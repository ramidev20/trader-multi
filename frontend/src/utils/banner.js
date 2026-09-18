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

// The banner now lives inline next to the breadcrumb (one row, not a block
// below it), so the full message can't be shown there -- just a short code.
// api.js's request() throws "Network error: could not reach <url>. <reason>"
// for a fetch failure and "Request failed (404)"-style text (or the
// backend's own `detail`) for an HTTP error response; this pulls whatever
// compact signal exists out of either shape. The full text is still kept on
// the banner object for a hover tooltip.
function deriveCode(text) {
  if (/^network error/i.test(text) || /failed to fetch/i.test(text)) return "NETWORK";
  if (/timed?\s*out/i.test(text)) return "TIMEOUT";
  const statusMatch = text.match(/\((\d{3})\)/);
  if (statusMatch) return statusMatch[1];
  return null;
}

/**
 * tone: "error" | "warning" | "success"
 * code: an explicit short code (e.g. an HTTP status or "NETWORK", as
 * attached by services/api.js) -- pass it when you have the original Error
 * object (`error.code`) rather than just its already-stringified message,
 * since a code like a 409 status is often not present anywhere in the text
 * itself (the backend's own `detail` message replaces it). Falls back to
 * pattern-matching the text when no explicit code is given.
 */
export function showBanner(text, tone = "error", code = null) {
  if (!text) return;
  const message = String(text);
  current = { id: nextId++, tone, text: message, code: code != null ? String(code) : deriveCode(message) };
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
