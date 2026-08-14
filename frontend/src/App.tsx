import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { WifiOff } from "lucide-react";
import Sidebar from "./components/layout/Sidebar";
import TopBar from "./components/layout/TopBar";
import { AppButton, Dialog, Field, SelectBox } from "./components/ui/Primitives";
import DashboardPage from "./pages/DashboardPage";
import SearchPage from "./pages/SearchPage";
import { NotificationsPage, ProfilePage, RiskManagementPage, SettingsPlaceholder, TradePage } from "./pages/Placeholders";
import TradeHistoryPage from "./pages/TradeHistoryPage";
import RemoteControlPage from "./pages/RemoteControlPage";
import { initialAccounts, liquidityLevels, strategyLogs } from "./data/mockData";
import { cx } from "./utils/format";
import { api } from "./services/api";

const avatarColorOptions = [
  { name: "Blue", value: "from-blue-600 to-indigo-600", swatch: "#2563eb" },
  { name: "Cyan", value: "from-cyan-500 to-blue-600", swatch: "#06b6d4" },
  { name: "Violet", value: "from-violet-500 to-purple-700", swatch: "#8b5cf6" },
  { name: "Amber", value: "from-amber-500 to-orange-600", swatch: "#f59e0b" },
  { name: "Rose", value: "from-rose-500 to-pink-600", swatch: "#f43f5e" },
  { name: "Emerald", value: "from-emerald-500 to-green-600", swatch: "#10b981" },
  { name: "Teal", value: "from-teal-500 to-cyan-600", swatch: "#14b8a6" },
  { name: "Sky", value: "from-sky-500 to-blue-600", swatch: "#0ea5e9" },
  { name: "Lime", value: "from-lime-500 to-green-600", swatch: "#84cc16" },
  { name: "Slate", value: "from-slate-500 to-slate-700", swatch: "#64748b" },
];
export default function App() {
  const [devModeEnabled, setDevModeEnabled] = useState(false);
  const [activePage, setActivePage] = useState("dashboard");
  const [accountList, setAccountList] = useState([]);
  const [runtime, setRuntime] = useState(null);
  const [searchLogs, setSearchLogs] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const dismissedNotificationIds = useRef(new Set());
  const [tradeHistory, setTradeHistory] = useState({ history: [], summaries: [] });
  const [loadingBootstrap, setLoadingBootstrap] = useState(true);
  const [errorText, setErrorText] = useState("");
  const [settingsTabRequest, setSettingsTabRequest] = useState("accounts");
  const [dialogMode, setDialogMode] = useState(null);
  const [selectedAccount, setSelectedAccount] = useState(null);
  const [searchTimeRange, setSearchTimeRange] = useState(() => {
    const now = new Date();
    return {
      startDate: now,
      startTime: now,
      endDate: now,
      endTime: now,
      endEnabled: false,
    };
  });
  const [formState, setFormState] = useState({
    name: "",
    role: "SUB",
    setAsMain: false,
    login: "",
    password: "",
    server: "",
    path: "",
    status: "Connected",
    balance: 0,
    equity: 0,
    pnl: 0,
    risk: 1,
    orderDelaySec: 0,
    latency: "",
    color: "from-blue-600 to-indigo-600",
  });

  const mergeAccountSnapshots = useCallback((snapshotData) => {
    const snapshots = new Map(
      (snapshotData?.snapshots || []).map((item) => [String(item.login), item]),
    );
    setAccountList((current) =>
      current.map((account) => {
        const snapshot = snapshots.get(String(account.login));
        if (!snapshot) return account;
        const hasNumber = (value) =>
          value !== null && value !== undefined && Number.isFinite(Number(value));
        return {
          ...account,
          balance: hasNumber(snapshot.balance) ? Number(snapshot.balance) : account.balance,
          equity: hasNumber(snapshot.equity) ? Number(snapshot.equity) : account.equity,
          pnl: hasNumber(snapshot.floating_pnl) ? Number(snapshot.floating_pnl) : account.pnl,
          floatingPnl: hasNumber(snapshot.floating_pnl) ? Number(snapshot.floating_pnl) : account.floatingPnl,
          latency: snapshot.latency ?? account.latency,
          algoEnabled: snapshot.algo_enabled ?? account.algoEnabled,
        };
      }),
    );
  }, []);

  const refreshBootstrap = useCallback(async (options = {}) => {
    const { silent = false, withSnapshots = false } = options;
    if (!silent) setLoadingBootstrap(true);
    try {
      const loaded = await api.bootstrap();
      const nextDevMode = Boolean(loaded?.dev_mode);
      setDevModeEnabled(nextDevMode);
      const data = resolveBootstrapData(loaded, nextDevMode);
      setAccountList((current) => {
        const previousByLogin = new Map(current.map((account) => [String(account.login), account]));
        return (Array.isArray(data.accounts) ? data.accounts : []).map((account) => {
          const previous = previousByLogin.get(String(account.login));
          const balance = Number(account.balance || 0) > 0 ? account.balance : previous?.balance || 0;
          const equity = Number(account.equity || 0) > 0 ? account.equity : previous?.equity || balance;
          const latency = Number(account.latency || 0) > 0 ? account.latency : previous?.latency || null;
          const floatingPnl = Number(previous?.floatingPnl ?? previous?.pnl ?? 0);
          return { ...account, balance, equity, pnl: floatingPnl, floatingPnl, latency };
        });
      });
      setRuntime(data.runtime || null);
      const incomingSearchLogs = data.logs?.search || data.runtime?.logs?.search;
      if (Array.isArray(incomingSearchLogs) && incomingSearchLogs.length) {
        setSearchLogs((current) => {
          const known = new Set(current);
          const merged = [...current];
          incomingSearchLogs.forEach((line) => {
            if (!known.has(line)) {
              known.add(line);
              merged.push(line);
            }
          });
          return merged.slice(-500);
        });
      }
      setNotifications(buildNotifications(data).filter((item) => !dismissedNotificationIds.current.has(item.id)));
      setErrorText("");
      if (withSnapshots && !devModeEnabled) {
        try {
          const snapshotData = await api.accountSnapshots();
          mergeAccountSnapshots(snapshotData);
        } catch (error) {
          setErrorText(String(error?.message || error));
        }
      }
      return data;
    } catch (error) {
      if (devModeEnabled) {
        const data = buildDeveloperBootstrap();
        setDevModeEnabled(true);
        setAccountList(data.accounts || []);
        setRuntime(data.runtime || null);
        setSearchLogs(data.logs?.search || []);
        setNotifications(buildNotifications(data));
        setTradeHistory(buildDeveloperTradeHistory());
        setErrorText("");
        return data;
      }
      setErrorText(String(error?.message || error));
      return null;
    } finally {
      if (!silent) setLoadingBootstrap(false);
    }
  }, [devModeEnabled, mergeAccountSnapshots]);

  function clearNotifications() {
    notifications.filter((item) => item.category !== "system").forEach((item) => dismissedNotificationIds.current.add(item.id));
    setNotifications((current) => current.filter((item) => item.category === "system"));
  }

  useEffect(() => {
    refreshBootstrap({ withSnapshots: true });
  }, [refreshBootstrap]);

  useEffect(() => {
    const timer = setInterval(() => refreshBootstrap({ silent: true }), 5000);
    return () => clearInterval(timer);
  }, [refreshBootstrap]);


  const totals = useMemo(
    () => ({
      balance: accountList.reduce((sum, account) => sum + account.balance, 0),
      equity: accountList.reduce((sum, account) => sum + account.equity, 0),
      connected: accountList.filter((account) => account.status === "Connected").length,
      pnl: accountList.reduce((sum, account) => sum + Number(account.floatingPnl ?? account.pnl ?? 0), 0),
    }),
    [accountList]
  );

  const masterAccount = useMemo(
    () => accountList.find((account) => account.role === "MASTER") || null,
    [accountList],
  );
  const masterConnected = devModeEnabled || masterAccount?.status === "Connected";

  useEffect(() => {
    if (!["history", "profile"].includes(activePage)) return;
    if (devModeEnabled) {
      setTradeHistory(buildDeveloperTradeHistory());
      return;
    }
    if (!masterConnected) return;
    api.tradeHistory()
      .then((data) => setTradeHistory({ history: data.history || [], summaries: data.summaries || [] }))
      .catch((error) => setErrorText(String(error?.message || error)));
  }, [activePage, masterConnected]);

  function openAddDialog() {
    setSelectedAccount(null);
    setFormState({
      name: "",
      role: "SUB",
      setAsMain: false,
      login: "",
      password: "",
      server: "",
      path: "",
      status: "Connected",
      balance: 0,
      equity: 0,
      pnl: 0,
      risk: 1,
      orderDelaySec: 0,
      latency: "",
      color: "from-blue-600 to-indigo-600",
    });
    setDialogMode("add");
  }

  function openEditDialog(account) {
    setSelectedAccount(account);
    setFormState({
      name: account.name,
      role: account.role,
      setAsMain: account.role === "MASTER",
      login: account.login,
      password: account.password || "",
      server: account.server,
      path: account.path,
      status: account.status,
      balance: account.balance,
      equity: account.equity,
      pnl: account.pnl,
      risk: account.risk,
      orderDelaySec: account.orderDelaySec ?? 0,
      latency: account.latency ?? "",
      color: account.color,
    });
    setDialogMode("edit");
  }

  function openDeleteDialog(account) {
    setSelectedAccount(account);
    setDialogMode("delete");
  }

  function closeDialog() {
    setDialogMode(null);
    setSelectedAccount(null);
  }

  async function handleLogout() {
    if (!masterAccount?.login) return;
    try {
      await api.disconnectAccount(Number(masterAccount.login));
      setActivePage("dashboard");
      await refreshBootstrap({ silent: true });
      setErrorText("");
    } catch (error) {
      setErrorText(String(error?.message || error));
    }
  }

  function openSettingsTab(tab) {
    setSettingsTabRequest(tab);
    setActivePage("settings");
  }

  async function saveAccount() {
    if (!formState.name.trim() || !String(formState.login).trim()) return;
    const shouldBeMain = !!formState.setAsMain;
    try {
      await api.saveAccount({
        username: formState.name,
        user: Number(formState.login),
        password: formState.password || "",
        server: formState.server,
        terminal_path: formState.path,
        role: shouldBeMain ? "master" : "sub",
        risk_percent: Number(formState.risk || 1),
        order_delay_sec: Number(formState.orderDelaySec || 0),
      });
      await refreshBootstrap();
      closeDialog();
    } catch (error) {
      setErrorText(String(error?.message || error));
    }
  }

  async function confirmDelete() {
    if (!selectedAccount) return;
    try {
      await api.deleteAccount(Number(selectedAccount.login));
      await refreshBootstrap();
      closeDialog();
    } catch (error) {
      setErrorText(String(error?.message || error));
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function connectAccountAndSync(account) {
    if (!account) return;
    try {
      if (account.status === "Connected") {
        await api.disconnectAccount(Number(account.login));
        await refreshBootstrap({ silent: true });
        return;
      }
      await api.connectAccount(Number(account.login));
      if (devModeEnabled) {
        await refreshBootstrap({ silent: true });
        return;
      }
      let connected = false;
      for (let i = 0; i < 8; i += 1) {
        const data = await refreshBootstrap({ silent: true });
        const current = (data?.accounts || []).find((a) => String(a.login) === String(account.login));
        if (current?.status === "Connected") {
          connected = true;
          break;
        }
        await sleep(600);
      }
      if (!connected) {
        // final UI sync even if adapter is still starting
        await refreshBootstrap({ silent: true });
      }
    } catch (error) {
      setErrorText(String(error?.message || error));
    }
  }

  async function refreshDashboard() {
    const data = await refreshBootstrap({ silent: true });
    if (devModeEnabled) return data;
    try {
      const snapshotData = await api.accountSnapshots();
      mergeAccountSnapshots(snapshotData);
    } catch (error) {
      setErrorText(String(error?.message || error));
    }
    return data;
  }

  const pageTitle =
    activePage === "search"
      ? "Strategy Search"
      : activePage === "trade"
        ? "Trade"
        : activePage === "history"
            ? "Trade History"
            : activePage === "risk"
              ? "Risk Management"
              : activePage === "settings"
                ? "Settings"
                : activePage === "remote"
                  ? "Remote Control"
                : activePage === "profile"
                  ? "Profile"
                : activePage === "notifications"
                  ? "Notifications"
                : "Trading Control Center";

  return (
    <div className="lg:grid lg:grid-cols-[264px_minmax(0,1fr)]" style={styles.appShell}>
      <Sidebar activePage={activePage} onChangePage={setActivePage} connectedCount={totals.connected} totalCount={accountList.length} />
      <main className="min-w-0">
        <TopBar pageTitle={pageTitle} activePage={activePage} onChangePage={setActivePage} onChangeSettingsTab={openSettingsTab} onAddAccount={openAddDialog} onLogout={handleLogout} masterAccount={masterAccount} notifications={notifications.filter((item) => item.category !== "system")} onClearNotifications={clearNotifications} onViewMoreNotifications={() => setActivePage("notifications")} />
        <div className="px-3 py-6 lg:px-5" style={styles.pageContent}>
          <motion.div key={activePage} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22 }}>
            {errorText ? <div style={styles.errorBanner}>{errorText}</div> : null}
            {devModeEnabled ? <div style={styles.loadingBanner}>Developer mode is enabled. Using mock MT5 data unless a live backend session is available.</div> : null}
            {loadingBootstrap ? <div style={styles.loadingBanner}>Loading backend data...</div> : null}
            {activePage === "dashboard" && <DashboardPage totals={totals} accountsData={accountList} onAdd={openAddDialog} onEdit={openEditDialog} onDelete={openDeleteDialog} onConnect={connectAccountAndSync} onRefresh={refreshDashboard} />}
            {activePage === "search" && (masterConnected ? <SearchPage runtime={runtime} searchLogs={searchLogs} onRefreshRuntime={refreshBootstrap} timeRange={searchTimeRange} onTimeRangeChange={setSearchTimeRange} /> : <MasterConnectionRequiredPage />)}
            {activePage === "trade" && (masterConnected ? <TradePage runtime={runtime} onRefreshRuntime={refreshBootstrap} /> : <MasterConnectionRequiredPage />)}
            {activePage === "history" && (masterConnected ? <TradeHistoryPage runtime={runtime} historyRows={tradeHistory.history} /> : <MasterConnectionRequiredPage />)}
            {activePage === "risk" && (masterConnected ? <RiskManagementPage runtime={runtime} onRefreshRuntime={refreshBootstrap} /> : <MasterConnectionRequiredPage />)}
            {activePage === "remote" && <RemoteControlPage />}
            {activePage === "settings" && <SettingsPlaceholder initialTab={settingsTabRequest} accountsData={accountList} onEdit={openEditDialog} onDelete={openDeleteDialog} />}
            {activePage === "profile" && <ProfilePage accountsData={accountList} runtime={runtime} historyRows={tradeHistory.history} summaries={tradeHistory.summaries} />}
            {activePage === "notifications" && <NotificationsPage notifications={notifications} />}
          </motion.div>
        </div>
      </main>

      <Dialog open={dialogMode === "add" || dialogMode === "edit"} title={dialogMode === "edit" ? "Edit Account Settings" : "Add Account"} onClose={closeDialog}>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Account Name" value={formState.name} onChange={(e) => setFormState((s) => ({ ...s, name: e.target.value }))} />
          <Field label="Login Username" value={formState.login} onChange={(e) => setFormState((s) => ({ ...s, login: e.target.value }))} />
          <Field label="Server" value={formState.server} onChange={(e) => setFormState((s) => ({ ...s, server: e.target.value }))} />
          <Field label="Password" value={formState.password} onChange={(e) => setFormState((s) => ({ ...s, password: e.target.value }))} />
          <Field label="Terminal Path" value={formState.path} onChange={(e) => setFormState((s) => ({ ...s, path: e.target.value }))} />
          {dialogMode === "edit" && (
            <>
              <Field label="Risk %" value={String(formState.risk)} type="number" onChange={(e) => setFormState((s) => ({ ...s, risk: e.target.value }))} />
              <Field label="Position Delay (seconds)" value={String(formState.orderDelaySec)} type="number" min={0} max={10} onChange={(e) => setFormState((s) => ({ ...s, orderDelaySec: Math.min(10, Math.max(0, Number(e.target.value || 0))) }))} />
              <label className="block">
                <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Avatar Color</span>
                <select
                  value={formState.color}
                  onChange={(e) => setFormState((s) => ({ ...s, color: e.target.value }))}
                  className="mt-1 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-900 outline-none transition focus:border-blue-400 focus:bg-white focus:ring-4 focus:ring-blue-100"
                >
                  {avatarColorOptions.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <div className="mt-2 flex items-center gap-2 text-xs font-semibold text-slate-600">
                  <span className="h-3 w-3 rounded-full" style={{ backgroundColor: (avatarColorOptions.find((c) => c.value === formState.color) || avatarColorOptions[0]).swatch }} />
                  {(avatarColorOptions.find((c) => c.value === formState.color) || avatarColorOptions[0]).name}
                </div>
              </label>
              <label className="flex items-center justify-between rounded-[8px] border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700">
                <span>Switch this account to main account</span>
                <button
                  type="button"
                  onClick={() => setFormState((s) => ({ ...s, setAsMain: !s.setAsMain, role: !s.setAsMain ? "MASTER" : "SUB" }))}
                  className={cx("relative h-6 w-11 rounded-full transition", formState.setAsMain ? "bg-blue-600" : "bg-slate-300")}
                >
                  <span className={cx("absolute top-1 h-4 w-4 rounded-full bg-white transition", formState.setAsMain ? "left-6" : "left-1")} />
                </button>
              </label>
            </>
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2"><AppButton variant="soft" onClick={closeDialog}>Cancel</AppButton><AppButton variant="blue" onClick={saveAccount}>Save</AppButton></div>
      </Dialog>

      <Dialog open={dialogMode === "delete"} title="Delete Account" onClose={closeDialog}>
        <p className="text-sm text-slate-600">Are you sure you want to delete <span className="font-bold">{selectedAccount?.name}</span>?</p>
        <div className="mt-4 flex justify-end gap-2"><AppButton variant="soft" onClick={closeDialog}>Cancel</AppButton><AppButton variant="red" onClick={confirmDelete}>Delete</AppButton></div>
      </Dialog>
    </div>
  );
}

function buildNotifications(data) {
  const runtime = data?.runtime || {};
  const notifications = [];
  const logs = [
    ...(runtime.logs?.search || []).map((message) => ({ source: "search", message })),
    ...(runtime.logs?.risk || []).map((message) => ({ source: "risk", message })),
    ...(runtime.logs?.adapter || []).map((message) => ({ source: "adapter", message })),
  ];
  logs.slice(-40).forEach(({ source, message }, index) => {
    const text = String(message || "");
    const normalizedMessage = text.replace(/^\[[^\]]+\]\s*/, "").replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, "").trim();
    const id = `${source}-${normalizedMessage}`;
    if (notifications.some((item) => item.id === id)) return;
    const lower = normalizedMessage.toLowerCase();
    const level = text.includes("[ERROR]") || lower.includes("failed") || lower.includes("blocked") ? "error" : text.includes("[WARNING]") || lower.includes("disabled") || lower.includes("disconnected") ? "warning" : text.includes("[SUCCESS]") ? "success" : "info";
    const title = lower.includes("algo") || lower.includes("algorithmic") ? "MT5 Algo Trading" : source === "risk" || lower.includes("risk") ? "Risk management" : source === "adapter" || lower.includes("connect") || lower.includes("terminal") ? "Account connection" : lower.includes("copy") || lower.includes("order") || lower.includes("position") ? "Trade execution" : lower.includes("strategy") ? "Strategy status" : "System update";
    notifications.push({ id, title, message: normalizedMessage, level, category: title === "System update" ? "system" : "other" });
  });
  (data?.accounts || []).filter((account) => account.status === "Disconnected").forEach((account) => {
    notifications.push({ id: `disconnected-${account.login}`, title: "Account disconnected", message: `${account.name} is not connected.`, level: "warning" });
  });
  (data?.accounts || []).filter((account) => account.algoEnabled === false).forEach((account) => {
    notifications.push({ id: `algo-disabled-${account.login}`, title: "Algorithmic trading disabled", message: `${account.name} has Algo Trading disabled in MT5.`, level: "warning" });
  });
  return notifications.slice(-30).reverse();
}

function MasterConnectionRequiredPage() {
  return (
    <div className="flex min-h-[420px] items-center justify-center rounded-3xl border border-slate-200 bg-white px-6 py-16 shadow-sm">
      <div className="max-w-md text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-amber-50 text-amber-600">
          <WifiOff className="h-8 w-8" strokeWidth={2.5} />
        </div>
        <h3 className="mt-5 text-xl font-black text-slate-950">Master account is not connected</h3>
        <p className="mt-2 text-sm font-medium leading-6 text-slate-500">
          Connect the master account from the Dashboard to use this page.
        </p>
      </div>
    </div>
  );
}

function resolveBootstrapData(data, devModeEnabled) {
  if (!devModeEnabled) return data;
  if (Array.isArray(data?.accounts) && data.accounts.length > 0) return data;
  return buildDeveloperBootstrap();
}

function buildDeveloperBootstrap() {
  const accounts = initialAccounts.map((account) => ({
    ...account,
    floatingPnl: Number(account.pnl || 0),
    algoEnabled: true,
    sessionState: account.status === "Connected" ? "connected" : "disconnected",
    orderDelaySec: account.orderDelaySec ?? 0,
  }));
  const runtime = {
    strategy: {
      running: false,
      mode: null,
      started_at: null,
      tasks: [],
      start_time: null,
      end_time: null,
      last_stop_reason: null,
    },
    risk_monitor: {
      running: false,
      started_at: null,
      interval_sec: 60,
      risk_percent: 1,
      profit_percent: 1,
      orders_limit: 10,
      start_balance: null,
    },
    manual_trade: {
      auto_close_at: null,
      scheduled_at: null,
    },
    liquidity_levels: liquidityLevels,
    orders: [
      {
        id: "dev-open-1",
        ticket: 101001,
        symbol: "XAUUSD",
        side: "BUY",
        order_kind: "MARKET",
        lot: 0.12,
        entry: 3348.2,
        tp: 3358.2,
        sl: 3340.2,
        status: "open",
        origin: "manual",
        created_at: new Date().toISOString(),
      },
    ],
    sessions: {},
    logs: {
      search: strategyLogs,
      risk: ["[INFO] Developer mode risk monitor ready."],
      adapter: ["[INFO] Developer mode adapter simulation active."],
    },
    bootstrap_cache: {
      settings: {
        search_config: {
          timeframe: "M1",
          max_positions: 1,
          orders_limit: 10,
          pips: 10,
          max_pips: 100,
          tp: 400,
          sl: 200,
          enable_liquidity: true,
          enable_buy: true,
          enable_sell: true,
          stop_on_first_close: false,
          tp_type: true,
          sl_type: true,
        },
      },
    },
  };
  return {
    dev_mode: true,
    settings: {},
    accounts,
    metrics: {
      balance: accounts.reduce((sum, account) => sum + Number(account.balance || 0), 0),
      equity: accounts.reduce((sum, account) => sum + Number(account.equity || 0), 0),
      pnl: accounts.reduce((sum, account) => sum + Number(account.pnl || 0), 0),
      connected: accounts.filter((account) => account.status === "Connected").length,
      total: accounts.length,
    },
    logs: runtime.logs,
    runtime,
  };
}

function buildDeveloperTradeHistory() {
  return {
    history: [
      {
        id: "dev-history-1",
        ticket: 100901,
        account_login: "8888888",
        account_name: "Main Strategy Account",
        symbol: "XAUUSD",
        side: "BUY",
        lot: 0.1,
        entry: 3341.8,
        profit: 128.55,
        status: "Closed",
        comment: "Developer mode sample history row",
        created_at: new Date(Date.now() - 3600 * 1000).toISOString(),
      },
    ],
    summaries: [
      {
        login: "8888888",
        balance: 52458.75,
        initial_balance: 52330.2,
        profit: 128.55,
        profit_percent: 0.25,
      },
    ],
  };
}

const styles = {
  appShell: {
    minHeight: "100vh",
    overflowX: "clip",
    background: "#f1f5f9",
    color: "#020617",
  } satisfies React.CSSProperties,
  pageContent: { paddingTop: 24, paddingBottom: 24 } satisfies React.CSSProperties,
  errorBanner: {
    marginBottom: 16,
    border: "1px solid #fecdd3",
    borderRadius: 16,
    background: "#fff1f2",
    padding: "12px 16px",
    color: "#be123c",
    fontSize: 14,
    fontWeight: 600,
  } satisfies React.CSSProperties,
  loadingBanner: {
    marginBottom: 16,
    border: "1px solid #e2e8f0",
    borderRadius: 16,
    background: "white",
    padding: "12px 16px",
    color: "#475569",
    fontSize: 14,
    fontWeight: 600,
  } satisfies React.CSSProperties,
};
