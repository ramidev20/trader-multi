from __future__ import annotations

import json
from pathlib import Path
from typing import Any

ROOT_DIR = Path(__file__).resolve().parents[3]
# Its own folder, apart from the MetaTrader 5 build's config.json in the
# project root (both are gitignored, so switching branches never swaps them).
CONFIG_FILE = ROOT_DIR / "ctrader" / "config.json"
# The cTrader Open API application (register one at openapi.ctrader.com),
# shared by every account. Kept in the config file and never sent to the UI.
CTRADER_APP_KEY = "ctrader_app"


def ctrader_app_settings() -> dict[str, Any]:
    try:
        config = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    app = config.get(CTRADER_APP_KEY) if isinstance(config, dict) else None
    return app if isinstance(app, dict) else {}


def ctrader_app_credentials() -> tuple[str, str]:
    app = ctrader_app_settings()
    return str(app.get("client_id", "") or "").strip(), str(app.get("client_secret", "") or "").strip()
