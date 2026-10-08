import React, { useEffect, useRef, useState } from "react";
import { CheckCircle2, Link2, Loader2 } from "lucide-react";
import { AppButton } from "./ui/Primitives";
import { api } from "../services/api";
import { cx } from "../utils/format";

export type CTraderAccount = {
  login: number;
  account_id: number;
  environment: "demo" | "live";
  broker: string;
};

type CTraderConnectProps = {
  // Login of the account being edited, picked automatically when the
  // cTrader login covers it; empty when adding a new account.
  currentLogin?: string;
  existingLogins: string[];
  selectedLogin?: string;
  linked: boolean;
  onPick: (account: CTraderAccount, oauthState: string) => void;
};

const POLL_MS = 1500;
const GIVE_UP_MS = 10 * 60 * 1000;

/** "Connect with cTrader": signs in with a cTrader ID in the browser, then
 *  lists the trading accounts that login granted so one can be picked. */
export function CTraderConnect({ currentLogin = "", existingLogins, selectedLogin = "", linked, onPick }: CTraderConnectProps) {
  const [phase, setPhase] = useState<"idle" | "waiting" | "done" | "error">("idle");
  const [accounts, setAccounts] = useState<CTraderAccount[]>([]);
  const [error, setError] = useState("");
  const [loginUrl, setLoginUrl] = useState("");
  const [oauthState, setOauthState] = useState("");
  const pollRun = useRef(0);

  // Stop polling when the dialog closes (this component unmounts with it).
  useEffect(() => () => {
    pollRun.current += 1;
  }, []);

  async function connect() {
    const run = (pollRun.current += 1);
    setPhase("waiting");
    setError("");
    setAccounts([]);
    try {
      const started = await api.ctraderOAuthStart();
      setOauthState(started.state);
      setLoginUrl(started.url);
      if (!started.opened) window.open(started.url, "_blank", "noopener");
      const deadline = Date.now() + GIVE_UP_MS;
      while (pollRun.current === run && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        if (pollRun.current !== run) return;
        const status = await api.ctraderOAuthStatus(started.state);
        if (status.status === "pending") continue;
        if (status.status !== "done") throw new Error(status.error || "cTrader login failed.");
        const granted: CTraderAccount[] = status.accounts || [];
        if (!granted.length) throw new Error("This cTrader ID has no trading accounts granted to the app.");
        setAccounts(granted);
        setPhase("done");
        const match = currentLogin ? granted.find((a) => String(a.login) === String(currentLogin)) : granted.length === 1 ? granted[0] : null;
        if (match) onPick(match, started.state);
        return;
      }
      if (pollRun.current === run) throw new Error("Timed out waiting for the cTrader login. Try again.");
    } catch (ex) {
      if (pollRun.current !== run) return;
      setError(ex instanceof Error ? ex.message : String(ex));
      setPhase("error");
    }
  }

  function cancel() {
    pollRun.current += 1;
    setPhase("idle");
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 md:col-span-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-black text-slate-900">cTrader login</div>
          <div className="text-xs font-semibold text-slate-500">
            {linked
              ? "Linked to a cTrader ID. The access token renews automatically."
              : "Sign in with the cTrader ID that owns the account, or paste a token below."}
          </div>
        </div>
        {phase === "waiting" ? (
          <AppButton variant="soft" onClick={cancel}>Cancel</AppButton>
        ) : (
          <AppButton variant="blue" onClick={connect}>
            <Link2 size={16} />
            {linked || phase === "done" ? "Reconnect with cTrader" : "Connect with cTrader"}
          </AppButton>
        )}
      </div>

      {phase === "waiting" && (
        <div className="mt-3 flex items-start gap-2 text-xs font-semibold text-slate-600">
          <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin" />
          <span>
            Waiting for you to sign in and approve access in the browser.{" "}
            {loginUrl ? (
              <a href={loginUrl} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">
                Open the cTrader login page
              </a>
            ) : null}
          </span>
        </div>
      )}

      {phase === "error" && <div className="mt-3 text-xs font-bold text-rose-600">{error}</div>}

      {phase === "done" && accounts.length > 0 && (
        <div className="mt-3 grid gap-2">
          <div className="text-xs font-black uppercase tracking-wide text-slate-500">Choose the account</div>
          {accounts.map((account) => {
            const login = String(account.login);
            const selected = linked && login === String(selectedLogin);
            const added = existingLogins.includes(login) && login !== String(currentLogin);
            return (
              <button
                key={account.account_id}
                type="button"
                onClick={() => onPick(account, oauthState)}
                className={cx(
                  "flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left text-sm font-semibold transition",
                  selected ? "border-blue-500 bg-blue-50 text-blue-900" : "border-slate-200 bg-white text-slate-800 hover:border-blue-300",
                )}
              >
                <span className="min-w-0 truncate">
                  {login}
                  <span className="ml-2 text-xs font-bold text-slate-500">{account.broker}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2 text-xs font-bold">
                  {added && <span className="text-slate-400">already added</span>}
                  <span className={account.environment === "live" ? "text-rose-600" : "text-emerald-600"}>{account.environment.toUpperCase()}</span>
                  {selected && <CheckCircle2 size={16} className="text-blue-600" />}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
