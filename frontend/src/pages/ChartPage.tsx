import React, { useEffect, useMemo, useRef, useState } from "react";
import { RefreshCcw } from "lucide-react";
import {
  BaselineSeries,
  CandlestickSeries,
  ColorType,
  LineSeries,
  createChart,
} from "lightweight-charts";
import { api } from "../services/api";
import { AppButton, Card } from "../components/ui/Primitives";
import { cx } from "../utils/format";

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
  const zoneOverlayRef = useRef<{
    triggerLine: any;
    zoneBand: any;
    entryLine: any;
    slLine: any;
    tpLine: any;
  } | null>(null);
  const fittedRef = useRef(false);
  const [timeframe, setTimeframe] = useState("M1");
  const [snapshot, setSnapshot] = useState<ChartSnapshot>({
    candles: [],
    orders: [],
  });
  const [zoneStatus, setZoneStatus] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [errorText, setErrorText] = useState("");
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
      setErrorText("");
    } catch (error) {
      setErrorText(String(error?.message || error));
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
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#f8fafc" },
        textColor: "#334155",
      },
      grid: {
        vertLines: { color: "#e2e8f0" },
        horzLines: { color: "#e2e8f0" },
      },
      crosshair: { mode: 0 },
      rightPriceScale: { borderColor: "#cbd5e1" },
      timeScale: {
        borderColor: "#cbd5e1",
        timeVisible: true,
        secondsVisible: false,
      },
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: "#059669",
      downColor: "#e11d48",
      borderVisible: false,
      wickUpColor: "#059669",
      wickDownColor: "#e11d48",
    });
    chartRef.current = chart;
    seriesRef.current = candles;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      positionSeriesRef.current.clear();
      zoneOverlayRef.current = null;
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

  useEffect(() => {
    if (!seriesRef.current || !chartRef.current) return;
    seriesRef.current.setData(normalizedCandles);

    const positions = snapshot.orders.filter(
      (order) =>
        String(order.status || "").toLowerCase() === "open" &&
        String(order.order_kind || "").toUpperCase() === "MARKET" &&
        Number(order.price ?? order.entry ?? 0) > 0,
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
  }, [snapshot.orders, normalizedCandles]);

  useEffect(() => {
    if (!seriesRef.current || !chartRef.current || !normalizedCandles.length) return;
    let overlay = zoneOverlayRef.current;
    if (!overlay) {
      overlay = {
        triggerLine: null,
        m5ZoneBand: null,
        m1ZoneBand: null,
        entryLine: null,
        slLine: null,
        tpLine: null,
      };
      zoneOverlayRef.current = overlay;
    }

    const endTime = normalizedCandles[normalizedCandles.length - 1]?.time;
    // The chart only ever shows XAUUSD today, same as the strategy's default.
    const symbolMatches =
      !zoneStatus?.symbol ||
      String(zoneStatus.symbol).toUpperCase() === "XAUUSD";

    const triggerPrice = Number(zoneStatus?.trigger_price || 0);
    const showTrigger =
      symbolMatches &&
      triggerPrice > 0 &&
      ["waiting_trigger", "searching_m5_zone", "searching_m1_zone"].includes(
        zoneStatus?.phase,
      );
    if (showTrigger) {
      const title = `${String(zoneStatus.trigger_zone_type || "").toUpperCase()} trigger`;
      if (!overlay.triggerLine) {
        overlay.triggerLine = seriesRef.current.createPriceLine({
          price: triggerPrice,
          color: "#7c3aed",
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

    // Draw a zone rectangle as a BaselineSeries band running from the zone's
    // own base candle to the latest candle -- same trick used for the TP/SL
    // shading around an open position, just anchored to the zone's own edges.
    function drawZoneBand(zone, refKey, label, fillAlpha) {
      if (!zone) {
        if (overlay[refKey]) {
          chartRef.current.removeSeries(overlay[refKey]);
          overlay[refKey] = null;
        }
        return;
      }
      let startTime =
        nearestCandleTime(zone.base_candle_time, normalizedCandles) ??
        normalizedCandles[0].time;
      if (startTime === endTime && normalizedCandles.length > 1) {
        startTime = normalizedCandles[normalizedCandles.length - 2].time;
      }
      const zoneColor = zone.type === "demand" ? "#16a34a" : "#e11d48";
      const zoneFill =
        zone.type === "demand"
          ? `rgba(22, 163, 74, ${fillAlpha})`
          : `rgba(225, 29, 72, ${fillAlpha})`;
      const title = `${zone.type.toUpperCase()} ${label}`;
      if (!overlay[refKey]) {
        overlay[refKey] = chartRef.current.addSeries(BaselineSeries, {
          baseValue: { type: "price", price: zone.price_low },
          topLineColor: zoneColor,
          topFillColor1: zoneFill,
          topFillColor2: zoneFill,
          bottomLineColor: zoneColor,
          bottomFillColor1: "rgba(0, 0, 0, 0)",
          bottomFillColor2: "rgba(0, 0, 0, 0)",
          lineVisible: false,
          priceLineVisible: false,
          lastValueVisible: false,
          title,
        });
      } else {
        overlay[refKey].applyOptions({
          baseValue: { type: "price", price: zone.price_low },
          topLineColor: zoneColor,
          topFillColor1: zoneFill,
          topFillColor2: zoneFill,
          bottomLineColor: zoneColor,
          title,
        });
      }
      overlay[refKey].setData([
        { time: startTime, value: zone.price_high },
        { time: endTime, value: zone.price_high },
      ]);
    }

    // The M5 zone is the intermediate trigger for the M1 search -- shade it
    // lighter than the M1 zone, which is the one the order actually opens
    // from.
    drawZoneBand(
      symbolMatches ? zoneStatus?.m5_zone : null,
      "m5ZoneBand",
      "M5 zone",
      0.1,
    );
    drawZoneBand(
      symbolMatches ? zoneStatus?.m1_zone : null,
      "m1ZoneBand",
      "M1 zone",
      0.22,
    );

    const order = symbolMatches ? zoneStatus?.placed_order : null;
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
          title: `Scalp entry #${order.ticket ?? ""}`,
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
          title: "Scalp SL",
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
          title: "Scalp TP",
        });
      } else {
        overlay.tpLine.applyOptions({ price: tpPrice });
      }
    } else if (overlay.tpLine) {
      seriesRef.current.removePriceLine(overlay.tpLine);
      overlay.tpLine = null;
    }
  }, [normalizedCandles, zoneStatus]);

  async function refreshChart() {
    setRefreshing(true);
    try {
      await loadChart(true);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {errorText ? (
        <div className="shrink-0 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-700">
          {errorText}
        </div>
      ) : null}

      <Card className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-black text-slate-950">
                Live Order Chart
              </h3>
              <span
                className={cx(
                  "rounded-full px-2.5 py-1 text-[10px] font-black tracking-wider",
                  snapshot.source === "live"
                    ? "bg-emerald-100 text-emerald-700"
                    : "bg-amber-100 text-amber-700",
                )}
              >
                {snapshot.source === "live" ? "LIVE MT5" : "SIMULATED"}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-bold text-slate-700">
              Spread {spread == null ? "-" : (spread * 10).toFixed(1)}
            </div>
            <select
              value={timeframe}
              onChange={(e) => setTimeframe(e.target.value)}
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-bold text-slate-700 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            >
              {["M1", "M3", "M5", "M15"].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            <AppButton
              variant="soft"
              onClick={refreshChart}
              disabled={refreshing || loading}
            >
              <RefreshCcw
                className={cx(
                  "h-4 w-4",
                  (refreshing || loading) && "animate-spin",
                )}
              />
              {loading
                ? "Loading..."
                : refreshing
                  ? "Refreshing..."
                  : "Refresh"}
            </AppButton>
          </div>
        </div>
        <div className="relative mt-4 min-h-0 flex-1">
          <div
            ref={containerRef}
            className="absolute inset-0 rounded-3xl border border-slate-200 bg-slate-50"
          />
          {!snapshot.candles.length && !loading ? (
            <div className="absolute inset-0 flex items-center justify-center rounded-3xl border border-dashed border-slate-200 bg-white/60 backdrop-blur-[1px]">
              <p className="text-sm font-semibold text-slate-500">
                No candle data loaded yet.
              </p>
            </div>
          ) : null}
        </div>
        <p className="mt-3 shrink-0 text-xs font-semibold text-slate-500">
          {snapshot.updated_at
            ? `Updated ${new Date(snapshot.updated_at).toLocaleString()}`
            : "Waiting for chart data..."}
        </p>
      </Card>
    </div>
  );
}
