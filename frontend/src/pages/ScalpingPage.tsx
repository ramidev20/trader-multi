import React, { useEffect, useMemo, useRef, useState } from "react";
import { RefreshCcw, StopCircle, FlaskConical } from "lucide-react";
import { LocalizationProvider } from "@mui/x-date-pickers/LocalizationProvider";
import { AdapterDayjs } from "@mui/x-date-pickers/AdapterDayjs";
import { AppButton, Field } from "../components/ui/Primitives";
import { ORDER_KIND_OPTIONS, IconSelect } from "./shared/IconSelect";
import { DateTimeField } from "./shared/DateTimeField";
import { cx, decimalInput } from "../utils/format";
import { clearBanner, showBanner } from "../utils/banner";
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
  demand: {
    label: "Demand",
    activeClassName: "bg-emerald-600 text-white shadow-sm",
  },
  supply: {
    label: "Supply",
    activeClassName: "bg-rose-600 text-white shadow-sm",
  },
};


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
  phase,
  isActive,
  confirmationLevel,
  lastError,
  disabled,
  onStop,
  stopping,
  onDevTest,
  devTesting,
}) {
  const meta = SIDE_META[side];
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="flex items-center justify-between gap-2">
        <span
          className={cx(
            "rounded-lg px-2.5 py-1 text-xs font-black uppercase tracking-wide",
            meta.activeClassName,
          )}
        >
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
              <span className="text-[11px] font-semibold text-slate-500">
                Instant M5 start
              </span>
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
          placeholder={
            instantM5
              ? "Not needed -- M15 treated as already triggered"
              : "e.g. 3352.40"
          }
        />
        <p className="mt-1 text-[11px] leading-4 text-slate-400">
          {instantM5
            ? `Skips the M15 wait -- arms straight into the M5 ${meta.label.toLowerCase()} search.`
            : "Waits for price to touch this M15 level before searching M5."}
        </p>
        {!instantM5 &&
        phase === "waiting_trigger" &&
        Number(confirmationLevel) > 0 ? (
          <p className="mt-1 text-[11px] font-semibold leading-4 text-blue-600">
            Amount reached -- confirming against M1{" "}
            {side === "supply" ? "high" : "low"}{" "}
            {Number(confirmationLevel).toFixed(2)} before firing.
          </p>
        ) : null}
      </div>
      {!instantM5 ? (
        <div className="mt-2">
          <Field
            label="M15 trigger check (sec)"
            type="text"
            value="60"
            disabled
          />
          <p className="mt-1 text-[11px] leading-4 text-slate-400">
            Checks for the M15 trigger once every minute.
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
      <AppButton
        variant="soft"
        className="mt-3 w-full"
        onClick={onDevTest}
        disabled={disabled || devTesting || isActive}
        title="Dev only -- skips the M15 trigger and M5 zone, searching M1 directly and placing an order as soon as a qualifying M1 zone forms."
      >
        <FlaskConical className="h-4 w-4" /> 1 min dev test
      </AppButton>
    </div>
  );
}

export default function ScalpingPage() {
  const saved = useRef(loadSavedForm()).current;
  const [demandPrice, setDemandPrice] = useState(saved.demandPrice ?? "");
  const [supplyPrice, setSupplyPrice] = useState(saved.supplyPrice ?? "");
  const [demandInstantM5, setDemandInstantM5] = useState(
    saved.demandInstantM5 ?? false,
  );
  const [supplyInstantM5, setSupplyInstantM5] = useState(
    saved.supplyInstantM5 ?? false,
  );
  const [minSlPips, setMinSlPips] = useState(saved.minSlPips ?? "");
  const [liquiditySlPips, setLiquiditySlPips] = useState(
    saved.liquiditySlPips ?? "0",
  );
  const [orderKind, setOrderKind] = useState(saved.orderKind ?? "MARKET");
  const [riskPercent, setRiskPercent] = useState(saved.riskPercent ?? "1");

  // Multi-TP (up to 2 stages), same mechanism as Manual Trade's Advanced
  // Risk panel -- but with no Stop Loss Price field, since the SL here
  // always comes from the strategy's own liquidity-swing/min-SL calculation,
  // never a typed price.
  const [tp1Ratio, setTp1Ratio] = useState(saved.tp1Ratio ?? "1.0");
  const [tp2Ratio, setTp2Ratio] = useState(saved.tp2Ratio ?? "1.0");
  const [tp2Enabled, setTp2Enabled] = useState(saved.tp2Enabled ?? false);
  const [tp1Percent, setTp1Percent] = useState(saved.tp1Percent ?? "100");
  const [tp2Percent, setTp2Percent] = useState(saved.tp2Percent ?? "100");

  // Optional schedule, same idea as the Search page's Start/End Time, but
  // time-of-day only -- this always applies to today, so there's no date
  // picker. Start delays the M15 trigger watch (or the M5/M1 search
  // directly when paired with a side's "Instant M5" checkbox); end
  // auto-stops the search and closes any open position, same as the Search
  // page's End Time. Times round-trip through localStorage as ISO strings,
  // so they're rehydrated back into Date objects here rather than used as-is.
  const [startTime, setStartTime] = useState(
    () => new Date(saved.startTime || Date.now()),
  );
  const [endTime, setEndTime] = useState(
    () => new Date(saved.endTime || Date.now()),
  );
  const [endEnabled, setEndEnabled] = useState(saved.endEnabled ?? false);
  const [openPicker, setOpenPicker] = useState(null);

  const [status, setStatus] = useState({ demand: null, supply: null });
  const [submitting, setSubmitting] = useState(false);
  const [stoppingSide, setStoppingSide] = useState(null);
  const [devTestingSide, setDevTestingSide] = useState(null);
  // Surfaces in the TopBar's banner slot instead of an inline div here.
  // reportError takes the actual Error object so its `.code` (an HTTP status
  // or "NETWORK", attached by services/api.js) survives into the banner.
  function reportError(error) {
    showBanner(error?.message || String(error), "error", error?.code);
  }

  useEffect(() => {
    const form = {
      demandPrice,
      supplyPrice,
      demandInstantM5,
      supplyInstantM5,
      minSlPips,
      liquiditySlPips,
      orderKind,
      riskPercent,
      tp1Ratio,
      tp2Ratio,
      tp2Enabled,
      tp1Percent,
      tp2Percent,
      startTime,
      endTime,
      endEnabled,
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
    minSlPips,
    liquiditySlPips,
    orderKind,
    riskPercent,
    tp1Ratio,
    tp2Ratio,
    tp2Enabled,
    tp1Percent,
    tp2Percent,
    startTime,
    endTime,
    endEnabled,
  ]);

  // Mirrors Manual Trade's Advanced Risk normalization: enabling TP2 defaults
  // TP1's withdrawal down from 100% so there's actually something left for it.
  useEffect(() => {
    if (tp2Enabled && tp1Percent === "100") setTp1Percent("50");
  }, [tp2Enabled]);

  const totalTpRatio = useMemo(() => {
    let total = Number(tp1Ratio || 0);
    if (tp2Enabled) total += Number(tp2Ratio || 0);
    return total;
  }, [tp1Ratio, tp2Enabled, tp2Ratio]);

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

  const ACTIVE_PHASES = [
    "waiting_trigger",
    "searching_m5_zone",
    "searching_m1_zone",
  ];
  const demandPhase = status.demand?.phase ?? "idle";
  const supplyPhase = status.supply?.phase ?? "idle";
  const demandActive = ACTIVE_PHASES.includes(demandPhase);
  const supplyActive = ACTIVE_PHASES.includes(supplyPhase);
  const anyActive = demandActive || supplyActive;

  // Same local-wall-clock ISO format as the Search page's Start/End Time --
  // avoids converting to UTC, which would make the picker look shifted on
  // reload. Always combined with today's date, never a stored one -- this
  // schedule only ever covers "later today", so there's no date to pick.
  function combineDateTime(timePart) {
    const d = new Date();
    d.setHours(
      timePart.getHours(),
      timePart.getMinutes(),
      timePart.getSeconds(),
      0,
    );
    const pad = (value) => String(value).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function setPickerOpenState(pickerKey, isOpen) {
    setOpenPicker(isOpen ? pickerKey : null);
  }

  function buildPayload(side, price, instantM5, devM1 = false) {
    // Dev test is a "right now" shortcut -- it never carries the scheduled
    // start/end window from the main form.
    const startIso = devM1 ? null : combineDateTime(startTime);
    const endIso = !devM1 && endEnabled ? combineDateTime(endTime) : null;
    return {
      symbol: SYMBOL,
      trigger_price: instantM5 || devM1 ? 0 : Number(price),
      trigger_zone_type: side,
      manual_sl_distance: Number(minSlPips),
      sl_distance_in_pips: true,
      liquidity_buffer_pips: Number(liquiditySlPips || 0),
      order_kind: orderKind,
      lot: null,
      risk_percent: Number(riskPercent || 0),
      instant_m5_start: Boolean(instantM5) && !devM1,
      dev_m1_start: Boolean(devM1),
      tp1_ratio: Number(tp1Ratio || 0),
      tp2_ratio: Number(tp2Ratio || 0),
      tp2_enabled: tp2Enabled,
      tp1_percent: Number(tp1Percent || 0),
      tp2_percent: Number(tp2Percent || 0),
      start_time: startIso,
      end_time: endIso,
    };
  }

  async function handleStart() {
    clearBanner();
    if (!(Number(minSlPips) > 0)) {
      showBanner("Enter a min SL (pips) amount greater than 0.", "error");
      return;
    }
    if (!(Number(tp1Ratio) > 0)) {
      showBanner("Enter a TP1 ratio greater than 0.", "error");
      return;
    }
    if (endEnabled) {
      const startIso = combineDateTime(startTime);
      const endIso = combineDateTime(endTime);
      if (new Date(endIso) <= new Date(startIso)) {
        showBanner("End time must be later than start time.", "error");
        return;
      }
    }
    const candidates = [
      {
        side: "demand",
        price: demandPrice,
        active: demandActive,
        instantM5: demandInstantM5,
      },
      {
        side: "supply",
        price: supplyPrice,
        active: supplyActive,
        instantM5: supplyInstantM5,
      },
    ].filter(
      (candidate) =>
        !candidate.active &&
        (candidate.instantM5 || Number(candidate.price) > 0),
    );

    if (!candidates.length) {
      // Distinguish "both sides are already running, there's nothing left
      // to arm" from "you haven't actually filled anything in" -- the old
      // single message here fired for both, which was misleading right
      // after arming (the amounts you'd typed were already fine).
      showBanner(
        demandActive && supplyActive
          ? "Demand and supply are both already armed. Stop one first to re-arm it."
          : "Enter a valid demand and/or supply M15 amount (or enable Instant M5 start) to arm a search.",
        "error",
      );
      return;
    }

    setSubmitting(true);
    try {
      const results = await Promise.allSettled(
        candidates.map(({ side, price, instantM5 }) =>
          api.startZoneStrategy(
            buildPayload(side, price, instantM5),
          ),
        ),
      );
      const failures = results
        .map((result, index) => ({ result, side: candidates[index].side }))
        .filter(({ result }) => result.status === "rejected");
      if (failures.length) {
        showBanner(
          failures
            .map(
              ({ result, side }) =>
                `${side}: ${String(result.reason?.message || result.reason)}`,
            )
            .join(" | "),
          "error",
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

  async function handleDevM1Start(side) {
    clearBanner();
    if (!(Number(minSlPips) > 0)) {
      showBanner("Enter a min SL (pips) amount greater than 0.", "error");
      return;
    }
    if (!(Number(tp1Ratio) > 0)) {
      showBanner("Enter a TP1 ratio greater than 0.", "error");
      return;
    }
    setDevTestingSide(side);
    try {
      const result = await api.startZoneStrategy(
        buildPayload(side, "", false, true),
      );
      setStatus({
        demand: result?.zone_strategy?.demand || null,
        supply: result?.zone_strategy?.supply || null,
      });
    } catch (error) {
      reportError(error);
    } finally {
      setDevTestingSide(null);
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
      clearBanner();
    } catch (error) {
      reportError(error);
    } finally {
      setStoppingSide(null);
    }
  }

  async function handleStopAll() {
    setStoppingSide("all");
    try {
      const result = await api.stopZoneStrategy();
      setStatus({
        demand: result?.zone_strategy?.demand || null,
        supply: result?.zone_strategy?.supply || null,
      });
      clearBanner();
    } catch (error) {
      reportError(error);
    } finally {
      setStoppingSide(null);
    }
  }

  return (
    <LocalizationProvider dateAdapter={AdapterDayjs}>
    <div className="flex min-h-max flex-none flex-col gap-3">
      <div className="flex flex-wrap justify-end gap-2">
        <AppButton
          variant="blue"
          className="shrink-0"
          onClick={handleStart}
          disabled={submitting || Boolean(stoppingSide) || (demandActive && supplyActive)}
        >
          {demandActive && supplyActive ? (
            "Start"
          ) : anyActive ? (
            <>
              <RefreshCcw className="h-4 w-4" />
              Start {demandActive ? "supply" : "demand"}
            </>
          ) : (
            "Start"
          )}
        </AppButton>
        <AppButton
          variant="red"
          className="shrink-0"
          onClick={handleStopAll}
          disabled={!anyActive || submitting || Boolean(stoppingSide)}
        >
          <StopCircle className="h-4 w-4" />
          {stoppingSide === "all" ? "Stopping..." : "Stop"}
        </AppButton>
      </div>

      {/* Demand, Supply, and Settings side by side on a wide screen (like the
          other tabs' full-width tables/grids) instead of a single centered
          column -- Settings drops onto its own full-width row on medium
          screens where three columns would get cramped, and only sits in a
          narrow third column once xl has the room for it. */}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <ZoneSideCard
          side="demand"
          price={demandPrice}
          onPriceChange={setDemandPrice}
          instantM5={demandInstantM5}
          onInstantM5Change={setDemandInstantM5}
          phase={demandPhase}
          isActive={demandActive}
          confirmationLevel={status.demand?.confirmation_level}
          lastError={status.demand?.last_error}
          disabled={submitting}
          onStop={() => handleStop("demand")}
          stopping={stoppingSide === "demand"}
          onDevTest={() => handleDevM1Start("demand")}
          devTesting={devTestingSide === "demand"}
        />
        <ZoneSideCard
          side="supply"
          price={supplyPrice}
          onPriceChange={setSupplyPrice}
          instantM5={supplyInstantM5}
          onInstantM5Change={setSupplyInstantM5}
          phase={supplyPhase}
          isActive={supplyActive}
          confirmationLevel={status.supply?.confirmation_level}
          lastError={status.supply?.last_error}
          disabled={submitting}
          onStop={() => handleStop("supply")}
          stopping={stoppingSide === "supply"}
          onDevTest={() => handleDevM1Start("supply")}
          devTesting={devTestingSide === "supply"}
        />

        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 md:col-span-2 xl:col-span-1">
          <span className="text-xs font-black uppercase tracking-wide text-slate-500">
            Order Settings
          </span>
          <div className="mt-3 grid grid-cols-2 gap-3">
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
              onChange={(event) =>
                setRiskPercent(decimalInput(event.target.value))
              }
              disabled={submitting}
            />

            <Field
              label="Min SL (pips)"
              type="text"
              inputMode="decimal"
              value={minSlPips}
              onChange={(event) =>
                setMinSlPips(decimalInput(event.target.value))
              }
              disabled={submitting}
              placeholder="e.g. 50"
            />

            <Field
              label="Liquidity SL (pips)"
              type="text"
              inputMode="decimal"
              value={liquiditySlPips}
              onChange={(event) =>
                setLiquiditySlPips(decimalInput(event.target.value))
              }
              disabled={submitting}
              placeholder="e.g. 5"
            />
          </div>
        </div>

        <div className="grid gap-3 lg:grid-cols-2 md:col-span-2 xl:col-span-3">
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-black uppercase tracking-wide text-slate-500">
                Take Profit
              </span>
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-black text-slate-600">
                Total Ratio {totalTpRatio.toFixed(1)}
              </span>
            </div>
            <p className="mt-1 text-[11px] leading-4 text-slate-400">
              Multi-TP, same as Manual Trade&apos;s Advanced Risk panel --
              exits in up to two stages, each at its own risk ratio and share
              of the remaining volume. No Stop Loss Price here: the ratios
              are measured against the SL this strategy already computes per
              trade (liquidity swing vs. Min SL floor above).
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field
                label="TP1 Ratio"
                type="text"
                inputMode="decimal"
                value={tp1Ratio}
                onChange={(event) => setTp1Ratio(decimalInput(event.target.value))}
                disabled={submitting}
              />
              <Field
                label="TP1 %"
                type="text"
                inputMode="decimal"
                value={tp1Percent}
                onChange={(event) => setTp1Percent(event.target.value)}
                disabled={submitting || !tp2Enabled}
              />
              <Field
                label="TP2 Ratio"
                labelExtra={
                  <span className="flex items-center gap-1.5 normal-case tracking-normal">
                    <span className="text-[11px] font-semibold text-slate-500">
                      Enable
                    </span>
                    <SwitchToggle
                      checked={tp2Enabled}
                      onChange={setTp2Enabled}
                      disabled={submitting}
                    />
                  </span>
                }
                type="text"
                inputMode="decimal"
                value={tp2Ratio}
                onChange={(event) => setTp2Ratio(decimalInput(event.target.value))}
                disabled={submitting || !tp2Enabled}
              />
              <Field
                label="TP2 %"
                type="text"
                inputMode="decimal"
                value={tp2Percent}
                onChange={(event) => setTp2Percent(event.target.value)}
                disabled={submitting || !tp2Enabled}
              />
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <span className="text-xs font-black uppercase tracking-wide text-slate-500">
              Schedule
            </span>
            <p className="mt-1 text-[11px] leading-4 text-slate-400">
              Optional -- same as the Search page, always for today. Start
              delays the M15 trigger watch (or the M5/M1 search directly, for
              a side with Instant M5 checked) until this time. End stops the
              search and closes any open position, whichever side hits it
              first. Doesn&apos;t apply to the 1 min dev test.
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div className="rounded-lg border border-slate-200 bg-white p-2.5">
                <h4 className="font-black text-slate-950">Start Time</h4>
                <div className="mt-2.5">
                  <DateTimeField
                    fieldKey="scalping-start-time"
                    label="Time"
                    picker="time"
                    value={startTime}
                    onChange={setStartTime}
                    openPicker={openPicker}
                    setPickerOpenState={setPickerOpenState}
                  />
                </div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-2.5">
                <div className="flex items-center justify-between">
                  <h4 className="font-black text-slate-950">End Time</h4>
                  <span className="flex items-center gap-1.5">
                    <span className="text-[11px] font-semibold text-slate-500">
                      Enabled
                    </span>
                    <SwitchToggle
                      checked={endEnabled}
                      onChange={setEndEnabled}
                      disabled={submitting}
                    />
                  </span>
                </div>
                <div className="mt-2.5">
                  <DateTimeField
                    fieldKey="scalping-end-time"
                    label="Time"
                    picker="time"
                    value={endTime}
                    onChange={setEndTime}
                    openPicker={openPicker}
                    setPickerOpenState={setPickerOpenState}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    </LocalizationProvider>
  );
}
