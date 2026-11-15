"""HTTP-слой. Индексация отдаёт прогресс потоком — она идёт минутами."""

from __future__ import annotations

import json
import queue
import threading
from pathlib import Path
from typing import Any, Iterator

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from . import crawler, indexer, llm, parsers, projects, settings, store

app = FastAPI(title="BookRipper", version="0.1.0")

# Фронт живёт на отдельном порту дев-сервера Vite; у собранного Tauri-окна — свой псевдо-домен.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173", "http://127.0.0.1:5173",
        "http://localhost:5174", "http://127.0.0.1:5174",
        "http://tauri.localhost",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)


class CreateProject(BaseModel):
    name: str = Field(min_length=1, max_length=120)


class IndexRequest(BaseModel):
    files: list[str] = Field(default_factory=list, description="paths inside Books/, empty = all")
    force: bool = False


class CrawlRequest(BaseModel):
    url: str = Field(min_length=4)
    max_pages: int = Field(default=settings.CRAWL_MAX_PAGES, ge=1, le=200)
    same_domain: bool = True


class SearchRequest(BaseModel):
    queries: list[str] = Field(min_length=1)
    limit: int = 40


class AskRequest(BaseModel):
    question: str = Field(min_length=2)
    context_terms: list[str] = Field(default_factory=list)
    candidates: int = 24
    keep: int = 8
    summary: bool = True
    deeper: bool = False
    exclude_ids: list[int] = Field(default_factory=list)
    scope_doc_ids: list[int] = Field(default_factory=list)


def _project(name: str) -> projects.Project:
    try:
        return projects.get(name)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e)) from e


def _resolve(rel: str) -> Path:
    """Пути приходят с фронта, поэтому не выпускаем их за пределы Books/."""
    p = (settings.BOOKS_DIR / rel).resolve()
    if not p.is_file() or settings.BOOKS_DIR.resolve() not in p.parents:
        raise HTTPException(400, f"not a file inside Books/: {rel}")
    return p


@app.get("/")
def root() -> dict[str, Any]:
    """Корень API. Интерфейс живёт отдельно — иначе здесь виден голый 404."""
    return {
        "service": "BookRipper API",
        "version": app.version,
        "ui": "http://localhost:5173",
        "interactive_docs": "/docs",
        "endpoints": {
            "GET /health": "Ollama reachability, models, paths",
            "PUT /settings": "choose the filter/synth models used for search",
            "GET /library": "books found in Books/",
            "POST /crawl": "crawl a documentation site into Books/Web/, streams NDJSON progress",
            "GET /projects": "list projects",
            "POST /projects": "create a project",
            "DELETE /projects/{name}": "delete a project (index + canvas; books in Books/ stay)",
            "GET|PUT /projects/{name}/canvas": "load or save canvas state",
            "POST /projects/{name}/index": "index books, streams NDJSON progress",
            "POST /projects/{name}/search": "hybrid search over the project index",
        },
    }


@app.get("/health")
def health() -> dict[str, Any]:
    try:
        models = llm.available_models()
        ollama_error = None
    except llm.OllamaError as e:
        models = []
        ollama_error = str(e)
    return {
        "ok": True,
        "ollama": settings.OLLAMA_HOST,
        "ollama_reachable": ollama_error is None,
        "ollama_error": ollama_error,
        "models": models,
        "embed_model": settings.EMBED_MODEL,
        "embed_ready": any(m.split(":")[0] == settings.EMBED_MODEL.split(":")[0] for m in models),
        "filter_model": settings.FILTER_MODEL,
        "synth_model": settings.SYNTH_MODEL,
        "books_dir": str(settings.BOOKS_DIR),
        "projects_dir": str(settings.PROJECTS_DIR),
    }


class ModelSettings(BaseModel):
    filter_model: str = Field(min_length=1)
    synth_model: str = Field(min_length=1)


@app.put("/settings")
def update_settings(body: ModelSettings) -> dict[str, Any]:
    """Эмбеддинг здесь не трогаем намеренно: его смена требует переиндексации."""
    settings.save_overrides(filter_model=body.filter_model, synth_model=body.synth_model)
    return {"filter_model": settings.FILTER_MODEL, "synth_model": settings.SYNTH_MODEL}


@app.get("/library")
def library() -> dict[str, Any]:
    settings.BOOKS_DIR.mkdir(parents=True, exist_ok=True)
    files = []
    for p in parsers.iter_library(settings.BOOKS_DIR):
        files.append(
            {
                "path": str(p.relative_to(settings.BOOKS_DIR)),
                "name": p.name,
                "format": p.suffix.upper().lstrip("."),
                "size": p.stat().st_size,
            }
        )
    return {"books_dir": str(settings.BOOKS_DIR), "files": files}


@app.post("/crawl")
def crawl_site(body: CrawlRequest) -> StreamingResponse:
    """Обход сайта документации: страницы падают как .md в Books/Web/, прогресс потоком."""
    events: queue.Queue[dict[str, Any] | None] = queue.Queue()

    def work() -> None:
        try:
            saved = crawler.crawl(
                body.url,
                max_pages=body.max_pages,
                same_domain=body.same_domain,
                progress=events.put,
            )
            events.put({
                "stage": "done",
                "files": [str(p.relative_to(settings.BOOKS_DIR)) for p in saved],
            })
        except Exception as e:
            events.put({"stage": "error", "error": str(e)})
        finally:
            events.put(None)

    threading.Thread(target=work, daemon=True).start()

    def stream() -> Iterator[str]:
        while True:
            item = events.get()
            if item is None:
                return
            yield json.dumps(item, ensure_ascii=False) + "\n"

    return StreamingResponse(stream(), media_type="application/x-ndjson")


@app.get("/projects")
def list_projects() -> dict[str, Any]:
    return {"projects": [p.info() for p in projects.list_all()]}


@app.post("/projects")
def create_project(body: CreateProject) -> dict[str, Any]:
    return projects.create(body.name).info()


@app.delete("/projects/{name}")
def delete_project(name: str) -> dict[str, Any]:
    """Удаляет только папку проекта (индекс и канвас) — книги в Books/ остаются."""
    try:
        projects.delete(name)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e)) from e
    return {"deleted": name}


@app.get("/projects/{name}")
def project_info(name: str) -> dict[str, Any]:
    return _project(name).info()


@app.get("/projects/{name}/canvas")
def read_canvas(name: str) -> dict[str, Any]:
    return _project(name).read_canvas()


@app.put("/projects/{name}/canvas")
def write_canvas(name: str, canvas: dict[str, Any]) -> dict[str, Any]:
    p = _project(name)
    p.write_canvas(canvas)
    return {"saved": True, "path": str(p.canvas_path)}


@app.post("/projects/{name}/index")
def index_sources(name: str, body: IndexRequest) -> StreamingResponse:
    """Прогресс идёт построчным JSON: индексация книги занимает десятки секунд."""
    project = _project(name)
    paths = (
        [_resolve(f) for f in body.files]
        if body.files
        else list(parsers.iter_library(settings.BOOKS_DIR))
    )

    events: queue.Queue[dict[str, Any] | None] = queue.Queue()

    def work() -> None:
        con = project.connect()
        try:
            results = indexer.index_files(
                con, paths, progress=events.put, force=body.force
            )
            events.put({"stage": "finished", "results": results, **store.stats(con)})
        except Exception as e:
            events.put({"stage": "error", "error": str(e)})
        finally:
            con.close()
            events.put(None)

    threading.Thread(target=work, daemon=True).start()

    def stream() -> Iterator[str]:
        while True:
            item = events.get()
            if item is None:
                return
            yield json.dumps(item, ensure_ascii=False) + "\n"

    return StreamingResponse(stream(), media_type="application/x-ndjson")


@app.post("/projects/{name}/search")
def search_project(name: str, body: SearchRequest) -> dict[str, Any]:
    from . import search as search_mod

    project = _project(name)
    con = project.connect()
    try:
        hits = search_mod.search(con, body.queries, limit=body.limit)
    finally:
        con.close()

    return {
        "queries": body.queries,
        "hits": [
            {
                "chunk_id": h.chunk_id,
                "source": h.doc_title,
                "lang": h.lang,
                "kind": h.kind,
                "locator": h.locator,
                "text": h.text,
                "score": h.score,
                "matched_by": h.why_found,
            }
            for h in hits
        ],
    }


@app.post("/projects/{name}/ask")
def ask(name: str, body: AskRequest) -> StreamingResponse:
    """Полный цикл за кнопкой «run»: идёт десятки секунд, поэтому тоже потоком."""
    from . import pipeline

    project = _project(name)
    events: queue.Queue[dict[str, Any] | None] = queue.Queue()

    def work() -> None:
        con = project.connect()
        try:
            result = pipeline.ask(
                con,
                body.question,
                context_terms=body.context_terms,
                candidates=body.candidates,
                keep_limit=body.keep,
                want_summary=body.summary,
                deeper=body.deeper,
                exclude_ids=body.exclude_ids,
                scope_doc_ids=body.scope_doc_ids,
                progress=events.put,
            )
            events.put({"stage": "finished", **result})
        except Exception as e:
            events.put({"stage": "error", "error": str(e)})
        finally:
            con.close()
            events.put(None)

    threading.Thread(target=work, daemon=True).start()

    def stream() -> Iterator[str]:
        while True:
            item = events.get()
            if item is None:
                return
            yield json.dumps(item, ensure_ascii=False) + "\n"

    return StreamingResponse(stream(), media_type="application/x-ndjson")


class RenameSource(BaseModel):
    title: str = Field(min_length=1, max_length=300)


@app.patch("/projects/{name}/sources/{doc_id}")
def rename_source(name: str, doc_id: int, body: RenameSource) -> dict[str, Any]:
    """Заголовки из имён файлов шумные — читатель вправе назвать книгу по-своему."""
    con = _project(name).connect()
    try:
        cur = con.execute("UPDATE documents SET title = ? WHERE id = ?", (body.title.strip(), doc_id))
        con.commit()
        if not cur.rowcount:
            raise HTTPException(404, f"no source {doc_id}")
    finally:
        con.close()
    return {"id": doc_id, "title": body.title.strip()}


@app.delete("/projects/{name}/sources/{doc_id}")
def drop_source(name: str, doc_id: int) -> dict[str, Any]:
    con = _project(name).connect()
    try:
        store.delete_document(con, doc_id)
    finally:
        con.close()
    return {"deleted": doc_id}
