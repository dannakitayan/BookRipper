"""Краулер документации: страницы сайта → markdown-файлы в Books/Web/.

Экстракция контента — на trafilatura, он отлично отделяет текст статьи от
навигации и реклам. Обход ссылок — вручную через BeautifulSoup, чтобы
управлять прогрессом и вежливой паузой между запросами самостоятельно.
"""

from __future__ import annotations

import re
import time
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup

from . import settings

Progress = Callable[[dict[str, Any]], None]


def _noop(_: dict[str, Any]) -> None:
    pass


def _slug(url: str) -> str:
    p = urlparse(url)
    path = (p.path or "/").strip("/") or "index"
    slug = re.sub(r"[^a-zA-Z0-9._-]+", "-", path).strip("-")
    return f"{p.netloc}__{slug}"[:150] or p.netloc


def _links(html: str, base_url: str) -> list[str]:
    soup = BeautifulSoup(html, "lxml")
    out = []
    for a in soup.find_all("a", href=True):
        href = urljoin(base_url, a["href"]).split("#")[0]
        if href.startswith("http"):
            out.append(href)
    return out


def _save(url: str, title: str, markdown_text: str) -> Path:
    settings.WEB_DIR.mkdir(parents=True, exist_ok=True)
    path = settings.WEB_DIR / f"{_slug(url)}.md"
    heading = f"# {title}\n\n" if title and not markdown_text.lstrip().startswith("#") else ""
    path.write_text(f"{heading}Source: {url}\n\n{markdown_text}", encoding="utf-8")
    return path


def crawl(
    start_url: str,
    *,
    max_pages: int = settings.CRAWL_MAX_PAGES,
    same_domain: bool = True,
    progress: Progress = _noop,
) -> list[Path]:
    import trafilatura

    domain = urlparse(start_url).netloc
    visited: set[str] = set()
    queue = [start_url]
    saved: list[Path] = []

    while queue and len(visited) < max_pages:
        url = queue.pop(0)
        if url in visited:
            continue
        visited.add(url)
        progress({"stage": "fetching", "url": url})

        try:
            downloaded = trafilatura.fetch_url(url)
        except Exception as e:  # сетевые сбои одной страницы не должны валить весь обход
            downloaded = None
            progress({"stage": "failed", "url": url, "error": str(e)})

        if not downloaded:
            if url not in queue:
                progress({"stage": "failed", "url": url, "error": "fetch failed"})
            continue

        md = trafilatura.extract(downloaded, output_format="markdown", url=url)
        if md and len(md.strip()) >= 200:
            meta = trafilatura.extract_metadata(downloaded)
            title = (meta.title if meta else None) or url
            path = _save(url, title, md)
            saved.append(path)
            progress({"stage": "saved", "url": url, "file": path.name, "title": title})
        else:
            progress({"stage": "skipped", "url": url, "error": "no extractable content"})

        for href in _links(downloaded, url):
            if same_domain and urlparse(href).netloc != domain:
                continue
            if href not in visited and href not in queue:
                queue.append(href)

        if queue:
            time.sleep(settings.CRAWL_DELAY_SECONDS)

    progress({"stage": "finished", "pages": len(visited), "saved": len(saved)})
    return saved
