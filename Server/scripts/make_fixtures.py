"""Тестовые книги трёх форматов: англ. EPUB, японский FB2 и PDF с текстовым слоем.

Нужны, чтобы проверять парсеры и поиск до того, как в Books/ появятся настоящие книги,
и чтобы потом ловить регрессии на известном содержимом.
"""

from __future__ import annotations

import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "tests" / "fixtures"

EPUB_CHAPTERS = [
    (
        "Chapter 1. Ownership",
        [
            "Every value in the language has a single owning variable. When the owner goes out of "
            "scope, the value is dropped and its memory released. This is the whole of the rule.",
            "Borrowing lets other parts of the program read a value without taking ownership of it. "
            "A shared borrow may be taken many times at once; a mutable borrow may not.",
            ("fn main() {\n"
             "    let s = String::from(\"hello\");\n"
             "    takes_ownership(s);\n"
             "    // s is no longer valid here\n"
             "}"),
        ],
    ),
    (
        "Chapter 2. Lifetimes",
        [
            "A lifetime is the region of code for which a reference is valid. The compiler infers "
            "most lifetimes; annotations are needed only when several references are related.",
            "Dangling references are rejected at compile time. The borrow checker proves that no "
            "reference outlives the data it points to, which removes a whole class of memory bugs.",
        ],
    ),
    (
        "Chapter 3. Concurrency",
        [
            "Data races are prevented by the same ownership rules that prevent dangling pointers. "
            "Sending a value between threads transfers ownership of it.",
            "Channels move values from one thread to another. After a send, the sending thread can "
            "no longer use the value, so no lock is required to keep it consistent.",
        ],
    ),
]

FB2_SECTIONS = [
    (
        "第1章 所有権",
        [
            "すべての値には所有者となる変数がひとつだけ存在する。所有者がスコープを抜けると、値は破棄され、"
            "メモリは解放される。これが規則のすべてである。",
            "借用を使えば、所有権を奪わずに値を読むことができる。共有借用は同時に何度でも取得できるが、"
            "可変借用はひとつしか取得できない。",
        ],
    ),
    (
        "第2章 並行処理",
        [
            "データ競合は、ダングリングポインタを防ぐのと同じ所有権の規則によって防がれる。"
            "スレッド間で値を送ると、その所有権も移動する。",
            "可視性の保証は、スレッド間の順序関係が確立された場合にのみ成立する。",
        ],
    ),
]

PDF_PAGES = [
    (
        "Memory ordering",
        "The happens-before relation is a partial order: if A happens-before B, then the effects "
        "of A are visible to B. Unlocking a mutex happens-before every subsequent lock of it.",
    ),
    (
        "Acquire and release",
        "Acquire and release orderings are used in pairs. A release store synchronizes with an "
        "acquire load that reads the stored value, which establishes happens-before between them.",
    ),
    (
        "Sequential consistency",
        "Sequentially consistent ordering adds a single total order over all such operations. It "
        "is the easiest model to reason about and the most expensive one to execute.",
    ),
    (
        "Relaxed ordering",
        "Relaxed operations guarantee atomicity but impose no ordering. They are appropriate for "
        "counters whose value is inspected only after other synchronization has happened.",
    ),
]


def make_epub(path: Path) -> None:
    from ebooklib import epub

    book = epub.EpubBook()
    book.set_identifier("bookripper-fixture-epub")
    book.set_title("Ownership and Borrowing")
    book.set_language("en")
    book.add_author("Test Author")

    items = []
    for i, (title, paragraphs) in enumerate(EPUB_CHAPTERS, 1):
        body = [f"<h2>{title}</h2>"]
        for p in paragraphs:
            tag = "pre" if p.startswith("fn ") else "p"
            body.append(f"<{tag}>{p}</{tag}>")
        ch = epub.EpubHtml(title=title, file_name=f"ch{i}.xhtml", lang="en")
        ch.content = "<html><body>" + "".join(body) + "</body></html>"
        book.add_item(ch)
        items.append(ch)

    book.toc = tuple(items)
    book.spine = ["nav", *items]
    book.add_item(epub.EpubNcx())
    book.add_item(epub.EpubNav())
    epub.write_epub(str(path), book)


def make_fb2(path: Path) -> None:
    parts = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">',
        "<description><title-info><book-title>所有権とメモリモデル</book-title>"
        "<lang>ja</lang></title-info></description>",
        "<body>",
    ]
    for title, paragraphs in FB2_SECTIONS:
        parts.append(f"<section><title><p>{title}</p></title>")
        parts.extend(f"<p>{p}</p>" for p in paragraphs)
        parts.append("</section>")
    parts.append("</body></FictionBook>")
    path.write_text("\n".join(parts), encoding="utf-8")


def make_pdf(path: Path) -> None:
    import pymupdf

    doc = pymupdf.open()
    for heading, body in PDF_PAGES:
        page = doc.new_page()
        page.insert_text((72, 90), heading, fontname="helv", fontsize=16)
        wrapped, line = [], ""
        for word in body.split():
            if len(line) + len(word) > 70:
                wrapped.append(line)
                line = word
            else:
                line = f"{line} {word}".strip()
        wrapped.append(line)
        for i, ln in enumerate(wrapped):
            page.insert_text((72, 130 + i * 18), ln, fontname="helv", fontsize=11)
    doc.set_metadata({"title": "Atomics in Practice"})
    doc.save(str(path))
    doc.close()


def make_scan_pdf(path: Path) -> None:
    """PDF без текстового слоя — проверяем, что индексатор его распознаёт как скан."""
    import pymupdf

    doc = pymupdf.open()
    for _ in range(3):
        page = doc.new_page()
        page.draw_rect(pymupdf.Rect(72, 72, 500, 700), color=(0.8, 0.8, 0.8), fill=(0.93, 0.93, 0.93))
    doc.save(str(path))
    doc.close()


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    make_epub(OUT / "ownership.epub")
    make_fb2(OUT / "memory-model.fb2")
    make_pdf(OUT / "atomics.pdf")
    make_scan_pdf(OUT / "scanned.pdf")
    (OUT / "notes.txt").write_text(
        "# Reading notes\n\n"
        "Ownership removes the need for a garbage collector.\n\n"
        "    let v = vec![1, 2, 3];\n\n"
        "Borrowing is checked at compile time.\n",
        encoding="utf-8",
    )
    for f in sorted(OUT.iterdir()):
        print(f"{f.name:22} {f.stat().st_size:>8} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
