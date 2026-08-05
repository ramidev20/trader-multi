from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import BaseModel

from .services.mt5_compat import mt5, mt5_available
from .services.risk_service import start_risk_monitor, stop_risk_monitor
from .services.mt5_lock import MT5_LOCK
from .services.runtime_state import append_log, get as state_get, patch_path as state_patch, set_path as state_set, snapshot
from .services.session_service import connect_account, disconnect_account, list_sessions
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
)
from .services.task_manager import set_runtime_logger

ROOT_DIR = Path(__file__).resolve().parents[2]
CONFIG_FILE = ROOT_DIR / "config.json"
FRONTEND_DIST = ROOT_DIR / "frontend" / "dist"
FRONTEND_INDEX = FRONTEND_DIST / "index.html"
SYMBOL_DEFAULT = "XAUUSD"

DEFAULT_CONFIG: dict[str, Any] = {
    "trading_accounts": [],
    "master_account_login": None,
    "search_config": {
        "time": 900,
        "lot": 0.05,
        "risk_percent": 1.0,
        "order_delay": 0,
        "max_positions": 3,
        "orders_limit": 10,
        "pips": 25,
        "max_pips": 70,
        "last_position_pips": -150,
        "enable_pullback": False,
        "pullback_pips": 20,
        "tp": 150,
        "sl": 500,
        "enable_liquidity": True,
        "stop_on_first_close": True,
    },
    "terminal_path": "",
    "copy_accounts": [],
    "theme_mode": "LIGHT",
}


class ThemeUpdate(BaseModel):
    theme_mode: str


class SearchConfigUpdate(BaseModel):
    search_config: dict[str, Any]


class AccountPayload(BaseModel):
    username: str
    user: int
    password: str
    server: str
    terminal_path: str
    role: str = "sub"
    risk_multiplier: float = 1.0


class CopyAccountPayload(BaseModel):
    account_login: int
    risk_multiplier: float
    enabled: bool = True
    terminal_path: str = ""


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
    tp: float | None = None
    sl: float | None = None
    tp_in_pips: bool = False
    sl_in_pips: bool = False
    risk_percent: float | None = None
    advanced: bool = False
    sl_price: float | None = None
    ratio: float = 3.0
    tp2_enabled: bool = False
    tp3_enabled: bool = False
    tp1_percent: float = 100.0
    tp2_percent: float = 100.0


class LotCalculationPayload(BaseModel):
    side: str
    risk_percent: float
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
    config = dict(DEFAULT_CONFIG)
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
    if not isinstance(config.get("copy_accounts"), list):
        config["copy_accounts"] = []
    if not isinstance(config.get("search_config"), dict):
        config["search_config"] = dict(DEFAULT_CONFIG["search_config"])
    return config


def _save_config(config: dict[str, Any]) -> None:
    CONFIG_FILE.write_text(json.dumps(config, indent=4), encoding="utf-8")


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
    balance = float((session or {}).get("balance", account.get("balance", 0)) or 0)
    equity = float((session or {}).get("equity", account.get("equity", balance)) or balance)
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
        "risk": float(account.get("risk_multiplier", 1.0) or 1.0),
        "lotMultiplier": float(account.get("risk_multiplier", 1.0) or 1.0),
        "orderDelaySec": int(_load_config().get("search_config", {}).get("order_delay", 0) or 0),
        "latency": None,
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


def _require_master_connected() -> int:
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
        "settings": config,
        "accounts": front_accounts,
        "copy_accounts": config.get("copy_accounts", []),
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
    append_log("search", "[INFO] Search defaults saved.")
    return {"status": "ok"}


@app.post("/accounts")
def save_account(payload: AccountPayload) -> dict[str, Any]:
    config = _load_config()
    accounts = config["trading_accounts"]
    updated = False
    account_data = payload.model_dump()
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

    # keep copy_accounts in sync with sub accounts
    copy_accounts = []
    for acc in accounts:
        if str(acc.get("role", "sub")).lower() != "sub":
            continue
        copy_accounts.append(
            {
                "account_login": int(acc.get("user")),
                "risk_multiplier": float(acc.get("risk_multiplier", 1.0) or 1.0),
                "enabled": True,
                "terminal_path": str(acc.get("terminal_path", "") or ""),
            }
        )
    config["copy_accounts"] = copy_accounts
    _save_config(config)
    _refresh_bootstrap_cache()
    append_log("adapter", f"[INFO] Account {'updated' if updated else 'added'}: {payload.user}")
    return {"status": "ok", "updated": updated}


@app.delete("/accounts/{login}")
def delete_account(login: int) -> dict[str, str]:
    config = _load_config()
    config["trading_accounts"] = [a for a in config["trading_accounts"] if int(a.get("user", 0) or 0) != login]
    config["copy_accounts"] = [c for c in config["copy_accounts"] if int(c.get("account_login", 0) or 0) != login]
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


@app.post("/copy-accounts")
def save_copy_account(payload: CopyAccountPayload) -> dict[str, Any]:
    config = _load_config()
    copy_accounts = config["copy_accounts"]
    updated = False
    for idx, existing in enumerate(copy_accounts):
        if int(existing.get("account_login", 0) or 0) == payload.account_login:
            copy_accounts[idx] = payload.model_dump()
            updated = True
            break
    if not updated:
        copy_accounts.append(payload.model_dump())
    _save_config(config)
    _refresh_bootstrap_cache()
    return {"status": "ok", "updated": updated}


@app.delete("/copy-accounts/{login}")
def delete_copy_account(login: int) -> dict[str, str]:
    config = _load_config()
    config["copy_accounts"] = [c for c in config["copy_accounts"] if int(c.get("account_login", 0) or 0) != login]
    _save_config(config)
    _refresh_bootstrap_cache()
    return {"status": "ok"}


@app.get("/runtime")
def runtime() -> dict[str, Any]:
    return snapshot()


@app.get("/positions/live")
def live_positions() -> dict[str, Any]:
    positions, errors = _fetch_live_positions()
    return {
        "status": "ok",
        "positions": positions,
        "errors": errors,
        "updated_at": datetime.now().isoformat(),
    }


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
    _require_master_connected()
    try:
        open_manual_position(
            str(payload.side).upper(),
            float(payload.lot),
            payload.tp,
            payload.sl,
            symbol=payload.symbol,
            tp_in_pips=bool(payload.tp_in_pips),
            sl_in_pips=bool(payload.sl_in_pips),
            risk_percent=payload.risk_percent,
            advanced=bool(payload.advanced),
            sl_price=payload.sl_price,
            ratio=float(payload.ratio),
            tp2_enabled=bool(payload.tp2_enabled),
            tp3_enabled=bool(payload.tp3_enabled),
            tp1_percent=float(payload.tp1_percent),
            tp2_percent=float(payload.tp2_percent),
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"status": "ok", "orders": state_get("orders", [])}


@app.post("/positions/calculate-lot")
def calculate_lot(payload: LotCalculationPayload) -> dict[str, Any]:
    try:
        lot, message = calculate_manual_lot(
            str(payload.side).upper(),
            float(payload.risk_percent),
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
        append_log("search", "[INFO] Search defaults loaded.")
        return {"status": "ok", "message": "Defaults loaded."}
    if action_name == "connect_account":
        login = int(data.get("login", 0) or 0)
        return connect_saved_account(login)
    if action_name == "disconnect_account":
        login = int(data.get("login", 0) or 0)
        return disconnect_saved_account(login)

    return {"status": "ok", "message": f"Action handled: {action_name}"}


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

    if FRONTEND_INDEX.exists():
        return FileResponse(FRONTEND_INDEX)
    raise HTTPException(status_code=404, detail="Not found")
