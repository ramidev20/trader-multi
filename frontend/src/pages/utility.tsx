import React, { useEffect, useMemo, useState } from "react";
import {
  Box,
  Card,
  CardContent,
  Typography,
  Grid,
  Stack,
  Button,
  Divider,
  TextField,
  Switch,
  FormControlLabel,
  Chip,
  Alert,
} from "@mui/material";
import PlayArrowRoundedIcon from "@mui/icons-material/PlayArrowRounded";
import StopRoundedIcon from "@mui/icons-material/StopRounded";
import WarningAmberRoundedIcon from "@mui/icons-material/WarningAmberRounded";

import {
  closeAllPositions,
  closePositionsBySide,
  closePositionsBySymbol,
  flattenAllOrders,
  getRiskStatus,
  startRiskManagement,
  stopRiskManagement,
  type RiskConfig,
  type RiskStatus,
} from "../api/utility";

function toNum(v: string, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export default function UtilityPage() {
  const [busy, setBusy] = useState(false);

  // Utility actions inputs
  const [symbol, setSymbol] = useState("XAUUSD");

  // Risk management
  const [riskBusy, setRiskBusy] = useState(false);
  const [riskStatus, setRiskStatus] = useState<RiskStatus | null>(null);

  const [cfg, setCfg] = useState({
    enabled: true,
    symbol: "XAUUSD",
    maxDailyLoss: "250",
    maxDrawdown: "500",
    stopAfterProfit: "300",
    maxOpenPositions: "2",
    disableNewTradesOnLimit: true,
    closePositionsOnLimit: false,
  });

  const running = Boolean(riskStatus?.running);

  async function refreshRisk() {
    try {
      const s = await getRiskStatus();
      setRiskStatus(s);

      if (s?.config) {
        setCfg((prev) => ({
          ...prev,
          enabled: Boolean(s.config.enabled ?? prev.enabled),
          symbol: String(s.config.symbol ?? prev.symbol),
          maxDailyLoss: String(s.config.maxDailyLoss ?? prev.maxDailyLoss),
          maxDrawdown: String(s.config.maxDrawdown ?? prev.maxDrawdown),
          stopAfterProfit: String(s.config.stopAfterProfit ?? prev.stopAfterProfit),
          maxOpenPositions: String(s.config.maxOpenPositions ?? prev.maxOpenPositions),
          disableNewTradesOnLimit: Boolean(
            s.config.disableNewTradesOnLimit ?? prev.disableNewTradesOnLimit,
          ),
          closePositionsOnLimit: Boolean(
            s.config.closePositionsOnLimit ?? prev.closePositionsOnLimit,
          ),
        }));
      }
    } catch {
      // silent
    }
  }

  useEffect(() => {
    refreshRisk();
    const t = setInterval(refreshRisk, 1000);
    return () => clearInterval(t);
  }, []);

  const riskBadge = useMemo(() => {
    if (!riskStatus) return { label: "UNKNOWN", color: "default" as const };
    if (riskStatus.limit_hit) return { label: "LIMIT HIT", color: "error" as const };
    if (riskStatus.running) return { label: "RUNNING", color: "success" as const };
    return { label: "STOPPED", color: "default" as const };
  }, [riskStatus]);

  async function runAction(fn: () => Promise<any>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      console.error(e);
      alert("Action failed. Check backend logs / routes.");
    } finally {
      setBusy(false);
    }
  }

  async function onStartRisk() {
    const payload: RiskConfig = {
      enabled: cfg.enabled,
      symbol: cfg.symbol.trim(),
      maxDailyLoss: toNum(cfg.maxDailyLoss, 0),
      maxDrawdown: toNum(cfg.maxDrawdown, 0),
      stopAfterProfit: toNum(cfg.stopAfterProfit, 0),
      maxOpenPositions: toNum(cfg.maxOpenPositions, 0),
      disableNewTradesOnLimit: cfg.disableNewTradesOnLimit,
      closePositionsOnLimit: cfg.closePositionsOnLimit,
    };

    setRiskBusy(true);
    try {
      await startRiskManagement(payload);
      await refreshRisk();
    } catch (e) {
      console.error(e);
      alert("Failed to start risk management (check backend routes / payload).");
    } finally {
      setRiskBusy(false);
    }
  }

  async function onStopRisk() {
    setRiskBusy(true);
    try {
      await stopRiskManagement();
      await refreshRisk();
    } catch (e) {
      console.error(e);
      alert("Failed to stop risk management.");
    } finally {
      setRiskBusy(false);
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
      <Stack
        direction={{ xs: "column", sm: "row" }}
        alignItems={{ sm: "center" }}
        justifyContent="space-between"
        gap={1.5}
        sx={{ mb: 2 }}
      >
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 900 }}>
            Utility
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Quick actions + risk management guardrails.
          </Typography>
        </Box>

        <Stack direction="row" gap={1} alignItems="center">
          <Chip label={riskBadge.label} color={riskBadge.color} />
        </Stack>
      </Stack>

      <Grid container spacing={2}>
        {/* Utility section */}
        <Grid item xs={12} lg={6}>
          <Card sx={{ borderRadius: 3, height: "100%" }}>
            <CardContent>
              <Typography variant="subtitle1" sx={{ fontWeight: 900, mb: 1 }}>
                Utility Actions
              </Typography>
              <Divider sx={{ mb: 2 }} />

              <Alert icon={<WarningAmberRoundedIcon />} severity="warning" sx={{ mb: 2 }}>
                These actions can close/flatten positions. Use carefully.
              </Alert>

              <Grid container spacing={2}>
                <Grid item xs={12} sm={6}>
                  <TextField
                    fullWidth
                    label="Symbol"
                    value={symbol}
                    onChange={(e) => setSymbol(e.target.value)}
                  />
                </Grid>

                <Grid item xs={12} sm={6}>
                  <Stack direction="row" gap={1} sx={{ height: "100%" }} alignItems="center">
                    <Button
                      fullWidth
                      disabled={busy}
                      variant="outlined"
                      onClick={() => runAction(() => closePositionsBySymbol(symbol))}
                    >
                      Close Symbol
                    </Button>
                  </Stack>
                </Grid>

                <Grid item xs={12}>
                  <Stack direction={{ xs: "column", sm: "row" }} gap={1}>
                    <Button
                      disabled={busy}
                      variant="contained"
                      color="error"
                      onClick={() => runAction(() => closeAllPositions())}
                    >
                      Close ALL Positions
                    </Button>

                    <Button
                      disabled={busy}
                      variant="outlined"
                      onClick={() => runAction(() => closePositionsBySide("BUY"))}
                    >
                      Close BUYs
                    </Button>

                    <Button
                      disabled={busy}
                      variant="outlined"
                      onClick={() => runAction(() => closePositionsBySide("SELL"))}
                    >
                      Close SELLs
                    </Button>

                    <Button
                      disabled={busy}
                      variant="outlined"
                      onClick={() => runAction(() => flattenAllOrders())}
                    >
                      Flatten Orders
                    </Button>
                  </Stack>
                </Grid>
              </Grid>
            </CardContent>
          </Card>
        </Grid>

        {/* Risk section */}
        <Grid item xs={12} lg={6}>
          <Card sx={{ borderRadius: 3, height: "100%" }}>
            <CardContent>
              <Stack direction="row" alignItems="center" justifyContent="space-between">
                <Typography variant="subtitle1" sx={{ fontWeight: 900 }}>
                  Risk Management
                </Typography>

                <Stack direction="row" gap={1}>
                  <Button
                    onClick={onStartRisk}
                    disabled={riskBusy || running}
                    startIcon={<PlayArrowRoundedIcon />}
                    variant="contained"
                  >
                    Start
                  </Button>
                  <Button
                    onClick={onStopRisk}
                    disabled={riskBusy || !running}
                    startIcon={<StopRoundedIcon />}
                    variant="outlined"
                  >
                    Stop
                  </Button>
                </Stack>
              </Stack>

              <Divider sx={{ my: 2 }} />

              {riskStatus?.limit_hit ? (
                <Alert severity="error" sx={{ mb: 2 }}>
                  Risk limit hit: {riskStatus.reason ?? "Unknown"}.
                  {riskStatus?.action_taken ? ` Action: ${riskStatus.action_taken}.` : ""}
                </Alert>
              ) : (
                <Alert severity="info" sx={{ mb: 2 }}>
                  Configure guardrails. When a limit hits, strategy will be stopped automatically.
                </Alert>
              )}

              <Grid container spacing={2}>
                <Grid item xs={12} sm={6}>
                  <FormControlLabel
                    control={
                      <Switch
                        checked={cfg.enabled}
                        onChange={(e) => setCfg((s) => ({ ...s, enabled: e.target.checked }))}
                      />
                    }
                    label="Enable Risk Manager"
                  />
                </Grid>

                <Grid item xs={12} sm={6}>
                  <TextField
                    fullWidth
                    label="Symbol"
                    value={cfg.symbol}
                    onChange={(e) => setCfg((s) => ({ ...s, symbol: e.target.value }))}
                  />
                </Grid>

                <Grid item xs={12} sm={6}>
                  <TextField
                    fullWidth
                    label="Max Daily Loss"
                    value={cfg.maxDailyLoss}
                    onChange={(e) => setCfg((s) => ({ ...s, maxDailyLoss: e.target.value }))}
                    inputProps={{ inputMode: "decimal" }}
                    helperText="Account currency"
                  />
                </Grid>

                <Grid item xs={12} sm={6}>
                  <TextField
                    fullWidth
                    label="Max Drawdown"
                    value={cfg.maxDrawdown}
                    onChange={(e) => setCfg((s) => ({ ...s, maxDrawdown: e.target.value }))}
                    inputProps={{ inputMode: "decimal" }}
                    helperText="Account currency"
                  />
                </Grid>

                <Grid item xs={12} sm={6}>
                  <TextField
                    fullWidth
                    label="Stop After Profit"
                    value={cfg.stopAfterProfit}
                    onChange={(e) => setCfg((s) => ({ ...s, stopAfterProfit: e.target.value }))}
                    inputProps={{ inputMode: "decimal" }}
                    helperText="Account currency"
                  />
                </Grid>

                <Grid item xs={12} sm={6}>
                  <TextField
                    fullWidth
                    label="Max Open Positions"
                    value={cfg.maxOpenPositions}
                    onChange={(e) => setCfg((s) => ({ ...s, maxOpenPositions: e.target.value }))}
                    inputProps={{ inputMode: "numeric" }}
                  />
                </Grid>

                <Grid item xs={12}>
                  <Stack direction={{ xs: "column", sm: "row" }} gap={2}>
                    <FormControlLabel
                      control={
                        <Switch
                          checked={cfg.disableNewTradesOnLimit}
                          onChange={(e) =>
                            setCfg((s) => ({ ...s, disableNewTradesOnLimit: e.target.checked }))
                          }
                        />
                      }
                      label="Disable new trades on limit"
                    />

                    <FormControlLabel
                      control={
                        <Switch
                          checked={cfg.closePositionsOnLimit}
                          onChange={(e) =>
                            setCfg((s) => ({ ...s, closePositionsOnLimit: e.target.checked }))
                          }
                        />
                      }
                      label="Close positions on limit"
                    />
                  </Stack>
                </Grid>

                <Grid item xs={12}>
                  <Divider sx={{ my: 1.5 }} />
                  <Typography variant="body2" color="text.secondary">
                    Status: <b>{riskStatus?.running ? "Running" : "Stopped"}</b>
                    {" • "}Equity: <b>{riskStatus?.equity ?? "--"}</b>
                    {" • "}Balance: <b>{riskStatus?.balance ?? "--"}</b>
                    {" • "}Floating PnL: <b>{riskStatus?.floating_pnl ?? "--"}</b>
                    {" • "}Today PnL: <b>{riskStatus?.today_pnl ?? "--"}</b>
                  </Typography>
                </Grid>
              </Grid>
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
}
