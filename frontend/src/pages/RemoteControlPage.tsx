import React, { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Check,
  CheckCircle2,
  CircleOff,
  Copy,
  Info,
  Laptop,
  Loader2,
  Pencil,
  Plus,
  RadioTower,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  Wifi,
  X,
} from "lucide-react";
import { LogList } from "../components/ui/LogList";
import { api } from "../services/api";
import {
  connectReceiver,
  disconnectReceiver,
  removeReceiver,
  saveReceiver,
  setReceiverEnabled,
  subscribeReceivers,
  subscribeRemoteLogs,
} from "../services/remoteControl";

const REMOTE_ROLE_STORAGE_KEY = "trader.remoteControl.role";
const REMOTE_TAB_STORAGE_KEY = "trader.remoteControl.tab";
const LEGACY_CONTROLLER_SETTINGS_KEY = "trader.remoteControl.controllerSettings";

type RemoteRole = "receiver" | "controller";
type RemoteTab = "settings" | "logs";
type RemoteLogEntry = { id: string; level: "info" | "success" | "warning" | "error"; message: string; at: string };
type ReceiverRecord = {
  id: string;
  label: string;
  url: string;
  token: string;
  enabled: boolean;
  status: { state: string; message: string };
};

const roles = [
  {
    id: "receiver" as const,
    eyebrow: "Trading PC",
    title: "Receiver",
    description: "Mirrors trades sent from a connected controller.",
    icon: RadioTower,
  },
  {
    id: "controller" as const,
    eyebrow: "Your control PC",
    title: "Controller / Trader",
    description: "Places trades and broadcasts them to every receiver.",
    icon: Laptop,
  },
];

function importLegacyReceiver() {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(LEGACY_CONTROLLER_SETTINGS_KEY) || "{}");
    if (saved?.url && saved?.token) {
      saveReceiver({ label: "Receiver 1", url: saved.url, token: saved.token, enabled: true });
    }
    globalThis.localStorage?.removeItem(LEGACY_CONTROLLER_SETTINGS_KEY);
  } catch {
    // Nothing to migrate.
  }
}

type FieldAction = { key: string; title: string; icon: React.ReactNode; onClick: () => void; active?: boolean };

type RemoteFieldProps = React.InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  tone?: "teal" | "blue";
  actions?: FieldAction[];
};

const toneRing = {
  teal: "focus:border-teal-500 focus:ring-teal-100",
  blue: "focus:border-blue-500 focus:ring-blue-100",
};

function RemoteField({ label, className = "", tone = "blue", actions, ...props }: RemoteFieldProps) {
  return (
    <label className={`block min-w-0 ${className}`}>
      <span className="mb-2 block text-xs font-black uppercase tracking-[0.12em] text-slate-500">{label}</span>
      <div className="relative flex items-center">
        <input
          {...props}
          className={`block h-12 w-full rounded-xl border border-slate-200 bg-slate-50 px-4 text-sm font-semibold text-slate-900 outline-none transition placeholder:font-medium placeholder:text-slate-400 focus:bg-white focus:ring-4 ${toneRing[tone]} ${actions?.length ? (actions.length > 1 ? "pr-[76px]" : "pr-11") : ""}`}
        />
        {actions?.length ? (
          <div className="absolute right-1.5 flex items-center gap-1">
            {actions.map((action) => (
              <button
                key={action.key}
                type="button"
                title={action.title}
                aria-label={action.title}
                onClick={action.onClick}
                className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg transition ${action.active ? "text-teal-600" : "text-slate-400 hover:bg-white hover:text-slate-900 hover:shadow-sm"}`}
              >
                {action.icon}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </label>
  );
}

type RemoteButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "primary" | "success" | "secondary" | "danger" };

function RemoteButton({ children, tone = "secondary", className = "", ...props }: RemoteButtonProps) {
  const toneClass = {
    primary: "bg-blue-600 text-white shadow-lg shadow-blue-600/20 hover:bg-blue-700",
    success: "bg-teal-600 text-white shadow-lg shadow-teal-600/20 hover:bg-teal-700",
    secondary: "border border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50",
    danger: "border border-rose-200 bg-white text-rose-600 hover:border-rose-300 hover:bg-rose-50",
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

function RemoteTabs({ role, activeTab, onChange }: { role: RemoteRole; activeTab: RemoteTab; onChange: (tab: RemoteTab) => void }) {
  const accentActive = role === "receiver" ? "text-teal-600" : "text-blue-600";
  const accentBar = role === "receiver" ? "bg-teal-500" : "bg-blue-600";
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-slate-200">
      {[{ id: "settings" as const, label: "Settings" }, { id: "logs" as const, label: "Logs" }].map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className={`relative px-3 py-4 text-sm font-bold transition ${activeTab === tab.id ? accentActive : "text-slate-500 hover:text-slate-950"}`}
        >
          {tab.label}
          {activeTab === tab.id ? <span className={`absolute inset-x-3 bottom-0 h-0.5 rounded-full ${accentBar}`} /> : null}
        </button>
      ))}
    </div>
  );
}

function StatusBadge({ state }: { state: string }) {
  if (state === "online") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-teal-100 px-2.5 py-1 text-xs font-black text-teal-800">
        <CheckCircle2 className="h-3.5 w-3.5" />Online
      </span>
    );
  }
  if (state === "connecting") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-black text-amber-800">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />Connecting
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-black text-slate-600">
      <CircleOff className="h-3.5 w-3.5" />Offline
    </span>
  );
}

/** Live tunnel signature: "this PC" and "peer" nodes joined by a dashed line.
 * The traveling dot only animates while `animate` is true (an actual session is live). */
function TopologyBar({
  role,
  meLabel,
  meSub,
  peerLabel,
  peerSub,
  animate,
}: {
  role: RemoteRole;
  meLabel: string;
  meSub: string;
  peerLabel: string;
  peerSub: string;
  animate: boolean;
}) {
  const isReceiver = role === "receiver";
  const MeIcon = isReceiver ? RadioTower : Laptop;
  const PeerIcon = isReceiver ? Laptop : RadioTower;
  const meIconClass = isReceiver
    ? "border-teal-500 bg-teal-50 text-teal-700"
    : "border-blue-500 bg-blue-50 text-blue-700";
  const dotColorClass = isReceiver ? "text-teal-500" : "text-blue-500";

  return (
    <div className="flex items-center gap-4 rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm sm:px-6">
      <div className="flex items-center gap-3">
        <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl border-[1.5px] ${meIconClass}`}>
          <MeIcon className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-slate-900">{meLabel}</p>
          <p className="truncate font-mono text-[10.5px] text-slate-400">{meSub}</p>
        </div>
      </div>

      <div className="hidden flex-1 flex-col items-center gap-1.5 sm:flex">
        <span className="flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-wide text-slate-400">
          <ShieldCheck className="h-[11px] w-[11px]" />Tailscale tunnel
        </span>
        <div className={`topo-line relative h-px w-full ${dotColorClass}`}>
          {animate ? <span className="topo-dot" /> : null}
        </div>
      </div>

      <div className="ml-auto flex items-center gap-3 text-right">
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-slate-900">{peerLabel}</p>
          <p className="truncate font-mono text-[10.5px] text-slate-400">{peerSub}</p>
        </div>
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border-[1.5px] border-slate-300 bg-slate-100 text-slate-400">
          <PeerIcon className="h-[18px] w-[18px]" />
        </span>
      </div>
    </div>
  );
}

function ReceiverForm({
  initial,
  onCancel,
  onSaved,
}: {
  initial?: ReceiverRecord;
  onCancel: () => void;
  onSaved: (id: string) => void;
}) {
  const [label, setLabel] = useState(initial?.label ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [token, setToken] = useState(initial?.token ?? "");
  const [error, setError] = useState("");

  function submit() {
    if (!url.trim() || !token.trim()) {
      setError("URL and token are both required.");
      return;
    }
    const id = saveReceiver({
      id: initial?.id,
      label: label.trim() || `Receiver ${url.trim()}`,
      url,
      token,
      enabled: initial?.enabled ?? true,
    });
    onSaved(id);
  }

  return (
    <div className="space-y-4 rounded-2xl border border-blue-200 bg-blue-50/50 p-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <RemoteField label="Label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. London PC" />
        <RemoteField label="WebSocket URL" className="sm:col-span-2" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="ws://100.x.x.x:8000/remote/ws" />
      </div>
      <RemoteField label="Token" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Paste the token from the receiver PC" />
      {error ? <p className="text-sm font-semibold text-rose-600">{error}</p> : null}
      <div className="flex gap-3">
        <RemoteButton tone="primary" onClick={submit}><Save className="h-4 w-4" />Save</RemoteButton>
        <RemoteButton onClick={onCancel}><X className="h-4 w-4" />Cancel</RemoteButton>
      </div>
    </div>
  );
}

function ReceiverRow({ receiver, onEdit }: { receiver: ReceiverRecord; onEdit: () => void }) {
  const online = receiver.status.state === "online";
  const connecting = receiver.status.state === "connecting";
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-black text-slate-900">{receiver.label}</p>
          <StatusBadge state={receiver.status.state} />
          {!receiver.enabled ? <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-slate-500">Excluded from trades</span> : null}
        </div>
        <p className="mt-1 truncate text-xs font-semibold text-slate-500">{receiver.url || "No URL set"}</p>
        <p className="text-xs text-slate-400">{receiver.status.message}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
        <button
          type="button"
          role="switch"
          aria-label={`Include ${receiver.label} in broadcast trades`}
          aria-checked={receiver.enabled}
          onClick={() => setReceiverEnabled(receiver.id, !receiver.enabled)}
          title="Include this receiver when mirroring trades"
          className={`relative h-6 w-11 shrink-0 rounded-full border-2 transition-colors duration-200 ${receiver.enabled ? "border-blue-600 bg-blue-600" : "border-slate-300 bg-slate-300"}`}
        >
          <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${receiver.enabled ? "translate-x-5" : "translate-x-0"}`} />
        </button>
        {online ? (
          <RemoteButton className="h-9 px-3" onClick={() => disconnectReceiver(receiver.id)}>Disconnect</RemoteButton>
        ) : (
          <RemoteButton className="h-9 px-3" tone="primary" disabled={connecting} onClick={() => connectReceiver(receiver.id).catch(() => {})}>
            <Wifi className="h-4 w-4" />Connect
          </RemoteButton>
        )}
        <button type="button" onClick={onEdit} className="grid h-9 w-9 place-items-center rounded-xl border border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-900" aria-label={`Edit ${receiver.label}`}>
          <Pencil className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => removeReceiver(receiver.id)}
          className="grid h-9 w-9 place-items-center rounded-xl border border-rose-200 text-rose-500 hover:bg-rose-50"
          aria-label={`Remove ${receiver.label}`}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

const setupSteps = [
  "Install Tailscale and sign in on this PC",
  "Confirm the 100.x address matches above",
  "Share the URL and token with your controller PC",
];

function StepLine() {
  return (
    <div className="flex">
      {setupSteps.map((step, index) => (
        <div key={step} className="relative flex-1 pr-4">
          {index < setupSteps.length - 1 ? (
            <div className="absolute right-0 top-[11px] h-px w-full translate-x-1/2 border-t border-slate-200" />
          ) : null}
          <span className="relative z-10 mb-2 grid h-[22px] w-[22px] place-items-center rounded-full border border-slate-300 bg-slate-50 font-mono text-[10.5px] font-bold text-slate-600">
            {index + 1}
          </span>
          <p className="max-w-[150px] text-[11.5px] leading-tight text-slate-500">{step}</p>
        </div>
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
  const [token, setToken] = useState("");
  const [url, setUrl] = useState("");
  const [acceptTrades, setAcceptTrades] = useState(false);
  const [errorText, setErrorText] = useState("");
  const [receiverMessage, setReceiverMessage] = useState("");
  const [receiverError, setReceiverError] = useState("");
  const [saving, setSaving] = useState(false);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [urlCopied, setUrlCopied] = useState(false);
  const [controllerLogs, setControllerLogs] = useState<RemoteLogEntry[]>([]);
  const [receiverLogs, setReceiverLogs] = useState<RemoteLogEntry[]>([]);
  const [receiverConnections, setReceiverConnections] = useState(0);
  const [receivers, setReceivers] = useState<ReceiverRecord[]>([]);
  const [formState, setFormState] = useState<{ mode: "closed" | "add" | "edit"; receiver?: ReceiverRecord }>({ mode: "closed" });
  const [activeTab, setActiveTab] = useState<RemoteTab>(() => {
    try {
      return globalThis.localStorage?.getItem(REMOTE_TAB_STORAGE_KEY) === "logs" ? "logs" : "settings";
    } catch {
      return "settings";
    }
  });

  const onlineCount = useMemo(() => receivers.filter((r) => r.status.state === "online").length, [receivers]);
  const enabledCount = useMemo(() => receivers.filter((r) => r.enabled).length, [receivers]);

  useEffect(() => {
    importLegacyReceiver();
    return subscribeReceivers(setReceivers);
  }, []);
  useEffect(() => subscribeRemoteLogs((entries) => setControllerLogs(entries)), []);

  useEffect(() => {
    try {
      if (role) globalThis.localStorage?.setItem(REMOTE_ROLE_STORAGE_KEY, role);
      else globalThis.localStorage?.removeItem(REMOTE_ROLE_STORAGE_KEY);
    } catch {
      // Ignore storage failures so the page still works in restricted browsers.
    }
  }, [role]);

  useEffect(() => {
    try {
      globalThis.localStorage?.setItem(REMOTE_TAB_STORAGE_KEY, activeTab);
    } catch {
      // Keep navigation working if storage is unavailable.
    }
  }, [activeTab]);

  useEffect(() => {
    if (role !== "receiver") return;
    let cancelled = false;

    async function loadReceiverLogs() {
      try {
        const runtime = await api.runtime();
        if (cancelled) return;
        const adapterLines = Array.isArray(runtime?.logs?.adapter) ? runtime.logs.adapter : [];
        const nextLogs: RemoteLogEntry[] = adapterLines
          .filter((line) => typeof line === "string")
          .slice(-80)
          .map((line, index) => {
            const match = line.match(/^\[(.*?)\]\s+(.*)$/);
            const at = match?.[1] || "--:--:--";
            const message = match?.[2] || line;
            return { id: `${at}-${index}-${message}`, at, message, level: inferServerLevel(message) } satisfies RemoteLogEntry;
          });
        const connections = Number(runtime?.remote_control?.connections || 0);
        setReceiverConnections(connections);
        setReceiverLogs(nextLogs);
      } catch {
        if (cancelled) return;
        setReceiverLogs((current) => {
          if (current.some((entry) => entry.id === "receiver-log-fetch-error")) return current;
          return [...current, {
            id: "receiver-log-fetch-error",
            at: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
            message: "Receiver logs could not be refreshed. Existing entries are being kept.",
            level: "warning",
          }];
        });
      }
    }

    loadReceiverLogs();
    const timer = window.setInterval(loadReceiverLogs, 2000);
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
        setUrl(String(remote.receiver_url || "").trim());
        setToken(String(remote.token || ""));
        setAcceptTrades(Boolean(remote.enabled));
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
    const generated = globalThis.crypto?.randomUUID?.().replaceAll("-", "") || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 18)}`;
    setToken(generated);
    setTokenCopied(false);
    setReceiverMessage("");
  }

  async function copyToken() {
    if (!token.trim()) return;
    try {
      await navigator.clipboard.writeText(token.trim());
      setTokenCopied(true);
      setReceiverMessage("Token copied. Paste it into the receiver's entry on the controller PC.");
      setReceiverError("");
      window.setTimeout(() => setTokenCopied(false), 1200);
    } catch (error) {
      setReceiverError(`Could not copy the token: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function copyUrl() {
    if (!url.trim()) return;
    try {
      await navigator.clipboard.writeText(url.trim());
      setUrlCopied(true);
      window.setTimeout(() => setUrlCopied(false), 1200);
    } catch (error) {
      setReceiverError(`Could not copy the URL: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function saveReceiverSetup() {
    if (saving) return;
    setSaving(true);
    setReceiverError("");
    setReceiverMessage("");
    try {
      await api.saveRemoteControlSettings({ enabled: acceptTrades, token, receiver_url: url });
      setReceiverMessage(acceptTrades ? "Saved. This PC now accepts authenticated controller connections." : "Saved.");
    } catch (error) {
      setReceiverError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="w-full max-w-none space-y-6">
      <motion.header initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-2xl">
          <p className="flex items-center gap-2 font-mono text-xs font-bold uppercase tracking-[0.16em] text-teal-700">
            <span className="h-1.5 w-1.5 rounded-full bg-teal-500 shadow-[0_0_0_3px_rgba(20,184,166,0.18)]" />
            Secure Tailscale channel
          </p>
          <h2 className="mt-2 text-2xl font-black tracking-tight text-slate-950 sm:text-3xl">How will this PC be used?</h2>
        </div>
      </motion.header>

      <div className="grid gap-4 md:grid-cols-2">
        {roles.map((item, index) => {
          const selected = role === item.id;
          const Icon = item.icon;
          const isReceiver = item.id === "receiver";
          return (
            <motion.button
              key={item.id}
              type="button"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.08 + index * 0.08 }}
              onClick={() => chooseRole(item.id)}
              className={`group relative overflow-hidden rounded-2xl border p-4 text-left transition-colors duration-300 sm:p-5 ${
                selected
                  ? isReceiver
                    ? "border-teal-400 bg-teal-50"
                    : "border-blue-400 bg-blue-50"
                  : "border-slate-200 bg-white hover:border-slate-300"
              }`}
            >
              <div className="flex items-center gap-3">
                <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${isReceiver ? "bg-teal-100 text-teal-700" : "bg-blue-100 text-blue-700"}`}>
                  <Icon className="h-[18px] w-[18px]" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className={`font-mono text-[10px] font-bold uppercase tracking-[0.1em] ${isReceiver ? "text-teal-700" : "text-blue-700"}`}>{item.eyebrow}</p>
                  <p className="text-[15px] font-bold text-slate-950">{item.title}</p>
                </div>
                <span className={`grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border transition-all ${selected ? (isReceiver ? "border-teal-500 bg-teal-500 text-white" : "border-blue-600 bg-blue-600 text-white") : "border-slate-300 text-transparent"}`}>
                  <Check className="h-2.5 w-2.5" strokeWidth={3.5} />
                </span>
              </div>
              <p className="mt-2 text-[11.5px] leading-snug text-slate-500">{item.description}</p>
            </motion.button>
          );
        })}
      </div>

      <AnimatePresence mode="wait">
        {!role ? (
          <motion.div key="prompt" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-5 py-6 text-center text-sm font-semibold text-slate-500">
            Select a role above to continue setup.
          </motion.div>
        ) : role === "receiver" ? (
          <motion.div key="receiver" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className="space-y-4">
            <TopologyBar
              role="receiver"
              meLabel="This PC · Receiver"
              meSub={url || "URL not set"}
              peerLabel={`${receiverConnections} controller${receiverConnections === 1 ? "" : "s"}`}
              peerSub={receiverConnections > 0 ? "connected" : "not connected"}
              animate={receiverConnections > 0}
            />
            <div className="space-y-6 rounded-3xl border border-teal-100 bg-white p-4 shadow-sm sm:p-5">
              <RemoteTabs role="receiver" activeTab={activeTab} onChange={setActiveTab} />

              {activeTab === "settings" ? (
                <>
                  <div className="flex items-start gap-2.5 rounded-2xl border border-teal-200 bg-teal-50 p-3.5 text-[12.5px] leading-relaxed text-teal-800">
                    <Info className="mt-0.5 h-[15px] w-[15px] shrink-0 text-teal-600" />
                    This PC receives trades once a controller connects with the token below. Nothing broadcasts from here.
                  </div>
                  <div className={`flex items-center justify-between gap-4 rounded-2xl border p-4 transition-colors ${acceptTrades ? "border-teal-200 bg-teal-50/70" : "border-slate-200 bg-slate-50"}`}>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-black text-slate-900">Accept remote trades</p>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-wider ${acceptTrades ? "bg-teal-100 text-teal-700" : "bg-slate-200 text-slate-600"}`}>
                          {acceptTrades ? "Enabled" : "Disabled"}
                        </span>
                      </div>
                      <p className="mt-1 text-xs leading-5 text-slate-500">Authenticated controllers can connect once this is on.</p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-label="Accept remote trades"
                      aria-checked={acceptTrades}
                      onClick={() => setAcceptTrades((current) => !current)}
                      className={`relative h-7 w-12 shrink-0 rounded-full border-2 transition-colors duration-200 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-teal-200 ${acceptTrades ? "border-teal-600 bg-teal-600" : "border-slate-300 bg-slate-300"}`}
                    >
                      <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200 ${acceptTrades ? "translate-x-5" : "translate-x-0"}`} />
                    </button>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <RemoteField
                      label="Private Receiver Token"
                      type="password"
                      tone="teal"
                      value={token}
                      onChange={(event) => { setToken(event.target.value); setTokenCopied(false); }}
                      placeholder="Generate a secure token"
                      actions={[
                        { key: "regen", title: "Generate a new token", icon: <RefreshCw className="h-3.5 w-3.5" />, onClick: generateToken },
                        { key: "copy", title: tokenCopied ? "Copied" : "Copy token", icon: tokenCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />, onClick: copyToken, active: tokenCopied },
                      ]}
                    />
                    <RemoteField
                      label="This PC's Receiver URL"
                      tone="teal"
                      value={url}
                      onChange={(event) => setUrl(event.target.value)}
                      placeholder="ws://100.x.x.x:8000/remote/ws"
                      actions={[
                        { key: "copy", title: urlCopied ? "Copied" : "Copy URL", icon: urlCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />, onClick: copyUrl, active: urlCopied },
                      ]}
                    />
                  </div>

                  <StepLine />

                  <div className="min-h-[46px]" aria-live="polite">
                    {receiverMessage ? <p className="rounded-xl border border-teal-200 bg-teal-50 p-3 text-sm font-semibold text-teal-700">{receiverMessage}</p> : null}
                    {receiverError ? <p className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm font-semibold text-rose-700">{receiverError}</p> : null}
                  </div>
                  <RemoteButton className="w-full sm:w-[218px]" tone="success" onClick={saveReceiverSetup} aria-busy={saving}>
                    {saving ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    Save
                  </RemoteButton>
                </>
              ) : (
                <RemoteLogPanel emptyText="No receiver events yet. Authentication attempts, disconnects, and command results will appear here." entries={receiverLogs} />
              )}
            </div>
          </motion.div>
        ) : (
          <motion.div key="controller" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className="space-y-4">
            <TopologyBar
              role="controller"
              meLabel="This PC · Controller"
              meSub={`${enabledCount} receiver${enabledCount === 1 ? "" : "s"} in broadcast`}
              peerLabel={`${onlineCount}/${receivers.length} receivers`}
              peerSub={onlineCount > 0 ? "online" : "offline"}
              animate={onlineCount > 0}
            />
            <div className="space-y-6 rounded-3xl border border-blue-100 bg-white p-4 shadow-sm sm:p-5">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <RemoteTabs role="controller" activeTab={activeTab} onChange={setActiveTab} />
                <div className="flex items-center gap-2 self-start rounded-full bg-slate-100 px-4 py-2 text-sm font-black text-slate-700 sm:ml-auto">
                  <Wifi className={`h-4 w-4 ${onlineCount ? "text-teal-600" : "text-slate-400"}`} />
                  {onlineCount}/{receivers.length} online · {enabledCount} in trade broadcast
                </div>
              </div>

              {activeTab === "settings" ? (
                <>
                  <div className="flex items-start gap-2.5 rounded-2xl border border-blue-200 bg-blue-50 p-3.5 text-[12.5px] leading-relaxed text-blue-800">
                    <Info className="mt-0.5 h-[15px] w-[15px] shrink-0 text-blue-600" />
                    Add each trading PC's receiver URL and token below. Every trade placed here mirrors to receivers you switch on.
                  </div>
                  <div className="space-y-3">
                    {receivers.length === 0 && formState.mode === "closed" ? (
                      <div className="flex items-center gap-3.5 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-5 py-6">
                        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-blue-100 text-blue-700">
                          <RadioTower className="h-[17px] w-[17px]" />
                        </span>
                        <div>
                          <p className="text-sm font-black text-slate-900">No receivers yet</p>
                          <p className="text-xs text-slate-500">Add the first trading PC to start mirroring trades to it.</p>
                        </div>
                      </div>
                    ) : (
                      receivers.map((receiver) =>
                        formState.mode === "edit" && formState.receiver?.id === receiver.id ? (
                          <ReceiverForm key={receiver.id} initial={receiver} onCancel={() => setFormState({ mode: "closed" })} onSaved={() => setFormState({ mode: "closed" })} />
                        ) : (
                          <ReceiverRow key={receiver.id} receiver={receiver} onEdit={() => setFormState({ mode: "edit", receiver })} />
                        ),
                      )
                    )}
                    {formState.mode === "add" ? (
                      <ReceiverForm onCancel={() => setFormState({ mode: "closed" })} onSaved={() => setFormState({ mode: "closed" })} />
                    ) : (
                      <RemoteButton tone="primary" onClick={() => setFormState({ mode: "add" })}>
                        <Plus className="h-4 w-4" />Add Receiver
                      </RemoteButton>
                    )}
                  </div>
                  {errorText ? <p className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm font-semibold text-rose-700">{errorText}</p> : null}
                </>
              ) : (
                <RemoteLogPanel emptyText="No controller events yet. Connection attempts and remote command results will appear here." entries={controllerLogs} />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
