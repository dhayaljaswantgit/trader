import { describe, it, expect } from "vitest";
import { STRATEGIES, runBacktest, type Bar } from "../src/index.ts";

const day = (k: number, o: number, c: number): Bar => ({ t: Date.UTC(2025, 0, 1) / 1000 + k * 86400, o, h: Math.max(o, c) + 1, l: Math.min(o, c) - 1, c, v: 0 });
const cfg = { strategyId: "nifty-overnight-momentum", daily: true, startingCapital: 100000, riskPerTradePct: 0.5, slippageBps: 0, product: "FUTURES" as const,
  allowShort: true, squareOffIst: "15:15", maxHoldBars: 15, lotSize: 1, oosFraction: 0.3 };

describe("NIFTY Overnight Momentum", () => {
  it("is registered as a daily, close-entry, full-capital strategy", () => {
    const s = STRATEGIES["nifty-overnight-momentum"]!;
    expect([s.dailyOnly, s.entryAtClose, s.fullCapital, s.maxHoldBars]).toEqual([true, true, true, 1]);
  });
  it("buys at the close of a ≥0.5% up-day and sells at the next open", () => {
    // day 1: +1% up-day (signal) → buy at its close 101; day 2 opens at 102 → exit 102
    const bars: Bar[] = []; for (let k = 0; k < 60; k++) bars.push(day(k, 100, 100.1)); // flat filler (no signal)
    bars.push(day(60, 100, 101)); bars.push(day(61, 102, 102.1)); bars.push(day(62, 102.1, 102.2));
    const r = runBacktest(bars, cfg);
    expect(r.trades.length).toBe(1);
    const t = r.trades[0]!;
    expect([t.entry, t.exit, t.exitReason, t.side]).toEqual([101, 102, "EXIT_RULE", "LONG"]);
    expect(t.qty).toBe(Math.floor(100000 / 101)); // full capital
    expect(t.entryTime).toBe(bars[60]!.t); expect(t.exitTime).toBe(bars[61]!.t);
  });
  it("takes no trade on days below the 0.5% threshold", () => {
    const bars: Bar[] = []; for (let k = 0; k < 80; k++) bars.push(day(k, 100, 100.4));
    expect(runBacktest(bars, cfg).trades.length).toBe(0);
  });
  it("a big overnight gap down hits the 2% stop at the open", () => {
    const bars: Bar[] = []; for (let k = 0; k < 60; k++) bars.push(day(k, 100, 100.1));
    bars.push(day(60, 100, 101)); bars.push(day(61, 97, 98)); bars.push(day(62, 98, 98));
    const t = runBacktest(bars, cfg).trades[0]!;
    expect(t.exit).toBe(97); expect(t.exitReason).toBe("EXIT_RULE"); // exit rule fires at the open first; fill is the gapped open
  });
});
