import React, { useEffect, useState } from "react";
import { Terminal, Trash2, Wrench } from "lucide-react";
import { AppButton, Card } from "../components/ui/Primitives";
import { cx, money } from "../utils/format";
import { api } from "../services/api";

export function SettingsPlaceholder({
  initialTab = "accounts",
  accountsData = [],
  onEdit,
  onDelete,
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
}) {
  const settingsTabs = ["accounts", "search", "notifications", "appearance"];
  const normalizeSettingsTab = (tab) =>
    settingsTabs.includes(tab) ? tab : "accounts";
  const [settingsTab, setSettingsTab] = useState(
    normalizeSettingsTab(initialTab),
  );
  const [searchSettings, setSearchSettings] = useState({
    timeframe: "M1",
    pips: 25,
    max_pips: 70,
    max_positions: 3,
    orders_limit: 10,
    tp: 150,
    sl: 500,
    enable_buy: true,
    enable_sell: true,
    enable_liquidity: true,
    enable_pullback: false,
    pullback_pips: 20,
    stop_on_first_close: true,
  });
  const [settingsMessage, setSettingsMessage] = useState("");
  useEffect(
    () => setSettingsTab(normalizeSettingsTab(initialTab)),
    [initialTab],
  );
  useEffect(() => {
    api
      .settings()
      .then((settings) => {
        if (settings?.search_config)
          setSearchSettings((current) => ({
            ...current,
            ...settings.search_config,
          }));
      })
      .catch(() => {});
  }, []);

  async function saveSearchSettings() {
    try {
      await api.saveSearchConfig(searchSettings);
      setSettingsMessage(
        "Search defaults saved. New searches will use these values.",
      );
    } catch (error) {
      setSettingsMessage(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async function saveNotificationSettings(nextSettings) {
    try {
      await api.saveNotificationSettings(nextSettings);
      onNotificationSettingsChange?.(nextSettings);
      setSettingsMessage("Notification preferences saved.");
    } catch (error) {
      setSettingsMessage(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async function saveThemeMode(nextThemeMode) {
    try {
      await api.saveTheme(nextThemeMode);
      onThemeModeChange?.(nextThemeMode);
      setSettingsMessage(
        `${nextThemeMode === "DARK" ? "Dark" : "Light"} appearance saved.`,
      );
    } catch (error) {
      setSettingsMessage(
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  async function saveUiZoom(nextZoom) {
    const zoom = Math.min(150, Math.max(70, Number(nextZoom || 100)));
    onUiZoomPercentChange?.(zoom);
    try {
      await api.saveZoom(zoom);
      setSettingsMessage(`App zoom saved at ${zoom}%.`);
    } catch (error) {
      setSettingsMessage(
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  const tabNavigation = (
    <div className="flex flex-wrap gap-5 border-b border-slate-200">
      {settingsTabs.map((tab) => (
        <button
          key={tab}
          type="button"
          onClick={() => setSettingsTab(tab)}
          className={cx(
            "border-b-2 px-1 py-3 text-sm font-bold capitalize transition",
            settingsTab === tab
              ? "border-blue-600 text-blue-600"
              : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-900",
          )}
        >
          {tab}
        </button>
      ))}
    </div>
  );

  if (settingsTab !== "accounts") {
    return (
      <div className="space-y-6">
        {tabNavigation}
        <Card>
          {settingsTab === "search" ? (
            <>
              <h3 className="text-lg font-black text-slate-950">
                Search Defaults
              </h3>
              <div className="mt-6 grid gap-4 md:grid-cols-3">
                <label className="text-sm font-bold text-slate-700">
                  Timeframe
                  <select
                    value={searchSettings.timeframe}
                    onChange={(event) =>
                      setSearchSettings({
                        ...searchSettings,
                        timeframe: event.target.value,
                      })
                    }
                    className="mt-2 h-11 w-full rounded-xl border border-slate-200 bg-white px-3 font-semibold"
                  >
                    <option>M1</option>
                    <option>M3</option>
                    <option>M5</option>
                    <option>M15</option>
                  </select>
                </label>
                {[
                  ["pips", "Minimum Pips"],
                  ["max_pips", "Maximum Pips"],
                  ["max_positions", "Maximum Positions"],
                  ["orders_limit", "Search Order Limit"],
                  ["tp", "Take Profit"],
                  ["sl", "Stop Loss"],
                  ["pullback_pips", "Pullback Pips"],
                ].map(([key, label]) => (
                  <label key={key} className="text-sm font-bold text-slate-700">
                    {label}
                    <input
                      type="number"
                      min="0"
                      value={searchSettings[key] ?? ""}
                      onChange={(event) =>
                        setSearchSettings({
                          ...searchSettings,
                          [key]: Number(event.target.value),
                        })
                      }
                      className="mt-2 h-11 w-full rounded-xl border border-slate-200 bg-white px-3 font-semibold"
                    />
                  </label>
                ))}
              </div>
              <div className="mt-5 flex flex-wrap gap-5 text-sm font-bold text-slate-700">
                {[
                  ["enable_buy", "Enable BUY"],
                  ["enable_sell", "Enable SELL"],
                  ["enable_liquidity", "Liquidity trigger"],
                  ["enable_pullback", "Enable pullback"],
                  ["stop_on_first_close", "Stop after first close"],
                ].map(([key, label]) => (
                  <label key={key} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={Boolean(searchSettings[key])}
                      onChange={(event) =>
                        setSearchSettings({
                          ...searchSettings,
                          [key]: event.target.checked,
                        })
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>
              <AppButton
                variant="blue"
                className="mt-6"
                onClick={saveSearchSettings}
              >
                Save Search Defaults
              </AppButton>
            </>
          ) : null}

          {settingsTab === "notifications" ? (
            <>
              <h3 className="text-lg font-black text-slate-950">
                Notification Preferences
              </h3>
              <div className="mt-6 space-y-4">
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
                  <label
                    key={key}
                    className="flex items-start justify-between gap-4 rounded-lg border border-slate-200 p-4"
                  >
                    <span>
                      <span className="block text-sm font-black text-slate-900">
                        {label}
                      </span>
                      <span className="mt-1 block text-xs leading-5 text-slate-500">
                        {help}
                      </span>
                    </span>
                    <input
                      type="checkbox"
                      checked={Boolean(notificationSettings[key])}
                      onChange={(event) =>
                        saveNotificationSettings({
                          ...notificationSettings,
                          [key]: event.target.checked,
                        })
                      }
                      className="mt-1 h-4 w-4"
                    />
                  </label>
                ))}
              </div>
            </>
          ) : null}

          {settingsTab === "appearance" ? (
            <>
              <h3 className="text-lg font-black text-slate-950">Appearance</h3>
              <div className="mt-6 grid max-w-xl gap-3 sm:grid-cols-2">
                {[
                  [
                    "LIGHT",
                    "Light",
                    "Clean, high-contrast workspace for daytime trading.",
                  ],
                  [
                    "DARK",
                    "Dark",
                    "Reduced glare for low-light trading sessions.",
                  ],
                ].map(([mode, label, help]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => saveThemeMode(mode)}
                    className={cx(
                      "rounded-lg border p-4 text-left transition",
                      themeMode === mode
                        ? "border-blue-500 bg-blue-50"
                        : "border-slate-200 bg-white hover:border-slate-300",
                    )}
                  >
                    <span className="block text-sm font-black text-slate-950">
                      {label}
                    </span>
                    <span className="mt-1 block text-xs leading-5 text-slate-500">
                      {help}
                    </span>
                  </button>
                ))}
              </div>
              <div className="mt-7 max-w-xl rounded-lg border border-slate-200 bg-slate-50 p-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <span className="block text-sm font-black text-slate-950">
                      App zoom
                    </span>
                    <span className="mt-1 block text-xs leading-5 text-slate-500">
                      Scale the entire interface like browser zoom.
                    </span>
                  </div>
                  <output className="min-w-14 rounded-lg bg-white px-3 py-1.5 text-center text-sm font-black text-blue-600">
                    {uiZoomPercent}%
                  </output>
                </div>
                <input
                  aria-label="App zoom"
                  className="mt-4 w-full accent-blue-600"
                  type="range"
                  min="70"
                  max="150"
                  step="5"
                  value={uiZoomPercent}
                  onChange={(event) =>
                    onUiZoomPercentChange?.(Number(event.target.value))
                  }
                  onPointerUp={(event) => saveUiZoom(event.currentTarget.value)}
                  onKeyUp={(event) => saveUiZoom(event.currentTarget.value)}
                />
                <div className="mt-2 flex justify-between text-[11px] font-bold text-slate-500">
                  <span>70%</span>
                  <button
                    type="button"
                    className="text-blue-600 hover:text-blue-700"
                    onClick={() => saveUiZoom(100)}
                  >
                    Reset to 100%
                  </button>
                  <span>150%</span>
                </div>
              </div>
            </>
          ) : null}
          {settingsMessage ? (
            <p className="mt-5 text-sm font-semibold text-emerald-700">
              {settingsMessage}
            </p>
          ) : null}
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {tabNavigation}
      <div>
        <div className="min-h-[420px] overflow-hidden rounded-[8px] border border-slate-200">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[940px] text-left">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-3 pl-4 pr-3 font-bold">Account</th>
                  <th className="px-3 py-3 font-bold">Server</th>
                  <th className="px-3 py-3 font-bold">Balance</th>
                  <th className="px-3 py-3 font-bold">Risk Percent</th>
                  <th className="py-3 pl-3 pr-4 text-right font-bold">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {accountsData.map((account) => (
                  <tr
                    key={account.id}
                    className="border-t border-slate-100 hover:bg-slate-50/70"
                  >
                    <td className="py-4 pl-4 pr-3">
                      <div className="flex items-center gap-3">
                        <div
                          className={cx(
                            "grid h-11 w-11 place-items-center rounded-lg bg-gradient-to-br text-xs font-black text-white shadow-sm",
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
                    <td className="px-3 py-4 text-sm text-slate-700 break-words">
                      {account.server}
                    </td>
                    <td className="px-3 py-4 text-sm font-semibold text-slate-800">
                      {money(account.balance)}
                    </td>
                    <td className="px-3 py-4 text-sm font-semibold text-slate-800">
                      {Number(account.risk ?? 1).toFixed(2)}
                    </td>
                    <td className="py-4 pl-3 pr-4">
                      <div className="flex justify-end gap-2">
                        <button className="rounded-xl border border-slate-200 p-2 text-slate-500 hover:bg-white hover:text-blue-600">
                          <Terminal className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => onEdit?.(account)}
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
      </div>
    </div>
  );
}
