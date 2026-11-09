import type { PrismaClient, Instrument, PaperTrade, TradingSession } from "@prisma/client";
import { Decimal, toIstDate, toIstHHMM, type DailySession, type OrderIntent } from "@dat/shared";
import { evaluateSessionLimits, preTradeCheck } from "@dat/risk-engine";
import { liveEntrySignal, liveManage, type StrategySpec, STRATEGIES, evaluateLatest, orderCharges, DEFAULT_PARAMS, type Bar, type StrategyParams, type StrategySignal, type ProductKind } from "@dat/quant";
import type { InstrumentRef, LiveQuote, OptionLeg } from "@dat/broker-dhan";
import type { BrokerHolder } from "./broker.ts";
import { config, EFFECTIVE_MODE } from "./config.ts";
import { nearestFuture, refOf } from "./instruments.ts";

/** Trading styles map to bar interval + parameter overrides + carry policy. */
export const STYLES: Record<string, { label: string; interval: 1 | 5 | 15; params: Partial<StrategyParams>; carry: boolean }> = {
  SCALPING: { label: "Scalper (1-min)", interval: 1, params: { breakoutLookback: 5, relVolMin: 1.8, stopAtr: 0.8, rewardRisk: 1.5, adxMin: 22 }, carry: false },
  INTRADAY: { label: "Intraday (5-min)", interval: 5, params: {}, carry: false },
  POSITIONAL: { label: "Carry forward (15-min)", interval: 15, params: { rewardRisk: 2.5, stopAtr: 1.5 }, carry: true },
};

export function toDto(s: TradingSession): DailySession & { maxConsecutiveLosses: number } {
  return {
    id: s.id, tradingDate: s.tradingDate, mode: s.mode, capitalInr: s.capitalInr.toFixed(2), maxLossInr: s.maxLossInr.toFixed(2),
    maxProfitInr: s.maxProfitInr ? s.maxProfitInr.toFixed(2) : null, riskPerTradePct: s.riskPerTradePct.toFixed(2), status: s.status,
    realizedPnlInr: s.realizedPnlInr.toFixed(2), unrealizedPnlInr: s.unrealizedPnlInr.toFixed(2), consecutiveLosses: s.consecutiveLosses, maxConsecutiveLosses: s.maxConsecutiveLosses, startedAt: s.startedAt.toISOString(),
  };
}

export function marketOpen(now: Date) {
  const day = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kolkata", weekday: "short" }).format(now);
  const hm = toIstHHMM(now);
  return day !== "Sat" && day !== "Sun" && hm >= "09:15" && hm < "15:30"; // exchange holidays not yet modelled
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const roundTick = (n: number, tick = 0.05) => r2(Math.round(n / tick) * tick);

/** Mock option contracts are encoded in the key so they can be re-priced: MOCKOPT|<underKey>|<expiry>|<strike>|<CE|PE> */
const mockOptKey = (uKey: string, exp: string, strike: number, t: "CE" | "PE") => `MOCKOPT|${uKey}|${exp}|${strike}|${t}`;

export interface EngineStatus { running: boolean; lastTick: string | null; lastError: string | null; marketOpen: boolean; ticks: number; log: string[] }

export class PaperEngine {
  status: EngineStatus = { running: false, lastTick: null, lastError: null, marketOpen: false, ticks: 0, log: [] };
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private barCache = new Map<string, { slot: number; bars: Bar[] }>();
  quotes = new Map<string, LiveQuote & { key: string }>();

  constructor(private prisma: PrismaClient, private broker: BrokerHolder, private clock: () => Date, private audit: (a: string, d: object, c?: string) => Promise<unknown>) {}

  log(msg: string) { this.status.log.unshift(`${toIstHHMM(this.clock())} ${msg}`); this.status.log.length = Math.min(this.status.log.length, 60); }
  start() { if (this.timer) return; this.status.running = true; this.timer = setInterval(() => void this.tick(), config.engineTickMs); void this.tick(); }
  stop() { this.status.running = false; if (this.timer) clearInterval(this.timer); this.timer = null; }
  /** Background monitor of open positions even when auto-entries are off. */
  startMonitor() { setInterval(() => { if (!this.status.running) void this.tick(true); }, config.engineTickMs * 2); }
  clearCache() { this.barCache.clear(); this.quotes.clear(); }

  today() { return toIstDate(this.clock()); }
  currentSession() { return this.prisma.tradingSession.findUnique({ where: { tradingDate: this.today() } }); }

  async ensureSession(): Promise<TradingSession | null> {
    const s = await this.currentSession(); if (s) return s;
    const p = await this.prisma.preferences.findUnique({ where: { id: 1 } });
    if (!p?.autoStartDaily || !marketOpen(this.clock())) return null;
    const created = await this.prisma.tradingSession.create({ data: { tradingDate: this.today(), mode: EFFECTIVE_MODE, capitalInr: p.defaultCapital,
      maxLossInr: p.defaultMaxLoss, maxProfitInr: p.defaultMaxProfit, riskPerTradePct: p.defaultRiskPct, maxConsecutiveLosses: p.defaultMaxConsecutiveLosses } }).catch(() => null);
    if (created) { await this.audit("SESSION_AUTO_STARTED", { capital: p.defaultCapital, maxLoss: p.defaultMaxLoss, maxProfit: p.defaultMaxProfit ?? "UNLIMITED" }); this.log("Day auto-started with saved defaults"); }
    return created ?? this.currentSession();
  }

  /** Completed bars only (last bar dropped if still forming). Re-fetched once per interval slot. */
  async completedBars(ref: InstrumentRef, interval: 1 | 5 | 15): Promise<Bar[]> {
    const now = this.clock().getTime() / 1000, slot = Math.floor(now / (interval * 60));
    const k = `${ref.segment}:${ref.securityId}:${interval}`, hit = this.barCache.get(k);
    if (hit && hit.slot === slot) return hit.bars;
    const from = new Date((now - 6 * 86400) * 1000);
    const bars = (await this.broker.current.getCandles({ ref, interval, from, to: this.clock() })).filter(b => b.t + interval * 60 <= now);
    this.barCache.set(k, { slot, bars }); return bars;
  }

  /** Last known bars without waiting; triggers a background refresh when the slot changed. */
  cachedBars(ref: InstrumentRef, interval: 1 | 5 | 15): Bar[] | null {
    const k = `${ref.segment}:${ref.securityId}:${interval}`, hit = this.barCache.get(k);
    const slot = Math.floor(this.clock().getTime() / 1000 / (interval * 60));
    if (!hit || hit.slot !== slot) { if (!this.refreshing.has(k)) { this.refreshing.add(k); void this.completedBars(ref, interval).catch(() => null).finally(() => this.refreshing.delete(k)); } }
    return hit?.bars ?? null;
  }
  private refreshing = new Set<string>();

  /** Underlying used for signals: indices use their nearest future (index has no volume → no VWAP) when available. */
  async signalSource(u: Instrument): Promise<Instrument> {
    if (u.instrumentType !== "INDEX" || this.broker.source === "MOCK") return u;
    return (await nearestFuture(this.prisma, u, this.today())) ?? u;
  }

  /** Price any instrument key, incl. mock option contracts. */
  async priceKeys(keys: string[]): Promise<Map<string, LiveQuote>> {
    const out = new Map<string, LiveQuote>(), refs: Array<{ key: string; ref: InstrumentRef }> = [];
    for (const k of new Set(keys)) {
      if (k.startsWith("MOCKOPT|")) {
        const [, uKey, exp, strike, t] = k.split("|"); const u = await this.prisma.instrument.findUnique({ where: { key: uKey! } }); if (!u) continue;
        const ch = await this.broker.mock.getOptionChain(refOf(u), exp!); const row = ch.strikes.find(s => s.strike === Number(strike)); const leg = row?.[t === "CE" ? "ce" : "pe"];
        if (leg?.ltp) out.set(k, { securityId: k, segment: "NSE_FNO", ltp: leg.ltp, bid: leg.bid, ask: leg.ask, volume: leg.volume, open: null, high: null, low: null, prevClose: null, oi: leg.oi, sourceTs: ch.fetchedAt, receivedTs: ch.fetchedAt, source: "MOCK" });
        continue;
      }
      const [segment, securityId] = k.split(":");
      const inst = await this.prisma.instrument.findUnique({ where: { key: k } });
      // MOCK: futures track their underlying's synthetic price
      if (this.broker.source === "MOCK" && inst && inst.instrumentType.startsWith("FUT")) {
        const u = await this.prisma.instrument.findFirst({ where: inst.instrumentType === "FUTIDX" ? { instrumentType: "INDEX", symbol: inst.underlyingSymbol ?? "" } : { key: `NSE_EQ:${inst.underlyingSecurityId}` } });
        if (u) { refs.push({ key: k, ref: refOf(u) }); continue; }
      }
      refs.push({ key: k, ref: inst ? refOf(inst) : { securityId: securityId!, segment: segment as InstrumentRef["segment"], instrumentType: "OPTIDX", symbol: k } });
    }
    if (refs.length) {
      const qs = await this.broker.current.getQuotes(refs.map(r => r.ref));
      for (const r of refs) { const q = qs.find(x => x.securityId === r.ref.securityId && x.segment === r.ref.segment); if (q) out.set(r.key, q); }
    }
    for (const [k, q] of out) this.quotes.set(k, { ...q, key: k });
    return out;
  }

  async tick(monitorOnly = false) {
    if (this.busy) return; this.busy = true;
    try {
      const now = this.clock(); this.status.marketOpen = marketOpen(now);
      const session = await this.ensureSession();
      await this.managePositions(session);
      if (monitorOnly || !this.status.running || !session) return;
      const prefs = await this.prisma.preferences.findUnique({ where: { id: 1 } });
      if (!prefs || !this.status.marketOpen) return;
      for (const key of prefs.instrumentKeys) {
        const u = await this.prisma.instrument.findUnique({ where: { key } }); if (!u) continue;
        const src = await this.signalSource(u);
        for (const style of prefs.styles) {
          const st = STYLES[style]; if (!st) continue;
          let bars: Bar[];
          try { bars = await this.completedBars(refOf(src), st.interval); } catch (e) { this.status.lastError = `${u.symbol}: ${(e as Error).message}`; continue; }
          if (!bars.length) continue;
          for (const sid of prefs.strategies) {
            if (sid.startsWith("custom:")) continue; // Strategy Builder strategies run below on their own timeframe
            if (STRATEGIES[sid]?.dailyOnly) continue; // daily strategies are backtest-only until the engine runs on daily bars
            const sig = evaluateLatest(sid, bars, st.params); if (!sig) continue;
            const correlationId = `${sid}|${style}|${key}|${sig.barTime}`;
            const fresh = now.getTime() / 1000 - (sig.barTime + st.interval * 60) < st.interval * 60 * 2;
            const exists = await this.prisma.signal.findUnique({ where: { correlationId } });
            if (exists) continue;
            await this.prisma.signal.create({ data: { correlationId, strategyId: `${sid}@${style}`, strategyVersion: sig.strategyVersion, instrumentKey: key, underlying: u.symbol,
              direction: sig.direction, action: fresh ? sig.action : "NO_TRADE", reasons: fresh ? sig.reasons : ["✗ Data stale: last closed bar too old", ...sig.reasons], checks: sig.checks as object,
              entry: sig.entry, stop: sig.stop, target: sig.target, dataFresh: fresh, mode: EFFECTIVE_MODE, dataSource: this.broker.source, barTime: new Date(sig.barTime * 1000) } });
            if (sig.action === "ENTER" && fresh && prefs.autoPaper) await this.tryEnter(sig, u, style, prefs.segments, session, correlationId);
          }
        }
      }
      await this.runCustomStrategies(prefs, session, now);
    } catch (e) { this.status.lastError = (e as Error).message; this.log(`Error: ${(e as Error).message}`); }
    finally { this.status.lastTick = this.clock().toISOString(); this.status.ticks++; this.busy = false; }
  }

  /** Pick the contract per segment preference (OPTIONS > FUTURES > EQUITY), size it, risk-check it, paper-fill it. */
  async tryEnter(sig: StrategySignal, u: Instrument, style: string, segments: string[], session: TradingSession, correlationId: string, meta?: Record<string, unknown>, label?: string) {
    const bull = sig.direction === "BULLISH", st = STYLES[style]!, product = st.carry ? "CARRY_FORWARD" : "INTRADAY";
    // Reward:risk comes from the strategy's own target (library strategies differ); style params for older signals.
    const rr = sig.target !== null && sig.entry !== null && sig.stop !== null && sig.entry !== sig.stop
      ? Math.abs(sig.target - sig.entry) / Math.abs(sig.entry - sig.stop) : { ...DEFAULT_PARAMS, ...st.params }.rewardRisk;
    const uDist = Math.abs(sig.entry! - sig.stop!);
    const order = ["OPTIONS", "FUTURES", "EQUITY"].filter(s => segments.includes(s));
    const rejections: string[] = [];
    for (const kind of order) {
      try {
        let c: { key: string; contract: string; lot: number; quote: LiveQuote; side: "LONG" | "SHORT"; stop: number; target: number; fillNote: string } | null = null;
        if (kind === "EQUITY") {
          if (u.instrumentType !== "EQUITY") { rejections.push("EQUITY: index cannot be traded as cash"); continue; }
          if (!bull && product === "CARRY_FORWARD") { rejections.push("EQUITY: cannot short delivery"); continue; }
          const q = (await this.priceKeys([u.key])).get(u.key); if (!q) { rejections.push("EQUITY: no quote"); continue; }
          const px = bull ? (q.ask ?? q.ltp) : (q.bid ?? q.ltp);
          c = { key: u.key, contract: `${u.symbol} EQ`, lot: 1, quote: q, side: bull ? "LONG" : "SHORT", stop: roundTick(bull ? px - uDist : px + uDist), target: roundTick(bull ? px + uDist * rr : px - uDist * rr), fillNote: "" };
        } else if (kind === "FUTURES") {
          const f = await nearestFuture(this.prisma, u, this.today()); if (!f) { rejections.push("FUTURES: no listed future (sync instruments)"); continue; }
          const q = (await this.priceKeys([f.key])).get(f.key); if (!q) { rejections.push("FUTURES: no quote"); continue; }
          const px = bull ? (q.ask ?? q.ltp) : (q.bid ?? q.ltp);
          c = { key: f.key, contract: f.name, lot: f.lotSize, quote: q, side: bull ? "LONG" : "SHORT", stop: roundTick(bull ? px - uDist : px + uDist), target: roundTick(bull ? px + uDist * rr : px - uDist * rr), fillNote: "" };
        } else {
          if (u.instrumentType !== "INDEX" && !u.fnoEligible) { rejections.push("OPTIONS: not F&O eligible"); continue; }
          const ref = refOf(u), exps = await this.broker.current.getExpiries(ref);
          // Option buyers avoid the last 2 days before expiry (theta decay, gamma risk, wide spreads).
          const minExp = new Date(this.clock().getTime() + 19800000 + 2 * 86400000).toISOString().slice(0, 10);
          const exp = exps.find(e => e >= minExp); if (!exp) { rejections.push("OPTIONS: no expiry ≥ 2 days away"); continue; }
          const ch = await this.broker.current.getOptionChain(ref, exp);
          const atm = ch.strikes.reduce((a, b) => Math.abs(b.strike - ch.spot) < Math.abs(a.strike - ch.spot) ? b : a, ch.strikes[0]!);
          const leg: OptionLeg | null | undefined = bull ? atm?.ce : atm?.pe;
          if (!leg?.ltp || !leg.ask || !leg.bid) { rejections.push("OPTIONS: ATM leg has no two-sided quote"); continue; }
          const segFno = u.symbol === "SENSEX" ? "BSE_FNO" : "NSE_FNO";
          const key = ch.source === "MOCK" ? mockOptKey(u.key, exp, atm!.strike, bull ? "CE" : "PE") : leg.securityId ? `${segFno}:${leg.securityId}` : null;
          if (!key) { rejections.push("OPTIONS: broker did not return contract id"); continue; }
          const fut = await nearestFuture(this.prisma, u, this.today());
          const lot = fut?.lotSize ?? u.fnoLotSize ?? (ch.source === "MOCK" ? 1 : 0); if (!lot) { rejections.push("OPTIONS: lot size unknown (sync instruments)"); continue; }
          const delta = Math.min(Math.max(Math.abs(leg.delta ?? 0.5), 0.2), 0.8), pStop = roundTick(Math.max(0.05, leg.ask - delta * uDist));
          const q: LiveQuote = { securityId: key, segment: segFno, ltp: leg.ltp, bid: leg.bid, ask: leg.ask, volume: leg.volume, open: null, high: null, low: null, prevClose: null, oi: leg.oi, sourceTs: ch.fetchedAt, receivedTs: ch.fetchedAt, source: ch.source };
          this.quotes.set(key, { ...q, key });
          c = { key, contract: `${u.symbol} ${exp} ${atm!.strike} ${bull ? "CE" : "PE"}`, lot, quote: q, side: "LONG", stop: pStop, target: roundTick(leg.ask + (leg.ask - pStop) * rr),
            fillNote: `ATM by spot ${ch.spot}; Δ ${delta.toFixed(2)}${leg.delta == null ? " (assumed)" : ""}; IV ${leg.iv ?? "n/a"}` };
        }
        const q = c.quote, slip = config.slippageBps / 10000;
        const fill = roundTick(c.side === "LONG" ? (q.ask ?? q.ltp) * (1 + slip) : (q.bid ?? q.ltp) * (1 - slip));
        const perUnit = Math.abs(fill - c.stop);
        const s = toDto(session), pnl = Number(s.realizedPnlInr) + Number(s.unrealizedPnlInr);
        const sz = meta?.sizing as { mode?: string; lots?: number; riskPct?: number; capitalPerLot?: number; maxLots?: number } | undefined;
        const riskPct = sz?.mode === "risk" && sz.riskPct ? sz.riskPct : Number(s.riskPerTradePct);
        const budget = Math.min(Number(s.capitalInr) * riskPct / 100, Number(s.maxLossInr) + pnl);
        let lots = Math.floor(budget / (perUnit * c.lot));
        if (sz && (sz.mode === "fixed" || sz.mode === "capital")) {
          // Strategy Builder sizing: fixed lots or capital ÷ ₹ per lot — never more than the capital pays for or max lots
          const afford = Math.min(Math.max(1, Math.round(sz.maxLots ?? 20)), Math.floor(Number(s.capitalInr) / (sz.capitalPerLot || 15000)));
          lots = sz.mode === "fixed" ? Math.min(Math.max(1, Math.round(sz.lots ?? 1)), afford) : afford;
        }
        const qty = lots * c.lot;
        if (qty <= 0) { rejections.push(sz && sz.mode !== "risk" ? `${kind}: capital ₹${Number(s.capitalInr).toFixed(0)} < ₹ per lot` : `${kind}: risk budget ₹${budget.toFixed(0)} < 1 lot risk ₹${(perUnit * c.lot).toFixed(0)}`); continue; }
        const intent: OrderIntent = { correlationId: `${correlationId}|${kind}`, mode: "PAPER", securityId: c.key, side: c.side === "LONG" ? "BUY" : "SELL", quantity: qty, lotSize: c.lot,
          limitPrice: fill.toFixed(2), stopPrice: c.stop.toFixed(2), isEntry: true, strategyVersion: sig.strategyVersion, kind: kind as OrderIntent["kind"], product };
        const spreadPct = q.bid && q.ask ? ((q.ask - q.bid) / q.ltp) * 100 : kind === "EQUITY" && u.instrumentType === "INDEX" ? 0 : null;
        const open = await this.prisma.paperTrade.count({ where: { closedAt: null } });
        const d = preTradeCheck(intent, { gates: config.gates, session: s, openPositions: open, maxOpenPositions: config.maxOpenPositions, maxConsecutiveLosses: s.maxConsecutiveLosses,
          quoteAgeMs: this.clock().getTime() - Date.parse(q.receivedTs), maxQuoteAgeMs: Math.max(config.maxQuoteAgeMs, 10000), spreadPct, maxSpreadPct: config.maxSpreadPct,
          brokerConnected: true, positionMismatch: false, unknownOrderState: false, now: this.clock(), entryCutoffIst: config.entryCutoffIst });
        await this.prisma.riskDecision.create({ data: { correlationId: intent.correlationId, sessionId: session.id, mode: "PAPER", approved: d.approved, reasons: d.reasons, intent: intent as object } });
        if (!d.approved) { rejections.push(`${kind}: ${d.reasons.join("; ")}`); continue; }
        const created = await this.prisma.orderIntent.create({ data: { correlationId: intent.correlationId, mode: "PAPER", instrumentKey: c.key, side: intent.side, quantity: qty, limitPrice: fill, state: "FILLED" } }).catch(() => null);
        if (!created) return; // duplicate intent → already handled
        const pk: ProductKind = kind === "OPTIONS" ? "OPTIONS" : kind === "FUTURES" ? "FUTURES" : product === "INTRADAY" ? "EQUITY_INTRADAY" : "EQUITY_DELIVERY";
        const t = await this.prisma.paperTrade.create({ data: { sessionId: session.id, correlationId: intent.correlationId, strategyId: label ?? `${sig.strategyId}@${style}`, underlying: u.symbol, ...(meta ? { meta: meta as object } : {}),
          instrumentKey: c.key, contract: c.contract, kind, product, side: c.side, quantity: qty, lotSize: c.lot, entryPrice: fill, stopPrice: c.stop, targetPrice: c.target, lastPrice: fill,
          entryCharges: orderCharges(pk, intent.side, fill * qty), dataSource: q.source, fillNote: `Filled at ${c.side === "LONG" ? "ask" : "bid"} + ${config.slippageBps}bps slippage. ${c.fillNote}` } });
        await this.audit("PAPER_ENTRY", { contract: c.contract, side: c.side, qty, fill, stop: c.stop, target: c.target, strategy: t.strategyId }, intent.correlationId);
        this.log(`ENTRY ${c.side} ${qty} × ${c.contract} @ ${fill} (SL ${c.stop}, TGT ${c.target})`);
        return;
      } catch (e) { rejections.push(`${kind}: ${(e as Error).message}`); }
    }
    if (rejections.length) { this.log(`${u.symbol} ENTER skipped — ${rejections.join(" | ")}`); await this.audit("ENTRY_REJECTED", { underlying: u.symbol, reasons: rejections }, correlationId); }
  }

  /** Strategy Builder strategies: entry decided by the same engine as the backtest, on the spot index candles. */
  async runCustomStrategies(prefs: { strategies: string[]; instrumentKeys: string[]; segments: string[]; autoPaper: boolean }, session: TradingSession, now: Date) {
    const ids = prefs.strategies.filter(s => s.startsWith("custom:")).map(s => s.slice(7)); if (!ids.length) return;
    const rows = await this.prisma.customStrategy.findMany({ where: { id: { in: ids } } });
    const dayStart = new Date(Date.parse(this.today() + "T00:00:00+05:30"));
    for (const row of rows) {
      const spec = row.spec as unknown as StrategySpec, tf = (Number(spec.timeframe ?? 5) as 1 | 5 | 15), sid = `custom:${row.id}`;
      for (const key of spec.instruments?.length ? spec.instruments : prefs.instrumentKeys) {
        const u = await this.prisma.instrument.findUnique({ where: { key } }); if (!u) continue;
        const mine = { meta: { path: ["specId"], equals: row.id }, underlying: u.symbol } as const;
        if (await this.prisma.paperTrade.count({ where: { ...mine, closedAt: null } })) continue;           // one position per strategy & instrument
        const today = await this.prisma.paperTrade.findMany({ where: { ...mine, openedAt: { gte: dayStart } } });
        if (today.length >= spec.session.maxTradesPerDay) continue;
        const dayNet = today.reduce((a, t) => a + Number(t.pnlInr ?? 0), 0);
        if ((spec.session.dayProfitLock ?? 0) > 0 && dayNet >= spec.session.dayProfitLock!) continue;
        if ((spec.session.dayLossLimit ?? 0) > 0 && dayNet <= -spec.session.dayLossLimit!) continue;
        let bars: Bar[];
        try { bars = await this.completedBars(refOf(u), tf); } catch (e) { this.status.lastError = `${u.symbol}: ${(e as Error).message}`; continue; }
        const sig = liveEntrySignal(bars, spec); if (!sig) continue;
        const correlationId = `${sid}|${key}|${sig.barTime}`;
        if (await this.prisma.signal.findUnique({ where: { correlationId } })) continue;
        const fresh = now.getTime() / 1000 - (sig.barTime + tf * 60) < tf * 60 * 2;
        const dir = sig.dir === 1 ? "BULLISH" : "BEARISH";
        // sizing stop for the order path: real stop, or (no stop in the strategy) a 2% catastrophic level
        const sizingStop = sig.stop ?? sig.entry * (1 - sig.dir * 0.02);
        await this.prisma.signal.create({ data: { correlationId, strategyId: `${row.name} (custom)`, strategyVersion: "custom", instrumentKey: key, underlying: u.symbol, direction: dir,
          action: fresh ? "ENTER" : "NO_TRADE", reasons: fresh ? [`Strategy Builder: ${row.name}`, `Entry ${sig.entry.toFixed(2)} · stop ${sig.stop?.toFixed(2) ?? "none (exit rules)"}`] : ["✗ Data stale: last closed bar too old"],
          checks: [] as object, entry: sig.entry, stop: sizingStop, target: sig.target, dataFresh: fresh, mode: EFFECTIVE_MODE, dataSource: this.broker.source, barTime: new Date(sig.barTime * 1000) } });
        if (!fresh || !prefs.autoPaper) continue;
        const ssig: StrategySignal = { strategyId: sid, strategyVersion: "custom", barTime: sig.barTime, direction: dir, action: "ENTER", reasons: sig.reasons, checks: [], entry: sig.entry, stop: sizingStop, target: null };
        await this.tryEnter(ssig, u, "INTRADAY", prefs.segments, session, correlationId,
          { custom: true, specId: row.id, uKey: u.key, dir: sig.dir, uEntry: sig.entry, uStop: sig.stop, uTarget: sig.target, entryT: sig.barTime + tf * 60, tf, curStop: sig.stop, sizing: spec.sizing }, `${row.name} (custom)`);
      }
    }
  }

  /** Exit management for a Strategy Builder trade: replay its rules on the index candles since entry + live stop check. */
  async manageCustom(t: PaperTrade, q: LiveQuote) {
    const m = t.meta as { specId: string; uKey: string; dir: 1 | -1; uEntry: number; uStop: number | null; uTarget: number | null; entryT: number; tf: 1 | 5 | 15; curStop: number | null };
    const row = await this.prisma.customStrategy.findUnique({ where: { id: m.specId } });
    const u = await this.prisma.instrument.findUnique({ where: { key: m.uKey } });
    if (!row || !u) { if (toIstHHMM(this.clock()) >= config.squareOffIst) await this.closeTrade(t, q, "INTRADAY_SQUARE_OFF"); return; }
    const spec = row.spec as unknown as StrategySpec;
    let bars: Bar[] = []; try { bars = await this.completedBars(refOf(u), m.tf); } catch { /* keep live checks below */ }
    const r = bars.length ? liveManage(bars, spec, { dir: m.dir, entry: m.uEntry, stop: m.uStop, target: m.uTarget, entryT: m.entryT }) : { exit: null, stop: m.curStop, best: m.uEntry };
    if (r.exit) { await this.closeTrade(t, q, `RULE_${r.exit}`); return; }
    // live index check between candle closes: stop / target touched right now
    const uq = (await this.priceKeys([m.uKey])).get(m.uKey);
    if (uq && r.stop != null && (m.dir === 1 ? uq.ltp <= r.stop : uq.ltp >= r.stop)) { await this.closeTrade(t, q, "STOP (index)"); return; }
    if (uq && m.uTarget != null && (m.dir === 1 ? uq.ltp >= m.uTarget : uq.ltp <= m.uTarget)) { await this.closeTrade(t, q, "TARGET (index)"); return; }
    if (toIstHHMM(this.clock()) >= (spec.session.squareOff < config.squareOffIst ? spec.session.squareOff : config.squareOffIst)) { await this.closeTrade(t, q, "INTRADAY_SQUARE_OFF"); return; }
    if (r.stop !== m.curStop) {
      await this.prisma.paperTrade.update({ where: { id: t.id }, data: { meta: { ...m, curStop: r.stop } as object } });
      this.log(`TRAIL ${t.contract}: index stop → ${r.stop?.toFixed(2)}`);
    }
  }

  productKind(t: PaperTrade): ProductKind { return t.kind === "OPTIONS" ? "OPTIONS" : t.kind === "FUTURES" ? "FUTURES" : t.product === "INTRADAY" ? "EQUITY_INTRADAY" : "EQUITY_DELIVERY"; }

  async closeTrade(t: PaperTrade, q: LiveQuote | undefined, reason: string, at?: number) {
    const slip = config.slippageBps / 10000;
    const base = at ?? (t.side === "LONG" ? (q?.bid ?? q?.ltp) : (q?.ask ?? q?.ltp)) ?? Number(t.lastPrice);
    const px = roundTick(t.side === "LONG" ? base * (1 - slip) : base * (1 + slip));
    const exitCh = orderCharges(this.productKind(t), t.side === "LONG" ? "SELL" : "BUY", px * t.quantity);
    const gross = new Decimal(px).minus(t.entryPrice).times(t.side === "LONG" ? 1 : -1).times(t.quantity);
    const pnl = gross.minus(t.entryCharges).minus(exitCh);
    const upd = await this.prisma.paperTrade.updateMany({ where: { id: t.id, closedAt: null }, data: { exitPrice: px, exitCharges: exitCh, pnlInr: pnl, exitReason: reason, closedAt: this.clock(), lastPrice: px } });
    if (!upd.count) return;
    const s = await this.currentSession();
    if (s) await this.prisma.tradingSession.update({ where: { id: s.id }, data: { realizedPnlInr: { increment: pnl }, consecutiveLosses: pnl.lte(0) ? { increment: 1 } : 0 } });
    await this.audit("PAPER_EXIT", { contract: t.contract, reason, exit: px, pnl: pnl.toFixed(2) }, t.correlationId);
    this.log(`EXIT ${t.contract} @ ${px} — ${reason} — P&L ₹${pnl.toFixed(2)}`);
  }

  async closeAll(reason: string) {
    const open = await this.prisma.paperTrade.findMany({ where: { closedAt: null } });
    const qs = open.length ? await this.priceKeys(open.map(t => t.instrumentKey)).catch(() => new Map()) : new Map();
    for (const t of open) await this.closeTrade(t, qs.get(t.instrumentKey), reason);
    await this.refreshUnrealized();
    return open.length;
  }

  async refreshUnrealized() {
    const s = await this.currentSession(); if (!s) return;
    const open = await this.prisma.paperTrade.findMany({ where: { closedAt: null } });
    let u = new Decimal(0);
    for (const t of open) u = u.plus(new Decimal(t.lastPrice).minus(t.entryPrice).times(t.side === "LONG" ? 1 : -1).times(t.quantity).minus(t.entryCharges));
    await this.prisma.tradingSession.update({ where: { id: s.id }, data: { unrealizedPnlInr: u } });
  }

  async managePositions(session: TradingSession | null) {
    const open = await this.prisma.paperTrade.findMany({ where: { closedAt: null } });
    if (open.length) {
      const qs = await this.priceKeys(open.map(t => t.instrumentKey));
      const hm = toIstHHMM(this.clock());
      for (const t of open) {
        const q = qs.get(t.instrumentKey); if (!q) continue;
        const L = t.side === "LONG", px = q.ltp, stop = Number(t.stopPrice), tgt = Number(t.targetPrice), entry = Number(t.entryPrice);
        await this.prisma.paperTrade.update({ where: { id: t.id }, data: { lastPrice: px } });
        if ((t.meta as { custom?: boolean } | null)?.custom) { await this.manageCustom(t, q); continue; } // exits follow the strategy's index rules
        if (L ? px <= stop : px >= stop) await this.closeTrade(t, q, "STOP");
        else if (L ? px >= tgt : px <= tgt) await this.closeTrade(t, q, "TARGET");
        else if (t.product === "INTRADAY" && hm >= config.squareOffIst) await this.closeTrade(t, q, "INTRADAY_SQUARE_OFF");
        else {
          // Trail to breakeven after +1R
          const R = Math.abs(entry - stop);
          if (R > 0 && (L ? px - entry >= R && stop < entry : entry - px >= R && stop > entry)) {
            await this.prisma.paperTrade.update({ where: { id: t.id }, data: { stopPrice: entry } }); this.log(`TRAIL ${t.contract}: stop → breakeven ${entry}`);
          }
        }
      }
    }
    await this.refreshUnrealized();
    const s = session ? await this.prisma.tradingSession.findUnique({ where: { id: session.id } }) : null;
    if (s) {
      const st = evaluateSessionLimits(toDto(s), s.maxConsecutiveLosses);
      if (st !== s.status) {
        await this.prisma.tradingSession.update({ where: { id: s.id }, data: { status: st } });
        await this.audit("SESSION_STATUS", { from: s.status, to: st });
        this.log(`Session → ${st}`);
        if (st === "HALTED_LOSS" || st === "HALTED_PROFIT") { const n = await this.closeAll(st); if (n) this.log(`Closed ${n} position(s) due to ${st}`); }
      }
    }
  }
}
