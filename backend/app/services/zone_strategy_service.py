from __future__ import annotations

import random
import threading
import time
from collections import deque
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from .env_utils import is_dev_mode
from .mt5_compat import mt5, mt5_available
from .mt5_lock import MT5_LOCK
from .remote_controller import remote_controller
from .runtime_state import append_log, get, patch_path
from .task_manager import is_task_running, start_task, stop_task
from .strategy_service import (
    SYMBOL_DEFAULT,
    TIMEFRAME_MAP,
    _candle_value,
    _ensure_master_session,
    _ensure_symbol_ready,
    _tick_for,
    _clone_trade_to_sub_accounts,
    _close_mt5_pending_order,
    close_all_positions,
    open_manual_position,
    stop_on_final_tp_enabled,
    wait_for_new_candle,
)

# "Scalping" strategy: watch a manually entered M15 demand/supply price level.
# Once price touches it, watch new M5 candles going forward for that *same*
# zone type (demand input -> search demand, and vice versa). Once that M5 zone
# forms, don't trade off it directly -- instead watch new M1 candles going
# forward for a zone of that same type again, confirming demand -> demand ->
# demand (or supply -> supply -> supply) before actually opening. The M1 zone
# is what actually places the MARKET/LIMIT order.
#
# Zone definition -- identical 3-candle imbalance/gap check for both M5 and
# M1, run against each timeframe's own candle buffer. Both timeframes validate
# only after c1 closes. c1 is newest, c2 is the
# one before it, and c3 is two before that (oldest of the three).
#
# Which edge of c3's body matters depends on which way c3 itself closed --
# not always the same open/close pick regardless of direction:
#   - demand gap check: bearish c3 -> its close; bullish c3 -> its open.
#   - supply gap check: bearish c3 -> its open; bullish c3 -> its close
#     (mirrored from demand).
# Call that level c3's "gap reference":
#   - demand: c1's low must be above c3's gap reference (price gapped up
#     through c2 and held above where c3's body last offered support).
#   - supply: c1's high must be below c3's gap reference (mirrored: gapped
#     down through c2 and held below where c3's body last offered
#     resistance).
#
# c2 also has to have actually retraced back onto a c3 level before the c1
# breakout counts, otherwise c1's gap could be jumping clean over a c3 that
# was never retested. The touch reference is c3's gap reference itself:
#   - demand: c2's low must touch (reach down to, or through) bullish c3's
#     open / bearish c3's close.
#   - supply: c2's high must touch (reach up to, or through) bullish c3's
#     close / bearish c3's open -- the top of c3's body either way.
#
# Two zone types are checked automatically on both M5 and M1: Type 1 first,
# and Type 2 only if Type 1 does not match:
#   - Type 1: everything above -- c2 must retest c3's gap reference.
#   - Type 2: no c2 retest. Only c1 matters: it must stay entirely clear of
#     c3's body -- demand: c1's low above the top of c3's body (max of open/
#     close); supply: c1's high below the bottom of c3's body (min of
#     open/close). So c1 never touches c3's open or close, whichever way c3
#     closed.
#
# The zone box itself is drawn on c3 alone: demand from c3's low up to its
# gap reference, supply from its gap reference up to c3's high. M5 zones only:
# if c2's low is below c3's low (demand) / c2's high is above c3's high
# (supply), the box extends to c2's extreme, and that is the level whose
# breach invalidates the zone. M1 zones stay on c3 alone.
#
# The M5 buffer is cleared when the M15 trigger fires, and the M1 buffer when
# the M5 zone forms. Each stage keeps its own timeframe's candles separate.
# Two shortcuts keep the last closed candle as c3, so only two new candles
# are needed instead of three:
#   - after an M5 zone breach, for the fresh M5 search;
#   - after a position on this side hits SL, for the next M1 entry on the
#     same, still-valid M5 zone. Here c3 is the M1 candle the SL hit in
#     (from the SL deal's broker time), not whichever candle was last closed
#     when the close was noticed.
#
# The demand side and the supply side are armed independently (two engine
# instances below) so both can be watching -- and can both fire -- at once.
#
# Stoploss is always anchored on a real M1 candle low (BUY) / high (SELL):
#   - The reference is c2's low/high only when c2 goes beyond c3 (demand: c2
#     low below c3 low; supply: c2 high above c3 high); otherwise it is c3's
#     own low/high. Walk backward from there one candle at a time. Take the
#     first candle whose low is below the reference (BUY) / whose high is
#     above it (SELL) by at least
#     the user's "Liquidity SL (pips)" minimum, and that is also at least the
#     global "min SL" from entry. The stop sits on that candle's low/high;
#     the user's "Spread (pips)" is then added beyond it, the same way Manual
#     Trade applies its spread.
#
# Order type is chosen per trade from that SL (measured from the market
# price, spread included):
#   - SL <= "Max SL (pips)" (or Max SL unset): MARKET order.
#   - SL >  "Max SL (pips)": LIMIT order. The entry moves toward the SL by
#     "Limit %" of the SL distance while the SL stays put, e.g. a 100 pip SL
#     with 40% becomes a limit 40 pips better than market with a 60 pip SL.
#     If the M5 zone breaks before the limit fills, the limit is cancelled.
#
# A position closed by its final TP (the broker TP -- partial TP1/TP2
# withdrawals are closed by the app and don't count) ends the session: both
# sides' searches stop and every open position on the symbol is closed.
# With "Stop on final TP" turned off in Settings, a final TP is handled like
# any other TP/SL close instead: the search keeps going and nothing is closed.
#   - Candles that fail either minimum are skipped and the walk continues to
#     the next deeper low/high. Only if no candle in the lookback qualifies
#     does the stop fall back to entry -/+ min SL.

TRIGGER_TASK_NAME = "zone_trigger_watch"
SEARCH_M5_TASK_NAME = "zone_m5_watch"
SEARCH_M1_TASK_NAME = "zone_m1_watch"

CANDLE_BUFFER_MAXLEN = 12
SL_LIQUIDITY_LOOKBACK_CANDLES = 1000
DEFAULT_TRIGGER_CHECK_CYCLE_SEC = 60.0
# Both searches poll every second and pick up each candle the moment MT5
# publishes it. MT5 only creates a new bar on the first tick after the
# boundary, so a single read exactly on the minute often still sees the
# previous bar -- with a 60s poll that delayed the M1 entry by a full minute.
M1_SEARCH_INTERVAL_SEC = 1.0
M5_SEARCH_INTERVAL_SEC = 1.0
# Closed candles re-read per poll so a late read never skips a bar.
CLOSED_CANDLE_CATCHUP = 5
# Re-read after a longer stall, back to the last processed candle.
CLOSED_CANDLE_MAX_CATCHUP = 300
# Polls to wait for the closing deal to reach history after a position
# disappears, before treating the close as manual.
EXIT_REASON_GRACE_POLLS = 10
# _closing_reason result when deal history can't be read (terminal down):
# the exit watcher must wait, not treat the close as manual.
CLOSE_REASON_UNREADABLE = "UNREADABLE"
_end_close_lock = threading.Lock()
_last_end_close_at = float("-inf")
# Symbol/session problems are the same for both sides; report each once
# (keyed by check kind) instead of once per side, every poll.
_symbol_error_lock = threading.Lock()
_reported_symbol_errors: dict[str, Optional[str]] = {}


class _SearchStopped(RuntimeError):
    pass


def _next_candle_open(timeframe_minutes: int, after: datetime | None = None) -> datetime:
    """Return the next candle boundary at or after the requested start time."""
    now = datetime.now()
    anchor = after if after is not None and after > now else now
    interval_seconds = max(1, int(timeframe_minutes)) * 60
    timestamp = anchor.timestamp()
    boundary = (int(timestamp // interval_seconds) + 1) * interval_seconds
    return datetime.fromtimestamp(boundary)


def _is_bullish(candle: Any) -> bool:
    return _candle_value(candle, 4, "close") > _candle_value(candle, 1, "open")


# wait_for_new_candle()'s simulated/dev-mode branch only carries open/close --
# no other caller has ever needed high/low from it. Zone detection needs the
# full candle range, so dev mode gets its own small synthetic M1/M5 generator
# here rather than changing that shared helper (which the existing
# pips-breakout strategy also relies on).
_sim_state: dict[str, dict[str, Any]] = {}
_sim_lock = threading.Lock()


def _sim_next_candle(symbol: str, timeframe_label: str) -> Optional[dict[str, Any]]:
    """Latest synthetic candle -- a new one each second.

    One shared market feed: every caller in the same second gets the same
    candle, so the demand and supply engines see identical candles (each
    filters out what it already has by time). Handing each candle only to
    the first caller left the other side with none.
    """
    key = f"zone:{timeframe_label}:{symbol}"
    with _sim_lock:
        return _sim_generate_locked(key, symbol)


def _sim_generate_locked(key: str, symbol: str) -> dict[str, Any]:
    now_ts = int(time.time())
    state = _sim_state.get(key)
    if state is not None and now_ts <= state["last_ts"]:
        return state["candle"]
    rng = random.Random(f"{key}:{now_ts}")
    prior_close = state["close"] if state is not None else float(_tick_for(symbol).bid)
    # Roughly one in four candles is a strong displacement so an armed demo
    # strategy actually finds a zone within a handful of seconds.
    is_displacement = now_ts % 4 == 0
    body_pips = rng.uniform(20.0, 35.0) if is_displacement else rng.uniform(2.0, 8.0)
    direction = 1 if rng.random() < 0.5 else -1
    open_price = prior_close
    close_price = round(open_price + direction * body_pips / 10.0, 2)
    wick = rng.uniform(0.05, 0.2)
    high_price = round(max(open_price, close_price) + wick, 2)
    low_price = round(min(open_price, close_price) - wick, 2)
    candle = {"time": now_ts, 1: open_price, 2: high_price, 3: low_price, 4: close_price}
    _sim_state[key] = {"last_ts": now_ts, "close": close_price, "candle": candle}
    return candle


def _next_candle(symbol: str, timeframe_label: str) -> Optional[dict[str, Any]]:
    if mt5_available():
        # Same lazy in-process connect the trigger check needs -- without it,
        # a search armed straight into M5 (instant start) or entered before
        # anything else this process has touched MT5 with would just poll
        # None forever.
        _ensure_master_session()
        return wait_for_new_candle(TIMEFRAME_MAP[timeframe_label], symbol=symbol)
    return _sim_next_candle(symbol, timeframe_label)


class ZoneStrategyEngine:
    def __init__(self, side: str) -> None:
        self.side = side
        self._trigger_task_name = f"{TRIGGER_TASK_NAME}_{side}"
        self._scheduled_m5_task_name = f"{TRIGGER_TASK_NAME}_m5_start_{side}"
        self._search_m5_task_name = f"{SEARCH_M5_TASK_NAME}_{side}"
        self._search_m1_task_name = f"{SEARCH_M1_TASK_NAME}_{side}"
        self._exit_task_name = f"zone_exit_watch_{side}"
        self._end_task_name = f"zone_end_time_{side}"
        self._state_path = f"zone_strategy.{side}"
        self._lock = threading.Lock()
        # Set by stop() so a search tick already in flight (e.g. while Close
        # All runs) cannot restart a stage or send an order afterwards.
        self._stopped = True
        self._reset_config()

    def _reset_config(self) -> None:
        self.symbol: str = SYMBOL_DEFAULT
        self.trigger_price: float = 0.0
        self.trigger_zone_type: str = self.side
        self.m5_target_zone_type: str = self.side
        self.m1_target_zone_type: str = self.side
        self.instant_m5_start: bool = False
        self.dev_m1_start: bool = False
        self.trigger_check_cycle_sec: float = DEFAULT_TRIGGER_CHECK_CYCLE_SEC
        # Optional scheduling window, like the Search page's Start/End Time:
        # start_time delays the very first check (the M15 trigger watch, or
        # the M5/M1 search directly when instant/dev-start skip ahead of it);
        # end_time fires its own one-shot timer (_end_task_name) at exactly
        # that moment, whichever stage is active -- see _on_scheduled_end.
        self.start_time: Optional[datetime] = None
        self.end_time: Optional[datetime] = None
        self.manual_sl_distance: float = 0.0
        self.sl_distance_in_pips: bool = True
        self.liquidity_buffer_pips: float = 0.0
        # Added beyond the SL like Manual Trade's spread field.
        self.spread_pips: float = 0.0
        # Chosen per trade in _place_order from max_sl_pips / limit_percent.
        self.order_kind: str = "AUTO"
        self.max_sl_pips: float = 0.0
        self.limit_percent: float = 0.0
        # 5-minute zones measuring more than this from their extreme (c3 or
        # c2 low/high) to c3's close are skipped; 0 = no limit.
        self.max_zone_pips: float = 0.0
        self.lot: Optional[float] = None
        self.risk_percent: Optional[float] = None
        # Take-profit is always ratio-based here (same mechanism as manual
        # trade's Multi-TP), never a flat pip amount -- the stop that the
        # ratios multiply against is the one this engine itself computes in
        # _place_order (liquidity swing vs. manual SL floor), not a
        # separately entered price, since scalping never has a user-typed SL.
        self.tp1_ratio: float = 1.0
        self.tp2_ratio: float = 1.0
        self.tp3_ratio: float = 1.0
        self.tp2_enabled: bool = False
        self.tp3_enabled: bool = False
        self.tp1_percent: float = 100.0
        self.tp2_percent: float = 100.0
        self.m5_buffer: deque = deque(maxlen=CANDLE_BUFFER_MAXLEN)
        self.m1_buffer: deque = deque(maxlen=CANDLE_BUFFER_MAXLEN)
        self._last_processed_candle_time: dict[str, int] = {"M1": 0, "M5": 0}
        self.last_mid: Optional[float] = None
        self.confirmation_level: Optional[float] = None
        # The M5 zone the M1 search is currently confirming against, kept
        # here (not just in the patched runtime state) so the M1 search loop
        # can check live price against it every tick.
        self.m5_zone: Optional[dict[str, Any]] = None
        self._exit_position_keys: set[str] = set()
        self._exit_position_seen = False
        self._exit_monitor_attempts = 0
        self._exit_missing_polls = 0
        self._exit_levels: dict[str, Any] = {}
        # Set when the trade's M5 zone breaks while the position is still
        # open: a fresh M5 search is already running, so the exit watcher
        # must neither re-check the old zone nor restart the search on close.
        self._search_resumed_during_trade = False
        # Broker time of the last SL fill, set by _closing_reason.
        self._sl_deal_time: Optional[int] = None

    def start(self, cfg: dict) -> None:
        manual_sl_distance = float(cfg.get("manual_sl_distance", 0) or 0)
        if manual_sl_distance <= 0:
            raise RuntimeError("Enter a manual stoploss distance greater than 0.")
        if float(cfg.get("tp1_ratio") or 0) <= 0:
            raise RuntimeError("TP1 ratio must be greater than 0.")
        if bool(cfg.get("tp2_enabled", False)) and float(cfg.get("tp2_ratio") or 0) <= 0:
            raise RuntimeError("TP2 ratio must be greater than 0.")
        if (
            bool(cfg.get("tp2_enabled", False))
            and bool(cfg.get("tp3_enabled", False))
            and float(cfg.get("tp3_ratio") or 0) <= 0
        ):
            raise RuntimeError("TP3 ratio must be greater than 0.")
        instant_m5_start = bool(cfg.get("instant_m5_start", False))
        # Dev-only shortcut: skip the M15 trigger *and* the M5 zone entirely
        # and drop straight into the M1 search, so the order-placement logic
        # can be tested without waiting for the M15 and M5 stages.
        dev_m1_start = bool(cfg.get("dev_m1_start", False))
        trigger_price = float(cfg.get("trigger_price", 0) or 0)
        if not instant_m5_start and not dev_m1_start and trigger_price <= 0:
            raise RuntimeError("Enter a valid trigger price.")
        # Trigger verification runs once per M1 candle. Keep accepting the old
        # config field for API compatibility, but ignore custom intervals.
        trigger_check_cycle_sec = DEFAULT_TRIGGER_CHECK_CYCLE_SEC
        # MARKET vs LIMIT is decided per trade from the SL size; the old
        # order_kind field is accepted but ignored.
        order_kind = "AUTO"
        max_sl_pips = max(0.0, float(cfg.get("max_sl_pips", 0) or 0))
        limit_percent = float(cfg.get("limit_percent", 0) or 0)
        if max_sl_pips > 0 and not 0 < limit_percent < 100:
            raise RuntimeError("Limit % must be between 0 and 100 when Max SL is set.")
        max_zone_pips = float(cfg.get("max_zone_pips", 0) or 0)
        if max_zone_pips < 0:
            raise RuntimeError("Max demand/supply pips cannot be negative.")
        cfg_start_time = cfg.get("start_time")
        start_time = cfg_start_time if isinstance(cfg_start_time, datetime) else None
        cfg_end_time = cfg.get("end_time")
        end_time = cfg_end_time if isinstance(cfg_end_time, datetime) else None
        if end_time is not None and start_time is not None and end_time <= start_time:
            raise RuntimeError("End time must be later than start time.")
        if end_time is not None and end_time <= datetime.now():
            raise RuntimeError("End time must be in the future.")

        stop_task(self._trigger_task_name)
        stop_task(self._scheduled_m5_task_name)
        stop_task(self._search_m5_task_name)
        stop_task(self._search_m1_task_name)
        stop_task(self._exit_task_name)
        stop_task(self._end_task_name)
        self._stopped = False

        with self._lock:
            self._reset_config()
            self.symbol = str(cfg.get("symbol") or SYMBOL_DEFAULT).strip().upper()
            self.trigger_price = trigger_price
            self.instant_m5_start = instant_m5_start
            self.dev_m1_start = dev_m1_start
            self.trigger_check_cycle_sec = trigger_check_cycle_sec
            self.manual_sl_distance = manual_sl_distance
            self.sl_distance_in_pips = bool(cfg.get("sl_distance_in_pips", True))
            # "Liquidity SL (pips)": the minimum distance between c3's
            # low/high and the liquidity candle's low/high (field name kept
            # for API compatibility).
            self.liquidity_buffer_pips = max(0.0, float(cfg.get("liquidity_buffer_pips", 0) or 0))
            self.spread_pips = max(0.0, float(cfg.get("spread_pips", 0) or 0))
            self.order_kind = order_kind
            self.max_sl_pips = max_sl_pips
            self.limit_percent = limit_percent
            self.max_zone_pips = max_zone_pips
            self.lot = cfg.get("lot")
            # Risk comes from each account's own Risk % setting
            # (open_manual_position falls back to the master's when None).
            self.risk_percent = None
            self.tp1_ratio = float(cfg.get("tp1_ratio") or 1.0)
            self.tp2_ratio = float(cfg.get("tp2_ratio") or 1.0)
            self.tp3_ratio = float(cfg.get("tp3_ratio") or 1.0)
            self.tp2_enabled = bool(cfg.get("tp2_enabled", False))
            self.tp3_enabled = bool(cfg.get("tp3_enabled", False)) and self.tp2_enabled
            self.tp1_percent = float(cfg.get("tp1_percent") or 100.0)
            self.tp2_percent = float(cfg.get("tp2_percent") or 100.0)
            self.start_time = start_time
            self.end_time = end_time

        started_at = datetime.now().isoformat()
        instant = self.instant_m5_start
        dev_m1 = self.dev_m1_start
        scheduled_instant_start = bool(instant and start_time and start_time > datetime.now())
        phase = (
            "searching_m1_zone" if dev_m1 else
            "scheduled_m5_start" if scheduled_instant_start else
            "searching_m5_zone" if instant else
            "waiting_trigger"
        )
        patch_path(
            self._state_path,
            {
                "running": True,
                "phase": phase,
                "symbol": self.symbol,
                "trigger_price": self.trigger_price,
                "trigger_zone_type": self.trigger_zone_type,
                "m5_target_zone_type": self.m5_target_zone_type,
                "m1_target_zone_type": self.m1_target_zone_type,
                "order_kind": self.order_kind,
                "max_sl_pips": self.max_sl_pips,
                "limit_percent": self.limit_percent,
                "max_zone_pips": self.max_zone_pips,
                "instant_m5_start": instant,
                "dev_m1_start": dev_m1,
                "trigger_check_cycle_sec": self.trigger_check_cycle_sec,
                "manual_sl_distance": self.manual_sl_distance,
                "sl_distance_in_pips": self.sl_distance_in_pips,
                "liquidity_buffer_pips": self.liquidity_buffer_pips,
                "spread_pips": self.spread_pips,
                "lot": self.lot,
                "risk_percent": self.risk_percent,
                "tp1_ratio": self.tp1_ratio,
                "tp2_ratio": self.tp2_ratio,
                "tp3_ratio": self.tp3_ratio,
                "tp2_enabled": self.tp2_enabled,
                "tp3_enabled": self.tp3_enabled,
                "tp1_percent": self.tp1_percent,
                "tp2_percent": self.tp2_percent,
                "start_time": self.start_time.isoformat() if self.start_time else None,
                "end_time": self.end_time.isoformat() if self.end_time else None,
                "started_at": started_at,
                "triggered_at": started_at if (instant or dev_m1) else None,
                "confirmation_level": None,
                "m5_zone": None,
                "m1_zone": None,
                "last_breached_m5_zone": None,
                "sl_liquidity_price": None,
                "sl_liquidity_pips": None,
                "placed_order": None,
                "last_stop_reason": None,
                "last_error": None,
                "stopped_at": None,
            },
        )
        if self.end_time:
            # A one-shot timer at End Time itself. Stage timers only check
            # on their own cadence (60s while waiting for the M15 trigger),
            # which made the stop late.
            start_task(
                self._end_task_name,
                self._on_scheduled_end,
                interval_sec=60,
                start_time=self.end_time,
                log_schedule=False,
            )
        if dev_m1:
            append_log(
                "search",
                f"[INFO] [scalping:{self.side}] armed on {self.symbol} -- DEV 1-min test, "
                f"skipping the M15 trigger and M5 zone, searching M1 directly.",
            )
            self._seed_buffer(self.m1_buffer, "M1", preload_count=0)
            with self._lock:
                self.m5_zone = None
            start_task(
                self._search_m1_task_name,
                self._search_m1_tick,
                interval_sec=M1_SEARCH_INTERVAL_SEC,
                start_time=datetime.now(),
            )
        elif instant:
            scheduled_start = self.start_time if self.start_time and self.start_time > datetime.now() else None
            if scheduled_start:
                append_log(
                    "search",
                    f"[INFO] [scalping:{self.side}] Instant M5 start is scheduled for "
                    f"{scheduled_start.strftime('%Y-%m-%d %H:%M:%S')}; waiting until then.",
                )
                start_task(
                    self._scheduled_m5_task_name,
                    self._begin_scheduled_m5_search,
                    interval_sec=1,
                    start_time=scheduled_start,
                )
            else:
                append_log(
                    "search",
                    f"[INFO] [scalping:{self.side}] armed on {self.symbol} -- instant M5 start, "
                    f"skipping the M15 trigger.",
                )
                self._start_m5_search()
        else:
            # Anchor the first check to the next M1 candle open instead of
            # "now" (or the user's chosen start_time, whichever is later) --
            # starting immediately on click would offset every future poll by
            # however many seconds were left in the current minute, so checks
            # would keep landing mid-candle instead of right as each fresh M1
            # bar opens.
            next_candle_open = _next_candle_open(1, self.start_time)
            append_log(
                "search",
                f"[INFO] [scalping:{self.side}] armed on {self.symbol} @ {self.trigger_price:.2f}, "
                f"checking every 60s from {next_candle_open.strftime('%Y-%m-%d %H:%M:%S')}.",
            )
            start_task(
                self._trigger_task_name,
                self._trigger_tick,
                interval_sec=DEFAULT_TRIGGER_CHECK_CYCLE_SEC,
                start_time=next_candle_open,
            )

    def stop(self, reason: str = "Manual stop requested.") -> None:
        self._stopped = True
        was_running = (
            is_task_running(self._trigger_task_name)
            or is_task_running(self._scheduled_m5_task_name)
            or is_task_running(self._search_m5_task_name)
            or is_task_running(self._search_m1_task_name)
            or is_task_running(self._exit_task_name)
        )
        stop_task(self._trigger_task_name)
        stop_task(self._scheduled_m5_task_name)
        stop_task(self._search_m5_task_name)
        stop_task(self._search_m1_task_name)
        stop_task(self._exit_task_name)
        stop_task(self._end_task_name)
        if was_running or bool(get(self._state_path, {}).get("running")):
            patch_path(self._state_path, {
                "running": False,
                "phase": "stopped",
                "last_stop_reason": reason,
                # Broker time the chart freezes this run's zone boxes at.
                "stopped_at": self._broker_time(),
            })
            append_log("search", f"[WARNING] [scalping:{self.side}] {reason}")
        else:
            patch_path(self._state_path, {"running": False})

    def _broker_time(self) -> Optional[int]:
        """Latest MT5 quote time (broker clock), or this machine's clock in
        simulation. None if MT5 can't be read right now."""
        if not mt5_available():
            return int(time.time())
        try:
            with MT5_LOCK:
                tick = mt5.symbol_info_tick(self.symbol)
        except Exception:
            return None
        stamp = int(getattr(tick, "time", 0) or 0) if tick is not None else 0
        return stamp or None

    def _broker_clock_offset(self) -> int:
        """Seconds the broker's candle clock runs ahead of this machine's.

        MT5 stamps candles in server time (often UTC+2/+3), not real UTC.
        Rounded to the nearest half hour so a quote a few minutes old (quiet
        market) still gives the whole-hour server offset. 0 in simulation or
        when MT5 can't be read.
        """
        stamp = self._broker_time()
        if not mt5_available() or not stamp:
            return 0
        return int(round((stamp - time.time()) / 1800.0)) * 1800

    def _begin_scheduled_m5_search(self) -> None:
        # start_task normally repeats callbacks. This is an arm timer, so
        # remove it before handing control to the recurring M5 candle task.
        stop_task(self._scheduled_m5_task_name)
        if self._stopped:
            return
        patch_path(self._state_path, {
            "phase": "searching_m5_zone",
            "running": True,
            "triggered_at": datetime.now().isoformat(),
        })
        self._start_m5_search()

    def _on_scheduled_end(self) -> None:
        """Fired by this side's one-shot End Time timer.

        Stop the search first (so nothing new opens), then close whatever is
        open on this symbol -- a plain close-all, same as the Search page's
        End Time. Both sides usually share one End Time: the first to fire
        does the close-all and the second skips it, so the feed shows one
        close instead of a duplicate "nothing to close" line.
        """
        stop_task(self._end_task_name)
        end_label = self.end_time.strftime("%Y-%m-%d %H:%M:%S") if self.end_time else "End time"
        self.stop(f"End time {end_label} reached; search stopped.")
        _close_all_once(
            self.symbol,
            f"[WARNING] [scalping] End time {end_label} reached; closing {self.symbol} positions.",
        )

    def _ensure_symbol_or_log(self, require_fresh_quote: bool = True) -> bool:
        """Guard MT5 calls, with quote freshness required only for live prices.

        The main API process's MT5 module starts out disconnected -- only
        _ensure_master_session() (mt5.initialize() with the master account's
        saved credentials) brings it up *in this process*, separately from
        the adapter subprocess used for chart data. Skipping that call means
        symbol_info()/copy_rates_from_pos() return None with no exception,
        which _ensure_symbol_ready() alone misreports as "symbol not found"
        rather than "not connected yet". Report the reason once, not every
        cycle, so a persistent failure doesn't spam the feed.
        """
        session_ok, session_detail, _master, _cfg = _ensure_master_session()
        self._report_symbol_state("session", None if session_ok else session_detail)
        if not session_ok:
            return False

        ok, detail = _ensure_symbol_ready(
            self.symbol,
            require_fresh_quote=require_fresh_quote,
        )
        # The candle check (no fresh quote needed) and the live-price check
        # run in the same poll. Tracking them separately stops a passing
        # candle check from clearing -- and so re-logging every second -- a
        # stale-price error the price check keeps hitting.
        self._report_symbol_state("quote" if require_fresh_quote else "candles", None if ok else detail)
        return ok

    def _report_symbol_state(self, kind: str, error: Optional[str]) -> None:
        """Log a symbol/session problem once when it starts (shared by both
        sides) and once when it clears."""
        key = f"{self.symbol}:{kind}"
        with _symbol_error_lock:
            previous = _reported_symbol_errors.get(key)
            if previous == error:
                return
            _reported_symbol_errors[key] = error
        if error:
            append_log("search", f"[ERROR] [scalping] {error}")
        elif previous:
            append_log("search", f"[INFO] [scalping] {self.symbol} {kind} OK again.")

    def _m15_amount_touched(self, trigger_price: float) -> bool:
        """Has price reached the typed amount at any point since the last check?

        This reads a window of M1 candles wide enough to cover the gap since
        the previous poll (sized off `trigger_check_cycle_sec`), not the
        currently-forming M15 candle -- an M15 bar resets every 15 minutes,
        so a touch just before that boundary would otherwise be forgotten the
        moment a fresh M15 candle opens, even though price never actually
        moved back to it. Checking a rolling M1 window has no such reset.
        """
        if mt5_available():
            if not self._ensure_symbol_or_log(require_fresh_quote=False):
                return False
            lookback = max(2, int(self.trigger_check_cycle_sec // 60) + 2)
            try:
                rates = mt5.copy_rates_from_pos(self.symbol, TIMEFRAME_MAP["M1"], 0, lookback)
            except Exception:
                rates = None
            if rates is None or len(rates) == 0:
                return False
            highs = [float(_candle_value(c, 2, "high")) for c in rates]
            lows = [float(_candle_value(c, 3, "low")) for c in rates]
            return min(lows) <= trigger_price <= max(highs)

        # No real M1 feed in dev/sim mode -- fall back to the live simulated
        # tick crossing the level between polls.
        tick = _tick_for(self.symbol)
        if tick is None:
            return False
        mid = (float(tick.ask) + float(tick.bid)) / 2.0
        with self._lock:
            last_mid = self.last_mid
            self.last_mid = mid
        return last_mid is not None and (last_mid - trigger_price) * (mid - trigger_price) <= 0

    def _capture_m1_confirmation_level(self, is_supply: bool) -> Optional[float]:
        """Last *closed* M1 candle's high (supply) / low (demand).

        Fetched once, right when the M15 amount is first reached, and then
        held fixed -- it's the fakeout filter the amount touch has to clear,
        not a level that keeps sliding with the newest candle.
        """
        if mt5_available():
            if not self._ensure_symbol_or_log(require_fresh_quote=False):
                return None
            try:
                rates = mt5.copy_rates_from_pos(self.symbol, TIMEFRAME_MAP["M1"], 1, 1)
            except Exception:
                rates = None
            if rates is None or len(rates) == 0:
                return None
            candle = rates[0]
        else:
            candle = _sim_next_candle(self.symbol, "M1")
            if candle is None:
                return None
        return float(_candle_value(candle, 2, "high")) if is_supply else float(_candle_value(candle, 3, "low"))

    def _current_price(self) -> Optional[float]:
        if mt5_available():
            with MT5_LOCK:
                if not self._ensure_symbol_or_log():
                    return None
                tick = mt5.symbol_info_tick(self.symbol)
        else:
            tick = _tick_for(self.symbol)
        if tick is None:
            return None
        return (float(tick.ask) + float(tick.bid)) / 2.0

    def _trigger_tick(self) -> None:
        # Runs once per minute. Two-step gate: first wait for the typed M15 amount to actually
        # be touched, then capture the M1 confirmation level and only fire
        # once live price breaks past *that* level on a later cycle.
        #
        # Wrapped in MT5_LOCK (the same process-wide lock every other MT5
        # touchpoint in the app uses -- see strategy_service._mt5_session_locked)
        # for the whole tick: the demand and supply engines each run their own
        # independent threading.Timer chain, so with both sides armed at once
        # their ticks genuinely execute concurrently on separate threads.
        # MetaTrader5's Python API is one process-wide connection, not
        # thread-safe for concurrent calls, so without this lock the two
        # sides' unlocked mt5.* reads (copy_rates_from_pos, symbol_info_tick)
        # could interleave and corrupt/stall each other -- in practice this
        # showed up as only one side's search ever actually finding candles
        # while the other silently stalled.
        with MT5_LOCK:
            with self._lock:
                trigger_price = self.trigger_price
                confirmation_level = self.confirmation_level
                side = self.side

            if confirmation_level is None:
                if not self._m15_amount_touched(trigger_price):
                    return
                confirmation_level = self._capture_m1_confirmation_level(side == "supply")
                if confirmation_level is None:
                    return
                with self._lock:
                    self.confirmation_level = confirmation_level
                patch_path(self._state_path, {"confirmation_level": confirmation_level})
                append_log(
                    "search",
                    f"[INFO] [scalping:{side}] {trigger_price:.2f} touched, confirming vs M1 "
                    f"{'high' if side == 'supply' else 'low'} {confirmation_level:.2f}.",
                )
                return

            price = self._current_price()
            if price is None:
                return
            broke = price > confirmation_level if side == "supply" else price < confirmation_level
            if not broke:
                return

            stop_task(self._trigger_task_name)
            if self._stopped:
                return
            triggered_at = datetime.now().isoformat()
            patch_path(self._state_path, {"phase": "searching_m5_zone", "triggered_at": triggered_at})
            append_log(
                "search",
                f"[INFO] [scalping:{self.side}] M15 confirmed @ {price:.2f}, searching M5.",
            )
            self._start_m5_search()

    def _seed_buffer(self, buffer: deque, timeframe_label: str, preload_count: int = 2) -> None:
        """Reset `buffer` and set its closed-candle timestamp anchor.

        M5 can preload its last three closed candles and check them immediately
        when that stage starts. M1 starts empty so its confirmation still
        requires three newly closed candles.

        The timestamp anchor prevents a candle that closed before this search
        stage started from counting as one of its new candles. MT5 rates arrive
        oldest-first, which is the order _detect_gap_zone_locked expects.
        """
        history: list[Any] = []
        latest_closed_time = 0
        if mt5_available():
            # MT5_LOCK here (not just from the tick handlers that usually
            # call this) since start() also calls this directly from the API
            # request thread -- see _trigger_tick's comment on why every
            # MT5 touchpoint needs it. Reentrant, so no deadlock when a tick
            # handler that already holds it calls in here too.
            with MT5_LOCK:
                # Same lazy in-process connect every other MT5 call here needs --
                # see _ensure_symbol_or_log's docstring.
                _ensure_master_session()
                try:
                    rates = mt5.copy_rates_from_pos(
                        self.symbol,
                        TIMEFRAME_MAP[timeframe_label],
                        1,
                        max(1, preload_count),
                    )
                except Exception:
                    rates = None
                if rates is not None:
                    latest = list(rates)
                    if latest:
                        latest_closed_time = int(latest[-1]["time"])
                    history = latest[-preload_count:] if preload_count else []
        with self._lock:
            buffer.clear()
            for candle in history:
                buffer.append(candle)
            self._last_processed_candle_time[timeframe_label] = (
                int(history[-1]["time"]) if history else latest_closed_time
            )

    def _new_closed_candles(self, timeframe_label: str) -> list[Any]:
        """Return every candle that closed since the last call, oldest first.

        Reading only the latest closed bar could skip one: right after a
        boundary MT5 keeps serving the previous bar until the first tick of
        the new one, so a read that lands late already sees a bar further on
        and the one in between is never checked. Re-reading the last few
        closed bars and filtering on the broker timestamp keeps c3/c2/c1
        consecutive.
        """
        if not mt5_available():
            candle = _next_candle(self.symbol, timeframe_label)
            if candle is None:
                return []
            # The sim feed repeats its latest candle until the next second;
            # this engine's own anchor decides whether it's new to this side.
            with self._lock:
                if int(candle["time"]) <= self._last_processed_candle_time[timeframe_label]:
                    return []
                self._last_processed_candle_time[timeframe_label] = int(candle["time"])
            return [candle]
        # Serialize only the MT5 calls. Holding this process-wide lock for the
        # whole search tick made the demand and supply workers wait on each
        # other's buffer checks and state transitions too.
        with self._lock:
            known = self._last_processed_candle_time[timeframe_label]
        with MT5_LOCK:
            if not self._ensure_symbol_or_log(require_fresh_quote=False):
                return []
            try:
                rates = mt5.copy_rates_from_pos(
                    self.symbol, TIMEFRAME_MAP[timeframe_label], 1, CLOSED_CANDLE_CATCHUP
                )
                if rates is not None and len(rates) > 0 and 0 < known < int(rates[0]["time"]):
                    # Stalled longer than the normal re-read: reach back to
                    # the last processed candle, or the ones in between would
                    # be lost and c3/c2/c1 would join non-adjacent bars.
                    rates = mt5.copy_rates_from_pos(
                        self.symbol, TIMEFRAME_MAP[timeframe_label], 1, CLOSED_CANDLE_MAX_CATCHUP
                    )
            except Exception:
                return []
        if rates is None or len(rates) == 0:
            return []
        with self._lock:
            anchor = self._last_processed_candle_time[timeframe_label]
            if anchor <= 0:
                # No seed anchor: never replay history as new candles.
                fresh = [rates[-1]]
            else:
                fresh = [candle for candle in rates if int(candle["time"]) > anchor]
            if fresh:
                self._last_processed_candle_time[timeframe_label] = int(fresh[-1]["time"])
        return fresh

    def _live_quote(self) -> tuple[Optional[float], list[Any]]:
        """Mid price plus the last closed and the forming M1 bars.

        The forming bar's low/high covers every tick since the minute opened,
        so a breach wick between one-second polls is still caught. Its time is
        broker time, the same clock the chart uses to freeze a breached box.
        """
        if not mt5_available():
            tick = _tick_for(self.symbol)
            return (float(tick.ask) + float(tick.bid)) / 2.0, []
        with MT5_LOCK:
            if not self._ensure_symbol_or_log():
                return None, []
            tick = mt5.symbol_info_tick(self.symbol)
            try:
                bars = mt5.copy_rates_from_pos(self.symbol, TIMEFRAME_MAP["M1"], 0, 2)
            except Exception:
                bars = None
        price = (float(tick.ask) + float(tick.bid)) / 2.0 if tick is not None else None
        return price, list(bars) if bars is not None else []

    def _start_m5_search(
        self,
        fresh: bool = False,
        keep_last_closed: bool = False,
        announce: bool = True,
    ) -> None:
        """`fresh` waits for newly closed M5 candles only. `keep_last_closed`
        (used after a breach) keeps the last closed candle as a possible c3,
        so a new zone needs two new candles instead of three."""
        if self._stopped:
            return
        # Evaluate the latest completed M5 pattern as soon as this stage starts.
        # C1 must be closed: checking a forming bar early shifts the apparent
        # C1/C2 labels when the bar finally closes.
        self._seed_buffer(
            self.m5_buffer,
            "M5",
            preload_count=(1 if keep_last_closed else 0) if fresh else 3,
        )
        if announce:
            append_log(
                "search",
                f"[INFO] [scalping:{self.side}] Started searching for a new 5-minute zone.",
            )
        # Read before taking self._lock: _broker_time takes MT5_LOCK, which
        # is always acquired before self._lock elsewhere.
        clock_offset = self._broker_clock_offset()
        with self._lock:
            self.m5_zone = None
            self.m1_buffer.clear()
            # When a search starts exactly on an M5 boundary, the terminal can
            # briefly keep returning the previous shift=1 candle while it
            # publishes the bar that just closed. Do not evaluate that stale
            # history as C1; _search_m5_tick will pick up the new closed bar
            # as soon as MT5 advances its timestamp. The boundary must be on
            # the broker's candle clock -- this machine's clock is hours
            # behind it, which made every preload look current.
            boundary_time = ((int(time.time()) + clock_offset) // 300) * 300
            latest_closed_time = (
                int(self.m5_buffer[-1]["time"]) + 300
                if self.m5_buffer
                else 0
            )
            history_is_current = latest_closed_time >= boundary_time
            zone = (
                self._detect_gap_zone_locked(
                    self.m5_buffer, self.m5_target_zone_type, extend_to_c2=True
                )
                if not fresh and history_is_current
                else None
            )
        if fresh:
            patch_path(self._state_path, {
                "running": True,
                "phase": "searching_m5_zone",
                "m5_zone": None,
                "m1_zone": None,
                "placed_order": None,
                "last_error": None,
            })
        elif zone is not None and not self._m5_zone_too_big(zone):
            self._accept_m5_zone(zone)
            return
        start_task(
            self._search_m5_task_name,
            self._search_m5_tick,
            interval_sec=M5_SEARCH_INTERVAL_SEC,
            start_time=datetime.now(),
        )

    def _m5_zone_too_big(self, zone: dict[str, Any]) -> bool:
        """Max demand/supply pips: measured from the zone's extreme -- the
        lower of c3/c2's lows (demand) or the higher of their highs (supply),
        which is the zone's breach edge -- to c3's close. A bigger zone is
        logged and skipped; the search carries on to the next pattern."""
        if self.max_zone_pips <= 0:
            return False
        is_demand = zone.get("type") == "demand"
        extreme = float(zone["price_low"] if is_demand else zone["price_high"])
        span_pips = round(abs(float(zone["c3_close"]) - extreme) * 10.0, 1)
        if span_pips <= self.max_zone_pips:
            return False
        append_log(
            "search",
            f"[INFO] [scalping:{self.side}] 5-minute zone {zone['price_low']:.2f}-{zone['price_high']:.2f} skipped: "
            f"{span_pips:g} pips from its {'low' if is_demand else 'high'} to the c3 close is over the "
            f"max {self.max_zone_pips:g}; still searching.",
        )
        return True

    def _accept_m5_zone(self, zone: dict[str, Any]) -> None:
        # The engine owns a side-specific search. Keep that ownership explicit
        # in the zone payload so the UI can never attribute a breach to the
        # opposite side if a stale/malformed zone reaches this handoff.
        zone = {**zone, "type": self.side}
        stop_task(self._search_m5_task_name)
        if self._stopped:
            return
        self._seed_buffer(self.m1_buffer, "M1", preload_count=0)
        with self._lock:
            self.m5_zone = zone
        patch_path(self._state_path, {"phase": "searching_m1_zone", "m5_zone": zone})
        append_log(
            "search",
            f"[SUCCESS] [scalping:{self.side}] 5-minute zone appeared at {zone['price_low']:.2f}-{zone['price_high']:.2f} (C1 closed at {datetime.fromtimestamp(int(zone['displacement_candle_time']) + 300).strftime('%H:%M:%S')}); starting 1-minute search.",
        )
        # The seeded anchor keeps candles that closed before this point out
        # of the buffer, so polling can start right away.
        start_task(
            self._search_m1_task_name,
            self._search_m1_tick,
            interval_sec=M1_SEARCH_INTERVAL_SEC,
            start_time=datetime.now(),
        )

    def _log_catch_up(self, timeframe_label: str, candles: list[Any]) -> None:
        """One poll returned several closed candles: this side's poll or the
        MT5 feed stalled (e.g. waiting on MT5_LOCK while the other side's
        order was sent). Each candle is still checked; this just makes the
        stall visible."""
        if len(candles) > 1:
            append_log(
                "search",
                f"[WARNING] [scalping:{self.side}] {timeframe_label} poll picked up {len(candles)} "
                f"closed candles at once (feed or lock stall); checking each one in order.",
            )

    def _search_m5_tick(self) -> None:
        candles = self._new_closed_candles("M5")
        if not candles:
            return
        self._log_catch_up("M5", candles)
        # One candle at a time: testing only the newest window after a
        # multi-candle catch-up skipped every window ending on an earlier one.
        for candle in candles:
            with self._lock:
                self.m5_buffer.append(candle)
                zone = self._detect_gap_zone_locked(
                    self.m5_buffer, self.m5_target_zone_type, extend_to_c2=True
                )
            if zone is not None and not self._m5_zone_too_big(zone):
                self._accept_m5_zone(zone)
                return

    def _m5_zone_breach(self, price: float | None, candles: list[Any]) -> tuple[bool, Optional[int]]:
        """Has price traded through the M5 zone? Returns (breached, broker time).

        Invalidate demand if price or any given M1 candle's low is below the
        M5 demand low; invalidate supply if price or a candle's high is above
        the M5 supply high.
        """
        zone = self.m5_zone
        if zone is None:
            return False, None
        # A zone from the other engine must never be invalidated by this
        # engine's price direction. Treat mismatched state as non-actionable;
        # _accept_m5_zone stamps the expected type at the handoff.
        if zone.get("type") != self.side:
            return False, None
        is_demand = self.side == "demand"
        edge = zone["price_low"] if is_demand else zone["price_high"]
        for candle in candles:
            extreme = float(
                _candle_value(candle, 3, "low") if is_demand else _candle_value(candle, 2, "high")
            )
            if (is_demand and extreme < edge) or (not is_demand and extreme > edge):
                return True, int(candle["time"])
        if price is not None and ((is_demand and price < edge) or (not is_demand and price > edge)):
            return True, None
        return False, None

    def _retreat_after_breach(self, breach_time: int | None = None) -> None:
        """Price broke the M5 zone (during the M1 search or an open trade):
        drop back to hunting a fresh M5 zone instead of continuing to chase
        a level that no longer holds. This is the only way an M5 zone is
        dropped -- the M1 search has no candle limit.

        The old zone is kept (separately from the live `m5_zone`, which gets
        cleared) as `last_breached_m5_zone` so the chart can still show it --
        greyed out, marking where the search moved on from -- instead of it
        just vanishing.
        """
        stop_task(self._search_m1_task_name)
        with self._lock:
            zone = self.m5_zone
            self.m5_zone = None
            # Same broker-time domain as base_candle_time/displacement_candle_time
            # (an epoch straight from MT5 candle data), not the backend
            # process's own wall clock -- that runs on a different clock than
            # the broker feed the chart's candle times use (seen off by hours
            # earlier), so the frontend's "nearest loaded candle to this
            # timestamp" search always landed on the oldest candle in its
            # sliding window. Since that window keeps sliding forward as new
            # candles arrive, the "frozen" box kept visibly growing to the
            # right forever instead of actually freezing.
            breach_time = breach_time or (int(self.m5_buffer[-1]["time"]) if self.m5_buffer else None)
        breached_zone = (
            {
                **zone,
                "breached_at": breach_time if breach_time is not None else zone["displacement_candle_time"],
                "breached_by_side": self.side,
                "was_price_breached": True,
                "retirement_reason": "price_breach",
            }
            if zone
            else None
        )
        patch_path(
            self._state_path,
            {
                "phase": "searching_m5_zone",
                "m5_zone": None,
                "m1_zone": None,
                "last_breached_m5_zone": breached_zone,
            },
        )
        if zone:
            edge = "low" if self.side == "demand" else "high"
            direction = "below" if self.side == "demand" else "above"
            append_log(
                "search",
                f"[WARNING] [scalping:{self.side}] 5-minute zone breached {direction} its {edge} "
                f"({zone[f'price_{edge}']:.2f}); starting a new 5-minute search "
                f"(last closed candle kept as c3 -- 2 new candles needed).",
            )
        # A breach re-arms after two new M5 candles instead of three.
        self._start_m5_search(fresh=True, keep_last_closed=True, announce=False)

    def _search_m1_tick(self) -> None:
        candles = self._new_closed_candles("M1")
        price, live_bars = self._live_quote()
        breached, breach_time = self._m5_zone_breach(price, [*candles, *live_bars])
        if breached:
            self._retreat_after_breach(breach_time=breach_time)
            return
        if not candles:
            return
        self._log_catch_up("M1", candles)
        zone = None
        # One candle at a time, same as the M5 search: a catch-up must not
        # skip the windows ending on its earlier candles.
        for candle in candles:
            with self._lock:
                self.m1_buffer.append(candle)
                zone = self._detect_gap_zone_locked(
                    self.m1_buffer, self.m1_target_zone_type
                )
            if zone is not None:
                break
        if zone is None:
            # No candle limit: keep searching M1 on this M5 zone until a
            # match is found or the zone is breached. The buffer only keeps
            # the latest candles; detection uses the newest three.
            return
        # Publish as soon as a matching M1 zone is found so the chart can draw
        # it right away instead of only surfacing it the instant the order fires.
        patch_path(self._state_path, {"m1_zone": zone})
        stop_task(self._search_m1_task_name)
        append_log(
            "search",
            f"[SUCCESS] [scalping:{self.side}] 1-minute liquidity appeared at {zone['price_low']:.2f}-{zone['price_high']:.2f}; placing order.",
        )
        self._place_order(zone)

    def _monitor_m5_zone_after_entry(self) -> bool:
        """Keep validating the accepted M5 zone while its trade is open.

        Reads live M1 bars only -- never M5 candles through
        _new_closed_candles, which would consume the bars the M5 search needs
        once a breach restarts it. After a breach this is a no-op.
        """
        if self._search_resumed_during_trade:
            return False
        with self._lock:
            if self.m5_zone is None:
                return False
        price, live_bars = self._live_quote()
        breached, breach_time = self._m5_zone_breach(price, live_bars)
        if not breached:
            return False
        self._search_resumed_during_trade = True
        self._cancel_unfilled_limit()
        self._retreat_after_breach(breach_time=breach_time)
        return True

    def _cancel_unfilled_limit(self) -> None:
        """A LIMIT entry that hasn't filled must not fill on a broken zone."""
        if self._exit_levels.get("order_kind") != "LIMIT" or self._exit_position_seen:
            return
        if not mt5_available():
            return
        with MT5_LOCK:
            try:
                pending = mt5.orders_get(symbol=self.symbol) or []
            except Exception:
                pending = []
            for order in pending:
                if str(int(getattr(order, "ticket", 0) or 0)) not in self._exit_position_keys:
                    continue
                ok, detail = _close_mt5_pending_order(order, comment="scalping zone breached")
                append_log(
                    "search",
                    f"[{'INFO' if ok else 'ERROR'}] [scalping:{self.side}] unfilled LIMIT "
                    f"{int(getattr(order, 'ticket', 0) or 0)} "
                    f"{'cancelled -- its 5-minute zone was breached' if ok else f'cancel failed: {detail}'}.",
                )

    def _resume_m1_search_for_current_zone(
        self,
        allow_without_zone: bool = False,
        sl_candle_time: Optional[int] = None,
    ) -> bool:
        """After TP/SL, reuse the still-valid M5 zone for another M1 entry.

        `allow_without_zone` lets the dev M1 test (which never has an M5
        zone) go back to its own M1 search after a failed order.
        `sl_candle_time` (after an SL) is the open time of the M1 candle the
        SL hit in. That candle becomes c3 however late the close was noticed:
        the anchor sits just before it, so it enters the buffer as the first
        new candle once it closes (or on the first poll if it already has).
        """
        if self._stopped:
            return True
        with self._lock:
            if self.m5_zone is None and not allow_without_zone:
                return False
            self.m1_buffer.clear()
        if sl_candle_time:
            with self._lock:
                self._last_processed_candle_time["M1"] = sl_candle_time - 1
        else:
            self._seed_buffer(self.m1_buffer, "M1", preload_count=0)
        patch_path(self._state_path, {
            "running": True,
            "phase": "searching_m1_zone",
            "m1_zone": None,
            "placed_order": None,
        })
        start_task(
            self._search_m1_task_name,
            self._search_m1_tick,
            interval_sec=M1_SEARCH_INTERVAL_SEC,
            start_time=datetime.now(),
        )
        return True

    @staticmethod
    def _c3_reference_prices(c3: Any, target_zone_type: str) -> tuple[float, float]:
        """The two c3 body-edge prices the gap check and the c2-touch check
        compare against -- see the module docstring for the full spec.

        Which edge (open vs. close) is picked depends on which way c3 itself
        closed, not a fixed choice regardless of direction. Returns
        (gap_reference, touch_reference); these are the same price for both
        demand and supply.
        """
        c3_bullish = _is_bullish(c3)
        c3_open = _candle_value(c3, 1, "open")
        c3_close = _candle_value(c3, 4, "close")
        if target_zone_type == "demand":
            ref = c3_close if not c3_bullish else c3_open
            return ref, ref
        gap_ref = c3_open if not c3_bullish else c3_close
        # Supply: c2's high has to reach the same body edge c1 later stays
        # below (bullish c3 -> close, bearish c3 -> open).
        return gap_ref, gap_ref

    def _detect_gap_zone_locked(
        self,
        buffer: deque,
        target_zone_type: str,
        extend_to_c2: bool = False,
        variant: Optional[int] = None,
    ) -> Optional[dict[str, Any]]:
        """3-candle imbalance/gap check, shared by both the M5 and M1
        searches -- see the module docstring for the full spec.

        With `variant=None` (the normal case) Type 1 is tried first and Type 2
        only if Type 1 finds nothing; pass 1 or 2 to test a single type.

        c1 is the newest closed candle, c2 is the one before it, and c3 is two
        candles before that (oldest of the three). M5 and M1 both validate only
        complete three-candle patterns.
        """
        if variant is None:
            return self._detect_gap_zone_locked(
                buffer, target_zone_type, extend_to_c2, variant=1
            ) or self._detect_gap_zone_locked(buffer, target_zone_type, extend_to_c2, variant=2)
        if len(buffer) < 3:
            return None
        c3, c2, c1 = list(buffer)[-3:]
        gap_ref, touch_ref = self._c3_reference_prices(c3, target_zone_type)

        if target_zone_type == "demand":
            # c3 defines the base and c2 retests it. c1 only needs to hold
            # above the gap reference; its candle direction is irrelevant.
            c1_low = _candle_value(c1, 3, "low")
            # Type 2: clear of the whole c3 body, not just its lower edge.
            c1_limit = gap_ref if variant == 1 else max(
                _candle_value(c3, 1, "open"), _candle_value(c3, 4, "close")
            )
            if c1_low <= c1_limit:
                return None
            c2_low = _candle_value(c2, 3, "low")
            if variant == 1 and c2_low > touch_ref:
                return None
            # Zone box drawn on c3 alone -- its low up to its gap reference.
            c3_low = _candle_value(c3, 3, "low")
            # M5: a deeper c2 low becomes the zone's low (the breach level).
            price_low, price_high = (min(c3_low, c2_low) if extend_to_c2 else c3_low), gap_ref
        else:
            # Supply mirrors demand: c1 must hold below the reference, but
            # its candle direction is irrelevant.
            c1_high = _candle_value(c1, 2, "high")
            c1_limit = gap_ref if variant == 1 else min(
                _candle_value(c3, 1, "open"), _candle_value(c3, 4, "close")
            )
            if c1_high >= c1_limit:
                return None
            c2_high = _candle_value(c2, 2, "high")
            if variant == 1 and c2_high < touch_ref:
                return None
            # Zone box drawn on c3 alone -- its gap reference up to its high.
            c3_high = _candle_value(c3, 2, "high")
            # M5: a higher c2 high becomes the zone's high (the breach level).
            price_low, price_high = gap_ref, (max(c3_high, c2_high) if extend_to_c2 else c3_high)

        return {
            "type": target_zone_type,
            "variant": variant,
            "price_high": round(float(price_high), 2),
            "price_low": round(float(price_low), 2),
            # For the 5-minute Max demand/supply pips check.
            "c3_close": round(float(_candle_value(c3, 4, "close")), 2),
            "base_candle_time": int(c3["time"]),
            "retest_candle_time": int(c2["time"]),
            "displacement_candle_time": int(c1["time"]),
            "formed_at": datetime.now().isoformat(),
        }

    def _m1_history_through(self, anchor_time: int) -> tuple[Optional[Any], list[Any]]:
        """(anchor candle, M1 candles before it oldest first).

        Filtered by the anchor's broker timestamp rather than a fixed bar offset, so
        the history is right even if the zone was picked up a bar late. In
        dev/sim mode there's no historical feed to query, so fall back to
        whatever the live search buffer collected (best-effort only).
        """
        if mt5_available():
            with MT5_LOCK:
                try:
                    rates = mt5.copy_rates_from_pos(
                        self.symbol, TIMEFRAME_MAP["M1"], 1, SL_LIQUIDITY_LOOKBACK_CANDLES + 3
                    )
                except Exception:
                    rates = None
            candles = list(rates) if rates is not None else []
        else:
            with self._lock:
                candles = list(self.m1_buffer)
        anchor = next((candle for candle in candles if int(candle["time"]) == anchor_time), None)
        return anchor, [candle for candle in candles if int(candle["time"]) < anchor_time]

    def _sl_liquidity(
        self,
        zone: dict[str, Any],
        is_buy: bool,
        entry_price: float,
        min_sl_distance: float,
        min_liquidity_distance: float,
    ) -> tuple[float, Optional[tuple[float, float, int]]]:
        """Liquidity candle behind the M1 zone. Returns (reference extreme, match).

        The stop sits exactly on a real candle extreme. The reference the
        distance is measured from is c2's low (BUY) / high (SELL) only when c2
        goes beyond c3 (c2 low below c3 low / c2 high above c3 high);
        otherwise it is c3's own low / high. Walk backward from the reference
        candle and take the first candle whose low is below the reference
        (BUY) / high is above it (SELL) by at least `min_liquidity_distance`,
        and that is also at least the global min SL away from entry. Nearer
        swings are skipped, so the walk moves on to the next deeper low/high
        instead of floating the stop at an arbitrary price. `match` is (that
        candle's low/high, its distance from the reference, its broker time),
        or None if the lookback has no such candle.
        """
        c3_time = int(zone["base_candle_time"])
        c2_time = int(zone.get("retest_candle_time") or c3_time + 60)
        c2, history = self._m1_history_through(c2_time)
        c3 = next((candle for candle in history if int(candle["time"]) == c3_time), None)
        pick = (lambda candle: float(_candle_value(candle, 3, "low"))) if is_buy else (
            lambda candle: float(_candle_value(candle, 2, "high"))
        )
        if c2 is not None and c3 is not None:
            c2_beyond_c3 = pick(c2) < pick(c3) if is_buy else pick(c2) > pick(c3)
            if c2_beyond_c3:
                c2_extreme = pick(c2)  # history is already everything before c2
            else:
                c2_extreme = pick(c3)
                history = [candle for candle in history if int(candle["time"]) < c3_time]
        else:
            # No c2/c3 bars to read (sim mode): start from c3 as before.
            _c3, history = self._m1_history_through(c3_time)
            c2_extreme = float(zone["price_low"] if is_buy else zone["price_high"])
        if is_buy:
            limit = min(c2_extreme - min_liquidity_distance, entry_price - min_sl_distance)
        else:
            limit = max(c2_extreme + min_liquidity_distance, entry_price + min_sl_distance)
        for candle in reversed(history):
            candidate = float(
                _candle_value(candle, 3, "low") if is_buy else _candle_value(candle, 2, "high")
            )
            beyond_c2 = candidate < c2_extreme if is_buy else candidate > c2_extreme
            far_enough = candidate <= limit if is_buy else candidate >= limit
            if beyond_c2 and far_enough:
                return c2_extreme, (
                    round(candidate, 2),
                    round(abs(c2_extreme - candidate), 2),
                    int(candle["time"]),
                )
        return c2_extreme, None

    def _recover_after_failed_order(self, message: str) -> None:
        """Keep searching after an order is refused instead of dying.

        A refused order (position cap, broker reject, limit price already
        crossed) only skips this one M1 zone. A session-risk stop or a manual
        stop while the order was in flight ends the run.
        """
        session_risk = get("session_risk", {})
        risk_hit = isinstance(session_risk, dict) and session_risk.get("hit")
        for prefix in ("Manual order failed: ", "Manual order blocked: "):
            if message.startswith(prefix):
                message = message[len(prefix):]
        if not bool(get(self._state_path, {}).get("running")):
            # Stopped (manually, by Close All, or by session risk) while the
            # order was in flight; stop() already recorded the state.
            return
        if risk_hit:
            append_log("search", f"[ERROR] [scalping:{self.side}] Order failed: {message} Search stopped.")
            patch_path(self._state_path, {
                "phase": "error",
                "running": False,
                "last_error": message,
                "stopped_at": self._broker_time(),
            })
            return
        patch_path(self._state_path, {"last_error": message})
        append_log("search", f"[WARNING] [scalping:{self.side}] Order failed: {message} Still searching.")
        if not self._resume_m1_search_for_current_zone(allow_without_zone=self.dev_m1_start):
            self._start_m5_search(fresh=True)

    def _place_order(self, zone: dict[str, Any]) -> None:
        is_buy = zone["type"] == "demand"
        side = "BUY" if is_buy else "SELL"
        position_candle_time: Optional[int] = None
        order_result = None
        placed: dict[str, Any] = {}
        sl_liquidity_price: Optional[float] = None
        sl_liquidity_pips: Optional[float] = None
        order_kind = "MARKET"
        try:
            if mt5_available():
                with MT5_LOCK:
                    _ensure_master_session()
                    try:
                        current_candle = mt5.copy_rates_from_pos(
                            self.symbol, TIMEFRAME_MAP["M1"], 0, 1
                        )
                        if current_candle is not None and len(current_candle) > 0:
                            position_candle_time = int(current_candle[0]["time"])
                    except Exception:
                        position_candle_time = None
                    tick = mt5.symbol_info_tick(self.symbol)
            else:
                tick = _tick_for(self.symbol)
            if tick is None:
                raise RuntimeError("No live tick to price the order.")
            market_price = float(tick.ask if is_buy else tick.bid)
            # The SL (and so MARKET vs LIMIT) is worked out from market.
            entry_price = market_price
            min_sl_distance = self.manual_sl_distance / 10.0 if self.sl_distance_in_pips else self.manual_sl_distance
            min_liquidity_distance = self.liquidity_buffer_pips / 10.0
            c2_extreme, liquidity = self._sl_liquidity(
                zone, is_buy, entry_price, min_sl_distance, min_liquidity_distance
            )
            if liquidity is None:
                # Only when no candle in the lookback satisfies the min SL.
                sl_price = entry_price - min_sl_distance if is_buy else entry_price + min_sl_distance
                append_log(
                    "search",
                    f"[WARNING] [scalping:{self.side}] no M1 candle within {SL_LIQUIDITY_LOOKBACK_CANDLES} "
                    f"candles is at least {self.liquidity_buffer_pips:g} pips beyond c2 and the min SL "
                    f"from entry; using the min SL price.",
                )
                liquidity_note = "min SL fallback"
            else:
                sl_liquidity_price, liquidity_distance, liquidity_candle_time = liquidity
                sl_liquidity_pips = round(liquidity_distance * 10.0, 1)
                # Exactly on that candle's low/high -- nothing added.
                sl_price = sl_liquidity_price
                liquidity_note = (
                    f"M1 candle {time.strftime('%H:%M', time.gmtime(liquidity_candle_time))} "
                    f"{'low' if is_buy else 'high'} {sl_liquidity_price:.2f}; liquidity SL "
                    f"{sl_liquidity_pips:g} pips {'below' if is_buy else 'above'} c2 "
                    f"{'low' if is_buy else 'high'} {c2_extreme:.2f}, min {self.liquidity_buffer_pips:g} pips"
                )
            sl_price = round(sl_price, 2)
            # open_manual_position adds the spread beyond sl_price, exactly
            # like Manual Trade's spread field (and the TPs scale with it).
            spread_offset = self.spread_pips / 10.0
            final_sl = round(sl_price - spread_offset if is_buy else sl_price + spread_offset, 2)
            spread_note = f"; + spread {self.spread_pips:g} pips" if self.spread_pips > 0 else ""
            sl_distance = abs(market_price - final_sl)
            sl_pips = round(sl_distance * 10.0, 1)
            if self.max_sl_pips > 0 and sl_pips > self.max_sl_pips:
                # SL too wide for a market entry: move the entry toward the
                # SL by Limit % of its distance; the SL price stays put.
                order_kind = "LIMIT"
                shift = sl_distance * self.limit_percent / 100.0
                entry_price = round(market_price - shift if is_buy else market_price + shift, 2)
                order_note = (
                    f"SL {sl_pips:g} pips > max {self.max_sl_pips:g} -> LIMIT {self.limit_percent:g}% "
                    f"closer, SL now {abs(entry_price - final_sl) * 10.0:.1f} pips"
                )
            else:
                order_note = (
                    f"SL {sl_pips:g} pips <= max {self.max_sl_pips:g} -> MARKET"
                    if self.max_sl_pips > 0
                    else f"SL {sl_pips:g} pips -> MARKET"
                )
            append_log(
                "search",
                f"[INFO] [scalping:{self.side}] {side} {order_kind} @ {entry_price:.2f}, SL {final_sl:.2f} "
                f"({liquidity_note}{spread_note}; {order_note}).",
            )

            # Multi-TP, ratio-based against the SL this engine just computed
            # above -- same mechanism as manual trade's Advanced Risk panel,
            # but fed the strategy's own stop instead of a manually typed
            # Stop Loss Price, since scalping never has one of those.
            # Both side engines can reach order placement on independent
            # timer threads. Serialize the broker request because the MT5
            # Python connection is process-wide and not thread-safe.
            def after_master_fill(request: dict[str, Any]) -> Optional[str]:
                # Receivers first, the instant the master order fills; the
                # local sub-account dispatch re-verifies the MT5 login first.
                self._mirror_to_receivers(side, order_kind, placed, entry_price, final_sl)
                return _clone_trade_to_sub_accounts(request, origin="manual")

            with MT5_LOCK:
                if self._stopped:
                    raise _SearchStopped()
                order_result = open_manual_position(
                    side,
                    lot_size=self.lot,
                    symbol=self.symbol,
                    order_kind=order_kind,
                    limit_price=entry_price if order_kind == "LIMIT" else None,
                    risk_percent=self.risk_percent,
                    advanced=True,
                    sl_price=sl_price,
                    spread_pips=self.spread_pips,
                    ratio=self.tp1_ratio,
                    tp1_ratio=self.tp1_ratio,
                    tp2_ratio=self.tp2_ratio,
                    tp3_ratio=self.tp3_ratio,
                    tp2_enabled=self.tp2_enabled,
                    tp3_enabled=self.tp3_enabled,
                    tp1_percent=self.tp1_percent,
                    tp2_percent=self.tp2_percent,
                    # The engine logs one line for a failure itself.
                    log_failures=False,
                    order_sink=placed,
                    after_master_order=after_master_fill,
                )
        except _SearchStopped:
            append_log("search", f"[INFO] [scalping:{self.side}] search stopped; {side} entry not sent.")
            return
        except Exception as exc:
            self._recover_after_failed_order(str(exc))
            return

        # `placed` is this order's own row (no shared orders list to search).
        result_order_ticket = getattr(order_result, "order", None)
        ticket = placed.get("ticket", result_order_ticket)
        position_key_values = [
            ticket,
            result_order_ticket,
            getattr(order_result, "position", None),
        ]
        self._exit_position_keys = {str(value) for value in position_key_values if value not in (None, "", 0)}
        self._exit_position_seen = False
        self._exit_monitor_attempts = 0
        self._exit_missing_polls = 0
        self._search_resumed_during_trade = False
        self._exit_levels = {
            "ticket": ticket,
            "side": side,
            "order_kind": order_kind,
            "tp": float(placed.get("tp", 0) or 0),
            "sl": float(placed.get("sl", final_sl) or final_sl),
        }
        if position_candle_time is not None:
            zone["position_candle_time"] = position_candle_time
        patch_path(
            self._state_path,
            {
                "phase": "placed",
                # Keep the search alive while the exit watcher validates its
                # M5 zone. The chart extends this box until breach or stop.
                "running": True,
                "m1_zone": zone,
                "sl_liquidity_price": sl_liquidity_price,
                "sl_liquidity_pips": sl_liquidity_pips,
                # A breached-and-superseded zone from earlier in this run is
                # no longer relevant once a trade is actually live -- drop it
                # so the chart isn't left showing a greyed-out box alongside
                # the live entry/SL/TP lines.
                "last_breached_m5_zone": None,
                "placed_order": {
                    "ticket": placed.get("ticket"),
                    "side": side,
                    "entry": placed.get("entry", entry_price),
                    "sl": placed.get("sl", final_sl),
                    "tp": placed.get("tp"),
                    "lot": placed.get("lot"),
                    "order_kind": order_kind,
                    "created_at": placed.get("created_at"),
                },
            },
        )
        start_task(
            self._exit_task_name,
            self._watch_position_exit,
            interval_sec=1.0,
            start_time=datetime.now() + timedelta(seconds=1),
            log_schedule=False,
        )

    def _mirror_to_receivers(
        self,
        side: str,
        order_kind: str,
        placed: dict[str, Any],
        entry_price: float,
        final_sl: float,
    ) -> None:
        """Send this entry to the remote receivers straight away.

        Done here rather than by the UI noticing the "placed" phase, which a
        minimized window only polled about once a minute. Each receiver sizes
        the lot from its own Risk % (see _receiver_open_settings).
        """
        if is_dev_mode():
            return
        remote_controller.broadcast_in_background(
            "open",
            {
                "side": side,
                "symbol": self.symbol,
                "order_kind": order_kind,
                "limit_price": placed.get("entry", entry_price) if order_kind == "LIMIT" else None,
                "advanced": True,
                # The receiver adds the spread back, landing on the same
                # final SL, and sizes the lot per its own "Include spread in
                # risk" setting.
                "sl_price": round(
                    float(placed.get("sl", final_sl)) + self.spread_pips / 10.0
                    if side == "BUY"
                    else float(placed.get("sl", final_sl)) - self.spread_pips / 10.0,
                    2,
                ),
                "spread_pips": self.spread_pips,
                # With TP2 off, TP1 comes from `ratio`, not tp1_ratio.
                "ratio": self.tp1_ratio,
                "tp1_ratio": self.tp1_ratio,
                "tp2_ratio": self.tp2_ratio,
                "tp3_ratio": self.tp3_ratio,
                "tp2_enabled": self.tp2_enabled,
                "tp3_enabled": self.tp3_enabled,
                "tp1_percent": self.tp1_percent,
                "tp2_percent": self.tp2_percent,
            },
            f"{side} {order_kind} mirror",
            f"[scalping:{self.side}]",
        )

    def _watch_position_exit(self) -> None:
        """Restart the same side's search only after its trade closes by TP/SL."""
        if not mt5_available():
            price = self._current_price()
            if price is None:
                return
            levels = self._exit_levels
            hit_tp = price >= levels["tp"] if levels.get("side") == "BUY" else price <= levels["tp"]
            hit_sl = price <= levels["sl"] if levels.get("side") == "BUY" else price >= levels["sl"]
            self._monitor_m5_zone_after_entry()
            if (levels.get("tp", 0) > 0 and hit_tp) or (levels.get("sl", 0) > 0 and hit_sl):
                stop_task(self._exit_task_name)
                self._sl_deal_time = None
                self._restart_search_after_close("TP" if hit_tp else "SL")
            return

        if not self._ensure_symbol_or_log():
            return
        self._monitor_m5_zone_after_entry()
        self._exit_monitor_attempts += 1
        with MT5_LOCK:
            try:
                positions = mt5.positions_get(symbol=self.symbol)
                pending_orders = mt5.orders_get(symbol=self.symbol)
            except Exception as exc:
                append_log("search", f"[WARNING] [scalping:{self.side}] position close monitor failed: {exc}")
                return
        # None means MT5 could not answer (terminal disconnected), not "no
        # positions" -- reading it as empty counted the trade as closed
        # outside TP/SL and stopped the search. Wait for the terminal.
        if positions is None or pending_orders is None:
            return

        identity_keys = set(self._exit_position_keys)
        for position in positions:
            ticket = int(getattr(position, "ticket", 0) or 0)
            identifier = int(getattr(position, "identifier", ticket) or ticket)
            if str(ticket) in identity_keys or str(identifier) in identity_keys:
                self._exit_position_seen = True
                self._exit_position_keys.update({str(ticket), str(identifier)})
                return
        for order in pending_orders:
            if str(int(getattr(order, "ticket", 0) or 0)) in identity_keys:
                return

        closed_reason = self._closing_reason(identity_keys)
        if closed_reason == CLOSE_REASON_UNREADABLE:
            return
        if closed_reason:
            stop_task(self._exit_task_name)
            self._restart_search_after_close(closed_reason)
            return
        if self._exit_position_seen:
            # The closing deal can reach history a moment after the position
            # leaves positions_get(); give it a few polls before calling the
            # close manual.
            self._exit_missing_polls += 1
            if self._exit_missing_polls < EXIT_REASON_GRACE_POLLS:
                return
        elif self._exit_monitor_attempts < 15:
            return
        # Manual closes and cancelled pending orders do not restart this
        # TP/SL-triggered search. End the run visibly instead of leaving the
        # side marked "placed" with nothing searching.
        stop_task(self._exit_task_name)
        if self._search_resumed_during_trade:
            return
        self.stop("Position closed outside TP/SL; scalping search stopped.")

    def _closing_reason(self, identity_keys: set[str]) -> Optional[str]:
        """"TP"/"SL" when the tracked position's closing deal says so.

        Deals are looked up by position id, not by a date range: MT5 stamps
        deals in broker server time, which runs hours ahead of this machine's
        clock, so a history_deals_get(since, datetime.now()) window missed
        the closing deal and the search never restarted.
        """
        tp_reason = int(getattr(mt5, "DEAL_REASON_TP", 5))
        sl_reason = int(getattr(mt5, "DEAL_REASON_SL", 4))
        closing_entries = {
            int(getattr(mt5, "DEAL_ENTRY_OUT", 1)),
            int(getattr(mt5, "DEAL_ENTRY_OUT_BY", 3)),
            int(getattr(mt5, "DEAL_ENTRY_INOUT", 2)),
        }
        deals: list[Any] = []
        with MT5_LOCK:
            for key in identity_keys:
                try:
                    history = mt5.history_deals_get(position=int(key))
                except Exception as exc:
                    append_log("search", f"[WARNING] [scalping:{self.side}] close history read failed: {exc}")
                    return CLOSE_REASON_UNREADABLE
                if history is None:
                    return CLOSE_REASON_UNREADABLE
                deals.extend(history)
        for deal in sorted(deals, key=lambda item: int(getattr(item, "time_msc", 0) or 0), reverse=True):
            if int(getattr(deal, "entry", -1)) not in closing_entries:
                continue
            reason = int(getattr(deal, "reason", -1))
            if reason == tp_reason:
                return "TP"
            if reason == sl_reason:
                # Broker time of the SL fill: picks the M1 candle that
                # becomes c3 for the next entry search.
                self._sl_deal_time = int(getattr(deal, "time", 0) or 0) or None
                return "SL"
        return None

    def _restart_search_after_close(self, closed_reason: str) -> None:
        if closed_reason == "TP" and stop_on_final_tp_enabled():
            _stop_all_and_close(
                self.symbol,
                f"[SUCCESS] [scalping:{self.side}] Position hit its final TP; stopping scalping "
                f"and closing all {self.symbol} positions.",
                "Final TP hit; search stopped.",
            )
            return
        prefix = f"[INFO] [scalping:{self.side}] Position closed by {closed_reason}"
        # A breach during the trade already restarted the M5 search.
        if self._search_resumed_during_trade:
            append_log("search", f"{prefix}; 5-minute search already running after the zone breach.")
            return
        sl_candle_time: Optional[int] = None
        if closed_reason == "SL":
            # The SL fill's broker time; the latest quote time if the deal
            # didn't carry one (simulation), which is within a second of it.
            sl_time = self._sl_deal_time or self._broker_time()
            sl_candle_time = (sl_time // 60) * 60 if sl_time else None
        if self._resume_m1_search_for_current_zone(sl_candle_time=sl_candle_time):
            candles = (
                f"SL candle {datetime.fromtimestamp(sl_candle_time, timezone.utc).strftime('%H:%M')} is c3, "
                "2 more candles needed"
                if sl_candle_time
                else "3 new candles"
            )
            append_log("search", f"{prefix}; searching 1-minute again on the same 5-minute zone ({candles}).")
            return
        append_log("search", f"{prefix}; starting a new 5-minute search.")
        self._start_m5_search(fresh=True, announce=False)


def _claim_close_all() -> bool:
    """End time and a final TP can fire on both sides within moments of each
    other; only the first caller gets to close, so the feed shows one close."""
    global _last_end_close_at
    with _end_close_lock:
        if time.monotonic() - _last_end_close_at < 30:
            return False
        _last_end_close_at = time.monotonic()
        return True


def _close_positions(symbol: str) -> None:
    try:
        close_all_positions(symbol=symbol)
    except Exception as exc:
        append_log("search", f"[ERROR] [scalping] close-all failed: {exc}")


def _close_all_once(symbol: str, announcement: str) -> None:
    """Close every position on `symbol` unless that was just done."""
    if not _claim_close_all():
        return
    append_log("search", announcement)
    _close_positions(symbol)


def _stop_all_and_close(symbol: str, announcement: str, stop_reason: str) -> None:
    """Final TP: stop both sides' searches first (so nothing new opens),
    then close every open position on the symbol once."""
    first = _claim_close_all()
    if first:
        append_log("search", announcement)
    for manager in _zone_managers.values():
        manager.stop(stop_reason)
    if first:
        _close_positions(symbol)


zone_manager_demand = ZoneStrategyEngine("demand")
zone_manager_supply = ZoneStrategyEngine("supply")
_zone_managers = {"demand": zone_manager_demand, "supply": zone_manager_supply}


def start_zone_strategy_system(cfg: dict) -> None:
    side = str(cfg.get("trigger_zone_type", "")).lower()
    if side not in _zone_managers:
        raise RuntimeError("trigger_zone_type must be 'demand' or 'supply'.")
    _zone_managers[side].start(cfg)


def stop_zone_strategy_system(side: Optional[str] = None, reason: str = "Manual stop requested.") -> None:
    if side:
        normalized = side.lower()
        if normalized not in _zone_managers:
            raise RuntimeError("side must be 'demand' or 'supply'.")
        _zone_managers[normalized].stop(reason)
        return
    for manager in _zone_managers.values():
        manager.stop(reason)
