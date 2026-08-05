import React, { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import Sidebar from "./components/layout/Sidebar";
import TopBar from "./components/layout/TopBar";
import { AppButton, Dialog, Field, SelectBox } from "./components/ui/Primitives";
import DashboardPage from "./pages/DashboardPage";
import SearchPage from "./pages/SearchPage";
import { RiskManagementPage, SettingsPlaceholder, TradePage } from "./pages/Placeholders";
import TradeHistoryPage from "./pages/TradeHistoryPage";
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
  const [activePage, setActivePage] = useState("dashboard");
  const [accountList, setAccountList] = useState([]);
  const [runtime, setRuntime] = useState(null);
  const [loadingBootstrap, setLoadingBootstrap] = useState(true);
  const [errorText, setErrorText] = useState("");
  const [refreshPausedByPage, setRefreshPausedByPage] = useState(false);
  const [dialogMode, setDialogMode] = useState(null);
  const [selectedAccount, setSelectedAccount] = useState(null);
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

  const refreshBootstrap = useCallback(async (options = {}) => {
    const { silent = false } = options;
    if (!silent) setLoadingBootstrap(true);
    try {
      const data = await api.bootstrap();
      setAccountList(Array.isArray(data.accounts) ? data.accounts : []);
      setRuntime(data.runtime || null);
      setErrorText("");
      return data;
    } catch (error) {
      setErrorText(String(error?.message || error));
      return null;
    } finally {
      if (!silent) setLoadingBootstrap(false);
    }
  }, []);

  useEffect(() => {
    refreshBootstrap();
  }, [refreshBootstrap]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (refreshPausedByPage) {
        return;
      }
      refreshBootstrap({ silent: true });
    }, 2500);
    return () => clearInterval(timer);
  }, [refreshBootstrap, refreshPausedByPage]);

  const totals = useMemo(
    () => ({
      balance: accountList.reduce((sum, account) => sum + account.balance, 0),
      equity: accountList.reduce((sum, account) => sum + account.equity, 0),
      connected: accountList.filter((account) => account.status === "Connected").length,
      pnl: accountList.reduce((sum, account) => sum + account.pnl, 0),
    }),
    [accountList]
  );

  const masterAccount = useMemo(
    () => accountList.find((account) => account.role === "MASTER") || null,
    [accountList],
  );

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
        risk_multiplier: Number(formState.risk || 1),
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
      await api.connectAccount(Number(account.login));
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
                : "Trading Control Center";

  return (
    <div className="lg:grid lg:grid-cols-[264px_minmax(0,1fr)]" style={styles.appShell}>
      <Sidebar activePage={activePage} onChangePage={setActivePage} connectedCount={totals.connected} totalCount={accountList.length} />
      <main className="min-w-0">
        <TopBar pageTitle={pageTitle} activePage={activePage} onChangePage={setActivePage} onAddAccount={openAddDialog} masterAccount={masterAccount} />
        <div className="px-5 py-6 lg:px-8" style={styles.pageContent}>
          <motion.div key={activePage} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22 }}>
            {errorText ? <div style={styles.errorBanner}>{errorText}</div> : null}
            {loadingBootstrap ? <div style={styles.loadingBanner}>Loading backend data...</div> : null}
            {activePage === "dashboard" && <DashboardPage totals={totals} accountsData={accountList} onAdd={openAddDialog} onEdit={openEditDialog} onDelete={openDeleteDialog} onConnect={connectAccountAndSync} />}
            {activePage === "search" && <SearchPage runtime={runtime} onRefreshRuntime={refreshBootstrap} onPickerInteractionChange={setRefreshPausedByPage} />}
            {activePage === "trade" && <TradePage runtime={runtime} onRefreshRuntime={refreshBootstrap} />}
            {activePage === "history" && <TradeHistoryPage runtime={runtime} />}
            {activePage === "risk" && <RiskManagementPage runtime={runtime} onRefreshRuntime={refreshBootstrap} />}
            {activePage === "settings" && <SettingsPlaceholder accountsData={accountList} onEdit={openEditDialog} onDelete={openDeleteDialog} />}
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
              <SelectBox label="Position Delay (sec)" value={String(formState.orderDelaySec)} options={["0","1","2","3","4","5","6","7","8","9","10"]} onChange={(e) => setFormState((s) => ({ ...s, orderDelaySec: e.target.value }))} />
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

const styles = {
  appShell: {
    minHeight: "100vh",
    overflowX: "hidden",
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
