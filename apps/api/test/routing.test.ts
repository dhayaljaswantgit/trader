import { describe, it, expect } from "vitest";
import { BrokerHolder } from "../src/broker.ts";

describe("parallel data routing (Dhan/Mock + Delta)", () => {
  it("DELTA instruments go to Delta, NSE instruments to the active broker — at the same time", async () => {
    const h = new BrokerHolder(() => new Date("2026-11-09T05:00:00Z"), "MOCK");
    const calls: string[] = [];
    h.delta.getCandles = async q => { calls.push(`delta:${q.ref.securityId}`); return [{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 1 }]; };
    h.delta.getQuotes = async refs => { calls.push(`deltaQ:${refs.map(r => r.securityId).join(",")}`); return refs.map(r => ({ securityId: r.securityId, segment: "DELTA" as const, ltp: 74600, bid: null, ask: null, volume: null, open: null, high: null, low: null, prevClose: null, oi: null, sourceTs: null, receivedTs: "", source: "DELTA" as const })); };
    const btc = { securityId: "BTCUSD", segment: "DELTA" as const, instrumentType: "CRYPTO_PERP" as const, symbol: "BTCUSD" };
    const nifty = { securityId: "13", segment: "IDX_I" as const, instrumentType: "INDEX" as const, symbol: "NIFTY" };
    await h.current.getCandles({ ref: btc, interval: 5, from: new Date(0), to: new Date() });
    const nb = await h.current.getCandles({ ref: nifty, interval: 5, from: new Date("2026-11-05"), to: new Date("2026-11-09T05:00:00Z") });
    expect(calls).toEqual(["delta:BTCUSD"]); expect(nb.length).toBeGreaterThan(0);          // NIFTY served by mock, not Delta
    const qs = await h.current.getQuotes([nifty, btc]);
    expect(qs.map(q => q.source).sort()).toEqual(["DELTA", "MOCK"]);
    expect(h.source).toBe("MOCK");                                                            // active NSE source unchanged
    h.use("DHAN"); expect(h.source).toBe("DHAN");
    await h.current.getCandles({ ref: btc, interval: 5, from: new Date(0), to: new Date() }); expect(calls.at(-1)).toBe("delta:BTCUSD"); // still Delta
  });
});
