from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parents[3]
ENV_FILE = ROOT_DIR / ".env"

_loaded = False


def load_project_env() -> None:
    global _loaded
    if _loaded:
        return
    load_dotenv(ENV_FILE, override=False)
    _loaded = True


def env_flag(name: str, default: bool = False) -> bool:
    load_project_env()
    value = os.getenv(name)
    if value is None:
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def is_dev_mode() -> bool:
    return env_flag("TRADER_DEV_MODE", False) or env_flag("DEV_MODE", False)
