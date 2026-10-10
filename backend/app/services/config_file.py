from __future__ import annotations

from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[3]
# Its own folder, like the cTrader build's ctrader/config.json (both are
# gitignored, so switching branches never swaps them).
CONFIG_FILE = ROOT_DIR / "mt5" / "config.json"
