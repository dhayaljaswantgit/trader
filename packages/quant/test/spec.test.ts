import { describe, it, expect } from "vitest";
import { runSpecBacktest, JASSU_MARKET_TREND, type StrategySpec, type Bar, type Condition } from "../src/index.ts";

// Build 5-min IST sessions: day(dateIdx, [[o,h,l,c], ...]) starting 09:15
const T = (d: number, k: number) => Date.UTC(2026, 0, 5 + d, 3, 45) / 1000 + k * 300;
const day = (d: number, candles: number[][]): Bar[] => candles.map(([o, h, l, c], k) => ({ t: T(d, k), o: o!, h: h!, l: l!, c: c!, v: 0 }));
const flat = (d: number, px: number, n = 75) => day(d, Array.from({ length: n }, () => [px, px + 1, px - 1, px]));
const cfg = { daily: false, startingCapital: 100000, oosFraction: 0.3 };
const noCost: StrategySpec = { ...JASSU_MARKET_TREND, costs: { perTrade: 0, slippagePoints: 0 }, sizing: { qty: 1, delta: 1 } };
// previous day: green (open 100 → close 110)
const greenDay = (d: number) => day(d, Array.from({ length: 75 }, (_, k) => { const p = 100 + (10 * k) / 74; return [k ? 100 + (10 * (k - 1)) / 74 : 100, p + 0.2, p - 0.2, p]; }));

describe("Strategy Builder engine — Jassu Market Trend", () => {
  it("prev day green + open above prev close → LONG at the open; exits after 2 closes below prev close", () => {
    const today = [[112, 113, 111, 112], [112, 113, 111, 112.5], [112, 112, 108, 109], [109, 110, 107, 108], [108, 109, 107, 108]];
    const bars = [...flat(0, 100, 60), ...greenDay(1), ...day(2, today.concat(Array.from({ length: 70 }, () => [108, 109, 107, 108])))];
    const r = runSpecBacktest(bars, noCost, cfg);
    const t = r.trades.find(x => x.entryTime === T(2, 0))!;
    expect(t.side).toBe("LONG"); expect(t.entry).toBe(112);
    expect(t.exitReason).toBe("EXIT_RULE"); expect(t.exitTime).toBe(T(2, 3)); expect(t.exit).toBe(108); // 2nd close below 110
  });
  it("no trade when prev day green but open is below prev close", () => {
    const bars = [...flat(0, 100, 60), ...greenDay(1), ...day(2, Array.from({ length: 75 }, () => [105, 106, 104, 105]))];
    expect(runSpecBacktest(bars, noCost, cfg).trades.filter(x => x.entryTime >= T(2, 0)).length).toBe(0);
  });
  it("step trailing: +5 points on close moves the stop to entry+1, and the stop then exits", () => {
    const today = [[112, 113, 111, 112], [112, 118, 112, 117.5], [117.5, 118, 112.5, 113], [113, 113, 111, 112]];
    const bars = [...flat(0, 100, 60), ...greenDay(1), ...day(2, today.concat(Array.from({ length: 70 }, () => [112, 112.5, 111.5, 112])))];
    const t = runSpecBacktest(bars, noCost, cfg).trades.find(x => x.entryTime === T(2, 0))!;
    // close 117.5 = +5.5 → stop 113; next candle low 112.5 ≤ 113 → STOP at 113
    expect([t.exitReason, t.exit, t.exitTime]).toEqual(["STOP", 113, T(2, 2)]);
  });
  it("squares off at 15:15 and applies qty × delta and costs", () => {
    const bars = [...flat(0, 100, 60), ...greenDay(1), ...day(2, Array.from({ length: 75 }, () => [112, 112.4, 111.8, 112]))];
    const spec: StrategySpec = { ...JASSU_MARKET_TREND, costs: { perTrade: 60, slippagePoints: 0 }, sizing: { qty: 75, delta: 0.5 }, trailing: { type: "none", every: 5, by: 1 } };
    const t = runSpecBacktest(bars, spec, cfg).trades.find(x => x.entryTime === T(2, 0))!;
    expect(t.exitReason).toBe("SQUARE_OFF"); expect(t.netPnl).toBe(0 * 37.5 - 60);
  });
  it("mirror: prev day red + open below prev close → SHORT (buy put)", () => {
    const redDay = (d: number) => day(d, Array.from({ length: 75 }, (_, k) => { const p = 110 - (10 * k) / 74; return [k ? 110 - (10 * (k - 1)) / 74 : 110, p + 0.2, p - 0.2, p]; }));
    const bars = [...flat(0, 110, 60), ...redDay(1), ...day(2, Array.from({ length: 75 }, () => [97, 97.5, 96.5, 97]))];
    const t = runSpecBacktest(bars, noCost, cfg).trades.find(x => x.entryTime === T(2, 0))!;
    expect(t.side).toBe("SHORT"); expect(t.entry).toBe(97);
  });
  it("bar-close entries never look ahead (result unchanged when future candles are removed)", () => {
    const spec: StrategySpec = { ...noCost, entryMode: "barClose",
      long: { enabled: true, entry: [{ t: "compare", a: { k: "price", f: "close" }, op: "crossAbove", b: { k: "ema", n: 5 } }], exit: [{ t: "candle", color: "red", n: 2 }] },
      short: { enabled: false, entry: [], exit: [] } };
    let s = 3; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const bars: Bar[] = []; let px = 100;
    for (let d = 0; d < 6; d++) for (let k = 0; k < 75; k++) { const o = px, c = o + (rnd() - 0.5) * 2; bars.push({ t: T(d, k), o, h: Math.max(o, c) + rnd(), l: Math.min(o, c) - rnd(), c, v: 0 }); px = c; }
    const full = runSpecBacktest(bars, spec, cfg).trades, cut = runSpecBacktest(bars.slice(0, 300), spec, cfg).trades;
    const done = cut.filter(t => t.exitReason !== "END_OF_DATA");
    expect(full.slice(0, done.length)).toEqual(done.map(t => ({ ...t, sample: full.find(f => f.entryTime === t.entryTime)!.sample })));
  });
});

describe("pivot stops", () => {
  it("swing pivots are only used after they are confirmed (no look-ahead)", () => {
    let s = 9; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const bars: Bar[] = []; let px = 100;
    for (let d = 0; d < 6; d++) for (let k = 0; k < 75; k++) { const o = px, c = o + (rnd() - 0.48) * 3; bars.push({ t: T(d, k), o, h: Math.max(o, c) + rnd(), l: Math.min(o, c) - rnd(), c, v: 0 }); px = c; }
    const spec: StrategySpec = { ...noCost, entryMode: "barClose", stop: { type: "pivot", value: 0.5 }, trailing: { type: "pivot", every: 0, by: 0.5, k: 3 },
      long: { enabled: true, entry: [{ t: "compare", a: { k: "price", f: "close" }, op: "crossAbove", b: { k: "ema", n: 9 } }], exit: [] }, short: { enabled: false, entry: [], exit: [] } };
    const full = runSpecBacktest(bars, spec, cfg).trades, cut = runSpecBacktest(bars.slice(0, 260), spec, cfg).trades.filter(t => t.exitReason !== "END_OF_DATA");
    expect(cut.length).toBeGreaterThan(2);
    expect(full.slice(0, cut.length).map(t => [t.entryTime, t.exitTime, t.exit])).toEqual(cut.map(t => [t.entryTime, t.exitTime, t.exit]));
    for (const t of full) if (t.exitReason === "STOP") expect(t.exit).toBeLessThan(t.entry + 1000);
  });
});

describe("trading windows", () => {
  const spec = (exit: boolean): StrategySpec => ({ ...noCost, entryMode: "barClose", stop: { type: "none", value: 0 }, trailing: { type: "none", every: 5, by: 1 },
    long: { enabled: true, entry: [{ t: "candle", color: "green", n: 1 }], exit: [] }, short: { enabled: false, entry: [], exit: [] },
    session: { squareOff: "15:15", noEntryAfter: "15:00", maxTradesPerDay: 5, windows: [{ from: "09:15", to: "10:00" }, { from: "13:55", to: "15:15" }], exitAtWindowEnd: exit } });
  const bars = day(0, Array.from({ length: 75 }, (_, k) => [100 + k, 101.5 + k, 99.5 + k, 101 + k])); // every candle green
  const mins = (t: number) => (((t + 19800) % 86400) / 60) | 0;
  it("enters only inside the windows", () => {
    const tr = runSpecBacktest(bars, spec(false), cfg).trades;
    expect(tr.length).toBeGreaterThan(0);
    for (const t of tr) { const m = mins(t.entryTime); expect((m >= 555 && m <= 600) || (m >= 835 && m <= 915)).toBe(true); }
  });
  it("exitAtWindowEnd closes the trade when its window ends", () => {
    const first = runSpecBacktest(bars, spec(true), cfg).trades[0]!;
    expect(first.exitReason).toBe("WINDOW_END"); expect(mins(first.exitTime) + 5).toBeGreaterThan(600);
  });
});

describe("position sizing", () => {
  const bars = [...flat(0, 100, 60), ...greenDay(1), ...day(2, Array.from({ length: 75 }, (_, k) => [112 + k * 0.1, 112.5 + k * 0.1, 111.9 + k * 0.1, 112.1 + k * 0.1]))];
  const base: StrategySpec = { ...noCost, trailing: { type: "none", every: 5, by: 1 }, sizing: { qty: 75, delta: 0.5 }, costs: { perTrade: 60, slippagePoints: 0, perExtraLot: 15 } };
  const run = (sp: StrategySpec, cap: number) => runSpecBacktest(bars, sp, { daily: false, startingCapital: cap, oosFraction: 0.3 }).trades.find(t => t.entryTime === T(2, 0))!;
  it("fixed: same P&L whatever the capital (when affordable)", () => {
    expect(run(base, 100000).netPnl).toBe(run(base, 1300000).netPnl);
  });
  it("fixed lots are capped by what the capital can pay for", () => {
    const sp: StrategySpec = { ...base, sizing: { ...base.sizing, mode: "fixed", lots: 1000, capitalPerLot: 15000 } };
    expect(run(sp, 100000).qty).toBe(6 * 75);  // ₹1L ÷ ₹15k = 6 lots, not 1000
    const r = runSpecBacktest(bars, sp, { daily: false, startingCapital: 100000, oosFraction: 0.3 });
    expect(r.assumptions.some(a => a.includes("FEWER lots"))).toBe(true);
  });
  it("capital mode: lots = capital ÷ ₹ per lot, P&L and charges scale", () => {
    const sp: StrategySpec = { ...base, sizing: { ...base.sizing, mode: "capital", capitalPerLot: 15000 } };
    const a = run(sp, 100000), b = run(sp, 1300000);
    expect(a.qty).toBe(6 * 75); expect(b.qty).toBe(20 * 75); // 86 affordable, capped at the default 20 lots
    expect(b.grossPnl / a.grossPnl).toBeCloseTo(20 / 6, 6);
    const c = run({ ...sp, sizing: { ...sp.sizing, maxLots: 100 } }, 1300000); expect(c.qty).toBe(86 * 75);
    expect(a.charges).toBe(60 + 5 * 15);
  });
  it("risk mode: lots so a stop hit ≈ risk% of capital, capped by capital", () => {
    const sp: StrategySpec = { ...base, stop: { type: "points", value: 20 }, sizing: { ...base.sizing, mode: "risk", riskPct: 1, capitalPerLot: 15000 } };
    // 1% of 1,00,000 = 1000 ÷ (20 pts × 0.5 × 75 = 750 per lot) → 1 lot
    expect(run(sp, 100000).qty).toBe(75);
    // 1% of 13,00,000 = 13000 ÷ 750 → 17 lots (capital allows 86)
    expect(run(sp, 1300000).qty).toBe(17 * 75);
  });
  it("skips a trade when capital can't afford one lot", () => {
    const sp: StrategySpec = { ...base, sizing: { ...base.sizing, mode: "capital", capitalPerLot: 15000 } };
    expect(runSpecBacktest(bars, sp, { daily: false, startingCapital: 10000, oosFraction: 0.3 }).trades.length).toBe(0);
  });
});

import { liveEntrySignal, liveManage } from "../src/index.ts";
describe("live trading = backtest (parity)", () => {
  it("stepping candle by candle gives the same entries and exits as the backtest", () => {
    let s = 21; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const bars: Bar[] = []; let px = 100;
    for (let d = 0; d < 8; d++) for (let k = 0; k < 75; k++) { const o = px, c = o + (rnd() - 0.48) * 2.5; bars.push({ t: T(d, k), o, h: Math.max(o, c) + rnd(), l: Math.min(o, c) - rnd(), c, v: 0 }); px = c; }
    const spec: StrategySpec = { ...noCost, entryMode: "barClose", stop: { type: "pivot", value: 0.5 }, trailing: { type: "pivot", every: 0, by: 0.5, k: 3 },
      long: { enabled: true, entry: [{ t: "compare", a: { k: "price", f: "close" }, op: "crossAbove", b: { k: "ema", n: 9 } }], exit: [{ t: "candle", color: "red", n: 3 }] },
      short: { enabled: true, entry: [{ t: "compare", a: { k: "price", f: "close" }, op: "crossBelow", b: { k: "ema", n: 9 } }], exit: [{ t: "candle", color: "green", n: 3 }] },
      session: { squareOff: "15:15", noEntryAfter: "14:45", maxTradesPerDay: 99 } };
    const bt = runSpecBacktest(bars, spec, cfg).trades.filter(t => t.exitReason !== "END_OF_DATA" && t.exitReason !== "SESSION_END");
    // live replay
    const live: Array<{ side: string; entryTime: number; exitTime: number; reason: string }> = [];
    let pos: { dir: 1 | -1; entry: number; stop: number | null; target: number | null; entryT: number } | null = null;
    for (let i = 1; i < bars.length - 1; i++) {
      const seen = bars.slice(0, i + 1);           // candles completed so far
      if (pos) {
        const m = liveManage(seen, spec, pos);
        if (m.exit) { live.push({ side: pos.dir === 1 ? "LONG" : "SHORT", entryTime: pos.entryT, exitTime: bars[i]!.t, reason: m.exit }); pos = null; }
      }
      if (!pos) {
        const sig = liveEntrySignal(seen, spec);
        if (sig && (((bars[i + 1]!.t + 19800) / 86400) | 0) === (((bars[i]!.t + 19800) / 86400) | 0)) {
          const e = bars[i + 1]!.o; // filled at the next candle's open, like the backtest
          const st = sig.stop == null ? null : sig.stopIsLevel ? sig.stop : e - (sig.entry - sig.stop);
          pos = { dir: sig.dir, entry: e, stop: st, target: null, entryT: bars[i + 1]!.t };
        }
      }
    }
    expect(live.length).toBeGreaterThan(5);
    const n = Math.min(live.length, bt.length);
    expect(live.slice(0, n).map(t => [t.side, t.entryTime, t.exitTime])).toEqual(bt.slice(0, n).map(t => [t.side, t.entryTime, t.exitTime]));
  });
});

import { cryptoSpec, runBacktest, dayContext, orderCharges } from "../src/index.ts";
describe("crypto (24x7) mode", () => {
  // 24h of 5-min candles per IST day, starting 00:00 IST, steady uptrend
  const D0 = Date.UTC(2026, 0, 4, 18, 30) / 1000; // 00:00 IST
  const bars: Bar[] = Array.from({ length: 288 * 3 }, (_, k) => ({ t: D0 + k * 300, o: 60000 + k * 5, h: 60008 + k * 5, l: 59998 + k * 5, c: 60005 + k * 5, v: 10 }));
  const always: Condition = { t: "compare", a: { k: "value", v: 1 }, op: ">", b: { k: "value", v: 0 } };
  const base: StrategySpec = { ...noCost, entryMode: "barClose", long: { enabled: true, entry: [always], exit: [] }, short: { enabled: false, entry: [], exit: [] },
    stop: { type: "points", value: 500 }, trailing: { type: "none", every: 5, by: 1 }, session: { squareOff: "15:15", noEntryAfter: "14:45", maxTradesPerDay: 1 } };
  it("no 15:15 square-off and no forced close at day change", () => {
    const t = runSpecBacktest(bars, base, { daily: false, startingCapital: 1e6, oosFraction: 0.3, market: "CRYPTO" }).trades[0]!;
    expect(t.exitReason).toBe("END_OF_DATA");            // held across midnights
    const nse = runSpecBacktest(bars, base, { daily: false, startingCapital: 1e6, oosFraction: 0.3 }).trades[0]!;
    expect(["SQUARE_OFF", "SESSION_END"]).toContain(nse.exitReason);
  });
  it("cryptoSpec: 1 lot = 1 contract, delta 1, margin by leverage, fees as % of notional", () => {
    const sp = cryptoSpec({ ...base, sizing: { qty: 75, delta: 0.5, mode: "fixed", lots: 10 } }, { contractValue: 0.001, refPrice: 60000, leverage: 10, takerFee: 0.0005 });
    expect(sp.sizing).toMatchObject({ qty: 0.001, delta: 1, capitalPerLot: 6 });
    const t = runSpecBacktest(bars, sp, { daily: false, startingCapital: 1e6, oosFraction: 0.3, market: "CRYPTO" }).trades[0]!;
    const notional = (t.entry + t.exit) * 0.001 * 10;
    expect(t.charges).toBeCloseTo(notional * 0.05 * 1.18 / 100, 2);
    expect(t.grossPnl).toBeCloseTo((t.exit - t.entry) * 0.001 * 10, 2);
  });
  it("opening range starts at the day's first candle (00:00 for crypto, 09:15 for NSE)", () => {
    const ctx = dayContext(bars, 300, [15]);
    expect(ctx.or[15]!.hi[1]).toBeNull(); expect(ctx.or[15]!.hi[2]).toBe(Math.max(bars[0]!.h, bars[1]!.h, bars[2]!.h)); // 00:00–00:15
  });
  it("built-in backtester: CRYPTO_PERP fee model and 24x7 holding", () => {
    expect(orderCharges("CRYPTO_PERP", "BUY", 100000)).toBeCloseTo(100000 * 0.0005 * 1.18, 2);
    const r = runBacktest(bars, { strategyId: "supertrend-10-3", daily: false, startingCapital: 1e6, riskPerTradePct: 1, slippageBps: 2, product: "CRYPTO_PERP", allowShort: true,
      squareOffIst: "15:15", maxHoldBars: 1000, lotSize: 0.001, oosFraction: 0.3, market: "CRYPTO" });
    expect(r.trades.every(t => t.exitReason !== "SQUARE_OFF" && t.exitReason !== "SESSION_END")).toBe(true);
  });
});
