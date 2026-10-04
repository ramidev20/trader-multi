from __future__ import annotations

from .env_utils import is_dev_mode, load_project_env

load_project_env()

# This branch trades through the cTrader Open API instead of a MetaTrader 5
# terminal. `ctrader` exposes the MetaTrader5 module's functions, constants
# and result shapes, so everything importing `mt5` from here runs unchanged.
from .ctrader_compat import ctrader as mt5  # noqa: E402


def mt5_available() -> bool:
    return not is_dev_mode()
