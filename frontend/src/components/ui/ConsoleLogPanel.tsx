import React, { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowDown, Check, CheckCircle2, Copy, Info, Search, Trash2, XCircle } from "lucide-react";

export type ConsoleLogLevel = "info" | "success" | "warning" | "error";

export type ConsoleLogEntry = {
  id: string;
  level: ConsoleLogLevel;
  message: string;
  at: string;
  /** Scalping side, used to distinguish demand and supply appearance logs. */
  side?: "demand" | "supply";
  /** Optional small tag shown next to the timestamp (e.g. a receiver name);
   * also filterable via the dropdown when `showTagFilter` is set. */
  tag?: string | null;
};

/** Per-level row treatment: colored left border + tint + icon + bracketed
 * label, tuned for a white card (pastel text-only coloring reads washed out
 * there). Info stays neutral but a readable, slightly darker grey. */
const LOG_LEVEL_STYLE: Record<
  ConsoleLogLevel,
  { row: string; icon: React.ComponentType<{ className?: string }>; iconClass: string; label: string; textClass: string }
> = {
  error: { row: "border-l-rose-500 bg-rose-50", icon: XCircle, iconClass: "text-rose-600", label: "ERROR", textClass: "text-rose-700" },
  warning: { row: "border-l-amber-500 bg-amber-50", icon: AlertTriangle, iconClass: "text-amber-600", label: "WARNING", textClass: "text-amber-700" },
  success: { row: "border-l-teal-500 bg-teal-50/70", icon: CheckCircle2, iconClass: "text-teal-600", label: "SUCCESS", textClass: "text-teal-700" },
  info: { row: "border-l-slate-200 bg-white", icon: Info, iconClass: "text-slate-500", label: "INFO", textClass: "text-slate-600" },
};

/** Content-based identity for a log line (there's no server-side sequence
 * number to key off), used only to let "Clear view" hide already-seen lines
 * without touching the underlying log store. */
function logEntryKey(entry: ConsoleLogEntry) {
  return `${entry.at}::${entry.message}`;
}

export function ConsoleLogPanel({
  emptyText,
  entries,
  onClear,
  showTagFilter = false,
  tagFilterLabel = "All",
  fill = false,
}: {
  emptyText: string;
  entries: ConsoleLogEntry[];
  /** Provide when the log is owned by this browser so Clear can really
   * delete it. Omit for a backend-owned log: Clear then only hides what's
   * already on screen here, it can't erase the source's own copy. */
  onClear?: () => void;
  showTagFilter?: boolean;
  tagFilterLabel?: string;
  /** Stretch to fill the parent's height instead of a fixed 380px box --
   * use this when the parent already has a real, bounded height to give
   * (e.g. a `flex h-full flex-col` card), so the log genuinely reaches the
   * bottom of its column instead of stopping at a fixed pixel height. */
  fill?: boolean;
}) {
  const [tagFilter, setTagFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(() => new Set());
  const [copied, setCopied] = useState(false);
  const [following, setFollowing] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const tagNames = useMemo(() => {
    if (!showTagFilter) return [];
    const names = new Set<string>();
    entries.forEach((entry) => { if (entry.tag) names.add(entry.tag); });
    return Array.from(names).sort();
  }, [entries, showTagFilter]);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return entries.filter((entry) => {
      if (hiddenKeys.has(logEntryKey(entry))) return false;
      if (tagFilter !== "all" && entry.tag !== tagFilter) return false;
      if (query && !entry.message.toLowerCase().includes(query) && !(entry.tag || "").toLowerCase().includes(query)) return false;
      return true;
    });
  }, [entries, hiddenKeys, tagFilter, search]);

  // Stick to the bottom as new lines arrive, unless the operator has
  // scrolled up to read history -- matches a normal chat/log-tail feel.
  useEffect(() => {
    if (!following) return;
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [visible, following]);

  function handleScroll() {
    const node = scrollRef.current;
    if (!node) return;
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
    setFollowing(atBottom);
  }

  function jumpToLatest() {
    setFollowing(true);
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }

  function handleClear() {
    if (onClear) {
      onClear();
      setHiddenKeys(new Set());
    } else {
      setHiddenKeys((current) => {
        const next = new Set(current);
        entries.forEach((entry) => next.add(logEntryKey(entry)));
        return next;
      });
    }
  }

  async function handleCopy() {
    const text = visible
      .map((entry) => `[${entry.level.toUpperCase()}] ${entry.at} ${entry.tag ? `[${entry.tag}] ` : ""}${entry.message}`)
      .join("\n");
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard access can be denied; the log stays visible either way.
    }
  }

  return (
    <div className={fill ? "flex h-full min-h-0 flex-col gap-2" : "space-y-2"}>
      {/* One bordered box, header strip on top like the trade table's own
          thead, instead of a separate floating row of controls above a
          second bordered box underneath it. */}
      <div className={fill ? "relative flex min-h-0 flex-1 flex-col rounded-lg border border-slate-200 bg-white" : "relative flex min-h-[380px] flex-col rounded-lg border border-slate-200 bg-white"}>
        {/* Column headers and the toolbar controls share one row instead of
            stacking in two -- the controls just live in the same cell as the
            "Description" label, pushed to its right. */}
        <div className="grid shrink-0 grid-cols-[92px_92px_1fr] items-center gap-x-3 rounded-t-lg border-b border-slate-200 bg-slate-50 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-500">
          <span>Time</span>
          <span>Type</span>
          <div className="flex flex-wrap items-center gap-1.5">
            <span>Description</span>
            {showTagFilter && tagNames.length ? (
              <select
                value={tagFilter}
                onChange={(event) => setTagFilter(event.target.value)}
                className="h-[26px] rounded-full border border-slate-200 bg-white px-2.5 text-[11px] font-black normal-case tracking-normal text-slate-600 outline-none focus:border-blue-400"
                aria-label="Filter logs"
              >
                <option value="all">{tagFilterLabel}</option>
                {tagNames.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            ) : null}
            <div className="relative ml-auto">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search logs..."
                className="h-[26px] w-[160px] rounded-full border border-slate-200 bg-white pl-8 pr-2.5 text-[11px] font-semibold normal-case tracking-normal text-slate-700 outline-none transition focus:w-[200px] focus:border-blue-400 sm:w-[180px]"
              />
            </div>
            <button
              type="button"
              onClick={handleCopy}
              disabled={!visible.length}
              title="Copy visible lines"
              className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-full border border-slate-200 bg-white text-slate-500 transition hover:border-slate-300 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-teal-600" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
            <button
              type="button"
              onClick={handleClear}
              disabled={!entries.length}
              title={onClear ? "Clear this log" : "Hide everything shown so far"}
              className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-full border border-rose-200 bg-white text-rose-500 transition hover:border-rose-300 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className={fill ? "min-h-0 flex-1 divide-y divide-slate-100 overflow-y-auto" : "max-h-[380px] divide-y divide-slate-100 overflow-y-auto"}
        >
          {visible.length ? (
            visible.map((entry) => {
              const style = LOG_LEVEL_STYLE[entry.level];
              const LevelIcon = style.icon;
              const sideAppearance = entry.side && /\bappeared\b/i.test(entry.message);
              const messageColor = sideAppearance
                ? entry.side === "demand" ? "text-emerald-700" : "text-rose-700"
                : "text-slate-700";
              return (
                <div key={entry.id} data-log-level={entry.level} className={`grid grid-cols-[92px_92px_1fr] items-start gap-x-3 border-l-[3px] px-3 py-2 text-[12.5px] leading-relaxed ${style.row}`}>
                  <span className="shrink-0 font-mono text-[10.5px] text-slate-400">{entry.at}</span>
                  <span className={`flex min-w-0 items-center gap-1 font-mono text-[10.5px] font-black ${style.textClass}`}>
                    <LevelIcon className={`h-3.5 w-3.5 shrink-0 ${style.iconClass}`} />
                    {style.label}
                  </span>
                  <span className={`min-w-0 break-words font-semibold ${messageColor}`}>
                    {entry.side ? (
                      <span className={`mr-1.5 inline-block shrink-0 rounded-full px-1.5 py-0.5 text-[9.5px] font-black uppercase tracking-wide ${entry.side === "demand" ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"}`}>
                        {entry.side}
                      </span>
                    ) : null}
                    {entry.tag ? (
                      <span className="mr-1.5 inline-block shrink-0 rounded-full bg-slate-900/5 px-1.5 py-0.5 text-[9.5px] font-black uppercase tracking-wide text-slate-600">
                        {entry.tag}
                      </span>
                    ) : null}
                    {entry.message}
                  </span>
                </div>
              );
            })
          ) : (
            <div className={fill ? "grid h-full place-items-center px-4 text-center text-sm font-semibold text-slate-400" : "grid min-h-[380px] place-items-center px-4 text-center text-sm font-semibold text-slate-400"}>
              {entries.length ? "No log lines match the current filter." : emptyText}
            </div>
          )}
        </div>
        {!following && visible.length ? (
          <button
            type="button"
            onClick={jumpToLatest}
            className="absolute bottom-3 right-3 inline-flex items-center gap-1.5 rounded-full bg-slate-900 px-3 py-1.5 text-[11px] font-black text-white shadow-lg transition hover:bg-slate-800"
          >
            <ArrowDown className="h-3.5 w-3.5" />Jump to latest
          </button>
        ) : null}
      </div>
      {onClear ? null : (
        <p className="text-[11px] text-slate-400">
          "Clear" only hides what's shown here in this browser -- it does not erase the source's own copy.
        </p>
      )}
    </div>
  );
}
