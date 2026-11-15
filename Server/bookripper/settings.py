"""Пути и настройки моделей.

Значения для Ollama взяты из рабочей конфигурации DeepWikiLocal: ключевое здесь —
явный num_ctx. По умолчанию Ollama даёт маленькое окно и молча обрезает промпт,
из-за чего «теряется контекст», а ответы выходят поверхностными.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

# По умолчанию — корень репозитория (этот файл лежит в Server/bookripper/).
# BOOKRIPPER_ROOT переопределяет это, если Books/ и Projects/ вынесены отдельно.
ROOT = Path(os.environ.get("BOOKRIPPER_ROOT", str(Path(__file__).resolve().parents[2])))
BOOKS_DIR = ROOT / "Books"
PROJECTS_DIR = ROOT / "Projects"
WEB_DIR = BOOKS_DIR / "Web"  # сюда складывает страницы краулер — iter_library обходит Books/ рекурсивно

# Именно 127.0.0.1, а не localhost: на Windows имя сперва резолвится в ::1,
# и каждый запрос к Ollama получает лишние сотни миллисекунд на откат к IPv4.
OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")

# Многоязычная модель: один вектор на en и ja, иначе их результаты несравнимы.
EMBED_MODEL = os.environ.get("BOOKRIPPER_EMBED_MODEL", "bge-m3")
EMBED_DIM = 1024
EMBED_BATCH = 16

# Фильтрация идёт пачками и должна быть быстрой; синтез — реже и качественнее.
FILTER_MODEL = os.environ.get("BOOKRIPPER_FILTER_MODEL", "qwen3:8b")
SYNTH_MODEL = os.environ.get("BOOKRIPPER_SYNTH_MODEL", "qwen3:8b")

# На 8 ГБ VRAM окно в 32k у qwen3:8b уже не помещается вместе с весами
# (KV-кэш ~144 КБ на токен), поэтому держим окно под задачу, а не максимальное.
FILTER_OPTIONS = {"temperature": 0.2, "top_p": 0.8, "num_ctx": 8192}
SYNTH_OPTIONS = {"temperature": 0.2, "top_p": 0.8, "num_ctx": 16384}

# Выгружать модель сразу после запроса не нужно: следующая пачка придёт через секунды.
KEEP_ALIVE = "5m"

# Размер чанка в символах. У японского нет пробелов и выше плотность смысла,
# поэтому куски короче — иначе в один чанк попадает несколько сюжетов.
CHUNK_CHARS = {"ja": 450, "en": 1100}
CHUNK_OVERLAP = 0.15

SUPPORTED_SUFFIXES = {".epub", ".fb2", ".pdf", ".djvu", ".djv", ".txt", ".md"}

CRAWL_MAX_PAGES = 40
CRAWL_DELAY_SECONDS = 0.5  # вежливая пауза между запросами к одному домену

# Модель эмбеддинга менять на ходу нельзя — старые чанки уже лежат в её векторном
# пространстве, смена потребовала бы переиндексации всех проектов. А вот FILTER/SYNTH
# можно переключать свободно: они участвуют только в текущем запросе.
SETTINGS_FILE = ROOT / "bookripper_settings.json"


def load_overrides() -> None:
    """Выбор моделей из окна настроек переживает перезапуск сервера."""
    global FILTER_MODEL, SYNTH_MODEL
    try:
        data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    FILTER_MODEL = data.get("filter_model", FILTER_MODEL)
    SYNTH_MODEL = data.get("synth_model", SYNTH_MODEL)


def save_overrides(*, filter_model: str, synth_model: str) -> None:
    global FILTER_MODEL, SYNTH_MODEL
    FILTER_MODEL = filter_model
    SYNTH_MODEL = synth_model
    SETTINGS_FILE.write_text(
        json.dumps({"filter_model": filter_model, "synth_model": synth_model}), encoding="utf-8"
    )


load_overrides()


def project_dir(name: str) -> Path:
    """Папка проекта: там же лежит всё сгенерированное — индекс, кэш, выгрузки."""
    safe = "".join(c for c in name if c.isalnum() or c in " ._-()").strip()
    if not safe:
        raise ValueError("project name is empty after sanitising")
    return PROJECTS_DIR / safe
