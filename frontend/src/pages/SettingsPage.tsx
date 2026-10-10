import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRightLeft,
  Bell,
  CandlestickChart,
  Copy,
  ExternalLink,
  Keyboard,
  Minus,
  Monitor,
  Moon,
  Palette,
  Plus,
  RadioTower,
  RotateCcw,
  Save,
  ScrollText,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Terminal,
  Trash2,
  Users,
  Wrench,
  ZoomIn,
} from "lucide-react";
import { AppButton, Card } from "../components/ui/Primitives";
import { cx, decimalInput, money, riskLabel } from "../utils/format";
import { api } from "../services/api";
import {
  CANDLE_PRESETS,
  CHART_PALETTE,
  DEFAULT_APPEARANCE,
  candleColors,
} from "../utils/chartTheme";

const SETTINGS_TABS = [
  { id: "accounts", label: "Accounts", icon: Users },
  { id: "preferences", label: "Preferences", icon: SlidersHorizontal },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "appearance", label: "Appearance", icon: Palette },
];
// Older links (TopBar, saved state) still ask for the tabs that were merged
// into Preferences.
const LEGACY_TABS = { risk: "preferences", search: "preferences" };
const ZOOM_MIN = 70;
const ZOOM_MAX = 150;
const ZOOM_STEP = 10;
const ZOOM_PRESETS = [80, 90, 100, 110, 125, 150];

function normalizeSettingsTab(tab) {
  const mapped = LEGACY_TABS[tab] || tab;
  return SETTINGS_TABS.some((item) => item.id === mapped) ? mapped : "accounts";
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

// What the session risk form saves for its current mode. An empty profit
// limit means no profit stop.
function sessionRiskPayload(risk) {
  const isAmount = risk.mode === "amount";
  return {
    enabled: risk.enabled,
    mode: risk.mode,
    ...(isAmount
      ? {
          session_risk_amount: Number(risk.amount || 0),
          session_profit_amount: Number(risk.profitAmount || 0),
        }
      : {
          session_risk_percent: Number(risk.percent || 0),
          session_profit_percent: Number(risk.profitPercent || 0),
        }),
  };
}

export function SettingsPlaceholder({
  initialTab = "accounts",
  accountsData = [],
  runtime = null,
  onEdit,
  onDelete,
  onOpenPage,
  notificationSettings = {
    enabled: true,
    show_warnings: true,
    show_success: true,
    show_info: false,
  },
  onNotificationSettingsChange,
  themeMode = "LIGHT",
  onThemeModeChange,
  uiZoomPercent = 100,
  onUiZoomPercentChange,
  appearance = DEFAULT_APPEARANCE,
  onAppearanceChange,
  copyTradingEnabled = true,
  onCopyTradingChange,
  onRefreshRuntime,
}) {
  const [settingsTab, setSettingsTab] = useState(() =>
    normalizeSettingsTab(initialTab),
  );
  const [notice, setNotice] = useState(null);
  const noticeTimer = useRef(null);
  useEffect(
    () => setSettingsTab(normalizeSettingsTab(initialTab)),
    [initialTab],
  );
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

  function notify(text, tone = "success") {
    setNotice({ text, tone });
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(
      () => setNotice(null),
      tone === "error" ? 8000 : 4000,
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200">
        <nav className="flex flex-wrap gap-1" aria-label="Settings sections">
          {SETTINGS_TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setSettingsTab(id)}
              aria-current={settingsTab === id ? "page" : undefined}
              className={cx(
                "-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-3 text-sm font-bold transition",
                settingsTab === id
                  ? "border-blue-600 text-blue-600"
                  : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-900",
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </nav>
        {notice ? (
          <p
            role="status"
            className={cx(
              "rounded-lg px-3 py-1.5 text-xs font-bold",
              notice.tone === "error"
                ? "bg-rose-50 text-rose-700"
                : "bg-emerald-50 text-emerald-700",
            )}
          >
            {notice.text}
          </p>
        ) : null}
      </div>

      {settingsTab === "accounts" ? (
        <AccountsTab
          accountsData={accountsData}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ) : null}
      {settingsTab === "preferences" ? (
        <PreferencesTab
          accountsData={accountsData}
          runtime={runtime}
          notify={notify}
          onOpenPage={onOpenPage}
          copyTradingEnabled={copyTradingEnabled}
          onCopyTradingChange={onCopyTradingChange}
          onRefreshRuntime={onRefreshRuntime}
        />
      ) : null}
      {settingsTab === "notifications" ? (
        <NotificationsTab
          notificationSettings={notificationSettings}
          onNotificationSettingsChange={onNotificationSettingsChange}
          notify={notify}
        />
      ) : null}
      {settingsTab === "appearance" ? (
        <AppearanceTab
          notify={notify}
          themeMode={themeMode}
          onThemeModeChange={onThemeModeChange}
          uiZoomPercent={uiZoomPercent}
          onUiZoomPercentChange={onUiZoomPercentChange}
          appearance={appearance}
          onAppearanceChange={onAppearanceChange}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Shared building blocks                                              */
/* ------------------------------------------------------------------ */

function Section({
  icon: Icon,
  title,
  description = null,
  aside = null,
  children,
  className = "",
}) {
  return (
    <Card className={className}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-blue-50 text-blue-600">
            <Icon className="h-[18px] w-[18px]" />
          </span>
          <div className="min-w-0">
            <h3 className="text-base font-black text-slate-950">{title}</h3>
            {description ? (
              <p className="mt-0.5 text-xs leading-5 text-slate-500">
                {description}
              </p>
            ) : null}
          </div>
        </div>
        {aside}
      </div>
      <div className="mt-5">{children}</div>
    </Card>
  );
}

function Switch({ checked, onChange, disabled = false, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-blue-600" : "bg-slate-300",
      )}
    >
      <span
        className={cx(
          "h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200",
          checked ? "translate-x-6" : "translate-x-1",
        )}
      />
    </button>
  );
}

function ToggleRow({
  label,
  description = null,
  checked,
  onChange,
  disabled = false,
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
      <div>
        <p className="text-sm font-black text-slate-900">{label}</p>
        {description ? (
          <p className="mt-0.5 text-xs leading-5 text-slate-500">
            {description}
          </p>
        ) : null}
      </div>
      <Switch
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        label={label}
      />
    </div>
  );
}

function Segmented({ value, options, onChange, disabled = false, label }) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cx(
        "inline-grid gap-1 rounded-xl border border-slate-200 bg-slate-100 p-1",
        disabled && "opacity-60",
      )}
      style={{
        gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))`,
      }}
    >
      {options.map(({ value: optionValue, label: optionLabel, icon: Icon }) => (
        <button
          key={optionValue}
          type="button"
          role="radio"
          aria-checked={value === optionValue}
          disabled={disabled}
          onClick={() => onChange(optionValue)}
          className={cx(
            "inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-black transition disabled:cursor-not-allowed",
            value === optionValue
              ? "bg-white text-blue-700 shadow-sm"
              : "text-slate-500 hover:text-slate-900",
          )}
        >
          {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
          {optionLabel}
        </button>
      ))}
    </div>
  );
}

function StatusPill({ on, onText = "On", offText = "Off" }) {
  return (
    <span
      className={cx(
        "shrink-0 rounded-full px-2.5 py-1 text-[11px] font-black",
        on ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500",
      )}
    >
      {on ? onText : offText}
    </span>
  );
}

const inputClass =
  "mt-1.5 h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-900 outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-100 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400";

/* ------------------------------------------------------------------ */
/* Accounts                                                            */
/* ------------------------------------------------------------------ */

function AccountsTab({ accountsData, onEdit, onDelete }) {
  // Master on top, the rest in their saved order -- switching an account to
  // master moves its row to the first position.
  const orderedAccounts = useMemo(
    () =>
      [...accountsData].sort(
        (a, b) => Number(b.role === "MASTER") - Number(a.role === "MASTER"),
      ),
    [accountsData],
  );
  return (
    <div className="min-h-[420px] overflow-hidden rounded-[8px] border border-slate-200">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[940px] text-left">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="py-3 pl-4 pr-3 font-bold">Account</th>
              <th className="px-3 py-3 font-bold">Server</th>
              <th className="px-3 py-3 font-bold">Balance</th>
              <th className="px-3 py-3 font-bold">Risk per Trade</th>
              <th className="py-3 pl-3 pr-4 text-right font-bold">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {orderedAccounts.map((account) => (
              <tr
                key={account.login}
                className="border-t border-slate-100 hover:bg-slate-50/70"
              >
                <td className="py-4 pl-4 pr-3">
                  <div className="flex items-center gap-3">
                    <div
                      className={cx(
                        "grid h-11 w-11 place-items-center rounded-lg bg-gradient-to-br text-sm font-black text-white shadow-sm",
                        account.color,
                      )}
                    >
                      {(account.name || "A").charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-semibold text-slate-950">
                          {account.name}
                        </p>
                        <span
                          className={cx(
                            "rounded-full px-2 py-0.5 text-[10px] font-bold",
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
                <td className="break-words px-3 py-4 text-sm text-slate-700">
                  {account.server}
                </td>
                <td className="px-3 py-4 text-sm font-semibold text-slate-800">
                  {money(account.balance)}
                </td>
                <td className="px-3 py-4 text-sm font-semibold text-slate-800">
                  {riskLabel(account)}
                  <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold uppercase text-slate-500">
                    {account.riskMode === "amount" ? "amount" : "percent"}
                  </span>
                </td>
                <td className="py-4 pl-3 pr-4">
                  <div className="flex justify-end gap-2">
                    <button className="rounded-xl border border-slate-200 p-2 text-slate-500 hover:bg-white hover:text-blue-600">
                      <Terminal className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => onEdit?.(account)}
                      title="Edit account, risk per trade and delay"
                      className="rounded-xl border border-slate-200 p-2 text-slate-500 hover:bg-white hover:text-slate-950"
                    >
                      <Wrench className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => onDelete?.(account)}
                      className="rounded-xl border border-slate-200 p-2 text-slate-500 hover:bg-white hover:text-rose-600"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Preferences: session risk, copy trading, logs, remote               */
/* ------------------------------------------------------------------ */

function PreferencesTab({
  accountsData,
  runtime,
  notify,
  onOpenPage,
  copyTradingEnabled,
  onCopyTradingChange,
  onRefreshRuntime,
}) {
  const [loaded, setLoaded] = useState(false);
  const [sessionRisk, setSessionRisk] = useState({
    enabled: true,
    mode: "percent",
    percent: "2",
    amount: "",
    profitPercent: "",
    profitAmount: "",
  });
  const [remote, setRemote] = useState({
    enabled: false,
    token: "",
    receiver_url: "",
  });
  const [stopOnFinalTp, setStopOnFinalTp] = useState(true);
  const [spreadInRisk, setSpreadInRisk] = useState(true);
  const [busy, setBusy] = useState("");

  useEffect(() => {
    let active = true;
    api
      .settings()
      .then((settings) => {
        if (!active) return;
        const positive = (value) =>
          Number(value || 0) > 0 ? String(value) : "";
        const loadedRisk = {
          enabled: Boolean(settings?.session_risk_enabled ?? true),
          mode: settings?.session_risk_mode === "amount" ? "amount" : "percent",
          percent: String(settings?.session_risk_percent ?? 2),
          amount: positive(settings?.session_risk_amount),
          profitPercent: positive(settings?.session_profit_percent),
          profitAmount: positive(settings?.session_profit_amount),
        };
        setSessionRisk(loadedRisk);
        setSavedSessionRiskKey(JSON.stringify(sessionRiskPayload(loadedRisk)));
        setStopOnFinalTp(settings?.stop_on_final_tp !== false);
        setSpreadInRisk(settings?.spread_in_risk !== false);
        setRemote({
          enabled: Boolean(settings?.remote_control?.enabled),
          token: String(settings?.remote_control?.token || ""),
          receiver_url: String(settings?.remote_control?.receiver_url || ""),
        });
        setLoaded(true);
      })
      .catch((error) => notify(errorText(error), "error"));
    return () => {
      active = false;
    };
  }, []);

  // The switch saves at once; the limit type and the limits are a draft
  // saved by the Update button (or Enter in a limit field).
  const [savedSessionRiskKey, setSavedSessionRiskKey] = useState("");
  const sessionRiskDirty =
    loaded &&
    JSON.stringify(sessionRiskPayload(sessionRisk)) !== savedSessionRiskKey;

  async function persistSessionRisk(next) {
    const isAmount = next.mode === "amount";
    const value = Number((isAmount ? next.amount : next.percent) || 0);
    const profit = Number((isAmount ? next.profitAmount : next.profitPercent) || 0);
    if (!Number.isFinite(value) || value < 0 || (!isAmount && value > 100)) {
      notify(
        isAmount
          ? "Session loss limit must be an amount of 0 or more."
          : "Session loss limit must be between 0 and 100 percent.",
        "error",
      );
      return;
    }
    if (!Number.isFinite(profit) || profit < 0) {
      notify("Session profit limit must be 0 or more.", "error");
      return;
    }
    if (next.enabled && value <= 0) {
      notify(
        "Enter a session loss limit above 0 to turn the session risk guard on.",
        "error",
      );
      return;
    }
    const payload = sessionRiskPayload(next);
    const key = JSON.stringify(payload);
    if (key === savedSessionRiskKey) return true;
    const label = (amount: number) => (isAmount ? money(amount) : `${amount}%`);
    setBusy("session-risk");
    try {
      await api.saveSessionRisk(payload);
      setSavedSessionRiskKey(key);
      notify(
        next.enabled
          ? `Session risk saved: stops at ${label(value)} loss${profit > 0 ? ` or ${label(profit)} profit` : ""}.`
          : "Session risk guard turned off.",
      );
      onRefreshRuntime?.({ silent: true });
      return true;
    } catch (error) {
      notify(errorText(error), "error");
      return false;
    } finally {
      setBusy("");
    }
  }

  async function toggleSessionRisk(enabled: boolean) {
    const next = { ...sessionRisk, enabled };
    setSessionRisk(next);
    if (!(await persistSessionRisk(next))) {
      setSessionRisk((current) => ({ ...current, enabled: !enabled }));
    }
  }

  function editSessionRisk(patch: Partial<typeof sessionRisk>) {
    setSessionRisk((current) => ({ ...current, ...patch }));
  }

  function saveSessionRiskLimits() {
    if (sessionRiskDirty && busy !== "session-risk")
      persistSessionRisk(sessionRisk);
  }

  async function toggleStopOnFinalTp(enabled) {
    setBusy("final-tp");
    setStopOnFinalTp(enabled);
    try {
      await api.saveFinalTpStop(enabled);
      notify(
        enabled
          ? "Final TP stop on: a scalping final TP stops the search and closes all positions."
          : "Final TP stop off: scalping keeps searching after a final TP and positions stay open.",
      );
    } catch (error) {
      setStopOnFinalTp(!enabled);
      notify(errorText(error), "error");
    } finally {
      setBusy("");
    }
  }

  async function toggleSpreadInRisk(enabled) {
    setBusy("spread");
    setSpreadInRisk(enabled);
    try {
      await api.saveSpreadRisk(enabled);
      notify(
        enabled
          ? "Spread included: lots are sized to the SL including the spread pips."
          : "Spread excluded: a stop-out now loses more than the risk per trade.",
      );
    } catch (error) {
      setSpreadInRisk(!enabled);
      notify(errorText(error), "error");
    } finally {
      setBusy("");
    }
  }

  async function toggleCopyTrading(enabled) {
    setBusy("copy");
    onCopyTradingChange?.(enabled);
    try {
      await api.saveCopyTrading(enabled);
      notify(
        enabled
          ? "Copy trading on: master trades copy to connected sub accounts."
          : "Copy trading off: trades stay on the master account.",
      );
    } catch (error) {
      onCopyTradingChange?.(!enabled);
      notify(errorText(error), "error");
    } finally {
      setBusy("");
    }
  }

  async function toggleRemoteReceiver(enabled) {
    if (enabled && !remote.token.trim()) {
      notify(
        "Generate a receiver token on the Remote Control page before accepting trades.",
        "error",
      );
      return;
    }
    setBusy("remote");
    try {
      await api.saveRemoteControlSettings({ ...remote, enabled });
      setRemote((current) => ({ ...current, enabled }));
      notify(
        enabled
          ? "This PC now accepts trades from an authenticated controller."
          : "Remote receiver turned off.",
      );
    } catch (error) {
      notify(errorText(error), "error");
    } finally {
      setBusy("");
    }
  }

  async function clearLog(kind) {
    setBusy(`log-${kind}`);
    try {
      await api.clearLogs(kind);
      await onRefreshRuntime?.({
        silent: true,
        replaceSearchLogs: kind === "search",
      });
      notify(
        kind === "search"
          ? "Strategy & trade log cleared."
          : "Account & remote log cleared.",
      );
    } catch (error) {
      notify(errorText(error), "error");
    } finally {
      setBusy("");
    }
  }

  const liveRisk = runtime?.session_risk;
  const logCounts = {
    search: runtime?.logs?.search?.length ?? 0,
    adapter: runtime?.logs?.adapter?.length ?? 0,
  };
  const remoteConnections = Number(runtime?.remote_control?.connections || 0);
  const isAmountMode = sessionRisk.mode === "amount";

  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <Section
        icon={ShieldAlert}
        title="Session Risk Guard"
        description="Tracks the master account's balance (closed trades) from the start of a search session. On the loss or profit limit, every search stops and connected positions are closed. The session resets when all searches stop."
        aside={<StatusPill on={sessionRisk.enabled} />}
        className="xl:col-span-2"
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="flex flex-col rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-black text-slate-900">
                  Enable session risk guard
                </p>
                <p className="mt-0.5 text-xs leading-5 text-slate-500">
                  Turning this off removes the session loss stop.
                </p>
              </div>
              <Switch
                label="Enable session risk guard"
                checked={sessionRisk.enabled}
                onChange={toggleSessionRisk}
                disabled={!loaded || busy === "session-risk"}
              />
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {(
                [
                  {
                    label: "Session loss limit",
                    field: isAmountMode ? "amount" : "percent",
                    placeholder: isAmountMode ? "e.g. 500" : "e.g. 2",
                    max: isAmountMode ? undefined : "100",
                  },
                  {
                    label: "Session profit limit",
                    field: isAmountMode ? "profitAmount" : "profitPercent",
                    placeholder: isAmountMode ? "Off, e.g. 1000" : "Off, e.g. 4",
                    max: undefined,
                  },
                ] as const
              ).map(({ label, field, placeholder, max }) => (
                <label
                  key={label}
                  className="block text-xs font-black uppercase tracking-wide text-slate-500"
                >
                  {label} ({isAmountMode ? "$" : "%"})
                  <input
                    type="number"
                    min="0"
                    max={max}
                    step={isAmountMode ? "1" : "0.1"}
                    inputMode="decimal"
                    placeholder={placeholder}
                    value={sessionRisk[field]}
                    onChange={(event) =>
                      editSessionRisk({
                        [field]: decimalInput(event.target.value),
                      })
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter") saveSessionRiskLimits();
                    }}
                    className={inputClass}
                    disabled={!sessionRisk.enabled || !loaded}
                  />
                </label>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] leading-5 text-slate-500">
              Leave the profit limit empty to keep trading after any profit.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <AppButton
                onClick={saveSessionRiskLimits}
                disabled={
                  !sessionRisk.enabled ||
                  !sessionRiskDirty ||
                  busy === "session-risk"
                }
              >
                <Save className="h-4 w-4" />
                {busy === "session-risk" ? "Saving..." : "Update limits"}
              </AppButton>
              {sessionRisk.enabled && sessionRiskDirty ? (
                <span className="text-xs font-bold text-amber-600">
                  Unsaved changes
                </span>
              ) : null}
            </div>
            {liveRisk?.active ? (
              <p className="mt-4 rounded-lg bg-blue-50 px-3 py-2 text-xs font-bold text-blue-700">
                Live session:{" "}
                {Number(liveRisk.profit_amount || 0) > 0
                  ? `${money(Number(liveRisk.profit_amount))} profit (${Number(liveRisk.profit_percent || 0).toFixed(2)}%)`
                  : `${money(Number(liveRisk.loss_amount || 0))} loss (${Number(liveRisk.loss_percent || 0).toFixed(2)}%)`}{" "}
                from {money(Number(liveRisk.start_balance || 0))} starting
                balance.
              </p>
            ) : liveRisk?.hit ? (
              <p
                className={cx(
                  "mt-4 rounded-lg px-3 py-2 text-xs font-bold",
                  liveRisk.hit_type === "profit"
                    ? "bg-emerald-50 text-emerald-700"
                    : "bg-rose-50 text-rose-700",
                )}
              >
                {liveRisk.reason ||
                  "Session risk limit reached. Start a new search session to reset it."}
              </p>
            ) : null}
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-sm font-black text-slate-900">Limit type</p>
            <p className="mt-0.5 text-xs leading-5 text-slate-500">
              {isAmountMode
                ? "Limits are fixed amounts of master balance."
                : "Limits are a percent of the session's starting balance."}
            </p>
            <div className="mt-2.5">
              <Segmented
                label="Session limit type"
                value={sessionRisk.mode}
                disabled={!sessionRisk.enabled || !loaded}
                onChange={(mode) => editSessionRisk({ mode })}
                options={[
                  { value: "percent", label: "Percent (%)" },
                  { value: "amount", label: "Amount ($)" },
                ]}
              />
            </div>
          </div>
        </div>
      </Section>

      <Section
        icon={ArrowRightLeft}
        title="Trade"
        description="How trades are copied, sized and closed. Applies to manual, search and scalping trades."
        className="xl:col-span-2"
      >
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(260px,1fr))]">
          <div className="flex flex-col rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-black text-slate-900">Copy trades to sub accounts</p>
                <p className="mt-0.5 text-xs leading-5 text-slate-500">
                  Copy master trades to connected sub accounts, each sized by its own risk. Close-all still closes
                  sub positions.
                </p>
              </div>
              <Switch
                label="Copy trades to sub accounts"
                checked={copyTradingEnabled}
                onChange={toggleCopyTrading}
                disabled={busy === "copy"}
              />
            </div>
          </div>
          <div className="flex flex-col rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-black text-slate-900">
                  Stop scalping on final TP
                </p>
                <p className="mt-0.5 text-xs leading-5 text-slate-500">
                  On a scalping final TP (not TP1/TP2), stop the search and close all positions. When off, that side starts a new 5-minute zone search.
                </p>
              </div>
              <Switch
                label="Stop scalping on final TP"
                checked={stopOnFinalTp}
                onChange={toggleStopOnFinalTp}
                disabled={!loaded || busy === "final-tp"}
              />
            </div>
            <p
              className={cx(
                "mt-2.5 flex items-start gap-2 rounded-lg px-3 py-2 text-xs font-semibold leading-5",
                stopOnFinalTp
                  ? "bg-amber-50 text-amber-700"
                  : "bg-rose-50 text-rose-700",
              )}
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {stopOnFinalTp
                ? "Recommended: keep this on."
                : "Not recommended: scalping keeps trading and positions stay open."}
            </p>
          </div>
          <div className="flex flex-col rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-black text-slate-900">Include spread in risk</p>
                <p className="mt-0.5 text-xs leading-5 text-slate-500">
                  Size the lot to the SL including spread pips, so a stop-out loses exactly your risk per trade. Off:
                  you lose risk + spread.
                </p>
              </div>
              <Switch
                label="Include spread in risk"
                checked={spreadInRisk}
                onChange={toggleSpreadInRisk}
                disabled={!loaded || busy === "spread"}
              />
            </div>
          </div>
        </div>
      </Section>

      <Section
        icon={RadioTower}
        title="Remote"
        description="Let a controller PC send trades to this PC. Tokens, the receiver URL and controller targets are managed on the Remote Control page."
        aside={
          <StatusPill on={remote.enabled} onText="Receiving" offText="Off" />
        }
      >
        <ToggleRow
          label="Accept trades from a controller"
          description={
            remote.token
              ? "Only controllers with this PC's token can connect."
              : "No receiver token yet. Create one on the Remote Control page."
          }
          checked={remote.enabled}
          onChange={toggleRemoteReceiver}
          disabled={!loaded || busy === "remote"}
        />
        <dl className="mt-4 grid gap-2 text-xs sm:grid-cols-2">
          <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
            <dt className="font-bold uppercase tracking-wide text-slate-500">
              Receiver URL
            </dt>
            <dd
              className="mt-0.5 truncate font-semibold text-slate-900"
              title={remote.receiver_url}
            >
              {remote.receiver_url || "Not set"}
            </dd>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
            <dt className="font-bold uppercase tracking-wide text-slate-500">
              Controller connections
            </dt>
            <dd className="mt-0.5 font-semibold text-slate-900">
              {remoteConnections}
            </dd>
          </div>
        </dl>
        <AppButton
          variant="soft"
          className="mt-4"
          onClick={() => onOpenPage?.("remote")}
        >
          <ExternalLink className="h-4 w-4" /> Open Remote Control
        </AppButton>
      </Section>

      <Section
        icon={ScrollText}
        title="Logs"
        description="Each log keeps its latest 500 lines. Clearing removes them from this app only; trades and history are not affected."
      >
        <div className="grid gap-3">
          {[
            [
              "search",
              "Strategy & trade log",
              "Search, scalping, orders, copy trading and session risk.",
            ],
            [
              "adapter",
              "Account & remote log",
              "cTrader account connections and remote control activity.",
            ],
          ].map(([kind, label, help]) => (
            <div
              key={kind}
              className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-black text-slate-900">{label}</p>
                <p className="mt-0.5 text-xs leading-5 text-slate-500">
                  {help}
                </p>
                <p className="mt-1 text-[11px] font-bold text-slate-500">
                  {logCounts[kind]} line(s)
                </p>
              </div>
              <AppButton
                variant="soft"
                onClick={() => clearLog(kind)}
                disabled={busy === `log-${kind}` || logCounts[kind] === 0}
              >
                <Trash2 className="h-4 w-4" /> Clear
              </AppButton>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */

function NotificationsTab({
  notificationSettings,
  onNotificationSettingsChange,
  notify,
}) {
  async function save(nextSettings) {
    try {
      await api.saveNotificationSettings(nextSettings);
      onNotificationSettingsChange?.(nextSettings);
      notify("Notification preferences saved.");
    } catch (error) {
      notify(errorText(error), "error");
    }
  }

  return (
    <Section
      icon={Bell}
      title="Notification Preferences"
      description="Choose which events appear in the notification bell. Errors are always shown."
    >
      <div className="grid gap-3 lg:grid-cols-2">
        {[
          [
            "enabled",
            "Enable notifications",
            "Show notifications from account, search, remote, and risk events.",
          ],
          [
            "show_warnings",
            "Show warnings",
            "Include account disconnects, blocked commands, and warning events.",
          ],
          [
            "show_success",
            "Show successful actions",
            "Include successful orders, connections, and completed commands.",
          ],
          [
            "show_info",
            "Show informational updates",
            "Include routine system information messages.",
          ],
        ].map(([key, label, help]) => (
          <ToggleRow
            key={key}
            label={label}
            description={help}
            checked={Boolean(notificationSettings[key])}
            disabled={key !== "enabled" && !notificationSettings.enabled}
            onChange={(checked) =>
              save({ ...notificationSettings, [key]: checked })
            }
          />
        ))}
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Appearance                                                          */
/* ------------------------------------------------------------------ */

const THEME_OPTIONS = [
  {
    mode: "LIGHT",
    label: "Light",
    help: "Clean, high-contrast workspace for daytime trading.",
    icon: Sun,
  },
  {
    mode: "DARK",
    label: "Dark",
    help: "Reduced glare for low-light trading sessions.",
    icon: Moon,
  },
  {
    mode: "SYSTEM",
    label: "System",
    help: "Follow your operating system's light or dark setting.",
    icon: Monitor,
  },
];

// Fixed colors on purpose: each card previews its own theme, whatever the
// current one is.
const THEME_PREVIEW = {
  LIGHT: {
    shell: "#f1f5f9",
    side: "#ffffff",
    card: "#ffffff",
    line: "#e2e8f0",
    accent: "#2563eb",
  },
  DARK: {
    shell: "#1e1e1e",
    side: "#252526",
    card: "#2d2d2d",
    line: "#3c3c3c",
    accent: "#0e639c",
  },
};

function ThemePreview({ mode }) {
  if (mode === "SYSTEM") {
    return (
      <div className="relative h-20 overflow-hidden rounded-md border border-slate-200">
        <div
          className="absolute inset-0"
          style={{ clipPath: "polygon(0 0, 100% 0, 0 100%)" }}
        >
          <MiniShell colors={THEME_PREVIEW.LIGHT} />
        </div>
        <div
          className="absolute inset-0"
          style={{ clipPath: "polygon(100% 0, 100% 100%, 0 100%)" }}
        >
          <MiniShell colors={THEME_PREVIEW.DARK} />
        </div>
      </div>
    );
  }
  return (
    <div className="h-20 overflow-hidden rounded-md border border-slate-200">
      <MiniShell colors={THEME_PREVIEW[mode]} />
    </div>
  );
}

function MiniShell({ colors }) {
  return (
    <div className="flex h-full w-full" style={{ background: colors.shell }}>
      <div
        className="w-1/5 space-y-1.5 p-2"
        style={{ background: colors.side }}
      >
        <div
          className="h-1.5 rounded-full"
          style={{ background: colors.accent }}
        />
        <div
          className="h-1.5 rounded-full"
          style={{ background: colors.line }}
        />
        <div
          className="h-1.5 rounded-full"
          style={{ background: colors.line }}
        />
      </div>
      <div className="flex-1 space-y-1.5 p-2">
        <div
          className="h-2 w-1/2 rounded-full"
          style={{ background: colors.line }}
        />
        <div className="grid grid-cols-2 gap-1.5">
          <div
            className="h-8 rounded"
            style={{
              background: colors.card,
              border: `1px solid ${colors.line}`,
            }}
          />
          <div
            className="h-8 rounded"
            style={{
              background: colors.card,
              border: `1px solid ${colors.line}`,
            }}
          />
        </div>
      </div>
    </div>
  );
}

// [open, close, high, low] for the static preview chart.
const PREVIEW_CANDLES = [
  [40, 46, 48, 37],
  [46, 43, 49, 41],
  [43, 50, 52, 42],
  [50, 55, 58, 48],
  [55, 52, 57, 49],
  [52, 47, 54, 45],
  [47, 49, 52, 44],
  [49, 56, 59, 48],
  [56, 61, 63, 54],
  [61, 58, 64, 55],
  [58, 64, 66, 57],
  [64, 60, 67, 58],
  [60, 66, 69, 59],
  [66, 71, 74, 64],
];

function ChartPreview({ appearance, dark }) {
  const base = dark ? CHART_PALETTE.dark : CHART_PALETTE.light;
  const { upColor, downColor } = candleColors(appearance, dark);
  const width = 280;
  const height = 120;
  const toY = (value) => height - 10 - ((value - 34) / 42) * (height - 20);
  const step = width / PREVIEW_CANDLES.length;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-full w-full rounded-md"
      role="img"
      aria-label="Chart style preview"
    >
      <rect width={width} height={height} fill={base.background} />
      {appearance.chart_grid !== false
        ? [1, 2, 3].map((row) => (
            <line
              key={`h${row}`}
              x1="0"
              x2={width}
              y1={(height / 4) * row}
              y2={(height / 4) * row}
              stroke={base.grid}
              strokeWidth="1"
            />
          ))
        : null}
      {appearance.chart_grid !== false
        ? [1, 2, 3, 4, 5].map((col) => (
            <line
              key={`v${col}`}
              y1="0"
              y2={height}
              x1={(width / 6) * col}
              x2={(width / 6) * col}
              stroke={base.grid}
              strokeWidth="1"
            />
          ))
        : null}
      {PREVIEW_CANDLES.map(([open, close, high, low], index) => {
        const color = close >= open ? upColor : downColor;
        const x = step * index + step / 2;
        const top = toY(Math.max(open, close));
        const bottom = toY(Math.min(open, close));
        return (
          <g key={index}>
            <line
              x1={x}
              x2={x}
              y1={toY(high)}
              y2={toY(low)}
              stroke={color}
              strokeWidth="1.5"
            />
            <rect
              x={x - step * 0.3}
              y={top}
              width={step * 0.6}
              height={Math.max(2, bottom - top)}
              fill={color}
              rx="1"
            />
          </g>
        );
      })}
      {appearance.chart_crosshair === "magnet" ? (
        <circle
          cx={step * 9.5}
          cy={toY(58)}
          r="3.5"
          fill="none"
          stroke={base.text}
          strokeWidth="1.5"
        />
      ) : null}
      <line
        x1={step * 9.5}
        x2={step * 9.5}
        y1="0"
        y2={height}
        stroke={base.text}
        strokeDasharray="3 3"
        strokeOpacity="0.5"
      />
      <line
        x1="0"
        x2={width}
        y1={toY(appearance.chart_crosshair === "magnet" ? 58 : 62)}
        y2={toY(appearance.chart_crosshair === "magnet" ? 58 : 62)}
        stroke={base.text}
        strokeDasharray="3 3"
        strokeOpacity="0.5"
      />
    </svg>
  );
}

function AppearanceTab({
  notify,
  themeMode,
  onThemeModeChange,
  uiZoomPercent,
  onUiZoomPercentChange,
  appearance,
  onAppearanceChange,
}) {
  const [zoomDraft, setZoomDraft] = useState(uiZoomPercent);
  const draggingZoom = useRef(false);
  const pendingAppearance = useRef({});
  const appearanceTimer = useRef(null);
  const prefersDark = useMemo(
    () => Boolean(window.matchMedia?.("(prefers-color-scheme: dark)").matches),
    [themeMode],
  );
  const previewDark =
    themeMode === "DARK" || (themeMode === "SYSTEM" && prefersDark);

  useEffect(() => {
    if (!draggingZoom.current) setZoomDraft(uiZoomPercent);
  }, [uiZoomPercent]);
  useEffect(() => () => window.clearTimeout(appearanceTimer.current), []);

  async function saveTheme(mode) {
    const previous = themeMode;
    onThemeModeChange?.(mode);
    try {
      await api.saveTheme(mode);
      notify(
        `${THEME_OPTIONS.find((item) => item.mode === mode)?.label} theme saved.`,
      );
    } catch (error) {
      onThemeModeChange?.(previous);
      notify(errorText(error), "error");
    }
  }

  // The canvas repaints immediately; saves are batched so dragging a color
  // picker doesn't send a request per pixel.
  function updateAppearance(patch) {
    onAppearanceChange?.({ ...appearance, ...patch });
    pendingAppearance.current = { ...pendingAppearance.current, ...patch };
    window.clearTimeout(appearanceTimer.current);
    appearanceTimer.current = window.setTimeout(async () => {
      const changes = pendingAppearance.current;
      pendingAppearance.current = {};
      try {
        await api.saveAppearance(changes);
        notify("Appearance saved.");
      } catch (error) {
        notify(errorText(error), "error");
      }
    }, 350);
  }

  function commitZoom(value) {
    draggingZoom.current = false;
    const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(value) || 100));
    setZoomDraft(zoom);
    if (zoom !== uiZoomPercent) onUiZoomPercentChange?.(zoom);
  }

  const customColors = candleColors(
    { ...appearance, chart_candle_preset: "custom" },
    previewDark,
  );

  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <Section
        icon={Palette}
        title="Theme"
        description="Applies to the whole app, including charts."
        className="xl:col-span-2"
      >
        <div
          className="grid gap-3 sm:grid-cols-3"
          role="radiogroup"
          aria-label="Theme"
        >
          {THEME_OPTIONS.map(({ mode, label, help, icon: Icon }) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={themeMode === mode}
              onClick={() => themeMode !== mode && saveTheme(mode)}
              className={cx(
                "rounded-lg border p-3 text-left transition",
                themeMode === mode
                  ? "border-blue-500 bg-blue-50 ring-2 ring-blue-100"
                  : "border-slate-200 bg-white hover:border-slate-300",
              )}
            >
              <ThemePreview mode={mode} />
              <span className="mt-3 flex items-center gap-2 text-sm font-black text-slate-950">
                <Icon className="h-4 w-4" /> {label}
              </span>
              <span className="mt-1 block text-xs leading-5 text-slate-500">
                {help}
              </span>
            </button>
          ))}
        </div>
      </Section>

      <Section
        icon={ZoomIn}
        title="Interface Scale"
        description="Scales the entire interface like browser zoom. Applied when you release the slider."
        aside={
          <output className="min-w-16 rounded-lg bg-blue-50 px-3 py-1.5 text-center text-sm font-black text-blue-600">
            {zoomDraft}%
          </output>
        }
      >
        <div className="flex items-center gap-3">
          <button
            type="button"
            aria-label="Zoom out"
            onClick={() => commitZoom(uiZoomPercent - ZOOM_STEP)}
            disabled={uiZoomPercent <= ZOOM_MIN}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-40"
          >
            <Minus className="h-4 w-4" />
          </button>
          <input
            aria-label="Interface scale"
            className="w-full accent-blue-600"
            type="range"
            min={ZOOM_MIN}
            max={ZOOM_MAX}
            step="5"
            value={zoomDraft}
            onPointerDown={() => {
              draggingZoom.current = true;
            }}
            onChange={(event) => setZoomDraft(Number(event.target.value))}
            onPointerUp={(event) => commitZoom(event.currentTarget.value)}
            onKeyUp={(event) => commitZoom(event.currentTarget.value)}
            onBlur={(event) => commitZoom(event.currentTarget.value)}
          />
          <button
            type="button"
            aria-label="Zoom in"
            onClick={() => commitZoom(uiZoomPercent + ZOOM_STEP)}
            disabled={uiZoomPercent >= ZOOM_MAX}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-40"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {ZOOM_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => commitZoom(preset)}
              className={cx(
                "rounded-lg border px-3 py-1.5 text-xs font-black transition",
                uiZoomPercent === preset
                  ? "border-blue-500 bg-blue-50 text-blue-700"
                  : "border-slate-200 bg-white text-slate-600 hover:border-slate-300",
              )}
            >
              {preset}%
            </button>
          ))}
          <button
            type="button"
            onClick={() => commitZoom(100)}
            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-bold text-blue-600 hover:text-blue-700"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Reset
          </button>
        </div>
        <p className="mt-4 flex flex-wrap items-center gap-1.5 text-[11px] font-semibold text-slate-500">
          <Keyboard className="h-3.5 w-3.5" /> Shortcuts:
          <kbd className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] text-slate-700">
            Ctrl +
          </kbd>
          <kbd className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] text-slate-700">
            Ctrl −
          </kbd>
          <kbd className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] text-slate-700">
            Ctrl 0
          </kbd>
          reset
        </p>
      </Section>

      <Section
        icon={Sparkles}
        title="Motion"
        description="Animations used for page changes, menus and toggles."
      >
        <ToggleRow
          label="Reduce motion"
          description="Turns off page transitions and UI animations. Loading spinners keep spinning."
          checked={Boolean(appearance.reduce_motion)}
          onChange={(reduce_motion) => updateAppearance({ reduce_motion })}
        />
      </Section>

      <Section
        icon={CandlestickChart}
        title="Chart"
        description="Applies to the trading chart and the dashboard equity chart."
        className="xl:col-span-2"
      >
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-5">
            <div>
              <p className="text-xs font-black uppercase tracking-wide text-slate-500">
                Candle colors
              </p>
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {CANDLE_PRESETS.map((preset) => {
                  const colors = candleColors(
                    { ...appearance, chart_candle_preset: preset.id },
                    previewDark,
                  );
                  const selected =
                    (appearance.chart_candle_preset || "default") === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() =>
                        updateAppearance({ chart_candle_preset: preset.id })
                      }
                      className={cx(
                        "flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition",
                        selected
                          ? "border-blue-500 bg-blue-50 ring-2 ring-blue-100"
                          : "border-slate-200 bg-white hover:border-slate-300",
                      )}
                    >
                      <span
                        className="flex items-end gap-0.5"
                        aria-hidden="true"
                      >
                        <span
                          className="h-5 w-2 rounded-sm"
                          style={{ background: colors.upColor }}
                        />
                        <span
                          className="h-3.5 w-2 rounded-sm"
                          style={{ background: colors.downColor }}
                        />
                        <span
                          className="h-4 w-2 rounded-sm"
                          style={{ background: colors.upColor }}
                        />
                      </span>
                      <span className="text-xs font-black text-slate-800">
                        {preset.label}
                      </span>
                    </button>
                  );
                })}
              </div>
              {appearance.chart_candle_preset === "custom" ? (
                <div className="mt-3 flex flex-wrap gap-4">
                  {[
                    ["chart_up_color", "Up candle", customColors.upColor],
                    ["chart_down_color", "Down candle", customColors.downColor],
                  ].map(([key, label, value]) => (
                    <label
                      key={key}
                      className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700"
                    >
                      <input
                        type="color"
                        value={value}
                        onChange={(event) =>
                          updateAppearance({ [key]: event.target.value })
                        }
                        className="h-7 w-9 cursor-pointer rounded border-0 bg-transparent p-0"
                      />
                      {label}
                      <span className="font-mono text-[11px] text-slate-500">
                        {value}
                      </span>
                    </label>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <ToggleRow
                label="Grid lines"
                description="Background price and time grid."
                checked={appearance.chart_grid !== false}
                onChange={(chart_grid) => updateAppearance({ chart_grid })}
              />
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-sm font-black text-slate-900">Crosshair</p>
                <p className="mt-0.5 text-xs leading-5 text-slate-500">
                  Magnet snaps to the candle's close.
                </p>
                <div className="mt-2.5">
                  <Segmented
                    label="Crosshair mode"
                    value={
                      appearance.chart_crosshair === "magnet"
                        ? "magnet"
                        : "normal"
                    }
                    onChange={(chart_crosshair) =>
                      updateAppearance({ chart_crosshair })
                    }
                    options={[
                      { value: "normal", label: "Free" },
                      { value: "magnet", label: "Magnet" },
                    ]}
                  />
                </div>
              </div>
            </div>
          </div>
          <div>
            <p className="text-xs font-black uppercase tracking-wide text-slate-500">
              Preview
            </p>
            <div className="mt-2 h-[150px] overflow-hidden rounded-lg border border-slate-200">
              <ChartPreview appearance={appearance} dark={previewDark} />
            </div>
          </div>
        </div>
      </Section>
    </div>
  );
}
