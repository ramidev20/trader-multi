let socket = null;
let status = { state: "offline", message: "Not connected to a trading PC." };
const listeners = new Set();
const pending = new Map();

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

export function connectRemote(url, token) {
  if (!url?.trim() || !token?.trim()) {
    return Promise.reject(new Error("Enter the receiver WebSocket URL and remote token."));
  }
  disconnectRemote();
  publish({ state: "connecting", message: "Authenticating with the trading PC..." });
  return new Promise((resolve, reject) => {
    const nextSocket = new WebSocket(url.trim());
    socket = nextSocket;
    nextSocket.onopen = () => nextSocket.send(JSON.stringify({ type: "authenticate", token: token.trim() }));
    nextSocket.onmessage = (event) => {
      if (socket !== nextSocket) return;
      const message = JSON.parse(event.data);
      if (message.type === "connection") {
        publish({ state: "online", message: message.message || "Connected and authenticated." });
        resolve(message);
        return;
      }
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      message.status === "success" ? waiting.resolve(message) : waiting.reject(new Error(message.message || "Remote command failed."));
    };
    nextSocket.onerror = () => {
      if (socket === nextSocket) publish({ state: "offline", message: "Could not reach the receiver. Check Tailscale, URL, and token." });
    };
    nextSocket.onclose = () => {
      if (socket !== nextSocket) return;
      socket = null;
      publish({ state: "offline", message: "Connection closed. Check the token or network if this was unexpected." });
      reject(new Error("Remote connection closed before authentication completed."));
    };
  });
}

export function disconnectRemote() {
  socket?.close();
  socket = null;
  publish({ state: "offline", message: "Disconnected from the trading PC." });
}

export function isRemoteConnected() {
  return Boolean(socket && socket.readyState === WebSocket.OPEN && status.state === "online");
}

export function sendRemoteCommand(action, data) {
  if (!socket || socket.readyState !== WebSocket.OPEN || status.state !== "online") {
    return Promise.reject(new Error("Remote receiver is not connected."));
  }
  const id = commandId();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, action, data }));
    window.setTimeout(() => {
      const waiting = pending.get(id);
      if (waiting) {
        pending.delete(id);
        waiting.reject(new Error("The remote receiver did not answer within 20 seconds."));
      }
    }, 20000);
  });
}
