import React, { useEffect, useMemo, useState } from "react";
import {
  Box,
  Card,
  CardContent,
  Typography,
  Grid,
  TextField,
  MenuItem,
  Button,
  Divider,
  Stack,
  Chip,
  Switch,
  FormControlLabel,
  Table,
  TableHead,
  TableRow,
  TableCell,
  TableBody,
  IconButton,
  Tooltip,
} from "@mui/material";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import StopRoundedIcon from "@mui/icons-material/StopRounded";
import AddRoundedIcon from "@mui/icons-material/AddRounded";

import {
  LiquidityItem,
  LiquiditySide,
  addLiquidity,
  deleteLiquidity,
  getStrategyStatus,
  startStrategy,
  stopStrategy,
  updateLiquidity,
} from "../api/strategy";
import { useTradingStore } from "../store/tradingStore";

type FormState = {
  timeframe: number;
  lot: string;
  orderDelay: string;
  minPips: string;
  maxPips: string;
  tpInPips: boolean;
  tp: string;
  slInPips: boolean;
  sl: string;
  enableBuy: boolean;
  enableSell: boolean;
  maxOrders: string;
  startTime: string;
  endTimeEnabled: boolean;
  endTime: string;
  useLiquidity: boolean;
};

const TIMEFRAMES = [
  { label: "M1", value: 1 },
  { label: "M3", value: 3 },
  { label: "M5", value: 5 },
  { label: "M15", value: 15 },
  { label: "H1", value: 60 },
];
const STRATEGY_FORM_KEY = "strategy_form_v1";

function toNum(v: string, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function nowLocalInput() {
  const d = new Date();
  d.setSeconds(0, 0);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toIsoOrNull(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString();
}

const DEFAULT_FORM: FormState = {
  timeframe: 1,
  lot: "0.05",
  orderDelay: "0",
  minPips: "8",
  maxPips: "40",
  tpInPips: true,
  tp: "120",
  slInPips: true,
  sl: "400",
  enableBuy: true,
  enableSell: true,
  maxOrders: "2",
  startTime: nowLocalInput(),
  endTimeEnabled: false,
  endTime: "",
  useLiquidity: true,
};

function loadFormState(): FormState {
  try {
    const raw = localStorage.getItem(STRATEGY_FORM_KEY);
    if (!raw) return { ...DEFAULT_FORM };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_FORM, ...parsed };
  } catch {
    return { ...DEFAULT_FORM };
  }
}

export default function StrategyPage() {
  const [busy, setBusy] = useState(false);

  const [form, setForm] = useState<FormState>(() => loadFormState());

  const [liqPrice, setLiqPrice] = useState("");
  const [liqSide, setLiqSide] = useState<LiquiditySide>("buy");

  const items = useTradingStore((s) => s.liquidity) as LiquidityItem[];
  const logs = useTradingStore((s) => s.logs);
  const strategyStatus = useTradingStore((s) => s.strategyStatus);
  const setStrategyStatus = useTradingStore((s) => s.setStrategyStatus);
  const running = !!strategyStatus.running;

  const triggered = useMemo(() => items.filter((i) => i.triggered), [items]);
  const pending = useMemo(() => items.filter((i) => !i.triggered), [items]);
  const strategyLogs = useMemo(
    () => logs.filter((x) => x.toLowerCase().includes("[strategy]")),
    [logs],
  );

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data = await getStrategyStatus();
        if (!alive) return;
        setStrategyStatus(data ?? {});
      } catch (e) {
        console.error("Failed to fetch strategy status", e);
      }
    })();
    return () => {
      alive = false;
    };
  }, [setStrategyStatus]);

  useEffect(() => {
    localStorage.setItem(STRATEGY_FORM_KEY, JSON.stringify(form));
  }, [form]);

  async function onStart() {
    setBusy(true);
    try {
      await startStrategy({
        symbol: "XAUUSD",
        timeframe: form.timeframe,
        lot: toNum(form.lot, 0.05),
        min_pips: toNum(form.minPips, 8),
        max_pips: toNum(form.maxPips, 40),
        order_delay: toNum(form.orderDelay, 0),
        tp_type: form.tpInPips,
        tp: toNum(form.tp, 120),
        sl_type: form.slInPips,
        sl: toNum(form.sl, 400),
        enable_buy: form.enableBuy,
        enable_sell: form.enableSell,
        max_orders: Math.max(1, Math.floor(toNum(form.maxOrders, 1))),
        start_time: toIsoOrNull(form.startTime),
        end_time_enabled: form.endTimeEnabled,
        end_time: form.endTimeEnabled ? toIsoOrNull(form.endTime) : null,
        use_liquidity: form.useLiquidity,
      });
      setStrategyStatus({ running: true });
    } catch (e) {
      console.error(e);
      alert("Failed to start strategy (check backend routes / payload).");
    } finally {
      setBusy(false);
    }
  }

  async function onStop() {
    setBusy(true);
    try {
      await stopStrategy();
      setStrategyStatus({ running: false, pending_liq: null });
    } catch (e) {
      console.error(e);
      alert("Failed to stop strategy.");
    } finally {
      setBusy(false);
    }
  }

  async function onAddLiquidity() {
    const price = toNum(liqPrice, NaN);
    if (!Number.isFinite(price)) return alert("Invalid price");

    setBusy(true);
    try {
      await addLiquidity(price, liqSide);
      setLiqPrice("");
    } catch (e) {
      console.error(e);
      alert("Failed to add liquidity.");
    } finally {
      setBusy(false);
    }
  }

  async function onUpdatePrice(id: string, priceStr: string) {
    const price = toNum(priceStr, NaN);
    if (!Number.isFinite(price)) return;
    try {
      await updateLiquidity(id, price);
    } catch (e) {
      console.error(e);
    }
  }

  async function onDelete(id: string) {
    try {
      await deleteLiquidity(id);
    } catch (e) {
      console.error(e);
    }
  }

  return (
    <Box sx={{ width: "100%", maxWidth: "none", mx: 0, px: { xs: 1.5, sm: 2.5, md: 3 }, pb: 2 }}>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        alignItems={{ sm: "center" }}
        justifyContent="space-between"
        gap={1.5}
        sx={{ mb: 2 }}
      >
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 900 }}>
            Strategy
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Liquidity-driven execution with session windows, max entries, and live journal.
          </Typography>
        </Box>

        <Stack direction="row" gap={1} alignItems="center">
          <Button
            onClick={onStart}
            disabled={busy || running}
            startIcon={<PlayArrowRoundedIcon />}
            variant="contained"
          >
            Start
          </Button>
          <Button
            onClick={onStop}
            disabled={busy || !running}
            startIcon={<StopRoundedIcon />}
            variant="outlined"
          >
            Stop
          </Button>
          {strategyStatus.last_event ? (
            <Tooltip title={strategyStatus.last_event}>
              <Chip
                size="small"
                label={strategyStatus.last_event}
                variant="outlined"
                sx={{
                  maxWidth: 360,
                  "& .MuiChip-label": {
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    display: "block",
                  },
                }}
              />
            </Tooltip>
          ) : null}
        </Stack>
      </Stack>

      <Grid container spacing={2} alignItems="stretch">
        <Grid item xs={12} lg={4}>
          <Card sx={{ borderRadius: 3, height: "100%" }}>
            <CardContent>
              <Typography variant="subtitle1" sx={{ fontWeight: 800, mb: 1 }}>
                Liquidity Watchlist
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                {form.useLiquidity
                  ? "Trigger levels to arm forced entries."
                  : "Liquidity condition is disabled. Strategy uses candle + volume conditions only."}
              </Typography>

              <Stack direction={{ xs: "column", sm: "row" }} gap={1.2} sx={{ mb: 2 }}>
                <TextField
                  fullWidth
                  label="Liquidity Price"
                  value={liqPrice}
                  onChange={(e) => setLiqPrice(e.target.value)}
                  disabled={!form.useLiquidity}
                  inputProps={{ inputMode: "decimal" }}
                />
                <TextField
                  select
                  label="Side"
                  value={liqSide}
                  onChange={(e) => setLiqSide(e.target.value as LiquiditySide)}
                  disabled={!form.useLiquidity}
                  sx={{ minWidth: 120 }}
                >
                  <MenuItem value="buy">Buy</MenuItem>
                  <MenuItem value="sell">Sell</MenuItem>
                </TextField>
                <Button onClick={onAddLiquidity} disabled={busy || !form.useLiquidity} variant="contained" startIcon={<AddRoundedIcon />}>
                  Add
                </Button>
              </Stack>

              <Divider sx={{ my: 2 }} />

              <Typography variant="subtitle2" sx={{ fontWeight: 900, mb: 1 }}>
                Pending
              </Typography>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Side</TableCell>
                    <TableCell>Price</TableCell>
                    <TableCell align="right">Action</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {pending.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={3} sx={{ color: "text.secondary" }}>
                        No pending liquidity levels.
                      </TableCell>
                    </TableRow>
                  ) : (
                    pending.map((l) => (
                      <TableRow key={l.id}>
                        <TableCell>
                          <Chip size="small" label={l.side.toUpperCase()} color={l.side === "buy" ? "success" : "error"} variant="outlined" />
                        </TableCell>
                        <TableCell>
                          <TextField
                            defaultValue={String(l.price)}
                            onBlur={(e) => onUpdatePrice(l.id, e.target.value)}
                            size="small"
                            fullWidth
                            inputProps={{ inputMode: "decimal" }}
                          />
                        </TableCell>
                        <TableCell align="right">
                          <Tooltip title="Delete">
                            <IconButton onClick={() => onDelete(l.id)} size="small">
                              <DeleteOutlineIcon />
                            </IconButton>
                          </Tooltip>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>

              <Divider sx={{ my: 2 }} />
              <Typography variant="subtitle2" sx={{ fontWeight: 900, mb: 1 }}>
                Triggered
              </Typography>
              <Stack gap={1}>
                {triggered.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">
                    No triggered liquidity yet.
                  </Typography>
                ) : (
                  triggered.map((l) => (
                    <Card key={l.id} variant="outlined" sx={{ borderRadius: 2 }}>
                      <CardContent sx={{ py: 1.2, "&:last-child": { pb: 1.2 } }}>
                        <Stack direction="row" alignItems="center" justifyContent="space-between">
                          <Stack direction="row" gap={1} alignItems="center">
                            <Chip size="small" label={l.side.toUpperCase()} color={l.side === "buy" ? "success" : "error"} />
                            <Typography sx={{ fontWeight: 800 }}>{l.price}</Typography>
                          </Stack>
                          <Chip size="small" label="TRIGGERED" color="warning" />
                        </Stack>
                      </CardContent>
                    </Card>
                  ))
                )}
              </Stack>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} lg={8}>
          <Card sx={{ borderRadius: 3 }}>
            <CardContent>
              <Typography variant="subtitle1" sx={{ fontWeight: 800, mb: 1 }}>
                Strategy Configuration
              </Typography>
              <Divider sx={{ mb: 2 }} />

              <Grid container spacing={2} alignItems="stretch">
                <Grid item xs={12} sm={3}>
                  <TextField
                    select
                    fullWidth
                    label="Timeframe"
                    value={form.timeframe}
                    onChange={(e) => setForm((s) => ({ ...s, timeframe: Number(e.target.value) }))}
                  >
                    {TIMEFRAMES.map((t) => (
                      <MenuItem key={t.value} value={t.value}>
                        {t.label}
                      </MenuItem>
                    ))}
                  </TextField>
                </Grid>
                <Grid item xs={12} sm={3}>
                  <TextField
                    fullWidth
                    label="Lot"
                    value={form.lot}
                    onChange={(e) => setForm((s) => ({ ...s, lot: e.target.value }))}
                    inputProps={{ inputMode: "decimal" }}
                  />
                </Grid>
                <Grid item xs={12} sm={3}>
                  <TextField
                    select
                    fullWidth
                    label="Order Delay (sec)"
                    value={form.orderDelay}
                    onChange={(e) => setForm((s) => ({ ...s, orderDelay: e.target.value }))}
                  >
                    {Array.from({ length: 11 }).map((_, i) => (
                      <MenuItem key={i} value={String(i)}>
                        {i}
                      </MenuItem>
                    ))}
                  </TextField>
                </Grid>
                <Grid item xs={12} sm={3}>
                  <TextField
                    fullWidth
                    label="Max Orders / Trigger"
                    value={form.maxOrders}
                    onChange={(e) => setForm((s) => ({ ...s, maxOrders: e.target.value }))}
                    inputProps={{ inputMode: "numeric" }}
                  />
                </Grid>

                <Grid item xs={12} sm={6} md={3}>
                  <TextField
                    fullWidth
                    type="datetime-local"
                    label="Start Time"
                    value={form.startTime}
                    onChange={(e) => setForm((s) => ({ ...s, startTime: e.target.value }))}
                    InputLabelProps={{ shrink: true }}
                  />
                </Grid>
                <Grid item xs={12} sm={6} md={3}>
                  <TextField
                    fullWidth
                    type="datetime-local"
                    label="End Time"
                    value={form.endTime}
                    disabled={!form.endTimeEnabled}
                    onChange={(e) => setForm((s) => ({ ...s, endTime: e.target.value }))}
                    InputLabelProps={{ shrink: true }}
                  />
                </Grid>
                <Grid item xs={12} md={6}>
                  <Stack direction={{ xs: "column", sm: "row" }} gap={2} sx={{ height: "100%" }} alignItems={{ sm: "center" }}>
                    <FormControlLabel
                      control={<Switch checked={form.useLiquidity} onChange={(e) => setForm((s) => ({ ...s, useLiquidity: e.target.checked }))} />}
                      label="Use Liquidity Condition"
                    />
                    <FormControlLabel
                      control={
                        <Switch
                          checked={form.endTimeEnabled}
                          onChange={(e) => setForm((s) => ({ ...s, endTimeEnabled: e.target.checked }))}
                        />
                      }
                      label="Use End Time"
                    />
                    <FormControlLabel
                      control={<Switch checked={form.enableBuy} onChange={(e) => setForm((s) => ({ ...s, enableBuy: e.target.checked }))} />}
                      label="Enable Buy"
                    />
                    <FormControlLabel
                      control={<Switch checked={form.enableSell} onChange={(e) => setForm((s) => ({ ...s, enableSell: e.target.checked }))} />}
                      label="Enable Sell"
                    />
                  </Stack>
                </Grid>

                <Grid item xs={12} sm={6}>
                  <TextField
                    fullWidth
                    label="Min Candle Body (pips)"
                    value={form.minPips}
                    onChange={(e) => setForm((s) => ({ ...s, minPips: e.target.value }))}
                    inputProps={{ inputMode: "numeric" }}
                  />
                </Grid>
                <Grid item xs={12} sm={6}>
                  <TextField
                    fullWidth
                    label="Max Candle Body (pips)"
                    value={form.maxPips}
                    onChange={(e) => setForm((s) => ({ ...s, maxPips: e.target.value }))}
                    inputProps={{ inputMode: "numeric" }}
                  />
                </Grid>

                <Grid item xs={12} sm={6}>
                  <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
                    <Typography sx={{ fontWeight: 800 }}>Take Profit</Typography>
                    <Switch checked={form.tpInPips} onChange={(e) => setForm((s) => ({ ...s, tpInPips: e.target.checked }))} />
                    <Chip size="small" label={form.tpInPips ? "Pips" : "Price"} variant="outlined" />
                  </Stack>
                  <TextField
                    fullWidth
                    label="TP"
                    value={form.tp}
                    onChange={(e) => setForm((s) => ({ ...s, tp: e.target.value }))}
                    inputProps={{ inputMode: "numeric" }}
                  />
                </Grid>
                <Grid item xs={12} sm={6}>
                  <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
                    <Typography sx={{ fontWeight: 800 }}>Stop Loss</Typography>
                    <Switch checked={form.slInPips} onChange={(e) => setForm((s) => ({ ...s, slInPips: e.target.checked }))} />
                    <Chip size="small" label={form.slInPips ? "Pips" : "Price"} variant="outlined" />
                  </Stack>
                  <TextField
                    fullWidth
                    label="SL"
                    value={form.sl}
                    onChange={(e) => setForm((s) => ({ ...s, sl: e.target.value }))}
                    inputProps={{ inputMode: "numeric" }}
                  />
                </Grid>
              </Grid>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12}>
          <Card
            sx={{
              borderRadius: 3,
              minHeight: 240,
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <CardContent sx={{ pb: 1 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 800, mb: 1 }}>
                Strategy Journal
              </Typography>
              <Divider sx={{ mb: 1.5 }} />
              {strategyLogs.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  No strategy logs yet.
                </Typography>
              ) : (
                <Box
                  component="pre"
                  sx={{
                    m: 0,
                    p: 1.5,
                    borderRadius: 2,
                    bgcolor: "rgba(15,23,42,0.05)",
                    fontSize: 12,
                    lineHeight: 1.45,
                    whiteSpace: "pre-wrap",
                    maxHeight: 240,
                    overflow: "auto",
                  }}
                >
                  {strategyLogs.slice(-300).join("\n")}
                </Box>
              )}
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
}
