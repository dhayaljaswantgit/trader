import Decimal from "decimal.js";
import { z } from "zod";

export { Decimal };

export type TradingMode = "PAPER" | "LIVE";
export type SignalAction = "WATCH" | "ENTER" | "EXIT" | "NO_TRADE";
export type Direction = "BULLISH" | "BEARISH" | "NEUTRAL";
export type ExchangeSegment = "NSE_EQ" | "NSE_FNO" | "BSE_EQ" | "BSE_FNO" | "IDX";

export interface Instrument {
  /** Broker security id. MOCK ids are prefixed "MOCK-". */
  securityId: string;
  symbol: string;
  segment: ExchangeSegment;
  lotSize: number;
  tickSize: string;
  kind: "INDEX" | "EQUITY" | "OPTION";
}

export interface Quote {
  securityId: string;
  symbol: string;
  ltp: string;
  bid: string | null;
  ask: string | null;
  volume: number | null;
  /** Exchange/source timestamp, ISO UTC */
  sourceTs: string;
  /** When our system received it, ISO UTC */
  receivedTs: string;
  source: "MOCK" | "DHAN";
}

export interface Candle {
  securityId: string;
  start: string; // ISO UTC, bar open time
  open: string; high: string; low: string; close: string;
  volume: number;
  complete: boolean;
}

/** The morning-of-day settings the user chooses. */
export const DailySessionInput = z.object({
  capitalInr: z.coerce.number().positive().max(1e9),
  maxLossInr: z.coerce.number().positive(),
  /** null = unlimited profit (no profit-based halt) */
  maxProfitInr: z.coerce.number().positive().nullable(),
  riskPerTradePct: z.coerce.number().positive().max(5).default(0.25),
  maxConsecutiveLosses: z.coerce.number().int().min(1).max(50).default(3),
}).refine(v => v.maxLossInr <= v.capitalInr, { message: "Max loss cannot exceed capital", path: ["maxLossInr"] });
export type DailySessionInput = z.infer<typeof DailySessionInput>;

export interface DailySession {
  id: string;
  tradingDate: string; // YYYY-MM-DD (IST)
  mode: TradingMode;
  capitalInr: string;
  maxLossInr: string;
  maxProfitInr: string | null;
  riskPerTradePct: string;
  status: "ACTIVE" | "HALTED_LOSS" | "HALTED_PROFIT" | "HALTED_CONSECUTIVE_LOSSES" | "EMERGENCY_STOP" | "CLOSED";
  realizedPnlInr: string;
  unrealizedPnlInr: string;
  consecutiveLosses: number;
  startedAt: string;
}

export interface OrderIntent {
  correlationId: string;
  mode: TradingMode;
  securityId: string;
  side: "BUY" | "SELL";
  quantity: number;
  lotSize: number;
  /** Expected premium per unit */
  limitPrice: string;
  /** Planned stop price per unit (for long options: max premium loss if null = full premium) */
  stopPrice: string | null;
  isEntry: boolean;
  strategyVersion: string;
  /** Defaults to OPTIONS (long premium) when omitted */
  kind?: "EQUITY" | "FUTURES" | "OPTIONS";
  product?: "INTRADAY" | "CARRY_FORWARD";
}

export const IST = "Asia/Kolkata";
export function toIstDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: IST, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
export function toIstHHMM(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: IST, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
}
