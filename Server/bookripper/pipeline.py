"""Цикл библиотекаря: расширить запрос → найти → отсеять → объяснить.

Правила, заданные проектом и зашитые здесь:
  • всё, что пишет модель, — по-английски, независимо от языка вопроса;
  • цитата остаётся дословной, модель её не переписывает;
  • текст конспекта сюда не попадает никогда — библиотекарь не читает записи читателя.
"""

from __future__ import annotations

import json
import re
import sqlite3
from typing import Any, Callable, Iterable, Sequence

from . import llm, search, settings
from .store import Hit

Progress = Callable[[dict[str, Any]], None]

FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL)

EXPAND_SYSTEM = """You turn a reader's question into search queries over a library of books.

Step 1: translate the question into English. Step 2: write the queries in English only.
Never output a query in the language of the question.

Rules:
- Reply with a JSON array of 3 to 5 short query strings, nothing else.
- Vary the wording: the author may name the concept differently than the reader does.
- Include the exact technical terms, identifiers or symbols that must appear verbatim.
- Keep each query under 12 words."""

# Одной инструкции qwen3:8b не слушается и отвечает на языке вопроса — показываем пример.
EXPAND_EXAMPLE_USER = "Question: Что такое указатель на функцию?"
EXPAND_EXAMPLE_REPLY = json.dumps(
    [
        "function pointer declaration",
        "pointer to function syntax",
        "passing a function as an argument",
        "calling a function through a pointer",
    ]
)

FILTER_SYSTEM = """You decide which book excerpts actually answer a reader's question.

Rules:
- Reply with a JSON array, one object per excerpt you were given, nothing else.
- Each object: {"id": <number>, "keep": true|false, "why": "<at most 20 words>"}
- Keep an excerpt only if it helps answer the question. Being on the same topic is not enough.
- "why" must say what the excerpt contributes, in English, always.
- Never invent text that is not in the excerpt."""

SUMMARY_SYSTEM = """You summarise what the books say in answer to a reader's question.

The answer is always written in English. The question may be in any language; translate it
for yourself and still answer in English. Never reply in the language of the question.

Rules:
- Write 2 to 4 sentences.
- Use only the excerpts given. If they disagree, say so plainly.
- Cite with [n] markers matching the excerpt numbers.
- No preamble, no restating the question."""

# qwen3:8b сползает на язык вопроса, поэтому показываем разноязычную пару.
SUMMARY_EXAMPLE_USER = (
    "Question: Что такое указатель на функцию?\n\n"
    "Excerpts:\n[1] A Book · p. 10 (en)\nA function pointer stores the address of a function "
    "and can be called through it."
)
SUMMARY_EXAMPLE_REPLY = (
    "A function pointer holds the address of a function and can be invoked through that "
    "address [1]."
)


def _json_block(text: str) -> Any:
    """Модель охотно оборачивает ответ в ``` или добавляет вступление — достаём JSON."""
    fenced = FENCE.search(text)
    candidate = fenced.group(1) if fenced else text
    candidate = candidate.strip()
    try:
        return json.loads(candidate)
    except json.JSONDecodeError:
        pass
    # Последняя попытка: вырезать самый внешний массив или объект.
    for opener, closer in (("[", "]"), ("{", "}")):
        start, end = candidate.find(opener), candidate.rfind(closer)
        if start != -1 and end > start:
            try:
                return json.loads(candidate[start : end + 1])
            except json.JSONDecodeError:
                continue
    raise ValueError(f"model did not return JSON: {text[:200]}")


def expand_query(question: str, *, context_terms: Sequence[str] = ()) -> list[str]:
    """Переформулировки вопроса. Термины предков подмешиваются сюда — в этом смысл стрелок."""
    user = f"Question: {question}"
    if context_terms:
        joined = ", ".join(dict.fromkeys(context_terms))
        user += f"\nTerms already established by earlier findings: {joined}"

    try:
        raw = llm.chat(
            [
                {"role": "system", "content": EXPAND_SYSTEM},
                {"role": "user", "content": EXPAND_EXAMPLE_USER},
                {"role": "assistant", "content": EXPAND_EXAMPLE_REPLY},
                {"role": "user", "content": user},
            ],
            model=settings.FILTER_MODEL,
            options=settings.FILTER_OPTIONS,
        )
        queries = [str(q).strip() for q in _json_block(raw) if str(q).strip()]
    except (ValueError, llm.OllamaError):
        queries = []

    # Исходная формулировка остаётся первой: она точнее всего передаёт намерение.
    out = [question] + [q for q in queries if q.lower() != question.lower()]
    return out[:5]


def _render_excerpt(i: int, hit: Hit) -> str:
    loc = hit.locator
    where = (
        f"p. {loc['page']}"
        if loc.get("kind") == "page"
        else f"{loc.get('section', '?')} ¶{loc.get('paragraph', 0)}"
    )
    return f"[{i}] {hit.doc_title} · {where} ({hit.lang})\n{hit.text}"


def filter_hits(
    question: str,
    hits: Sequence[Hit],
    *,
    batch_size: int = 6,
    progress: Progress = lambda _: None,
) -> list[Hit]:
    """Прогон кандидатов пачками: в одно окно всё не влезает, да и качество падает."""
    kept: list[Hit] = []
    for start in range(0, len(hits), batch_size):
        batch = list(hits[start : start + batch_size])
        listing = "\n\n".join(_render_excerpt(i, h) for i, h in enumerate(batch, start + 1))
        user = f"Question: {question}\n\nExcerpts:\n{listing}"

        try:
            raw = llm.chat(
                [{"role": "system", "content": FILTER_SYSTEM}, {"role": "user", "content": user}],
                model=settings.FILTER_MODEL,
                options=settings.FILTER_OPTIONS,
            )
            verdicts = _json_block(raw)
        except (ValueError, llm.OllamaError) as e:
            # Молча терять кандидатов нельзя: отдаём их неразмеченными.
            progress({"stage": "filter_failed", "error": str(e)[:200], "batch": start // batch_size})
            for h in batch:
                h.why_found = f"{h.why_found} (not reviewed by the model)"
                kept.append(h)
            continue

        by_id = {start + 1 + i: h for i, h in enumerate(batch)}
        for v in verdicts if isinstance(verdicts, list) else []:
            try:
                hit = by_id.get(int(v["id"]))
            except (KeyError, TypeError, ValueError):
                continue
            if hit is not None and bool(v.get("keep")):
                hit.why_found = str(v.get("why", "")).strip() or "relevant to the question"
                kept.append(hit)

        progress(
            {"stage": "filtered", "done": min(start + batch_size, len(hits)), "total": len(hits),
             "kept": len(kept)}
        )
    return kept


def summarise(question: str, hits: Sequence[Hit]) -> str:
    if not hits:
        return ""
    listing = "\n\n".join(_render_excerpt(i, h) for i, h in enumerate(hits, 1))
    try:
        return llm.chat(
            [
                {"role": "system", "content": SUMMARY_SYSTEM},
                {"role": "user", "content": SUMMARY_EXAMPLE_USER},
                {"role": "assistant", "content": SUMMARY_EXAMPLE_REPLY},
                {"role": "user", "content": f"Question: {question}\n\nExcerpts:\n{listing}"},
            ],
            model=settings.SYNTH_MODEL,
            options=settings.SYNTH_OPTIONS,
        )
    except llm.OllamaError:
        return ""


def _book_terms(con: sqlite3.Connection) -> list[str]:
    """Key terms from book titles — helps the model generate domain-specific queries."""
    rows = con.execute("SELECT title FROM documents").fetchall()
    terms: list[str] = []
    for r in rows:
        for word in re.findall(r"[A-Za-z][a-z]{2,}", r["title"]):
            w = word.lower()
            if w not in {"the", "and", "for", "with", "from", "edition"}:
                terms.append(w)
    return list(dict.fromkeys(terms))[:12]


def ask(
    con: sqlite3.Connection,
    question: str,
    *,
    context_terms: Sequence[str] = (),
    candidates: int = 24,
    keep_limit: int = 8,
    want_summary: bool = True,
    deeper: bool = False,
    exclude_ids: Sequence[int] = (),
    scope_doc_ids: Sequence[int] = (),
    progress: Progress = lambda _: None,
) -> dict[str, Any]:
    """Полный проход: именно он стоит за кнопкой «run» у заметки."""
    book_terms = _book_terms(con)
    all_context = list(context_terms) + book_terms
    doc_ids = list(scope_doc_ids) or None

    if deeper:
        candidates = max(candidates, 48)
        keep_limit = max(keep_limit, 12)

    progress({"stage": "expanding"})
    queries = expand_query(question, context_terms=all_context)
    progress({"stage": "expanded", "queries": queries})

    hits = search.search(con, queries, limit=candidates, doc_ids=doc_ids)
    if exclude_ids:
        seen = set(exclude_ids)
        hits = [h for h in hits if h.chunk_id not in seen]
    progress({"stage": "retrieved", "candidates": len(hits)})

    if not hits:
        return {"queries": queries, "findings": [], "summary": "", "candidates": 0}

    kept = filter_hits(question, hits, progress=progress)[:keep_limit]
    progress({"stage": "kept", "kept": len(kept)})

    # Auto second round: if the first pass found very few, widen the net.
    if len(kept) < 3 and not deeper and not exclude_ids:
        progress({"stage": "deepening", "reason": "few results, widening search"})
        already = {h.chunk_id for h in kept}
        extra_hits = search.search(con, queries, limit=candidates * 2, doc_ids=doc_ids)
        extra_hits = [h for h in extra_hits if h.chunk_id not in already]
        if extra_hits:
            progress({"stage": "retrieved", "candidates": len(extra_hits)})
            extra_kept = filter_hits(question, extra_hits, progress=progress)[:keep_limit - len(kept)]
            kept.extend(extra_kept)
            progress({"stage": "kept", "kept": len(kept)})

    summary = ""
    if want_summary and kept:
        progress({"stage": "summarising"})
        summary = summarise(question, kept)

    return {
        "queries": queries,
        "candidates": len(hits),
        "summary": summary,
        "findings": [
            {
                "chunk_id": h.chunk_id,
                "docId": h.doc_id,
                "sourceTitle": h.doc_title,
                "sourceLang": h.lang,
                "locator": h.locator,
                "excerpt": h.text,
                "why": h.why_found,
                "kind": h.kind,
            }
            for h in kept
        ],
    }


def iter_terms(findings: Iterable[dict[str, Any]]) -> list[str]:
    """Термины из принятых выписок — их подмешивает дочерний запрос."""
    terms: list[str] = []
    for f in findings:
        terms += re.findall(r"\*\*(.+?)\*\*", str(f.get("excerpt", "")))
    return terms
