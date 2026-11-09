import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "../src/app.ts";
import { BrokerHolder } from "../src/broker.ts";

const prisma = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL ?? "postgresql://jassu@localhost:5432/dhan_trader_test" } } });
let now = new Date("2026-11-09T05:00:00Z"); // Mon 10:30 IST
const clock = () => now;
let ctx: Awaited<ReturnType<typeof buildApp>>;
const inject = (method: "GET" | "POST" | "PUT", url: string, payload?: object) => ctx.app.inject({ method, url, payload });

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  await prisma.$executeRawUnsafe(`TRUNCATE "Instrument","Preferences" CASCADE`);
  ctx = await buildApp({ prisma, clock, broker: new BrokerHolder(clock, "MOCK") });
});
afterAll(async () => { ctx.engine.stop(); await ctx.app.close(); await prisma.$disconnect(); });
beforeEach(async () => {
  now = new Date("2026-11-09T05:00:00Z");
  await prisma.$executeRawUnsafe(`TRUNCATE "RiskDecision","PaperTrade","TradingSession","AuditEvent","Signal","OrderIntent" RESTART IDENTITY CASCADE`);
  await prisma.preferences.update({ where: { id: 1 }, data: { autoStartDaily: false, autoPaper: false, strategies: [] } });
});
const start = (body: object) => inject("POST", "/api/session/start", body);

describe("daily session", () => {
  it("starts with unlimited profit", async () => {
    const r = await start({ capitalInr: 50000, maxLossInr: 1000, maxProfitInr: null });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ mode: "PAPER", maxProfitInr: null, status: "ACTIVE", tradingDate: "2026-11-09" });
  });
  it("rejects max loss above capital and missing max loss", async () => {
    expect((await start({ capitalInr: 1000, maxLossInr: 5000, maxProfitInr: null })).statusCode).toBe(400);
    expect((await start({ capitalInr: 1000, maxProfitInr: null })).statusCode).toBe(400);
  });
  it("one session per day; limits are editable mid-day", async () => {
    await start({ capitalInr: 50000, maxLossInr: 1000, maxProfitInr: 3000 });
    expect((await start({ capitalInr: 50000, maxLossInr: 1000, maxProfitInr: null })).statusCode).toBe(409);
    expect((await inject("POST", "/api/session/limits", { capitalInr: 50000, maxLossInr: 60000, maxProfitInr: null })).statusCode).toBe(400);
    const r = await inject("POST", "/api/session/limits", { capitalInr: 50000, maxLossInr: 2000, maxProfitInr: null, riskPerTradePct: 1, maxConsecutiveLosses: 5 });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ maxLossInr: "2000.00", maxProfitInr: null, riskPerTradePct: "1.00", maxConsecutiveLosses: 5 });
  });
  it("loosening the loss-streak limit resumes a paused session", async () => {
    await start({ capitalInr: 50000, maxLossInr: 1000, maxProfitInr: null, maxConsecutiveLosses: 2 });
    await prisma.tradingSession.updateMany({ data: { consecutiveLosses: 2, status: "HALTED_CONSECUTIVE_LOSSES" } });
    const r = await inject("POST", "/api/session/limits", { capitalInr: 50000, maxLossInr: 1000, maxProfitInr: null, maxConsecutiveLosses: 4 });
    expect(r.json().status).toBe("ACTIVE");
  });
  it("auto-starts the day from saved defaults when enabled", async () => {
    await inject("PUT", "/api/preferences", { autoStartDaily: true, defaultCapital: 20000, defaultMaxLoss: 400, defaultMaxProfit: null });
    await ctx.engine.tick(true);
    const s = (await inject("GET", "/api/session")).json().session;
    expect(s).toMatchObject({ capitalInr: "20000.00", maxLossInr: "400.00", maxProfitInr: null });
  });
});

describe("preferences", () => {
  it("validates multi-select styles and segments", async () => {
    expect((await inject("PUT", "/api/preferences", { styles: [] })).statusCode).toBe(400);
    expect((await inject("PUT", "/api/preferences", { segments: ["CRYPTO"] })).statusCode).toBe(400);
    const r = await inject("PUT", "/api/preferences", { styles: ["INTRADAY", "SCALPING"], segments: ["EQUITY", "FUTURES", "OPTIONS"] });
    expect(r.statusCode).toBe(200);
  });
});

describe("paper trading flow (mock data)", () => {
  it("manual paper position: close-all requires typed confirmation and books P&L", async () => {
    await start({ capitalInr: 100000, maxLossInr: 2000, maxProfitInr: null });
    const s = await prisma.tradingSession.findFirstOrThrow();
    await prisma.paperTrade.create({ data: { sessionId: s.id, correlationId: "t1", strategyId: "x", underlying: "HDFCBANK", instrumentKey: "NSE_EQ:1333", contract: "HDFCBANK EQ", kind: "EQUITY", product: "INTRADAY",
      side: "LONG", quantity: 10, lotSize: 1, entryPrice: 1, stopPrice: 0.5, targetPrice: 100000, lastPrice: 1, dataSource: "MOCK", fillNote: "test" } });
    expect((await inject("POST", "/api/positions/close-all", {})).statusCode).toBe(400);
    const r = await inject("POST", "/api/positions/close-all", { confirm: "CLOSE ALL" });
    expect(r.json().closed).toBe(1);
    const t = await prisma.paperTrade.findFirstOrThrow();
    expect(t.closedAt).not.toBeNull(); expect(t.exitReason).toBe("MANUAL_CLOSE_ALL");
    const sess = (await inject("GET", "/api/session")).json().session;
    expect(Number(sess.realizedPnlInr)).toBeCloseTo(Number(t.pnlInr), 2);
  });
  it("daily max-loss breach halts the session and flattens positions", async () => {
    await start({ capitalInr: 100000, maxLossInr: 100, maxProfitInr: null });
    const s = await prisma.tradingSession.findFirstOrThrow();
    await prisma.paperTrade.create({ data: { sessionId: s.id, correlationId: "t2", strategyId: "x", underlying: "HDFCBANK", instrumentKey: "NSE_EQ:1333", contract: "HDFCBANK EQ", kind: "EQUITY", product: "INTRADAY",
      side: "LONG", quantity: 100, lotSize: 1, entryPrice: 5000, stopPrice: 1, targetPrice: 100000, lastPrice: 5000, dataSource: "MOCK", fillNote: "test" } });
    await ctx.engine.tick(true);
    const sess = (await inject("GET", "/api/session")).json().session;
    expect(sess.status).toBe("HALTED_LOSS");
    expect(await prisma.paperTrade.count({ where: { closedAt: null } })).toBe(0);
  });
  it("intraday positions are squared off at 15:15 IST", async () => {
    await start({ capitalInr: 100000, maxLossInr: 100000, maxProfitInr: null });
    const s = await prisma.tradingSession.findFirstOrThrow();
    const [q] = await ctx.broker.mock.getQuotes([{ securityId: "1333", segment: "NSE_EQ", instrumentType: "EQUITY", symbol: "HDFCBANK" }]);
    await prisma.paperTrade.create({ data: { sessionId: s.id, correlationId: "t3", strategyId: "x", underlying: "HDFCBANK", instrumentKey: "NSE_EQ:1333", contract: "HDFCBANK EQ", kind: "EQUITY", product: "INTRADAY",
      side: "LONG", quantity: 1, lotSize: 1, entryPrice: q!.ltp, stopPrice: q!.ltp * 0.5, targetPrice: q!.ltp * 2, lastPrice: q!.ltp, dataSource: "MOCK", fillNote: "test" } });
    now = new Date("2026-11-09T09:46:00Z"); // 15:16 IST
    await ctx.engine.tick(true);
    expect((await prisma.paperTrade.findFirstOrThrow()).exitReason).toBe("INTRADAY_SQUARE_OFF");
  });
  it("engine generates explainable signals from mock data and never duplicates them", async () => {
    await start({ capitalInr: 100000, maxLossInr: 2000, maxProfitInr: null });
    await inject("PUT", "/api/preferences", { strategies: ["trend-breakout", "vwap-pullback"], styles: ["INTRADAY"], autoPaper: true, segments: ["EQUITY"] });
    expect((await inject("POST", "/api/engine/start")).statusCode).toBe(200);
    ctx.engine.stop(); await new Promise(r => setTimeout(r, 300)); ctx.engine.status.running = true;
    await ctx.engine.tick(); const n1 = await prisma.signal.count();
    await ctx.engine.tick(); const n2 = await prisma.signal.count();
    ctx.engine.stop();
    expect(n1).toBeGreaterThan(0); expect(n2).toBe(n1);
    const sig = await prisma.signal.findFirstOrThrow();
    expect(Array.isArray(sig.reasons)).toBe(true); expect(sig.dataSource).toBe("MOCK");
    expect(await prisma.paperTrade.count()).toBeLessThanOrEqual(1); // max open positions = 1
  });
  it("Strategy Builder strategy trades live: entry by its rules → paper fill → exit by its exit rule", async () => {
    await start({ capitalInr: 500000, maxLossInr: 20000, maxProfitInr: null, riskPerTradePct: 1 });
    const always = { t: "compare", a: { k: "value", v: 1 }, op: ">", b: { k: "value", v: 0 } };
    const spec = { name: "Live test strategy", timeframe: "5", entryMode: "barClose", long: { enabled: true, entry: [always], exit: [always] }, short: { enabled: false, entry: [], exit: [] },
      stop: { type: "points", value: 50 }, target: { type: "none", value: 0 }, trailing: { type: "none", every: 5, by: 1 },
      session: { squareOff: "15:15", noEntryAfter: "14:45", maxTradesPerDay: 1 }, sizing: { qty: 75, delta: 0.5 }, costs: { perTrade: 60, slippagePoints: 0.5 } };
    const created = await inject("POST", "/api/builder/strategies", { spec }); expect(created.statusCode).toBe(200);
    const sid = `custom:${created.json().id}`;
    const opts = (await inject("GET", "/api/preferences")).json().strategyOptions;
    expect(opts.find((o: { id: string }) => o.id === sid)).toMatchObject({ custom: true, liveSupported: true });
    expect((await inject("PUT", "/api/preferences", { strategies: [sid], instrumentKeys: ["IDX_I:13"], styles: ["INTRADAY"], autoPaper: true, segments: ["OPTIONS"] })).statusCode).toBe(200);
    ctx.engine.status.running = true;
    await ctx.engine.tick();
    const t = await prisma.paperTrade.findFirstOrThrow();
    expect(t.strategyId).toBe("Live test strategy (custom)"); expect(t.kind).toBe("OPTIONS");
    expect(t.meta).toMatchObject({ custom: true, dir: 1, tf: 5 });
    await ctx.engine.tick(); expect(await prisma.paperTrade.count()).toBe(1); // one position per strategy & instrument
    now = new Date(now.getTime() + 11 * 60000);                                // the entry candle has now closed
    await ctx.engine.tick();
    const closed = await prisma.paperTrade.findUniqueOrThrow({ where: { id: t.id } });
    expect(closed.exitReason).toBe("RULE_EXIT_RULE");
    await ctx.engine.tick(); expect(await prisma.paperTrade.count()).toBe(1);   // max 1 trade/day respected
    ctx.engine.stop();
  });
  it("Use in Trade Setup: applies strategy + lot sizing to live, and the engine trades that many lots", async () => {
    await start({ capitalInr: 500000, maxLossInr: 50000, maxProfitInr: null, riskPerTradePct: 1 });
    const always = { t: "compare", a: { k: "value", v: 1 }, op: ">", b: { k: "value", v: 0 } };
    const spec = { name: "Apply test", timeframe: "5", instruments: ["IDX_I:13"], entryMode: "barClose", long: { enabled: true, entry: [always], exit: [] }, short: { enabled: false, entry: [], exit: [] },
      stop: { type: "points", value: 50 }, target: { type: "none", value: 0 }, trailing: { type: "none", every: 5, by: 1 },
      session: { squareOff: "15:15", noEntryAfter: "14:45", maxTradesPerDay: 1 }, sizing: { qty: 75, delta: 0.5 }, costs: { perTrade: 60, slippagePoints: 0.5 } };
    const id = (await inject("POST", "/api/builder/strategies", { spec })).json().id, sid = `custom:${id}`;
    await inject("PUT", "/api/preferences", { strategies: ["trend-breakout"], styles: ["INTRADAY"], autoPaper: true, segments: ["OPTIONS"] });
    const r = await inject("POST", "/api/builder/apply-live", { strategyId: sid, capital: 500000, sizingMode: "fixed", lots: 2, capitalPerLot: 15000, slippagePoints: 0.25, onlyThis: true });
    expect(r.statusCode).toBe(200);
    const prefs = (await inject("GET", "/api/preferences")).json();
    expect(prefs.strategies).toEqual([sid]); expect(prefs.defaultCapital).toBe(500000);
    ctx.engine.status.running = true; await ctx.engine.tick(); ctx.engine.stop();
    const t = await prisma.paperTrade.findFirstOrThrow();
    expect(t.quantity).toBe(2 * t.lotSize);                       // exactly the 2 fixed lots applied from Backtest Lab
    expect(t.meta).toMatchObject({ sizing: { mode: "fixed", lots: 2 } });
    // 100 fixed lots on ₹5L are capped by capital (₹5L ÷ ₹15k = 33) and max 20
    await inject("POST", "/api/builder/apply-live", { strategyId: sid, capital: 500000, sizingMode: "fixed", lots: 100, capitalPerLot: 15000 });
    expect(((await prisma.customStrategy.findUniqueOrThrow({ where: { id } })).spec as { sizing: { lots: number } }).sizing.lots).toBe(100);
  });
  it("ENTER signal → option contract pick → risk check → paper fill (mock chain)", async () => {
    await start({ capitalInr: 100000, maxLossInr: 2000, maxProfitInr: null, riskPerTradePct: 1 });
    const session = await prisma.tradingSession.findFirstOrThrow();
    const u = await prisma.instrument.findUniqueOrThrow({ where: { key: "IDX_I:13" } });
    const [q] = await ctx.broker.mock.getQuotes([{ securityId: "13", segment: "IDX_I", instrumentType: "INDEX", symbol: "NIFTY" }]);
    const sig = { strategyId: "trend-breakout", strategyVersion: "1.0.0", barTime: 0, direction: "BULLISH" as const, action: "ENTER" as const, reasons: [], checks: [], entry: q!.ltp, stop: q!.ltp - 20, target: q!.ltp + 40 };
    await ctx.engine.tryEnter(sig, u, "INTRADAY", ["OPTIONS"], session, "corr-1");
    const t = await prisma.paperTrade.findFirstOrThrow();
    expect(t).toMatchObject({ kind: "OPTIONS", side: "LONG", product: "INTRADAY" });
    expect(t.contract).toMatch(/NIFTY .* CE$/);
    expect(Number(t.stopPrice)).toBeLessThan(Number(t.entryPrice));
    expect(await prisma.riskDecision.count({ where: { approved: true } })).toBe(1);
    // same correlation id again → no duplicate
    await ctx.engine.tryEnter(sig, u, "INTRADAY", ["OPTIONS"], session, "corr-1");
    expect(await prisma.paperTrade.count()).toBe(1);
  });
  it("emergency stop flattens and blocks entries", async () => {
    await start({ capitalInr: 50000, maxLossInr: 1000, maxProfitInr: null });
    const r = (await inject("POST", "/api/emergency-stop")).json();
    expect(r.status).toBe("EMERGENCY_STOP");
    const d = (await inject("POST", "/api/risk/check", { correlationId: "x", securityId: "NSE_EQ:1333", side: "BUY", quantity: 1, lotSize: 1, limitPrice: "10", stopPrice: "9", isEntry: true, strategyVersion: "t" })).json();
    expect(d.reasons).toContain("SESSION_EMERGENCY_STOP");
  });
});

describe("backtest", () => {
  it("runs a 10-year daily backtest on mock data with costs and OOS split", async () => {
    const r = await inject("POST", "/api/backtest", { key: "NSE_EQ:1333", strategyId: "trend-breakout", interval: "D", years: 10, capital: 100000, riskPct: 1 });
    expect(r.statusCode).toBe(200);
    const j = r.json(); expect(j.bars).toBeGreaterThan(2400);
    expect(j.assumptions.join(" ")).toMatch(/SYNTHETIC/); expect(j.outOfSample).toBeDefined();
    const csv = await inject("GET", `/api/backtests/${j.id}/csv`); expect(csv.body).toMatch(/entryTimeUTC/);
  }, 30000);
  it("caps intraday ranges to Dhan's 5-year limit", async () => {
    const j = (await inject("POST", "/api/backtest", { key: "NSE_EQ:1333", strategyId: "vwap-pullback", interval: "5", years: 10 })).json();
    expect(j.assumptions.join(" ")).toMatch(/5 years/);
  }, 60000);
});

describe("live safety", () => {
  it("LIVE intent via API is rejected even with flags flipped", async () => {
    process.env.LIVE_TRADING_ENABLED = "true";
    await start({ capitalInr: 50000, maxLossInr: 1000, maxProfitInr: null });
    const d = (await inject("POST", "/api/risk/check", { mode: "LIVE", correlationId: "y", securityId: "NSE_EQ:1333", side: "BUY", quantity: 1, lotSize: 1, limitPrice: "10", stopPrice: "9", isEntry: true, strategyVersion: "t" })).json();
    expect(d.approved).toBe(false); expect(d.reasons.join()).toMatch(/LIVE_NOT_IMPLEMENTED/);
  });
  it("no broker order route exists; cross-origin writes rejected", async () => {
    for (const url of ["/api/orders", "/api/order", "/api/orders/place"]) expect((await inject("POST", url, {})).statusCode).toBe(404);
    const r = await ctx.app.inject({ method: "POST", url: "/api/positions/close-all", headers: { origin: "https://evil.example" }, payload: { confirm: "CLOSE ALL" } });
    expect(r.statusCode).toBe(403);
  });
  it("health never exposes the token", async () => {
    const h = (await inject("GET", "/api/health")).body;
    expect(h).not.toMatch(/accessToken/);
    expect(JSON.parse(h)).toMatchObject({ mode: "PAPER", liveExecutionAvailable: false });
  });
});
