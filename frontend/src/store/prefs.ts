// src/store/prefs.ts

export type SavedAccount = {
  id: string;
  name: string;
  login: string;
  server: string;
  password?: string; // ⚠️ stored locally (not secure)
};

export type TradingSettings = {
  terminalPath: string;
  lastAccountId?: string;
};

const ACC_KEY = "mt5_saved_accounts_v1";
const SET_KEY = "mt5_settings_v1";

/* =========================
   ACCOUNTS
========================= */

export function loadAccounts(): SavedAccount[] {
  try {
    const raw = JSON.parse(localStorage.getItem(ACC_KEY) || "[]");

    if (!Array.isArray(raw)) return [];

    return raw.filter(
      (x) =>
        typeof x.id === "string" &&
        typeof x.name === "string" &&
        typeof x.login === "string" &&
        typeof x.server === "string" &&
        (x.password == null || typeof x.password === "string"),
    );
  } catch {
    return [];
  }
}

export function saveAccounts(accounts: SavedAccount[]) {
  localStorage.setItem(ACC_KEY, JSON.stringify(accounts));
}

/* =========================
   SETTINGS
========================= */

export function loadSettings(): TradingSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(SET_KEY) || "{}");

    return {
      terminalPath:
        typeof raw.terminalPath === "string" ? raw.terminalPath : "",
      lastAccountId:
        typeof raw.lastAccountId === "string" ? raw.lastAccountId : undefined,
    };
  } catch {
    return {
      terminalPath: "",
    };
  }
}

export function saveSettings(settings: TradingSettings) {
  localStorage.setItem(SET_KEY, JSON.stringify(settings));
}

/* =========================
   HELPERS
========================= */

export function makeAccountId(login: string, server: string): string {
  return `${login.trim()}@${server.trim()}`.toLowerCase();
}
