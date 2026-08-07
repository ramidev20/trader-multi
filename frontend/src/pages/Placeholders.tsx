import React, { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bell,
  CheckCircle2,
  Gauge,
  Play,
  RefreshCcw,
  Server,
  Settings,
  StopCircle,
  Terminal,
  Trash2,
  Wrench,
  Info,
} from "lucide-react";
import { AppButton, Card, Dialog, Field } from "../components/ui/Primitives";
import { TableFrame } from "../components/ui/TableFrame";
import { LogList } from "../components/ui/LogList";
import { MetricCard } from "./shared/MetricCard";
import { cx, decimalInput, money } from "../utils/format";
import { api } from "../services/api";

export function TradePage({ runtime, onRefreshRuntime }) {
  const [side, setSide] = useState("BUY");
  const [tp, setTp] = useState("150");
  const [sl, setSl] = useState("600");
  const [multiTp, setMultiTp] = useState(false);
  const [slPrice, setSlPrice] = useState("");
  const [ratio, setRatio] = useState("3.0");
  const [tp2Enabled, setTp2Enabled] = useState(false);
  const [tp3Enabled, setTp3Enabled] = useState(false);
  const [tp1Percent, setTp1Percent] = useState("100");
  const [tp2Percent, setTp2Percent] = useState("100");
  const [errorText, setErrorText] = useState("");
  const [pendingSide, setPendingSide] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [positions, setPositions] = useState([]);
  const [positionsErrors, setPositionsErrors] = useState([]);
  const [spread, setSpread] = useState(null);
  const [positionsTab, setPositionsTab] = useState("live");
  const openOrders = useMemo(
    () => (runtime?.orders || []).filter((o) => o.status === "open"),
    [runtime],
  );
  const latestOrder = openOrders[openOrders.length - 1] || null;
  const manualPositionLogs = useMemo(
    () =>
      (runtime?.logs?.search || []).filter((line) =>
        /manual|multi.?tp|position/i.test(String(line)),
      ),
    [runtime],
  );

  useEffect(() => {
    if (!multiTp && tp3Enabled) setTp3Enabled(false);
    if (multiTp && tp2Enabled && !tp3Enabled && tp1Percent === "100")
      setTp1Percent("50");
    if (multiTp && tp3Enabled && tp2Percent === "100") setTp2Percent("50");
  }, [multiTp, tp2Enabled, tp3Enabled]);

  function SummaryCard({ label, value, hint, icon: Icon, tone = "slate" }) {
    const toneStyle = {
      slate: "bg-slate-100 text-slate-600",
      green: "bg-emerald-50 text-emerald-700",
      blue: "bg-blue-50 text-blue-700",
      red: "bg-rose-50 text-rose-700",
      amber: "bg-amber-50 text-amber-700",
    };

    return (
      <Card className="p-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-bold text-slate-500">{label}</p>
          <div className={cx("rounded-2xl p-2.5", toneStyle[tone])}>
            <Icon className="h-6 w-6" />
          </div>
        </div>
        <p className="mt-4 text-2xl font-black tracking-tight text-slate-950">
          {value}
        </p>
        {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
      </Card>
    );
  }

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
            : "flex h-[50px] w-full items-center justify-between rounded-[8px] border border-slate-200 bg-slate-50 px-4 text-sm font-semibold text-slate-700 transition hover:bg-white disabled:pointer-events-none disabled:opacity-60",
        )}
      >
        <span>{label}</span>
        <SwitchKnob checked={checked} />
      </button>
    );
  }

  function SideButton({ value, label, activeClassName, idleClassName }) {
    const isActive = side === value;
    return (
      <button
        type="button"
        disabled={submitting}
        onClick={() => {
          setSide(value);
          setPendingSide(value);
          setConfirmOpen(true);
        }}
        className={cx(
          "flex h-[50px] w-full items-center justify-center rounded-2xl border px-4 text-sm font-bold transition",
          isActive ? activeClassName : idleClassName,
        )}
      >
        {label}
      </button>
    );
  }

  async function loadPositions(options = {}) {
    const { silent = false } = options;
    try {
      const data = await api.livePositions();
      setPositions(Array.isArray(data?.positions) ? data.positions : []);
      setPositionsErrors(Array.isArray(data?.errors) ? data.errors : []);
      setSpread(data?.spread ?? null);
    } catch (error) {
      setErrorText(String(error?.message || error));
    }
  }

  useEffect(() => {
    loadPositions();
  }, []);

  async function refreshTradeData() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await onRefreshRuntime?.({ silent: true });
      await loadPositions({ silent: true });
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

  async function openPosition(orderSide) {
    if (submitting) return;
    setSubmitting(true);
    try {
      await api.openPosition({
        side: orderSide,
        tp: Number(tp || 0),
        sl: Number(sl || 0),
        tp_in_pips: true,
        sl_in_pips: true,
        advanced: multiTp,
        sl_price: multiTp ? Number(slPrice || 0) : null,
        ratio: Number(ratio || 0),
        tp2_enabled: tp2Enabled,
        tp3_enabled: tp3Enabled,
        tp1_percent: Number(tp1Percent || 0),
        tp2_percent: Number(tp2Percent || 0),
        symbol: "XAUUSD",
      });
      await onRefreshRuntime?.();
      await loadPositions({ silent: true });
      setErrorText("");
    } catch (error) {
      setErrorText(String(error?.message || error));
    } finally {
      setSubmitting(false);
    }
  }

  async function closePositions() {
    try {
      setCloseConfirmOpen(false);
      const response = await api.closePositions();
      await onRefreshRuntime?.();
      await loadPositions({ silent: true });
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
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          label="Open Orders"
          value={String(openOrders.length)}
          hint="Runtime positions"
          icon={Server}
          tone="blue"
        />
        <SummaryCard
          label="Strategy"
          value={runtime?.strategy?.running ? "Running" : "Idle"}
          hint="Search engine state"
          icon={Activity}
          tone={runtime?.strategy?.running ? "green" : "slate"}
        />
        <SummaryCard
          label="Spread"
          value={spread == null ? "-" : Number(spread).toFixed(2)}
          hint="Current spread estimate"
          icon={Gauge}
          tone="amber"
        />
        <SummaryCard
          label="Last Side"
          value={latestOrder ? String(latestOrder.side || "-") : "-"}
          hint="Most recent open order"
          icon={Terminal}
          tone={
            latestOrder?.side === "BUY"
              ? "green"
              : latestOrder?.side === "SELL"
                ? "red"
                : "slate"
          }
        />
      </section>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.65fr)_360px]">
        <Card className="flex min-h-[calc(100vh-180px)] flex-col">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1">
              {[
                ["live", "Live Positions"],
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
              <AppButton variant="soft" onClick={refreshTradeData} disabled={refreshing}>
                <RefreshCcw className={cx("h-4 w-4", refreshing && "animate-spin")} />
                {refreshing ? "Refreshing..." : "Refresh"}
              </AppButton>
            </div>
          </div>

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
          ) : (
            <LogList
              className="mt-4 min-h-[360px]"
              logs={manualPositionLogs}
              emptyMessage="[INFO] No manual-position watch logs yet."
            />
          )}
        </Card>

        <Card>
          <h3 className="text-lg font-black text-slate-950">Manual Trade</h3>
          <p className="mt-1 text-sm text-slate-500">
            Open a master position and auto-clone to enabled sub accounts.
          </p>
          <div className="mt-4 space-y-3">
            <div className="grid gap-3 md:grid-cols-2">
              <SideButton
                value="BUY"
                label="BUY"
                activeClassName="border-emerald-600 bg-emerald-600 text-white shadow-lg shadow-emerald-600/20"
                idleClassName="border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
              />
              <SideButton
                value="SELL"
                label="SELL"
                activeClassName="border-rose-600 bg-rose-600 text-white shadow-lg shadow-rose-600/20"
                idleClassName="border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100"
              />
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <Field
                label="Take Profit (Pips)"
                value={tp}
                onChange={(e) => setTp(e.target.value)}
                disabled={multiTp}
              />
              <Field
                label="Stop Loss (Pips)"
                value={sl}
                onChange={(e) => setSl(e.target.value)}
                disabled={multiTp}
              />
            </div>
            <div className={cx("space-y-3 border-t border-slate-200 pt-4")}>
              <div className="flex items-center justify-between gap-3">
                <h4 className="font-black text-slate-950">
                  Advanced Risk / Multi-TP
                </h4>
                <InlineSwitcher
                  compact
                  checked={multiTp}
                  onChange={setMultiTp}
                />
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <Field
                  label="Stop Loss Price"
                  value={slPrice}
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  onChange={(e) => setSlPrice(decimalInput(e.target.value))}
                  disabled={!multiTp}
                />
                <Field
                  label="Ratio"
                  value={ratio}
                  type="number"
                  min="0.5"
                  max="10"
                  step="0.5"
                  onChange={(e) => setRatio(decimalInput(e.target.value))}
                  disabled={!multiTp}
                />
              </div>
              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_140px] items-end">
                <InlineSwitcher
                  label="Enable TP2"
                  checked={tp2Enabled}
                  onChange={setTp2Enabled}
                  disabled={!multiTp}
                />
                <Field
                  label="TP1 %"
                  value={tp1Percent}
                  type="number"
                  min="1"
                  max="100"
                  onChange={(e) => setTp1Percent(e.target.value)}
                  disabled={!multiTp || !tp2Enabled}
                />
              </div>
              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_140px] items-end">
                <InlineSwitcher
                  label="Enable TP3"
                  checked={tp3Enabled}
                  onChange={setTp3Enabled}
                  disabled={!multiTp || !tp2Enabled}
                />
                <Field
                  label="TP2 %"
                  value={tp2Percent}
                  type="number"
                  min="1"
                  max="100"
                  onChange={(e) => setTp2Percent(e.target.value)}
                  disabled={!multiTp || !tp3Enabled}
                />
              </div>
            </div>
          </div>
        </Card>
      </div>

      <Dialog
        open={confirmOpen}
        title={`Confirm ${pendingSide || ""} Order`}
        onClose={() => {
          setConfirmOpen(false);
          setPendingSide(null);
        }}
      >
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            You are about to open a{" "}
            <span className="font-bold">{pendingSide || "BUY"}</span> order.
          </p>
          <div className="rounded-[8px] border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
            Lot:{" "}
            <span className="font-bold text-slate-950">Account setting</span>
            <br />
            {multiTp ? (
              <>
                Stop Loss:{" "}
                <span className="font-bold text-slate-950">
                  {slPrice || "-"}
                </span>
                <br />
                Ratio:{" "}
                <span className="font-bold text-slate-950">{ratio}R</span>
                <br />
                TP stages:{" "}
                <span className="font-bold text-slate-950">
                  {tp3Enabled ? "3" : tp2Enabled ? "2" : "1"}
                </span>
              </>
            ) : (
              <>
                TP: <span className="font-bold text-slate-950">{tp} pips</span>
                <br />
                SL: <span className="font-bold text-slate-950">{sl} pips</span>
              </>
            )}
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <AppButton
            variant="soft"
            onClick={() => {
              setConfirmOpen(false);
              setPendingSide(null);
            }}
          >
            Cancel
          </AppButton>
          <AppButton
            variant={pendingSide === "SELL" ? "red" : "green"}
            disabled={submitting}
            onClick={async () => {
              const chosenSide = pendingSide || "BUY";
              setConfirmOpen(false);
              setPendingSide(null);
              await openPosition(chosenSide);
            }}
          >
            {submitting ? "Opening..." : "Confirm"}
          </AppButton>
        </div>
      </Dialog>

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
      <p className="mt-1 text-sm text-slate-500">
        Monitor equity and enforce risk/profit boundaries.
      </p>
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
        <p className="mt-1 text-sm font-medium text-slate-500">
          Detailed balance and performance overview for every trading account.
        </p>
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
          <p className="mt-1 text-sm font-medium text-slate-500">
            System updates are preserved here for auditing and awareness.
          </p>
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
}) {
  const [defaults, setDefaults] = useState({
    autoStartMonitoring: false,
  });
  const [settingsTab, setSettingsTab] = useState(initialTab);
  useEffect(() => setSettingsTab(initialTab), [initialTab]);
  const settingsTabs = ["accounts", "search", "notifications", "appearance"];
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

  function SettingsSwitch({ label, value, onToggle }) {
    return (
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between rounded-[8px] border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700"
      >
        <span>{label}</span>
        <span
          className={cx(
            "relative inline-flex h-6 w-11 items-center rounded-full transition",
            value ? "bg-blue-600" : "bg-slate-300",
          )}
        >
          <span
            className={cx(
              "h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200",
              value ? "translate-x-6" : "translate-x-1",
            )}
          />
        </span>
      </button>
    );
  }

  if (settingsTab !== "accounts") {
    return (
      <div className="space-y-6">
        {tabNavigation}
        <Card>
          <h3 className="text-lg font-black capitalize text-slate-950">
            {settingsTab} Settings
          </h3>
          <p className="mt-1 text-sm text-slate-500">
            These settings are ready for configuration and will be persisted
            with the selected section.
          </p>
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
