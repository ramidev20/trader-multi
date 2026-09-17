from __future__ import annotations

import random
import threading
import time
from collections import deque
from datetime import datetime
from typing import Any, Optional

from .mt5_compat import mt5, mt5_available
from .runtime_state import append_log, get, patch_path
from .task_manager import is_task_running, start_task, stop_task
from .strategy_service import (
    SYMBOL_DEFAULT,
    TIMEFRAME_MAP,
    _candle_value,
    _tick_for,
    open_manual_position,
    wait_for_new_candle,
)

# "Scalping" strategy: watch a manually entered M15 demand/supply price level.
# Once price touches it, watch new M5 candles going forward for that *same*
# zone type (demand input -> search demand, and vice versa). Once that M5 zone
# forms, don't trade off it directly -- instead watch new M1 candles going
# forward for a zone of that same type again, confirming demand -> demand ->
# demand (or supply -> supply -> supply) before actually opening. Zones are
# detected with a simple base-candle + displacement-candle definition. The M1
# zone is what actually places the MARKET/LIMIT order.
#
# The demand side and the supply side are armed independently (two engine
# instances below) so both can be watching -- and can both fire -- at once.
#
# Stoploss is the farther of two distances from entry:
#   - "SL liquidity": walk backward candle by candle from the M1 zone's own
#     base candle, extending the stop past each earlier candle's low (buy) /
#     high (sell) as long as it keeps making a new extreme. This clears the
#     nearest real swing point instead of resting the stop right on top of it,
#     where retail liquidity (and stop-hunt wicks) tend to sit.
#   - "min SL": the user's manually entered minimum stop distance, used as a
#     floor in case the liquidity swing is too close to entry.

TRIGGER_TASK_NAME = "zone_trigger_watch"
SEARCH_M5_TASK_NAME = "zone_m5_watch"
SEARCH_M1_TASK_NAME = "zone_m1_watch"

DEFAULT_DISPLACEMENT_MIN_PIPS = 15.0
DEFAULT_DISPLACEMENT_AVG_MULTIPLIER = 1.8
DEFAULT_BASE_MAX_BODY_RATIO = 0.6
CANDLE_BUFFER_MAXLEN = 12
AVG_LOOKBACK_CANDLES = 10
SL_LIQUIDITY_LOOKBACK_CANDLES = 20
DEFAULT_TRIGGER_CHECK_CYCLE_SEC = 60.0
MIN_TRIGGER_CHECK_CYCLE_SEC = 1.0


def _body_pips(candle: Any) -> float:
    open_price = _candle_value(candle, 1, "open")
    close_price = _candle_value(candle, 4, "close")
    return abs(close_price - open_price) * 10.0


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
        self.trigger_check_cycle_sec: float = DEFAULT_TRIGGER_CHECK_CYCLE_SEC
        self.manual_sl_distance: float = 0.0
        self.sl_distance_in_pips: bool = True
        self.liquidity_buffer_pips: float = 0.0
        self.order_kind: str = "MARKET"
        self.lot: Optional[float] = None
        self.risk_percent: Optional[float] = None
        self.tp: Optional[float] = None
        self.tp_in_pips: bool = True
        self.displacement_min_pips: float = DEFAULT_DISPLACEMENT_MIN_PIPS
        self.displacement_avg_multiplier: float = DEFAULT_DISPLACEMENT_AVG_MULTIPLIER
        self.base_max_body_ratio: float = DEFAULT_BASE_MAX_BODY_RATIO
        self.m5_buffer: deque = deque(maxlen=CANDLE_BUFFER_MAXLEN)
        self.m1_buffer: deque = deque(maxlen=CANDLE_BUFFER_MAXLEN)
        self.last_mid: Optional[float] = None

    def start(self, cfg: dict) -> None:
        manual_sl_distance = float(cfg.get("manual_sl_distance", 0) or 0)
        if manual_sl_distance <= 0:
            raise RuntimeError("Enter a manual stoploss distance greater than 0.")
        instant_m5_start = bool(cfg.get("instant_m5_start", False))
        trigger_price = float(cfg.get("trigger_price", 0) or 0)
        if not instant_m5_start and trigger_price <= 0:
            raise RuntimeError("Enter a valid trigger price.")
        trigger_check_cycle_sec = max(
            MIN_TRIGGER_CHECK_CYCLE_SEC,
            float(cfg.get("trigger_check_cycle_sec") or DEFAULT_TRIGGER_CHECK_CYCLE_SEC),
        )
        order_kind = str(cfg.get("order_kind") or "MARKET").upper()
        if order_kind not in {"MARKET", "LIMIT"}:
            raise RuntimeError("Order type must be MARKET or LIMIT.")

        stop_task(self._trigger_task_name)
        stop_task(self._search_m5_task_name)
        stop_task(self._search_m1_task_name)

        with self._lock:
            self._reset_config()
            self.symbol = str(cfg.get("symbol") or SYMBOL_DEFAULT).strip().upper()
            self.trigger_price = trigger_price
            self.instant_m5_start = instant_m5_start
            self.trigger_check_cycle_sec = trigger_check_cycle_sec
            self.manual_sl_distance = manual_sl_distance
            self.sl_distance_in_pips = bool(cfg.get("sl_distance_in_pips", True))
            self.liquidity_buffer_pips = float(cfg.get("liquidity_buffer_pips", 0) or 0)
            self.order_kind = order_kind
            self.lot = cfg.get("lot")
            self.risk_percent = cfg.get("risk_percent")
            self.tp = cfg.get("tp")
            self.tp_in_pips = bool(cfg.get("tp_in_pips", True))
            self.displacement_min_pips = float(cfg.get("displacement_min_pips") or DEFAULT_DISPLACEMENT_MIN_PIPS)
            self.displacement_avg_multiplier = float(cfg.get("displacement_avg_multiplier") or DEFAULT_DISPLACEMENT_AVG_MULTIPLIER)
            self.base_max_body_ratio = float(cfg.get("base_max_body_ratio") or DEFAULT_BASE_MAX_BODY_RATIO)

        started_at = datetime.now().isoformat()
        instant = self.instant_m5_start
        patch_path(
            self._state_path,
            {
                "running": True,
                "phase": "searching_m5_zone" if instant else "waiting_trigger",
                "symbol": self.symbol,
                "trigger_price": self.trigger_price,
                "trigger_zone_type": self.trigger_zone_type,
                "m5_target_zone_type": self.m5_target_zone_type,
                "m1_target_zone_type": self.m1_target_zone_type,
                "order_kind": self.order_kind,
                "instant_m5_start": instant,
                "trigger_check_cycle_sec": self.trigger_check_cycle_sec,
                "manual_sl_distance": self.manual_sl_distance,
                "sl_distance_in_pips": self.sl_distance_in_pips,
                "liquidity_buffer_pips": self.liquidity_buffer_pips,
                "lot": self.lot,
                "risk_percent": self.risk_percent,
                "tp": self.tp,
                "tp_in_pips": self.tp_in_pips,
                "started_at": started_at,
                "triggered_at": started_at if instant else None,
                "m5_zone": None,
                "m1_zone": None,
                "sl_liquidity_price": None,
                "placed_order": None,
                "last_stop_reason": None,
                "last_error": None,
            },
        )
        if instant:
            append_log(
                "search",
                f"[INFO] [scalping] armed: instant M5 start for {self.symbol} -- treating M15 "
                f"{self.trigger_zone_type} as already triggered, searching M5 for "
                f"{self.m5_target_zone_type} directly, then M1 for {self.m1_target_zone_type} before opening.",
            )
            with self._lock:
                self.m5_buffer.clear()
            start_task(self._search_m5_task_name, self._search_m5_tick, interval_sec=1)
        else:
            append_log(
                "search",
                f"[INFO] [scalping] armed: watching {self.symbol} for {self.trigger_zone_type} trigger @ "
                f"{self.trigger_price:.2f} (checked every {self.trigger_check_cycle_sec:.0f}s); will search M5 "
                f"for {self.m5_target_zone_type}, then M1 for {self.m1_target_zone_type} before opening.",
            )
            start_task(self._trigger_task_name, self._trigger_tick, interval_sec=self.trigger_check_cycle_sec)

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
            append_log("search", f"[WARNING] [scalping] {reason}")
        else:
            patch_path(self._state_path, {"running": False})

    def _trigger_tick(self) -> None:
        # Runs every `trigger_check_cycle_sec` (not the M5/M1 searches' fixed
        # 1s) -- only the M15 trigger wait is meant to be checked this
        # infrequently.
        tick = mt5.symbol_info_tick(self.symbol) if mt5_available() else _tick_for(self.symbol)
        if tick is None:
            return
        mid = (float(tick.ask) + float(tick.bid)) / 2.0
        with self._lock:
            last_mid = self.last_mid
            self.last_mid = mid
            trigger_price = self.trigger_price
        if last_mid is None:
            return
        crossed = (last_mid - trigger_price) * (mid - trigger_price) <= 0
        if not crossed:
            return

        stop_task(self._trigger_task_name)
        with self._lock:
            self.m5_buffer.clear()
            m5_target_zone_type = self.m5_target_zone_type
        triggered_at = datetime.now().isoformat()
        patch_path(self._state_path, {"phase": "searching_m5_zone", "triggered_at": triggered_at})
        append_log(
            "search",
            f"[INFO] [scalping] M15 trigger hit @ {mid:.2f} (level {trigger_price:.2f}); "
            f"searching M5 for {m5_target_zone_type}.",
        )
        start_task(self._search_m5_task_name, self._search_m5_tick, interval_sec=1)

    def _search_m5_tick(self) -> None:
        candle = _next_candle(self.symbol, "M5")
        if candle is None:
            return
        with self._lock:
            self.m5_buffer.append(candle)
            zone = self._detect_zone_locked(self.m5_buffer, self.m5_target_zone_type)
            m1_target_zone_type = self.m1_target_zone_type
        if zone is None:
            return
        stop_task(self._search_m5_task_name)
        with self._lock:
            self.m1_buffer.clear()
        patch_path(self._state_path, {"phase": "searching_m1_zone", "m5_zone": zone})
        append_log(
            "search",
            f"[SUCCESS] [scalping] M5 {zone['type']} zone found {zone['price_low']:.2f}-{zone['price_high']:.2f}; "
            f"searching M1 for {m1_target_zone_type} before opening.",
        )
        start_task(self._search_m1_task_name, self._search_m1_tick, interval_sec=1)

    def _search_m1_tick(self) -> None:
        candle = _next_candle(self.symbol, "M1")
        if candle is None:
            return
        with self._lock:
            self.m1_buffer.append(candle)
            zone = self._detect_zone_locked(self.m1_buffer, self.m1_target_zone_type)
        if zone is None:
            return
        stop_task(self._search_m1_task_name)
        patch_path(self._state_path, {"m1_zone": zone})
        append_log(
            "search",
            f"[SUCCESS] [scalping] M1 {zone['type']} zone found {zone['price_low']:.2f}-{zone['price_high']:.2f}; placing order.",
        )
        self._place_order(zone)

    def _detect_zone_locked(self, buffer: deque, target_zone_type: str) -> Optional[dict[str, Any]]:
        if len(buffer) < 2:
            return None
        candles = list(buffer)
        base = candles[-2]
        displacement = candles[-1]
        history = candles[:-1][-AVG_LOOKBACK_CANDLES:]
        avg_body = sum(_body_pips(c) for c in history) / len(history) if len(history) >= 3 else 0.0
        threshold = max(self.displacement_min_pips, avg_body * self.displacement_avg_multiplier)

        disp_body = _body_pips(displacement)
        if disp_body < threshold:
            return None
        base_body = _body_pips(base)
        if base_body > disp_body * self.base_max_body_ratio:
            return None

        zone_type = "demand" if _is_bullish(displacement) else "supply"
        if zone_type != target_zone_type:
            return None

        return {
            "type": zone_type,
            "price_high": round(float(_candle_value(base, 2, "high")), 2),
            "price_low": round(float(_candle_value(base, 3, "low")), 2),
            "base_candle_time": int(base["time"]),
            "displacement_candle_time": int(displacement["time"]),
            "formed_at": datetime.now().isoformat(),
        }

    def _m1_history_before_base(self) -> list[Any]:
        """M1 candles immediately preceding the zone's base candle, oldest first.

        At the moment a zone is detected the base candle is 2 bars behind the
        currently-forming one and the displacement candle is 1 bar behind, so
        position 3 onward is exactly the history that precedes the base
        candle. In dev/sim mode there's no historical feed to query, so fall
        back to whatever the live search buffer happened to collect before
        the base/displacement pair (best-effort only).
        """
        if mt5_available():
            try:
                rates = mt5.copy_rates_from_pos(self.symbol, TIMEFRAME_MAP["M1"], 3, SL_LIQUIDITY_LOOKBACK_CANDLES)
            except Exception:
                rates = None
            return list(rates) if rates is not None else []
        with self._lock:
            return list(self.m1_buffer)[:-2]

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
        try:
            tick = mt5.symbol_info_tick(self.symbol) if mt5_available() else _tick_for(self.symbol)
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
                f"[INFO] [scalping] SL liquidity @ {sl_liquidity_price:.2f} + {self.liquidity_buffer_pips:.1f} pip buffer "
                f"(distance {sl_liquidity_distance:.2f}), min SL distance {min_sl_distance:.2f}; "
                f"using {final_distance:.2f} -> SL {sl_price:.2f}.",
            )

            open_manual_position(
                side,
                lot_size=self.lot,
                tp=self.tp,
                sl=sl_price,
                symbol=self.symbol,
                order_kind=self.order_kind,
                limit_price=entry_price if self.order_kind == "LIMIT" else None,
                tp_in_pips=self.tp_in_pips,
                sl_in_pips=False,
                risk_percent=self.risk_percent,
            )
        except RuntimeError as exc:
            patch_path(self._state_path, {"phase": "error", "running": False, "last_error": str(exc)})
            append_log("search", f"[ERROR] [scalping] order failed: {exc}")
            return

        placed_orders = get("orders", [])
        placed = placed_orders[-1] if placed_orders else {}
        patch_path(
            self._state_path,
            {
                "phase": "placed",
                "running": False,
                "sl_liquidity_price": sl_liquidity_price,
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
