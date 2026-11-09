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
  maxQuoteAgeMs: num(process.env.MAX_QUOTE_AGE_MS, 5000),
  maxSpreadPct: num(process.env.MAX_SPREAD_PCT, 2),
  entryCutoffIst: process.env.ENTRY_CUTOFF_IST ?? "15:00",
  squareOffIst: process.env.SQUARE_OFF_IST ?? "15:15",
  engineTickMs: num(process.env.ENGINE_TICK_MS, 5000),
  slippageBps: num(process.env.PAPER_SLIPPAGE_BPS, 3),
};

// Hard rule for this build: whatever .env says, the system runs PAPER.
export const EFFECTIVE_MODE = "PAPER" as const;
