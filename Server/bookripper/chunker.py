"""Сборка блоков в чанки для поиска.

Два правила, из-за которых не подошёл обычный сплиттер по словам:
  • в японском нет пробелов, поэтому режем по символам и короче;
  • листинг кода не режем никогда — разрубленный пополам пример теряет смысл,
    а в книгах по программированию он и есть ответ на вопрос.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from . import settings
from .parsers import Block, ParsedDoc, detect_lang


@dataclass
class Chunk:
    text: str
    locator: dict[str, Any]
    kind: str
    lang: str
    section: str | None = None


def _target(lang: str) -> int:
    return settings.CHUNK_CHARS.get(lang, settings.CHUNK_CHARS["en"])


def _section_of(block: Block) -> str | None:
    loc = block.locator
    return loc.get("section") if loc.get("kind") == "section" else None


def _unit(block: Block) -> tuple[Any, ...]:
    """Единица ссылки: страница у PDF, раздел у EPUB/FB2.

    Чанк не имеет права пересекать её границу — иначе цитата получит локатор
    первой половины, а текст окажется со второй, и ссылка станет ложной.
    """
    loc = block.locator
    if loc.get("kind") == "page":
        return ("page", loc.get("page"))
    return ("section", loc.get("section"))


def split_long(text: str, limit: int) -> list[str]:
    """Режем переросший абзац по предложениям, а если и те длинные — по символам."""
    if len(text) <= limit:
        return [text]
    parts: list[str] = []
    buf = ""
    # Точки японские и латинские, плюс перевод строки как граница.
    for piece in _sentences(text):
        if buf and len(buf) + len(piece) > limit:
            parts.append(buf)
            buf = piece
        else:
            buf += piece
        while len(buf) > limit:
            parts.append(buf[:limit])
            buf = buf[limit:]
    if buf:
        parts.append(buf)
    return parts


def _sentences(text: str) -> list[str]:
    out: list[str] = []
    buf = ""
    for ch in text:
        buf += ch
        if ch in "。！？!?\n" or (ch == "." and len(buf) > 40):
            out.append(buf)
            buf = ""
    if buf:
        out.append(buf)
    return out


def chunk_document(doc: ParsedDoc) -> list[Chunk]:
    limit = _target(doc.lang)
    overlap_chars = int(limit * settings.CHUNK_OVERLAP)

    chunks: list[Chunk] = []
    buf: list[Block] = []
    buf_len = 0

    def flush() -> None:
        nonlocal buf, buf_len
        if not buf:
            return
        text = "\n".join(b.text for b in buf).strip()
        if text:
            lang = detect_lang(text) if doc.lang == "en" else doc.lang
            chunks.append(
                Chunk(text=text, locator=buf[0].locator, kind="text", lang=lang, section=_section_of(buf[0]))
            )
        buf, buf_len = [], 0

    for block in doc.blocks:
        if block.kind == "code":
            # Код живёт отдельным чанком целиком, даже если он длиннее лимита.
            flush()
            chunks.append(
                Chunk(text=block.text, locator=block.locator, kind="code", lang=doc.lang,
                      section=_section_of(block))
            )
            continue

        if block.kind == "heading":
            # Заголовок открывает новый кусок и прилипает к нему как контекст.
            flush()
            buf, buf_len = [block], len(block.text)
            continue

        if buf and _unit(buf[-1]) != _unit(block):
            flush()

        for piece in split_long(block.text, limit):
            if buf_len + len(piece) > limit and buf:
                flush()
                # Хвост предыдущего чанка повторяем, чтобы не разрывать мысль на границе.
                if overlap_chars and chunks and chunks[-1].locator == block.locator:
                    tail = chunks[-1].text[-overlap_chars:]
                    buf = [Block(tail, chunks[-1].locator)]
                    buf_len = len(tail)
            buf.append(Block(piece, block.locator, block.kind))
            buf_len += len(piece)

    flush()
    return [c for c in chunks if is_useful(c)]


def is_useful(chunk: Chunk) -> bool:
    """Отсекаем оглавления и колонтитулы: строки из точек и номеров искать незачем."""
    text = chunk.text.strip()
    if len(text) < 24:
        return False
    if chunk.kind == "code":
        return True
    meaningful = sum(1 for ch in text if ch.isalnum())
    return meaningful / len(text) >= 0.55
