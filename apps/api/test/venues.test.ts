import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "../src/app.ts";
import { BrokerHolder } from "../src/broker.ts";
import type { Bar } from "@dat/quant";

const prisma = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL ?? "postgresql://jassu@localhost:5432/dhan_trader_test" } } });
let now = new Date("2026-11-09T05:00:00Z");
const clock = () => now;
let ctx: Awaited<ReturnType<typeof buildApp>>;
const inject = (method: "GET" | "POST" | "PUT", url: string, payload?: object) => ctx.app.inject({ method, url, payload });

beforeAll(async () => {
  process.env.NODE_ENV = "test";
  await prisma.$executeRawUnsafe(`TRUNCATE "RiskDecision","PaperTrade","TradingSession","AuditEvent","Signal","OrderIntent" RESTART IDENTITY CASCADE`);
  const broker = new BrokerHolder(clock, "MOCK");
  // fake Delta: BTC around $74,600, gently rising 5-min candles
  broker.delta.getCandles = async q => { const out: Bar[] = []; const st = q.interval === "D" ? 86400 : 300; const end = Math.floor(clock().getTime() / 1000 / st) * st; for (let t = Math.floor(q.from.getTime() / 1000 / st) * st; t < end; t += st) { const p = 74000 + (t % 86400) / 300 + (st === 86400 ? (t / 86400) % 100 : 0); out.push({ t, o: p, h: p + 20, l: p - 20, c: p + 5, v: 100 }); } return out; };
  broker.delta.getQuotes = async refs => refs.map(r => ({ securityId: r.securityId, segment: "DELTA" as const, ltp: 74600, bid: 74599.5, ask: 74600.5, volume: 1, open: 74000, high: null, low: null, prevClose: null, oi: null, sourceTs: null, receivedTs: clock().toISOString(), source: "DELTA" as const }));
  ctx = await buildApp({ prisma, clock, broker });
  await prisma.instrument.upsert({ where: { key: "DELTA:BTCUSD" }, update: { contractValue: 0.001, takerFee: 0.0005 },
    create: { key: "DELTA:BTCUSD", securityId: "BTCUSD", segment: "DELTA", instrumentType: "CRYPTO_PERP", symbol: "BTCUSD", name: "Bitcoin Perpetual (Delta)", lotSize: 1, tickSize: 0.5, contractValue: 0.001, takerFee: 0.0005, source: "DELTA" } });
});
afterAll(async () => { ctx.engines.DHAN.stop(); ctx.engines.DELTA.stop(); await ctx.app.close(); await prisma.$disconnect(); });

describe("two exchanges side by side (Dhan + Delta)", () => {
  it("each venue has its own session, prefs, engine and trades; Delta trades crypto perpetuals 24x7", async () => {
    // separate sessions
    expect((await inject("POST", "/api/session/start?venue=DHAN", { capitalInr: 100000, maxLossInr: 2000, maxProfitInr: null })).statusCode).toBe(200);
    expect((await inject("POST", "/api/session/start?venue=DELTA", { capitalInr: 300000, maxLossInr: 9000, maxProfitInr: null, riskPerTradePct: 1 })).statusCode).toBe(200);
    expect((await inject("GET", "/api/session?venue=DELTA")).json().session.capitalInr).toBe("300000.00");
    expect((await inject("GET", "/api/session?venue=DHAN")).json().session.capitalInr).toBe("100000.00");
    // separate prefs: a builder strategy on Delta only
    const always = { t: "compare", a: { k: "value", v: 1 }, op: ">", b: { k: "value", v: 0 } };
    const spec = { name: "Crypto test", timeframe: "5", entryMode: "barClose", long: { enabled: true, entry: [always], exit: [] }, short: { enabled: false, entry: [], exit: [] },
      stop: { type: "points", value: 50000 }, target: { type: "none", value: 0 }, trailing: { type: "none", every: 5, by: 1 },
      session: { squareOff: "15:15", noEntryAfter: "14:45", maxTradesPerDay: 1 }, sizing: { qty: 75, delta: 0.5 }, costs: { perTrade: 60, slippagePoints: 0.5 } };
    const sid = `custom:${(await inject("POST", "/api/builder/strategies", { spec })).json().id}`;
    expect((await inject("PUT", "/api/preferences?venue=DELTA", { strategies: [sid], instrumentKeys: ["DELTA:BTCUSD"], autoPaper: true })).statusCode).toBe(200);
    expect((await inject("GET", "/api/preferences?venue=DHAN")).json().strategies).not.toContain(sid);
    // Delta engine trades at 21:30 IST (NSE closed) — crypto is 24x7
    now = new Date("2026-11-09T16:00:00Z");
    expect((await inject("GET", "/api/health?venue=DELTA")).json().marketOpen).toBe(true);
    expect((await inject("GET", "/api/health?venue=DHAN")).json().marketOpen).toBe(false);
    ctx.engines.DELTA.status.running = true; await ctx.engines.DELTA.tick(); ctx.engines.DELTA.stop();
    const t = await prisma.paperTrade.findFirstOrThrow();
    expect(t).toMatchObject({ venue: "DELTA", kind: "CRYPTO", underlying: "BTCUSD", side: "LONG" });
    expect(Math.abs(Number(t.entryPrice) / (74600.5 * 85 * 0.001) - 1)).toBeLessThan(0.001); // ₹ per contract (0.001 BTC) + slippage
    expect(t.quantity).toBeGreaterThan(0);
    // positions are isolated per venue
    expect((await inject("GET", "/api/positions?venue=DELTA")).json().open.length).toBe(1);
    expect((await inject("GET", "/api/positions?venue=DHAN")).json().open.length).toBe(0);
    // Delta position is NOT squared off at 15:15 IST; Dhan engine leaves Delta trades alone
    now = new Date("2026-11-10T10:00:00Z"); // 15:30 IST next day
    await ctx.engines.DHAN.tick(true); await ctx.engines.DELTA.tick(true);
    expect((await prisma.paperTrade.findUniqueOrThrow({ where: { id: t.id } })).closedAt).toBeNull();
  });
  it("a rejected daily signal is retried (every 10 min while fresh) once limits allow — not lost for the day", async () => {
    await prisma.instrument.upsert({ where: { key: "DELTA:ETHUSD" }, update: { contractValue: 0.01 },
      create: { key: "DELTA:ETHUSD", securityId: "ETHUSD", segment: "DELTA", instrumentType: "CRYPTO_PERP", symbol: "ETHUSD", name: "Ether Perpetual (Delta)", lotSize: 1, tickSize: 0.05, contractValue: 0.01, takerFee: 0.0005, source: "DELTA" } });
    const always = { t: "compare", a: { k: "value", v: 1 }, op: ">", b: { k: "value", v: 0 } };
    const spec = { name: "Daily retry test", timeframe: "D", instruments: ["DELTA:ETHUSD"], entryMode: "barClose", long: { enabled: true, entry: [always], exit: [] }, short: { enabled: false, entry: [], exit: [] },
      stop: { type: "points", value: 3000 }, target: { type: "none", value: 0 }, trailing: { type: "none", every: 5, by: 1 },
      session: { squareOff: "23:59", noEntryAfter: "23:59", maxTradesPerDay: 1 }, sizing: { qty: 1, delta: 1, mode: "fixed", lots: 5 }, costs: { perTrade: 0, slippagePoints: 0 } };
    const sid = `custom:${(await inject("POST", "/api/builder/strategies", { spec })).json().id}`;
    await inject("PUT", "/api/preferences?venue=DELTA", { strategies: [sid], instrumentKeys: ["DELTA:ETHUSD"], autoPaper: true });
    // limits too small: 1 contract's stop risk (₹3000 × 0.01 = ₹30) > remaining max loss ₹10 → rejected
    expect((await inject("POST", "/api/session/start?venue=DELTA", { capitalInr: 300000, maxLossInr: 10, maxProfitInr: null, riskPerTradePct: 1 })).statusCode).toBe(200);
    ctx.engines.DELTA.status.running = true; await ctx.engines.DELTA.tick();
    expect(await prisma.paperTrade.count({ where: { underlying: "ETHUSD" } })).toBe(0);
    // user raises the limits → within 10 min nothing (throttled), after 10 min the SAME signal is retried and traded
    await inject("POST", "/api/session/limits?venue=DELTA", { capitalInr: 300000, maxLossInr: 9000, maxProfitInr: null, riskPerTradePct: 1 });
    now = new Date(now.getTime() + 5 * 60000); await ctx.engines.DELTA.tick();
    expect(await prisma.paperTrade.count({ where: { underlying: "ETHUSD" } })).toBe(0);
    now = new Date(now.getTime() + 6 * 60000); await ctx.engines.DELTA.tick(); ctx.engines.DELTA.stop();
    const t = await prisma.paperTrade.findFirstOrThrow({ where: { underlying: "ETHUSD" } });
    expect(t.correlationId.startsWith(sid)).toBe(true); expect(t.quantity).toBe(5);   // fixed 5 contracts, risk fits
    expect(await prisma.signal.count({ where: { strategyId: "Daily retry test (custom)" } })).toBe(1);  // one signal, retried — no duplicates
  });
});
