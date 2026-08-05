import React, { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { Card } from "../components/ui/Primitives";
import { TableFrame } from "../components/ui/TableFrame";
import { cx, money } from "../utils/format";

function SortHeader({ active, direction, label, onSort, className = "" }) {
  return (
    <th className={cx("px-3 py-3 font-bold", className)}>
      <button
        type="button"
        onPointerDown={(event) => {
          event.preventDefault();
          onSort();
        }}
        className={cx(
          "flex w-full items-center gap-1 select-none text-left transition",
          active ? "text-slate-950" : "text-slate-500 hover:text-slate-950",
        )}
      >
        <span>{label}</span>
        {active ? direction === "asc" ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" /> : <ArrowUpDown className="h-3.5 w-3.5 opacity-70" />}
      </button>
    </th>
  );
}

export default function TradeHistoryPage({ runtime }) {
  const [timeFilter, setTimeFilter] = useState("today");
  const [sortColumn, setSortColumn] = useState("time");
  const [sortDirection, setSortDirection] = useState("desc");

  const tradeRows = useMemo(() => {
    const rows = runtime?.orders || [];
    return rows
      .map((order, idx) => {
        const createdAt = order.created_at ? new Date(order.created_at) : null;
        return {
          id: order.id || idx + 1,
          createdAt,
          time: createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt.toLocaleString() : "-",
          account: order.origin === "strategy" ? "Strategy Engine" : "Manual",
          symbol: order.symbol || "XAUUSD",
          side: order.side || "-",
          lot: Number(order.lot ?? 0),
          open: order.entry != null ? String(order.entry) : "-",
          close: order.status === "closed" ? "Closed" : "-",
          profit: Number(order.profit ?? 0),
          status: order.status === "open" ? "Open" : "Closed",
          comment: order.origin || "",
        };
      })
      .sort((a, b) => {
        const direction = sortDirection === "asc" ? 1 : -1;
        if (sortColumn === "time") {
          return direction * ((a.createdAt?.getTime?.() || 0) - (b.createdAt?.getTime?.() || 0));
        }
        if (sortColumn === "lot" || sortColumn === "profit") {
          return direction * ((Number(a[sortColumn]) || 0) - (Number(b[sortColumn]) || 0));
        }
        if (sortColumn === "side") {
          const weight = (value) => {
            const normalized = String(value || "").toUpperCase();
            if (normalized === "BUY") return 0;
            if (normalized === "SELL") return 1;
            return 2;
          };
          return direction * (weight(a.side) - weight(b.side));
        }
        return direction * String(a[sortColumn] || "").localeCompare(String(b[sortColumn] || ""));
      });
  }, [runtime, sortColumn, sortDirection]);

  const filteredTradeRows = useMemo(() => {
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(now);
    todayEnd.setHours(23, 59, 59, 999);

    if (timeFilter === "today") {
      return tradeRows.filter((row) => row.createdAt && row.createdAt >= todayStart && row.createdAt <= todayEnd);
    }
    return tradeRows;
  }, [tradeRows, timeFilter]);

  function toggleSort(column) {
    setSortColumn((current) => {
      if (current === column) {
        setSortDirection((direction) => (direction === "asc" ? "desc" : "asc"));
        return current;
      }
      setSortDirection(column === "time" ? "desc" : "asc");
      return column;
    });
  }

  return (
    <Card className="flex min-h-[calc(100vh-150px)] flex-col">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h3 className="text-lg font-black text-slate-950">Trade History</h3>
          <p className="mt-1 text-sm text-slate-500">Executed MT5 deals with quick filters and sortable order.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setTimeFilter("all")}
            className={cx("rounded-full px-3 py-1.5 text-xs font-bold transition", timeFilter === "all" ? "bg-slate-950 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200")}
          >
            All
          </button>
          <button
            type="button"
            onClick={() => setTimeFilter("today")}
            className={cx("rounded-full px-3 py-1.5 text-xs font-bold transition", timeFilter === "today" ? "bg-slate-950 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200")}
          >
            Today
          </button>
        </div>
      </div>
      <TableFrame className="mt-4">
            <table className="h-full w-full min-w-[900px] text-left">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <SortHeader active={sortColumn === "time"} direction={sortDirection} label="Time" onSort={() => toggleSort("time")} className="py-3 pl-4 pr-3" />
                <SortHeader active={sortColumn === "account"} direction={sortDirection} label="Account" onSort={() => toggleSort("account")} />
                <SortHeader active={sortColumn === "lot"} direction={sortDirection} label="Lot" onSort={() => toggleSort("lot")} />
                <th className="px-3 py-3 font-bold">Open</th>
                <th className="px-3 py-3 font-bold">Close</th>
                <SortHeader active={sortColumn === "profit"} direction={sortDirection} label="Profit" onSort={() => toggleSort("profit")} />
                <th className="py-3 pl-3 pr-4 font-bold">Comment</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {(filteredTradeRows.length ? filteredTradeRows : [{ id: "empty", time: "-", account: "-", symbol: "-", side: "-", lot: "-", open: "-", close: "-", profit: 0, status: "-", comment: "No matching orders for the selected filter." }]).map((row) => (
                <tr key={row.id} className="hover:bg-slate-50/70">
                  <td className="py-3 pl-4 pr-3 text-sm font-medium text-slate-700">{row.time}</td>
                  <td className="px-3 py-3 text-sm text-slate-800">{row.account}</td>
                  <td className="px-3 py-3 text-sm text-slate-700">{row.lot}</td>
                  <td className="px-3 py-3 text-sm text-slate-700">{row.open}</td>
                  <td className="px-3 py-3 text-sm text-slate-700">{row.close}</td>
                  <td className={cx("px-3 py-3 text-sm font-bold", row.profit >= 0 ? "text-emerald-600" : "text-rose-600")}>
                    {row.profit >= 0 ? "+" : ""}
                    {money(row.profit)}
                  </td>
                  <td className="py-3 pl-3 pr-4 text-sm text-slate-500">{row.comment}</td>
                </tr>
              ))}
            </tbody>
          </table>
      </TableFrame>
    </Card>
  );
}
