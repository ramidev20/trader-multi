"""MetaTrader5-shaped facade over the cTrader Open API.

The strategy, adapter and API code were written against the `MetaTrader5`
module: synchronous calls returning namespaces with MT5 field names. This
module keeps that surface (`mt5.positions_get()`, `mt5.order_send(request)`,
`mt5.copy_rates_from_pos(...)` ...) so that code runs unchanged, while the
data underneath comes from a direct, terminal-less cTrader connection.

What makes it fast: cTrader pushes prices, bars and executions, so quotes,
positions, pending orders and candles are served from an in-memory cache
kept current by those events -- a read never waits on the network. Only
trading requests and history back-fills do a round trip.

Unit conversions handled here (cTrader -> MT5):
  * spot/trendbar prices arrive as integers in 1/100000 of a price unit;
  * volumes are in 1/100 of a unit, so lots = volume / symbol.lotSize;
  * money values are integers scaled by 10**moneyDigits;
  * position ids double as MT5 tickets (MT5's position ticket equals the
    opening order's ticket; cTrader keeps separate ids, so market order
    results report the position id as `order`).

Credentials: the Open API application's client id and secret come from
`ctrader_app` in ctrader/config.json. Each account supplies its trader login
(`login`), an OAuth access token (`password`) and `demo`/`live` (`server`).
"""

from __future__ import annotations

import bisect
import re
import threading
import time
from datetime import datetime
from types import SimpleNamespace
from typing import Any, Iterable

import numpy as np

from .config_file import ctrader_app_credentials
from .ctrader_client import HOSTS, CTraderConnection, CTraderError
from .ctrader_proto import OpenApiMessages_pb2 as msg
from .ctrader_proto import OpenApiModelMessages_pb2 as model

PRICE_SCALE = 100_000
RATES_DTYPE = np.dtype(
    [
        ("time", "<i8"),
        ("open", "<f8"),
        ("high", "<f8"),
        ("low", "<f8"),
        ("close", "<f8"),
        ("tick_volume", "<u8"),
        ("spread", "<i4"),
        ("real_volume", "<u8"),
    ]
)

# MT5 timeframe constant -> (cTrader trendbar period, minutes)
_PERIODS: dict[int, tuple[int, int]] = {
    1: (model.M1, 1),
    3: (model.M3, 3),
    5: (model.M5, 5),
    15: (model.M15, 15),
    30: (model.M30, 30),
    16385: (model.H1, 60),
    16388: (model.H4, 240),
    16408: (model.D1, 1440),
}
_PERIOD_MINUTES = {period: minutes for period, minutes in _PERIODS.values()}

_SYMBOL_ALIASES = {"XAUUSD": ("GOLD", "XAUUSD.", "XAUUSDM")}
_RECONNECT_GRACE_SEC = 20.0
_HISTORY_TOPUP_SEC = 15.0
_WEEK_MS = 7 * 24 * 3600 * 1000


def _to_ms(value: Any) -> int:
    if isinstance(value, datetime):
        return int(value.timestamp() * 1000)
    return int(float(value) * 1000)


def _norm_name(name: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", str(name or "").upper())


class _BarSeries:
    """Bars for one symbol/period, ascending by open time (seconds)."""

    MAX_ROWS = 6000

    def __init__(self) -> None:
        self.times: list[int] = []
        self.rows: dict[int, list[float]] = {}
        self.live = False
        self.last_refresh = 0.0

    def upsert(self, stamp: int, open_: float, high: float, low: float, close: float, volume: int) -> bool:
        """Insert or update one bar. Returns True when it opened a new latest bar."""
        row = self.rows.get(stamp)
        if row is not None:
            row[:] = [open_, high, low, close, volume]
            return False
        is_new_latest = not self.times or stamp > self.times[-1]
        bisect.insort(self.times, stamp)
        self.rows[stamp] = [open_, high, low, close, volume]
        if len(self.times) > self.MAX_ROWS:
            for old in self.times[: len(self.times) - self.MAX_ROWS]:
                self.rows.pop(old, None)
            del self.times[: len(self.times) - self.MAX_ROWS]
        return is_new_latest

    def tail(self, start_pos: int, count: int) -> np.ndarray:
        end = len(self.times) - max(0, start_pos)
        begin = max(0, end - max(0, count))
        selected = self.times[begin:max(begin, end)]
        out = np.zeros(len(selected), dtype=RATES_DTYPE)
        for index, stamp in enumerate(selected):
            o, h, l, c, v = self.rows[stamp]
            out[index] = (stamp, o, h, l, c, int(v), 0, int(v))
        return out


class CTraderMT5:
    # --- MT5 constants the application uses (same values as MetaTrader5) ---
    TIMEFRAME_M1 = 1
    TIMEFRAME_M3 = 3
    TIMEFRAME_M5 = 5
    TIMEFRAME_M15 = 15
    TIMEFRAME_M30 = 30
    TIMEFRAME_H1 = 16385
    TIMEFRAME_H4 = 16388
    TIMEFRAME_D1 = 16408

    ORDER_TYPE_BUY = 0
    ORDER_TYPE_SELL = 1
    ORDER_TYPE_BUY_LIMIT = 2
    ORDER_TYPE_SELL_LIMIT = 3
    ORDER_TYPE_BUY_STOP = 4
    ORDER_TYPE_SELL_STOP = 5
    POSITION_TYPE_BUY = 0
    POSITION_TYPE_SELL = 1

    TRADE_ACTION_DEAL = 1
    TRADE_ACTION_PENDING = 5
    TRADE_ACTION_SLTP = 6
    TRADE_ACTION_MODIFY = 7
    TRADE_ACTION_REMOVE = 8

    ORDER_TIME_GTC = 0
    ORDER_FILLING_FOK = 0
    ORDER_FILLING_IOC = 1
    ORDER_FILLING_RETURN = 2

    TRADE_RETCODE_REJECT = 10006
    TRADE_RETCODE_DONE = 10009
    TRADE_RETCODE_ERROR = 10011
    TRADE_RETCODE_TIMEOUT = 10012
    TRADE_RETCODE_INVALID = 10013
    TRADE_RETCODE_INVALID_VOLUME = 10014
    TRADE_RETCODE_MARKET_CLOSED = 10018
    TRADE_RETCODE_NO_MONEY = 10019
    TRADE_RETCODE_CONNECTION = 10031

    DEAL_TYPE_BUY = 0
    DEAL_TYPE_SELL = 1
    DEAL_ENTRY_IN = 0
    DEAL_ENTRY_OUT = 1
    DEAL_ENTRY_INOUT = 2
    DEAL_ENTRY_OUT_BY = 3
    DEAL_REASON_CLIENT = 0
    DEAL_REASON_EXPERT = 3
    DEAL_REASON_SL = 4
    DEAL_REASON_TP = 5
    DEAL_REASON_SO = 6

    _ERROR_RETCODES = {
        "MARKET_CLOSED": TRADE_RETCODE_MARKET_CLOSED,
        "NOT_ENOUGH_MONEY": TRADE_RETCODE_NO_MONEY,
        "TRADING_BAD_VOLUME": TRADE_RETCODE_INVALID_VOLUME,
        "TIMEOUT": TRADE_RETCODE_TIMEOUT,
        "CONNECTION_CLOSED": TRADE_RETCODE_CONNECTION,
    }

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._conn: CTraderConnection | None = None
        self._last_error: tuple[int, str] = (1, "Success")
        self._stop = threading.Event()
        self._maintenance: threading.Thread | None = None
        self._reset_session()

    def _reset_session(self) -> None:
        self._login = 0
        self._account_id = 0
        self._token = ""
        self._env = "demo"
        self._trader: Any = None
        self._broker = ""
        self._assets: dict[int, str] = {}
        self._light_symbols: dict[int, Any] = {}
        self._symbol_ids: dict[str, int] = {}
        self._display_names: dict[int, str] = {}
        self._details: dict[int, Any] = {}
        self._spots: dict[int, dict[str, float]] = {}
        self._spot_ready = threading.Condition(self._lock)
        self._spot_subs: set[int] = set()
        self._bars: dict[tuple[int, int], _BarSeries] = {}
        self._bar_refresh: set[tuple[int, int]] = set()
        self._positions: dict[int, Any] = {}
        self._orders: dict[int, Any] = {}
        self._protection: dict[int, tuple[float, float]] = {}
        self._unrealized: dict[int, tuple[float, float]] = {}
        self._deals: dict[int, Any] = {}
        self._hist_orders: dict[int, Any] = {}
        self._deal_reasons: dict[int, int] = {}
        self._history_range: tuple[int, int] | None = None
        self._history_topup_at = 0.0
        self._latency_us = 0.0
        self._disconnected_since: float | None = None
        self._fatal_error = ""
        self._token_swapped_at = 0.0

    # ------------------------------------------------------------------
    # connection / session
    # ------------------------------------------------------------------

    def last_error(self) -> tuple[int, str]:
        return self._last_error

    def _fail(self, code: int, text: str) -> None:
        self._last_error = (code, text)

    def initialize(self, login: Any = None, password: str = "", server: str = "", path: str | None = None, timeout: Any = None, **_kwargs: Any) -> bool:
        client_id, client_secret = ctrader_app_credentials()
        if not client_id or not client_secret:
            self._fail(-2, 'Set "client_id" and "client_secret" under "ctrader_app" in ctrader/config.json (register an app at openapi.ctrader.com).')
            return False
        try:
            login_number = int(login or 0)
        except (TypeError, ValueError):
            login_number = 0
        token = str(password or "").strip()
        if login_number <= 0 or not token:
            self._fail(-2, "A cTrader account number (login) and an Open API access token (password) are required.")
            return False
        self.shutdown()
        with self._lock:
            self._reset_session()
            self._login = login_number
            self._token = token
            self._env = "live" if "live" in str(server or "").lower() else "demo"
            self._client_id, self._client_secret = client_id, client_secret
        try:
            self._open_session(resolve_account=True)
        except CTraderError as ex:
            self._close_connection("initialize failed")
            self._fail(-10003, f"cTrader initialize failed: {ex}")
            return False
        except OSError as ex:
            self._close_connection("initialize failed")
            self._fail(-10004, f"Could not reach cTrader {self._env} server: {ex}")
            return False
        self._stop.clear()
        self._maintenance = threading.Thread(target=self._maintenance_loop, name="ctrader-maintenance", daemon=True)
        self._maintenance.start()
        self._fail(1, "Success")
        return True

    def _open_session(self, resolve_account: bool) -> None:
        """Connect, authenticate the app and the account, then load caches."""
        conn = self._connect(self._env)
        if resolve_account or not self._account_id:
            reply = conn.request_one(msg.ProtoOAGetAccountListByAccessTokenReq(accessToken=self._token))
            match = next(
                (
                    account
                    for account in reply.ctidTraderAccount
                    if int(account.traderLogin) == self._login or int(account.ctidTraderAccountId) == self._login
                ),
                None,
            )
            if match is None:
                available = ", ".join(str(a.traderLogin) for a in reply.ctidTraderAccount) or "none"
                raise CTraderError("ACCOUNT_NOT_FOUND", f"account {self._login} is not authorized for this access token (token covers: {available})")
            account_env = "live" if match.isLive else "demo"
            self._account_id = int(match.ctidTraderAccountId)
            self._broker = str(match.brokerTitleShort or "")
            if account_env != self._env:
                # The account lives on the other proxy; accounts only authorize there.
                self._env = account_env
                conn = self._connect(account_env)
        conn.request_one(msg.ProtoOAAccountAuthReq(ctidTraderAccountId=self._account_id, accessToken=self._token))
        trader = conn.request_one(msg.ProtoOATraderReq(ctidTraderAccountId=self._account_id)).trader
        assets = conn.request_one(msg.ProtoOAAssetListReq(ctidTraderAccountId=self._account_id)).asset
        symbols = conn.request_one(msg.ProtoOASymbolsListReq(ctidTraderAccountId=self._account_id)).symbol
        reconcile = conn.request_one(msg.ProtoOAReconcileReq(ctidTraderAccountId=self._account_id))
        with self._lock:
            self._trader = trader
            self._broker = str(trader.brokerName or self._broker)
            self._assets = {int(a.assetId): str(a.name) for a in assets}
            self._light_symbols = {int(s.symbolId): s for s in symbols}
            self._symbol_ids = {}
            for symbol in symbols:
                self._symbol_ids.setdefault(str(symbol.symbolName).upper(), int(symbol.symbolId))
            self._positions = {int(p.positionId): p for p in reconcile.position}
            self._orders = {int(o.orderId): o for o in reconcile.order if self._is_pending(o)}
            for position in reconcile.position:
                self._remember_protection(position)
            self._disconnected_since = None
            resubscribe = sorted(self._spot_subs)
            self._spot_subs = set()
            bar_keys = list(self._bars.keys())
        self._load_details(set(self._symbol_id_of(p) for p in reconcile.position) | set(self._symbol_id_of(o) for o in reconcile.order))
        for symbol_id in resubscribe:
            self._subscribe_spots(symbol_id)
        for symbol_id, period in bar_keys:
            # Fill whatever was missed while the connection was down.
            self._fetch_bars(symbol_id, period, 300)
            self._subscribe_live_bars(symbol_id, period)
        self._refresh_unrealized()

    def _connect(self, env: str) -> CTraderConnection:
        self._close_connection("reconnecting")
        conn = CTraderConnection(HOSTS[env], on_event=self._on_event)
        conn.connect()
        conn.request_one(msg.ProtoOAApplicationAuthReq(clientId=self._client_id, clientSecret=self._client_secret))
        self._conn = conn
        return conn

    def _close_connection(self, reason: str) -> None:
        conn, self._conn = self._conn, None
        if conn is not None:
            conn.close(reason)

    def set_access_token(self, token: str) -> bool:
        """Switch to a refreshed access token without dropping the session.

        Refreshing invalidates the old token, so the current socket is closed
        and the maintenance thread re-authorizes on a new one; the account and
        its caches are kept, and account_info() rides out the short gap.
        """
        token = str(token or "").strip()
        if not token or not self._account_id:
            return False
        with self._lock:
            self._token = token
            self._token_swapped_at = time.monotonic()
            self._fatal_error = ""
        self._close_connection("access token refreshed")
        return True

    def shutdown(self) -> bool:
        self._stop.set()
        conn = self._conn
        if conn is not None and conn.connected and self._account_id:
            try:
                conn.request_one(msg.ProtoOAAccountLogoutReq(ctidTraderAccountId=self._account_id), timeout=3)
            except CTraderError:
                pass
        self._close_connection("shutdown")
        maintenance, self._maintenance = self._maintenance, None
        if maintenance is not None and maintenance is not threading.current_thread():
            maintenance.join(timeout=2)
        return True

    def _call(self, message: Any, timeout: float = 15.0, done=None) -> list:
        """Request with a live connection, retrying once when rate-limited."""
        for attempt in range(3):
            conn = self._conn
            if conn is None or not conn.connected:
                raise CTraderError("CONNECTION_CLOSED", self._fatal_error or "cTrader connection is down")
            try:
                return conn.request(message, timeout=timeout, done=done)
            except CTraderError as ex:
                if ex.code != "BLOCKED_PAYLOAD_TYPE" or attempt == 2:
                    raise
                time.sleep(1.0)
        return []

    def _call_one(self, message: Any, timeout: float = 15.0) -> Any:
        return self._call(message, timeout=timeout)[-1][1]

    # ------------------------------------------------------------------
    # background upkeep
    # ------------------------------------------------------------------

    def _maintenance_loop(self) -> None:
        last_trader = 0.0
        last_reconcile = time.monotonic()
        backoff = 1.0
        while not self._stop.wait(1.0):
            conn = self._conn
            if conn is None or not conn.connected:
                with self._lock:
                    if self._disconnected_since is None:
                        self._disconnected_since = time.monotonic()
                if self._fatal_error:
                    continue
                try:
                    self._open_session(resolve_account=False)
                    backoff = 1.0
                except (CTraderError, OSError) as ex:
                    self._fail(-10005, f"cTrader reconnect failed: {ex}")
                    self._stop.wait(backoff)
                    backoff = min(30.0, backoff * 2)
                continue
            try:
                now = time.monotonic()
                if now - last_trader >= 5.0:
                    started = time.perf_counter()
                    trader = self._call_one(msg.ProtoOATraderReq(ctidTraderAccountId=self._account_id), timeout=10).trader
                    self._latency_us = (time.perf_counter() - started) * 1_000_000
                    with self._lock:
                        self._trader = trader
                    last_trader = now
                if now - last_reconcile >= 60.0:
                    self._reconcile()
                    last_reconcile = now
                self._refresh_unrealized()
                with self._lock:
                    pending_refresh = list(self._bar_refresh)
                    self._bar_refresh.clear()
                for symbol_id, period in pending_refresh:
                    # The closed bar's final OHLC from history, rather than the
                    # last live update we happened to see before rollover.
                    self._fetch_bars(symbol_id, period, 3)
            except CTraderError:
                continue

    def _reconcile(self) -> None:
        reply = self._call_one(msg.ProtoOAReconcileReq(ctidTraderAccountId=self._account_id))
        with self._lock:
            self._positions = {int(p.positionId): p for p in reply.position}
            self._orders = {int(o.orderId): o for o in reply.order if self._is_pending(o)}
            for position in reply.position:
                self._remember_protection(position)

    def _refresh_unrealized(self) -> None:
        with self._lock:
            has_positions = bool(self._positions)
        if not has_positions:
            with self._lock:
                self._unrealized = {}
            return
        reply = self._call_one(msg.ProtoOAGetPositionUnrealizedPnLReq(ctidTraderAccountId=self._account_id), timeout=10)
        scale = 10 ** int(reply.moneyDigits or 2)
        with self._lock:
            self._unrealized = {
                int(row.positionId): (row.grossUnrealizedPnL / scale, row.netUnrealizedPnL / scale)
                for row in reply.positionUnrealizedPnL
            }

    # ------------------------------------------------------------------
    # pushed events
    # ------------------------------------------------------------------

    def _on_event(self, payload_type: int, message: Any, _client_msg_id: str) -> None:
        if payload_type == model.PROTO_OA_SPOT_EVENT:
            self._on_spot(message)
        elif payload_type == model.PROTO_OA_EXECUTION_EVENT:
            self._on_execution(message)
        elif payload_type == model.PROTO_OA_TRADER_UPDATE_EVENT:
            with self._lock:
                self._trader = message.trader
        elif payload_type == model.PROTO_OA_ACCOUNTS_TOKEN_INVALIDATED_EVENT:
            if time.monotonic() - self._token_swapped_at < 30.0:
                # The old token's session ending after set_access_token().
                return
            self._fatal_error = f"Access token was invalidated: {message.reason or 'reauthorize the account'}"
            self._fail(-10006, self._fatal_error)
            threading.Thread(target=self._close_connection, args=("token invalidated",), daemon=True).start()
        elif payload_type in {model.PROTO_OA_CLIENT_DISCONNECT_EVENT, model.PROTO_OA_ACCOUNT_DISCONNECT_EVENT}:
            # Drop the socket; the maintenance thread reconnects.
            threading.Thread(target=self._close_connection, args=("disconnected by server",), daemon=True).start()

    def _on_spot(self, event: Any) -> None:
        symbol_id = int(event.symbolId)
        with self._lock:
            spot = self._spots.setdefault(symbol_id, {"bid": 0.0, "ask": 0.0, "time_ms": 0})
            if event.HasField("bid"):
                spot["bid"] = event.bid / PRICE_SCALE
            if event.HasField("ask"):
                spot["ask"] = event.ask / PRICE_SCALE
            spot["time_ms"] = int(event.timestamp) if event.HasField("timestamp") else int(time.time() * 1000)
            digits = self._digits(symbol_id)
            for bar in event.trendbar:
                series = self._bars.get((symbol_id, int(bar.period)))
                if series is None:
                    continue
                stamp, o, h, l, c, v = self._decode_bar(bar, digits, fallback_close=spot["bid"])
                if series.upsert(stamp, o, h, l, c, v) and len(series.times) > 1:
                    self._bar_refresh.add((symbol_id, int(bar.period)))
                series.live = True
            self._spot_ready.notify_all()

    def _on_execution(self, event: Any) -> None:
        with self._lock:
            if event.HasField("position"):
                position = event.position
                position_id = int(position.positionId)
                if position.positionStatus == model.POSITION_STATUS_OPEN:
                    self._positions[position_id] = position
                    self._remember_protection(position)
                elif position.positionStatus in {model.POSITION_STATUS_CLOSED, model.POSITION_STATUS_ERROR}:
                    self._positions.pop(position_id, None)
                    self._unrealized.pop(position_id, None)
            if event.HasField("order"):
                order = event.order
                order_id = int(order.orderId)
                if self._is_pending(order):
                    self._orders[order_id] = order
                else:
                    self._orders.pop(order_id, None)
                self._hist_orders[order_id] = order
            if event.HasField("deal"):
                deal = event.deal
                self._deals[int(deal.dealId)] = deal
                if deal.HasField("closePositionDetail"):
                    reason = self.DEAL_REASON_CLIENT
                    if event.HasField("order") and event.order.isStopOut:
                        reason = self.DEAL_REASON_SO
                    elif event.HasField("order") and event.order.orderType == model.STOP_LOSS_TAKE_PROFIT:
                        reason = self._protection_reason(int(deal.positionId), float(deal.executionPrice or 0.0), event.order)
                    self._deal_reasons[int(deal.dealId)] = reason
                    detail = deal.closePositionDetail
                    if self._trader is not None and detail.HasField("balance"):
                        self._trader.balance = detail.balance

    # ------------------------------------------------------------------
    # symbols and quotes
    # ------------------------------------------------------------------

    @staticmethod
    def _symbol_id_of(item: Any) -> int:
        return int(item.tradeData.symbolId)

    def _resolve_symbol(self, symbol: str) -> int | None:
        name = str(symbol or "").strip().upper()
        if not name:
            return None
        with self._lock:
            symbol_id = self._symbol_ids.get(name)
            if symbol_id is None:
                wanted = _norm_name(name)
                candidates = [wanted, *(_norm_name(alias) for alias in _SYMBOL_ALIASES.get(name, ()))]
                by_norm = {_norm_name(key): value for key, value in self._symbol_ids.items()}
                symbol_id = next((by_norm[c] for c in candidates if c in by_norm), None)
                if symbol_id is None:
                    symbol_id = next((value for key, value in self._symbol_ids.items() if _norm_name(key).startswith(wanted)), None)
                if symbol_id is not None:
                    self._symbol_ids[name] = symbol_id
            if symbol_id is not None:
                # Report the name the app asked for (e.g. XAUUSD for a broker's
                # "GOLD") so its symbol comparisons keep matching.
                self._display_names.setdefault(symbol_id, name)
        return symbol_id

    def _symbol_name(self, symbol_id: int) -> str:
        with self._lock:
            if symbol_id in self._display_names:
                return self._display_names[symbol_id]
            light = self._light_symbols.get(symbol_id)
            return str(light.symbolName) if light is not None else str(symbol_id)

    def _load_details(self, symbol_ids: Iterable[int]) -> None:
        with self._lock:
            missing = sorted({int(s) for s in symbol_ids if s and int(s) not in self._details})
        if not missing:
            return
        reply = self._call_one(msg.ProtoOASymbolByIdReq(ctidTraderAccountId=self._account_id, symbolId=missing))
        with self._lock:
            for detail in reply.symbol:
                self._details[int(detail.symbolId)] = detail

    def _detail(self, symbol_id: int) -> Any:
        with self._lock:
            detail = self._details.get(symbol_id)
        if detail is None:
            self._load_details([symbol_id])
            with self._lock:
                detail = self._details.get(symbol_id)
        return detail

    def _digits(self, symbol_id: int) -> int:
        detail = self._details.get(symbol_id)
        return int(detail.digits) if detail is not None else 5

    def _lot_size(self, symbol_id: int) -> int:
        detail = self._details.get(symbol_id)
        lot_size = int(getattr(detail, "lotSize", 0) or 0) if detail is not None else 0
        return lot_size if lot_size > 0 else 10_000_000

    def _lots(self, symbol_id: int, volume: int) -> float:
        return round(int(volume or 0) / self._lot_size(symbol_id), 4)

    def _protocol_volume(self, symbol_id: int, lots: float) -> int:
        detail = self._detail(symbol_id)
        volume = int(round(float(lots) * self._lot_size(symbol_id)))
        step = int(getattr(detail, "stepVolume", 0) or 0)
        if step > 0:
            volume = int(round(volume / step)) * step
        return volume

    def _subscribe_spots(self, symbol_id: int) -> None:
        with self._lock:
            if symbol_id in self._spot_subs:
                return
            self._spot_subs.add(symbol_id)
        try:
            self._call(msg.ProtoOASubscribeSpotsReq(ctidTraderAccountId=self._account_id, symbolId=[symbol_id], subscribeToSpotTimestamp=True))
        except CTraderError as ex:
            if "ALREADY_SUBSCRIBED" not in ex.code:
                with self._lock:
                    self._spot_subs.discard(symbol_id)
                raise

    def _wait_spot(self, symbol_id: int, timeout: float = 3.0) -> dict[str, float] | None:
        deadline = time.monotonic() + timeout
        with self._lock:
            while True:
                spot = self._spots.get(symbol_id)
                if spot and spot["bid"] > 0 and spot["ask"] > 0:
                    return dict(spot)
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None
                self._spot_ready.wait(remaining)

    def _ready_symbol(self, symbol: str) -> int | None:
        if not self._ensure_connected():
            return None
        symbol_id = self._resolve_symbol(symbol)
        if symbol_id is None:
            self._fail(-4, f"Symbol {symbol} is not offered by this cTrader account.")
            return None
        try:
            self._detail(symbol_id)
            self._subscribe_spots(symbol_id)
        except CTraderError as ex:
            self._fail(-5, f"Could not subscribe to {symbol}: {ex}")
            return None
        return symbol_id

    def symbol_select(self, symbol: str, enable: bool = True) -> bool:
        return self._ready_symbol(symbol) is not None

    def symbol_info_tick(self, symbol: str) -> Any:
        symbol_id = self._ready_symbol(symbol)
        if symbol_id is None:
            return None
        spot = self._wait_spot(symbol_id)
        if spot is None:
            self._fail(-6, f"No live quote received for {symbol}.")
            return None
        stamp_ms = int(spot["time_ms"])
        return SimpleNamespace(
            time=stamp_ms // 1000,
            time_msc=stamp_ms,
            bid=spot["bid"],
            ask=spot["ask"],
            last=0.0,
            volume=0,
            flags=0,
        )

    def symbol_info(self, symbol: str) -> Any:
        symbol_id = self._ready_symbol(symbol)
        if symbol_id is None:
            return None
        detail = self._detail(symbol_id)
        if detail is None:
            return None
        spot = self._wait_spot(symbol_id, timeout=1.0) or {"bid": 0.0, "ask": 0.0}
        digits = int(detail.digits)
        point = 10 ** -digits
        lot_size = self._lot_size(symbol_id)
        contract_size = lot_size / 100.0
        rate = self._quote_to_deposit_rate(symbol_id)
        tick_value = point * contract_size * rate if rate else 0.0
        light = self._light_symbols.get(symbol_id)
        return SimpleNamespace(
            name=self._symbol_name(symbol_id),
            description=str(getattr(light, "description", "") or ""),
            visible=True,
            select=True,
            digits=digits,
            point=point,
            trade_tick_size=point,
            trade_tick_value=tick_value,
            trade_tick_value_profit=tick_value,
            trade_tick_value_loss=tick_value,
            trade_contract_size=contract_size,
            volume_min=int(detail.minVolume or 0) / lot_size if detail.minVolume else 0.01,
            volume_max=int(detail.maxVolume or 0) / lot_size if detail.maxVolume else 100.0,
            volume_step=int(detail.stepVolume or 0) / lot_size if detail.stepVolume else 0.01,
            bid=spot["bid"],
            ask=spot["ask"],
            spread=int(round((spot["ask"] - spot["bid"]) / point)) if spot["bid"] else 0,
            trade_mode=int(detail.tradingMode),
        )

    def _quote_to_deposit_rate(self, symbol_id: int) -> float | None:
        """Multiplier from the symbol's quote currency to the deposit currency."""
        with self._lock:
            light = self._light_symbols.get(symbol_id)
            deposit = int(getattr(self._trader, "depositAssetId", 0) or 0)
            if light is None or not deposit:
                return None
            quote = int(light.quoteAssetId)
            if quote == deposit:
                return 1.0
            direct = next((s for s in self._light_symbols.values() if s.baseAssetId == quote and s.quoteAssetId == deposit), None)
            inverse = next((s for s in self._light_symbols.values() if s.baseAssetId == deposit and s.quoteAssetId == quote), None)
        conversion = direct or inverse
        if conversion is None:
            return None
        try:
            self._subscribe_spots(int(conversion.symbolId))
        except CTraderError:
            return None
        spot = self._wait_spot(int(conversion.symbolId), timeout=2.0)
        if spot is None:
            return None
        return spot["bid"] if conversion is direct else (1.0 / spot["ask"] if spot["ask"] else None)

    # ------------------------------------------------------------------
    # candles
    # ------------------------------------------------------------------

    @staticmethod
    def _decode_bar(bar: Any, digits: int, fallback_close: float = 0.0) -> tuple[int, float, float, float, float, int]:
        low = int(bar.low)
        open_ = (low + int(bar.deltaOpen)) / PRICE_SCALE
        high = (low + int(bar.deltaHigh)) / PRICE_SCALE
        close = (low + int(bar.deltaClose)) / PRICE_SCALE if bar.HasField("deltaClose") else (fallback_close or open_)
        low_price = low / PRICE_SCALE
        # A live bar's close is the current bid, which can briefly sit outside
        # the high/low the server last sent.
        high = max(high, close)
        low_price = min(low_price, close)
        return (
            int(bar.utcTimestampInMinutes) * 60,
            round(open_, digits),
            round(high, digits),
            round(low_price, digits),
            round(close, digits),
            int(bar.volume),
        )

    def _fetch_bars(self, symbol_id: int, period: int, count: int, to_ms: int | None = None) -> int:
        """Back-fill `count` bars ending at `to_ms` into the cache. Returns bars received."""
        minutes = _PERIOD_MINUTES.get(period, 1)
        to_ms = int(to_ms or (time.time() * 1000 + 60_000))
        # Wide enough to cover a weekend or holiday gap; `count` trims the reply.
        window = int(count * minutes * 60_000 * 2 + 4 * 24 * 3600 * 1000)
        digits = self._digits(symbol_id)
        received = 0
        for _ in range(4):
            try:
                reply = self._call_one(
                    msg.ProtoOAGetTrendbarsReq(
                        ctidTraderAccountId=self._account_id,
                        symbolId=symbol_id,
                        period=period,
                        fromTimestamp=max(0, to_ms - window),
                        toTimestamp=to_ms,
                        count=min(count, 5000),
                    )
                )
            except CTraderError as ex:
                if ex.code == "INVALID_REQUEST" and window > 24 * 3600 * 1000:
                    window //= 2
                    continue
                raise
            with self._lock:
                series = self._bars.setdefault((symbol_id, period), _BarSeries())
                for bar in reply.trendbar:
                    series.upsert(*self._decode_bar(bar, digits))
                series.last_refresh = time.monotonic()
            received = len(reply.trendbar)
            if received >= count or window >= 400 * 24 * 3600 * 1000:
                break
            window *= 3
        return received

    def _subscribe_live_bars(self, symbol_id: int, period: int) -> None:
        try:
            self._subscribe_spots(symbol_id)
            self._call(msg.ProtoOASubscribeLiveTrendbarReq(ctidTraderAccountId=self._account_id, symbolId=symbol_id, period=period))
        except CTraderError as ex:
            if "ALREADY_SUBSCRIBED" not in ex.code:
                with self._lock:
                    series = self._bars.get((symbol_id, period))
                    if series is not None:
                        series.live = False

    def copy_rates_from_pos(self, symbol: str, timeframe: int, start_pos: int, count: int) -> np.ndarray | None:
        symbol_id = self._ready_symbol(symbol)
        if symbol_id is None:
            return None
        period = _PERIODS.get(int(timeframe), _PERIODS[1])[0]
        key = (symbol_id, period)
        needed = max(0, int(start_pos)) + max(0, int(count))
        have = 0
        try:
            with self._lock:
                series = self._bars.get(key)
                have = len(series.times) if series else 0
                subscribed = series is not None
                stale = series is not None and not series.live and time.monotonic() - series.last_refresh > 2.0
            if have < needed:
                if have == 0:
                    self._fetch_bars(symbol_id, period, max(needed, 300))
                else:
                    with self._lock:
                        oldest = self._bars[key].times[0]
                    self._fetch_bars(symbol_id, period, needed - have, to_ms=oldest * 1000 - 1)
            elif stale:
                # No live trendbar feed for this key: poll, at most every 2s.
                self._fetch_bars(symbol_id, period, 3)
            if not subscribed:
                self._subscribe_live_bars(symbol_id, period)
        except CTraderError as ex:
            self._fail(-7, f"Trendbar request failed for {symbol}: {ex}")
            if have == 0:
                return None
        with self._lock:
            series = self._bars.get(key)
            if series is None or not series.times:
                return None
            return series.tail(start_pos, count)

    # ------------------------------------------------------------------
    # account, positions, orders
    # ------------------------------------------------------------------

    def _ensure_connected(self) -> bool:
        conn = self._conn
        if conn is not None and conn.connected and self._account_id:
            return True
        self._fail(-10001, self._fatal_error or "cTrader is not connected.")
        return False

    def _money(self, value: int) -> float:
        digits = int(getattr(self._trader, "moneyDigits", 0) or 2)
        return int(value or 0) / (10 ** digits)

    def account_info(self) -> Any:
        with self._lock:
            trader = self._trader
            down_since = self._disconnected_since
            unrealized = dict(self._unrealized)
        if trader is None:
            return None
        if down_since is not None and time.monotonic() - down_since > _RECONNECT_GRACE_SEC:
            return None
        balance = self._money(trader.balance)
        profit = sum(gross for gross, _net in unrealized.values())
        equity = balance + sum(net for _gross, net in unrealized.values())
        return SimpleNamespace(
            login=self._login,
            server=f"{self._broker or 'cTrader'} ({self._env})",
            name=str(self._login),
            company=self._broker,
            currency=self._assets.get(int(trader.depositAssetId), ""),
            balance=balance,
            equity=equity,
            profit=profit,
            leverage=int((trader.leverageInCents or 0) / 100),
            trade_allowed=trader.accessRights == model.FULL_ACCESS,
            trade_expert=True,
        )

    def terminal_info(self) -> Any:
        with self._lock:
            trader = self._trader
        connected = self._conn is not None and self._conn.connected
        return SimpleNamespace(
            connected=connected,
            ping_last=self._latency_us,
            trade_allowed=trader is not None and trader.accessRights in {model.FULL_ACCESS, model.CLOSE_ONLY},
            tradeapi_disabled=False,
            name="cTrader Open API",
            company=self._broker,
        )

    @staticmethod
    def _is_pending(order: Any) -> bool:
        return (
            order.orderStatus == model.ORDER_STATUS_ACCEPTED
            and order.orderType in {model.LIMIT, model.STOP, model.STOP_LIMIT}
            and not order.closingOrder
        )

    def _remember_protection(self, position: Any) -> None:
        self._protection[int(position.positionId)] = (float(position.stopLoss or 0.0), float(position.takeProfit or 0.0))

    def _protection_reason(self, position_id: int, close_price: float, closing_order: Any = None, opening_order: Any = None) -> int:
        """SL or TP for a protective close: whichever level the fill sits nearest.

        cTrader reports one STOP_LOSS_TAKE_PROFIT order type for both, so the
        known levels decide. Falls back to profit-free CLIENT when none is known.
        """
        levels = list(self._protection.get(position_id, (0.0, 0.0)))
        for source in (closing_order, opening_order):
            if source is None:
                continue
            levels[0] = levels[0] or float(getattr(source, "stopLoss", 0.0) or 0.0)
            levels[1] = levels[1] or float(getattr(source, "takeProfit", 0.0) or 0.0)
        sl, tp = levels
        if sl and tp:
            return self.DEAL_REASON_SL if abs(close_price - sl) <= abs(close_price - tp) else self.DEAL_REASON_TP
        if sl:
            return self.DEAL_REASON_SL
        if tp:
            return self.DEAL_REASON_TP
        return self.DEAL_REASON_CLIENT

    def _position_ns(self, position: Any) -> Any:
        symbol_id = self._symbol_id_of(position)
        trade = position.tradeData
        position_id = int(position.positionId)
        gross = self._unrealized.get(position_id, (0.0, 0.0))[0]
        spot = self._spots.get(symbol_id, {})
        is_buy = trade.tradeSide == model.BUY
        opened_ms = int(trade.openTimestamp or 0)
        return SimpleNamespace(
            ticket=position_id,
            identifier=position_id,
            symbol=self._symbol_name(symbol_id),
            type=self.POSITION_TYPE_BUY if is_buy else self.POSITION_TYPE_SELL,
            volume=self._lots(symbol_id, trade.volume),
            price_open=float(position.price or 0.0),
            price_current=float(spot.get("bid" if is_buy else "ask", 0.0) or 0.0),
            sl=float(position.stopLoss or 0.0),
            tp=float(position.takeProfit or 0.0),
            profit=gross,
            swap=self._money(position.swap),
            commission=self._money(position.commission),
            comment=str(trade.comment or ""),
            magic=int(trade.label) if str(trade.label or "").isdigit() else 0,
            time=opened_ms // 1000,
            time_msc=opened_ms,
            time_update=int(position.utcLastUpdateTimestamp or 0) // 1000,
        )

    def _order_ns(self, order: Any) -> Any:
        symbol_id = self._symbol_id_of(order)
        trade = order.tradeData
        is_buy = trade.tradeSide == model.BUY
        if order.orderType == model.LIMIT:
            order_type = self.ORDER_TYPE_BUY_LIMIT if is_buy else self.ORDER_TYPE_SELL_LIMIT
            price = float(order.limitPrice or 0.0)
        elif order.orderType in {model.STOP, model.STOP_LIMIT}:
            order_type = self.ORDER_TYPE_BUY_STOP if is_buy else self.ORDER_TYPE_SELL_STOP
            price = float(order.stopPrice or 0.0)
        else:
            order_type = self.ORDER_TYPE_BUY if is_buy else self.ORDER_TYPE_SELL
            price = float(order.executionPrice or 0.0)
        volume = self._lots(symbol_id, trade.volume)
        return SimpleNamespace(
            ticket=int(order.orderId),
            symbol=self._symbol_name(symbol_id),
            type=order_type,
            volume_initial=volume,
            volume_current=volume - self._lots(symbol_id, order.executedVolume or 0),
            price_open=price,
            sl=float(order.stopLoss or 0.0),
            tp=float(order.takeProfit or 0.0),
            comment=str(trade.comment or ""),
            magic=int(trade.label) if str(trade.label or "").isdigit() else 0,
            position_id=int(order.positionId or 0),
            time_setup=int(trade.openTimestamp or order.utcLastUpdateTimestamp or 0) // 1000,
            time_done=int(order.utcLastUpdateTimestamp or 0) // 1000,
        )

    def _filter(self, rows: Iterable[Any], symbol: str | None, ticket: int | None, id_attr: str) -> list[Any]:
        symbol_id = self._resolve_symbol(symbol) if symbol else None
        if symbol and symbol_id is None:
            return []
        out = []
        for row in rows:
            if symbol_id is not None and self._symbol_id_of(row) != symbol_id:
                continue
            if ticket is not None and int(getattr(row, id_attr)) != int(ticket):
                continue
            out.append(row)
        return out

    def positions_get(self, symbol: str | None = None, ticket: int | None = None, group: str | None = None) -> tuple | None:
        if not self._ensure_connected():
            return None
        with self._lock:
            rows = self._filter(list(self._positions.values()), symbol, ticket, "positionId")
            return tuple(self._position_ns(p) for p in rows)

    def orders_get(self, symbol: str | None = None, ticket: int | None = None, group: str | None = None) -> tuple | None:
        if not self._ensure_connected():
            return None
        with self._lock:
            rows = self._filter(list(self._orders.values()), symbol, ticket, "orderId")
            return tuple(self._order_ns(o) for o in rows)

    # ------------------------------------------------------------------
    # history
    # ------------------------------------------------------------------

    def _fetch_history_window(self, from_ms: int, to_ms: int) -> None:
        """Deals and orders in [from_ms, to_ms], paging with hasMore and
        falling back to one-week chunks if the server rejects a long range."""

        def pull(start: int, end: int) -> None:
            cursor = end
            while cursor > start:
                reply = self._call_one(msg.ProtoOADealListReq(ctidTraderAccountId=self._account_id, fromTimestamp=start, toTimestamp=cursor, maxRows=1000))
                with self._lock:
                    for deal in reply.deal:
                        self._deals[int(deal.dealId)] = deal
                if not reply.hasMore or not reply.deal:
                    break
                cursor = min(int(d.executionTimestamp) for d in reply.deal) - 1
            cursor = end
            while cursor > start:
                reply = self._call_one(msg.ProtoOAOrderListReq(ctidTraderAccountId=self._account_id, fromTimestamp=start, toTimestamp=cursor))
                with self._lock:
                    for order in reply.order:
                        self._hist_orders.setdefault(int(order.orderId), order)
                if not reply.hasMore or not reply.order:
                    break
                cursor = min(int(o.utcLastUpdateTimestamp or o.tradeData.openTimestamp) for o in reply.order) - 1

        try:
            pull(from_ms, to_ms)
        except CTraderError as ex:
            if ex.code != "INVALID_REQUEST":
                raise
            chunk_end = to_ms
            while chunk_end > from_ms:
                chunk_start = max(from_ms, chunk_end - _WEEK_MS)
                pull(chunk_start, chunk_end)
                chunk_end = chunk_start

    def _ensure_history(self, from_ms: int, to_ms: int) -> None:
        registered = int(getattr(self._trader, "registrationTimestamp", 0) or 0)
        from_ms = max(from_ms, registered - 24 * 3600 * 1000) if registered else from_ms
        now_ms = int(time.time() * 1000)
        to_ms = min(to_ms, now_ms + 60_000)
        with self._lock:
            covered = self._history_range
            topup_due = time.monotonic() - self._history_topup_at > _HISTORY_TOPUP_SEC
        if covered is None:
            self._fetch_history_window(from_ms, to_ms)
            covered = (from_ms, to_ms)
            topup_due = False
        else:
            if from_ms < covered[0]:
                self._fetch_history_window(from_ms, covered[0])
                covered = (from_ms, covered[1])
            # Execution events keep the cache current; this periodic top-up
            # only guards against a missed event.
            if to_ms > covered[1] and topup_due:
                self._fetch_history_window(covered[1] - 300_000, to_ms)
                covered = (covered[0], to_ms)
        with self._lock:
            self._history_range = covered
            if topup_due or self._history_topup_at == 0.0:
                self._history_topup_at = time.monotonic()

    def _deal_reason(self, deal: Any) -> int:
        deal_id = int(deal.dealId)
        if deal_id in self._deal_reasons:
            return self._deal_reasons[deal_id]
        closing_order = self._hist_orders.get(int(deal.orderId))
        if closing_order is None or closing_order.orderType != model.STOP_LOSS_TAKE_PROFIT:
            if closing_order is not None and closing_order.isStopOut:
                return self.DEAL_REASON_SO
            return self.DEAL_REASON_CLIENT
        position_id = int(deal.positionId)
        opening_order = next(
            (o for o in self._hist_orders.values() if int(o.positionId or 0) == position_id and not o.closingOrder),
            None,
        )
        opening_levels = None
        if opening_order is not None:
            entry = float(opening_order.executionPrice or 0.0)
            is_buy = opening_order.tradeData.tradeSide == model.BUY
            sl = float(opening_order.stopLoss or 0.0)
            tp = float(opening_order.takeProfit or 0.0)
            # Market orders carry relative protection (distance from the fill).
            if not sl and opening_order.relativeStopLoss and entry:
                distance = opening_order.relativeStopLoss / PRICE_SCALE
                sl = entry - distance if is_buy else entry + distance
            if not tp and opening_order.relativeTakeProfit and entry:
                distance = opening_order.relativeTakeProfit / PRICE_SCALE
                tp = entry + distance if is_buy else entry - distance
            opening_levels = SimpleNamespace(stopLoss=sl, takeProfit=tp)
        reason = self._protection_reason(position_id, float(deal.executionPrice or 0.0), closing_order, opening_levels)
        self._deal_reasons[deal_id] = reason
        return reason

    def _deal_ns(self, deal: Any) -> Any:
        symbol_id = int(deal.symbolId)
        closing = deal.HasField("closePositionDetail")
        detail = deal.closePositionDetail if closing else None
        money_digits = int((detail.moneyDigits if closing and detail.moneyDigits else deal.moneyDigits) or getattr(self._trader, "moneyDigits", 0) or 2)
        scale = 10 ** money_digits
        stamp_ms = int(deal.executionTimestamp or deal.createTimestamp or 0)
        return SimpleNamespace(
            ticket=int(deal.dealId),
            order=int(deal.orderId),
            position_id=int(deal.positionId),
            symbol=self._symbol_name(symbol_id),
            type=self.DEAL_TYPE_BUY if deal.tradeSide == model.BUY else self.DEAL_TYPE_SELL,
            entry=self.DEAL_ENTRY_OUT if closing else self.DEAL_ENTRY_IN,
            reason=self._deal_reason(deal) if closing else self.DEAL_REASON_CLIENT,
            volume=self._lots(symbol_id, deal.filledVolume or deal.volume),
            price=float(deal.executionPrice or 0.0),
            profit=(detail.grossProfit / scale) if closing else 0.0,
            swap=(detail.swap / scale) if closing else 0.0,
            commission=int(deal.commission or 0) / scale,
            comment="",
            magic=0,
            time=stamp_ms // 1000,
            time_msc=stamp_ms,
        )

    _FILLED_DEALS = {model.FILLED, model.PARTIALLY_FILLED}

    def history_deals_get(self, date_from: Any = None, date_to: Any = None, group: str | None = None, position: int | None = None, ticket: int | None = None) -> tuple | None:
        if not self._ensure_connected():
            return None
        try:
            if position is not None:
                reply = self._call_one(msg.ProtoOADealListByPositionIdReq(ctidTraderAccountId=self._account_id, positionId=int(position)))
                deals = list(reply.deal)
                with self._lock:
                    for deal in deals:
                        self._deals.setdefault(int(deal.dealId), deal)
                # Closing-order types are needed to tell SL from TP.
                closing_ids = [int(d.orderId) for d in deals if d.HasField("closePositionDetail") and int(d.orderId) not in self._hist_orders]
                if closing_ids:
                    stamps = [int(d.executionTimestamp) for d in deals]
                    self._ensure_history(min(stamps) - 60_000, max(stamps) + 60_000)
            else:
                from_ms = _to_ms(date_from) if date_from is not None else 0
                to_ms = _to_ms(date_to) if date_to is not None else int(time.time() * 1000)
                self._ensure_history(from_ms, to_ms)
                with self._lock:
                    deals = [d for d in self._deals.values() if from_ms <= int(d.executionTimestamp or 0) <= to_ms]
        except CTraderError as ex:
            self._fail(-8, f"Deal history request failed: {ex}")
            return None
        self._load_details({int(d.symbolId) for d in deals})
        with self._lock:
            rows = [d for d in deals if d.dealStatus in self._FILLED_DEALS]
            if ticket is not None:
                rows = [d for d in rows if int(d.dealId) == int(ticket)]
            rows.sort(key=lambda d: int(d.executionTimestamp or 0))
            return tuple(self._deal_ns(d) for d in rows)

    def history_orders_get(self, date_from: Any = None, date_to: Any = None, group: str | None = None, position: int | None = None, ticket: int | None = None) -> tuple | None:
        if not self._ensure_connected():
            return None
        from_ms = _to_ms(date_from) if date_from is not None else 0
        to_ms = _to_ms(date_to) if date_to is not None else int(time.time() * 1000)
        try:
            self._ensure_history(from_ms, to_ms)
        except CTraderError as ex:
            self._fail(-8, f"Order history request failed: {ex}")
            return None
        with self._lock:
            rows = []
            for order in self._hist_orders.values():
                stamp = int(order.tradeData.openTimestamp or order.utcLastUpdateTimestamp or 0)
                if not from_ms <= stamp <= to_ms:
                    continue
                if position is not None and int(order.positionId or 0) != int(position):
                    continue
                if ticket is not None and int(order.orderId) != int(ticket):
                    continue
                rows.append(order)
            return tuple(self._order_ns(o) for o in rows)

    # ------------------------------------------------------------------
    # trading
    # ------------------------------------------------------------------

    def _result(self, retcode: int, request: dict, comment: str, **fields: Any) -> Any:
        base = dict(retcode=retcode, deal=0, order=0, volume=0.0, price=0.0, bid=0.0, ask=0.0, comment=comment, request_id=0, position=0, request=request)
        base.update(fields)
        return SimpleNamespace(**base)

    def _error_result(self, request: dict, ex: CTraderError) -> Any:
        retcode = next((code for key, code in self._ERROR_RETCODES.items() if key in ex.code), self.TRADE_RETCODE_REJECT)
        self._fail(retcode, str(ex))
        return self._result(retcode, request, str(ex))

    def order_check(self, request: dict) -> Any:
        """cTrader has no dry-run endpoint: validate what can be checked locally."""
        symbol_id = self._ready_symbol(str(request.get("symbol", "")))
        if symbol_id is None:
            return self._result(self.TRADE_RETCODE_INVALID, request, self._last_error[1])
        detail = self._detail(symbol_id)
        if int(request.get("action", 0)) in {self.TRADE_ACTION_DEAL, self.TRADE_ACTION_PENDING} and "position" not in request:
            volume = self._protocol_volume(symbol_id, float(request.get("volume", 0.0) or 0.0))
            min_volume = int(getattr(detail, "minVolume", 0) or 0)
            max_volume = int(getattr(detail, "maxVolume", 0) or 0)
            if volume <= 0 or (min_volume and volume < min_volume) or (max_volume and volume > max_volume):
                return self._result(self.TRADE_RETCODE_INVALID_VOLUME, request, f"Invalid volume {request.get('volume')}")
            if detail is not None and detail.tradingMode != model.ENABLED:
                return self._result(self.TRADE_RETCODE_MARKET_CLOSED, request, "Trading is disabled for this symbol")
        return self._result(0, request, "Done")

    def order_calc_profit(self, action: int, symbol: str, volume: float, price_open: float, price_close: float) -> float | None:
        symbol_id = self._ready_symbol(symbol)
        if symbol_id is None:
            return None
        self._detail(symbol_id)
        rate = self._quote_to_deposit_rate(symbol_id)
        if rate is None:
            return None
        units = float(volume) * self._lot_size(symbol_id) / 100.0
        direction = 1.0 if int(action) in {self.ORDER_TYPE_BUY, self.ORDER_TYPE_BUY_LIMIT, self.ORDER_TYPE_BUY_STOP} else -1.0
        return round((float(price_close) - float(price_open)) * direction * units * rate, 2)

    @staticmethod
    def _execution_done(*finals: int):
        def done(payload_type: int, reply: Any) -> bool:
            return payload_type == model.PROTO_OA_EXECUTION_EVENT and reply.executionType in finals

        return done

    def _execution_failure(self, replies: list, request: dict) -> Any | None:
        for payload_type, reply in replies:
            if payload_type == model.PROTO_OA_EXECUTION_EVENT and reply.executionType in {
                model.ORDER_REJECTED,
                model.ORDER_CANCELLED,
                model.ORDER_EXPIRED,
                model.ORDER_CANCEL_REJECTED,
            }:
                code = str(reply.errorCode or model.ProtoOAExecutionType.Name(reply.executionType))
                return self._error_result(request, CTraderError(code))
        return None

    def order_send(self, request: dict) -> Any:
        request = dict(request or {})
        if not self._ensure_connected():
            return self._result(self.TRADE_RETCODE_CONNECTION, request, self._last_error[1])
        action = int(request.get("action", 0) or 0)
        try:
            if action == self.TRADE_ACTION_REMOVE:
                return self._cancel_order(request)
            if action == self.TRADE_ACTION_SLTP:
                return self._amend_position(request)
            if action == self.TRADE_ACTION_MODIFY:
                return self._amend_order(request)
            if action == self.TRADE_ACTION_DEAL and request.get("position"):
                return self._close_position(request)
            if action in {self.TRADE_ACTION_DEAL, self.TRADE_ACTION_PENDING}:
                return self._new_order(request, pending=action == self.TRADE_ACTION_PENDING)
        except CTraderError as ex:
            return self._error_result(request, ex)
        return self._result(self.TRADE_RETCODE_INVALID, request, f"Unsupported trade action {action}")

    def _relative(self, symbol_id: int, reference: float, level: float) -> int:
        digits = self._digits(symbol_id)
        step = 10 ** max(0, 5 - digits)
        return int(round(abs(reference - level) * PRICE_SCALE / step)) * step

    def _new_order(self, request: dict, pending: bool) -> Any:
        symbol_id = self._ready_symbol(str(request.get("symbol", "")))
        if symbol_id is None:
            return self._result(self.TRADE_RETCODE_INVALID, request, self._last_error[1])
        digits = self._digits(symbol_id)
        order_type = int(request.get("type", self.ORDER_TYPE_BUY))
        is_buy = order_type in {self.ORDER_TYPE_BUY, self.ORDER_TYPE_BUY_LIMIT, self.ORDER_TYPE_BUY_STOP}
        volume = self._protocol_volume(symbol_id, float(request.get("volume", 0.0) or 0.0))
        if volume <= 0:
            return self._result(self.TRADE_RETCODE_INVALID_VOLUME, request, "Volume rounds to zero")
        price = round(float(request.get("price", 0.0) or 0.0), digits)
        sl = round(float(request.get("sl", 0.0) or 0.0), digits)
        tp = round(float(request.get("tp", 0.0) or 0.0), digits)
        order = msg.ProtoOANewOrderReq(
            ctidTraderAccountId=self._account_id,
            symbolId=symbol_id,
            tradeSide=model.BUY if is_buy else model.SELL,
            volume=volume,
        )
        if request.get("comment"):
            order.comment = str(request["comment"])[:100]
        if request.get("magic"):
            order.label = str(int(request["magic"]))
        if pending:
            if order_type in {self.ORDER_TYPE_BUY_LIMIT, self.ORDER_TYPE_SELL_LIMIT}:
                order.orderType = model.LIMIT
                order.limitPrice = price
            else:
                order.orderType = model.STOP
                order.stopPrice = price
            order.timeInForce = model.GOOD_TILL_CANCEL
            if sl:
                order.stopLoss = sl
            if tp:
                order.takeProfit = tp
            replies = self._call(order, done=self._execution_done(model.ORDER_ACCEPTED, model.ORDER_REJECTED))
            failure = self._execution_failure(replies, request)
            if failure is not None:
                return failure
            event = replies[-1][1]
            order_id = int(event.order.orderId)
            spot = self._spots.get(symbol_id, {})
            return self._result(self.TRADE_RETCODE_DONE, request, "Request executed", order=order_id, volume=self._lots(symbol_id, volume), price=price, bid=spot.get("bid", 0.0), ask=spot.get("ask", 0.0))

        # Market order. Absolute SL/TP are not accepted on MARKET orders, so
        # protection rides along as a distance from the quoted price and is
        # re-pinned to the requested absolute levels if the fill slipped.
        order.orderType = model.MARKET
        if price > 0:
            if sl:
                order.relativeStopLoss = self._relative(symbol_id, price, sl)
            if tp:
                order.relativeTakeProfit = self._relative(symbol_id, price, tp)
        replies = self._call(order, done=self._execution_done(model.ORDER_FILLED, model.ORDER_REJECTED, model.ORDER_CANCELLED, model.ORDER_EXPIRED))
        failure = self._execution_failure(replies, request)
        if failure is not None:
            return failure
        event = replies[-1][1]
        position_id = int(event.position.positionId) if event.HasField("position") else 0
        fill_price = float(event.deal.executionPrice or 0.0) if event.HasField("deal") else price
        deal_id = int(event.deal.dealId) if event.HasField("deal") else 0
        if position_id and price > 0 and (sl or tp) and abs(fill_price - price) >= 10 ** -digits / 2:
            sl_ok = not sl or (sl < fill_price if is_buy else sl > fill_price)
            tp_ok = not tp or (tp > fill_price if is_buy else tp < fill_price)
            if sl_ok and tp_ok:
                try:
                    self._amend_position({"position": position_id, "sl": sl, "tp": tp, "symbol": request.get("symbol")})
                except CTraderError:
                    pass  # keep the relative levels the order was filled with
        spot = self._spots.get(symbol_id, {})
        filled_volume = int(event.deal.filledVolume) if event.HasField("deal") else volume
        return self._result(
            self.TRADE_RETCODE_DONE,
            request,
            "Request executed",
            order=position_id or int(event.order.orderId),
            deal=deal_id,
            position=position_id,
            volume=self._lots(symbol_id, filled_volume),
            price=fill_price,
            bid=spot.get("bid", 0.0),
            ask=spot.get("ask", 0.0),
        )

    def _close_position(self, request: dict) -> Any:
        position_id = int(request["position"])
        with self._lock:
            position = self._positions.get(position_id)
        if position is None:
            return self._result(self.TRADE_RETCODE_INVALID, request, f"Position {position_id} is not open")
        symbol_id = self._symbol_id_of(position)
        volume = int(position.tradeData.volume)
        if request.get("volume"):
            volume = min(volume, self._protocol_volume(symbol_id, float(request["volume"])))
        replies = self._call(
            msg.ProtoOAClosePositionReq(ctidTraderAccountId=self._account_id, positionId=position_id, volume=volume),
            done=self._execution_done(model.ORDER_FILLED, model.ORDER_REJECTED, model.ORDER_CANCELLED),
        )
        failure = self._execution_failure(replies, request)
        if failure is not None:
            return failure
        event = replies[-1][1]
        return self._result(
            self.TRADE_RETCODE_DONE,
            request,
            "Request executed",
            order=int(event.order.orderId) if event.HasField("order") else 0,
            deal=int(event.deal.dealId) if event.HasField("deal") else 0,
            position=position_id,
            volume=self._lots(symbol_id, volume),
            price=float(event.deal.executionPrice or 0.0) if event.HasField("deal") else 0.0,
        )

    def _cancel_order(self, request: dict) -> Any:
        order_id = int(request.get("order", 0) or 0)
        replies = self._call(
            msg.ProtoOACancelOrderReq(ctidTraderAccountId=self._account_id, orderId=order_id),
            done=self._execution_done(model.ORDER_CANCELLED, model.ORDER_CANCEL_REJECTED),
        )
        if replies and replies[-1][1].executionType == model.ORDER_CANCEL_REJECTED:
            return self._error_result(request, CTraderError(str(replies[-1][1].errorCode or "ORDER_CANCEL_REJECTED")))
        return self._result(self.TRADE_RETCODE_DONE, request, "Request executed", order=order_id)

    def _amend_position(self, request: dict) -> Any:
        position_id = int(request.get("position", 0) or 0)
        with self._lock:
            position = self._positions.get(position_id)
        digits = self._digits(self._symbol_id_of(position)) if position is not None else 5
        amend = msg.ProtoOAAmendPositionSLTPReq(ctidTraderAccountId=self._account_id, positionId=position_id)
        if float(request.get("sl", 0.0) or 0.0):
            amend.stopLoss = round(float(request["sl"]), digits)
        if float(request.get("tp", 0.0) or 0.0):
            amend.takeProfit = round(float(request["tp"]), digits)
        self._call(amend, done=lambda payload_type, _reply: payload_type == model.PROTO_OA_EXECUTION_EVENT)
        return self._result(self.TRADE_RETCODE_DONE, request, "Request executed", position=position_id)

    def _amend_order(self, request: dict) -> Any:
        order_id = int(request.get("order", 0) or 0)
        with self._lock:
            order = self._orders.get(order_id)
        if order is None:
            return self._result(self.TRADE_RETCODE_INVALID, request, f"Order {order_id} is not pending")
        digits = self._digits(self._symbol_id_of(order))
        amend = msg.ProtoOAAmendOrderReq(ctidTraderAccountId=self._account_id, orderId=order_id)
        if float(request.get("price", 0.0) or 0.0):
            if order.orderType == model.LIMIT:
                amend.limitPrice = round(float(request["price"]), digits)
            else:
                amend.stopPrice = round(float(request["price"]), digits)
        if float(request.get("sl", 0.0) or 0.0):
            amend.stopLoss = round(float(request["sl"]), digits)
        if float(request.get("tp", 0.0) or 0.0):
            amend.takeProfit = round(float(request["tp"]), digits)
        self._call(amend, done=self._execution_done(model.ORDER_REPLACED, model.ORDER_REJECTED))
        return self._result(self.TRADE_RETCODE_DONE, request, "Request executed", order=order_id)


ctrader = CTraderMT5()
