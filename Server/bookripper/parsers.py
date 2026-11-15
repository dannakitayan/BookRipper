"""Разбор книг в блоки текста с локаторами.

Локатор полиморфен, и это принципиально: у PDF и DJVU есть настоящие страницы,
а EPUB и FB2 — поток текста, где страниц не существует вовсе. Выдумывать их значит
врать в ссылке, поэтому там локатор — раздел и номер абзаца.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

CJK = re.compile(r"[぀-ヿ㐀-䶿一-鿿]")
WS = re.compile(r"[ \t　]+")


def detect_lang(text: str) -> str:
    """Нам нужно отличать японский от английского — для чанкинга и промптов."""
    sample = text[:4000]
    if not sample:
        return "en"
    cjk = len(CJK.findall(sample))
    return "ja" if cjk / max(len(sample), 1) > 0.05 else "en"


@dataclass
class Block:
    text: str
    locator: dict[str, Any]
    kind: str = "text"  # text | heading | code


@dataclass
class ParsedDoc:
    title: str
    lang: str
    fmt: str
    blocks: list[Block] = field(default_factory=list)
    pages: int | None = None
    needs_ocr: bool = False
    warnings: list[str] = field(default_factory=list)


def _clean(s: str) -> str:
    return WS.sub(" ", s.replace(" ", " ")).strip()


# ── EPUB ──────────────────────────────────────────────────────────────────


def parse_epub(path: Path) -> ParsedDoc:
    import warnings

    import ebooklib
    from bs4 import BeautifulSoup, XMLParsedAsHTMLWarning
    from ebooklib import epub

    # Содержимое EPUB — XHTML; html-парсер выбран намеренно, он терпимее к кривой вёрстке.
    warnings.filterwarnings("ignore", category=XMLParsedAsHTMLWarning)

    book = epub.read_epub(str(path), options={"ignore_ncx": True})
    meta_title = book.get_metadata("DC", "title")
    title = book_title(meta_title[0][0] if meta_title else None, path)

    blocks: list[Block] = []
    section = "start"
    for item in book.get_items_of_type(ebooklib.ITEM_DOCUMENT):
        # Оглавление — не текст книги: оно дало бы чанк из одних названий глав.
        if "nav" in (getattr(item, "properties", None) or []) or item.get_name().endswith("nav.xhtml"):
            continue
        soup = BeautifulSoup(item.get_content(), "lxml")
        para = 0
        for el in soup.find_all(["h1", "h2", "h3", "h4", "p", "pre", "li", "blockquote"]):
            text = _clean(el.get_text("\n" if el.name == "pre" else " "))
            if not text:
                continue
            if el.name in ("h1", "h2", "h3", "h4"):
                section = text[:120]
                para = 0
                blocks.append(Block(text, {"kind": "section", "section": section, "paragraph": 0}, "heading"))
                continue
            para += 1
            kind = "code" if el.name == "pre" else "text"
            blocks.append(Block(text, {"kind": "section", "section": section, "paragraph": para}, kind))

    full = " ".join(b.text for b in blocks[:50])
    return ParsedDoc(title=title, lang=detect_lang(full), fmt="EPUB", blocks=blocks)


# ── FB2 ───────────────────────────────────────────────────────────────────


def _fb2_root(path: Path) -> ET.Element:
    # Встречается и как zip (.fb2.zip), и как голый XML.
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as z:
            name = next((n for n in z.namelist() if n.lower().endswith(".fb2")), z.namelist()[0])
            return ET.fromstring(z.read(name))
    return ET.parse(path).getroot()


def parse_fb2(path: Path) -> ParsedDoc:
    root = _fb2_root(path)
    ns = {"fb": root.tag.split("}")[0].strip("{")} if "}" in root.tag else {}

    def tag(el: ET.Element) -> str:
        return el.tag.split("}")[-1]

    title = path.stem
    for el in root.iter():
        if tag(el) == "book-title" and (el.text or "").strip():
            title = el.text.strip()
            break

    blocks: list[Block] = []
    section = "start"
    para = 0
    bodies = [el for el in root.iter() if tag(el) == "body"]
    for body in bodies:
        # Внутрь <title> не спускаемся: его собственные <p> дали бы второй, дублирующий блок.
        skip: set[ET.Element] = set()
        for el in body.iter():
            if el in skip:
                continue
            name = tag(el)
            if name == "title":
                skip.update(el.iter())
                text = _clean(" ".join(t.strip() for t in el.itertext()))
                if text:
                    section, para = text[:120], 0
                    blocks.append(
                        Block(text, {"kind": "section", "section": section, "paragraph": 0}, "heading")
                    )
            elif name in ("p", "v", "subtitle"):
                text = _clean(" ".join(t.strip() for t in el.itertext()))
                if text:
                    para += 1
                    blocks.append(Block(text, {"kind": "section", "section": section, "paragraph": para}))
            elif name == "code":
                text = _clean(" ".join(t.strip() for t in el.itertext()))
                if text:
                    para += 1
                    blocks.append(
                        Block(text, {"kind": "section", "section": section, "paragraph": para}, "code")
                    )

    _ = ns  # пространства имён во fb2 разнятся, поэтому идём по локальным именам
    full = " ".join(b.text for b in blocks[:50])
    return ParsedDoc(title=title, lang=detect_lang(full), fmt="FB2", blocks=blocks)


# ── PDF ───────────────────────────────────────────────────────────────────

# Ниже этого на страницу — почти наверняка скан без текстового слоя.
SCAN_CHARS_PER_PAGE = 120


# Метаданные PDF врут чаще, чем помогают: у K&R в title лежит «Preface».
GENERIC_TITLES = {
    "preface", "contents", "table of contents", "untitled", "document", "introduction",
    "index", "chapter", "cover", "title page", "foreword", "microsoft word",
}


def book_title(meta_title: str | None, path: Path) -> str:
    """Берём заголовок из метаданных, только если он похож на название книги."""
    t = (meta_title or "").strip()
    if len(t) >= 8 and t.lower() not in GENERIC_TITLES and not t.lower().startswith("microsoft word"):
        return t

    # Имя файла у скачанных книг зашумлено: «Title -- Author -- ISBN -- Anna's Archive».
    stem = path.stem.split(" -- ")[0]
    stem = re.sub(r"[._]+", " ", stem)
    stem = re.sub(r"\s{2,}", " ", stem).strip(" -")
    return stem or path.stem


def parse_pdf(path: Path) -> ParsedDoc:
    import pymupdf

    doc = pymupdf.open(path)
    title = book_title((doc.metadata or {}).get("title"), path)

    blocks: list[Block] = []
    total_chars = 0
    for page_index in range(doc.page_count):
        page = doc[page_index]
        page_no = page_index + 1
        for b in page.get_text("blocks"):
            text = _clean(b[4])
            if not text:
                continue
            total_chars += len(text)
            blocks.append(Block(text, {"kind": "page", "page": page_no}))

    pages = doc.page_count
    doc.close()

    needs_ocr = pages > 0 and total_chars / pages < SCAN_CHARS_PER_PAGE
    warnings = ["looks like a scan: no usable text layer, OCR needed"] if needs_ocr else []
    full = " ".join(b.text for b in blocks[:80])
    return ParsedDoc(
        title=str(title),
        lang=detect_lang(full),
        fmt="PDF",
        blocks=blocks,
        pages=pages,
        needs_ocr=needs_ocr,
        warnings=warnings,
    )


# ── DJVU ──────────────────────────────────────────────────────────────────


def parse_djvu(path: Path) -> ParsedDoc:
    """Чистого Python-парсера нет: нужен djvutxt из DjVuLibre."""
    exe = shutil.which("djvutxt")
    if not exe:
        raise RuntimeError(
            "djvutxt not found. Install DjVuLibre and make sure djvutxt is on PATH, "
            "or convert the file to PDF first."
        )
    out = subprocess.run(
        [exe, "--detail=page", str(path)], capture_output=True, text=True, encoding="utf-8", errors="replace"
    )
    if out.returncode != 0:
        raise RuntimeError(f"djvutxt failed: {out.stderr[:300]}")

    blocks: list[Block] = []
    page_no = 0
    for chunk in out.stdout.split("\f"):
        page_no += 1
        for part in re.split(r"\n\s*\n", chunk):
            text = _clean(part)
            if text:
                blocks.append(Block(text, {"kind": "page", "page": page_no}))

    full = " ".join(b.text for b in blocks[:80])
    return ParsedDoc(title=path.stem, lang=detect_lang(full), fmt="DJVU", blocks=blocks, pages=page_no)


# ── TXT / MD ──────────────────────────────────────────────────────────────


def parse_text(path: Path) -> ParsedDoc:
    raw = path.read_text(encoding="utf-8", errors="replace")
    blocks: list[Block] = []
    section, para = "start", 0
    in_code = False
    title: str | None = None
    for part in re.split(r"\n\s*\n", raw):
        # Отступ проверяем до strip — иначе признак кода теряется.
        indented = part.startswith(("    ", "\t"))
        text = part.strip()
        if not text:
            continue
        if text.startswith("```"):
            in_code = not in_code
        if text.startswith("#"):
            section = text.lstrip("#").strip().rstrip("¶").strip()[:120]
            para = 0
            # Первый заголовок — почти всегда заголовок страницы: краулер его туда и кладёт.
            if title is None:
                title = section
            blocks.append(Block(section, {"kind": "section", "section": section, "paragraph": 0}, "heading"))
            continue
        para += 1
        kind = "code" if (in_code or indented) else "text"
        blocks.append(Block(_clean(text) if kind == "text" else text,
                            {"kind": "section", "section": section, "paragraph": para}, kind))

    return ParsedDoc(
        title=title or path.stem, lang=detect_lang(raw), fmt=path.suffix.upper().lstrip("."), blocks=blocks
    )


PARSERS = {
    ".epub": parse_epub,
    ".fb2": parse_fb2,
    ".pdf": parse_pdf,
    ".djvu": parse_djvu,
    ".djv": parse_djvu,
    ".txt": parse_text,
    ".md": parse_text,
}


def parse(path: Path) -> ParsedDoc:
    fn = PARSERS.get(path.suffix.lower())
    if not fn:
        raise ValueError(f"unsupported format: {path.suffix}")
    return fn(path)


def iter_library(books_dir: Path) -> Iterator[Path]:
    for p in sorted(books_dir.rglob("*")):
        if p.is_file() and p.suffix.lower() in PARSERS:
            yield p
