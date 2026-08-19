import React, { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bell,
  CheckCircle2,
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
import { AppButton, Card, Dialog, Field, SelectBox } from "../components/ui/Primitives";
import { TableFrame } from "../components/ui/TableFrame";
import { LogList } from "../components/ui/LogList";
import { MetricCard } from "./shared/MetricCard";
import ChartPage from "./ChartPage";
import { cx, decimalInput, money } from "../utils/format";
import { api } from "../services/api";
import { isRemoteConnected, sendRemoteCommand } from "../services/remoteControl";

const TRADE_FORM_STORAGE_KEY = "trader.trade.form";

function loadTradeForm() {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(TRADE_FORM_STORAGE_KEY) || "{}");
    return saved && typeof saved === "object" ? saved : {};
  } catch {
    return {};
  }
}
export function TradePage({ runtime, onRefreshRuntime }) {
  const savedTradeForm = useMemo(loadTradeForm, []);
  const [side, setSide] = useState(() => savedTradeForm.side ?? "BUY");
  const [orderKind, setOrderKind] = useState(() => savedTradeForm.orderKind ?? "MARKET");
  const [limitPrice, setLimitPrice] = useState(() => savedTradeForm.limitPrice ?? "");
  const [tp, setTp] = useState(() => savedTradeForm.tp ?? "150");
  const [sl, setSl] = useState(() => savedTradeForm.sl ?? "600");
  const [spreadPips, setSpreadPips] = useState(() => savedTradeForm.spreadPips ?? "0");
  const [multiTp, setMultiTp] = useState(() => Boolean(savedTradeForm.multiTp));
  const [slPrice, setSlPrice] = useState(() => savedTradeForm.slPrice ?? "");
  const [tp1Ratio, setTp1Ratio] = useState(() => savedTradeForm.tp1Ratio ?? "1.0");
  const [tp2Ratio, setTp2Ratio] = useState(() => savedTradeForm.tp2Ratio ?? "1.0");
  const [tp3Ratio, setTp3Ratio] = useState(() => savedTradeForm.tp3Ratio ?? "1.0");
  const [tp2Enabled, setTp2Enabled] = useState(() => Boolean(savedTradeForm.tp2Enabled));
  const [tp3Enabled, setTp3Enabled] = useState(() => Boolean(savedTradeForm.tp3Enabled));
  const [tp1Percent, setTp1Percent] = useState(() => savedTradeForm.tp1Percent ?? "100");
  const [tp2Percent, setTp2Percent] = useState(() => savedTradeForm.tp2Percent ?? "100");
  const [autoCloseEnabled, setAutoCloseEnabled] = useState(() => Boolean(savedTradeForm.autoCloseEnabled));
  const [autoCloseAt, setAutoCloseAt] = useState(() => savedTradeForm.autoCloseAt ?? defaultAutoCloseValue());
  const [errorText, setErrorText] = useState("");
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [positions, setPositions] = useState([]);
  const [positionsErrors, setPositionsErrors] = useState([]);
  const [limitOrders, setLimitOrders] = useState([]);
  const [limitOrdersErrors, setLimitOrdersErrors] = useState([]);
  const [positionsTab, setPositionsTab] = useState(() => savedTradeForm.tradeTab ?? savedTradeForm.positionsTab ?? "chart");
  const openOrders = useMemo(
    () => (runtime?.orders || []).filter((o) => o.status === "open"),
    [runtime],
  );
  const latestOrder = openOrders[openOrders.length - 1] || null;
  const tradeFeedLogs = useMemo(() => {
    const tradeLogPattern = /manual|order|position|limit|close|auto close|tp\d?|take profit|stop loss|trade/i;
    const runtimeLogs = (runtime?.logs?.search || []).filter((line) => tradeLogPattern.test(String(line)));
    const openOrderLogs = openOrders.filter((order) => String(order.order_kind || "").toUpperCase() !== "LIMIT").map((order) => {
      const kind = String(order.order_kind || "MARKET").toUpperCase();
      const sideLabel = String(order.side || "-").toUpperCase();
      const entry = Number(order.entry ?? order.price ?? 0) || 0;
      return `[INFO] ${kind} ${sideLabel} ${order.symbol || "XAUUSD"} @ ${entry.toFixed(2)} lot=${Number(order.lot || 0).toFixed(2)} status=${order.status || "open"}`;
    });
    const pendingOrderLogs = limitOrders.map((order) => {
      const sideLabel = String(order.side || "-").toUpperCase();
      const entry = Number(order.price ?? order.entry ?? 0) || 0;
      return `[INFO] LIMIT ${sideLabel} ${order.symbol || "XAUUSD"} @ ${entry.toFixed(2)} lot=${Number(order.lot || 0).toFixed(2)} ticket=${order.ticket || "-"}`;
    });
    return [...runtimeLogs, ...openOrderLogs, ...pendingOrderLogs].slice(-120).reverse();
  }, [runtime, openOrders, limitOrders]);
  const totalRatio = useMemo(() => {
    let total = Number(tp1Ratio || 0);
    if (tp2Enabled) total += Number(tp2Ratio || 0);
    if (tp3Enabled) total += Number(tp3Ratio || 0);
    return total;
  }, [tp1Ratio, tp2Enabled, tp2Ratio, tp3Enabled, tp3Ratio]);
  const scheduledAutoCloseAt = runtime?.manual_trade?.auto_close_at || null;
  const displayedLimitOrders = limitOrders.length
    ? limitOrders
    : (runtime?.orders || []).filter((order) =>
        String(order?.status || "").toLowerCase() === "open" &&
        String(order?.order_kind || "").toUpperCase() === "LIMIT",
      );

  useEffect(() => {
    try {
      globalThis.localStorage?.setItem(TRADE_FORM_STORAGE_KEY, JSON.stringify({
        side,
        orderKind,
        limitPrice,
        tp,
        sl,
        spreadPips,
        multiTp,
        slPrice,
        tp1Ratio,
        tp2Ratio,
        tp3Ratio,
        tp2Enabled,
        tp3Enabled,
        tp1Percent,
        tp2Percent,
        autoCloseEnabled,
        autoCloseAt,
        positionsTab,
        tradeTab: positionsTab,
      }));
    } catch {
      // Keep the trade form usable when browser storage is unavailable.
    }
  }, [side, orderKind, limitPrice, tp, sl, spreadPips, multiTp, slPrice, tp1Ratio, tp2Ratio, tp3Ratio, tp2Enabled, tp3Enabled, tp1Percent, tp2Percent, autoCloseEnabled, autoCloseAt, positionsTab]);

  useEffect(() => {
    const persistTradeForm = () => {
      try {
        globalThis.localStorage?.setItem(TRADE_FORM_STORAGE_KEY, JSON.stringify({
          side,
          orderKind,
          limitPrice,
          tp,
          sl,
          spreadPips,
          multiTp,
          slPrice,
          tp1Ratio,
          tp2Ratio,
          tp3Ratio,
          tp2Enabled,
          tp3Enabled,
          tp1Percent,
          tp2Percent,
          autoCloseEnabled,
          autoCloseAt,
          positionsTab,
          tradeTab: positionsTab,
        }));
      } catch {
        // Ignore storage failures during shutdown or private browsing.
      }
    };

    window.addEventListener("beforeunload", persistTradeForm);
    window.addEventListener("pagehide", persistTradeForm);
    return () => {
      persistTradeForm();
      window.removeEventListener("beforeunload", persistTradeForm);
      window.removeEventListener("pagehide", persistTradeForm);
    };
  }, [side, orderKind, limitPrice, tp, sl, spreadPips, multiTp, slPrice, tp1Ratio, tp2Ratio, tp3Ratio, tp2Enabled, tp3Enabled, tp1Percent, tp2Percent, autoCloseEnabled, autoCloseAt, positionsTab]);

  useEffect(() => {
    if (!multiTp && tp3Enabled) setTp3Enabled(false);
    if (multiTp && tp2Enabled && !tp3Enabled && tp1Percent === "100")
      setTp1Percent("50");
    if (multiTp && tp3Enabled && tp2Percent === "100") setTp2Percent("50");
  }, [multiTp, tp2Enabled, tp3Enabled]);

  useEffect(() => {
    if (!scheduledAutoCloseAt) return;
    const dt = new Date(scheduledAutoCloseAt);
    if (Number.isNaN(dt.getTime())) return;
    setAutoCloseEnabled(true);
    setAutoCloseAt(toDateTimeLocalValue(dt));
  }, [scheduledAutoCloseAt]);

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
            : "flex min-w-0 h-[50px] w-full items-center justify-between rounded-[8px] border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-slate-700 transition hover:bg-white disabled:pointer-events-none disabled:opacity-60 sm:px-4",
        )}
      >
        <span className="min-w-0 text-left leading-tight">{label}</span>
        <SwitchKnob checked={checked} />
      </button>
    );
  }

  function SideButton({ value, label, activeClassName, idleClassName }) {
    const isActive = side === value;
    const busy = submitting && isActive;
    const actionLabel = orderKind === "LIMIT" ? "Pending limit order" : "Market execution";
    return (
      <button
        type="button"
        disabled={submitting}
        onClick={() => {
          setSide(value);
          openPosition(value);
        }}
        className={cx(
          "flex min-h-[64px] w-full flex-col items-center justify-center rounded-2xl border px-4 py-2 text-sm font-bold transition",
          isActive ? activeClassName : idleClassName,
        )}
      >
        <span className="text-[15px] leading-none">{busy ? `OPENING ${label}...` : `OPEN ${label}`}</span>
        <span className={cx("mt-1 text-[11px] font-semibold tracking-wide", isActive ? "text-white/85" : "text-slate-600")}>
          {actionLabel}
        </span>
      </button>
    );
  }

  async function loadPositions(options = {}) {
    const { silent = false } = options;
    try {
      const data = await api.livePositions();
      setPositions(Array.isArray(data?.positions) ? data.positions : []);
      setPositionsErrors(Array.isArray(data?.errors) ? data.errors : []);
    } catch (error) {
      setErrorText(String(error?.message || error));
    }
  }

  async function loadLimitOrders(options = {}) {
    const { silent = false } = options;
    try {
      const data = await api.liveOrders();
      setLimitOrders(Array.isArray(data?.orders) ? data.orders : []);
      setLimitOrdersErrors(Array.isArray(data?.errors) ? data.errors : []);
    } catch (error) {
      if (!silent) {
        setErrorText(String(error?.message || error));
      }
    }
  }

  useEffect(() => {
    loadPositions();
    loadLimitOrders();
  }, []);

  async function refreshTradeData() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await onRefreshRuntime?.({ silent: true });
      await loadPositions({ silent: true });
      await loadLimitOrders({ silent: true });
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
    if (autoCloseEnabled && !autoCloseAt) {
      setErrorText("Choose an end time for auto close.");
      return;
    }
    setSubmitting(true);
    try {
      const orderPayload = {
        side: orderSide,
        order_kind: orderKind,
        limit_price: orderKind === "LIMIT" ? Number(limitPrice || 0) : null,
        tp: Number(tp || 0),
        sl: Number(sl || 0),
        spread_pips: Number(spreadPips || 0),
        tp_in_pips: true,
        sl_in_pips: true,
        advanced: multiTp,
        sl_price: multiTp ? Number(slPrice || 0) : null,
        ratio: totalRatio,
        tp1_ratio: Number(tp1Ratio || 0),
        tp2_ratio: Number(tp2Ratio || 0),
        tp3_ratio: Number(tp3Ratio || 0),
        tp2_enabled: tp2Enabled,
        tp3_enabled: tp3Enabled,
        tp1_percent: Number(tp1Percent || 0),
        tp2_percent: Number(tp2Percent || 0),
        auto_close_at: autoCloseEnabled ? new Date(autoCloseAt).toISOString() : null,
        symbol: "XAUUSD",
      };
      await api.openPosition(orderPayload);
      if (isRemoteConnected()) {
        const { risk_percent, riskPercent, ...receiverPayload } = orderPayload;
        try {
          await sendRemoteCommand("open", receiverPayload);
        } catch (error) {
          throw new Error(`Order opened locally, but PC B did not mirror it: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      await onRefreshRuntime?.();
      await loadPositions({ silent: true });
      await loadLimitOrders({ silent: true });
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
      if (isRemoteConnected()) {
        try {
          await sendRemoteCommand("close_all", {});
        } catch (error) {
          throw new Error(`Positions closed locally, but PC B did not receive the close request: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      await onRefreshRuntime?.();
      await loadPositions({ silent: true });
      await loadLimitOrders({ silent: true });
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
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.65fr)_360px]">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1">
              {[
                ["chart", "Chart"],
                ["live", "Live Positions"],
                ["orders", "Limit Orders"],
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

          {positionsTab === "orders" && limitOrdersErrors.length ? (
            <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
              {limitOrdersErrors.join(" • ")}
            </div>
          ) : null}

          {positionsTab === "chart" ? (
            <ChartPage />
          ) : (
            <Card className="flex min-h-[calc(100vh-180px)] flex-col">
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
              ) : positionsTab === "orders" ? (
                <TableFrame className="mt-4 min-h-[360px]">
                  <table className="h-full w-full min-w-[760px] text-left">
                    <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="py-3 pl-4 pr-3 font-bold">Account</th>
                        <th className="px-3 py-3 font-bold">Ticket</th>
                        <th className="px-3 py-3 font-bold">Side</th>
                        <th className="px-3 py-3 font-bold">Price</th>
                        <th className="px-3 py-3 font-bold">Lot</th>
                        <th className="px-3 py-3 font-bold">Time</th>
                        <th className="py-3 pl-3 pr-4 font-bold">Comment</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 bg-white">
                      {(displayedLimitOrders.length
                        ? displayedLimitOrders
                        : [
                            {
                              ticket: "empty",
                              account_name: "-",
                              account_login: "-",
                              side: "-",
                              price: "-",
                              lot: "-",
                              opened_at: "-",
                              comment: "No pending limit orders.",
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
                          <td className="px-3 py-3 text-sm text-slate-700">
                            {row.ticket}
                          </td>
                          <td className="px-3 py-3 text-sm">
                            <span
                              className={cx(
                                "rounded-full px-2 py-0.5 text-[10px] font-bold",
                                row.side === "BUY"
                                  ? "bg-emerald-100 text-emerald-700"
                                  : "bg-rose-100 text-rose-700",
                              )}
                            >
                              {row.side}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-sm text-slate-700">
                            {row.price ?? row.open_price ?? "-"}
                          </td>
                          <td className="px-3 py-3 text-sm text-slate-700">
                            {row.lot}
                          </td>
                          <td className="px-3 py-3 text-sm text-slate-700">
                            {fmtDateTime(row.opened_at)}
                          </td>
                          <td className="py-3 pl-3 pr-4 text-sm text-slate-700">
                            {row.comment || "-"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableFrame>
              ) : (
                <LogList
                  className="mt-4 min-h-[360px]"
                  logs={tradeFeedLogs}
                  emptyMessage="[INFO] No trade activity logs yet."
                />
              )}
            </Card>
          )}
        </div>
        <div className="space-y-6">
          <Card>
            <h3 className="text-lg font-black text-slate-950">Manual Trade</h3>
            <p className="mt-1 text-sm text-slate-500">
              Open a master position and auto-clone to enabled sub accounts.
            </p>
            <div className="mt-4 space-y-3">
            <div className="grid gap-3 md:grid-cols-2">
              <SelectBox
                label="Order Type"
                value={orderKind}
                options={["MARKET", "LIMIT"]}
                onChange={(e) => setOrderKind(e.target.value)}
              />
              <Field
                label={orderKind === "LIMIT" ? "Limit Entry Price" : "Entry Mode"}
                value={orderKind === "LIMIT" ? limitPrice : "Market execution"}
                type={orderKind === "LIMIT" ? "number" : "text"}
                min="0"
                step="0.01"
                inputMode="decimal"
                onChange={
                  orderKind === "LIMIT"
                    ? (e) => setLimitPrice(decimalInput(e.target.value))
                    : undefined
                }
                disabled={orderKind !== "LIMIT"}
              />
            </div>
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
            <div className="grid gap-3 md:grid-cols-3">
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
              <Field
                label="Spread (Pips)"
                value={spreadPips}
                onChange={(e) => setSpreadPips(decimalInput(e.target.value))}
              />
            </div>
            <div className="space-y-3 rounded-[8px] border border-slate-200 bg-slate-50 p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h4 className="font-black text-slate-950">Auto Close All Positions</h4>
                  <p className="text-xs font-medium text-slate-500">
                    Close all open positions automatically at the selected end time.
                  </p>
                </div>
                <InlineSwitcher compact checked={autoCloseEnabled} onChange={setAutoCloseEnabled} />
              </div>
              <Field
                label="End Time"
                value={autoCloseAt}
                type="datetime-local"
                onChange={(e) => setAutoCloseAt(e.target.value)}
                disabled={!autoCloseEnabled}
              />
              {scheduledAutoCloseAt ? (
                <p className="text-xs font-semibold text-slate-600">
                  Scheduled auto close: {fmtDateTime(scheduledAutoCloseAt)}
                </p>
              ) : null}
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
                  label="Total Ratio"
                  value={String(totalRatio || 0)}
                  type="number"
                  step="0.1"
                  disabled
                />
              </div>
              <p className="text-xs font-medium text-slate-500">
                Spread pips are added to the final stop loss distance for both pip-based and price-based SL.
              </p>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-3 items-end">
                <Field
                  label="TP1 Ratio"
                  value={tp1Ratio}
                  type="number"
                  min="0.1"
                  step="0.1"
                  onChange={(e) => setTp1Ratio(decimalInput(e.target.value))}
                  disabled={!multiTp}
                />
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
              <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-3 items-end">
                <Field
                  label="TP2 Ratio"
                  value={tp2Ratio}
                  type="number"
                  min="0.1"
                  step="0.1"
                  onChange={(e) => setTp2Ratio(decimalInput(e.target.value))}
                  disabled={!multiTp || !tp2Enabled}
                />
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
                <Field
                  label="TP3 Ratio"
                  value={tp3Ratio}
                  type="number"
                  min="0.1"
                  step="0.1"
                  onChange={(e) => setTp3Ratio(decimalInput(e.target.value))}
                  disabled={!multiTp || !tp3Enabled}
                />
              </div>
            </div>
            </div>
          </Card>
        </div>
      </div>

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

function toDateTimeLocalValue(value) {
  const dt = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(dt.getTime())) return "";
  const local = new Date(dt.getTime() - dt.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function defaultAutoCloseValue() {
  return toDateTimeLocalValue(new Date(Date.now() + 60 * 60 * 1000));
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
  notificationSettings = { enabled: true, show_warnings: true, show_success: true, show_info: false },
  onNotificationSettingsChange,
  themeMode = "LIGHT",
  onThemeModeChange,
  uiZoomPercent = 100,
  onUiZoomPercentChange,
}) {
  const settingsTabs = ["accounts", "search", "notifications", "appearance"];
  const normalizeSettingsTab = (tab) => settingsTabs.includes(tab) ? tab : "accounts";
  const [settingsTab, setSettingsTab] = useState(normalizeSettingsTab(initialTab));
  const [searchSettings, setSearchSettings] = useState({ timeframe: "M1", pips: 25, max_pips: 70, max_positions: 3, orders_limit: 10, tp: 150, sl: 500, enable_buy: true, enable_sell: true, enable_liquidity: true, enable_pullback: false, pullback_pips: 20, stop_on_first_close: true });
  const [settingsMessage, setSettingsMessage] = useState("");
  useEffect(() => setSettingsTab(normalizeSettingsTab(initialTab)), [initialTab]);
  useEffect(() => {
    api.settings().then((settings) => {
      if (settings?.search_config) setSearchSettings((current) => ({ ...current, ...settings.search_config }));
    }).catch(() => {});
  }, []);

  async function saveSearchSettings() {
    try {
      await api.saveSearchConfig(searchSettings);
      setSettingsMessage("Search defaults saved. New searches will use these values.");
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveNotificationSettings(nextSettings) {
    try {
      await api.saveNotificationSettings(nextSettings);
      onNotificationSettingsChange?.(nextSettings);
      setSettingsMessage("Notification preferences saved.");
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveThemeMode(nextThemeMode) {
    try {
      await api.saveTheme(nextThemeMode);
      onThemeModeChange?.(nextThemeMode);
      setSettingsMessage(`${nextThemeMode === "DARK" ? "Dark" : "Light"} appearance saved.`);
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : String(error));
    }
  }
  async function saveUiZoom(nextZoom) {
    const zoom = Math.min(150, Math.max(70, Number(nextZoom || 100)));
    onUiZoomPercentChange?.(zoom);
    try {
      await api.saveZoom(zoom);
      setSettingsMessage(`App zoom saved at ${zoom}%.`);
    } catch (error) {
      setSettingsMessage(error instanceof Error ? error.message : String(error));
    }
  }
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

  if (settingsTab !== "accounts") {
    return (
      <div className="space-y-6">
        {tabNavigation}
        <Card>
          {settingsTab === "search" ? <>
            <h3 className="text-lg font-black text-slate-950">Search Defaults</h3>
            <p className="mt-1 text-sm text-slate-500">These values are used when you start or save a Search configuration.</p>
            <div className="mt-6 grid gap-4 md:grid-cols-3">
              <label className="text-sm font-bold text-slate-700">Timeframe<select value={searchSettings.timeframe} onChange={(event) => setSearchSettings({ ...searchSettings, timeframe: event.target.value })} className="mt-2 h-11 w-full rounded-xl border border-slate-200 bg-white px-3 font-semibold"><option>M1</option><option>M3</option><option>M5</option><option>M15</option></select></label>
              {[['pips', 'Minimum Pips'], ['max_pips', 'Maximum Pips'], ['max_positions', 'Maximum Positions'], ['orders_limit', 'Search Order Limit'], ['tp', 'Take Profit'], ['sl', 'Stop Loss'], ['pullback_pips', 'Pullback Pips']].map(([key, label]) => <label key={key} className="text-sm font-bold text-slate-700">{label}<input type="number" min="0" value={searchSettings[key] ?? ""} onChange={(event) => setSearchSettings({ ...searchSettings, [key]: Number(event.target.value) })} className="mt-2 h-11 w-full rounded-xl border border-slate-200 bg-white px-3 font-semibold" /></label>)}
            </div>
            <div className="mt-5 flex flex-wrap gap-5 text-sm font-bold text-slate-700">
              {[['enable_buy', 'Enable BUY'], ['enable_sell', 'Enable SELL'], ['enable_liquidity', 'Liquidity trigger'], ['enable_pullback', 'Enable pullback'], ['stop_on_first_close', 'Stop after first close']].map(([key, label]) => <label key={key} className="flex items-center gap-2"><input type="checkbox" checked={Boolean(searchSettings[key])} onChange={(event) => setSearchSettings({ ...searchSettings, [key]: event.target.checked })} />{label}</label>)}
            </div>
            <AppButton variant="blue" className="mt-6" onClick={saveSearchSettings}>Save Search Defaults</AppButton>
          </> : null}

          {settingsTab === "notifications" ? <>
            <h3 className="text-lg font-black text-slate-950">Notification Preferences</h3>
            <p className="mt-1 text-sm text-slate-500">Choose which backend events appear in the notification bell and notification page.</p>
            <div className="mt-6 space-y-4">
              {[['enabled', 'Enable notifications', 'Show notifications from account, search, remote, and risk events.'], ['show_warnings', 'Show warnings', 'Include account disconnects, blocked commands, and warning events.'], ['show_success', 'Show successful actions', 'Include successful orders, connections, and completed commands.'], ['show_info', 'Show informational updates', 'Include routine system information messages.']].map(([key, label, help]) => <label key={key} className="flex items-start justify-between gap-4 rounded-2xl border border-slate-200 p-4"><span><span className="block text-sm font-black text-slate-900">{label}</span><span className="mt-1 block text-xs leading-5 text-slate-500">{help}</span></span><input type="checkbox" checked={Boolean(notificationSettings[key])} onChange={(event) => saveNotificationSettings({ ...notificationSettings, [key]: event.target.checked })} className="mt-1 h-4 w-4" /></label>)}
            </div>
          </> : null}

          {settingsTab === "appearance" ? <>
            <h3 className="text-lg font-black text-slate-950">Appearance</h3>
            <p className="mt-1 text-sm text-slate-500">The selected appearance is applied immediately and saved for the next launch.</p>
            <div className="mt-6 grid max-w-xl gap-3 sm:grid-cols-2">
              {[['LIGHT', 'Light', 'Clean, high-contrast workspace for daytime trading.'], ['DARK', 'Dark', 'Reduced glare for low-light trading sessions.']].map(([mode, label, help]) => <button key={mode} type="button" onClick={() => saveThemeMode(mode)} className={cx("rounded-2xl border p-4 text-left transition", themeMode === mode ? "border-blue-500 bg-blue-50" : "border-slate-200 bg-white hover:border-slate-300")}><span className="block text-sm font-black text-slate-950">{label}</span><span className="mt-1 block text-xs leading-5 text-slate-500">{help}</span></button>)}
            </div>
            <div className="mt-7 max-w-xl rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <span className="block text-sm font-black text-slate-950">App zoom</span>
                  <span className="mt-1 block text-xs leading-5 text-slate-500">Scale the entire interface like browser zoom.</span>
                </div>
                <output className="min-w-14 rounded-lg bg-white px-3 py-1.5 text-center text-sm font-black text-blue-600">{uiZoomPercent}%</output>
              </div>
              <input aria-label="App zoom" className="mt-4 w-full accent-blue-600" type="range" min="70" max="150" step="5" value={uiZoomPercent} onChange={(event) => onUiZoomPercentChange?.(Number(event.target.value))} onPointerUp={(event) => saveUiZoom(event.currentTarget.value)} onKeyUp={(event) => saveUiZoom(event.currentTarget.value)} />
              <div className="mt-2 flex justify-between text-[11px] font-bold text-slate-500"><span>70%</span><button type="button" className="text-blue-600 hover:text-blue-700" onClick={() => saveUiZoom(100)}>Reset to 100%</button><span>150%</span></div>
            </div>
          </> : null}
          {settingsMessage ? <p className="mt-5 text-sm font-semibold text-emerald-700">{settingsMessage}</p> : null}
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
