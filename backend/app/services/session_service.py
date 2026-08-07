from __future__ import annotations

import json
import time
from pathlib import Path
import subprocess
import sys
from typing import Any

from .runtime_state import append_log

ROOT_DIR = Path(__file__).resolve().parents[3]
# Connection status is runtime state, not application source/log history.
STATUS_DIR = ROOT_DIR / ".runtime" / "mt5_sessions"
WORKER_SCRIPT = ROOT_DIR / "mt5_adapter_worker.py"

_adapter_processes: dict[int, subprocess.Popen] = {}
_STATUS_HEARTBEAT_SEC = 8


def _safe_int(value: Any) -> int:
    try:
        return int(value)
    except Exception:
        return 0


def _status_path(login: int) -> Path:
    return STATUS_DIR / f"{int(login)}.json"


def _write_status(login: int, payload: dict[str, Any]) -> None:
    STATUS_DIR.mkdir(parents=True, exist_ok=True)
    data = dict(payload)
    data["login"] = int(login)
    data.setdefault("updated_at", int(time.time()))
    _status_path(login).write_text(json.dumps(data, indent=2), encoding="utf-8")


def _normalize_terminal_path(path_value: str) -> str:
    # Users often paste quoted Windows paths; strip wrapping quotes safely.
    path = str(path_value or "").strip()
    if len(path) >= 2 and path[0] == path[-1] and path[0] in {'"', "'"}:
        path = path[1:-1].strip()
    return path


def _launch_terminal(terminal_path: str) -> tuple[bool, str]:
    path = Path(terminal_path)
    if not path.exists():
        return False, f"Terminal executable not found: {terminal_path}"
    try:
        # Visible launch on purpose: user explicitly clicked Launch.
        subprocess.Popen([str(path)])
        return True, "Terminal launched."
    except Exception as ex:
        return False, f"Failed to launch terminal: {ex}"


def _read_status(login: int) -> dict[str, Any]:
    path = _status_path(login)
    if not path.exists():
        return {"state": "disconnected", "login": login}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(payload, dict):
            return payload
    except Exception:
        pass
    return {"state": "warning", "login": login, "error": "Invalid status file"}


def _proc_alive(login: int) -> bool:
    proc = _adapter_processes.get(login)
    return proc is not None and proc.poll() is None


def _is_status_fresh(status: dict[str, Any]) -> bool:
    try:
        updated_at = float(status.get("updated_at", 0) or 0)
    except Exception:
        return False
    if updated_at <= 0:
        return False
    return (time.time() - updated_at) <= _STATUS_HEARTBEAT_SEC


def _has_active_adapter(login: int) -> bool:
    # Active if we launched it in this API process, or if status heartbeat is fresh.
    if _proc_alive(login):
        return True
    status = _read_status(login)
    return str(status.get("state", "")).lower() in {"connected", "warning", "starting"} and _is_status_fresh(status)


def list_sessions(accounts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    sessions: list[dict[str, Any]] = []
    by_login = {_safe_int(a.get("user")): a for a in accounts}
    for login, account in by_login.items():
        status = _read_status(login)
        state = str(status.get("state", "disconnected"))
        alive = _has_active_adapter(login)
        if state == "connected" and not alive:
            state = "disconnected"
        if state in {"starting", "warning"} and alive:
            # Keep UI optimistic while adapter is live and refreshing.
            # Some MT5 sessions briefly return warning/None account_info during warmup.
            state = "connected"
        sessions.append(
            {
                "login": login,
                "name": str(account.get("username", "")),
                "server": str(account.get("server", "")),
                "state": state,
                "alive": alive,
                "balance": float(status.get("balance", 0.0) or 0.0),
                "equity": float(status.get("equity", 0.0) or 0.0),
                "latency": float(status.get("latency", 0.0) or 0.0),
                "algo_enabled": status.get("algo_enabled"),
                "error": status.get("error"),
                "updated_at": status.get("updated_at"),
            }
        )
    return sorted(sessions, key=lambda x: x.get("login", 0))


def resolve_master_login(config: dict[str, Any]) -> int | None:
    master_login = _safe_int(config.get("master_account_login"))
    if master_login > 0:
        return master_login
    for account in config.get("trading_accounts", []):
        if str(account.get("role", "sub")).lower() == "master":
            login = _safe_int(account.get("user"))
            if login > 0:
                return login
    return None


def master_adapter_ready(config: dict[str, Any]) -> tuple[bool, str, int | None]:
    master_login = resolve_master_login(config)
    if not master_login:
        return False, "No master account configured.", None

    sessions = list_sessions(config.get("trading_accounts", []))
    target = next((s for s in sessions if int(s.get("login", 0) or 0) == master_login), None)
    if target is None:
        return False, f"Master account {master_login} not found in sessions.", master_login

    state = str(target.get("state", "disconnected")).lower()
    alive = bool(target.get("alive"))
    # Treat live warning/starting states as ready to avoid false negatives while
    # MT5 heartbeat is still stabilizing.
    if state in {"warning", "starting"} and alive:
        state = "connected"
    if state != "connected":
        return False, f"Master adapter {master_login} is not connected (state={state}).", master_login
    return True, "ok", master_login


def connect_account(account: dict[str, Any]) -> dict[str, Any]:
    login = _safe_int(account.get("user"))
    if login <= 0:
        return {"status": "error", "message": "Invalid account login"}
    terminal_path = _normalize_terminal_path(str(account.get("terminal_path", "") or ""))
    if not terminal_path:
        return {"status": "error", "message": "Missing terminal path"}

    if _has_active_adapter(login):
        append_log("adapter", f"[INFO] Adapter already active for account {login}.")
        return {"status": "ok", "message": f"Adapter already active for {login}"}

    STATUS_DIR.mkdir(parents=True, exist_ok=True)
    _write_status(
        login,
        {
            "state": "starting",
            "server": str(account.get("server", "") or ""),
            "terminal_path": terminal_path,
        },
    )
    launched, launch_message = _launch_terminal(terminal_path)
    if not launched:
        append_log("adapter", f"[ERROR] {launch_message}")
        _write_status(
            login,
            {
                "state": "error",
                "server": str(account.get("server", "") or ""),
                "terminal_path": terminal_path,
                "error": launch_message,
            },
        )
        return {"status": "error", "message": launch_message}

    creation_flags = 0
    if sys.platform.startswith("win"):
        creation_flags = subprocess.CREATE_NO_WINDOW

    _adapter_processes[login] = subprocess.Popen(
        [
            sys.executable,
            str(WORKER_SCRIPT),
            "--login",
            str(login),
            "--password",
            str(account.get("password", "")),
            "--server",
            str(account.get("server", "")),
            "--terminal-path",
            terminal_path,
            "--status-file",
            str(_status_path(login)),
        ],
        creationflags=creation_flags,
    )
    append_log("adapter", f"[INFO] {launch_message} Started MT5 adapter for account {login}.")
    return {"status": "ok", "message": f"{launch_message} Started adapter for account {login}"}


def disconnect_account(login: int) -> dict[str, Any]:
    login = _safe_int(login)
    proc = _adapter_processes.get(login)
    if proc is not None:
        try:
            if proc.poll() is None:
                proc.terminate()
        except Exception:
            pass
    _adapter_processes.pop(login, None)
    _write_status(
        login,
        {
            "state": "stopped",
            "error": None,
            "updated_at": int(time.time()),
        },
    )
    append_log("adapter", f"[WARNING] Adapter stopped for account {login}.")
    return {"status": "ok", "message": f"Stopped adapter for {login}"}


def disconnect_all() -> None:
    for login in list(_adapter_processes.keys()):
        disconnect_account(login)
