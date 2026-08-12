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

type SidebarProps = {
  activePage: string;
  onChangePage: (page: string) => void;
  connectedCount: number;
  totalCount: number;
};

export default function Sidebar({
  activePage,
  onChangePage,
  connectedCount,
  totalCount,
}: SidebarProps) {
  const items = [
    { key: "dashboard", label: "Dashboard", icon: Home },
    { key: "search", label: "Search", icon: Search },
    { key: "trade", label: "Trade", icon: Terminal },
    { key: "history", label: "Trade History", icon: Copy },
    { key: "risk", label: "Risk Management", icon: ShieldCheck },
    { key: "remote", label: "Remote Control", icon: Radio },
    { key: "settings", label: "Settings", icon: Settings },
  ];

  return (
    <aside
      className="sticky top-0 hidden h-screen flex-col border-r border-slate-200 p-4 lg:flex"
      style={styles.drawer}
    >
      <nav style={styles.navigation}>
        {items.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => onChangePage(key)}
            style={{
              ...styles.navButton,
              ...(activePage === key
                ? styles.navButtonActive
                : styles.navButtonIdle),
            }}
            className="flex w-full items-center gap-3 text-sm font-bold transition"
          >
            <Icon className="h-5 w-5" />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}

const styles = {
  drawer: { background: "#ffffff" } satisfies React.CSSProperties,
  mutedSmall: {
    margin: 0,
    color: "#64748b",
    fontSize: 12,
    fontWeight: 500,
  } satisfies React.CSSProperties,
  navigation: {
    display: "grid",
    gap: 8,
    marginTop: 32,
  } satisfies React.CSSProperties,
  navButton: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: 12,
    border: 0,
    borderRadius: 16,
    background: "transparent",
    padding: "12px 16px",
    fontSize: 14,
    fontWeight: 700,
    textAlign: "left",
    cursor: "pointer",
    transition: "background .2s, color .2s",
  } satisfies React.CSSProperties,
  navButtonActive: {
    background: "#f1f5f9",
    color: "#334155",
  } satisfies React.CSSProperties,
  navButtonIdle: {
    background: "transparent",
    color: "#64748b",
  } satisfies React.CSSProperties,
};
