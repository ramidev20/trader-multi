from __future__ import annotations

import atexit
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

try:
    import webview
except ModuleNotFoundError as exc:
    if exc.name == "webview":
        raise SystemExit(
            "pywebview is not installed for this Python interpreter. Run: "
            "python -m pip install -r requirements.txt"
        ) from exc
    raise

from backend.app.services.env_utils import load_project_env

load_project_env()

ROOT_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = ROOT_DIR / "frontend"
CONFIG_FILE = ROOT_DIR / "config.json"
BACKEND_HEALTH_URL = "http://127.0.0.1:8000/health"
FRONTEND_DEV_URL = "http://127.0.0.1:5173/"
FRONTEND_VITE_BIN = FRONTEND_DIR / "node_modules" / ".bin" / "vite.cmd"
FRONTEND_VITE_PACKAGE = FRONTEND_DIR / "node_modules" / "vite" / "package.json"


def _load_remote_control_settings() -> dict[str, object]:
    try:
        config = json.loads(CONFIG_FILE.read_text(encoding="utf-8")) if CONFIG_FILE.exists() else {}
    except Exception:
        config = {}
    remote_control = config.get("remote_control", {}) if isinstance(config, dict) else {}
    if not isinstance(remote_control, dict):
        remote_control = {}
    env_enabled = str(os.environ.get("TRADER_REMOTE_ENABLED", "")).lower() in {"1", "true", "yes", "on"}
    receiver_url = str(remote_control.get("receiver_url", "") or "").strip()
    return {
        "enabled": bool(remote_control.get("enabled", False)) or env_enabled,
        "token": str(remote_control.get("token", "") or os.environ.get("TRADER_REMOTE_TOKEN", "")).strip(),
        "receiver_url": receiver_url,
    }


def _find_npm() -> str:
    npm = shutil.which("npm.cmd") or shutil.which("npm")
    if not npm:
        raise RuntimeError("npm was not found in PATH. Install Node.js 18+ and try again.")
    return npm


def ensure_frontend_dependencies(npm: str) -> None:
    if FRONTEND_VITE_BIN.exists() and FRONTEND_VITE_PACKAGE.exists():
        return
    subprocess.run([npm, "install"], cwd=FRONTEND_DIR, env=os.environ.copy(), check=True)


def _http_ready(url: str) -> bool:
    try:
        with urlopen(url, timeout=2) as response:
            return 200 <= int(getattr(response, "status", 0) or 0) < 500
    except (URLError, OSError):
        return False


def _find_listening_pids(port: int) -> list[int]:
    """PIDs of processes with a LISTENING socket on `port` (Windows netstat).

    `netstat` writes in the console's OEM codepage, which doesn't always match
    Python's default text encoding (varies by machine/locale) -- decode with
    `errors="replace"` so an unmappable byte can't crash this instead of just
    garbling a column we don't even read.
    """
    try:
        result = subprocess.run(
            ["netstat", "-ano"], capture_output=True, text=True, errors="replace", timeout=5
        )
    except Exception:
        return []
    output = result.stdout or ""
    pids: set[int] = set()
    needle = f":{port}"
    for line in output.splitlines():
        parts = line.split()
        if len(parts) < 5 or parts[0].upper() != "TCP":
            continue
        local_address, state, pid_text = parts[1], parts[3], parts[-1]
        if state.upper() != "LISTENING" or not local_address.endswith(needle):
            continue
        try:
            pids.add(int(pid_text))
        except ValueError:
            continue
    return sorted(pids)


def _kill_process_tree(pid: int) -> None:
    try:
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, timeout=10)
    except Exception:
        pass


def stop_existing_backend() -> None:
    """Force-kill any backend already bound to the API port before starting a fresh one.

    Reusing an already-running backend meant code changes never took effect until
    someone remembered to hard-kill it manually -- and MT5 adapter subprocesses
    (spawned as children of the backend) kept running stale code indefinitely,
    surviving even repeated `run.py` launches. `/T` kills the whole process tree,
    so adapter children go down with the backend that spawned them.
    """
    pids = _find_listening_pids(8000)
    for pid in pids:
        _kill_process_tree(pid)
    if not pids:
        return
    deadline = time.time() + 10
    while time.time() < deadline and _http_ready(BACKEND_HEALTH_URL):
        time.sleep(0.3)


def start_backend_if_needed() -> subprocess.Popen[str] | None:
    stop_existing_backend()
    env = os.environ.copy()
    env.setdefault("PYTHONUNBUFFERED", "1")
    return subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "backend.app.main:app",
            "--host",
            "0.0.0.0",
            "--port",
            "8000",
            # Frequent UI polling (chart data, remote-control status, etc.) would
            # otherwise print a request line to the console roughly every second.
            "--no-access-log",
        ],
        cwd=ROOT_DIR,
        env=env,
    )


def start_frontend_if_needed() -> subprocess.Popen[str] | None:
    if _http_ready(FRONTEND_DEV_URL):
        return None
    npm = _find_npm()
    ensure_frontend_dependencies(npm)
    return subprocess.Popen(
        [npm, "run", "dev", "--", "--host", "127.0.0.1", "--port", "5173"],
        cwd=FRONTEND_DIR,
        env=os.environ.copy(),
    )


def wait_for_service(url: str, label: str, timeout_sec: int = 30) -> None:
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        if _http_ready(url):
            return
        time.sleep(0.5)
    raise RuntimeError(f"{label} did not become ready at {url}.")


def stop_process(process: subprocess.Popen[str] | None) -> None:
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()


def main() -> int:
    remote_control = _load_remote_control_settings()
    if remote_control["enabled"] and not remote_control["token"]:
        raise RuntimeError("Set a receiver token on the Remote Control page before enabling remote control.")
    backend_process = start_backend_if_needed()
    frontend_process = start_frontend_if_needed()
    atexit.register(stop_process, frontend_process)
    atexit.register(stop_process, backend_process)
    wait_for_service(BACKEND_HEALTH_URL, "Backend")
    wait_for_service(FRONTEND_DEV_URL, "Vite frontend")

    window = webview.create_window(
        "Lequidity Trader",
        FRONTEND_DEV_URL,
        width=1440,
        height=960,
        min_size=(1100, 760),
    )
    window.events.closed += lambda: (stop_process(frontend_process), stop_process(backend_process))
    webview.start()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
