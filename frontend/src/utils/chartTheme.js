// Mirrors TradingView's dark chart theme so the price/equity charts match
// the rest of the app's dark mode instead of staying hardcoded light.
export const CHART_PALETTE = {
  light: {
    background: "#f8fafc",
    text: "#334155",
    grid: "#e2e8f0",
    border: "#cbd5e1",
    upColor: "#059669",
    downColor: "#e11d48",
  },
  dark: {
    background: "#131722",
    text: "#d1d4dc",
    grid: "#1e222d",
    border: "#2a2e39",
    upColor: "#26a69a",
    downColor: "#ef5350",
  },
};

// Candle color schemes offered in Settings > Appearance > Chart. "default"
// follows the theme palette above; "custom" uses the user's own two colors.
export const CANDLE_PRESETS = [
  { id: "default", label: "Theme default" },
  { id: "classic", label: "Classic", light: ["#16a34a", "#dc2626"], dark: ["#22c55e", "#ef4444"] },
  { id: "teal", label: "TradingView", light: ["#089981", "#f23645"], dark: ["#26a69a", "#ef5350"] },
  { id: "blue", label: "Blue / Orange", light: ["#2563eb", "#ea580c"], dark: ["#3b82f6", "#f97316"] },
  { id: "mono", label: "Monochrome", light: ["#94a3b8", "#1e293b"], dark: ["#d1d4dc", "#5d606b"] },
  { id: "custom", label: "Custom" },
];

export const DEFAULT_APPEARANCE = {
  reduce_motion: false,
  chart_candle_preset: "default",
  chart_up_color: "",
  chart_down_color: "",
  chart_grid: true,
  chart_crosshair: "normal",
};

let chartPreferences = { ...DEFAULT_APPEARANCE };
const preferenceListeners = new Set();

export function isDarkTheme() {
  return document.documentElement.dataset.theme === "DARK";
}

export function candleColors(appearance, dark) {
  const base = dark ? CHART_PALETTE.dark : CHART_PALETTE.light;
  const presetId = appearance?.chart_candle_preset || "default";
  if (presetId === "custom") {
    return {
      upColor: appearance.chart_up_color || base.upColor,
      downColor: appearance.chart_down_color || base.downColor,
    };
  }
  const preset = CANDLE_PRESETS.find((item) => item.id === presetId);
  const pair = preset?.[dark ? "dark" : "light"];
  return pair
    ? { upColor: pair[0], downColor: pair[1] }
    : { upColor: base.upColor, downColor: base.downColor };
}

export function getChartPalette() {
  const dark = isDarkTheme();
  return {
    ...(dark ? CHART_PALETTE.dark : CHART_PALETTE.light),
    ...candleColors(chartPreferences, dark),
    gridVisible: chartPreferences.chart_grid !== false,
    // lightweight-charts CrosshairMode: 0 = Normal, 1 = Magnet.
    crosshairMode: chartPreferences.chart_crosshair === "magnet" ? 1 : 0,
  };
}

// Called by App whenever saved appearance settings load or change. Charts
// that are already open repaint through watchThemeChange below.
export function setChartPreferences(appearance) {
  const next = { ...DEFAULT_APPEARANCE, ...(appearance || {}) };
  if (JSON.stringify(next) === JSON.stringify(chartPreferences)) return;
  chartPreferences = next;
  const palette = getChartPalette();
  preferenceListeners.forEach((listener) => listener(palette));
}

// The chart's colors are set once via imperative options, not Tailwind
// classes, so switching the theme (or chart preferences) mid-session needs
// its own listener rather than relying on the CSS overrides in index.css to
// repaint the canvas.
export function watchThemeChange(onChange) {
  const observer = new MutationObserver(() => onChange(getChartPalette()));
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  preferenceListeners.add(onChange);
  return () => {
    observer.disconnect();
    preferenceListeners.delete(onChange);
  };
}
