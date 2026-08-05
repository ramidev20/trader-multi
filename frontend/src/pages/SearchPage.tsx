import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CalendarDays,
  Clock3,
  Play,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
  StopCircle,
  Trash2,
  Zap,
} from "lucide-react";
import dayjs from "dayjs";
import { LocalizationProvider } from "@mui/x-date-pickers/LocalizationProvider";
import { AdapterDayjs } from "@mui/x-date-pickers/AdapterDayjs";
import { DesktopDatePicker } from "@mui/x-date-pickers/DesktopDatePicker";
import { TimePicker } from "@mui/x-date-pickers/TimePicker";
import { cx, decimalInput } from "../utils/format";
import {
  AppButton,
  Card,
  Dialog,
  Field,
  SelectBox,
} from "../components/ui/Primitives";
import { api } from "../services/api";
import { LogList } from "../components/ui/LogList";

function LogPanel({ logs }) {
  return (
    <Card className="flex min-h-[520px] flex-col">
      <LogList logs={logs} emptyMessage="[INFO] No strategy logs yet." />
    </Card>
  );
}

export default function SearchPage({
  runtime,
  onRefreshRuntime,
  onPickerInteractionChange = () => {},
}) {
  const timeframeOptions = ["M1", "M3", "M5", "M15"];
  const didHydrateDefaults = useRef(false);
  const [activeTab, setActiveTab] = useState("search");
  const [showDefaultsDialog, setShowDefaultsDialog] = useState(false);
  const [errorText, setErrorText] = useState("");
  const [strategyRunning, setStrategyRunning] = useState(false);
  const [leqList, setLeqList] = useState([]);
  const [leqPrice, setLeqPrice] = useState("3348.20");
  const [leqSide, setLeqSide] = useState("BUY");
  const [startDate, setStartDate] = useState(new Date());
  const [startTime, setStartTime] = useState(new Date());
  const [endDate, setEndDate] = useState(new Date());
  const [endTime, setEndTime] = useState(new Date());
  const [endEnabled, setEndEnabled] = useState(false);
  const [pauseSearch, setPauseSearch] = useState(false);
  const [enableBuy, setEnableBuy] = useState(true);
  const [enableSell, setEnableSell] = useState(true);
  const [liquidityTrigger, setLiquidityTrigger] = useState(true);
  const [tpPips, setTpPips] = useState(true);
  const [slPips, setSlPips] = useState(true);
  const [tpValue, setTpValue] = useState("400");
  const [slValue, setSlValue] = useState("200");
  const [lotValue, setLotValue] = useState("0.03");
  const [riskPercentValue, setRiskPercentValue] = useState("1");
  const [timeframeValue, setTimeframeValue] = useState("M1");
  const [minPipsValue, setMinPipsValue] = useState("10");
  const [maxPipsValue, setMaxPipsValue] = useState("100");
  const [maxPositionsValue, setMaxPositionsValue] = useState("1");
  const [openPicker, setOpenPicker] = useState(null);

  const logs = useMemo(() => runtime?.logs?.search || [], [runtime]);

  function applySavedSearchConfig(searchConfig) {
    if (!searchConfig || typeof searchConfig !== "object") return;
    setTimeframeValue(String(searchConfig.timeframe ?? "M1"));
    setLotValue(String(searchConfig.lot ?? 0.03));
    setMinPipsValue(String(searchConfig.pips ?? searchConfig.min_pips ?? 10));
    setMaxPipsValue(String(searchConfig.max_pips ?? 100));
    setMaxPositionsValue(String(searchConfig.max_positions ?? 1));
    setTpValue(String(searchConfig.tp ?? 400));
    setSlValue(String(searchConfig.sl ?? 200));
    setRiskPercentValue(String(searchConfig.risk_percent ?? 1));
    setEnableBuy(Boolean(searchConfig.enable_buy ?? true));
    setEnableSell(Boolean(searchConfig.enable_sell ?? true));
    setLiquidityTrigger(Boolean(searchConfig.enable_liquidity ?? true));
    setPauseSearch(Boolean(searchConfig.stop_on_first_close ?? false));
    setTpPips(Boolean(searchConfig.tp_type ?? true));
    setSlPips(Boolean(searchConfig.sl_type ?? true));
  }

  useEffect(() => {
    setStrategyRunning(Boolean(runtime?.strategy?.running));
    setLeqList(
      Array.isArray(runtime?.liquidity_levels) ? runtime.liquidity_levels : [],
    );

    // Route switching remounts this page; hydrate once from saved backend defaults.
    if (!didHydrateDefaults.current) {
      const saved = runtime?.bootstrap_cache?.settings?.search_config;
      if (saved) {
        applySavedSearchConfig(saved);
        didHydrateDefaults.current = true;
      }
    }
  }, [runtime]);

  function combineDateTime(datePart, timePart) {
    const d = new Date(datePart);
    d.setHours(
      timePart.getHours(),
      timePart.getMinutes(),
      timePart.getSeconds(),
      0,
    );
    return d.toISOString();
  }

  function parseIntegerField(
    value,
    fallback,
    min = 0,
    max = Number.POSITIVE_INFINITY,
  ) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  }

  function parseDecimalField(
    value,
    fallback,
    min = 0,
    max = Number.POSITIVE_INFINITY,
    precision = 2,
  ) {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) return fallback;
    const clamped = Math.min(max, Math.max(min, parsed));
    return Number(clamped.toFixed(precision));
  }

  function setPickerOpenState(pickerKey, isOpen) {
    const nextValue = isOpen ? pickerKey : null;
    setOpenPicker(nextValue);
    onPickerInteractionChange(Boolean(nextValue));
  }

  useEffect(() => {
    return () => onPickerInteractionChange(false);
  }, [onPickerInteractionChange]);

  async function addLiquidityLevel() {
    if (!liquidityTrigger) return;
    const priceNum = Number(leqPrice);
    if (!priceNum || priceNum <= 0) return;
    try {
      await api.addLiquidityLevel({ price: priceNum, side: leqSide });
      await onRefreshRuntime?.({ silent: true });
      setLeqPrice("");
      setErrorText("");
    } catch (error) {
      setErrorText(String(error?.message || error));
    }
  }

  async function removeLiquidityLevel(id) {
    try {
      await api.removeLiquidityLevel(id);
      await onRefreshRuntime?.({ silent: true });
      setErrorText("");
    } catch (error) {
      setErrorText(String(error?.message || error));
    }
  }

  async function startStrategy() {
    try {
      if (!enableBuy && !enableSell) {
        setErrorText("Enable at least one side before starting strategy.");
        return;
      }

      const startIso = combineDateTime(startDate, startTime);
      const endIso = endEnabled ? combineDateTime(endDate, endTime) : null;
      if (endIso && new Date(endIso) <= new Date(startIso)) {
        setErrorText("End time must be later than start time.");
        return;
      }

      const normalizedLot = parseDecimalField(lotValue, 0.03, 0.01, 10, 2);
      const normalizedRiskPercent = parseDecimalField(
        riskPercentValue,
        1,
        0.01,
        100,
        2,
      );
      const normalizedMaxPositions = parseIntegerField(
        maxPositionsValue,
        1,
        1,
        999,
      );
      const normalizedMinPips = parseIntegerField(minPipsValue, 10, 1, 99999);
      const normalizedMaxPips = parseIntegerField(maxPipsValue, 100, 1, 99999);
      const normalizedTp = tpPips
        ? parseIntegerField(tpValue, 400, 1, 99999)
        : parseDecimalField(tpValue, 400, 0.01, 99999, 2);
      const normalizedSl = slPips
        ? parseIntegerField(slValue, 200, 1, 99999)
        : parseDecimalField(slValue, 200, 0.01, 99999, 2);

      const searchConfig = {
        time: 900,
        timeframe: timeframeValue,
        lot: normalizedLot,
        risk_percent: normalizedRiskPercent,
        order_delay: 0,
        max_positions: normalizedMaxPositions,
        orders_limit: normalizedMaxPositions * 10,
        pips: normalizedMinPips,
        max_pips: normalizedMaxPips,
        tp: normalizedTp,
        sl: normalizedSl,
        enable_liquidity: Boolean(liquidityTrigger),
        enable_buy: Boolean(enableBuy),
        enable_sell: Boolean(enableSell),
        stop_on_first_close: Boolean(pauseSearch),
        tp_type: Boolean(tpPips),
        sl_type: Boolean(slPips),
      };
      await api.saveSearchConfig(searchConfig);
      await api.startStrategy({
        liquidity_enabled: Boolean(liquidityTrigger),
        start_time: startIso,
        end_time: endIso,
      });
      await onRefreshRuntime?.();
      setStrategyRunning(true);
      setErrorText("");
    } catch (error) {
      setErrorText(String(error?.message || error));
    }
  }

  async function stopStrategy() {
    try {
      await api.stopStrategy();
      await onRefreshRuntime?.();
      setStrategyRunning(false);
      setErrorText("");
    } catch (error) {
      setErrorText(String(error?.message || error));
    }
  }

  function SwitchKnob({ checked }) {
    return (
      <span
        className={cx(
          "relative inline-flex h-6 w-11 items-center rounded-full transition",
          checked ? "bg-blue-600" : "bg-slate-300",
        )}
      >
        <span
          className={cx(
            "h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200",
            checked ? "translate-x-6" : "translate-x-1",
          )}
        />
      </span>
    );
  }

  function Switcher({ checked, onChange, label }) {
    return (
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className="flex w-full items-center justify-between rounded-[8px] border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700"
      >
        <span>{label}</span>
        <SwitchKnob checked={checked} />
      </button>
    );
  }

  function InlineSwitcher({ checked, onChange, label }) {
    return (
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className="flex h-[50px] w-full items-center justify-between rounded-[8px] border border-slate-200 bg-slate-50 px-4 text-sm font-semibold text-slate-700 transition hover:bg-white"
      >
        <span>{label}</span>
        <SwitchKnob checked={checked} />
      </button>
    );
  }

  function DateTimeField({ fieldKey, label, picker, value, onChange }) {
    const Icon = picker === "date" ? CalendarDays : Clock3;
    const pickerKey = fieldKey || `${label}-${picker}`;
    const commonSlotProps = {
      textField: {
        fullWidth: true,
        onFocus: () => setPickerOpenState(pickerKey, true),
        InputProps: {
          endAdornment: <Icon className="h-4 w-4 text-slate-400" />,
        },
        sx: {
          "& .MuiOutlinedInput-root": {
            height: 46,
            borderRadius: "1rem",
            backgroundColor: "#ffffff",
            fontSize: "0.875rem",
            fontWeight: 600,
          },
        },
      },
      popper: {
        placement: "bottom-start",
      },
    };

    const dayValue = dayjs(value);

    return (
      <label className="block">
        <span className="text-xs font-bold uppercase tracking-wide text-slate-500">
          {label}
        </span>
        <div className="mt-1">
          {picker === "date" ? (
            <DesktopDatePicker
              value={dayValue}
              format="DD/MM/YYYY"
              open={openPicker === pickerKey}
              onOpen={() => setPickerOpenState(pickerKey, true)}
              onClose={() => setPickerOpenState(pickerKey, false)}
              onChange={(newValue) => {
                if (newValue?.isValid?.()) {
                  const next = new Date(value);
                  next.setFullYear(
                    newValue.year(),
                    newValue.month(),
                    newValue.date(),
                  );
                  onChange(next);
                }
              }}
              slotProps={commonSlotProps}
            />
          ) : (
            <TimePicker
              value={dayValue}
              ampm={false}
              views={["hours", "minutes"]}
              open={openPicker === pickerKey}
              onOpen={() => setPickerOpenState(pickerKey, true)}
              onClose={() => setPickerOpenState(pickerKey, false)}
              onChange={(newValue) => {
                if (newValue?.isValid?.()) {
                  const next = new Date(value);
                  next.setHours(newValue.hour(), newValue.minute(), 0, 0);
                  onChange(next);
                }
              }}
              slotProps={commonSlotProps}
            />
          )}
        </div>
      </label>
    );
  }

  if (activeTab === "log") {
    return (
      <>
        <div className="mb-6 flex flex-wrap items-center gap-2 border-b border-slate-200">
          <button
            onClick={() => setActiveTab("search")}
            className="px-3 py-4 text-sm font-bold text-slate-500 hover:text-slate-950"
          >
            Search
          </button>
          <button className="relative px-3 py-4 text-sm font-bold text-blue-600">
            Log
            <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-blue-600" />
          </button>
        </div>
        <LogPanel logs={logs} />
      </>
    );
  }

  return (
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      {errorText ? (
        <div className="mb-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">
          {errorText}
        </div>
      ) : null}
      <div className="mb-6 flex flex-wrap items-center gap-2 border-b border-slate-200">
        <button className="relative px-3 py-4 text-sm font-bold text-blue-600">
          Search
          <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-blue-600" />
        </button>
        <button
          onClick={() => setActiveTab("log")}
          className="px-3 py-4 text-sm font-bold text-slate-500 hover:text-slate-950"
        >
          Log
        </button>
        <div className="ml-auto flex flex-wrap items-center gap-2 py-2">
          <AppButton variant="soft" onClick={() => setShowDefaultsDialog(true)}>
            <SlidersHorizontal className="h-4 w-4" /> Load Defaults
          </AppButton>
          <AppButton
            variant="green"
            disabled={strategyRunning}
            onClick={startStrategy}
          >
            <Play className="h-4 w-4" /> Start Strategy
          </AppButton>
          <AppButton
            variant="soft"
            disabled={!strategyRunning}
            onClick={stopStrategy}
          >
            <StopCircle className="h-4 w-4" /> Stop Strategy
          </AppButton>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.75fr)_minmax(340px,0.75fr)]">
        <Card>
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-black text-slate-950">
                Search Configuration
              </h3>
              <p className="mt-1 text-sm text-slate-500">
                Main settings from your current search page, redesigned as clean
                cards.
              </p>
            </div>
            <div className="rounded-2xl bg-blue-50 p-2 text-blue-700">
              <Zap className="h-5 w-5" />
            </div>
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-3">
            <SelectBox
              label="Time Frame"
              value={timeframeValue}
              options={timeframeOptions}
              onChange={(e) => setTimeframeValue(e.target.value)}
            />
            <Field
              label="Lot"
              value={lotValue}
              type="number"
              min="0.01"
              max="10"
              step="0.01"
              inputMode="decimal"
              onChange={(e) => setLotValue(e.target.value)}
            />
            <Field
              label="Risk % (by SL)"
              value={riskPercentValue}
              type="number"
              min="0.01"
              max="100"
              step="0.01"
              inputMode="decimal"
              onChange={(e) => setRiskPercentValue(e.target.value)}
            />
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-3">
            <Field
              label="Min Pips"
              value={minPipsValue}
              type="number"
              min="1"
              step="1"
              inputMode="numeric"
              onChange={(e) => setMinPipsValue(e.target.value)}
            />
            <Field
              label="Max Pips"
              value={maxPipsValue}
              type="number"
              min="1"
              step="1"
              inputMode="numeric"
              onChange={(e) => setMaxPipsValue(e.target.value)}
            />
            <Field
              label="Max Positions"
              value={maxPositionsValue}
              type="number"
              min="1"
              step="1"
              inputMode="numeric"
              onChange={(e) => setMaxPositionsValue(e.target.value)}
            />
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-4 md:items-end">
            <InlineSwitcher
              label="TP in Pips"
              checked={tpPips}
              onChange={setTpPips}
            />
            <Field
              label="TP"
              value={tpValue}
              type="number"
              min={tpPips ? "1" : "0.01"}
              step={tpPips ? "1" : "0.01"}
              inputMode={tpPips ? "numeric" : "decimal"}
              onChange={(e) => setTpValue(tpPips ? e.target.value : decimalInput(e.target.value))}
            />
            <InlineSwitcher
              label="SL in Pips"
              checked={slPips}
              onChange={setSlPips}
            />
            <Field
              label="SL"
              value={slValue}
              type="number"
              min={slPips ? "1" : "0.01"}
              step={slPips ? "1" : "0.01"}
              inputMode={slPips ? "numeric" : "decimal"}
              onChange={(e) => setSlValue(slPips ? e.target.value : decimalInput(e.target.value))}
            />
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-4">
            <Switcher
              label="Enable Buy"
              checked={enableBuy}
              onChange={setEnableBuy}
            />
            <Switcher
              label="Enable Sell"
              checked={enableSell}
              onChange={setEnableSell}
            />
            <Switcher
              label="Liquidity"
              checked={liquidityTrigger}
              onChange={setLiquidityTrigger}
            />
            <Switcher
              label="Pause Search"
              checked={pauseSearch}
              onChange={setPauseSearch}
            />
          </div>

          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-2.5">
              <h4 className="font-black text-slate-950">Start Time</h4>
              <div className="mt-2.5 grid gap-2.5 md:grid-cols-2">
                <DateTimeField
                  fieldKey="start-date"
                  label="Date"
                  picker="date"
                  value={startDate}
                  onChange={setStartDate}
                />
                <DateTimeField
                  fieldKey="start-time"
                  label="Time"
                  picker="time"
                  value={startTime}
                  onChange={setStartTime}
                />
              </div>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-2.5">
              <div className="flex items-center justify-between">
                <h4 className="font-black text-slate-950">End Time</h4>
                <button
                  type="button"
                  onClick={() => setEndEnabled((v) => !v)}
                  className="flex items-center gap-2 text-xs font-bold text-blue-700"
                >
                  <SwitchKnob checked={endEnabled} />
                  Enabled
                </button>
              </div>
              <div className="mt-2.5 grid gap-2.5 md:grid-cols-2">
                <DateTimeField
                  fieldKey="end-date"
                  label="Date"
                  picker="date"
                  value={endDate}
                  onChange={setEndDate}
                />
                <DateTimeField
                  fieldKey="end-time"
                  label="Time"
                  picker="time"
                  value={endTime}
                  onChange={setEndTime}
                />
              </div>
            </div>
          </div>
        </Card>

        <div className="space-y-6">
          <Card>
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-black text-slate-950">
                  Liquidity Levels
                </h3>
                <p className="mt-1 text-sm text-slate-500">
                  Add pending BUY/SELL trigger prices.
                </p>
              </div>
              <ShieldCheck className="h-5 w-5 text-emerald-600" />
            </div>
            {!liquidityTrigger && (
              <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-700">
                Liquidity trigger is disabled. Enable it in Search Configuration
                to edit or add LEQ levels.
              </div>
            )}
            <div className="mt-5 grid gap-3 md:grid-cols-[1fr_120px]">
              <fieldset
                disabled={!liquidityTrigger}
                className="contents disabled:opacity-60"
              >
                <Field
                  label="Price"
                  value={leqPrice}
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  onChange={(e) => setLeqPrice(decimalInput(e.target.value))}
                />
                <SelectBox
                  label="Side"
                  value={leqSide}
                  options={["BUY", "SELL"]}
                  onChange={(e) => setLeqSide(e.target.value)}
                />
              </fieldset>
            </div>
            <AppButton
              className="mt-3 w-full disabled:cursor-not-allowed disabled:opacity-60"
              onClick={addLiquidityLevel}
              disabled={!liquidityTrigger}
            >
              <Plus className="h-4 w-4" /> Add Liquidity Level
            </AppButton>
            <div className="mt-5 space-y-3">
              {leqList.map((level) => (
                <div
                  key={level.id}
                  className="flex items-center justify-between rounded-2xl bg-slate-50 px-4 py-3"
                >
                  <div>
                    <p className="font-bold text-slate-900">
                      {level.side} @ {level.price}
                    </p>
                    <p className="text-xs text-slate-500">
                      {level.state} liquidity level
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={cx(
                        "rounded-full px-2.5 py-1 text-xs font-bold",
                        level.side === "BUY"
                          ? "bg-emerald-50 text-emerald-700"
                          : "bg-rose-50 text-rose-700",
                      )}
                    >
                      {level.side}
                    </span>
                    <button
                      onClick={() => removeLiquidityLevel(level.id)}
                      className="rounded-xl border border-slate-200 p-1.5 text-slate-500 hover:bg-white hover:text-rose-600"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </Card>
          <Card>
            <div className="flex items-start gap-3">
              <div className="rounded-2xl bg-amber-50 p-2 text-amber-700">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div>
                <div>
                  <h3 className="font-black text-slate-950">Execution Safety</h3>
                  <p className="mt-1 text-sm text-slate-500">
                    Before sending orders, validate terminal connection, symbol
                    visibility, spread, max positions, and account risk.
                  </p>
                </div>
              </div>
            </div>
          </Card>
        </div>
      </div>

      <Dialog
        open={showDefaultsDialog}
        title="Search Default Settings"
        onClose={() => setShowDefaultsDialog(false)}
      >
        <div className="grid gap-4 md:grid-cols-3">
          <Field
            label="Lot"
            value={lotValue}
            type="number"
            min="0.01"
            max="10"
            step="0.01"
            inputMode="decimal"
            onChange={(e) => setLotValue(e.target.value)}
          />
          <Field
            label="Risk % (by SL)"
            value={riskPercentValue}
            type="number"
            min="0.01"
            max="100"
            step="0.01"
            inputMode="decimal"
            onChange={(e) => setRiskPercentValue(e.target.value)}
          />
          <Field
            label="Min Pips"
            value={minPipsValue}
            type="number"
            min="1"
            step="1"
            inputMode="numeric"
            onChange={(e) => setMinPipsValue(e.target.value)}
          />
          <Field
            label="Max Pips"
            value={maxPipsValue}
            type="number"
            min="1"
            step="1"
            inputMode="numeric"
            onChange={(e) => setMaxPipsValue(e.target.value)}
          />
          <Field
            label="Max Positions"
            value={maxPositionsValue}
            type="number"
            min="1"
            step="1"
            inputMode="numeric"
            onChange={(e) => setMaxPositionsValue(e.target.value)}
          />
          <Field
            label="TP"
            value={tpValue}
            type="number"
            min={tpPips ? "1" : "0.01"}
            step={tpPips ? "1" : "0.01"}
            inputMode={tpPips ? "numeric" : "decimal"}
            onChange={(e) => setTpValue(tpPips ? e.target.value : decimalInput(e.target.value))}
          />
          <Field
            label="SL"
            value={slValue}
            type="number"
            min={slPips ? "1" : "0.01"}
            step={slPips ? "1" : "0.01"}
            inputMode={slPips ? "numeric" : "decimal"}
            onChange={(e) => setSlValue(slPips ? e.target.value : decimalInput(e.target.value))}
          />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <AppButton
            variant="soft"
            onClick={() => setShowDefaultsDialog(false)}
          >
            Cancel
          </AppButton>
          <AppButton
            variant="blue"
            onClick={() => {
              applySavedSearchConfig(
                runtime?.bootstrap_cache?.settings?.search_config,
              );
              setShowDefaultsDialog(false);
            }}
          >
            Apply
          </AppButton>
        </div>
      </Dialog>
    </LocalizationProvider>
  );
}
