import React, { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  CircleOff,
  Copy,
  KeyRound,
  Laptop,
  RadioTower,
  RefreshCw,
  Save,
  Wifi,
} from "lucide-react";
import { LogList } from "../components/ui/LogList";
import { api } from "../services/api";
import { connectRemote, disconnectRemote, subscribeRemoteLogs, subscribeRemoteStatus } from "../services/remoteControl";

const defaultUrl = import.meta.env.VITE_REMOTE_COMMAND_URL || "";
const REMOTE_ROLE_STORAGE_KEY = "trader.remoteControl.role";

type RemoteRole = "receiver" | "controller";
type RemoteTab = "settings" | "logs";
type RemoteLogEntry = {
  id: string;
  level: "info" | "success" | "warning" | "error";
  message: string;
  at: string;
};

const roles = [
  {
    id: "receiver" as const,
    eyebrow: "Trading PC",
    title: "Receiver",
    description: "Runs MT5 and securely receives mirrored trade commands.",
    icon: RadioTower,
    accent: "emerald",
  },
  {
    id: "controller" as const,
    eyebrow: "Your control PC",
    title: "Controller / Trader",
    description: "Connects to the receiver and sends trades from this app.",
    icon: Laptop,
    accent: "cyan",
  },
];

type RemoteFieldProps = React.InputHTMLAttributes<HTMLInputElement> & {
  label: string;
};

function RemoteField({ label, className = "", ...props }: RemoteFieldProps) {
  return (
    <label className={`block min-w-0 ${className}`}>
      <span className="mb-2 block text-xs font-black uppercase tracking-[0.12em] text-slate-500">{label}</span>
      <input
        {...props}
        className="block h-12 w-full rounded-xl border border-slate-200 bg-slate-50 px-4 text-sm font-semibold text-slate-900 outline-none transition placeholder:font-medium placeholder:text-slate-400 focus:border-cyan-500 focus:bg-white focus:ring-4 focus:ring-cyan-100"
      />
    </label>
  );
}

type RemoteButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: "primary" | "success" | "secondary";
};

function RemoteButton({ children, tone = "secondary", className = "", ...props }: RemoteButtonProps) {
  const toneClass = {
    primary: "bg-cyan-600 text-white shadow-lg shadow-cyan-600/20 hover:bg-cyan-700",
    success: "bg-emerald-600 text-white shadow-lg shadow-emerald-600/20 hover:bg-emerald-700",
    secondary: "border border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50",
  }[tone];

  return (
    <button
      type="button"
      {...props}
      className={`inline-flex h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-black transition duration-200 disabled:cursor-not-allowed disabled:opacity-50 ${toneClass} ${className}`}
    >
      {children}
    </button>
  );
}

function inferServerLevel(message: string): RemoteLogEntry["level"] {
  const line = message.toLowerCase();
  if (line.includes("failed") || line.includes("rejected") || line.includes("timed out") || line.includes("disabled")) return "error";
  if (line.includes("disconnected") || line.includes("active connections: 0")) return "warning";
  if (line.includes("executed") || line.includes("authenticated successfully")) return "success";
  return "info";
}

function RemoteLogPanel({ emptyText, entries }: { emptyText: string; entries: RemoteLogEntry[] }) {
  const lines = entries.map((entry) => `[${entry.level.toUpperCase()}] ${entry.at} ${entry.message}`);

  return (
    <div className="min-h-[420px] rounded-2xl border border-slate-200 bg-white">
        <LogList logs={lines} emptyMessage={emptyText} className="max-h-[420px] overflow-y-auto" />
    </div>
  );
}

function RemoteTabs({
  role,
  activeTab,
  onChange,
}: {
  role: RemoteRole;
  activeTab: RemoteTab;
  onChange: (tab: RemoteTab) => void;
}) {
  const accent =
    role === "receiver"
      ? {
          active: "text-emerald-600",
          idle: "text-slate-500 hover:text-slate-950",
        }
      : {
          active: "text-cyan-600",
          idle: "text-slate-500 hover:text-slate-950",
        };

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-slate-200">
      {[
        { id: "settings" as const, label: "Settings" },
        { id: "logs" as const, label: "Logs" },
      ].map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className={`relative px-3 py-4 text-sm font-bold transition ${
            activeTab === tab.id ? accent.active : accent.idle
          }`}
        >
          {tab.label}
          {activeTab === tab.id ? (
            <span className={`absolute inset-x-3 bottom-0 h-0.5 rounded-full ${role === "receiver" ? "bg-emerald-500" : "bg-cyan-600"}`} />
          ) : null}
        </button>
      ))}
    </div>
  );
}

export default function RemoteControlPage() {
  const [role, setRole] = useState<RemoteRole | null>(() => {
    try {
      const savedRole = globalThis.localStorage?.getItem(REMOTE_ROLE_STORAGE_KEY);
      return savedRole === "receiver" || savedRole === "controller" ? savedRole : null;
    } catch {
      return null;
    }
  });
  const [url, setUrl] = useState(defaultUrl);
  const [token, setToken] = useState("");
  const [receiverEnabled, setReceiverEnabled] = useState(false);
  const [connection, setConnection] = useState({ state: "offline", message: "Not connected to a trading PC." });
  const [errorText, setErrorText] = useState("");
  const [receiverMessage, setReceiverMessage] = useState("");
  const [receiverError, setReceiverError] = useState("");
  const [saving, setSaving] = useState(false);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [controllerLogs, setControllerLogs] = useState<RemoteLogEntry[]>([]);
  const [receiverLogs, setReceiverLogs] = useState<RemoteLogEntry[]>([]);
  const [activeTab, setActiveTab] = useState<RemoteTab>("settings");
  const online = connection.state === "online";
  const controllerStatusLabel = useMemo(
    () => (connection.state === "connecting" ? "Connecting" : online ? "Connected" : "Offline"),
    [connection.state, online],
  );

  useEffect(() => subscribeRemoteStatus(setConnection), []);
  useEffect(() => subscribeRemoteLogs((entries) => setControllerLogs(entries)), []);

  useEffect(() => {
    try {
      if (role) {
        globalThis.localStorage?.setItem(REMOTE_ROLE_STORAGE_KEY, role);
      } else {
        globalThis.localStorage?.removeItem(REMOTE_ROLE_STORAGE_KEY);
      }
    } catch {
      // Ignore storage failures so the page still works in restricted browsers.
    }
  }, [role]);

  useEffect(() => {
    if (role !== "receiver") return;
    let cancelled = false;

    async function loadReceiverLogs() {
      try {
        const runtime = await api.runtime();
        if (cancelled) return;
        const adapterLines = Array.isArray(runtime?.logs?.adapter) ? runtime.logs.adapter : [];
        const nextLogs = adapterLines
          .filter((line) => typeof line === "string" && line.includes("[REMOTE]"))
          .slice(-40)
          .map((line, index) => {
            const match = line.match(/^\[(.*?)\]\s+(.*)$/);
            const at = match?.[1] || "--:--:--";
            const message = match?.[2] || line;
            return {
              id: `${at}-${index}-${message}`,
              at,
              message,
              level: inferServerLevel(message),
            } satisfies RemoteLogEntry;
          });
        setReceiverLogs(nextLogs);
      } catch {
        if (!cancelled) {
          setReceiverLogs([]);
        }
      }
    }

    loadReceiverLogs();
    const timer = window.setInterval(loadReceiverLogs, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [role]);

  useEffect(() => {
    let cancelled = false;
    api.settings()
      .then((settings) => {
        if (cancelled) return;
        const remote = settings?.remote_control || {};
        const savedUrl = String(remote.receiver_url || "").trim();
        if (savedUrl) setUrl(savedUrl);
        setToken(String(remote.token || ""));
        setReceiverEnabled(Boolean(remote.enabled));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  function chooseRole(nextRole: RemoteRole) {
    setRole(nextRole);
    setActiveTab("settings");
    setErrorText("");
    setReceiverError("");
    setReceiverMessage("");
  }

  function generateToken() {
    const generated =
      globalThis.crypto?.randomUUID?.().replaceAll("-", "") ||
      `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 18)}`;
    setToken(generated);
    setTokenCopied(false);
    setReceiverMessage("");
  }

  async function copyToken() {
    if (!token.trim()) return;
    try {
      await navigator.clipboard.writeText(token.trim());
      setTokenCopied(true);
      setReceiverMessage("Receiver token copied. Paste it on the controller PC.");
      setReceiverError("");
    } catch (error) {
      setReceiverError(`Could not copy the token: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function saveReceiver() {
    if (saving) return;
    setSaving(true);
    setReceiverError("");
    setReceiverMessage("");
    try {
      await api.saveRemoteControlSettings({
        enabled: receiverEnabled,
        token,
        receiver_url: url,
      });
      setReceiverMessage(
        receiverEnabled
          ? "Receiver saved. Remote control is now ready for authenticated controller connections."
          : "Receiver settings saved.",
      );
    } catch (error) {
      setReceiverError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function connect() {
    setErrorText("");
    try {
      await connectRemote(url, token);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <motion.header
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between"
      >
        <div className="max-w-2xl">
          <p className="text-xs font-black uppercase tracking-[0.16em] text-cyan-700">Secure Tailscale channel</p>
          <h2 className="mt-2 text-2xl font-black tracking-tight text-slate-950 sm:text-3xl">How will this PC be used?</h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Pick a role and we will show only the settings needed for this computer.
          </p>
        </div>
      </motion.header>

      <div className="grid gap-4 md:grid-cols-2">
        {roles.map((item, index) => {
          const selected = role === item.id;
          const Icon = item.icon;
          const isReceiver = item.accent === "emerald";
          return (
            <motion.button
              key={item.id}
              type="button"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.08 + index * 0.08 }}
              onClick={() => chooseRole(item.id)}
              className={`group relative overflow-hidden rounded-3xl border p-5 text-left transition-colors duration-300 sm:p-6 ${
                selected
                  ? isReceiver
                    ? "border-emerald-400 bg-emerald-50"
                    : "border-cyan-400 bg-cyan-50"
                  : "border-slate-200 bg-white hover:border-slate-300"
              }`}
            >
              <div className="flex items-start justify-between gap-4">
                <span className={`grid h-12 w-12 place-items-center rounded-2xl ${isReceiver ? "bg-emerald-500 text-white" : "bg-cyan-600 text-white"}`}>
                  <Icon className="h-6 w-6" />
                </span>
                <span className={`grid h-7 w-7 place-items-center rounded-full border transition-all ${selected ? (isReceiver ? "border-emerald-500 bg-emerald-500 text-white" : "border-cyan-600 bg-cyan-600 text-white") : "border-slate-300 text-transparent"}`}>
                  <Check className="h-4 w-4" strokeWidth={3} />
                </span>
              </div>
              <p className={`mt-5 text-xs font-black uppercase tracking-[0.16em] ${isReceiver ? "text-emerald-700" : "text-cyan-700"}`}>{item.eyebrow}</p>
              <h3 className="mt-1 text-xl font-black text-slate-950">{item.title}</h3>
              <p className="mt-2 max-w-sm text-sm leading-6 text-slate-600">{item.description}</p>
              <span className="mt-5 inline-flex items-center gap-2 text-sm font-black text-slate-900">
                {selected ? "Selected" : "Choose this role"}
                <ArrowRight className={`h-4 w-4 transition-transform ${selected ? "translate-x-1" : "group-hover:translate-x-1"}`} />
              </span>
            </motion.button>
          );
        })}
      </div>

      <AnimatePresence mode="wait">
        {!role ? (
          <motion.div
            key="prompt"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-5 py-6 text-center text-sm font-semibold text-slate-500"
          >
            Select a role above to continue setup.
          </motion.div>
        ) : role === "receiver" ? (
          <motion.div key="receiver" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>
            <div className="space-y-6 rounded-3xl border border-emerald-100 bg-white p-5 shadow-sm sm:p-7">
              <RemoteTabs role="receiver" activeTab={activeTab} onChange={setActiveTab} />

              {activeTab === "settings" ? (
                <>
                  <div className={`flex items-center justify-between gap-4 rounded-2xl border p-4 transition-colors ${receiverEnabled ? "border-emerald-200 bg-emerald-50/70" : "border-slate-200 bg-slate-50"}`}>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-black text-slate-900">Accept remote trades</p>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-wider ${receiverEnabled ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"}`}>
                          {receiverEnabled ? "Enabled" : "Disabled"}
                        </span>
                      </div>
                      <p className="mt-1 text-xs leading-5 text-slate-500">Allow authenticated controllers to connect to this trading PC.</p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-label="Accept remote trades"
                      aria-checked={receiverEnabled}
                      onClick={() => setReceiverEnabled((current) => !current)}
                      className={`relative h-7 w-12 shrink-0 rounded-full border-2 transition-colors duration-200 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-200 ${receiverEnabled ? "border-emerald-600 bg-emerald-600" : "border-slate-300 bg-slate-300"}`}
                    >
                      <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200 ${receiverEnabled ? "translate-x-5" : "translate-x-0"}`} />
                    </button>
                  </div>

                  <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto_auto] lg:items-end">
                    <RemoteField label="Private Receiver Token" type="password" value={token} onChange={(event) => { setToken(event.target.value); setTokenCopied(false); }} placeholder="Generate a secure token" />
                    <RemoteButton className="w-full lg:w-auto" onClick={generateToken}><RefreshCw className="h-4 w-4" />Generate</RemoteButton>
                    <RemoteButton className="w-full lg:w-auto" onClick={copyToken} disabled={!token.trim()}><Copy className="h-4 w-4" />{tokenCopied ? "Copied" : "Copy"}</RemoteButton>
                  </div>

                  <RemoteField label="This PC's Receiver URL" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="ws://100.x.x.x:8000/remote/ws" />

                  <div className="grid gap-3 sm:grid-cols-3">
                    {["Install and sign in to Tailscale", "Use this PC's 100.x IP", "Share the URL + token"].map((step, index) => (
                      <div key={step} className="flex items-center gap-3 rounded-2xl bg-slate-50 p-3 text-sm font-bold text-slate-600">
                        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-emerald-100 text-xs font-black text-emerald-700">{index + 1}</span>{step}
                      </div>
                    ))}
                  </div>

                  <div className="min-h-[46px]" aria-live="polite">
                    {receiverMessage ? <p className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm font-semibold text-emerald-700">{receiverMessage}</p> : null}
                    {receiverError ? <p className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm font-semibold text-rose-700">{receiverError}</p> : null}
                  </div>
                  <RemoteButton className="w-full sm:w-[218px]" tone="success" onClick={saveReceiver} aria-busy={saving}>
                    {saving ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    Save Receiver Setup
                  </RemoteButton>
                </>
              ) : (
                <RemoteLogPanel
                  emptyText="No remote receiver events yet. Authentication attempts, disconnects, and command results will appear here."
                  entries={receiverLogs}
                />
              )}
            </div>
          </motion.div>
        ) : (
          <motion.div key="controller" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>
            <div className="space-y-6 rounded-3xl border border-cyan-100 bg-white p-5 shadow-sm sm:p-7">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <RemoteTabs role="controller" activeTab={activeTab} onChange={setActiveTab} />
                <div className="flex flex-col gap-3 sm:items-end sm:ml-auto">
                  <div className={`inline-flex items-center gap-2 self-start rounded-full px-4 py-2 text-sm font-black ${online ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-600"}`}>
                    {online ? <CheckCircle2 className="h-4 w-4" /> : <CircleOff className="h-4 w-4" />}
                    {controllerStatusLabel}
                  </div>
                </div>
              </div>

              {activeTab === "settings" ? (
                <>
                  <div className="grid gap-5 md:grid-cols-2">
                    <RemoteField label="Receiver WebSocket URL" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="ws://100.x.x.x:8000/remote/ws" />
                    <RemoteField label="Receiver Token" type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Paste the token from the receiver PC" />
                  </div>

                  <div className="flex items-start gap-3 rounded-2xl border border-cyan-100 bg-cyan-50/70 p-4 text-sm leading-6 text-slate-600">
                    <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-cyan-700" />
                    Tailscale encrypts the connection between both PCs. The receiver still applies its own account risk settings.
                  </div>

                  <div className="flex flex-wrap gap-3">
                    <RemoteButton className="w-full sm:w-auto" tone="primary" onClick={connect} disabled={connection.state === "connecting" || online}><Wifi className="h-4 w-4" />Connect to Receiver</RemoteButton>
                    <RemoteButton className="w-full sm:w-auto" onClick={disconnectRemote} disabled={!online && connection.state !== "connecting"}>Disconnect</RemoteButton>
                  </div>
                  {errorText ? <p className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm font-semibold text-rose-700">{errorText}</p> : null}
                </>
              ) : (
                <RemoteLogPanel
                  emptyText="No controller events yet. Connection attempts and remote command results will appear here."
                  entries={controllerLogs}
                />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
