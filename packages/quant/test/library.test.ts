import { describe, it, expect } from "vitest";
import { LIBRARY, STRATEGIES, DEFAULT_PARAMS, runBacktest, dayContext, supertrend, type Bar } from "../src/index.ts";

// Deterministic synthetic NSE-like 5-min session data: 12 days × 75 bars, 09:15–15:30 IST, with gaps and trends.
function synth(days = 12, seed = 7, withVolume = true): Bar[] {
  let s = seed; const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const out: Bar[] = []; let px = 1000;
  for (let d = 0; d < days; d++) {
    const t0 = Date.UTC(2026, 9, 1 + d, 3, 45) / 1000; px *= 1 + (r() - 0.5) * 0.02; // overnight gap
    const drift = (r() - 0.5) * 0.002;
    for (let k = 0; k < 75; k++) {
      const o = px, c = o * (1 + drift + (r() - 0.5) * 0.006);
      out.push({ t: t0 + k * 300, o, h: Math.max(o, c) * (1 + r() * 0.002), l: Math.min(o, c) * (1 - r() * 0.002), c, v: withVolume ? Math.round(1000 + r() * 4000) : 0 });
      px = c;
    }
  }
  return out;
}

describe("strategy library", () => {
  it("has 75 uniquely-identified strategies registered in STRATEGIES", () => {
    expect(LIBRARY.length).toBe(75);
    expect(Object.keys(STRATEGIES).length).toBe(81);
    expect(new Set(LIBRARY.map(s => s.id)).size).toBe(75);
    for (const s of LIBRARY) expect(STRATEGIES[s.id]?.name).toBe(s.name);
  });

  it("never looks ahead: a signal at bar i is identical with or without later bars", () => {
    const bars = synth();
    for (const s of LIBRARY) {
      for (let i = 80; i < bars.length - 1; i += 7) {
        const full = s.evaluate(bars, i, null, DEFAULT_PARAMS, false);
        const cut = s.evaluate(bars.slice(0, i + 1), i, null, DEFAULT_PARAMS, false);
        expect({ id: s.id, i, a: cut.action, d: cut.direction, st: cut.stop }).toEqual({ id: s.id, i, a: full.action, d: full.direction, st: full.stop });
      }
    }
   }, 30000);

  it("every ENTER has a stop on the correct side and a target at the strategy's reward:risk", () => {
    const bars = synth(20, 11);
    let enters = 0;
    for (const s of LIBRARY) for (let i = 60; i < bars.length; i++) {
      const g = s.evaluate(bars, i, null, DEFAULT_PARAMS, false); if (g.action !== "ENTER") continue; enters++;
      const risk = g.direction === "BULLISH" ? g.entry! - g.stop! : g.stop! - g.entry!;
      expect(risk).toBeGreaterThan(0);
      expect(Math.abs(g.target! - g.entry!) / risk).toBeCloseTo(s.rr, 6);
    }
    expect(enters).toBeGreaterThan(200); // the library actually fires on realistic data
  });

  it("volume strategies stay silent on a volume-less index, intraday-only ones on daily bars", () => {
    const idx = synth(12, 3, false);
    for (const s of LIBRARY.filter(x => x.needsVolume)) for (let i = 60; i < idx.length; i++) expect(s.evaluate(idx, i, null, DEFAULT_PARAMS, false).action).not.toBe("ENTER");
    for (const s of LIBRARY.filter(x => x.intradayOnly)) expect(s.evaluate(idx, idx.length - 1, null, DEFAULT_PARAMS, true).action).toBe("NO_TRADE");
  });

  it("opening range is only known after it completes", () => {
    const bars = synth(2), ctx = dayContext(bars, 300);
    const day2 = 75; // 09:15 bar of day 2
    expect(ctx.or[15]!.hi[day2 + 1]).toBeNull();        // 09:20 close: range still forming
    expect(ctx.or[15]!.hi[day2 + 2]).toBe(Math.max(bars[day2]!.h, bars[day2 + 1]!.h, bars[day2 + 2]!.h)); // 09:30 close
    expect(ctx.prevH[day2]).toBe(Math.max(...bars.slice(0, 75).map(b => b.h)));
  });

  it("supertrend stays below price in an uptrend", () => {
    const up: Bar[] = Array.from({ length: 60 }, (_, i) => ({ t: i * 300, o: 100 + i, h: 101.5 + i, l: 99.5 + i, c: 101 + i, v: 1 }));
    const st = supertrend(up, 10, 3);
    expect(st.dir[59]).toBe(1); expect(st.line[59]!).toBeLessThan(up[59]!.c);
  });

  it("backtests every library strategy end-to-end without errors", () => {
    const bars = synth(20, 5);
    for (const s of LIBRARY) {
      const r = runBacktest(bars, { strategyId: s.id, daily: false, startingCapital: 100000, riskPerTradePct: 0.5, slippageBps: 5, product: "EQUITY_INTRADAY",
        allowShort: true, squareOffIst: "15:15", maxHoldBars: 60, lotSize: 1, oosFraction: 0.3 });
      expect(Number.isFinite(r.metrics.netPnl)).toBe(true);
    }
  });
});
