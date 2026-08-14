let socket = null;
let status = { state: "offline", message: "Not connected to a trading PC." };
const listeners = new Set();
const pending = new Map();
const logListeners = new Set();
const logEntries = [];
const LOG_LIMIT = 80;

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

export function connectRemote(url, token) {
  if (!url?.trim() || !token?.trim()) {
    appendLog("error", "Connection blocked: receiver URL and token are required.");
    return Promise.reject(new Error("Enter the receiver WebSocket URL and remote token."));
  }
  disconnectRemote();
  appendLog("info", `Connecting to ${url.trim()}...`);
  publish({ state: "connecting", message: "Authenticating with the trading PC..." });
  return new Promise((resolve, reject) => {
    const nextSocket = new WebSocket(url.trim());
    socket = nextSocket;
    let settled = false;
    nextSocket.onopen = () => {
      appendLog("info", "Socket opened. Sending authentication token.");
      nextSocket.send(JSON.stringify({ type: "authenticate", token: token.trim() }));
    };
    nextSocket.onmessage = (event) => {
      if (socket !== nextSocket) return;
      const message = JSON.parse(event.data);
      if (message.type === "connection") {
        settled = true;
        appendLog("success", message.message || "Connected and authenticated.");
        publish({ state: "online", message: message.message || "Connected and authenticated." });
        resolve(message);
        return;
      }
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      if (message.status === "success") {
        appendLog("success", `Command ${message.id || "unknown"} completed successfully.`);
        waiting.resolve(message);
      } else {
        appendLog("error", `Command ${message.id || "unknown"} failed: ${message.message || "Remote command failed."}`);
        waiting.reject(new Error(message.message || "Remote command failed."));
      }
    };
    nextSocket.onerror = () => {
      if (socket === nextSocket) {
        appendLog("error", "Socket error while contacting the receiver.");
        publish({ state: "offline", message: "Could not reach the receiver. Check Tailscale, URL, and token." });
      }
    };
    nextSocket.onclose = (event) => {
      if (socket !== nextSocket) return;
      socket = null;
      const closeReason = event.reason || "Connection closed. Check the token or network if this was unexpected.";
      appendLog(settled ? "warning" : "error", `${settled ? "Remote session ended" : "Authentication failed"}: ${closeReason}`);
      publish({ state: "offline", message: closeReason });
      if (!settled) {
        reject(new Error(closeReason || "Remote connection closed before authentication completed."));
      }
    };
  });
}

export function disconnectRemote() {
  socket?.close();
  socket = null;
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
        appendLog("error", `Command ${action} (${id}) timed out after 20 seconds.`);
        waiting.reject(new Error("The remote receiver did not answer within 20 seconds."));
      }
    }, 20000);
  });
}
