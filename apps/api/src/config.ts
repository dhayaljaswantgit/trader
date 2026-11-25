const bool = (v: string | undefined) => v === "true";
const num = (v: string | undefined, d: number) => (v === undefined || v === "" ? d : Number(v));

export const config = {
  host: process.env.API_HOST ?? "127.0.0.1",
  port: num(process.env.API_PORT, 4000),
  gates: {
    tradingMode: process.env.TRADING_MODE ?? "PAPER",
    liveTradingEnabled: bool(process.env.LIVE_TRADING_ENABLED),
    autoExecutionEnabled: bool(process.env.AUTO_EXECUTION_ENABLED),
  },
  maxOpenPositions: num(process.env.MAX_OPEN_POSITIONS, 1),
  /** USD → ₹ rate used to express crypto (Delta, USD-priced) backtests in rupees. Approximate; override with CRYPTO_USDINR. */
  cryptoUsdInr: num(process.env.CRYPTO_USDINR, 85),
  /** Default leverage for crypto backtests (margin per contract = notional ÷ leverage). */
  cryptoLeverage: num(process.env.CRYPTO_LEVERAGE, 10),
  maxQuoteAgeMs: num(process.env.MAX_QUOTE_AGE_MS, 5000),
  maxSpreadPct: num(process.env.MAX_SPREAD_PCT, 2),
  entryCutoffIst: process.env.ENTRY_CUTOFF_IST ?? "15:00",
  squareOffIst: process.env.SQUARE_OFF_IST ?? "15:15",
  engineTickMs: num(process.env.ENGINE_TICK_MS, 5000),
  slippageBps: num(process.env.PAPER_SLIPPAGE_BPS, 3),
};

// Hard rule for this build: whatever .env says, the system runs PAPER.
export const EFFECTIVE_MODE = "PAPER" as const;

// ---- Delta (crypto) runtime settings: editable from Settings, persisted in data/delta.json ----
import { readFileSync as _rf, writeFileSync as _wf, mkdirSync as _mk } from "node:fs";
import { resolve as _res, dirname as _dir } from "node:path";
export const DELTA_SETTINGS_FILE = _res(process.env.DATA_DIR ?? _res(import.meta.dirname, "../../../data"), "delta.json");
// tests never read the user's saved settings
if (!process.env.VITEST) try { const j = JSON.parse(_rf(DELTA_SETTINGS_FILE, "utf8")); if (j.usdInr > 0) config.cryptoUsdInr = j.usdInr; if (j.leverage > 0) config.cryptoLeverage = j.leverage; } catch { /* defaults */ }
export function saveDeltaSettings(s: { usdInr: number; leverage: number }) {
  config.cryptoUsdInr = s.usdInr; config.cryptoLeverage = s.leverage;
  if (process.env.NODE_ENV !== "test" && !process.env.VITEST) { _mk(_dir(DELTA_SETTINGS_FILE), { recursive: true }); _wf(DELTA_SETTINGS_FILE, JSON.stringify({ ...s, at: new Date().toISOString() }), { mode: 0o600 }); }
}
