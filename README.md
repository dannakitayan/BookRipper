# BookRipper

A local, offline research tool for reading technical books: ask questions, get excerpts
with exact citations (page or section + paragraph), and build up a canvas of linked notes
and summaries. Everything runs on your machine — no cloud calls, no API keys. Embeddings
and language models come from [Ollama](https://ollama.com/) running locally.

![license](https://img.shields.io/badge/license-MIT-blue)

## What it does

- **Hybrid search over your own books.** EPUB, FB2, PDF, DJVU, TXT and Markdown are parsed,
  chunked and indexed per-project. Search combines dense vector similarity (rephrasings) with
  full-text and trigram matching (exact terms, identifiers, Japanese text with no spaces) via
  Reciprocal Rank Fusion.
- **A canvas, not a chat log.** Questions live in blocks you can arrange, connect and reuse.
  Arrows carry meaning:
  - **context** — accepted findings of an ancestor block feed into the child's search terms.
  - **narrow scope** — restricts the child's search to only the book(s) the ancestor's
    accepted findings came from.
  - **cite** — pulls a block's accepted findings into a synopsis as numbered citations.
- **Exact locators.** PDF/DJVU cite a page number; EPUB/FB2 (which have no fixed pages) cite
  a section and paragraph instead. A chunk never crosses that boundary, so a citation never
  points at the wrong place.
- **A documentation-site crawler.** Pull a docs site into your library via
  [trafilatura](https://trafilatura.readthedocs.io/) — it strips navigation/boilerplate and
  saves clean Markdown pages that index exactly like a book.
- **Runs as a desktop app.** A [Tauri](https://tauri.app/) shell wraps the canvas and starts/stops
  the backend for you, or run the pieces separately as a web app.

## Architecture

```
Source/                 React + TypeScript canvas (Vite), wrapped by Tauri for desktop use
    src/                 UI, graph model, API client
    src-tauri/           Rust shell: opens the window, spawns/kills the Python backend
Server/                  FastAPI backend
    bookripper/
        parsers.py        EPUB/FB2/PDF/DJVU/TXT → text blocks with locators
        indexer.py         chunking + embedding → SQLite
        search.py          hybrid retrieval (dense + FTS + trigram, RRF fusion)
        pipeline.py        query expansion → search → LLM filtering → summary
        crawler.py          documentation-site crawler (trafilatura)
        llm.py              thin Ollama client (embeddings + chat)
        app.py              HTTP layer
Books/                   your library (gitignored — never copied, referenced by path)
Projects/<name>/         per-project SQLite index + canvas state (gitignored)
```

See [`Server/README.md`](Server/README.md) for the backend's design decisions (why one
embedding model for every language, why locators are polymorphic, why Ollama is reached at
`127.0.0.1` and not `localhost`, etc.).

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| [Node.js](https://nodejs.org/) | 20+ | frontend build |
| [Python](https://www.python.org/) | 3.11+ | backend |
| [Rust](https://rustup.rs/) | stable | required only to build/run the desktop app |
| [Ollama](https://ollama.com/) | latest | local embeddings + chat models |

**Windows only, to build the Tauri shell:**
- [Microsoft Visual C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
  (MSVC toolchain — needed by `cargo` to link the app)
- [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) (preinstalled
  on current Windows 10/11; Tauri uses it to render the UI)
- Rust's default toolchain must target `*-pc-windows-msvc` (`rustup default stable-msvc`)

**Optional:** [DjVuLibre](http://djvu.sourceforge.net/) (`djvutxt` on `PATH`) if you want to
index `.djvu` files.

## Setup

```bash
git clone https://github.com/dannakitayan/BookRipper.git
cd BookRipper

# Backend
python -m venv Server/.venv
Server/.venv/Scripts/python.exe -m pip install -r Server/requirements.txt   # Windows
# Server/.venv/bin/python -m pip install -r Server/requirements.txt         # macOS/Linux

# Frontend
cd Source
npm install
cd ..

# Models (once)
ollama pull bge-m3         # embeddings — multilingual, needed by both EN and JA text
ollama pull qwen3:8b        # filtering + summarizing; swap for any chat-capable model later
```

By default the app expects to live at a path it can compute itself: `Books/` and `Projects/`
sit next to `Server/` and `Source/` at the repository root. To put them somewhere else, set
`BOOKRIPPER_ROOT` as an environment variable (both the Python backend and the Tauri shell
read it).

## Running it

**Desktop app (recommended):**

```bash
cd Source
npm run tauri dev
```

This starts the Vite dev server, launches the Rust/Tauri window, and the window itself spawns
the Python backend on port 8008 and kills it when you close the window. On Windows, double-click
[`BookRipper.bat`](BookRipper.bat) instead — it also checks that Ollama is actually listening on
`127.0.0.1:11434` (the tray icon can be running without the server underneath it) and starts it
if not.

**As a plain web app**, run the two halves yourself:

```bash
# terminal 1
Server/.venv/Scripts/python.exe -m uvicorn bookripper.app:app --app-dir Server --host 127.0.0.1 --port 8008

# terminal 2
cd Source && npm run dev
```

then open `http://localhost:5174`.

**Building an installer:**

```bash
cd Source
npm run tauri build
```

Produces a native installer under `src-tauri/target/release/bundle/`.

## Using it

1. **Create a project** (top bar → `+ project`) — each project has its own search index, so
   the same book can mean different things in different projects.
2. **Put books in `Books/`** and open **library** to index the ones you want searchable in
   this project (or crawl a documentation site straight into `Books/Web/` from the same panel).
3. **Add a reference block** (`+ reference`), write a question, hit **run**. Excerpts come
   back with their source and exact locator; accept the ones that actually answer it.
4. **Connect blocks with arrows** to carry context or narrow the search to a specific book,
   and **cite** blocks into a synopsis to write your own notes with numbered references.
5. Check **settings** (top bar) any time to see whether Ollama is reachable, which models are
   installed, and to switch which model does filtering vs. summarizing.

## License

[MIT](LICENSE)
