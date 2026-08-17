const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000";

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Network error: could not reach ${API_BASE}${path}. ${reason}`);
  }
  if (!response.ok) {
    let detail = `Request failed (${response.status})`;
    try {
      const payload = await response.json();
      detail = payload.detail || payload.message || detail;
    } catch {
      // ignore
    }
    throw new Error(detail);
  }
  return response.json();
}

export const api = {
  bootstrap: () => request("/bootstrap"),
  dashboard: () => request("/dashboard"),
  runtime: () => request("/runtime"),
  settings: () => request("/settings"),
  saveTheme: (theme_mode) => request("/settings/theme", { method: "PATCH", body: JSON.stringify({ theme_mode }) }),
  saveZoom: (ui_zoom_percent) => request("/settings/zoom", { method: "PATCH", body: JSON.stringify({ ui_zoom_percent }) }),
  saveSearchConfig: (search_config) => request("/settings/search", { method: "PATCH", body: JSON.stringify({ search_config }) }),
  saveNotificationSettings: (payload) => request("/settings/notifications", { method: "PATCH", body: JSON.stringify(payload) }),
  saveRemoteControlSettings: (payload) => request("/settings/remote-control", { method: "PATCH", body: JSON.stringify(payload) }),

  saveAccount: (payload) => request("/accounts", { method: "POST", body: JSON.stringify(payload) }),
  deleteAccount: (login) => request(`/accounts/${login}`, { method: "DELETE" }),
  connectAccount: (login) => request(`/accounts/${login}/connect`, { method: "POST" }),
  disconnectAccount: (login) => request(`/accounts/${login}/disconnect`, { method: "POST" }),
  sessions: () => request("/accounts/sessions"),
  accountSnapshots: () => request("/accounts/snapshots"),
  livePositions: () => request("/positions/live"),
  tradeHistory: () => request("/trade-history"),
  calculateLot: (payload) => request("/positions/calculate-lot", { method: "POST", body: JSON.stringify(payload) }),

  startStrategy: (payload) => request("/strategy/start", { method: "POST", body: JSON.stringify(payload) }),
  stopStrategy: () => request("/strategy/stop", { method: "POST" }),
  addLiquidityLevel: (payload) => request("/liquidity-levels", { method: "POST", body: JSON.stringify(payload) }),
  removeLiquidityLevel: (id) => request(`/liquidity-levels/${id}`, { method: "DELETE" }),
  openPosition: (payload) => request("/positions/open", { method: "POST", body: JSON.stringify(payload) }),
  closePositions: () => request("/positions/close", { method: "POST" }),

  startRiskMonitor: (payload) => request("/risk/start", { method: "POST", body: JSON.stringify(payload) }),
  stopRiskMonitor: () => request("/risk/stop", { method: "POST" }),
};
