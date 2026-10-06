import React, { useEffect, useState } from "react";
import {
  Copy,
  Home,
  ChevronsLeft,
  ChevronsRight,
  Search,
  Settings,
  Radio,
  Terminal,
} from "lucide-react";
import { cx } from "../../utils/format";

type SidebarProps = {
  activePage: string;
  onChangePage: (page: string) => void;
  connectedCount: number;
  totalCount: number;
};

// Per-viewer UI preference, so it lives in this browser rather than in
// config.json; storage can be unavailable (private window), hence try/catch.
const COLLAPSED_STORAGE_KEY = "mt5-trader.sidebar-collapsed";

function readCollapsed() {
  try {
    return globalThis.localStorage?.getItem(COLLAPSED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export default function Sidebar({ activePage, onChangePage }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const items = [
    { key: "dashboard", label: "Dashboard", icon: Home },
    { key: "search", label: "Search", icon: Search },
    { key: "trade", label: "Trade", icon: Terminal },
    { key: "history", label: "Trade History", icon: Copy },
    { key: "remote", label: "Remote Control", icon: Radio },
    { key: "settings", label: "Settings", icon: Settings },
  ];

  useEffect(() => {
    try {
      globalThis.localStorage?.setItem(COLLAPSED_STORAGE_KEY, String(collapsed));
    } catch {
      // The sidebar still toggles; it just won't be remembered.
    }
  }, [collapsed]);

  const ToggleIcon = collapsed ? ChevronsRight : ChevronsLeft;
  const toggleLabel = collapsed ? "Expand sidebar" : "Collapse sidebar to icons";

  return (
    <aside
      className={cx(
        "app-sidebar sticky top-0 z-20 hidden shrink-0 flex-col self-stretch border-r border-slate-200 bg-white p-3 transition-[width] duration-200 lg:flex",
        collapsed ? "w-[68px]" : "w-[212px]",
      )}
    >
      <div
        className={cx(
          "flex pb-2",
          collapsed ? "flex-col items-center gap-2" : "items-center gap-2.5 px-2",
        )}
      >
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-blue-600 text-sm font-black text-white">
          MT
        </span>
        {!collapsed ? (
          <span className="min-w-0 flex-1 truncate text-sm font-black tracking-tight text-slate-950">
            MT5 Trader
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          title={toggleLabel}
          aria-label={toggleLabel}
          aria-expanded={!collapsed}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
        >
          <ToggleIcon className="h-[18px] w-[18px]" />
        </button>
      </div>
      <nav className={cx("grid gap-1", collapsed ? "mt-3" : "mt-6")}>
        {items.map(({ key, label, icon: Icon }) => {
          const active = activePage === key;
          return (
            <button
              key={key}
              onClick={() => onChangePage(key)}
              title={collapsed ? label : undefined}
              aria-label={collapsed ? label : undefined}
              className={cx(
                "app-nav-button flex w-full items-center rounded-xl py-2.5 text-sm font-bold transition",
                collapsed ? "justify-center px-0" : "gap-2.5 px-3",
                active
                  ? "app-nav-button--active bg-blue-50 text-blue-700"
                  : "text-slate-500 hover:bg-slate-100 hover:text-slate-900",
              )}
              aria-current={active ? "page" : undefined}
            >
              <Icon className="h-5 w-5 shrink-0" />
              {!collapsed ? <span className="truncate">{label}</span> : null}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
