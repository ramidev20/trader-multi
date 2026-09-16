from __future__ import annotations

from copy import deepcopy
from datetime import datetime
from threading import RLock
from typing import Any

_lock = RLock()

_state: dict[str, Any] = {
    "remote_control": {
        "connections": 0,
        "last_command_at": None,
        "last_command_action": None,
    },
    "manual_trade": {
        "auto_close_at": None,
        "scheduled_at": None,
    },
    "strategy": {
        "running": False,
        "mode": None,
        "started_at": None,
        "tasks": [],
        "start_time": None,
        "end_time": None,
        "last_stop_reason": None,
    },
    "zone_strategy": {
        "demand": {
            "running": False,
            "phase": "idle",
            "symbol": None,
            "trigger_price": None,
            "trigger_zone_type": "demand",
            "m5_target_zone_type": None,
            "m1_target_zone_type": None,
            "order_kind": None,
            "manual_sl_distance": None,
            "sl_distance_in_pips": True,
            "liquidity_buffer_pips": None,
            "lot": None,
            "risk_percent": None,
            "tp": None,
            "tp_in_pips": True,
            "started_at": None,
            "triggered_at": None,
            "m5_zone": None,
            "m1_zone": None,
            "sl_liquidity_price": None,
            "placed_order": None,
            "last_stop_reason": None,
            "last_error": None,
        },
        "supply": {
            "running": False,
            "phase": "idle",
            "symbol": None,
            "trigger_price": None,
            "trigger_zone_type": "supply",
            "m5_target_zone_type": None,
            "m1_target_zone_type": None,
            "order_kind": None,
            "manual_sl_distance": None,
            "sl_distance_in_pips": True,
            "liquidity_buffer_pips": None,
            "lot": None,
            "risk_percent": None,
            "tp": None,
            "tp_in_pips": True,
            "started_at": None,
            "triggered_at": None,
            "m5_zone": None,
            "m1_zone": None,
            "sl_liquidity_price": None,
            "placed_order": None,
            "last_stop_reason": None,
            "last_error": None,
        },
    },
    "liquidity_levels": [],
    "orders": [],
    "sessions": {},
    "logs": {
        "search": [],
        "adapter": [],
    },
}


def now_label() -> str:
    return datetime.now().strftime("%H:%M:%S")


def snapshot() -> dict[str, Any]:
    with _lock:
        return deepcopy(_state)


def get(path: str, default: Any = None) -> Any:
    keys = path.split(".")
    with _lock:
        cursor: Any = _state
        for key in keys:
            if not isinstance(cursor, dict) or key not in cursor:
                return default
            cursor = cursor[key]
        return deepcopy(cursor)


def set_path(path: str, value: Any) -> None:
    keys = path.split(".")
    with _lock:
        cursor: Any = _state
        for key in keys[:-1]:
            nxt = cursor.get(key)
            if not isinstance(nxt, dict):
                nxt = {}
                cursor[key] = nxt
            cursor = nxt
        cursor[keys[-1]] = value


def patch_path(path: str, values: dict[str, Any]) -> None:
    keys = path.split(".")
    with _lock:
        cursor: Any = _state
        for key in keys:
            nxt = cursor.get(key)
            if not isinstance(nxt, dict):
                nxt = {}
                cursor[key] = nxt
            cursor = nxt
        cursor.update(values)


def append_log(kind: str, message: str) -> None:
    key = kind if kind in {"search", "adapter"} else "search"
    line = f"[{now_label()}] {message}"
    with _lock:
        logs = _state["logs"][key]
        logs.append(line)
        if len(logs) > 500:
            del logs[:-500]


def clear_logs(kind: str) -> None:
    if kind not in {"search", "adapter"}:
        return
    with _lock:
        _state["logs"][kind] = []


def replace_list(path: str, value: list[Any]) -> None:
    set_path(path, list(value))


def append_list(path: str, value: Any, limit: int | None = None) -> None:
    keys = path.split(".")
    with _lock:
        cursor: Any = _state
        for key in keys[:-1]:
            nxt = cursor.get(key)
            if not isinstance(nxt, dict):
                nxt = {}
                cursor[key] = nxt
            cursor = nxt
        lst = cursor.get(keys[-1])
        if not isinstance(lst, list):
            lst = []
            cursor[keys[-1]] = lst
        lst.append(value)
        if limit and len(lst) > limit:
            del lst[:-limit]
