from __future__ import annotations

# This branch trades through the cTrader Open API instead of a MetaTrader 5
# terminal. `ctrader` exposes the MetaTrader5 module's functions, constants
# and result shapes, so everything importing `mt5` from here runs unchanged.
from .ctrader_compat import ctrader as mt5  # noqa: F401
