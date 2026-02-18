import { api } from "./client";

export type LiquiditySide = "buy" | "sell";

export type LiquidityItem = {
  id: string;
  price: number;
  side: LiquiditySide;
  triggered: boolean;
};

export type StartStrategyPayload = {
  symbol: string;
  timeframe: number;
  lot: number;
  min_pips: number;
  max_pips: number;
  order_delay: number;
  tp_type: boolean;
  tp: number;
  sl_type: boolean;
  sl: number;
};

export type StrategyStatusResponse = {
  running: boolean;
  pending_liq?: any | null;
  config?: Record<string, any>;
  last_event?: string;
  last_event_at?: number;
};

export async function startStrategy(payload: StartStrategyPayload) {
  const { data } = await api.post("/strategy/start", payload);
  return data;
}

export async function stopStrategy() {
  const { data } = await api.post("/strategy/stop");
  return data;
}

export async function getStrategyStatus() {
  const { data } = await api.get<StrategyStatusResponse>("/strategy/status");
  return data;
}

export async function addLiquidity(price: number, side: LiquiditySide) {
  const { data } = await api.post<LiquidityItem>("/strategy/liquidity", {
    price,
    side,
  });
  return data;
}

export async function updateLiquidity(id: string, price: number) {
  const { data } = await api.patch<LiquidityItem>(`/strategy/liquidity/${id}`, {
    price,
  });
  return data;
}

export async function deleteLiquidity(id: string) {
  const { data } = await api.delete(`/strategy/liquidity/${id}`);
  return data;
}
