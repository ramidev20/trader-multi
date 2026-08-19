from __future__ import annotations

import argparse
import json
import os
import time
from datetime import datetime
from pathlib import Path
from typing import Any

import MetaTrader5 as mt5

from backend.app.services.path_utils import resolve_terminal_path
from backend.app.services.session_service import adapter_command_paths, submit_adapter_command
from backend.app.services.strategy_service import (
    _build_copy_request,
    _copy_targets,
    _load_config,
    _safe_int,
    open_manual_position,
)


def write_status(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def initialize_session(login: int, password: str, server: str, terminal_path: str) -> tuple[bool, str]:
    try:
        mt5.shutdown()
    except Exception:
        pass
    ok = mt5.initialize(
        login=login,
        password=password,
        server=server,
        path=terminal_path,
    )
    return ok, str(mt5.last_error()) if not ok else "ok"


def _write_command_result(path: Path, result: dict[str, Any]) -> None:
    temp_path = path.with_suffix(".tmp")
    temp_path.write_text(json.dumps(result), encoding="utf-8")
    temp_path.replace(path)


def _copy_to_connected_sub_adapters(master_request: dict[str, Any]) -> str | None:
    """Fan out a master trade without changing the current adapter's MT5 login."""
    config = _load_config()
    master_login = _safe_int(config.get("master_account_login"))
    targets = _copy_targets(config, master_login)
    if not targets:
        return "Copied master trade to 0/0 sub adapter(s)"

    copied = 0
    active_targets = 0
    target_details: list[str] = []
    for account, risk_percent in targets:
        login = _safe_int(account.get("user"))
        delay_seconds = max(
            0.0,
            float(account.get("order_delay_sec", account.get("orderDelaySec", 0)) or 0),
        )
        result = submit_adapter_command(
            login,
            "copy_open",
            {
                "master_request": master_request,
                "risk_percent": float(risk_percent),
                "order_delay_sec": delay_seconds,
                "origin": "manual",
            },
            timeout_sec=15.0,
        )
        if result.get("status") == "ok":
            active_targets += 1
            copied += 1
            target_details.append(f"{login}: {delay_seconds:g}s delay")

    if active_targets == 0:
        return f"Copied master trade to 0/{len(targets)} sub adapter(s); no sub adapter is connected"
    detail = ", ".join(target_details)
    return f"Copied master trade to {copied}/{len(targets)} sub adapter(s) ({detail})"


def _execute_copy_open(payload: dict[str, Any]) -> dict[str, Any]:
    master_request = payload.get("master_request", {})
    if not isinstance(master_request, dict):
        return {"status": "error", "message": "Invalid master trade for copy command."}
    try:
        delay_seconds = max(0.0, float(payload.get("order_delay_sec", 0) or 0))
        if delay_seconds > 0:
            time.sleep(delay_seconds)
        request = _build_copy_request(
            master_request,
            float(payload.get("risk_percent", 1.0) or 1.0),
            str(payload.get("origin", "manual")),
        )
        result = mt5.order_send(request)
        if result is None or getattr(result, "retcode", None) != mt5.TRADE_RETCODE_DONE:
            message = str(getattr(result, "comment", mt5.last_error()) or mt5.last_error())
            return {"status": "error", "message": f"Copy order failed: {message}"}
        return {
            "status": "ok",
            "ticket": int(getattr(result, "order", 0) or getattr(result, "position", 0) or 0),
        }
    except Exception as ex:
        return {"status": "error", "message": str(ex)}


def _execute_command(command: dict[str, Any]) -> dict[str, Any]:
    action = str(command.get("action", "")).strip().lower()
    payload = command.get("payload", {})
    if not isinstance(payload, dict):
        return {"status": "error", "message": "Invalid adapter command payload."}
    if action == "copy_open":
        return _execute_copy_open(payload)
    if action == "chart":
        try:
            symbol = str(payload.get("symbol", "XAUUSD") or "XAUUSD").strip().upper()
            timeframe_name = str(payload.get("timeframe", "M1") or "M1").strip().upper()
            timeframe = {
                "M1": mt5.TIMEFRAME_M1,
                "M3": mt5.TIMEFRAME_M3,
                "M5": mt5.TIMEFRAME_M5,
                "M15": mt5.TIMEFRAME_M15,
            }.get(timeframe_name, mt5.TIMEFRAME_M1)
            count = max(20, min(400, int(payload.get("count", 180) or 180)))

            symbol_info = mt5.symbol_info(symbol)
            if symbol_info is None:
                return {"status": "error", "message": f"Symbol {symbol} is unavailable in the connected MT5 terminal."}
            if not bool(getattr(symbol_info, "visible", False)) and not mt5.symbol_select(symbol, True):
                return {"status": "error", "message": f"Could not select {symbol} in Market Watch."}

            rates = mt5.copy_rates_from_pos(symbol, timeframe, 0, count)
            if rates is None or len(rates) == 0:
                return {"status": "error", "message": f"MT5 returned no {timeframe_name} candles for {symbol}: {mt5.last_error()}"}

            tick = mt5.symbol_info_tick(symbol)
            chart_orders = []
            for position in mt5.positions_get(symbol=symbol) or []:
                position_type = int(getattr(position, "type", -1))
                chart_orders.append(
                    {
                        "ticket": int(getattr(position, "ticket", 0) or 0),
                        "symbol": symbol,
                        "side": "BUY" if position_type == mt5.POSITION_TYPE_BUY else "SELL",
                        "order_kind": "MARKET",
                        "lot": float(getattr(position, "volume", 0.0) or 0.0),
                        "price": float(getattr(position, "price_open", 0.0) or 0.0),
                        "sl": float(getattr(position, "sl", 0.0) or 0.0),
                        "tp": float(getattr(position, "tp", 0.0) or 0.0),
                        "opened_at": int(getattr(position, "time", 0) or 0),
                        "status": "open",
                    }
                )
            for order in mt5.orders_get(symbol=symbol) or []:
                order_type = int(getattr(order, "type", -1))
                if order_type not in {mt5.ORDER_TYPE_BUY_LIMIT, mt5.ORDER_TYPE_SELL_LIMIT}:
                    continue
                chart_orders.append(
                    {
                        "ticket": int(getattr(order, "ticket", 0) or 0),
                        "symbol": symbol,
                        "side": "BUY" if order_type == mt5.ORDER_TYPE_BUY_LIMIT else "SELL",
                        "order_kind": "LIMIT",
                        "lot": float(getattr(order, "volume_current", getattr(order, "volume_initial", 0.0)) or 0.0),
                        "price": float(getattr(order, "price_open", 0.0) or 0.0),
                        "sl": float(getattr(order, "sl", 0.0) or 0.0),
                        "tp": float(getattr(order, "tp", 0.0) or 0.0),
                        "opened_at": int(getattr(order, "time_setup", 0) or 0),
                        "status": "open",
                    }
                )
            return {
                "status": "ok",
                "source": "live",
                "symbol": symbol,
                "timeframe": timeframe_name,
                "candles": [
                    {
                        "time": int(row["time"]),
                        "open": float(row["open"]),
                        "high": float(row["high"]),
                        "low": float(row["low"]),
                        "close": float(row["close"]),
                    }
                    for row in rates
                ],
                "orders": chart_orders,
                "bid": float(getattr(tick, "bid", 0.0) or 0.0) if tick is not None else None,
                "ask": float(getattr(tick, "ask", 0.0) or 0.0) if tick is not None else None,
                "server_time": int(getattr(tick, "time", 0) or 0) if tick is not None else None,
            }
        except Exception as ex:
            return {"status": "error", "message": str(ex)}
    if action == "snapshot":
        try:
            info = mt5.account_info()
            terminal = mt5.terminal_info()
            if info is None:
                return {"status": "error", "message": "MT5 account information is unavailable."}
            positions = []
            for position in mt5.positions_get() or []:
                positions.append(
                    {
                        "ticket": int(getattr(position, "ticket", 0) or 0),
                        "symbol": str(getattr(position, "symbol", "XAUUSD") or "XAUUSD"),
                        "side": "BUY" if int(getattr(position, "type", 0) or 0) == mt5.ORDER_TYPE_BUY else "SELL",
                        "lot": float(getattr(position, "volume", 0.0) or 0.0),
                        "open_price": float(getattr(position, "price_open", 0.0) or 0.0),
                        "sl": float(getattr(position, "sl", 0.0) or 0.0),
                        "tp": float(getattr(position, "tp", 0.0) or 0.0),
                        "profit": float(getattr(position, "profit", 0.0) or 0.0),
                        "comment": str(getattr(position, "comment", "") or ""),
                        "opened_at": int(getattr(position, "time", 0) or 0),
                    }
                )
            orders = []
            for order in mt5.orders_get() or []:
                order_type = int(getattr(order, "type", -1) or -1)
                if order_type not in {
                    mt5.ORDER_TYPE_BUY_LIMIT,
                    mt5.ORDER_TYPE_SELL_LIMIT,
                }:
                    continue
                side = "BUY" if order_type == mt5.ORDER_TYPE_BUY_LIMIT else "SELL"
                orders.append(
                    {
                        "ticket": int(getattr(order, "ticket", 0) or 0),
                        "symbol": str(getattr(order, "symbol", "XAUUSD") or "XAUUSD"),
                        "side": side,
                        "order_kind": "LIMIT",
                        "lot": float(getattr(order, "volume_current", getattr(order, "volume_initial", 0.0)) or 0.0),
                        "price": float(getattr(order, "price_open", 0.0) or 0.0),
                        "sl": float(getattr(order, "sl", 0.0) or 0.0),
                        "tp": float(getattr(order, "tp", 0.0) or 0.0),
                        "comment": str(getattr(order, "comment", "") or ""),
                        "opened_at": int(getattr(order, "time_setup", 0) or 0),
                        "status": "open",
                    }
                )
            tick = mt5.symbol_info_tick("XAUUSD")
            spread = (
                abs(float(getattr(tick, "ask", 0.0)) - float(getattr(tick, "bid", 0.0)))
                if tick is not None
                else None
            )
            ping_last = float(getattr(terminal, "ping_last", 0.0) or 0.0) if terminal is not None else 0.0
            return {
                "status": "ok",
                "account": {
                    "balance": float(getattr(info, "balance", 0.0) or 0.0),
                    "equity": float(getattr(info, "equity", 0.0) or 0.0),
                    "latency": round(ping_last / 1000.0, 2) if ping_last > 0 else None,
                    "algo_enabled": bool(getattr(terminal, "trade_allowed", True)) and not bool(getattr(terminal, "tradeapi_disabled", False)) if terminal is not None else None,
                },
                "positions": positions,
                "orders": orders,
                "spread": spread,
            }
        except Exception as ex:
            return {"status": "error", "message": str(ex)}
    if action != "open":
        return {"status": "error", "message": f"Unsupported adapter command: {action}"}
    try:
        copy_summary: list[str | None] = [None]

        def copy_to_sub_adapters(master_request: dict[str, Any]) -> str | None:
            copy_summary[0] = _copy_to_connected_sub_adapters(master_request)
            return copy_summary[0]

        result = open_manual_position(
            str(payload.get("side", "")).upper(),
            payload.get("lot"),
            payload.get("tp"),
            payload.get("sl"),
            symbol=str(payload.get("symbol", "XAUUSD")),
            order_kind=str(payload.get("order_kind", "MARKET")).upper(),
            limit_price=payload.get("limit_price"),
            tp_in_pips=bool(payload.get("tp_in_pips")),
            sl_in_pips=bool(payload.get("sl_in_pips")),
            risk_percent=payload.get("risk_percent"),
            advanced=bool(payload.get("advanced")),
            sl_price=payload.get("sl_price"),
            spread_pips=float(payload.get("spread_pips", 0.0) or 0.0),
            ratio=float(payload.get("ratio", 3.0)),
            tp1_ratio=float(payload.get("tp1_ratio", 1.0)),
            tp2_ratio=float(payload.get("tp2_ratio", 1.0)),
            tp3_ratio=float(payload.get("tp3_ratio", 1.0)),
            tp2_enabled=bool(payload.get("tp2_enabled")),
            tp3_enabled=bool(payload.get("tp3_enabled")),
            tp1_percent=float(payload.get("tp1_percent", 100.0)),
            tp2_percent=float(payload.get("tp2_percent", 100.0)),
            auto_close_at=(
                datetime.fromisoformat(str(payload["auto_close_at"]))
                if payload.get("auto_close_at")
                else None
            ),
            copy_to_sub_accounts=False,
            after_master_order=copy_to_sub_adapters,
        )
        return {
            "status": "ok",
            "ticket": int(getattr(result, "order", 0) or getattr(result, "position", 0) or 0),
            "message": "Order sent by the connected MT5 adapter.",
            "copy_summary": copy_summary[0],
        }
    except Exception as ex:
        return {"status": "error", "message": str(ex)}


def process_pending_commands(login: int) -> None:
    command_dir = adapter_command_paths(login, "placeholder")[0].parent
    if not command_dir.exists():
        return
    for request_path in command_dir.glob("*.request.json"):
        result_path = request_path.with_name(request_path.name.replace(".request.json", ".result.json"))
        try:
            command = json.loads(request_path.read_text(encoding="utf-8"))
            result = _execute_command(command) if isinstance(command, dict) else {"status": "error", "message": "Invalid adapter command."}
        except Exception as ex:
            result = {"status": "error", "message": str(ex)}
        finally:
            request_path.unlink(missing_ok=True)
        _write_command_result(result_path, result)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--login", required=True, type=int)
    parser.add_argument("--password", required=True)
    parser.add_argument("--server", required=True)
    parser.add_argument("--terminal-path", required=True)
    parser.add_argument("--status-file", required=True)
    args = parser.parse_args()
    terminal_path = resolve_terminal_path(args.terminal_path)

    status_file = Path(args.status_file)
    write_status(
        status_file,
        {
            "state": "starting",
            "pid": os.getpid(),
            "login": args.login,
            "server": args.server,
            "terminal_path": terminal_path,
            "updated_at": int(time.time()),
        },
    )

    ok, init_detail = initialize_session(args.login, args.password, args.server, terminal_path)
    if not ok:
        write_status(
            status_file,
            {
                "state": "error",
                "pid": os.getpid(),
                "login": args.login,
                "server": args.server,
                "terminal_path": terminal_path,
                "error": init_detail,
                "updated_at": int(time.time()),
            },
        )
        return

    try:
        while True:
            # This adapter is the single owner of MT5 commands for its account.
            process_pending_commands(args.login)
            terminal = mt5.terminal_info()
            ping_last = float(getattr(terminal, "ping_last", 0.0) or 0.0) if terminal is not None else 0.0
            algo_enabled = bool(getattr(terminal, "trade_allowed", True)) and not bool(getattr(terminal, "tradeapi_disabled", False)) if terminal is not None else None
            info = mt5.account_info()
            actual_login = int(getattr(info, "login", 0) or 0) if info is not None else 0
            if info is None or actual_login != int(args.login):
                reconnected, reconnect_detail = initialize_session(args.login, args.password, args.server, terminal_path)
                if reconnected:
                    info = mt5.account_info()
                    actual_login = int(getattr(info, "login", 0) or 0) if info is not None else 0
            if info is None or actual_login != int(args.login):
                write_status(
                    status_file,
                    {
                        "state": "warning",
                        "pid": os.getpid(),
                        "login": args.login,
                        "server": args.server,
                        "terminal_path": terminal_path,
                        "latency": round(ping_last / 1000.0, 2) if ping_last > 0 else 0.0,
                        "algo_enabled": algo_enabled,
                        "error": (
                            f"Active MT5 login is {actual_login}, expected {args.login}"
                            if actual_login
                            else "No account info available"
                        ),
                        "updated_at": int(time.time()),
                    },
                )
            else:
                write_status(
                    status_file,
                    {
                        "state": "connected",
                        "pid": os.getpid(),
                        "login": int(getattr(info, "login", args.login) or args.login),
                        "server": str(getattr(info, "server", args.server) or args.server),
                        "balance": float(getattr(info, "balance", 0.0) or 0.0),
                        "equity": float(getattr(info, "equity", 0.0) or 0.0),
                        "latency": round(ping_last / 1000.0, 2) if ping_last > 0 else 0.0,
                        "algo_enabled": algo_enabled,
                        "terminal_path": terminal_path,
                        "updated_at": int(time.time()),
                    },
                )
            # Keep account status on a two-second cadence while serving chart and
            # trade commands promptly from the adapter-owned MT5 session.
            for _ in range(20):
                time.sleep(0.1)
                process_pending_commands(args.login)
    except KeyboardInterrupt:
        pass
    finally:
        mt5.shutdown()
        write_status(
            status_file,
            {
                "state": "stopped",
                "pid": os.getpid(),
                "login": args.login,
                "server": args.server,
                "terminal_path": terminal_path,
                "updated_at": int(time.time()),
            },
        )


if __name__ == "__main__":
    main()
