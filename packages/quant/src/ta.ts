/** Extra technical indicators used by the strategy library. All series are aligned to the input bars; null = not warmed up. */
import { type Bar, istDay, istMinutes } from "./types.ts";
import { atr, ema, sma, type Series } from "./indicators.ts";

export function stdev(values: number[], n: number): Series {
  const out: Series = new Array(values.length).fill(null);
  let s = 0, s2 = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!; s += v; s2 += v * v;
    if (i >= n) { const o = values[i - n]!; s -= o; s2 -= o * o; }
    if (i >= n - 1) out[i] = Math.sqrt(Math.max(s2 / n - (s / n) ** 2, 0));
  }
  return out;
}

export function bollinger(c: number[], n = 20, k = 2) {
  const mid = sma(c, n), sd = stdev(c, n);
  const up = mid.map((m, i) => m === null ? null : m + k * sd[i]!), lo = mid.map((m, i) => m === null ? null : m - k * sd[i]!);
  const width = mid.map((m, i) => m === null || m === 0 ? null : (up[i]! - lo[i]!) / m);
  return { mid, up, lo, width };
}

export function keltner(b: Bar[], n = 20, mult = 2) {
  const mid = ema(b.map(x => x.c), n), a = atr(b, n);
  return { mid, up: mid.map((m, i) => m === null || a[i] === null ? null : m + mult * a[i]!), lo: mid.map((m, i) => m === null || a[i] === null ? null : m - mult * a[i]!) };
}

/** Supertrend: line and direction (+1 up / -1 down). */
export function supertrend(b: Bar[], n = 10, mult = 3) {
  const a = atr(b, n), line: Series = new Array(b.length).fill(null), dir: Array<1 | -1 | 0> = new Array(b.length).fill(0);
  let fu = 0, fl = 0, d: 1 | -1 = 1;
  for (let i = 0; i < b.length; i++) {
    const x = b[i]!, at = a[i]; if (at === null || at === undefined) continue;
    const hl2 = (x.h + x.l) / 2, bu = hl2 + mult * at, bl = hl2 - mult * at;
    const pc = i ? b[i - 1]!.c : x.c, first = line[i - 1] === null || line[i - 1] === undefined;
    fu = first || bu < fu || pc > fu ? bu : fu;
    fl = first || bl > fl || pc < fl ? bl : fl;
    if (!first) d = d === 1 ? (x.c < fl ? -1 : 1) : (x.c > fu ? 1 : -1);
    line[i] = d === 1 ? fl : fu; dir[i] = d;
  }
  return { line, dir };
}

export function macd(c: number[], f = 12, s = 26, sig = 9) {
  const ef = ema(c, f), es = ema(c, s);
  const m: Series = ef.map((v, i) => v === null || es[i] === null ? null : v - es[i]!);
  const start = m.findIndex(v => v !== null);
  const sl: Series = new Array(c.length).fill(null);
  if (start >= 0) { const e = ema(m.slice(start) as number[], sig); e.forEach((v, j) => { sl[start + j] = v; }); }
  return { macd: m, signal: sl, hist: m.map((v, i) => v === null || sl[i] === null ? null : v - sl[i]!) };
}

export function stochastic(b: Bar[], n = 14, d = 3) {
  const k: Series = new Array(b.length).fill(null);
  for (let i = n - 1; i < b.length; i++) {
    let hh = -Infinity, ll = Infinity; for (let j = i - n + 1; j <= i; j++) { hh = Math.max(hh, b[j]!.h); ll = Math.min(ll, b[j]!.l); }
    k[i] = hh === ll ? 50 : ((b[i]!.c - ll) / (hh - ll)) * 100;
  }
  const start = k.findIndex(v => v !== null), ds: Series = new Array(b.length).fill(null);
  if (start >= 0) sma(k.slice(start) as number[], d).forEach((v, j) => { ds[start + j] = v; });
  return { k, d: ds };
}

/** Highest high / lowest low of the n bars BEFORE bar i (excludes bar i). */
export function donchian(b: Bar[], n: number) {
  const hi: Series = new Array(b.length).fill(null), lo: Series = new Array(b.length).fill(null);
  for (let i = n; i < b.length; i++) {
    let h = -Infinity, l = Infinity; for (let j = i - n; j < i; j++) { h = Math.max(h, b[j]!.h); l = Math.min(l, b[j]!.l); }
    hi[i] = h; lo[i] = l;
  }
  return { hi, lo };
}

export function cci(b: Bar[], n = 20): Series {
  const tp = b.map(x => (x.h + x.l + x.c) / 3), m = sma(tp, n), out: Series = new Array(b.length).fill(null);
  for (let i = n - 1; i < b.length; i++) {
    let md = 0; for (let j = i - n + 1; j <= i; j++) md += Math.abs(tp[j]! - m[i]!); md /= n;
    out[i] = md === 0 ? 0 : (tp[i]! - m[i]!) / (0.015 * md);
  }
  return out;
}

export function williamsR(b: Bar[], n = 14): Series {
  const s = stochastic(b, n, 1); return s.k.map(v => v === null ? null : v - 100);
}

/** Parabolic SAR with direction (+1 long / -1 short). */
export function psar(b: Bar[], step = 0.02, max = 0.2) {
  const sar: Series = new Array(b.length).fill(null), dir: Array<1 | -1 | 0> = new Array(b.length).fill(0);
  if (b.length < 3) return { sar, dir };
  let up = b[1]!.c >= b[0]!.c, af = step, ep = up ? b[1]!.h : b[1]!.l, s = up ? b[0]!.l : b[0]!.h;
  for (let i = 2; i < b.length; i++) {
    const x = b[i]!;
    s = s + af * (ep - s);
    s = up ? Math.min(s, b[i - 1]!.l, b[i - 2]!.l) : Math.max(s, b[i - 1]!.h, b[i - 2]!.h);
    if (up ? x.l < s : x.h > s) { up = !up; s = ep; ep = up ? x.h : x.l; af = step; }
    else if (up ? x.h > ep : x.l < ep) { ep = up ? x.h : x.l; af = Math.min(af + step, max); }
    sar[i] = s; dir[i] = up ? 1 : -1;
  }
  return { sar, dir };
}

/** +DI / -DI (Wilder). */
export function dmi(b: Bar[], n = 14) {
  const plus: Series = new Array(b.length).fill(null), minus: Series = new Array(b.length).fill(null);
  let tr = 0, p = 0, m = 0;
  for (let i = 1; i < b.length; i++) {
    const x = b[i]!, y = b[i - 1]!;
    const t = Math.max(x.h - x.l, Math.abs(x.h - y.c), Math.abs(x.l - y.c));
    const up = x.h - y.h, dn = y.l - x.l;
    const pd = up > dn && up > 0 ? up : 0, md = dn > up && dn > 0 ? dn : 0;
    if (i <= n) { tr += t; p += pd; m += md; if (i < n) continue; }
    else { tr = tr - tr / n + t; p = p - p / n + pd; m = m - m / n + md; }
    plus[i] = tr ? (100 * p) / tr : 0; minus[i] = tr ? (100 * m) / tr : 0;
  }
  return { plus, minus };
}

export function heikinAshi(b: Bar[]): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < b.length; i++) {
    const x = b[i]!, c = (x.o + x.h + x.l + x.c) / 4;
    const o = i ? (out[i - 1]!.o + out[i - 1]!.c) / 2 : (x.o + x.c) / 2;
    out.push({ t: x.t, o, h: Math.max(x.h, o, c), l: Math.min(x.l, o, c), c, v: x.v });
  }
  return out;
}

/** Midpoint of the highest high and lowest low over n bars including bar i (Ichimoku lines). */
export function midline(b: Bar[], n: number): Series {
  const out: Series = new Array(b.length).fill(null);
  for (let i = n - 1; i < b.length; i++) { let h = -Infinity, l = Infinity; for (let j = i - n + 1; j <= i; j++) { h = Math.max(h, b[j]!.h); l = Math.min(l, b[j]!.l); } out[i] = (h + l) / 2; }
  return out;
}

export function roc(c: number[], n: number): Series { return c.map((v, i) => i < n || c[i - n] === 0 ? null : ((v - c[i - n]!) / c[i - n]!) * 100); }

/** Session VWAP with a volume-weighted standard deviation band. Null where volume is 0. */
export function vwapBands(b: Bar[]) {
  const vw: Series = new Array(b.length).fill(null), sd: Series = new Array(b.length).fill(null);
  let day = -1, pv = 0, vv = 0, p2v = 0;
  for (let i = 0; i < b.length; i++) {
    const x = b[i]!, d = istDay(x.t), tp = (x.h + x.l + x.c) / 3;
    if (d !== day) { day = d; pv = 0; vv = 0; p2v = 0; }
    pv += tp * x.v; vv += x.v; p2v += tp * tp * x.v;
    if (vv > 0) { const m = pv / vv; vw[i] = m; sd[i] = Math.sqrt(Math.max(p2v / vv - m * m, 0)); }
  }
  return { vwap: vw, sd };
}

/**
 * Per-bar intraday session context. Every value is known by the CLOSE of bar i (no look-ahead):
 * previous session H/L/C, today's open, running session high/low (before bar i), and opening ranges
 * that are only set once the range window has fully closed.
 */
export interface DayContext {
  newDay: boolean[]; barOfDay: number[]; dayOpen: number[]; prevH: Series; prevL: Series; prevC: Series;
  sessHiBefore: Series; sessLoBefore: Series; minuteEnd: number[];
  or: Record<number, { hi: Series; lo: Series }>;
  /** high/low of 12:00–13:30 IST, known after 13:30 */ lunchHi: Series; lunchLo: Series;
}
export function dayContext(b: Bar[], barSec: number, orMinutes: number[] = [15, 30, 60]): DayContext {
  const n = b.length, mk = () => new Array(n).fill(null) as Series;
  const ctx: DayContext = { newDay: [], barOfDay: [], dayOpen: [], prevH: mk(), prevL: mk(), prevC: mk(), sessHiBefore: mk(), sessLoBefore: mk(), minuteEnd: [],
    or: Object.fromEntries(orMinutes.map(m => [m, { hi: mk(), lo: mk() }])), lunchHi: mk(), lunchLo: mk() };
  let day = -1, k = 0, open = 0, hi = -Infinity, lo = Infinity, close = 0, pH: number | null = null, pL: number | null = null, pC: number | null = null;
  const orHi: Record<number, number> = {}, orLo: Record<number, number> = {}; let lh = -Infinity, ll = Infinity, sessStart = 555;
  for (let i = 0; i < n; i++) {
    const x = b[i]!, d = istDay(x.t), start = istMinutes(x.t), end = start + barSec / 60;
    const nd = d !== day;
    if (nd) {
      if (day !== -1) { pH = hi; pL = lo; pC = close; }
      day = d; k = 0; open = x.o; hi = -Infinity; lo = Infinity; lh = -Infinity; ll = Infinity; sessStart = start; // first candle of the day (09:15 NSE, 00:00 crypto)
      for (const m of orMinutes) { orHi[m] = -Infinity; orLo[m] = Infinity; }
    } else k++;
    ctx.newDay.push(nd); ctx.barOfDay.push(k); ctx.dayOpen.push(open); ctx.minuteEnd.push(end);
    ctx.prevH[i] = pH; ctx.prevL[i] = pL; ctx.prevC[i] = pC;
    ctx.sessHiBefore[i] = Number.isFinite(hi) ? hi : null; ctx.sessLoBefore[i] = Number.isFinite(lo) ? lo : null;
    for (const m of orMinutes) {
      if (start < sessStart + m) { orHi[m] = Math.max(orHi[m]!, x.h); orLo[m] = Math.min(orLo[m]!, x.l); }
      if (end >= sessStart + m && Number.isFinite(orHi[m]!)) { ctx.or[m]!.hi[i] = orHi[m]!; ctx.or[m]!.lo[i] = orLo[m]!; }
    }
    if (start >= 720 && start < 810) { lh = Math.max(lh, x.h); ll = Math.min(ll, x.l); }
    if (end >= 810 && Number.isFinite(lh)) { ctx.lunchHi[i] = lh; ctx.lunchLo[i] = ll; }
    hi = Math.max(hi, x.h); lo = Math.min(lo, x.l); close = x.c;
  }
  return ctx;
}
