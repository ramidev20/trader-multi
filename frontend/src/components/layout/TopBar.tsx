import React, { useEffect, useRef, useState } from "react";
import {
  Bell,
  ChevronDown,
  Copy,
  LogOut,
  Plus,
  Settings,
  SlidersHorizontal,
  Terminal,
  UserRound,
} from "lucide-react";
import { cx } from "../../utils/format";

type TopBarProps = {
  pageTitle: string;
  activePage: string;
  onChangePage: (page: string) => void;
  onAddAccount: () => void;
  masterAccount?: {
    status?: string;
    color?: string;
    name?: string;
    login?: string | number;
  };
};

export default function TopBar({
  pageTitle,
  activePage,
  onChangePage,
  onAddAccount,
  masterAccount,
}: TopBarProps) {
  const status = String(masterAccount?.status || "Disconnected");
  const isConnected = status === "Connected";
  const isStarting = status === "Starting";
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function closeAccountMenu(event: MouseEvent) {
      if (!accountMenuRef.current?.contains(event.target as Node)) {
        setAccountMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", closeAccountMenu);
    return () => document.removeEventListener("mousedown", closeAccountMenu);
  }, []);

  return (
    <header
      className="sticky top-0 z-10 px-5 py-4 lg:px-8"
      style={styles.header}
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div style={styles.titleBlock}>
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-500">
            <span>MT5 Trader</span>
            <span>/</span>
            <span className="text-slate-950">{pageTitle}</span>
          </div>
          <h2 style={styles.title}>{pageTitle}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button style={styles.iconButton}>
            <Bell className="h-5 w-5" />
          </button>

          <div ref={accountMenuRef} style={styles.accountMenuContainer}>
            <button
              type="button"
              onClick={() => setAccountMenuOpen((open) => !open)}
              style={styles.accountCard}
              aria-expanded={accountMenuOpen}
            >
              <div
                className={cx(
                  "grid h-10 w-10 shrink-0 place-items-center rounded-full bg-gradient-to-br text-xs font-black text-white shadow-sm",
                  masterAccount?.color || "from-slate-500 to-slate-700",
                )}
              >
                {(masterAccount?.name || "M").charAt(0).toUpperCase()}
              </div>
              <ChevronDown size={18} color="#475569" />
            </button>
            {accountMenuOpen ? (
              <div style={styles.accountMenu}>
                <div style={styles.menuHeader}>
                  <div>
                    <p style={styles.menuName}>
                      {masterAccount?.name || "Master Account"}
                    </p>
                    <p style={styles.menuLogin}>
                      Login {masterAccount?.login || "-"}
                    </p>
                  </div>
                  <span
                    style={{
                      ...styles.menuStatus,
                      color: isConnected
                        ? "#059669"
                        : isStarting
                          ? "#d97706"
                          : "#e11d48",
                    }}
                  >
                    <span
                      style={{
                        ...styles.statusDot,
                        backgroundColor: isConnected
                          ? "#10b981"
                          : isStarting
                            ? "#f59e0b"
                            : "#f43f5e",
                      }}
                    />
                    {status}
                  </span>
                </div>
                <div style={styles.menuDivider} />
                <button
                  type="button"
                  style={styles.menuButton}
                  onClick={() => setAccountMenuOpen(false)}
                >
                  <UserRound size={17} /> Profile
                </button>
                <button
                  type="button"
                  style={styles.menuButton}
                  onClick={() => setAccountMenuOpen(false)}
                >
                  <Settings size={17} /> Account Settings
                </button>
                <button
                  type="button"
                  style={styles.menuButton}
                  onClick={() => setAccountMenuOpen(false)}
                >
                  <SlidersHorizontal size={17} /> Preferences
                </button>
                <div style={styles.menuDivider} />
                <button
                  type="button"
                  style={styles.menuButton}
                  onClick={() => {
                    setAccountMenuOpen(false);
                    onAddAccount();
                  }}
                >
                  <Plus className="h-4 w-4" /> Add Account
                </button>
                <button
                  type="button"
                  style={styles.menuButton}
                  onClick={() => setAccountMenuOpen(false)}
                >
                  <LogOut size={17} /> Logout
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 lg:hidden">
        <button
          onClick={() => onChangePage("dashboard")}
          className={cx(
            "rounded-2xl px-4 py-3 text-sm font-bold",
            activePage === "dashboard"
              ? "bg-slate-950 text-white"
              : "bg-white text-slate-500",
          )}
        >
          Dashboard
        </button>
        <button
          onClick={() => onChangePage("search")}
          className={cx(
            "rounded-2xl px-4 py-3 text-sm font-bold",
            activePage === "search"
              ? "bg-slate-950 text-white"
              : "bg-white text-slate-500",
          )}
        >
          Search
        </button>
        <button
          onClick={() => onChangePage("trade")}
          className={cx(
            "rounded-2xl px-4 py-3 text-sm font-bold",
            activePage === "trade"
              ? "bg-slate-950 text-white"
              : "bg-white text-slate-500",
          )}
        >
          <span className="inline-flex items-center gap-2">
            <Terminal className="h-4 w-4" /> Trade
          </span>
        </button>
        <button
          onClick={() => onChangePage("history")}
          className={cx(
            "rounded-2xl px-4 py-3 text-sm font-bold",
            activePage === "history"
              ? "bg-slate-950 text-white"
              : "bg-white text-slate-500",
          )}
        >
          <span className="inline-flex items-center gap-2">
            <Copy className="h-4 w-4" /> History
          </span>
        </button>
      </div>
    </header>
  );
}

const styles = {
  header: {
    position: "sticky",
    top: 0,
    zIndex: 10,
    borderBottom: "1px solid #e2e8f0",
    background: "#ffffff",
  } satisfies React.CSSProperties,
  titleBlock: { minWidth: 0 } satisfies React.CSSProperties,
  title: {
    margin: "4px 0 0",
    fontSize: 30,
    fontWeight: 900,
    letterSpacing: "-0.025em",
  } satisfies React.CSSProperties,
  iconButton: {
    border: "1px solid #e2e8f0",
    borderRadius: 16,
    background: "white",
    padding: 12,
    color: "#475569",
    boxShadow: "0 1px 2px rgba(15, 23, 42, .05)",
    cursor: "pointer",
  } satisfies React.CSSProperties,
  accountCard: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    border: 0,
    borderRadius: 12,
    background: "transparent",
    padding: 0,
    color: "inherit",
    cursor: "pointer",
  } satisfies React.CSSProperties,
  accountMenuContainer: {
    position: "relative",
    display: "flex",
    justifyContent: "flex-end",
  } satisfies React.CSSProperties,
  accountMenu: {
    position: "absolute",
    top: "calc(100% + 12px)",
    right: 0,
    zIndex: 20,
    width: 248,
    border: "1px solid #cbd5e1",
    borderRadius: 16,
    background: "white",
    padding: 8,
    boxShadow: "0 16px 32px rgba(15, 23, 42, .14)",
  } satisfies React.CSSProperties,
  menuHeader: {
    position: "relative",
    display: "flex",
    justifyContent: "space-between",
    minHeight: 58,
    padding: "10px 10px 14px",
  } satisfies React.CSSProperties,
  menuName: {
    margin: 0,
    color: "#0f172a",
    fontSize: 16,
    fontWeight: 800,
  } satisfies React.CSSProperties,
  menuLogin: {
    margin: "3px 0 0",
    color: "#64748b",
    fontSize: 13,
  } satisfies React.CSSProperties,
  menuStatus: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    fontSize: 12,
    fontWeight: 400,
  } satisfies React.CSSProperties,
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: "50%",
  } satisfies React.CSSProperties,
  menuDivider: {
    height: 1,
    margin: "6px 4px",
    background: "#e2e8f0",
  } satisfies React.CSSProperties,
  menuButton: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: 8,
    border: 0,
    borderRadius: 8,
    background: "transparent",
    padding: "10px 12px",
    color: "#334155",
    fontSize: 14,
    fontWeight: 700,
    textAlign: "left",
    cursor: "pointer",
  } satisfies React.CSSProperties,
};
