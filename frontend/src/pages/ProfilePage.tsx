import React from "react";
import { Card } from "../components/ui/Primitives";
import { cx, money } from "../utils/format";

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
