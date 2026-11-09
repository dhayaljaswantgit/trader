/**
 * Strategy Builder engine: a strategy is plain JSON (StrategySpec) — conditions built from operands and comparators,
 * plus exits, stops, trailing, session and cost settings. runSpecBacktest() simulates it bar by bar with no look-ahead:
 *   - "barClose" entries are decided on a CLOSED candle and filled at the next candle's open;
 *   - "dayOpen" entries are decided at the day's first candle OPEN using only information known at the open;
 *   - exit conditions and trailing-stop updates use candle CLOSES (exit fills at that close);
 *   - stop / target are checked intrabar (stop first when both are touched — conservative).
 */
import { type Bar, istDay, istMinutes } from "./types.ts";
import { adx, atr, ema, rsi, sma, type Series } from "./indicators.ts";
import { dayContext, supertrend, vwapBands } from "./ta.ts";
import { barSeconds } from "./signal.ts";
import { computeMetrics, type BacktestResult, type BtTrade } from "./backtest.ts";

// ------------------------------------------------------------------ schema
export type Field = "open" | "high" | "low" | "close";
export type Operand =
  | { k: "price"; f: Field }                 // current candle
  | { k: "prevCandle"; f: Field }            // previous candle
  | { k: "prevDay"; f: Field }               // yesterday's daily OHLC
  | { k: "today"; f: "open" | "high" | "low" } // today's open / running high / low (incl. current candle)
  | { k: "orHigh" | "orLow"; m: number }     // opening range of the first m minutes (known after it completes)
  | { k: "ema" | "sma" | "rsi" | "atr" | "adx"; n: number }
  | { k: "vwap" }
  | { k: "supertrend"; n: number; m: number }
  | { k: "value"; v: number };
export type Op = ">" | "<" | ">=" | "<=" | "crossAbove" | "crossBelow";
export type Condition =
  | { t: "compare"; a: Operand; op: Op; b: Operand; offset?: number }            // a op (b + offset points)
  | { t: "consecutive"; n: number; a: Operand; op: ">" | "<" | ">=" | "<="; b: Operand; offset?: number } // last n candles all satisfy
  | { t: "candle"; color: "green" | "red"; n: number }                            // last n candles all green/red
  | { t: "prevDayColor"; color: "green" | "red" }
  | { t: "gap"; dir: "up" | "down"; minPoints?: number; minPct?: number }       // today's open vs yesterday's close
  | { t: "time"; from: string; to: string };                                      // candle close time window (IST)
export interface SideRules { enabled: boolean; entry: Condition[]; exit: Condition[] }
export interface StrategySpec {
  name: string; description?: string; version?: number;
  /** Candle size used for LIVE paper trading (backtests use the timeframe you pick). Default 5-min. */
  timeframe?: "1" | "5" | "15";
  /** Instruments this strategy trades LIVE (instrument keys). Empty = every instrument selected in Trade Setup. */
  instruments?: string[];
  entryMode: "barClose" | "dayOpen";
  long: SideRules; short: SideRules;
  /** pivot: initial stop below the nearest confirmed swing low (above swing high for shorts), minus `value` points buffer. */
  stop: { type: "none" | "points" | "pct" | "atr" | "pivot"; value: number };
  target: { type: "none" | "points" | "pct" | "rr"; value: number };
  /** step: every `every` points of favourable CLOSE move, the stop moves `by` points (first step puts it at entry + by).
   *  trail: once `every` points in profit, the stop trails `by` points behind the best close. */
  /** pivot: once `every` points in profit (0 = at once), keep moving the stop to the latest confirmed swing low − `by` pts (long). */
  trailing: { type: "none" | "step" | "trail" | "pivot"; every: number; by: number; k?: number };
  /** dayProfitLock / dayLossLimit (₹, 0 = off): once the day's net P&L reaches +lock or −limit, no new entries that day. */
  session: { squareOff: string; noEntryAfter: string; maxTradesPerDay: number; dayProfitLock?: number; dayLossLimit?: number;
    /** Trading windows (IST). If set, entries only inside a window; with exitAtWindowEnd, open trades close at the window's end. */
    windows?: Array<{ from: string; to: string }>; exitAtWindowEnd?: boolean };
  /** qty = lot size (e.g. NIFTY 75). P&L = points × delta × qty × lots (delta 1 = futures, ~0.5 = ATM option).
   *  mode fixed: `lots` lots · capital: floor(equity / capitalPerLot) · risk: lots so a stop hit ≈ riskPct% of equity (capped by capital). */
  sizing: { qty: number; delta: number; mode?: "fixed" | "capital" | "risk"; lots?: number; capitalPerLot?: number; riskPct?: number; maxLots?: number };
  /** perTrade = ₹ per round trip for the first lot; perExtraLot = ₹ added for each extra lot; slippage points per side. */
  costs: { perTrade: number; slippagePoints: number; perExtraLot?: number };
}

// ------------------------------------------------------------------ evaluation context
class Ctx {
  readonly day: ReturnType<typeof dayContext>; readonly prevOpen: Series; readonly todayHi: number[]; readonly todayLo: number[];
  private memo = new Map<string, Series>(); private piv = new Map<number, { lo: Series; hi: Series }>();
  /** Latest swing low/high CONFIRMED by bar i (a pivot at j needs k lower-highs / higher-lows on both sides, so it is known at j + k). */
  pivots(k: number) {
    if (this.piv.has(k)) return this.piv.get(k)!;
    const b = this.b, lo: Series = new Array(b.length).fill(null), hi: Series = new Array(b.length).fill(null);
    let curLo: number | null = null, curHi: number | null = null;
    for (let i = 0; i < b.length; i++) {
      const j = i - k;
      if (j >= k) {
        let isLo = true, isHi = true;
        for (let q = j - k; q <= j + k; q++) { if (q === j) continue; if (b[q]!.l < b[j]!.l || (q > j && b[q]!.l === b[j]!.l)) isLo = false; if (b[q]!.h > b[j]!.h || (q > j && b[q]!.h === b[j]!.h)) isHi = false; }
        if (isLo) curLo = b[j]!.l; if (isHi) curHi = b[j]!.h;
      }
      lo[i] = curLo; hi[i] = curHi;
    }
    const r = { lo, hi }; this.piv.set(k, r); return r;
  }
  constructor(readonly b: Bar[], readonly daily: boolean) {
    this.day = dayContext(b, barSeconds(b));
    // previous day's open + running high/low of today including the current candle
    this.prevOpen = new Array(b.length).fill(null); this.todayHi = []; this.todayLo = [];
    let curOpen: number | null = null, prevO: number | null = null, hi = -Infinity, lo = Infinity;
    for (let i = 0; i < b.length; i++) {
      if (this.day.newDay[i]) { if (curOpen !== null) prevO = curOpen; curOpen = b[i]!.o; hi = -Infinity; lo = Infinity; }
      this.prevOpen[i] = prevO; hi = Math.max(hi, b[i]!.h); lo = Math.min(lo, b[i]!.l); this.todayHi.push(hi); this.todayLo.push(lo);
    }
  }
  series(o: Operand): Series | null {
    const key = JSON.stringify(o); if (this.memo.has(key)) return this.memo.get(key)!;
    const c = this.b.map(x => x.c); let s: Series | null = null;
    if (o.k === "ema") s = ema(c, o.n); else if (o.k === "sma") s = sma(c, o.n); else if (o.k === "rsi") s = rsi(c, o.n);
    else if (o.k === "atr") s = atr(this.b, o.n); else if (o.k === "adx") s = adx(this.b, o.n); else if (o.k === "vwap") s = vwapBands(this.b).vwap;
    else if (o.k === "supertrend") s = supertrend(this.b, o.n, o.m).line;
    else if (o.k === "orHigh" || o.k === "orLow") { const d = dayContext(this.b, barSeconds(this.b), [o.m]); s = o.k === "orHigh" ? d.or[o.m]!.hi : d.or[o.m]!.lo; }
    if (s) this.memo.set(key, s); return s;
  }
  /** Operand value at bar i. atOpen = evaluating at the OPEN of bar i (only the open is known for the current candle). */
  val(o: Operand, i: number, atOpen = false): number | null {
    const x = this.b[i]!, d = this.day;
    switch (o.k) {
      case "value": return o.v;
      case "price": return atOpen ? x.o : x[o.f[0] as "o" | "h" | "l" | "c"];
      case "prevCandle": { const p = this.b[i - 1]; return p ? p[o.f[0] as "o" | "h" | "l" | "c"] : null; }
      case "prevDay": return o.f === "open" ? this.prevOpen[i] ?? null : o.f === "high" ? d.prevH[i] ?? null : o.f === "low" ? d.prevL[i] ?? null : d.prevC[i] ?? null;
      case "today": return o.f === "open" ? d.dayOpen[i] ?? null : atOpen ? x.o : o.f === "high" ? this.todayHi[i]! : this.todayLo[i]!;
      default: { const s = this.series(o); if (!s) return null; const v = s[atOpen ? i - 1 : i]; return v ?? null; }
    }
  }
}
const cmp = (a: number, op: string, b: number) => op === ">" ? a > b : op === "<" ? a < b : op === ">=" ? a >= b : a <= b;
const hhmm = (s: string) => { const [h, m] = s.split(":").map(Number); return h! * 60 + m!; };

/** Is the condition true at bar i? `since` limits look-back for "last n candles" (e.g. only candles after entry). */
export function condTrue(cx: Ctx, c: Condition, i: number, atOpen = false, since = 0): boolean {
  const b = cx.b, x = b[i]!;
  switch (c.t) {
    case "prevDayColor": { const o = cx.prevOpen[i], cl = cx.day.prevC[i]; return o != null && cl != null && (c.color === "green" ? cl > o : cl < o); }
    case "gap": {
      const o = cx.day.dayOpen[i], pc = cx.day.prevC[i]; if (o == null || pc == null) return false;
      const pts = c.dir === "up" ? o - pc : pc - o; if (pts <= 0) return false;
      return pts >= (c.minPoints ?? 0) && (pts / pc) * 100 >= (c.minPct ?? 0);
    }
    case "time": { const m = atOpen ? istMinutes(x.t) : cx.day.minuteEnd[i]!; return m >= hhmm(c.from) && m <= hhmm(c.to); }
    case "candle": {
      if (atOpen || i - c.n + 1 < since) return false;
      for (let j = i - c.n + 1; j <= i; j++) { const y = b[j]; if (!y || (c.color === "green" ? !(y.c > y.o) : !(y.c < y.o))) return false; }
      return true;
    }
    case "consecutive": {
      if (atOpen || i - c.n + 1 < since) return false;
      for (let j = i - c.n + 1; j <= i; j++) { const a = cx.val(c.a, j), v = cx.val(c.b, j); if (a == null || v == null || !cmp(a, c.op, v + (c.offset ?? 0))) return false; }
      return true;
    }
    case "compare": {
      const a = cx.val(c.a, i, atOpen), v = cx.val(c.b, i, atOpen); if (a == null || v == null) return false;
      const bv = v + (c.offset ?? 0);
      if (c.op === "crossAbove" || c.op === "crossBelow") {
        if (atOpen) return false;
        const a0 = cx.val(c.a, i - 1), b0 = cx.val(c.b, i - 1); if (a0 == null || b0 == null) return false;
        const b0v = b0 + (c.offset ?? 0);
        return c.op === "crossAbove" ? a0 <= b0v && a > bv : a0 >= b0v && a < bv;
      }
      return cmp(a, c.op, bv);
    }
  }
}
const allTrue = (cx: Ctx, cs: Condition[], i: number, atOpen: boolean) => cs.length > 0 && cs.every(c => condTrue(cx, c, i, atOpen));
const anyTrue = (cx: Ctx, cs: Condition[], i: number, since: number) => cs.some(c => condTrue(cx, c, i, false, since));

// ------------------------------------------------------------------ simulator
export interface SpecBacktestConfig { daily: boolean; startingCapital: number; oosFraction: number; slippagePointsOverride?: number }
const DEFAULT_CAPITAL_PER_LOT = 15000; // ≈ ATM NIFTY option premium × lot — an assumption, editable per strategy

function simulateSpec(bars: Bar[], spec: StrategySpec, cfg: SpecBacktestConfig) {
  const cx = new Ctx(bars, cfg.daily), slip = cfg.slippagePointsOverride ?? spec.costs.slippagePoints;
  const A = atr(bars, 14), sz = spec.sizing, mode = sz.mode ?? "fixed", perLot = sz.capitalPerLot || DEFAULT_CAPITAL_PER_LOT;
  /** Lots for a new trade, given the current equity and the stop distance in index points (null = no stop). */
  const lotsFor = (stopPts: number | null) => {
    // Never trade more than the capital can pay for (₹ per lot) or the max-lots limit; no capital → no trade.
    const cap = Math.max(1, Math.round(sz.maxLots ?? 20)), afford = Math.min(cap, Math.floor(Math.max(0, equity) / perLot));
    if (mode === "fixed") { const want = Math.max(1, Math.round(sz.lots ?? 1)); if (want > afford) capped++; return Math.min(want, afford); }
    if (mode === "risk" && stopPts && stopPts > 0) return Math.min(afford, Math.floor((equity * (sz.riskPct ?? 1) / 100) / (stopPts * sz.delta * sz.qty)));
    return afford; // capital mode, or risk mode without a stop
  };
  const oosStart = bars[Math.floor(bars.length * (1 - cfg.oosFraction))]?.t ?? Infinity;
  const sq = hhmm(spec.session.squareOff), lastEntry = hhmm(spec.session.noEntryAfter);
  const wins = (spec.session.windows ?? []).map(w => [hhmm(w.from), hhmm(w.to)] as const);
  const inWin = (m: number) => !wins.length || wins.some(([a, b]) => m >= a && m <= b);
  let equity = cfg.startingCapital, inMarket = 0, tradesToday = 0, dayNet = 0, skipped = 0, capped = 0;
  const trades: BtTrade[] = [], curve: Array<{ t: number; equity: number }> = [{ t: bars[0]?.t ?? 0, equity }];
  type Pos = { d: 1 | -1; entry: number; stop: number | null; target: number | null; t: number; i: number; best: number; lots: number };
  let pos: Pos | null = null;

  const close = (i: number, px: number, reason: string) => {
    if (!pos) return;
    const fill = px - pos.d * slip, pts = (fill - pos.entry) * pos.d, gross = pts * sz.delta * sz.qty * pos.lots;
    const charges = spec.costs.perTrade + (pos.lots - 1) * (spec.costs.perExtraLot ?? 15), net = gross - charges;
    equity += net; dayNet += net;
    trades.push({ n: trades.length + 1, side: pos.d === 1 ? "LONG" : "SHORT", entryTime: pos.t, exitTime: bars[i]!.t, entry: r2(pos.entry), exit: r2(fill), qty: sz.qty * pos.lots,
      stop: r2(pos.stop ?? NaN), target: r2(pos.target ?? NaN), grossPnl: r2(gross), charges: r2(charges), netPnl: r2(net), exitReason: reason, sample: pos.t >= oosStart ? "OUT" : "IN" });
    curve.push({ t: bars[i]!.t, equity: r2(equity) }); pos = null;
  };
  const open = (i: number, d: 1 | -1, px: number) => {
    const entry = px + d * slip, a = A[i - 1] ?? A[i] ?? null;
    let sd = spec.stop.type === "points" ? spec.stop.value : spec.stop.type === "pct" ? entry * spec.stop.value / 100 : spec.stop.type === "atr" && a ? a * spec.stop.value : null;
    if (spec.stop.type === "pivot") { // known by the previous candle's close
      const pv = cx.pivots(spec.trailing.k ?? 3), lvl = d === 1 ? pv.lo[i - 1] : pv.hi[i - 1];
      if (lvl != null) { const dist = (entry - lvl) * d + spec.stop.value; if (dist > 0) sd = dist; }
    }
    const stop = sd != null ? entry - d * sd : null;
    const td = spec.target.type === "points" ? spec.target.value : spec.target.type === "pct" ? entry * spec.target.value / 100 : spec.target.type === "rr" && sd != null ? sd * spec.target.value : null;
    const lots = lotsFor(sd); if (lots < 1) { skipped++; return; } // capital/risk too small for even one lot
    pos = { d, entry, stop, target: td != null ? entry + d * td : null, t: bars[i]!.t, i, best: entry, lots }; tradesToday++;
  };
  /** Manage an open position through candle i (intrabar stop/target, then close-based exits and trailing). */
  const manage = (i: number) => {
    if (!pos) return; const x = bars[i]!, L = pos.d === 1; inMarket++;
    if (pos.stop != null && (L ? x.o <= pos.stop : x.o >= pos.stop) && i > pos.i) return close(i, x.o, "STOP_GAP");
    if (pos.stop != null && (L ? x.l <= pos.stop : x.h >= pos.stop)) return close(i, pos.stop, "STOP");
    if (pos.target != null && (L ? x.h >= pos.target : x.l <= pos.target)) return close(i, (L ? x.o > pos.target : x.o < pos.target) && i > pos.i ? x.o : pos.target, "TARGET");
    const rules = L ? spec.long.exit : spec.short.exit;
    if (anyTrue(cx, rules, i, pos.i)) return close(i, x.c, "EXIT_RULE");
    if (!cfg.daily && cx.day.minuteEnd[i]! >= sq) return close(i, x.c, "SQUARE_OFF");
    if (!cfg.daily && wins.length && spec.session.exitAtWindowEnd && !inWin(cx.day.minuteEnd[i]!) ) return close(i, x.c, "WINDOW_END");
    const nextNewDay = i + 1 < bars.length && istDay(bars[i + 1]!.t) !== istDay(x.t);
    if (!cfg.daily && nextNewDay) return close(i, x.c, "SESSION_END");
    // trailing stop, updated on the candle close
    const gain = (x.c - pos.entry) * pos.d; pos.best = L ? Math.max(pos.best, x.c) : Math.min(pos.best, x.c);
    const tr = spec.trailing;
    if (tr.type === "step" && tr.every > 0) {
      const k = Math.floor(gain / tr.every);
      if (k >= 1) { const ns = pos.entry + pos.d * k * tr.by; if (pos.stop == null || (L ? ns > pos.stop : ns < pos.stop)) pos.stop = ns; }
    } else if (tr.type === "pivot" && gain >= tr.every) {
      const pv = cx.pivots(tr.k ?? 3), lvl = L ? pv.lo[i] : pv.hi[i];
      if (lvl != null) { const ns = lvl - pos.d * tr.by; if ((L ? ns < x.c : ns > x.c) && (pos.stop == null || (L ? ns > pos.stop : ns < pos.stop))) pos.stop = ns; }
    } else if (tr.type === "trail" && tr.every > 0 && gain >= tr.every) {
      const ns = pos.best - pos.d * tr.by; if (pos.stop == null || (L ? ns > pos.stop : ns < pos.stop)) pos.stop = ns;
    }
  };

  for (let i = 1; i < bars.length; i++) {
    const x = bars[i]!;
    if (cx.day.newDay[i]) { tradesToday = 0; dayNet = 0; }
    const lock = spec.session.dayProfitLock ?? 0, lim = spec.session.dayLossLimit ?? 0;
    // window check for entries: bar-close entries use the signal candle's close time, day-open entries use 09:15
    const canEnter = () => !pos && tradesToday < spec.session.maxTradesPerDay && !(lock > 0 && dayNet >= lock) && !(lim > 0 && dayNet <= -lim);
    // a) day-open entry: decided and filled at the first candle's open
    if (spec.entryMode === "dayOpen" && cx.day.newDay[i] && canEnter() && (cfg.daily || inWin(istMinutes(x.t)))) {
      if (spec.long.enabled && allTrue(cx, spec.long.entry, i, true)) open(i, 1, x.o);
      else if (spec.short.enabled && allTrue(cx, spec.short.entry, i, true)) open(i, -1, x.o);
    }
    // b) bar-close entry decided on the previous candle → fill at this candle's open
    if (spec.entryMode === "barClose" && canEnter() && i >= 2) {
      const p = i - 1, sameDay = cfg.daily || !cx.day.newDay[i];
      const okTime = cfg.daily || (cx.day.minuteEnd[p]! <= lastEntry && inWin(cx.day.minuteEnd[p]!));
      if (sameDay && okTime) {
        if (spec.long.enabled && allTrue(cx, spec.long.entry, p, false)) open(i, 1, x.o);
        else if (spec.short.enabled && allTrue(cx, spec.short.entry, p, false)) open(i, -1, x.o);
      }
    }
    manage(i);
  }
  if (pos) close(bars.length - 1, bars[bars.length - 1]!.c, "END_OF_DATA");
  return { trades, curve, inMarket, skipped, capped };
}
const r2 = (n: number) => Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;

export function runSpecBacktest(bars: Bar[], spec: StrategySpec, cfg: SpecBacktestConfig): BacktestResult {
  if (bars.length < 50) throw new Error("Not enough bars for a backtest (need ≥ 50)");
  const { trades, curve, inMarket, skipped, capped } = simulateSpec(bars, spec, cfg);
  const ins = trades.filter(t => t.sample === "IN"), outs = trades.filter(t => t.sample === "OUT");
  const s0 = spec.costs.slippagePoints, sz = spec.sizing, mode = sz.mode ?? "fixed", perLot = sz.capitalPerLot || DEFAULT_CAPITAL_PER_LOT;
  const sens = [0, s0, s0 * 2 || 0.5, s0 * 4 || 1].map(sp => {
    const r = simulateSpec(bars, spec, { ...cfg, slippagePointsOverride: sp }); const m = computeMetrics(r.trades, cfg.startingCapital, r.curve, 0, 1, false);
    return { slippageBps: sp, netPnl: m.netPnl, expectancy: m.expectancy };
  });
  const first = bars[0]!, last = bars[bars.length - 1]!;
  return {
    config: { strategyId: "custom", daily: cfg.daily, startingCapital: cfg.startingCapital, riskPerTradePct: 0, slippageBps: s0, product: "OPTIONS", allowShort: spec.short.enabled,
      squareOffIst: spec.session.squareOff, maxHoldBars: 0, lotSize: spec.sizing.qty, oosFraction: cfg.oosFraction } as BacktestResult["config"],
    bars: bars.length, from: first.t, to: last.t, trades, equity: curve,
    metrics: computeMetrics(trades, cfg.startingCapital, curve, inMarket, bars.length),
    inSample: computeMetrics(ins, cfg.startingCapital, curve), outOfSample: computeMetrics(outs, cfg.startingCapital, curve),
    buyHoldReturnPct: ((last.c - first.o) / first.o) * 100,
    slippageSensitivity: sens,
    assumptions: [
      spec.entryMode === "dayOpen" ? "Entry at the day's first candle OPEN, decided only from information known at the open." : "Entry decided on a CLOSED candle, filled at the next candle's open (no look-ahead).",
      "Exit conditions and trailing-stop moves use candle CLOSES; exit-rule fills at that close. Stop/target checked inside the candle (stop first if both touched).",
      `P&L = index points × delta ${sz.delta} × lot size ${sz.qty} × lots${sz.delta < 1 ? " (ATM option approximation — theta/IV/spread NOT modelled)" : ""}.`,
      mode === "fixed" ? `Sizing: fixed ${Math.max(1, Math.round(sz.lots ?? 1))} lot(s) per trade — capital does not change the P&L, only the % numbers.`
        : mode === "capital" ? `Sizing: lots = current capital ÷ ₹${perLot.toLocaleString("en-IN")} per lot (compounds with profits/losses).`
        : `Sizing: lots so a stop hit ≈ ${sz.riskPct ?? 1}% of current capital, max capital ÷ ₹${perLot.toLocaleString("en-IN")} per lot (no stop → capital-based).`,
      `Lots per trade are capped at capital ÷ ₹${perLot.toLocaleString("en-IN")} per lot and at max ${Math.max(1, Math.round(sz.maxLots ?? 20))} lots (order limits / liquidity). No capital left → no new trades.`,
      ...(capped ? [`⚠ ${capped} trade(s) used FEWER lots than requested (${Math.round(sz.lots ?? 1)}) — capital/max-lots limit.`] : []),
      ...(skipped ? [`⚠ ${skipped} signal(s) SKIPPED — capital/risk % too small for even 1 lot at that stop distance. Raise capital or risk %, or use Fixed lots.`] : []),
      `Costs: ₹${spec.costs.perTrade} per round trip for the first lot + ₹${spec.costs.perExtraLot ?? 15} per extra lot + ${spec.costs.slippagePoints} point(s) slippage per side. Slippage table shows points, not bps.`,
      cfg.daily ? "Daily candles: a 'day' is one candle; no intraday square-off." : `Intraday: square-off at ${spec.session.squareOff}; no entries after ${spec.session.noEntryAfter}; max ${spec.session.maxTradesPerDay} trade(s)/day${spec.session.dayProfitLock ? `; stop for the day at +₹${spec.session.dayProfitLock}` : ""}${spec.session.dayLossLimit ? `; stop for the day at −₹${spec.session.dayLossLimit}` : ""}.`,
      `Last ${Math.round(cfg.oosFraction * 100)}% of the period is out-of-sample.`,
    ],
  };
}

/** Preset: the user's "Jassu Market Trend". */
export const JASSU_MARKET_TREND: StrategySpec = {
  name: "Jassu Market Trend", version: 1,
  description: "Prev day green + open above yesterday's close → BUY CALL; exit on 2 candles closing below yesterday's close. Prev day red + open below → BUY PUT; exit on 2 candles closing above. Trailing: every 5 points in favour (on close) the stop moves 1 point.",
  entryMode: "dayOpen",
  long: { enabled: true,
    entry: [{ t: "prevDayColor", color: "green" }, { t: "compare", a: { k: "today", f: "open" }, op: ">", b: { k: "prevDay", f: "close" } }],
    exit: [{ t: "consecutive", n: 2, a: { k: "price", f: "close" }, op: "<", b: { k: "prevDay", f: "close" } }] },
  short: { enabled: true,
    entry: [{ t: "prevDayColor", color: "red" }, { t: "compare", a: { k: "today", f: "open" }, op: "<", b: { k: "prevDay", f: "close" } }],
    exit: [{ t: "consecutive", n: 2, a: { k: "price", f: "close" }, op: ">", b: { k: "prevDay", f: "close" } }] },
  stop: { type: "none", value: 0 }, target: { type: "none", value: 0 },
  trailing: { type: "step", every: 5, by: 1 },
  session: { squareOff: "15:15", noEntryAfter: "14:45", maxTradesPerDay: 1 },
  sizing: { qty: 75, delta: 0.5 },
  costs: { perTrade: 60, slippagePoints: 0.5 },
};


// ------------------------------------------------------------------ live (paper) trading — same rules as the backtest
/** stopIsLevel: pivot stops are an absolute index level; other stops are a distance to apply from the actual fill. */
export interface LiveEntry { dir: 1 | -1; entry: number; stop: number | null; target: number | null; barTime: number; reasons: string[]; stopIsLevel: boolean }
const stopFor = (cx: Ctx, spec: StrategySpec, i: number, d: 1 | -1, entry: number): number | null => {
  const a = atr(cx.b, 14)[i] ?? null;
  let sd = spec.stop.type === "points" ? spec.stop.value : spec.stop.type === "pct" ? entry * spec.stop.value / 100 : spec.stop.type === "atr" && a ? a * spec.stop.value : null;
  if (spec.stop.type === "pivot") { const pv = cx.pivots(spec.trailing.k ?? 3), lvl = d === 1 ? pv.lo[i] : pv.hi[i]; if (lvl != null) { const dist = (entry - lvl) * d + spec.stop.value; if (dist > 0) sd = dist; } }
  return sd != null ? entry - d * sd : null;
};
const targetFor = (spec: StrategySpec, d: 1 | -1, entry: number, stop: number | null): number | null => {
  const sd = stop != null ? Math.abs(entry - stop) : null;
  const td = spec.target.type === "points" ? spec.target.value : spec.target.type === "pct" ? entry * spec.target.value / 100 : spec.target.type === "rr" && sd != null ? sd * spec.target.value : null;
  return td != null ? entry + d * td : null;
};

/**
 * Entry decision on the LATEST CLOSED candle (bars must contain only completed candles, oldest first).
 * The caller enforces per-day limits (trades today, day lock) and the "already in a trade" rule.
 */
export function liveEntrySignal(bars: Bar[], spec: StrategySpec): LiveEntry | null {
  const i = bars.length - 1; if (i < 2) return null;
  const cx = new Ctx(bars, false), x = bars[i]!;
  const wins = (spec.session.windows ?? []).map(w => [hhmm(w.from), hhmm(w.to)] as const);
  const inWin = (m: number) => !wins.length || wins.some(([a, b]) => m >= a && m <= b);
  let side: 1 | -1 | 0 = 0, atOpen = false;
  if (spec.entryMode === "dayOpen") {
    // decided at today's first candle open (only open-time information), acted on once it has printed
    if (!cx.day.newDay[i] || !inWin(istMinutes(x.t))) return null; atOpen = true;
  } else {
    const m = cx.day.minuteEnd[i]!; if (m > hhmm(spec.session.noEntryAfter) || !inWin(m)) return null;
  }
  if (spec.long.enabled && allTrue(cx, spec.long.entry, i, atOpen)) side = 1;
  else if (spec.short.enabled && allTrue(cx, spec.short.entry, i, atOpen)) side = -1;
  if (!side) return null;
  const entry = atOpen ? x.o : x.c, stop = stopFor(cx, spec, atOpen ? i - 1 : i, side, entry);
  const rules = (side === 1 ? spec.long.entry : spec.short.entry).map(c => `✓ ${JSON.stringify(c)}`);
  return { dir: side, entry, stop, target: targetFor(spec, side, entry, stop), barTime: x.t, reasons: rules, stopIsLevel: spec.stop.type === "pivot" };
}

export interface LiveState { dir: 1 | -1; entry: number; stop: number | null; target: number | null; entryT: number }
/**
 * Replays the open position over every completed candle since entry (deterministic, same as the backtest) and returns
 * the current trailing stop and whether an exit (exit rule / stop / target / window end / square-off) has triggered.
 */
export function liveManage(bars: Bar[], spec: StrategySpec, st: LiveState): { exit: string | null; stop: number | null; best: number } {
  const cx = new Ctx(bars, false), L = st.dir === 1;
  const startIdx = bars.findIndex(b => b.t >= st.entryT); if (startIdx < 0) return { exit: null, stop: st.stop, best: st.entry };
  const sq = hhmm(spec.session.squareOff), wins = (spec.session.windows ?? []).map(w => [hhmm(w.from), hhmm(w.to)] as const);
  const inWin = (m: number) => !wins.length || wins.some(([a, b]) => m >= a && m <= b);
  let stop = st.stop, best = st.entry;
  for (let i = startIdx; i < bars.length; i++) {
    const x = bars[i]!;
    if (stop != null && (L ? x.l <= stop : x.h >= stop)) return { exit: "STOP", stop, best };
    if (st.target != null && (L ? x.h >= st.target : x.l <= st.target)) return { exit: "TARGET", stop, best };
    if (anyTrue(cx, L ? spec.long.exit : spec.short.exit, i, startIdx)) return { exit: "EXIT_RULE", stop, best };
    if (cx.day.minuteEnd[i]! >= sq) return { exit: "SQUARE_OFF", stop, best };
    if (wins.length && spec.session.exitAtWindowEnd && !inWin(cx.day.minuteEnd[i]!)) return { exit: "WINDOW_END", stop, best };
    const gain = (x.c - st.entry) * st.dir; best = L ? Math.max(best, x.c) : Math.min(best, x.c);
    const tr = spec.trailing;
    if (tr.type === "step" && tr.every > 0) { const k = Math.floor(gain / tr.every); if (k >= 1) { const ns = st.entry + st.dir * k * tr.by; if (stop == null || (L ? ns > stop : ns < stop)) stop = ns; } }
    else if (tr.type === "pivot" && gain >= tr.every) { const pv = cx.pivots(tr.k ?? 3), lvl = L ? pv.lo[i] : pv.hi[i]; if (lvl != null) { const ns = lvl - st.dir * tr.by; if ((L ? ns < x.c : ns > x.c) && (stop == null || (L ? ns > stop : ns < stop))) stop = ns; } }
    else if (tr.type === "trail" && tr.every > 0 && gain >= tr.every) { const ns = best - st.dir * tr.by; if (stop == null || (L ? ns > stop : ns < stop)) stop = ns; }
  }
  return { exit: null, stop, best };
}
