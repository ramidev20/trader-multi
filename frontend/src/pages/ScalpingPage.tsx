import React, { useEffect, useRef, useState } from "react";
import { RefreshCcw, StopCircle } from "lucide-react";
import { AppButton, Field } from "../components/ui/Primitives";
import { ORDER_KIND_OPTIONS, IconSelect } from "./Placeholders";
import { cx, decimalInput } from "../utils/format";
import { api } from "../services/api";

const STORAGE_KEY = "trader.scalping.form";
const POLL_INTERVAL_MS = 1500;
const SYMBOL = "XAUUSD";

const PHASE_LABELS = {
  idle: "Idle",
  waiting_trigger: "Waiting for M15 trigger",
  searching_m5_zone: "Searching M5 for matching zone",
  searching_m1_zone: "Searching M1 to confirm entry",
  placed: "Order placed",
  stopped: "Stopped",
  error: "Error",
};

const SIDE_META = {
  demand: { label: "Demand", activeClassName: "bg-emerald-600 text-white shadow-sm" },
  supply: { label: "Supply", activeClassName: "bg-rose-600 text-white shadow-sm" },
};

const DEFAULT_CHECK_CYCLE_SEC = "60";

function SwitchToggle({ checked, onChange, disabled = false }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition disabled:opacity-50",
        checked ? "bg-blue-600" : "bg-slate-300",
      )}
    >
      <span
        className={cx(
          "h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform duration-200",
          checked ? "translate-x-4" : "translate-x-1",
        )}
      />
    </button>
  );
}

function loadSavedForm() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function ZoneSideCard({
  side,
  price,
  onPriceChange,
  instantM5,
  onInstantM5Change,
  checkCycleSec,
  onCheckCycleChange,
  phase,
  isActive,
  lastError,
  disabled,
  onStop,
  stopping,
}) {
  const meta = SIDE_META[side];
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className={cx("rounded-lg px-2.5 py-1 text-xs font-black uppercase tracking-wide", meta.activeClassName)}>
          {meta.label}
        </span>
        <span
          className={cx(
            "shrink-0 rounded-full px-2.5 py-1 text-xs font-bold",
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
      <div className="mt-3">
        <Field
          label={`${meta.label} Amount (M15)`}
          labelExtra={
            <span className="flex items-center gap-1.5 normal-case tracking-normal">
              <span className="text-[11px] font-semibold text-slate-500">Instant M5 start</span>
              <SwitchToggle
                checked={instantM5}
                onChange={onInstantM5Change}
                disabled={disabled || isActive}
              />
            </span>
          }
          type="text"
          inputMode="decimal"
          value={price}
          onChange={(event) => onPriceChange(decimalInput(event.target.value))}
          disabled={disabled || isActive || instantM5}
          placeholder={instantM5 ? "Not needed -- M15 treated as already triggered" : "e.g. 3352.40"}
        />
        <p className="mt-1 text-[11px] leading-4 text-slate-400">
          {instantM5
            ? `Skips the M15 wait -- arms straight into the M5 ${meta.label.toLowerCase()} search.`
            : "Waits for price to touch this M15 level before searching M5."}
        </p>
      </div>
      {!instantM5 ? (
        <div className="mt-2">
          <Field
            label="Check cycle (sec)"
            type="text"
            inputMode="decimal"
            value={checkCycleSec}
            onChange={(event) => onCheckCycleChange(decimalInput(event.target.value))}
            disabled={disabled || isActive}
            placeholder="e.g. 60"
          />
          <p className="mt-1 text-[11px] leading-4 text-slate-400">
            How often (1 min or less) to check whether price has hit the M15 amount. Only applies
            to this M15 search.
          </p>
        </div>
      ) : null}
      {lastError ? (
        <div className="mt-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">
          {lastError}
        </div>
      ) : null}
      {isActive ? (
        <AppButton
          variant="soft"
          className="mt-3 w-full"
          onClick={onStop}
          disabled={stopping}
        >
          <StopCircle className="h-4 w-4" /> Stop {meta.label} Search
        </AppButton>
      ) : null}
    </div>
  );
}

export default function ScalpingPage() {
  const saved = useRef(loadSavedForm()).current;
  const [demandPrice, setDemandPrice] = useState(saved.demandPrice ?? "");
  const [supplyPrice, setSupplyPrice] = useState(saved.supplyPrice ?? "");
  const [demandInstantM5, setDemandInstantM5] = useState(saved.demandInstantM5 ?? false);
  const [supplyInstantM5, setSupplyInstantM5] = useState(saved.supplyInstantM5 ?? false);
  const [demandCheckCycleSec, setDemandCheckCycleSec] = useState(
    saved.demandCheckCycleSec ?? DEFAULT_CHECK_CYCLE_SEC,
  );
  const [supplyCheckCycleSec, setSupplyCheckCycleSec] = useState(
    saved.supplyCheckCycleSec ?? DEFAULT_CHECK_CYCLE_SEC,
  );
  const [minSlPips, setMinSlPips] = useState(saved.minSlPips ?? "");
  const [liquiditySlPips, setLiquiditySlPips] = useState(saved.liquiditySlPips ?? "0");
  const [orderKind, setOrderKind] = useState(saved.orderKind ?? "MARKET");
  const [riskPercent, setRiskPercent] = useState(saved.riskPercent ?? "1");

  const [status, setStatus] = useState({ demand: null, supply: null });
  const [submitting, setSubmitting] = useState(false);
  const [stoppingSide, setStoppingSide] = useState(null);
  const [errorText, setErrorText] = useState("");

  useEffect(() => {
    const form = {
      demandPrice,
      supplyPrice,
      demandInstantM5,
      supplyInstantM5,
      demandCheckCycleSec,
      supplyCheckCycleSec,
      minSlPips,
      liquiditySlPips,
      orderKind,
      riskPercent,
    };
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(form));
    } catch {
      // ignore persistence failures (private mode, storage full, etc.)
    }
  }, [
    demandPrice,
    supplyPrice,
    demandInstantM5,
    supplyInstantM5,
    demandCheckCycleSec,
    supplyCheckCycleSec,
    minSlPips,
    liquiditySlPips,
    orderKind,
    riskPercent,
  ]);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const result = await api.zoneStrategyStatus();
        if (!cancelled) {
          setStatus({
            demand: result?.zone_strategy?.demand || null,
            supply: result?.zone_strategy?.supply || null,
          });
        }
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

  const ACTIVE_PHASES = ["waiting_trigger", "searching_m5_zone", "searching_m1_zone"];
  const demandPhase = status.demand?.phase ?? "idle";
  const supplyPhase = status.supply?.phase ?? "idle";
  const demandActive = ACTIVE_PHASES.includes(demandPhase);
  const supplyActive = ACTIVE_PHASES.includes(supplyPhase);
  const anyActive = demandActive || supplyActive;

  function buildPayload(side, price, instantM5, checkCycleSec) {
    return {
      symbol: SYMBOL,
      trigger_price: instantM5 ? 0 : Number(price),
      trigger_zone_type: side,
      manual_sl_distance: Number(minSlPips),
      sl_distance_in_pips: true,
      liquidity_buffer_pips: Number(liquiditySlPips || 0),
      order_kind: orderKind,
      lot: null,
      risk_percent: Number(riskPercent || 0),
      instant_m5_start: Boolean(instantM5),
      trigger_check_cycle_sec: Number(checkCycleSec || DEFAULT_CHECK_CYCLE_SEC),
    };
  }

  async function handleStart() {
    setErrorText("");
    if (!(Number(minSlPips) > 0)) {
      setErrorText("Enter a min SL (pips) amount greater than 0.");
      return;
    }
    const candidates = [
      {
        side: "demand",
        price: demandPrice,
        active: demandActive,
        instantM5: demandInstantM5,
        checkCycleSec: demandCheckCycleSec,
      },
      {
        side: "supply",
        price: supplyPrice,
        active: supplyActive,
        instantM5: supplyInstantM5,
        checkCycleSec: supplyCheckCycleSec,
      },
    ].filter((candidate) => !candidate.active && (candidate.instantM5 || Number(candidate.price) > 0));

    if (!candidates.length) {
      setErrorText(
        "Enter a valid demand and/or supply M15 amount (or enable Instant M5 start) to arm a search.",
      );
      return;
    }

    setSubmitting(true);
    try {
      const results = await Promise.allSettled(
        candidates.map(({ side, price, instantM5, checkCycleSec }) =>
          api.startZoneStrategy(buildPayload(side, price, instantM5, checkCycleSec)),
        ),
      );
      const failures = results
        .map((result, index) => ({ result, side: candidates[index].side }))
        .filter(({ result }) => result.status === "rejected");
      if (failures.length) {
        setErrorText(
          failures
            .map(({ result, side }) => `${side}: ${String(result.reason?.message || result.reason)}`)
            .join(" | "),
        );
      }
      const result = await api.zoneStrategyStatus();
      setStatus({
        demand: result?.zone_strategy?.demand || null,
        supply: result?.zone_strategy?.supply || null,
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleStop(side) {
    setStoppingSide(side);
    try {
      const result = await api.stopZoneStrategy(side);
      setStatus({
        demand: result?.zone_strategy?.demand || null,
        supply: result?.zone_strategy?.supply || null,
      });
      setErrorText("");
    } catch (error) {
      setErrorText(String(error?.message || error));
    } finally {
      setStoppingSide(null);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div>
        <h3 className="m-0 text-lg font-black text-slate-950">Scalping</h3>
        <p className="mt-1 text-sm text-slate-500">
          Enter a manually spotted M15 demand and/or supply level. Once price touches
          either one, the engine watches new M5 candles for a matching zone (same
          side), then new M1 candles for another matching zone, before opening that
          trade. The demand and supply searches run independently, so both can be
          armed and both can fire. Lines draw live on the Chart tab.
        </p>
      </div>

      {errorText ? (
        <div className="shrink-0 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-700">
          {errorText}
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        <ZoneSideCard
          side="demand"
          price={demandPrice}
          onPriceChange={setDemandPrice}
          instantM5={demandInstantM5}
          onInstantM5Change={setDemandInstantM5}
          checkCycleSec={demandCheckCycleSec}
          onCheckCycleChange={setDemandCheckCycleSec}
          phase={demandPhase}
          isActive={demandActive}
          lastError={status.demand?.last_error}
          disabled={submitting}
          onStop={() => handleStop("demand")}
          stopping={stoppingSide === "demand"}
        />
        <ZoneSideCard
          side="supply"
          price={supplyPrice}
          onPriceChange={setSupplyPrice}
          instantM5={supplyInstantM5}
          onInstantM5Change={setSupplyInstantM5}
          checkCycleSec={supplyCheckCycleSec}
          onCheckCycleChange={setSupplyCheckCycleSec}
          phase={supplyPhase}
          isActive={supplyActive}
          lastError={status.supply?.last_error}
          disabled={submitting}
          onStop={() => handleStop("supply")}
          stopping={stoppingSide === "supply"}
        />
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <IconSelect
          label="Order Type"
          value={orderKind}
          options={ORDER_KIND_OPTIONS}
          onChange={setOrderKind}
          disabled={submitting}
        />

        <Field
          label="Risk %"
          type="text"
          inputMode="decimal"
          value={riskPercent}
          onChange={(event) => setRiskPercent(decimalInput(event.target.value))}
          disabled={submitting}
        />

        <Field
          label="Min SL (pips)"
          type="text"
          inputMode="decimal"
          value={minSlPips}
          onChange={(event) => setMinSlPips(decimalInput(event.target.value))}
          disabled={submitting}
          placeholder="e.g. 50"
        />

        <Field
          label="Liquidity SL (pips)"
          type="text"
          inputMode="decimal"
          value={liquiditySlPips}
          onChange={(event) => setLiquiditySlPips(decimalInput(event.target.value))}
          disabled={submitting}
          placeholder="e.g. 5"
        />
      </div>

      <div className="flex items-center gap-2">
        <AppButton variant="blue" onClick={handleStart} disabled={submitting}>
          {anyActive ? (
            <>
              <RefreshCcw className="h-4 w-4" />
              Arm remaining
            </>
          ) : (
            "Start"
          )}
        </AppButton>
      </div>
    </div>
  );
}
