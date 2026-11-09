import Fastify from "fastify";
import type { PrismaClient } from "@prisma/client";
import { DailySessionInput, toIstDate, type OrderIntent } from "@dat/shared";
import { evaluateSessionLimits, preTradeCheck } from "@dat/risk-engine";
import { type BtTrade, STRATEGIES, JASSU_MARKET_TREND, runSpecBacktest, type StrategySpec, DEFAULT_PARAMS, ema, vwap, rsi, atr, snapshot, runBacktest, tradesToCsv, type ProductKind } from "@dat/quant";
import { BrokerHolder, saveCreds, tokenInfo } from "./broker.ts";
import { config, EFFECTIVE_MODE } from "./config.ts";
import { DEFAULT_KEYS, refOf, seedInstruments, syncInstruments, syncState, nifty50Symbols } from "./instruments.ts";
import { PaperEngine, STYLES, toDto, marketOpen } from "./engine.ts";
import { Leaderboard } from "./leaderboard.ts";

export { toDto };

export async function buildApp(opts: { prisma: PrismaClient; clock?: () => Date; broker?: BrokerHolder; autoSync?: boolean }) {
  const { prisma } = opts;
  const clock = opts.clock ?? (() => new Date());
  const broker = opts.broker ?? new BrokerHolder(clock);
  const app = Fastify({
    logger: process.env.NODE_ENV === "test" ? false : { level: process.env.LOG_LEVEL ?? "info", redact: ["req.headers.authorization", "req.headers.cookie", "req.body.accessToken", "*.accessToken"] },
    bodyLimit: 1_000_000,
  });
  // CSRF-ish guard for a localhost app: reject cross-site browser writes.
  app.addHook("onRequest", async (req, reply) => {
    if (req.method !== "GET" && req.headers.origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.origin)) return reply.code(403).send({ error: "FORBIDDEN_ORIGIN" });
  });

  const audit = (action: string, details: object, correlationId?: string) =>
    prisma.auditEvent.create({ data: { actor: "local-user", action, mode: EFFECTIVE_MODE, details: details as object, correlationId } });
  const engine = new PaperEngine(prisma, broker, clock, audit);
  const leaderboard = new Leaderboard(prisma, broker, clock);
  const today = () => toIstDate(clock());

  await seedInstruments(prisma);
  await prisma.preferences.upsert({ where: { id: 1 }, update: {}, create: { id: 1, instrumentKeys: DEFAULT_KEYS } });
  if (opts.autoSync) {
    const n = await prisma.instrument.count({ where: { source: "DHAN_MASTER" } });
    if (!n) void syncInstruments(prisma).then(s => app.log.info({ s }, "instrument sync"));
  }

  // ---------- health / settings ----------
  app.get("/api/health", async () => {
    const db = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
    return { ok: db, db, broker: await broker.current.healthCheck(), mode: EFFECTIVE_MODE, liveExecutionAvailable: false, serverTime: clock().toISOString(),
      marketOpen: marketOpen(clock()), engine: { ...engine.status, log: undefined }, instruments: { ...syncState, total: await prisma.instrument.count() }, token: tokenInfo() };
  });

  app.post("/api/settings/dhan", async (req, reply) => {
    const b = req.body as { clientId?: string; accessToken?: string };
    if (!b?.clientId?.trim() || !b?.accessToken?.trim()) return reply.code(400).send({ error: "VALIDATION", issues: ["Client ID and access token are required"] });
    saveCreds({ clientId: b.clientId.trim(), accessToken: b.accessToken.trim() });
    await audit("DHAN_CREDENTIALS_SAVED", { clientId: tokenInfo().clientIdMasked });
    return tokenInfo();
  });
  app.post("/api/settings/source", async (req, reply) => {
    const s = (req.body as { source?: string })?.source;
    if (s !== "MOCK" && s !== "DHAN") return reply.code(400).send({ error: "VALIDATION", issues: ["source must be MOCK or DHAN"] });
    if (s === "DHAN" && !tokenInfo().configured) return reply.code(400).send({ error: "VALIDATION", issues: ["Save Dhan Client ID + Access Token first"] });
    const open = await prisma.paperTrade.count({ where: { closedAt: null } });
    if (open) return reply.code(409).send({ error: "OPEN_POSITIONS", message: "Close all positions before switching data source (paper & data sources must not mix)." });
    broker.use(s); engine.clearCache();
    await audit("DATA_SOURCE_CHANGED", { source: s });
    return { source: broker.source, health: await broker.current.healthCheck() };
  });
  app.post("/api/instruments/sync", async () => { void syncInstruments(prisma); return syncState; });

  // ---------- preferences ----------
  app.get("/api/preferences", async () => {
    const p = await prisma.preferences.findUniqueOrThrow({ where: { id: 1 } });
    const selected = await prisma.instrument.findMany({ where: { key: { in: p.instrumentKeys } } });
    return { ...p, defaultCapital: Number(p.defaultCapital), defaultMaxLoss: Number(p.defaultMaxLoss), defaultMaxProfit: p.defaultMaxProfit === null ? null : Number(p.defaultMaxProfit),
      defaultRiskPct: Number(p.defaultRiskPct), defaultMaxConsecutiveLosses: p.defaultMaxConsecutiveLosses, selected, styleOptions: Object.entries(STYLES).map(([id, s]) => ({ id, label: s.label })),
      strategyOptions: [
        ...(await listCustom()).map(c => ({ id: `custom:${c.id}`, name: `${c.name}`, description: (c.spec as { description?: string }).description || "Strategy Builder se bani custom strategy", family: "My custom",
          needsVolume: false, intradayOnly: false, custom: true, liveSupported: true, timeframe: (c.spec as { timeframe?: string }).timeframe ?? "5" })),
        ...Object.entries(STRATEGIES).map(([id, s]) => ({ id, name: s.name, description: s.description, family: s.family, needsVolume: !!s.needsVolume, intradayOnly: !!s.intradayOnly, custom: false, liveSupported: !s.dailyOnly })),
      ] };
  });
  app.put("/api/preferences", async (req, reply) => {
    const b = req.body as Record<string, unknown>; const errs: string[] = [];
    const arr = (v: unknown, allowed?: string[]) => Array.isArray(v) && v.every(x => typeof x === "string" && (!allowed || allowed.includes(x)));
    const data: Record<string, unknown> = {};
    if (b.styles !== undefined) { if (!arr(b.styles, Object.keys(STYLES)) || !(b.styles as string[]).length) errs.push("Select at least one trading style"); else data.styles = b.styles; }
    if (b.segments !== undefined) { if (!arr(b.segments, ["EQUITY", "FUTURES", "OPTIONS"]) || !(b.segments as string[]).length) errs.push("Select at least one segment"); else data.segments = b.segments; }
    if (b.strategies !== undefined) {
      const customIds = (await prisma.customStrategy.findMany({ select: { id: true } })).map(c => `custom:${c.id}`);
      if (!arr(b.strategies, [...Object.keys(STRATEGIES), ...customIds])) errs.push("Unknown strategy"); else data.strategies = b.strategies;
    }
    if (b.instrumentKeys !== undefined) { if (!arr(b.instrumentKeys) || (b.instrumentKeys as string[]).length > 80) errs.push("Select up to 80 instruments"); else data.instrumentKeys = b.instrumentKeys; }
    for (const k of ["autoPaper", "autoStartDaily"]) if (b[k] !== undefined) data[k] = !!b[k];
    for (const k of ["defaultCapital", "defaultMaxLoss", "defaultRiskPct"]) if (b[k] !== undefined) { const n = Number(b[k]); if (!(n > 0)) errs.push(`${k} must be positive`); else data[k] = n; }
    if (b.defaultMaxConsecutiveLosses !== undefined) { const n = Number(b.defaultMaxConsecutiveLosses); if (!Number.isInteger(n) || n < 1 || n > 50) errs.push("Loss streak limit must be a whole number 1–50"); else data.defaultMaxConsecutiveLosses = n; }
    if (b.defaultMaxProfit !== undefined) data.defaultMaxProfit = b.defaultMaxProfit === null || b.defaultMaxProfit === "" ? null : Number(b.defaultMaxProfit);
    if (data.defaultMaxLoss !== undefined && data.defaultCapital !== undefined && Number(data.defaultMaxLoss) > Number(data.defaultCapital)) errs.push("Max loss cannot exceed capital");
    if (errs.length) return reply.code(400).send({ error: "VALIDATION", issues: errs });
    const p = await prisma.preferences.update({ where: { id: 1 }, data });
    await audit("PREFERENCES_UPDATED", data);
    engine.clearCache();
    return p;
  });

  app.get("/api/instruments", async (req) => {
    const { q = "", kind = "" } = req.query as { q?: string; kind?: string };
    return prisma.instrument.findMany({
      where: { instrumentType: kind ? kind : { in: ["INDEX", "EQUITY"] }, NOT: [{ symbol: { contains: "NSETEST" } }, { symbol: { contains: "BSETEST" } }],
        OR: q ? [{ symbol: { contains: q.toUpperCase() } }, { name: { contains: q, mode: "insensitive" } }] : undefined },
      orderBy: [{ fnoEligible: "desc" }, { symbol: "asc" }], take: 40,
    });
  });

  /** One-click selections: all indices with listed derivatives, and current NIFTY 50 constituents. */
  app.get("/api/instruments/presets", async () => {
    const fnoIndices = await prisma.instrument.findMany({ where: { instrumentType: "INDEX", fnoEligible: true }, orderBy: { symbol: "asc" } });
    let nifty50: typeof fnoIndices = [], missing: string[] = [], n50Error: string | null = null;
    try {
      const syms = await nifty50Symbols();
      nifty50 = await prisma.instrument.findMany({ where: { segment: "NSE_EQ", symbol: { in: syms } }, orderBy: { symbol: "asc" } });
      missing = syms.filter(x => !nifty50.some(i => i.symbol === x));
    } catch (e) { n50Error = (e as Error).message; }
    return { fnoIndices, nifty50, missing, n50Error, note: fnoIndices.length < 3 ? "Instrument master not synced yet — Settings → Sync" : null };
  });

  // ---------- session ----------
  const currentSession = () => prisma.tradingSession.findUnique({ where: { tradingDate: today() } });
  app.get("/api/session", async () => { const s = await currentSession(); return { tradingDate: today(), session: s ? toDto(s) : null }; });
  app.post("/api/session/start", async (req, reply) => {
    const parsed = DailySessionInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "VALIDATION", issues: parsed.error.issues.map(i => i.message) });
    if (await currentSession()) return reply.code(409).send({ error: "SESSION_EXISTS", message: "Today's session already started. Limits can only be tightened." });
    const v = parsed.data;
    const s = await prisma.tradingSession.create({ data: { tradingDate: today(), mode: EFFECTIVE_MODE, capitalInr: v.capitalInr, maxLossInr: v.maxLossInr, maxProfitInr: v.maxProfitInr, riskPerTradePct: v.riskPerTradePct, maxConsecutiveLosses: v.maxConsecutiveLosses } });
    await audit("SESSION_STARTED", { ...v, maxProfit: v.maxProfitInr ?? "UNLIMITED" });
    return toDto(s);
  });
  app.post("/api/session/limits", async (req, reply) => {
    const s = await currentSession(); if (!s) return reply.code(404).send({ error: "NO_SESSION" });
    const parsed = DailySessionInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "VALIDATION", issues: parsed.error.issues.map(i => i.message) });
    const v = parsed.data;
    const limits = { capitalInr: v.capitalInr, maxLossInr: v.maxLossInr, maxProfitInr: v.maxProfitInr, riskPerTradePct: v.riskPerTradePct, maxConsecutiveLosses: v.maxConsecutiveLosses };
    let u = await prisma.tradingSession.update({ where: { id: s.id }, data: limits });
    // A halt caused by a limit is re-checked against the new limits, so loosening a limit resumes trading.
    if (u.status.startsWith("HALTED_")) {
      const st = evaluateSessionLimits({ ...toDto(u), status: "ACTIVE" }, u.maxConsecutiveLosses);
      if (st !== u.status) { u = await prisma.tradingSession.update({ where: { id: s.id }, data: { status: st } }); await audit("SESSION_STATUS", { from: s.status, to: st }); }
    }
    await audit("LIMITS_UPDATED", { from: { capital: s.capitalInr, maxLoss: s.maxLossInr, maxProfit: s.maxProfitInr, riskPct: s.riskPerTradePct, maxConsecutiveLosses: s.maxConsecutiveLosses }, to: limits });
    return toDto(u);
  });
  app.post("/api/emergency-stop", async (_req, reply) => {
    const s = await currentSession(); if (!s) return reply.code(404).send({ error: "NO_SESSION" });
    engine.stop();
    const u = await prisma.tradingSession.update({ where: { id: s.id }, data: { status: "EMERGENCY_STOP" } });
    const closed = await engine.closeAll("EMERGENCY_STOP");
    await audit("EMERGENCY_STOP", { previousStatus: s.status, positionsClosed: closed });
    return { ...toDto((await currentSession()) ?? u), positionsClosed: closed };
  });
  app.post("/api/positions/close-all", async (req, reply) => {
    if ((req.body as { confirm?: string })?.confirm !== "CLOSE ALL") return reply.code(400).send({ error: "CONFIRMATION_REQUIRED", message: 'Send {"confirm":"CLOSE ALL"}' });
    const n = await engine.closeAll("MANUAL_CLOSE_ALL"); await audit("CLOSE_ALL", { positionsClosed: n });
    return { closed: n };
  });
  app.post("/api/positions/:id/close", async (req, reply) => {
    const t = await prisma.paperTrade.findUnique({ where: { id: (req.params as { id: string }).id } });
    if (!t || t.closedAt) return reply.code(404).send({ error: "NOT_OPEN" });
    const q = (await engine.priceKeys([t.instrumentKey])).get(t.instrumentKey);
    await engine.closeTrade(t, q, "MANUAL_CLOSE"); await engine.refreshUnrealized(); return { ok: true };
  });

  // ---------- engine ----------
  app.get("/api/engine", async () => engine.status);
  app.post("/api/engine/start", async (_req, reply) => {
    const p = await prisma.preferences.findUniqueOrThrow({ where: { id: 1 } });
    if (!p.strategies.length) return reply.code(400).send({ error: "VALIDATION", issues: ["Enable at least one strategy in Setup first"] });
    engine.start(); await audit("ENGINE_STARTED", { autoPaper: p.autoPaper, styles: p.styles, segments: p.segments }); return engine.status;
  });
  app.post("/api/engine/stop", async () => { engine.stop(); await audit("ENGINE_STOPPED", {}); return engine.status; });

  // ---------- market data ----------
  app.get("/api/watchlist", async () => {
    const p = await prisma.preferences.findUniqueOrThrow({ where: { id: 1 } });
    const insts = await prisma.instrument.findMany({ where: { key: { in: p.instrumentKeys } } });
    let error: string | null = null;
    try { await engine.priceKeys(insts.map(i => i.key)); } catch (e) { error = (e as Error).message; }
    const now = clock().getTime();
    const sigs = await prisma.signal.findMany({ where: { createdAt: { gte: new Date(now - 30 * 60000) } }, orderBy: { createdAt: "desc" } });
    const items = await Promise.all(insts.map(async i => {
      const q = engine.quotes.get(i.key);
      let ind = null;
      const bars = engine.cachedBars(refOf(i), 5); // never block the watchlist on history fetches
      if (bars?.length) ind = snapshot(bars);
      const latest = sigs.find(s => s.instrumentKey === i.key && s.action !== "NO_TRADE") ?? sigs.find(s => s.instrumentKey === i.key);
      const chg = q && q.prevClose ? ((q.ltp - q.prevClose) / q.prevClose) * 100 : q && q.open ? ((q.ltp - q.open) / q.open) * 100 : null;
      const trend = ind && ind.ema9 && ind.ema21 && ind.vwap && q ? (q.ltp > ind.vwap && ind.ema9 > ind.ema21 ? "UP" : q.ltp < ind.vwap && ind.ema9 < ind.ema21 ? "DOWN" : "SIDEWAYS") : null;
      return { key: i.key, symbol: i.symbol, name: i.name, kind: i.instrumentType, fno: i.fnoEligible, quote: q ?? null, changePct: chg,
        ageMs: q ? now - Date.parse(q.receivedTs) : null, stale: !q || now - Date.parse(q.receivedTs) > config.maxQuoteAgeMs * 6, indicators: ind, trend,
        signal: latest ? { action: latest.action, direction: latest.direction, strategy: latest.strategyId, at: latest.createdAt } : null };
    }));
    return { source: broker.source, error, marketOpen: marketOpen(clock()), items };
  });

  app.get("/api/candles", async (req, reply) => {
    const { key, interval = "5", days = "3" } = req.query as Record<string, string>;
    const inst = await prisma.instrument.findUnique({ where: { key: key ?? "" } }); if (!inst) return reply.code(404).send({ error: "UNKNOWN_INSTRUMENT" });
    const iv = (interval === "D" ? "D" : Number(interval)) as 1 | 5 | 15 | 25 | 60 | "D";
    const to = clock(), from = new Date(to.getTime() - Number(days) * 86400000);
    try {
      const nowS = to.getTime() / 1000;
      const bars = (await broker.current.getCandles({ ref: refOf(inst), interval: iv, from, to })).filter(b => iv === "D" || b.t + (iv as number) * 60 <= nowS);
      const c = bars.map(b => b.c);
      return { source: broker.source, symbol: inst.symbol, interval: iv, bars, ema9: ema(c, 9), ema21: ema(c, 21), vwap: vwap(bars, iv === "D" ? "rolling" : "session"), rsi: rsi(c, 14), atr: atr(bars, 14) };
    } catch (e) { return reply.code(502).send({ error: "DATA_ERROR", message: (e as Error).message }); }
  });

  app.get("/api/option-chain", async (req, reply) => {
    const { key, expiry } = req.query as Record<string, string>;
    const inst = await prisma.instrument.findUnique({ where: { key: key ?? "" } }); if (!inst) return reply.code(404).send({ error: "UNKNOWN_INSTRUMENT" });
    try {
      const expiries = await broker.current.getExpiries(refOf(inst));
      const exp = expiry && expiries.includes(expiry) ? expiry : expiries[0];
      if (!exp) return { expiries, chain: null };
      return { expiries, chain: await broker.current.getOptionChain(refOf(inst), exp) };
    } catch (e) { return reply.code(502).send({ error: "DATA_ERROR", message: (e as Error).message }); }
  });

  // ---------- signals / trades ----------
  app.get("/api/signals", async (req) => {
    const { action } = req.query as { action?: string };
    return prisma.signal.findMany({ where: action ? { action } : undefined, orderBy: { createdAt: "desc" }, take: 100 });
  });
  app.get("/api/positions", async () => {
    const open = await prisma.paperTrade.findMany({ where: { closedAt: null }, orderBy: { openedAt: "desc" } });
    const closed = await prisma.paperTrade.findMany({ where: { closedAt: { not: null } }, orderBy: { closedAt: "desc" }, take: 200 });
    return { open, closed };
  });
  app.get("/api/performance", async () => {
    const t = await prisma.paperTrade.findMany({ where: { closedAt: { not: null } }, orderBy: { closedAt: "asc" } });
    const pnl = t.map(x => Number(x.pnlInr)), wins = pnl.filter(p => p > 0), losses = pnl.filter(p => p <= 0), sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
    let cum = 0; const curve = t.map(x => ({ t: Math.floor(x.closedAt!.getTime() / 1000), v: (cum += Number(x.pnlInr)) }));
    const sessions = await prisma.tradingSession.findMany({ orderBy: { tradingDate: "desc" }, take: 60 });
    return { trades: t.length, winRate: t.length ? wins.length / t.length : null, expectancy: t.length ? sum(pnl) / t.length : null, net: sum(pnl),
      profitFactor: losses.length && sum(losses) ? sum(wins) / Math.abs(sum(losses)) : null, avgWin: wins.length ? sum(wins) / wins.length : null, avgLoss: losses.length ? sum(losses) / losses.length : null,
      curve, sessions: sessions.map(toDto), sessionsCount: sessions.length };
  });

  app.post("/api/risk/check", async (req) => {
    const intent = { mode: "PAPER", ...(req.body as object) } as OrderIntent;
    const s = await currentSession(); const q = engine.quotes.get(intent.securityId);
    const d = preTradeCheck(intent, { gates: config.gates, session: s ? toDto(s) : null, openPositions: await prisma.paperTrade.count({ where: { closedAt: null } }), maxOpenPositions: config.maxOpenPositions,
      maxConsecutiveLosses: s?.maxConsecutiveLosses ?? 3, quoteAgeMs: q ? clock().getTime() - Date.parse(q.receivedTs) : null, maxQuoteAgeMs: config.maxQuoteAgeMs,
      spreadPct: q?.bid && q?.ask ? ((q.ask - q.bid) / q.ltp) * 100 : null, maxSpreadPct: config.maxSpreadPct, brokerConnected: true, positionMismatch: false, unknownOrderState: false, now: clock(), entryCutoffIst: config.entryCutoffIst });
    await prisma.riskDecision.create({ data: { correlationId: intent.correlationId ?? "dry-run", sessionId: s?.id, mode: EFFECTIVE_MODE, approved: d.approved, reasons: d.reasons, intent: intent as object } });
    return d;
  });

  // ---------- strategy builder ----------
  const specErrors = (sp: any): string[] => {
    const e: string[] = [];
    if (!sp || typeof sp !== "object") return ["Strategy missing"];
    if (!String(sp.name ?? "").trim()) e.push("Strategy ka naam do");
    if (!["barClose", "dayOpen"].includes(sp.entryMode)) e.push("Entry mode invalid");
    for (const side of ["long", "short"] as const) { const r = sp[side]; if (!r || !Array.isArray(r.entry) || !Array.isArray(r.exit)) e.push(`${side} rules missing`); else if (r.enabled && !r.entry.length) e.push(`${side === "long" ? "BUY/CALL" : "SELL/PUT"} side enabled hai par koi entry condition nahi`); }
    if (!sp.long?.enabled && !sp.short?.enabled) e.push("Kam se kam ek side (CALL ya PUT) enable karo");
    if (!(Number(sp.sizing?.qty) > 0)) e.push("Quantity > 0 honi chahiye");
    if (!(Number(sp.sizing?.delta) > 0 && Number(sp.sizing?.delta) <= 1)) e.push("Delta 0–1 ke beech");
    if (!(Number(sp.session?.maxTradesPerDay) >= 1)) e.push("Max trades/day ≥ 1");
    return e;
  };
  const listCustom = async () => {
    if (!(await prisma.customStrategy.count())) await prisma.customStrategy.create({ data: { name: JASSU_MARKET_TREND.name, spec: JASSU_MARKET_TREND as object } });
    return prisma.customStrategy.findMany({ orderBy: { updatedAt: "desc" } });
  };
  /** Backtest a builder strategy (StrategySpec) and save it to My Backtests. Shared by the builder and Backtest Lab. */
  const runCustomBacktest = async (spec0: StrategySpec | undefined, specId: string | null,
    b: { key: string; interval: string; years: number; capital?: number; sizingMode?: string; riskPct?: number; capitalPerLot?: number; lots?: number; slippagePoints?: number }, reply: import("fastify").FastifyReply) => {
    // Backtest Lab / builder test overrides: lot sizing, risk %, slippage (index points)
    let spec = spec0;
    if (spec && b.sizingMode && ["fixed", "capital", "risk"].includes(b.sizingMode)) spec = { ...spec, sizing: { ...spec.sizing, mode: b.sizingMode as "fixed" | "capital" | "risk",
      ...(b.riskPct != null ? { riskPct: Number(b.riskPct) } : {}), ...(b.capitalPerLot ? { capitalPerLot: Number(b.capitalPerLot) } : {}), ...(b.lots ? { lots: Number(b.lots) } : {}) } };
    if (spec && b.slippagePoints != null && Number.isFinite(Number(b.slippagePoints))) spec = { ...spec, costs: { ...spec.costs, slippagePoints: Math.max(0, Number(b.slippagePoints)) } };
    const errs = specErrors(spec); if (errs.length) return reply.code(400).send({ error: "VALIDATION", issues: errs });
    const inst = await prisma.instrument.findUnique({ where: { key: b.key } }); if (!inst) return reply.code(404).send({ error: "UNKNOWN_INSTRUMENT" });
    const daily = b.interval === "D", iv = daily ? "D" : (Number(b.interval) as 1 | 5 | 15 | 25 | 60);
    let years = Math.min(Math.max(Number(b.years) || 1, 0.1), 10); const notes: string[] = [];
    if (!daily && years > 5) { years = 5; notes.push("Intraday data max 5 years (Dhan limit)."); }
    if (!daily && broker.source === "MOCK" && years > 1) { years = 1; notes.push("MOCK intraday capped at 1 year."); }
    const to = clock(), from = new Date(to.getTime() - years * 365.25 * 86400000);
    let bars; try { bars = await broker.current.getCandles({ ref: refOf(inst), interval: iv, from, to }); } catch (e) { return reply.code(502).send({ error: "DATA_ERROR", message: (e as Error).message }); }
    if (bars.length < 50) return reply.code(422).send({ error: "INSUFFICIENT_DATA", message: `Only ${bars.length} bars returned for ${inst.symbol}.` });
    const r = runSpecBacktest(bars, spec!, { daily, startingCapital: Number(b.capital) || 100000, oosFraction: 0.3 });
    r.assumptions.unshift(...notes, `Data source: ${broker.source}${broker.source === "MOCK" ? " (SYNTHETIC)" : ""}.`);
    const sz = spec!.sizing, capLots = Math.min(Math.max(1, Math.round(sz.maxLots ?? 20)), Math.floor((Number(b.capital) || 100000) / (sz.capitalPerLot || 15000)));
    const sizeTxt = (sz.mode ?? "fixed") === "fixed" ? ((sz.lots ?? 1) > capLots ? `${sz.lots} lot → max ${capLots} used` : `${sz.lots ?? 1} lot`) : sz.mode === "capital" ? "capital-sized" : `risk ${sz.riskPct ?? 1}%`;
    const label = `${inst.symbol} · ${spec!.name} (custom) · ${daily ? "Daily" : iv + "m"} · ${years}y · ₹${(Number(b.capital) || 100000).toLocaleString("en-IN")} · ${sizeTxt}`;
    const { trades, equity, ...summary } = r;
    const run = await prisma.backtestRun.create({ data: { label, dataSource: broker.source, metrics: r.metrics as object, result: { ...summary, trades, equity } as object,
      config: { custom: true, specId, spec: spec as object, key: b.key, interval: b.interval, years, daily, startingCapital: Number(b.capital) || 100000, sizingMode: sz.mode ?? "fixed", riskPct: sz.riskPct, slippagePoints: spec!.costs.slippagePoints } as object } });
    await audit("CUSTOM_BACKTEST_RUN", { label, trades: r.trades.length });
    return { id: run.id, label, ...r, daily: dailyPnl(r.trades), trades: r.trades.slice(-500), equity: thin(r.equity, 1500), tradeCount: r.trades.length };
  };
  app.get("/api/builder/strategies", async () => listCustom());
  /** Apply Backtest Lab filters to live paper trading: strategy selection + its lot sizing + default capital/risk. */
  app.post("/api/builder/apply-live", async (req, reply) => {
    const b = req.body as { strategyId: string; capital: number; sizingMode: string; lots?: number; riskPct?: number; capitalPerLot?: number; slippagePoints?: number; onlyThis?: boolean };
    if (!b.strategyId?.startsWith("custom:")) return reply.code(400).send({ error: "VALIDATION", issues: ["Sirf Strategy Builder (custom) strategies apply ho sakti hain"] });
    const id = b.strategyId.slice(7), row = await prisma.customStrategy.findUnique({ where: { id } }); if (!row) return reply.code(404).send({ error: "NOT_FOUND" });
    const cap = Number(b.capital); if (!(cap > 0)) return reply.code(400).send({ error: "VALIDATION", issues: ["Capital > 0 chahiye"] });
    if (!["fixed", "capital", "risk"].includes(b.sizingMode)) return reply.code(400).send({ error: "VALIDATION", issues: ["Lot sizing invalid"] });
    const spec = row.spec as unknown as StrategySpec;
    const sizing = { ...spec.sizing, mode: b.sizingMode as "fixed" | "capital" | "risk", ...(b.lots ? { lots: Number(b.lots) } : {}), ...(b.riskPct ? { riskPct: Number(b.riskPct) } : {}), ...(b.capitalPerLot ? { capitalPerLot: Number(b.capitalPerLot) } : {}) };
    const costs = b.slippagePoints != null ? { ...spec.costs, slippagePoints: Number(b.slippagePoints) } : spec.costs;
    await prisma.customStrategy.update({ where: { id }, data: { spec: { ...spec, sizing, costs } as object } });
    const p = await prisma.preferences.findUniqueOrThrow({ where: { id: 1 } });
    const strategies = b.onlyThis ? [b.strategyId] : [...new Set([...p.strategies, b.strategyId])];
    await prisma.preferences.update({ where: { id: 1 }, data: { strategies, defaultCapital: cap, ...(b.sizingMode === "risk" && b.riskPct ? { defaultRiskPct: Number(b.riskPct) } : {}) } });
    await audit("APPLIED_TO_LIVE", { strategy: row.name, capital: cap, sizing });
    const s = await currentSession();
    return { ok: true, strategy: row.name, selected: strategies.length, sessionCapital: s ? Number(s.capitalInr) : null };
  });
  /** Everything the engine will actually trade with — for the Dashboard "Trading plan" view. */
  app.get("/api/live-plan", async () => {
    const p = await prisma.preferences.findUniqueOrThrow({ where: { id: 1 } });
    const s = await currentSession();
    const insts = await prisma.instrument.findMany({ where: { key: { in: p.instrumentKeys } }, select: { key: true, symbol: true } });
    const customIds = p.strategies.filter(x => x.startsWith("custom:")).map(x => x.slice(7));
    const customs = await prisma.customStrategy.findMany({ where: { id: { in: customIds } } });
    const symOf = async (keys: string[]) => (await prisma.instrument.findMany({ where: { key: { in: keys } }, select: { symbol: true } })).map(i => i.symbol);
    const strategies = [];
    for (const sid of p.strategies) {
      if (sid.startsWith("custom:")) {
        const c = customs.find(x => x.id === sid.slice(7));
        if (!c) { strategies.push({ id: sid, name: "Deleted custom strategy", kind: "missing" }); continue; }
        const spec = c.spec as unknown as StrategySpec;
        strategies.push({ id: sid, name: c.name, kind: "custom", timeframe: `${spec.timeframe ?? "5"}-min`, runsOn: spec.instruments?.length ? await symOf(spec.instruments) : insts.map(i => i.symbol), spec });
      } else {
        const st = STRATEGIES[sid];
        strategies.push({ id: sid, name: st?.name ?? sid, kind: st ? "builtin" : "missing", family: st?.family, description: st?.description, live: st ? !st.dailyOnly : false,
          timeframe: p.styles.map(x => STYLES[x]?.label).filter(Boolean).join(" + "), runsOn: insts.map(i => i.symbol) });
      }
    }
    return { autoPaper: p.autoPaper, styles: p.styles, segments: p.segments, engineRunning: engine.status.running, marketOpen: marketOpen(clock()),
      session: s ? toDto(s) : null, defaultCapital: Number(p.defaultCapital), strategies, squareOffIst: config.squareOffIst, maxOpenPositions: config.maxOpenPositions };
  });
  app.get("/api/builder/preset", async () => JASSU_MARKET_TREND);
  app.post("/api/builder/strategies", async (req, reply) => {
    const sp = (req.body as { spec: StrategySpec }).spec; const errs = specErrors(sp); if (errs.length) return reply.code(400).send({ error: "VALIDATION", issues: errs });
    const row = await prisma.customStrategy.create({ data: { name: sp.name.trim(), spec: sp as object } }); await audit("CUSTOM_STRATEGY_CREATED", { id: row.id, name: row.name }); return row;
  });
  app.put("/api/builder/strategies/:id", async (req, reply) => {
    const sp = (req.body as { spec: StrategySpec }).spec; const errs = specErrors(sp); if (errs.length) return reply.code(400).send({ error: "VALIDATION", issues: errs });
    const id = (req.params as { id: string }).id;
    if (!(await prisma.customStrategy.findUnique({ where: { id } }))) return reply.code(404).send({ error: "NOT_FOUND" });
    const row = await prisma.customStrategy.update({ where: { id }, data: { name: sp.name.trim(), spec: sp as object } }); await audit("CUSTOM_STRATEGY_UPDATED", { id, name: row.name }); return row;
  });
  app.delete("/api/builder/strategies/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id; const row = await prisma.customStrategy.findUnique({ where: { id } }); if (!row) return reply.code(404).send({ error: "NOT_FOUND" });
    await prisma.customStrategy.delete({ where: { id } }); await audit("CUSTOM_STRATEGY_DELETED", { id, name: row.name }); return { ok: true };
  });
  app.post("/api/builder/backtest", async (req, reply) => {
    const b = req.body as { id?: string; spec?: StrategySpec; key: string; interval: string; years: number; capital?: number };
    let spec = b.spec; let specId = b.id ?? null;
    if (!spec && b.id) { const row = await prisma.customStrategy.findUnique({ where: { id: b.id } }); if (!row) return reply.code(404).send({ error: "NOT_FOUND" }); spec = row.spec as unknown as StrategySpec; }
    return runCustomBacktest(spec, specId, b, reply);
  });

  // ---------- backtest ----------
  app.post("/api/backtest", async (req, reply) => {
    const b = req.body as { key: string; strategyId: string; style?: string; interval: string; years: number; capital?: number; riskPct?: number; slippageBps?: number; product?: ProductKind; allowShort?: boolean };
    const inst = await prisma.instrument.findUnique({ where: { key: b.key } }); if (!inst) return reply.code(404).send({ error: "UNKNOWN_INSTRUMENT" });
    if (b.strategyId?.startsWith("custom:")) {
      const id = b.strategyId.slice(7), row = await prisma.customStrategy.findUnique({ where: { id } });
      if (!row) return reply.code(404).send({ error: "NOT_FOUND", message: "Custom strategy not found (deleted?)" });
      return runCustomBacktest(row.spec as unknown as StrategySpec, id, b, reply);
    }
    if (!STRATEGIES[b.strategyId]) return reply.code(400).send({ error: "VALIDATION", issues: ["Unknown strategy"] });
    const daily = b.interval === "D", iv = daily ? "D" : (Number(b.interval) as 1 | 5 | 15 | 25 | 60);
    const years = Math.min(Math.max(Number(b.years) || 1, 0.1), 10);
    const notes: string[] = [];
    let effYears = years;
    if (!daily && years > 5) { effYears = 5; notes.push("Dhan provides intraday candles for the last 5 years only; range capped at 5 years. Use Daily interval for up to 10 years."); }
    if (!daily && broker.source === "MOCK" && effYears > 1) { notes.push("MOCK intraday backtests are capped at 1 year for speed."); effYears = 1; }
    const to = clock(), from = new Date(to.getTime() - effYears * 365.25 * 86400000);
    let bars;
    try { bars = await broker.current.getCandles({ ref: refOf(inst), interval: iv, from, to }); } catch (e) { return reply.code(502).send({ error: "DATA_ERROR", message: (e as Error).message }); }
    if (bars.length < 50) return reply.code(422).send({ error: "INSUFFICIENT_DATA", message: `Only ${bars.length} bars returned for ${inst.symbol}. ${inst.instrumentType === "INDEX" ? "Indices have no volume → VWAP strategies cannot trigger; try a stock." : ""}` });
    if (inst.instrumentType === "INDEX" && bars.every(x => x.v === 0)) notes.push("Index has no volume: VWAP/relative-volume checks cannot pass. Backtest a stock or the index future instead.");
    const style = STYLES[b.style ?? "INTRADAY"];
    const cfg = { strategyId: b.strategyId, params: { ...(daily ? {} : style?.params) }, daily, startingCapital: Number(b.capital) || 100000, riskPerTradePct: Number(b.riskPct) || 0.5,
      slippageBps: Number(b.slippageBps ?? 5), // Spot indices are traded via futures/options, so index backtests use futures charges.
      product: b.product ?? (inst.instrumentType === "INDEX" ? "FUTURES" : daily ? "EQUITY_DELIVERY" : "EQUITY_INTRADAY"), allowShort: b.allowShort ?? !daily, squareOffIst: config.squareOffIst,
      maxHoldBars: daily ? 20 : 60, lotSize: 1, oosFraction: 0.3 };
    const r = runBacktest(bars, cfg);
    r.assumptions.unshift(...notes, `Data source: ${broker.source}${broker.source === "MOCK" ? " (SYNTHETIC — results say nothing about real markets)" : ""}.`);
    const label = `${inst.symbol} · ${STRATEGIES[b.strategyId]!.name} · ${daily ? "Daily" : iv + "m"} · ${effYears}y`;
    const { trades, equity, ...summary } = r;
    const run = await prisma.backtestRun.create({ data: { label, dataSource: broker.source, config: { ...cfg, key: b.key, years: effYears, interval: b.interval, style: b.style } as object, metrics: r.metrics as object, result: { ...summary, trades, equity } as object } });
    await audit("BACKTEST_RUN", { label, trades: r.trades.length });
    return { id: run.id, label, ...r, daily: dailyPnl(r.trades), trades: r.trades.slice(-500), equity: thin(r.equity, 1500), tradeCount: r.trades.length };
  });
  // ---------- strategy leaderboard (all strategies × instrument basket) ----------
  app.get("/api/leaderboard", async () => {
    const r = await leaderboard.latest();
    return { status: leaderboard.status, run: r ? { id: r.id, createdAt: r.createdAt, dataSource: r.dataSource, config: r.config, rows: r.rows } : null };
  });
  app.get("/api/leaderboard/:runId/strategy/:id", async (req, reply) => {
    const { runId, id } = req.params as { runId: string; id: string };
    const d = await leaderboard.detail(runId, id); if (!d) return reply.code(404).send({ error: "NOT_FOUND" });
    if (id.startsWith("custom:")) { const c = await prisma.customStrategy.findUnique({ where: { id: id.slice(7) } });
      return { ...d, info: { name: c?.name ?? "Custom strategy (deleted)", family: "My custom", description: (c?.spec as { description?: string } | undefined)?.description ?? "Strategy Builder strategy", needsVolume: false, intradayOnly: false, dailyOnly: false } }; }
    return { ...d, info: STRATEGIES[id] ? { name: STRATEGIES[id]!.name, family: STRATEGIES[id]!.family, description: STRATEGIES[id]!.description, needsVolume: !!STRATEGIES[id]!.needsVolume, intradayOnly: !!STRATEGIES[id]!.intradayOnly, dailyOnly: !!STRATEGIES[id]!.dailyOnly } : null };
  });
  app.post("/api/leaderboard/run", async (req) => {
    const b = (req.body ?? {}) as { years?: number; interval?: number | string; keys?: string[]; slippageBps?: number };
    const interval = String(b.interval) === "D" ? "D" as const : Number(b.interval) === 15 ? 15 : 5;
    const keys = Array.isArray(b.keys) ? b.keys.filter(k => typeof k === "string") : undefined;
    const st = leaderboard.start(Number(b.years) || 1, interval, keys, b.slippageBps != null ? Number(b.slippageBps) : 5);
    await audit("LEADERBOARD_STARTED", { years: Number(b.years) || 1, interval, keys: keys ?? "basket" });
    return st;
  });
  app.get("/api/backtests", async () => (await prisma.backtestRun.findMany({ orderBy: { createdAt: "desc" }, take: 200, select: { id: true, label: true, createdAt: true, dataSource: true, metrics: true } })));
  app.get("/api/backtests/:id", async (req, reply) => {
    const run = await prisma.backtestRun.findUnique({ where: { id: (req.params as { id: string }).id } }); if (!run) return reply.code(404).send({ error: "NOT_FOUND" });
    const res = run.result as unknown as { trades: unknown[]; equity: Array<{ t: number; equity: number }> } & Record<string, unknown>;
    return { ...res, id: run.id, label: run.label, createdAt: run.createdAt, dataSource: run.dataSource, runConfig: run.config, daily: dailyPnl(res.trades as BtTrade[]), trades: res.trades.slice(-500), equity: thin(res.equity, 1500), tradeCount: res.trades.length };
  });
  app.get("/api/backtests/:id/csv", async (req, reply) => {
    const r = await prisma.backtestRun.findUnique({ where: { id: (req.params as { id: string }).id } }); if (!r) return reply.code(404).send({ error: "NOT_FOUND" });
    const res = r.result as unknown as { trades: Parameters<typeof tradesToCsv>[0]; assumptions: string[] };
    reply.header("content-type", "text/csv").header("content-disposition", `attachment; filename="backtest-${r.id.slice(0, 8)}.csv"`);
    return `# ${r.label}\n# ${res.assumptions.join("\n# ")}\n${tradesToCsv(res.trades)}`;
  });

  app.get("/api/audit", async () => (await prisma.auditEvent.findMany({ orderBy: { id: "desc" }, take: 100 })).map(r => ({ ...r, id: r.id.toString() })));
  app.get("/api/meta", async () => ({ defaults: DEFAULT_PARAMS, styles: STYLES, strategies: Object.keys(STRATEGIES) }));

  // There is intentionally NO broker order-placement route in this build.
  return { app, engine, broker };
}

/** Day-by-day P&L (IST date of the trade exit) from ALL trades. */
function dailyPnl(trades: BtTrade[]) {
  const m = new Map<string, { day: string; trades: number; wins: number; gross: number; charges: number; net: number }>();
  for (const t of trades) {
    const day = new Date((t.exitTime + 19800) * 1000).toISOString().slice(0, 10);
    const d = m.get(day) ?? { day, trades: 0, wins: 0, gross: 0, charges: 0, net: 0 };
    d.trades++; if (t.netPnl > 0) d.wins++; d.gross += t.grossPnl; d.charges += t.charges; d.net += t.netPnl; m.set(day, d);
  }
  return [...m.values()].sort((a, b) => a.day.localeCompare(b.day)).map(d => ({ ...d, gross: Math.round(d.gross * 100) / 100, charges: Math.round(d.charges * 100) / 100, net: Math.round(d.net * 100) / 100 }));
}
function thin<T>(a: T[], n: number): T[] { if (a.length <= n) return a; const step = a.length / n; return Array.from({ length: n }, (_, i) => a[Math.floor(i * step)]!).concat([a[a.length - 1]!]); }
