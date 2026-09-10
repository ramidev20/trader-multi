import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  Play,
  RefreshCcw,
  Server,
  Settings,
  StopCircle,
  Terminal,
  Trash2,
  Wrench,
  Info,
  Check,
  ChevronDown,
  Hourglass,
  Zap,
} from "lucide-react";
import {
  AppButton,
  Card,
  Dialog,
  Field,
} from "../components/ui/Primitives";
import { TableFrame } from "../components/ui/TableFrame";
import { LogList } from "../components/ui/LogList";
import { MetricCard } from "./shared/MetricCard";
import ChartPage from "./ChartPage";
import { cx, decimalInput, money, signedDecimalInput } from "../utils/format";
import { api } from "../services/api";
import {
  isRemoteConnected,
  sendRemoteCommand,
} from "../services/remoteControl";

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

const ORDER_KIND_OPTIONS = [
  { value: "MARKET", label: "MARKET", Icon: Zap },
  { value: "LIMIT", label: "LIMIT", Icon: Hourglass },
];

function IconSelect({ label, value, options, onChange, disabled = false }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const selected = options.find((option) => option.value === value) ?? options[0];
  const SelectedIcon = selected.Icon;

  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(event) {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    }
    function onKeyDown(event) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="relative" ref={rootRef}>
      <span className="block text-xs font-black uppercase tracking-wide text-slate-500">
        {label}
      </span>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((previous) => !previous)}
        className="mt-1.5 flex h-[46px] w-full items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 text-sm font-semibold text-slate-900 outline-none transition hover:bg-white focus:border-blue-500 focus:ring-4 focus:ring-blue-100 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <SelectedIcon className="h-4 w-4 shrink-0 text-blue-600" />
        <span className="min-w-0 flex-1 truncate text-left">
          {selected.label}
        </span>
        <ChevronDown
          className={cx(
            "h-4 w-4 shrink-0 text-slate-400 transition",
            open && "rotate-180",
          )}
        />
      </button>
      {open ? (
        <ul
          role="listbox"
          className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lg shadow-slate-950/10"
        >
          {options.map((option) => {
            const OptionIcon = option.Icon;
            const isSelected = option.value === selected.value;
            return (
              <li key={option.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  className={cx(
                    "flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-semibold transition",
                    isSelected
                      ? "bg-blue-50 text-blue-700"
                      : "text-slate-700 hover:bg-slate-50",
                  )}
                >
                  <OptionIcon
                    className={cx(
                      "h-4 w-4 shrink-0",
                      isSelected ? "text-blue-600" : "text-slate-400",
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {isSelected ? (
                    <Check className="h-4 w-4 shrink-0 text-blue-600" />
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

const PANEL_MIN_WIDTH = 300;
const PANEL_MAX_WIDTH = 720;
const PANEL_DEFAULT_WIDTH = 360;

function clampPanelWidth(value) {
  const width = Number(value);
  if (!Number.isFinite(width)) return PANEL_DEFAULT_WIDTH;
  return Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, Math.round(width)));
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
export function TradePage({ runtime, onRefreshRuntime }) {
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
  const [searchPips, setSearchPips] = useState(
    () => savedTradeForm.searchPips ?? "10",
  );
  // {time, open} of the newest M1 candle. `time` identifies the candle so we
  // can tell when a genuinely new one has started.
  const [m1Candle, setM1Candle] = useState(null);
  // Armed = waiting for the next candle to open before sending the order.
  const [searchArmed, setSearchArmed] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [panelWidth, setPanelWidth] = useState(() =>
    clampPanelWidth(savedTradeForm.panelWidth ?? PANEL_DEFAULT_WIDTH),
  );
  const layoutRef = useRef(null);
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
  const [errorText, setErrorText] = useState("");
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // React state updates aren't synchronous: a very fast double-click can fire
  // both handlers before a re-render disables the button or before `submitting`
  // reflects true in the second call's closure, sending the order twice (locally
  // and to every remote receiver). A ref is read/written immediately, so it
  // closes that gap regardless of render timing.
  const submittingRef = useRef(false);
  // Timestamp of the candle that was current when the search was armed; the
  // order fires on the first candle newer than this one.
  const armedFromRef = useRef(null);
  const placeSearchOrderRef = useRef(null);
  const [refreshing, setRefreshing] = useState(false);
  const [positions, setPositions] = useState([]);
  const [positionsErrors, setPositionsErrors] = useState([]);
  const [limitOrders, setLimitOrders] = useState([]);
  const [limitOrdersErrors, setLimitOrdersErrors] = useState([]);
  const [positionsTab, setPositionsTab] = useState(
    () => savedTradeForm.tradeTab ?? savedTradeForm.positionsTab ?? "chart",
  );
  const openOrders = useMemo(
    () => (runtime?.orders || []).filter((o) => o.status === "open"),
    [runtime],
  );
  const tradeFeedLogs = useMemo(() => {
    const tradeLogPattern =
      /manual|order|position|limit|close|auto close|tp\d?|take profit|stop loss|trade/i;
    const runtimeLogs = (runtime?.logs?.search || []).filter((line) =>
      tradeLogPattern.test(String(line)),
    );
    const openOrderLogs = openOrders
      .filter(
        (order) => String(order.order_kind || "").toUpperCase() !== "LIMIT",
      )
      .map((order) => {
        const kind = String(order.order_kind || "MARKET").toUpperCase();
        const sideLabel = String(order.side || "-").toUpperCase();
        const entry = Number(order.entry ?? order.price ?? 0) || 0;
        return `[INFO] ${kind} ${sideLabel} ${order.symbol || "XAUUSD"} @ ${entry.toFixed(2)} lot=${Number(order.lot || 0).toFixed(2)} status=${order.status || "open"}`;
      });
    const pendingOrderLogs = limitOrders.map((order) => {
      const sideLabel = String(order.side || "-").toUpperCase();
      const entry = Number(order.price ?? order.entry ?? 0) || 0;
      return `[INFO] LIMIT ${sideLabel} ${order.symbol || "XAUUSD"} @ ${entry.toFixed(2)} lot=${Number(order.lot || 0).toFixed(2)} ticket=${order.ticket || "-"}`;
    });
    return [...runtimeLogs, ...openOrderLogs, ...pendingOrderLogs]
      .slice(-120)
      .reverse();
  }, [runtime, openOrders, limitOrders]);
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
          panelWidth,
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
    panelWidth,
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
            panelWidth,
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
    panelWidth,
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
        className="flex min-h-[52px] w-full items-center justify-center rounded-2xl border border-slate-950 bg-slate-950 px-4 text-[15px] font-bold text-white shadow-lg shadow-slate-950/20 transition hover:bg-slate-800 disabled:pointer-events-none disabled:opacity-60"
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
      setErrorText(String(error?.message || error));
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
        setErrorText(String(error?.message || error));
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

  // TradePage unmounts on navigation, so a running countdown would be lost.
  // Re-arm from the candle that is current now: the search stays live instead of
  // resetting, without firing on a trigger that already passed while away.
  useEffect(() => {
    if (savedTradeForm.searchEnabled && savedTradeForm.searchArmed) armSearch();
  }, []);

  // While armed, poll every second so the order lands right on the new candle.
  useEffect(() => {
    if (!searchArmed) return undefined;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      if (cancelled || submittingRef.current) return;
      const candle = await refreshM1Candle();
      if (cancelled || !candle) return;
      if (armedFromRef.current == null || candle.time <= armedFromRef.current)
        return;
      setSearchArmed(false);
      armedFromRef.current = null;
      // Read through the ref: the order must use the TP/SL/side in the form at
      // fire time, not whatever was set when the search was armed.
      placeSearchOrderRef.current?.(candle.open);
    }, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
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
    const { prepare = null, fromSearch = false } = options;
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
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
      if (isRemoteConnected()) {
        const { risk_percent, riskPercent, ...receiverPayload } = orderPayload;
        const { results } = await sendRemoteCommand("open", receiverPayload);
        const failed = results.filter((result) => result.status === "error");
        if (failed.length) {
          throw new Error(
            `Order opened locally, but ${failed.length} receiver(s) did not mirror it: ${failed.map((f) => `${f.label} (${f.message})`).join("; ")}`,
          );
        }
      }
      if (kind === "LIMIT" || fromSearch) setSearchEnabled(false);
      await onRefreshRuntime?.();
      await loadPositions({ silent: true });
      await loadLimitOrders({ silent: true });
      setErrorText("");
    } catch (error) {
      setErrorText(String(error?.message || error));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  // Fired when a new candle starts. Order Type decides what gets sent: MARKET
  // executes on the spot, LIMIT rests at that candle's open plus the offset.
  function openPositionWithSearch(candleOpen) {
    if (orderKind !== "LIMIT") {
      // The candle open is only the trigger here; the fill comes off the tick.
      return openPosition(side, { fromSearch: true });
    }
    return openPosition(side, {
      fromSearch: true,
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
    setErrorText("");
    // Must be a fresh read: a cached candle from before the last fire would
    // already be older than the live one and trigger immediately.
    const candle = await refreshM1Candle();
    if (!candle) {
      setErrorText(
        "Could not read the current 1 minute candle for XAUUSD, so the search cannot start.",
      );
      return;
    }
    armedFromRef.current = candle.time;
    setSearchArmed(true);
  }

  // Width is written straight to the CSS variable while dragging so the whole
  // panel does not re-render on every pointer move; state is committed on drop.
  function startPanelResize(event) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panelWidth;
    let nextWidth = startWidth;

    function onMove(moveEvent) {
      nextWidth = clampPanelWidth(startWidth + (startX - moveEvent.clientX));
      layoutRef.current?.style.setProperty(
        "--trade-panel-width",
        `${nextWidth}px`,
      );
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.removeProperty("user-select");
      document.body.style.removeProperty("cursor");
      setPanelWidth(nextWidth);
    }

    document.body.style.setProperty("user-select", "none");
    document.body.style.setProperty("cursor", "col-resize");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  async function closePositions() {
    try {
      setCloseConfirmOpen(false);
      const response = await api.closePositions();
      if (isRemoteConnected()) {
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
      if (Number(summary.closed || 0) > 0) {
        setErrorText("");
      } else if (Number(summary.attempted || 0) > 0) {
        setErrorText(
          "Close-all completed, but no positions were confirmed closed. Check backend logs.",
        );
      } else {
        setErrorText("No open positions were found to close.");
      }
    } catch (error) {
      setErrorText(String(error?.message || error));
    }
  }

  return (
    <div className="space-y-4">
      {errorText ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-700">
          {errorText}
        </div>
      ) : null}
      <div
        ref={layoutRef}
        className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_6px_var(--trade-panel-width)]"
        style={{ "--trade-panel-width": `${panelWidth}px` }}
      >
        <div className="flex h-[calc(100vh-180px)] flex-col gap-4">
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1">
              {[
                ["chart", "Chart"],
                ["live", "Live Positions"],
                ["orders", "Limit Orders"],
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
              <button
                type="button"
                onClick={() => setCloseConfirmOpen(true)}
                className="inline-flex items-center justify-center gap-2 rounded-2xl border border-transparent bg-transparent px-3 py-2 text-sm font-bold text-violet-700 transition hover:bg-violet-50 hover:text-violet-800"
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

          {positionsTab === "orders" && limitOrdersErrors.length ? (
            <div className="shrink-0 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
              {limitOrdersErrors.join(" • ")}
            </div>
          ) : null}

          <div className="min-h-0 flex-1">
            {positionsTab === "chart" ? (
              <ChartPage />
            ) : (
              <Card className="flex h-full flex-col">
                {positionsTab === "live" ? (
                  <TableFrame className="mt-4 min-h-[360px]">
                    <table className="h-full w-full min-w-[700px] text-left">
                      <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                        <tr>
                          <th className="py-3 pl-4 pr-3 font-bold">Account</th>
                          <th className="px-3 py-3 font-bold">Tag</th>
                          <th className="px-3 py-3 font-bold">Ticket</th>
                          <th className="px-3 py-3 font-bold">Lot</th>
                          <th className="px-3 py-3 font-bold">Open</th>
                          <th className="py-3 pl-3 pr-4 font-bold">P/L</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 bg-white">
                        {(positions.length
                          ? positions
                          : [
                              {
                                ticket: "empty",
                                account_name: "-",
                                account_login: "-",
                                tag: "-",
                                side: "-",
                                lot: "-",
                                open_price: "-",
                                profit: "No open positions.",
                              },
                            ]
                        ).map((row) => (
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
                            <td className="px-3 py-3 text-sm text-slate-700">
                              {row.lot}
                            </td>
                            <td className="px-3 py-3 text-sm text-slate-700">
                              {row.open_price}
                            </td>
                            <td
                              className={cx(
                                "px-3 py-3 text-sm font-bold",
                                Number(row.profit) >= 0
                                  ? "text-emerald-600"
                                  : "text-rose-600",
                              )}
                            >
                              {row.profit}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableFrame>
                ) : positionsTab === "orders" ? (
                  <TableFrame className="mt-4 min-h-[360px]">
                    <table className="h-full w-full min-w-[760px] text-left">
                      <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                        <tr>
                          <th className="py-3 pl-4 pr-3 font-bold">Account</th>
                          <th className="px-3 py-3 font-bold">Ticket</th>
                          <th className="px-3 py-3 font-bold">Side</th>
                          <th className="px-3 py-3 font-bold">Price</th>
                          <th className="px-3 py-3 font-bold">Lot</th>
                          <th className="px-3 py-3 font-bold">Time</th>
                          <th className="py-3 pl-3 pr-4 font-bold">Comment</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 bg-white">
                        {(displayedLimitOrders.length
                          ? displayedLimitOrders
                          : [
                              {
                                ticket: "empty",
                                account_name: "-",
                                account_login: "-",
                                side: "-",
                                price: "-",
                                lot: "-",
                                opened_at: "-",
                                comment: "No pending limit orders.",
                              },
                            ]
                        ).map((row) => (
                          <tr
                            key={`${row.account_login}-${row.ticket}`}
                            className="hover:bg-slate-50/70"
                          >
                            <td className="py-3 pl-4 pr-3 text-sm font-medium text-slate-800">
                              {row.account_name} ({row.account_login})
                            </td>
                            <td className="px-3 py-3 text-sm text-slate-700">
                              {row.ticket}
                            </td>
                            <td className="px-3 py-3 text-sm">
                              <span
                                className={cx(
                                  "rounded-full px-2 py-0.5 text-[10px] font-bold",
                                  row.side === "BUY"
                                    ? "bg-emerald-100 text-emerald-700"
                                    : "bg-rose-100 text-rose-700",
                                )}
                              >
                                {row.side}
                              </span>
                            </td>
                            <td className="px-3 py-3 text-sm text-slate-700">
                              {row.price ?? row.open_price ?? "-"}
                            </td>
                            <td className="px-3 py-3 text-sm text-slate-700">
                              {row.lot}
                            </td>
                            <td className="px-3 py-3 text-sm text-slate-700">
                              {fmtDateTime(row.opened_at)}
                            </td>
                            <td className="py-3 pl-3 pr-4 text-sm text-slate-700">
                              {row.comment || "-"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableFrame>
                ) : (
                  <LogList
                    className="mt-4 min-h-[360px]"
                    logs={tradeFeedLogs}
                    emptyMessage="[INFO] No trade activity logs yet."
                  />
                )}
              </Card>
            )}
          </div>
        </div>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize trade panel"
          title="Drag to resize · double-click to reset"
          onPointerDown={startPanelResize}
          onDoubleClick={() => setPanelWidth(PANEL_DEFAULT_WIDTH)}
          className="hidden cursor-col-resize rounded-full bg-slate-200 transition hover:bg-blue-400 xl:block"
        />
        <div className="flex h-[calc(100vh-180px)] min-w-0 flex-col">
          <Card className="flex h-full flex-col pt-3">
            <div className="shrink-0 space-y-3">
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
            <div
              role="tablist"
              aria-label="Trade options"
              className="mt-4 grid shrink-0 grid-cols-3 gap-1 rounded-xl border border-slate-200 bg-slate-100 p-1"
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
            <div className="mt-3 shrink-0 border-t border-slate-200 pt-3">
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

export function RiskManagementPage({ runtime, onRefreshRuntime }) {
  const [intervalSec, setIntervalSec] = useState("60");
  const [ordersLimit, setOrdersLimit] = useState("10");
  const [riskLimit, setRiskLimit] = useState("1");
  const [profitLimit, setProfitLimit] = useState("1");
  const [errorText, setErrorText] = useState("");

  const monitorRunning = Boolean(runtime?.risk_monitor?.running);

  async function startMonitor() {
    try {
      await api.startRiskMonitor({
        interval_sec: Number(intervalSec || 60),
        orders_limit: Number(ordersLimit || 10),
        risk_percent: Number(riskLimit || 1),
        profit_percent: Number(profitLimit || 1),
      });
      await onRefreshRuntime?.();
      setErrorText("");
    } catch (error) {
      setErrorText(String(error?.message || error));
    }
  }

  async function stopMonitor() {
    try {
      await api.stopRiskMonitor();
      await onRefreshRuntime?.();
      setErrorText("");
    } catch (error) {
      setErrorText(String(error?.message || error));
    }
  }

  return (
    <Card>
      <h3 className="text-lg font-black text-slate-950">Risk Management</h3>
      {errorText ? (
        <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-700">
          {errorText}
        </div>
      ) : null}
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <Field
          label="Check Interval (seconds)"
          value={intervalSec}
          onChange={(e) => setIntervalSec(e.target.value)}
        />
        <Field
          label="Orders Limit"
          value={ordersLimit}
          onChange={(e) => setOrdersLimit(e.target.value)}
        />
        <Field
          label="Risk Limit (%)"
          value={riskLimit}
          onChange={(e) => setRiskLimit(e.target.value)}
        />
        <Field
          label="Profit Limit (%)"
          value={profitLimit}
          onChange={(e) => setProfitLimit(e.target.value)}
        />
      </div>
      <div className="mt-4 flex gap-2">
        <AppButton
          variant="green"
          disabled={monitorRunning}
          onClick={startMonitor}
        >
          <Play className="h-4 w-4" /> Start Monitoring
        </AppButton>
        <AppButton
          variant="soft"
          disabled={!monitorRunning}
          onClick={stopMonitor}
        >
          <StopCircle className="h-4 w-4" /> Stop Monitoring
        </AppButton>
      </div>
    </Card>
  );
}

export function ProfilePage({
  accountsData = [],
  runtime,
  historyRows = [],
  summaries = [],
}) {
  const historyOrders = historyRows.length
    ? historyRows
    : Array.isArray(runtime?.orders)
      ? runtime.orders
      : [];

  return (
    <div className="grid gap-5">
      <Card>
        <h3 className="text-xl font-black text-slate-950">Account Profiles</h3>
      </Card>
      <div className="grid gap-5 xl:grid-cols-2">
        {accountsData.length ? (
          accountsData.map((account) => {
            const balance = Number(account.balance || 0);
            const accountLogin = String(account.login || "");
            const accountHistory = historyOrders.filter((order) => {
              const orderLogin = order.account_login ?? order.login;
              // Older runtime orders have no account login and belong to the master.
              return orderLogin == null
                ? String(account.role).toUpperCase() === "MASTER"
                : String(orderLogin) === accountLogin;
            });
            const historyProfit = accountHistory
              .filter(
                (order) =>
                  String(order.status || "").toLowerCase() === "closed",
              )
              .reduce((sum, order) => sum + Number(order.profit || 0), 0);
            const pnl = historyProfit || Number(account.pnl || 0);
            const firstBalanceFromHistory = accountHistory
              .map((order) => ({
                balance: Number(
                  order.balance_before || order.initial_balance || 0,
                ),
                createdAt: new Date(order.created_at || 0).getTime(),
              }))
              .filter((item) => item.balance > 0)
              .sort((a, b) => a.createdAt - b.createdAt)[0]?.balance;
            const summary = summaries.find(
              (item) => String(item.login) === accountLogin,
            );
            const firstBalance = Number(
              summary?.initial_balance ||
                firstBalanceFromHistory ||
                balance - historyProfit,
            );
            const profitPercent = firstBalance ? (pnl / firstBalance) * 100 : 0;
            return (
              <Card key={account.login}>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div
                      className={cx(
                        "grid h-12 w-12 place-items-center rounded-xl bg-gradient-to-br text-lg font-black text-white",
                        account.color || "from-slate-500 to-slate-700",
                      )}
                    >
                      {(account.name || "A").charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <h4 className="font-black text-slate-950">
                        {account.name || "Trading Account"}
                      </h4>
                      <p className="mt-1 text-xs font-semibold text-slate-500">
                        {account.role} - Login {account.login}
                      </p>
                    </div>
                  </div>
                  <span
                    className={cx(
                      "rounded-full px-2.5 py-1 text-xs font-bold",
                      account.status === "Connected"
                        ? "bg-emerald-50 text-emerald-700"
                        : "bg-rose-50 text-rose-700",
                    )}
                  >
                    {account.status || "Disconnected"}
                  </span>
                </div>
                <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <ProfileMetric label="Balance" value={money(balance)} />
                  <ProfileMetric label="Equity" value={money(account.equity)} />
                  <ProfileMetric
                    label="Profit / Loss"
                    value={money(pnl)}
                    positive={pnl >= 0}
                  />
                  <ProfileMetric
                    label="Profit %"
                    value={`${profitPercent.toFixed(2)}%`}
                    positive={profitPercent >= 0}
                  />
                </div>
                <div className="mt-4 grid gap-2 border-t border-slate-100 pt-4 text-xs font-semibold text-slate-500 sm:grid-cols-2">
                  <span>
                    Server:{" "}
                    <strong className="text-slate-700">
                      {account.server || "-"}
                    </strong>
                  </span>
                  <span>
                    Risk:{" "}
                    <strong className="text-slate-700">
                      {Number(account.risk || 0).toFixed(2)}%
                    </strong>
                  </span>
                  <span>
                    Order delay:{" "}
                    <strong className="text-slate-700">
                      {account.orderDelaySec ?? 0}s
                    </strong>
                  </span>
                  <span>
                    Connection:{" "}
                    <strong className="text-slate-700">
                      {account.sessionState || "-"}
                    </strong>
                  </span>
                </div>
              </Card>
            );
          })
        ) : (
          <Card>
            <p className="text-sm font-semibold text-slate-500">
              No trading accounts configured.
            </p>
          </Card>
        )}
      </div>
    </div>
  );
}

export function NotificationsPage({ notifications = [] }) {
  const [filter, setFilter] = useState("all");
  const visible = notifications.filter(
    (notification) => filter === "all" || notification.category === filter,
  );

  return (
    <Card className="min-h-[calc(100vh-150px)]">
      <div className="flex flex-col gap-4 border-b border-slate-100 pb-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="flex items-center gap-2 text-xl font-black text-slate-950">
            <Bell className="h-5 w-5 text-blue-600" /> Notifications
          </h3>
        </div>
        <div className="flex gap-2">
          {["all", "system", "other"].map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              className={cx(
                "rounded-full px-3 py-1.5 text-xs font-bold capitalize",
                filter === value
                  ? "bg-slate-950 text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200",
              )}
            >
              {value === "other" ? "Other notifications" : value}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-5 divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white">
        {visible.length ? (
          visible.map((notification) => {
            const Icon =
              notification.level === "error" || notification.level === "warning"
                ? AlertTriangle
                : notification.level === "success"
                  ? CheckCircle2
                  : Info;
            return (
              <div key={notification.id} className="flex gap-4 px-4 py-4">
                <Icon
                  className={cx(
                    "mt-0.5 h-5 w-5 shrink-0",
                    notification.level === "error"
                      ? "text-rose-500"
                      : notification.level === "warning"
                        ? "text-amber-500"
                        : notification.level === "success"
                          ? "text-emerald-500"
                          : "text-blue-500",
                  )}
                />
                <div>
                  <p className="text-sm font-black text-slate-800">
                    {notification.title}
                  </p>
                  <p className="mt-1 text-sm leading-6 text-slate-500">
                    {notification.message}
                  </p>
                </div>
              </div>
            );
          })
        ) : (
          <p className="px-4 py-12 text-center text-sm font-semibold text-slate-400">
            No notifications in this category.
          </p>
        )}
      </div>
    </Card>
  );
}

function ProfileMetric({ label, value, positive }) {
  return (
    <div className="rounded-xl bg-slate-50 p-3">
      <p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">
        {label}
      </p>
      <p
        className={cx(
          "mt-1 text-sm font-black",
          positive === undefined
            ? "text-slate-950"
            : positive
              ? "text-emerald-600"
              : "text-rose-600",
        )}
      >
        {value}
      </p>
    </div>
  );
}

export function SettingsPlaceholder({
  initialTab = "accounts",
  accountsData = [],
  onEdit,
  onDelete,
  notificationSettings = {
    enabled: true,
    show_warnings: true,
    show_success: true,
    show_info: false,
  },
  onNotificationSettingsChange,
  themeMode = "LIGHT",
  onThemeModeChange,
  uiZoomPercent = 100,
  onUiZoomPercentChange,
}) {
  const settingsTabs = ["accounts", "search", "notifications", "appearance"];
  const normalizeSettingsTab = (tab) =>
    settingsTabs.includes(tab) ? tab : "accounts";
  const [settingsTab, setSettingsTab] = useState(
    normalizeSettingsTab(initialTab),
  );
  const [searchSettings, setSearchSettings] = useState({
    timeframe: "M1",
    pips: 25,
    max_pips: 70,
    max_positions: 3,
    orders_limit: 10,
    tp: 150,
    sl: 500,
    enable_buy: true,
    enable_sell: true,
    enable_liquidity: true,
    enable_pullback: false,
    pullback_pips: 20,
    stop_on_first_close: true,
  });
  const [settingsMessage, setSettingsMessage] = useState("");
  useEffect(
    () => setSettingsTab(normalizeSettingsTab(initialTab)),
    [initialTab],
  );
  useEffect(() => {
    api
      .settings()
      .then((settings) => {
        if (settings?.search_config)
          setSearchSettings((current) => ({
            ...current,
            ...settings.search_config,
          }));
      })
      .catch(() => {});
  }, []);

  async function saveSearchSettings() {
    try {
      await api.saveSearchConfig(searchSettings);
      setSettingsMessage(
        "Search defaults saved. New searches will use these values.",
      );
    } catch (error) {
      setSettingsMessage(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async function saveNotificationSettings(nextSettings) {
    try {
      await api.saveNotificationSettings(nextSettings);
      onNotificationSettingsChange?.(nextSettings);
      setSettingsMessage("Notification preferences saved.");
    } catch (error) {
      setSettingsMessage(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async function saveThemeMode(nextThemeMode) {
    try {
      await api.saveTheme(nextThemeMode);
      onThemeModeChange?.(nextThemeMode);
      setSettingsMessage(
        `${nextThemeMode === "DARK" ? "Dark" : "Light"} appearance saved.`,
      );
    } catch (error) {
      setSettingsMessage(
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  async function saveUiZoom(nextZoom) {
    const zoom = Math.min(150, Math.max(70, Number(nextZoom || 100)));
    onUiZoomPercentChange?.(zoom);
    try {
      await api.saveZoom(zoom);
      setSettingsMessage(`App zoom saved at ${zoom}%.`);
    } catch (error) {
      setSettingsMessage(
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  const tabNavigation = (
    <div className="flex flex-wrap gap-5 border-b border-slate-200">
      {settingsTabs.map((tab) => (
        <button
          key={tab}
          type="button"
          onClick={() => setSettingsTab(tab)}
          className={cx(
            "border-b-2 px-1 py-3 text-sm font-bold capitalize transition",
            settingsTab === tab
              ? "border-blue-600 text-blue-600"
              : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-900",
          )}
        >
          {tab}
        </button>
      ))}
    </div>
  );

  if (settingsTab !== "accounts") {
    return (
      <div className="space-y-6">
        {tabNavigation}
        <Card>
          {settingsTab === "search" ? (
            <>
              <h3 className="text-lg font-black text-slate-950">
                Search Defaults
              </h3>
              <div className="mt-6 grid gap-4 md:grid-cols-3">
                <label className="text-sm font-bold text-slate-700">
                  Timeframe
                  <select
                    value={searchSettings.timeframe}
                    onChange={(event) =>
                      setSearchSettings({
                        ...searchSettings,
                        timeframe: event.target.value,
                      })
                    }
                    className="mt-2 h-11 w-full rounded-xl border border-slate-200 bg-white px-3 font-semibold"
                  >
                    <option>M1</option>
                    <option>M3</option>
                    <option>M5</option>
                    <option>M15</option>
                  </select>
                </label>
                {[
                  ["pips", "Minimum Pips"],
                  ["max_pips", "Maximum Pips"],
                  ["max_positions", "Maximum Positions"],
                  ["orders_limit", "Search Order Limit"],
                  ["tp", "Take Profit"],
                  ["sl", "Stop Loss"],
                  ["pullback_pips", "Pullback Pips"],
                ].map(([key, label]) => (
                  <label key={key} className="text-sm font-bold text-slate-700">
                    {label}
                    <input
                      type="number"
                      min="0"
                      value={searchSettings[key] ?? ""}
                      onChange={(event) =>
                        setSearchSettings({
                          ...searchSettings,
                          [key]: Number(event.target.value),
                        })
                      }
                      className="mt-2 h-11 w-full rounded-xl border border-slate-200 bg-white px-3 font-semibold"
                    />
                  </label>
                ))}
              </div>
              <div className="mt-5 flex flex-wrap gap-5 text-sm font-bold text-slate-700">
                {[
                  ["enable_buy", "Enable BUY"],
                  ["enable_sell", "Enable SELL"],
                  ["enable_liquidity", "Liquidity trigger"],
                  ["enable_pullback", "Enable pullback"],
                  ["stop_on_first_close", "Stop after first close"],
                ].map(([key, label]) => (
                  <label key={key} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={Boolean(searchSettings[key])}
                      onChange={(event) =>
                        setSearchSettings({
                          ...searchSettings,
                          [key]: event.target.checked,
                        })
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>
              <AppButton
                variant="blue"
                className="mt-6"
                onClick={saveSearchSettings}
              >
                Save Search Defaults
              </AppButton>
            </>
          ) : null}

          {settingsTab === "notifications" ? (
            <>
              <h3 className="text-lg font-black text-slate-950">
                Notification Preferences
              </h3>
              <div className="mt-6 space-y-4">
                {[
                  [
                    "enabled",
                    "Enable notifications",
                    "Show notifications from account, search, remote, and risk events.",
                  ],
                  [
                    "show_warnings",
                    "Show warnings",
                    "Include account disconnects, blocked commands, and warning events.",
                  ],
                  [
                    "show_success",
                    "Show successful actions",
                    "Include successful orders, connections, and completed commands.",
                  ],
                  [
                    "show_info",
                    "Show informational updates",
                    "Include routine system information messages.",
                  ],
                ].map(([key, label, help]) => (
                  <label
                    key={key}
                    className="flex items-start justify-between gap-4 rounded-2xl border border-slate-200 p-4"
                  >
                    <span>
                      <span className="block text-sm font-black text-slate-900">
                        {label}
                      </span>
                      <span className="mt-1 block text-xs leading-5 text-slate-500">
                        {help}
                      </span>
                    </span>
                    <input
                      type="checkbox"
                      checked={Boolean(notificationSettings[key])}
                      onChange={(event) =>
                        saveNotificationSettings({
                          ...notificationSettings,
                          [key]: event.target.checked,
                        })
                      }
                      className="mt-1 h-4 w-4"
                    />
                  </label>
                ))}
              </div>
            </>
          ) : null}

          {settingsTab === "appearance" ? (
            <>
              <h3 className="text-lg font-black text-slate-950">Appearance</h3>
              <div className="mt-6 grid max-w-xl gap-3 sm:grid-cols-2">
                {[
                  [
                    "LIGHT",
                    "Light",
                    "Clean, high-contrast workspace for daytime trading.",
                  ],
                  [
                    "DARK",
                    "Dark",
                    "Reduced glare for low-light trading sessions.",
                  ],
                ].map(([mode, label, help]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => saveThemeMode(mode)}
                    className={cx(
                      "rounded-2xl border p-4 text-left transition",
                      themeMode === mode
                        ? "border-blue-500 bg-blue-50"
                        : "border-slate-200 bg-white hover:border-slate-300",
                    )}
                  >
                    <span className="block text-sm font-black text-slate-950">
                      {label}
                    </span>
                    <span className="mt-1 block text-xs leading-5 text-slate-500">
                      {help}
                    </span>
                  </button>
                ))}
              </div>
              <div className="mt-7 max-w-xl rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <span className="block text-sm font-black text-slate-950">
                      App zoom
                    </span>
                    <span className="mt-1 block text-xs leading-5 text-slate-500">
                      Scale the entire interface like browser zoom.
                    </span>
                  </div>
                  <output className="min-w-14 rounded-lg bg-white px-3 py-1.5 text-center text-sm font-black text-blue-600">
                    {uiZoomPercent}%
                  </output>
                </div>
                <input
                  aria-label="App zoom"
                  className="mt-4 w-full accent-blue-600"
                  type="range"
                  min="70"
                  max="150"
                  step="5"
                  value={uiZoomPercent}
                  onChange={(event) =>
                    onUiZoomPercentChange?.(Number(event.target.value))
                  }
                  onPointerUp={(event) => saveUiZoom(event.currentTarget.value)}
                  onKeyUp={(event) => saveUiZoom(event.currentTarget.value)}
                />
                <div className="mt-2 flex justify-between text-[11px] font-bold text-slate-500">
                  <span>70%</span>
                  <button
                    type="button"
                    className="text-blue-600 hover:text-blue-700"
                    onClick={() => saveUiZoom(100)}
                  >
                    Reset to 100%
                  </button>
                  <span>150%</span>
                </div>
              </div>
            </>
          ) : null}
          {settingsMessage ? (
            <p className="mt-5 text-sm font-semibold text-emerald-700">
              {settingsMessage}
            </p>
          ) : null}
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {tabNavigation}
      <div>
        <div className="min-h-[420px] overflow-hidden rounded-[8px] border border-slate-200">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[940px] text-left">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-3 pl-4 pr-3 font-bold">Account</th>
                  <th className="px-3 py-3 font-bold">Server</th>
                  <th className="px-3 py-3 font-bold">Balance</th>
                  <th className="px-3 py-3 font-bold">Risk Percent</th>
                  <th className="py-3 pl-3 pr-4 text-right font-bold">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {accountsData.map((account) => (
                  <tr
                    key={account.id}
                    className="border-t border-slate-100 hover:bg-slate-50/70"
                  >
                    <td className="py-4 pl-4 pr-3">
                      <div className="flex items-center gap-3">
                        <div
                          className={cx(
                            "grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br text-xs font-black text-white shadow-sm",
                            account.color,
                          )}
                        >
                          {(account.name || "A").charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="font-semibold text-slate-950">
                              {account.name}
                            </p>
                            <span
                              className={cx(
                                "rounded-full px-2 py-0.5 text-[10px] font-bold",
                                account.role === "MASTER"
                                  ? "bg-blue-100 text-blue-700"
                                  : "bg-emerald-100 text-emerald-700",
                              )}
                            >
                              {account.role}
                            </span>
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-4 text-sm text-slate-700 break-words">
                      {account.server}
                    </td>
                    <td className="px-3 py-4 text-sm font-semibold text-slate-800">
                      {money(account.balance)}
                    </td>
                    <td className="px-3 py-4 text-sm font-semibold text-slate-800">
                      {Number(account.risk ?? 1).toFixed(2)}
                    </td>
                    <td className="py-4 pl-3 pr-4">
                      <div className="flex justify-end gap-2">
                        <button className="rounded-xl border border-slate-200 p-2 text-slate-500 hover:bg-white hover:text-blue-600">
                          <Terminal className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => onEdit?.(account)}
                          className="rounded-xl border border-slate-200 p-2 text-slate-500 hover:bg-white hover:text-slate-950"
                        >
                          <Wrench className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => onDelete?.(account)}
                          className="rounded-xl border border-slate-200 p-2 text-slate-500 hover:bg-white hover:text-rose-600"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
