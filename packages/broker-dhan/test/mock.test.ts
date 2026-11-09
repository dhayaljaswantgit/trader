import { describe, it, expect } from "vitest";
import { MockBrokerAdapter, DhanAdapter, parseMaster, type InstrumentRef } from "../src/index.ts";

const clock = () => new Date("2026-11-09T07:00:00Z"); // Mon 12:30 IST
const HDFC: InstrumentRef = { securityId: "1333", segment: "NSE_EQ", instrumentType: "EQUITY", symbol: "HDFCBANK" };

describe("MockBrokerAdapter", () => {
  it("is deterministic and candles never include future bars", async () => {
    const a = new MockBrokerAdapter(clock), b = new MockBrokerAdapter(clock);
    const q = { ref: HDFC, interval: 5 as const, from: new Date("2026-11-09T00:00:00Z"), to: new Date("2026-11-09T12:00:00Z") };
    const ca = await a.getCandles(q); expect(ca).toEqual(await b.getCandles(q));
    expect(ca.length).toBe(39); // 09:15..12:30 = 195 min -> 39 complete 5m bars
    for (const x of ca) expect(x.t + 300).toBeLessThanOrEqual(clock().getTime() / 1000);
  });
  it("quote ltp equals last 1m candle close", async () => {
    const m = new MockBrokerAdapter(clock);
    const [q] = await m.getQuotes([HDFC]);
    const c = await m.getCandles({ ref: HDFC, interval: 1, from: new Date("2026-11-09T00:00:00Z"), to: clock() });
    expect(Math.abs(q!.ltp - c[c.length - 1]!.c)).toBeLessThan(q!.ltp * 0.01);
    expect(q!.source).toBe("MOCK");
  });
  it("10 years of daily bars skip weekends", async () => {
    const m = new MockBrokerAdapter(clock);
    const d = await m.getCandles({ ref: HDFC, interval: "D", from: new Date("2016-11-09T00:00:00Z"), to: clock() });
    expect(d.length).toBeGreaterThan(2500); expect(d.length).toBeLessThan(2620);
  });
});

describe("DhanAdapter", () => {
  it("sends verified headers/body and parses quote", async () => {
    let seen: any;
    const fake = (async (url: string, init: any) => { seen = { url, init }; return new Response(JSON.stringify({ status: "success", data: { NSE_EQ: { "1333": { last_price: 990.5, volume: 10, depth: { buy: [{ price: 990.4 }], sell: [{ price: 990.6 }] }, ohlc: { open: 980 }, last_trade_time: "09/11/2026 12:29:59" } } } })); }) as unknown as typeof fetch;
    const d = new DhanAdapter(() => ({ clientId: "C", accessToken: "T" }), fake);
    const [q] = await d.getQuotes([HDFC]);
    expect(seen.url).toBe("https://api.dhan.co/v2/marketfeed/quote");
    expect(seen.init.headers).toMatchObject({ "access-token": "T", "client-id": "C" });
    expect(JSON.parse(seen.init.body)).toEqual({ NSE_EQ: [1333] });
    expect(q).toMatchObject({ ltp: 990.5, bid: 990.4, ask: 990.6, sourceTs: "2026-11-09T06:59:59.000Z" });
  });
  it("missing credentials => clear error; token never serialized", async () => {
    const d = new DhanAdapter(() => ({ clientId: "", accessToken: "" }));
    await expect(d.getQuotes([HDFC])).rejects.toThrow(/credentials/);
    expect(JSON.stringify(new DhanAdapter(() => ({ clientId: "x", accessToken: "SECRET" })))).not.toContain("SECRET");
  });
});

describe("parseMaster", () => {
  it("keeps indices, EQ equities and futures; drops options", () => {
    const csv = [
      "EXCH_ID,SEGMENT,SECURITY_ID,ISIN,INSTRUMENT,UNDERLYING_SECURITY_ID,UNDERLYING_SYMBOL,SYMBOL_NAME,DISPLAY_NAME,INSTRUMENT_TYPE,SERIES,LOT_SIZE,SM_EXPIRY_DATE,STRIKE_PRICE,OPTION_TYPE,TICK_SIZE,EXPIRY_FLAG",
      "NSE,I,13,NA,INDEX,13,NIFTY,NIFTY,Nifty 50,INDEX,NA,1.0,0001-01-01,,XX,0.0500,N",
      "NSE,E,1333,INE040A01034,EQUITY,,HDFCBANK,HDFC BANK LTD,HDFC Bank,ES,EQ,1.0,0001-01-01,,XX,0.1000,N",
      "NSE,D,5,NA,FUTSTK,1333,HDFCBANK,HDFCBANK-Nov2026-FUT,HDFCBANK NOV FUT,FUT,NA,550.0,2026-11-25,,XX,0.1000,M",
      "NSE,D,6,NA,OPTSTK,1333,HDFCBANK,X,HDFCBANK 1000 CE,OP,NA,550.0,2026-11-25,1000,CE,0.0500,M",
    ].join("\n");
    const r = parseMaster(csv);
    expect(r.map(x => x.instrumentType)).toEqual(["INDEX", "EQUITY", "FUTSTK"]);
    expect(r[2]).toMatchObject({ lotSize: 550, expiry: "2026-11-25", underlyingSecurityId: "1333" });
  });
});
