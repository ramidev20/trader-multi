import React, { useEffect, useRef, useState } from "react";
import { RefreshCcw } from "lucide-react";
import { AppButton, Field } from "../components/ui/Primitives";
import { ORDER_KIND_OPTIONS, IconSelect } from "./Placeholders";
import { cx, decimalInput } from "../utils/format";
import { api } from "../services/api";

const STORAGE_KEY = "trader.scalping.form";
const POLL_INTERVAL_MS = 1500;

const PHASE_LABELS = {
  idle: "Idle",
  waiting_trigger: "Waiting for M15 trigger",
  searching_m5_zone: "Searching M5 for opposite zone",
  searching_m1_zone: "Searching M1 to confirm entry",
  placed: "Order placed",
  stopped: "Stopped",
  error: "Error",
};

function loadSavedForm() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function ToggleField({ label, options, value, onChange, disabled }) {
  return (
    <label className="block">
      <span className="block text-xs font-black uppercase tracking-wide text-slate-500">
        {label}
      </span>
      <div className="mt-1.5 grid grid-cols-2 gap-1 rounded-xl border border-slate-200 bg-slate-100 p-1">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cx(
              "h-[42px] rounded-lg text-sm font-bold transition disabled:pointer-events-none disabled:opacity-60",
              value === option.value
                ? option.activeClassName
                : "text-slate-600 hover:bg-white/70",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </label>
  );
}

export default function ScalpingPage() {
  const saved = useRef(loadSavedForm()).current;
  const [symbol, setSymbol] = useState(saved.symbol ?? "XAUUSD");
  const [zoneType, setZoneType] = useState(saved.zoneType ?? "demand");
  const [triggerPrice, setTriggerPrice] = useState(saved.triggerPrice ?? "");
  const [slAmount, setSlAmount] = useState(saved.slAmount ?? "");
  const [slInPips, setSlInPips] = useState(saved.slInPips ?? true);
  const [orderKind, setOrderKind] = useState(saved.orderKind ?? "MARKET");
  const [sizingMode, setSizingMode] = useState(saved.sizingMode ?? "risk");
  const [riskPercent, setRiskPercent] = useState(saved.riskPercent ?? "1");
  const [lot, setLot] = useState(saved.lot ?? "0.01");
  const [tp, setTp] = useState(saved.tp ?? "");
  const [tpInPips, setTpInPips] = useState(saved.tpInPips ?? true);

  const [status, setStatus] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [errorText, setErrorText] = useState("");

  useEffect(() => {
    const form = {
      symbol,
      zoneType,
      triggerPrice,
      slAmount,
      slInPips,
      orderKind,
      sizingMode,
      riskPercent,
      lot,
      tp,
      tpInPips,
    };
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(form));
    } catch {
      // ignore persistence failures (private mode, storage full, etc.)
    }
  }, [
    symbol,
    zoneType,
    triggerPrice,
    slAmount,
    slInPips,
    orderKind,
    sizingMode,
    riskPercent,
    lot,
    tp,
    tpInPips,
  ]);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const result = await api.zoneStrategyStatus();
        if (!cancelled) setStatus(result?.zone_strategy || null);
      } catch {
        // transient network errors are fine to skip silently on a poll loop
      }
    }
    poll();
    const id = window.setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const phase = status?.phase ?? "idle";
  const isActive =
    phase === "waiting_trigger" ||
    phase === "searching_m5_zone" ||
    phase === "searching_m1_zone";
  const m5TargetZoneType = zoneType === "demand" ? "supply" : "demand";
  const m1TargetZoneType = zoneType;

  async function handleStart() {
    setErrorText("");
    if (!(Number(triggerPrice) > 0)) {
      setErrorText("Enter a valid M15 trigger price.");
      return;
    }
    if (!(Number(slAmount) > 0)) {
      setErrorText("Enter a manual stoploss amount greater than 0.");
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        symbol,
        trigger_price: Number(triggerPrice),
        trigger_zone_type: zoneType,
        manual_sl_distance: Number(slAmount),
        sl_distance_in_pips: slInPips,
        order_kind: orderKind,
        lot: sizingMode === "lot" ? Number(lot || 0) : null,
        risk_percent: sizingMode === "risk" ? Number(riskPercent || 0) : null,
        tp: tp !== "" ? Number(tp) : null,
        tp_in_pips: tpInPips,
      };
      const result = await api.startZoneStrategy(payload);
      setStatus(result?.zone_strategy || null);
    } catch (error) {
      setErrorText(String(error?.message || error));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleStop() {
    setSubmitting(true);
    try {
      const result = await api.stopZoneStrategy();
      setStatus(result?.zone_strategy || null);
    } catch (error) {
      setErrorText(String(error?.message || error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="m-0 text-lg font-black text-slate-950">Scalping</h3>
          <p className="mt-1 text-sm text-slate-500">
            Enter a manually spotted M15 {zoneType} level. Once price touches it, the
            engine watches new M5 candles for the opposite ({m5TargetZoneType}) zone,
            then new M1 candles for a {m1TargetZoneType} zone to confirm entry before
            opening the trade. Lines draw live on the Chart tab.
          </p>
        </div>
        <span
          className={cx(
            "shrink-0 rounded-full px-3 py-1 text-xs font-bold",
            phase === "placed"
              ? "bg-emerald-100 text-emerald-700"
              : phase === "error"
                ? "bg-rose-100 text-rose-700"
                : isActive
                  ? "bg-blue-100 text-blue-700"
                  : "bg-slate-100 text-slate-600",
          )}
        >
          {PHASE_LABELS[phase] || phase}
        </span>
      </div>

      {errorText ? (
        <div className="shrink-0 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-700">
          {errorText}
        </div>
      ) : null}
      {status?.last_error ? (
        <div className="shrink-0 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-700">
          {status.last_error}
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        <ToggleField
          label="M15 Level Type"
          value={zoneType}
          onChange={setZoneType}
          disabled={isActive || submitting}
          options={[
            { value: "demand", label: "Demand", activeClassName: "bg-emerald-600 text-white shadow-sm" },
            { value: "supply", label: "Supply", activeClassName: "bg-rose-600 text-white shadow-sm" },
          ]}
        />

        <Field
          label="Symbol"
          value={symbol}
          onChange={(event) => setSymbol(event.target.value.toUpperCase())}
          disabled={isActive || submitting}
        />

        <Field
          label="M15 Trigger Price"
          type="text"
          inputMode="decimal"
          value={triggerPrice}
          onChange={(event) => setTriggerPrice(decimalInput(event.target.value))}
          disabled={isActive || submitting}
          placeholder="e.g. 3352.40"
        />

        <IconSelect
          label="Order Type"
          value={orderKind}
          options={ORDER_KIND_OPTIONS}
          onChange={setOrderKind}
          disabled={isActive || submitting}
        />

        <Field
          label={`Manual Stoploss (${slInPips ? "pips" : "price"})`}
          labelExtra={
            <button
              type="button"
              disabled={isActive || submitting}
              onClick={() => setSlInPips((previous) => !previous)}
              className="text-[10px] font-black uppercase tracking-wide text-blue-600 hover:text-blue-700 disabled:pointer-events-none disabled:opacity-60"
            >
              Switch to {slInPips ? "price" : "pips"}
            </button>
          }
          type="text"
          inputMode="decimal"
          value={slAmount}
          onChange={(event) => setSlAmount(decimalInput(event.target.value))}
          disabled={isActive || submitting}
          placeholder={slInPips ? "e.g. 50" : "e.g. 5.00"}
        />

        <Field
          label={`Take Profit (${tpInPips ? "pips" : "price"}) - optional`}
          labelExtra={
            <button
              type="button"
              disabled={isActive || submitting}
              onClick={() => setTpInPips((previous) => !previous)}
              className="text-[10px] font-black uppercase tracking-wide text-blue-600 hover:text-blue-700 disabled:pointer-events-none disabled:opacity-60"
            >
              Switch to {tpInPips ? "price" : "pips"}
            </button>
          }
          type="text"
          inputMode="decimal"
          value={tp}
          onChange={(event) => setTp(decimalInput(event.target.value))}
          disabled={isActive || submitting}
          placeholder="leave blank for default"
        />

        <ToggleField
          label="Position Sizing"
          value={sizingMode}
          onChange={setSizingMode}
          disabled={isActive || submitting}
          options={[
            { value: "risk", label: "Risk %", activeClassName: "bg-slate-950 text-white shadow-sm" },
            { value: "lot", label: "Lot", activeClassName: "bg-slate-950 text-white shadow-sm" },
          ]}
        />

        {sizingMode === "risk" ? (
          <Field
            label="Risk %"
            type="text"
            inputMode="decimal"
            value={riskPercent}
            onChange={(event) => setRiskPercent(decimalInput(event.target.value))}
            disabled={isActive || submitting}
          />
        ) : (
          <Field
            label="Lot"
            type="text"
            inputMode="decimal"
            value={lot}
            onChange={(event) => setLot(decimalInput(event.target.value, 2))}
            disabled={isActive || submitting}
          />
        )}
      </div>

      <div className="flex items-center gap-2">
        {isActive ? (
          <AppButton variant="red" onClick={handleStop} disabled={submitting}>
            Stop
          </AppButton>
        ) : (
          <AppButton variant="blue" onClick={handleStart} disabled={submitting}>
            {phase === "placed" || phase === "stopped" || phase === "error" ? (
              <>
                <RefreshCcw className="h-4 w-4" />
                Arm again
              </>
            ) : (
              "Start"
            )}
          </AppButton>
        )}
      </div>
    </div>
  );
}
