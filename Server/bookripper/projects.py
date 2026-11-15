"""Проект — это папка в Projects/ со всем, что приложение нажило.

    Projects/<название>/
        project.json   — состояние канваса (блоки, стрелки, конспекты)
        index.sqlite   — чанки, полнотекстовые индексы и векторы книг проекта
        exports/       — выгрузки в Markdown

Книги остаются в Books/ и не копируются: проект ссылается на них по пути.
Индекс при этом у каждого проекта свой — так одна книга в двух проектах
индексируется дважды, зато папка проекта самодостаточна и переносима.
"""

from __future__ import annotations

import json
import shutil
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import settings, store

CANVAS_FILE = "project.json"
INDEX_FILE = "index.sqlite"
EXPORTS_DIR = "exports"

EMPTY_CANVAS: dict[str, Any] = {"version": 3, "nodes": [], "edges": []}


@dataclass
class Project:
    name: str
    path: Path

    @property
    def canvas_path(self) -> Path:
        return self.path / CANVAS_FILE

    @property
    def index_path(self) -> Path:
        return self.path / INDEX_FILE

    @property
    def exports_path(self) -> Path:
        return self.path / EXPORTS_DIR

    def connect(self) -> sqlite3.Connection:
        return store.connect(self.index_path)

    def read_canvas(self) -> dict[str, Any]:
        if not self.canvas_path.exists():
            return dict(EMPTY_CANVAS)
        try:
            return json.loads(self.canvas_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            # Канвас — единственное, что нельзя потерять молча.
            broken = self.canvas_path.with_suffix(".broken.json")
            self.canvas_path.replace(broken)
            return dict(EMPTY_CANVAS) | {"recovered_from": broken.name}

    def write_canvas(self, data: dict[str, Any]) -> None:
        self.path.mkdir(parents=True, exist_ok=True)
        tmp = self.canvas_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self.canvas_path)  # атомарная замена: обрыв не оставит огрызок

    def info(self) -> dict[str, Any]:
        con = self.connect()
        try:
            s = store.stats(con)
        finally:
            con.close()
        canvas = self.read_canvas()
        return {
            "name": self.name,
            "path": str(self.path),
            "sources": s["documents"],
            "chunks": s["chunks"],
            "blocks": len(canvas.get("nodes", [])),
            "updated_at": datetime.fromtimestamp(
                self.canvas_path.stat().st_mtime, tz=timezone.utc
            ).isoformat(timespec="seconds")
            if self.canvas_path.exists()
            else None,
        }


def create(name: str) -> Project:
    p = Project(name=name, path=settings.project_dir(name))
    p.path.mkdir(parents=True, exist_ok=True)
    p.exports_path.mkdir(exist_ok=True)
    if not p.canvas_path.exists():
        p.write_canvas(dict(EMPTY_CANVAS))
    p.connect().close()  # создаём пустой индекс сразу, чтобы папка была готовой
    return p


def get(name: str) -> Project:
    path = settings.project_dir(name)
    if not path.exists():
        raise FileNotFoundError(f"project '{name}' does not exist")
    return Project(name=path.name, path=path)


def delete(name: str) -> None:
    """Книги в Books/ не трогает — проект лишь ссылается на них по пути."""
    path = settings.project_dir(name)
    if not path.exists():
        raise FileNotFoundError(f"project '{name}' does not exist")
    shutil.rmtree(path)


def list_all() -> list[Project]:
    if not settings.PROJECTS_DIR.exists():
        return []
    return [
        Project(name=d.name, path=d)
        for d in sorted(settings.PROJECTS_DIR.iterdir())
        if d.is_dir() and not d.name.startswith("_")
    ]
