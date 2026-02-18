
import { useEffect, useMemo, useRef } from "react";
import {
  createChart,
  IChartApi,
  CandlestickData,
  CrosshairMode,
  Time,
  SeriesMarker,
  LineStyle,
  IPriceLine,
} from "lightweight-charts";
import axios from "axios";
import { ChartTimeframe, useTradingStore } from "../store/tradingStore";

type Candle = CandlestickData<Time>;
type TF = ChartTimeframe;

const CHART_ENDPOINT = "http://localhost:8000/api/chart/";

function tfToSeconds(tf: TF) {
  switch (tf) {
    case "M1":
      return 60;
    case "M5":
      return 300;
    case "M15":
      return 900;
    case "H1":
      return 3600;
  }
}

function normalizeSide(v: any): "BUY" | "SELL" | null {
  const s = String(v ?? "")
    .toUpperCase()
    .trim();
  if (s === "BUY") return "BUY";
  if (s === "SELL") return "SELL";
  if (s === "0") return "BUY";
  if (s === "1") return "SELL";
  return null;
}

function normalizeTimeToSeconds(t: any): number {
  const n = Number(t);
  if (!Number.isFinite(n)) return NaN;
  return n > 1e12 ? Math.floor(n / 1000) : n;
}

export default function ChartPanel() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<any>(null);
  const lastCandleRef = useRef<Candle | null>(null);

  // lookup deal by aligned candle time
  const historyDealByCandleTimeRef = useRef<Map<number, any>>(new Map());

  // ✅ liquidity price lines (id -> IPriceLine)
  const liqLinesRef = useRef<Map<string, IPriceLine>>(new Map());

  const timeframe = useTradingStore((s) => s.chartTimeframe);
  const setTimeframe = useTradingStore((s) => s.setChartTimeframe);
  const timeframeSeconds = useMemo(() => tfToSeconds(timeframe), [timeframe]);

  const bid = useTradingStore((s) => s.bid);
  const tickTime = useTradingStore((s) => (s as any).tickTime);
  const history = useTradingStore((s) => s.history) as any[];
  const positions = useTradingStore((s) => s.positions) as any[];
  const liquidity = useTradingStore((s) => s.liquidity) as any[];




  // ===========================
  // CHART INIT + TOOLTIP
  // ===========================
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: { timeVisible: true },
    });

    chartRef.current = chart;

    const candleSeries = chart.addCandlestickSeries({
      upColor: "#1ca175",
      downColor: "#ef4444",
      borderUpColor: "#1ca175",
      borderDownColor: "#ef4444",
      wickUpColor: "#1ca175",
      wickDownColor: "#ef4444",
    });
    candleSeriesRef.current = candleSeries;

    // ---- OHLC tooltip (candle)
    const ohlcTip = document.createElement("div");
    ohlcTip.style.position = "absolute";
    ohlcTip.style.zIndex = "10";
    ohlcTip.style.top = "8px";
    ohlcTip.style.left = "8px";
    ohlcTip.style.padding = "6px 8px";
    ohlcTip.style.borderRadius = "6px";
    ohlcTip.style.fontSize = "12px";
    ohlcTip.style.background = "rgba(15, 23, 42, 0.85)";
    ohlcTip.style.color = "white";
    ohlcTip.style.pointerEvents = "none";
    ohlcTip.style.display = "none";

    // ---- Deal tooltip (marker)
    const dealTip = document.createElement("div");
    dealTip.style.position = "absolute";
    dealTip.style.zIndex = "11";
    dealTip.style.top = "8px";
    dealTip.style.left = "8px";
    dealTip.style.padding = "6px 8px";
    dealTip.style.borderRadius = "6px";
    dealTip.style.fontSize = "12px";
    dealTip.style.background = "rgba(2, 6, 23, 0.92)";
    dealTip.style.color = "white";
    dealTip.style.pointerEvents = "none";
    dealTip.style.display = "none";
    dealTip.style.whiteSpace = "nowrap";

    // container must be relative for absolute tooltips
    containerRef.current.style.position = "relative";
    containerRef.current.appendChild(ohlcTip);
    containerRef.current.appendChild(dealTip);

    const onMove = (param: any) => {
      if (!param?.time || !param?.point) {
        ohlcTip.style.display = "none";
        dealTip.style.display = "none";
        return;
      }

      const series = candleSeriesRef.current;
      const chartApi = chartRef.current;
      if (!series || !chartApi) return;

      const candle = param.seriesData.get(series) as Candle | undefined;
      if (!candle) {
        ohlcTip.style.display = "none";
        dealTip.style.display = "none";
        return;
      }

      // ✅ always show OHLC
      ohlcTip.style.display = "block";
      ohlcTip.style.left = "8px";
      ohlcTip.style.top = "8px";
      ohlcTip.innerHTML =
        `O: ${candle.open.toFixed(2)}  ` +
        `H: ${candle.high.toFixed(2)}  ` +
        `L: ${candle.low.toFixed(2)}  ` +
        `C: ${candle.close.toFixed(2)}`;

      const mouseX = Number(param.point.x);
      const mouseY = Number(param.point.y);

      // ✅ align lookup to candle bucket (same as applyMarkers)
      const tAligned =
        Math.floor(Number(param.time) / timeframeSeconds) * timeframeSeconds;

      const deal = historyDealByCandleTimeRef.current.get(tAligned);
      if (!deal) {
        dealTip.style.display = "none";
        return;
      }

      const side = normalizeSide(
        deal?.__side ?? deal?.type ?? deal?.side ?? deal?.cmd,
      );
      if (!side) {
        dealTip.style.display = "none";
        return;
      }

      const timeX = chartApi.timeScale().timeToCoordinate(param.time);
      const highY = series.priceToCoordinate(candle.high);
      const lowY = series.priceToCoordinate(candle.low);

      if (
        !Number.isFinite(timeX) ||
        !Number.isFinite(highY) ||
        !Number.isFinite(lowY)
      ) {
        dealTip.style.display = "none";
        return;
      }

      const nearSameCandleX = Math.abs(mouseX - (timeX as number)) <= 35;

      const inSellZone = mouseY <= (highY as number) + 40;
      const inBuyZone = mouseY >= (lowY as number) - 40;

      const showDeal =
        nearSameCandleX &&
        ((side === "SELL" && inSellZone) || (side === "BUY" && inBuyZone));

      if (!showDeal) {
        dealTip.style.display = "none";
        return;
      }

      dealTip.style.display = "block";
      dealTip.style.left = `${Math.max(8, mouseX + 12)}px`;
      dealTip.style.top = `${Math.max(8, mouseY + 12)}px`;

      const closePrice = Number(deal.price ?? deal.close_price ?? candle.close);
      const pnl = Number(deal.profit ?? 0);

      dealTip.innerHTML =
        `DEAL: ${side}` +
        ` | CLOSE: ${Number.isFinite(closePrice) ? closePrice.toFixed(2) : "--"}` +
        ` | PnL: ${Number.isFinite(pnl) ? pnl.toFixed(2) : "--"}`;
    };

    chart.subscribeCrosshairMove(onMove);

    const resize = () => {
      if (!containerRef.current) return;
      chart.applyOptions({
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight,
      });
    };
    window.addEventListener("resize", resize);

    return () => {
      window.removeEventListener("resize", resize);
      chart.unsubscribeCrosshairMove(onMove);
      ohlcTip.remove();
      dealTip.remove();

      // ✅ cleanup liquidity lines
      try {
        const series = candleSeriesRef.current;
        if (series) {
          for (const line of liqLinesRef.current.values()) {
            series.removePriceLine(line);
          }
        }
      } catch {}
      liqLinesRef.current.clear();

      chart.remove();
    };
  }, [timeframeSeconds]);

  // ===========================
  // LOAD CANDLES ON TF CHANGE
  // ===========================
  useEffect(() => {
    loadInitialCandles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeframe]);

  async function loadInitialCandles() {
    if (!candleSeriesRef.current) return;

    lastCandleRef.current = null;
    candleSeriesRef.current.setData([]);
    syncLiquidityLines(liquidity);


    const res = await axios.get(`${CHART_ENDPOINT}?timeframe=${timeframe}`);

    const candles: Candle[] = (res.data.candles ?? [])
      .map((c: any) => ({
        time: Number(c.time) as Time,
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
      }))
      .filter((c: any) => Number.isFinite(c.time))
      .sort((a, b) => Number(a.time) - Number(b.time));

    candleSeriesRef.current.setData(candles);
    lastCandleRef.current = candles[candles.length - 1] ?? null;
    chartRef.current?.timeScale().fitContent();

    applyMarkers(history, positions, timeframeSeconds);
    syncLiquidityLines(liquidity); // ✅ ensure lines exist after reload
  }

  // ===========================
  // LIVE TICK UPDATE
  // ===========================
  useEffect(() => {
    if (!Number.isFinite(Number(bid)) || !Number.isFinite(Number(tickTime)))
      return;
    updateCandle(Number(bid), Number(tickTime), timeframeSeconds);
  }, [bid, tickTime, timeframeSeconds]);

  function updateCandle(price: number, tickTimeSec: number, tfSeconds: number) {
    if (!candleSeriesRef.current) return;

    const candleTime = Math.floor(tickTimeSec / tfSeconds) * tfSeconds;

    if (!lastCandleRef.current) {
      const newCandle: Candle = {
        time: candleTime as Time,
        open: price,
        high: price,
        low: price,
        close: price,
      };
      lastCandleRef.current = newCandle;
      candleSeriesRef.current.update(newCandle);
      return;
    }

    const lastTime = Number(lastCandleRef.current.time);

    if (candleTime === lastTime) {
      const updated: Candle = {
        time: candleTime as Time,
        open: lastCandleRef.current.open,
        high: Math.max(lastCandleRef.current.high, price),
        low: Math.min(lastCandleRef.current.low, price),
        close: price,
      };
      lastCandleRef.current = updated;
      candleSeriesRef.current.update(updated);
    } else if (candleTime > lastTime) {
      const newCandle: Candle = {
        time: candleTime as Time,
        open: price,
        high: price,
        low: price,
        close: price,
      };
      lastCandleRef.current = newCandle;
      candleSeriesRef.current.update(newCandle);
    }
  }

  // ===========================
  // MARKERS: HISTORY + OPEN POSITIONS
  // ===========================
  useEffect(() => {
    applyMarkers(history, positions, timeframeSeconds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, positions, timeframeSeconds]);

  function applyMarkers(
    historyDeals: any[],
    openPositions: any[],
    tfSeconds: number,
  ) {
    const series = candleSeriesRef.current;
    if (!series) return;

    const historyMap = new Map<number, any>();

    const historyMarkers: SeriesMarker<Time>[] = (historyDeals ?? [])
      .map((d) => {
        const side = normalizeSide(d?.type ?? d?.side ?? d?.cmd);
        if (!side) return null;

        const raw = normalizeTimeToSeconds(
          d?.time ?? d?.close_time ?? d?.closeTime,
        );
        if (!Number.isFinite(raw)) return null;

        const t = Math.floor(raw / tfSeconds) * tfSeconds;

        historyMap.set(t, { ...d, __side: side });

        const isBuy = side === "BUY";
        return {
          time: t as Time,
          position: isBuy ? "belowBar" : "aboveBar",
          shape: isBuy ? "arrowUp" : "arrowDown",
          color: isBuy ? "#1da04d" : "#ce3e3e",
          text: side,
        } as SeriesMarker<Time>;
      })
      .filter(Boolean) as SeriesMarker<Time>[];

    historyDealByCandleTimeRef.current = historyMap;

    const openMarkers: SeriesMarker<Time>[] = (openPositions ?? [])
      .map((p) => {
        const side = normalizeSide(p?.type);
        if (!side) return null;

        const raw = normalizeTimeToSeconds(p?.time_open);
        if (!Number.isFinite(raw)) return null;

        const t = Math.floor(raw / tfSeconds) * tfSeconds;
        const isBuy = side === "BUY";

        return {
          time: t as Time,
          position: isBuy ? "belowBar" : "aboveBar",
          shape: "circle",
          color: isBuy ? "#1da04d" : "#ce3e3e",
          text: `OPEN ${side}`,
        } as SeriesMarker<Time>;
      })
      .filter(Boolean) as SeriesMarker<Time>[];

    const merged = [...historyMarkers, ...openMarkers].sort(
      (a, b) => Number(a.time) - Number(b.time),
    );

    const seen = new Set<string>();
    const deduped = merged.filter((m) => {
      const key = `${Number(m.time)}|${m.text}|${m.shape}|${m.position}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    series.setMarkers(deduped);
  }



  useEffect(() => {
    syncLiquidityLines(liquidity);
  }, [liquidity, timeframeSeconds]);


  function syncLiquidityLines(items: any[]) {
    const series = candleSeriesRef.current;
    if (!series) return;

    const map = liqLinesRef.current;

    // remove lines that no longer exist
    const nextIds = new Set((items ?? []).map((x) => String(x.id)));
    for (const [id, line] of map.entries()) {
      if (!nextIds.has(id)) {
        series.removePriceLine(line);
        map.delete(id);
      }
    }

    // add/update
    for (const it of items ?? []) {
      const id = String(it.id);
      const price = Number(it.price);
      if (!Number.isFinite(price)) continue;

      const side = String(it.side ?? "").toLowerCase(); // "buy" | "sell"
      const titleBase = side === "sell" ? "Liquidity Sell" : "Liquidity Buy";
      const title = it.triggered ? `${titleBase} (Triggered)` : titleBase;

      const opts = {
        price,
        color: "#3b82f6", // ✅ blue
        lineWidth: 2,
        lineStyle: LineStyle.Dashed, // ✅ dashed
        axisLabelVisible: true,
        title,
      };

      const existing = map.get(id);
      if (!existing) {
        const pl = series.createPriceLine(opts);
        map.set(id, pl);
      } else {
        existing.applyOptions(opts);
      }
    }
  }

  // ===========================
  // UI
  // ===========================
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{ display: "flex", gap: 8, padding: 8 }}>
        {(["M1", "M5", "M15", "H1"] as TF[]).map((tf) => (
          <button
            key={tf}
            onClick={() => setTimeframe(tf)}
            style={{
              padding: "6px 10px",
              borderRadius: 6,
              background: tf === timeframe ? "#1e293b" : "#4b607c",
              color: "white",
              border: "1px solid #4b607c",
              cursor: "pointer",
            }}
          >
            {tf}
          </button>
        ))}
      </div>

      <div ref={containerRef} style={{ flex: 1 }} />
    </div>
  );
}
