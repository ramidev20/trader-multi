from __future__ import annotations

from typing import Any

from .env_utils import is_dev_mode, load_project_env

load_project_env()

try:
    import MetaTrader5 as _mt5  # type: ignore
except Exception:  # pragma: no cover
    _mt5 = None


class _MT5Fallback:
    TIMEFRAME_M1 = 1
    TIMEFRAME_M3 = 3
    TIMEFRAME_M5 = 5
    TIMEFRAME_M15 = 15

    ORDER_TYPE_BUY = 0
    ORDER_TYPE_SELL = 1
    ORDER_TYPE_BUY_LIMIT = 2
    ORDER_TYPE_SELL_LIMIT = 3
    TRADE_ACTION_DEAL = 1
    TRADE_ACTION_PENDING = 5
    ORDER_TIME_GTC = 0
    ORDER_FILLING_FOK = 0
    ORDER_FILLING_RETURN = 2
    TRADE_RETCODE_DONE = 10009

    def __getattr__(self, name: str) -> Any:
        def _missing(*_args, **_kwargs):
            return None

        return _missing

    @staticmethod
    def last_error() -> tuple[int, str]:
        return (-1, "MetaTrader5 module unavailable")


mt5 = _mt5 if _mt5 is not None else _MT5Fallback()


def mt5_available() -> bool:
    return _mt5 is not None and not is_dev_mode()
