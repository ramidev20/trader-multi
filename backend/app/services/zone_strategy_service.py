from __future__ import annotations

import random
import threading
import time
from collections import deque
from datetime import datetime, timedelta
from typing import Any, Optional

from .mt5_compat import mt5, mt5_available
from .mt5_lock import MT5_LOCK
from .runtime_state import append_log, get, patch_path
from .task_manager import is_task_running, start_task, stop_task
from .strategy_service import (
    SYMBOL_DEFAULT,
    TIMEFRAME_MAP,
    _candle_value,
    _ensure_master_session,
    _ensure_symbol_ready,
    _tick_for,
    close_all_positions,
    open_manual_position,
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
# M1, just run against each timeframe's own candle buffer, checked one
# newly-closed candle at a time. c1 is the candle that just closed, c2 is the
# one before it, c3 is two before that (oldest of the three).
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
# was never retested. This "touch reference" uses its own open/close pick --
# for supply, a different one than the gap check above:
#   - demand: c2's low must touch (reach down to, or through) bullish c3's
#     open / bearish c3's close -- same mapping as demand's gap reference.
#   - supply: c2's high must touch (reach up to, or through) bullish c3's
#     open / bearish c3's close -- *not* mirrored from the supply gap
#     reference; same open/close mapping as demand's touch reference,
#     checked against the high instead of the low.
#
# The zone box itself is drawn on c3 alone: demand from c3's low up to its
# gap reference, supply from its gap reference up to c3's high.
#
# The M5 buffer is cleared the moment the M15 trigger fires, and the M1
# buffer the moment the M5 zone forms, so the earliest possible c3 for each
# stage is exactly the candle that was still forming at that instant -- i.e.
# each search only starts evaluating once *that* candle has closed, not
# mid-candle.
#
# The demand side and the supply side are armed independently (two engine
# instances below) so both can be watching -- and can both fire -- at once.
#
# Stoploss is the farther of two distances from entry:
#   - "SL liquidity": walk backward candle by candle from the M1 zone's own
#     c3 candle, extending the stop past each earlier candle's low (buy) /
#     high (sell) as long as it keeps making a new extreme. This clears the
#     nearest real swing point instead of resting the stop right on top of it,
#     where retail liquidity (and stop-hunt wicks) tend to sit.
#   - "min SL": the user's manually entered minimum stop distance, used as a
#     floor in case the liquidity swing is too close to entry.

TRIGGER_TASK_NAME = "zone_trigger_watch"
SEARCH_M5_TASK_NAME = "zone_m5_watch"
SEARCH_M1_TASK_NAME = "zone_m1_watch"

CANDLE_BUFFER_MAXLEN = 12
SL_LIQUIDITY_LOOKBACK_CANDLES = 20
DEFAULT_TRIGGER_CHECK_CYCLE_SEC = 60.0
M1_SEARCH_INTERVAL_SEC = 60.0
M5_SEARCH_INTERVAL_SEC = 300.0


def _next_candle_open(timeframe_minutes: int) -> datetime:
    now = datetime.now()
    minutes_until_open = timeframe_minutes - (now.minute % timeframe_minutes)
    return now.replace(second=0, microsecond=0) + timedelta(minutes=minutes_until_open)


def _is_bullish(candle: Any) -> bool:
    return _candle_value(candle, 4, "close") > _candle_value(candle, 1, "open")


# wait_for_new_candle()'s simulated/dev-mode branch only carries open/close --
# no other caller has ever needed high/low from it. Zone detection needs the
# full candle range, so dev mode gets its own small synthetic M1/M5 generator
# here rather than changing that shared helper (which the existing
# pips-breakout strategy also relies on).
_sim_state: dict[str, dict[str, Any]] = {}


def _sim_next_candle(symbol: str, timeframe_label: str) -> Optional[dict[str, Any]]:
    key = f"zone:{timeframe_label}:{symbol}"
    now_ts = int(time.time())
    state = _sim_state.get(key)
    if state is not None and now_ts <= state["last_ts"]:
        return None
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
    _sim_state[key] = {"last_ts": now_ts, "close": close_price}
    return {"time": now_ts, 1: open_price, 2: high_price, 3: low_price, 4: close_price}


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
        self._search_m5_task_name = f"{SEARCH_M5_TASK_NAME}_{side}"
        self._search_m1_task_name = f"{SEARCH_M1_TASK_NAME}_{side}"
        self._state_path = f"zone_strategy.{side}"
        self._lock = threading.Lock()
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
        # end_time is a deadline enforced by task_manager across every stage
        # this run passes through -- see _end_time_kwargs.
        self.start_time: Optional[datetime] = None
        self.end_time: Optional[datetime] = None
        self.manual_sl_distance: float = 0.0
        self.sl_distance_in_pips: bool = True
        self.liquidity_buffer_pips: float = 0.0
        self.order_kind: str = "MARKET"
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
        self._last_symbol_error: Optional[str] = None

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
        order_kind = str(cfg.get("order_kind") or "MARKET").upper()
        if order_kind not in {"MARKET", "LIMIT"}:
            raise RuntimeError("Order type must be MARKET or LIMIT.")
        cfg_start_time = cfg.get("start_time")
        start_time = cfg_start_time if isinstance(cfg_start_time, datetime) else None
        cfg_end_time = cfg.get("end_time")
        end_time = cfg_end_time if isinstance(cfg_end_time, datetime) else None
        if end_time is not None and start_time is not None and end_time <= start_time:
            raise RuntimeError("End time must be later than start time.")
        if end_time is not None and end_time <= datetime.now():
            raise RuntimeError("End time must be in the future.")

        stop_task(self._trigger_task_name)
        stop_task(self._search_m5_task_name)
        stop_task(self._search_m1_task_name)

        with self._lock:
            self._reset_config()
            self.symbol = str(cfg.get("symbol") or SYMBOL_DEFAULT).strip().upper()
            self.trigger_price = trigger_price
            self.instant_m5_start = instant_m5_start
            self.dev_m1_start = dev_m1_start
            self.trigger_check_cycle_sec = trigger_check_cycle_sec
            self.manual_sl_distance = manual_sl_distance
            self.sl_distance_in_pips = bool(cfg.get("sl_distance_in_pips", True))
            self.liquidity_buffer_pips = float(cfg.get("liquidity_buffer_pips", 0) or 0)
            self.order_kind = order_kind
            self.lot = cfg.get("lot")
            self.risk_percent = cfg.get("risk_percent")
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
        phase = "searching_m1_zone" if dev_m1 else ("searching_m5_zone" if instant else "waiting_trigger")
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
                "instant_m5_start": instant,
                "dev_m1_start": dev_m1,
                "trigger_check_cycle_sec": self.trigger_check_cycle_sec,
                "manual_sl_distance": self.manual_sl_distance,
                "sl_distance_in_pips": self.sl_distance_in_pips,
                "liquidity_buffer_pips": self.liquidity_buffer_pips,
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
                "placed_order": None,
                "last_stop_reason": None,
                "last_error": None,
            },
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
                start_time=_next_candle_open(1),
                **self._end_time_kwargs(),
            )
        elif instant:
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
            next_candle_open = _next_candle_open(1)
            if self.start_time and self.start_time > datetime.now():
                anchor = self.start_time
                next_candle_open = anchor.replace(second=0, microsecond=0) + timedelta(minutes=1)
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
                **self._end_time_kwargs(),
            )

    def stop(self, reason: str = "Manual stop requested.") -> None:
        was_running = (
            is_task_running(self._trigger_task_name)
            or is_task_running(self._search_m5_task_name)
            or is_task_running(self._search_m1_task_name)
        )
        stop_task(self._trigger_task_name)
        stop_task(self._search_m5_task_name)
        stop_task(self._search_m1_task_name)
        if was_running:
            patch_path(self._state_path, {"running": False, "phase": "stopped", "last_stop_reason": reason})
            append_log("search", f"[WARNING] [scalping:{self.side}] {reason}")
        else:
            patch_path(self._state_path, {"running": False})

    def _end_time_kwargs(self) -> dict[str, Any]:
        """kwargs to splice into every start_task() call for this run, so
        the scheduled End Time (if any) follows the search through every
        stage it passes through -- task_manager only remembers end_time/
        on_task_end for the specific task it was given, not per-engine, so
        each new stage (trigger -> M5 -> M1, and M5 re-armed after a breach
        or a stalled M1 confirmation) has to be told again.
        """
        if not self.end_time:
            return {}
        return {
            "end_time": self.end_time,
            "end_time_enabled": True,
            "on_task_end": self._on_scheduled_end,
        }

    def _on_scheduled_end(self) -> None:
        """task_manager calls this once End Time is reached, from whichever
        stage (trigger/M5/M1 search) happens to be active then.

        Matches the Search page's End Time behavior: close whatever's open
        on this symbol (not scoped to just this side's own position -- the
        user asked for a plain close-all here, same as the Search page's
        default), then stop the search the normal way.
        """
        try:
            close_all_positions(symbol=self.symbol)
        except Exception as exc:
            append_log("search", f"[ERROR] [scalping:{self.side}] end-time close failed: {exc}")
        self.stop("End time reached.")

    def _ensure_symbol_or_log(self) -> bool:
        """Guard every MT5 rates/tick call the way open_manual_position() does.

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
        if not session_ok:
            with self._lock:
                already_reported = self._last_symbol_error == session_detail
                self._last_symbol_error = session_detail
            if not already_reported:
                append_log("search", f"[ERROR] [scalping:{self.side}] {session_detail}")
            return False

        ok, detail = _ensure_symbol_ready(self.symbol)
        if ok:
            with self._lock:
                self._last_symbol_error = None
            return True
        with self._lock:
            already_reported = self._last_symbol_error == detail
            self._last_symbol_error = detail
        if not already_reported:
            append_log("search", f"[ERROR] [scalping:{self.side}] {detail}")
        return False

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
            if not self._ensure_symbol_or_log():
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
            if not self._ensure_symbol_or_log():
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

    def _next_search_candle(self, timeframe_label: str) -> Optional[Any]:
        """Return each newly closed candle once, without a blocking wait.

        Search tasks run on their candle timeframe boundaries (one minute for
        M1 and five minutes for M5), so each run checks the latest closed bar
        once and compares its broker timestamp to prevent duplicate checks.
        """
        if not mt5_available():
            return _next_candle(self.symbol, timeframe_label)
        # Serialize only the MT5 calls. Holding this process-wide lock for the
        # whole search tick made the demand and supply workers wait on each
        # other's buffer checks and state transitions too.
        with MT5_LOCK:
            if not self._ensure_symbol_or_log():
                return None
            try:
                rates = mt5.copy_rates_from_pos(self.symbol, TIMEFRAME_MAP[timeframe_label], 1, 1)
            except Exception:
                return None
        if rates is None or len(rates) == 0:
            return None
        candle = rates[0]
        candle_time = int(candle["time"])
        with self._lock:
            if candle_time <= self._last_processed_candle_time[timeframe_label]:
                return None
            self._last_processed_candle_time[timeframe_label] = candle_time
        return candle

    def _start_m5_search(self) -> None:
        # Evaluate the latest completed M5 pattern as soon as the M15 trigger
        # starts this stage. Waiting for the next M5 close adds up to five
        # minutes even though three completed candles are already available.
        self._seed_buffer(self.m5_buffer, "M5", preload_count=3)
        with self._lock:
            zone = self._detect_gap_zone_locked(self.m5_buffer, self.m5_target_zone_type)
        if zone is not None:
            self._accept_m5_zone(zone)
            return
        start_task(
            self._search_m5_task_name,
            self._search_m5_tick,
            interval_sec=M5_SEARCH_INTERVAL_SEC,
            start_time=_next_candle_open(5),
            **self._end_time_kwargs(),
        )

    def _accept_m5_zone(self, zone: dict[str, Any]) -> None:
        stop_task(self._search_m5_task_name)
        self._seed_buffer(self.m1_buffer, "M1", preload_count=0)
        with self._lock:
            self.m5_zone = zone
        patch_path(self._state_path, {"phase": "searching_m1_zone", "m5_zone": zone})
        append_log(
            "search",
            f"[SUCCESS] [scalping:{self.side}] M5 zone {zone['price_low']:.2f}-{zone['price_high']:.2f}, searching M1.",
        )
        start_task(
            self._search_m1_task_name,
            self._search_m1_tick,
            interval_sec=M1_SEARCH_INTERVAL_SEC,
            start_time=_next_candle_open(1),
            **self._end_time_kwargs(),
        )

    def _search_m5_tick(self) -> None:
        candle = self._next_search_candle("M5")
        if candle is None:
            return
        with self._lock:
            self.m5_buffer.append(candle)
            zone = self._detect_gap_zone_locked(self.m5_buffer, self.m5_target_zone_type)
        if zone is None:
            return
        self._accept_m5_zone(zone)

    def _m5_zone_breached(self, price: float) -> bool:
        """Has price traded through the M5 zone while waiting on M1?

        A demand zone is invalidated the moment price closes below its own
        low (it didn't hold as support); a supply zone the moment price
        trades above its own high. Once that happens there's nothing left
        worth confirming with M1 -- the zone itself is no longer a valid
        demand/supply level.
        """
        zone = self.m5_zone
        if zone is None:
            return False
        if self.side == "demand":
            return price < zone["price_low"]
        return price > zone["price_high"]

    def _retreat_after_breach(self, reason: Optional[str] = None) -> None:
        """M5 zone invalidated (or its M1 confirmation gave up) mid-M1-search:
        drop back to hunting a fresh M5 zone instead of continuing to chase
        a level that no longer holds, or that price has already moved too
        far away from to still confirm against.

        `reason` overrides the default "breached" log wording -- used by the
        stalled-M1-confirmation case in _search_m1_tick, where the M5 zone
        itself was never actually breached, just left too far behind for the
        M1 side to keep confirming against.

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
            breach_time = int(self.m5_buffer[-1]["time"]) if self.m5_buffer else None
        breached_zone = (
            {
                **zone,
                "breached_at": breach_time if breach_time is not None else zone["displacement_candle_time"],
            }
            if zone
            else None
        )
        self._seed_buffer(self.m5_buffer, "M5", preload_count=3)
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
            if reason:
                append_log("search", f"[WARNING] [scalping:{self.side}] {reason}; searching a new M5 zone.")
            else:
                edge = "low" if self.side == "demand" else "high"
                append_log(
                    "search",
                    f"[WARNING] [scalping:{self.side}] M5 zone breached (price past {edge} "
                    f"{zone[f'price_{edge}']:.2f}); searching a new M5 zone.",
                )
        self._start_m5_search()

    def _search_m1_tick(self) -> None:
        price = self._current_price()
        if price is not None and self._m5_zone_breached(price):
            self._retreat_after_breach()
            return
        candle = self._next_search_candle("M1")
        if candle is None:
            return
        with self._lock:
            self.m1_buffer.append(candle)
            zone = self._detect_gap_zone_locked(self.m1_buffer, self.m1_target_zone_type)
            buffer_full = len(self.m1_buffer) >= CANDLE_BUFFER_MAXLEN
        if zone is None:
            if buffer_full:
                # A full buffer's worth of M1 candles has gone by without a
                # single matching c1/c2/c3 window -- in a fast, sustained
                # one-directional run, price rarely retraces onto a c3 base
                # long enough for the touch check to pass, so continuing to
                # wait here just lets the eventual entry drift further from
                # this M5 zone the longer it takes. Drop this zone and look
                # for a fresh one nearer to current price instead.
                self._retreat_after_breach(
                    f"M1 confirmation found no match in {CANDLE_BUFFER_MAXLEN} candles"
                )
            return
        # Publish as soon as a matching M1 zone is found so the chart can draw
        # it right away instead of only surfacing it the instant the order fires.
        patch_path(self._state_path, {"m1_zone": zone})
        stop_task(self._search_m1_task_name)
        append_log(
            "search",
            f"[SUCCESS] [scalping:{self.side}] M1 zone {zone['price_low']:.2f}-{zone['price_high']:.2f}, placing order.",
        )
        self._place_order(zone)

    @staticmethod
    def _c3_reference_prices(c3: Any, target_zone_type: str) -> tuple[float, float]:
        """The two c3 body-edge prices the gap check and the c2-touch check
        compare against -- see the module docstring for the full spec.

        Which edge (open vs. close) is picked depends on which way c3 itself
        closed, not a fixed choice regardless of direction. Returns
        (gap_reference, touch_reference); for demand these are the same
        price, for supply they're mirrored opposites of each other.
        """
        c3_bullish = _is_bullish(c3)
        c3_open = _candle_value(c3, 1, "open")
        c3_close = _candle_value(c3, 4, "close")
        if target_zone_type == "demand":
            ref = c3_close if not c3_bullish else c3_open
            return ref, ref
        gap_ref = c3_open if not c3_bullish else c3_close
        touch_ref = c3_open if c3_bullish else c3_close
        return gap_ref, touch_ref

    def _detect_gap_zone_locked(self, buffer: deque, target_zone_type: str) -> Optional[dict[str, Any]]:
        """3-candle imbalance/gap check, shared by both the M5 and M1
        searches -- see the module docstring for the full spec.

        c1 = the candle that just closed (newest), c2 = the one before it,
        c3 = two candles before c1 (oldest of the three). Needs 3 candles in
        `buffer`, which -- since the buffer is cleared/reseeded right as the
        prior stage completes -- means the first possible c3 is the candle
        that was still forming at that instant, so evaluation naturally
        can't start until that candle has closed.
        """
        if len(buffer) < 3:
            return None
        c3, c2, c1 = list(buffer)[-3:]
        gap_ref, touch_ref = self._c3_reference_prices(c3, target_zone_type)

        if target_zone_type == "demand":
            # The confirming candle must be bullish, as in the chart pattern:
            # c3 defines the base, c2 retests it, and bullish c1 confirms the
            # rejection before a demand entry is sent.
            if not _is_bullish(c1):
                return None
            c1_low = _candle_value(c1, 3, "low")
            if c1_low <= gap_ref:
                return None
            c2_low = _candle_value(c2, 3, "low")
            if c2_low > touch_ref:
                return None
            # Zone box drawn on c3 alone -- its low up to its gap reference.
            c3_low = _candle_value(c3, 3, "low")
            price_low, price_high = c3_low, gap_ref
        else:
            if _is_bullish(c1):
                return None
            c1_high = _candle_value(c1, 2, "high")
            if c1_high >= gap_ref:
                return None
            c2_high = _candle_value(c2, 2, "high")
            if c2_high < touch_ref:
                return None
            # Zone box drawn on c3 alone -- its gap reference up to its high.
            c3_high = _candle_value(c3, 2, "high")
            price_low, price_high = gap_ref, c3_high

        return {
            "type": target_zone_type,
            "price_high": round(float(price_high), 2),
            "price_low": round(float(price_low), 2),
            "base_candle_time": int(c3["time"]),
            "displacement_candle_time": int(c1["time"]),
            "formed_at": datetime.now().isoformat(),
        }

    def _m1_history_before_base(self) -> list[Any]:
        """M1 candles immediately preceding the zone's c3 (base) candle,
        oldest first.

        At the moment a zone is detected, c3 is 3 bars behind the
        currently-forming candle (c2 is 2 behind, c1 is 1 behind), so
        position 4 onward is exactly the history that precedes c3. In
        dev/sim mode there's no historical feed to query, so fall back to
        whatever the live search buffer happened to collect before the
        c1/c2/c3 window (best-effort only).
        """
        if mt5_available():
            with MT5_LOCK:
                try:
                    rates = mt5.copy_rates_from_pos(
                        self.symbol, TIMEFRAME_MAP["M1"], 4, SL_LIQUIDITY_LOOKBACK_CANDLES
                    )
                except Exception:
                    rates = None
            return list(rates) if rates is not None else []
        with self._lock:
            return list(self.m1_buffer)[:-3]

    def _sl_liquidity_price(self, zone: dict[str, Any], is_buy: bool) -> float:
        history = self._m1_history_before_base()
        extreme = zone["price_low"] if is_buy else zone["price_high"]
        for candle in reversed(history):
            candidate = (
                _candle_value(candle, 3, "low") if is_buy else _candle_value(candle, 2, "high")
            )
            if is_buy:
                if candidate >= extreme:
                    break
                extreme = candidate
            else:
                if candidate <= extreme:
                    break
                extreme = candidate
        return round(float(extreme), 2)

    def _place_order(self, zone: dict[str, Any]) -> None:
        is_buy = zone["type"] == "demand"
        side = "BUY" if is_buy else "SELL"
        position_candle_time: Optional[int] = None
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
            entry_price = (
                (zone["price_high"] if is_buy else zone["price_low"])
                if self.order_kind == "LIMIT"
                else market_price
            )
            sl_liquidity_price = self._sl_liquidity_price(zone, is_buy)
            liquidity_buffer = self.liquidity_buffer_pips / 10.0
            sl_liquidity_distance = abs(entry_price - sl_liquidity_price) + liquidity_buffer
            min_sl_distance = self.manual_sl_distance / 10.0 if self.sl_distance_in_pips else self.manual_sl_distance
            final_distance = max(sl_liquidity_distance, min_sl_distance)
            sl_price = entry_price - final_distance if is_buy else entry_price + final_distance
            append_log(
                "search",
                f"[INFO] [scalping:{self.side}] {side} @ {entry_price:.2f}, SL {sl_price:.2f} "
                f"(liquidity {sl_liquidity_price:.2f}).",
            )

            # Multi-TP, ratio-based against the SL this engine just computed
            # above -- same mechanism as manual trade's Advanced Risk panel,
            # but fed the strategy's own stop instead of a manually typed
            # Stop Loss Price, since scalping never has one of those.
            open_manual_position(
                side,
                lot_size=self.lot,
                symbol=self.symbol,
                order_kind=self.order_kind,
                limit_price=entry_price if self.order_kind == "LIMIT" else None,
                risk_percent=self.risk_percent,
                advanced=True,
                sl_price=sl_price,
                ratio=self.tp1_ratio,
                tp1_ratio=self.tp1_ratio,
                tp2_ratio=self.tp2_ratio,
                tp3_ratio=self.tp3_ratio,
                tp2_enabled=self.tp2_enabled,
                tp3_enabled=self.tp3_enabled,
                tp1_percent=self.tp1_percent,
                tp2_percent=self.tp2_percent,
            )
        except RuntimeError as exc:
            patch_path(self._state_path, {"phase": "error", "running": False, "last_error": str(exc)})
            append_log("search", f"[ERROR] [scalping:{self.side}] order failed: {exc}")
            return

        placed_orders = get("orders", [])
        placed = placed_orders[-1] if placed_orders else {}
        if position_candle_time is not None:
            zone["position_candle_time"] = position_candle_time
        patch_path(
            self._state_path,
            {
                "phase": "placed",
                "running": False,
                "m1_zone": zone,
                "sl_liquidity_price": sl_liquidity_price,
                # A breached-and-superseded zone from earlier in this run is
                # no longer relevant once a trade is actually live -- drop it
                # so the chart isn't left showing a greyed-out box alongside
                # the live entry/SL/TP lines.
                "last_breached_m5_zone": None,
                "placed_order": {
                    "ticket": placed.get("ticket"),
                    "side": side,
                    "entry": placed.get("entry", entry_price),
                    "sl": placed.get("sl", sl_price),
                    "tp": placed.get("tp"),
                    "lot": placed.get("lot"),
                    "order_kind": self.order_kind,
                    "created_at": placed.get("created_at"),
                },
            },
        )


zone_manager_demand = ZoneStrategyEngine("demand")
zone_manager_supply = ZoneStrategyEngine("supply")
_zone_managers = {"demand": zone_manager_demand, "supply": zone_manager_supply}


def start_zone_strategy_system(cfg: dict) -> None:
    side = str(cfg.get("trigger_zone_type", "")).lower()
    if side not in _zone_managers:
        raise RuntimeError("trigger_zone_type must be 'demand' or 'supply'.")
    _zone_managers[side].start(cfg)


def stop_zone_strategy_system(side: Optional[str] = None) -> None:
    if side:
        normalized = side.lower()
        if normalized not in _zone_managers:
            raise RuntimeError("side must be 'demand' or 'supply'.")
        _zone_managers[normalized].stop()
        return
    for manager in _zone_managers.values():
        manager.stop()
