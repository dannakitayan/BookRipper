"""Конвейер индексации: файл → блоки → чанки → векторы → SQLite."""

from __future__ import annotations

import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable

import numpy as np

from . import llm, settings, store
from .chunker import chunk_document
from .parsers import parse

Progress = Callable[[dict[str, Any]], None]


def _noop(_: dict[str, Any]) -> None:
    pass


def index_file(
    con: sqlite3.Connection,
    path: Path,
    *,
    progress: Progress = _noop,
    force: bool = False,
) -> dict[str, Any]:
    started = time.perf_counter()
    if not force and store.is_current(con, path):
        progress({"stage": "skipped", "file": path.name})
        return {"file": path.name, "status": "up-to-date"}

    progress({"stage": "parsing", "file": path.name})
    doc = parse(path)

    chunks = chunk_document(doc)
    progress({"stage": "chunked", "file": path.name, "chunks": len(chunks), "lang": doc.lang})

    if not chunks:
        return {
            "file": path.name,
            "status": "empty",
            "needs_ocr": doc.needs_ocr,
            "warnings": doc.warnings or ["no text extracted"],
        }

    vectors = np.zeros((len(chunks), settings.EMBED_DIM), dtype=np.float32)
    batch = settings.EMBED_BATCH
    for i in range(0, len(chunks), batch):
        part = chunks[i : i + batch]
        vectors[i : i + len(part)] = llm.embed([c.text for c in part])
        progress(
            {"stage": "embedding", "file": path.name, "done": min(i + batch, len(chunks)),
             "total": len(chunks)}
        )

    doc_id = store.add_document(
        con, path, doc, chunks, vectors, datetime.now(timezone.utc).isoformat(timespec="seconds")
    )
    elapsed = round(time.perf_counter() - started, 1)
    progress({"stage": "done", "file": path.name, "chunks": len(chunks), "seconds": elapsed})

    return {
        "file": path.name,
        "status": "indexed",
        "doc_id": doc_id,
        "title": doc.title,
        "lang": doc.lang,
        "format": doc.fmt,
        "pages": doc.pages,
        "chunks": len(chunks),
        "needs_ocr": doc.needs_ocr,
        "warnings": doc.warnings,
        "seconds": elapsed,
    }


def index_files(
    con: sqlite3.Connection,
    paths: Iterable[Path],
    *,
    progress: Progress = _noop,
    force: bool = False,
) -> list[dict[str, Any]]:
    results = []
    for p in paths:
        try:
            results.append(index_file(con, p, progress=progress, force=force))
        except Exception as e:  # одна битая книга не должна валить всю индексацию
            progress({"stage": "failed", "file": p.name, "error": str(e)})
            results.append({"file": p.name, "status": "failed", "error": str(e)})
    return results
