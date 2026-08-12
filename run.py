from __future__ import annotations

import atexit
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
BACKEND_HEALTH_URL = "http://127.0.0.1:8000/health"
FRONTEND_DEV_URL = "http://127.0.0.1:5173/"
REMOTE_ENABLED = str(os.environ.get("TRADER_REMOTE_ENABLED", "")).lower() in {"1", "true", "yes", "on"}
BACKEND_BIND_HOST = "0.0.0.0" if REMOTE_ENABLED else "127.0.0.1"


def _find_npm() -> str:
    npm = shutil.which("npm") or shutil.which("npm.cmd")
    if not npm:
        raise RuntimeError("npm was not found in PATH. Install Node.js 18+ and try again.")
    return npm


def _http_ready(url: str) -> bool:
    try:
        with urlopen(url, timeout=2) as response:
            return 200 <= int(getattr(response, "status", 0) or 0) < 500
    except (URLError, OSError):
        return False


def start_backend_if_needed() -> subprocess.Popen[str] | None:
    if _http_ready(BACKEND_HEALTH_URL):
        return None
    env = os.environ.copy()
    env.setdefault("PYTHONUNBUFFERED", "1")
    return subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "backend.app.main:app",
            "--host",
            BACKEND_BIND_HOST,
            "--port",
            "8000",
        ],
        cwd=ROOT_DIR,
        env=env,
    )


def start_frontend_if_needed() -> subprocess.Popen[str] | None:
    if _http_ready(FRONTEND_DEV_URL):
        return None
    npm = _find_npm()
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
    if REMOTE_ENABLED and not str(os.environ.get("TRADER_REMOTE_TOKEN", "")).strip():
        raise RuntimeError("Set TRADER_REMOTE_TOKEN in .env before enabling remote control.")
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
