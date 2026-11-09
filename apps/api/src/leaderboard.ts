/**
 * Strategy leaderboard: backtest every strategy on the same basket of instruments and rank them.
 * Runs as a background job (CPU work yields between runs so the API and engine stay responsive).
 */
import type { PrismaClient } from "@prisma/client";
import { STRATEGIES, quickBacktest, runSpecBacktest, type Bar, type BtTrade, type StrategySpec } from "@dat/quant";
import type { BrokerHolder } from "./broker.ts";
import { refOf } from "./instruments.ts";
import { config } from "./config.ts";

/** Liquid NSE basket: the two main indices (what options traders trade) + 10 large, liquid NIFTY 50 stocks. */
export const LEADERBOARD_UNIVERSE = ["IDX_I:13", "IDX_I:25", "NSE_EQ:2885", "NSE_EQ:1333", "NSE_EQ:4963", "NSE_EQ:1594", "NSE_EQ:11536", "NSE_EQ:3045", "NSE_EQ:5900", "NSE_EQ:1922", "NSE_EQ:11483", "NSE_EQ:10604"];
const CAPITAL = 100000;

export interface LeaderboardRow {
  id: string; name: string; family: string; trades: number; winRate: number | null; profitFactor: number | null; grossProfitFactor: number | null;
  netPnl: number; capital: number; charges: number; grossPnl: number; returnPct: number; avgTradePct: number | null; maxDrawdownPct: number; profitableInstruments: number; testedInstruments: number;
  inSample: { trades: number; returnPct: number; profitFactor: number | null }; outOfSample: { trades: number; returnPct: number; profitFactor: number | null; winRate: number | null };
  robust: boolean;
  /** Same metrics for each instrument on its own (table instrument filter). */
  perInstrument?: Record<string, InstrumentRow>;
}
export interface InstrumentRow { trades: number; wins: number; gross: number; charges: number; net: number; profitFactor: number | null; grossProfitFactor: number | null;
  maxDrawdownPct: number; isNet: number; oosNet: number; oosTrades: number; oosProfitFactor: number | null; oosWins: number }
export interface LeaderboardStatus { running: boolean; phase: string; done: number; total: number; error: string | null; startedAt: string | null }

const pf = (t: BtTrade[]) => { let w = 0, l = 0; for (const x of t) x.netPnl > 0 ? (w += x.netPnl) : (l -= x.netPnl); return l > 0 ? w / l : null; };
const pfGross = (t: BtTrade[]) => { let w = 0, l = 0; for (const x of t) x.grossPnl > 0 ? (w += x.grossPnl) : (l -= x.grossPnl); return l > 0 ? w / l : null; };
const sum = (t: BtTrade[]) => t.reduce((a, x) => a + x.netPnl, 0);
export interface Agg { trades: number; wins: number; gross: number; charges: number; net: number }
interface InstrumentStat extends Agg { symbol: string; maxDrawdownPct: number }
function agg(t: BtTrade[]): Agg {
  let wins = 0, gross = 0, charges = 0, net = 0;
  for (const x of t) { if (x.netPnl > 0) wins++; gross += x.grossPnl; charges += x.charges; net += x.netPnl; }
  return { trades: t.length, wins, gross: Math.round(gross), charges: Math.round(charges), net: Math.round(net) };
}
const r2 = (n: number) => Math.round(n * 100) / 100;
/** Trade list (compact tuples) + breakdowns for the strategy detail page. */
function buildDetail(symbols: string[], tagged: Array<{ k: number; t: BtTrade }>, perInst: InstrumentStat[]) {
  const sorted = [...tagged].sort((a, b) => a.t.exitTime - b.t.exitTime);
  const byYear = new Map<number, BtTrade[]>(), byReason = new Map<string, BtTrade[]>();
  for (const { t } of sorted) {
    const y = new Date((t.exitTime + 19800) * 1000).getUTCFullYear();
    (byYear.get(y) ?? byYear.set(y, []).get(y)!).push(t); (byReason.get(t.exitReason) ?? byReason.set(t.exitReason, []).get(t.exitReason)!).push(t);
  }
  let cum = 0; const eq = sorted.map(({ t }) => ({ t: t.exitTime, v: Math.round(cum += t.netPnl) }));
  const step = Math.max(1, Math.ceil(eq.length / 1500));
  return {
    fields: ["sym", "side", "entryT", "exitT", "entry", "exit", "qty", "gross", "charges", "net", "reason", "sample"],
    symbols, instruments: perInst.sort((a, b) => b.net - a.net),
    years: [...byYear.entries()].map(([year, t]) => ({ year, ...agg(t) })),
    exitReasons: [...byReason.entries()].map(([reason, t]) => ({ reason, ...agg(t) })).sort((a, b) => b.trades - a.trades),
    equity: eq.filter((_, i) => i % step === 0 || i === eq.length - 1),
    trades: sorted.map(({ k, t }) => [k, t.side === "LONG" ? 1 : -1, t.entryTime, t.exitTime, r2(t.entry), r2(t.exit), t.qty, r2(t.grossPnl), r2(t.charges), r2(t.netPnl), t.exitReason, t.sample === "OUT" ? 1 : 0]),
  };
}
const tick = () => new Promise<void>(r => setImmediate(r));

export class Leaderboard {
  status: LeaderboardStatus = { running: false, phase: "idle", done: 0, total: 0, error: null, startedAt: null };
  constructor(private prisma: PrismaClient, private broker: BrokerHolder, private clock: () => Date) {}

  start(years = 1, interval: 5 | 15 | "D" = 5, keys?: string[], slippageBps = 5): LeaderboardStatus {
    if (this.status.running) return this.status;
    this.status = { running: true, phase: "Fetching candles", done: 0, total: 0, error: null, startedAt: this.clock().toISOString() };
    void this.run(interval === "D" ? 10 : Math.min(Math.max(years, 0.25), 2), interval, keys?.length ? keys.slice(0, 20) : LEADERBOARD_UNIVERSE, Math.min(Math.max(slippageBps, 0), 50)).catch(e => { this.status = { ...this.status, running: false, phase: "failed", error: (e as Error).message }; });
    return this.status;
  }

  private async run(years: number, interval: 5 | 15 | "D", keys: string[], slip: number) {
    const daily = interval === "D";
    const insts = await this.prisma.instrument.findMany({ where: { key: { in: keys } } });
    const to = this.clock(), from = new Date(to.getTime() - years * 365.25 * 86400000);
    const data: Array<{ symbol: string; bars: Bar[]; index: boolean }> = [];
    this.status.total = insts.length;
    for (const inst of insts) {
      this.status.phase = `Fetching ${daily ? "daily" : interval + "-min"} candles · ${inst.symbol}`;
      const bars = await this.broker.current.getCandles({ ref: refOf(inst), interval, from, to });
      if (bars.length >= 200) data.push({ symbol: inst.symbol, bars, index: inst.instrumentType === "INDEX" });
      this.status.done++;
    }
    if (!data.length) throw new Error("No candle data returned — check the Dhan connection.");

    // Built-in strategies + the user's Strategy Builder strategies ("custom:<id>").
    const customs = new Map((await this.prisma.customStrategy.findMany()).map(c => [`custom:${c.id}`, c]));
    const ids = [...customs.keys(), ...Object.keys(STRATEGIES)];
    this.status.phase = "Backtesting"; this.status.done = 0; this.status.total = ids.length * data.length;
    const rows: LeaderboardRow[] = []; const details: Array<{ strategyId: string; data: object }> = [];
    const symbols = data.map(d => d.symbol);
    for (const id of ids) {
      const cs = customs.get(id), s = cs ? { name: cs.name, family: "My custom" } : STRATEGIES[id]!; const all: BtTrade[] = []; let profitable = 0, tested = 0, mdd = 0;
      const perInst: InstrumentStat[] = []; const perRow: Record<string, InstrumentRow> = {}; const tagged: Array<{ k: number; t: BtTrade }> = [];
      for (const [k, d] of data.entries()) {
        const r = cs ? runSpecBacktest(d.bars, cs.spec as unknown as StrategySpec, { daily, startingCapital: CAPITAL, oosFraction: 0.3 }) : quickBacktest(d.bars, { strategyId: id, daily, startingCapital: CAPITAL, riskPerTradePct: 0.5, slippageBps: slip, // Indices trade via futures/options → futures charges; stocks: cash delivery (daily) or intraday.
          product: d.index ? "FUTURES" : daily ? "EQUITY_DELIVERY" : "EQUITY_INTRADAY",
          // Daily = cash delivery: long-only (no overnight shorting in cash), 15-day max hold.
          allowShort: !daily, squareOffIst: config.squareOffIst, maxHoldBars: daily ? 15 : 60, lotSize: 1, oosFraction: 0.3 });
        this.status.done++; await tick();
        if (!r.trades.length) continue;
        tested++; if (r.metrics.netPnl > 0) profitable++; mdd = Math.max(mdd, r.metrics.maxDrawdownPct); all.push(...r.trades);
        for (const t of r.trades) tagged.push({ k, t });
        perInst.push({ symbol: d.symbol, ...agg(r.trades), maxDrawdownPct: r.metrics.maxDrawdownPct });
        const io = r.trades.filter(t => t.sample === "OUT"), ii = r.trades.filter(t => t.sample === "IN");
        perRow[d.symbol] = { ...agg(r.trades), profitFactor: pf(r.trades), grossProfitFactor: pfGross(r.trades), maxDrawdownPct: r.metrics.maxDrawdownPct,
          isNet: Math.round(sum(ii)), oosNet: Math.round(sum(io)), oosTrades: io.length, oosProfitFactor: pf(io), oosWins: io.filter(t => t.netPnl > 0).length };
      }
      const ins = all.filter(t => t.sample === "IN"), oos = all.filter(t => t.sample === "OUT"), base = CAPITAL * Math.max(tested, 1);
      const wins = all.filter(t => t.netPnl > 0).length, net = sum(all);
      const row: LeaderboardRow = {
        id, name: s.name, family: s.family, trades: all.length, winRate: all.length ? wins / all.length : null, profitFactor: pf(all), grossProfitFactor: pfGross(all),
        netPnl: Math.round(net), capital: CAPITAL * tested, charges: Math.round(all.reduce((a, t) => a + t.charges, 0)),
        grossPnl: Math.round(all.reduce((a, t) => a + t.grossPnl, 0)), returnPct: (net / base) * 100, avgTradePct: all.length ? (net / all.length / CAPITAL) * 100 : null, maxDrawdownPct: mdd,
        profitableInstruments: profitable, testedInstruments: tested,
        inSample: { trades: ins.length, returnPct: (sum(ins) / base) * 100, profitFactor: pf(ins) },
        outOfSample: { trades: oos.length, returnPct: (sum(oos) / base) * 100, profitFactor: pf(oos), winRate: oos.length ? oos.filter(t => t.netPnl > 0).length / oos.length : null },
        robust: false, perInstrument: perRow,
      };
      // "Robust" = enough trades, profitable overall AND in both halves (the out-of-sample part was never used to pick anything).
      row.robust = row.trades >= 50 && oos.length >= 15 && (row.profitFactor ?? 0) >= 1.1 && sum(ins) > 0 && sum(oos) > 0;
      rows.push(row);
      details.push({ strategyId: id, data: buildDetail(symbols, tagged, perInst) });
    }
    rows.sort((a, b) => Number(b.robust) - Number(a.robust) || b.returnPct - a.returnPct);
    const first = Math.min(...data.map(d => d.bars[0]!.t)), last = Math.max(...data.map(d => d.bars[d.bars.length - 1]!.t));
    const created = await this.prisma.leaderboardRun.create({ data: { dataSource: this.broker.source, rows: rows as object,
      config: { interval: daily ? "Daily" : `${interval}m`, years, from: first, to: last, instruments: data.map(d => d.symbol), capitalPerInstrument: CAPITAL, riskPerTradePct: 0.5, slippageBps: slip,
        product: data.every(d => d.index) ? "FUTURES" : data.some(d => d.index) ? `FUTURES (indices) + ${daily ? "EQUITY_DELIVERY" : "EQUITY_INTRADAY"} (stocks)` : daily ? "EQUITY_DELIVERY" : "EQUITY_INTRADAY", oosFraction: 0.3, squareOffIst: config.squareOffIst } } });
    this.status.phase = "Saving trade details";
    for (let k = 0; k < details.length; k += 10) await this.prisma.leaderboardDetail.createMany({ data: details.slice(k, k + 10).map(d => ({ runId: created.id, ...d })) });
    this.status = { ...this.status, running: false, phase: "done", done: this.status.total };
  }

  async detail(runId: string, strategyId: string) {
    const [run, d] = await Promise.all([this.prisma.leaderboardRun.findUnique({ where: { id: runId } }), this.prisma.leaderboardDetail.findUnique({ where: { runId_strategyId: { runId, strategyId } } })]);
    if (!run) return null;
    const row = (run.rows as unknown as LeaderboardRow[]).find(r => r.id === strategyId) ?? null;
    return { run: { id: run.id, createdAt: run.createdAt, dataSource: run.dataSource, config: run.config }, row, detail: d?.data ?? null };
  }

  latest() { return this.prisma.leaderboardRun.findFirst({ orderBy: { createdAt: "desc" } }); }
}
