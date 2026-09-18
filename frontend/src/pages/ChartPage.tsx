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
};

type ChartSnapshot = {
  candles: CandlePoint[];
  orders: TradeOrder[];
  source?: "live" | "simulated";
  bid?: number | null;
  ask?: number | null;
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

export default function ChartPage() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<any>(null);
  const seriesRef = useRef<any>(null);
  const positionSeriesRef = useRef<
    Map<
      string,
      {
        entry: any;
        tpZone: any;
        slZone: any;
        tpPriceLine: any;
        slPriceLine: any;
      }
    >
  >(new Map());
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
        entryLine: any;
        slLine: any;
        tpLine: any;
      }
    >
  >({});
  const fittedRef = useRef(false);
  // Broker (MT5) time vs. this browser's clock, so the per-timeframe
  // countdowns line up with when candles actually close on the server
  // rather than the client's clock -- captured from the currently-forming
  // candle's open time each time a new one appears, and reused for every
  // timeframe's countdown (the offset between the two clocks is the same
  // regardless of which timeframe is selected).
  const brokerOffsetRef = useRef<number | null>(null);
  const lastAnchorCandleTimeRef = useRef<number | null>(null);
  const countdownLineRef = useRef<any>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [timeframe, setTimeframe] = useState("M1");
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
      if (sideStatus.placed_order) keys.add(`${side}:order:${sideStatus.placed_order.ticket}`);
    });
    (snapshot.orders || []).forEach((order) => {
      if (order.ticket != null) keys.add(`position:${order.ticket}`);
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
    if (!silent) setLoading(true);
    try {
      const data = await api.chartData({
        symbol: "XAUUSD",
        timeframe,
        count: 180,
      });
      setSnapshot({
        candles: Array.isArray(data?.candles) ? data.candles : [],
        orders: Array.isArray(data?.orders) ? data.orders : [],
        source: data?.source,
        bid: data?.bid,
        ask: data?.ask,
        updated_at: data?.updated_at,
      });
      clearBanner();
    } catch (error) {
      reportError(error);
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useEffect(() => {
    fittedRef.current = false;
    loadChart();
    const timer = window.setInterval(() => loadChart(true), 2000);
    return () => window.clearInterval(timer);
  }, [timeframe]);

  useEffect(() => {
    let cancelled = false;
    async function pollZoneStrategy() {
      try {
        const result = await api.zoneStrategyStatus();
        if (!cancelled) setZoneStatus(result?.zone_strategy || null);
      } catch {
        // transient network errors are fine to skip silently on a poll loop
      }
    }
    pollZoneStrategy();
    const timer = window.setInterval(pollZoneStrategy, 2000);
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
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      positionSeriesRef.current.clear();
      zoneOverlayRef.current = {};
      countdownLineRef.current = null;
    };
  }, []);

  const normalizedCandles = useMemo(
    () =>
      snapshot.candles
        .map((candle) => ({
          time: Number(candle.time),
          open: Number(candle.open),
          high: Number(candle.high),
          low: Number(candle.low),
          close: Number(candle.close),
        }))
        .filter((candle) =>
          [candle.time, candle.open, candle.high, candle.low, candle.close].every(
            Number.isFinite,
          ),
        )
        .sort((left, right) => left.time - right.time)
        .filter(
          (candle, index, all) =>
            index === 0 || candle.time !== all[index - 1].time,
        ),
    [snapshot.candles],
  );

  // Recalibrate the broker/client clock offset whenever a fresh candle opens
  // (its time changes from the last one we saw) -- the currently-forming
  // candle's open time is always an exact multiple of that timeframe's
  // length in broker time, so it's a reliable anchor.
  useEffect(() => {
    const formingCandle = normalizedCandles[normalizedCandles.length - 1];
    if (!formingCandle) return;
    if (lastAnchorCandleTimeRef.current !== formingCandle.time) {
      lastAnchorCandleTimeRef.current = formingCandle.time;
      brokerOffsetRef.current = formingCandle.time - Date.now() / 1000;
    }
  }, [normalizedCandles]);

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
    seriesRef.current.setData(normalizedCandles);

    // Candles always render; only the overlays are conditional -- excluding
    // a cleared ticket here makes the cleanup loop below remove its existing
    // overlay and skips recreating it, while a ticket that wasn't on screen
    // when Clear was clicked (a new position) still draws normally.
    const positions = snapshot.orders.filter(
      (order) =>
        String(order.status || "").toLowerCase() === "open" &&
        String(order.order_kind || "").toUpperCase() === "MARKET" &&
        Number(order.price ?? order.entry ?? 0) > 0 &&
        !clearedKeysRef.current.has(`position:${order.ticket}`),
    );
    const activeTickets = new Set(
      positions.map((position) => String(position.ticket)),
    );
    positionSeriesRef.current.forEach((series, ticket) => {
      if (activeTickets.has(ticket)) return;
      chartRef.current.removeSeries(series.entry);
      chartRef.current.removeSeries(series.tpZone);
      chartRef.current.removeSeries(series.slZone);
      if (series.tpPriceLine)
        seriesRef.current.removePriceLine(series.tpPriceLine);
      if (series.slPriceLine)
        seriesRef.current.removePriceLine(series.slPriceLine);
      positionSeriesRef.current.delete(ticket);
    });

    positions.forEach((position) => {
      const ticket = String(position.ticket);
      const entryPrice = Number(position.price ?? position.entry ?? 0);
      const tpPrice = Number(position.tp || 0);
      const slPrice = Number(position.sl || 0);
      const endTime = normalizedCandles[normalizedCandles.length - 1]?.time;
      let startTime = nearestCandleTime(
        position.opened_at || position.created_at,
        normalizedCandles,
      );
      if (!startTime || !endTime) return;
      if (startTime === endTime && normalizedCandles.length > 1) {
        startTime = normalizedCandles[normalizedCandles.length - 2].time;
      }

      let overlay = positionSeriesRef.current.get(ticket);
      if (!overlay) {
        const isBuy = String(position.side || "").toUpperCase() === "BUY";
        overlay = {
          entry: chartRef.current.addSeries(LineSeries, {
            color: isBuy ? "#047857" : "#be123c",
            lineWidth: 2,
            lineStyle: 2,
            priceLineVisible: false,
            lastValueVisible: true,
            title: `${isBuy ? "LONG" : "SHORT"} ${Number(position.lot || 0).toFixed(2)}`,
          }),
          tpZone: chartRef.current.addSeries(BaselineSeries, {
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
          tpPriceLine: null,
          slPriceLine: null,
        };
        positionSeriesRef.current.set(ticket, overlay);
      }

      overlay.entry.setData([
        { time: startTime, value: entryPrice },
        { time: endTime, value: entryPrice },
      ]);
      overlay.tpZone.applyOptions({
        baseValue: { type: "price", price: entryPrice },
      });
      overlay.slZone.applyOptions({
        baseValue: { type: "price", price: entryPrice },
      });
      const tpData =
        tpPrice > 0
          ? [
              { time: startTime, value: tpPrice },
              { time: endTime, value: tpPrice },
            ]
          : [];
      const slData =
        slPrice > 0
          ? [
              { time: startTime, value: slPrice },
              { time: endTime, value: slPrice },
            ]
          : [];
      overlay.tpZone.setData(tpData);
      overlay.slZone.setData(slData);
      if (tpPrice > 0) {
        if (!overlay.tpPriceLine) {
          overlay.tpPriceLine = seriesRef.current.createPriceLine({
            price: tpPrice,
            color: "#16a34a",
            lineWidth: 2,
            lineStyle: 2,
            axisLabelVisible: true,
            title: `TP #${ticket}`,
          });
        } else {
          overlay.tpPriceLine.applyOptions({ price: tpPrice });
        }
      } else if (overlay.tpPriceLine) {
        seriesRef.current.removePriceLine(overlay.tpPriceLine);
        overlay.tpPriceLine = null;
      }
      if (slPrice > 0) {
        if (!overlay.slPriceLine) {
          overlay.slPriceLine = seriesRef.current.createPriceLine({
            price: slPrice,
            color: "#e11d48",
            lineWidth: 2,
            lineStyle: 2,
            axisLabelVisible: true,
            title: `SL #${ticket}`,
          });
        } else {
          overlay.slPriceLine.applyOptions({ price: slPrice });
        }
      } else if (overlay.slPriceLine) {
        seriesRef.current.removePriceLine(overlay.slPriceLine);
        overlay.slPriceLine = null;
      }
    });
    if (normalizedCandles.length && !fittedRef.current) {
      chartRef.current?.timeScale().fitContent();
      fittedRef.current = true;
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
    // `frozenAt` marks a zone as no longer live (breached): drawn grey
    // instead of green/red, and its box stops at the breach time instead of
    // stretching to the latest candle like an active search's zone does.
    function drawZoneBorder(overlay, zone, refPrefix, fillAlpha, frozenAt) {
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
      const zoneColor = frozenAt
        ? "#94a3b8"
        : zone.type === "demand"
          ? "#16a34a"
          : "#e11d48";
      const zoneFill = frozenAt
        ? `rgba(148, 163, 184, ${fillAlpha})`
        : zone.type === "demand"
          ? `rgba(22, 163, 74, ${fillAlpha})`
          : `rgba(225, 29, 72, ${fillAlpha})`;

      const fillOptions = {
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
          entryLine: null,
          slLine: null,
          tpLine: null,
        };
        zoneOverlayRef.current[side] = overlay;
      }

      // The chart only ever shows XAUUSD today, same as the strategy's default.
      const symbolMatches =
        !sideStatus?.symbol || String(sideStatus.symbol).toUpperCase() === "XAUUSD";

      // Once the side's trade is placed (buy for demand, sell for supply),
      // stop drawing its zone boxes/trigger line -- the position is open, so
      // there's nothing left to search for.
      const searchActive =
        symbolMatches &&
        ["waiting_trigger", "searching_m5_zone", "searching_m1_zone"].includes(
          sideStatus?.phase,
        );

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
      drawZoneBorder(overlay, m5Zone, "m5Zone", 0.1);
      const m1Zone =
        searchActive && showM1Zone && sideStatus?.m1_zone &&
        !cleared.has(`${side}:m1:${sideStatus.m1_zone.formed_at}`)
          ? sideStatus.m1_zone
          : null;
      drawZoneBorder(overlay, m1Zone, "m1Zone", 0.22);
      // A breached M5 zone stays on the chart -- greyed out, frozen at the
      // moment it broke -- as a record of where the search moved on from,
      // instead of just disappearing. Shown regardless of the current
      // phase/searchActive so it survives even once a fresh zone is found.
      const breachedZone =
        symbolMatches && showM5Zone && sideStatus?.last_breached_m5_zone &&
        !cleared.has(`${side}:breached:${sideStatus.last_breached_m5_zone.breached_at}`)
          ? sideStatus.last_breached_m5_zone
          : null;
      drawZoneBorder(
        overlay,
        breachedZone,
        "breachedZone",
        0.1,
        breachedZone?.breached_at,
      );

      const order =
        symbolMatches && sideStatus?.placed_order &&
        !cleared.has(`${side}:order:${sideStatus.placed_order.ticket}`)
          ? sideStatus.placed_order
          : null;
      const entryPrice = Number(order?.entry || 0);
      const slPrice = Number(order?.sl || 0);
      const tpPrice = Number(order?.tp || 0);

      if (order && entryPrice > 0) {
        if (!overlay.entryLine) {
          overlay.entryLine = seriesRef.current.createPriceLine({
            price: entryPrice,
            color: "#2563eb",
            lineWidth: 2,
            lineStyle: 0,
            axisLabelVisible: true,
            title: `${side} scalp entry #${order.ticket ?? ""}`,
          });
        } else {
          overlay.entryLine.applyOptions({ price: entryPrice });
        }
      } else if (overlay.entryLine) {
        seriesRef.current.removePriceLine(overlay.entryLine);
        overlay.entryLine = null;
      }

      if (order && slPrice > 0) {
        if (!overlay.slLine) {
          overlay.slLine = seriesRef.current.createPriceLine({
            price: slPrice,
            color: "#e11d48",
            lineWidth: 2,
            lineStyle: 2,
            axisLabelVisible: true,
            title: `${side} scalp SL`,
          });
        } else {
          overlay.slLine.applyOptions({ price: slPrice });
        }
      } else if (overlay.slLine) {
        seriesRef.current.removePriceLine(overlay.slLine);
        overlay.slLine = null;
      }

      if (order && tpPrice > 0) {
        if (!overlay.tpLine) {
          overlay.tpLine = seriesRef.current.createPriceLine({
            price: tpPrice,
            color: "#16a34a",
            lineWidth: 2,
            lineStyle: 2,
            axisLabelVisible: true,
            title: `${side} scalp TP`,
          });
        } else {
          overlay.tpLine.applyOptions({ price: tpPrice });
        }
      } else if (overlay.tpLine) {
        seriesRef.current.removePriceLine(overlay.tpLine);
        overlay.tpLine = null;
      }
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
