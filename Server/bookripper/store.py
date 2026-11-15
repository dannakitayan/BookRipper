"""Хранилище проекта: один файл SQLite на проект.

Полнотекстовый индекс намеренно в двух экземплярах. unicode61 со стеммингом хорош
для английского, но японский он видит как одно гигантское слово — там работает
только trigram. На десятке книг дублирование индекса ничего не стоит.
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

import numpy as np

from .chunker import Chunk
from .parsers import ParsedDoc

SCHEMA = """
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS documents (
  id        INTEGER PRIMARY KEY,
  path      TEXT UNIQUE NOT NULL,
  title     TEXT NOT NULL,
  lang      TEXT NOT NULL,
  fmt       TEXT NOT NULL,
  pages     INTEGER,
  needs_ocr INTEGER NOT NULL DEFAULT 0,
  mtime     REAL NOT NULL,
  size      INTEGER NOT NULL,
  indexed_at TEXT NOT NULL,
  warnings  TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS chunks (
  id      INTEGER PRIMARY KEY,
  doc_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ord     INTEGER NOT NULL,
  text    TEXT NOT NULL,
  kind    TEXT NOT NULL,
  lang    TEXT NOT NULL,
  section TEXT,
  locator TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_doc ON chunks(doc_id);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
  USING fts5(text, content='chunks', content_rowid='id',
             tokenize="unicode61 remove_diacritics 2");

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_tri
  USING fts5(text, content='chunks', content_rowid='id', tokenize='trigram');

CREATE TABLE IF NOT EXISTS vectors (
  chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  dim      INTEGER NOT NULL,
  vec      BLOB NOT NULL
);
"""


@dataclass
class Hit:
    chunk_id: int
    doc_id: int
    doc_title: str
    lang: str
    kind: str
    section: str | None
    locator: dict[str, Any]
    text: str
    score: float
    why_found: str = ""


def connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    con.executescript(SCHEMA)
    return con


def document_row(con: sqlite3.Connection, path: Path) -> sqlite3.Row | None:
    return con.execute("SELECT * FROM documents WHERE path = ?", (str(path),)).fetchone()


def is_current(con: sqlite3.Connection, path: Path) -> bool:
    """Переиндексируем только изменившиеся файлы."""
    row = document_row(con, path)
    if not row:
        return False
    st = path.stat()
    return abs(row["mtime"] - st.st_mtime) < 1 and row["size"] == st.st_size


def delete_document(con: sqlite3.Connection, doc_id: int) -> None:
    ids = [r[0] for r in con.execute("SELECT id FROM chunks WHERE doc_id = ?", (doc_id,))]
    for cid in ids:
        # content-таблицы FTS5 нужно чистить вручную — триггеров мы не ставили.
        con.execute("INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', ?, ?)",
                    (cid, con.execute("SELECT text FROM chunks WHERE id = ?", (cid,)).fetchone()[0]))
        con.execute("INSERT INTO chunks_tri(chunks_tri, rowid, text) VALUES('delete', ?, ?)",
                    (cid, con.execute("SELECT text FROM chunks WHERE id = ?", (cid,)).fetchone()[0]))
    con.execute("DELETE FROM documents WHERE id = ?", (doc_id,))
    con.commit()


def add_document(
    con: sqlite3.Connection,
    path: Path,
    doc: ParsedDoc,
    chunks: Sequence[Chunk],
    vectors: np.ndarray,
    indexed_at: str,
) -> int:
    assert len(chunks) == len(vectors), "chunks and vectors are out of sync"

    existing = document_row(con, path)
    if existing:
        delete_document(con, existing["id"])

    st = path.stat()
    cur = con.execute(
        "INSERT INTO documents(path,title,lang,fmt,pages,needs_ocr,mtime,size,indexed_at,warnings)"
        " VALUES(?,?,?,?,?,?,?,?,?,?)",
        (str(path), doc.title, doc.lang, doc.fmt, doc.pages, int(doc.needs_ocr),
         st.st_mtime, st.st_size, indexed_at, json.dumps(doc.warnings, ensure_ascii=False)),
    )
    doc_id = int(cur.lastrowid)

    for ord_, (chunk, vec) in enumerate(zip(chunks, vectors)):
        c = con.execute(
            "INSERT INTO chunks(doc_id,ord,text,kind,lang,section,locator) VALUES(?,?,?,?,?,?,?)",
            (doc_id, ord_, chunk.text, chunk.kind, chunk.lang, chunk.section,
             json.dumps(chunk.locator, ensure_ascii=False)),
        )
        cid = int(c.lastrowid)
        con.execute("INSERT INTO chunks_fts(rowid, text) VALUES(?, ?)", (cid, chunk.text))
        con.execute("INSERT INTO chunks_tri(rowid, text) VALUES(?, ?)", (cid, chunk.text))
        con.execute(
            "INSERT INTO vectors(chunk_id, dim, vec) VALUES(?,?,?)",
            (cid, int(vec.shape[0]), np.asarray(vec, dtype=np.float32).tobytes()),
        )

    con.commit()
    return doc_id


def load_vectors(con: sqlite3.Connection, doc_ids: Iterable[int] | None = None) -> tuple[np.ndarray, list[int]]:
    """Матрица всех векторов проекта: десяток книг свободно живёт в памяти."""
    sql = "SELECT v.chunk_id, v.vec FROM vectors v JOIN chunks c ON c.id = v.chunk_id"
    params: list[Any] = []
    ids = list(doc_ids) if doc_ids is not None else None
    if ids:
        sql += f" WHERE c.doc_id IN ({','.join('?' * len(ids))})"
        params = ids
    sql += " ORDER BY v.chunk_id"

    rows = con.execute(sql, params).fetchall()
    if not rows:
        return np.zeros((0, 0), dtype=np.float32), []
    mat = np.vstack([np.frombuffer(r["vec"], dtype=np.float32) for r in rows])
    return mat, [int(r["chunk_id"]) for r in rows]


def chunks_by_ids(con: sqlite3.Connection, ids: Sequence[int]) -> dict[int, sqlite3.Row]:
    if not ids:
        return {}
    q = (
        "SELECT c.*, d.title AS doc_title, d.id AS document_id FROM chunks c"
        " JOIN documents d ON d.id = c.doc_id"
        f" WHERE c.id IN ({','.join('?' * len(ids))})"
    )
    return {int(r["id"]): r for r in con.execute(q, list(ids))}


def stats(con: sqlite3.Connection) -> dict[str, Any]:
    docs = con.execute(
        "SELECT id, title, lang, fmt, pages, needs_ocr, path, indexed_at, warnings FROM documents ORDER BY title"
    ).fetchall()
    per_doc = {
        int(r["doc_id"]): int(r["n"])
        for r in con.execute("SELECT doc_id, COUNT(*) AS n FROM chunks GROUP BY doc_id")
    }
    return {
        "documents": [
            {
                "id": int(d["id"]),
                "title": d["title"],
                "lang": d["lang"],
                "format": d["fmt"],
                "pages": d["pages"],
                "needs_ocr": bool(d["needs_ocr"]),
                "path": d["path"],
                "indexed_at": d["indexed_at"],
                "warnings": json.loads(d["warnings"]),
                "chunks": per_doc.get(int(d["id"]), 0),
            }
            for d in docs
        ],
        "chunks": int(con.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]),
    }
