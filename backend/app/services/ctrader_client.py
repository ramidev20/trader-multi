"""Low-level cTrader Open API connection.

One TLS socket to the Open API proxy carrying length-prefixed protobuf
frames. A reader thread decodes every frame, hands replies to the request
that is waiting on them (matched by clientMsgId) and passes everything --
replies and unsolicited events alike -- to the registered event handler, so
the account cache in ctrader_compat sees its own fills too.

No cTrader terminal is involved: this talks to the broker's servers directly.
"""

from __future__ import annotations

import queue
import socket
import ssl
import struct
import threading
import time
from itertools import count
from typing import Any, Callable

from google.protobuf.message import Message

from .ctrader_proto import OpenApiCommonMessages_pb2 as common_messages
from .ctrader_proto import OpenApiCommonModelMessages_pb2 as common_model
from .ctrader_proto import OpenApiMessages_pb2 as messages
from .ctrader_proto import OpenApiModelMessages_pb2 as model

HOSTS = {
    "demo": "demo.ctraderapi.com",
    "live": "live.ctraderapi.com",
}
PORT = 5035
HEARTBEAT_EVENT = int(common_model.HEARTBEAT_EVENT)
ERROR_RES = int(common_model.ERROR_RES)
OA_ERROR_RES = int(model.PROTO_OA_ERROR_RES)
ORDER_ERROR_EVENT = int(model.PROTO_OA_ORDER_ERROR_EVENT)


def _build_payload_registry() -> dict[int, type[Message]]:
    """payloadType -> message class, read from each message's default
    payloadType so the table can never drift from the vendored .proto files."""
    registry: dict[int, type[Message]] = {}
    for module in (messages, common_messages):
        for name in dir(module):
            cls = getattr(module, name)
            if not isinstance(cls, type) or not issubclass(cls, Message):
                continue
            field = cls.DESCRIPTOR.fields_by_name.get("payloadType")
            if field is None or not field.has_default_value:
                continue
            registry[int(field.default_value)] = cls
    return registry


PAYLOAD_CLASSES = _build_payload_registry()


def payload_type_of(message: Message) -> int:
    return int(message.DESCRIPTOR.fields_by_name["payloadType"].default_value)


class CTraderError(RuntimeError):
    def __init__(self, code: str, description: str = "") -> None:
        self.code = str(code or "UNKNOWN_ERROR")
        self.description = str(description or "")
        super().__init__(f"{self.code}: {self.description}" if self.description else self.code)


class _Pending:
    __slots__ = ("replies",)

    def __init__(self) -> None:
        self.replies: queue.Queue[tuple[int, Message]] = queue.Queue()


class CTraderConnection:
    """Thread-safe request/response client for one Open API connection."""

    HEARTBEAT_INTERVAL_SEC = 10.0

    def __init__(self, host: str, on_event: Callable[[int, Message, str], None] | None = None) -> None:
        self.host = host
        self._on_event = on_event
        self._sock: ssl.SSLSocket | None = None
        self._send_lock = threading.Lock()
        self._pending: dict[str, _Pending] = {}
        self._pending_lock = threading.Lock()
        self._ids = count(1)
        self._closed = threading.Event()
        self._reader: threading.Thread | None = None
        self._heartbeat: threading.Thread | None = None
        self.last_received = 0.0
        self.disconnect_reason = ""

    # -- lifecycle -------------------------------------------------------

    def connect(self, timeout: float = 10.0) -> None:
        raw = socket.create_connection((self.host, PORT), timeout=timeout)
        raw.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        context = ssl.create_default_context()
        sock = context.wrap_socket(raw, server_hostname=self.host)
        sock.settimeout(None)
        self._sock = sock
        self._closed.clear()
        self.last_received = time.monotonic()
        self._reader = threading.Thread(target=self._read_loop, name=f"ctrader-reader-{self.host}", daemon=True)
        self._reader.start()
        self._heartbeat = threading.Thread(target=self._heartbeat_loop, name="ctrader-heartbeat", daemon=True)
        self._heartbeat.start()

    def close(self, reason: str = "closed by client") -> None:
        if self._closed.is_set():
            return
        self.disconnect_reason = self.disconnect_reason or reason
        self._closed.set()
        sock, self._sock = self._sock, None
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                sock.close()
            except OSError:
                pass
        # Wake every waiter so nothing blocks for its full timeout on a dead socket.
        with self._pending_lock:
            waiters = list(self._pending.values())
        for pending in waiters:
            pending.replies.put((ERROR_RES, common_messages.ProtoErrorRes(errorCode="CONNECTION_CLOSED", description=self.disconnect_reason)))

    @property
    def connected(self) -> bool:
        return self._sock is not None and not self._closed.is_set()

    # -- sending ---------------------------------------------------------

    def _send_frame(self, payload_type: int, payload: bytes, client_msg_id: str | None) -> None:
        envelope = common_messages.ProtoMessage(payloadType=payload_type, payload=payload)
        if client_msg_id:
            envelope.clientMsgId = client_msg_id
        data = envelope.SerializeToString()
        sock = self._sock
        if sock is None or self._closed.is_set():
            raise CTraderError("CONNECTION_CLOSED", self.disconnect_reason or "not connected")
        with self._send_lock:
            try:
                sock.sendall(struct.pack(">I", len(data)) + data)
            except OSError as ex:
                self.close(f"send failed: {ex}")
                raise CTraderError("CONNECTION_CLOSED", str(ex)) from ex

    def send(self, message: Message, client_msg_id: str | None = None) -> None:
        self._send_frame(payload_type_of(message), message.SerializeToString(), client_msg_id)

    def request(
        self,
        message: Message,
        timeout: float = 15.0,
        done: Callable[[int, Message], bool] | None = None,
    ) -> list[tuple[int, Message]]:
        """Send `message` and collect the replies carrying its clientMsgId.

        Without `done` the first reply finishes the request. With it, replies
        keep collecting until `done(payload_type, reply)` is true -- a market
        order answers ORDER_ACCEPTED first and ORDER_FILLED after. Error
        replies always finish it and raise CTraderError.
        """
        client_msg_id = f"m{next(self._ids)}"
        pending = _Pending()
        with self._pending_lock:
            self._pending[client_msg_id] = pending
        replies: list[tuple[int, Message]] = []
        try:
            self.send(message, client_msg_id)
            deadline = time.monotonic() + timeout
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise CTraderError("TIMEOUT", f"no reply to {type(message).__name__} within {timeout:.0f}s")
                try:
                    payload_type, reply = pending.replies.get(timeout=remaining)
                except queue.Empty:
                    continue
                if payload_type in {ERROR_RES, OA_ERROR_RES, ORDER_ERROR_EVENT}:
                    raise CTraderError(
                        getattr(reply, "errorCode", "UNKNOWN_ERROR"),
                        getattr(reply, "description", ""),
                    )
                replies.append((payload_type, reply))
                if done is None or done(payload_type, reply):
                    return replies
        finally:
            with self._pending_lock:
                self._pending.pop(client_msg_id, None)

    def request_one(self, message: Message, timeout: float = 15.0) -> Message:
        return self.request(message, timeout=timeout)[-1][1]

    # -- receiving -------------------------------------------------------

    def _recv_exact(self, size: int) -> bytes:
        chunks = bytearray()
        sock = self._sock
        while len(chunks) < size:
            if sock is None:
                raise ConnectionError("socket closed")
            chunk = sock.recv(size - len(chunks))
            if not chunk:
                raise ConnectionError("connection closed by server")
            chunks.extend(chunk)
        return bytes(chunks)

    def _read_loop(self) -> None:
        try:
            while not self._closed.is_set():
                (length,) = struct.unpack(">I", self._recv_exact(4))
                envelope = common_messages.ProtoMessage()
                envelope.ParseFromString(self._recv_exact(length))
                self.last_received = time.monotonic()
                payload_type = int(envelope.payloadType)
                if payload_type == HEARTBEAT_EVENT:
                    continue
                cls = PAYLOAD_CLASSES.get(payload_type)
                if cls is None:
                    continue
                message = cls()
                message.ParseFromString(envelope.payload)
                client_msg_id = envelope.clientMsgId if envelope.HasField("clientMsgId") else ""
                if self._on_event is not None:
                    try:
                        self._on_event(payload_type, message, client_msg_id)
                    except Exception:
                        # A cache bug must never kill the reader thread.
                        pass
                if client_msg_id:
                    with self._pending_lock:
                        pending = self._pending.get(client_msg_id)
                    if pending is not None:
                        pending.replies.put((payload_type, message))
        except Exception as ex:
            if not self._closed.is_set():
                self.close(f"connection lost: {ex}")

    def _heartbeat_loop(self) -> None:
        heartbeat = common_messages.ProtoHeartbeatEvent().SerializeToString()
        while not self._closed.wait(self.HEARTBEAT_INTERVAL_SEC):
            try:
                self._send_frame(HEARTBEAT_EVENT, heartbeat, None)
            except CTraderError:
                return
