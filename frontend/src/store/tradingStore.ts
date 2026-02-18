import { create } from "zustand";

export interface AccountInfo {
  balance?: number;
  equity?: number;
  profit?: number;
  margin?: number;
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

  setLiveData: (data: any) => void;
  setPositions: (rows: any[]) => void;
  setHistory: (rows: any[]) => void;
  setLiquidity: (rows: any[]) => void;

  addLog: (log: string) => void;
  setLoggedIn: (v: boolean) => void;
  setAccount: (acc: AccountInfo | null) => void;
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

  addLog: (log) => set((state) => ({ logs: [...state.logs, log] })),

  setLoggedIn: (v) => set({ isLoggedIn: v }),
  setAccount: (acc) => set({ account: acc }),
}));
