import React, { useEffect, useState } from "react";
import { CalendarDays, Clock3 } from "lucide-react";
import dayjs from "dayjs";
import { DesktopDatePicker } from "@mui/x-date-pickers/DesktopDatePicker";

// Shared with SearchPage's Start/End Time panel -- extracted here so
// ScalpingPage (and any future page) can reuse the exact same date/time
// picker UI instead of re-implementing the MUI date picker + custom time
// wheel dialog. Callers must wrap usage in
// <LocalizationProvider dateAdapter={AdapterDayjs}>.

export function formatTime12(value) {
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
  const [minute, setMinute] = useState(String(source.getMinutes()).padStart(2, "0"));
  const [period, setPeriod] = useState(source.getHours() >= 12 ? "PM" : "AM");
  const hours = Array.from({ length: 12 }, (_, index) => index + 1);

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
    const parsedMinute = Number.parseInt(minute, 10);
    next.setHours(nextHour, Number.isFinite(parsedMinute) ? Math.min(59, Math.max(0, parsedMinute)) : 0, 0, 0);
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
      <div className="w-full max-w-[430px] overflow-hidden rounded-lg bg-white shadow-2xl">
        <div className="border-b-2 border-blue-600 px-6 py-5 text-3xl font-light text-blue-600">
          {title}
        </div>
        <div className="flex justify-center gap-3 px-6 py-7">
          <WheelColumn values={hours} selected={hour} onChange={setHour} />
          <div className="flex w-20 flex-col items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Minute</span>
            <input
              type="text"
              inputMode="numeric"
              aria-label="Minutes"
              value={minute}
              maxLength={2}
              onChange={(event) => setMinute(event.target.value.replace(/\D/g, "").slice(0, 2))}
              onBlur={() => {
                const parsedMinute = Number.parseInt(minute, 10);
                setMinute(String(Number.isFinite(parsedMinute) ? Math.min(59, Math.max(0, parsedMinute)) : 0).padStart(2, "0"));
              }}
              className="h-16 w-full rounded-md border-y-2 border-blue-400 bg-white text-center text-2xl font-semibold text-slate-950 outline-none focus:ring-4 focus:ring-blue-100"
            />
            <span className="text-[10px] text-slate-400">Type 00–59</span>
          </div>
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

export function DateTimeField({ fieldKey, label, picker, value, onChange, openPicker, setPickerOpenState }) {
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
              className="flex h-[46px] w-full items-center justify-between rounded-lg border border-slate-300 bg-white px-3 text-left text-sm font-semibold leading-none text-slate-900 outline-none transition hover:border-blue-400 focus:border-blue-500 focus:ring-4 focus:ring-blue-100"
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
