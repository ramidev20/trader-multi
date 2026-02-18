import { create } from "zustand";

export interface AccountInfo {
  balance?: number;
  equity?: number;
  profit?: number;
  margin?: number;
}

export type ChartTimeframe = "M1" | "M5" | "M15" | "H1";

export interface StrategyStatus {
  running: boolean;
  pending_liq?: any | null;
  config?: Record<string, any>;
  last_event?: string;
  last_event_at?: number;
  events?: Array<{ text: string; at: number }>;
}

export interface TradingState {
  equity: number;
  bid: number;
  ask: number;
  logs: string[];

  isLoggedIn: boolean;
  account?: AccountInfo | null;

  positions: any[];
  history: any[];
  liquidity: any[];

  tickTime?: number;
  chartTimeframe: ChartTimeframe;
  strategyStatus: StrategyStatus;

  setLiveData: (data: any) => void;
  setPositions: (rows: any[]) => void;
  setHistory: (rows: any[]) => void;
  setLiquidity: (rows: any[]) => void;
  setChartTimeframe: (tf: ChartTimeframe) => void;
  setStrategyStatus: (status: Partial<StrategyStatus>) => void;

  addLog: (log: string) => void;
  setLoggedIn: (v: boolean) => void;
  setAccount: (acc: AccountInfo | null) => void;
}

function loadChartTimeframe(): ChartTimeframe {
  if (typeof window === "undefined") return "M5";
  const raw = window.localStorage.getItem("chart_timeframe_v1");
  return raw === "M1" || raw === "M5" || raw === "M15" || raw === "H1"
    ? raw
    : "M5";
}

export const useTradingStore = create<TradingState>((set) => ({
  equity: 0,
  bid: 0,
  ask: 0,
  logs: [],

  isLoggedIn: false,
  account: null,

  positions: [],
  history: [],
  liquidity: [],

  tickTime: undefined,
  chartTimeframe: loadChartTimeframe(),
  strategyStatus: { running: false, pending_liq: null },

  setLiveData: (data) =>
    set((s) => ({
      bid: data.bid ?? s.bid,
      ask: data.ask ?? s.ask,
      equity: data.equity ?? s.equity,
      tickTime: data.time ?? s.tickTime,
    })),

  setPositions: (rows) => set({ positions: rows }),
  setHistory: (rows) => set({ history: rows }),
  setLiquidity: (rows) => set({ liquidity: rows }),
  setChartTimeframe: (tf) =>
    set(() => {
      if (typeof window !== "undefined") {
        window.localStorage.setItem("chart_timeframe_v1", tf);
      }
      return { chartTimeframe: tf };
    }),
  setStrategyStatus: (status) =>
    set((s) => ({ strategyStatus: { ...s.strategyStatus, ...status } })),

  addLog: (log) => set((state) => ({ logs: [...state.logs, log] })),

  setLoggedIn: (v) => set({ isLoggedIn: v }),
  setAccount: (acc) => set({ account: acc }),
}));
