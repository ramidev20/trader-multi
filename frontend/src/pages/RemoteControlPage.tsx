import React, { useEffect, useState } from "react";
import { CheckCircle2, CircleOff, KeyRound, Radio } from "lucide-react";
import { AppButton, Card, Field } from "../components/ui/Primitives";
import { connectRemote, disconnectRemote, subscribeRemoteStatus } from "../services/remoteControl";

const defaultUrl = import.meta.env.VITE_REMOTE_COMMAND_URL || "";

export default function RemoteControlPage() {
  const [url, setUrl] = useState(defaultUrl);
  const [token, setToken] = useState("");
  const [connection, setConnection] = useState({ state: "offline", message: "Not connected to a trading PC." });
  const [errorText, setErrorText] = useState("");

  useEffect(() => subscribeRemoteStatus(setConnection), []);

  async function connect() {
    setErrorText("");
    try {
      await connectRemote(url, token);
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : String(error));
    }
  }

  const online = connection.state === "online";
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <section className="overflow-hidden rounded-3xl bg-slate-950 px-6 py-7 text-white shadow-xl sm:px-8">
        <div className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.18em] text-cyan-300">Private command channel</p>
            <h3 className="mt-2 text-2xl font-black">Remote Trade Mirroring</h3>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300">Connect PC A to the MT5 receiver on PC B. Orders placed from this app's Trade page are mirrored automatically after the local order succeeds.</p>
          </div>
          <div className={`inline-flex items-center gap-2 self-start rounded-full px-4 py-2 text-sm font-black ${online ? "bg-emerald-400 text-emerald-950" : "bg-slate-800 text-slate-300"}`}>
            {online ? <CheckCircle2 size={18} /> : <CircleOff size={18} />}
            {connection.state === "connecting" ? "Connecting" : online ? "Mirror online" : "Mirror offline"}
          </div>
        </div>
      </section>

      <Card className="space-y-5">
        <div className="flex items-center gap-3"><Radio className="text-cyan-700" /><div><h3 className="font-black text-slate-950">Receiver Connection</h3><p className="text-sm text-slate-500">{connection.message}</p></div></div>
        <Field label="Receiver WebSocket URL" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="ws://100.x.x.x:8000/remote/ws" />
        <Field label="Remote Token" type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Token from the trading PC .env" />
        <p className="text-xs leading-5 text-slate-500"><KeyRound className="mr-1 inline h-3.5 w-3.5" />The token stays in this browser session only. PC B applies its own account risk setting, so PC A risk percentages are never mirrored.</p>
        <div className="flex gap-3"><AppButton variant="blue" onClick={connect} disabled={connection.state === "connecting" || online}>Connect Mirroring</AppButton><AppButton variant="soft" onClick={disconnectRemote} disabled={!online && connection.state !== "connecting"}>Disconnect</AppButton></div>
        {errorText ? <p className="rounded-xl bg-rose-50 p-3 text-sm font-semibold text-rose-700">{errorText}</p> : null}
      </Card>
    </div>
  );
}
