import React, { useEffect, useRef, useState } from "react";
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
  const fittedRef = useRef(false);
  const [timeframe, setTimeframe] = useState("M1");
  const [snapshot, setSnapshot] = useState<ChartSnapshot>({
    candles: [],
    orders: [],
  });
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
    };
  }, []);

  useEffect(() => {
    if (!seriesRef.current || !chartRef.current) return;
    const normalizedCandles = snapshot.candles
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
      );
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
  }, [snapshot]);

  async function refreshChart() {
    setRefreshing(true);
    try {
      await loadChart(true);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="space-y-4">
      {errorText ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-700">
          {errorText}
        </div>
      ) : null}

      <Card className="min-h-[680px]">
        <div className="flex flex-wrap items-center justify-between gap-3">
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
            <p className="text-sm text-slate-500">
              Candles update every two seconds. Activated positions show entry,
              TP, and SL levels.
            </p>
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
        <div
          ref={containerRef}
          className="mt-4 h-[580px] w-full rounded-3xl border border-slate-200 bg-slate-50"
        />
        {!snapshot.candles.length && !loading ? (
          <div className="mt-[-580px] flex h-[580px] items-center justify-center rounded-3xl border border-dashed border-slate-200 bg-white/60 backdrop-blur-[1px]">
            <p className="text-sm font-semibold text-slate-500">
              No candle data loaded yet.
            </p>
          </div>
        ) : null}
        <p className="mt-3 text-xs font-semibold text-slate-500">
          {snapshot.updated_at
            ? `Updated ${new Date(snapshot.updated_at).toLocaleString()}`
            : "Waiting for chart data..."}
        </p>
      </Card>
    </div>
  );
}
