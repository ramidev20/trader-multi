import { useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Tabs,
  Tab,
  Typography,
  Divider,
  Stack,
  Chip,
  Table,
  TableHead,
  TableRow,
  TableCell,
  TableBody,
} from "@mui/material";
import {
  AreaData,
  ColorType,
  IChartApi,
  ISeriesApi,
  LineData,
  Time,
  createChart,
} from "lightweight-charts";
import { useTradingStore } from "../store/tradingStore";

function TabPanel(props: { value: number; index: number; children: any }) {
  const { value, index, children } = props;
  if (value !== index) return null;
  return (
    <Box sx={{ flex: 1, minHeight: 0, overflow: "auto", p: 2 }}>{children}</Box>
  );
}

function toAccountCurves(
  history: any[],
  account: any,
): {
  equity: AreaData<Time>[];
  balance: LineData<Time>[];
  profit: LineData<Time>[];
} {
  const perSecondProfit = new Map<number, number>();
  for (const d of history ?? []) {
    const ts = Math.floor(Number(d?.time));
    if (!Number.isFinite(ts)) continue;
    const p = Number(d?.profit);
    const prev = perSecondProfit.get(ts) ?? 0;
    perSecondProfit.set(ts, prev + (Number.isFinite(p) ? p : 0));
  }

  const timestamps = [...perSecondProfit.keys()].sort((a, b) => a - b);
  const accountBalance = Number(account?.balance);
  const accountEquity = Number(account?.equity);

  if (timestamps.length === 0) {
    if (!Number.isFinite(accountBalance) && !Number.isFinite(accountEquity)) {
      return { equity: [], balance: [], profit: [] };
    }
    const nowTs = Math.floor(Date.now() / 1000) as Time;
    const bal = Number.isFinite(accountBalance)
      ? accountBalance
      : accountEquity;
    const eq = Number.isFinite(accountEquity) ? accountEquity : bal;
    const pf = eq - bal;
    return {
      equity: [{ time: nowTs, value: eq }],
      balance: [{ time: nowTs, value: bal }],
      profit: [{ time: nowTs, value: pf }],
    };
  }

  const totalProfit = [...perSecondProfit.values()].reduce((acc, p) => acc + p, 0);
  const startBalance = Number.isFinite(accountBalance)
    ? accountBalance - totalProfit
    : 0;

  let running = 0;
  const equity: AreaData<Time>[] = [];
  const balance: LineData<Time>[] = [];
  const profit: LineData<Time>[] = [];

  for (const ts of timestamps) {
    running += perSecondProfit.get(ts) ?? 0;
    const bal = startBalance + running;
    const eq = bal;
    equity.push({ time: ts as Time, value: eq });
    balance.push({ time: ts as Time, value: bal });
    profit.push({ time: ts as Time, value: eq - startBalance });
  }

  if (Number.isFinite(accountEquity)) {
    const nowTs = Math.floor(Date.now() / 1000);
    const lastTs = Number(equity[equity.length - 1]?.time ?? 0);
    const t = Math.max(nowTs, lastTs + 1) as Time;
    const balNow = Number.isFinite(accountBalance)
      ? accountBalance
      : Number(balance[balance.length - 1]?.value ?? startBalance);
    equity.push({
      time: t,
      value: accountEquity,
    });
    balance.push({
      time: t,
      value: balNow,
    });
    profit.push({
      time: t,
      value: accountEquity - startBalance,
    });
  } else if (Number.isFinite(accountBalance)) {
    const nowTs = Math.floor(Date.now() / 1000);
    const lastTs = Number(equity[equity.length - 1]?.time ?? 0);
    const t = Math.max(nowTs, lastTs + 1) as Time;
    const eqNow = accountBalance;
    equity.push({
      time: t,
      value: eqNow,
    });
    balance.push({
      time: t,
      value: accountBalance,
    });
    profit.push({
      time: Math.max(nowTs, lastTs + 1) as Time,
      value: eqNow - startBalance,
    });
  }

  return { equity, balance, profit };
}

function AccountEquityChart({ history, account }: { history: any[]; account: any }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const equitySeriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const balanceSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const profitSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);

  const curves = useMemo(() => toAccountCurves(history, account), [history, account]);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#64748b",
      },
      grid: {
        vertLines: { color: "rgba(148, 163, 184, 0.12)" },
        horzLines: { color: "rgba(148, 163, 184, 0.12)" },
      },
      rightPriceScale: {
        borderVisible: false,
      },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: {
        vertLine: { color: "rgba(100, 116, 139, 0.35)" },
        horzLine: { color: "rgba(100, 116, 139, 0.35)" },
      },
    });
    chartRef.current = chart;

    const equitySeries = chart.addAreaSeries({
      lineColor: "#2563eb",
      topColor: "rgba(37, 99, 235, 0.35)",
      bottomColor: "rgba(37, 99, 235, 0.03)",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    equitySeriesRef.current = equitySeries;

    const balanceSeries = chart.addLineSeries({
      color: "#16a34a",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    balanceSeriesRef.current = balanceSeries;

    const profitSeries = chart.addLineSeries({
      color: "#f59e0b",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    profitSeriesRef.current = profitSeries;

    const resize = () => {
      if (!containerRef.current) return;
      chart.applyOptions({
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight,
      });
    };
    const ro = new ResizeObserver(resize);
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      equitySeriesRef.current = null;
      balanceSeriesRef.current = null;
      profitSeriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!equitySeriesRef.current || !balanceSeriesRef.current || !profitSeriesRef.current || !chartRef.current) return;
    equitySeriesRef.current.setData(curves.equity);
    balanceSeriesRef.current.setData(curves.balance);
    profitSeriesRef.current.setData(curves.profit);
    if (curves.equity.length > 1) {
      chartRef.current.timeScale().fitContent();
    }
  }, [curves]);

  return <Box ref={containerRef} sx={{ width: "100%", height: "100%" }} />;
}

export default function TerminalPanel() {
  const [tab, setTab] = useState(0);
  const logs = useTradingStore((s) => s.logs);
  const isLoggedIn = useTradingStore((s) => s.isLoggedIn);
  const account = useTradingStore((s) => s.account);

  const positions = useTradingStore((s) => s.positions);
  const history = useTradingStore((s) => s.history);
  const liq = useTradingStore((s) => s.liquidity);

  const triggered = useMemo(() => liq.filter((x) => x.triggered), [liq]);
  const pending = useMemo(() => liq.filter((x) => !x.triggered), [liq]);

  return (
    <Box sx={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <Tabs
        value={tab}
        onChange={(_, v) => setTab(v)}
        sx={{ px: 2 }}
        variant="scrollable"
        scrollButtons="auto"
      >
        <Tab label="Journals" />
        <Tab label="Positions" />
        <Tab label="History" />
        <Tab label="Liquidity" />
        <Tab label="Account" />
      </Tabs>

      <Divider />

      {/* Journals */}
      <TabPanel value={tab} index={0}>
        {logs.length === 0 ? (
          <Typography color="text.secondary">No logs yet.</Typography>
        ) : (
          <Box
            component="pre"
            sx={{ m: 0, fontSize: 12, whiteSpace: "pre-wrap" }}
          >
            {logs.slice(-300).join("\n")}
          </Box>
        )}
      </TabPanel>

      {/* Positions */}
      <TabPanel value={tab} index={1}>
        {!isLoggedIn ? (
          <Typography color="text.secondary">
            Login to view positions.
          </Typography>
        ) : positions.length === 0 ? (
          <Typography color="text.secondary">No open positions.</Typography>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Ticket</TableCell>
                <TableCell>Symbol</TableCell>
                <TableCell>Type</TableCell>
                <TableCell>Vol</TableCell>
                <TableCell>Open</TableCell>
                <TableCell align="right">P/L</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {positions.map((p) => (
                <TableRow key={p.ticket}>
                  <TableCell>{p.ticket}</TableCell>
                  <TableCell>{p.symbol}</TableCell>
                  <TableCell>{p.type}</TableCell>
                  <TableCell>{p.volume}</TableCell>
                  <TableCell>{p.price_open}</TableCell>
                  <TableCell align="right">
                    {Number(p.profit).toFixed(2)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </TabPanel>

      {/* History */}
      <TabPanel value={tab} index={2}>
        {!isLoggedIn ? (
          <Typography color="text.secondary">Login to view history.</Typography>
        ) : history.length === 0 ? (
          <Typography color="text.secondary">No history found.</Typography>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Ticket</TableCell>
                <TableCell>Time</TableCell>
                <TableCell>Symbol</TableCell>
                <TableCell>Type</TableCell>
                <TableCell>Vol</TableCell>
                <TableCell align="right">P/L</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {history.slice(0, 200).map((d) => (
                <TableRow key={d.ticket}>
                  <TableCell>{d.ticket}</TableCell>
                  <TableCell>
                    {new Date(d.time * 1000).toLocaleString()}
                  </TableCell>
                  <TableCell>{d.symbol}</TableCell>
                  <TableCell>{d.type}</TableCell>
                  <TableCell>{d.volume}</TableCell>
                  <TableCell align="right">
                    {Number(d.profit).toFixed(2)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </TabPanel>

      {/* Liquidity */}
      <TabPanel value={tab} index={3}>
        {!isLoggedIn ? (
          <Typography color="text.secondary">
            Login to view liquidity.
          </Typography>
        ) : (
          <Stack gap={2}>
            <Box>
              <Typography sx={{ fontWeight: 800, mb: 1 }}>Pending</Typography>
              {pending.length === 0 ? (
                <Typography color="text.secondary">
                  No pending liquidity.
                </Typography>
              ) : (
                pending.map((x) => (
                  <Chip
                    key={x.id}
                    label={`${x.side.toUpperCase()} @ ${x.price}`}
                    sx={{ mr: 1, mb: 1 }}
                    variant="outlined"
                    color={x.side === "buy" ? "success" : "error"}
                  />
                ))
              )}
            </Box>

            <Box>
              <Typography sx={{ fontWeight: 800, mb: 1 }}>Triggered</Typography>
              {triggered.length === 0 ? (
                <Typography color="text.secondary">
                  No triggered liquidity.
                </Typography>
              ) : (
                triggered.map((x) => (
                  <Chip
                    key={x.id}
                    label={`${x.side.toUpperCase()} @ ${x.price} (TRIGGERED)`}
                    sx={{ mr: 1, mb: 1 }}
                    color="warning"
                  />
                ))
              )}
            </Box>
          </Stack>
        )}
      </TabPanel>

      {/* Account */}
      <TabPanel value={tab} index={4}>
        {!isLoggedIn ? (
          <Typography color="text.secondary">
            Login to view account info.
          </Typography>
        ) : (
          <Stack gap={2}>
            <Stack direction="row" gap={1.2} flexWrap="wrap">
              <Chip label={`Balance: ${Number(account?.balance ?? 0).toFixed(2)}`} />
              <Chip label={`Equity: ${Number(account?.equity ?? 0).toFixed(2)}`} />
              <Chip label={`Profit: ${Number(account?.profit ?? 0).toFixed(2)}`} />
              <Chip label={`Margin: ${Number(account?.margin ?? 0).toFixed(2)}`} />
            </Stack>

            <Box
              sx={{
                border: "1px solid",
                borderColor: "divider",
                borderRadius: 2,
                p: 1.25,
                bgcolor: "rgba(15,23,42,0.015)",
              }}
            >
              <Typography variant="caption" color="text.secondary" sx={{ px: 0.5 }}>
                Equity / Balance / Profit
              </Typography>
              <Stack direction="row" gap={1} sx={{ mt: 0.75, px: 0.5 }}>
                <Chip size="small" label="Equity" sx={{ bgcolor: "rgba(37,99,235,0.14)" }} />
                <Chip size="small" label="Balance" sx={{ bgcolor: "rgba(22,163,74,0.14)" }} />
                <Chip size="small" label="Profit" sx={{ bgcolor: "rgba(245,158,11,0.14)" }} />
              </Stack>
              <Box sx={{ height: { xs: 170, sm: 210, md: 240 }, mt: 1 }}>
                <AccountEquityChart history={history} account={account} />
              </Box>
            </Box>
          </Stack>
        )}
      </TabPanel>
    </Box>
  );
}
