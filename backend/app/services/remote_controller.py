"""Controller side of remote control: this backend's connections to receivers.

These used to live in the browser (services/remoteControl.js), which made
mirroring depend on the UI: WebView2 throttles a minimized window's timers to
about once a minute, so heartbeats looked stale and connections were dropped,
and scalping orders were only noticed -- and forwarded -- whenever the UI's
throttled poll happened to run. Here they run on their own asyncio loop in a
background thread, unaffected by the window state.

Each saved receiver gets one long-lived connection task that authenticates,
relies on WebSocket protocol pings for keepalive, and reconnects with backoff.
Commands wait briefly for a reconnecting receiver and are re-sent with the
same id if the connection drops mid-command; the receiver caches results by
id, so a re-send never executes the order twice.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from concurrent.futures import Future
from datetime import datetime
from pathlib import Path
from typing import Any, Optional
from uuid import uuid4

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

from .runtime_state import append_log

ROOT_DIR = Path(__file__).resolve().parents[3]
RECEIVERS_FILE = ROOT_DIR / "controller_receivers.json"
LOG_LIMIT = 120
COMMAND_TIMEOUT_SEC = 60.0
# How long a command waits for a receiver that is reconnecting before it
# reports "not connected".
RECONNECT_WAIT_SEC = 20.0
AUTH_TIMEOUT_SEC = 15.0
CONNECT_RESULT_TIMEOUT_SEC = 20.0
PING_INTERVAL_SEC = 10.0
PING_TIMEOUT_SEC = 20.0
MAX_RECONNECT_DELAY_SEC = 15.0
POLICY_VIOLATION = 1008


class _Disconnected(Exception):
    """The connection closed while a command was waiting for its result."""


class _Receiver:
    def __init__(self, saved: dict[str, Any]) -> None:
        self.id = str(saved.get("id") or uuid4())
        self.label = str(saved.get("label") or "Receiver")
        self.url = str(saved.get("url") or "").strip()
        self.token = str(saved.get("token") or "").strip()
        self.enabled = saved.get("enabled", True) is not False
        # Reconnect after a backend restart if it was connected when it stopped.
        self.auto_connect = bool(saved.get("auto_connect", False))
        self.status: dict[str, str] = {"state": "offline", "message": "Not connected."}
        self.desired = False
        self.ws: Any = None
        self.task: Optional[asyncio.Task] = None
        self.online: Optional[asyncio.Event] = None
        self.connect_waiters: list[asyncio.Future] = []
        self.pending: dict[str, asyncio.Future] = {}

    def saved(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "url": self.url,
            "token": self.token,
            "enabled": self.enabled,
            "auto_connect": self.auto_connect,
        }

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "url": self.url,
            "token": self.token,
            "enabled": self.enabled,
            "status": dict(self.status),
        }


class RemoteController:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._receivers: dict[str, _Receiver] = {}
        self._logs: list[dict[str, Any]] = []
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None
        self._started = threading.Event()

    # ----- lifecycle -------------------------------------------------------

    def start(self) -> None:
        with self._lock:
            if self._thread is not None:
                self._started.wait(timeout=10)
                return
            for saved in self._load():
                receiver = _Receiver(saved)
                self._receivers[receiver.id] = receiver
            self._dedupe_by_url()
            self._thread = threading.Thread(target=self._run_loop, name="remote-controller", daemon=True)
            self._thread.start()
        self._started.wait(timeout=10)
        for receiver in list(self._receivers.values()):
            if receiver.enabled and receiver.auto_connect and receiver.url and receiver.token:
                self._submit(self._connect(receiver.id, wait=False))

    def _run_loop(self) -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._loop = loop
        self._started.set()
        loop.run_forever()

    def _submit(self, coro) -> Future:
        if not self._started.is_set():
            self.start()
        return asyncio.run_coroutine_threadsafe(coro, self._loop)

    async def run(self, coro_factory, *args) -> Any:
        """Await a controller coroutine from another event loop (FastAPI)."""
        return await asyncio.wrap_future(self._submit(coro_factory(*args)))

    def run_sync(self, coro_factory, *args, timeout: Optional[float] = None) -> Any:
        return self._submit(coro_factory(*args)).result(timeout=timeout)

    # ----- persistence -----------------------------------------------------

    def _load(self) -> list[dict[str, Any]]:
        try:
            data = json.loads(RECEIVERS_FILE.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return []
        except Exception as exc:
            append_log("adapter", f"[REMOTE] Could not read saved receivers: {exc}")
            return []
        return [row for row in data if isinstance(row, dict)] if isinstance(data, list) else []

    def _persist(self) -> None:
        with self._lock:
            rows = [receiver.saved() for receiver in self._receivers.values()]
        try:
            RECEIVERS_FILE.write_text(json.dumps(rows, indent=2), encoding="utf-8")
        except Exception as exc:
            append_log("adapter", f"[REMOTE] Could not save receivers: {exc}")

    def _dedupe_by_url(self) -> None:
        """A second entry for the same URL would send every command to that
        PC twice -- two real orders. Keep one entry per URL."""
        keepers: dict[str, _Receiver] = {}
        for receiver in list(self._receivers.values()):
            key = receiver.url.lower()
            if not key:
                continue
            keeper = keepers.get(key)
            if keeper is None:
                keepers[key] = receiver
                continue
            keeper.enabled = keeper.enabled or receiver.enabled
            del self._receivers[receiver.id]

    # ----- logs ------------------------------------------------------------

    def _log(self, level: str, message: str, receiver: Optional[_Receiver] = None) -> None:
        entry = {
            "id": str(uuid4()),
            "level": level,
            "receiver": receiver.label if receiver else None,
            "message": message,
            "at": datetime.now().strftime("%H:%M:%S"),
            "atMs": int(time.time() * 1000),
        }
        with self._lock:
            self._logs.append(entry)
            if len(self._logs) > LOG_LIMIT:
                del self._logs[:-LOG_LIMIT]

    def clear_logs(self) -> None:
        with self._lock:
            self._logs.clear()

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "receivers": [receiver.public() for receiver in self._receivers.values()],
                "logs": [dict(entry) for entry in self._logs],
            }

    def has_enabled_receivers(self) -> bool:
        with self._lock:
            return any(receiver.enabled for receiver in self._receivers.values())

    # ----- receiver management (run on the controller loop) ----------------

    async def save_receiver(self, payload: dict[str, Any]) -> str:
        url = str(payload.get("url") or "").strip()
        token = str(payload.get("token") or "").strip()
        receiver_id = payload.get("id") or None
        with self._lock:
            if not receiver_id:
                receiver_id = next(
                    (r.id for r in self._receivers.values() if url and r.url.lower() == url.lower()),
                    None,
                )
            receiver = self._receivers.get(receiver_id) if receiver_id else None
            if receiver is None:
                receiver = _Receiver({"id": receiver_id})
                self._receivers[receiver.id] = receiver
            receiver.label = str(payload.get("label") or "").strip() or receiver.label or "Receiver"
            receiver.url = url
            receiver.token = token
            receiver.enabled = payload.get("enabled", True) is not False
        self._persist()
        return receiver.id

    async def remove_receiver(self, receiver_id: str) -> None:
        receiver = self._receivers.get(receiver_id)
        if receiver is None:
            return
        await self._teardown(receiver, "Receiver removed.", silent=True)
        with self._lock:
            self._receivers.pop(receiver_id, None)
        self._persist()

    async def set_enabled(self, receiver_id: str, enabled: bool) -> None:
        receiver = self._receivers.get(receiver_id)
        if receiver is None:
            return
        receiver.enabled = bool(enabled)
        if not receiver.enabled and receiver.desired:
            await self._teardown(receiver, "Disconnected from the receiver.")
        self._persist()

    async def connect_receiver(self, receiver_id: str) -> dict[str, Any]:
        return await self._connect(receiver_id, wait=True)

    async def disconnect_receiver(self, receiver_id: str) -> None:
        receiver = self._receivers.get(receiver_id)
        if receiver is not None:
            await self._teardown(receiver, "Disconnected from the receiver.")

    async def _connect(self, receiver_id: str, wait: bool) -> dict[str, Any]:
        receiver = self._receivers.get(receiver_id)
        if receiver is None:
            raise RuntimeError("Unknown receiver.")
        if not receiver.url or not receiver.token:
            self._log("error", "Connection blocked: URL and token are required.", receiver)
            raise RuntimeError("Enter the receiver WebSocket URL and token.")
        if receiver.online is None:
            receiver.online = asyncio.Event()
        receiver.desired = True
        if not receiver.auto_connect:
            receiver.auto_connect = True
            self._persist()
        if receiver.task is None or receiver.task.done():
            receiver.task = asyncio.create_task(self._connection_loop(receiver))
        elif receiver.ws is not None:
            return receiver.public()
        if not wait:
            return receiver.public()
        waiter = asyncio.get_running_loop().create_future()
        receiver.connect_waiters.append(waiter)
        try:
            message = await asyncio.wait_for(waiter, CONNECT_RESULT_TIMEOUT_SEC)
        except asyncio.TimeoutError:
            raise RuntimeError("The receiver did not answer in time; still retrying in the background.")
        finally:
            if waiter in receiver.connect_waiters:
                receiver.connect_waiters.remove(waiter)
        if message:
            raise RuntimeError(message)
        return receiver.public()

    def _settle_connect_waiters(self, receiver: _Receiver, error: Optional[str]) -> None:
        for waiter in receiver.connect_waiters:
            if not waiter.done():
                waiter.set_result(error)
        receiver.connect_waiters.clear()

    def _fail_pending(self, receiver: _Receiver) -> None:
        for future in receiver.pending.values():
            if not future.done():
                future.set_exception(_Disconnected())

    async def _teardown(self, receiver: _Receiver, message: str, silent: bool = False) -> None:
        receiver.desired = False
        if receiver.auto_connect:
            receiver.auto_connect = False
            self._persist()
        task = receiver.task
        receiver.task = None
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except BaseException:
                pass
        ws = receiver.ws
        receiver.ws = None
        if ws is not None:
            try:
                await ws.close(1000, message)
            except Exception:
                pass
        if receiver.online is not None:
            receiver.online.clear()
        self._fail_pending(receiver)
        self._settle_connect_waiters(receiver, message)
        if not silent:
            self._log("info", message, receiver)
        receiver.status = {"state": "offline", "message": message}

    async def _connection_loop(self, receiver: _Receiver) -> None:
        attempt = 0
        while receiver.desired:
            receiver.status = {"state": "connecting", "message": "Authenticating with the trading PC..."}
            authenticated = False
            close_code: Optional[int] = None
            close_reason = ""
            ws = None
            try:
                async with connect(
                    receiver.url,
                    open_timeout=AUTH_TIMEOUT_SEC,
                    ping_interval=PING_INTERVAL_SEC,
                    ping_timeout=PING_TIMEOUT_SEC,
                    close_timeout=5,
                    max_size=None,
                    proxy=None,
                ) as ws:
                    await ws.send(json.dumps({"type": "authenticate", "token": receiver.token}))
                    first = json.loads(await asyncio.wait_for(ws.recv(), AUTH_TIMEOUT_SEC))
                    if not isinstance(first, dict) or first.get("type") != "connection":
                        raise RuntimeError("Unexpected response from the receiver.")
                    authenticated = True
                    attempt = 0
                    receiver.ws = ws
                    receiver.online.set()
                    message = str(first.get("message") or "Connected and authenticated.")
                    receiver.status = {"state": "online", "message": message}
                    self._log("success", message, receiver)
                    self._settle_connect_waiters(receiver, None)
                    async for raw in ws:
                        self._handle_message(receiver, raw)
            except asyncio.CancelledError:
                raise
            except TimeoutError:
                close_reason = "Timed out waiting for the receiver to answer."
            except ConnectionClosed as exc:
                frame = exc.rcvd
                close_code = frame.code if frame is not None else None
                close_reason = frame.reason if frame is not None else ""
            except Exception as exc:
                close_reason = str(exc) or exc.__class__.__name__
            finally:
                receiver.ws = None
                if receiver.online is not None:
                    receiver.online.clear()
                self._fail_pending(receiver)
            if ws is not None and close_code is None:
                close_code = ws.close_code
                close_reason = close_reason or (ws.close_reason or "")
            if not receiver.desired:
                return
            reason = close_reason or "Connection closed. Check the token or network if this was unexpected."
            label = "Remote session ended" if authenticated else ("Authentication failed" if close_code == POLICY_VIOLATION else "Receiver unreachable")
            self._log("warning" if authenticated else "error", f"{label}: {reason}", receiver)
            if close_code == POLICY_VIOLATION:
                # Wrong token or receiver mode disabled: retrying cannot help.
                receiver.desired = False
                receiver.auto_connect = False
                self._persist()
                receiver.status = {"state": "offline", "message": reason}
                self._settle_connect_waiters(receiver, reason)
                receiver.task = None
                return
            self._settle_connect_waiters(receiver, None if authenticated else reason)
            delay = min(MAX_RECONNECT_DELAY_SEC, 1.5 * (2 ** attempt))
            attempt += 1
            self._log("warning", f"Connection lost. Reconnecting in {round(delay)}s...", receiver)
            receiver.status = {"state": "connecting", "message": "Connection lost. Reconnecting automatically..."}
            await asyncio.sleep(delay)

    def _handle_message(self, receiver: _Receiver, raw: Any) -> None:
        try:
            message = json.loads(raw)
        except Exception:
            self._log("warning", "Ignored an invalid response from the receiver.", receiver)
            return
        if not isinstance(message, dict) or message.get("type") in {"pong", "log"}:
            # "log" is per-step narration (risk %, order-delay countdown);
            # the result is what matters.
            return
        future = receiver.pending.get(str(message.get("id") or ""))
        if future is not None and not future.done():
            future.set_result(message)

    # ----- commands --------------------------------------------------------

    async def send_command(
        self,
        action: str,
        data: dict[str, Any],
        receiver_ids: Optional[list[str]] = None,
    ) -> dict[str, Any]:
        """Send to every enabled receiver (or the given ids). Never raises:
        returns one outcome per receiver so one offline PC can't block the rest."""
        with self._lock:
            targets = [
                receiver for receiver in self._receivers.values()
                if receiver.enabled and (receiver_ids is None or receiver.id in receiver_ids)
            ]
        if not targets:
            return {"sent": 0, "results": []}
        results = await asyncio.gather(*(self._send_to(receiver, action, data) for receiver in targets))
        return {"sent": len(results), "results": list(results)}

    async def _send_to(self, receiver: _Receiver, action: str, data: dict[str, Any]) -> dict[str, Any]:
        command_id = str(uuid4())
        loop = asyncio.get_running_loop()
        deadline = loop.time() + COMMAND_TIMEOUT_SEC

        def outcome(status: str, message: Any) -> dict[str, Any]:
            return {"id": receiver.id, "label": receiver.label, "status": status, "message": message}

        sent_once = False
        while True:
            if not receiver.desired or receiver.online is None:
                return outcome("error", "Remote receiver is not connected.")
            if receiver.ws is None:
                wait = min(RECONNECT_WAIT_SEC, deadline - loop.time())
                try:
                    await asyncio.wait_for(receiver.online.wait(), max(0.0, wait))
                except asyncio.TimeoutError:
                    message = (
                        "Connection dropped before the receiver confirmed the command; it did not reconnect in time."
                        if sent_once
                        else f"Remote receiver is not connected (still reconnecting after {wait:.0f}s)."
                    )
                    self._log("error", f"Command {action} ({command_id}) failed: {message}", receiver)
                    return outcome("error", message)
            ws = receiver.ws
            if ws is None:
                continue
            future = loop.create_future()
            receiver.pending[command_id] = future
            try:
                if not sent_once:
                    self._log("info", f"Sending command {action} ({command_id}).", receiver)
                else:
                    self._log("warning", f"Re-sending {action} ({command_id}) after reconnect; the receiver will not run it twice.", receiver)
                await ws.send(json.dumps({"id": command_id, "action": action, "data": data}))
                sent_once = True
                message = await asyncio.wait_for(future, max(0.0, deadline - loop.time()))
            except (_Disconnected, ConnectionClosed):
                continue
            except asyncio.TimeoutError:
                text = f"The remote receiver did not answer within {COMMAND_TIMEOUT_SEC:.0f} seconds."
                self._log("error", f"Command {action} ({command_id}) timed out after {COMMAND_TIMEOUT_SEC:.0f}s.", receiver)
                return outcome("error", text)
            finally:
                receiver.pending.pop(command_id, None)
            if message.get("status") == "success":
                result = message.get("result") or {}
                adapter_result = result.get("adapter_result") or {} if isinstance(result, dict) else {}
                summary = " — ".join(
                    str(part) for part in (
                        result.get("message") or adapter_result.get("message"),
                        result.get("copy_summary") or adapter_result.get("copy_summary"),
                    ) if part
                ) or f"Command {command_id} completed successfully."
                self._log("success", summary, receiver)
                return outcome("success", message)
            error = str(message.get("message") or "Remote command failed.")
            self._log("error", f"Command {command_id} failed: {error}", receiver)
            return outcome("error", error)

    def submit_command(self, action: str, data: dict[str, Any]) -> Future:
        """Start send_command from any thread; the Future yields its outcome."""
        return self._submit(self.send_command(action, data))

    def broadcast_in_background(self, action: str, data: dict[str, Any], describe: str, log_prefix: str) -> None:
        """Fire-and-forget for backend-originated commands (scalping entries,
        session-risk stops). The outcome is written to the search log, which
        the UI shows, since no browser request is waiting on it."""
        if not self.has_enabled_receivers():
            return

        async def run() -> None:
            outcome = await self.send_command(action, data)
            failed = [item for item in outcome["results"] if item["status"] == "error"]
            ok = len(outcome["results"]) - len(failed)
            if failed:
                details = "; ".join(f"{item['label']} ({item['message']})" for item in failed)
                append_log("search", f"[ERROR] {log_prefix} {describe}: {len(failed)} receiver(s) failed: {details}")
            if ok:
                append_log("search", f"[SUCCESS] {log_prefix} {describe}: sent to {ok} receiver(s).")

        self._submit(run())


remote_controller = RemoteController()
