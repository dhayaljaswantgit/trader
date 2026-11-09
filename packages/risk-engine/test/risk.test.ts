import { describe, it, expect } from "vitest";
import { preTradeCheck, evaluateSessionLimits, type RiskContext } from "../src/index.ts";
import type { DailySession, OrderIntent } from "@dat/shared";

const session = (o: Partial<DailySession> = {}): DailySession => ({
  id: "s1", tradingDate: "2026-11-09", mode: "PAPER", capitalInr: "100000", maxLossInr: "1000",
  maxProfitInr: null, riskPerTradePct: "0.25", status: "ACTIVE", realizedPnlInr: "0", unrealizedPnlInr: "0",
  consecutiveLosses: 0, startedAt: "2026-11-09T03:45:00Z", ...o,
});
// 10:30 IST
const ctx = (o: Partial<RiskContext> = {}): RiskContext => ({
  gates: { tradingMode: "PAPER", liveTradingEnabled: false, autoExecutionEnabled: false },
  session: session(), openPositions: 0, maxOpenPositions: 1, maxConsecutiveLosses: 3,
  quoteAgeMs: 500, maxQuoteAgeMs: 5000, spreadPct: 0.5, maxSpreadPct: 2,
  brokerConnected: true, positionMismatch: false, unknownOrderState: false,
  now: new Date("2026-11-09T05:00:00Z"), entryCutoffIst: "15:00", ...o,
});
// risk = (100-90)*20 = 200 <= 250 cap
const intent = (o: Partial<OrderIntent> = {}): OrderIntent => ({
  correlationId: "c1", mode: "PAPER", securityId: "MOCK-OPT", side: "BUY", quantity: 20, lotSize: 20,
  limitPrice: "100", stopPrice: "90", isEntry: true, strategyVersion: "test", ...o,
});

describe("preTradeCheck", () => {
  it("approves a clean paper entry", () => {
    expect(preTradeCheck(intent(), ctx())).toMatchObject({ approved: true });
  });
  it("blocks LIVE even if every config flag is flipped on", () => {
    const d = preTradeCheck(intent({ mode: "LIVE" }), ctx({
      gates: { tradingMode: "LIVE", liveTradingEnabled: true, autoExecutionEnabled: true },
      session: session({ mode: "LIVE" }),
    }));
    expect(d.approved).toBe(false);
    expect(d.reasons.join()).toMatch(/LIVE_NOT_IMPLEMENTED/);
  });
  it("blocks without a started session", () => {
    expect(preTradeCheck(intent(), ctx({ session: null })).approved).toBe(false);
  });
  it("stale or missing data => blocked", () => {
    expect(preTradeCheck(intent(), ctx({ quoteAgeMs: 9000 })).reasons).toContain("STALE_DATA");
    expect(preTradeCheck(intent(), ctx({ quoteAgeMs: null })).reasons).toContain("STALE_DATA");
  });
  it("respects max open positions", () => {
    expect(preTradeCheck(intent(), ctx({ openPositions: 1 })).approved).toBe(false);
  });
  it("rejects risk above per-trade cap", () => {
    const d = preTradeCheck(intent({ stopPrice: null }), ctx()); // full premium 2000 > 250
    expect(d.reasons.join()).toMatch(/RISK_TOO_HIGH/);
  });
  it("caps risk by remaining daily loss budget", () => {
    const d = preTradeCheck(intent(), ctx({ session: session({ realizedPnlInr: "-850" }) })); // 150 left
    expect(d.approved).toBe(false);
    expect(d.allowedRiskInr).toBe("150.00");
  });
  it("blocks after entry cutoff", () => {
    expect(preTradeCheck(intent(), ctx({ now: new Date("2026-11-09T09:35:00Z") })).approved).toBe(false); // 15:05 IST
  });
  it("blocks option selling and bad lot multiples", () => {
    expect(preTradeCheck(intent({ side: "SELL" }), ctx()).approved).toBe(false);
    expect(preTradeCheck(intent({ quantity: 25 }), ctx()).approved).toBe(false);
  });
  it("allows intraday futures short with stop, blocks delivery short", () => {
    expect(preTradeCheck(intent({ side: "SELL", kind: "FUTURES", limitPrice: "100", stopPrice: "110", quantity: 20 }), ctx()).approved).toBe(true);
    expect(preTradeCheck(intent({ side: "SELL", kind: "EQUITY", product: "CARRY_FORWARD", stopPrice: "110" }), ctx()).approved).toBe(false);
  });
  it("exits are allowed even when session is halted", () => {
    const d = preTradeCheck(intent({ isEntry: false, side: "SELL" }), ctx({ session: session({ realizedPnlInr: "-5000" }) }));
    expect(d.approved).toBe(true);
  });
});

describe("evaluateSessionLimits", () => {
  it("halts at max loss including unrealized", () => {
    expect(evaluateSessionLimits(session({ realizedPnlInr: "-600", unrealizedPnlInr: "-400" }), 3)).toBe("HALTED_LOSS");
  });
  it("unlimited profit never halts on profit", () => {
    expect(evaluateSessionLimits(session({ realizedPnlInr: "999999" }), 3)).toBe("ACTIVE");
  });
  it("halts on profit target when set", () => {
    expect(evaluateSessionLimits(session({ maxProfitInr: "2000", realizedPnlInr: "2000" }), 3)).toBe("HALTED_PROFIT");
  });
  it("halts after consecutive losses", () => {
    expect(evaluateSessionLimits(session({ consecutiveLosses: 3 }), 3)).toBe("HALTED_CONSECUTIVE_LOSSES");
  });
  it("emergency stop is sticky", () => {
    expect(evaluateSessionLimits(session({ status: "EMERGENCY_STOP", realizedPnlInr: "5000" }), 3)).toBe("EMERGENCY_STOP");
  });
});
