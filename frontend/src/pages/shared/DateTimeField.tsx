import React from "react";
import { CalendarDays, Clock3 } from "lucide-react";
import dayjs from "dayjs";
import { DesktopDatePicker } from "@mui/x-date-pickers/DesktopDatePicker";
import { IosTimePickerDialog } from "./IosTimePicker";

// Shared with SearchPage's Start/End Time panel -- extracted here so
// ScalpingPage (and any future page) can reuse the exact same date/time
// picker UI instead of re-implementing the MUI date picker + iOS-style time
// wheel dialog (IosTimePicker.tsx). Callers must wrap usage in
// <LocalizationProvider dateAdapter={AdapterDayjs}>.

export function formatTime12(value) {
  const date = new Date(value);
  const hour = date.getHours() % 12 || 12;
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${hour}:${minute} ${date.getHours() >= 12 ? "PM" : "AM"}`;
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
        <IosTimePickerDialog
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
