// A tiny pub/sub so any page can surface a warning/error/success message in
// the fixed TopBar instead of rendering its own inline banner that pushes
// the rest of the page content down every time one appears. Pages don't need
// a prop path up to TopBar (which they don't have -- TopBar is a sibling
// rendered once in App.tsx) to use this; they just call showBanner/clearBanner
// directly, and TopBar is the sole subscriber that renders whatever is current.
let current = null;
let nextId = 1;
const listeners = new Set();

function notify() {
  listeners.forEach((listener) => listener(current));
}

/** tone: "error" | "warning" | "success" */
export function showBanner(text, tone = "error") {
  if (!text) return;
  current = { id: nextId++, tone, text: String(text) };
  notify();
}

export function clearBanner() {
  if (!current) return;
  current = null;
  notify();
}

export function subscribeBanner(listener) {
  listener(current);
  listeners.add(listener);
  return () => listeners.delete(listener);
}
