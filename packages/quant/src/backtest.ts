import { type Bar, istDay, istMinutes } from "./types.ts";
import { DEFAULT_PARAMS, STRATEGIES, precompute, type StrategyParams } from "./strategies.ts";
import { orderCharges, type ProductKind } from "./costs.ts";

export interface BacktestConfig {
  strategyId: string; params?: Partial<StrategyParams>; daily: boolean;
  startingCapital: number; riskPerTradePct: number; slippageBps: number; product: ProductKind;
  allowShort: boolean; squareOffIst: string; maxHoldBars: number; lotSize: number; oosFraction: number;
  /** CRYPTO = 24x7 market: no square-off, no forced close at day change, no entry-time limits. */
  market?: "NSE" | "CRYPTO";
}
export interface BtTrade {
  n: number; side: "LONG" | "SHORT"; entryTime: number; exitTime: number; entry: number; exit: number; qty: number;
  stop: number; target: number; grossPnl: number; charges: number; netPnl: number; exitReason: string; sample: "IN" | "OUT";
}
export interface Metrics {
  trades: number; winRate: number | null; avgWin: number | null; avgLoss: number | null; expectancy: number | null;
  expectancyCI90: [number, number] | null; profitFactor: number | null; netPnl: number; returnPct: number;
  maxDrawdownPct: number; sharpe: number | null; sortino: number | null; maxConsecLosses: number; exposurePct: number; totalCharges: number;
}
export interface BacktestResult {
  config: BacktestConfig; bars: number; from: number; to: number; trades: BtTrade[];
  equity: Array<{ t: number; equity: number }>; metrics: Metrics; inSample: Metrics; outOfSample: Metrics; buyHoldReturnPct: number;
  slippageSensitivity: Array<{ slippageBps: number; netPnl: number; expectancy: number | null }>; assumptions: string[];
}

const hhmm = (s: string) => { const [h, m] = s.split(":").map(Number); return h! * 60 + m!; };

/** Seeded RNG for reproducible bootstrap */
function rng(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }

export function computeMetrics(trades: BtTrade[], startingCapital: number, equity: Array<{ t: number; equity: number }>, barsInMarket = 0, totalBars = 1, bootstrap = true): Metrics {
  const pnl = trades.map(t => t.netPnl), wins = pnl.filter(p => p > 0), losses = pnl.filter(p => p <= 0);
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  const n = trades.length, net = sum(pnl);
  let peak = startingCapital, mdd = 0;
  for (const e of equity) { peak = Math.max(peak, e.equity); mdd = Math.max(mdd, (peak - e.equity) / peak); }
  let cl = 0, mcl = 0; for (const p of pnl) { cl = p <= 0 ? cl + 1 : 0; mcl = Math.max(mcl, cl); }
  // Daily returns for Sharpe/Sortino
  const byDay = new Map<number, number>(); for (const t of trades) byDay.set(istDay(t.exitTime), (byDay.get(istDay(t.exitTime)) ?? 0) + t.netPnl);
  const dr = [...byDay.values()].map(v => v / startingCapital);
  const mean = dr.length ? sum(dr) / dr.length : 0;
  const sd = dr.length > 1 ? Math.sqrt(sum(dr.map(r => (r - mean) ** 2)) / (dr.length - 1)) : 0;
  const dsd = dr.length > 1 ? Math.sqrt(sum(dr.map(r => Math.min(r, 0) ** 2)) / (dr.length - 1)) : 0;
  let ci: [number, number] | null = null;
  if (bootstrap && n >= 10) {
    const r = rng(12345), means: number[] = [];
    for (let k = 0; k < 2000; k++) { let s = 0; for (let j = 0; j < n; j++) s += pnl[Math.floor(r() * n)]!; means.push(s / n); }
    means.sort((a, b) => a - b); ci = [means[100]!, means[1899]!];
  }
  return {
    trades: n, winRate: n ? wins.length / n : null, avgWin: wins.length ? sum(wins) / wins.length : null,
    avgLoss: losses.length ? sum(losses) / losses.length : null, expectancy: n ? net / n : null, expectancyCI90: ci,
    profitFactor: losses.length && sum(losses) !== 0 ? sum(wins) / Math.abs(sum(losses)) : wins.length ? Infinity : null,
    netPnl: Math.round(net * 100) / 100, returnPct: (net / startingCapital) * 100, maxDrawdownPct: mdd * 100,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(252) : null, sortino: dsd > 0 ? (mean / dsd) * Math.sqrt(252) : null,
    maxConsecLosses: mcl, exposurePct: (barsInMarket / Math.max(totalBars, 1)) * 100, totalCharges: Math.round(sum(trades.map(t => t.charges)) * 100) / 100,
  };
}

function simulate(bars: Bar[], cfg: BacktestConfig) {
  const p = { ...DEFAULT_PARAMS, ...cfg.params, ...(cfg.market === "CRYPTO" ? { noEntryBeforeIst: "00:00", noEntryAfterIst: "23:59" } : {}) };
  const strat = STRATEGIES[cfg.strategyId]; if (!strat) throw new Error(`Unknown strategy ${cfg.strategyId}`);
  const pc = precompute(bars, p, cfg.daily);
  const slip = cfg.slippageBps / 10000, sq = hhmm(cfg.squareOffIst);
  const oosStart = bars[Math.floor(bars.length * (1 - cfg.oosFraction))]?.t ?? Infinity;
  let equity = cfg.startingCapital, inMarket = 0;
  const trades: BtTrade[] = [], curve: Array<{ t: number; equity: number }> = [{ t: bars[0]?.t ?? 0, equity }];
  let pos = null as null | { side: "LONG" | "SHORT"; entry: number; qty: number; stop: number; target: number; t: number; bars: number; entryCharges: number };

  const close = (i: number, px: number, reason: string) => {
    if (!pos) return;
    const fill = pos.side === "LONG" ? px * (1 - slip) : px * (1 + slip);
    const gross = (pos.side === "LONG" ? fill - pos.entry : pos.entry - fill) * pos.qty;
    const ch = pos.entryCharges + orderCharges(cfg.product, pos.side === "LONG" ? "SELL" : "BUY", fill * pos.qty);
    const net = gross - ch; equity += net;
    trades.push({ n: trades.length + 1, side: pos.side, entryTime: pos.t, exitTime: bars[i]!.t, entry: r2(pos.entry), exit: r2(fill), qty: pos.qty,
      stop: r2(pos.stop), target: r2(pos.target), grossPnl: r2(gross), charges: ch, netPnl: r2(net), exitReason: reason, sample: pos.t >= oosStart ? "OUT" : "IN" });
    curve.push({ t: bars[i]!.t, equity: r2(equity) }); pos = null;
  };

  const maxHold = strat.maxHoldBars ?? cfg.maxHoldBars;
  const open = (s: ReturnType<typeof strat.evaluate>, px: number, t: number) => {
    if (s.action !== "ENTER" || s.stop === null || s.entry === null) return;
    const side = s.direction === "BULLISH" ? "LONG" : "SHORT";
    if (side === "SHORT" && !cfg.allowShort) return;
    const entry = side === "LONG" ? px * (1 + slip) : px * (1 - slip);
    const riskPerUnit = Math.abs(entry - s.stop);
    if (riskPerUnit <= 0 || (side === "LONG" ? s.stop >= entry : s.stop <= entry)) return;
    const lots = Math.floor((equity * cfg.riskPerTradePct / 100) / (riskPerUnit * cfg.lotSize));
    const maxLots = Math.floor(equity / (entry * cfg.lotSize));
    const qty = (strat.fullCapital ? maxLots : Math.min(lots, maxLots)) * cfg.lotSize;
    if (qty <= 0) return;
    // Each strategy sets its own reward:risk via the signal's target; fall back to params for older signals.
    const rr = s.target !== null && Math.abs(s.entry - s.stop) > 0 ? Math.abs(s.target - s.entry) / Math.abs(s.entry - s.stop) : p.rewardRisk;
    // Rule-exit strategies have no fixed target.
    const target = strat.exitRule && s.target === null ? (side === "LONG" ? Infinity : -Infinity) : side === "LONG" ? entry + riskPerUnit * rr : entry - riskPerUnit * rr;
    pos = { side, entry, qty, stop: s.stop, target, t, bars: 0, entryCharges: orderCharges(cfg.product, side === "LONG" ? "BUY" : "SELL", entry * qty) };
  };
  for (let i = 1; i < bars.length; i++) {
    const x = bars[i]!, prev = bars[i - 1]!;
    // 1) Manage open position on this bar (stop first = conservative when both touched)
    if (pos) {
      inMarket++; pos.bars++;
      const L = pos.side === "LONG";
      const newDay = istDay(x.t) !== istDay(prev.t);
      const ruleExit = strat.exitRule ? strat.exitRule(bars, i - 1, pos.side) : null; // decided on the previous close
      if (!cfg.daily && newDay && cfg.market !== "CRYPTO") { close(i - 1, prev.c, "SESSION_END"); }
      else if (ruleExit) close(i, x.o, "EXIT_RULE");
      else if (L ? x.o <= pos.stop : x.o >= pos.stop) close(i, x.o, "STOP_GAP");
      else if (L ? x.l <= pos.stop : x.h >= pos.stop) close(i, pos.stop, "STOP");
      else if (L ? x.o >= pos.target : x.o <= pos.target) close(i, x.o, "TARGET_GAP");
      else if (L ? x.h >= pos.target : x.l <= pos.target) close(i, pos.target, "TARGET");
      else if (!cfg.daily && cfg.market !== "CRYPTO" && istMinutes(x.t) >= sq) close(i, x.c, "SQUARE_OFF");
      else if (pos.bars >= maxHold) close(i, x.c, "TIME_STOP");
    }
    // 2) Signal on CLOSED previous bar -> enter at this bar's open (no look-ahead)
    if (!pos && i >= 2 && !strat.entryAtClose) {
      if (!cfg.daily && cfg.market !== "CRYPTO" && (istDay(x.t) !== istDay(prev.t) || istMinutes(x.t) >= sq)) continue;
      open(strat.evaluate(bars, i - 1, pc, p, cfg.daily), x.o, x.t);
    }
    // 2b) Close-entry strategies: signal on THIS bar's close, filled at that close (e.g. buy at 15:25).
    if (!pos && strat.entryAtClose && i < bars.length - 1) open(strat.evaluate(bars, i, pc, p, cfg.daily), x.c, x.t);
  }
  if (pos) close(bars.length - 1, bars[bars.length - 1]!.c, "END_OF_DATA");
  return { trades, curve, inMarket, oosStart };
}
const r2 = (n: number) => Math.round(n * 100) / 100;

export function runBacktest(bars: Bar[], cfg: BacktestConfig): BacktestResult {
  if (bars.length < 50) throw new Error("Not enough bars for a backtest (need ≥ 50)");
  const { trades, curve, inMarket } = simulate(bars, cfg);
  const ins = trades.filter(t => t.sample === "IN"), outs = trades.filter(t => t.sample === "OUT");
  const sens = [0, cfg.slippageBps, cfg.slippageBps * 2 || 5, cfg.slippageBps * 4 || 10].map(bps => {
    const r = simulate(bars, { ...cfg, slippageBps: bps }); const m = computeMetrics(r.trades, cfg.startingCapital, r.curve);
    return { slippageBps: bps, netPnl: m.netPnl, expectancy: m.expectancy };
  });
  const first = bars[0]!, last = bars[bars.length - 1]!;
  return {
    config: cfg, bars: bars.length, from: first.t, to: last.t, trades, equity: curve,
    metrics: computeMetrics(trades, cfg.startingCapital, curve, inMarket, bars.length),
    inSample: computeMetrics(ins, cfg.startingCapital, curve), outOfSample: computeMetrics(outs, cfg.startingCapital, curve),
    buyHoldReturnPct: ((last.c - first.o) / first.o) * 100, slippageSensitivity: sens,
    assumptions: [
      "Signals computed on CLOSED bars only; entries fill at the NEXT bar's open (no look-ahead).",
      `Slippage ${cfg.slippageBps} bps per side; charges model: ${cfg.product} (approximate statutory + brokerage, verify current rates).`,
      "If stop and target are both touched inside one bar, the STOP is assumed (conservative). Gaps fill at the open.",
      cfg.daily ? "Daily bars: VWAP replaced by rolling 20-bar VWAP; positions may be held overnight (gap risk included via open fills)." : `Intraday: forced square-off at ${cfg.squareOffIst} IST; no overnight positions.`,
      "P&L is on the UNDERLYING price series. This is NOT option P&L — option premium, theta and IV are not modelled here.",
      `Last ${Math.round(cfg.oosFraction * 100)}% of the period is out-of-sample. Small samples do not establish future profitability.`,
    ],
  };
}

/** Fast path for batch runs (leaderboard): one simulation, no slippage sweep, no bootstrap CI. */
export function quickBacktest(bars: Bar[], cfg: BacktestConfig): { trades: BtTrade[]; metrics: Metrics } {
  const { trades, curve, inMarket } = simulate(bars, cfg);
  return { trades, metrics: computeMetrics(trades, cfg.startingCapital, curve, inMarket, bars.length, false) };
}

export function tradesToCsv(trades: BtTrade[]): string {
  const iso = (t: number) => new Date(t * 1000).toISOString();
  const h = "n,side,entryTimeUTC,exitTimeUTC,entry,exit,qty,stop,target,grossPnl,charges,netPnl,exitReason,sample";
  return [h, ...trades.map(t => [t.n, t.side, iso(t.entryTime), iso(t.exitTime), t.entry, t.exit, t.qty, t.stop, t.target, t.grossPnl, t.charges, t.netPnl, t.exitReason, t.sample].join(","))].join("\n");
}
