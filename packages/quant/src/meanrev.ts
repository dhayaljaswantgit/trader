/**
 * Daily mean-reversion strategies (buy the dip in an uptrend, sell the bounce).
 *
 * Research (10y daily, 12 NSE instruments, design on first 70%, tested on unseen last 30%, 0.10% costs,
 * 3-ATR safety stop, 15-day max hold) — see the leaderboard's Daily run for the in-app numbers:
 *   IBS < 0.2      win 64% → 65%, PF 1.26 → 1.29   (random long entries, same hold: PF 1.11 → 1.04)
 *   3 down days    win 61% → 61%, PF 1.25 → 1.20   (random: PF 1.00 → 0.95)
 *   BB to mid      win 64% → 64%, PF 1.08 → 1.20   (random: PF 1.29 → 1.21 for its longer hold)
 * Parameters are the textbook ones and were NOT tuned on this data. Long-only (cash delivery can't be shorted overnight).
 * Exits are rule-based (evaluated on the close, filled at the next open), plus the 3-ATR stop and the max-hold time stop.
 */
import { type Bar } from "./types.ts";
import { atr, rsi, sma, type Series } from "./indicators.ts";
import { stdev } from "./ta.ts";
import { finish, type Check, type StrategySignal } from "./signal.ts";

interface MrCtx { c: number[]; atr: Series; sma200: Series; sma5: Series; sma20: Series; sd20: Series; rsi2: Series; n: number; lastT: number }
const cache = new WeakMap<Bar[], MrCtx>();
function ctx(b: Bar[]): MrCtx {
  const last = b[b.length - 1]?.t ?? 0; let x = cache.get(b);
  if (!x || x.n !== b.length || x.lastT !== last) {
    const c = b.map(y => y.c);
    x = { c, atr: atr(b, 14), sma200: sma(c, 200), sma5: sma(c, 5), sma20: sma(c, 20), sd20: stdev(c, 20), rsi2: rsi(c, 2), n: b.length, lastT: last };
    cache.set(b, x);
  }
  return x;
}
const ibs = (x: Bar) => x.h > x.l ? (x.c - x.l) / (x.h - x.l) : 0.5;
const f2 = (n: number) => n.toFixed(2);

interface MrDef {
  id: string; name: string; description: string;
  setup: (b: Bar[], i: number, x: MrCtx) => string | null;   // reason when the dip condition holds
  exit: (b: Bar[], i: number, x: MrCtx) => string | null;    // reason when the bounce exit holds
}
const DEFS: MrDef[] = [
  { id: "mr-ibs", name: "IBS dip buy (daily)",
    description: "Daily, long-only: in an uptrend (close > SMA 200), buy when the day closes in the bottom 20% of its range (IBS < 0.2). Exit when IBS > 0.8 or the close beats yesterday's high. 3-ATR safety stop.",
    setup: (b, i) => { const v = ibs(b[i]!); return v < 0.2 ? `IBS ${f2(v)} < 0.2 (closed near the day's low)` : null; },
    exit: (b, i) => { const v = ibs(b[i]!); return v > 0.8 ? `IBS ${f2(v)} > 0.8` : b[i]!.c > b[i - 1]!.h ? "close above yesterday's high" : null; } },
  { id: "mr-3down", name: "3 down days (daily)",
    description: "Daily, long-only: in an uptrend (close > SMA 200), buy after three consecutive lower closes. Exit on the first higher close. 3-ATR safety stop.",
    setup: (_b, i, x) => x.c[i]! < x.c[i - 1]! && x.c[i - 1]! < x.c[i - 2]! && x.c[i - 2]! < x.c[i - 3]! ? "three lower closes in a row" : null,
    exit: (_b, i, x) => x.c[i]! > x.c[i - 1]! ? "first higher close" : null },
  { id: "mr-bb-mid", name: "Bollinger dip to middle (daily)",
    description: "Daily, long-only: in an uptrend (close > SMA 200), buy a close below the lower Bollinger band (20, 2). Exit when the close is back above the 20-day average. 3-ATR safety stop.",
    setup: (_b, i, x) => { const m = x.sma20[i], s = x.sd20[i]; return m != null && s != null && x.c[i]! < m - 2 * s ? `close ${f2(x.c[i]!)} below lower band ${f2(m - 2 * s)}` : null; },
    exit: (_b, i, x) => { const m = x.sma20[i]; return m != null && x.c[i]! > m ? `back above 20-day average ${f2(m)}` : null; } },
];

export interface MeanRevStrategy {
  id: string; name: string; description: string;
  evaluate: (b: Bar[], i: number, _pc: unknown, _p: unknown, daily: boolean) => StrategySignal;
  /** Rule exit, evaluated on the CLOSE of bar i; the position is closed at the next bar's open. */
  exitRule: (b: Bar[], i: number, side: "LONG" | "SHORT") => string | null;
}

export const MEAN_REVERSION: MeanRevStrategy[] = DEFS.map(d => ({
  id: d.id, name: d.name, description: d.description,
  exitRule: (b, i, side) => side === "LONG" && i >= 1 ? d.exit(b, i, ctx(b)) : null,
  evaluate: (b, i, _pc, _p, daily) => {
    const bar = b[i]!, x = ctx(b), checks: Check[] = [], a = x.atr[i], s200 = x.sma200[i];
    checks.push({ name: "Daily candles", pass: daily, detail: daily ? "daily" : "designed for daily bars — use the Daily timeframe" });
    const warm = s200 != null && a != null && i >= 3;
    checks.push({ name: "Enough history (200 days)", pass: warm, detail: warm ? "ok" : "needs 200 daily bars" });
    if (!daily || !warm) return finish(d.id, bar, "NEUTRAL", checks, null, null, 1);
    checks.push({ name: "Uptrend (close > SMA 200)", pass: bar.c > s200!, detail: `close ${f2(bar.c)} / SMA200 ${f2(s200!)}` });
    const why = d.setup(b, i, x);
    checks.push({ name: `Setup: ${d.name}`, pass: !!why, detail: why ?? "condition not met" });
    if (!why || bar.c <= s200!) return finish(d.id, bar, why ? "BULLISH" : "NEUTRAL", checks, null, null, 1);
    const sig = finish(d.id, bar, "BULLISH", checks, bar.c, bar.c - 3 * a!, 1);
    return { ...sig, target: null }; // no fixed target: exits on the rule above
  },
}));
