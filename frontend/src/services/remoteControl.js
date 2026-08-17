let socket = null;
let status = { state: "offline", message: "Not connected to a trading PC." };
const listeners = new Set();
const pending = new Map();
const logListeners = new Set();
const LOG_STORAGE_KEY = "trader.remoteControl.logs";
const logEntries = (() => {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(LOG_STORAGE_KEY) || "[]");
    return Array.isArray(saved) ? saved.slice(-80) : [];
  } catch {
    return [];
  }
})();
const LOG_LIMIT = 80;
const HEARTBEAT_INTERVAL_MS = 12000;
const COMMAND_TIMEOUT_MS = 60000;
let heartbeatTimer = null;
let reconnectTimer = null;
let desiredConnection = null;
let reconnectAttempt = 0;

function nowLabel() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function appendLog(level, message) {
  const entry = {
    id: globalThis.crypto?.randomUUID?.() || `remote-log-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    level,
    message,
    at: nowLabel(),
  };
  logEntries.push(entry);
  if (logEntries.length > LOG_LIMIT) {
    logEntries.splice(0, logEntries.length - LOG_LIMIT);
  }
  try {
    globalThis.localStorage?.setItem(LOG_STORAGE_KEY, JSON.stringify(logEntries));
  } catch {
    // Logging must continue when browser storage is unavailable.
  }
  logListeners.forEach((listener) => listener([...logEntries]));
}

function publish(next) {
  status = { ...status, ...next };
  listeners.forEach((listener) => listener(status));
}

function commandId() {
  return globalThis.crypto?.randomUUID?.() || `cmd-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function subscribeRemoteStatus(listener) {
  listeners.add(listener);
  listener(status);
  return () => listeners.delete(listener);
}

export function subscribeRemoteLogs(listener) {
  logListeners.add(listener);
  listener([...logEntries]);
  return () => logListeners.delete(listener);
}

function clearConnectionTimers() {
  if (heartbeatTimer) globalThis.clearInterval(heartbeatTimer);
  if (reconnectTimer) globalThis.clearTimeout(reconnectTimer);
  heartbeatTimer = null;
  reconnectTimer = null;
}

function rejectPendingCommands(message) {
  pending.forEach((waiting) => waiting.reject(new Error(message)));
  pending.clear();
}

function startHeartbeat(targetSocket) {
  if (heartbeatTimer) globalThis.clearInterval(heartbeatTimer);
  heartbeatTimer = globalThis.setInterval(() => {
    if (socket === targetSocket && targetSocket.readyState === WebSocket.OPEN) {
      targetSocket.send(JSON.stringify({ type: "ping", sent_at: new Date().toISOString() }));
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function scheduleReconnect() {
  if (!desiredConnection || reconnectTimer) return;
  const delay = Math.min(15000, 1500 * (2 ** reconnectAttempt));
  reconnectAttempt += 1;
  appendLog("warning", `Connection lost. Reconnecting in ${Math.round(delay / 1000)} seconds...`);
  publish({ state: "connecting", message: "Connection lost. Reconnecting automatically..." });
  reconnectTimer = globalThis.setTimeout(() => {
    reconnectTimer = null;
    if (desiredConnection) {
      openRemoteSocket(desiredConnection.url, desiredConnection.token, true).catch(() => {});
    }
  }, delay);
}

function openRemoteSocket(url, token, reconnecting = false) {
  if (socket) {
    const previous = socket;
    socket = null;
    previous.close();
  }
  if (heartbeatTimer) globalThis.clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  appendLog("info", `${reconnecting ? "Reconnecting" : "Connecting"} to ${url}...`);
  publish({ state: "connecting", message: "Authenticating with the trading PC..." });
  return new Promise((resolve, reject) => {
    const nextSocket = new WebSocket(url);
    socket = nextSocket;
    let settled = false;
    let socketOpened = false;
    nextSocket.onopen = () => {
      socketOpened = true;
      appendLog("info", "Socket opened. Sending authentication token.");
      nextSocket.send(JSON.stringify({ type: "authenticate", token }));
    };
    nextSocket.onmessage = (event) => {
      if (socket !== nextSocket) return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        appendLog("warning", "Ignored an invalid response from the receiver.");
        return;
      }
      if (message.type === "pong") return;
      if (message.type === "connection") {
        settled = true;
        reconnectAttempt = 0;
        appendLog("success", message.message || "Connected and authenticated.");
        publish({ state: "online", message: message.message || "Connected and authenticated." });
        startHeartbeat(nextSocket);
        resolve(message);
        return;
      }
      if (message.type === "log" && message.message) {
        appendLog(message.level || "info", message.message);
        return;
      }
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      if (message.status === "success") {
        const resultMessage = message.result?.message || message.result?.adapter_result?.message;
        const copySummary = message.result?.copy_summary || message.result?.adapter_result?.copy_summary;
        appendLog("success", resultMessage || `Command ${message.id || "unknown"} completed successfully.`);
        if (copySummary) appendLog("info", copySummary);
        waiting.resolve(message);
      } else {
        appendLog("error", `Command ${message.id || "unknown"} failed: ${message.message || "Remote command failed."}`);
        waiting.reject(new Error(message.message || "Remote command failed."));
      }
    };
    nextSocket.onerror = () => {
      if (socket === nextSocket) {
        appendLog("error", "Socket error while contacting the receiver.");
      }
    };
    nextSocket.onclose = (event) => {
      if (socket !== nextSocket) return;
      socket = null;
      if (heartbeatTimer) globalThis.clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      const closeReason = event.reason || "Connection closed. Check the token or network if this was unexpected.";
      const closeLabel = settled
        ? "Remote session ended"
        : socketOpened
          ? "Authentication failed"
          : "Receiver unreachable";
      appendLog(settled ? "warning" : "error", `${closeLabel}: ${closeReason}`);
      rejectPendingCommands(closeReason);
      if (!settled) reject(new Error(closeReason));
      if (event.code === 1008) {
        desiredConnection = null;
        publish({ state: "offline", message: closeReason });
      } else if (desiredConnection) {
        scheduleReconnect();
      } else {
        publish({ state: "offline", message: closeReason });
      }
    };
  });
}

export function connectRemote(url, token) {
  if (!url?.trim() || !token?.trim()) {
    appendLog("error", "Connection blocked: receiver URL and token are required.");
    return Promise.reject(new Error("Enter the receiver WebSocket URL and remote token."));
  }
  clearConnectionTimers();
  reconnectAttempt = 0;
  desiredConnection = { url: url.trim(), token: token.trim() };
  return openRemoteSocket(desiredConnection.url, desiredConnection.token);
}

export function disconnectRemote() {
  desiredConnection = null;
  clearConnectionTimers();
  const previous = socket;
  socket = null;
  previous?.close(1000, "Disconnected by controller.");
  rejectPendingCommands("Disconnected from the receiver.");
  appendLog("info", "Disconnected from the receiver.");
  publish({ state: "offline", message: "Disconnected from the trading PC." });
}

export function isRemoteConnected() {
  return Boolean(socket && socket.readyState === WebSocket.OPEN && status.state === "online");
}

export function sendRemoteCommand(action, data) {
  if (!socket || socket.readyState !== WebSocket.OPEN || status.state !== "online") {
    appendLog("error", `Command ${action} blocked: receiver is not connected.`);
    return Promise.reject(new Error("Remote receiver is not connected."));
  }
  const id = commandId();
  appendLog("info", `Sending command ${action} (${id}).`);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, action, data }));
    window.setTimeout(() => {
      const waiting = pending.get(id);
      if (waiting) {
        pending.delete(id);
        appendLog("error", `Command ${action} (${id}) timed out after ${COMMAND_TIMEOUT_MS / 1000} seconds.`);
        waiting.reject(new Error(`The remote receiver did not answer within ${COMMAND_TIMEOUT_MS / 1000} seconds.`));
      }
    }, COMMAND_TIMEOUT_MS);
  });
}
