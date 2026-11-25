import { registerGoogleAuth } from "./auth.ts";
import Fastify from "fastify";
import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma, type PrismaClient } from "@prisma/client";
import { DailySessionInput, toIstDate, type OrderIntent } from "@dat/shared";
import { evaluateSessionLimits, preTradeCheck } from "@dat/risk-engine";
import { type BtTrade, type Bar, cryptoSpec, STRATEGIES, JASSU_MARKET_TREND, runSpecBacktest, type StrategySpec, DEFAULT_PARAMS, ema, vwap, rsi, atr, snapshot, runBacktest, tradesToCsv, type ProductKind } from "@dat/quant";
import { BrokerHolder, saveCreds, tokenInfo } from "./broker.ts";
import { DhanAuth, DhanInstantLogin, appInfo, saveAppCreds, saveTotpCreds, setAutoLogin, totpInfo } from "./dhanAuth.ts";
import type { LiveQuote } from "@dat/broker-dhan";
import { config, EFFECTIVE_MODE, saveDeltaSettings } from "./config.ts";
import { DEFAULT_KEYS, refOf, seedInstruments, syncInstruments, syncState, nifty50Symbols, syncDeltaInstruments, deltaSyncState } from "./instruments.ts";
import { PaperEngine, STYLES, toDto } from "./engine.ts";
import { Leaderboard } from "./leaderboard.ts";
import { askClaude, buildSnapshot, chatInfo, pickUnderlying, saveChatSettings, type ChatTurn } from "./chat.ts";

export { toDto };

export async function buildApp(opts: { prisma: PrismaClient; clock?: () => Date; broker?: BrokerHolder; autoSync?: boolean; dhanAuth?: DhanAuth; dhanInstant?: DhanInstantLogin }) {
  const { prisma } = opts;
  const clock = opts.clock ?? (() => new Date());
  const broker = opts.broker ?? new BrokerHolder(clock);
  const app = Fastify({
    logger: process.env.NODE_ENV === "test" ? false : { level: process.env.LOG_LEVEL ?? "info", redact: ["req.headers.authorization", "req.headers.cookie", "req.body.accessToken", "*.accessToken"] },
    bodyLimit: 1_000_000,
  });
  // Optional login (server deploy): APP_USER + APP_PASSWORD → HTTP Basic auth on every request (UI and API).
  // Google sign-in (GOOGLE_CLIENT_ID/SECRET + ALLOWED_EMAILS) takes priority; else optional Basic auth.
  const google = process.env.NODE_ENV !== "test" && registerGoogleAuth(app);
  if (!google) app.get("/api/me", async () => ({ email: null }));
  const authUser = process.env.APP_USER, authPass = process.env.APP_PASSWORD;
  if (!google && authPass && process.env.NODE_ENV !== "test") {
    const { timingSafeEqual } = await import("node:crypto");
    const want = Buffer.from(`${authUser ?? "admin"}:${authPass}`);
    app.addHook("onRequest", async (req, reply) => {
      if (req.url === "/healthz") return;
      const h = req.headers.authorization ?? "", got = h.startsWith("Basic ") ? Buffer.from(h.slice(6), "base64") : Buffer.alloc(0);
      if (got.length !== want.length || !timingSafeEqual(got, want)) return reply.code(401).header("www-authenticate", 'Basic realm="AI Trader", charset="UTF-8"').send({ error: "LOGIN_REQUIRED" });
    });
  }
  app.get("/healthz", async () => ({ ok: true }));
  // CSRF-ish guard: browser writes must come from this same site (localhost in dev, the server's own host when deployed).
  const extraOrigins = (process.env.ALLOWED_ORIGINS ?? "").split(",").map(x => x.trim()).filter(Boolean);
  app.addHook("onRequest", async (req, reply) => {
    const o = req.headers.origin; if (req.method === "GET" || !o) return;
    let sameHost = false; try { sameHost = new URL(o).host === req.headers.host; } catch { /* bad origin */ }
    if (!sameHost && !extraOrigins.includes(o) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(o)) return reply.code(403).send({ error: "FORBIDDEN_ORIGIN" });
  });

  let venueOfRequest: () => "DHAN" | "DELTA" | null = () => null;
  const audit = (action: string, details: object, correlationId?: string, v?: "DHAN" | "DELTA") =>
    prisma.auditEvent.create({ data: { actor: "local-user", action, mode: EFFECTIVE_MODE, details: { ...details, venue: v ?? venueOfRequest() ?? "DHAN" } as object, correlationId } });
  // One engine per exchange; both run independently (Dhan = NSE/BSE, Delta = crypto 24x7).
  const engines = { DHAN: new PaperEngine(prisma, broker, clock, (a, d, c) => audit(a, d, c, "DHAN"), "DHAN"), DELTA: new PaperEngine(prisma, broker, clock, (a, d, c) => audit(a, d, c, "DELTA"), "DELTA") } as const;
  const engine = engines.DHAN;
  // Request-scoped venue (?venue=DHAN|DELTA): every handler below uses the active exchange's engine, prefs row, session and trades.
  const venueCtx = new AsyncLocalStorage<{ venue: "DHAN" | "DELTA" }>();
  app.addHook("onRequest", (req, _rep, done) => { const v = (req.query as { venue?: string } | undefined)?.venue === "DELTA" ? "DELTA" : "DHAN"; venueCtx.run({ venue: v }, done); });
  const venue = () => venueCtx.getStore()?.venue ?? "DHAN";
  venueOfRequest = () => venueCtx.getStore()?.venue ?? null;
  const eng = () => engines[venue()];
  const pid = () => (venue() === "DELTA" ? 2 : 1);
  const leaderboard = new Leaderboard(prisma, broker, clock);
  const today = () => toIstDate(clock());

  await seedInstruments(prisma);
  await prisma.preferences.upsert({ where: { id: 1 }, update: {}, create: { id: 1, instrumentKeys: DEFAULT_KEYS } });
  // Delta (crypto) trade setup — row 2; starts with BTC & ETH perpetuals, intraday 5-min style
  await prisma.preferences.upsert({ where: { id: 2 }, update: {}, create: { id: 2, instrumentKeys: ["DELTA:BTCUSD", "DELTA:ETHUSD"], styles: ["INTRADAY"], segments: ["OPTIONS"] } });
  if (opts.autoSync) {
    const n = await prisma.instrument.count({ where: { source: "DHAN_MASTER" } });
    if (!n) void syncInstruments(prisma).then(s => app.log.info({ s }, "instrument sync"));
    void syncDeltaInstruments(prisma, broker.delta).then(s => app.log.info({ s }, "delta instrument sync"));
  }
  app.post("/api/delta/sync", async () => syncDeltaInstruments(prisma, broker.delta));
  app.get("/api/delta/status", async () => ({ ...deltaSyncState, instruments: await prisma.instrument.count({ where: { segment: "DELTA" } }), health: await broker.delta.healthCheck(), usdInr: config.cryptoUsdInr, leverage: config.cryptoLeverage }));

  // ---------- health / settings ----------
  app.get("/api/health", async () => {
    const db = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
    return { ok: db, db, broker: await broker.current.healthCheck(), mode: EFFECTIVE_MODE, liveExecutionAvailable: true, liveTrading: !!(await prisma.preferences.findUnique({ where: { id: 1 } }))?.liveTrading && broker.source === "DHAN", serverTime: clock().toISOString(),
      marketOpen: eng().isOpen(), venue: venue(), engines: { DHAN: engines.DHAN.status.running, DELTA: engines.DELTA.status.running }, engine: { ...eng().status, log: undefined }, instruments: { ...syncState, total: await prisma.instrument.count() }, token: tokenInfo() };
  });

  app.post("/api/settings/dhan", async (req, reply) => {
    const b = req.body as { clientId?: string; accessToken?: string };
    if (!b?.clientId?.trim() || !b?.accessToken?.trim()) return reply.code(400).send({ error: "VALIDATION", issues: ["Client ID and access token are required"] });
    saveCreds({ clientId: b.clientId.trim(), accessToken: b.accessToken.trim() });
    await audit("DHAN_CREDENTIALS_SAVED", { clientId: tokenInfo().clientIdMasked });
    return tokenInfo();
  });
  // ---------- one-click Dhan login (API key consent flow) + auto-renew ----------
  const dhanAuth = opts.dhanAuth ?? new DhanAuth();
  if (opts.autoSync) setInterval(() => { void dhanAuth.maybeRenew().then(ok => { if (ok) void audit("DHAN_TOKEN_RENEWED", { expiresAt: tokenInfo().expiresAt }, undefined, "DHAN"); }); }, 10 * 60000);
  app.get("/api/settings/dhan-app", async () => ({ ...appInfo(), renew: dhanAuth.renewState, token: tokenInfo() }));
  app.put("/api/settings/dhan-app", async (req, reply) => {
    const b = req.body as { clientId?: string; apiKey?: string; apiSecret?: string };
    if (!b?.clientId?.trim() || !b?.apiKey?.trim() || !b?.apiSecret?.trim()) return reply.code(400).send({ error: "VALIDATION", issues: ["Client ID, API key aur API secret teeno chahiye"] });
    saveAppCreds({ clientId: b.clientId.trim(), apiKey: b.apiKey.trim(), apiSecret: b.apiSecret.trim() });
    await audit("DHAN_API_KEY_SAVED", { clientId: appInfo().clientIdMasked }, undefined, "DHAN");
    return appInfo();
  });
  app.post("/api/dhan/oauth/start", async (_req, reply) => {
    try { return await dhanAuth.start(); } catch (e) { return reply.code(400).send({ error: "DHAN_AUTH", message: (e as Error).message }); }
  });
  /** Dhan redirects the browser here after login (?tokenId=…); we exchange it and send the user back to the app. */
  app.get("/api/dhan/oauth/callback", async (req, reply) => {
    const tokenId = (req.query as { tokenId?: string }).tokenId;
    if (!tokenId) return reply.redirect("/?dhan=error&msg=" + encodeURIComponent("Dhan ne tokenId nahi bheja"));
    try {
      const r = await dhanAuth.complete(tokenId);
      broker.use("DHAN"); engines.DHAN.clearCache();
      await audit("DHAN_AUTHORIZED", { client: r.clientName, expiryTime: r.expiryTime }, undefined, "DHAN");
      return reply.redirect("/?dhan=connected");
    } catch (e) { return reply.redirect("/?dhan=error&msg=" + encodeURIComponent((e as Error).message.slice(0, 180))); }
  });
  // ---------- instant one-click login: Client ID + PIN + TOTP (official generateAccessToken, no browser) ----------
  const instant = opts.dhanInstant ?? new DhanInstantLogin();
  if (opts.autoSync) setInterval(() => { void instant.maybeAutoLogin().then(ok => { if (ok) { broker.use("DHAN"); engines.DHAN.clearCache(); void audit("DHAN_AUTO_LOGIN", { expiresAt: tokenInfo().expiresAt }, undefined, "DHAN"); } }); }, 60000);
  app.get("/api/settings/dhan-instant", async () => ({ ...totpInfo(), state: instant.state, token: tokenInfo() }));
  app.put("/api/settings/dhan-instant", async (req, reply) => {
    const b = req.body as { clientId?: string; pin?: string; secret?: string; autoLogin?: boolean };
    if (b && b.clientId === undefined && b.pin === undefined && b.secret === undefined && typeof b.autoLogin === "boolean") { // toggle only
      if (!totpInfo().configured) return reply.code(400).send({ error: "VALIDATION", issues: ["Pehle setup save karein"] });
      setAutoLogin(b.autoLogin); await audit("DHAN_AUTO_LOGIN_TOGGLED", { on: b.autoLogin }, undefined, "DHAN"); return totpInfo();
    }
    const errs: string[] = [];
    if (!b?.clientId?.trim()) errs.push("Client ID chahiye");
    if (!/^\d{4,6}$/.test(String(b?.pin ?? "").trim())) errs.push("PIN 4–6 digits ka hota hai");
    if (!b?.secret?.trim()) errs.push("TOTP secret chahiye (Dhan 'Setup TOTP' QR ke neeche wala code)");
    if (errs.length) return reply.code(400).send({ error: "VALIDATION", issues: errs });
    try { saveTotpCreds({ clientId: b.clientId!.trim(), pin: String(b.pin).trim(), secret: b.secret!.trim(), autoLogin: !!b.autoLogin }); }
    catch (e) { return reply.code(400).send({ error: "VALIDATION", issues: [(e as Error).message] }); }
    await audit("DHAN_INSTANT_LOGIN_SAVED", { clientId: totpInfo().clientIdMasked, autoLogin: !!b.autoLogin }, undefined, "DHAN");
    return totpInfo();
  });
  app.post("/api/dhan/login", async (_req, reply) => {
    try {
      const r = await instant.login();
      broker.use("DHAN"); engines.DHAN.clearCache();
      await audit("DHAN_INSTANT_LOGIN", { client: r.clientName, expiryTime: r.expiryTime }, undefined, "DHAN");
      return { ok: true, client: r.clientName, token: tokenInfo() };
    } catch (e) { return reply.code(400).send({ error: "DHAN_LOGIN", message: (e as Error).message }); }
  });
  app.post("/api/dhan/renew", async (_req, reply) => {
    const ok = await dhanAuth.renew();
    if (ok) await audit("DHAN_TOKEN_RENEWED", { expiresAt: tokenInfo().expiresAt, manual: true }, undefined, "DHAN");
    return ok ? { ok, token: tokenInfo() } : reply.code(400).send({ error: "DHAN_RENEW", message: `Renew nahi hua: ${dhanAuth.renewState.lastError ?? "token expired?"} — 'Authorize with Dhan' se login karein.` });
  });
  app.post("/api/settings/source", async (req, reply) => {
    const s = (req.body as { source?: string })?.source;
    if (s !== "MOCK" && s !== "DHAN") return reply.code(400).send({ error: "VALIDATION", issues: ["source must be MOCK or DHAN"] });
    if (s === "DHAN" && !tokenInfo().configured) return reply.code(400).send({ error: "VALIDATION", issues: ["Save Dhan Client ID + Access Token first"] });
    const open = await prisma.paperTrade.count({ where: { closedAt: null, venue: venue() } });
    if (open) return reply.code(409).send({ error: "OPEN_POSITIONS", message: "Close all positions before switching data source (paper & data sources must not mix)." });
    broker.use(s); eng().clearCache();
    await audit("DATA_SOURCE_CHANGED", { source: s });
    return { source: broker.source, health: await broker.current.healthCheck() };
  });
  app.post("/api/instruments/sync", async () => { void syncInstruments(prisma); return syncState; });

  // ---------- preferences ----------
  app.get("/api/preferences", async () => {
    const p = await prisma.preferences.findUniqueOrThrow({ where: { id: pid() } });
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
    for (const k of ["autoPaper", "autoStartDaily", "autoEngine", "minOneLot"]) if (b[k] !== undefined) data[k] = !!b[k];
    for (const k of ["defaultCapital", "defaultMaxLoss", "defaultRiskPct"]) if (b[k] !== undefined) { const n = Number(b[k]); if (!(n > 0)) errs.push(`${k} must be positive`); else data[k] = n; }
    if (b.defaultMaxConsecutiveLosses !== undefined) { const n = Number(b.defaultMaxConsecutiveLosses); if (!Number.isInteger(n) || n < 1 || n > 50) errs.push("Loss streak limit must be a whole number 1–50"); else data.defaultMaxConsecutiveLosses = n; }
    if (b.liveTrading !== undefined) {
      if (b.liveTrading === true && (venue() !== "DHAN" || b.liveConfirm !== "LIVE")) errs.push("LIVE sirf Dhan par, aur confirm mein LIVE likhna zaroori hai");
      else { data.liveTrading = !!b.liveTrading; await audit(b.liveTrading ? "LIVE_TRADING_ON" : "LIVE_TRADING_OFF", {}); }
    }
    if (b.liveMaxLots !== undefined) { const n = Number(b.liveMaxLots); if (!Number.isInteger(n) || n < 1 || n > 10) errs.push("Live max lots 1–10"); else data.liveMaxLots = n; }
    if (b.maxOpenPositions !== undefined) { const n = Number(b.maxOpenPositions); if (!Number.isInteger(n) || n < 1 || n > 10) errs.push("Max open positions must be a whole number 1–10"); else data.maxOpenPositions = n; }
    if (b.defaultMaxProfit !== undefined) data.defaultMaxProfit = b.defaultMaxProfit === null || b.defaultMaxProfit === "" ? null : Number(b.defaultMaxProfit);
    if (data.defaultMaxLoss !== undefined && data.defaultCapital !== undefined && Number(data.defaultMaxLoss) > Number(data.defaultCapital)) errs.push("Max loss cannot exceed capital");
    if (errs.length) return reply.code(400).send({ error: "VALIDATION", issues: errs });
    const p = await prisma.preferences.update({ where: { id: pid() }, data });
    await audit("PREFERENCES_UPDATED", data);
    eng().clearCache();
    return p;
  });

  app.get("/api/instruments", async (req) => {
    const { q = "", kind = "", limit = "40" } = req.query as { q?: string; kind?: string; limit?: string };
    return prisma.instrument.findMany({
      where: { instrumentType: kind ? kind : venue() === "DELTA" ? "CRYPTO_PERP" : { in: ["INDEX", "EQUITY"] }, NOT: [{ symbol: { contains: "NSETEST" } }, { symbol: { contains: "BSETEST" } }],
        OR: q ? [{ symbol: { contains: q.toUpperCase() } }, { name: { contains: q, mode: "insensitive" } }] : undefined },
      orderBy: [{ fnoEligible: "desc" }, { symbol: "asc" }], take: Math.min(Math.max(Number(limit) || 40, 1), 400),
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
  const currentSession = () => prisma.tradingSession.findUnique({ where: { tradingDate_venue: { tradingDate: today(), venue: venue() } } });
  app.get("/api/session", async () => { const s = await currentSession(); return { tradingDate: today(), session: s ? toDto(s) : null }; });
  app.post("/api/session/start", async (req, reply) => {
    const parsed = DailySessionInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "VALIDATION", issues: parsed.error.issues.map(i => i.message) });
    if (await currentSession()) return reply.code(409).send({ error: "SESSION_EXISTS", message: "Today's session already started. Limits can only be tightened." });
    const v = parsed.data;
    const s = await prisma.tradingSession.create({ data: { tradingDate: today(), venue: venue(), mode: EFFECTIVE_MODE, capitalInr: v.capitalInr, maxLossInr: v.maxLossInr, maxProfitInr: v.maxProfitInr, riskPerTradePct: v.riskPerTradePct, maxConsecutiveLosses: v.maxConsecutiveLosses } });
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
    eng().stop();
    const u = await prisma.tradingSession.update({ where: { id: s.id }, data: { status: "EMERGENCY_STOP" } });
    const closed = await eng().closeAll("EMERGENCY_STOP");
    await audit("EMERGENCY_STOP", { previousStatus: s.status, positionsClosed: closed });
    return { ...toDto((await currentSession()) ?? u), positionsClosed: closed };
  });
  app.post("/api/positions/close-all", async (req, reply) => {
    if ((req.body as { confirm?: string })?.confirm !== "CLOSE ALL") return reply.code(400).send({ error: "CONFIRMATION_REQUIRED", message: 'Send {"confirm":"CLOSE ALL"}' });
    const n = await eng().closeAll("MANUAL_CLOSE_ALL"); await audit("CLOSE_ALL", { positionsClosed: n });
    return { closed: n };
  });
  // Edit stop loss of an open paper position. Builder trades: premiumStop (option price) and/or indexStop (underlying, can only tighten the trail).
  app.post("/api/positions/:id/stop", async (req, reply) => {
    const t = await prisma.paperTrade.findUnique({ where: { id: (req.params as { id: string }).id } });
    if (!t || t.closedAt || t.venue !== venue()) return reply.code(404).send({ error: "NOT_OPEN" });
    const b = (req.body ?? {}) as { premiumStop?: number | string | null; indexStop?: number | string | null };
    const L = t.side === "LONG", ltp = Number(t.lastPrice), num = (v: unknown) => v === null || v === "" ? null : Number(v);
    const ps = b.premiumStop === undefined ? undefined : num(b.premiumStop), is = b.indexStop === undefined ? undefined : num(b.indexStop);
    if (ps != null && (!(ps > 0) || (L ? ps >= ltp : ps <= ltp))) return reply.code(400).send({ error: "BAD_STOP", message: `Premium SL ${L ? "LTP ₹" + ltp + " se neeche" : "LTP ₹" + ltp + " se upar"} hona chahiye (warna turant hit ho jayega)` });
    const meta = t.meta as Record<string, unknown> | null;
    if (meta?.custom) {
      if (is != null) { const uq = (await eng().priceKeys([String(meta.uKey)], false)).get(String(meta.uKey)); const dir = meta.dir === 1;
        if (!(is > 0) || (uq && (dir ? is >= uq.ltp : is <= uq.ltp))) return reply.code(400).send({ error: "BAD_STOP", message: `Index SL ${dir ? "index LTP se neeche" : "index LTP se upar"} hona chahiye${uq ? ` (abhi ${uq.ltp})` : ""}` }); }
      const next = { ...meta, ...(ps !== undefined ? { premStop: ps } : {}), ...(is !== undefined ? { manualIdxStop: is } : {}) };
      await prisma.paperTrade.update({ where: { id: t.id }, data: { meta: next as object } });
    } else if (ps != null) await prisma.paperTrade.update({ where: { id: t.id }, data: { stopPrice: ps } });
    await audit("STOP_EDITED", { contract: t.contract, premiumStop: ps ?? null, indexStop: is ?? null });
    return { ok: true };
  });
  app.post("/api/positions/:id/close", async (req, reply) => {
    const t = await prisma.paperTrade.findUnique({ where: { id: (req.params as { id: string }).id } });
    if (!t || t.closedAt) return reply.code(404).send({ error: "NOT_OPEN" });
    const q = (await eng().priceKeys([t.instrumentKey])).get(t.instrumentKey);
    await eng().closeTrade(t, q, "MANUAL_CLOSE"); await eng().refreshUnrealized(); return { ok: true };
  });

  // ---------- engine ----------
  app.get("/api/engine", async () => eng().status);
  app.post("/api/engine/start", async (_req, reply) => {
    const p = await prisma.preferences.findUniqueOrThrow({ where: { id: pid() } });
    if (!p.strategies.length) return reply.code(400).send({ error: "VALIDATION", issues: ["Enable at least one strategy in Setup first"] });
    eng().start(); await audit("ENGINE_STARTED", { autoPaper: p.autoPaper, styles: p.styles, segments: p.segments }); return eng().status;
  });
  app.post("/api/engine/stop", async () => { eng().stop(); await audit("ENGINE_STOPPED", {}); return eng().status; });

  // ---------- market data ----------
  app.get("/api/watchlist", async () => {
    const p = await prisma.preferences.findUniqueOrThrow({ where: { id: pid() } });
    const insts = await prisma.instrument.findMany({ where: { key: { in: p.instrumentKeys } } });
    let error: string | null = null;
    // Crypto (Delta) is shown in native USD on Markets; NSE via the engine's quote cache.
    const usd = new Map<string, LiveQuote>();
    try {
      if (venue() === "DELTA") for (const q of await broker.current.getQuotes(insts.map(i => refOf(i)))) usd.set(`DELTA:${q.securityId}`, q);
      else await eng().priceKeys(insts.map(i => i.key));
    } catch (e) { error = (e as Error).message; }
    const now = clock().getTime();
    const sigs = await prisma.signal.findMany({ where: { venue: venue(), createdAt: { gte: new Date(now - 30 * 60000) } }, orderBy: { createdAt: "desc" } });
    const items = await Promise.all(insts.map(async i => {
      const q = venue() === "DELTA" ? usd.get(i.key) : eng().quotes.get(i.key);
      let ind = null;
      const bars = eng().cachedBars(refOf(i), 5); // never block the watchlist on history fetches
      if (bars?.length) ind = snapshot(bars);
      if (ind && i.segment === "DELTA") { const R = config.cryptoUsdInr, d = (v: number | null) => v == null ? null : v / R; ind = { ...ind, ema9: d(ind.ema9), ema21: d(ind.ema21), atr14: d(ind.atr14), vwap: d(ind.vwap) }; }
      const latest = sigs.find(s => s.instrumentKey === i.key && s.action !== "NO_TRADE") ?? sigs.find(s => s.instrumentKey === i.key);
      const chg = q && q.prevClose ? ((q.ltp - q.prevClose) / q.prevClose) * 100 : q && q.open ? ((q.ltp - q.open) / q.open) * 100 : null;
      const trend = ind && ind.ema9 && ind.ema21 && ind.vwap && q ? (q.ltp > ind.vwap && ind.ema9 > ind.ema21 ? "UP" : q.ltp < ind.vwap && ind.ema9 < ind.ema21 ? "DOWN" : "SIDEWAYS") : null;
      return { key: i.key, symbol: i.symbol, name: i.name, kind: i.instrumentType, fno: i.fnoEligible, quote: q ?? null, changePct: chg,
        ageMs: q ? now - Date.parse(q.receivedTs) : null, stale: !q || now - Date.parse(q.receivedTs) > config.maxQuoteAgeMs * 6, indicators: ind, trend,
        signal: latest ? { action: latest.action, direction: latest.direction, strategy: latest.strategyId, at: latest.createdAt } : null };
    }));
    return { source: venue() === "DELTA" ? "DELTA" : broker.source, error, marketOpen: eng().isOpen(), items };
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
    return prisma.signal.findMany({ where: action ? { action, venue: venue() } : { venue: venue() }, orderBy: { createdAt: "desc" }, take: 100 });
  });
  const modeOf = (req: { query: unknown }) => { const m = (req.query as { mode?: string }).mode; return m === "LIVE" || m === "PAPER" ? { mode: m } : {}; };
  app.get("/api/positions", async req => {
    const open = await prisma.paperTrade.findMany({ where: { closedAt: null, venue: venue(), ...modeOf(req) }, orderBy: { openedAt: "desc" } });
    const closed = await prisma.paperTrade.findMany({ where: { closedAt: { not: null }, venue: venue(), ...modeOf(req) }, orderBy: { closedAt: "desc" }, take: 200 });
    // today's P&L split paper vs live (current session)
    const s = await currentSession(), split = { PAPER: { realized: 0, unrealized: 0, trades: 0 }, LIVE: { realized: 0, unrealized: 0, trades: 0 } };
    if (s) for (const t of await prisma.paperTrade.findMany({ where: { sessionId: s.id, venue: venue() } })) {
      const b = split[t.mode === "LIVE" ? "LIVE" : "PAPER"]; b.trades++;
      if (t.closedAt) b.realized += Number(t.pnlInr);
      else b.unrealized += (Number(t.lastPrice) - Number(t.entryPrice)) * (t.side === "LONG" ? 1 : -1) * t.quantity - Number(t.entryCharges);
    }
    return { open, closed, today: split };
  });
  app.get("/api/performance", async req => {
    const t = await prisma.paperTrade.findMany({ where: { closedAt: { not: null }, venue: venue(), ...modeOf(req) }, orderBy: { closedAt: "asc" } });
    const pnl = t.map(x => Number(x.pnlInr)), wins = pnl.filter(p => p > 0), losses = pnl.filter(p => p <= 0), sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
    let cum = 0; const curve = t.map(x => ({ t: Math.floor(x.closedAt!.getTime() / 1000), v: (cum += Number(x.pnlInr)) }));
    const sessions = await prisma.tradingSession.findMany({ where: { venue: venue(), ...(modeOf(req).mode ? { paperTrades: { some: modeOf(req) } } : {}) }, orderBy: { tradingDate: "desc" }, take: 60 });
    return { trades: t.length, winRate: t.length ? wins.length / t.length : null, expectancy: t.length ? sum(pnl) / t.length : null, net: sum(pnl),
      profitFactor: losses.length && sum(losses) ? sum(wins) / Math.abs(sum(losses)) : null, avgWin: wins.length ? sum(wins) / wins.length : null, avgLoss: losses.length ? sum(losses) / losses.length : null,
      curve, sessions: sessions.map(toDto), sessionsCount: sessions.length };
  });

  app.post("/api/risk/check", async (req) => {
    const intent = { mode: "PAPER", ...(req.body as object) } as OrderIntent;
    const s = await currentSession(); const q = eng().quotes.get(intent.securityId);
    const d = preTradeCheck(intent, { gates: config.gates, session: s ? toDto(s) : null, openPositions: await prisma.paperTrade.count({ where: { closedAt: null, venue: venue() } }), maxOpenPositions: (await prisma.preferences.findUnique({ where: { id: pid() } }))?.maxOpenPositions ?? config.maxOpenPositions,
      maxConsecutiveLosses: s?.maxConsecutiveLosses ?? 3, quoteAgeMs: q ? clock().getTime() - Date.parse(q.receivedTs) : null, maxQuoteAgeMs: config.maxQuoteAgeMs,
      spreadPct: q?.bid && q?.ask ? ((q.ask - q.bid) / q.ltp) * 100 : null, maxSpreadPct: config.maxSpreadPct, brokerConnected: true, positionMismatch: false, unknownOrderState: false, now: clock(), entryCutoffIst: config.entryCutoffIst });
    await prisma.riskDecision.create({ data: { correlationId: intent.correlationId ?? "dry-run", sessionId: s?.id, mode: EFFECTIVE_MODE, approved: d.approved, reasons: d.reasons, intent: intent as object } });
    return d;
  });

  // ---------- crypto (Delta Exchange) helpers ----------
  const isCrypto = (i: { segment: string }) => i.segment === "DELTA";
  /** Delta prices are USD; backtests run in ₹ so capital/P&L stay comparable (approximate fixed rate). */
  const toInr = (bars: Bar[]) => bars.map(x => ({ ...x, o: x.o * config.cryptoUsdInr, h: x.h * config.cryptoUsdInr, l: x.l * config.cryptoUsdInr, c: x.c * config.cryptoUsdInr }));
  const cryptoNotes = (lev?: number) => [`Data: Delta Exchange India (USD) → ₹ at ${config.cryptoUsdInr}/USD (approx). 24x7 market: no square-off, positions can run across days.`,
    `Fees: Delta taker 0.05% of notional per side + 18% GST. Funding payments of perpetual futures are NOT modelled.${lev ? ` Margin per contract = notional ÷ ${lev}× leverage.` : ""}`];

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
    b: { key: string; interval: string; years: number; capital?: number; leverage?: number; sizingMode?: string; riskPct?: number; capitalPerLot?: number; lots?: number; slippagePoints?: number }, reply: import("fastify").FastifyReply) => {
    // Backtest Lab / builder test overrides: lot sizing, risk %, slippage (index points)
    let spec = spec0;
    if (spec && b.sizingMode && ["fixed", "capital", "risk"].includes(b.sizingMode)) spec = { ...spec, sizing: { ...spec.sizing, mode: b.sizingMode as "fixed" | "capital" | "risk",
      ...(b.riskPct != null ? { riskPct: Number(b.riskPct) } : {}), ...(b.capitalPerLot ? { capitalPerLot: Number(b.capitalPerLot) } : {}), ...(b.lots ? { lots: Number(b.lots) } : {}) } };
    if (spec && b.slippagePoints != null && Number.isFinite(Number(b.slippagePoints))) spec = { ...spec, costs: { ...spec.costs, slippagePoints: Math.max(0, Number(b.slippagePoints)) } };
    const errs = specErrors(spec); if (errs.length) return reply.code(400).send({ error: "VALIDATION", issues: errs });
    const inst = await prisma.instrument.findUnique({ where: { key: b.key } }); if (!inst) return reply.code(404).send({ error: "UNKNOWN_INSTRUMENT" });
    const daily = b.interval === "D", iv = daily ? "D" : (Number(b.interval) as 1 | 5 | 15 | 25 | 60);
    let years = Math.min(Math.max(Number(b.years) || 1, 0.1), 10); const notes: string[] = [];
    const crypto = isCrypto(inst), src = crypto ? "DELTA" : broker.source;
    if (!daily && years > 5) { years = 5; notes.push("Intraday data max 5 years (Dhan limit)."); }
    if (!crypto && !daily && broker.source === "MOCK" && years > 1) { years = 1; notes.push("MOCK intraday capped at 1 year."); }
    const to = clock(), from = new Date(to.getTime() - years * 365.25 * 86400000);
    let bars; try { bars = await broker.current.getCandles({ ref: refOf(inst), interval: iv, from, to }); } catch (e) { return reply.code(502).send({ error: "DATA_ERROR", message: (e as Error).message }); }
    if (bars.length < 50) return reply.code(422).send({ error: "INSUFFICIENT_DATA", message: `Only ${bars.length} bars returned for ${inst.symbol}.` });
    if (crypto) {
      bars = toInr(bars); const lev = Number(b.leverage) || config.cryptoLeverage;
      spec = cryptoSpec(spec!, { contractValue: Number(inst.contractValue ?? 1), refPrice: bars[bars.length - 1]!.c, leverage: lev, takerFee: Number(inst.takerFee ?? 0.0005),
        slippagePrice: (b.slippagePoints != null ? Number(b.slippagePoints) : 0.5) * config.cryptoUsdInr });
      notes.push(...cryptoNotes(lev), `1 lot = 1 contract = ${Number(inst.contractValue)} ${inst.symbol.replace(/USD$/, "")}; slippage ${b.slippagePoints ?? 0.5} USD/side.`);
    }
    const r = runSpecBacktest(bars, spec!, { daily, startingCapital: Number(b.capital) || 100000, oosFraction: 0.3, market: crypto ? "CRYPTO" : "NSE" });
    r.assumptions.unshift(...notes, `Data source: ${src}${src === "MOCK" ? " (SYNTHETIC)" : ""}.`);
    const sz = spec!.sizing, capLots = Math.min(Math.max(1, Math.round(sz.maxLots ?? 20)), Math.floor((Number(b.capital) || 100000) / (sz.capitalPerLot || 15000)));
    const sizeTxt = (sz.mode ?? "fixed") === "fixed" ? ((sz.lots ?? 1) > capLots ? `${sz.lots} lot → max ${capLots} used` : `${sz.lots ?? 1} lot`) : sz.mode === "capital" ? "capital-sized" : `risk ${sz.riskPct ?? 1}%`;
    const label = `${inst.symbol} · ${spec!.name} (custom) · ${daily ? "Daily" : iv + "m"} · ${years}y · ₹${(Number(b.capital) || 100000).toLocaleString("en-IN")} · ${sizeTxt}`;
    const { trades, equity, ...summary } = r;
    const run = await prisma.backtestRun.create({ data: { label, dataSource: src, metrics: r.metrics as object, result: { ...summary, trades, equity } as object,
      config: { custom: true, specId, spec: spec as object, key: b.key, interval: b.interval, years, daily, startingCapital: Number(b.capital) || 100000, sizingMode: sz.mode ?? "fixed", riskPct: sz.riskPct,
        // exactly what the user entered (so "Use these filters" restores the form 1:1)
        slippagePoints: b.slippagePoints != null ? Number(b.slippagePoints) : (crypto ? 0.5 : spec!.costs.slippagePoints), lots: sz.lots ?? 1, capitalPerLot: b.capitalPerLot ?? sz.capitalPerLot ?? 15000, leverage: b.leverage ?? null } as object } });
    await audit("CUSTOM_BACKTEST_RUN", { label, trades: r.trades.length });
    return { id: run.id, label, runConfig: run.config, ...r, daily: dailyPnl(r.trades), trades: r.trades.slice(-500), equity: thin(r.equity, 1500), tradeCount: r.trades.length };
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
    const p = await prisma.preferences.findUniqueOrThrow({ where: { id: pid() } });
    const strategies = b.onlyThis ? [b.strategyId] : [...new Set([...p.strategies, b.strategyId])];
    await prisma.preferences.update({ where: { id: pid() }, data: { strategies, defaultCapital: cap, ...(b.sizingMode === "risk" && b.riskPct ? { defaultRiskPct: Number(b.riskPct) } : {}) } });
    await audit("APPLIED_TO_LIVE", { strategy: row.name, capital: cap, sizing });
    const s = await currentSession();
    return { ok: true, strategy: row.name, selected: strategies.length, sessionCapital: s ? Number(s.capitalInr) : null };
  });
  /** Everything the engine will actually trade with — for the Dashboard "Trading plan" view. */
  app.get("/api/live-plan", async () => {
    const p = await prisma.preferences.findUniqueOrThrow({ where: { id: pid() } });
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
    // today's rejected ENTER signals (why no trade happened)
    const dayStart = new Date(Date.parse(today() + "T00:00:00+05:30"));
    const rejected = (await prisma.auditEvent.findMany({ where: { action: "ENTRY_REJECTED", at: { gte: dayStart }, details: { path: ["venue"], equals: venue() } }, orderBy: { id: "desc" }, take: 8 }))
      .map(r => ({ at: r.at, underlying: (r.details as { underlying?: string }).underlying, reasons: (r.details as { reasons?: string[] }).reasons ?? [] }));
    const signalsToday = await prisma.signal.count({ where: { venue: venue(), action: "ENTER", createdAt: { gte: dayStart } } });
    return { autoEngine: p.autoEngine, rejected, signalsToday, autoPaper: p.autoPaper, styles: p.styles, segments: p.segments, engineRunning: eng().status.running, marketOpen: eng().isOpen(), venue: venue(),
      session: s ? toDto(s) : null, defaultCapital: Number(p.defaultCapital), strategies, squareOffIst: config.squareOffIst, maxOpenPositions: p.maxOpenPositions };
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
    if (!daily && broker.source === "MOCK" && inst.segment !== "DELTA" && effYears > 1) { notes.push("MOCK intraday backtests are capped at 1 year for speed."); effYears = 1; }
    const to = clock(), from = new Date(to.getTime() - effYears * 365.25 * 86400000);
    let bars;
    try { bars = await broker.current.getCandles({ ref: refOf(inst), interval: iv, from, to }); } catch (e) { return reply.code(502).send({ error: "DATA_ERROR", message: (e as Error).message }); }
    if (bars.length < 50) return reply.code(422).send({ error: "INSUFFICIENT_DATA", message: `Only ${bars.length} bars returned for ${inst.symbol}. ${inst.instrumentType === "INDEX" ? "Indices have no volume → VWAP strategies cannot trigger; try a stock." : ""}` });
    if (inst.instrumentType === "INDEX" && bars.every(x => x.v === 0)) notes.push("Index has no volume: VWAP/relative-volume checks cannot pass. Backtest a stock or the index future instead.");
    const style = STYLES[b.style ?? "INTRADAY"];
    const crypto = isCrypto(inst); if (crypto) { bars = toInr(bars); notes.push(...cryptoNotes(), `1 unit = 1 contract = ${Number(inst.contractValue)} ${inst.symbol.replace(/USD$/, "")}.`); }
    const cfg = { strategyId: b.strategyId, params: { ...(daily ? {} : style?.params) }, daily, startingCapital: Number(b.capital) || 100000, riskPerTradePct: Number(b.riskPct) || 0.5,
      slippageBps: Number(b.slippageBps ?? 5), // Spot indices are traded via futures/options, so index backtests use futures charges.
      product: b.product ?? (inst.instrumentType === "INDEX" ? "FUTURES" : daily ? "EQUITY_DELIVERY" : "EQUITY_INTRADAY"), allowShort: b.allowShort ?? !daily, squareOffIst: config.squareOffIst,
      maxHoldBars: daily ? 20 : 60, lotSize: 1, oosFraction: 0.3,
      ...(crypto ? { product: "CRYPTO_PERP" as ProductKind, lotSize: Number(inst.contractValue ?? 1), market: "CRYPTO" as const, allowShort: true, maxHoldBars: daily ? 30 : 288 } : {}) };
    const src = crypto ? "DELTA" : broker.source;
    const r = runBacktest(bars, cfg);
    r.assumptions.unshift(...notes, `Data source: ${src}${src === "MOCK" ? " (SYNTHETIC — results say nothing about real markets)" : ""}.`);
    const label = `${inst.symbol} · ${STRATEGIES[b.strategyId]!.name} · ${daily ? "Daily" : iv + "m"} · ${effYears}y`;
    const { trades, equity, ...summary } = r;
    const run = await prisma.backtestRun.create({ data: { label, dataSource: src, config: { ...cfg, key: b.key, years: effYears, interval: b.interval, style: b.style } as object, metrics: r.metrics as object, result: { ...summary, trades, equity } as object } });
    await audit("BACKTEST_RUN", { label, trades: r.trades.length });
    return { id: run.id, label, runConfig: run.config, ...r, daily: dailyPnl(r.trades), trades: r.trades.slice(-500), equity: thin(r.equity, 1500), tradeCount: r.trades.length };
  });
  // ---------- strategy leaderboard (all strategies × instrument basket) ----------
  app.get("/api/leaderboard", async () => {
    const r = await leaderboard.latest(venue());
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
    // Delta default basket: BTC, ETH, SOL, XRP perpetuals
    const vkeys = keys?.length ? keys : venue() === "DELTA" ? ["DELTA:BTCUSD", "DELTA:ETHUSD", "DELTA:SOLUSD", "DELTA:XRPUSD"] : undefined;
    const st = leaderboard.start(Number(b.years) || 1, interval, vkeys, b.slippageBps != null ? Number(b.slippageBps) : 5, venue());
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

  app.get("/api/audit", async () => (await prisma.auditEvent.findMany({ where: venue() === "DELTA" ? { details: { path: ["venue"], equals: "DELTA" } }
      : { OR: [{ details: { path: ["venue"], equals: "DHAN" } }, { details: { path: ["venue"], equals: Prisma.AnyNull } }] }, orderBy: { id: "desc" }, take: 100 })) // untagged (older) = Dhan
    .map(r => ({ ...r, id: r.id.toString() })));
  // ---------- 💬 market chat (read-only Claude analysis; never touches orders/engine) ----------
  app.get("/api/settings/chat", async () => chatInfo());
  app.put("/api/settings/chat", async (req) => { const b = (req.body ?? {}) as { apiKey?: string; model?: string; provider?: string }; const r = saveChatSettings(b); await audit("CHAT_SETTINGS", { provider: r.provider, model: r.model, keyChanged: b.apiKey !== undefined }); return r; });
  app.get("/api/chat/snapshot", async (req) => { const q = (req.query as { q?: string }).q ?? ""; return buildSnapshot(prisma, broker, venue(), await pickUnderlying(prisma, venue(), q), clock()); });
  app.post("/api/chat", async (req, reply) => {
    const b = (req.body ?? {}) as { question?: string; history?: ChatTurn[] };
    const question = String(b.question ?? "").trim().slice(0, 4000); if (!question) return reply.code(400).send({ error: "EMPTY_QUESTION" });
    if (!chatInfo().configured) return reply.code(400).send({ error: "NO_KEY", message: chatInfo().provider === "local" ? "Claude Code CLI nahi mila — Terminal mein 'claude' install/login karein." : "Claude API key set nahi hai — Market Chat settings mein key daalein." });
    const v = venue(), snapshot = await buildSnapshot(prisma, broker, v, await pickUnderlying(prisma, v, question), clock());
    reply.hijack();
    const res = reply.raw; res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no" });
    const ac = new AbortController(); res.on("close", () => { if (!res.writableFinished) ac.abort(); });
    let answer = "";
    try { answer = await askClaude({ history: Array.isArray(b.history) ? b.history : [], question, snapshot, onText: t => res.write(t), signal: ac.signal }); }
    catch (e) { const m = (e as Error).message; res.write(`\n\n⚠️ Chat error: ${m}`); answer = `ERROR: ${m}`; }
    res.end();
    // suggestion log — review later whether the chat's calls actually helped
    await audit("CHAT_QA", { question, answer: answer.slice(0, 4000), spot: (snapshot as { spot?: { ltp?: number } }).spot?.ltp ?? null, underlying: (snapshot as { underlying?: { symbol?: string } }).underlying?.symbol ?? null }, undefined, v).catch(() => {});
  });

  app.put("/api/settings/delta", async (req, reply) => {
    const b = req.body as { usdInr?: number; leverage?: number }, usdInr = Number(b.usdInr), leverage = Number(b.leverage);
    if (!(usdInr >= 40 && usdInr <= 200)) return reply.code(400).send({ error: "VALIDATION", issues: ["₹/USD rate 40–200 ke beech hona chahiye"] });
    if (!(leverage >= 1 && leverage <= 100)) return reply.code(400).send({ error: "VALIDATION", issues: ["Leverage 1–100 ke beech"] });
    saveDeltaSettings({ usdInr, leverage }); engines.DELTA.clearCache(); await audit("DELTA_SETTINGS_UPDATED", { usdInr, leverage }, undefined, "DELTA");
    return { usdInr: config.cryptoUsdInr, leverage: config.cryptoLeverage };
  });
  app.get("/api/meta", async () => ({ defaults: DEFAULT_PARAMS, styles: STYLES, strategies: Object.keys(STRATEGIES) }));

  // There is intentionally NO broker order-placement route in this build.
  return { app, engine, engines, broker };
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
