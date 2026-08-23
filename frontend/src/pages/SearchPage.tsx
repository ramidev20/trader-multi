import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
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

function formatTime12(value) {
  const date = new Date(value);
  const hour = date.getHours() % 12 || 12;
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${hour}:${minute} ${date.getHours() >= 12 ? "PM" : "AM"}`;
}

function WheelColumn({ values, selected, format = (item) => item, onChange }) {
  const selectedIndex = Math.max(0, values.indexOf(selected));
  const selectOffset = (offset) => {
    const nextIndex = (selectedIndex + offset + values.length) % values.length;
    onChange(values[nextIndex]);
  };
  return (
    <div
      className="w-20 overflow-hidden"
      onWheel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        selectOffset(event.deltaY > 0 ? 1 : -1);
      }}
    >
      <div className="flex h-36 flex-col items-center justify-center">
        {[-1, 0, 1].map((offset) => {
          const index = (selectedIndex + offset + values.length) % values.length;
          const isSelected = offset === 0;
          return (
            <button
              key={`${String(values[index])}-${offset}`}
              type="button"
              onClick={() => onChange(values[index])}
              className={`flex h-12 w-full items-center justify-center text-2xl font-normal transition ${
                isSelected
                  ? "border-y-2 border-blue-400 text-slate-950"
                  : "text-slate-400 hover:text-slate-700"
              }`}
            >
              {format(values[index])}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TimeWheelDialog({ value, title, onCancel, onConfirm }) {
  const source = new Date(value);
  const [hour, setHour] = useState(source.getHours() % 12 || 12);
  const [minute, setMinute] = useState(source.getMinutes());
  const [period, setPeriod] = useState(source.getHours() >= 12 ? "PM" : "AM");
  const hours = Array.from({ length: 12 }, (_, index) => index + 1);
  const minutes = Array.from({ length: 60 }, (_, index) => index);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  function confirm() {
    const next = new Date(value);
    let nextHour = hour % 12;
    if (period === "PM") nextHour += 12;
    next.setHours(nextHour, minute, 0, 0);
    onConfirm(next);
  }

  return (
    <div
      className="fixed inset-0 z-[1400] flex items-center justify-center bg-slate-950/35 p-4"
      onWheel={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="w-full max-w-[430px] overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="border-b-2 border-blue-600 px-6 py-5 text-3xl font-light text-blue-600">
          {title}
        </div>
        <div className="flex justify-center gap-3 px-6 py-7">
          <WheelColumn values={hours} selected={hour} onChange={setHour} />
          <WheelColumn
            values={minutes}
            selected={minute}
            format={(item) => String(item).padStart(2, "0")}
            onChange={setMinute}
          />
          <WheelColumn values={["AM", "PM"]} selected={period} onChange={setPeriod} />
        </div>
        <div className="flex border-t border-slate-300">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 border-r border-slate-200 py-5 text-lg font-medium text-slate-950 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            className="flex-1 py-5 text-lg font-medium text-slate-950 hover:bg-slate-50"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

function DateTimeField({ fieldKey, label, picker, value, onChange, openPicker, setPickerOpenState }) {
  const Icon = picker === "date" ? CalendarDays : Clock3;
  const pickerKey = fieldKey || `${label}-${picker}`;
  const commonSlotProps = {
    textField: {
      fullWidth: true,
      onClick: () => setPickerOpenState(pickerKey, true),
      InputProps: {
        endAdornment: <Icon className="h-4 w-4 text-slate-400" />,
      },
      sx: {
        "& .MuiPickersInputBase-root": {
          height: 46,
          borderRadius: "1rem",
          backgroundColor: "#ffffff",
          fontSize: "0.875rem",
          fontWeight: 600,
          padding: "0 12px",
        },
        "& .MuiPickersOutlinedInput-notchedOutline": {
          borderColor: "#cbd5e1",
        },
        "&:hover .MuiPickersOutlinedInput-notchedOutline": {
          borderColor: "#60a5fa",
        },
        "& .MuiPickersInputBase-root.Mui-focused .MuiPickersOutlinedInput-notchedOutline": {
          borderColor: "#3b82f6",
          borderWidth: 1,
        },
        "& .MuiPickersInputBase-sectionContent": {
          color: "#0f172a",
          fontSize: "0.875rem",
          fontWeight: 600,
        },
        "& .MuiPickersInputBase-input": {
          padding: 0,
        },
        "& .MuiIconButton-root": {
          color: "#64748b",
          padding: 0,
        },
      },
    },
    popper: { placement: "bottom-start" },
  };
  const dayValue = dayjs(value);
  const isOpen = openPicker === pickerKey;

  return (
    <>
      <label className="block">
        <span className="text-xs font-bold uppercase tracking-wide text-slate-500">{label}</span>
        <div className="mt-1">
          {picker === "date" ? (
            <DesktopDatePicker
              value={dayValue}
              format="DD/MM/YYYY"
              open={isOpen}
              onOpen={() => setPickerOpenState(pickerKey, true)}
              onClose={() => setPickerOpenState(pickerKey, false)}
              onChange={(newValue) => {
                if (newValue?.isValid?.()) {
                  const next = new Date(value);
                  next.setFullYear(newValue.year(), newValue.month(), newValue.date());
                  onChange(next);
                }
              }}
              slotProps={commonSlotProps}
            />
          ) : (
            <button
              type="button"
              onClick={() => setPickerOpenState(pickerKey, true)}
              className="flex h-[46px] w-full items-center justify-between rounded-2xl border border-slate-300 bg-white px-3 text-left text-sm font-semibold leading-none text-slate-900 outline-none transition hover:border-blue-400 focus:border-blue-500 focus:ring-4 focus:ring-blue-100"
            >
              <span>{formatTime12(value)}</span>
              <Clock3 className="h-4 w-4 text-slate-400" />
            </button>
          )}
        </div>
      </label>
      {picker === "time" && isOpen ? (
        <TimeWheelDialog
          value={value}
          title="Select time"
          onCancel={() => setPickerOpenState(pickerKey, false)}
          onConfirm={(next) => {
            onChange(next);
            setPickerOpenState(pickerKey, false);
          }}
        />
      ) : null}
    </>
  );
}

export default function SearchPage({
  runtime,
  searchLogs = [],
  onRefreshRuntime,
  onPickerInteractionChange = () => {},
  timeRange,
  onTimeRangeChange = () => {},
}) {
  const timeframeOptions = ["M1", "M3", "M5", "M15"];
  const didHydrateDefaults = useRef(false);
  const strategyCommand = useRef(null);
  const [activeTab, setActiveTab] = useState("search");
  const [showDefaultsDialog, setShowDefaultsDialog] = useState(false);
  const [errorText, setErrorText] = useState("");
  const [strategyRunning, setStrategyRunning] = useState(false);
  const [leqList, setLeqList] = useState([]);
  const [leqPrice, setLeqPrice] = useState("3348.20");
  const [leqSide, setLeqSide] = useState("BUY");
  const [startDate, setStartDate] = useState(() => timeRange?.startDate || new Date());
  const [startTime, setStartTime] = useState(() => timeRange?.startTime || new Date());
  const [endDate, setEndDate] = useState(() => timeRange?.endDate || new Date());
  const [endTime, setEndTime] = useState(() => timeRange?.endTime || new Date());
  const [endEnabled, setEndEnabled] = useState(() => timeRange?.endEnabled ?? false);
  const [pauseSearch, setPauseSearch] = useState(false);
  const [enableBuy, setEnableBuy] = useState(true);
  const [enableSell, setEnableSell] = useState(true);
  const [liquidityTrigger, setLiquidityTrigger] = useState(true);
  const [tpPips, setTpPips] = useState(true);
  const [slPips, setSlPips] = useState(true);
  const [tpValue, setTpValue] = useState("400");
  const [slValue, setSlValue] = useState("200");
  const [calculatedLot, setCalculatedLot] = useState(null);
  const [timeframeValue, setTimeframeValue] = useState("M1");
  const [minPipsValue, setMinPipsValue] = useState("10");
  const [maxPipsValue, setMaxPipsValue] = useState("100");
  const [maxPositionsValue, setMaxPositionsValue] = useState("1");
  const [openPicker, setOpenPicker] = useState(null);

  const logs = useMemo(
    () =>
      [...new Set([...(runtime?.logs?.search || []), ...searchLogs])].filter(
        (line) =>
          !/Search defaults saved|scheduling task|task scheduled to start|Strategy started in .* mode/i.test(line),
      ),
    [runtime, searchLogs],
  );

  function applySavedSearchConfig(searchConfig) {
    if (!searchConfig || typeof searchConfig !== "object") return;
    setTimeframeValue(String(searchConfig.timeframe ?? "M1"));
    setMinPipsValue(String(searchConfig.pips ?? searchConfig.min_pips ?? 10));
    setMaxPipsValue(String(searchConfig.max_pips ?? 100));
    setMaxPositionsValue(String(searchConfig.max_positions ?? 1));
    setTpValue(String(searchConfig.tp ?? 400));
    setSlValue(String(searchConfig.sl ?? 200));
    setEnableBuy(Boolean(searchConfig.enable_buy ?? true));
    setEnableSell(Boolean(searchConfig.enable_sell ?? true));
    setLiquidityTrigger(Boolean(searchConfig.enable_liquidity ?? true));
    setPauseSearch(Boolean(searchConfig.stop_on_first_close ?? false));
    setTpPips(Boolean(searchConfig.tp_type ?? true));
    setSlPips(Boolean(searchConfig.sl_type ?? true));
  }

  function updateTimeRange(field, value) {
    const setters = {
      startDate: setStartDate,
      startTime: setStartTime,
      endDate: setEndDate,
      endTime: setEndTime,
      endEnabled: setEndEnabled,
    };
    setters[field](value);
    onTimeRangeChange((current) => ({ ...current, [field]: value }));
  }

  useEffect(() => {
    if (strategyCommand.current === "stopped" && runtime?.strategy?.running) {
      return;
    }
    if (!runtime?.strategy?.running) {
      strategyCommand.current = null;
    }
    setStrategyRunning(Boolean(runtime?.strategy?.running));
    setLeqList(
      Array.isArray(runtime?.liquidity_levels) ? runtime.liquidity_levels : [],
    );

    // Route switching remounts this page; hydrate once from saved backend defaults.
    if (!didHydrateDefaults.current) {
      const saved = runtime?.bootstrap_cache?.settings?.search_config;
      if (saved) {
        applySavedSearchConfig(saved);
      }
      didHydrateDefaults.current = true;
    }
  }, [runtime]);

  useEffect(() => {
    if (!didHydrateDefaults.current) return undefined;
    const timer = setTimeout(() => {
      const normalizedMaxPositions = parseIntegerField(maxPositionsValue, 1, 1, 999);
      const normalizedMinPips = parseIntegerField(minPipsValue, 0, 0, 99999);
      const normalizedMaxPips = parseIntegerField(maxPipsValue, 100, 1, 99999);
      const normalizedTp = tpPips ? parseIntegerField(tpValue, 400, 1, 99999) : parseDecimalField(tpValue, 400, 0.01, 99999, 2);
      const normalizedSl = slPips ? parseIntegerField(slValue, 200, 1, 99999) : parseDecimalField(slValue, 200, 0.01, 99999, 2);
      api.saveSearchConfig({
        timeframe: timeframeValue,
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
      }).catch(() => {});
    }, 600);
    return () => clearTimeout(timer);
  }, [timeframeValue, minPipsValue, maxPipsValue, maxPositionsValue, tpValue, slValue, enableBuy, enableSell, liquidityTrigger, pauseSearch, tpPips, slPips]);

  useEffect(() => {
    const stop = Number(slValue);
    if (!stop || stop <= 0) {
      setCalculatedLot(null);
      return undefined;
    }
    const timer = setTimeout(async () => {
      try {
        const result = await api.calculateLot({
          side: "BUY",
          sl: stop,
          sl_in_pips: slPips,
          sl_price: !slPips,
          symbol: "XAUUSD",
        });
        setCalculatedLot(Number(result?.lot || 0));
      } catch {
        setCalculatedLot(null);
      }
    }, 450);
    return () => clearTimeout(timer);
  }, [slValue, slPips]);

  function combineDateTime(datePart, timePart) {
    const d = new Date(datePart);
    d.setHours(
      timePart.getHours(),
      timePart.getMinutes(),
      timePart.getSeconds(),
      0,
    );
    // Search settings represent the user's local wall-clock time. Avoid
    // converting it to UTC, which made the picker appear shifted on reload.
    const pad = (value) => String(value).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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

      const normalizedMaxPositions = parseIntegerField(
        maxPositionsValue,
        1,
        1,
        999,
      );
      const normalizedMinPips = parseIntegerField(minPipsValue, 0, 0, 99999);
      const normalizedMaxPips = parseIntegerField(maxPipsValue, 100, 1, 99999);
      const normalizedTp = tpPips
        ? parseIntegerField(tpValue, 400, 1, 99999)
        : parseDecimalField(tpValue, 400, 0.01, 99999, 2);
      const normalizedSl = slPips
        ? parseIntegerField(slValue, 200, 1, 99999)
        : parseDecimalField(slValue, 200, 0.01, 99999, 2);

      const searchConfig = {
        timeframe: timeframeValue,
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
      strategyCommand.current = "started";
      setStrategyRunning(true);
      await onRefreshRuntime?.({ silent: true });
      setErrorText("");
    } catch (error) {
      setErrorText(String(error?.message || error));
    }
  }

  async function stopStrategy() {
    try {
      strategyCommand.current = "stopped";
      setStrategyRunning(false);
      await api.stopStrategy();
      await onRefreshRuntime?.({ silent: true });
      setStrategyRunning(false);
      setErrorText("");
    } catch (error) {
      strategyCommand.current = null;
      setStrategyRunning(Boolean(runtime?.strategy?.running));
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
            </div>
            <div className="rounded-2xl bg-blue-50 p-2 text-blue-700">
              <Zap className="h-5 w-5" />
            </div>
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-4">
            <SelectBox
              label="Time Frame"
              value={timeframeValue}
              options={timeframeOptions}
              onChange={(e) => setTimeframeValue(e.target.value)}
            />
            <Field
              label="Min Pips"
              value={minPipsValue}
              type="number"
              min="0"
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
              onChange={(e) =>
                setTpValue(
                  tpPips ? e.target.value : decimalInput(e.target.value),
                )
              }
            />
            <InlineSwitcher
              label="SL in Pips"
              checked={slPips}
              onChange={setSlPips}
            />
            <div>
              <Field
                label="SL "
                labelExtra={
                  <span className="normal-case tracking-normal text-[11px] font-semibold text-slate-500">
                    lot:{" "}
                    <span className="font-black text-slate-900">
                      {calculatedLot ? calculatedLot.toFixed(2) : "-"}
                    </span>
                  </span>
                }
                value={slValue}
                type="number"
                min={slPips ? "1" : "0.01"}
                step={slPips ? "1" : "0.01"}
                inputMode={slPips ? "numeric" : "decimal"}
                onChange={(e) =>
                  setSlValue(
                    slPips ? e.target.value : decimalInput(e.target.value),
                  )
                }
              />
            </div>
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
                  onChange={(value) => updateTimeRange("startDate", value)}
                  openPicker={openPicker}
                  setPickerOpenState={setPickerOpenState}
                />
                <DateTimeField
                  fieldKey="start-time"
                  label="Time"
                  picker="time"
                  value={startTime}
                  onChange={(value) => updateTimeRange("startTime", value)}
                  openPicker={openPicker}
                  setPickerOpenState={setPickerOpenState}
                />
              </div>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-2.5">
              <div className="flex items-center justify-between">
                <h4 className="font-black text-slate-950">End Time</h4>
                <button
                  type="button"
                  onClick={() => updateTimeRange("endEnabled", !endEnabled)}
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
                  onChange={(value) => updateTimeRange("endDate", value)}
                  openPicker={openPicker}
                  setPickerOpenState={setPickerOpenState}
                />
                <DateTimeField
                  fieldKey="end-time"
                  label="Time"
                  picker="time"
                  value={endTime}
                  onChange={(value) => updateTimeRange("endTime", value)}
                  openPicker={openPicker}
                  setPickerOpenState={setPickerOpenState}
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
            <div className="mt-5 max-h-[320px] space-y-3 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
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
        </div>
      </div>

      <Dialog
        open={showDefaultsDialog}
        title="Search Default Settings"
        onClose={() => setShowDefaultsDialog(false)}
      >
        <div className="grid gap-4 md:grid-cols-3">
          <Field
            label="Min Pips"
            value={minPipsValue}
            type="number"
            min="0"
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
            onChange={(e) =>
              setTpValue(tpPips ? e.target.value : decimalInput(e.target.value))
            }
          />
          <Field
            label="SL"
            value={slValue}
            type="number"
            min={slPips ? "1" : "0.01"}
            step={slPips ? "1" : "0.01"}
            inputMode={slPips ? "numeric" : "decimal"}
            onChange={(e) =>
              setSlValue(slPips ? e.target.value : decimalInput(e.target.value))
            }
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
