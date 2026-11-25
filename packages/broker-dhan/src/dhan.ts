import type { Bar } from "@dat/quant";
import { BrokerError, type BrokerHealth, type CandleQuery, type IBrokerAdapter, type InstrumentRef, type LiveQuote, type OptionChain, type OptionLeg } from "./index.ts";

/**
 * DhanHQ v2 DATA adapter. Endpoints verified against https://dhanhq.co/docs/v2/ on 2026-11-09:
 *   POST /v2/marketfeed/quote            (1 req/s, ≤1000 instruments)
 *   POST /v2/charts/historical            (daily, from inception, toDate exclusive)
 *   POST /v2/charts/intraday              (1/5/15/25/60m, last 5 years, ≤90 days per call)
 *   POST /v2/optionchain, /v2/optionchain/expirylist  (1 unique req / 3 s)
 * Requires the Dhan "Data APIs" subscription. Headers: access-token, client-id.
 * Orders: POST /v2/orders, GET /v2/orders/{id}, DELETE /v2/orders/{id} — used ONLY when LIVE trading is switched on.
 */
const BASE = "https://api.dhan.co/v2";

/** Shared back-off: after a 429 every Dhan call waits until the cool-down ends. */
const backoff = { until: 0, level: 0 };
class Throttle {
  private last = 0; private chain: Promise<unknown> = Promise.resolve();
  constructor(private gapMs: number) {}
  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(async () => {
      const w = Math.max(this.last + this.gapMs, backoff.until) - Date.now(); if (w > 0) await new Promise(r => setTimeout(r, w));
      this.last = Date.now(); return fn(); });
    this.chain = p.catch(() => undefined); return p;
  }
}

const istStamp = (d: Date) => { const s = new Date(d.getTime() + 19800000).toISOString(); return `${s.slice(0, 10)} ${s.slice(11, 19)}`; };
const istDate = (d: Date) => new Date(d.getTime() + 19800000).toISOString().slice(0, 10);
/** "DD/MM/YYYY HH:mm:ss" IST -> ISO UTC */
const parseDhanTime = (s: unknown): string | null => {
  if (typeof s !== "string") return null; const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/); if (!m || m[3] === "1980") return null;
  return new Date(Date.UTC(+m[3]!, +m[2]! - 1, +m[1]!, +m[4]!, +m[5]!, +m[6]!) - 19800000).toISOString();
};
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v !== 0 ? v : null);

export type LiveOrder = { tag: string; side: "BUY" | "SELL"; segment: string; securityId: string; quantity: number; product: "INTRADAY" | "MARGIN" | "CNC"; price: number | null };
export type LiveOrderStatus = { orderId: string; status: string; filledQty: number; avgPrice: number | null; reason: string | null };

export class DhanAdapter implements IBrokerAdapter {
  readonly source = "DHAN" as const;
  private quoteT = new Throttle(1100);
  private chartT = new Throttle(400);
  private ocT = new Throttle(3100);
  constructor(private creds: () => { clientId: string; accessToken: string }, private fetchFn: typeof fetch = fetch) {}

  private post<T>(path: string, body: unknown): Promise<T> { return this.req<T>("POST", path, body); }
  private async req<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
    const { clientId, accessToken } = this.creds();
    if (!clientId || !accessToken) throw new BrokerError("Dhan credentials not configured (Settings → Dhan connection)", 401, "NO_CREDENTIALS");
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await this.fetchFn(BASE + path, { method, signal: ctrl.signal,
        headers: { "access-token": accessToken, "client-id": clientId, "Content-Type": "application/json", Accept: "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await r.text(); let j: any; try { j = JSON.parse(text); } catch { j = { raw: text.slice(0, 200) }; }
      if (r.status === 429) { backoff.level = Math.min(backoff.level + 1, 5); backoff.until = Date.now() + 2000 * 2 ** backoff.level; }
      else if (r.ok) backoff.level = Math.max(backoff.level - 1, 0);
      if (!r.ok || j?.status === "failure") {
        const code = j?.errorCode ?? j?.data?.errorCode ?? j?.remarks?.error_code ?? String(r.status);
        const msg = j?.errorMessage ?? j?.remarks?.error_message ?? j?.data?.errorMessage ?? j?.raw ?? r.statusText;
        throw new BrokerError(`Dhan ${path} failed [${code}]: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`, r.status, String(code));
      }
      this.lastOk = Date.now(); this.lastErr = null;
      return j as T;
    } catch (e) {
      this.lastErr = (e as Error).message;
      if ((e as Error).name === "AbortError") throw new BrokerError(`Dhan ${path} timed out`, 504, "TIMEOUT");
      throw e;
    } finally { clearTimeout(to); }
  }

  private orderT = new Throttle(250);
  /** Place a REAL order. Returns Dhan orderId. */
  async placeOrder(o: LiveOrder): Promise<string> {
    const { clientId } = this.creds();
    const j = await this.orderT.run(() => this.post<{ orderId?: string; orderStatus?: string }>("/orders", {
      dhanClientId: clientId, correlationId: o.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 25), transactionType: o.side, exchangeSegment: o.segment,
      productType: o.product, orderType: o.price == null ? "MARKET" : "LIMIT", validity: "DAY", securityId: o.securityId, quantity: o.quantity,
      price: o.price ?? 0, triggerPrice: 0, disclosedQuantity: 0, afterMarketOrder: false }));
    if (!j.orderId) throw new BrokerError(`Dhan order rejected: ${JSON.stringify(j).slice(0, 200)}`, 400, "ORDER_REJECTED");
    return String(j.orderId);
  }
  async getOrder(orderId: string): Promise<LiveOrderStatus> {
    const j = await this.orderT.run(() => this.req<any>("GET", `/orders/${encodeURIComponent(orderId)}`));
    const o = Array.isArray(j) ? j[0] : j?.data ?? j;
    return { orderId, status: String(o?.orderStatus ?? "UNKNOWN"), filledQty: Number(o?.filledQty ?? 0), avgPrice: Number(o?.averageTradedPrice ?? 0) || null,
      reason: o?.omsErrorDescription ?? o?.errorDescription ?? null };
  }
  async cancelOrder(orderId: string): Promise<void> { await this.orderT.run(() => this.req("DELETE", `/orders/${encodeURIComponent(orderId)}`)); }

  private lastOk = 0; private lastErr: string | null = null;
  async healthCheck(): Promise<BrokerHealth> {
    const checkedAt = new Date().toISOString();
    // Derive health from recent real traffic; only probe when nothing succeeded for 45 s (saves rate limit).
    if (Date.now() - this.lastOk < 45000) return { connected: true, source: "DHAN", detail: `Dhan Data API OK (last success ${Math.round((Date.now() - this.lastOk) / 1000)}s ago)${backoff.until > Date.now() ? " · rate-limit cool-down" : ""}`, checkedAt };
    try {
      await this.quoteT.run(() => this.post("/marketfeed/ltp", { IDX_I: [13] }));
      return { connected: true, source: "DHAN", detail: "Dhan Data API reachable (NIFTY LTP ok)", checkedAt };
    } catch (e) { return { connected: false, source: "DHAN", detail: (e as Error).message, checkedAt }; }
  }

  async getQuotes(refs: InstrumentRef[]): Promise<LiveQuote[]> {
    if (!refs.length) return [];
    const body: Record<string, number[]> = {};
    for (const r of refs.slice(0, 1000)) (body[r.segment] ??= []).push(Number(r.securityId));
    const call = () => this.quoteT.run(() => this.post<{ data: Record<string, Record<string, any>> }>("/marketfeed/quote", body));
    // a single slow Dhan response is common — retry once on timeout before reporting an error
    const j = await call().catch(e => (e as BrokerError).code === "TIMEOUT" ? call() : Promise.reject(e));
    const received = new Date().toISOString(), out: LiveQuote[] = [];
    for (const r of refs) {
      const q = j.data?.[r.segment]?.[r.securityId]; if (!q || typeof q.last_price !== "number") continue;
      out.push({ securityId: r.securityId, segment: r.segment, ltp: q.last_price, bid: num(q.depth?.buy?.[0]?.price), ask: num(q.depth?.sell?.[0]?.price),
        volume: typeof q.volume === "number" ? q.volume : null, open: num(q.ohlc?.open), high: num(q.ohlc?.high), low: num(q.ohlc?.low), prevClose: num(q.ohlc?.close),
        oi: num(q.oi), sourceTs: parseDhanTime(q.last_trade_time), receivedTs: received, source: "DHAN" });
    }
    return out;
  }

  async getCandles(q: CandleQuery): Promise<Bar[]> {
    const base = { securityId: q.ref.securityId, exchangeSegment: q.ref.segment, instrument: q.ref.instrumentType, oi: false };
    const toBars = (j: any): Bar[] => {
      const t: number[] = j?.timestamp ?? []; return t.map((ts, i) => ({ t: ts, o: j.open[i], h: j.high[i], l: j.low[i], c: j.close[i], v: j.volume?.[i] ?? 0 }));
    };
    if (q.interval === "D") {
      const to = new Date(q.to.getTime() + 86400000); // toDate is exclusive
      const j = await this.chartT.run(() => this.post<any>("/charts/historical", { ...base, expiryCode: 0, fromDate: istDate(q.from), toDate: istDate(to) }));
      return toBars(j);
    }
    const out: Bar[] = []; const fiveY = Date.now() - 5 * 365 * 86400000;
    let s = new Date(Math.max(q.from.getTime(), fiveY));
    while (s < q.to) {
      const e = new Date(Math.min(s.getTime() + 89 * 86400000, q.to.getTime()));
      const j = await this.chartT.run(() => this.post<any>("/charts/intraday", { ...base, interval: String(q.interval), fromDate: istStamp(s), toDate: istStamp(e) }));
      out.push(...toBars(j)); s = e;
    }
    const seen = new Set<number>(); return out.filter(b => !seen.has(b.t) && seen.add(b.t)).sort((a, b) => a.t - b.t);
  }

  async getExpiries(u: InstrumentRef): Promise<string[]> {
    const j = await this.ocT.run(() => this.post<{ data: string[] }>("/optionchain/expirylist", { UnderlyingScrip: Number(u.securityId), UnderlyingSeg: u.segment }));
    return j.data ?? [];
  }

  async getOptionChain(u: InstrumentRef, expiry: string): Promise<OptionChain> {
    const j = await this.ocT.run(() => this.post<any>("/optionchain", { UnderlyingScrip: Number(u.securityId), UnderlyingSeg: u.segment, Expiry: expiry }));
    const leg = (x: any): OptionLeg | null => !x ? null : ({
      securityId: x.security_id != null ? String(x.security_id) : null, ltp: num(x.last_price), bid: num(x.top_bid_price), ask: num(x.top_ask_price),
      volume: typeof x.volume === "number" ? x.volume : null, oi: typeof x.oi === "number" ? x.oi : null, iv: num(x.implied_volatility),
      delta: typeof x.greeks?.delta === "number" ? x.greeks.delta : null, theta: typeof x.greeks?.theta === "number" ? x.greeks.theta : null,
      gamma: typeof x.greeks?.gamma === "number" ? x.greeks.gamma : null, vega: typeof x.greeks?.vega === "number" ? x.greeks.vega : null });
    const strikes = Object.entries(j.data?.oc ?? {}).map(([k, v]: [string, any]) => ({ strike: Number(k), ce: leg(v.ce), pe: leg(v.pe) })).sort((a, b) => a.strike - b.strike);
    return { underlying: u, expiry, spot: j.data?.last_price ?? 0, strikes, source: "DHAN", fetchedAt: new Date().toISOString() };
  }
  toJSON() { return { source: this.source, credentials: "***redacted***" }; }
}
