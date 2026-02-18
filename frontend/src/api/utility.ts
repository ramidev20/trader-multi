import { api } from "./client";

export type RiskConfig = {
  enabled: boolean;
  symbol: string;
  maxDailyLoss: number;
  maxDrawdown: number;
  stopAfterProfit: number;
  maxOpenPositions: number;
  disableNewTradesOnLimit: boolean;
  closePositionsOnLimit: boolean;
};

export type RiskStatus = {
  running: boolean;
  limit_hit?: boolean;
  reason?: string;
  action_taken?: string;
  equity?: number;
  balance?: number;
  floating_pnl?: number;
  today_pnl?: number;
  config?: Partial<RiskConfig>;
};

// Utility
export async function closeAllPositions() {
  const { data } = await api.post("/utility/close-all");
  return data;
}

export async function closePositionsBySymbol(symbol: string) {
  const { data } = await api.post("/utility/close-symbol", { symbol });
  return data;
}

export async function closePositionsBySide(side: "BUY" | "SELL") {
  const { data } = await api.post("/utility/close-side", { side });
  return data;
}

export async function flattenAllOrders() {
  const { data } = await api.post("/utility/flatten");
  return data;
}

// Risk
export async function startRiskManagement(config: RiskConfig) {
  const { data } = await api.post("/risk/start", config);
  return data;
}

export async function stopRiskManagement() {
  const { data } = await api.post("/risk/stop");
  return data;
}

export async function getRiskStatus(): Promise<RiskStatus> {
  const { data } = await api.get("/risk/status");
  return data;
}
