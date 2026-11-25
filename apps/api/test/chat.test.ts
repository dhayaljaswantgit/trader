import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "../src/app.ts";
import { BrokerHolder } from "../src/broker.ts";
import { saveChatSettings } from "../src/chat.ts";

const prisma = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL ?? "postgresql://jassu@localhost:5432/dhan_trader_test" } } });
const now = new Date("2026-11-09T05:00:00Z");
let ctx: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => { process.env.NODE_ENV = "test"; delete process.env.ANTHROPIC_API_KEY; ctx = await buildApp({ prisma, clock: () => now, broker: new BrokerHolder(() => now, "MOCK") }); });
afterAll(async () => { ctx.engines.DHAN.stop(); ctx.engines.DELTA.stop(); await ctx.app.close(); await prisma.$disconnect(); });

describe("market chat (read-only)", () => {
  it("snapshot carries spot, candles, option chain with OI/straddle/PCR and positions", async () => {
    const r = await ctx.app.inject({ method: "GET", url: "/api/chat/snapshot?q=nifty CE ya PE" });
    expect(r.statusCode).toBe(200);
    const s = r.json();
    expect(s.underlying.symbol).toBe("NIFTY");
    expect(s.spot.ltp).toBeGreaterThan(0);
    expect(s.candles5m.length).toBeGreaterThan(0);
    expect(s.optionChain.strikes.length).toBeGreaterThan(5);
    expect(s.optionChain.atmStraddle).toBeGreaterThan(0);
    expect(s.optionChain.totals.pcr).not.toBeNull();
    expect(s.position.mode).toMatch(/PAPER/);
  });
  it("refuses to chat without a key, and never exposes the key", async () => {
    saveChatSettings({ apiKey: "", provider: "api" });
    const r = await ctx.app.inject({ method: "POST", url: "/api/chat", payload: { question: "CE ya PE?" } });
    expect(r.statusCode).toBe(400); expect(r.json().error).toBe("NO_KEY");
    const put = await ctx.app.inject({ method: "PUT", url: "/api/settings/chat", payload: { apiKey: "sk-ant-test-1234567890abcd", model: "claude-haiku-5-5" } });
    expect(put.json().keyMasked).toBe("sk-ant-…abcd"); expect(JSON.stringify(put.json())).not.toContain("1234567890");
    expect(put.json().model).toBe("claude-haiku-5-5");
    expect(ctx.app.inject).toBeDefined(); saveChatSettings({ apiKey: "", provider: "local" });
  });
});
