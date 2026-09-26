import React, { useEffect, useMemo, useRef, useState } from "react";
import { Eraser } from "lucide-react";
import {
  BaselineSeries,
  CandlestickSeries,
  ColorType,
  LineSeries,
  createChart,
} from "lightweight-charts";
import { api } from "../services/api";
import { cx } from "../utils/format";
import { clearBanner, showBanner } from "../utils/banner";
import { getChartPalette, watchThemeChange } from "../utils/chartTheme";

type CandlePoint = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

type TradeOrder = {
  ticket?: number | string;
  position_id?: number | string;
  symbol?: string;
  side?: string;
  order_kind?: string;
  lot?: number;
  price?: number;
  entry?: number;
  sl?: number;
  tp?: number;
  created_at?: string;
  opened_at?: string | number;
  status?: string;
  close_reason?: string;
  close_price?: number;
  closed_at?: string | number;
};

type ChartSnapshot = {
  candles: CandlePoint[];
  orders: TradeOrder[];
  source?: "live" | "simulated";
  bid?: number | null;
  ask?: number | null;
  server_time?: number | null;
  updated_at?: string;
};

function toUnix(value?: string | number | null) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value))
    return Math.floor(value);
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return null;
  return Math.floor(dt.getTime() / 1000);
}

const TIMEFRAME_SECONDS: Record<string, number> = {
  M1: 60,
  M3: 180,
  M5: 300,
  M15: 900,
};

const TIMEFRAME_MINUTES: Record<string, number> = {
  M1: 1,
  M3: 3,
  M5: 5,
  M15: 15,
};

function formatCountdown(totalSeconds: number) {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function nearestCandleTime(
  value: string | number | undefined,
  candles: CandlePoint[],
) {
  const lastTime = candles[candles.length - 1]?.time;
  if (!lastTime) return null;
  const requestedTime = toUnix(value) ?? lastTime;
  return candles.reduce(
    (nearest, candle) =>
      Math.abs(candle.time - requestedTime) < Math.abs(nearest - requestedTime)
        ? candle.time
        : nearest,
    candles[0].time,
  );
}

function positionIdentity(order: TradeOrder) {
  return String(order.position_id ?? order.ticket ?? "");
}

class ChartErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-64 flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-rose-200 bg-rose-50 p-6 text-center">
          <p className="text-sm font-semibold text-rose-800">The chart hit a rendering error.</p>
          <button
            type="button"
            className="rounded-lg bg-white px-3 py-2 text-sm font-bold text-slate-700 shadow-sm"
            onClick={() => this.setState({ hasError: false })}
          >
            Reload chart
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function ChartPageView() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<any>(null);
  const seriesRef = useRef<any>(null);
  const positionSeriesRef = useRef<
    Map<
      string,
      {
        tpZone: any;
        slZone: any;
      }
    >
  >(new Map());
  const rememberedPositionsRef = useRef<Map<string, TradeOrder>>(new Map());
  const frozenZoneTimesRef = useRef<Map<string, number>>(new Map());
  // Hover hit-test data for the position tooltip -- kept separate from the
  // chart series themselves (lightweight-charts series aren't queryable for
  // "what price range does this cover", so the plain numbers are cached here
  // instead) and rebuilt every time the positions-drawing effect runs.
  const positionsHoverRef = useRef<
    Array<{
      ticket: string;
      side: string;
      lot: number;
      entryPrice: number;
      tpPrice: number;
      slPrice: number;
      closeReason: string;
      closePrice: number;
      startTime: number;
      endTime: number;
    }>
  >([]);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const tooltipTitleRef = useRef<HTMLDivElement | null>(null);
  const tooltipMetaRef = useRef<HTMLSpanElement | null>(null);
  const tooltipOpenRef = useRef<HTMLSpanElement | null>(null);
  const tooltipTpRowRef = useRef<HTMLDivElement | null>(null);
  const tooltipTpRef = useRef<HTMLSpanElement | null>(null);
  const tooltipSlRowRef = useRef<HTMLDivElement | null>(null);
  const tooltipSlRef = useRef<HTMLSpanElement | null>(null);
  const tooltipResultRef = useRef<HTMLDivElement | null>(null);
  const zoneOverlayRef = useRef<
    Record<
      string,
      {
        triggerLine: any;
        m5ZoneFill: any;
        m5ZoneBottom: any;
        m5ZoneEdges: any;
        m1ZoneFill: any;
        m1ZoneBottom: any;
        m1ZoneEdges: any;
        breachedZoneFill: any;
        breachedZoneBottom: any;
        breachedZoneEdges: any;
      }
    >
  >({});
  const fittedRef = useRef(false);
  const normalizedCandlesRef = useRef<CandlePoint[]>([]);
  const chartHistoryResetRef = useRef(true);
  const chartHistoryLoadedRef = useRef(false);
  const quotePollRef = useRef(false);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  // Broker (MT5) time vs. this browser's clock, so the per-timeframe
  // countdowns line up with when candles actually close on the server
  // rather than the client's clock -- captured from the currently-forming
  // candle's open time each time a new one appears, and reused for every
  // timeframe's countdown (the offset between the two clocks is the same
  // regardless of which timeframe is selected).
  const brokerOffsetRef = useRef<number | null>(null);
  const countdownLineRef = useRef<any>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [timeframe, setTimeframe] = useState("M1");
  const timeframeRef = useRef(timeframe);
  timeframeRef.current = timeframe;
  const chartRequestRef = useRef(0);
  const [snapshot, setSnapshot] = useState<ChartSnapshot>({
    candles: [],
    orders: [],
  });
  const [zoneStatus, setZoneStatus] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  // Brief flash over the chart pane on the Clear click, purely visual
  // feedback that it happened.
  const [clearPulse, setClearPulse] = useState(false);
  // Identities (not a blanket flag) of the specific items visible at the
  // moment Clear was clicked -- a plain boolean here previously suppressed
  // *every* future redraw too, so a brand new zone found or order placed
  // after clicking Clear would never appear again until the page reloaded.
  // "No restore" only means what was on screen at that moment stays gone;
  // anything new discovered afterwards (different formed_at/ticket, so a
  // different key) still draws normally.
  const clearedKeysRef = useRef<Set<string>>(new Set());
  const [clearNonce, setClearNonce] = useState(0);
  function clearDrawings() {
    setClearPulse(true);
    window.setTimeout(() => setClearPulse(false), 350);
    const keys = clearedKeysRef.current;
    ["demand", "supply"].forEach((side) => {
      const sideStatus = zoneStatus?.[side];
      if (!sideStatus) return;
      if (Number(sideStatus.trigger_price) > 0) {
        keys.add(`${side}:trigger:${sideStatus.started_at}`);
      }
      if (sideStatus.m5_zone) keys.add(`${side}:m5:${sideStatus.m5_zone.formed_at}`);
      if (sideStatus.m1_zone) keys.add(`${side}:m1:${sideStatus.m1_zone.formed_at}`);
      if (sideStatus.last_breached_m5_zone) {
        keys.add(`${side}:breached:${sideStatus.last_breached_m5_zone.breached_at}`);
      }
    });
    rememberedPositionsRef.current.forEach((order) => {
      const identity = positionIdentity(order);
      if (identity) keys.add(`position:${identity}`);
    });
    // Nothing above mutates React state the effects depend on, so bump a
    // counter to make them re-run immediately against the updated cleared
    // set instead of waiting for the next 2s poll.
    setClearNonce((n) => n + 1);
  }
  // Surfaces in the TopBar's banner slot (see utils/banner.js) instead of an
  // inline div here, which used to push the chart down every time a fetch
  // failed. Called with the actual Error object so its `.code` (an HTTP
  // status or "NETWORK") survives into the banner.
  function reportError(error) {
    showBanner(error?.message || String(error), "error", error?.code);
  }
  const spread =
    typeof snapshot.bid === "number" && typeof snapshot.ask === "number"
      ? snapshot.ask - snapshot.bid
      : null;

  async function loadChart(silent = false) {
    const requestId = ++chartRequestRef.current;
    const requestedTimeframe = timeframeRef.current;
    if (!silent) setLoading(true);
    try {
      const data = await api.chartData({
        symbol: "XAUUSD",
        timeframe: requestedTimeframe,
        count: 180,
      });
      // A slow response from the previous timeframe must not replace the
      // snapshot for the currently selected chart frame.
      if (requestId !== chartRequestRef.current) return;
      chartHistoryResetRef.current = true;
      chartHistoryLoadedRef.current = true;
      setSnapshot({
        candles: Array.isArray(data?.candles) ? data.candles : [],
        orders: Array.isArray(data?.orders) ? data.orders : [],
        source: data?.source,
        bid: data?.bid,
        ask: data?.ask,
        server_time: data?.server_time,
        updated_at: data?.updated_at,
      });
      clearBanner();
    } catch (error) {
      if (requestId === chartRequestRef.current) reportError(error);
    } finally {
      if (requestId === chartRequestRef.current && !silent) setLoading(false);
    }
  }

  useEffect(() => {
    // Invalidate any in-flight request from the frame we are leaving before
    // starting the initial fetch and polling for the newly selected frame.
    chartRequestRef.current += 1;
    fittedRef.current = false;
    chartHistoryLoadedRef.current = false;
    normalizedCandlesRef.current = [];
    chartHistoryResetRef.current = true;
    loadChart();
    return undefined;
  }, [timeframe]);

  // History is fetched when the page opens or the timeframe changes. The
  // frequent path asks MT5 only for its current tick, then updates the
  // forming candle locally instead of downloading the same 180 bars again.
  useEffect(() => {
    let cancelled = false;
    async function pollQuote() {
      if (cancelled || quotePollRef.current) return;
      quotePollRef.current = true;
      try {
        const quote = await api.chartQuote("XAUUSD");
        if (cancelled) return;
        const bid = Number(quote?.bid);
        const ask = Number(quote?.ask);
        const serverTime = Number(quote?.server_time);
        if (![bid, ask, serverTime].every(Number.isFinite) || bid <= 0 || ask <= 0 || serverTime <= 0) return;
        const seconds = TIMEFRAME_SECONDS[timeframeRef.current] || 60;
        const candleTime = Math.floor(serverTime / seconds) * seconds;
        const price = (bid + ask) / 2;
        setSnapshot((current) => {
          const candles = current.candles.slice();
          const last = candles[candles.length - 1];
          if (last && Number(last.time) === candleTime) {
            candles[candles.length - 1] = {
              ...last,
              high: Math.max(Number(last.high), price),
              low: Math.min(Number(last.low), price),
              close: price,
            };
          } else if (last && candleTime > Number(last.time)) {
            candles.push({ time: candleTime, open: price, high: price, low: price, close: price });
            if (candles.length > 400) candles.splice(0, candles.length - 400);
          }
          const refreshedOpenPositions = Array.isArray(quote?.orders) ? quote.orders : null;
          const orders = refreshedOpenPositions
            ? [
                ...current.orders.filter((order) =>
                  String(order.status || "").toLowerCase() !== "open",
                ),
                ...refreshedOpenPositions,
              ]
            : current.orders;
          return { ...current, candles, orders, bid, ask, server_time: serverTime, source: quote?.source || current.source, updated_at: new Date().toISOString() };
        });
      } catch (error) {
        if (!cancelled) reportError(error);
      } finally {
        quotePollRef.current = false;
      }
    }
    pollQuote();
    const timer = window.setInterval(pollQuote, 1000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let polling = false;
    async function pollZoneStrategy() {
      if (polling) return;
      polling = true;
      try {
        const result = await api.zoneStrategyStatus();
        if (!cancelled) {
          const status = result?.zone_strategy || null;
          setZoneStatus(status);
          // Live positions now arrive with the quote poll, so order placement
          // does not trigger another full candle-history request.
        }
      } catch {
        // transient network errors are fine to skip silently on a poll loop
      } finally {
        polling = false;
      }
    }
    pollZoneStrategy();
    const timer = window.setInterval(pollZoneStrategy, 500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!containerRef.current) return undefined;
    const palette = getChartPalette();
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: palette.background },
        textColor: palette.text,
      },
      grid: {
        vertLines: { color: palette.grid },
        horzLines: { color: palette.grid },
      },
      crosshair: { mode: 0 },
      rightPriceScale: { borderColor: palette.border },
      timeScale: {
        borderColor: palette.border,
        timeVisible: true,
        secondsVisible: false,
      },
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: palette.upColor,
      downColor: palette.downColor,
      borderVisible: false,
      wickUpColor: palette.upColor,
      wickDownColor: palette.downColor,
      // The built-in last-value tag is replaced by our own price line below
      // (price + candle-close countdown combined into one tag), so the
      // default one is turned off instead of showing two side by side.
      lastValueVisible: false,
    });
    chartRef.current = chart;
    seriesRef.current = candles;
    const fitWhenVisible = () => {
      const container = containerRef.current;
      if (
        fittedRef.current ||
        !chartHistoryLoadedRef.current ||
        !normalizedCandlesRef.current.length ||
        !container?.clientWidth ||
        !container?.clientHeight
      ) {
        return;
      }
      chart.timeScale().fitContent();
      fittedRef.current = true;
    };
    resizeObserverRef.current = new ResizeObserver(fitWhenVisible);
    resizeObserverRef.current.observe(containerRef.current);

    // Hover tooltip for open positions -- replaces the dashed TP/SL/entry
    // price lines that used to sit on the chart permanently. Hit-tested
    // against positionsHoverRef (rebuilt by the positions-drawing effect)
    // instead of a series lookup, since lightweight-charts series can't be
    // queried for "what price range does this cover".
    function handleCrosshairMove(param: any) {
      const tooltip = tooltipRef.current;
      if (!tooltip) return;
      if (!param?.point || param.time == null || !seriesRef.current) {
        tooltip.classList.add("hidden");
        return;
      }
      const hoverPrice = seriesRef.current.coordinateToPrice(param.point.y);
      if (hoverPrice == null) {
        tooltip.classList.add("hidden");
        return;
      }
      const match = positionsHoverRef.current.find((position) => {
        const values = [position.entryPrice, position.tpPrice, position.slPrice, position.closePrice].filter(
          (value) => value > 0,
        );
        if (!values.length) return false;
        const lo = Math.min(...values);
        const hi = Math.max(...values);
        return (
          Number(param.time) >= position.startTime &&
          Number(param.time) <= position.endTime &&
          hoverPrice >= lo &&
          hoverPrice <= hi
        );
      });
      if (!match) {
        tooltip.classList.add("hidden");
        return;
      }
      tooltip.classList.remove("hidden");
      if (tooltipTitleRef.current) {
        tooltipTitleRef.current.textContent = `${match.side === "LONG" ? "BUY" : "SELL"} XAUUSD`;
        tooltipTitleRef.current.style.color = "#334155";
      }
      if (tooltipMetaRef.current) {
        tooltipMetaRef.current.textContent = `${match.lot.toFixed(2)} lot · #${match.ticket}`;
      }
      if (tooltipOpenRef.current) {
        tooltipOpenRef.current.textContent = match.entryPrice.toFixed(2);
      }
      if (tooltipTpRowRef.current) {
        tooltipTpRowRef.current.classList.toggle("hidden", !(match.tpPrice > 0));
      }
      if (tooltipTpRef.current) {
        tooltipTpRef.current.textContent = match.tpPrice > 0 ? match.tpPrice.toFixed(2) : "-";
      }
      if (tooltipSlRowRef.current) {
        tooltipSlRowRef.current.classList.toggle("hidden", !(match.slPrice > 0));
      }
      if (tooltipSlRef.current) {
        tooltipSlRef.current.textContent = match.slPrice > 0 ? match.slPrice.toFixed(2) : "-";
      }
      if (tooltipResultRef.current) {
        const hasResult = Boolean(match.closeReason);
        tooltipResultRef.current.classList.toggle("hidden", !hasResult);
        tooltipResultRef.current.textContent = hasResult
          ? `${match.closeReason}${match.closePrice > 0 ? ` @ ${match.closePrice.toFixed(2)}` : ""}`
          : "";
        tooltipResultRef.current.className = `mt-1.5 rounded-lg px-2 py-1.5 text-[11px] font-black ${match.closeReason === "TP hit" ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}${hasResult ? "" : " hidden"}`;
      }
    }
    chart.subscribeCrosshairMove(handleCrosshairMove);

    const stopWatching = watchThemeChange((nextPalette) => {
      chart.applyOptions({
        layout: {
          background: { type: ColorType.Solid, color: nextPalette.background },
          textColor: nextPalette.text,
        },
        grid: {
          vertLines: { color: nextPalette.grid },
          horzLines: { color: nextPalette.grid },
        },
        rightPriceScale: { borderColor: nextPalette.border },
        timeScale: { borderColor: nextPalette.border },
      });
      candles.applyOptions({
        upColor: nextPalette.upColor,
        downColor: nextPalette.downColor,
        wickUpColor: nextPalette.upColor,
        wickDownColor: nextPalette.downColor,
      });
    });

    return () => {
      stopWatching();
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      positionSeriesRef.current.clear();
      positionsHoverRef.current = [];
      zoneOverlayRef.current = {};
      countdownLineRef.current = null;
    };
  }, []);

  const normalizedCandles = useMemo(
    () =>
      snapshot.candles
        .map((candle) => ({
          time: Math.floor(Number(candle.time)),
          open: Number(candle.open),
          high: Math.max(Number(candle.high), Number(candle.open), Number(candle.close)),
          low: Math.min(Number(candle.low), Number(candle.open), Number(candle.close)),
          close: Number(candle.close),
        }))
        .filter((candle) =>
          [candle.time, candle.open, candle.high, candle.low, candle.close].every(Number.isFinite) &&
          candle.time > 0 && candle.open > 0 && candle.high > 0 && candle.low > 0 && candle.close > 0,
        )
        .sort((left, right) => left.time - right.time)
        .reduce((all: CandlePoint[], candle) => {
          const previous = all[all.length - 1];
          if (previous?.time === candle.time) all[all.length - 1] = candle;
          else all.push(candle);
          return all;
        }, []),
    [snapshot.candles],
  );

  // Use the broker's actual quote timestamp as the clock anchor. Candle open
  // times are unsuitable here because the first poll can see a candle well
  // after its open and make the countdown jump by that elapsed time.
  useEffect(() => {
    const serverTime = Number(snapshot.server_time);
    if (Number.isFinite(serverTime) && serverTime > 0) {
      const measuredOffset = serverTime - Date.now() / 1000;
      brokerOffsetRef.current = brokerOffsetRef.current == null
        ? measuredOffset
        : brokerOffsetRef.current * 0.8 + measuredOffset * 0.2;
    }
  }, [snapshot.server_time]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Seconds left until the *current* timeframe's candle closes, derived from
  // the broker-time estimate above so it lines up with the server's actual
  // candle boundaries rather than this browser's clock.
  const countdownSeconds = useMemo(() => {
    if (brokerOffsetRef.current == null) return null;
    const seconds = TIMEFRAME_SECONDS[timeframe] || 60;
    const brokerNow = nowTick / 1000 + brokerOffsetRef.current;
    const intoCandle = ((brokerNow % seconds) + seconds) % seconds;
    return seconds - intoCandle;
  }, [nowTick, timeframe]);

  // Replaces the series' own last-value tag (turned off above) with one that
  // folds the countdown into the same tag: "0:41 4396.59", colored like the
  // current candle (green/red) so it reads as the same price tag, just with
  // the time-to-close prepended -- switching timeframe just changes what
  // TIMEFRAME_SECONDS[timeframe] resolves to, so the ticking number updates
  // to the new frame's boundary automatically.
  useEffect(() => {
    if (!seriesRef.current || !chartRef.current) return;
    if (countdownSeconds == null) return;
    const lastCandle = normalizedCandles[normalizedCandles.length - 1];
    const currentPrice =
      typeof snapshot.bid === "number" && typeof snapshot.ask === "number"
        ? (snapshot.bid + snapshot.ask) / 2
        : lastCandle?.close;
    if (typeof currentPrice !== "number" || !Number.isFinite(currentPrice)) return;

    const palette = getChartPalette();
    const isUp = lastCandle ? lastCandle.close >= lastCandle.open : true;
    const color = isUp ? palette.upColor : palette.downColor;
    // The price line's axis tag renders as "{title} {formatted price}" --
    // the title here is just the countdown, so the single resulting tag
    // reads e.g. "0:41 4396.59" instead of a second box next to the price.
    const title = formatCountdown(countdownSeconds);

    if (!countdownLineRef.current) {
      countdownLineRef.current = seriesRef.current.createPriceLine({
        price: currentPrice,
        color,
        lineWidth: 1,
        lineStyle: 2,
        lineVisible: false,
        axisLabelVisible: true,
        title,
      });
    } else {
      countdownLineRef.current.applyOptions({ price: currentPrice, color, title });
    }
  }, [countdownSeconds, normalizedCandles, snapshot.bid, snapshot.ask]);

  useEffect(() => {
    if (!seriesRef.current || !chartRef.current) return;
    try {
      if (chartHistoryResetRef.current || !normalizedCandlesRef.current.length) {
        seriesRef.current.setData(normalizedCandles);
        chartHistoryResetRef.current = false;
      } else if (normalizedCandles.length) {
        // lightweight-charts requires update() times to be monotonic. The
        // normalization above sorts and collapses duplicate timestamps.
        seriesRef.current.update(normalizedCandles[normalizedCandles.length - 1]);
      }
    } catch (error) {
      // A malformed broker bar must not take down the entire React page.
      // Recover the series from the sanitized snapshot and let the next quote
      // continue from there.
      try { seriesRef.current.setData(normalizedCandles); } catch { reportError(error); }
    }
    normalizedCandlesRef.current = normalizedCandles;

    // Remember every open position by ticket instead of only drawing what's
    // currently "open" -- once MT5 reports a position closed (TP/SL hit) it
    // drops out of snapshot.orders entirely, but the box should stay on the
    // chart as a record of the trade rather than vanish. Prices keep
    // refreshing from live data while still open; once closed, the last
    // known values stay frozen until the ticket is manually cleared.
    snapshot.orders.forEach((order) => {
      if (
        (String(order.status || "").toLowerCase() === "open" || order.close_reason) &&
        String(order.order_kind || "").toUpperCase() === "MARKET" &&
        Number(order.price ?? order.entry ?? 0) > 0
      ) {
        const ticket = positionIdentity(order);
        if (!ticket) return;
        const prior = rememberedPositionsRef.current.get(ticket);
        const closedAt =
          order.closed_at ||
          prior?.closed_at ||
          (order.close_reason
            ? normalizedCandles[normalizedCandles.length - 1]?.time
            : undefined);
        rememberedPositionsRef.current.set(ticket, {
          ...prior,
          ...order,
          sl: Number(order.sl) > 0 ? order.sl : prior?.sl,
          tp: Number(order.tp) > 0 ? order.tp : prior?.tp,
          closed_at: closedAt,
        });
      }
    });
    // Candles always render; only the overlays are conditional -- excluding
    // a cleared ticket here makes the cleanup loop below remove its existing
    // overlay and skips recreating it, while a ticket that wasn't on screen
    // when Clear was clicked (a new position) still draws normally.
    const firstCandleTime = normalizedCandles[0]?.time;
    const positions = Array.from(rememberedPositionsRef.current.values()).filter((order) => {
      if (clearedKeysRef.current.has(`position:${positionIdentity(order)}`)) return false;
      // The API can return closed deals from the last 30 days, while this
      // chart only contains the latest candles. Do not clamp older closed
      // trades to the first visible candle: after a reload that made their
      // TP/SL boxes look like they covered the entire chart. Open trades stay
      // visible even when they started before the current candle window.
      if (order.close_reason && firstCandleTime != null) {
        const openedAt = toUnix(order.opened_at || order.created_at);
        if (openedAt != null && openedAt < firstCandleTime) return false;
      }
      return true;
    });
    const activeTickets = new Set(
      positions.map(positionIdentity),
    );
    positionSeriesRef.current.forEach((series, ticket) => {
      if (activeTickets.has(ticket)) return;
      chartRef.current.removeSeries(series.tpZone);
      chartRef.current.removeSeries(series.slZone);
      positionSeriesRef.current.delete(ticket);
    });

    const hoverEntries: typeof positionsHoverRef.current = [];
    positions.forEach((position) => {
      const ticket = positionIdentity(position);
      const entryPrice = Number(position.price ?? position.entry ?? 0);
      const tpPrice = Number(position.tp || 0);
      const slPrice = Number(position.sl || 0);
      const lastCandleTime = normalizedCandles[normalizedCandles.length - 1]?.time;
      let startTime = nearestCandleTime(
        position.opened_at || position.created_at,
        normalizedCandles,
      );
      if (!startTime || !lastCandleTime) return;
      if (startTime === lastCandleTime && normalizedCandles.length > 1) {
        startTime = normalizedCandles[normalizedCandles.length - 2].time;
      }
      // Closed trades end at their close candle. Open trades keep extending
      // to the newest candle as live chart data arrives.
      const closedAt = position.close_reason ? nearestCandleTime(position.closed_at, normalizedCandles) : null;
      const endTime = Math.max(startTime, closedAt ?? lastCandleTime);

      const isBuy = String(position.side || "").toUpperCase() === "BUY";
      hoverEntries.push({
        ticket,
        side: isBuy ? "LONG" : "SHORT",
        lot: Number(position.lot || 0),
        entryPrice,
        tpPrice,
        slPrice,
        closeReason: String(position.close_reason || ""),
        closePrice: Number(position.close_price || 0),
        startTime,
        endTime,
      });

      let overlay = positionSeriesRef.current.get(ticket);
      if (!overlay) {
        overlay = {
          tpZone: chartRef.current.addSeries(BaselineSeries, {
            autoscaleInfoProvider: () => null,
            baseValue: { type: "price", price: entryPrice },
            topLineColor: "#16a34a",
            topFillColor1: "rgba(34, 197, 94, 0.22)",
            topFillColor2: "rgba(34, 197, 94, 0.22)",
            bottomLineColor: "#16a34a",
            bottomFillColor1: "rgba(34, 197, 94, 0.22)",
            bottomFillColor2: "rgba(34, 197, 94, 0.22)",
            lineVisible: false,
            priceLineVisible: false,
            lastValueVisible: false,
          }),
          slZone: chartRef.current.addSeries(BaselineSeries, {
            autoscaleInfoProvider: () => null,
            baseValue: { type: "price", price: entryPrice },
            topLineColor: "#e11d48",
            topFillColor1: "rgba(225, 29, 72, 0.20)",
            topFillColor2: "rgba(225, 29, 72, 0.20)",
            bottomLineColor: "#e11d48",
            bottomFillColor1: "rgba(225, 29, 72, 0.20)",
            bottomFillColor2: "rgba(225, 29, 72, 0.20)",
            lineVisible: false,
            priceLineVisible: false,
            lastValueVisible: false,
          }),
        };
        positionSeriesRef.current.set(ticket, overlay);
      }

      overlay.tpZone.applyOptions({
        baseValue: { type: "price", price: entryPrice },
      });
      overlay.slZone.applyOptions({
        baseValue: { type: "price", price: entryPrice },
      });
      const tpData =
        tpPrice > 0
          ? startTime === endTime
            ? [{ time: startTime, value: tpPrice }]
            : [
                { time: startTime, value: tpPrice },
                { time: endTime, value: tpPrice },
              ]
          : [];
      const slData =
        slPrice > 0
          ? startTime === endTime
            ? [{ time: startTime, value: slPrice }]
            : [
                { time: startTime, value: slPrice },
                { time: endTime, value: slPrice },
              ]
          : [];
      overlay.tpZone.setData(tpData);
      overlay.slZone.setData(slData);
    });
    positionsHoverRef.current = hoverEntries;
    if (chartHistoryLoadedRef.current && normalizedCandles.length && !fittedRef.current) {
      const container = containerRef.current;
      if (container?.clientWidth && container?.clientHeight) {
        chartRef.current?.timeScale().fitContent();
        fittedRef.current = true;
      }
    }
  }, [snapshot.orders, normalizedCandles, clearNonce]);

  useEffect(() => {
    if (!seriesRef.current || !chartRef.current || !normalizedCandles.length) return;
    if (!zoneOverlayRef.current) zoneOverlayRef.current = {};

    const endTime = normalizedCandles[normalizedCandles.length - 1]?.time;

    // Draw a zone as a filled, fully bordered box: a BaselineSeries gives the
    // fill plus the top edge (its own line, drawn at price_high against a
    // price_low baseline), a flat LineSeries gives the bottom edge, and a
    // zero-height CandlestickSeries (open == close, so only the wick shows)
    // gives the two vertical edges -- lightweight-charts has no native
    // "rectangle" primitive, but a doji's wick is just a vertical line at an
    // exact time/price-range, so one placed at the start time and another at
    // the end time stand in for the box's left/right sides.
    // `frozenAt` stops the box at a fixed candle. Breached zones also pass
    // `greyedOut`; a zone frozen by a successful position keeps its side color.
    function drawZoneBorder(overlay, zone, refPrefix, fillAlpha, frozenAt, greyedOut = false) {
      const fillKey = `${refPrefix}Fill`;
      const bottomKey = `${refPrefix}Bottom`;
      const edgesKey = `${refPrefix}Edges`;
      if (!zone) {
        if (overlay[fillKey]) {
          chartRef.current.removeSeries(overlay[fillKey]);
          overlay[fillKey] = null;
        }
        if (overlay[bottomKey]) {
          chartRef.current.removeSeries(overlay[bottomKey]);
          overlay[bottomKey] = null;
        }
        if (overlay[edgesKey]) {
          chartRef.current.removeSeries(overlay[edgesKey]);
          overlay[edgesKey] = null;
        }
        return;
      }
      let startTime =
        nearestCandleTime(zone.base_candle_time, normalizedCandles) ??
        normalizedCandles[0].time;
      const boxEndTime = frozenAt
        ? (nearestCandleTime(frozenAt, normalizedCandles) ?? endTime)
        : endTime;
      if (startTime === boxEndTime && normalizedCandles.length > 1) {
        startTime = normalizedCandles[normalizedCandles.length - 2].time;
      }
      // Retired zones keep a muted version of their side color, so a demand
      // breach cannot be mistaken for a supply zone (or vice versa).
      const isDemand = zone.type === "demand";
      const zoneColor = greyedOut
        ? isDemand ? "#86a99a" : "#c58a98"
        : isDemand ? "#16a34a" : "#e11d48";
      const zoneFill = greyedOut
        ? isDemand
          ? `rgba(134, 169, 154, ${fillAlpha})`
          : `rgba(197, 138, 152, ${fillAlpha})`
        : isDemand
          ? `rgba(22, 163, 74, ${fillAlpha})`
          : `rgba(225, 29, 72, ${fillAlpha})`;

      const fillOptions = {
        autoscaleInfoProvider: () => null,
        baseValue: { type: "price", price: zone.price_low },
        topLineColor: zoneColor,
        topFillColor1: zoneFill,
        topFillColor2: zoneFill,
        bottomLineColor: zoneColor,
        bottomFillColor1: "rgba(0, 0, 0, 0)",
        bottomFillColor2: "rgba(0, 0, 0, 0)",
        lineWidth: 1,
        lineVisible: true,
        priceLineVisible: false,
        lastValueVisible: false,
      };
      if (!overlay[fillKey]) {
        overlay[fillKey] = chartRef.current.addSeries(BaselineSeries, fillOptions);
      } else {
        overlay[fillKey].applyOptions(fillOptions);
      }
      overlay[fillKey].setData([
        { time: startTime, value: zone.price_high },
        { time: boxEndTime, value: zone.price_high },
      ]);

      const bottomOptions = {
        autoscaleInfoProvider: () => null,
        color: zoneColor,
        lineWidth: 1,
        lineStyle: 0,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      };
      if (!overlay[bottomKey]) {
        overlay[bottomKey] = chartRef.current.addSeries(LineSeries, bottomOptions);
      } else {
        overlay[bottomKey].applyOptions(bottomOptions);
      }
      overlay[bottomKey].setData([
        { time: startTime, value: zone.price_low },
        { time: boxEndTime, value: zone.price_low },
      ]);

      const edgeOptions = {
        autoscaleInfoProvider: () => null,
        upColor: "rgba(0, 0, 0, 0)",
        downColor: "rgba(0, 0, 0, 0)",
        borderVisible: false,
        wickUpColor: zoneColor,
        wickDownColor: zoneColor,
        wickVisible: true,
        priceLineVisible: false,
        lastValueVisible: false,
      };
      if (!overlay[edgesKey]) {
        overlay[edgesKey] = chartRef.current.addSeries(CandlestickSeries, edgeOptions);
      } else {
        overlay[edgesKey].applyOptions(edgeOptions);
      }
      const edgeCandle = (time) => ({
        time,
        open: zone.price_low,
        high: zone.price_high,
        low: zone.price_low,
        close: zone.price_low,
      });
      overlay[edgesKey].setData(
        startTime === boxEndTime
          ? [edgeCandle(startTime)]
          : [edgeCandle(startTime), edgeCandle(boxEndTime)],
      );
    }

    // The demand and supply M15 triggers watch independently, so both get
    // their own overlay set drawn at once -- a distinct trigger-line color
    // per side keeps them visually separable.
    const SIDE_TRIGGER_COLOR = { demand: "#7c3aed", supply: "#ea580c" };
    ["demand", "supply"].forEach((side) => {
      const sideStatus = zoneStatus?.[side];
      const cleared = clearedKeysRef.current;
      const placedOrder = sideStatus?.placed_order;
      const placedOrderKey = placedOrder?.ticket ?? placedOrder?.created_at;
      const frozenZoneKey = `${side}:${placedOrderKey ?? sideStatus?.started_at ?? ""}`;
      const isPlaced = sideStatus?.phase === "placed";
      if (isPlaced && endTime && !frozenZoneTimesRef.current.has(frozenZoneKey)) {
        // Prefer the broker's M1 candle timestamp captured when the order was
        // sent. The chart's latest candle is a fallback for simulated mode.
        const orderCandleTime = Number(sideStatus?.m1_zone?.position_candle_time);
        frozenZoneTimesRef.current.set(
          frozenZoneKey,
          Number.isFinite(orderCandleTime) && orderCandleTime > 0
            ? orderCandleTime
            : endTime,
        );
      }
      const zoneFrozenAt = isPlaced
        ? frozenZoneTimesRef.current.get(frozenZoneKey)
        : undefined;
      let overlay = zoneOverlayRef.current[side];
      if (!overlay) {
        overlay = {
          triggerLine: null,
          m5ZoneFill: null,
          m5ZoneBottom: null,
          m5ZoneEdges: null,
          m1ZoneFill: null,
          m1ZoneBottom: null,
          m1ZoneEdges: null,
          breachedZoneFill: null,
          breachedZoneBottom: null,
          breachedZoneEdges: null,
        };
        zoneOverlayRef.current[side] = overlay;
      }

      // The chart only ever shows XAUUSD today, same as the strategy's default.
      const symbolMatches =
        !sideStatus?.symbol || String(sideStatus.symbol).toUpperCase() === "XAUUSD";

      // The zone boxes stay drawn once the side's trade is placed (buy for
      // demand, sell for supply) too -- the M5/M1 zone that produced the
      // entry is still meaningful context while the position is open, same
      // as the entry/TP/SL themselves staying visible. Only a side that's
      // fully idle (never armed, or stopped/errored out) drops its boxes.
      const searchActive =
        symbolMatches &&
        [
          "waiting_trigger",
          "searching_m5_zone",
          "searching_m1_zone",
          "placed",
        ].includes(sideStatus?.phase);

      // The M15 trigger line only makes sense while still waiting for that
      // trigger -- once it fires (phase moves on to searching the M5/M1
      // zones), the level has already done its job, so drop the line instead
      // of leaving it drawn for the rest of the search.
      const triggerPrice = Number(sideStatus?.trigger_price || 0);
      const showTrigger =
        symbolMatches &&
        sideStatus?.phase === "waiting_trigger" &&
        triggerPrice > 0 &&
        !cleared.has(`${side}:trigger:${sideStatus?.started_at}`);
      if (showTrigger) {
        const title = `${side.toUpperCase()} M15 trigger`;
        if (!overlay.triggerLine) {
          overlay.triggerLine = seriesRef.current.createPriceLine({
            price: triggerPrice,
            color: SIDE_TRIGGER_COLOR[side],
            lineWidth: 2,
            lineStyle: 3,
            axisLabelVisible: true,
            title,
          });
        } else {
          overlay.triggerLine.applyOptions({ price: triggerPrice, title });
        }
      } else if (overlay.triggerLine) {
        seriesRef.current.removePriceLine(overlay.triggerLine);
        overlay.triggerLine = null;
      }

      // A higher-timeframe zone still means something on a lower-timeframe
      // chart (e.g. the M5 zone is still relevant while looking at M1), so
      // it stays visible there -- but a lower-timeframe zone (M1) drawn on a
      // higher-timeframe chart (M5/M15) would just be clutter relative to
      // that chart's own candle size, so it's hidden once you zoom out past
      // its own timeframe.
      const showM5Zone = TIMEFRAME_MINUTES[timeframe] <= TIMEFRAME_MINUTES.M5;
      const showM1Zone = TIMEFRAME_MINUTES[timeframe] <= TIMEFRAME_MINUTES.M1;
      const m5Zone =
        searchActive && showM5Zone && sideStatus?.m5_zone &&
        !cleared.has(`${side}:m5:${sideStatus.m5_zone.formed_at}`)
          ? sideStatus.m5_zone
          : null;
      drawZoneBorder(overlay, m5Zone, "m5Zone", 0.1, zoneFrozenAt);
      const m1Zone =
        searchActive && isPlaced && showM1Zone && sideStatus?.m1_zone &&
        !cleared.has(`${side}:m1:${sideStatus.m1_zone.formed_at}`)
          ? sideStatus.m1_zone
          : null;
      drawZoneBorder(overlay, m1Zone, "m1Zone", 0.22, zoneFrozenAt);
      // A breached M5 zone stays on the chart -- greyed out, frozen at the
      // moment it broke -- as a record of where the search moved on from,
      // instead of just disappearing. Shown regardless of the current
      // phase/searchActive so it survives even once a fresh zone is found.
      const breachedZone =
        symbolMatches && showM5Zone && sideStatus?.last_breached_m5_zone &&
        sideStatus.last_breached_m5_zone.type === side &&
        sideStatus.last_breached_m5_zone.breached_by_side === side &&
        sideStatus.last_breached_m5_zone.was_price_breached === true &&
        !cleared.has(`${side}:breached:${sideStatus.last_breached_m5_zone.breached_at}`)
          ? sideStatus.last_breached_m5_zone
          : null;
      drawZoneBorder(
        overlay,
        breachedZone,
        "breachedZone",
        0.1,
        breachedZone?.breached_at,
        true,
      );
    });
  }, [normalizedCandles, zoneStatus, timeframe, clearNonce]);

  return (
    // No surrounding Card -- the chart fills the tab directly, like an
    // embedded TradingView widget, instead of sitting inside its own boxed
    // header (which just duplicated the "Chart" tab label above it).
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={containerRef}
        className="absolute inset-0 rounded-xl border border-slate-200 bg-slate-50"
      />
      {/* Flash feedback for the Clear/Restore click -- purely cosmetic, the
          actual removal already happened synchronously via removeSeries in
          the drawing effects by the time this is visible. */}
      <div
        className={cx(
          "pointer-events-none absolute inset-0 z-20 rounded-xl bg-white transition-opacity duration-300",
          clearPulse ? "opacity-40" : "opacity-0",
        )}
      />
      {/* TradingView-style overlay toolbar, floated on the chart pane itself
          instead of a card header above it. */}
      <div className="absolute left-3 top-3 z-10 flex flex-wrap items-center gap-2">
        <span
          className={cx(
            "rounded-lg px-2.5 py-1.5 text-[10px] font-black tracking-wider shadow-sm backdrop-blur-sm",
            snapshot.source === "live"
              ? "bg-emerald-100/90 text-emerald-700"
              : "bg-amber-100/90 text-amber-700",
          )}
        >
          {snapshot.source === "live" ? "LIVE MT5" : "SIMULATED"}
        </span>
        <div className="rounded-lg border border-slate-200 bg-white/90 px-2.5 py-1.5 text-xs font-bold text-slate-700 shadow-sm backdrop-blur-sm">
          Spread {spread == null ? "-" : (spread * 10).toFixed(1)}
        </div>
        <select
          value={timeframe}
          onChange={(e) => setTimeframe(e.target.value)}
          className="rounded-lg border border-slate-200 bg-white/90 px-2.5 py-1.5 text-xs font-bold text-slate-700 shadow-sm outline-none backdrop-blur-sm focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
        >
          {["M1", "M3", "M5", "M15"].map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={clearDrawings}
          title="Clear drawings"
          className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white/90 px-2.5 py-1.5 text-xs font-bold text-slate-700 shadow-sm backdrop-blur-sm transition hover:bg-slate-50 active:scale-95"
        >
          <Eraser className="h-3.5 w-3.5" />
          Clear
        </button>
      </div>
      {/* Position tooltip -- shown while hovering over an open position's
          TP/SL zone fill, in place of permanent dashed price lines. Content
          is written directly to these nodes in handleCrosshairMove rather
          than through React state, since it needs to update on every mouse
          move without re-rendering the whole page. */}
      <div
        ref={tooltipRef}
        className="pointer-events-none absolute right-3 top-3 z-10 hidden min-w-[230px] rounded-xl border border-slate-200 bg-white/95 p-2.5 text-xs shadow-lg shadow-slate-900/10 backdrop-blur-sm"
      >
        <div className="mb-2 flex items-center justify-between gap-3">
          <div ref={tooltipTitleRef} className="text-[11px] font-black tracking-wide text-slate-700" />
          <span ref={tooltipMetaRef} className="rounded-md bg-slate-100 px-1.5 py-1 text-[10px] font-bold text-slate-500" />
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          <div className="rounded-lg bg-slate-50 px-2 py-1.5">
            <div className="text-[9px] font-bold uppercase tracking-wider text-slate-400">Entry</div>
            <div ref={tooltipOpenRef} className="mt-0.5 text-[11px] font-black tabular-nums text-slate-800" />
          </div>
          <div ref={tooltipTpRowRef} className="rounded-lg bg-slate-50 px-2 py-1.5">
            <div className="text-[9px] font-bold uppercase tracking-wider text-slate-400">TP</div>
            <div ref={tooltipTpRef} className="mt-0.5 text-[11px] font-black tabular-nums text-emerald-700" />
          </div>
          <div ref={tooltipSlRowRef} className="rounded-lg bg-slate-50 px-2 py-1.5">
            <div className="text-[9px] font-bold uppercase tracking-wider text-slate-400">SL</div>
            <div ref={tooltipSlRef} className="mt-0.5 text-[11px] font-black tabular-nums text-rose-700" />
          </div>
        </div>
        <div ref={tooltipResultRef} className="mt-1.5 hidden rounded-lg px-2 py-1.5 text-[11px] font-black" />
      </div>
      {!snapshot.candles.length && !loading ? (
        <div className="absolute inset-0 flex items-center justify-center rounded-xl border border-dashed border-slate-200 bg-white/60 backdrop-blur-[1px]">
          <p className="text-sm font-semibold text-slate-500">
            No candle data loaded yet.
          </p>
        </div>
      ) : null}
    </div>
  );
}

export default function ChartPage() {
  return (
    <ChartErrorBoundary>
      <ChartPageView />
    </ChartErrorBoundary>
  );
}
