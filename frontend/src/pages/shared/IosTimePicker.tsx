import React, { useEffect, useRef, useState } from "react";

// iOS-style drum-wheel time picker, adapted from react-ios-time-picker by
// MEddarhri (MIT License, https://github.com/MEddarhri/react-ios-time-picker).
// Its drag/flick physics are kept; the rest is reworked for this app:
// - none of the package's global CSS (`* { font-family: Roboto }`, `button`
//   and `input` resets) that restyled the whole app on import;
// - one generic Wheel instead of three copied hour/minute/AM-PM components;
// - selection follows the wheel's position directly. The package only read
//   it on `transitionend`, so a mouse-wheel scroll before any click never
//   changed the value;
// - the list re-centres after each move, so hours and minutes wrap around
//   endlessly instead of stopping at the end of a 3x repeated list;
// - styled with the app's Tailwind classes, which index.css already remaps
//   for the dark theme.

const CELL_HEIGHT = 36;
const VISIBLE_ROWS = 5;
// Rows above the selected one; the selection band sits on this row.
const CENTER_ROW = 2;
// A release within this many ms of the press counts as a flick (momentum).
const FLICK_MS = 100;
const TRANSITIONS = {
  fast: "transform 700ms cubic-bezier(0.13, 0.67, 0.01, 0.94)",
  slow: "transform 600ms cubic-bezier(0.13, 0.67, 0.01, 0.94)",
  step: "transform 180ms ease-out",
};

const toTranslate = (position) => (CENTER_ROW - position) * CELL_HEIGHT;
const toPosition = (translate) => Math.round(CENTER_ROW - translate / CELL_HEIGHT);

function Wheel({ labels, selectedIndex, onSelect, repeat = 3, ariaLabel }) {
  const count = labels.length;
  // Repeated so there is always room to scroll both ways; the middle copy
  // is "home", and the list jumps back to it after every move.
  const total = count * repeat;
  const home = count * Math.floor(repeat / 2);
  const minTranslate = toTranslate(total - 1);
  const maxTranslate = toTranslate(0);
  const clamp = (value) => Math.min(maxTranslate, Math.max(minTranslate, value));
  const snap = (value) => clamp(Math.round(value / CELL_HEIGHT) * CELL_HEIGHT);

  const [translate, setTranslate] = useState(() => toTranslate(home + selectedIndex));
  const [dragDelta, setDragDelta] = useState(0);
  const [animation, setAnimation] = useState(null);
  const drag = useRef(null);

  const settledPosition = toPosition(translate);
  const livePosition = toPosition(translate + dragDelta);
  const indexOf = (position) => ((position % count) + count) % count;

  useEffect(() => {
    onSelect(indexOf(settledPosition));
    // onSelect is a state setter from the parent; only the position matters.
  }, [settledPosition]);

  function moveTo(nextTranslate, speed) {
    setAnimation(speed);
    setTranslate(snap(nextTranslate));
  }

  function recenter() {
    if (repeat < 2) return;
    if (settledPosition >= home && settledPosition < home + count) return;
    setAnimation(null);
    setTranslate(toTranslate(home + indexOf(settledPosition)));
  }

  function handlePointerDown(event) {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startY: event.clientY, startTime: performance.now(), moved: false };
    setAnimation(null);
    setDragDelta(0);
  }

  function handlePointerMove(event) {
    if (!drag.current) return;
    const delta = event.clientY - drag.current.startY;
    if (Math.abs(delta) > 3) drag.current.moved = true;
    setDragDelta(delta);
  }

  function handlePointerUp(event) {
    const started = drag.current;
    drag.current = null;
    if (!started) return;
    const delta = event.clientY - started.startY;
    setDragDelta(0);
    if (!started.moved) {
      // A tap: select the row under the pointer. Pointer capture makes the
      // wheel itself the event target, so work the row out from the Y.
      const top = event.currentTarget.getBoundingClientRect().top;
      const row = Math.floor((event.clientY - top) / CELL_HEIGHT);
      moveTo(toTranslate(settledPosition + row - CENTER_ROW), "slow");
      return;
    }
    const duration = performance.now() - started.startTime;
    if (duration <= FLICK_MS) {
      const momentum = Math.sign(delta) * (120 / Math.max(duration, 1)) * 100;
      moveTo(translate + delta + momentum, "fast");
    } else {
      moveTo(translate + delta, "slow");
    }
  }

  function handlePointerCancel() {
    drag.current = null;
    setDragDelta(0);
  }

  function handleWheel(event) {
    // Scrolling down moves to the next value, like the old wheel dialog.
    const step = event.deltaY > 0 ? -CELL_HEIGHT : CELL_HEIGHT;
    setAnimation("step");
    setTranslate((current) => snap(current + step));
  }

  function handleKeyDown(event) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    moveTo(translate + (event.key === "ArrowDown" ? -CELL_HEIGHT : CELL_HEIGHT), "step");
  }

  return (
    <div
      role="listbox"
      tabIndex={0}
      aria-label={ariaLabel}
      className="relative w-16 cursor-grab touch-none select-none overflow-hidden rounded-md outline-none focus-visible:ring-2 focus-visible:ring-blue-300 active:cursor-grabbing"
      style={{
        height: CELL_HEIGHT * VISIBLE_ROWS,
        // Fade the rows away from the selection, like the iOS drum.
        maskImage: "linear-gradient(to bottom, transparent, black 30%, black 70%, transparent)",
        WebkitMaskImage: "linear-gradient(to bottom, transparent, black 30%, black 70%, transparent)",
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onWheel={handleWheel}
      onKeyDown={handleKeyDown}
    >
      <div
        onTransitionEnd={(event) => {
          if (event.propertyName === "transform") recenter();
        }}
        style={{
          transform: `translateY(${translate + dragDelta}px)`,
          transition: animation ? TRANSITIONS[animation] : "none",
        }}
      >
        {Array.from({ length: total }, (_, position) => {
          const selected = position === livePosition;
          return (
            <div
              key={position}
              role="option"
              aria-selected={selected}
              className={`flex items-center justify-center transition-[font-size,color] duration-100 ${
                selected ? "text-xl font-semibold text-slate-900" : "text-base text-slate-400"
              }`}
              style={{ height: CELL_HEIGHT }}
            >
              {labels[indexOf(position)]}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const HOUR_LABELS = Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, "0"));
const MINUTE_LABELS = Array.from({ length: 60 }, (_, index) => String(index).padStart(2, "0"));
const PERIOD_LABELS = ["AM", "PM"];

export function IosTimePickerDialog({ value, title = "Select time", onCancel, onConfirm }) {
  const source = new Date(value);
  const [hourIndex, setHourIndex] = useState((source.getHours() % 12 || 12) - 1);
  const [minute, setMinute] = useState(source.getMinutes());
  const [periodIndex, setPeriodIndex] = useState(source.getHours() >= 12 ? 1 : 0);

  function confirm() {
    const next = new Date(value);
    next.setHours(((hourIndex + 1) % 12) + (periodIndex === 1 ? 12 : 0), minute, 0, 0);
    onConfirm(next);
  }

  // Latest handlers for the window key listener below.
  const keyHandlers = useRef({ confirm, onCancel });
  keyHandlers.current = { confirm, onCancel };

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function handleKey(event) {
      if (event.key === "Escape") keyHandlers.current.onCancel();
      if (event.key === "Enter") keyHandlers.current.confirm();
    }
    window.addEventListener("keydown", handleKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKey);
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-[1400] flex items-center justify-center bg-slate-950/35 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="ios-time-picker-pop w-full max-w-[320px] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-3 text-sm font-medium text-slate-500 transition hover:opacity-60"
          >
            Cancel
          </button>
          <span className="text-sm font-bold text-slate-900">
            {title} · {HOUR_LABELS[hourIndex]}:{MINUTE_LABELS[minute]} {PERIOD_LABELS[periodIndex]}
          </span>
          <button
            type="button"
            onClick={confirm}
            className="rounded-md px-3 py-3 text-sm font-bold text-blue-600 transition hover:opacity-60"
          >
            OK
          </button>
        </div>
        <div className="relative flex items-center justify-center gap-1 px-4 py-5">
          {/* Selection band behind the centre row of every wheel. */}
          <div
            className="ios-time-picker-band pointer-events-none absolute inset-x-6 rounded-lg bg-slate-100"
            style={{ top: 20 + CENTER_ROW * CELL_HEIGHT, height: CELL_HEIGHT }}
          />
          <div className="relative flex items-center">
            <Wheel labels={HOUR_LABELS} selectedIndex={hourIndex} onSelect={setHourIndex} ariaLabel="Hour" />
            <span className="px-1 text-xl font-semibold text-slate-900">:</span>
            <Wheel labels={MINUTE_LABELS} selectedIndex={minute} onSelect={setMinute} ariaLabel="Minute" />
            <Wheel labels={PERIOD_LABELS} selectedIndex={periodIndex} onSelect={setPeriodIndex} repeat={1} ariaLabel="AM or PM" />
          </div>
        </div>
      </div>
    </div>
  );
}
