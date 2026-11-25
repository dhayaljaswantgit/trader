import { describe, expect, it } from "vitest";
import { DhanAdapter } from "../src/index.ts";

describe("Dhan live orders", () => {
  it("places a LIMIT order with Dhan's field names and reads the fill", async () => {
    const calls: { method: string; path: string; body: any }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname; calls.push({ method: String(init.method), path, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (path === "/v2/orders") return new Response(JSON.stringify({ orderId: "112111182198", orderStatus: "PENDING" }), { status: 200 });
      return new Response(JSON.stringify({ orderId: "112111182198", orderStatus: "TRADED", filledQty: 65, averageTradedPrice: 101.5 }), { status: 200 });
    }) as unknown as typeof fetch;
    const d = new DhanAdapter(() => ({ clientId: "1000000001", accessToken: "t" }), f);
    const id = await d.placeOrder({ tag: "abc|OPTIONS", side: "BUY", segment: "NSE_FNO", securityId: "35001", quantity: 65, product: "INTRADAY", price: 101.6 });
    expect(id).toBe("112111182198");
    expect(calls[0]).toMatchObject({ method: "POST", path: "/v2/orders", body: { dhanClientId: "1000000001", correlationId: "abcOPTIONS", transactionType: "BUY", exchangeSegment: "NSE_FNO",
      productType: "INTRADAY", orderType: "LIMIT", validity: "DAY", securityId: "35001", quantity: 65, price: 101.6 } });
    expect(await d.getOrder(id)).toMatchObject({ status: "TRADED", filledQty: 65, avgPrice: 101.5 });
    expect(calls[1]).toMatchObject({ method: "GET", path: "/v2/orders/112111182198", body: undefined });
  });
});
