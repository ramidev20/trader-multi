import React, { useEffect, useRef, useState } from "react";
import {
  Bell,
  ChevronDown,
  Copy,
  CheckCircle2,
  AlertTriangle,
  Info,
  LogOut,
  Plus,
  Settings,
  SlidersHorizontal,
  Terminal,
  UserRound,
  X,
} from "lucide-react";
import { cx } from "../../utils/format";
import { clearBanner, subscribeBanner } from "../../utils/banner";

type TopBarProps = {
  pageTitle: string;
  activePage: string;
  onChangePage: (page: string) => void;
  onChangeSettingsTab: (tab: string) => void;
  onAddAccount: () => void;
  onLogout: () => void;
  onClearNotifications: () => void;
  onViewMoreNotifications: () => void;
  notifications?: Array<{ id: string; title: string; message: string; level: string }>;
  masterAccount?: {
    status?: string;
    color?: string;
    name?: string;
    login?: string | number;
  };
};

const statusTone: Record<string, string> = {
  Connected: "text-emerald-600",
  Starting: "text-amber-600",
};
const statusDotTone: Record<string, string> = {
  Connected: "bg-emerald-500",
  Starting: "bg-amber-500",
};

const mobileNavItems = [
  { key: "dashboard", label: "Dashboard", icon: null },
  { key: "search", label: "Search", icon: null },
  { key: "trade", label: "Trade", icon: Terminal },
  { key: "history", label: "History", icon: Copy },
];

export default function TopBar({
  pageTitle,
  activePage,
  onChangePage,
  onChangeSettingsTab,
  onAddAccount,
  onLogout,
  onClearNotifications,
  onViewMoreNotifications,
  notifications = [],
  masterAccount,
}: TopBarProps) {
  const status = String(masterAccount?.status || "Disconnected");
  const isConnected = status === "Connected";
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  // Pages push warning/error/success text here (via showBanner) instead of
  // rendering their own inline banner -- that used to add height to the
  // scrollable page content and shove everything below it down every time
  // one appeared. This slot lives in the sticky header instead, so it never
  // shifts the page.
  const [banner, setBanner] = useState<{ id: number; tone: string; text: string; code: string | null } | null>(null);

  useEffect(() => {
    function closeAccountMenu(event: MouseEvent) {
      if (!accountMenuRef.current?.contains(event.target as Node)) {
        setAccountMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", closeAccountMenu);
    return () => document.removeEventListener("mousedown", closeAccountMenu);
  }, []);

  useEffect(() => subscribeBanner(setBanner), []);

  const bannerTone: Record<string, string> = {
    error: "border-rose-200 bg-rose-50 text-rose-700",
    warning: "border-amber-200 bg-amber-50 text-amber-800",
    success: "border-teal-200 bg-teal-50 text-teal-700",
  };

  return (
    <header className="app-topbar sticky top-0 z-10 border-b border-slate-200 bg-white px-5 py-2.5 lg:px-8">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-slate-500">
            <span>MT5 Trader</span>
            <span>/</span>
            <span className="text-slate-950">{pageTitle}</span>
            {/* Same row as the breadcrumb, not a block below it -- a short
                code (an HTTP status or "NETWORK", or the tone itself when
                no code applies) instead of the full description, which the
                title attribute still carries for a hover tooltip. */}
            {banner ? (
              <span
                title={banner.text}
                className={cx(
                  "flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-black uppercase tracking-wide",
                  bannerTone[banner.tone] || bannerTone.error,
                )}
              >
                {banner.code || banner.tone}
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    clearBanner();
                  }}
                  className="opacity-70 transition hover:opacity-100"
                  aria-label="Dismiss"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative">
            <button
              type="button"
              className="app-icon-button relative rounded-lg border border-slate-200 bg-white p-2.5 text-slate-500 shadow-sm transition hover:bg-slate-50"
              onClick={() => setNotificationsOpen((open) => !open)}
              aria-label="Notifications"
            >
              <Bell className="h-4 w-4" />
              {notifications.length ? (
                <span className="absolute -right-1 -top-1 min-w-5 rounded-full bg-rose-500 px-1 text-center text-[10px] font-black leading-5 text-white">
                  {Math.min(notifications.length, 99)}
                </span>
              ) : null}
            </button>
            {notificationsOpen ? (
              <div className="app-popover absolute right-0 top-14 z-20 w-[340px] overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
                <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
                  <span className="text-sm font-black text-slate-950">Notifications</span>
                  <div className="flex items-center gap-3">
                    <button type="button" onClick={(event) => { event.stopPropagation(); setNotificationsOpen(false); onViewMoreNotifications(); }} className="text-xs font-bold text-slate-500 hover:text-slate-800">View more</button>
                    <button type="button" onClick={(event) => { event.stopPropagation(); onClearNotifications(); }} className="text-xs font-bold text-blue-600 hover:text-blue-800">Clear all</button>
                  </div>
                </div>
                <div className="max-h-80 overflow-y-auto">
                  {notifications.length ? notifications.map((notification) => {
                    const Icon = notification.level === "error" || notification.level === "warning" ? AlertTriangle : notification.level === "success" ? CheckCircle2 : Info;
                    return (
                      <div key={notification.id} className="flex gap-3 border-b border-slate-50 px-4 py-3 last:border-0">
                        <Icon className={cx("mt-0.5 h-4 w-4 shrink-0", notification.level === "error" ? "text-rose-500" : notification.level === "warning" ? "text-amber-500" : notification.level === "success" ? "text-emerald-500" : "text-blue-500")} />
                        <div>
                          <p className="text-xs font-black text-slate-800">{notification.title}</p>
                          <p className="mt-1 text-xs leading-5 text-slate-500">{notification.message}</p>
                        </div>
                      </div>
                    );
                  }) : <p className="px-4 py-8 text-center text-sm font-semibold text-slate-400">No notifications yet.</p>}
                </div>
              </div>
            ) : null}
          </div>

          <div ref={accountMenuRef} className="relative flex justify-end">
            <button
              type="button"
              className="app-account-button flex items-center gap-2.5 rounded-full border-0 bg-transparent p-0"
              onClick={() => setAccountMenuOpen((open) => !open)}
              aria-expanded={accountMenuOpen}
            >
              <div
                className={cx(
                  "grid h-10 w-10 shrink-0 place-items-center rounded-full bg-gradient-to-br text-sm font-black text-white shadow-sm",
                  masterAccount?.color || "from-slate-500 to-slate-700",
                )}
              >
                {(masterAccount?.name || "M").charAt(0).toUpperCase()}
              </div>
              <ChevronDown className="h-4 w-4 text-slate-500" />
            </button>
            {accountMenuOpen ? (
              <div className="app-account-menu absolute right-0 top-[calc(100%+12px)] z-20 w-64 rounded-lg border border-slate-200 bg-white p-2 shadow-xl">
                <div className="flex items-start justify-between gap-3 px-2.5 pb-3.5 pt-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-base font-extrabold text-slate-900">{masterAccount?.name || "Master Account"}</p>
                    <p className="mt-0.5 text-[13px] text-slate-500">Login {masterAccount?.login || "-"}</p>
                  </div>
                  <span className={cx("inline-flex shrink-0 items-center gap-1.5 text-xs font-semibold", statusTone[status] || "text-rose-600")}>
                    <span className={cx("h-1.5 w-1.5 rounded-full", statusDotTone[status] || "bg-rose-500")} />
                    {status}
                  </span>
                </div>
                <div className="mx-1 my-1.5 h-px bg-slate-200" />
                <button
                  type="button"
                  className="app-menu-button flex w-full items-center gap-2 rounded-lg border-0 bg-transparent px-3 py-2.5 text-left text-sm font-bold text-slate-700 transition hover:bg-slate-100"
                  onClick={() => { setAccountMenuOpen(false); onChangePage("profile"); }}
                >
                  <UserRound className="h-[17px] w-[17px]" /> Profile
                </button>
                <button
                  type="button"
                  className="app-menu-button flex w-full items-center gap-2 rounded-lg border-0 bg-transparent px-3 py-2.5 text-left text-sm font-bold text-slate-700 transition hover:bg-slate-100"
                  onClick={() => { setAccountMenuOpen(false); onChangeSettingsTab("accounts"); }}
                >
                  <Settings className="h-[17px] w-[17px]" /> Account Settings
                </button>
                <button
                  type="button"
                  className="app-menu-button flex w-full items-center gap-2 rounded-lg border-0 bg-transparent px-3 py-2.5 text-left text-sm font-bold text-slate-700 transition hover:bg-slate-100"
                  onClick={() => { setAccountMenuOpen(false); onChangeSettingsTab("appearance"); }}
                >
                  <SlidersHorizontal className="h-[17px] w-[17px]" /> Preferences
                </button>
                <div className="mx-1 my-1.5 h-px bg-slate-200" />
                <button
                  type="button"
                  className="app-menu-button flex w-full items-center gap-2 rounded-lg border-0 bg-transparent px-3 py-2.5 text-left text-sm font-bold text-slate-700 transition hover:bg-slate-100"
                  onClick={() => { setAccountMenuOpen(false); onAddAccount(); }}
                >
                  <Plus className="h-4 w-4" /> Add Account
                </button>
                {isConnected ? (
                  <button
                    type="button"
                    className="app-menu-button flex w-full items-center gap-2 rounded-lg border-0 bg-transparent px-3 py-2.5 text-left text-sm font-bold text-rose-600 transition hover:bg-rose-50"
                    onClick={() => { setAccountMenuOpen(false); onLogout(); }}
                  >
                    <LogOut className="h-[17px] w-[17px]" /> Logout
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 lg:hidden">
        {mobileNavItems.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => onChangePage(key)}
            className={cx(
              "rounded-lg px-4 py-3 text-sm font-bold transition",
              activePage === key
                ? "bg-slate-950 text-white"
                : "bg-slate-100 text-slate-500",
            )}
          >
            {Icon ? (
              <span className="inline-flex items-center gap-2">
                <Icon className="h-4 w-4" /> {label}
              </span>
            ) : (
              label
            )}
          </button>
        ))}
      </div>
    </header>
  );
}
