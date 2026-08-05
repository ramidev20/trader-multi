from __future__ import annotations

from datetime import datetime
from typing import Any

from .runtime_state import append_log, get, patch_path
from .strategy_service import account_management, manager as strategy_manager, running_tasks, stop_strategy_system
from .task_manager import is_task_running, start_task, stop_task


def _strategy_running() -> bool:
    tasks = running_tasks()
    return tasks["search_global"] or tasks["search_leq"] or tasks["pos_search"]


def _monitor_tick(risk_percent: float, profit_percent: float, start_balance: float):
    if not _strategy_running():
        reason = strategy_manager.last_stop_reason
        if reason:
            append_log("risk", f"[WARNING] {reason}")
        stop_task("account_management")
        patch_path("risk_monitor", {"running": False})
        return

    status, text_status, text = account_management(profit_percent, risk_percent, start_balance)
    append_log("risk", f"[{text_status.upper()}] {text}")

    if not status:
        stop_task("account_management")
        stop_strategy_system()
        patch_path("risk_monitor", {"running": False})
        append_log("risk", "[WARNING] Strategy stopped due to account risk/profit rule.")


def start_risk_monitor(
    *,
    risk_percent: float,
    profit_percent: float,
    orders_limit: int,
    interval_sec: int,
) -> dict[str, Any]:
    if not _strategy_running():
        return {"status": "error", "message": "Please start strategy first."}
    if orders_limit <= 0:
        return {"status": "error", "message": "Orders Limit must be at least 1."}

    strategy_manager.set_orders_limit(orders_limit)

    # Prefer MT5 equity when available; fallback to aggregated configured equity.
    start_balance = 0.0
    settings = get("bootstrap_cache.settings", {})
    for acc in settings.get("trading_accounts", []):
        start_balance += float(acc.get("equity", acc.get("balance", 0)) or 0)
    if start_balance <= 0:
        start_balance = 10000.0

    strategy_task_start = datetime.now()
    start_task(
        "account_management",
        _monitor_tick,
        float(risk_percent),
        float(profit_percent),
        float(start_balance),
        start_time=strategy_task_start,
        interval_sec=max(1, int(interval_sec or 60)),
    )
    patch_path(
        "risk_monitor",
        {
            "running": True,
            "started_at": datetime.now().isoformat(),
            "interval_sec": int(interval_sec),
            "risk_percent": float(risk_percent),
            "profit_percent": float(profit_percent),
            "orders_limit": int(orders_limit),
            "start_balance": float(start_balance),
        },
    )
    append_log("risk", "[INFO] Risk monitor started.")
    return {"status": "ok"}


def stop_risk_monitor() -> dict[str, Any]:
    if is_task_running("account_management"):
        stop_task("account_management")
    patch_path("risk_monitor", {"running": False})
    append_log("risk", "[WARNING] Risk monitor stopped.")
    return {"status": "ok"}
