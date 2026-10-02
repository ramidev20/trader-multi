// Controller-side remote control. The connections to receivers live in this
// app's Python backend (backend/app/services/remote_controller.py), not in
// the page: WebView2 throttles a minimized window's timers to about once a
// minute, which used to drop healthy connections and delay mirrored orders.
// This module only mirrors the backend's state for the UI and forwards
// actions to it; minimizing or reloading the window no longer affects the
// connections themselves.
import { api } from "./api";
import { showBanner } from "../utils/banner";

// Pre-backend storage: receivers saved in the browser are moved to the
// backend once, then removed from here.
const LEGACY_RECEIVERS_STORAGE_KEY = "trader.remoteControl.receivers";
const LEGACY_LOG_STORAGE_KEY = "trader.remoteControl.logs";
const POLL_INTERVAL_MS = 1000;

const receiverListeners = new Set();
const logListeners = new Set();
let receivers = [];
let logEntries = [];
let receiversKey = "";
let logsKey = "";
let legacyMigrated = false;
let polling = false;

function reportError(error) {
  showBanner(error?.message || String(error), "error", error?.code);
}

function applySnapshot(data) {
  const nextReceivers = Array.isArray(data?.receivers) ? data.receivers : [];
  const nextLogs = Array.isArray(data?.logs) ? data.logs : [];
  // Only notify on change, so the 1s poll doesn't re-render every second.
  const nextReceiversKey = JSON.stringify(nextReceivers);
  if (nextReceiversKey !== receiversKey) {
    receiversKey = nextReceiversKey;
    receivers = nextReceivers;
    receiverListeners.forEach((listener) => listener(listReceivers()));
  }
  const nextLogsKey = nextLogs.length ? `${nextLogs.length}:${nextLogs[nextLogs.length - 1].id}` : "0";
  if (nextLogsKey !== logsKey) {
    logsKey = nextLogsKey;
    logEntries = nextLogs;
    logListeners.forEach((listener) => listener([...logEntries]));
  }
}

async function migrateLegacyReceivers() {
  let saved = [];
  try {
    saved = JSON.parse(globalThis.localStorage?.getItem(LEGACY_RECEIVERS_STORAGE_KEY) || "[]");
  } catch {
    saved = [];
  }
  if (Array.isArray(saved) && saved.length && !receivers.length) {
    for (const row of saved) {
      if (!row?.url || !row?.token) continue;
      await api.saveControllerReceiver({
        label: row.label || "Receiver",
        url: row.url,
        token: row.token,
        enabled: row.enabled !== false,
      });
    }
  }
  try {
    globalThis.localStorage?.removeItem(LEGACY_RECEIVERS_STORAGE_KEY);
    globalThis.localStorage?.removeItem(LEGACY_LOG_STORAGE_KEY);
  } catch {
    // Nothing else to clean up.
  }
  // Only after every save succeeded; a failed save is retried next poll.
  legacyMigrated = true;
}

export async function refreshRemoteState() {
  if (polling) return;
  polling = true;
  try {
    applySnapshot(await api.remoteController());
    if (!legacyMigrated) {
      await migrateLegacyReceivers();
      applySnapshot(await api.remoteController());
    }
  } catch {
    // The backend may be starting up; the next poll retries.
  } finally {
    polling = false;
  }
}

refreshRemoteState();
globalThis.setInterval(refreshRemoteState, POLL_INTERVAL_MS);

export function listReceivers() {
  return receivers.map((receiver) => ({ ...receiver, status: { ...receiver.status } }));
}

export function subscribeReceivers(listener) {
  receiverListeners.add(listener);
  listener(listReceivers());
  return () => receiverListeners.delete(listener);
}

export function subscribeRemoteLogs(listener) {
  logListeners.add(listener);
  listener([...logEntries]);
  return () => logListeners.delete(listener);
}

/** Empties the controller's own connection/command log. Does not affect any
 * receiver's own log (that log lives on the receiver's backend, not here). */
export function clearRemoteLogs() {
  return api.clearControllerLogs().then(applySnapshot).catch(reportError);
}

/** Saves (or updates) a receiver and resolves to its id. A URL that is
 * already saved reuses that entry, so one PC never receives every command
 * twice. */
export async function saveReceiver({ id, label, url, token, enabled = true }) {
  const result = await api.saveControllerReceiver({ id: id || null, label, url, token, enabled });
  applySnapshot(result);
  return result.id;
}

export function removeReceiver(id) {
  return api.removeControllerReceiver(id).then(applySnapshot).catch(reportError);
}

export function setReceiverEnabled(id, enabled) {
  return api.setControllerReceiverEnabled(id, enabled).then(applySnapshot).catch(reportError);
}

/** Resolves once authenticated; rejects with the reason if the first attempt
 * fails (the backend keeps retrying unless the token was rejected). */
export async function connectReceiver(id) {
  try {
    applySnapshot(await api.connectControllerReceiver(id));
  } finally {
    refreshRemoteState();
  }
}

export function disconnectReceiver(id) {
  return api.disconnectControllerReceiver(id).then(applySnapshot).catch(reportError);
}

export function isReceiverConnected(id) {
  return receivers.some((receiver) => receiver.id === id && receiver.status?.state === "online");
}

/** True when at least one enabled receiver is currently online. */
export function isRemoteConnected() {
  return receivers.some((receiver) => receiver.enabled && receiver.status?.state === "online");
}

/**
 * Broadcasts a command through the backend to every enabled receiver (or a
 * specific subset of receiver ids). Returns per-receiver outcomes instead of
 * throwing, so one offline receiver never blocks the others.
 */
export async function sendRemoteCommand(action, data, receiverIds = null) {
  const result = await api.sendControllerCommand(action, data, receiverIds);
  refreshRemoteState();
  return { sent: result.sent ?? 0, results: Array.isArray(result.results) ? result.results : [] };
}
