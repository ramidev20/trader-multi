import threading
import time
from dataclasses import dataclass, asdict
from datetime import datetime, time as dtime
from typing import Optional, Dict, Any

import MetaTrader5 as mt5

from app.services.mt5_service import (
    is_logged_in,
    get_account_info,
    get_open_positions,
    close_all_positions,
)
from app.services.strategy_service import strategy_service


@dataclass
class RiskConfig:
    enabled: bool = True
    symbol: str = "XAUUSD"

    # limits in account currency
    maxDailyLoss: float = 250.0
    maxDrawdown: float = 500.0
    stopAfterProfit: float = 300.0
    maxOpenPositions: int = 2

    disableNewTradesOnLimit: bool = True
    closePositionsOnLimit: bool = False


@dataclass
class RiskStatus:
    running: bool = False
    limit_hit: bool = False
    reason: Optional[str] = None
    action_taken: Optional[str] = None

    balance: Optional[float] = None
    equity: Optional[float] = None
    floating_pnl: Optional[float] = None
    today_pnl: Optional[float] = None

    config: Optional[Dict[str, Any]] = None


class RiskService:
    def __init__(self):
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()

        self.config = RiskConfig()
        self.status = RiskStatus(running=False, config=asdict(self.config))

        self._peak_equity: Optional[float] = None
        self.block_new_trades: bool = False

    def start(self, cfg: Dict[str, Any]):
        with self._lock:
            base = asdict(RiskConfig())
            base.update(cfg or {})
            self.config = RiskConfig(**base)

            self.status = RiskStatus(
                running=True,
                limit_hit=False,
                reason=None,
                action_taken=None,
                config=asdict(self.config),
            )
            self._peak_equity = None
            self.block_new_trades = False
            self._stop.clear()

            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(target=self._loop, daemon=True)
                self._thread.start()

    def stop(self):
        with self._lock:
            self.status.running = False
            self._stop.set()

    def get_status(self) -> Dict[str, Any]:
        with self._lock:
            return asdict(self.status)

    def _today_realized_pnl(self) -> float:
        if not is_logged_in():
            return 0.0

        now = datetime.now()
        start = datetime.combine(now.date(), dtime(0, 0, 0))
        end = now

        deals = mt5.history_deals_get(start, end)
        if deals is None:
            return 0.0

        total = 0.0
        for d in deals:
            try:
                total += float(d.profit)
            except Exception:
                pass
        return float(total)

    def _hit(self, reason: str):
        # stop strategy immediately
        try:
            strategy_service.stop()
        except Exception:
            pass

        action = "strategy_stopped"

        if self.config.closePositionsOnLimit:
            try:
                close_all_positions()
                action += "+positions_closed"
            except Exception:
                action += "+close_failed"

        if self.config.disableNewTradesOnLimit:
            self.block_new_trades = True

        self.status.limit_hit = True
        self.status.reason = reason
        self.status.action_taken = action

    def _loop(self):
        while not self._stop.is_set():
            time.sleep(1.0)

            with self._lock:
                if not self.status.running:
                    continue
                if not self.config.enabled:
                    continue

                # if already hit, keep updating stats but don't trigger again
                already_hit = bool(self.status.limit_hit)

            if not is_logged_in():
                with self._lock:
                    self.status.balance = None
                    self.status.equity = None
                    self.status.floating_pnl = None
                    self.status.today_pnl = None
                continue

            acc = get_account_info() or {}
            balance = float(acc.get("balance") or 0.0)
            equity = float(acc.get("equity") or 0.0)
            floating = float(acc.get("profit") or 0.0)
            today = float(self._today_realized_pnl())

            open_positions = get_open_positions(symbol=None) or []
            open_count = len(open_positions)

            with self._lock:
                self.status.balance = balance
                self.status.equity = equity
                self.status.floating_pnl = floating
                self.status.today_pnl = today

                if self._peak_equity is None:
                    self._peak_equity = equity
                else:
                    self._peak_equity = max(self._peak_equity, equity)

                if already_hit:
                    continue

                # drawdown check
                if self.config.maxDrawdown and self.config.maxDrawdown > 0 and self._peak_equity is not None:
                    dd = self._peak_equity - equity
                    if dd >= float(self.config.maxDrawdown):
                        self._hit(f"MaxDrawdown hit (dd={dd:.2f} >= {self.config.maxDrawdown:.2f})")
                        continue

                # daily loss
                if self.config.maxDailyLoss and self.config.maxDailyLoss > 0:
                    if today <= -float(self.config.maxDailyLoss):
                        self._hit(f"MaxDailyLoss hit (today_pnl={today:.2f} <= -{self.config.maxDailyLoss:.2f})")
                        continue

                # stop after profit
                if self.config.stopAfterProfit and self.config.stopAfterProfit > 0:
                    if today >= float(self.config.stopAfterProfit):
                        self._hit(f"StopAfterProfit hit (today_pnl={today:.2f} >= {self.config.stopAfterProfit:.2f})")
                        continue

                # max open positions
                if self.config.maxOpenPositions and self.config.maxOpenPositions > 0:
                    if open_count >= int(self.config.maxOpenPositions):
                        self._hit(f"MaxOpenPositions hit (open={open_count} >= {self.config.maxOpenPositions})")
                        continue


risk_service = RiskService()
