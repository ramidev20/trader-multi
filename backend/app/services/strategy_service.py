from __future__ import annotations

import time
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta
from functools import wraps
from pathlib import Path
import json
from types import SimpleNamespace
from typing import Callable, Optional
from uuid import uuid4

from .mt5_compat import mt5, mt5_available
from .env_utils import is_dev_mode
from .mt5_lock import MT5_LOCK
from .path_utils import resolve_terminal_path, sanitize_terminal_path
from .runtime_state import append_list, append_log, get, patch_path, replace_list, set_path
from .task_manager import emit_log, is_task_running, start_task, stop_task

SYMBOL_DEFAULT = "XAUUSD"
CONFIG_FILE = Path(__file__).resolve().parents[3] / "config.json"
_sim_ticks = {"XAUUSD": 3350.0}
_sim_last_candle_ts: dict[str, int] = {}
MANUAL_TP_TASK_NAME = "manual_multi_tp"
MANUAL_AUTO_CLOSE_TASK_NAME = "manual_auto_close_all"
TIMEFRAME_MAP = {
    "M1": mt5.TIMEFRAME_M1,
    "M3": mt5.TIMEFRAME_M3,
    "M5": mt5.TIMEFRAME_M5,
    "M15": mt5.TIMEFRAME_M15,
}


def _mt5_session_locked(function):
    """Keep account selection and the following MT5 operation atomic.

    MT5 exposes one process-wide connection. Other requests (for example the
    dashboard snapshot refresh) can switch that connection to another saved
    account, so an order must not release the lock between initialize and
    order_send.
    """

    @wraps(function)
    def wrapped(*args, **kwargs):
        with MT5_LOCK:
            return function(*args, **kwargs)

    return wrapped


def _tick_for(symbol: str) -> SimpleNamespace:
    base = _sim_ticks.get(symbol, 3350.0)
    drift = ((int(time.time()) % 12) - 6) * 0.08
    ask = round(base + drift + 0.05, 2)
    bid = round(base + drift - 0.05, 2)
    _sim_ticks[symbol] = round(base + ((int(time.time() * 1000) % 2) * 0.01 - 0.005), 2)
    return SimpleNamespace(ask=ask, bid=bid)


def _resolve_timeframe(value) -> int:
    if isinstance(value, str):
        return int(TIMEFRAME_MAP.get(value.upper(), mt5.TIMEFRAME_M1))
    try:
        return int(value)
    except Exception:
        return int(mt5.TIMEFRAME_M1)


def _timeframe_seconds(timeframe: int) -> int:
    minutes_by_timeframe = {
        int(mt5.TIMEFRAME_M1): 1,
        int(mt5.TIMEFRAME_M3): 3,
        int(mt5.TIMEFRAME_M5): 5,
        int(mt5.TIMEFRAME_M15): 15,
    }
    return minutes_by_timeframe.get(int(timeframe), 1) * 60


def _load_config() -> dict:
    if not CONFIG_FILE.exists():
        return {}
    try:
        loaded = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        return loaded if isinstance(loaded, dict) else {}
    except Exception:
        return {}


def _safe_int(value) -> int:
    try:
        return int(value)
    except Exception:
        return 0


def _normalize_terminal_path(path_value: str) -> str:
    return sanitize_terminal_path(path_value)


def _resolve_master_account(cfg: dict) -> dict | None:
    accounts = cfg.get("trading_accounts", []) if isinstance(cfg, dict) else []
    master_login = _safe_int((cfg or {}).get("master_account_login"))
    if master_login > 0:
        for acc in accounts:
            if _safe_int(acc.get("user")) == master_login:
                return acc
    for acc in accounts:
        if str(acc.get("role", "sub")).lower() == "master":
            return acc
    return None


def _copy_targets(cfg: dict, master_login: int) -> list[tuple[dict, float]]:
    accounts = cfg.get("trading_accounts", []) if isinstance(cfg, dict) else []
    by_login = {_safe_int(a.get("user")): a for a in accounts}
    targets: list[tuple[dict, float]] = []

    for acc in accounts:
        try:
            login = _safe_int(acc.get("user"))
            if login <= 0 or login == master_login:
                continue
            if str(acc.get("role", "sub")).lower() != "sub":
                continue
            targets.append(
                (
                    acc,
                    float(acc.get("risk_percent", acc.get("risk_multiplier", 1.0)) or 1.0),
                )
            )
        except Exception:
            continue
    return targets


def _copy_targets_count() -> int:
    cfg = _load_config()
    master = _resolve_master_account(cfg)
    master_login = _safe_int((master or {}).get("user"))
    return len(_copy_targets(cfg, master_login))


def _initialize_mt5_for_account(account: dict) -> tuple[bool, str]:
    login = _safe_int(account.get("user"))
    password = str(account.get("password", "") or "")
    server = str(account.get("server", "") or "")
    terminal_path = resolve_terminal_path(account.get("terminal_path", ""))
    if login <= 0 or not password or not server or not terminal_path:
        return False, f"missing account credentials/path for login={login}"
    with MT5_LOCK:
        active = mt5.account_info()
        active_login = _safe_int(getattr(active, "login", 0)) if active is not None else 0
        if active_login == login:
            return True, "already connected"
        try:
            mt5.shutdown()
        except Exception:
            pass
        ok = mt5.initialize(login=login, password=password, server=server, path=terminal_path)
        if not ok:
            return False, str(mt5.last_error())
        return True, "ok"


def _ensure_symbol_ready(symbol: str) -> tuple[bool, str]:
    if not mt5_available():
        return True, "simulation"

    info = mt5.symbol_info(symbol)
    if info is None:
        return False, f"Symbol {symbol} not found in terminal."

    if not bool(getattr(info, "visible", False)):
        selected = mt5.symbol_select(symbol, True)
        if not selected:
            return False, f"Failed to select symbol {symbol}: {mt5.last_error()}"

    observed_stamps: list[int] = []
    for _ in range(10):
        tick = mt5.symbol_info_tick(symbol)
        if tick is not None and getattr(tick, "bid", 0) and getattr(tick, "ask", 0):
            stamp = getattr(tick, "time_msc", None) or getattr(tick, "time", None)
            if stamp:
                observed_stamps.append(int(stamp))
                if len(observed_stamps) >= 2 and observed_stamps[-1] != observed_stamps[-2]:
                    return True, "ok"
        time.sleep(0.2)
    if observed_stamps:
        return False, f"Stale prices for {symbol}. Terminal is connected but quote stream is not updating."
    return False, f"No prices available for {symbol}."


def _check_request(request: dict) -> tuple[bool, str]:
    if not mt5_available():
        return True, "simulation"
    try:
        result = mt5.order_check(request)
    except Exception as ex:
        return False, f"order_check exception: {ex}"
    if result is None:
        return False, f"order_check failed: {mt5.last_error()}"
    retcode = getattr(result, "retcode", None)
    if retcode in {0, mt5.TRADE_RETCODE_DONE}:
        return True, str(getattr(result, "comment", "Done") or "Done")
    return False, str(getattr(result, "comment", f"order_check retcode={retcode}") or f"order_check retcode={retcode}")


def _normalize_volume(symbol: str, volume: float) -> float:
    raw_volume = max(0.0, float(volume or 0.0))
    info = mt5.symbol_info(symbol) if mt5_available() else None
    min_volume = float(getattr(info, "volume_min", 0.01) or 0.01)
    max_volume = float(getattr(info, "volume_max", 100.0) or 100.0)
    step = float(getattr(info, "volume_step", 0.01) or 0.01)
    if step <= 0:
        step = 0.01

    stepped = max(min_volume, (raw_volume // step) * step)
    capped = min(stepped, max_volume)
    precision = 2
    step_text = f"{step:.10f}".rstrip("0").rstrip(".")
    if "." in step_text:
        precision = min(6, len(step_text.split(".")[1]))
    return round(capped, precision)


def _loss_per_lot(symbol: str, order_type: int, entry_price: float, stop_loss: float) -> float:
    if mt5_available():
        try:
            profit = mt5.order_calc_profit(order_type, symbol, 1.0, float(entry_price), float(stop_loss))
            if profit is not None:
                return abs(float(profit))
        except Exception:
            pass

    info = mt5.symbol_info(symbol) if mt5_available() else None
    if info is None:
        return 0.0

    tick_size = float(getattr(info, "trade_tick_size", 0.0) or getattr(info, "point", 0.0) or 0.0)
    tick_value = float(
        getattr(info, "trade_tick_value_loss", 0.0)
        or getattr(info, "trade_tick_value", 0.0)
        or getattr(info, "trade_tick_value_profit", 0.0)
        or 0.0
    )
    if tick_size <= 0 or tick_value <= 0:
        return 0.0
    return abs(float(entry_price) - float(stop_loss)) / tick_size * tick_value


def _risk_adjusted_volume(
    symbol: str,
    order_type: int,
    entry_price: float,
    stop_loss: float,
    risk_percent: float,
    fallback_lot: float,
) -> float:
    if not mt5_available():
        return _normalize_volume(symbol, fallback_lot)

    account_info = mt5.account_info()
    equity = float(
        getattr(account_info, "equity", 0.0) or getattr(account_info, "balance", 0.0) or 0.0
    )
    if equity <= 0 or risk_percent <= 0:
        return _normalize_volume(symbol, fallback_lot)

    loss_per_lot = _loss_per_lot(symbol, order_type, entry_price, stop_loss)
    if loss_per_lot <= 0:
        return _normalize_volume(symbol, fallback_lot)

    risk_amount = equity * (float(risk_percent) / 100.0)
    if risk_amount <= 0:
        return _normalize_volume(symbol, fallback_lot)

    raw_volume = risk_amount / loss_per_lot
    if raw_volume <= 0:
        return _normalize_volume(symbol, fallback_lot)
    return _normalize_volume(symbol, raw_volume)


def _ensure_master_session() -> tuple[bool, str, dict | None, dict]:
    cfg = _load_config()
    master = _resolve_master_account(cfg)
    if is_dev_mode():
        if master:
            return True, "developer mode", master, cfg
        return True, "developer mode", {"user": 0, "username": "Developer Mode", "risk_percent": 1.0, "role": "master"}, cfg
    if not master:
        return False, "No master account configured for execution.", None, cfg
    if not mt5_available():
        return True, "simulation", master, cfg
    ok, detail = _initialize_mt5_for_account(master)
    if not ok:
        login = _safe_int(master.get("user"))
        return False, f"MT5 initialize failed for master {login}: {detail}", master, cfg
    return True, "ok", master, cfg


def _verify_mt5_login(expected_login: int) -> tuple[bool, str]:
    if not mt5_available():
        return True, "simulation"
    info = mt5.account_info()
    actual_login = _safe_int(getattr(info, "login", 0)) if info is not None else 0
    if actual_login != int(expected_login):
        return False, f"active MT5 login is {actual_login or 'unknown'}, expected {expected_login}"
    return True, "ok"


def _build_copy_request(master_request: dict, risk_percent: float, origin: str) -> dict:
    req = dict(master_request)
    fallback_volume = float(master_request.get("volume", 0.01) or 0.01)
    req["comment"] = f"{origin} copy"
    req["magic"] = int(master_request.get("magic", 1000) or 1000) + 1

    symbol = str(master_request.get("symbol", SYMBOL_DEFAULT))
    symbol_ok, _symbol_detail = _ensure_symbol_ready(symbol)
    if not symbol_ok:
        return req
    order_type = int(master_request.get("type", mt5.ORDER_TYPE_BUY) or mt5.ORDER_TYPE_BUY)
    is_pending_limit = order_type in {mt5.ORDER_TYPE_BUY_LIMIT, mt5.ORDER_TYPE_SELL_LIMIT}
    tick = mt5.symbol_info_tick(symbol) if mt5_available() else None
    if tick is None and not is_pending_limit:
        return req

    master_price = float(master_request.get("price", 0.0) or 0.0)
    master_tp = float(master_request.get("tp", 0.0) or 0.0)
    master_sl = float(master_request.get("sl", 0.0) or 0.0)

    if is_pending_limit:
        price = master_price
        req["price"] = price
    elif order_type == mt5.ORDER_TYPE_BUY:
        price = float(getattr(tick, "ask", master_price) or master_price)
        req["price"] = price
        if master_tp:
            req["tp"] = round(price + (master_tp - master_price), 2)
        if master_sl:
            req["sl"] = round(price - (master_price - master_sl), 2)
    else:
        price = float(getattr(tick, "bid", master_price) or master_price)
        req["price"] = price
        if master_tp:
            req["tp"] = round(price - (master_price - master_tp), 2)
        if master_sl:
            req["sl"] = round(price + (master_sl - master_price), 2)
    req["volume"] = round(
        _risk_adjusted_volume(
            symbol,
            mt5.ORDER_TYPE_BUY if order_type in {mt5.ORDER_TYPE_BUY, mt5.ORDER_TYPE_BUY_LIMIT} else mt5.ORDER_TYPE_SELL,
            float(req.get("price", master_price) or master_price),
            float(req.get("sl", master_sl) or master_sl),
            float(risk_percent or 0.0),
            fallback_volume,
        ),
        2,
    )
    return req


@_mt5_session_locked
def _clone_trade_to_sub_accounts(master_request: dict, origin: str) -> str | None:
    ok, detail, master, cfg = _ensure_master_session()
    if not ok:
        append_log("search", f"[ERROR] Copy disabled: {detail}")
        return None
    master_login = _safe_int((master or {}).get("user"))
    master_session_ok, master_session_detail = _verify_mt5_login(master_login)
    if not master_session_ok:
        append_log("search", f"[ERROR] Copy disabled: {master_session_detail}")
        return None
    targets = _copy_targets(cfg, master_login)
    if not targets:
        return "Copied master trade to 0/0 sub account(s)"
    if not mt5_available():
        return f"Copied master trade to 0/{len(targets)} sub account(s)"

    copied = 0
    for account, risk_percent in targets:
        login = _safe_int(account.get("user"))
        delay_seconds = max(
            0.0,
            float(account.get("order_delay_sec", account.get("orderDelaySec", 0)) or 0),
        )
        if delay_seconds > 0:
            append_log("search", f"[COPY] Waiting {delay_seconds:.0f}s before copying to {login}.")
            time.sleep(delay_seconds)
        init_ok, init_detail = _initialize_mt5_for_account(account)
        if not init_ok:
            append_log("search", f"[ERROR] Copy init failed for {login}: {init_detail}")
            continue
        account_session_ok, account_session_detail = _verify_mt5_login(login)
        if not account_session_ok:
            append_log("search", f"[ERROR] Copy blocked for {login}: {account_session_detail}")
            continue
        copy_req = _build_copy_request(master_request, risk_percent, origin)
        result = mt5.order_send(copy_req)
        if result is not None and getattr(result, "retcode", None) == mt5.TRADE_RETCODE_DONE:
            copied += 1
        else:
            append_log(
                "search",
                f"[ERROR] Copy order failed for {login}: {getattr(result, 'comment', mt5.last_error())}",
            )

    # Restore master session for subsequent strategy ticks.
    if master:
        restore_ok, restore_detail = _initialize_mt5_for_account(master)
        if not restore_ok:
            append_log("search", f"[ERROR] Master session restore failed: {restore_detail}")
    return f"Copied master trade to {copied}/{len(targets)} sub account(s)"


@dataclass
class Liquidity:
    price: float
    side: str
    triggered: bool = False
    effect: Optional[Callable] = None


def wait_for_new_candle(
    timeframe,
    symbol: str = SYMBOL_DEFAULT,
    poll_attempts: int = 10,
    poll_sleep: float = 0.2,
):
    if mt5_available():
        symbol_ok, _symbol_detail = _ensure_symbol_ready(symbol)
        if not symbol_ok:
            return None
        rates = mt5.copy_rates_from_pos(symbol, timeframe, 0, 1)
        if rates is None or len(rates) == 0:
            return None
        last_time = rates[0]["time"]
        for _ in range(poll_attempts):
            time.sleep(poll_sleep)
            new_rates = mt5.copy_rates_from_pos(symbol, timeframe, 0, 1)
            if new_rates is not None and len(new_rates) > 0 and new_rates[0]["time"] != last_time:
                closed = mt5.copy_rates_from_pos(symbol, timeframe, 1, 1)
                return closed[0] if closed is not None and len(closed) > 0 else None
        return None

    candle_ts = int(time.time())
    last_ts = _sim_last_candle_ts.get(symbol)
    if last_ts is not None and candle_ts <= last_ts:
        return None
    _sim_last_candle_ts[symbol] = candle_ts
    t = _tick_for(symbol)
    open_price = t.bid
    close_price = t.ask if candle_ts % 2 else t.bid
    return {"time": candle_ts, 1: open_price, 4: close_price}


def latest_closed_candle(timeframe, symbol: str = SYMBOL_DEFAULT):
    """Return the most recently closed candle without waiting for another one."""
    if mt5_available():
        symbol_ok, _symbol_detail = _ensure_symbol_ready(symbol)
        if not symbol_ok:
            return None
        rates = mt5.copy_rates_from_pos(symbol, timeframe, 1, 1)
        return rates[0] if rates is not None and len(rates) > 0 else None

    candle_ts = int(time.time())
    t = _tick_for(symbol)
    open_price = t.bid
    close_price = t.ask if candle_ts % 2 else t.bid
    return {"time": candle_ts, 1: open_price, 4: close_price}


def _candle_value(candle, key: int, fallback_name: str) -> float:
    if isinstance(candle, dict):
        if key in candle:
            return float(candle[key])
        if fallback_name in candle:
            return float(candle[fallback_name])
    return float(candle[key])


def _open_positions_count(symbol: str) -> int:
    if mt5_available():
        positions = mt5.positions_get(symbol=symbol)
        return len(positions) if positions else 0
    orders = get("orders", [])
    return len([o for o in orders if o.get("status") == "open" and o.get("symbol") == symbol])


def _close_mt5_position(position, close_volume: float | None = None, comment: str = "close all positions") -> tuple[bool, str]:
    symbol = str(getattr(position, "symbol", SYMBOL_DEFAULT) or SYMBOL_DEFAULT)
    position_volume = float(getattr(position, "volume", 0.0) or 0.0)
    volume = min(position_volume, float(close_volume)) if close_volume is not None else position_volume
    position_type = int(getattr(position, "type", -1))
    position_ticket = int(getattr(position, "ticket", 0) or 0)
    if volume <= 0 or position_ticket <= 0:
        return False, "invalid position volume/ticket"

    with MT5_LOCK:
        info = mt5.symbol_info(symbol) if mt5_available() else None
        if info is not None and not bool(getattr(info, "visible", False)):
            if not mt5.symbol_select(symbol, True):
                return False, f"symbol select failed: {mt5.last_error()}"
        tick = mt5.symbol_info_tick(symbol) if mt5_available() else None
        if tick is None:
            return False, "no tick"

        if position_type == mt5.ORDER_TYPE_BUY:
            close_type = mt5.ORDER_TYPE_SELL
            price = float(getattr(tick, "bid", 0.0) or 0.0)
        else:
            close_type = mt5.ORDER_TYPE_BUY
            price = float(getattr(tick, "ask", 0.0) or 0.0)

        if price <= 0:
            return False, "invalid close price"

        request = {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": symbol,
            "volume": round(volume, 2),
            "type": close_type,
            "position": position_ticket,
            "price": price,
            "deviation": 20,
            "magic": 123456,
            "comment": comment,
            "type_time": mt5.ORDER_TIME_GTC,
        }

        fill_modes = [mt5.ORDER_FILLING_FOK]
        for candidate in ("ORDER_FILLING_IOC", "ORDER_FILLING_RETURN"):
            mode = getattr(mt5, candidate, None)
            if mode is not None and mode not in fill_modes:
                fill_modes.append(mode)

        for fill_mode in fill_modes:
            request["type_filling"] = fill_mode
            result = mt5.order_send(request)
            if result is not None and getattr(result, "retcode", None) == mt5.TRADE_RETCODE_DONE:
                return True, f"done:{getattr(result, 'comment', '') or 'ok'}"
            if result is not None:
                detail = f"retcode={getattr(result, 'retcode', None)} comment={getattr(result, 'comment', '') or ''}".strip()
            else:
                detail = f"no result last_error={mt5.last_error()}"
            last_detail = detail
        return False, last_detail if "last_detail" in locals() else "close failed"


_manual_tp_sessions: list[dict] = []


def _manual_tp_position(session: dict):
    positions = mt5.positions_get(symbol=session["symbol"]) or []
    ticket = int(session.get("ticket") or 0)
    if ticket:
        for position in positions:
            if int(getattr(position, "ticket", 0) or 0) == ticket:
                return position

    expected_type = mt5.ORDER_TYPE_BUY if session["side"] == "BUY" else mt5.ORDER_TYPE_SELL
    candidates = [
        position
        for position in positions
        if int(getattr(position, "type", -1)) == expected_type
        and abs(float(getattr(position, "price_open", 0.0) or 0.0) - float(session["entry"])) <= 1.0
    ]
    if not candidates:
        return None
    position = max(candidates, key=lambda item: int(getattr(item, "time", 0) or 0))
    session["ticket"] = int(getattr(position, "ticket", 0) or 0) or None
    return position


def _monitor_manual_multi_tp() -> None:
    if not _manual_tp_sessions:
        stop_task(MANUAL_TP_TASK_NAME)
        return

    for session in list(_manual_tp_sessions):
        targets = session.get("targets", [])
        target_index = int(session.get("next_target", 0) or 0)
        if target_index >= max(0, len(targets) - 1):
            _manual_tp_sessions.remove(session)
            continue

        target_price, withdrawal_percent = targets[target_index]
        if mt5_available():
            position = _manual_tp_position(session)
            if position is None:
                _manual_tp_sessions.remove(session)
                continue
            tick = mt5.symbol_info_tick(session["symbol"])
            if tick is None:
                continue
            current_price = float(tick.bid if session["side"] == "BUY" else tick.ask)
            target_hit = current_price >= target_price if session["side"] == "BUY" else current_price <= target_price
            if not target_hit:
                continue
            current_volume = float(getattr(position, "volume", 0.0) or 0.0)
            close_volume = current_volume * float(withdrawal_percent) / 100.0
            closed, detail = _close_mt5_position(position, close_volume, "manual TP partial close")
            if not closed:
                emit_log(f"[manual_tp] TP{target_index + 1} partial close failed: {detail}", "warning")
                continue
        else:
            order_id = str(session.get("order_id") or "")
            orders = get("orders", [])
            order = next((item for item in orders if str(item.get("id")) == order_id and item.get("status") == "open"), None)
            if order is None:
                _manual_tp_sessions.remove(session)
                continue
            tick = _tick_for(session["symbol"])
            current_price = float(tick.bid if session["side"] == "BUY" else tick.ask)
            target_hit = current_price >= target_price if session["side"] == "BUY" else current_price <= target_price
            if not target_hit:
                continue
            order["lot"] = round(float(order.get("lot", 0.0) or 0.0) * (1.0 - float(withdrawal_percent) / 100.0), 2)
            replace_list("orders", orders)

        session["next_target"] = target_index + 1
        emit_log(
            f"[manual_tp] TP{target_index + 1} reached at {float(target_price):.2f}; withdrew {float(withdrawal_percent):.0f}% of remaining volume.",
            "success",
        )


def _register_manual_tp_session(side: str, entry: float, targets: list[tuple[float, float]], ticket=None, order_id: str | None = None) -> None:
    _manual_tp_sessions.append(
        {
            "symbol": SYMBOL_DEFAULT,
            "side": side,
            "entry": float(entry),
            "targets": list(targets),
            "next_target": 0,
            "ticket": int(ticket or 0) or None,
            "order_id": order_id,
        }
    )
    if not is_task_running(MANUAL_TP_TASK_NAME):
        start_task(MANUAL_TP_TASK_NAME, _monitor_manual_multi_tp, interval_sec=1, log_schedule=False)


def cancel_manual_auto_close() -> None:
    stop_task(MANUAL_AUTO_CLOSE_TASK_NAME)
    patch_path(
        "manual_trade",
        {
            "auto_close_at": None,
            "scheduled_at": None,
        },
    )


def schedule_manual_auto_close(close_at: datetime, side: str = "all", symbol: str | None = None) -> None:
    close_at_value = close_at.isoformat()

    def _run_close_all() -> None:
        try:
            close_all_positions(side=side, symbol=symbol)
            append_log("search", f"[WARNING] Auto close executed at scheduled end time {close_at_value}.")
        finally:
            cancel_manual_auto_close()

    start_task(
        MANUAL_AUTO_CLOSE_TASK_NAME,
        _run_close_all,
        interval_sec=86400,
        start_time=close_at,
        log_schedule=False,
    )
    patch_path(
        "manual_trade",
        {
            "auto_close_at": close_at_value,
            "scheduled_at": datetime.now().isoformat(),
        },
    )
    append_log("search", f"[INFO] Auto close scheduled for {close_at_value}.")


@_mt5_session_locked
def open_manual_position(
    order_type: str,
    lot_size: float | None = None,
    tp: float | None = None,
    sl: float | None = None,
    symbol: str = SYMBOL_DEFAULT,
    order_kind: str = "MARKET",
    limit_price: float | None = None,
    tp_in_pips: bool = False,
    sl_in_pips: bool = False,
    risk_percent: float | None = None,
    advanced: bool = False,
    sl_price: float | None = None,
    ratio: float = 3.0,
    tp1_ratio: float = 1.0,
    tp2_ratio: float = 1.0,
    tp3_ratio: float = 1.0,
    tp2_enabled: bool = False,
    tp3_enabled: bool = False,
    tp1_percent: float = 100.0,
    tp2_percent: float = 100.0,
    auto_close_at: datetime | None = None,
    copy_to_sub_accounts: bool = True,
    after_master_order: Callable[[dict], str | None] | None = None,
):
    master_ok, master_detail, _master, _cfg = _ensure_master_session()
    if not master_ok:
        message = f"Manual order blocked: {master_detail}"
        append_log("search", f"[ERROR] {message}")
        raise RuntimeError(message)
    master_login = _safe_int((_master or {}).get("user"))
    master_session_ok, master_session_detail = _verify_mt5_login(master_login)
    if not master_session_ok:
        message = f"Manual order blocked: {master_session_detail}"
        append_log("search", f"[ERROR] {message}")
        raise RuntimeError(message)
    append_log("search", f"[INFO] [order] manual master execution account={master_login}")
    account_info = mt5.account_info() if mt5_available() else None
    balance_before = float(getattr(account_info, "balance", 0.0) or 0.0) if account_info is not None else 0.0

    symbol_ok, symbol_detail = _ensure_symbol_ready(symbol)
    if not symbol_ok:
        message = f"Manual order blocked: {symbol_detail}"
        append_log("search", f"[ERROR] {message}")
        raise RuntimeError(message)

    tick = mt5.symbol_info_tick(symbol) if mt5_available() else _tick_for(symbol)
    if tick is None:
        message = f"Manual order blocked: no live tick for {symbol}."
        append_log("search", f"[ERROR] {message}")
        raise RuntimeError(message)
    order_type_upper = str(order_type).upper()
    order_kind_upper = str(order_kind or "MARKET").upper()
    is_buy = order_type_upper == "BUY"
    market_entry_price = float(tick.ask) if is_buy else float(tick.bid)
    if order_kind_upper not in {"MARKET", "LIMIT"}:
        raise RuntimeError("Order type must be MARKET or LIMIT.")
    if order_kind_upper == "LIMIT":
        if limit_price is None or float(limit_price) <= 0:
            raise RuntimeError("Enter a valid limit price.")
        entry_price = float(limit_price)
        if is_buy and entry_price >= float(tick.ask):
            raise RuntimeError("BUY limit price must be below the current market price.")
        if (not is_buy) and entry_price <= float(tick.bid):
            raise RuntimeError("SELL limit price must be above the current market price.")
    else:
        entry_price = market_entry_price

    # Risk is configured per account. Keep accepting an explicit value for
    # backwards compatibility, but use the master account setting by default.
    if risk_percent is None:
        master_account = _master or {}
        risk_percent = master_account.get(
            "risk_percent", master_account.get("risk_multiplier", 1.0)
        )

    if advanced:
        if sl_price is None:
            raise RuntimeError("Multi-TP orders require a Stop Loss Price.")
        stop_loss = float(sl_price)
        if (is_buy and stop_loss >= entry_price) or ((not is_buy) and stop_loss <= entry_price):
            raise RuntimeError("Stop Loss Price must be below BUY price or above SELL price.")
        risk_distance = abs(entry_price - stop_loss)
    elif sl is None:
        stop_loss = entry_price - 1.0 if is_buy else entry_price + 1.0
        risk_distance = abs(entry_price - stop_loss)
    elif sl_in_pips:
        risk_distance = float(sl) / 10.0
        stop_loss = entry_price - risk_distance if is_buy else entry_price + risk_distance
    else:
        stop_loss = float(sl)
        risk_distance = abs(entry_price - stop_loss)

    if risk_distance <= 0:
        raise RuntimeError("Stop Loss must be different from the entry price.")

    effective_lot = float(lot_size or 0.0)
    if risk_percent is not None and float(risk_percent) > 0:
        effective_lot = _risk_adjusted_volume(
            symbol,
            mt5.ORDER_TYPE_BUY if is_buy else mt5.ORDER_TYPE_SELL,
            entry_price,
            stop_loss,
            float(risk_percent),
            effective_lot or 0.01,
        )
    if effective_lot <= 0:
        raise RuntimeError("Enter a valid Risk % or Lot size.")

    take_profit_specs: list[tuple[float, float]] = []
    if advanced:
        enabled_withdrawals = [float(tp1_percent)]
        if tp2_enabled:
            enabled_withdrawals.append(float(tp2_percent))
        if tp3_enabled:
            enabled_withdrawals.append(100.0)
        if any(percent <= 0 or percent > 100 for percent in enabled_withdrawals):
            raise RuntimeError("TP withdrawal percentages must be between 0 and 100.")
        if any(percent >= 100 for percent in enabled_withdrawals[:-1]):
            raise RuntimeError("Only the last enabled TP can withdraw 100% of its remaining position.")
        tp_ratios = [float(tp1_ratio or 0)]
        if tp2_enabled:
            tp_ratios.append(float(tp2_ratio or 0))
        elif float(ratio or 0) > 0:
            tp_ratios[0] = float(ratio or 0)
        if tp3_enabled:
            tp_ratios.append(float(tp3_ratio or 0))
        if any(stage_ratio <= 0 for stage_ratio in tp_ratios):
            raise RuntimeError("Each enabled TP ratio must be greater than 0.")
        cumulative_ratio = 0.0
        for stage_ratio, percent in zip(tp_ratios, enabled_withdrawals):
            cumulative_ratio += stage_ratio
            distance = risk_distance * cumulative_ratio
            target = entry_price + distance if is_buy else entry_price - distance
            take_profit_specs.append((target, percent))
        take_profit = take_profit_specs[-1][0]
    elif tp is None:
        take_profit = entry_price + 1.0 if is_buy else entry_price - 1.0
    elif tp_in_pips:
        take_profit = entry_price + (float(tp) / 10.0) if is_buy else entry_price - (float(tp) / 10.0)
    else:
        take_profit = float(tp)

    request = {
        "action": mt5.TRADE_ACTION_PENDING if order_kind_upper == "LIMIT" else mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": round(float(effective_lot), 2),
        "type": (
            mt5.ORDER_TYPE_BUY_LIMIT if order_kind_upper == "LIMIT" and is_buy else
            mt5.ORDER_TYPE_SELL_LIMIT if order_kind_upper == "LIMIT" else
            mt5.ORDER_TYPE_BUY if is_buy else mt5.ORDER_TYPE_SELL
        ),
        "price": float(entry_price),
        "sl": round(float(stop_loss), 2),
        "tp": round(float(take_profit), 2),
        "deviation": 20,
        "magic": 123456,
        "comment": "manual limit order" if order_kind_upper == "LIMIT" else "manual position",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_RETURN if order_kind_upper == "LIMIT" else mt5.ORDER_FILLING_FOK,
    }

    check_ok, check_detail = _check_request(request)
    if not check_ok:
        message = f"Manual order blocked: {check_detail}"
        append_log("search", f"[ERROR] {message}")
        raise RuntimeError(message)

    result = mt5.order_send(request) if mt5_available() else None
    done = bool(result is not None and getattr(result, "retcode", None) == mt5.TRADE_RETCODE_DONE) or not mt5_available()
    if done:
        ticket = getattr(result, "order", int(time.time() * 1000))
        append_list(
            "orders",
            {
                "id": str(uuid4()),
                "ticket": ticket,
                "symbol": symbol,
                "side": str(order_type).upper(),
                "order_kind": order_kind_upper,
                "lot": round(float(effective_lot), 2),
                "entry": round(float(entry_price), 2),
                "tp": round(float(take_profit), 2),
                "sl": round(float(stop_loss), 2),
                "tp_targets": [
                    {"price": round(float(target), 2), "withdraw_percent": float(percent)}
                    for target, percent in take_profit_specs
                ],
                "tp_ratio_total": round(sum(float(stage_ratio or 0) for stage_ratio in (
                    [tp1_ratio]
                    + ([tp2_ratio] if tp2_enabled else [])
                    + ([tp3_ratio] if tp3_enabled else [])
                )), 4) if advanced else 0.0,
                "risk_percent": float(risk_percent or 0),
                "balance_before": balance_before,
                "status": "open",
                "origin": "manual",
                "auto_close_at": auto_close_at.isoformat() if isinstance(auto_close_at, datetime) else None,
                "created_at": datetime.now().isoformat(),
            },
            limit=2000,
        )
        if after_master_order is not None:
            copy_summary = after_master_order(dict(request))
        elif copy_to_sub_accounts:
            copy_summary = _clone_trade_to_sub_accounts(request, origin="manual")
        else:
            copy_summary = None
        copy_suffix = f" ({copy_summary})" if copy_summary else ""
        if isinstance(auto_close_at, datetime):
            schedule_manual_auto_close(auto_close_at)
        else:
            cancel_manual_auto_close()
        append_log("search", f"[SUCCESS] [order] success {order_kind_upper} {order_type_upper} {symbol}{copy_suffix}")
        if len(take_profit_specs) > 1:
            _register_manual_tp_session(
                order_type_upper,
                entry_price,
                take_profit_specs,
                ticket=getattr(result, "position", None) if result is not None else ticket,
                order_id=str(get("orders", [])[-1].get("id")) if not mt5_available() and get("orders", []) else None,
            )
    else:
        message = str(getattr(result, "comment", mt5.last_error()) or mt5.last_error())
        append_log("search", f"[ERROR] Manual order failed: {message}")
        raise RuntimeError(f"Manual order failed: {message}")
    return result


@_mt5_session_locked
def calculate_manual_lot(
    order_type: str,
    risk_percent: float | None,
    sl: float,
    sl_in_pips: bool = True,
    symbol: str = SYMBOL_DEFAULT,
    sl_price: bool = False,
) -> tuple[float, str]:
    master_ok, master_detail, _master, _cfg = _ensure_master_session()
    if not master_ok:
        raise RuntimeError(f"Connect the master account from Dashboard before calculating lot size: {master_detail}")
    if risk_percent is None:
        cfg = _load_config()
        master = _resolve_master_account(cfg)
        master = master or {}
        risk_percent = master.get("risk_percent", master.get("risk_multiplier", 1.0))
    if mt5_available() and mt5.account_info() is None:
        raise RuntimeError("Connect the master account from Dashboard before calculating lot size.")
    symbol_ok, symbol_detail = _ensure_symbol_ready(symbol)
    if not symbol_ok:
        raise RuntimeError(symbol_detail)
    tick = mt5.symbol_info_tick(symbol) if mt5_available() else _tick_for(symbol)
    if tick is None:
        raise RuntimeError(f"No live tick for {symbol}.")
    side = str(order_type).upper()
    is_buy = side == "BUY"
    entry_price = float(tick.ask if is_buy else tick.bid)
    if sl_price:
        stop_loss = float(sl)
    elif sl_in_pips:
        distance = float(sl) / 10.0
        stop_loss = entry_price - distance if is_buy else entry_price + distance
    else:
        stop_loss = float(sl)
    if (is_buy and stop_loss >= entry_price) or ((not is_buy) and stop_loss <= entry_price):
        raise RuntimeError("Stop Loss must be below BUY price or above SELL price.")
    lot = _risk_adjusted_volume(
        symbol,
        mt5.ORDER_TYPE_BUY if is_buy else mt5.ORDER_TYPE_SELL,
        entry_price,
        stop_loss,
        float(risk_percent),
        0.01,
    )
    return lot, f"Lot calculated from {float(risk_percent):.2f}% risk and {abs(entry_price - stop_loss):.2f} price distance."


def close_all_positions(side: str = "all", symbol: str | None = None):
    _manual_tp_sessions.clear()
    stop_task(MANUAL_TP_TASK_NAME)
    cancel_manual_auto_close()
    closed_tickets: set[int] = set()
    attempted = 0
    errors: list[str] = []
    cfg = _load_config()
    accounts = cfg.get("trading_accounts", []) if isinstance(cfg, dict) else []
    master = _resolve_master_account(cfg)
    require_ticket_match = mt5_available() and bool(accounts)
    if mt5_available() and accounts:
        for account in accounts:
            login = _safe_int(account.get("user"))
            if login <= 0:
                continue
            init_ok, init_detail = _initialize_mt5_for_account(account)
            if not init_ok:
                errors.append(f"{login}: init failed {init_detail}")
                append_log("search", f"[ERROR] Close init failed for {login}: {init_detail}")
                continue
            try:
                positions = mt5.positions_get() if symbol is None else mt5.positions_get(symbol=symbol)
                if not positions:
                    continue
                for pos in positions:
                    try:
                        position_side = "buy" if int(getattr(pos, "type", -1)) == mt5.ORDER_TYPE_BUY else "sell"
                        if side == "buy" and position_side != "buy":
                            continue
                        if side == "sell" and position_side != "sell":
                            continue
                        attempted += 1
                        closed_ok, close_detail = _close_mt5_position(pos)
                        if closed_ok:
                            closed_tickets.add(int(getattr(pos, "ticket", 0) or 0))
                        else:
                            symbol_name = str(getattr(pos, "symbol", symbol or SYMBOL_DEFAULT) or SYMBOL_DEFAULT)
                            message = f"Close failed ticket={getattr(pos, 'ticket', '-')} symbol={symbol_name} {close_detail}"
                            errors.append(message)
                            append_log("search", f"[ERROR] {message}")
                    except Exception as ex:
                        message = f"{login}: close error {ex}"
                        errors.append(message)
                        append_log("search", f"[ERROR] {message}")
            finally:
                pass
        if master:
            restore_ok, restore_detail = _initialize_mt5_for_account(master)
            if not restore_ok:
                errors.append(f"master restore failed: {restore_detail}")
                append_log("search", f"[ERROR] Master session restore failed: {restore_detail}")
    else:
        for order in get("orders", []):
            if order.get("status") != "open":
                continue
            if side == "buy" and order.get("side") != "BUY":
                continue
            if side == "sell" and order.get("side") != "SELL":
                continue
            attempted += 1
            try:
                closed_tickets.add(int(order.get("ticket", 0) or 0))
            except Exception:
                continue
    orders = get("orders", [])
    for order in orders:
        if order.get("status") != "open":
            continue
        if side == "buy" and order.get("side") != "BUY":
            continue
        if side == "sell" and order.get("side") != "SELL":
            continue
        try:
            ticket = int(order.get("ticket", 0) or 0)
        except Exception:
            ticket = 0
        if require_ticket_match and ticket not in closed_tickets:
            continue
        order["status"] = "closed"
        order["closed_at"] = datetime.now().isoformat()
    replace_list("orders", orders)
    return {"attempted": attempted, "closed": len(closed_tickets), "real_close": mt5_available(), "errors": errors}
    append_log("search", f"[WARNING] Close positions requested ({side}) for {symbol}.")


def account_management(profit_percent, risk_percent, start_balance, symbol: str = SYMBOL_DEFAULT):
    if mt5_available():
        info = mt5.account_info()
        if info is None:
            return True, "warning", "No account info available."
        current_balance = float(info.equity)
    else:
        accounts = _load_config().get("trading_accounts", [])
        current_balance = float(sum(float(a.get("equity", a.get("balance", 0)) or 0) for a in accounts) or start_balance)

    trade_diff = current_balance - float(start_balance or 0)
    profit_threshold = float(start_balance) * (float(profit_percent) / 100.0)
    risk_threshold = float(start_balance) * (float(risk_percent) / 100.0)

    if trade_diff >= profit_threshold:
        close_all_positions(symbol=symbol)
        return False, "success", f"Daily profit limit reached: {trade_diff:.2f} USD"
    if trade_diff <= -risk_threshold:
        close_all_positions(symbol=symbol)
        return False, "warning", f"Daily risk limit reached: {abs(trade_diff):.2f} USD"
    return True, "debug", f"Balance: {current_balance:.2f} | Current P/L: {trade_diff:.2f} USD"


@_mt5_session_locked
def open_order_strategy(config_data):
    def body_pips(open_price, close_price):
        return round((open_price - close_price) * 10, 3)

    master_ok, master_detail, _master, _cfg = _ensure_master_session()
    if not master_ok:
        emit_log(f"[order] blocked: {master_detail}", "error")
        return None
    master_login = _safe_int((_master or {}).get("user"))
    master_session_ok, master_session_detail = _verify_mt5_login(master_login)
    if not master_session_ok:
        emit_log(f"[order] blocked: {master_session_detail}", "error")
        return None
    emit_log(f"[order] master execution account={master_login}", "debug")
    account_info = mt5.account_info() if mt5_available() else None
    balance_before = float(getattr(account_info, "balance", 0.0) or 0.0) if account_info is not None else 0.0

    min_pips = config_data.get("min_pips", config_data.get("pips"))
    max_pips = config_data["max_pips"]
    fallback_lot = float(config_data.get("lot", 0.01) or 0.01)
    master_risk_percent = (_master or {}).get(
        "risk_percent", (_master or {}).get("risk_multiplier", 1.0)
    )
    risk_percent = float(master_risk_percent or 0.0)
    max_positions = int(config_data.get("max_positions", 0) or 0)
    enable_buy = bool(config_data.get("enable_buy", True))
    enable_sell = bool(config_data.get("enable_sell", True))
    pullback_enabled = bool(config_data.get("enable_pullback", config_data.get("pullback_enabled", False)))
    pullback_pips = float(config_data.get("pullback_pips", 0) or 0)
    tp_type = bool(config_data["tp_type"])
    tp_val = float(config_data["tp"])
    sl_type = bool(config_data["sl_type"])
    sl_val = float(config_data["sl"])
    candle = config_data["candle"]
    symbol = config_data.get("symbol", SYMBOL_DEFAULT)

    symbol_ok, symbol_detail = _ensure_symbol_ready(symbol)
    if not symbol_ok:
        emit_log(f"[order] blocked: {symbol_detail}", "error")
        return None

    if min_pips is None:
        raise KeyError('config_data must contain "min_pips" (or legacy "pips")')

    pips = body_pips(_candle_value(candle, 1, "open"), _candle_value(candle, 4, "close"))
    if not (float(min_pips) <= abs(pips) <= float(max_pips)):
        return None

    tick = mt5.symbol_info_tick(symbol) if mt5_available() else _tick_for(symbol)
    if tick is None:
        return None

    if max_positions > 0:
        if _open_positions_count(symbol) >= max_positions:
            return None

    forced_side = config_data.get("forced_side")
    if forced_side == "buy":
        if pips >= 0 or not enable_buy:
            return None
        order_type = mt5.ORDER_TYPE_BUY
        entry_price = float(tick.ask)
    elif forced_side == "sell":
        if pips <= 0 or not enable_sell:
            return None
        order_type = mt5.ORDER_TYPE_SELL
        entry_price = float(tick.bid)
    else:
        if pips < 0:
            if not enable_buy:
                return None
            order_type = mt5.ORDER_TYPE_BUY
            entry_price = float(tick.ask)
        else:
            if not enable_sell:
                return None
            order_type = mt5.ORDER_TYPE_SELL
            entry_price = float(tick.bid)

    if pullback_enabled and pullback_pips > 0 and not mt5_available():
        # In simulation mode we skip pullback enforcement against real positions.
        pass

    tp = (entry_price + (tp_val / 10)) if tp_type and order_type == mt5.ORDER_TYPE_BUY else (
        (entry_price - (tp_val / 10)) if tp_type else float(tp_val)
    )
    sl = (entry_price - (sl_val / 10)) if sl_type and order_type == mt5.ORDER_TYPE_BUY else (
        (entry_price + (sl_val / 10)) if sl_type else float(sl_val)
    )
    lot = _risk_adjusted_volume(symbol, order_type, entry_price, sl, risk_percent, fallback_lot)
    side_label = "BUY" if order_type == mt5.ORDER_TYPE_BUY else "SELL"

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": float(lot),
        "type": order_type,
        "price": float(entry_price),
        "tp": float(tp),
        "sl": float(sl),
        "deviation": 20,
        "magic": 1000,
        "comment": "strategy position",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_FOK,
    }

    check_ok, check_detail = _check_request(request)
    if not check_ok:
        emit_log(f"[order] blocked {side_label} {symbol} reason={check_detail}", "warning")
        return None

    result = mt5.order_send(request) if mt5_available() else None
    done = bool(result is not None and getattr(result, "retcode", None) == mt5.TRADE_RETCODE_DONE) or not mt5_available()
    if done:
        append_list(
            "orders",
            {
                "id": str(uuid4()),
                "ticket": getattr(result, "order", int(time.time() * 1000)),
                "symbol": symbol,
                "side": side_label,
                "lot": float(lot),
                "entry": round(float(entry_price), 2),
                "tp": round(float(tp), 2),
                "sl": round(float(sl), 2),
                "balance_before": balance_before,
                "status": "open",
                "origin": "strategy",
                "created_at": datetime.now().isoformat(),
            },
            limit=2000,
        )
        copy_summary = _clone_trade_to_sub_accounts(request, origin="strategy")
        copy_suffix = f" ({copy_summary})" if copy_summary else ""
        emit_log(f"[order] success {side_label} {symbol}{copy_suffix}", "success")
        return result or SimpleNamespace(retcode=mt5.TRADE_RETCODE_DONE, order=int(time.time() * 1000))

    emit_log(
        f"[order] failed {side_label} {symbol} retcode={getattr(result, 'retcode', None)} comment={getattr(result, 'comment', mt5.last_error())}",
        "error",
    )
    return None


class LiquidityManager:
    def __init__(self, symbol: str = SYMBOL_DEFAULT, timeframe=mt5.TIMEFRAME_M1):
        self.symbol = symbol
        self.timeframe = timeframe
        self.leq_list: list[Liquidity] = []
        self.active_liq: Optional[Liquidity] = None
        self.orders_opened: int = 0
        self.orders_limit_total: int = 0
        self.last_stop_reason: Optional[str] = None
        self._last_global_candle_time: Optional[int] = None
        self._last_pos_candle_time: Optional[int] = None
        self._wait_close_after_leq_trigger: bool = False
        self._concurrent_lock_after_close: bool = False
        self._open_positions_peak: int = 0
        self._last_open_positions: Optional[int] = None
        self._max_positions_pause_logged: bool = False
        self._first_cycle_pending: bool = True
        self._orders_paused: bool = False
        self._lock = threading.Lock()

    def add(self, liq: Liquidity):
        with self._lock:
            self.leq_list.append(liq)
            replace_list(
                "liquidity_levels",
                [
                    {
                        "id": idx + 1,
                        "price": round(x.price, 2),
                        "side": x.side.upper(),
                        "state": "Triggered" if x.triggered else "Pending",
                    }
                    for idx, x in enumerate(self.leq_list)
                ],
            )

    def remove(self, liq_id: int):
        with self._lock:
            if 0 <= liq_id - 1 < len(self.leq_list):
                self.leq_list.pop(liq_id - 1)
            replace_list(
                "liquidity_levels",
                [
                    {
                        "id": idx + 1,
                        "price": round(x.price, 2),
                        "side": x.side.upper(),
                        "state": "Triggered" if x.triggered else "Pending",
                    }
                    for idx, x in enumerate(self.leq_list)
                ],
            )

    def clear_active(self):
        with self._lock:
            self.active_liq = None

    def set_orders_limit(self, orders_limit: int):
        with self._lock:
            self.orders_limit_total = max(0, int(orders_limit or 0))

    def _stop_strategy_now(self, reason: Optional[str] = None):
        if reason:
            self.last_stop_reason = reason
            emit_log(f"[strategy] {reason}", "warning")
        stop_task("search_global")
        stop_task("search_leq")
        stop_task("pos_search")
        self.clear_active()
        patch_path(
            "strategy",
            {
                "running": False,
                "tasks": [],
                "last_stop_reason": self.last_stop_reason,
            },
        )

    @staticmethod
    def _is_trade_done(result) -> bool:
        return result is not None and getattr(result, "retcode", None) == mt5.TRADE_RETCODE_DONE

    def _register_result_and_enforce_limit(self, result, base_config: Optional[dict] = None):
        if not self._is_trade_done(result):
            return
        with self._lock:
            self.orders_opened += 1
            limit = int(self.orders_limit_total or 0)
            reached_limit = limit > 0 and self.orders_opened >= limit
        pause_after_first = bool((base_config or {}).get("stop_on_first_close", False))
        if pause_after_first and not self._orders_paused:
            self._orders_paused = True
            emit_log("[strategy] Search paused after first position opened.", "warning")
        elif reached_limit:
            self._stop_strategy_now(f"Orders limit reached ({self.orders_opened}/{limit}). Strategy stopped.")

    def _touched_tick(self, liq: Liquidity, tick) -> bool:
        if liq.side == "buy":
            return float(tick.ask) <= float(liq.price)
        return float(tick.bid) >= float(liq.price)

    def _symbol_open_positions(self) -> int:
        return _open_positions_count(self.symbol)

    @staticmethod
    def _max_positions_from_config(base_config: dict) -> int:
        return int(base_config.get("max_positions", 0) or 0)

    def _active_liq_side(self) -> Optional[str]:
        with self._lock:
            return self.active_liq.side if self.active_liq else None

    def _clear_active_liquidity(self, remove_from_list: bool = False):
        with self._lock:
            liq = self.active_liq
            if liq is None:
                return
            if remove_from_list:
                try:
                    self.leq_list.remove(liq)
                except ValueError:
                    pass
            self.active_liq = None
            self._last_pos_candle_time = None
            self._wait_close_after_leq_trigger = False

    def _concurrent_positions_locked(self, base_config: dict) -> bool:
        with self._lock:
            if self._orders_paused:
                return False
        max_positions = self._max_positions_from_config(base_config)
        if max_positions <= 0:
            return False
        stop_on_first_close = bool(base_config.get("stop_on_first_close", False))

        open_positions = self._symbol_open_positions()
        with self._lock:
            if self._last_open_positions is None:
                self._last_open_positions = open_positions
                self._open_positions_peak = max(self._open_positions_peak, open_positions)
                return False
            if open_positions > self._open_positions_peak:
                self._open_positions_peak = open_positions
            if not self._concurrent_lock_after_close and self._open_positions_peak > 0 and open_positions < self._open_positions_peak:
                self._concurrent_lock_after_close = True
                reason = (
                    "A position closed (TP/SL). Strategy stopped (stop_on_first_close enabled)."
                    if stop_on_first_close
                    else "Concurrent mode: a position closed (TP/SL). New positions disabled until strategy restart."
                )
                if stop_on_first_close:
                    self._stop_strategy_now(reason)
                    return True
                if not self.last_stop_reason:
                    self.last_stop_reason = reason
            self._last_open_positions = open_positions
            return self._concurrent_lock_after_close

    def _active_liq_reached_max_positions(self, base_config: dict) -> bool:
        side = self._active_liq_side()
        if side is None:
            return False
        max_positions = self._max_positions_from_config(base_config)
        if max_positions <= 0:
            return False
        return self._symbol_open_positions() >= max_positions

    def global_search_tick(self, base_config: dict):
        if self._concurrent_positions_locked(base_config):
            return
        with self._lock:
            first_cycle_pending = self._first_cycle_pending
        if first_cycle_pending:
            candle = latest_closed_candle(self.timeframe, symbol=self.symbol)
            if candle is not None:
                with self._lock:
                    self._first_cycle_pending = False
        else:
            candle = wait_for_new_candle(self.timeframe, symbol=self.symbol)
        if candle is None:
            return
        candle_time = int(candle["time"])
        with self._lock:
            if candle_time == self._last_global_candle_time:
                return
            self._last_global_candle_time = candle_time
            orders_paused = self._orders_paused
        if orders_paused:
            return
        cfg = base_config.copy()
        cfg["symbol"] = self.symbol
        cfg["candle"] = candle
        cfg.pop("forced_side", None)
        result = open_order_strategy(cfg)
        self._register_result_and_enforce_limit(result, base_config)

    def search_leq_tick(self, base_config: dict):
        with self._lock:
            first_cycle_pending = self._first_cycle_pending
            orders_paused = self._orders_paused
            if first_cycle_pending:
                self._first_cycle_pending = False
        if orders_paused:
            return
        if self._concurrent_positions_locked(base_config):
            stop_task("pos_search")
            self._clear_active_liquidity(remove_from_list=False)
            return
        max_positions = self._max_positions_from_config(base_config)
        if max_positions > 0 and self._symbol_open_positions() >= max_positions:
            stop_task("pos_search")
            self._clear_active_liquidity(remove_from_list=False)
            if not self.last_stop_reason:
                self.last_stop_reason = "Liquidity mode paused at max positions."
            return

        tick = mt5.symbol_info_tick(self.symbol) if mt5_available() else _tick_for(self.symbol)
        if tick is None:
            return

        with self._lock:
            if self.active_liq is not None:
                return
            candidates = [l for l in self.leq_list if not l.triggered]
            if not candidates:
                return

        triggered_liq = None
        for liq in candidates:
            if self._touched_tick(liq, tick):
                triggered_liq = liq
                break
        if triggered_liq is None:
            return

        with self._lock:
            triggered_liq.triggered = True
            self.active_liq = triggered_liq
            self._last_pos_candle_time = None
            self._wait_close_after_leq_trigger = True
        emit_log(f"[liquidity] triggered side={triggered_liq.side} level={triggered_liq.price}", "info")

        stop_task("pos_search")
        cfg = base_config.copy()
        cfg["symbol"] = self.symbol
        cfg["forced_side"] = triggered_liq.side
        start_task("pos_search", lambda: self.pos_search_tick(cfg), interval_sec=1, start_time=datetime.now())

    def pos_search_tick(self, cfg: dict):
        with self._lock:
            liq = self.active_liq
            orders_paused = self._orders_paused
        if liq is None:
            stop_task("pos_search")
            return
        if orders_paused:
            stop_task("pos_search")
            return
        if self._concurrent_positions_locked(cfg):
            self._clear_active_liquidity(remove_from_list=True)
            stop_task("pos_search")
            return
        if self._active_liq_reached_max_positions(cfg):
            self._clear_active_liquidity(remove_from_list=True)
            stop_task("pos_search")
            return

        candle = wait_for_new_candle(self.timeframe, symbol=self.symbol)
        if candle is None:
            return
        candle_time = int(candle["time"])
        with self._lock:
            if candle_time == self._last_pos_candle_time:
                return
            self._last_pos_candle_time = candle_time
            if self._wait_close_after_leq_trigger:
                self._wait_close_after_leq_trigger = False
                return

        cfg["candle"] = candle
        cfg["forced_side"] = liq.side
        result = open_order_strategy(cfg)
        if self._is_trade_done(result):
            self._register_result_and_enforce_limit(result, cfg)
            if self._active_liq_reached_max_positions(cfg):
                self._clear_active_liquidity(remove_from_list=True)
                stop_task("pos_search")


manager = LiquidityManager(symbol=SYMBOL_DEFAULT, timeframe=mt5.TIMEFRAME_M1)


def strategy_status() -> dict:
    return get("strategy", {})


def start_strategy_system(
    base_config_data: dict,
    interval_sec: int = 1,
    liquidity_enabled: bool = True,
    start_time: Optional[datetime] = None,
    end_time: Optional[datetime] = None,
    end_time_enabled: bool = False,
):
    master_ok, master_detail, _master, _cfg = _ensure_master_session()
    if not master_ok:
        raise RuntimeError(master_detail)

    with manager._lock:
        manager.timeframe = _resolve_timeframe(base_config_data.get("timeframe", mt5.TIMEFRAME_M1))
        manager.orders_opened = 0
        manager.orders_limit_total = int(base_config_data.get("orders_limit", base_config_data.get("max_orders", 0)) or 0)
        manager.last_stop_reason = None
        manager.active_liq = None
        manager._last_global_candle_time = None
        manager._last_pos_candle_time = None
        manager._wait_close_after_leq_trigger = False
        manager._concurrent_lock_after_close = False
        manager._open_positions_peak = 0
        manager._last_open_positions = None
        manager._max_positions_pause_logged = False
        manager._first_cycle_pending = True
        manager._orders_paused = False

    strategy_start = start_time if isinstance(start_time, datetime) else datetime.now()
    clock_now = datetime.now(strategy_start.tzinfo) if strategy_start.tzinfo else datetime.now()
    first_check_base = strategy_start if strategy_start > clock_now else clock_now
    first_check_time = first_check_base + timedelta(seconds=_timeframe_seconds(manager.timeframe))
    strategy_started_at = datetime.now().isoformat()

    def log_initial_cycle_message():
        current_strategy = get("strategy", {})
        if (
            current_strategy.get("running")
            and current_strategy.get("started_at") == strategy_started_at
        ):
            emit_log(
                "[strategy] First initial timeframe cycle completed; checking search conditions.",
                "debug",
            )

    def on_strategy_end():
        try:
            stop_task("search_global")
            stop_task("search_leq")
            stop_task("pos_search")
            if not manager.last_stop_reason:
                manager.last_stop_reason = "End time reached. Closing all open positions."
            emit_log(f"[strategy] {manager.last_stop_reason}", "warning")
            manager.clear_active()
            close_all_positions(symbol=manager.symbol)
            patch_path("strategy", {"running": False, "tasks": [], "last_stop_reason": manager.last_stop_reason})
        except Exception as ex:
            emit_log(f"[strategy_end] error: {ex}", "error")

    if liquidity_enabled:
        stop_task("search_global")
        stop_task("pos_search")
        start_task(
            "search_leq",
            lambda: manager.search_leq_tick(base_config_data),
            interval_sec=interval_sec,
            start_time=first_check_time,
            end_time=end_time,
            end_time_enabled=end_time_enabled,
            on_task_end=on_strategy_end if end_time_enabled else None,
        )
        tasks = ["search_leq", "pos_search"]
        mode = "search_leq"
    else:
        start_task(
            "search_global",
            lambda: manager.global_search_tick(base_config_data),
            interval_sec=interval_sec,
            start_time=first_check_time,
            end_time=end_time,
            end_time_enabled=end_time_enabled,
            on_task_end=on_strategy_end if end_time_enabled else None,
        )
        stop_task("search_leq")
        stop_task("pos_search")
        manager.clear_active()
        tasks = ["search_global"]
        mode = "search_global"

    patch_path(
        "strategy",
        {
            "running": True,
            "mode": mode,
            "started_at": strategy_started_at,
            "tasks": tasks,
            "start_time": strategy_start.isoformat(),
            "end_time": end_time.isoformat() if isinstance(end_time, datetime) else None,
            "last_stop_reason": None,
        },
    )
    initial_log_delay = max(0.0, (strategy_start - clock_now).total_seconds())
    initial_log_timer = threading.Timer(initial_log_delay, log_initial_cycle_message)
    initial_log_timer.daemon = True
    initial_log_timer.start()
    master_risk_percent = float(
        (_master or {}).get("risk_percent", (_master or {}).get("risk_multiplier", 1.0)) or 0.0
    )
    lot_value = base_config_data.get("lot", "auto")
    tp_unit = "pips" if bool(base_config_data.get("tp_type", True)) else "price"
    sl_unit = "pips" if bool(base_config_data.get("sl_type", True)) else "price"
    start_label = strategy_start.strftime("%Y-%m-%d %H:%M:%S")
    end_label = end_time.strftime("%Y-%m-%d %H:%M:%S") if isinstance(end_time, datetime) else "not set"
    mode_label = "leq" if liquidity_enabled else "normal"
    append_log(
        "search",
        "[INFO] Search started "
        f"(risk: {master_risk_percent:.2f}%; "
        f"tp: {base_config_data.get('tp')}; sl: {base_config_data.get('sl')}; "
        f"mode: {mode_label}) start: {start_label}- end: {end_label}",
    )


def stop_strategy_system():
    stop_task("search_global")
    stop_task("search_leq")
    stop_task("pos_search")
    manager.clear_active()
    patch_path("strategy", {"running": False, "tasks": [], "last_stop_reason": manager.last_stop_reason})
    append_log("search", "[WARNING] Manual stop requested.")


def running_tasks() -> dict[str, bool]:
    return {
        "search_global": is_task_running("search_global"),
        "search_leq": is_task_running("search_leq"),
        "pos_search": is_task_running("pos_search"),
        "account_management": is_task_running("account_management"),
    }
