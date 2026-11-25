import { describe, it, expect, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "../src/app.ts";
import { BrokerHolder, tokenInfo } from "../src/broker.ts";
import { DhanAuth } from "../src/dhanAuth.ts";

const prisma = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL ?? "postgresql://jassu@localhost:5432/dhan_trader_test" } } });
const jwt = (expSec: number) => `x.${Buffer.from(JSON.stringify({ exp: expSec })).toString("base64url")}.y`;
let NOW = Date.UTC(2026, 10, 11, 3, 0);
const calls: Array<{ url: string; headers: Record<string, string> }> = [];
const fakeDhan = (async (url: string, init?: RequestInit) => {
  calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
  const u = new URL(url);
  if (u.pathname === "/app/generate-consent") return new Response(JSON.stringify({ consentAppId: "C-123", consentAppStatus: "GENERATED", status: "success" }));
  if (u.pathname === "/app/consumeApp-consent") return u.searchParams.get("tokenId") === "TOK-1"
    ? new Response(JSON.stringify({ dhanClientId: "1100123456", dhanClientName: "Jassu", accessToken: jwt(NOW / 1000 + 86400), expiryTime: "2026-11-12T08:30:00" }))
    : new Response(JSON.stringify({ errorCode: "INVALID" }), { status: 400 });
  if (u.pathname === "/v2/RenewToken") return new Response(JSON.stringify({ accessToken: jwt(NOW / 1000 + 2 * 86400) }));
  return new Response("{}", { status: 404 });
}) as unknown as typeof fetch;
let ctx: Awaited<ReturnType<typeof buildApp>>;
afterAll(async () => { ctx?.engines.DHAN.stop(); await ctx?.app.close(); await prisma.$disconnect(); });

describe("one-click Dhan login + auto-renew", () => {
  it("API key setup → Authorize → Dhan login redirect → token saved → back to app", async () => {
    ctx = await buildApp({ prisma, clock: () => new Date(NOW), broker: new BrokerHolder(() => new Date(NOW), "MOCK"), dhanAuth: new DhanAuth(fakeDhan, "https://auth.test", "https://api.test", () => NOW) });
    const inject = (method: "GET" | "POST" | "PUT", url: string, payload?: object) => ctx.app.inject({ method, url, payload });
    expect((await inject("POST", "/api/dhan/oauth/start")).statusCode).toBe(400);                    // not configured yet
    expect((await inject("PUT", "/api/settings/dhan-app", { clientId: "1100123456", apiKey: "KEY-abc", apiSecret: "SECRET-xyz" })).statusCode).toBe(200);
    const info = (await inject("GET", "/api/settings/dhan-app")).json();
    expect(info.configured).toBe(true); expect(JSON.stringify(info)).not.toContain("SECRET-xyz"); expect(JSON.stringify(info)).not.toContain("KEY-abc"); // never leaked
    const st = (await inject("POST", "/api/dhan/oauth/start")).json();
    expect(st.url).toBe("https://auth.test/login/consentApp-login?consentAppId=C-123");
    expect(calls[0]!.headers).toMatchObject({ app_id: "KEY-abc", app_secret: "SECRET-xyz" });
    const cb = await inject("GET", "/api/dhan/oauth/callback?tokenId=TOK-1");
    expect(cb.statusCode).toBe(302); expect(cb.headers.location).toBe("/?dhan=connected");
    expect(tokenInfo()).toMatchObject({ configured: true }); expect(Date.parse(tokenInfo().expiresAt!)).toBe(NOW + 86400000);
    expect(ctx.broker.source).toBe("DHAN");                                                             // switched to live Dhan data
    // a callback we did not start is rejected (no pending consent)
    expect((await inject("GET", "/api/dhan/oauth/callback?tokenId=TOK-1")).headers.location).toMatch(/^\/\?dhan=error/);
  });
  it("auto-renew: only when the token is still valid and expires within 3 hours", async () => {
    const auth = new DhanAuth(fakeDhan, "https://auth.test", "https://api.test", () => NOW);
    expect(await auth.maybeRenew()).toBe(false);                   // 24h left → no renew yet
    NOW += 22 * 3600000;                                           // 2h left
    expect(await auth.maybeRenew()).toBe(true);
    expect(calls.at(-1)!.url).toBe("https://api.test/v2/RenewToken"); expect(calls.at(-1)!.headers["dhanClientId"]).toBe("1100123456");
    expect(Date.parse(tokenInfo().expiresAt!)).toBeGreaterThan(NOW + 24 * 3600000);
  });
});

import { DhanInstantLogin, totpCode } from "../src/dhanAuth.ts";
describe("instant one-click login (PIN + TOTP, no browser)", () => {
  it("saves setup (secrets never returned), logs in with the right TOTP, and auto-logs-in on expiry", async () => {
    const SECRET = "JBSWY3DPEHPK3PXP"; let sent: URL | null = null; let ok = true;
    const fake = (async (url: string, init?: RequestInit) => { sent = new URL(url);
      expect(init?.method).toBe("POST");
      return ok ? new Response(JSON.stringify({ dhanClientId: "1100999999", dhanClientName: "Jassu", accessToken: jwt(NOW / 1000 + 86400), expiryTime: "2026-11-12T09:00:00" }))
        : new Response(JSON.stringify({ errorMessage: "Invalid TOTP" }), { status: 401 }); }) as unknown as typeof fetch;
    const instant = new DhanInstantLogin(fake, "https://auth.test", () => NOW);
    const app2 = await buildApp({ prisma, clock: () => new Date(NOW), broker: new BrokerHolder(() => new Date(NOW), "MOCK"), dhanInstant: instant });
    const inject = (method: "GET" | "POST" | "PUT", url: string, payload?: object) => app2.app.inject({ method, url, payload });
    expect((await inject("PUT", "/api/settings/dhan-instant", { clientId: "1100999999", pin: "12", secret: SECRET })).statusCode).toBe(400);   // bad PIN
    expect((await inject("PUT", "/api/settings/dhan-instant", { clientId: "1100999999", pin: "123456", secret: "not-base32!" })).statusCode).toBe(400);
    expect((await inject("PUT", "/api/settings/dhan-instant", { clientId: "1100999999", pin: "123456", secret: SECRET })).statusCode).toBe(200);
    const info = JSON.stringify((await inject("GET", "/api/settings/dhan-instant")).json());
    expect(info).not.toContain("123456"); expect(info).not.toContain(SECRET);                                   // never leaked
    const r = await inject("POST", "/api/dhan/login"); expect(r.statusCode).toBe(200); expect(r.json().client).toBe("Jassu");
    expect(sent!.pathname).toBe("/app/generateAccessToken");
    expect(sent!.searchParams.get("totp")).toBe(totpCode(SECRET, NOW)); expect(sent!.searchParams.get("pin")).toBe("123456");
    expect(Date.parse(tokenInfo().expiresAt!)).toBe(NOW + 86400000); expect(app2.broker.source).toBe("DHAN");
    // auto-login: off by default → nothing; on + token expired → logs in again
    NOW += 25 * 3600000; expect(await instant.maybeAutoLogin()).toBe(false);
    expect((await inject("PUT", "/api/settings/dhan-instant", { autoLogin: true })).json().autoLogin).toBe(true);
    expect(await instant.maybeAutoLogin()).toBe(true); expect(Date.parse(tokenInfo().expiresAt!)).toBe(NOW + 86400000);
    // a wrong TOTP/PIN shows Dhan's message, and auto-login backs off for 10 min
    ok = false; NOW += 25 * 3600000;
    const bad = await inject("POST", "/api/dhan/login"); expect(bad.statusCode).toBe(400); expect(bad.json().message).toMatch(/Invalid TOTP/);
    expect(await instant.maybeAutoLogin()).toBe(false);
    app2.engines.DHAN.stop(); await app2.app.close();
  });
});
