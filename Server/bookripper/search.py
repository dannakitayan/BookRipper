"""Гибридный поиск: смысл плюс точное совпадение.

Векторы находят переформулированное («выгорание» → «истощение»), FTS находит то,
что обязано совпасть буквально — имена API, термины, иероглифы. Склеиваем ранги
через RRF: он не требует приводить несравнимые шкалы к одной.
"""

from __future__ import annotations

import json
import re
import sqlite3
from typing import Sequence

import numpy as np

from . import llm, store
from .store import Hit

RRF_K = 60
WORD = re.compile(r"[\wÀ-ɏЀ-ӿ]+", re.UNICODE)


def _fts_query(text: str) -> str:
    """Токены в кавычках: иначе двоеточие или дефис уронят парсер FTS5."""
    words = WORD.findall(text)
    return " OR ".join(f'"{w}"' for w in words if len(w) > 1)


def _tri_query(text: str) -> str:
    """Для trigram подстрока ищется целиком — пригодно для японского."""
    cleaned = text.strip().replace('"', " ")
    return f'"{cleaned}"' if len(cleaned) >= 3 else ""


def _rank_dense(con: sqlite3.Connection, query: str, limit: int) -> list[tuple[int, float]]:
    mat, ids = store.load_vectors(con)
    if not len(ids):
        return []
    qvec = llm.embed([query])[0]
    sims = mat @ qvec
    top = np.argsort(-sims)[:limit]
    return [(ids[i], float(sims[i])) for i in top]


def _rank_fts(con: sqlite3.Connection, table: str, query: str, limit: int) -> list[tuple[int, float]]:
    if not query:
        return []
    try:
        rows = con.execute(
            f"SELECT rowid, bm25({table}) AS score FROM {table} WHERE {table} MATCH ?"
            " ORDER BY score LIMIT ?",
            (query, limit),
        ).fetchall()
    except sqlite3.OperationalError:
        # Кривой запрос не должен ронять поиск целиком — просто нет лексической части.
        return []
    return [(int(r["rowid"]), -float(r["score"])) for r in rows]


def _rrf(ranked: Sequence[Sequence[tuple[int, float]]], weights: Sequence[float]) -> dict[int, float]:
    out: dict[int, float] = {}
    for lst, w in zip(ranked, weights):
        for pos, (cid, _score) in enumerate(lst):
            out[cid] = out.get(cid, 0.0) + w / (RRF_K + pos + 1)
    return out


def search(
    con: sqlite3.Connection,
    queries: Sequence[str],
    *,
    limit: int = 40,
    per_source: int = 60,
    doc_ids: Sequence[int] | None = None,
) -> list[Hit]:
    """Несколько формулировок одного вопроса ищутся вместе и сливаются в один список."""
    pools: list[list[tuple[int, float]]] = []
    weights: list[float] = []
    found_by: dict[int, set[str]] = {}

    def remember(pairs: list[tuple[int, float]], label: str) -> None:
        for cid, _ in pairs:
            found_by.setdefault(cid, set()).add(label)

    for q in queries:
        dense = _rank_dense(con, q, per_source)
        lex = _rank_fts(con, "chunks_fts", _fts_query(q), per_source)
        tri = _rank_fts(con, "chunks_tri", _tri_query(q), per_source)
        remember(dense, "meaning")
        remember(lex, "words")
        remember(tri, "substring")
        pools += [dense, lex, tri]
        # Смысловой поиск весомее: лексика нужна как страховка на точные совпадения.
        weights += [1.0, 0.6, 0.4]

    fused = _rrf(pools, weights)
    if not fused:
        return []

    ordered = sorted(fused.items(), key=lambda kv: -kv[1])
    rows = store.chunks_by_ids(con, [cid for cid, _ in ordered])

    # Стрелка «narrow scope» сужает поиск до книг-предков — ранжирование общее, фильтр после.
    if doc_ids is not None:
        allowed = set(doc_ids)
        ordered = [(cid, score) for cid, score in ordered if cid in rows and int(rows[cid]["document_id"]) in allowed]

    best = ordered[:limit]

    hits: list[Hit] = []
    for cid, score in best:
        r = rows.get(cid)
        if not r:
            continue
        hits.append(
            Hit(
                chunk_id=cid,
                doc_id=int(r["document_id"]),
                doc_title=r["doc_title"],
                lang=r["lang"],
                kind=r["kind"],
                section=r["section"],
                locator=json.loads(r["locator"]),
                text=r["text"],
                score=round(score, 5),
                why_found="+".join(sorted(found_by.get(cid, set()))),
            )
        )
    return hits
