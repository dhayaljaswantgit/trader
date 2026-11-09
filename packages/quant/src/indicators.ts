import { type Bar, istDay } from "./types.ts";

export type Series = Array<number | null>;

export function ema(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) { prev = values[i]! * k + prev * (1 - k); out[i] = prev; }
  return out;
}

/** Wilder RSI */
export function rsi(values: number[], period = 14): Series {
  const out: Series = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) { const d = values[i]! - values[i - 1]!; if (d > 0) g += d; else l -= d; }
  g /= period; l /= period;
  out[period] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!;
    g = (g * (period - 1) + Math.max(d, 0)) / period;
    l = (l * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

export function trueRange(b: Bar[]): number[] {
  return b.map((x, i) => i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - b[i - 1]!.c), Math.abs(x.l - b[i - 1]!.c)));
}

/** Wilder ATR */
export function atr(b: Bar[], period = 14): Series {
  const tr = trueRange(b), out: Series = new Array(b.length).fill(null);
  if (b.length < period) return out;
  let prev = tr.slice(0, period).reduce((a, c) => a + c, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < b.length; i++) { prev = (prev * (period - 1) + tr[i]!) / period; out[i] = prev; }
  return out;
}

/** Wilder ADX */
export function adx(b: Bar[], period = 14): Series {
  const n = b.length, out: Series = new Array(n).fill(null);
  if (n < period * 2 + 1) return out;
  const tr = trueRange(b);
  let trS = 0, pS = 0, mS = 0; const dx: number[] = [];
  for (let i = 1; i < n; i++) {
    const up = b[i]!.h - b[i - 1]!.h, dn = b[i - 1]!.l - b[i]!.l;
    const pdm = up > dn && up > 0 ? up : 0, mdm = dn > up && dn > 0 ? dn : 0;
    if (i <= period) { trS += tr[i]!; pS += pdm; mS += mdm; if (i < period) continue; }
    else { trS = trS - trS / period + tr[i]!; pS = pS - pS / period + pdm; mS = mS - mS / period + mdm; }
    const pdi = trS ? 100 * pS / trS : 0, mdi = trS ? 100 * mS / trS : 0;
    dx.push(pdi + mdi ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0);
    const idx = i;
    if (dx.length === period) out[idx] = dx.reduce((a, c) => a + c, 0) / period;
    else if (dx.length > period) out[idx] = (out[idx - 1]! * (period - 1) + dx[dx.length - 1]!) / period;
  }
  return out;
}

/**
 * VWAP. mode "session": resets each IST day (intraday bars). mode "rolling": N-bar volume-weighted
 * typical price (used for daily bars, where a session VWAP is meaningless). Null where volume is 0.
 */
export function vwap(b: Bar[], mode: "session" | "rolling" = "session", rollN = 20): Series {
  const out: Series = new Array(b.length).fill(null);
  if (mode === "session") {
    let day = -1, pv = 0, vv = 0;
    for (let i = 0; i < b.length; i++) {
      const x = b[i]!, d = istDay(x.t);
      if (d !== day) { day = d; pv = 0; vv = 0; }
      pv += ((x.h + x.l + x.c) / 3) * x.v; vv += x.v;
      out[i] = vv > 0 ? pv / vv : null;
    }
  } else {
    for (let i = rollN - 1; i < b.length; i++) {
      let pv = 0, vv = 0;
      for (let j = i - rollN + 1; j <= i; j++) { const x = b[j]!; pv += ((x.h + x.l + x.c) / 3) * x.v; vv += x.v; }
      out[i] = vv > 0 ? pv / vv : null;
    }
  }
  return out;
}

export function sma(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null); let s = 0;
  for (let i = 0; i < values.length; i++) { s += values[i]!; if (i >= period) s -= values[i - period]!; if (i >= period - 1) out[i] = s / period; }
  return out;
}

/** Running session high/low (IST day) */
export function sessionHighLow(b: Bar[]): { high: number[]; low: number[] } {
  const high: number[] = [], low: number[] = []; let day = -1, h = -Infinity, l = Infinity;
  for (const x of b) { const d = istDay(x.t); if (d !== day) { day = d; h = -Infinity; l = Infinity; } h = Math.max(h, x.h); l = Math.min(l, x.l); high.push(h); low.push(l); }
  return { high, low };
}

/** Aggregate bars into larger buckets aligned to IST session start 09:15. */
export function resample(b: Bar[], minutes: number): Bar[] {
  const out: Bar[] = []; let key = -1;
  for (const x of b) {
    const m = Math.floor(((x.t + 19800) % 86400) / 60) - 555; // minutes since 09:15 IST
    const k = istDay(x.t) * 10000 + Math.floor(m / minutes);
    if (k !== key) { key = k; out.push({ ...x }); }
    else { const y = out[out.length - 1]!; y.h = Math.max(y.h, x.h); y.l = Math.min(y.l, x.l); y.c = x.c; y.v += x.v; }
  }
  return out;
}

export interface IndicatorSnapshot {
  ema9: number | null; ema21: number | null; rsi14: number | null; atr14: number | null; adx14: number | null;
  vwap: number | null; sessionHigh: number | null; sessionLow: number | null; relVolume: number | null;
}
export function snapshot(b: Bar[], vwapMode: "session" | "rolling" = "session"): IndicatorSnapshot {
  const n = b.length - 1;
  if (n < 0) return { ema9: null, ema21: null, rsi14: null, atr14: null, adx14: null, vwap: null, sessionHigh: null, sessionLow: null, relVolume: null };
  const c = b.map(x => x.c), v = b.map(x => x.v), hl = sessionHighLow(b), av = sma(v, 20);
  return {
    ema9: ema(c, 9)[n] ?? null, ema21: ema(c, 21)[n] ?? null, rsi14: rsi(c, 14)[n] ?? null, atr14: atr(b, 14)[n] ?? null,
    adx14: adx(b, 14)[n] ?? null, vwap: vwap(b, vwapMode)[n] ?? null, sessionHigh: hl.high[n] ?? null, sessionLow: hl.low[n] ?? null,
    relVolume: av[n - 1] ? v[n]! / av[n - 1]! : null,
  };
}
