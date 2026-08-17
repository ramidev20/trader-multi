from __future__ import annotations

import json
import os
import secrets
import asyncio
from copy import deepcopy
from datetime import datetime
from pathlib import Path
from threading import RLock
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import BaseModel

from .services.mt5_compat import mt5, mt5_available
from .services.env_utils import is_dev_mode, load_project_env
from .services.risk_service import start_risk_monitor, stop_risk_monitor
from .services.mt5_lock import MT5_LOCK
from .services.runtime_state import append_log, get as state_get, patch_path as state_patch, set_path as state_set, snapshot
from .services.session_service import connect_account, disconnect_account, disconnect_all, list_sessions, submit_adapter_command
from .services.session_service import master_adapter_ready
from .services.strategy_service import (
    Liquidity,
    manager as strategy_manager,
    open_manual_position,
    running_tasks,
    start_strategy_system,
    stop_strategy_system,
    close_all_positions,
    calculate_manual_lot,
    _initialize_mt5_for_account,
)
from .services.task_manager import set_runtime_logger

ROOT_DIR = Path(__file__).resolve().parents[2]
load_project_env()
CONFIG_FILE = ROOT_DIR / "config.json"
FRONTEND_DIST = ROOT_DIR / "frontend" / "dist"
FRONTEND_INDEX = FRONTEND_DIST / "index.html"
SYMBOL_DEFAULT = "XAUUSD"
REMOTE_COMMAND_CACHE_LIMIT = 500
_remote_command_cache: dict[str, dict[str, Any]] = {}
_remote_command_lock = RLock()

DEFAULT_CONFIG: dict[str, Any] = {
    "trading_accounts": [],
    "master_account_login": None,
    "remote_control": {
        "enabled": False,
        "token": "",
        "receiver_url": "",
    },
    "search_config": {
        "lot": 0.05,
        "timeframe": "M1",
        "max_positions": 3,
        "orders_limit": 10,
        "pips": 25,
        "max_pips": 70,
        "enable_pullback": False,
        "pullback_pips": 20,
        "tp": 150,
        "sl": 500,
        "enable_liquidity": True,
        "stop_on_first_close": True,
    },
    "theme_mode": "LIGHT",
    "ui_zoom_percent": 100,
    "notification_settings": {
        "enabled": True,
        "show_warnings": True,
        "show_success": True,
        "show_info": False,
    },
}


class ThemeUpdate(BaseModel):
    theme_mode: str


class ZoomUpdate(BaseModel):
    ui_zoom_percent: int


class SearchConfigUpdate(BaseModel):
    search_config: dict[str, Any]


class RemoteControlSettingsUpdate(BaseModel):
    enabled: bool
    token: str
    receiver_url: str = ""


class NotificationSettingsUpdate(BaseModel):
    enabled: bool = True
    show_warnings: bool = True
    show_success: bool = True
    show_info: bool = False


class AccountPayload(BaseModel):
    username: str
    user: int
    password: str
    server: str
    terminal_path: str
    role: str = "sub"
    risk_percent: float | None = None
    risk_multiplier: float | None = None
    order_delay_sec: int = 0


class ActionPayload(BaseModel):
    action: str
    payload: dict[str, Any] | None = None


class StrategyStartPayload(BaseModel):
    liquidity_enabled: bool = True
    start_time: str | None = None
    end_time: str | None = None
    interval_sec: int = 1


class OpenPositionPayload(BaseModel):
    side: str
    lot: float | None = None
    symbol: str = "XAUUSD"
    order_kind: str = "MARKET"
    limit_price: float | None = None
    tp: float | None = None
    sl: float | None = None
    tp_in_pips: bool = False
    sl_in_pips: bool = False
    risk_percent: float | None = None
    advanced: bool = False
    sl_price: float | None = None
    ratio: float = 3.0
    tp1_ratio: float = 1.0
    tp2_ratio: float = 1.0
    tp3_ratio: float = 1.0
    tp2_enabled: bool = False
    tp3_enabled: bool = False
    tp1_percent: float = 100.0
    tp2_percent: float = 100.0
    auto_close_at: datetime | None = None


def _remote_token() -> str:
    config = _load_config()
    remote_control = config.get("remote_control", {})
    token = str(remote_control.get("token", "")).strip()
    return token or str(os.environ.get("TRADER_REMOTE_TOKEN", "")).strip()


def _remote_control_enabled() -> bool:
    config = _load_config()
    remote_control = config.get("remote_control", {})
    env_enabled = str(os.environ.get("TRADER_REMOTE_ENABLED", "")).lower() in {"1", "true", "yes", "on"}
    return bool(remote_control.get("enabled", False)) or env_enabled


def _execute_remote_command(action_name: str, data: dict[str, Any]) -> dict[str, Any]:
    """Run remote commands through the same guarded operations as the local UI."""
    if action_name == "open":
        return open_position(OpenPositionPayload(**data))
    if action_name == "close_all":
        return close_positions()
    if action_name == "start_search":
        return start_strategy(StrategyStartPayload(**data))
    if action_name == "stop_search":
        return stop_strategy()
    raise ValueError(f"Unsupported remote action: {action_name}")


def _receiver_open_settings(data: dict[str, Any]) -> tuple[dict[str, Any], int, float, int]:
    """Force remote opens to use this receiver's account configuration."""
    config = _load_config()
    accounts = config.get("trading_accounts", [])
    master_login = int(config.get("master_account_login", 0) or 0)
    master = next(
        (
            account for account in accounts
            if int(account.get("user", 0) or 0) == master_login
        ),
        None,
    ) or next(
        (account for account in accounts if str(account.get("role", "sub")).lower() == "master"),
        None,
    )
    if not master:
        raise RuntimeError("No receiver master account is configured.")
    receiver_login = int(master.get("user", 0) or 0)
    risk_percent = float(master.get("risk_percent", master.get("risk_multiplier", 1.0)) or 1.0)
    delay_seconds = max(0, int(master.get("order_delay_sec", master.get("orderDelaySec", 0)) or 0))
    receiver_data = dict(data)
    receiver_data["risk_percent"] = risk_percent
    receiver_data["lot"] = None
    return receiver_data, receiver_login, risk_percent, delay_seconds


class LotCalculationPayload(BaseModel):
    side: str
    risk_percent: float | None = None
    sl: float
    sl_in_pips: bool = True
    sl_price: bool = False
    symbol: str = "XAUUSD"


class LiquidityLevelPayload(BaseModel):
    price: float
    side: str


class RiskStartPayload(BaseModel):
    interval_sec: int = 60
    risk_percent: float = 1.0
    profit_percent: float = 1.0
    orders_limit: int = 10


app = FastAPI(title="MT5 Trader API", version="0.3.0")


@app.on_event("shutdown")
def stop_account_adapters_on_backend_shutdown() -> None:
    """Adapters are explicit Dashboard connections, never a backend startup task."""
    disconnect_all()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    # Keep wildcard origin compatible with browser preflight on JSON POST.
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _runtime_logger(message: str, level: str) -> None:
    level_label = str(level or "info").upper()
    # Route strategy/risk lines by task prefix.
    log_kind = "risk" if any(x in message for x in ("account_management", "risk")) else "search"
    append_log(log_kind, f"[{level_label}] {message}")


set_runtime_logger(_runtime_logger)


def _load_config() -> dict[str, Any]:
    config = deepcopy(DEFAULT_CONFIG)
    if not CONFIG_FILE.exists():
        return config
    try:
        loaded = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to read config: {exc}") from exc
    if isinstance(loaded, dict):
        config.update(loaded)
    if not isinstance(config.get("trading_accounts"), list):
        config["trading_accounts"] = []
    for account in config["trading_accounts"]:
        if "risk_percent" not in account and "risk_multiplier" in account:
            account["risk_percent"] = account.get("risk_multiplier")
        account.pop("risk_multiplier", None)
        account.pop("orderDelaySec", None)
        account["order_delay_sec"] = int(account.get("order_delay_sec", 0) or 0)
    if not isinstance(config.get("search_config"), dict):
        config["search_config"] = dict(DEFAULT_CONFIG["search_config"])
    if not isinstance(config.get("remote_control"), dict):
        config["remote_control"] = dict(DEFAULT_CONFIG["remote_control"])
    config["remote_control"] = {
        "enabled": bool(config["remote_control"].get("enabled", False)),
        "token": str(config["remote_control"].get("token", "") or ""),
        "receiver_url": str(config["remote_control"].get("receiver_url", "") or "").strip(),
    }
    if not isinstance(config.get("notification_settings"), dict):
        config["notification_settings"] = dict(DEFAULT_CONFIG["notification_settings"])
    config["notification_settings"] = {
        "enabled": bool(config["notification_settings"].get("enabled", True)),
        "show_warnings": bool(config["notification_settings"].get("show_warnings", True)),
        "show_success": bool(config["notification_settings"].get("show_success", True)),
        "show_info": bool(config["notification_settings"].get("show_info", False)),
    }
    config["ui_zoom_percent"] = min(150, max(70, int(config.get("ui_zoom_percent", 100) or 100)))
    for unused_key in (
        "time",
        "order_delay",
        "risk_percent",
        "start_at",
        "end_at",
        "start_time",
        "end_time",
        "end_enabled",
    ):
        config["search_config"].pop(unused_key, None)
    config.pop("terminal_path", None)
    config.pop("copy_accounts", None)
    return config


def _save_config(config: dict[str, Any]) -> None:
    CONFIG_FILE.write_text(json.dumps(config, indent=4), encoding="utf-8")


def _ensure_config_file() -> None:
    """Create a usable empty configuration on a first launch."""
    if CONFIG_FILE.exists():
        return
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(deepcopy(DEFAULT_CONFIG), indent=4), encoding="utf-8")


@app.on_event("startup")
def ensure_config_on_startup() -> None:
    _ensure_config_file()


def _refresh_bootstrap_cache() -> dict[str, Any]:
    config = _load_config()
    state_set("bootstrap_cache.settings", config)
    return config


def _sessions_by_login(accounts: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
    items = list_sessions(accounts)
    out: dict[int, dict[str, Any]] = {}
    for item in items:
        try:
            out[int(item.get("login", 0))] = item
        except Exception:
            pass
    state_set("sessions", out)
    return out


def _to_front_account(index: int, account: dict[str, Any], session: dict[str, Any] | None) -> dict[str, Any]:
    login = int(account.get("user", 0) or 0)
    role = str(account.get("role", "sub")).upper()
    session_state = str((session or {}).get("state", "")).lower()
    connected = session_state == "connected"
    starting = session_state == "starting"
    disconnected = session_state in {"", "disconnected", "stopped", "error"}
    session_balance = float((session or {}).get("balance", 0) or 0)
    session_equity = float((session or {}).get("equity", 0) or 0)
    balance = session_balance if session_balance > 0 else float(account.get("balance", 0) or 0)
    equity = session_equity if session_equity > 0 else float(account.get("equity", balance) or balance)
    pnl = float(equity - balance)
    return {
        "id": index + 1,
        "name": str(account.get("username", f"Account {index + 1}")),
        "role": "MASTER" if role == "MASTER" else "SUB",
        "login": str(login),
        "password": str(account.get("password", "")),
        "server": str(account.get("server", "")),
        "path": str(account.get("terminal_path", "")),
        "status": "Connected" if connected else "Starting" if starting else "Disconnected" if disconnected else session_state.title(),
        "sessionState": session_state,
        "balance": balance,
        "equity": equity,
        "pnl": pnl,
        "risk": float(account.get("risk_percent", account.get("risk_multiplier", 1.0)) or 1.0),
        "orderDelaySec": int(account.get("order_delay_sec", account.get("orderDelaySec", 0)) or 0),
        "latency": float((session or {}).get("latency", 0.0) or 0.0) or None,
        "algoEnabled": (session or {}).get("algo_enabled"),
        "color": "from-blue-600 to-indigo-600" if role == "MASTER" else "from-cyan-500 to-blue-600",
    }


def _metrics(accounts: list[dict[str, Any]]) -> dict[str, Any]:
    total_balance = sum(float(a.get("balance", 0) or 0) for a in accounts)
    total_equity = sum(float(a.get("equity", a.get("balance", 0)) or 0) for a in accounts)
    total_pnl = sum(float(a.get("pnl", 0) or 0) for a in accounts)
    connected = sum(1 for a in accounts if str(a.get("status", "Disconnected")).lower() == "connected")
    return {
        "balance": total_balance,
        "equity": total_equity,
        "pnl": total_pnl,
        "connected": connected,
        "total": len(accounts),
    }


def _parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except Exception:
        return None


def _sanitize_terminal_path(value: str) -> str:
    path = str(value or "").strip()
    if len(path) >= 2 and path[0] == path[-1] and path[0] in {'"', "'"}:
        path = path[1:-1].strip()
    return path


def _safe_int(value: Any) -> int:
    try:
        return int(value)
    except Exception:
        return 0


def _to_iso_from_epoch(value: Any) -> str | None:
    try:
        ts = float(value or 0)
    except Exception:
        return None
    if ts <= 0:
        return None
    try:
        return datetime.fromtimestamp(ts).isoformat()
    except Exception:
        return None


def _resolve_active_account_for_positions(accounts: list[dict[str, Any]], config: dict[str, Any]) -> dict[str, Any] | None:
    master_login = _safe_int(config.get("master_account_login"))
    if master_login:
        return next((acc for acc in accounts if _safe_int(acc.get("user")) == master_login), None)
    return next((acc for acc in accounts if str(acc.get("role", "sub")).lower() == "master"), None)


def _fetch_live_positions() -> tuple[list[dict[str, Any]], list[str]]:
    config = _load_config()
    accounts = config.get("trading_accounts", [])
    positions: list[dict[str, Any]] = []
    errors: list[str] = []

    with MT5_LOCK:
        if not mt5_available():
            # Keep endpoint useful in simulation/fallback mode.
            for order in state_get("orders", []):
                if str(order.get("status", "")).lower() != "open":
                    continue
                positions.append(
                    {
                        "account_login": _safe_int(config.get("master_account_login")),
                        "account_name": "Master",
                        "account_role": "MASTER",
                        "tag": "Main",
                        "ticket": int(order.get("ticket", 0) or 0),
                        "symbol": str(order.get("symbol", SYMBOL_DEFAULT)),
                        "side": str(order.get("side", "BUY")).upper(),
                        "lot": float(order.get("lot", 0.0) or 0.0),
                        "open_price": float(order.get("entry", 0.0) or 0.0),
                        "sl": float(order.get("sl", 0.0) or 0.0),
                        "tp": float(order.get("tp", 0.0) or 0.0),
                        "profit": 0.0,
                        "comment": str(order.get("origin", "runtime")),
                        "opened_at": str(order.get("created_at") or ""),
                    }
                )
            return positions, errors

        # Reading positions must not initialize terminals. Account connections are
        # explicit user actions; a page refresh should never launch MT5 instances.
        account_info = mt5.account_info()
        if account_info is None:
            errors.append("Connect an account from Dashboard before loading live positions.")
        else:
            active_login = _safe_int(getattr(account_info, "login", 0))
            active_account = next(
                (acc for acc in accounts if _safe_int(acc.get("user")) == active_login),
                None,
            )
            if active_account is None:
                active_account = _resolve_active_account_for_positions(accounts, config)
            if active_account is None:
                errors.append("Connected MT5 account is not saved in the application.")
            else:
                login = _safe_int(active_account.get("user"))
                role = "MASTER" if str(active_account.get("role", "sub")).lower() == "master" else "SUB"
                tag = "Main" if role == "MASTER" else "Cloned"
                account_name = str(active_account.get("username", f"Account {login}"))
                try:
                    rows = mt5.positions_get()
                    for pos in rows or []:
                        side = "BUY" if int(getattr(pos, "type", 0) or 0) == mt5.ORDER_TYPE_BUY else "SELL"
                        positions.append(
                            {
                                "account_login": login,
                                "account_name": account_name,
                                "account_role": role,
                                "tag": tag,
                                "ticket": int(getattr(pos, "ticket", 0) or 0),
                                "symbol": str(getattr(pos, "symbol", SYMBOL_DEFAULT) or SYMBOL_DEFAULT),
                                "side": side,
                                "lot": float(getattr(pos, "volume", 0.0) or 0.0),
                                "open_price": float(getattr(pos, "price_open", 0.0) or 0.0),
                                "sl": float(getattr(pos, "sl", 0.0) or 0.0),
                                "tp": float(getattr(pos, "tp", 0.0) or 0.0),
                                "profit": float(getattr(pos, "profit", 0.0) or 0.0),
                                "comment": str(getattr(pos, "comment", "") or ""),
                                "opened_at": _to_iso_from_epoch(getattr(pos, "time", 0)),
                            }
                        )
                except Exception as ex:
                    errors.append(f"{login}: positions read error {ex}")

    positions.sort(key=lambda x: str(x.get("opened_at") or ""), reverse=True)
    return positions, errors


def _fetch_all_live_positions() -> tuple[list[dict[str, Any]], list[str], float | None]:
    """Read positions from every account that is already connected."""
    if not mt5_available():
        positions, errors = _fetch_live_positions()
        return positions, errors, 0.10

    config = _load_config()
    accounts = config.get("trading_accounts", [])
    positions: list[dict[str, Any]] = []
    errors: list[str] = []
    spreads: list[float] = []

    connected_logins = {
        _safe_int(session.get("login"))
        for session in list_sessions(accounts)
        if str(session.get("state", "")).lower() == "connected"
    }
    connected_accounts = [
        account for account in accounts if _safe_int(account.get("user")) in connected_logins
    ]
    if not connected_accounts:
        return [], ["Connect an account from Dashboard before loading live positions."], None

    for account in connected_accounts:
        login = _safe_int(account.get("user"))
        result = submit_adapter_command(login, "snapshot", {}, timeout_sec=5.0)
        if result.get("status") != "ok":
            errors.append(f"{login}: {result.get('message', 'adapter snapshot failed')}")
            continue
        role = "MASTER" if str(account.get("role", "sub")).lower() == "master" else "SUB"
        current_spread = result.get("spread")
        if isinstance(current_spread, (int, float)) and current_spread > 0:
            spreads.append(float(current_spread))
        for pos in result.get("positions", []):
            if not isinstance(pos, dict):
                continue
            positions.append(
                {
                    "account_login": login,
                    "account_name": str(account.get("username", f"Account {login}")),
                    "account_role": role,
                    "tag": "Main" if role == "MASTER" else "Cloned",
                    "ticket": int(pos.get("ticket", 0) or 0),
                    "symbol": str(pos.get("symbol", SYMBOL_DEFAULT) or SYMBOL_DEFAULT),
                    "side": str(pos.get("side", "BUY")).upper(),
                    "lot": float(pos.get("lot", 0.0) or 0.0),
                    "open_price": float(pos.get("open_price", 0.0) or 0.0),
                    "sl": float(pos.get("sl", 0.0) or 0.0),
                    "tp": float(pos.get("tp", 0.0) or 0.0),
                    "profit": float(pos.get("profit", 0.0) or 0.0),
                    "comment": str(pos.get("comment", "") or ""),
                    "opened_at": _to_iso_from_epoch(pos.get("opened_at")),
                }
            )

    positions.sort(key=lambda item: str(item.get("opened_at") or ""), reverse=True)
    return positions, errors, (max(spreads) if spreads else None)


def _require_master_connected() -> int:
    if is_dev_mode():
        return 0
    config = _load_config()
    ok, message, master_login = master_adapter_ready(config)
    if not ok:
        raise HTTPException(status_code=409, detail=message)
    return int(master_login or 0)


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "mt5_available": bool(hasattr(mt5, "initialize")),
        "tasks": running_tasks(),
    }


@app.get("/bootstrap")
def bootstrap() -> dict[str, Any]:
    config = _refresh_bootstrap_cache()
    sessions = _sessions_by_login(config.get("trading_accounts", []))
    front_accounts = [
        _to_front_account(i, acc, sessions.get(int(acc.get("user", 0) or 0)))
        for i, acc in enumerate(config.get("trading_accounts", []))
    ]
    runtime = snapshot()
    return {
        "dev_mode": is_dev_mode(),
        "settings": config,
        "accounts": front_accounts,
        "metrics": _metrics(front_accounts),
        "logs": {
            "search": runtime["logs"]["search"][-200:] or ["[INFO] Strategy engine initialized for XAUUSD M1."],
            "risk": runtime["logs"]["risk"][-200:] or ["[INFO] Risk monitor initialized."],
            "adapter": runtime["logs"]["adapter"][-200:],
        },
        "runtime": runtime,
    }


@app.get("/dashboard")
def dashboard() -> dict[str, Any]:
    config = _refresh_bootstrap_cache()
    sessions = _sessions_by_login(config.get("trading_accounts", []))
    front_accounts = [
        _to_front_account(i, acc, sessions.get(int(acc.get("user", 0) or 0)))
        for i, acc in enumerate(config.get("trading_accounts", []))
    ]
    return {"title": "Trading Control Center", "accounts": front_accounts, "metrics": _metrics(front_accounts)}


@app.get("/settings")
def get_settings() -> dict[str, Any]:
    return _refresh_bootstrap_cache()


@app.patch("/settings/theme")
def set_theme(payload: ThemeUpdate) -> dict[str, str]:
    mode = payload.theme_mode.upper()
    if mode not in {"LIGHT", "DARK"}:
        raise HTTPException(status_code=400, detail="theme_mode must be LIGHT or DARK")
    config = _load_config()
    config["theme_mode"] = mode
    _save_config(config)
    _refresh_bootstrap_cache()
    return {"status": "ok"}


@app.patch("/settings/search")
def set_search_config(payload: SearchConfigUpdate) -> dict[str, str]:
    config = _load_config()
    config["search_config"] = payload.search_config
    _save_config(config)
    _refresh_bootstrap_cache()
    return {"status": "ok"}


@app.patch("/settings/zoom")
def set_ui_zoom(payload: ZoomUpdate) -> dict[str, str | int]:
    zoom = min(150, max(70, int(payload.ui_zoom_percent)))
    config = _load_config()
    config["ui_zoom_percent"] = zoom
    _save_config(config)
    _refresh_bootstrap_cache()
    return {"status": "ok", "ui_zoom_percent": zoom}


@app.patch("/settings/notifications")
def set_notification_settings(payload: NotificationSettingsUpdate) -> dict[str, str]:
    config = _load_config()
    config["notification_settings"] = payload.model_dump()
    _save_config(config)
    _refresh_bootstrap_cache()
    return {"status": "ok"}


@app.patch("/settings/remote-control")
def set_remote_control_settings(payload: RemoteControlSettingsUpdate) -> dict[str, str]:
    token = payload.token.strip()
    if payload.enabled and not token:
        raise HTTPException(status_code=400, detail="Remote token is required when remote control is enabled.")
    config = _load_config()
    config["remote_control"] = {
        "enabled": bool(payload.enabled),
        "token": token,
        "receiver_url": payload.receiver_url.strip(),
    }
    _save_config(config)
    _refresh_bootstrap_cache()
    append_log(
        "adapter",
        "[REMOTE] Receiver setup saved and enabled."
        if payload.enabled
        else "[REMOTE] Receiver setup saved and disabled.",
    )
    return {"status": "ok"}


@app.post("/accounts")
def save_account(payload: AccountPayload) -> dict[str, Any]:
    config = _load_config()
    accounts = config["trading_accounts"]
    updated = False
    account_data = payload.model_dump()
    account_data["risk_percent"] = float(
        payload.risk_percent
        if payload.risk_percent is not None
        else (payload.risk_multiplier or 1.0)
    )
    account_data.pop("risk_multiplier", None)
    account_data["terminal_path"] = _sanitize_terminal_path(account_data.get("terminal_path", ""))

    for idx, existing in enumerate(accounts):
        if int(existing.get("user", 0) or 0) == payload.user:
            accounts[idx] = account_data
            updated = True
            break
    if not updated:
        accounts.append(account_data)

    if payload.role.lower() == "master":
        config["master_account_login"] = payload.user
        for acc in accounts:
            if int(acc.get("user", 0) or 0) != payload.user and str(acc.get("role", "sub")).lower() == "master":
                acc["role"] = "sub"

    _save_config(config)
    _refresh_bootstrap_cache()
    append_log("adapter", f"[INFO] Account {'updated' if updated else 'added'}: {payload.user}")
    return {"status": "ok", "updated": updated}


@app.delete("/accounts/{login}")
def delete_account(login: int) -> dict[str, str]:
    config = _load_config()
    config["trading_accounts"] = [a for a in config["trading_accounts"] if int(a.get("user", 0) or 0) != login]
    if int(config.get("master_account_login") or 0) == login:
        config["master_account_login"] = None
    _save_config(config)
    _refresh_bootstrap_cache()
    disconnect_account(login)
    return {"status": "ok"}


@app.post("/accounts/{login}/connect")
def connect_saved_account(login: int) -> dict[str, Any]:
    config = _load_config()
    account = next((a for a in config.get("trading_accounts", []) if int(a.get("user", 0) or 0) == int(login)), None)
    if account is None:
        raise HTTPException(status_code=404, detail="Account not found")
    return connect_account(account)


@app.post("/accounts/{login}/disconnect")
def disconnect_saved_account(login: int) -> dict[str, Any]:
    return disconnect_account(login)


@app.get("/accounts/sessions")
def account_sessions() -> dict[str, Any]:
    config = _load_config()
    return {"status": "ok", "sessions": list_sessions(config.get("trading_accounts", []))}


@app.get("/accounts/snapshots")
def account_snapshots() -> dict[str, Any]:
    """Read fresh account values through the process that owns each MT5 session."""
    config = _load_config()
    snapshots: list[dict[str, Any]] = []
    errors: list[str] = []
    accounts = config.get("trading_accounts", [])
    connected_logins = {
        _safe_int(session.get("login"))
        for session in list_sessions(accounts)
        if str(session.get("state", "")).lower() == "connected"
    }
    for account in accounts:
        login = _safe_int(account.get("user"))
        if login <= 0 or login not in connected_logins:
            continue
        result = submit_adapter_command(login, "snapshot", {}, timeout_sec=5.0)
        if result.get("status") != "ok":
            errors.append(f"{login}: {result.get('message', 'adapter snapshot failed')}")
            continue
        account_data = result.get("account", {})
        if not isinstance(account_data, dict):
            errors.append(f"{login}: invalid adapter snapshot")
            continue
        positions = result.get("positions", [])
        floating_pnl = sum(
            float(position.get("profit", 0.0) or 0.0)
            for position in positions
            if isinstance(position, dict)
        )
        snapshots.append({
            "login": login,
            "balance": float(account_data.get("balance", 0.0) or 0.0),
            "equity": float(account_data.get("equity", 0.0) or 0.0),
            "floating_pnl": floating_pnl,
            "latency": account_data.get("latency"),
            "algo_enabled": account_data.get("algo_enabled"),
        })
    if not snapshots and not errors:
        errors.append("No connected accounts available for snapshots.")
    return {"status": "ok", "snapshots": snapshots, "errors": errors}


@app.get("/runtime")
def runtime() -> dict[str, Any]:
    return snapshot()


@app.get("/positions/live")
def live_positions() -> dict[str, Any]:
    positions, errors, spread = _fetch_all_live_positions()
    return {
        "status": "ok",
        "positions": positions,
        "errors": errors,
        "spread": spread,
        "updated_at": datetime.now().isoformat(),
    }


@app.get("/trade-history")
def trade_history() -> dict[str, Any]:
    """Read closed MT5 deals and account performance for every connected account."""
    config = _load_config()
    accounts = config.get("trading_accounts", [])
    history: list[dict[str, Any]] = []
    summaries: list[dict[str, Any]] = []

    if not mt5_available():
        orders = state_get("orders", [])
        master_login = _safe_int(config.get("master_account_login"))
        master = next((a for a in accounts if _safe_int(a.get("user")) == master_login), None)
        profit = sum(float(o.get("profit", 0) or 0) for o in orders if str(o.get("status", "")).lower() == "closed")
        balance = float((master or {}).get("balance", 0) or 0)
        summaries.append({"login": master_login, "initial_balance": balance - profit, "profit": profit, "profit_percent": (profit / (balance - profit) * 100) if balance - profit else 0})
        return {"status": "ok", "history": orders, "summaries": summaries, "errors": []}

    errors: list[str] = []
    connected_logins = {
        _safe_int(session.get("login"))
        for session in list_sessions(accounts)
        if str(session.get("state", "")).lower() == "connected"
    }
    with MT5_LOCK:
        for account in accounts:
            login = _safe_int(account.get("user"))
            if login <= 0 or login not in connected_logins:
                continue
            init_ok, init_detail = _initialize_mt5_for_account(account)
            if not init_ok:
                errors.append(f"{login}: {init_detail}")
                continue
            try:
                info = mt5.account_info()
                current_balance = float(getattr(info, "balance", 0.0) or 0.0) if info is not None else 0.0
                deals = mt5.history_deals_get(datetime(2000, 1, 1), datetime.now()) or []
                account_profit = 0.0
                account_rows: list[dict[str, Any]] = []
                for deal in deals:
                    deal_type = int(getattr(deal, "type", -1))
                    buy_type = int(getattr(mt5, "DEAL_TYPE_BUY", 0))
                    sell_type = int(getattr(mt5, "DEAL_TYPE_SELL", 1))
                    if deal_type not in {buy_type, sell_type}:
                        continue
                    deal_entry = int(getattr(deal, "entry", -1))
                    closing_entries = {
                        int(getattr(mt5, "DEAL_ENTRY_OUT", 1)),
                        int(getattr(mt5, "DEAL_ENTRY_OUT_BY", 3)),
                        int(getattr(mt5, "DEAL_ENTRY_INOUT", 2)),
                    }
                    if deal_entry not in closing_entries:
                        continue
                    profit = float(getattr(deal, "profit", 0.0) or 0.0) + float(getattr(deal, "swap", 0.0) or 0.0) + float(getattr(deal, "commission", 0.0) or 0.0)
                    account_profit += profit
                    row = {
                        "id": f"{login}-{int(getattr(deal, 'ticket', 0) or 0)}",
                        "ticket": int(getattr(deal, "ticket", 0) or 0),
                        "account_login": login,
                        "account_name": str(account.get("username", f"Account {login}")),
                        "symbol": str(getattr(deal, "symbol", SYMBOL_DEFAULT) or SYMBOL_DEFAULT),
                        "side": "BUY" if deal_type == buy_type else "SELL",
                        "lot": float(getattr(deal, "volume", 0.0) or 0.0),
                        "entry": float(getattr(deal, "price", 0.0) or 0.0),
                        "profit": profit,
                        "status": "Closed",
                        "comment": str(getattr(deal, "comment", "") or ""),
                        "created_at": _to_iso_from_epoch(getattr(deal, "time", 0)),
                    }
                    account_rows.append(row)
                initial_balance = current_balance - account_profit
                summaries.append({
                    "login": login,
                    "balance": current_balance,
                    "initial_balance": initial_balance,
                    "profit": account_profit,
                    "profit_percent": (account_profit / initial_balance * 100) if initial_balance else 0,
                })
                history.extend(account_rows)
            except Exception as exc:
                errors.append(f"{login}: history read error {exc}")
    if not summaries and not errors:
        errors.append("No connected accounts available for trade history.")

    history.sort(key=lambda row: str(row.get("created_at") or ""), reverse=True)
    return {"status": "ok", "history": history, "summaries": summaries, "errors": errors}


@app.post("/strategy/start")
def start_strategy(payload: StrategyStartPayload) -> dict[str, Any]:
    _require_master_connected()
    config = _load_config()
    search_cfg = dict(config.get("search_config", {}))
    start_dt = _parse_dt(payload.start_time)
    end_dt = _parse_dt(payload.end_time)
    try:
        start_strategy_system(
            search_cfg,
            interval_sec=max(1, int(payload.interval_sec or 1)),
            liquidity_enabled=bool(payload.liquidity_enabled),
            start_time=start_dt,
            end_time=end_dt,
            end_time_enabled=end_dt is not None,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"status": "ok", "strategy": state_get("strategy", {})}


@app.post("/strategy/stop")
def stop_strategy() -> dict[str, Any]:
    stop_strategy_system()
    return {"status": "ok", "strategy": state_get("strategy", {})}


@app.post("/liquidity-levels")
def add_liquidity_level(payload: LiquidityLevelPayload) -> dict[str, Any]:
    liq = Liquidity(price=float(payload.price), side=str(payload.side).lower())
    strategy_manager.add(liq)
    append_log("search", f"[SUCCESS] Added liquidity level {liq.side.upper()} @ {liq.price:.2f}.")
    return {"status": "ok", "levels": state_get("liquidity_levels", [])}


@app.delete("/liquidity-levels/{level_id}")
def remove_liquidity_level(level_id: int) -> dict[str, Any]:
    strategy_manager.remove(level_id)
    append_log("search", f"[INFO] Removed liquidity level {level_id}.")
    return {"status": "ok", "levels": state_get("liquidity_levels", [])}


@app.post("/positions/open")
def open_position(payload: OpenPositionPayload) -> dict[str, Any]:
    config = _load_config()
    ready, _detail, master_login = master_adapter_ready(config)
    if not is_dev_mode():
        # Never initialize MT5 from the API process. Doing so can take over the
        # terminal session that belongs to the long-running adapter process.
        if not ready or not master_login:
            raise HTTPException(status_code=409, detail=_detail)
        result = submit_adapter_command(master_login, "open", payload.model_dump())
        if result.get("status") != "ok":
            raise HTTPException(status_code=409, detail=str(result.get("message", "MT5 adapter command failed.")))
        return {"status": "ok", "orders": state_get("orders", []), "adapter_result": result}
    try:
        open_manual_position(
            str(payload.side).upper(),
            payload.lot,
            payload.tp,
            payload.sl,
            symbol=payload.symbol,
            order_kind=str(payload.order_kind).upper(),
            limit_price=payload.limit_price,
            tp_in_pips=bool(payload.tp_in_pips),
            sl_in_pips=bool(payload.sl_in_pips),
            risk_percent=payload.risk_percent,
            advanced=bool(payload.advanced),
            sl_price=payload.sl_price,
            ratio=float(payload.ratio),
            tp1_ratio=float(payload.tp1_ratio),
            tp2_ratio=float(payload.tp2_ratio),
            tp3_ratio=float(payload.tp3_ratio),
            tp2_enabled=bool(payload.tp2_enabled),
            tp3_enabled=bool(payload.tp3_enabled),
            tp1_percent=float(payload.tp1_percent),
            tp2_percent=float(payload.tp2_percent),
            auto_close_at=payload.auto_close_at,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"status": "ok", "orders": state_get("orders", [])}


@app.post("/positions/calculate-lot")
def calculate_lot(payload: LotCalculationPayload) -> dict[str, Any]:
    try:
        lot, message = calculate_manual_lot(
            str(payload.side).upper(),
            float(payload.risk_percent) if payload.risk_percent is not None else None,
            float(payload.sl),
            sl_in_pips=bool(payload.sl_in_pips),
            sl_price=bool(payload.sl_price),
            symbol=payload.symbol,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"status": "ok", "lot": lot, "message": message}


@app.post("/positions/close")
def close_positions() -> dict[str, Any]:
    _require_master_connected()
    with MT5_LOCK:
        summary = close_all_positions()
    return {"status": "ok", "summary": summary, "orders": state_get("orders", [])}


@app.post("/risk/start")
def risk_start(payload: RiskStartPayload) -> dict[str, Any]:
    _require_master_connected()
    return start_risk_monitor(
        risk_percent=float(payload.risk_percent),
        profit_percent=float(payload.profit_percent),
        orders_limit=int(payload.orders_limit),
        interval_sec=max(1, int(payload.interval_sec)),
    )


@app.post("/risk/stop")
def risk_stop() -> dict[str, Any]:
    return stop_risk_monitor()


@app.post("/actions")
def action(payload: ActionPayload) -> dict[str, Any]:
    action_name = payload.action
    data = payload.payload or {}

    if action_name == "start_strategy":
        return start_strategy(StrategyStartPayload(**data))
    if action_name == "stop_strategy":
        return stop_strategy()
    if action_name == "open_position":
        return open_position(OpenPositionPayload(**data))
    if action_name == "close_positions":
        return close_positions()
    if action_name == "add_liquidity_level":
        return add_liquidity_level(LiquidityLevelPayload(**data))
    if action_name == "start_risk_monitor":
        return risk_start(RiskStartPayload(**data))
    if action_name == "stop_risk_monitor":
        return risk_stop()
    if action_name == "load_defaults":
        return {"status": "ok", "message": "Defaults loaded."}
    if action_name == "connect_account":
        login = int(data.get("login", 0) or 0)
        return connect_saved_account(login)
    if action_name == "disconnect_account":
        login = int(data.get("login", 0) or 0)
        return disconnect_saved_account(login)

    return {"status": "ok", "message": f"Action handled: {action_name}"}


@app.websocket("/remote/ws")
async def remote_command_socket(websocket: WebSocket) -> None:
    """Authenticated command receiver intended for a private Tailscale network."""
    if not _remote_control_enabled():
        await websocket.accept()
        append_log("adapter", "[REMOTE] Connection rejected because receiver mode is disabled.")
        await websocket.close(code=1008, reason="Remote control receiver is disabled.")
        return
    configured_token = _remote_token()
    await websocket.accept()
    append_log("adapter", "[REMOTE] Incoming controller connection awaiting authentication.")
    try:
        authentication = await asyncio.wait_for(websocket.receive_json(), timeout=10)
    except (TimeoutError, WebSocketDisconnect):
        append_log("adapter", "[REMOTE] Authentication timed out before a token was received.")
        await websocket.close(code=1008, reason="Remote control authentication timed out.")
        return
    provided_token = str(authentication.get("token", "")) if isinstance(authentication, dict) else ""
    if (
        not configured_token
        or not isinstance(authentication, dict)
        or authentication.get("type") != "authenticate"
        or not secrets.compare_digest(provided_token, configured_token)
    ):
        append_log("adapter", "[REMOTE] Authentication failed for an incoming controller connection.")
        await websocket.close(code=1008, reason="Remote control authentication failed.")
        return
    connections = int(state_get("remote_control.connections", 0) or 0) + 1
    state_patch("remote_control", {"connections": connections})
    append_log("adapter", f"[REMOTE] Controller authenticated successfully. Active connections: {connections}.")
    await websocket.send_json({
        "type": "connection",
        "status": "connected",
        "message": "Authenticated remote command receiver is ready.",
        "server_time": datetime.now().isoformat(),
    })
    try:
        while True:
            raw_message = await websocket.receive_json()
            if isinstance(raw_message, dict) and raw_message.get("type") == "ping":
                await websocket.send_json({"type": "pong", "server_time": datetime.now().isoformat()})
                continue
            command_id = str(raw_message.get("id", "")).strip()
            action_name = str(raw_message.get("action", "")).strip().lower()
            data = raw_message.get("data", {})
            if not command_id or not action_name or not isinstance(data, dict):
                append_log("adapter", "[REMOTE] Rejected malformed command payload from controller.")
                await websocket.send_json({
                    "type": "result",
                    "id": command_id or None,
                    "status": "error",
                    "message": "Each command requires an id, action, and object data.",
                })
                continue

            with _remote_command_lock:
                cached_result = _remote_command_cache.get(command_id)
            if cached_result:
                append_log("adapter", f"[REMOTE] Replayed cached result for {action_name} ({command_id}).")
                await websocket.send_json(cached_result)
                continue

            try:
                if action_name == "open":
                    data, receiver_login, receiver_risk, receiver_delay = _receiver_open_settings(data)
                    append_log("adapter", f"[REMOTE] Using receiver account {receiver_login} risk {receiver_risk:.2f}% for {command_id}.")
                    await websocket.send_json({
                        "type": "log",
                        "level": "info",
                        "message": f"Receiver account {receiver_login} risk {receiver_risk:.2f}% selected for the remote order.",
                    })
                    await websocket.send_json({
                        "type": "log",
                        "level": "info",
                        "message": f"Receiver account {receiver_login} order delay is {receiver_delay} seconds.",
                    })
                    if receiver_delay > 0:
                        append_log("adapter", f"[REMOTE] Waiting receiver order delay of {receiver_delay}s for {command_id}.")
                        await websocket.send_json({
                            "type": "log",
                            "level": "info",
                            "message": f"Waiting receiver order delay of {receiver_delay} seconds.",
                        })
                        await asyncio.sleep(receiver_delay)
                        append_log("adapter", f"[REMOTE] Receiver order delay completed for {command_id}.")
                        await websocket.send_json({
                            "type": "log",
                            "level": "success",
                            "message": f"Receiver delay completed after {receiver_delay} seconds. Submitting the order now.",
                        })
                result = _execute_remote_command(action_name, data)
                response = {"type": "result", "id": command_id, "status": "success", "result": result}
                append_log("adapter", f"[REMOTE] Executed {action_name} ({command_id}).")
                state_patch("remote_control", {
                    "last_command_at": datetime.now().isoformat(),
                    "last_command_action": action_name,
                })
            except HTTPException as exc:
                response = {"type": "result", "id": command_id, "status": "error", "message": str(exc.detail)}
                append_log("adapter", f"[REMOTE] {action_name} ({command_id}) failed: {exc.detail}")
            except (TypeError, ValueError, RuntimeError) as exc:
                response = {"type": "result", "id": command_id, "status": "error", "message": str(exc)}
                append_log("adapter", f"[REMOTE] {action_name} ({command_id}) failed: {exc}")
            except Exception:
                response = {"type": "result", "id": command_id, "status": "error", "message": "The remote command could not be completed."}
                append_log("adapter", f"[REMOTE] {action_name} ({command_id}) failed with an unexpected server error.")

            with _remote_command_lock:
                if len(_remote_command_cache) >= REMOTE_COMMAND_CACHE_LIMIT:
                    _remote_command_cache.pop(next(iter(_remote_command_cache)))
                _remote_command_cache[command_id] = response
            await websocket.send_json(response)
    except WebSocketDisconnect:
        append_log("adapter", "[REMOTE] Controller disconnected.")
        pass
    finally:
        remaining_connections = max(0, int(state_get("remote_control.connections", 1) or 1) - 1)
        state_patch("remote_control", {"connections": remaining_connections})
        append_log("adapter", f"[REMOTE] Active connections: {remaining_connections}.")


@app.get("/", include_in_schema=False)
def serve_frontend_root():
    if FRONTEND_INDEX.exists():
        return FileResponse(FRONTEND_INDEX)
    return PlainTextResponse(
        "Frontend build not found. Run `cd frontend && npm run build`.",
        status_code=503,
    )


@app.get("/{full_path:path}", include_in_schema=False)
def serve_frontend_assets(full_path: str):
    # Keep API routes above this catch-all route.
    if not FRONTEND_DIST.exists():
        return PlainTextResponse(
            "Frontend build not found. Run `cd frontend && npm run build`.",
            status_code=503,
        )

    candidate = (FRONTEND_DIST / full_path).resolve()
    try:
        candidate.relative_to(FRONTEND_DIST.resolve())
    except Exception:
        raise HTTPException(status_code=404, detail="Not found")

    if candidate.exists() and candidate.is_file():
        return FileResponse(candidate)

    # Static assets must fail visibly; only application routes should fall back to the SPA shell.
    if Path(full_path).suffix:
        raise HTTPException(status_code=404, detail="Static asset not found")

    if FRONTEND_INDEX.exists():
        return FileResponse(FRONTEND_INDEX)
    raise HTTPException(status_code=404, detail="Not found")
