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
    return {
        "enabled": bool(remote_control.get("enabled", False)) or env_enabled,
        "token": str(remote_control.get("token", "") or os.environ.get("TRADER_REMOTE_TOKEN", "")).strip(),
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


def start_backend_if_needed() -> subprocess.Popen[str] | None:
    if _http_ready(BACKEND_HEALTH_URL):
        return None
    remote_control = _load_remote_control_settings()
    backend_bind_host = "0.0.0.0" if remote_control["enabled"] else "127.0.0.1"
    env = os.environ.copy()
    env.setdefault("PYTHONUNBUFFERED", "1")
    return subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "backend.app.main:app",
            "--host",
            backend_bind_host,
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
