"""Тонкий клиент Ollama: эмбеддинги и чат.

Намеренно без SDK — два HTTP-вызова, зато видно, какие опции реально уходят в модель.
"""

from __future__ import annotations

import re
from typing import Any, Iterable, Sequence

import httpx
import numpy as np

from . import settings

_THINK = re.compile(r"<think>.*?</think>\s*", re.DOTALL)


class OllamaError(RuntimeError):
    pass


# Одно живое соединение на весь процесс: индексация шлёт сотни запросов подряд,
# и установка соединения на каждый из них стоила дороже самой модели.
_client = httpx.Client(base_url=settings.OLLAMA_HOST, timeout=60)


def _post(path: str, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
    try:
        r = _client.post(path, json=payload, timeout=timeout)
        r.raise_for_status()
        return r.json()
    except httpx.HTTPStatusError as e:
        raise OllamaError(f"{path} -> {e.response.status_code}: {e.response.text[:300]}") from e
    except httpx.HTTPError as e:
        raise OllamaError(f"{path} is unreachable at {settings.OLLAMA_HOST}: {e}") from e


def available_models() -> list[str]:
    """Поднимает OllamaError, если Ollama недоступна — отличать от «моделей просто нет»."""
    try:
        r = _client.get("/api/tags", timeout=5)
        r.raise_for_status()
        return [m["name"] for m in r.json().get("models", [])]
    except httpx.HTTPError as e:
        raise OllamaError(f"Ollama is unreachable at {settings.OLLAMA_HOST}: {e}") from e


def embed(texts: Sequence[str], *, model: str | None = None) -> np.ndarray:
    """Векторы, нормированные по L2 — тогда косинус это просто скалярное произведение."""
    if not texts:
        return np.zeros((0, settings.EMBED_DIM), dtype=np.float32)

    model = model or settings.EMBED_MODEL
    out: list[list[float]] = []
    for i in range(0, len(texts), settings.EMBED_BATCH):
        batch = list(texts[i : i + settings.EMBED_BATCH])
        data = _post(
            "/api/embed",
            {"model": model, "input": batch, "keep_alive": settings.KEEP_ALIVE},
            timeout=300,
        )
        got = data.get("embeddings")
        if not got or len(got) != len(batch):
            raise OllamaError(f"embed returned {len(got or [])} vectors for {len(batch)} inputs")
        out.extend(got)

    arr = np.asarray(out, dtype=np.float32)
    norms = np.linalg.norm(arr, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return arr / norms


def chat(
    messages: Iterable[dict[str, str]],
    *,
    model: str | None = None,
    options: dict[str, Any] | None = None,
    think: bool = False,
    timeout: float = 600,
) -> str:
    """Один ответ целиком. Рассуждение qwen3 в ответ не пускаем — нам нужен результат."""
    data = _post(
        "/api/chat",
        {
            "model": model or settings.FILTER_MODEL,
            "messages": list(messages),
            "stream": False,
            "think": think,
            "options": options or settings.FILTER_OPTIONS,
            "keep_alive": settings.KEEP_ALIVE,
        },
        timeout=timeout,
    )
    content = data.get("message", {}).get("content", "")
    return _THINK.sub("", content).strip()
