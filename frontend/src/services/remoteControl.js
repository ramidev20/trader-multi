const RECEIVERS_STORAGE_KEY = "trader.remoteControl.receivers";
const LOG_STORAGE_KEY = "trader.remoteControl.logs";
const LOG_LIMIT = 120;
const HEARTBEAT_INTERVAL_MS = 8000;
const HEARTBEAT_STALE_MS = 20000;
const COMMAND_TIMEOUT_MS = 60000;

const receiverListeners = new Set();
const logListeners = new Set();
const logEntries = loadLogs();

/** One entry per saved receiver: { id, label, url, token, enabled } plus live connection state. */
const receivers = new Map();
for (const saved of loadReceivers()) {
  receivers.set(saved.id, makeReceiverRecord(saved));
}

function loadReceivers() {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(RECEIVERS_STORAGE_KEY) || "[]");
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function loadLogs() {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(LOG_STORAGE_KEY) || "[]");
    return Array.isArray(saved) ? saved.slice(-LOG_LIMIT) : [];
  } catch {
    return [];
  }
}

function persistReceivers() {
  try {
    const rows = Array.from(receivers.values()).map((r) => ({
      id: r.id,
      label: r.label,
      url: r.url,
      token: r.token,
      enabled: r.enabled,
    }));
    globalThis.localStorage?.setItem(RECEIVERS_STORAGE_KEY, JSON.stringify(rows));
  } catch {
    // Keep receivers usable when browser storage is unavailable.
  }
}

function makeReceiverRecord(saved) {
  return {
    id: saved.id,
    label: saved.label || "Receiver",
    url: saved.url || "",
    token: saved.token || "",
    enabled: saved.enabled !== false,
    status: { state: "offline", message: "Not connected." },
    socket: null,
    desired: false,
    heartbeatTimer: null,
    lastPongAt: 0,
    reconnectTimer: null,
    reconnectAttempt: 0,
    pending: new Map(),
  };
}

function nowLabel() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function commandId() {
  return globalThis.crypto?.randomUUID?.() || `cmd-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function appendLog(level, message, receiverLabel) {
  const entry = {
    id: globalThis.crypto?.randomUUID?.() || `remote-log-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    level,
    message: receiverLabel ? `[${receiverLabel}] ${message}` : message,
    at: nowLabel(),
  };
  logEntries.push(entry);
  if (logEntries.length > LOG_LIMIT) logEntries.splice(0, logEntries.length - LOG_LIMIT);
  try {
    globalThis.localStorage?.setItem(LOG_STORAGE_KEY, JSON.stringify(logEntries));
  } catch {
    // Logging must continue when browser storage is unavailable.
  }
  logListeners.forEach((listener) => listener([...logEntries]));
}

function publishReceivers() {
  const snapshot = listReceivers();
  receiverListeners.forEach((listener) => listener(snapshot));
}

export function listReceivers() {
  return Array.from(receivers.values()).map((r) => ({
    id: r.id,
    label: r.label,
    url: r.url,
    token: r.token,
    enabled: r.enabled,
    status: r.status,
  }));
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

export function saveReceiver({ id, label, url, token, enabled = true }) {
  const receiverId = id || globalThis.crypto?.randomUUID?.() || `receiver-${Date.now()}`;
  const existing = receivers.get(receiverId);
  const record = existing || makeReceiverRecord({ id: receiverId });
  record.label = label?.trim() || record.label || "Receiver";
  record.url = url?.trim() || "";
  record.token = token?.trim() || "";
  record.enabled = enabled;
  receivers.set(receiverId, record);
  persistReceivers();
  publishReceivers();
  return receiverId;
}

export function removeReceiver(id) {
  const record = receivers.get(id);
  if (!record) return;
  teardownConnection(record, "Receiver removed.", true);
  receivers.delete(id);
  persistReceivers();
  publishReceivers();
}

export function setReceiverEnabled(id, enabled) {
  const record = receivers.get(id);
  if (!record) return;
  record.enabled = enabled;
  if (!enabled && record.desired) {
    disconnectReceiver(id);
  }
  persistReceivers();
  publishReceivers();
}

function clearTimers(record) {
  if (record.heartbeatTimer) globalThis.clearInterval(record.heartbeatTimer);
  if (record.reconnectTimer) globalThis.clearTimeout(record.reconnectTimer);
  record.heartbeatTimer = null;
  record.reconnectTimer = null;
}

function rejectPending(record, message) {
  record.pending.forEach((waiting) => waiting.reject(new Error(message)));
  record.pending.clear();
}

function startHeartbeat(record, targetSocket) {
  if (record.heartbeatTimer) globalThis.clearInterval(record.heartbeatTimer);
  record.lastPongAt = Date.now();
  record.heartbeatTimer = globalThis.setInterval(() => {
    if (record.socket !== targetSocket || targetSocket.readyState !== WebSocket.OPEN) return;
    if (Date.now() - record.lastPongAt > HEARTBEAT_STALE_MS + HEARTBEAT_INTERVAL_MS) {
      appendLog("warning", "No response to heartbeat pings. Reconnecting.", record.label);
      targetSocket.close(4000, "Heartbeat timed out.");
      return;
    }
    targetSocket.send(JSON.stringify({ type: "ping", sent_at: new Date().toISOString() }));
  }, HEARTBEAT_INTERVAL_MS);
}

function scheduleReconnect(record) {
  if (!record.desired || record.reconnectTimer) return;
  const delay = Math.min(15000, 1500 * (2 ** record.reconnectAttempt));
  record.reconnectAttempt += 1;
  appendLog("warning", `Connection lost. Reconnecting in ${Math.round(delay / 1000)}s...`, record.label);
  record.status = { state: "connecting", message: "Connection lost. Reconnecting automatically..." };
  publishReceivers();
  record.reconnectTimer = globalThis.setTimeout(() => {
    record.reconnectTimer = null;
    if (record.desired) openReceiverSocket(record, true).catch(() => {});
  }, delay);
}

function openReceiverSocket(record, reconnecting = false) {
  if (record.socket) {
    const previous = record.socket;
    record.socket = null;
    previous.close();
  }
  if (record.heartbeatTimer) globalThis.clearInterval(record.heartbeatTimer);
  record.heartbeatTimer = null;
  appendLog("info", `${reconnecting ? "Reconnecting" : "Connecting"} to ${record.url}...`, record.label);
  record.status = { state: "connecting", message: "Authenticating with the trading PC..." };
  publishReceivers();

  return new Promise((resolve, reject) => {
    const nextSocket = new WebSocket(record.url);
    record.socket = nextSocket;
    let settled = false;
    let socketOpened = false;

    nextSocket.onopen = () => {
      socketOpened = true;
      appendLog("info", "Socket opened. Sending authentication token.", record.label);
      nextSocket.send(JSON.stringify({ type: "authenticate", token: record.token }));
    };

    nextSocket.onmessage = (event) => {
      if (record.socket !== nextSocket) return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        appendLog("warning", "Ignored an invalid response from the receiver.", record.label);
        return;
      }
      if (message.type === "pong") {
        record.lastPongAt = Date.now();
        return;
      }
      if (message.type === "connection") {
        settled = true;
        record.reconnectAttempt = 0;
        record.lastPongAt = Date.now();
        appendLog("success", message.message || "Connected and authenticated.", record.label);
        record.status = { state: "online", message: message.message || "Connected and authenticated." };
        publishReceivers();
        startHeartbeat(record, nextSocket);
        resolve(message);
        return;
      }
      if (message.type === "log" && message.message) {
        appendLog(message.level || "info", message.message, record.label);
        return;
      }
      const waiting = record.pending.get(message.id);
      if (!waiting) return;
      record.pending.delete(message.id);
      if (message.status === "success") {
        const resultMessage = message.result?.message || message.result?.adapter_result?.message;
        const copySummary = message.result?.copy_summary || message.result?.adapter_result?.copy_summary;
        appendLog("success", resultMessage || `Command ${message.id || "unknown"} completed successfully.`, record.label);
        if (copySummary) appendLog("info", copySummary, record.label);
        waiting.resolve(message);
      } else {
        appendLog("error", `Command ${message.id || "unknown"} failed: ${message.message || "Remote command failed."}`, record.label);
        waiting.reject(new Error(message.message || "Remote command failed."));
      }
    };

    nextSocket.onerror = () => {
      if (record.socket === nextSocket) {
        appendLog("error", "Socket error while contacting the receiver.", record.label);
      }
    };

    nextSocket.onclose = (event) => {
      if (record.socket !== nextSocket) return;
      record.socket = null;
      if (record.heartbeatTimer) globalThis.clearInterval(record.heartbeatTimer);
      record.heartbeatTimer = null;
      const closeReason = event.reason || "Connection closed. Check the token or network if this was unexpected.";
      const closeLabel = settled ? "Remote session ended" : socketOpened ? "Authentication failed" : "Receiver unreachable";
      appendLog(settled ? "warning" : "error", `${closeLabel}: ${closeReason}`, record.label);
      rejectPending(record, closeReason);
      if (!settled) reject(new Error(closeReason));
      if (event.code === 1008) {
        record.desired = false;
        record.status = { state: "offline", message: closeReason };
        publishReceivers();
      } else if (record.desired) {
        scheduleReconnect(record);
      } else {
        record.status = { state: "offline", message: closeReason };
        publishReceivers();
      }
    };
  });
}

function teardownConnection(record, message, silent = false) {
  record.desired = false;
  clearTimers(record);
  const previous = record.socket;
  record.socket = null;
  previous?.close(1000, message);
  rejectPending(record, message);
  if (!silent) appendLog("info", message, record.label);
  record.status = { state: "offline", message };
  publishReceivers();
}

export function connectReceiver(id) {
  const record = receivers.get(id);
  if (!record) return Promise.reject(new Error("Unknown receiver."));
  if (!record.url.trim() || !record.token.trim()) {
    appendLog("error", "Connection blocked: URL and token are required.", record.label);
    return Promise.reject(new Error("Enter the receiver WebSocket URL and token."));
  }
  clearTimers(record);
  record.reconnectAttempt = 0;
  record.desired = true;
  return openReceiverSocket(record);
}

export function disconnectReceiver(id) {
  const record = receivers.get(id);
  if (!record) return;
  teardownConnection(record, "Disconnected from the receiver.");
}

export function isReceiverConnected(id) {
  const record = receivers.get(id);
  return Boolean(record?.socket && record.socket.readyState === WebSocket.OPEN && record.status.state === "online");
}

/** True when at least one enabled receiver is currently online. */
export function isRemoteConnected() {
  for (const record of receivers.values()) {
    if (record.enabled && record.socket && record.socket.readyState === WebSocket.OPEN && record.status.state === "online") {
      return true;
    }
  }
  return false;
}

function sendToReceiver(record, action, data) {
  if (!record.socket || record.socket.readyState !== WebSocket.OPEN || record.status.state !== "online") {
    return Promise.reject(new Error("Remote receiver is not connected."));
  }
  const id = commandId();
  appendLog("info", `Sending command ${action} (${id}).`, record.label);
  return new Promise((resolve, reject) => {
    record.pending.set(id, { resolve, reject });
    record.socket.send(JSON.stringify({ id, action, data }));
    globalThis.setTimeout(() => {
      const waiting = record.pending.get(id);
      if (waiting) {
        record.pending.delete(id);
        appendLog("error", `Command ${action} (${id}) timed out after ${COMMAND_TIMEOUT_MS / 1000}s.`, record.label);
        waiting.reject(new Error(`The remote receiver did not answer within ${COMMAND_TIMEOUT_MS / 1000} seconds.`));
      }
    }, COMMAND_TIMEOUT_MS);
  });
}

/**
 * Broadcasts a command to every enabled + connected receiver (or a specific
 * subset of receiver ids). Returns per-receiver outcomes instead of throwing,
 * so one offline receiver never blocks the others.
 */
export async function sendRemoteCommand(action, data, receiverIds = null) {
  const targets = Array.from(receivers.values()).filter((record) => {
    if (!record.enabled) return false;
    if (receiverIds && !receiverIds.includes(record.id)) return false;
    return true;
  });
  if (!targets.length) {
    return { sent: 0, results: [] };
  }
  const results = await Promise.all(
    targets.map(async (record) => {
      try {
        const message = await sendToReceiver(record, action, data);
        return { id: record.id, label: record.label, status: "success", message };
      } catch (error) {
        return {
          id: record.id,
          label: record.label,
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
  return { sent: results.length, results };
}
