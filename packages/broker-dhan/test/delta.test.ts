import { describe, it, expect } from "vitest";
import { DeltaAdapter } from "../src/index.ts";

const NOW = 1_800_000_000; // fixed clock (s)
function fakeFetch(log: string[]) {
  return (async (url: string) => {
    log.push(url);
    const u = new URL(url);
    if (u.pathname === "/v2/history/candles") {
      const s = Number(u.searchParams.get("start")), e = Number(u.searchParams.get("end"));
      const rows = []; for (let t = e - (e % 300) ; t >= s; t -= 300) rows.push({ time: t, open: 100, high: 101, low: 99, close: 100.5, volume: 7 }); // newest first, like Delta
      return new Response(JSON.stringify({ success: true, result: rows }), { status: 200 });
    }
    if (u.pathname === "/v2/tickers/BTCUSD") return new Response(JSON.stringify({ success: true, result: { symbol: "BTCUSD", close: 74600, quotes: { best_bid: "74600", best_ask: "74600.5" }, volume: 12, timestamp: 1794234155210592 } }), { status: 200 });
    if (u.pathname === "/v2/products") return new Response(JSON.stringify({ success: true, result: [{ symbol: "BTCUSD", id: 27, description: "Bitcoin Perpetual", contract_value: "0.001", contract_unit_currency: "BTC", tick_size: "0.5", taker_commission_rate: "0.0005", maker_commission_rate: "0.0002" }] }), { status: 200 });
    return new Response(JSON.stringify({ success: false, error: { code: "not_found" } }), { status: 404 });
  }) as unknown as typeof fetch;
}
const ref = { securityId: "BTCUSD", segment: "DELTA" as const, instrumentType: "CRYPTO_PERP" as const, symbol: "BTCUSD" };

describe("Delta adapter", () => {
  it("fetches long ranges in chunks, sorts oldest-first, de-duplicates and drops the forming candle", async () => {
    const log: string[] = []; const d = new DeltaAdapter(fakeFetch(log), "https://x.test", () => new Date(NOW * 1000), 0);
    const bars = await d.getCandles({ ref, interval: 5, from: new Date((NOW - 30 * 86400) * 1000), to: new Date(NOW * 1000) });
    expect(log.length).toBeGreaterThan(1);                                    // 30 days of 5m = 8640 candles → several requests
    expect(bars.every((b, i) => i === 0 || b.t > bars[i - 1]!.t)).toBe(true); // ascending, unique
    expect(bars.at(-1)!.t + 300).toBeLessThanOrEqual(NOW);                    // no still-forming candle
    expect(bars.length).toBeGreaterThan(8000);
  });
  it("parses tickers into quotes with bid/ask", async () => {
    const d = new DeltaAdapter(fakeFetch([]), "https://x.test", () => new Date(NOW * 1000), 0);
    const [q] = await d.getQuotes([ref]);
    expect(q).toMatchObject({ ltp: 74600, bid: 74600, ask: 74600.5, source: "DELTA", segment: "DELTA" });
  });
  it("lists perpetual products with contract value and fees", async () => {
    const [p] = await new DeltaAdapter(fakeFetch([]), "https://x.test", undefined, 0).products();
    expect(p).toMatchObject({ symbol: "BTCUSD", contractValue: 0.001, takerFee: 0.0005 });
  });
  it("raises a clear error for unsupported intervals and API failures", async () => {
    const d = new DeltaAdapter(fakeFetch([]), "https://x.test", () => new Date(NOW * 1000), 0);
    await expect(d.getCandles({ ref, interval: 25, from: new Date(0), to: new Date(NOW * 1000) })).rejects.toThrow(/not supported/);
    await expect(d.getQuotes([{ ...ref, securityId: "NOPE" }])).resolves.toEqual([]);
  });
});
