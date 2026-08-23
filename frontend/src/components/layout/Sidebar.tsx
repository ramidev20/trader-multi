import React from "react";
import {
  Copy,
  Home,
  Search,
  Settings,
  Radio,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import { cx } from "../../utils/format";

type SidebarProps = {
  activePage: string;
  onChangePage: (page: string) => void;
  connectedCount: number;
  totalCount: number;
};

export default function Sidebar({ activePage, onChangePage }: SidebarProps) {
  const items = [
    { key: "dashboard", label: "Dashboard", icon: Home },
    { key: "search", label: "Search", icon: Search },
    { key: "trade", label: "Trade", icon: Terminal },
    { key: "history", label: "Trade History", icon: Copy },
    { key: "risk", label: "Risk Manager", icon: ShieldCheck },
    { key: "remote", label: "Remote Control", icon: Radio },
    { key: "settings", label: "Settings", icon: Settings },
  ];

  return (
    <aside className="app-sidebar sticky top-0 z-20 hidden h-screen w-[212px] shrink-0 flex-col self-start border-r border-slate-200 bg-white p-3 lg:flex">
      <div className="flex items-center gap-2.5 px-2 pb-2">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-blue-600 text-sm font-black text-white">
          MT
        </span>
        <span className="text-sm font-black tracking-tight text-slate-950">
          MT5 Trader
        </span>
      </div>
      <nav className="mt-6 grid gap-1">
        {items.map(({ key, label, icon: Icon }) => {
          const active = activePage === key;
          return (
            <button
              key={key}
              onClick={() => onChangePage(key)}
              className={cx(
                "app-nav-button flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-bold transition",
                active
                  ? "bg-blue-50 text-blue-700"
                  : "text-slate-500 hover:bg-slate-100 hover:text-slate-900",
              )}
              aria-current={active ? "page" : undefined}
            >
              <Icon className="h-5 w-5 shrink-0" />
              <span>{label}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
