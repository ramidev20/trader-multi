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

export function isDarkTheme() {
  return document.documentElement.dataset.theme === "DARK";
}

export function getChartPalette() {
  return isDarkTheme() ? CHART_PALETTE.dark : CHART_PALETTE.light;
}

// The chart's colors are set once via imperative options, not Tailwind
// classes, so switching the theme mid-session needs its own listener rather
// than relying on the CSS overrides in index.css to repaint the canvas.
export function watchThemeChange(onChange) {
  const observer = new MutationObserver(() => onChange(getChartPalette()));
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
}
