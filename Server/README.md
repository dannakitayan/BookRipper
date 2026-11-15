# BookRipper — backend

Parsing, indexing and hybrid search over a local book library. Everything runs locally:
Ollama for embeddings, SQLite for storage, no cloud calls.

## Layout

```
Books/                      your books (never copied, only referenced)
Projects/<project name>/    everything the app generates
    project.json            canvas state: blocks, arrows, synopses
    index.sqlite            chunks, full-text indexes, vectors
    exports/                Markdown exports
Server/                     this backend
```

## Run

```bash
Server/.venv/Scripts/python.exe -m uvicorn bookripper.app:app --app-dir Server --port 8008
```

Ollama must be running with `bge-m3` pulled (`ollama pull bge-m3`).

## Endpoints

| method | path | purpose |
|---|---|---|
| GET | `/health` | Ollama reachability, models, paths |
| GET | `/library` | books found in `Books/` |
| GET/POST | `/projects` | list / create a project |
| GET/PUT | `/projects/{name}/canvas` | load / save canvas state |
| POST | `/projects/{name}/index` | index books, streams NDJSON progress |
| POST | `/projects/{name}/search` | hybrid search, returns chunks with locators |
| DELETE | `/projects/{name}/sources/{id}` | drop one indexed book |

## Decisions worth knowing

**One embedding model for every language.** `bge-m3` puts English and Japanese text in the
same vector space, so a question in one language finds passages in the other. Two separate
embedders would produce two incomparable spaces that cannot be ranked into one list.

**Locators are polymorphic.** PDF and DJVU have real pages; EPUB and FB2 do not — they are a
stream of text, so the locator there is section plus paragraph. A chunk never crosses a
locator boundary, otherwise the citation would point at the wrong place.

**Two full-text indexes.** `unicode61` with stemming serves English; Japanese has no spaces
and is only searchable through the `trigram` tokenizer. On ten books the duplication is free.

**Chunking is script-aware.** ~1100 characters for English, ~450 for Japanese, 15% overlap.
Code listings are never split: half a listing answers nothing.

**Hybrid retrieval.** Dense vectors find rephrasings, FTS finds exact terms and identifiers;
ranks are merged with RRF so two incomparable scales never have to be normalised.

**Ollama is reached at `127.0.0.1`, not `localhost`.** On Windows the name resolves to `::1`
first and every request pays for the fallback — measured 240 ms vs 15 ms. With one pooled
connection, a search went from ~3.5 s to ~30 ms.

**`num_ctx` is always set explicitly.** Ollama's default window is small and silently
truncates the prompt, which is what makes local models look shallow.

## Checks

```bash
Server/.venv/Scripts/python.exe Server/scripts/make_fixtures.py   # regenerate test books
Server/.venv/Scripts/python.exe -m pytest Server/tests            # not written yet
```

Fixtures in `tests/fixtures/` cover EPUB, FB2 (Japanese), PDF with a text layer, a scanned
PDF with none, and a text file with a code block.
