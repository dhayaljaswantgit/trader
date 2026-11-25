import type { Bar } from "@dat/quant";
export * from "./mock.ts";
export * from "./dhan.ts";
export * from "./master.ts";
export * from "./delta.ts";

export type Segment = "IDX_I" | "NSE_EQ" | "NSE_FNO" | "BSE_EQ" | "BSE_FNO" | "DELTA";
export type InstrumentType = "INDEX" | "EQUITY" | "FUTIDX" | "FUTSTK" | "OPTIDX" | "OPTSTK" | "CRYPTO_PERP";
export interface InstrumentRef { securityId: string; segment: Segment; instrumentType: InstrumentType; symbol: string }

export interface LiveQuote {
  securityId: string; segment: Segment; ltp: number; bid: number | null; ask: number | null; volume: number | null;
  open: number | null; high: number | null; low: number | null; prevClose: number | null; oi: number | null;
  sourceTs: string | null; receivedTs: string; source: "MOCK" | "DHAN" | "DELTA";
}
export interface CandleQuery { ref: InstrumentRef; interval: 1 | 5 | 15 | 25 | 60 | "D"; from: Date; to: Date }
export interface OptionLeg {
  securityId: string | null; ltp: number | null; bid: number | null; ask: number | null; volume: number | null; oi: number | null;
  iv: number | null; delta: number | null; theta: number | null; gamma: number | null; vega: number | null;
}
export interface OptionChain { underlying: InstrumentRef; expiry: string; spot: number; strikes: Array<{ strike: number; ce: OptionLeg | null; pe: OptionLeg | null }>; source: "MOCK" | "DHAN"; fetchedAt: string }
export interface BrokerHealth { connected: boolean; source: "MOCK" | "DHAN" | "DELTA"; detail: string; checkedAt: string }

/** Internal interface; names are ours, not Dhan's. Mapping: docs/dhan-api-mapping.md. No order methods in this build. */
export interface IBrokerAdapter {
  readonly source: "MOCK" | "DHAN";
  healthCheck(): Promise<BrokerHealth>;
  getQuotes(refs: InstrumentRef[]): Promise<LiveQuote[]>;
  getCandles(q: CandleQuery): Promise<Bar[]>;
  getExpiries(underlying: InstrumentRef): Promise<string[]>;
  getOptionChain(underlying: InstrumentRef, expiry: string): Promise<OptionChain>;
}

export class BrokerError extends Error { constructor(msg: string, public status?: number, public code?: string) { super(msg); } }
