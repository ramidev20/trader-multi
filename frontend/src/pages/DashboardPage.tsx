import React, { useMemo, useState } from "react";
import {
  Activity,
  CircleDollarSign,
  Gauge,
  Percent,
  Play,
  Server,
  SlidersHorizontal,
  Terminal,
  TrendingDown,
} from "lucide-react";
import { cx, money } from "../utils/format";
import { AppButton, Card } from "../components/ui/Primitives";
import { TableFrame } from "../components/ui/TableFrame";
import { ColorType, createChart, LineSeries } from "lightweight-charts";
import { useEffect, useRef } from "react";

function TradingViewProgressChart({ data }) {
  const containerRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current) return undefined;
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#f8fafc" },
        textColor: "#64748b",
      },
      grid: {
        vertLines: { color: "#e2e8f0" },
        horzLines: { color: "#e2e8f0" },
      },
      rightPriceScale: { borderColor: "#cbd5e1", autoScale: true },
      timeScale: { borderColor: "#cbd5e1", timeVisible: false, rightOffset: 6 },
      crosshair: { mode: 0 },
    });
    const balance = chart.addSeries(LineSeries, {
      color: "#2563eb",
      lineWidth: 2,
    });
    const equity = chart.addSeries(LineSeries, {
      color: "#059669",
      lineWidth: 2,
    });
    balance.setData(
      data.map((point) => ({ time: point.time, value: point.balance })),
    );
    equity.setData(
      data.map((point) => ({ time: point.time, value: point.equity })),
    );
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [data]);

  return (
    <div
      ref={containerRef}
      className="h-[400px] w-full rounded-2xl bg-slate-50"
    />
  );
}

function MetricCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = "slate",
  valueClassName = "",
}) {
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
      <p
        className={cx(
          "mt-4 text-2xl font-black tracking-tight text-slate-950",
          valueClassName,
        )}
      >
        {value}
      </p>
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </Card>
  );
}

function AccountHierarchy({ accountsData }) {
  return (
    <Card>
      <h3 className="text-lg font-black text-slate-950">Account Hierarchy</h3>
      <p className="mb-4 text-sm text-slate-500">
        Master account controls copy execution.
      </p>

      <div className="space-y-4">
        {accountsData.map((account) => (
          <div
            key={account.id}
            className={cx(
              "relative",
              account.role === "SUB" &&
                "ml-8 border-l border-dashed border-slate-300 pl-5",
            )}
          >
            {account.role === "SUB" && (
              <span className="absolute -left-[5px] top-5 h-2 w-2 rounded-full bg-slate-300" />
            )}
            <div className="flex items-center gap-3 rounded-2xl bg-slate-50 p-3">
              <div
                className={cx(
                  "grid h-10 w-10 place-items-center rounded-2xl bg-gradient-to-br text-xs font-black text-white shadow-sm",
                  account.color,
                )}
              >
                {(account.name || "A").charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold text-slate-900">
                  {account.name}
                </p>
                <p className="truncate text-xs text-slate-500">
                  Login {account.login}
                </p>
              </div>
              <span
                className={cx(
                  "h-2.5 w-2.5 rounded-full",
                  account.status === "Connected"
                    ? "bg-emerald-500"
                    : "bg-rose-500",
                )}
              />
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function AccountProgressTab({ accountsData }) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [progressRange, setProgressRange] = useState("monthly");
  const selected = accountsData[selectedIndex] || accountsData[0];

  if (!selected) {
    return (
      <Card>
        <p className="text-sm text-slate-500">No accounts available.</p>
      </Card>
    );
  }

  const rangeOptions = [
    { key: "weekly", label: "Weekly (Last Week)" },
    { key: "monthly", label: "Monthly (Last Month)" },
    { key: "3m", label: "Last 3 Months" },
    { key: "6m", label: "Last 6 Months" },
    { key: "year", label: "Last Year" },
    { key: "full", label: "Full Progress" },
  ];

  const datePoints = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let start;
    let end;

    if (progressRange === "weekly") {
      end = new Date(today);
      start = new Date(today);
      start.setDate(start.getDate() - 6);
    } else if (progressRange === "monthly") {
      const prevMonthLastDay = new Date(
        today.getFullYear(),
        today.getMonth(),
        0,
      );
      end = new Date(prevMonthLastDay);
      start = new Date(
        prevMonthLastDay.getFullYear(),
        prevMonthLastDay.getMonth(),
        1,
      );
    } else if (progressRange === "3m") {
      end = new Date(today);
      start = new Date(today);
      start.setDate(start.getDate() - 89);
    } else if (progressRange === "6m") {
      end = new Date(today);
      start = new Date(today);
      start.setDate(start.getDate() - 179);
    } else if (progressRange === "year") {
      end = new Date(today);
      start = new Date(today);
      start.setDate(start.getDate() - 364);
    } else {
      end = new Date(today);
      start = new Date(today);
      start.setDate(start.getDate() - 729);
    }

    const arr = [];
    const cursor = new Date(start);
    while (cursor <= end) {
      arr.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    return arr;
  }, [progressRange]);

  const dayLabels = datePoints.map((d) => String(d.getDate()));
  const targetBalance = selected.balance;
  const baseBalance =
    targetBalance - Math.max(Math.abs(selected.pnl) * 1.8, 1100);
  const balanceSeries = dayLabels.map((_, i) => {
    const t = i / (dayLabels.length - 1 || 1);
    const eased = t * t * (3 - 2 * t);
    return baseBalance + (targetBalance - baseBalance) * eased;
  });
  const provisionalEquity = balanceSeries.map((v, i) => {
    const wave =
      Math.sin((i / (dayLabels.length - 1 || 1)) * Math.PI * 1.2) *
      Math.max(Math.abs(selected.pnl) * 0.1, 95);
    const offset = Math.max(Math.abs(selected.pnl) * 0.15, 110);
    return v + offset + wave;
  });
  const equityDelta =
    selected.equity - provisionalEquity[provisionalEquity.length - 1];
  const equitySeries = provisionalEquity.map(
    (v, i) => v + equityDelta * (i / (provisionalEquity.length - 1 || 1)),
  );
  const chartData = datePoints.map((date, index) => ({
    time: Math.floor(date.getTime() / 1000),
    date: `${date.getMonth() + 1}/${date.getDate()}`,
    balance: balanceSeries[index],
    equity: equitySeries[index],
  }));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setSelectedIndex((i) => Math.max(0, i - 1))}
          className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-bold text-slate-600"
        >
          &larr;
        </button>
        <div className="flex-1 overflow-x-auto">
          <div className="flex min-w-max gap-3">
            {accountsData.map((a, i) => (
              <button
                key={a.id}
                onClick={() => setSelectedIndex(i)}
                className={cx(
                  "flex items-center gap-3 rounded-2xl border px-3 py-2 text-left transition",
                  i === selectedIndex
                    ? "border-blue-600 bg-white text-slate-900 shadow-sm shadow-blue-200"
                    : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
                )}
              >
                <div
                  className={cx(
                    "grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br text-xs font-black text-white",
                    a.color,
                  )}
                >
                  {(a.name || "A").charAt(0).toUpperCase()}
                </div>
                <span
                  className="max-w-[170px] text-sm font-bold leading-4"
                  style={{
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                  }}
                >
                  {a.name}
                </span>
              </button>
            ))}
          </div>
        </div>
        <button
          onClick={() =>
            setSelectedIndex((i) => Math.min(accountsData.length - 1, i + 1))
          }
          className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-bold text-slate-600"
        >
          &rarr;
        </button>
      </div>

      <div className="grid gap-3 grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
        <MetricCard
          label="Balance"
          value={money(selected.balance)}
          hint=""
          icon={CircleDollarSign}
          tone="blue"
        />
        <MetricCard
          label="Equity"
          value={money(selected.equity)}
          hint=""
          icon={Gauge}
          tone="amber"
        />
        <MetricCard
          label="Profit"
          value={`${selected.pnl >= 0 ? "+" : ""}${money(selected.pnl)}`}
          hint=""
          icon={Activity}
          tone="green"
          valueClassName={
            selected.pnl >= 0 ? "text-emerald-600" : "text-rose-600"
          }
        />
        <MetricCard
          label="Drawdown"
          value={`${(Math.max(0, (selected.balance - selected.equity) / Math.max(selected.balance, 1)) * 100).toFixed(2)}%`}
          hint=""
          icon={TrendingDown}
          tone="red"
        />
        <MetricCard
          label="Win Rate"
          value={`${Math.max(35, Math.min(92, Math.round(58 + selected.pnl / 120))).toString()}%`}
          hint=""
          icon={Percent}
          tone="blue"
        />
      </div>

      <Card className="min-h-[500px]">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-lg font-black text-slate-950">
            Balance / Equity Chart
          </h3>
          <div className="ml-auto flex items-center gap-3">
            <select
              value={progressRange}
              onChange={(e) => setProgressRange(e.target.value)}
              className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            >
              {rangeOptions.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
            <div className="flex items-center gap-4 text-xs font-bold">
              <span className="inline-flex items-center gap-1 text-blue-700">
                <span className="h-2 w-2 rounded-full bg-blue-600" /> Balance
              </span>
              <span className="inline-flex items-center gap-1 text-emerald-700">
                <span className="h-2 w-2 rounded-full bg-emerald-600" /> Equity
              </span>
            </div>
          </div>
        </div>
        <TradingViewProgressChart data={chartData} />
      </Card>
    </div>
  );
}

export default function DashboardPage({
  totals,
  accountsData,
  onAdd,
  onConnect,
}) {
  const [dashboardTab, setDashboardTab] = useState("login");

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center gap-2 border-b border-slate-200">
        <button
          onClick={() => setDashboardTab("login")}
          className={cx(
            "relative px-3 py-4 text-sm font-bold",
            dashboardTab === "login"
              ? "text-blue-600"
              : "text-slate-500 hover:text-slate-950",
          )}
        >
          Status
          {dashboardTab === "login" && (
            <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-blue-600" />
          )}
        </button>
        <button
          onClick={() => setDashboardTab("progress")}
          className={cx(
            "relative px-3 py-4 text-sm font-bold",
            dashboardTab === "progress"
              ? "text-blue-600"
              : "text-slate-500 hover:text-slate-950",
          )}
        >
          Accounts Progress
          {dashboardTab === "progress" && (
            <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-blue-600" />
          )}
        </button>
      </div>

      {dashboardTab === "login" ? (
        <>
          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              label="Total Balance"
              value={money(totals.balance)}
              hint="Across master and sub accounts"
              icon={CircleDollarSign}
              tone="green"
            />
            <MetricCard
              label="Total Equity"
              value={money(totals.equity)}
              hint="Real-time terminal snapshot"
              icon={Gauge}
              tone="amber"
            />
            <MetricCard
              label="Connected Terminals"
              value={`${totals.connected}/${accountsData.length}`}
              hint="MT5 local terminal sessions"
              icon={Server}
              tone="blue"
            />
            <MetricCard
              label="Floating P/L"
              value={`${totals.pnl >= 0 ? "+" : ""}${money(totals.pnl)}`}
              hint="All copied open positions"
              icon={Activity}
              tone="green"
            />
          </section>

          <section className="mt-6 grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_348px]">
            <Card className="flex min-h-[360px] flex-col">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <h3 className="text-lg font-black text-slate-950">
                    Saved Trading Accounts
                  </h3>
                  <p className="text-sm text-slate-500">
                    Click an account row to connect that exact MT5 terminal
                    path.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <AppButton variant="soft">
                    <SlidersHorizontal className="h-4 w-4" /> Filter
                  </AppButton>
                  <AppButton onClick={onAdd}>
                    <Play className="h-4 w-4" /> Add New Account
                  </AppButton>
                </div>
              </div>

              <TableFrame className="mt-5 min-h-[360px]">
                <table className="h-full w-full table-fixed text-left">
                  <colgroup>
                    <col className="w-[46%]" />
                    <col className="w-[30%]" />
                    <col className="w-[14%]" />
                    <col className="w-[10%]" />
                  </colgroup>
                  <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="py-3 pl-4 pr-2 font-bold">Account</th>
                      <th className="px-2 py-3 font-bold">Server</th>
                      <th className="px-2 py-3 font-bold">Latency</th>
                      <th className="px-2 py-3 text-center font-bold">
                        Launch
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {accountsData.map((account) => (
                      <tr
                        key={account.id}
                        className="border-t border-slate-100 hover:bg-slate-50/70"
                      >
                        <td className="py-4 pl-4 pr-2 align-middle">
                          <div className="flex min-w-0 items-center gap-3">
                            <div
                              className={cx(
                                "grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-gradient-to-br text-xs font-black text-white shadow-sm",
                                account.color,
                              )}
                            >
                              {(account.name || "A").charAt(0).toUpperCase()}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="inline-flex max-w-full items-center gap-1.5">
                                <p className="truncate font-semibold text-slate-950">
                                  {account.name}
                                </p>
                                <span
                                  className={cx(
                                    "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold",
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
                        <td className="truncate px-2 py-4 text-sm text-slate-700">
                          {account.server}
                        </td>
                        <td className="px-2 py-4 text-sm font-semibold text-slate-700">
                          {account.latency != null
                            ? `${account.latency} ms`
                            : "-"}
                        </td>
                        <td className="px-2 py-4 text-center">
                          <button
                            onClick={() => onConnect?.(account)}
                            className="rounded-xl border border-slate-200 p-2 text-slate-500 hover:bg-white hover:text-blue-600"
                          >
                            <Terminal className="h-4 w-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableFrame>
            </Card>

            <AccountHierarchy accountsData={accountsData} />
          </section>
        </>
      ) : (
        <AccountProgressTab accountsData={accountsData} />
      )}
    </>
  );
}
