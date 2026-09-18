import React, { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Hourglass, Zap } from "lucide-react";
import { cx } from "../../utils/format";

export const ORDER_KIND_OPTIONS = [
  { value: "MARKET", label: "MARKET", Icon: Zap },
  { value: "LIMIT", label: "LIMIT", Icon: Hourglass },
];

export function IconSelect({ label, value, options, onChange, disabled = false }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const selected = options.find((option) => option.value === value) ?? options[0];
  const SelectedIcon = selected.Icon;

  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(event) {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    }
    function onKeyDown(event) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="relative" ref={rootRef}>
      <span className="block text-xs font-black uppercase tracking-wide text-slate-500">
        {label}
      </span>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((previous) => !previous)}
        className="mt-1.5 flex h-[46px] w-full items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 text-sm font-semibold text-slate-900 outline-none transition hover:bg-white focus:border-blue-500 focus:ring-4 focus:ring-blue-100 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <SelectedIcon className="h-4 w-4 shrink-0 text-blue-600" />
        <span className="min-w-0 flex-1 truncate text-left">
          {selected.label}
        </span>
        <ChevronDown
          className={cx(
            "h-4 w-4 shrink-0 text-slate-400 transition",
            open && "rotate-180",
          )}
        />
      </button>
      {open ? (
        <ul
          role="listbox"
          className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lg shadow-slate-950/10"
        >
          {options.map((option) => {
            const OptionIcon = option.Icon;
            const isSelected = option.value === selected.value;
            return (
              <li key={option.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  className={cx(
                    "flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-semibold transition",
                    isSelected
                      ? "bg-blue-50 text-blue-700"
                      : "text-slate-700 hover:bg-slate-50",
                  )}
                >
                  <OptionIcon
                    className={cx(
                      "h-4 w-4 shrink-0",
                      isSelected ? "text-blue-600" : "text-slate-400",
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {isSelected ? (
                    <Check className="h-4 w-4 shrink-0 text-blue-600" />
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
