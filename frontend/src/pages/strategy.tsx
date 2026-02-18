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
  getLiquidity,
  startStrategy,
  stopStrategy,
  updateLiquidity,
} from "../api/strategy";

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
};

const TIMEFRAMES = [
  { label: "M1", value: 1 },
  { label: "M3", value: 3 },
  { label: "M5", value: 5 },
  { label: "M15", value: 15 },
];

function toNum(v: string, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export default function StrategyPage() {
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);

  const [form, setForm] = useState<FormState>({
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
  });

  const [liqPrice, setLiqPrice] = useState("");
  const [liqSide, setLiqSide] = useState<LiquiditySide>("buy");

  const [items, setItems] = useState<LiquidityItem[]>([]);
  const triggered = useMemo(() => items.filter((i) => i.triggered), [items]);
  const pending = useMemo(() => items.filter((i) => !i.triggered), [items]);

  async function refresh() {
    try {
      const data = await getLiquidity();
      setItems(data);
    } catch (e) {
      console.error(e);
    }
  }

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 1000);
    return () => clearInterval(t);
  }, []);

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
      });
      setRunning(true);
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
      setRunning(false);
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
      const created = await addLiquidity(price, liqSide);
      setItems((prev) => [created, ...prev]);
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

    setItems((prev) => prev.map((x) => (x.id === id ? { ...x, price } : x)));

    try {
      await updateLiquidity(id, price);
    } catch (e) {
      console.error(e);
      refresh();
    }
  }

  async function onDelete(id: string) {
    setItems((prev) => prev.filter((x) => x.id !== id));
    try {
      await deleteLiquidity(id);
    } catch (e) {
      console.error(e);
      refresh();
    }
  }

  return (
    <Box
      sx={{
        width: "100%",
        maxWidth: "none",
        mx: 0,
        px: { xs: 1.5, sm: 2.5, md: 3 },
      }}
    >
      {/* Page header */}
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
            Liquidity-driven execution with candle-body filters, TP/SL controls,
            and liquidity watchlists.
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
        </Stack>
      </Stack>

      <Grid container spacing={2} alignItems="stretch">
        {/* Left column: config */}
        <Grid item xs={12} lg={8}>
          <Card sx={{ borderRadius: 3, height: "100%" }}>
            <CardContent>
              <Typography variant="subtitle1" sx={{ fontWeight: 800, mb: 1 }}>
                Strategy Configuration
              </Typography>
              <Divider sx={{ mb: 2 }} />

              <Grid container spacing={2} alignItems="stretch">
                <Grid item xs={12} sm={4}>
                  <TextField
                    select
                    fullWidth
                    label="Timeframe"
                    value={form.timeframe}
                    onChange={(e) =>
                      setForm((s) => ({
                        ...s,
                        timeframe: Number(e.target.value),
                      }))
                    }
                  >
                    {TIMEFRAMES.map((t) => (
                      <MenuItem key={t.value} value={t.value}>
                        {t.label}
                      </MenuItem>
                    ))}
                  </TextField>
                </Grid>

                <Grid item xs={12} sm={4}>
                  <TextField
                    fullWidth
                    label="Lot"
                    value={form.lot}
                    onChange={(e) =>
                      setForm((s) => ({ ...s, lot: e.target.value }))
                    }
                    inputProps={{ inputMode: "decimal" }}
                  />
                </Grid>

                <Grid item xs={12} sm={4}>
                  <TextField
                    select
                    fullWidth
                    label="Order Delay (sec)"
                    value={form.orderDelay}
                    onChange={(e) =>
                      setForm((s) => ({ ...s, orderDelay: e.target.value }))
                    }
                  >
                    {Array.from({ length: 6 }).map((_, i) => (
                      <MenuItem key={i} value={String(i)}>
                        {i}
                      </MenuItem>
                    ))}
                  </TextField>
                </Grid>

                <Grid item xs={12} sm={6}>
                  <TextField
                    fullWidth
                    label="Min Candle Body (pips)"
                    value={form.minPips}
                    onChange={(e) =>
                      setForm((s) => ({ ...s, minPips: e.target.value }))
                    }
                    inputProps={{ inputMode: "numeric" }}
                  />
                </Grid>

                <Grid item xs={12} sm={6}>
                  <TextField
                    fullWidth
                    label="Max Candle Body (pips)"
                    value={form.maxPips}
                    onChange={(e) =>
                      setForm((s) => ({ ...s, maxPips: e.target.value }))
                    }
                    inputProps={{ inputMode: "numeric" }}
                  />
                </Grid>

                <Grid item xs={12} sm={4}>
                  <FormControlLabel
                    control={
                      <Switch
                        checked={form.enableBuy}
                        onChange={(e) =>
                          setForm((s) => ({
                            ...s,
                            enableBuy: e.target.checked,
                          }))
                        }
                      />
                    }
                    label="Enable Buy"
                  />
                </Grid>
                <Grid item xs={12} sm={4}>
                  <FormControlLabel
                    control={
                      <Switch
                        checked={form.enableSell}
                        onChange={(e) =>
                          setForm((s) => ({
                            ...s,
                            enableSell: e.target.checked,
                          }))
                        }
                      />
                    }
                    label="Enable Sell"
                  />
                </Grid>
                <Grid item xs={12} sm={4}>
                  <TextField
                    fullWidth
                    label="Max Orders"
                    value={form.maxOrders}
                    onChange={(e) =>
                      setForm((s) => ({ ...s, maxOrders: e.target.value }))
                    }
                    inputProps={{ inputMode: "numeric" }}
                  />
                </Grid>

                <Grid item xs={12} sm={6}>
                  <Stack
                    direction="row"
                    alignItems="center"
                    justifyContent="space-between"
                    sx={{ mb: 1 }}
                  >
                    <Typography sx={{ fontWeight: 800 }}>
                      Take Profit
                    </Typography>

                    <Switch
                      checked={form.tpInPips}
                      onChange={(e) =>
                        setForm((s) => ({
                          ...s,
                          tpInPips: e.target.checked,
                        }))
                      }
                    />

                    <Chip
                      size="small"
                      label={form.tpInPips ? "Pips" : "Price"}
                      variant="outlined"
                    />
                  </Stack>
                  <Stack direction="row" gap={1}>
                    <TextField
                      fullWidth
                      label="TP"
                      value={form.tp}
                      onChange={(e) =>
                        setForm((s) => ({ ...s, tp: e.target.value }))
                      }
                      inputProps={{ inputMode: "numeric" }}
                    />
                  </Stack>
                </Grid>

                <Grid item xs={12} sm={6}>
                  <Stack
                    direction="row"
                    alignItems="center"
                    justifyContent="space-between"
                    sx={{ mb: 1 }}
                  >
                    <Typography sx={{ fontWeight: 800 }}>Stop Loss</Typography>

                    <Switch
                      checked={form.slInPips}
                      onChange={(e) =>
                        setForm((s) => ({
                          ...s,
                          slInPips: e.target.checked,
                        }))
                      }
                    />

                    <Chip
                      size="small"
                      label={form.slInPips ? "Pips" : "Price"}
                      variant="outlined"
                    />
                  </Stack>
                  <Stack direction="row" gap={1}>
                    <TextField
                      fullWidth
                      label="SL"
                      value={form.sl}
                      onChange={(e) =>
                        setForm((s) => ({ ...s, sl: e.target.value }))
                      }
                      inputProps={{ inputMode: "numeric" }}
                    />
                  </Stack>
                </Grid>
              </Grid>
            </CardContent>
          </Card>
        </Grid>

        {/* Right column: liquidity */}
        <Grid item xs={12} lg={4}>
          <Card sx={{ borderRadius: 3, height: "100%" }}>
            <CardContent>
              <Typography variant="subtitle1" sx={{ fontWeight: 800, mb: 1 }}>
                Liquidity Watchlist
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Add price levels to trigger forced buy/sell entries when
                reached.
              </Typography>

              <Stack
                direction={{ xs: "column", sm: "row" }}
                gap={1.2}
                sx={{ mb: 2 }}
              >
                <TextField
                  fullWidth
                  label="Liquidity Price"
                  value={liqPrice}
                  onChange={(e) => setLiqPrice(e.target.value)}
                  inputProps={{ inputMode: "decimal" }}
                />
                <TextField
                  select
                  label="Side"
                  value={liqSide}
                  onChange={(e) => setLiqSide(e.target.value as LiquiditySide)}
                  sx={{ minWidth: 140 }}
                >
                  <MenuItem value="buy">Buy</MenuItem>
                  <MenuItem value="sell">Sell</MenuItem>
                </TextField>
                <Button
                  onClick={onAddLiquidity}
                  disabled={busy}
                  variant="contained"
                  startIcon={<AddRoundedIcon />}
                >
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
                          <Chip
                            size="small"
                            label={l.side.toUpperCase()}
                            color={l.side === "buy" ? "success" : "error"}
                            variant="outlined"
                          />
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
                            <IconButton
                              onClick={() => onDelete(l.id)}
                              size="small"
                            >
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
                    <Card
                      key={l.id}
                      variant="outlined"
                      sx={{ borderRadius: 2 }}
                    >
                      <CardContent
                        sx={{ py: 1.2, "&:last-child": { pb: 1.2 } }}
                      >
                        <Stack
                          direction="row"
                          alignItems="center"
                          justifyContent="space-between"
                        >
                          <Stack direction="row" gap={1} alignItems="center">
                            <Chip
                              size="small"
                              label={l.side.toUpperCase()}
                              color={l.side === "buy" ? "success" : "error"}
                            />
                            <Typography sx={{ fontWeight: 800 }}>
                              {l.price}
                            </Typography>
                          </Stack>
                          <Chip
                            size="small"
                            label="TRIGGERED"
                            color="warning"
                          />
                        </Stack>
                      </CardContent>
                    </Card>
                  ))
                )}
              </Stack>
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
}
