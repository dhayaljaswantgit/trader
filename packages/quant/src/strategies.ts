import { type Bar, istMinutes, fmtIstHHMM } from "./types.ts";
import { adx, atr, ema, sma, vwap, type Series } from "./indicators.ts";
import { barSeconds, finish, type Check, type Dir, type StrategySignal } from "./signal.ts";
export * from "./signal.ts";
import { LIBRARY } from "./library.ts";
import { MEAN_REVERSION } from "./meanrev.ts";
import { NIFTY_CUSTOM } from "./nifty.ts";


export interface StrategyParams {
  emaFast: number; emaSlow: number; adxMin: number; breakoutLookback: number; relVolMin: number;
  maxExtensionAtr: number; stopAtr: number; rewardRisk: number; noEntryBeforeIst: string; noEntryAfterIst: string;
  pullbackBars: number; maxRiskAtr: number;
}
export const DEFAULT_PARAMS: StrategyParams = {
  emaFast: 9, emaSlow: 21, adxMin: 20, breakoutLookback: 6, relVolMin: 1.5, maxExtensionAtr: 1.5,
  stopAtr: 1.0, rewardRisk: 2, noEntryBeforeIst: "09:30", noEntryAfterIst: "14:45", pullbackBars: 3, maxRiskAtr: 1.5,
};

export interface Precomputed { emaF: Series; emaS: Series; adx: Series; atr: Series; vwap: Series; avgVol: Series }
export function precompute(b: Bar[], p: StrategyParams, daily: boolean): Precomputed {
  const c = b.map(x => x.c);
  return { emaF: ema(c, p.emaFast), emaS: ema(c, p.emaSlow), adx: adx(b, 14), atr: atr(b, 14),
    vwap: vwap(b, daily ? "rolling" : "session"), avgVol: sma(b.map(x => x.v), 20) };
}

type Evaluator = (b: Bar[], i: number, pc: Precomputed, p: StrategyParams, daily: boolean) => StrategySignal;

const hhmm = (s: string) => { const [h, m] = s.split(":").map(Number); return h! * 60 + m!; };
function common(b: Bar[], i: number, pc: Precomputed, p: StrategyParams, daily: boolean) {
  const x = b[i]!, checks: Check[] = [];
  const need = [pc.emaF[i], pc.emaS[i], pc.adx[i], pc.atr[i]];
  const warm = need.every(v => v !== null && v !== undefined);
  checks.push({ name: "Enough history", pass: warm, detail: warm ? "indicators warmed up" : "not enough bars yet" });
  const vw = pc.vwap[i] ?? null;
  checks.push({ name: daily ? "Rolling 20-bar VWAP available" : "Session VWAP available", pass: vw !== null, detail: vw === null ? "no volume (index?) — use index future" : vw.toFixed(2) });
  if (!daily) {
    const m = istMinutes(x.t + barSeconds(b));
    const ok = m >= hhmm(p.noEntryBeforeIst) && m <= hhmm(p.noEntryAfterIst);
    checks.push({ name: "Entry window", pass: ok, detail: `${fmtIstHHMM(m)} IST (allowed ${p.noEntryBeforeIst}–${p.noEntryAfterIst})` });
  }
  return { x, checks, vw, warm };
}


/** Strategy A — trend breakout. Evaluated on the CLOSED bar i; entry is assumed at next bar open. */
export const trendBreakout: Evaluator = (b, i, pc, p, daily) => {
  const { x, checks, vw } = common(b, i, pc, p, daily);
  const ef = pc.emaF[i] ?? null, es = pc.emaS[i] ?? null, a = pc.atr[i] ?? null, ad = pc.adx[i] ?? null;
  const dir: Dir = ef !== null && es !== null && vw !== null ? (x.c > vw && ef > es ? "BULLISH" : x.c < vw && ef < es ? "BEARISH" : "NEUTRAL") : "NEUTRAL";
  const bull = dir !== "BEARISH";
  checks.push({ name: "Trend aligned (price vs VWAP, EMA fast vs slow)", pass: dir !== "NEUTRAL", detail: dir });
  checks.push({ name: `Trending regime ADX ≥ ${p.adxMin}`, pass: ad !== null && ad >= p.adxMin, detail: ad?.toFixed(1) ?? "n/a" });
  const look = b.slice(Math.max(0, i - p.breakoutLookback), i);
  const lvl = look.length ? (bull ? Math.max(...look.map(y => y.h)) : Math.min(...look.map(y => y.l))) : null;
  const broke = lvl !== null && (bull ? x.c > lvl : x.c < lvl);
  checks.push({ name: `Breakout of last ${p.breakoutLookback} bars`, pass: broke, detail: lvl === null ? "n/a" : `level ${lvl.toFixed(2)}, close ${x.c.toFixed(2)}` });
  const av = pc.avgVol[i - 1] ?? null, rv = av ? x.v / av : null;
  checks.push({ name: `Relative volume ≥ ${p.relVolMin}x`, pass: rv !== null && rv >= p.relVolMin, detail: rv?.toFixed(2) ?? "n/a" });
  const ext = a && vw !== null ? Math.abs(x.c - vw) / a : null;
  checks.push({ name: `Not over-extended (≤ ${p.maxExtensionAtr} ATR from VWAP)`, pass: ext !== null && ext <= p.maxExtensionAtr, detail: ext?.toFixed(2) ?? "n/a" });
  const stop = a ? (bull ? x.c - a * p.stopAtr : x.c + a * p.stopAtr) : null;
  return finish("trend-breakout", x, dir, checks, x.c, stop, p.rewardRisk);
};

/** Strategy B — VWAP pullback continuation. */
export const vwapPullback: Evaluator = (b, i, pc, p, daily) => {
  const { x, checks, vw } = common(b, i, pc, p, daily);
  const ef = pc.emaF[i] ?? null, es = pc.emaS[i] ?? null, a = pc.atr[i] ?? null;
  const dir: Dir = ef !== null && es !== null ? (ef > es ? "BULLISH" : ef < es ? "BEARISH" : "NEUTRAL") : "NEUTRAL";
  const bull = dir !== "BEARISH";
  checks.push({ name: "Confirmed trend (EMA fast vs slow)", pass: dir !== "NEUTRAL", detail: dir });
  const win = b.slice(Math.max(0, i - p.pullbackBars), i);
  const touched = win.some((y, k) => { const v = pc.vwap[i - win.length + k]; return v != null && (bull ? y.l <= v : y.h >= v); });
  checks.push({ name: `Pulled back to VWAP in last ${p.pullbackBars} bars`, pass: touched, detail: touched ? "yes" : "no" });
  const prev = b[i - 1];
  const reclaim = vw !== null && prev !== undefined && (bull ? x.c > vw && x.c > prev.h : x.c < vw && x.c < prev.l);
  checks.push({ name: bull ? "Closed back above VWAP & prior high" : "Closed back below VWAP & prior low", pass: reclaim, detail: vw === null ? "n/a" : `close ${x.c.toFixed(2)} / VWAP ${vw.toFixed(2)}` });
  const inval = win.length ? (bull ? Math.min(...win.map(y => y.l), x.l) : Math.max(...win.map(y => y.h), x.h)) : null;
  const risk = inval !== null ? Math.abs(x.c - inval) : null;
  checks.push({ name: `Valid invalidation, risk ≤ ${p.maxRiskAtr} ATR`, pass: risk !== null && !!a && risk > 0 && risk <= a * p.maxRiskAtr, detail: risk && a ? `${(risk / a).toFixed(2)} ATR` : "n/a" });
  return finish("vwap-pullback", x, dir, checks, x.c, inval, p.rewardRisk);
};

export interface StrategyInfo {
  name: string; description: string; family: string; evaluate: Evaluator; intradayOnly?: boolean; needsVolume?: boolean; dailyOnly?: boolean;
  /** Rule exit on the CLOSE of bar i (filled next open). Strategies with an exit rule have no fixed target. */
  exitRule?: (b: Bar[], i: number, side: "LONG" | "SHORT") => string | null;
  /** Enter at the signal bar's CLOSE (e.g. buy at 15:25) instead of the next bar's open. */
  entryAtClose?: boolean;
  /** Deploy the whole capital per position (single-index strategies) instead of risk-based sizing. */
  fullCapital?: boolean;
  /** Overrides the backtest's max holding period. */
  maxHoldBars?: number;
}
export const STRATEGIES: Record<string, StrategyInfo> = {
  "trend-breakout": { name: "A · Trend Breakout", family: "Core", description: "VWAP + EMA trend, ADX regime, N-bar breakout with relative volume.", evaluate: trendBreakout, needsVolume: true },
  "vwap-pullback": { name: "B · VWAP Pullback", family: "Core", description: "Trend continuation after a pullback to VWAP and a reclaim close.", evaluate: vwapPullback, needsVolume: true },
  ...Object.fromEntries(LIBRARY.map(s => [s.id, { name: s.name, family: s.family, description: s.description, evaluate: s.evaluate, intradayOnly: s.intradayOnly, needsVolume: s.needsVolume }])),
  ...Object.fromEntries(MEAN_REVERSION.map(s => [s.id, { name: s.name, family: "Daily mean reversion", description: s.description, evaluate: s.evaluate, exitRule: s.exitRule, dailyOnly: true }])),
  ...Object.fromEntries(NIFTY_CUSTOM.map(s => [s.id, { name: s.name, family: s.family, description: s.description, evaluate: s.evaluate, exitRule: s.exitRule,
    entryAtClose: s.entryAtClose, fullCapital: s.fullCapital, dailyOnly: s.dailyOnly, maxHoldBars: s.maxHoldBars }])),
};

/** Evaluate the latest CLOSED bar. Caller must pass only completed bars. */
export function evaluateLatest(strategyId: string, bars: Bar[], params: Partial<StrategyParams> = {}, daily = false): StrategySignal | null {
  const s = STRATEGIES[strategyId]; if (!s || bars.length === 0) return null;
  const p = { ...DEFAULT_PARAMS, ...params };
  return s.evaluate(bars, bars.length - 1, precompute(bars, p, daily), p, daily);
}
