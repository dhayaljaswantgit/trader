import { describe, it, expect } from "vitest";
import { MEAN_REVERSION, STRATEGIES, runBacktest, type Bar } from "../src/index.ts";

// 400 daily bars: steady uptrend with periodic 3-day dips (so SMA200 is below price and dips occur)
function daily(): Bar[] {
  const out: Bar[] = []; let px = 100;
  for (let i = 0; i < 400; i++) {
    const dip = i % 20 >= 15 && i % 20 < 18, o = px, c = dip ? o * 0.985 : o * 1.006;
    out.push({ t: Date.UTC(2024, 0, 1) / 1000 + i * 86400, o, h: Math.max(o, c) * 1.003, l: Math.min(o, c) * (dip ? 0.999 : 0.997), c, v: 1000 });
    px = c;
  }
  return out;
}
const cfg = (id: string) => ({ strategyId: id, daily: true, startingCapital: 100000, riskPerTradePct: 1, slippageBps: 0, product: "EQUITY_DELIVERY" as const,
  allowShort: false, squareOffIst: "15:15", maxHoldBars: 15, lotSize: 1, oosFraction: 0.3 });

describe("daily mean reversion", () => {
  it("registers 3 daily-only strategies with exit rules", () => {
    expect(MEAN_REVERSION.length).toBe(3);
    for (const s of MEAN_REVERSION) { expect(STRATEGIES[s.id]?.dailyOnly).toBe(true); expect(STRATEGIES[s.id]?.exitRule).toBeTypeOf("function"); }
  });
  it("buys dips in an uptrend, long-only, with no fixed target", () => {
    const b = daily(); const s = STRATEGIES["mr-3down"]!;
    const i = b.findIndex((_, k) => k > 220 && s.evaluate(b, k, null as never, {} as never, true).action === "ENTER");
    const g = s.evaluate(b, i, null as never, {} as never, true);
    expect(g.direction).toBe("BULLISH"); expect(g.target).toBeNull(); expect(g.stop!).toBeLessThan(g.entry!);
  });
  it("exits on the rule at the next open (not at a target)", () => {
    const r = runBacktest(daily(), cfg("mr-3down"));
    expect(r.trades.length).toBeGreaterThan(3);
    expect(r.trades.every(t => t.side === "LONG")).toBe(true);
    expect(r.trades.filter(t => t.exitReason === "EXIT_RULE").length).toBeGreaterThan(0);
    expect(r.trades.some(t => t.exitReason === "TARGET")).toBe(false);
  });
  it("never looks ahead", () => {
    const b = daily();
    for (const s of MEAN_REVERSION) for (let i = 210; i < b.length - 1; i += 3) {
      const a = s.evaluate(b, i, null, null, true), c = s.evaluate(b.slice(0, i + 1), i, null, null, true);
      expect([c.action, c.stop]).toEqual([a.action, a.stop]);
      expect(s.exitRule(b.slice(0, i + 1), i, "LONG")).toEqual(s.exitRule(b, i, "LONG"));
    }
  });
  it("stays silent on intraday bars", () => {
    const b = daily(); for (const s of MEAN_REVERSION) expect(s.evaluate(b, 300, null, null, false).action).toBe("NO_TRADE");
  });
});
