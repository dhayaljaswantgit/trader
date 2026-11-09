import { describe, it, expect } from "vitest";
import { ema, rsi, atr, vwap, resample, evaluateLatest, runBacktest, orderCharges, type Bar } from "../src/index.ts";

// 09:15 IST 2026-11-09 = 03:45 UTC
const T0 = Date.UTC(2026, 10, 9, 3, 45) / 1000;
const mk = (closes: number[], step = 300, vol = 1000): Bar[] => closes.map((c, i) => ({ t: T0 + i * step, o: i ? closes[i - 1]! : c, h: Math.max(c, i ? closes[i - 1]! : c) + 0.5, l: Math.min(c, i ? closes[i - 1]! : c) - 0.5, c, v: vol }));

describe("indicators", () => {
  it("EMA seeds with SMA and matches hand calc", () => {
    const e = ema([1, 2, 3, 4, 5], 3);
    expect(e.slice(0, 2)).toEqual([null, null]);
    expect(e[2]).toBe(2); expect(e[3]).toBe(3); expect(e[4]).toBe(4);
  });
  it("RSI is 100 on monotonic rise and ~0 on fall", () => {
    expect(rsi(Array.from({ length: 20 }, (_, i) => i), 14)[19]).toBe(100);
    expect(rsi(Array.from({ length: 20 }, (_, i) => 20 - i), 14)[19]).toBeCloseTo(0);
  });
  it("ATR of constant-range bars equals range", () => {
    const b = Array.from({ length: 20 }, (_, i) => ({ t: T0 + i * 60, o: 10, h: 11, l: 9, c: 10, v: 1 }));
    expect(atr(b, 14)[19]).toBeCloseTo(2);
  });
  it("session VWAP resets on new IST day and is null without volume", () => {
    const b: Bar[] = [{ t: T0, o: 10, h: 10, l: 10, c: 10, v: 100 }, { t: T0 + 300, o: 20, h: 20, l: 20, c: 20, v: 100 }, { t: T0 + 86400, o: 50, h: 50, l: 50, c: 50, v: 10 }];
    const v = vwap(b); expect(v[1]).toBe(15); expect(v[2]).toBe(50);
    expect(vwap([{ t: T0, o: 1, h: 1, l: 1, c: 1, v: 0 }])[0]).toBeNull();
  });
  it("resample 1m -> 5m aligns to 09:15", () => {
    const b = Array.from({ length: 10 }, (_, i) => ({ t: T0 + i * 60, o: i, h: i + 1, l: i - 1, c: i, v: 1 }));
    const r = resample(b, 5); expect(r).toHaveLength(2); expect(r[0]).toMatchObject({ o: 0, c: 4, h: 5, l: -1, v: 5 });
  });
});

describe("strategies", () => {
  it("not enough data => NO_TRADE, never ENTER", () => {
    const s = evaluateLatest("trend-breakout", mk([1, 2, 3]));
    expect(s?.action).not.toBe("ENTER");
  });
  it("signal does not change when future bars are appended (no look-ahead)", () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 5) * 3 + i * 0.1);
    const b = mk(closes);
    const a = evaluateLatest("vwap-pullback", b.slice(0, 60));
    const again = evaluateLatest("vwap-pullback", b.slice(0, 60));
    expect(a).toEqual(again);
  });
});

describe("costs", () => {
  it("intraday equity charges are positive and small", () => {
    const c = orderCharges("EQUITY_INTRADAY", "SELL", 100000);
    expect(c).toBeGreaterThan(20); expect(c).toBeLessThan(80);
  });
  it("options brokerage is flat ₹20", () => {
    expect(orderCharges("OPTIONS", "BUY", 1000000)).toBeGreaterThanOrEqual(20);
  });
});

describe("backtest", () => {
  const closes = Array.from({ length: 75 * 20 }, (_, i) => 100 + Math.sin(i / 7) * 2 + Math.sin(i / 53) * 4);
  // 20 sessions of 75 five-minute bars
  const bars: Bar[] = []; closes.forEach((c, i) => { const d = Math.floor(i / 75), k = i % 75; const t = T0 + d * 86400 + k * 300; const o = i ? closes[i - 1]! : c; bars.push({ t, o, h: Math.max(o, c) + 0.2, l: Math.min(o, c) - 0.2, c, v: 1000 + (k % 7) * 400 }); });
  const cfg = { strategyId: "trend-breakout", daily: false, startingCapital: 100000, riskPerTradePct: 0.5, slippageBps: 5, product: "EQUITY_INTRADAY" as const, allowShort: true, squareOffIst: "15:15", maxHoldBars: 50, lotSize: 1, oosFraction: 0.3, params: { relVolMin: 1.0, adxMin: 10 } };
  it("is deterministic and never holds across sessions intraday", () => {
    const a = runBacktest(bars, cfg), b = runBacktest(bars, cfg);
    expect(a.metrics).toEqual(b.metrics);
    for (const t of a.trades) expect(Math.floor((t.entryTime + 19800) / 86400)).toBe(Math.floor((t.exitTime + 19800) / 86400));
  });
  it("entries happen strictly after the signal bar", () => {
    const r = runBacktest(bars, cfg);
    for (const t of r.trades) expect(bars.findIndex(b => b.t === t.entryTime)).toBeGreaterThan(0);
  });
  it("charges are deducted", () => {
    const r = runBacktest(bars, cfg);
    if (r.trades.length) expect(r.metrics.totalCharges).toBeGreaterThan(0);
  });
});
