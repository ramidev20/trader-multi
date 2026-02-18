import time
import uuid
import threading
from typing import Dict, List, Optional

import MetaTrader5 as mt5


SYMBOL_DEFAULT = "XAUUSD"


# ===================== Strategy (your old function, unchanged) =====================

def open_order_strategy(config_data):
    """
    Required config keys:
      - min_pips (or legacy pips)
      - max_pips
      - lot
      - tp_type (True=TP in pips, False=absolute price)
      - tp
      - sl_type (True=SL in pips, False=absolute price)
      - sl
      - candle (CLOSED candle row)
      - order_delay (seconds)
    Optional:
      - symbol (default XAUUSD)
      - forced_side: "buy" or "sell" (Liquidity forces direction)
    """

    def body_pips(open_price, close_price):
        return round((open_price - close_price) * 10, 3)

    min_pips = config_data.get("min_pips", config_data.get("pips"))
    max_pips = config_data["max_pips"]
    lot = config_data["lot"]
    tp_type = config_data["tp_type"]
    tp_val = config_data["tp"]
    sl_type = config_data["sl_type"]
    sl_val = config_data["sl"]
    candle = config_data["candle"]
    delay = config_data.get("order_delay", 0.0)
    symbol = config_data.get("symbol", SYMBOL_DEFAULT)

    if min_pips is None:
        raise KeyError('config_data must contain "min_pips" (or legacy "pips")')

    pips = body_pips(candle[1], candle[4])

    # candle body filter
    if not (float(min_pips) <= abs(pips) <= float(max_pips)):
        return None

    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        return None

    forced_side = config_data.get("forced_side")  # "buy"/"sell"/None

    if forced_side == "buy":
        order_type = mt5.ORDER_TYPE_BUY
        entry_price = tick.ask
    elif forced_side == "sell":
        order_type = mt5.ORDER_TYPE_SELL
        entry_price = tick.bid
    else:
        # fallback: direction by candle body
        if pips < 0:
            order_type = mt5.ORDER_TYPE_BUY
            entry_price = tick.ask
        else:
            order_type = mt5.ORDER_TYPE_SELL
            entry_price = tick.bid

    if tp_type:
        tp = (entry_price + (tp_val / 10)) if order_type == mt5.ORDER_TYPE_BUY else (entry_price - (tp_val / 10))
    else:
        tp = float(tp_val)

    if sl_type:
        sl = (entry_price - (sl_val / 10)) if order_type == mt5.ORDER_TYPE_BUY else (entry_price + (sl_val / 10))
    else:
        sl = float(sl_val)

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": float(lot),
        "type": order_type,
        "price": float(entry_price),
        "tp": float(tp),
        "sl": float(sl),
        "deviation": 20,
        "magic": 1000,
        "comment": "strategy position",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_FOK,
    }

    if delay and delay > 0:
        time.sleep(float(delay))

    return mt5.order_send(request)


# ===================== Strategy Service (updated: pending stays forever) =====================

class StrategyService:
    def __init__(self):
        self.running: bool = False
        self.config: Dict = {}
        self._thread: Optional[threading.Thread] = None
        self._stop_flag = threading.Event()

        # Liquidity items stored here
        # item: {id, price, side, triggered}
        self.liquidity: List[Dict] = []

        # to avoid spamming orders every loop
        self._last_trade_time = 0.0
        self.min_trade_interval_sec = 2.0  # simple safety

        # ✅ pending liquidity confirmation state (REPLACE behavior, NO TIMEOUT)
        # stays until confirmation candle occurs OR another liquidity hit replaces it
        self.pending_liq: Optional[Dict] = None
        # example: {"id": "...", "side": "buy"/"sell", "price": 0.0, "armed_at": time.time()}

        # ✅ volume confirmation settings
        self.volume_lookback: int = 20
        self.volume_rule: str = "above_avg"  # "above_avg" | "max" | "min"
        self.last_event: str = ""
        self.last_event_at: float = 0.0

    # ---------- MT5 helpers ----------

    def _ensure_mt5(self) -> bool:
        if mt5.initialize():
            return True
        return False

    def _get_last_closed_candle(self, symbol: str, timeframe: int):
        """
        Returns a row like:
        [time, open, high, low, close, tick_volume, spread, real_volume]
        """
        rates = mt5.copy_rates_from_pos(symbol, timeframe, 1, 1)  # pos=1 = last CLOSED candle
        if rates is None or len(rates) == 0:
            return None
        r = rates[0]
        return [r["time"], r["open"], r["high"], r["low"], r["close"], r["tick_volume"], r["spread"], r["real_volume"]]

    def _get_recent_closed_candles(self, symbol: str, timeframe: int, count: int):
        """
        Returns list of rows (oldest->newest):
        [time, open, high, low, close, tick_volume, spread, real_volume]
        """
        if count <= 0:
            return []

        rates = mt5.copy_rates_from_pos(symbol, timeframe, 1, count)  # last `count` CLOSED candles
        if rates is None or len(rates) == 0:
            return []

        out = []
        for r in rates:
            out.append([r["time"], r["open"], r["high"], r["low"], r["close"], r["tick_volume"], r["spread"], r["real_volume"]])
        return out

    def _candle_side(self, candle_row) -> str:
        o = float(candle_row[1])
        c = float(candle_row[4])
        if c > o:
            return "buy"
        if c < o:
            return "sell"
        return "neutral"

    def _volume_ok(self, symbol: str, timeframe: int, candle_row) -> bool:
        """
        preferred volume rule:
          - above_avg: tick_volume >= avg(last N closed candles tick_volume)
          - max: tick_volume >= max(last N closed candles tick_volume)
          - min: tick_volume <= min(last N closed candles tick_volume)
        """
        try:
            v = float(candle_row[5] or 0.0)  # tick_volume at index 5
        except Exception:
            return True

        candles = self._get_recent_closed_candles(symbol, timeframe, self.volume_lookback)
        if not candles:
            return True

        vols = []
        for r in candles:
            try:
                vols.append(float(r[5] or 0.0))
            except Exception:
                pass

        if not vols:
            return True

        if self.volume_rule == "max":
            return v >= max(vols)
        if self.volume_rule == "min":
            return v <= min(vols)

        avg = sum(vols) / len(vols)
        return v >= avg

    # ---------- Public API ----------

    def _set_event(self, text: str):
        if text == self.last_event:
            return
        self.last_event = text
        self.last_event_at = time.time()
        print(f"[strategy] {text}")

    def get_status(self):
        return {
            "running": self.running,
            "pending_liq": self.pending_liq,
            "config": self.config,
            "last_event": self.last_event,
            "last_event_at": self.last_event_at,
        }

    def _is_order_success(self, retcode) -> bool:
        """
        MT5 success retcodes for trade requests.
        10009: DONE, 10010: DONE_PARTIAL, 10008: PLACED
        """
        if retcode is None:
            return False
        success_codes = {
            getattr(mt5, "TRADE_RETCODE_DONE", 10009),
            getattr(mt5, "TRADE_RETCODE_DONE_PARTIAL", 10010),
            getattr(mt5, "TRADE_RETCODE_PLACED", 10008),
        }
        try:
            return int(retcode) in success_codes
        except Exception:
            return False

    def start(self, config: dict):
        self.config = dict(config)
        self.running = True
        self._stop_flag.clear()

        # keep pending_liq as-is or reset?
        # Usually reset when starting to avoid stale intent:
        self.pending_liq = None
        self._set_event("started")

        if self._thread is None or not self._thread.is_alive():
            self._thread = threading.Thread(target=self._run_loop, daemon=True)
            self._thread.start()

    def stop(self):
        self.running = False
        self._stop_flag.set()
        self.pending_liq = None
        self._set_event("stopped")

    # ---------- Liquidity CRUD ----------

    def get_liquidity(self):
        return self.liquidity

    def add_liquidity(self, price: float, side: str):
        item = {
            "id": str(uuid.uuid4()),
            "price": float(price),
            "side": side,          # "buy" or "sell"
            "triggered": False,
        }
        self.liquidity.append(item)
        return item

    def update_liquidity(self, liq_id: str, price: float):
        for l in self.liquidity:
            if l["id"] == liq_id and not l["triggered"]:
                l["price"] = float(price)
                return l
        return None

    def delete_liquidity(self, liq_id: str):
        self.liquidity = [l for l in self.liquidity if l["id"] != liq_id]
        if self.pending_liq and self.pending_liq.get("id") == liq_id:
            self.pending_liq = None

    # ---------- Runner loop ----------

    def _run_loop(self):
        """
        Loop:
          - ensure MT5
          - check liquidity trigger using current tick
          - if hit => mark triggered and REPLACE pending_liq (NO TIMEOUT)
          - fetch last CLOSED candle
          - if pending_liq exists -> wait for candle confirmation (same side + preferred volume)
          - only then call open_order_strategy(config + candle + forced_side)
        """
        if not self._ensure_mt5():
            self.running = False
            return

        while not self._stop_flag.is_set():
            try:
                symbol = self.config.get("symbol", SYMBOL_DEFAULT)
                timeframe = int(self.config.get("timeframe", mt5.TIMEFRAME_M1))

                tick = mt5.symbol_info_tick(symbol)
                if tick is None:
                    time.sleep(0.25)
                    continue

                # ---- liquidity trigger check (REPLACE pending, NO TIMEOUT) ----
                for liq in self.liquidity:
                    if liq["triggered"]:
                        continue

                    price = float(liq["price"])
                    side = liq["side"]  # "buy" | "sell"

                    hit = False
                    if side == "buy" and tick.ask <= price:
                        hit = True
                    elif side == "sell" and tick.bid >= price:
                        hit = True

                    if hit:
                        liq["triggered"] = True

                        # ✅ REPLACE pending with new liquidity hit
                        self.pending_liq = {
                            "id": liq["id"],
                            "side": side,
                            "price": price,
                            "armed_at": time.time(),
                            "armed_candle_time": None,
                        }
                        self._set_event(f"liquidity_triggered:{side}@{price}")
                        break  # only one hit per loop

                candle = self._get_last_closed_candle(symbol, timeframe)
                if candle is None:
                    time.sleep(0.25)
                    continue

                # ---- throttle trades ----
                now = time.time()
                if now - self._last_trade_time < self.min_trade_interval_sec:
                    time.sleep(0.2)
                    continue

                # Liquidity-driven only: do not place auto/candle-only orders.
                if not self.pending_liq:
                    time.sleep(0.2)
                    continue

                desired = self.pending_liq["side"]  # "buy" | "sell"
                c_time = int(candle[0])

                if self.pending_liq.get("armed_candle_time") is None:
                    self.pending_liq["armed_candle_time"] = c_time
                    self._set_event(
                        f"pending_wait_next_candle from {c_time} for {desired}"
                    )
                    time.sleep(0.2)
                    continue

                if c_time <= int(self.pending_liq.get("armed_candle_time", 0)):
                    time.sleep(0.2)
                    continue

                # Avoid retry spam inside the same closed candle.
                if c_time == int(self.pending_liq.get("last_attempt_candle_time", 0)):
                    time.sleep(0.2)
                    continue

                # 1) candle direction must match liquidity side
                c_side = self._candle_side(candle)
                if c_side != desired:
                    self._set_event(
                        f"pending_wait_direction need={desired} got={c_side} candle={c_time}"
                    )
                    time.sleep(0.2)
                    continue

                # 2) preferred volume must match
                if not self._volume_ok(symbol, timeframe, candle):
                    self._set_event(
                        f"pending_wait_volume rule={self.volume_rule} candle={c_time}"
                    )
                    time.sleep(0.2)
                    continue

                self.pending_liq["last_attempt_candle_time"] = c_time

                cfg = dict(self.config)
                cfg["candle"] = candle
                cfg["forced_side"] = desired

                result = open_order_strategy(cfg)

                if result is not None:
                    retcode = getattr(result, "retcode", None)
                    self._set_event(f"order_attempt side={desired} retcode={retcode}")

                    if self._is_order_success(retcode):
                        self._last_trade_time = time.time()
                        liq_id = self.pending_liq.get("id")
                        self.liquidity = [l for l in self.liquidity if l.get("id") != liq_id]
                        self._set_event(
                            f"pending_confirmed_trade_opened removed_liq={liq_id}"
                        )
                        self.pending_liq = None
                    else:
                        self._set_event(
                            f"order_rejected_wait_next_candle side={desired} retcode={retcode}"
                        )
                else:
                    self._set_event("order_skipped_by_filters_or_tick")

                time.sleep(0.2)

            except Exception as e:
                self._set_event(f"loop_error:{e}")
                time.sleep(0.5)


strategy_service = StrategyService()

