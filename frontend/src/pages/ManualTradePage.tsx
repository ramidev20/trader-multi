import React, { useEffect, useMemo, useRef, useState } from "react";
import { RefreshCcw } from "lucide-react";
import {
  AppButton,
  Card,
  Dialog,
  Field,
} from "../components/ui/Primitives";
import { TableFrame } from "../components/ui/TableFrame";
import { ConsoleLogPanel } from "../components/ui/ConsoleLogPanel";
import ChartPage from "./ChartPage";
import ScalpingPage from "./ScalpingPage";
import { ORDER_KIND_OPTIONS, IconSelect } from "./shared/IconSelect";
import { cx, decimalInput, signedDecimalInput } from "../utils/format";
import { clearBanner, showBanner } from "../utils/banner";
import { parseSearchLogLine } from "../utils/logFeed";
import { api } from "../services/api";
import { listReceivers, sendRemoteCommand } from "../services/remoteControl";

const TRADE_FORM_STORAGE_KEY = "trader.trade.form";
// XAUUSD pip size, mirroring the backend which converts pips with `pips / 10`.
const PIPS_PER_PRICE_UNIT = 10;

const SECTION_TAG_TONES = {
  blue: "bg-blue-100 text-blue-700",
  amber: "bg-amber-100 text-amber-800",
  slate: "bg-slate-200 text-slate-600",
};

function SectionTag({ tone = "slate", children }) {
  return (
    <span
      className={cx(
        "rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-wide",
        SECTION_TAG_TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

function formatCountdown(seconds) {
  const safe = Math.max(0, Math.floor(Number(seconds) || 0));
  return `0:${String(safe).padStart(2, "0")}`;
}

function roundPrice(value) {
  return Math.round(Number(value) * 100) / 100;
}

// A pending order only rests on the far side of the market, so the pips amount
// is applied away from it: below the candle open for BUY, above it for SELL.
// (The backend rejects a BUY limit at or above the ask, and vice versa.)
function searchLimitPriceFrom(candleOpen, orderSide, pips) {
  const offset = pips / PIPS_PER_PRICE_UNIT;
  return roundPrice(
    orderSide === "BUY" ? candleOpen - offset : candleOpen + offset,
  );
}

function loadTradeForm() {
  try {
    const saved = JSON.parse(
      globalThis.localStorage?.getItem(TRADE_FORM_STORAGE_KEY) || "{}",
    );
    return saved && typeof saved === "object" ? saved : {};
  } catch {
    return {};
  }
}
export function ManualTradePage({ runtime, onRefreshRuntime }) {
  const savedTradeForm = useMemo(loadTradeForm, []);
  const [side, setSide] = useState(() => savedTradeForm.side ?? "BUY");
  const [orderKind, setOrderKind] = useState(
    () => savedTradeForm.orderKind ?? "MARKET",
  );
  const [limitPrice, setLimitPrice] = useState(
    () => savedTradeForm.limitPrice ?? "",
  );
  const [tp, setTp] = useState(() => savedTradeForm.tp ?? "150");
  const [sl, setSl] = useState(() => savedTradeForm.sl ?? "600");
  const [spreadPips, setSpreadPips] = useState(
    () => savedTradeForm.spreadPips ?? "0",
  );
  const [dailyRiskPercent, setDailyRiskPercent] = useState(
    () => savedTradeForm.dailyRiskPercent ?? "2",
  );
  const [searchPips, setSearchPips] = useState(
    () => savedTradeForm.searchPips ?? "10",
  );
  // {time, open} of the newest M1 candle. `time` identifies the candle so we
  // can tell when a genuinely new one has started.
  const [m1Candle, setM1Candle] = useState(null);
  // Armed = waiting for the next candle to open before sending the order.
  const [searchArmed, setSearchArmed] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  // Search mode: when on, Open prices a pending limit off the M1 candle instead
  // of sending the order as configured by Order Type.
  const [searchEnabled, setSearchEnabled] = useState(() =>
    Boolean(savedTradeForm.searchEnabled),
  );
  const [panelTab, setPanelTab] = useState(
    () => savedTradeForm.panelTab ?? "search",
  );
  const [multiTp, setMultiTp] = useState(() => Boolean(savedTradeForm.multiTp));
  const [slPrice, setSlPrice] = useState(() => savedTradeForm.slPrice ?? "");
  const [tp1Ratio, setTp1Ratio] = useState(
    () => savedTradeForm.tp1Ratio ?? "1.0",
  );
  const [tp2Ratio, setTp2Ratio] = useState(
    () => savedTradeForm.tp2Ratio ?? "1.0",
  );
  const [tp3Ratio, setTp3Ratio] = useState(
    () => savedTradeForm.tp3Ratio ?? "1.0",
  );
  const [tp2Enabled, setTp2Enabled] = useState(() =>
    Boolean(savedTradeForm.tp2Enabled),
  );
  const [tp3Enabled, setTp3Enabled] = useState(() =>
    Boolean(savedTradeForm.tp3Enabled),
  );
  const [tp1Percent, setTp1Percent] = useState(
    () => savedTradeForm.tp1Percent ?? "100",
  );
  const [tp2Percent, setTp2Percent] = useState(
    () => savedTradeForm.tp2Percent ?? "100",
  );
  const [autoCloseEnabled, setAutoCloseEnabled] = useState(() =>
    Boolean(savedTradeForm.autoCloseEnabled),
  );
  const [autoCloseAt, setAutoCloseAt] = useState(
    () => savedTradeForm.autoCloseAt ?? defaultAutoCloseValue(),
  );
  // Surface in the TopBar's banner slot (see utils/banner.js) instead of an
  // inline div here, which used to push the tabs/table below it down every
  // time one appeared. reportError takes the actual Error object (not an
  // already-stringified message) so its `.code` (an HTTP status or
  // "NETWORK", attached by services/api.js) survives into the banner.
  function reportError(error) {
    showBanner(error?.message || String(error), "error", error?.code);
  }
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // React state updates aren't synchronous: a very fast double-click can fire
  // both handlers before a re-render disables the button or before `submitting`
  // reflects true in the second call's closure, sending the order twice (locally
  // and to every remote receiver). A ref is read/written immediately, so it
  // closes that gap regardless of render timing.
  const submittingRef = useRef(false);
  const dailyRiskNoticeRef = useRef("");
  useEffect(() => {
    let active = true;
    api.settings()
      .then((settings) => {
        if (active) setDailyRiskPercent(String(settings?.daily_risk_percent ?? 2));
      })
      .catch((error) => showBanner(error?.message || String(error), "error", error?.code));
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const risk = runtime?.daily_risk;
    const hitLogins = Array.isArray(risk?.hit_accounts) ? risk.hit_accounts : [];
    const noticeKey = `${risk?.day || ""}:${hitLogins.join(",")}`;
    if (risk?.hit && noticeKey !== dailyRiskNoticeRef.current) {
      dailyRiskNoticeRef.current = noticeKey;
      if (risk.master_hit) setSearchArmed(false);
      const hitNames = (risk.accounts || [])
        .filter((account) => account.hit)
        .map((account) => `${account.name} (${account.login})`);
      showBanner(
        risk.master_hit
          ? `Daily risk limit hit on the master account (${Number(risk.loss_percent || 0).toFixed(2)}%). Searches stopped and all open positions are being closed.`
          : `Daily risk limit hit for ${hitNames.join(", ") || "a subaccount"}. Those accounts are no longer receiving trades and their positions are being closed.`,
        "warning",
      );
      if (risk.master_hit && listReceivers().some((receiver) => receiver.enabled)) {
        sendRemoteCommand("daily_risk_stop", {})
          .then(({ results }) => {
            const failed = results.filter((result) => result.status === "error");
            if (failed.length) {
              showBanner(
                `Daily risk was reached locally, but ${failed.length} remote receiver(s) could not be stopped and closed: ${failed.map((item) => `${item.label} (${item.message})`).join("; ")}`,
                "error",
              );
            }
          })
          .catch((error) => showBanner(error?.message || String(error), "error", error?.code));
      }
    } else if (!risk?.hit) {
      dailyRiskNoticeRef.current = "";
    }
  }, [runtime?.daily_risk]);

  async function saveDailyRiskPercent() {
    const value = Number(dailyRiskPercent);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      showBanner("Daily Risk must be between 0 and 100 percent.", "error");
      return;
    }
    try {
      await api.saveDailyRisk(value);
      setDailyRiskPercent(String(value));
    } catch (error) {
      reportError(error);
    }
  }
  // Minute index the search was armed in. The trigger is the wall clock, the
  // same source the countdown uses, so the two can never disagree -- and it does
  // not depend on how the backend stamps candle times.
  const armedMinuteRef = useRef(null);
  // Candle time at arm, used only by LIMIT so the price comes off the real new
  // bar rather than the one that was current when the search was armed.
  const armedCandleRef = useRef(null);
  const placeSearchOrderRef = useRef(null);
  const [refreshing, setRefreshing] = useState(false);
  const [positions, setPositions] = useState([]);
  const [positionsErrors, setPositionsErrors] = useState([]);
  const [limitOrders, setLimitOrders] = useState([]);
  const [limitOrdersErrors, setLimitOrdersErrors] = useState([]);
  const [positionsTab, setPositionsTab] = useState(() => {
    const saved = savedTradeForm.tradeTab ?? savedTradeForm.positionsTab ?? "chart";
    // "orders" was its own tab before positions and pending orders merged
    // into one MT5-style table under "live" -- map old saved state instead
    // of landing on a tab that no longer exists.
    return saved === "orders" ? "live" : saved;
  });
  // Only surfaced while actually looking at the Positions tab -- these are
  // about that table specifically, not the whole page.
  useEffect(() => {
    if (positionsTab === "live" && (positionsErrors.length || limitOrdersErrors.length)) {
      showBanner([...positionsErrors, ...limitOrdersErrors].join(" • "), "warning");
    }
  }, [positionsTab, positionsErrors, limitOrdersErrors]);
  // Only real events here, not a restated snapshot of current state: the
  // panel below auto-scrolls to the newest line, and a "current positions"
  // block re-timestamped on every 5s runtime poll would look like new
  // activity was constantly arriving even while nothing changed. Open
  // positions and pending orders already have their own tabs for that.
  const tradeFeedLogs = useMemo(() => {
    // The scalping engine tags every line (armed, M15/M5/M1 trigger hits,
    // demand/supply zone finds, order placement, stop/error) with
    // "[scalping:demand]"/"[scalping:supply]" -- matching the "[scalping"
    // prefix alone pulls its whole lifecycle into this feed instead of only
    // the lines that happen to contain a trade keyword.
    const tradeLogPattern =
      /manual|order|position|limit|close|auto close|tp\d?|take profit|stop loss|trade|\[scalping/i;
    return (runtime?.logs?.search || [])
      .filter((line) => tradeLogPattern.test(String(line)))
      .map(parseSearchLogLine)
      .slice(-200);
  }, [runtime]);
  async function clearTradeLogs() {
    try {
      await api.clearLogs("search");
      await onRefreshRuntime?.({ silent: true, replaceSearchLogs: true });
    } catch (error) {
      reportError(error);
      throw error;
    }
  }
  const searchPipsValue = useMemo(() => {
    const parsed = Number.parseFloat(searchPips);
    return Number.isFinite(parsed) ? parsed : 0;
  }, [searchPips]);
  // Entry the "Open With Search" button would use right now, so the offset is
  // visible before it is sent rather than only afterwards in the order list.
  // Minute boundaries line up in every timezone, so the wall clock is a safer
  // countdown source than the broker timestamp on the candle.
  const secondsToNextCandle = useMemo(
    () => 60 - (Math.floor(nowMs / 1000) % 60),
    [nowMs],
  );
  const searchOffsetLabel = `${side === "BUY" ? "-" : "+"}${Math.abs(searchPipsValue)} pips`;
  const totalRatio = useMemo(() => {
    let total = Number(tp1Ratio || 0);
    if (tp2Enabled) total += Number(tp2Ratio || 0);
    if (tp3Enabled) total += Number(tp3Ratio || 0);
    return total;
  }, [tp1Ratio, tp2Enabled, tp2Ratio, tp3Enabled, tp3Ratio]);
  const scheduledAutoCloseAt = runtime?.manual_trade?.auto_close_at || null;
  const displayedLimitOrders = limitOrders.length
    ? limitOrders
    : (runtime?.orders || []).filter(
        (order) =>
          String(order?.status || "").toLowerCase() === "open" &&
          String(order?.order_kind || "").toUpperCase() === "LIMIT",
      );
  // One MT5-style table: open positions and pending limit orders together,
  // newest first within each group, positions on top since they're the ones
  // actually working right now. Ticket dedup guards the dev/sim fallback
  // above, whose "positions" list is sourced from every open order
  // regardless of kind and can otherwise double-list a pending order.
  const mergedTradeRows = useMemo(() => {
    const positionTickets = new Set(positions.map((row) => String(row.ticket)));
    const pendingRows = displayedLimitOrders
      .filter((row) => !positionTickets.has(String(row.ticket)))
      .map((row) => ({ ...row, _kind: "pending" }));
    const positionRows = positions.map((row) => ({ ...row, _kind: "position" }));
    return [...positionRows, ...pendingRows].sort((a, b) => {
      if (a._kind !== b._kind) return a._kind === "position" ? -1 : 1;
      return String(b.opened_at || "").localeCompare(String(a.opened_at || ""));
    });
  }, [positions, displayedLimitOrders]);

  useEffect(() => {
    try {
      globalThis.localStorage?.setItem(
        TRADE_FORM_STORAGE_KEY,
        JSON.stringify({
          side,
          orderKind,
          limitPrice,
          tp,
          sl,
          spreadPips,
          dailyRiskPercent,
          searchPips,
          searchEnabled,
          searchArmed,
          multiTp,
          slPrice,
          tp1Ratio,
          tp2Ratio,
          tp3Ratio,
          tp2Enabled,
          tp3Enabled,
          tp1Percent,
          tp2Percent,
          autoCloseEnabled,
          autoCloseAt,
          positionsTab,
          panelTab,
          tradeTab: positionsTab,
        }),
      );
    } catch {
      // Keep the trade form usable when browser storage is unavailable.
    }
  }, [
    side,
    orderKind,
    limitPrice,
    tp,
    sl,
    spreadPips,
    dailyRiskPercent,
    searchPips,
    searchEnabled,
    searchArmed,
    multiTp,
    slPrice,
    tp1Ratio,
    tp2Ratio,
    tp3Ratio,
    tp2Enabled,
    tp3Enabled,
    tp1Percent,
    tp2Percent,
    autoCloseEnabled,
    autoCloseAt,
    positionsTab,
    panelTab,
  ]);

  useEffect(() => {
    const persistTradeForm = () => {
      try {
        globalThis.localStorage?.setItem(
          TRADE_FORM_STORAGE_KEY,
          JSON.stringify({
            side,
            orderKind,
            limitPrice,
            tp,
            sl,
            spreadPips,
            dailyRiskPercent,
            searchPips,
            searchEnabled,
            searchArmed,
            multiTp,
            slPrice,
            tp1Ratio,
            tp2Ratio,
            tp3Ratio,
            tp2Enabled,
            tp3Enabled,
            tp1Percent,
            tp2Percent,
            autoCloseEnabled,
            autoCloseAt,
            positionsTab,
            panelTab,
            tradeTab: positionsTab,
          }),
        );
      } catch {
        // Ignore storage failures during shutdown or private browsing.
      }
    };

    window.addEventListener("beforeunload", persistTradeForm);
    window.addEventListener("pagehide", persistTradeForm);
    return () => {
      persistTradeForm();
      window.removeEventListener("beforeunload", persistTradeForm);
      window.removeEventListener("pagehide", persistTradeForm);
    };
  }, [
    side,
    orderKind,
    limitPrice,
    tp,
    sl,
    spreadPips,
    dailyRiskPercent,
    searchPips,
    searchEnabled,
    searchArmed,
    multiTp,
    slPrice,
    tp1Ratio,
    tp2Ratio,
    tp3Ratio,
    tp2Enabled,
    tp3Enabled,
    tp1Percent,
    tp2Percent,
    autoCloseEnabled,
    autoCloseAt,
    positionsTab,
    panelTab,
  ]);

  useEffect(() => {
    if (!multiTp && tp3Enabled) setTp3Enabled(false);
    if (!tp2Enabled && tp3Enabled) setTp3Enabled(false);
    if (multiTp && tp2Enabled && !tp3Enabled && tp1Percent === "100")
      setTp1Percent("50");
    if (multiTp && tp3Enabled && tp2Percent === "100") setTp2Percent("50");
  }, [multiTp, tp2Enabled, tp3Enabled]);

  useEffect(() => {
    if (!scheduledAutoCloseAt) return;
    const dt = new Date(scheduledAutoCloseAt);
    if (Number.isNaN(dt.getTime())) return;
    setAutoCloseEnabled(true);
    setAutoCloseAt(toDateTimeLocalValue(dt));
  }, [scheduledAutoCloseAt]);

  function SwitchKnob({ checked }) {
    return (
      <span
        className={cx(
          "relative inline-flex h-6 w-11 items-center rounded-full transition",
          checked ? "bg-blue-600" : "bg-slate-300",
        )}
      >
        <span
          className={cx(
            "h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200",
            checked ? "translate-x-6" : "translate-x-1",
          )}
        />
      </span>
    );
  }

  function MiniToggle({ checked, onChange, disabled = false }) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={(e) => {
          e.preventDefault();
          onChange(!checked);
        }}
        className="shrink-0 disabled:pointer-events-none disabled:opacity-40"
        aria-pressed={checked}
      >
        <span
          className={cx(
            "relative inline-flex h-4 w-8 items-center rounded-full transition",
            checked ? "bg-blue-600" : "bg-slate-300",
          )}
        >
          <span
            className={cx(
              "h-3 w-3 rounded-full bg-white shadow-sm transition-transform duration-200",
              checked ? "translate-x-4" : "translate-x-0.5",
            )}
          />
        </span>
      </button>
    );
  }

  function InlineSwitcher({
    checked,
    onChange,
    label,
    disabled = false,
    compact = false,
  }) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          compact
            ? "inline-flex items-center gap-2 text-sm font-semibold text-slate-700 disabled:pointer-events-none disabled:opacity-60"
            : "flex min-w-0 h-[50px] w-full items-center justify-between rounded-[8px] border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-slate-700 transition hover:bg-white disabled:pointer-events-none disabled:opacity-60 sm:px-4",
        )}
      >
        <span className="min-w-0 text-left leading-tight">{label}</span>
        <SwitchKnob checked={checked} />
      </button>
    );
  }

  // Side buttons only pick the direction now; the Open buttons below submit.
  function SideButton({ value, label, activeClassName }) {
    const isActive = side === value;
    return (
      <button
        type="button"
        role="radio"
        aria-checked={isActive}
        disabled={submitting}
        onClick={() => setSide(value)}
        className={cx(
          "h-[42px] rounded-lg text-sm font-bold transition disabled:pointer-events-none disabled:opacity-60",
          isActive ? activeClassName : "text-slate-600 hover:bg-white/70",
        )}
      >
        {label}
      </button>
    );
  }

  function SideSelector() {
    return (
      <div
        role="radiogroup"
        aria-label="Order direction"
        className="grid grid-cols-2 gap-1 rounded-xl border border-slate-200 bg-slate-100 p-1"
      >
        <SideButton
          value="BUY"
          label="BUY"
          activeClassName="bg-emerald-600 text-white shadow-sm"
        />
        <SideButton
          value="SELL"
          label="SELL"
          activeClassName="bg-rose-600 text-white shadow-sm"
        />
      </div>
    );
  }

  function SectionHeader({ title, tags, checked, onChange }) {
    return (
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <h4 className="font-black text-slate-950">{title}</h4>
          <div className="flex flex-wrap items-center gap-1.5">
            {tags.map(([tone, label]) => (
              <SectionTag key={label} tone={tone}>
                {label}
              </SectionTag>
            ))}
          </div>
        </div>
        <InlineSwitcher compact checked={checked} onChange={onChange} />
      </div>
    );
  }

  // Option groups live behind tabs so the panel's core controls and the open
  // button stay put instead of scrolling out of reach.
  function PanelTab({ id, label, enabled }) {
    const selected = panelTab === id;
    return (
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        onClick={() => setPanelTab(id)}
        className={cx(
          "relative h-[34px] rounded-lg px-2 text-xs font-bold transition",
          selected
            ? "bg-white text-slate-950 shadow-sm"
            : "text-slate-600 hover:bg-white/70",
        )}
      >
        {label}
        {enabled ? (
          <span
            className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-emerald-500"
            aria-hidden="true"
          />
        ) : null}
      </button>
    );
  }

  function OpenButton({ label, busy, onClick }) {
    return (
      <button
        type="button"
        disabled={submitting}
        onClick={onClick}
        className="flex min-h-[52px] w-full items-center justify-center rounded-lg border border-slate-950 bg-slate-950 px-4 text-[15px] font-bold text-white shadow-lg shadow-slate-950/20 transition hover:bg-slate-800 disabled:pointer-events-none disabled:opacity-60"
      >
        {busy ? `${label}...` : label}
      </button>
    );
  }

  async function loadPositions(options = {}) {
    const { silent = false } = options;
    try {
      const data = await api.livePositions();
      setPositions(Array.isArray(data?.positions) ? data.positions : []);
      setPositionsErrors(Array.isArray(data?.errors) ? data.errors : []);
    } catch (error) {
      reportError(error);
    }
  }

  async function loadLimitOrders(options = {}) {
    const { silent = false } = options;
    try {
      const data = await api.liveOrders();
      setLimitOrders(Array.isArray(data?.orders) ? data.orders : []);
      setLimitOrdersErrors(Array.isArray(data?.errors) ? data.errors : []);
    } catch (error) {
      if (!silent) {
        reportError(error);
      }
    }
  }

  async function fetchM1Candle() {
    const data = await api.chartData({
      symbol: "XAUUSD",
      timeframe: "M1",
      count: 20,
    });
    const candles = Array.isArray(data?.candles) ? data.candles : [];
    const latest = candles[candles.length - 1];
    const open = Number(latest?.open);
    const time = Number(latest?.time);
    if (!Number.isFinite(open) || open <= 0 || !Number.isFinite(time)) {
      throw new Error(
        "Could not read the current 1 minute candle for XAUUSD.",
      );
    }
    return { time, open };
  }

  async function refreshM1Candle() {
    try {
      const candle = await fetchM1Candle();
      setM1Candle(candle);
      return candle;
    } catch {
      // Keep the panel usable; the armed poll simply retries on its next tick.
      return null;
    }
  }

  useEffect(() => {
    loadPositions();
    loadLimitOrders();
  }, []);

  useEffect(() => {
    if (!searchEnabled) {
      setSearchArmed(false);
      return undefined;
    }
    refreshM1Candle();
    const timer = window.setInterval(refreshM1Candle, 5000);
    return () => window.clearInterval(timer);
  }, [searchEnabled]);

  // This page used to unmount on navigation (losing a running countdown);
  // it's now kept mounted persistently by App.tsx, but re-arming from the
  // candle that is current now is still the right behavior if it's ever
  // reloaded fresh -- the search stays live instead of resetting, without
  // firing on a trigger that already passed while away.
  useEffect(() => {
    if (savedTradeForm.searchEnabled && savedTradeForm.searchArmed) armSearch();
  }, []);

  // Sleep until the boundary rather than polling for it: a 1s poll fired the
  // order up to a second late, and a MARKET search needs no data to go.
  useEffect(() => {
    if (!searchArmed) return undefined;
    let cancelled = false;
    let timer = null;
    let barWaitDeadline = 0;

    function send(candleOpen) {
      setSearchArmed(false);
      armedMinuteRef.current = null;
      armedCandleRef.current = null;
      // Read through the ref: the order must use the TP/SL/side in the form at
      // fire time, not whatever was set when the search was armed.
      placeSearchOrderRef.current?.(candleOpen);
    }

    async function fire() {
      if (cancelled || submittingRef.current) return;
      // Timers can wake a hair early; make sure the minute really has rolled.
      if (
        armedMinuteRef.current != null &&
        Math.floor(Date.now() / 60000) <= armedMinuteRef.current
      ) {
        timer = window.setTimeout(fire, 15);
        return;
      }
      if (armedCandleRef.current == null) {
        send(null);
        return;
      }
      // LIMIT: the new bar's open is the price, so wait for the broker to
      // publish it -- but retry fast instead of on a one-second beat.
      if (!barWaitDeadline) barWaitDeadline = Date.now() + 5000;
      const candle = await refreshM1Candle();
      if (cancelled) return;
      if (candle && candle.time > armedCandleRef.current) {
        send(candle.open);
        return;
      }
      if (Date.now() >= barWaitDeadline) {
        setSearchArmed(false);
        armedMinuteRef.current = null;
        armedCandleRef.current = null;
        showBanner(
          "The new 1 minute candle did not arrive in time, so no limit order was sent.",
          "error",
        );
        return;
      }
      timer = window.setTimeout(fire, 100);
    }

    timer = window.setTimeout(fire, 60000 - (Date.now() % 60000));
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [searchArmed]);

  // Drives the countdown shown on the Open button while a search is armed.
  useEffect(() => {
    if (!searchArmed) return undefined;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [searchArmed]);

  async function refreshTradeData() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await onRefreshRuntime?.({ silent: true });
      await loadPositions({ silent: true });
      await loadLimitOrders({ silent: true });
      if (searchEnabled) await refreshM1Candle();
    } finally {
      setRefreshing(false);
    }
  }

  function fmtDateTime(value) {
    if (!value) return "-";
    const dt = new Date(value);
    if (Number.isNaN(dt.getTime())) return String(value);
    return dt.toLocaleString();
  }

  // `prepare` runs inside the double-submit guard so an async entry lookup (the
  // search button reading the M1 candle) cannot be raced by a second click.
  async function openPosition(orderSide, options = {}) {
    const { prepare = null } = options;
    if (submittingRef.current) return;
    if (runtime?.daily_risk?.master_hit) {
      showBanner("Daily risk limit reached. New trades are blocked until the next day.", "warning");
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    let placed = false;
    try {
      let kind = orderKind;
      let entryPrice = limitPrice;
      if (prepare) {
        const prepared = await prepare();
        kind = prepared?.orderKind ?? kind;
        entryPrice = prepared?.limitPrice ?? entryPrice;
      }
      if (autoCloseEnabled && !autoCloseAt) {
        throw new Error("Choose an end time for auto close.");
      }
      if (multiTp && Number(slPrice || 0) <= 0) {
        throw new Error(
          "Enter a Stop Loss Price for Advanced Risk / Multi-TP orders.",
        );
      }
      if (kind === "LIMIT" && !(Number(entryPrice || 0) > 0)) {
        throw new Error(
          "Enter a limit entry price before opening a pending order.",
        );
      }
      const orderPayload = {
        side: orderSide,
        order_kind: kind,
        limit_price: kind === "LIMIT" ? Number(entryPrice || 0) : null,
        tp: Number(tp || 0),
        sl: Number(sl || 0),
        spread_pips: Number(spreadPips || 0),
        tp_in_pips: true,
        sl_in_pips: true,
        advanced: multiTp,
        sl_price: multiTp ? Number(slPrice || 0) : null,
        ratio: totalRatio,
        tp1_ratio: Number(tp1Ratio || 0),
        tp2_ratio: Number(tp2Ratio || 0),
        tp3_ratio: Number(tp3Ratio || 0),
        tp2_enabled: tp2Enabled,
        tp3_enabled: tp3Enabled,
        tp1_percent: Number(tp1Percent || 0),
        tp2_percent: Number(tp2Percent || 0),
        auto_close_at: autoCloseEnabled
          ? new Date(autoCloseAt).toISOString()
          : null,
        symbol: "XAUUSD",
      };
      await api.openPosition(orderPayload);
      // Local order is live from here on; a receiver failure below must still
      // refresh the tables, it just also reports the mirroring error.
      placed = true;
      // Attempt this whenever a receiver is configured, not only when
      // isRemoteConnected() already reads true: that flag can be stale for a
      // few hundred ms right after a reconnect, and gating on it meant a
      // receiver that looked briefly offline got silently skipped -- with no
      // error shown -- instead of failing loudly like every other receiver
      // problem. sendRemoteCommand re-checks each receiver's live state and
      // reports "not connected" as a normal per-receiver failure below.
      if (listReceivers().some((receiver) => receiver.enabled)) {
        const { risk_percent, riskPercent, ...receiverPayload } = orderPayload;
        const { results } = await sendRemoteCommand("open", receiverPayload);
        const failed = results.filter((result) => result.status === "error");
        if (failed.length) {
          throw new Error(
            `Order opened locally, but ${failed.length} receiver(s) did not mirror it: ${failed.map((f) => `${f.label} (${f.message})`).join("; ")}`,
          );
        }
      }
      clearBanner();
    } catch (error) {
      reportError(error);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
      if (placed) {
        // The order already exists at this point, so refresh in the background
        // and in parallel instead of holding the panel disabled through three
        // more round trips -- each of which queues behind the adapter anyway.
        void Promise.allSettled([
          onRefreshRuntime?.(),
          loadPositions({ silent: true }),
          loadLimitOrders({ silent: true }),
        ]);
      }
    }
  }

  // Fired when a new candle starts. Order Type decides what gets sent: MARKET
  // executes on the spot, LIMIT rests at that candle's open plus the offset.
  function openPositionWithSearch(candleOpen) {
    if (orderKind !== "LIMIT") {
      // The candle open is only the trigger here; the fill comes off the tick.
      return openPosition(side);
    }
    return openPosition(side, {
      prepare: async () => {
        const price = searchLimitPriceFrom(candleOpen, side, searchPipsValue);
        if (!(price > 0)) {
          throw new Error(
            `Search offset of ${searchPipsValue} pips gives an invalid limit price (${price}).`,
          );
        }
        setLimitPrice(String(price));
        return { orderKind: "LIMIT", limitPrice: price };
      },
    });
  }

  // Pressing Open under search does not send anything yet: it waits for the
  // next M1 candle to start and prices the order off that candle's open.
  placeSearchOrderRef.current = openPositionWithSearch;

  async function armSearch() {
    if (searchArmed) {
      setSearchArmed(false);
      return;
    }
    if (runtime?.daily_risk?.master_hit) {
      showBanner("Daily risk limit reached. New searches are blocked until the next day.", "warning");
      return;
    }
    clearBanner();
    if (orderKind === "LIMIT") {
      // Must be a fresh read: a cached candle from before the last fire is
      // already older than the live one and would trigger immediately.
      const candle = await refreshM1Candle();
      if (!candle) {
        showBanner(
          "Could not read the current 1 minute candle for XAUUSD, so the search cannot start.",
          "error",
        );
        return;
      }
      armedCandleRef.current = candle.time;
    } else {
      // A market order needs no candle data at all, only the boundary.
      armedCandleRef.current = null;
    }
    armedMinuteRef.current = Math.floor(Date.now() / 60000);
    setSearchArmed(true);
  }

  async function closePositions() {
    // The controller and each receiver are separate PCs with separate
    // accounts: it's entirely normal for the controller's own accounts to
    // have nothing open (e.g. a position only ever lived on a receiver via
    // mirroring). Track whether a remote mirror was attempted and succeeded
    // so that case doesn't get reported as a local error below.
    const receiversMirrored = listReceivers().some((receiver) => receiver.enabled);
    try {
      setCloseConfirmOpen(false);
      const response = await api.closePositions();
      // See openPosition's comment: attempt this whenever a receiver is
      // configured, not only when isRemoteConnected() already reads true, or
      // a receiver that is actually reachable but briefly looked offline gets
      // silently skipped instead of failing loudly.
      if (receiversMirrored) {
        const { results } = await sendRemoteCommand("close_all", {});
        const failed = results.filter((result) => result.status === "error");
        if (failed.length) {
          throw new Error(
            `Positions closed locally, but ${failed.length} receiver(s) did not receive the close request: ${failed.map((f) => `${f.label} (${f.message})`).join("; ")}`,
          );
        }
      }
      await onRefreshRuntime?.();
      await loadPositions({ silent: true });
      await loadLimitOrders({ silent: true });
      const summary = response?.summary || {};
      const closedCount = Number(summary.closed || 0);
      if (closedCount > 0) {
        const profit = Number(summary.profit || 0);
        const profitPercent = Number(summary.profit_percent || 0);
        const sign = profit >= 0 ? "+" : "";
        showBanner(
          `Closed ${closedCount} position${closedCount === 1 ? "" : "s"}: ${sign}${profit.toFixed(2)} USD (${sign}${profitPercent.toFixed(2)}%).`,
          "success",
        );
      } else if (Number(summary.attempted || 0) > 0) {
        showBanner(
          "Close-all completed, but no positions were confirmed closed locally. Check backend logs.",
          "error",
        );
      } else if (!receiversMirrored) {
        showBanner("No open positions were found to close.", "error");
      } else {
        // Nothing to close on this PC's own accounts, but the close request
        // was sent to and accepted by every enabled receiver above -- not an
        // error condition, just nothing local to report.
        clearBanner();
      }
    } catch (error) {
      reportError(error);
    }
  }

  return (
    // flex-1 (not just h-full) is required here: the parent only sets
    // min-height, and percentage heights don't reliably cascade through a
    // min-height chain -- this used to be masked because the old two-column
    // layout's right-hand panel had enough intrinsic content height to
    // stretch the grid row it lived in. Once that panel became its own tab,
    // nothing was left to force the height, and every tab's content
    // (chart included) collapsed to its shrink-wrapped size.
    <div className="flex h-full min-h-0 flex-1 flex-col gap-4">
      <div className="flex min-h-0 flex-1 flex-col gap-4">
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1">
              {[
                ["chart", "Chart"],
                ["live", "Positions"],
                ["scalping", "Scalping"],
                ["panel", "Manual Trade"],
                ["log", "Log"],
              ].map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setPositionsTab(key)}
                  className={cx(
                    "relative px-2 py-2 text-sm font-bold transition",
                    positionsTab === key
                      ? "text-blue-600"
                      : "text-slate-500 hover:text-slate-950",
                  )}
                >
                  {label}
                  {positionsTab === key ? (
                    <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-blue-600" />
                  ) : null}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <label className="flex w-28 flex-col gap-0.5" title="0 disables the daily loss limit">
                <span className="text-[9px] font-black uppercase leading-3 tracking-wide text-slate-500">Daily Risk (%)</span>
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  inputMode="decimal"
                  value={dailyRiskPercent}
                  onChange={(event) => setDailyRiskPercent(decimalInput(event.target.value))}
                  onBlur={saveDailyRiskPercent}
                  className="h-7 w-full rounded-md border border-slate-200 bg-slate-50 px-2 text-xs font-semibold text-slate-900 outline-none focus:border-blue-500 focus:bg-white focus:ring-2 focus:ring-blue-100"
                />
              </label>
              <button
                type="button"
                onClick={() => setCloseConfirmOpen(true)}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-transparent bg-transparent px-3 py-2 text-sm font-bold text-violet-700 transition hover:bg-violet-50 hover:text-violet-800"
              >
                Close All Positions
              </button>
              <AppButton
                variant="soft"
                onClick={refreshTradeData}
                disabled={refreshing}
              >
                <RefreshCcw
                  className={cx("h-4 w-4", refreshing && "animate-spin")}
                />
                {refreshing ? "Refreshing..." : "Refresh"}
              </AppButton>
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            {/* Always mounted, hidden with `hidden` instead of removed by the
                ternary below -- ChartPage owns real state worth keeping
                (selected timeframe, and the chart library's own zoom/pan)
                that a mount/unmount cycle on every tab switch would wipe. */}
            <div
              className={cx(
                "flex min-h-0 flex-1 flex-col",
                positionsTab === "chart" ? "" : "hidden",
              )}
            >
              <ChartPage />
            </div>
            {positionsTab === "chart" ? null : positionsTab === "panel" ? (
              // Two panels side by side instead of one narrow centered form --
              // core order entry on the left (paired with the Open button,
              // since that's the primary action for these fields), modifiers
              // (Search / Auto Close / Multi-TP) on the right. Uses the full
              // tab width like the other tabs' tables do, without individual
              // fields ballooning the way a single full-bleed column did.
              <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-2">
                <Card className="flex min-h-0 flex-col pt-3">
                  <div className="space-y-3">
                    <SideSelector />
                    <div className="grid gap-3 md:grid-cols-2">
                      <IconSelect
                        label="Order Type"
                        value={orderKind}
                        options={ORDER_KIND_OPTIONS}
                        onChange={setOrderKind}
                      />
                      <Field
                        label={
                          orderKind === "LIMIT" ? "Limit Entry Price" : "Entry Mode"
                        }
                        value={
                          orderKind === "LIMIT" ? limitPrice : "Market execution"
                        }
                        type={orderKind === "LIMIT" ? "number" : "text"}
                        min="0"
                        step="0.01"
                        inputMode="decimal"
                        onChange={
                          orderKind === "LIMIT"
                            ? (e) => setLimitPrice(decimalInput(e.target.value))
                            : undefined
                        }
                        disabled={orderKind !== "LIMIT"}
                      />
                    </div>
                    <div className="grid gap-3 md:grid-cols-3">
                      <Field
                        label="TP (Pips)"
                        value={tp}
                        onChange={(e) => setTp(e.target.value)}
                        disabled={multiTp}
                      />
                      <Field
                        label="SL (Pips)"
                        value={sl}
                        onChange={(e) => setSl(e.target.value)}
                        disabled={multiTp}
                      />
                      <Field
                        label="Spread"
                        value={spreadPips}
                        onChange={(e) => setSpreadPips(decimalInput(e.target.value))}
                      />
                    </div>
                  </div>
                  <div className="mt-4 flex-1 border-t border-slate-200 pt-4">
                    <p className="mb-2 text-center text-[13px] font-semibold text-blue-600">
                      {searchEnabled
                        ? orderKind === "LIMIT"
                          ? `Search: ${side} limit at next M1 open ${searchOffsetLabel}`
                          : `Search: ${side} market at next M1 open`
                        : orderKind === "LIMIT"
                          ? `${side} limit @ ${limitPrice || "-"}`
                          : `${side} market execution`}
                    </p>
                    <OpenButton
                      label={
                        searchArmed
                          ? `WAITING · ${formatCountdown(secondsToNextCandle)}`
                          : "OPEN"
                      }
                      busy={submitting}
                      onClick={() =>
                        searchEnabled ? armSearch() : openPosition(side)
                      }
                    />
                    {searchArmed ? (
                      <p className="mt-2 text-center text-xs font-semibold text-slate-600">
                        Sends on the next 1 minute candle open. Press again to cancel.
                      </p>
                    ) : null}
                  </div>
                </Card>
                <Card className="flex min-h-0 flex-col pt-3">
                <div
                  role="tablist"
                  aria-label="Trade options"
                  className="grid shrink-0 grid-cols-3 gap-1 rounded-xl border border-slate-200 bg-slate-100 p-1"
                >
                  <PanelTab id="search" label="Search" enabled={searchEnabled} />
                  <PanelTab
                    id="autoclose"
                    label="Auto Close"
                    enabled={autoCloseEnabled}
                  />
                  <PanelTab id="advanced" label="Multi-TP" enabled={multiTp} />
                </div>
                <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
                  {panelTab === "search" ? (
                    <div className="space-y-3">
                      <SectionHeader
                        title="Open With Search"
                        tags={[
                          ["blue", "Fires at candle open"],
                          ["slate", "Follows Order Type"],
                        ]}
                        checked={searchEnabled}
                        onChange={setSearchEnabled}
                      />
                      <p className="text-xs font-semibold text-slate-600">
                        Waits for the next 1 minute candle to open, then sends the
                        order: at market with Order Type MARKET, or as a pending
                        limit priced off that candle's open with LIMIT.
                      </p>
                      {searchEnabled && orderKind === "LIMIT" ? (
                        <Field
                          label="Limit Offset (Pips)"
                          value={searchPips}
                          inputMode="decimal"
                          onChange={(e) =>
                            setSearchPips(signedDecimalInput(e.target.value))
                          }
                        />
                      ) : null}
                    </div>
                  ) : null}
                  {panelTab === "autoclose" ? (
                    <div className="space-y-3">
                      <SectionHeader
                        title="Auto Close All Positions"
                        tags={[["amber", "Closes every position opened"]]}
                        checked={autoCloseEnabled}
                        onChange={setAutoCloseEnabled}
                      />
                      <p className="text-xs font-semibold text-slate-600">
                        Closes every open position on the master and linked accounts
                        at the end time you set.
                      </p>
                      {autoCloseEnabled ? (
                        <>
                          <Field
                            label="End Time"
                            value={autoCloseAt}
                            type="datetime-local"
                            onChange={(e) => setAutoCloseAt(e.target.value)}
                          />
                          {scheduledAutoCloseAt ? (
                            <p className="text-xs font-semibold text-slate-600">
                              Scheduled auto close:{" "}
                              {fmtDateTime(scheduledAutoCloseAt)}
                            </p>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                  ) : null}
                  {panelTab === "advanced" ? (
                    <div className="space-y-3">
                      <SectionHeader
                        title="Advanced Risk / Multi-TP"
                        tags={[["blue", "Up to 3 take profits targets"]]}
                        checked={multiTp}
                        onChange={setMultiTp}
                      />
                      <p className="text-xs font-semibold text-slate-600">
                        Takes the stop from a price instead of pips and exits in up
                        to three stages, each at its own risk ratio and share of the
                        remaining volume.
                      </p>
                      {multiTp ? (
                        <>
                          <div className="grid gap-3 md:grid-cols-2">
                            <Field
                              label="Stop Loss Price"
                              value={slPrice}
                              type="number"
                              min="0"
                              step="0.01"
                              inputMode="decimal"
                              onChange={(e) =>
                                setSlPrice(decimalInput(e.target.value))
                              }
                            />
                            <div>
                              <span className="block text-xs font-black uppercase tracking-wide text-slate-500">
                                Total Ratio
                              </span>
                              <div className="mt-1.5 flex h-[46px] items-center rounded-xl border border-slate-200 bg-slate-100 px-4 text-sm font-black text-slate-700">
                                {totalRatio.toFixed(1)}
                              </div>
                            </div>
                          </div>
                          <div className="grid grid-cols-2 gap-3">
                            <Field
                              label="TP1 Ratio"
                              value={tp1Ratio}
                              type="number"
                              min="0.1"
                              step="0.1"
                              onChange={(e) =>
                                setTp1Ratio(decimalInput(e.target.value))
                              }
                            />
                            <Field
                              label="TP1 %"
                              value={tp1Percent}
                              type="number"
                              min="1"
                              max="100"
                              onChange={(e) => setTp1Percent(e.target.value)}
                              disabled={!tp2Enabled}
                            />
                          </div>
                          <div className="grid grid-cols-2 gap-3">
                            <Field
                              label="TP2 Ratio"
                              labelExtra={
                                <MiniToggle
                                  checked={tp2Enabled}
                                  onChange={setTp2Enabled}
                                />
                              }
                              value={tp2Ratio}
                              type="number"
                              min="0.1"
                              step="0.1"
                              onChange={(e) =>
                                setTp2Ratio(decimalInput(e.target.value))
                              }
                              disabled={!tp2Enabled}
                            />
                            <Field
                              label="TP2 %"
                              value={tp2Percent}
                              type="number"
                              min="1"
                              max="100"
                              onChange={(e) => setTp2Percent(e.target.value)}
                              disabled={!tp2Enabled || !tp3Enabled}
                            />
                          </div>
                          <Field
                            label="TP3 Ratio"
                            labelExtra={
                              <MiniToggle
                                checked={tp3Enabled}
                                onChange={setTp3Enabled}
                                disabled={!tp2Enabled}
                              />
                            }
                            value={tp3Ratio}
                            type="number"
                            min="0.1"
                            step="0.1"
                            onChange={(e) =>
                              setTp3Ratio(decimalInput(e.target.value))
                            }
                            disabled={!tp3Enabled}
                          />
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                </Card>
              </div>
            ) : positionsTab === "live" ? (
              // TableFrame already draws its own border/rounding, so it sits
              // directly on the page instead of inside a Card -- wrapping it
              // in one too just doubled up the box around the same table.
              // One MT5-style "Trade" table: open positions and pending
              // limit orders together, distinguished by a Type badge
              // (BUY/SELL for a live position, BUY LIMIT/SELL LIMIT for a
              // still-pending one) instead of two separate tabs/tables.
              <TableFrame className="mt-4 min-h-[360px]">
                <table className="h-full w-full min-w-[820px] text-left">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="py-3 pl-4 pr-3 font-bold">Account</th>
                      <th className="px-3 py-3 font-bold">Tag</th>
                      <th className="px-3 py-3 font-bold">Ticket</th>
                      <th className="px-3 py-3 font-bold">Type</th>
                      <th className="px-3 py-3 font-bold">Lot</th>
                      <th className="px-3 py-3 font-bold">Price</th>
                      <th className="px-3 py-3 font-bold">Time</th>
                      <th className="py-3 pl-3 pr-4 font-bold">P/L</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {(mergedTradeRows.length
                      ? mergedTradeRows
                      : [
                          {
                            ticket: "empty",
                            account_name: "-",
                            account_login: "-",
                            tag: "-",
                            side: "-",
                            lot: "-",
                            open_price: "-",
                            profit: "No open positions or pending orders.",
                          },
                        ]
                    ).map((row) => {
                      const isPending = row._kind === "pending";
                      const isBuy = row.side === "BUY";
                      const typeLabel = row.ticket === "empty"
                        ? "-"
                        : `${row.side}${isPending ? " LIMIT" : ""}`;
                      return (
                        <tr
                          key={`${row.account_login}-${row.ticket}`}
                          className="hover:bg-slate-50/70"
                        >
                          <td className="py-3 pl-4 pr-3 text-sm font-medium text-slate-800">
                            {row.account_name} ({row.account_login})
                          </td>
                          <td className="px-3 py-3 text-sm">
                            <span
                              className={cx(
                                "rounded-full px-2 py-0.5 text-[10px] font-bold",
                                row.tag === "Main"
                                  ? "bg-blue-100 text-blue-700"
                                  : "bg-emerald-100 text-emerald-700",
                              )}
                            >
                              {row.tag}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-sm text-slate-700">
                            {row.ticket}
                          </td>
                          <td className="px-3 py-3 text-sm">
                            <span
                              className={cx(
                                "rounded-full px-2 py-0.5 text-[10px] font-bold",
                                isBuy
                                  ? "bg-emerald-100 text-emerald-700"
                                  : "bg-rose-100 text-rose-700",
                              )}
                            >
                              {typeLabel}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-sm text-slate-700">
                            {row.lot}
                          </td>
                          <td className="px-3 py-3 text-sm text-slate-700">
                            {row.price ?? row.open_price ?? "-"}
                          </td>
                          <td className="px-3 py-3 text-sm text-slate-700">
                            {row.ticket === "empty" ? "-" : fmtDateTime(row.opened_at)}
                          </td>
                          <td
                            className={cx(
                              "px-3 py-3 text-sm font-bold",
                              isPending
                                ? "text-slate-400"
                                : Number(row.profit) >= 0
                                  ? "text-emerald-600"
                                  : "text-rose-600",
                            )}
                          >
                            {isPending ? "Pending" : row.profit}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableFrame>
            ) : positionsTab === "scalping" ? (
              <Card className="w-full flex-none !p-3">
                <div className="min-h-max">
                  <ScalpingPage />
                </div>
              </Card>
            ) : (
              // ConsoleLogPanel already draws its own bordered box too --
              // same reasoning as the table above.
              <div className="flex min-h-0 flex-1 flex-col">
                <ConsoleLogPanel
                  emptyText="No trade activity logs yet."
                  entries={tradeFeedLogs}
                  onClear={clearTradeLogs}
                  fill
                />
              </div>
            )}
          </div>
      </div>

      <Dialog
        open={closeConfirmOpen}
        title="Close All Positions"
        onClose={() => setCloseConfirmOpen(false)}
      >
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            This will close every currently open position for the master account
            and linked accounts.
          </p>
          <p className="text-sm font-semibold text-slate-700">
            Do you want to continue?
          </p>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <AppButton variant="soft" onClick={() => setCloseConfirmOpen(false)}>
            Cancel
          </AppButton>
          <AppButton variant="red" onClick={closePositions}>
            Confirm Close
          </AppButton>
        </div>
      </Dialog>
    </div>
  );
}

function toDateTimeLocalValue(value) {
  const dt = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(dt.getTime())) return "";
  const local = new Date(dt.getTime() - dt.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function defaultAutoCloseValue() {
  return toDateTimeLocalValue(new Date(Date.now() + 60 * 60 * 1000));
}
