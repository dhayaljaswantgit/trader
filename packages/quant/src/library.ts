/**
 * Intraday strategy library — well-known, rule-based setups popular with Indian (NSE) intraday traders.
 *
 * Every strategy is evaluated on the CLOSED bar i only (entry assumed at the next bar's open), returns an
 * explainable signal, and defines its own stop and reward:risk. Nothing here is fitted to data; parameters
 * are the textbook defaults. Use the leaderboard backtest (in- vs out-of-sample) before trusting any of them.
 */
import { type Bar } from "./types.ts";
import { adx, atr, ema, rsi, sma, type Series } from "./indicators.ts";
import * as ta from "./ta.ts";
import { barSeconds, finish, type Check, type StrategySignal } from "./signal.ts";
import type { StrategyParams } from "./strategies.ts";

type D = 1 | -1;
interface Trig { dir: D; stop: number; why: string }

/** Per-bar-array cache: indicators are computed once and shared by every strategy evaluating the same bars. */
class Ctx {
  readonly c: number[]; readonly h: number[]; readonly l: number[]; readonly o: number[]; readonly v: number[];
  readonly atr: Series; readonly avgVol: Series; readonly hasVolume: boolean; readonly day: ta.DayContext | null;
  private memo = new Map<string, unknown>();
  constructor(readonly b: Bar[], readonly daily: boolean, readonly n: number, readonly lastT: number) {
    this.c = b.map(x => x.c); this.h = b.map(x => x.h); this.l = b.map(x => x.l); this.o = b.map(x => x.o); this.v = b.map(x => x.v);
    this.atr = atr(b, 14); this.avgVol = sma(this.v, 20); this.hasVolume = this.v.some(x => x > 0);
    this.day = daily ? null : ta.dayContext(b, barSeconds(b));
  }
  m<T>(k: string, f: () => T): T { if (!this.memo.has(k)) this.memo.set(k, f()); return this.memo.get(k) as T; }
  ema(n: number) { return this.m(`ema${n}`, () => ema(this.c, n)); }
  rsi(n: number) { return this.m(`rsi${n}`, () => rsi(this.c, n)); }
  adx() { return this.m("adx", () => adx(this.b, 14)); }
  vw() { return this.m("vwb", () => ta.vwapBands(this.b)); }
  st(n: number, k: number) { return this.m(`st${n}_${k}`, () => ta.supertrend(this.b, n, k)); }
  bb(n = 20, k = 2) { return this.m(`bb${n}_${k}`, () => ta.bollinger(this.c, n, k)); }
  kel() { return this.m("kel", () => ta.keltner(this.b, 20, 2)); }
  macd() { return this.m("macd", () => ta.macd(this.c)); }
  stoch() { return this.m("stoch", () => ta.stochastic(this.b, 14, 3)); }
  don(n: number) { return this.m(`don${n}`, () => ta.donchian(this.b, n)); }
  cci() { return this.m("cci", () => ta.cci(this.b, 20)); }
  wr() { return this.m("wr", () => ta.williamsR(this.b, 14)); }
  psar() { return this.m("psar", () => ta.psar(this.b)); }
  dmi() { return this.m("dmi", () => ta.dmi(this.b, 14)); }
  ha() { return this.m("ha", () => ta.heikinAshi(this.b)); }
  mid(n: number) { return this.m(`mid${n}`, () => ta.midline(this.b, n)); }
  roc(n: number) { return this.m(`roc${n}`, () => ta.roc(this.c, n)); }
  /** Lowest low / highest high of bars i-n+1..i */
  lo(i: number, n: number) { let x = Infinity; for (let j = Math.max(0, i - n + 1); j <= i; j++) x = Math.min(x, this.l[j]!); return x; }
  hi(i: number, n: number) { let x = -Infinity; for (let j = Math.max(0, i - n + 1); j <= i; j++) x = Math.max(x, this.h[j]!); return x; }
  /** Swing stop over the last n bars, never further than maxAtr ATR from the close. */
  swing(d: D, i: number, n = 5, maxAtr = 2) { const a = this.atr[i]!, c = this.c[i]!; return d === 1 ? Math.max(this.lo(i, n), c - maxAtr * a) : Math.min(this.hi(i, n), c + maxAtr * a); }
  atrStop(d: D, i: number, k = 1.5) { return this.c[i]! - d * k * this.atr[i]!; }
  /** Use a structural level as the stop, capped at maxAtr ATR. */
  level(d: D, i: number, lvl: number, maxAtr = 1.5) { const c = this.c[i]!, a = this.atr[i]!; return d === 1 ? Math.max(lvl, c - maxAtr * a) : Math.min(lvl, c + maxAtr * a); }
  volSpike(i: number, k: number) { const av = this.avgVol[i - 1]; return !!av && this.v[i]! >= k * av; }
}
const cache = new WeakMap<Bar[], Ctx>();
function ctxOf(b: Bar[], daily: boolean): Ctx {
  const last = b[b.length - 1]?.t ?? 0; let x = cache.get(b);
  if (!x || x.daily !== daily || x.n !== b.length || x.lastT !== last) { x = new Ctx(b, daily, b.length, last); cache.set(b, x); }
  return x;
}

// ---- small helpers ----
const ok = (...v: Array<number | null | undefined>) => v.every(x => x !== null && x !== undefined && Number.isFinite(x));
/** a crosses above b at bar i */
function xUp(a: Series | number[], b: Series | number[] | number, i: number) {
  const b0 = typeof b === "number" ? b : b[i - 1], b1 = typeof b === "number" ? b : b[i];
  return ok(a[i - 1], a[i], b0, b1) && a[i - 1]! <= b0! && a[i]! > b1!;
}
function xDn(a: Series | number[], b: Series | number[] | number, i: number) {
  const b0 = typeof b === "number" ? b : b[i - 1], b1 = typeof b === "number" ? b : b[i];
  return ok(a[i - 1], a[i], b0, b1) && a[i - 1]! >= b0! && a[i]! < b1!;
}
const f2 = (n: number) => n.toFixed(2);
const hhmm = (s: string) => { const [h, m] = s.split(":").map(Number); return h! * 60 + m!; };
const L: D = 1, S: D = -1;
/** Both directions from one rule: long(x) when up-condition holds, short when the mirror holds. */
function both(up: Trig | null | false, dn: Trig | null | false): Trig | null { return up || dn || null; }

// Day-level references (intraday only)
function pivots(x: Ctx, i: number) {
  const d = x.day!, H = d.prevH[i], Lw = d.prevL[i], C = d.prevC[i]; if (!ok(H, Lw, C)) return null;
  const P = (H! + Lw! + C!) / 3, BC = (H! + Lw!) / 2, TC = 2 * P - BC, rng = H! - Lw!;
  return { P, top: Math.max(BC, TC), bot: Math.min(BC, TC), R1: 2 * P - Lw!, S1: 2 * P - H!,
    H3: C! + rng * 1.1 / 4, L3: C! - rng * 1.1 / 4, H4: C! + rng * 1.1 / 2, L4: C! - rng * 1.1 / 2, H: H!, L: Lw!, C: C! };
}

interface Def {
  id: string; name: string; family: string; description: string; rr: number;
  intradayOnly?: boolean; needsVolume?: boolean; window?: [string, string];
  fire: (x: Ctx, i: number) => Trig | null;
}

// ---------------------------------------------------------------- families
const orb = (m: 15 | 30 | 60, filter: "" | "vwap" | "vol"): Def => ({
  id: `orb-${m}${filter ? "-" + filter : ""}`, name: `ORB ${m}-min${filter === "vwap" ? " + VWAP" : filter === "vol" ? " + volume" : ""}`, family: "Opening Range Breakout",
  description: `Break of the first ${m} minutes' high/low (09:15–${m === 60 ? "10:15" : "09:" + (15 + m)})${filter === "vwap" ? ", in the direction of VWAP" : filter === "vol" ? ", on ≥1.5× volume" : ""}. Stop: other side of the range (max 1.5 ATR).`,
  rr: 2, intradayOnly: true, needsVolume: filter !== "",
  fire: (x, i) => {
    const r = x.day!.or[m]!, hi = r.hi[i], lo = r.lo[i], c = x.c[i]!; if (!ok(hi, lo) || x.day!.newDay[i]) return null;
    const prevC = x.c[i - 1]!;
    let d: D | 0 = c > hi! && prevC <= hi! ? L : c < lo! && prevC >= lo! ? S : 0; if (!d) return null;
    if (filter === "vwap") { const vw = x.vw().vwap[i]; if (!ok(vw) || (d === L ? c <= vw! : c >= vw!)) return null; }
    if (filter === "vol" && !x.volSpike(i, 1.5)) return null;
    return { dir: d, stop: x.level(d, i, d === L ? lo! : hi!), why: `close ${f2(c)} ${d === L ? ">" : "<"} OR${m} ${d === L ? "high " + f2(hi!) : "low " + f2(lo!)}` };
  },
});

const supertrend = (n: number, k: number, filter: "" | "vwap" | "adx"): Def => ({
  id: `supertrend-${n}-${k}${filter ? "-" + filter : ""}`, name: `Supertrend (${n},${k})${filter === "vwap" ? " + VWAP" : filter === "adx" ? " + ADX" : ""}`, family: "Supertrend",
  description: `Enter when Supertrend(${n}, ${k}) flips direction${filter === "vwap" ? " and price is on the same side of VWAP" : filter === "adx" ? " while ADX ≥ 20 (trending)" : ""}. Stop: the Supertrend line.`,
  rr: 2, needsVolume: filter === "vwap",
  fire: (x, i) => {
    const s = x.st(n, k), d = s.dir[i], p = s.dir[i - 1]; if (!d || !p || d === p) return null;
    const c = x.c[i]!;
    if (filter === "vwap") { const vw = x.vw().vwap[i]; if (!ok(vw) || (d === L ? c <= vw! : c >= vw!)) return null; }
    if (filter === "adx") { const a = x.adx()[i]; if (!ok(a) || a! < 20) return null; }
    return { dir: d, stop: x.level(d, i, s.line[i]!, 2.5), why: `Supertrend flipped ${d === L ? "UP" : "DOWN"} (line ${f2(s.line[i]!)})` };
  },
});

const emaCross = (f: number, s: number, filter: "" | "vwap" | "adx"): Def => ({
  id: `ema-${f}-${s}${filter ? "-" + filter : ""}`, name: `EMA ${f}/${s} crossover${filter === "vwap" ? " + VWAP" : filter === "adx" ? " + ADX" : ""}`, family: "Moving-average crossover",
  description: `EMA ${f} crosses EMA ${s}${filter === "vwap" ? " with price on the same side of VWAP" : filter === "adx" ? " while ADX ≥ 20" : ""}. Stop: 5-bar swing (max 2 ATR).`,
  rr: 2, needsVolume: filter === "vwap",
  fire: (x, i) => {
    const a = x.ema(f), b = x.ema(s), c = x.c[i]!;
    const d: D | 0 = xUp(a, b, i) ? L : xDn(a, b, i) ? S : 0; if (!d) return null;
    if (filter === "vwap") { const vw = x.vw().vwap[i]; if (!ok(vw) || (d === L ? c <= vw! : c >= vw!)) return null; }
    if (filter === "adx") { const ad = x.adx()[i]; if (!ok(ad) || ad! < 20) return null; }
    return { dir: d, stop: x.swing(d, i), why: `EMA${f} ${f2(a[i]!)} crossed ${d === L ? "above" : "below"} EMA${s} ${f2(b[i]!)}` };
  },
});

// ---------------------------------------------------------------- the library
const DEFS: Def[] = [
  // Opening range breakout — the classic NSE index setup
  orb(15, ""), orb(30, ""), orb(60, ""), orb(15, "vwap"), orb(30, "vwap"), orb(15, "vol"),

  // Supertrend — very widely used by Indian traders
  supertrend(7, 3, ""), supertrend(10, 3, ""), supertrend(10, 2, ""), supertrend(14, 2, ""), supertrend(10, 3, "vwap"), supertrend(10, 3, "adx"),

  // Moving-average crossovers
  emaCross(5, 13, ""), emaCross(9, 21, ""), emaCross(13, 34, ""), emaCross(20, 50, ""), emaCross(9, 21, "vwap"), emaCross(9, 21, "adx"),

  // MACD
  { id: "macd-signal", name: "MACD signal cross", family: "MACD", rr: 2,
    description: "MACD(12,26,9) crosses its signal line. Stop: 1.5 ATR.",
    fire: (x, i) => { const m = x.macd(); const d: D | 0 = xUp(m.macd, m.signal, i) ? L : xDn(m.macd, m.signal, i) ? S : 0;
      return d ? { dir: d, stop: x.atrStop(d, i), why: `MACD crossed ${d === L ? "above" : "below"} signal` } : null; } },
  { id: "macd-zero", name: "MACD zero-line cross", family: "MACD", rr: 2,
    description: "MACD line crosses zero (EMA12 crosses EMA26 momentum confirmation). Stop: 1.5 ATR.",
    fire: (x, i) => { const m = x.macd(); const d: D | 0 = xUp(m.macd, 0, i) ? L : xDn(m.macd, 0, i) ? S : 0;
      return d ? { dir: d, stop: x.atrStop(d, i), why: `MACD crossed ${d === L ? "above" : "below"} zero` } : null; } },
  { id: "macd-trend", name: "MACD cross + EMA 50 trend", family: "MACD", rr: 2,
    description: "MACD signal cross only in the direction of the EMA 50 trend. Stop: 5-bar swing.",
    fire: (x, i) => { const m = x.macd(), e = x.ema(50)[i], c = x.c[i]!; if (!ok(e)) return null;
      const d: D | 0 = xUp(m.macd, m.signal, i) && c > e! ? L : xDn(m.macd, m.signal, i) && c < e! ? S : 0;
      return d ? { dir: d, stop: x.swing(d, i), why: `MACD cross with price ${d === L ? "above" : "below"} EMA50 ${f2(e!)}` } : null; } },

  // RSI
  { id: "rsi-reversal", name: "RSI 30/70 reversal", family: "RSI", rr: 1.5,
    description: "RSI(14) climbs back above 30 (long) or drops back below 70 (short). Stop: 5-bar swing.",
    fire: (x, i) => { const r = x.rsi(14); const d: D | 0 = xUp(r, 30, i) ? L : xDn(r, 70, i) ? S : 0;
      return d ? { dir: d, stop: x.swing(d, i), why: `RSI ${f2(r[i]!)} left ${d === L ? "oversold" : "overbought"}` } : null; } },
  { id: "rsi2-connors", name: "RSI(2) pullback (Connors)", family: "RSI", rr: 1,
    description: "In an EMA 200 uptrend, buy when RSI(2) dips below 10; short below EMA 200 when RSI(2) > 90. Stop: 1.5 ATR.",
    fire: (x, i) => { const r = x.rsi(2), e = x.ema(200)[i], c = x.c[i]!; if (!ok(e, r[i], r[i - 1])) return null;
      const d: D | 0 = c > e! && r[i]! < 10 && r[i - 1]! >= 10 ? L : c < e! && r[i]! > 90 && r[i - 1]! <= 90 ? S : 0;
      return d ? { dir: d, stop: x.atrStop(d, i), why: `RSI(2) ${f2(r[i]!)} in ${d === L ? "up" : "down"}trend` } : null; } },
  { id: "rsi7-reversal", name: "RSI(7) 20/80 reversal", family: "RSI", rr: 1.5,
    description: "Fast RSI(7) leaves the 20/80 extremes. Stop: 5-bar swing.",
    fire: (x, i) => { const r = x.rsi(7); const d: D | 0 = xUp(r, 20, i) ? L : xDn(r, 80, i) ? S : 0;
      return d ? { dir: d, stop: x.swing(d, i), why: `RSI(7) ${f2(r[i]!)} left ${d === L ? "20" : "80"}` } : null; } },
  { id: "rsi-momentum", name: "RSI 50 momentum", family: "RSI", rr: 2,
    description: "RSI(14) crosses 50 with price on the same side of a rising/falling EMA 21. Stop: 5-bar swing.",
    fire: (x, i) => { const r = x.rsi(14), e = x.ema(21), c = x.c[i]!; if (!ok(e[i], e[i - 3])) return null;
      const d: D | 0 = xUp(r, 50, i) && c > e[i]! && e[i]! > e[i - 3]! ? L : xDn(r, 50, i) && c < e[i]! && e[i]! < e[i - 3]! ? S : 0;
      return d ? { dir: d, stop: x.swing(d, i), why: `RSI crossed 50 with EMA21 trend` } : null; } },

  // Bollinger
  { id: "bb-reversion", name: "Bollinger band reversion", family: "Bollinger Bands", rr: 1.5,
    description: "Close back inside the Bollinger(20,2) band after closing outside it. Stop: 3-bar extreme.",
    fire: (x, i) => { const b = x.bb(); const d: D | 0 = xUp(x.c, b.lo, i) ? L : xDn(x.c, b.up, i) ? S : 0;
      return d ? { dir: d, stop: x.swing(d, i, 3), why: `re-entered band from ${d === L ? "below" : "above"}` } : null; } },
  { id: "bb-breakout", name: "Bollinger band breakout", family: "Bollinger Bands", rr: 2,
    description: "Close outside the Bollinger(20,2) band while the band is widening. Stop: middle band (max 2 ATR).",
    fire: (x, i) => { const b = x.bb(); if (!ok(b.width[i], b.width[i - 1], b.mid[i])) return null;
      const d: D | 0 = xUp(x.c, b.up, i) && b.width[i]! > b.width[i - 1]! ? L : xDn(x.c, b.lo, i) && b.width[i]! > b.width[i - 1]! ? S : 0;
      return d ? { dir: d, stop: x.level(d, i, b.mid[i]!, 2), why: `close outside ${d === L ? "upper" : "lower"} band, width expanding` } : null; } },
  { id: "bb-squeeze", name: "Bollinger squeeze breakout", family: "Bollinger Bands", rr: 2.5,
    description: "Bandwidth at its lowest of the last 60 bars (volatility squeeze), then a close outside the band. Stop: middle band.",
    fire: (x, i) => { const b = x.bb(); const w = b.width; if (!ok(w[i - 1], b.mid[i])) return null;
      let min = Infinity; for (let j = i - 60; j < i - 1; j++) { if (j < 0 || w[j] === null) return null; min = Math.min(min, w[j]!); }
      if (w[i - 1]! > min * 1.1) return null;
      const d: D | 0 = xUp(x.c, b.up, i) ? L : xDn(x.c, b.lo, i) ? S : 0;
      return d ? { dir: d, stop: x.level(d, i, b.mid[i]!, 2), why: `squeeze release ${d === L ? "up" : "down"}` } : null; } },
  { id: "bb-rsi", name: "Bollinger + RSI reversal", family: "Bollinger Bands", rr: 1.5,
    description: "Previous bar outside the band with RSI(14) < 30 / > 70, current bar reverses. Stop: 3-bar extreme.",
    fire: (x, i) => { const b = x.bb(), r = x.rsi(14); if (!ok(b.lo[i - 1], b.up[i - 1], r[i - 1])) return null;
      const c = x.c[i]!, o = x.o[i]!;
      const d: D | 0 = x.c[i - 1]! < b.lo[i - 1]! && r[i - 1]! < 30 && c > o ? L : x.c[i - 1]! > b.up[i - 1]! && r[i - 1]! > 70 && c < o ? S : 0;
      return d ? { dir: d, stop: x.swing(d, i, 3), why: `band extreme + RSI ${f2(r[i - 1]!)} then reversal bar` } : null; } },

  // Donchian / Keltner
  ...[20, 55].map((n): Def => ({ id: `donchian-${n}`, name: `Donchian ${n} breakout`, family: "Channel breakout", rr: 2,
    description: `Close above the highest high (or below the lowest low) of the previous ${n} bars (Turtle-style). Stop: channel middle (max 2 ATR).`,
    fire: (x, i) => { const dc = x.don(n); if (!ok(dc.hi[i], dc.lo[i])) return null;
      const d: D | 0 = xUp(x.c, dc.hi, i) ? L : xDn(x.c, dc.lo, i) ? S : 0;
      return d ? { dir: d, stop: x.level(d, i, (dc.hi[i]! + dc.lo[i]!) / 2, 2), why: `${n}-bar ${d === L ? "high" : "low"} broken` } : null; } })),
  { id: "donchian-20-adx", name: "Donchian 20 + ADX", family: "Channel breakout", rr: 2,
    description: "Donchian 20 breakout only when ADX ≥ 25 (strong trend). Stop: channel middle (max 2 ATR).",
    fire: (x, i) => { const dc = x.don(20), a = x.adx()[i]; if (!ok(dc.hi[i], dc.lo[i], a) || a! < 25) return null;
      const d: D | 0 = xUp(x.c, dc.hi, i) ? L : xDn(x.c, dc.lo, i) ? S : 0;
      return d ? { dir: d, stop: x.level(d, i, (dc.hi[i]! + dc.lo[i]!) / 2, 2), why: `20-bar breakout, ADX ${f2(a!)}` } : null; } },
  { id: "keltner-breakout", name: "Keltner channel breakout", family: "Channel breakout", rr: 2,
    description: "Close outside the Keltner channel (EMA 20 ± 2 ATR). Stop: channel middle.",
    fire: (x, i) => { const k = x.kel(); const d: D | 0 = xUp(x.c, k.up, i) ? L : xDn(x.c, k.lo, i) ? S : 0;
      return d ? { dir: d, stop: x.level(d, i, k.mid[i]!, 2.5), why: `close outside Keltner ${d === L ? "upper" : "lower"}` } : null; } },
  { id: "keltner-reversion", name: "Keltner channel reversion", family: "Channel breakout", rr: 1.5,
    description: "Close back inside the Keltner channel after a close outside it. Stop: 3-bar extreme.",
    fire: (x, i) => { const k = x.kel(); const d: D | 0 = xUp(x.c, k.lo, i) ? L : xDn(x.c, k.up, i) ? S : 0;
      return d ? { dir: d, stop: x.swing(d, i, 3), why: `back inside Keltner from ${d === L ? "below" : "above"}` } : null; } },

  // Oscillators
  { id: "stoch-reversal", name: "Stochastic 20/80 cross", family: "Oscillators", rr: 1.5,
    description: "Stochastic %K(14,3) crosses %D below 20 (long) or above 80 (short). Stop: 5-bar swing.",
    fire: (x, i) => { const s = x.stoch(); if (!ok(s.k[i - 1])) return null;
      const d: D | 0 = xUp(s.k, s.d, i) && s.k[i - 1]! < 20 ? L : xDn(s.k, s.d, i) && s.k[i - 1]! > 80 ? S : 0;
      return d ? { dir: d, stop: x.swing(d, i), why: `%K crossed %D in ${d === L ? "oversold" : "overbought"} zone` } : null; } },
  { id: "stoch-trend", name: "Stochastic pullback in trend", family: "Oscillators", rr: 2,
    description: "Stochastic %K crosses %D from below 40 / above 60 in the direction of EMA 50. Stop: 5-bar swing.",
    fire: (x, i) => { const s = x.stoch(), e = x.ema(50)[i], c = x.c[i]!; if (!ok(s.k[i - 1], e)) return null;
      const d: D | 0 = xUp(s.k, s.d, i) && s.k[i - 1]! < 40 && c > e! ? L : xDn(s.k, s.d, i) && s.k[i - 1]! > 60 && c < e! ? S : 0;
      return d ? { dir: d, stop: x.swing(d, i), why: `stochastic pullback with EMA50 trend` } : null; } },
  { id: "cci-momentum", name: "CCI ±100 momentum", family: "Oscillators", rr: 2,
    description: "CCI(20) crosses above +100 (long) or below −100 (short). Stop: 1.5 ATR.",
    fire: (x, i) => { const v = x.cci(); const d: D | 0 = xUp(v, 100, i) ? L : xDn(v, -100, i) ? S : 0;
      return d ? { dir: d, stop: x.atrStop(d, i), why: `CCI ${f2(v[i]!)}` } : null; } },
  { id: "cci-reversal", name: "CCI ±100 reversal", family: "Oscillators", rr: 1.5,
    description: "CCI(20) climbs back above −100 (long) or falls back below +100 (short). Stop: 5-bar swing.",
    fire: (x, i) => { const v = x.cci(); const d: D | 0 = xUp(v, -100, i) ? L : xDn(v, 100, i) ? S : 0;
      return d ? { dir: d, stop: x.swing(d, i), why: `CCI ${f2(v[i]!)} left the extreme` } : null; } },
  { id: "williams-r", name: "Williams %R + EMA 50", family: "Oscillators", rr: 1.5,
    description: "Williams %R(14) leaves −80 above EMA 50 (long) or leaves −20 below EMA 50 (short). Stop: 5-bar swing.",
    fire: (x, i) => { const w = x.wr(), e = x.ema(50)[i], c = x.c[i]!; if (!ok(e)) return null;
      const d: D | 0 = xUp(w, -80, i) && c > e! ? L : xDn(w, -20, i) && c < e! ? S : 0;
      return d ? { dir: d, stop: x.swing(d, i), why: `%R ${f2(w[i]!)} with EMA50 trend` } : null; } },
  { id: "roc-momentum", name: "Rate-of-change momentum", family: "Oscillators", rr: 2,
    description: "ROC(10) crosses zero in the direction of a sloping EMA 50. Stop: 1.5 ATR.",
    fire: (x, i) => { const r = x.roc(10), e = x.ema(50); if (!ok(e[i], e[i - 5])) return null; const c = x.c[i]!;
      const d: D | 0 = xUp(r, 0, i) && c > e[i]! && e[i]! > e[i - 5]! ? L : xDn(r, 0, i) && c < e[i]! && e[i]! < e[i - 5]! ? S : 0;
      return d ? { dir: d, stop: x.atrStop(d, i), why: `ROC crossed 0 with EMA50 slope` } : null; } },

  // VWAP (needs volume — stocks/futures, not spot indices)
  { id: "vwap-cross", name: "VWAP cross + EMA trend", family: "VWAP", rr: 2, intradayOnly: true, needsVolume: true,
    description: "Price crosses session VWAP with EMA 9 vs EMA 21 agreeing. Stop: 3-bar swing.",
    fire: (x, i) => { const vw = x.vw().vwap, a = x.ema(9)[i], b = x.ema(21)[i]; if (!ok(a, b)) return null;
      const d: D | 0 = xUp(x.c, vw, i) && a! > b! ? L : xDn(x.c, vw, i) && a! < b! ? S : 0;
      return d ? { dir: d, stop: x.swing(d, i, 3), why: `crossed VWAP ${f2(vw[i]!)}` } : null; } },
  { id: "vwap-band-reversion", name: "VWAP 2σ band reversion", family: "VWAP", rr: 1.5, intradayOnly: true, needsVolume: true,
    description: "Close back inside VWAP ± 2 standard deviations after stretching outside. Stop: 3-bar extreme.",
    fire: (x, i) => { const { vwap: vw, sd } = x.vw(); if (!ok(vw[i], sd[i], vw[i - 1], sd[i - 1]) || x.day!.newDay[i]) return null;
      const lo = (k: number) => vw[k]! - 2 * sd[k]!, hi = (k: number) => vw[k]! + 2 * sd[k]!;
      const d: D | 0 = x.c[i - 1]! < lo(i - 1) && x.c[i]! > lo(i) ? L : x.c[i - 1]! > hi(i - 1) && x.c[i]! < hi(i) ? S : 0;
      return d ? { dir: d, stop: x.swing(d, i, 3), why: `back inside VWAP 2σ band` } : null; } },
  { id: "vwap-bounce", name: "VWAP bounce", family: "VWAP", rr: 2, intradayOnly: true, needsVolume: true,
    description: "In an EMA 9/21 trend, a bar dips to VWAP and closes back strongly on the trend side. Stop: below the bar / VWAP.",
    fire: (x, i) => { const vw = x.vw().vwap[i], a = x.ema(9)[i], b = x.ema(21)[i]; if (!ok(vw, a, b)) return null;
      const c = x.c[i]!, o = x.o[i]!;
      const d: D | 0 = a! > b! && x.l[i]! <= vw! && c > vw! && c > o ? L : a! < b! && x.h[i]! >= vw! && c < vw! && c < o ? S : 0;
      return d ? { dir: d, stop: x.level(d, i, d === L ? Math.min(x.l[i]!, vw! - 0.2 * x.atr[i]!) : Math.max(x.h[i]!, vw! + 0.2 * x.atr[i]!), 2), why: `bounce off VWAP ${f2(vw!)}` } : null; } },
  { id: "day-high-vwap", name: "Day high/low breakout + VWAP", family: "VWAP", rr: 2, intradayOnly: true, needsVolume: true, window: ["10:30", "14:45"],
    description: "After 10:30, close at a new day high above VWAP (or new day low below VWAP). Stop: 1.2 ATR.",
    fire: (x, i) => { const d0 = x.day!, hi = d0.sessHiBefore[i], lo = d0.sessLoBefore[i], vw = x.vw().vwap[i], c = x.c[i]!; if (!ok(hi, lo, vw)) return null;
      const d: D | 0 = c > hi! && c > vw! ? L : c < lo! && c < vw! ? S : 0;
      return d ? { dir: d, stop: x.atrStop(d, i, 1.2), why: `new day ${d === L ? "high" : "low"} ${f2(c)}` } : null; } },

  // Previous-day levels
  { id: "pdh-pdl-breakout", name: "Previous day high/low breakout", family: "Previous-day levels", rr: 2, intradayOnly: true,
    description: "Close above yesterday's high (long) or below yesterday's low (short). Stop: 1.2 ATR.",
    fire: (x, i) => { const d0 = x.day!, H = d0.prevH[i], Lw = d0.prevL[i]; if (!ok(H, Lw) || d0.newDay[i]) return null;
      const d: D | 0 = xUp(x.c, H!, i) ? L : xDn(x.c, Lw!, i) ? S : 0;
      return d ? { dir: d, stop: x.atrStop(d, i, 1.2), why: `crossed PD${d === L ? "H " + f2(H!) : "L " + f2(Lw!)}` } : null; } },
  { id: "pdh-pdl-volume", name: "PDH/PDL breakout + volume", family: "Previous-day levels", rr: 2, intradayOnly: true, needsVolume: true,
    description: "Previous-day high/low breakout confirmed by ≥1.5× average volume. Stop: 1.2 ATR.",
    fire: (x, i) => { const d0 = x.day!, H = d0.prevH[i], Lw = d0.prevL[i]; if (!ok(H, Lw) || d0.newDay[i] || !x.volSpike(i, 1.5)) return null;
      const d: D | 0 = xUp(x.c, H!, i) ? L : xDn(x.c, Lw!, i) ? S : 0;
      return d ? { dir: d, stop: x.atrStop(d, i, 1.2), why: `PD${d === L ? "H" : "L"} break on volume` } : null; } },
  { id: "pdh-pdl-rejection", name: "PDH/PDL rejection", family: "Previous-day levels", rr: 2, intradayOnly: true,
    description: "Bar pokes above yesterday's high but closes back below it as a red bar → short (mirror for PDL). Stop: the bar's extreme.",
    fire: (x, i) => { const d0 = x.day!, H = d0.prevH[i], Lw = d0.prevL[i]; if (!ok(H, Lw)) return null; const c = x.c[i]!, o = x.o[i]!, a = x.atr[i]!;
      if (x.h[i]! > H! && c < H! && c < o) return { dir: S, stop: x.h[i]! + 0.1 * a, why: `rejected at PDH ${f2(H!)}` };
      if (x.l[i]! < Lw! && c > Lw! && c > o) return { dir: L, stop: x.l[i]! - 0.1 * a, why: `rejected at PDL ${f2(Lw!)}` };
      return null; } },
  { id: "pdc-cross", name: "Previous close cross + trend", family: "Previous-day levels", rr: 2, intradayOnly: true,
    description: "Price crosses yesterday's close with EMA 9 vs EMA 21 agreeing. Stop: 3-bar swing.",
    fire: (x, i) => { const C = x.day!.prevC[i], a = x.ema(9)[i], b = x.ema(21)[i]; if (!ok(C, a, b) || x.day!.newDay[i]) return null;
      const d: D | 0 = xUp(x.c, C!, i) && a! > b! ? L : xDn(x.c, C!, i) && a! < b! ? S : 0;
      return d ? { dir: d, stop: x.swing(d, i, 3), why: `crossed prev close ${f2(C!)}` } : null; } },

  // CPR & pivots
  { id: "cpr-narrow-breakout", name: "Narrow CPR breakout", family: "CPR & Pivots", rr: 2, intradayOnly: true,
    description: "On a narrow-CPR day (width < 0.2% — trending-day hint), trade the break above TC / below BC. Stop: other side of CPR (max 1.5 ATR).",
    fire: (x, i) => { const p = pivots(x, i); if (!p || (p.top - p.bot) / p.P > 0.002) return null;
      const d: D | 0 = xUp(x.c, p.top, i) ? L : xDn(x.c, p.bot, i) ? S : 0;
      return d ? { dir: d, stop: x.level(d, i, d === L ? p.bot : p.top), why: `narrow CPR ${f2(p.bot)}–${f2(p.top)} broken` } : null; } },
  { id: "cpr-bounce", name: "CPR bounce in trend", family: "CPR & Pivots", rr: 2, intradayOnly: true,
    description: "In an EMA 9/21 trend, price retests the CPR and closes back on the trend side. Stop: beyond CPR (max 1.5 ATR).",
    fire: (x, i) => { const p = pivots(x, i), a = x.ema(9)[i], b = x.ema(21)[i]; if (!p || !ok(a, b)) return null; const c = x.c[i]!, o = x.o[i]!;
      if (a! > b! && x.l[i]! <= p.top && c > p.top && c > o) return { dir: L, stop: x.level(L, i, p.bot - 0.1 * x.atr[i]!), why: `held above CPR top ${f2(p.top)}` };
      if (a! < b! && x.h[i]! >= p.bot && c < p.bot && c < o) return { dir: S, stop: x.level(S, i, p.top + 0.1 * x.atr[i]!), why: `held below CPR bottom ${f2(p.bot)}` };
      return null; } },
  { id: "pivot-r1s1-breakout", name: "Pivot R1/S1 breakout", family: "CPR & Pivots", rr: 2, intradayOnly: true,
    description: "Classic floor pivots: close above R1 (long) or below S1 (short). Stop: 1.2 ATR.",
    fire: (x, i) => { const p = pivots(x, i); if (!p) return null; const d: D | 0 = xUp(x.c, p.R1, i) ? L : xDn(x.c, p.S1, i) ? S : 0;
      return d ? { dir: d, stop: x.atrStop(d, i, 1.2), why: `${d === L ? "R1 " + f2(p.R1) : "S1 " + f2(p.S1)} broken` } : null; } },
  { id: "pivot-r1s1-reversal", name: "Pivot R1/S1 reversal", family: "CPR & Pivots", rr: 1.5, intradayOnly: true,
    description: "Price tags S1 and closes back above it as a green bar (long), or tags R1 and closes back below as red (short). Stop: bar extreme.",
    fire: (x, i) => { const p = pivots(x, i); if (!p) return null; const c = x.c[i]!, o = x.o[i]!, a = x.atr[i]!;
      if (x.l[i]! <= p.S1 && c > p.S1 && c > o) return { dir: L, stop: x.l[i]! - 0.1 * a, why: `bounced at S1 ${f2(p.S1)}` };
      if (x.h[i]! >= p.R1 && c < p.R1 && c < o) return { dir: S, stop: x.h[i]! + 0.1 * a, why: `rejected at R1 ${f2(p.R1)}` };
      return null; } },
  { id: "camarilla-reversal", name: "Camarilla H3/L3 reversal", family: "CPR & Pivots", rr: 1.5, intradayOnly: true,
    description: "Camarilla levels: fade a rejection at H3 (short) or L3 (long). Stop: bar extreme.",
    fire: (x, i) => { const p = pivots(x, i); if (!p) return null; const c = x.c[i]!, o = x.o[i]!, a = x.atr[i]!;
      if (x.h[i]! >= p.H3 && c < p.H3 && c < o) return { dir: S, stop: x.h[i]! + 0.1 * a, why: `rejected at H3 ${f2(p.H3)}` };
      if (x.l[i]! <= p.L3 && c > p.L3 && c > o) return { dir: L, stop: x.l[i]! - 0.1 * a, why: `held at L3 ${f2(p.L3)}` };
      return null; } },
  { id: "camarilla-breakout", name: "Camarilla H4/L4 breakout", family: "CPR & Pivots", rr: 2, intradayOnly: true,
    description: "Camarilla levels: close above H4 (long) or below L4 (short) — range-expansion day. Stop: 1.2 ATR.",
    fire: (x, i) => { const p = pivots(x, i); if (!p) return null; const d: D | 0 = xUp(x.c, p.H4, i) ? L : xDn(x.c, p.L4, i) ? S : 0;
      return d ? { dir: d, stop: x.atrStop(d, i, 1.2), why: `${d === L ? "H4 " + f2(p.H4) : "L4 " + f2(p.L4)} broken` } : null; } },

  // Price-action patterns
  { id: "inside-bar-breakout", name: "Inside bar breakout", family: "Price action", rr: 2,
    description: "Previous bar is inside its mother bar; current bar closes beyond the mother bar. Stop: inside bar's other side.",
    fire: (x, i) => { const h = x.h, l = x.l; if (!(h[i - 1]! <= h[i - 2]! && l[i - 1]! >= l[i - 2]!)) return null;
      const d: D | 0 = x.c[i]! > h[i - 2]! ? L : x.c[i]! < l[i - 2]! ? S : 0;
      return d ? { dir: d, stop: x.level(d, i, d === L ? l[i - 1]! : h[i - 1]!, 2), why: `inside bar broken ${d === L ? "up" : "down"}` } : null; } },
  ...[7, 4].map((n): Def => ({ id: `nr${n}-breakout`, name: `NR${n} breakout`, family: "Price action", rr: 2,
    description: `Previous bar has the narrowest range of the last ${n} bars; trade the close beyond it. Stop: other side of the NR${n} bar.`,
    fire: (x, i) => { const r = (k: number) => x.h[k]! - x.l[k]!; if (i < n + 1) return null;
      for (let j = i - n; j < i - 1; j++) if (r(j) <= r(i - 1)) return null;
      const d: D | 0 = x.c[i]! > x.h[i - 1]! ? L : x.c[i]! < x.l[i - 1]! ? S : 0;
      return d ? { dir: d, stop: x.level(d, i, d === L ? x.l[i - 1]! : x.h[i - 1]!, 2), why: `NR${n} bar broken ${d === L ? "up" : "down"}` } : null; } })),
  { id: "engulfing-ema", name: "Engulfing at EMA 21", family: "Price action", rr: 2,
    description: "Bullish (bearish) engulfing candle that touches a rising (falling) EMA 21. Stop: candle extreme.",
    fire: (x, i) => { const e = x.ema(21); if (!ok(e[i], e[i - 5])) return null; const o = x.o, c = x.c, a = x.atr[i]!;
      const bull = c[i]! > o[i]! && c[i - 1]! < o[i - 1]! && o[i]! <= c[i - 1]! && c[i]! >= o[i - 1]!;
      const bear = c[i]! < o[i]! && c[i - 1]! > o[i - 1]! && o[i]! >= c[i - 1]! && c[i]! <= o[i - 1]!;
      if (bull && e[i]! > e[i - 5]! && x.l[i]! <= e[i]! + 0.2 * a) return { dir: L, stop: x.l[i]! - 0.1 * a, why: `bullish engulfing at EMA21 ${f2(e[i]!)}` };
      if (bear && e[i]! < e[i - 5]! && x.h[i]! >= e[i]! - 0.2 * a) return { dir: S, stop: x.h[i]! + 0.1 * a, why: `bearish engulfing at EMA21 ${f2(e[i]!)}` };
      return null; } },
  { id: "pin-bar-bb", name: "Hammer / shooting star at band", family: "Price action", rr: 1.5,
    description: "Hammer at the lower Bollinger band (long) or shooting star at the upper band (short). Stop: wick extreme.",
    fire: (x, i) => { const b = x.bb(); if (!ok(b.lo[i], b.up[i])) return null; const o = x.o[i]!, c = x.c[i]!, h = x.h[i]!, l = x.l[i]!, rng = h - l, body = Math.abs(c - o), a = x.atr[i]!;
      if (rng <= 0) return null;
      if (l <= b.lo[i]! && Math.min(o, c) - l >= 2 * body && c >= l + rng * 0.66) return { dir: L, stop: l - 0.1 * a, why: `hammer at lower band` };
      if (h >= b.up[i]! && h - Math.max(o, c) >= 2 * body && c <= h - rng * 0.66) return { dir: S, stop: h + 0.1 * a, why: `shooting star at upper band` };
      return null; } },
  { id: "three-bar-momentum", name: "Three-bar momentum", family: "Price action", rr: 2,
    description: "Three strong same-colour candles closing near their extremes, ending at a 10-bar high/low. Stop: low/high of the first candle.",
    fire: (x, i) => { const strong = (k: number, d: D) => { const r = x.h[k]! - x.l[k]!; return r > 0 && (d === L ? x.c[k]! > x.o[k]! && x.c[k]! - x.l[k]! >= 0.7 * r : x.c[k]! < x.o[k]! && x.h[k]! - x.c[k]! >= 0.7 * r); };
      for (const d of [L, S] as D[]) if (strong(i, d) && strong(i - 1, d) && strong(i - 2, d)) {
        const brk = d === L ? x.c[i]! >= x.hi(i - 3, 10) : x.c[i]! <= x.lo(i - 3, 10);
        if (brk) return { dir: d, stop: x.level(d, i, d === L ? x.l[i - 2]! : x.h[i - 2]!, 2), why: `3 strong ${d === L ? "green" : "red"} candles at 10-bar ${d === L ? "high" : "low"}` }; }
      return null; } },
  { id: "rubber-band", name: "Rubber band (over-extension fade)", family: "Price action", rr: 1.5,
    description: "Price stretched > 2.5 ATR from EMA 20, then a reversal candle closes beyond the prior bar. Stop: recent extreme.",
    fire: (x, i) => { const e = x.ema(20)[i - 1], a = x.atr[i - 1]; if (!ok(e, a)) return null;
      if (x.c[i - 1]! > e! + 2.5 * a! && x.c[i]! < x.l[i - 1]!) return { dir: S, stop: Math.max(x.h[i]!, x.h[i - 1]!) + 0.1 * a!, why: `stretched ${f2((x.c[i - 1]! - e!) / a!)} ATR above EMA20, reversing` };
      if (x.c[i - 1]! < e! - 2.5 * a! && x.c[i]! > x.h[i - 1]!) return { dir: L, stop: Math.min(x.l[i]!, x.l[i - 1]!) - 0.1 * a!, why: `stretched ${f2((e! - x.c[i - 1]!) / a!)} ATR below EMA20, reversing` };
      return null; } },
  { id: "volume-spike-breakout", name: "Volume spike breakout", family: "Price action", rr: 2, needsVolume: true,
    description: "Volume ≥ 3× its 20-bar average on a close beyond the 10-bar range. Stop: the bar's other end.",
    fire: (x, i) => { if (!x.volSpike(i, 3)) return null; const dc = x.don(10); if (!ok(dc.hi[i], dc.lo[i])) return null;
      const d: D | 0 = x.c[i]! > dc.hi[i]! ? L : x.c[i]! < dc.lo[i]! ? S : 0;
      return d ? { dir: d, stop: x.level(d, i, d === L ? x.l[i]! : x.h[i]!, 2), why: `volume ${f2(x.v[i]! / x.avgVol[i - 1]!)}× breaking 10-bar range` } : null; } },

  // Heikin-Ashi
  ...[false, true].map((trend): Def => ({ id: trend ? "heikin-ashi-ema" : "heikin-ashi-flip", name: trend ? "Heikin-Ashi flip + EMA 50" : "Heikin-Ashi flip", family: "Heikin-Ashi", rr: 2,
    description: `Heikin-Ashi turns from red to a strong green candle with no lower wick (or the mirror)${trend ? ", only in the direction of a sloping EMA 50" : ""}. Stop: 3-bar swing.`,
    fire: (x, i) => { const ha = x.ha(), a = ha[i]!, p = ha[i - 1]!, eps = 1e-9;
      let d: D | 0 = a.c > a.o && p.c < p.o && Math.abs(a.l - a.o) < eps ? L : a.c < a.o && p.c > p.o && Math.abs(a.h - a.o) < eps ? S : 0; if (!d) return null;
      if (trend) { const e = x.ema(50); if (!ok(e[i], e[i - 5]) || (d === L ? !(x.c[i]! > e[i]! && e[i]! > e[i - 5]!) : !(x.c[i]! < e[i]! && e[i]! < e[i - 5]!))) return null; }
      return { dir: d, stop: x.swing(d, i, 3), why: `HA flipped ${d === L ? "green" : "red"} with no ${d === L ? "lower" : "upper"} wick` }; } })),

  // Trend indicators
  { id: "psar-flip", name: "Parabolic SAR flip", family: "Trend indicators", rr: 2,
    description: "Parabolic SAR (0.02/0.2) flips sides. Stop: the SAR value.",
    fire: (x, i) => { const p = x.psar(); const d = p.dir[i], q = p.dir[i - 1]; if (!d || !q || d === q) return null;
      return { dir: d, stop: x.level(d, i, p.sar[i]!, 2.5), why: `SAR flipped ${d === L ? "below" : "above"} price` }; } },
  { id: "psar-ema", name: "Parabolic SAR + EMA 50", family: "Trend indicators", rr: 2,
    description: "Parabolic SAR flip only in the direction of the EMA 50 trend. Stop: the SAR value.",
    fire: (x, i) => { const p = x.psar(), e = x.ema(50)[i]; const d = p.dir[i], q = p.dir[i - 1]; if (!d || !q || d === q || !ok(e)) return null;
      if (d === L ? x.c[i]! <= e! : x.c[i]! >= e!) return null;
      return { dir: d, stop: x.level(d, i, p.sar[i]!, 2.5), why: `SAR flip with EMA50 trend` }; } },
  { id: "dmi-cross", name: "DMI +DI/−DI cross", family: "Trend indicators", rr: 2,
    description: "+DI crosses −DI (or vice versa) while ADX ≥ 20. Stop: 1.5 ATR.",
    fire: (x, i) => { const m = x.dmi(), a = x.adx()[i]; if (!ok(a) || a! < 20) return null;
      const d: D | 0 = xUp(m.plus, m.minus, i) ? L : xDn(m.plus, m.minus, i) ? S : 0;
      return d ? { dir: d, stop: x.atrStop(d, i), why: `${d === L ? "+DI" : "−DI"} took over, ADX ${f2(a!)}` } : null; } },
  { id: "adx-trend-start", name: "ADX trend start", family: "Trend indicators", rr: 2,
    description: "ADX rises through 25 (a trend is starting); trade in the direction of the dominant DI. Stop: 1.5 ATR.",
    fire: (x, i) => { const m = x.dmi(), a = x.adx(); if (!ok(m.plus[i], m.minus[i]) || !xUp(a, 25, i)) return null;
      const d: D = m.plus[i]! > m.minus[i]! ? L : S;
      return { dir: d, stop: x.atrStop(d, i), why: `ADX crossed 25, ${d === L ? "+DI" : "−DI"} dominant` }; } },
  { id: "ichimoku-tk", name: "Ichimoku TK cross", family: "Trend indicators", rr: 2,
    description: "Tenkan (9) crosses Kijun (26) with price on the same side of the Kijun. Stop: Kijun (max 2 ATR).",
    fire: (x, i) => { const t = x.mid(9), k = x.mid(26); if (!ok(k[i])) return null; const c = x.c[i]!;
      const d: D | 0 = xUp(t, k, i) && c > k[i]! ? L : xDn(t, k, i) && c < k[i]! ? S : 0;
      return d ? { dir: d, stop: x.level(d, i, k[i]!, 2), why: `Tenkan crossed Kijun ${f2(k[i]!)}` } : null; } },
  { id: "ema-ribbon-pullback", name: "EMA ribbon pullback (8/13/21)", family: "Trend indicators", rr: 2,
    description: "EMAs 8 > 13 > 21 stacked; previous bar dips to EMA 13 and the current bar closes back above EMA 8 (mirror for shorts). Stop: pullback extreme.",
    fire: (x, i) => { const a = x.ema(8), b = x.ema(13), c = x.ema(21); if (!ok(a[i], b[i], c[i], b[i - 1])) return null; const cl = x.c[i]!, at = x.atr[i]!;
      if (a[i]! > b[i]! && b[i]! > c[i]! && x.l[i - 1]! <= b[i - 1]! && cl > a[i]! && cl > x.o[i]!) return { dir: L, stop: x.level(L, i, Math.min(x.l[i]!, x.l[i - 1]!) - 0.1 * at, 2), why: `pullback to EMA13 in bullish ribbon` };
      if (a[i]! < b[i]! && b[i]! < c[i]! && x.h[i - 1]! >= b[i - 1]! && cl < a[i]! && cl < x.o[i]!) return { dir: S, stop: x.level(S, i, Math.max(x.h[i]!, x.h[i - 1]!) + 0.1 * at, 2), why: `pullback to EMA13 in bearish ribbon` };
      return null; } },

  // Session / time-of-day
  { id: "gap-and-go", name: "Gap & Go", family: "Session & gaps", rr: 2, intradayOnly: true,
    description: "Gap ≥ 0.4% from yesterday's close, then a break of the first 15-min range in the gap's direction. Stop: other side of the range (max 1.5 ATR).",
    fire: (x, i) => { const d0 = x.day!, C = d0.prevC[i], r = d0.or[15]!, hi = r.hi[i], lo = r.lo[i]; if (!ok(C, hi, lo) || d0.newDay[i]) return null;
      const gap = (d0.dayOpen[i]! - C!) / C!;
      const d: D | 0 = gap >= 0.004 && xUp(x.c, hi!, i) ? L : gap <= -0.004 && xDn(x.c, lo!, i) ? S : 0;
      return d ? { dir: d, stop: x.level(d, i, d === L ? lo! : hi!), why: `gap ${(gap * 100).toFixed(2)}% and OR15 break` } : null; } },
  { id: "gap-fill", name: "Gap fill (fade)", family: "Session & gaps", rr: 1.5, intradayOnly: true, window: ["09:30", "11:00"],
    description: "Gap ≥ 0.5% that fails: price breaks the first 15-min range against the gap — trade back towards yesterday's close. Stop: day extreme (max 2 ATR).",
    fire: (x, i) => { const d0 = x.day!, C = d0.prevC[i], r = d0.or[15]!, hi = r.hi[i], lo = r.lo[i]; if (!ok(C, hi, lo) || d0.newDay[i]) return null;
      const gap = (d0.dayOpen[i]! - C!) / C!, sh = d0.sessHiBefore[i], sl = d0.sessLoBefore[i];
      if (gap >= 0.005 && xDn(x.c, lo!, i) && ok(sh)) return { dir: S, stop: x.level(S, i, sh!, 2), why: `gap-up ${(gap * 100).toFixed(2)}% failing below OR15 low` };
      if (gap <= -0.005 && xUp(x.c, hi!, i) && ok(sl)) return { dir: L, stop: x.level(L, i, sl!, 2), why: `gap-down ${(gap * 100).toFixed(2)}% failing above OR15 high` };
      return null; } },
  { id: "opening-drive", name: "Opening drive", family: "Session & gaps", rr: 2, intradayOnly: true, window: ["09:20", "09:25"],
    description: "First 5-min candle is large (≥ 0.6 ATR) and closes near its extreme — ride the opening drive. Stop: the candle's other end.",
    fire: (x, i) => { if (x.day!.barOfDay[i] !== 0 || !ok(x.atr[i - 1])) return null; const o = x.o[i]!, c = x.c[i]!, h = x.h[i]!, l = x.l[i]!, r = h - l;
      if (r < 0.6 * x.atr[i - 1]! || Math.abs(c - o) < 0.7 * r) return null; const d: D = c > o ? L : S;
      return { dir: d, stop: x.level(d, i, d === L ? l : h, 2), why: `strong ${d === L ? "green" : "red"} opening candle (${f2(r)} range)` }; } },
  { id: "lunch-range-breakout", name: "Lunch range breakout", family: "Session & gaps", rr: 2, intradayOnly: true, window: ["13:30", "14:45"],
    description: "Break of the 12:00–13:30 IST consolidation range after 13:30. Stop: other side of the range (max 1.5 ATR).",
    fire: (x, i) => { const d0 = x.day!, hi = d0.lunchHi[i], lo = d0.lunchLo[i]; if (!ok(hi, lo)) return null;
      const d: D | 0 = xUp(x.c, hi!, i) ? L : xDn(x.c, lo!, i) ? S : 0;
      return d ? { dir: d, stop: x.level(d, i, d === L ? lo! : hi!), why: `lunch range ${f2(lo!)}–${f2(hi!)} broken` } : null; } },
  { id: "power-hour", name: "Power hour breakout", family: "Session & gaps", rr: 1.5, intradayOnly: true, window: ["14:00", "14:45"],
    description: "After 14:00, a close at a new high (low) of the day with EMA 9 vs 21 agreeing. Stop: 1.2 ATR.",
    fire: (x, i) => { const d0 = x.day!, hi = d0.sessHiBefore[i], lo = d0.sessLoBefore[i], a = x.ema(9)[i], b = x.ema(21)[i]; if (!ok(hi, lo, a, b)) return null;
      const c = x.c[i]!; const d: D | 0 = c > hi! && a! > b! ? L : c < lo! && a! < b! ? S : 0;
      return d ? { dir: d, stop: x.atrStop(d, i, 1.2), why: `late-day new ${d === L ? "high" : "low"}` } : null; } },
];

// ---------------------------------------------------------------- adapter to the common evaluator interface
export interface LibraryStrategy {
  id: string; name: string; family: string; description: string; rr: number; intradayOnly: boolean; needsVolume: boolean;
  evaluate: (b: Bar[], i: number, _pc: unknown, p: StrategyParams, daily: boolean) => StrategySignal;
}

function wrap(d: Def): LibraryStrategy {
  return {
    id: d.id, name: d.name, family: d.family, description: d.description, rr: d.rr, intradayOnly: !!d.intradayOnly, needsVolume: !!d.needsVolume,
    evaluate: (b, i, _pc, p, daily) => {
      const x = b[i]!, cx = ctxOf(b, daily), checks: Check[] = [], a = cx.atr[i];
      const warm = i >= 60 && ok(a) && a! > 0;
      checks.push({ name: "Enough history", pass: warm, detail: warm ? "indicators warmed up" : "not enough bars yet" });
      if (daily && d.intradayOnly) {
        checks.push({ name: "Intraday candles", pass: false, detail: "this strategy needs intraday bars" });
        return finish(d.id, x, "NEUTRAL", checks, null, null, d.rr);
      }
      if (d.needsVolume && !cx.hasVolume) checks.push({ name: "Volume available", pass: false, detail: "no volume (spot index) — use a stock or future" });
      if (!daily) {
        const m = cx.day!.minuteEnd[i]!, [from, to] = d.window ?? [p.noEntryBeforeIst, p.noEntryAfterIst];
        const inWin = m >= hhmm(from) && m <= hhmm(to);
        checks.push({ name: "Entry window", pass: inWin, detail: `bar closes ${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")} IST (allowed ${from}–${to})` });
      }
      let t: Trig | null = null;
      if (warm) { try { t = d.fire(cx, i); } catch { t = null; } }
      checks.push({ name: `Setup: ${d.name}`, pass: !!t, detail: t?.why ?? "condition not met" });
      if (!t) return finish(d.id, x, "NEUTRAL", checks, null, null, d.rr);
      // Risk sanity: stop on the correct side, at least 0.3 ATR away (widened if tighter), at most 3 ATR.
      let stop = t.stop; const risk = t.dir === 1 ? x.c - stop : stop - x.c;
      if (risk < 0.3 * a!) stop = x.c - t.dir * 0.3 * a!;
      const finalRisk = Math.abs(x.c - stop);
      checks.push({ name: "Risk ≤ 3 ATR", pass: finalRisk <= 3 * a!, detail: `${(finalRisk / a!).toFixed(2)} ATR` });
      return finish(d.id, x, t.dir === 1 ? "BULLISH" : "BEARISH", checks, x.c, stop, d.rr);
    },
  };
}

export const LIBRARY: LibraryStrategy[] = DEFS.map(wrap);
