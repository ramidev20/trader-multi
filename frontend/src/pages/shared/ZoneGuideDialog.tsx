import React, { useEffect, useState } from "react";

// Illustrated guide to the two demand/supply zone types the Scalping page can
// look for (see zone_strategy_service.py for the exact rules). The candles are
// schematic: prices run 0-100 and the supply diagrams are the demand ones
// mirrored, so both sides always show the same pattern.

type Candle = { o: number; h: number; l: number; c: number };
type Side = "demand" | "supply";

// Oldest first: c3, c2, c1. c3 is bearish, so its body bottom (the gap
// reference) is its close.
const DEMAND_TYPE_1: Candle[] = [
  { o: 76, h: 80, l: 40, c: 50 },
  { o: 68, h: 71, l: 46, c: 56 }, // c2 low reaches the gap reference
  { o: 55, h: 92, l: 53, c: 88 }, // c1 low stays above it
];
const DEMAND_TYPE_2: Candle[] = [
  { o: 76, h: 80, l: 40, c: 50 },
  { o: 80, h: 92, l: 79, c: 90 }, // c2 can be anywhere
  { o: 80, h: 97, l: 78, c: 95 }, // c1 low stays above c3's whole body
];

const mirror = (candles: Candle[]): Candle[] =>
  candles.map((k) => ({ o: 100 - k.o, c: 100 - k.c, h: 100 - k.l, l: 100 - k.h }));

const UP = "#16a34a";
const DOWN = "#e11d48";

function Diagram({ candles, side, touch }: { candles: Candle[]; side: Side; touch: boolean }) {
  const isDemand = side === "demand";
  const y = (price: number) => 208 - price * 1.95;
  const c3 = candles[0];
  // Gap reference: the body edge of c3 that faces the zone.
  const ref = isDemand ? Math.min(c3.o, c3.c) : Math.max(c3.o, c3.c);
  // Type 2: c1 has to clear the far edge of c3's body instead.
  const clearLine = isDemand ? Math.max(c3.o, c3.c) : Math.min(c3.o, c3.c);
  const zoneTop = isDemand ? ref : c3.h;
  const zoneBottom = isDemand ? c3.l : ref;
  const zoneColor = isDemand ? UP : DOWN;
  const xs = [58, 128, 198];
  const labels = ["c3", "c2", "c1"];
  const fillId = `zone-${side}-${touch ? "t1" : "t2"}`;
  return (
    <svg viewBox="0 0 300 236" className="h-auto w-full" role="img" aria-label={`${side} zone diagram`}>
      <defs>
        <pattern id={fillId} width="6" height="6" patternUnits="userSpaceOnUse">
          <rect width="6" height="6" fill={zoneColor} opacity="0.12" />
        </pattern>
      </defs>
      {/* Chart grid */}
      <g stroke="#94a3b8" strokeOpacity="0.25" strokeWidth="1">
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <line key={`h${i}`} x1={12} x2={288} y1={24 + i * 26} y2={24 + i * 26} />
        ))}
        {[12, 58, 128, 198, 288].map((x) => (
          <line key={`v${x}`} x1={x} x2={x} y1={24} y2={206} />
        ))}
      </g>
      <rect
        x={xs[0] - 17}
        y={y(zoneTop)}
        width={280 - (xs[0] - 17)}
        height={y(zoneBottom) - y(zoneTop)}
        fill={`url(#${fillId})`}
        stroke={zoneColor}
        strokeWidth="1"
      />
      <line
        x1={20}
        x2={282}
        y1={y(ref)}
        y2={y(ref)}
        stroke="#64748b"
        strokeWidth="1"
        strokeDasharray="4 3"
      />
      <text x={282} y={y(ref) + (isDemand ? -4 : 11)} textAnchor="end" fontSize="9" className="fill-slate-500">
        gap reference
      </text>
      {!touch ? (
        <g>
          <line x1={20} x2={282} y1={y(clearLine)} y2={y(clearLine)} stroke="#2563eb" strokeWidth="1" strokeDasharray="2 3" />
          <text x={282} y={y(clearLine) + (isDemand ? -4 : 11)} textAnchor="end" fontSize="9" className="fill-blue-600">
            c3 body edge
          </text>
        </g>
      ) : null}
      {candles.map((k, i) => {
        const bullish = k.c > k.o;
        const color = bullish ? UP : DOWN;
        const top = y(Math.max(k.o, k.c));
        const bottom = y(Math.min(k.o, k.c));
        return (
          <g key={labels[i]}>
            <line x1={xs[i]} x2={xs[i]} y1={y(k.h)} y2={y(k.l)} stroke={color} strokeWidth="2" />
            <rect x={xs[i] - 13} y={top} width={26} height={Math.max(2, bottom - top)} fill={color} />
            <text x={xs[i]} y={228} textAnchor="middle" fontSize="11" fontWeight="700" className="fill-slate-600">
              {labels[i]}
            </text>
          </g>
        );
      })}
      {/* The wick edge that has to reach / stay clear of the reference. */}
      {touch ? (
        <g>
          <circle cx={xs[1]} cy={y(isDemand ? candles[1].l : candles[1].h)} r="4" fill="none" stroke="#f59e0b" strokeWidth="2" />
          <text x={xs[1] + 10} y={y(isDemand ? candles[1].l : candles[1].h) + 3} fontSize="9" className="fill-amber-600">
            c2 touches
          </text>
        </g>
      ) : null}
      <g>
        <circle cx={xs[2]} cy={y(isDemand ? candles[2].l : candles[2].h)} r="4" fill="none" stroke="#2563eb" strokeWidth="2" />
      </g>
    </svg>
  );
}

function TypeBlock({
  subtitle,
  demand,
  supply,
  touch,
}: {
  subtitle: string;
  demand: Candle[];
  supply: Candle[];
  touch: boolean;
}) {
  return (
    <section className="rounded-xl border border-slate-200 p-3">
      <p className="m-0 mb-2 text-xs text-slate-500">{subtitle}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <div className="mb-1 text-xs font-black uppercase tracking-wide text-emerald-700">Demand (buy)</div>
          <Diagram candles={demand} side="demand" touch={touch} />
        </div>
        <div>
          <div className="mb-1 text-xs font-black uppercase tracking-wide text-rose-700">Supply (sell)</div>
          <Diagram candles={supply} side="supply" touch={touch} />
        </div>
      </div>
    </section>
  );
}


// ---------------------------------------------------------------------------
// Stop-loss / breach / order-type diagrams. Every scene is drawn for a BUY
// (demand) in price units 0-100; `side="supply"` mirrors all prices so the
// sell version is the same picture flipped.

const SW = 520;
const SH = 306;
const LINE_END = 352; // guide lines stop here
const LABEL_X = 358; // line names live in this column (never on the lines)
const BRACKET_X = 446; // distance brackets, labels to their right
// Price 0-100 -> pixel row; higher price is higher on screen for demand and
// lower for supply (the mirrored view).
const sy = (price: number, side: Side) => 274 - (side === "demand" ? price : 100 - price) * 2.5;
const mirrorOne = (k: Candle, side: Side): Candle =>
  side === "demand" ? k : { o: 100 - k.o, c: 100 - k.c, h: 100 - k.l, l: 100 - k.h };

function SceneFrame({ label, xs = [], children }: { label: string; xs?: number[]; children: React.ReactNode }) {
  return (
    <svg viewBox={`0 0 ${SW} ${SH}`} className="h-auto w-full" role="img" aria-label={label}>
      <rect x={12} y={24} width={SW - 24} height={250} fill="none" stroke="#94a3b8" strokeOpacity="0.4" />
      <g stroke="#94a3b8" strokeOpacity="0.2" strokeWidth="1">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (
          <line key={`h${i}`} x1={12} x2={SW - 12} y1={24 + i * 25} y2={24 + i * 25} />
        ))}
        {xs.map((x) => (
          <line key={`v${x}`} x1={x} x2={x} y1={24} y2={274} />
        ))}
      </g>
      {children}
    </svg>
  );
}

function SceneCandles({
  candles,
  xs,
  labels,
  side,
  faded = [],
}: {
  candles: Candle[];
  xs: number[];
  labels: string[];
  side: Side;
  faded?: number[];
}) {
  return (
    <g>
      {candles.map((raw, i) => {
        const k = mirrorOne(raw, side);
        const color = k.c > k.o ? UP : DOWN;
        const a = sy(raw.o, side);
        const b = sy(raw.c, side);
        return (
          <g key={i} opacity={faded.includes(i) ? 0.35 : 1}>
            <line x1={xs[i]} x2={xs[i]} y1={sy(raw.h, side)} y2={sy(raw.l, side)} stroke={color} strokeWidth="2.5" />
            <rect x={xs[i] - 16} y={Math.min(a, b)} width={32} height={Math.max(3, Math.abs(a - b))} fill={color} rx="1" />
            <text x={xs[i]} y={296} textAnchor="middle" fontSize="13" fontWeight="700" className="fill-slate-600">
              {labels[i]}
            </text>
          </g>
        );
      })}
    </g>
  );
}

// A guide line with no text of its own: its name goes in the label column.
function HLine({
  price,
  side,
  color,
  dash = "5 4",
  x1 = 12,
  x2 = LINE_END,
}: {
  price: number;
  side: Side;
  color: string;
  dash?: string;
  x1?: number;
  x2?: number;
}) {
  const y = sy(price, side);
  return <line x1={x1} x2={x2} y1={y} y2={y} stroke={color} strokeWidth="1.6" strokeDasharray={dash} />;
}

type LineLabel = { price: number; text: string; color: string };

// Names for the guide lines, stacked in one column. Labels that would land on
// top of each other are pushed apart, with a short leader back to their line.
function LineLabels({ items, side }: { items: LineLabel[]; side: Side }) {
  const GAP = 15;
  const placed = items
    .map((item) => ({ ...item, lineY: sy(item.price, side), y: sy(item.price, side) }))
    .sort((a, b) => a.lineY - b.lineY);
  for (let i = 1; i < placed.length; i += 1) {
    if (placed[i].y - placed[i - 1].y < GAP) placed[i].y = placed[i - 1].y + GAP;
  }
  return (
    <g>
      {placed.map((item) => (
        <g key={item.text}>
          {Math.abs(item.y - item.lineY) > 1 ? (
            <line x1={LINE_END} x2={LABEL_X - 2} y1={item.lineY} y2={item.y} stroke={item.color} strokeWidth="1" />
          ) : null}
          <text x={LABEL_X} y={item.y + 4} fontSize="12" fontWeight="700" fill={item.color}>
            {item.text}
          </text>
        </g>
      ))}
    </g>
  );
}

function VBracket({
  x = BRACKET_X,
  p1,
  p2,
  side,
  color,
  label,
}: {
  x?: number;
  p1: number;
  p2: number;
  side: Side;
  color: string;
  label: string;
}) {
  const y1 = sy(p1, side);
  const y2 = sy(p2, side);
  return (
    <g stroke={color} strokeWidth="2" fill="none">
      <line x1={x} x2={x} y1={y1} y2={y2} />
      <line x1={x - 5} x2={x + 5} y1={y1} y2={y1} />
      <line x1={x - 5} x2={x + 5} y1={y2} y2={y2} />
      <text x={x + 9} y={(y1 + y2) / 2 + 4} fontSize="12" fontWeight="800" fill={color} stroke="none">
        {label}
      </text>
    </g>
  );
}

function Mark({ x, y, ok, text, dy = 20 }: { x: number; y: number; ok: boolean; text: string; dy?: number }) {
  const color = ok ? "#16a34a" : "#e11d48";
  return (
    <g>
      <circle cx={x} cy={y} r="5.5" fill="none" stroke={color} strokeWidth="2.5" />
      <text x={x} y={y + dy} textAnchor="middle" fontSize="12" fontWeight="800" fill={color}>
        {text}
      </text>
    </g>
  );
}

// Numbered badge: the order in which the SL walk looks at candles.
function Step({ x, y, n }: { x: number; y: number; n: number }) {
  return (
    <g>
      <circle cx={x} cy={y} r="9" fill="#334155" />
      <text x={x} y={y + 4} textAnchor="middle" fontSize="11" fontWeight="800" fill="#ffffff">
        {n}
      </text>
    </g>
  );
}

const SL_XS = [52, 116, 180, 244, 308];
const SL_LABELS = ["old", "old", "c3", "c2", "c1"];

// Oldest first: A, B, c3, c2, c1. Prices are demand-side; supply is the mirror.
// Case 1: c2's low is below c3's low -> the reference is c2's low.
const SL_C2_CANDLES: Candle[] = [
  { o: 56, h: 60, l: 30, c: 36 }, // A   low 30
  { o: 50, h: 56, l: 32, c: 44 }, // B   low 32
  { o: 66, h: 70, l: 46, c: 52 }, // c3  low 46
  { o: 56, h: 60, l: 42, c: 58 }, // c2  low 42  (below c3's low)
  { o: 62, h: 94, l: 58, c: 90 }, // c1
];
// Case 2: c2's low is NOT below c3's low -> the reference is c3's low.
const SL_C3_CANDLES: Candle[] = [
  { o: 60, h: 66, l: 34, c: 40 }, // A   low 34
  { o: 54, h: 60, l: 40, c: 46 }, // B   low 40
  { o: 66, h: 70, l: 46, c: 52 }, // c3  low 46
  { o: 56, h: 66, l: 50, c: 62 }, // c2  low 50  (not below c3's low)
  { o: 62, h: 94, l: 58, c: 90 }, // c1
];
// Min SL example: c2 low 42 is the reference; B (48 from entry) is too near, A (54) is used.
const SL_MINSL_CANDLES: Candle[] = [
  { o: 60, h: 66, l: 34, c: 40 }, // A   low 34
  { o: 54, h: 60, l: 40, c: 46 }, // B   low 40
  { o: 66, h: 70, l: 46, c: 52 }, // c3  low 46
  { o: 56, h: 62, l: 42, c: 58 }, // c2  low 42
  { o: 62, h: 94, l: 58, c: 90 }, // c1
];
const ENTRY = 88;
const VIOLET = "#7c3aed";
const SLATE = "#64748b";

type SlKind = "liquidityC2" | "liquidityC3" | "minsl";

function SlScene({ side, kind }: { side: Side; kind: SlKind }) {
  const isDemand = side === "demand";
  const extreme = isDemand ? "low" : "high";
  // Marker text sits on the wick tip's far side so it never covers the candle.
  const dy = isDemand ? 21 : -12;
  // Walk-order badges sit on the candle's opposite side from the markers.
  const badgeY = (candle: Candle) => sy(candle.h, side) + (isDemand ? -15 : 15);
  if (kind === "liquidityC2") {
    // Min Liquidity SL = 8. Reference = c2 low (42). c3 (46) is not below it; B (32) is 10 beyond -> used.
    return (
      <SceneFrame label={`${side} min liquidity SL from c2`} xs={SL_XS}>
        <HLine price={ENTRY} side={side} color="#94a3b8" dash="2 4" />
        <HLine price={46} side={side} color={VIOLET} dash="2 3" />
        <HLine price={42} side={side} color={SLATE} dash="0" />
        <HLine price={32} side={side} color="#e11d48" dash="0" />
        <SceneCandles candles={SL_C2_CANDLES} xs={SL_XS} labels={SL_LABELS} side={side} faded={[0]} />
        <Step x={SL_XS[2]} y={badgeY(SL_C2_CANDLES[2])} n={1} />
        <Step x={SL_XS[1]} y={badgeY(SL_C2_CANDLES[1])} n={2} />
        <Mark x={SL_XS[2]} y={sy(46, side)} ok={false} text="not beyond c2" dy={dy} />
        <Mark x={SL_XS[1]} y={sy(32, side)} ok text="SL here" dy={dy} />
        <LineLabels
          side={side}
          items={[
            { price: ENTRY, text: "entry", color: "#94a3b8" },
            { price: 46, text: `c3 ${extreme}`, color: VIOLET },
            { price: 42, text: `c2 ${extreme} (start)`, color: SLATE },
            { price: 32, text: "SL", color: "#e11d48" },
          ]}
        />
        <VBracket p1={42} p2={32} side={side} color="#2563eb" label="Min Liq." />
      </SceneFrame>
    );
  }
  if (kind === "liquidityC3") {
    // Reference = c3 low (46). c2 is ignored; B (40) is only 6 beyond -> skipped, A (34) is 12 -> used.
    return (
      <SceneFrame label={`${side} min liquidity SL from c3`} xs={SL_XS}>
        <HLine price={ENTRY} side={side} color="#94a3b8" dash="2 4" />
        <HLine price={50} side={side} color="#cbd5e1" dash="2 3" />
        <HLine price={46} side={side} color={VIOLET} dash="0" />
        <HLine price={34} side={side} color="#e11d48" dash="0" />
        <SceneCandles candles={SL_C3_CANDLES} xs={SL_XS} labels={SL_LABELS} side={side} />
        <Step x={SL_XS[1]} y={badgeY(SL_C3_CANDLES[1])} n={1} />
        <Step x={SL_XS[0]} y={badgeY(SL_C3_CANDLES[0])} n={2} />
        <Mark x={SL_XS[1]} y={sy(40, side)} ok={false} text="too close" dy={dy} />
        <Mark x={SL_XS[0]} y={sy(34, side)} ok text="SL here" dy={dy} />
        <LineLabels
          side={side}
          items={[
            { price: ENTRY, text: "entry", color: "#94a3b8" },
            { price: 50, text: `c2 ${extreme} (ignored)`, color: "#94a3b8" },
            { price: 46, text: `c3 ${extreme} (start)`, color: VIOLET },
            { price: 34, text: "SL", color: "#e11d48" },
          ]}
        />
        <VBracket p1={46} p2={34} side={side} color="#2563eb" label="Min Liq." />
      </SceneFrame>
    );
  }
  // Min SL = 50 from entry: B (48 away) is too near -> A (54 away) is used.
  return (
    <SceneFrame label={`${side} min SL diagram`} xs={SL_XS}>
      <rect
        x={12}
        y={Math.min(sy(ENTRY, side), sy(38, side))}
        width={LINE_END - 12}
        height={Math.abs(sy(ENTRY, side) - sy(38, side))}
        fill="#e11d48"
        opacity="0.07"
      />
      <HLine price={ENTRY} side={side} color="#94a3b8" dash="2 4" />
      <HLine price={38} side={side} color="#2563eb" />
      <HLine price={34} side={side} color="#e11d48" dash="0" />
      <SceneCandles candles={SL_MINSL_CANDLES} xs={SL_XS} labels={SL_LABELS} side={side} />
      <Step x={SL_XS[1]} y={badgeY(SL_MINSL_CANDLES[1])} n={1} />
      <Step x={SL_XS[0]} y={badgeY(SL_MINSL_CANDLES[0])} n={2} />
      <Mark x={SL_XS[1]} y={sy(40, side)} ok={false} text="too near" dy={dy} />
      <Mark x={SL_XS[0]} y={sy(34, side)} ok text="SL here" dy={dy} />
      <LineLabels
        side={side}
        items={[
          { price: ENTRY, text: "entry", color: "#94a3b8" },
          { price: 38, text: "Min SL line", color: "#2563eb" },
          { price: 34, text: "SL", color: "#e11d48" },
        ]}
      />
      <VBracket p1={ENTRY} p2={38} side={side} color="#2563eb" label="Min SL" />
    </SceneFrame>
  );
}

// Demand zone 40-50 (c3 low up to its body bottom); price later trades below its low.
const BREACH_CANDLES: Candle[] = [
  { o: 76, h: 80, l: 40, c: 50 }, // c3
  { o: 68, h: 72, l: 46, c: 56 }, // c2
  { o: 55, h: 94, l: 53, c: 90 }, // c1
  { o: 90, h: 98, l: 74, c: 80 },
  { o: 80, h: 84, l: 60, c: 62 },
  { o: 62, h: 66, l: 32, c: 36 }, // breach: low 32 < zone low 40
];
const BREACH_XS = [48, 102, 156, 210, 264, 318];

function BreachScene({ side }: { side: Side }) {
  const isDemand = side === "demand";
  const left = BREACH_XS[0] - 24;
  const right = BREACH_XS[5] + 24;
  const top = Math.min(sy(50, side), sy(40, side));
  const height = Math.abs(sy(50, side) - sy(40, side));
  return (
    <SceneFrame label={`${side} 5-minute breach diagram`} xs={BREACH_XS}>
      <rect
        x={left}
        y={top}
        width={right - left}
        height={height}
        fill="#94a3b8"
        opacity="0.3"
        stroke="#64748b"
        strokeWidth="1.5"
        strokeDasharray="5 4"
      />
      <HLine price={isDemand ? 40 : 50} side={side} color="#e11d48" dash="2 4" x1={left} x2={LINE_END} />
      <SceneCandles candles={BREACH_CANDLES} xs={BREACH_XS} labels={["c3", "c2", "c1", "", "", "breach"]} side={side} />
      <Mark x={BREACH_XS[5]} y={sy(32, side)} ok={false} text={isDemand ? "below zone low" : "above zone high"} dy={isDemand ? 20 : -12} />
      <LineLabels
        side={side}
        items={[
          { price: isDemand ? 40 : 50, text: isDemand ? "zone low" : "zone high", color: "#e11d48" },
          { price: isDemand ? 50 : 40, text: "zone (grey)", color: SLATE },
        ]}
      />
      <text x={LABEL_X} y={isDemand ? 44 : 268} fontSize="12" fontWeight="700" fill="#2563eb">
        then: new
      </text>
      <text x={LABEL_X} y={isDemand ? 59 : 283} fontSize="12" fontWeight="700" fill="#2563eb">
        5-min search
      </text>
    </SceneFrame>
  );
}

// Demand only. A MARKET order enters at the current price; a LIMIT order (SL
// wider than Max SL) waits Limit % of the SL distance closer to the SL, so the
// SL stays on the same candle but its size shrinks.
function OrderScene({ mode }: { mode: "market" | "limit" }) {
  const side: Side = "demand";
  const isLimit = mode === "limit";
  const market = 88;
  const sl = isLimit ? 36 : 66;
  const limit = market - (market - sl) * 0.4;
  const maxSl = market - 30;
  const entry = isLimit ? limit : market;
  const context: Candle[] = [
    { o: 62, h: 68, l: 58, c: 66 },
    { o: 66, h: 76, l: 64, c: 74 },
    { o: 74, h: 84, l: 72, c: 82 },
    { o: 82, h: 91, l: 79, c: 88 },
  ];
  const xs = [48, 92, 136, 180];
  const boxX = 212;
  return (
    <SceneFrame label={`${mode} order diagram`}>
      <text x={20} y={17} fontSize="14" fontWeight="800" fill={isLimit ? "#2563eb" : "#16a34a"}>
        {isLimit ? "LIMIT order: SL wider than Max SL" : "MARKET order: SL within Max SL"}
      </text>
      {/* risk box: entry down to the SL */}
      <rect
        x={boxX}
        y={sy(entry, side)}
        width={LINE_END - boxX}
        height={sy(sl, side) - sy(entry, side)}
        fill="#e11d48"
        opacity="0.1"
      />
      {isLimit ? (
        <rect
          x={boxX}
          y={sy(market, side)}
          width={LINE_END - boxX}
          height={sy(sl, side) - sy(market, side)}
          fill="none"
          stroke="#e11d48"
          strokeOpacity="0.5"
          strokeDasharray="4 3"
        />
      ) : null}
      <HLine price={market} side={side} color="#94a3b8" dash="2 4" />
      <HLine price={maxSl} side={side} color="#f59e0b" />
      <HLine price={sl} side={side} color="#e11d48" dash="0" />
      {isLimit ? <HLine price={limit} side={side} color="#2563eb" dash="0" x1={boxX - 14} /> : null}
      <SceneCandles candles={context} xs={xs} labels={["", "", "", ""]} side={side} />
      <text x={xs[3]} y={sy(79, side) + 18} textAnchor="middle" fontSize="12" fontWeight="700" className="fill-slate-600">
        now
      </text>
      {isLimit ? (
        <g stroke="#2563eb" strokeWidth="2" fill="#2563eb">
          <line x1={boxX + 24} x2={boxX + 24} y1={sy(market, side) + 3} y2={sy(limit, side) - 8} />
          <path d={`M ${boxX + 18} ${sy(limit, side) - 9} L ${boxX + 30} ${sy(limit, side) - 9} L ${boxX + 24} ${sy(limit, side)} Z`} stroke="none" />
        </g>
      ) : (
        <g fill="#16a34a" stroke="none">
          <circle cx={boxX} cy={sy(market, side)} r="5" />
        </g>
      )}
      <LineLabels
        side={side}
        items={[
          { price: market, text: "market price", color: "#94a3b8" },
          ...(isLimit ? [{ price: limit, text: "limit entry", color: "#2563eb" }] : []),
          { price: maxSl, text: "Max SL", color: "#d97706" },
          { price: sl, text: "SL", color: "#e11d48" },
        ]}
      />
      {isLimit ? (
        <>
          <VBracket p1={market} p2={limit} side={side} color="#2563eb" label="Limit %" />
          <VBracket p1={limit} p2={sl} side={side} color="#e11d48" label="new SL" />
        </>
      ) : (
        <VBracket p1={market} p2={sl} side={side} color="#16a34a" label="SL size" />
      )}
    </SceneFrame>
  );
}

function SidePair({ children }: { children: (side: Side) => React.ReactNode }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div>
        <div className="mb-1 text-xs font-black uppercase tracking-wide text-emerald-700">Demand (buy)</div>
        {children("demand")}
      </div>
      <div>
        <div className="mb-1 text-xs font-black uppercase tracking-wide text-rose-700">Supply (sell)</div>
        {children("supply")}
      </div>
    </div>
  );
}

function Panel({ subtitle, children }: { subtitle: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 p-3">
      <p className="m-0 mb-2 text-xs text-slate-500">{subtitle}</p>
      {children}
    </section>
  );
}

type TabKey = "type1" | "type2" | "liquidity" | "breach" | "order" | "minsl";
const TABS: { key: TabKey; label: string }[] = [
  { key: "type1", label: "Zone Type 1" },
  { key: "type2", label: "Zone Type 2" },
  { key: "liquidity", label: "Min Liquidity SL" },
  { key: "minsl", label: "Min SL" },
  { key: "breach", label: "5-min Zone Breach" },
  { key: "order", label: "Market / Limit Order" },
];

export function ZoneGuideDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<TabKey>("type1");
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/40 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="app-dialog mx-auto my-8 w-full max-w-5xl rounded-xl border border-slate-200 bg-white p-5 shadow-2xl shadow-slate-950/20"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Scalping guide"
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="m-0 text-lg font-black text-slate-950">Scalping guide</h3>
          <button
            type="button"
            onClick={onClose}
            className="app-dialog-close rounded-lg border border-slate-200 bg-white px-3 py-1 text-sm font-semibold text-slate-600 transition hover:bg-slate-50"
          >
            Close
          </button>
        </div>
        <div role="tablist" className="mb-3 flex flex-wrap gap-1 rounded-lg border border-slate-200 bg-slate-50 p-1">
          {TABS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={`rounded-md px-3 py-1.5 text-sm font-black transition ${
                tab === key ? "bg-blue-600 text-white shadow-sm" : "text-slate-600 hover:text-slate-900"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === "type1" ? (
          <TypeBlock
            subtitle="c2 retests c3's body edge, then c1 holds beyond it."
            demand={DEMAND_TYPE_1}
            supply={mirror(DEMAND_TYPE_1)}
            touch
          />
        ) : null}
        {tab === "type2" ? (
          <TypeBlock
            subtitle="No retest: c1 stays fully clear of c3's body."
            demand={DEMAND_TYPE_2}
            supply={mirror(DEMAND_TYPE_2)}
            touch={false}
          />
        ) : null}
        {tab === "liquidity" ? (
          <Panel subtitle="The walk starts at c2's low only when it is below c3's low; otherwise it starts at c3's low. The SL goes on the first candle back whose low is at least Min Liquidity SL below that start. Demand shown; supply is the mirror image.">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <div className="mb-1 text-xs font-black text-slate-700">c2 low below c3 low: start from c2</div>
                <SlScene side="demand" kind="liquidityC2" />
              </div>
              <div>
                <div className="mb-1 text-xs font-black text-slate-700">c2 low not below c3 low: start from c3</div>
                <SlScene side="demand" kind="liquidityC3" />
              </div>
            </div>
          </Panel>
        ) : null}
        {tab === "minsl" ? (
          <Panel subtitle="The SL is never closer than Min SL to the entry. Nearer lows/highs are skipped and the walk goes deeper; if none qualifies the SL is entry ∓ Min SL.">
            <SidePair>{(side) => <SlScene side={side} kind="minsl" />}</SidePair>
          </Panel>
        ) : null}
        {tab === "breach" ? (
          <Panel subtitle="Price trades below the 5-minute zone's low (demand) / above its high (supply): the zone is disabled and a new 5-minute search starts.">
            <SidePair>{(side) => <BreachScene side={side} />}</SidePair>
          </Panel>
        ) : null}
        {tab === "order" ? (
          <Panel subtitle="SL within Max SL: MARKET at the current price. Wider: LIMIT, entry moved Limit % of the SL distance toward the SL (40% shown). Demand shown; supply is the mirror image.">
            <div className="grid gap-3 sm:grid-cols-2">
              <OrderScene mode="market" />
              <OrderScene mode="limit" />
            </div>
          </Panel>
        ) : null}
      </div>
    </div>
  );
}
