/**
 * Delta Exchange India — public market-data adapter (no API key needed).
 * Perpetual futures list, historical candles (chunked: max ~4000 candles per request) and live tickers.
 * Prices are in USD. Order placement is NOT implemented here (phase 2 = testnet paper trading with API keys).
 */
import type { Bar } from "@dat/quant";
import { BrokerError, type CandleQuery, type InstrumentRef, type LiveQuote, type BrokerHealth } from "./index.ts";

export const DELTA_BASE = "https://api.india.delta.exchange";
const RES: Record<string, string> = { "1": "1m", "5": "5m", "15": "15m", "60": "1h", D: "1d" };
const SEC: Record<string, number> = { "1": 60, "5": 300, "15": 900, "60": 3600, D: 86400 };
const MAX_PER_REQ = 3900; // Delta returns at most ~4000 candles per call

export interface DeltaProduct { symbol: string; id: number; description: string; contractValue: number; contractUnit: string; tickSize: number; takerFee: number; makerFee: number }

export class DeltaAdapter {
  readonly source = "DELTA" as const;
  private lastCall = 0;
  constructor(private fetchFn: typeof fetch = fetch, private base = process.env.DELTA_BASE ?? DELTA_BASE, private clock: () => Date = () => new Date(), private minGapMs = 150) {}

  private async get<T>(path: string): Promise<T> {
    const wait = this.lastCall + this.minGapMs - Date.now(); if (wait > 0) await new Promise(r => setTimeout(r, wait));
    this.lastCall = Date.now();
    let res: Response;
    try { res = await this.fetchFn(this.base + path, { headers: { Accept: "application/json" } }); }
    catch (e) { throw new BrokerError(`Delta ${path} network error: ${(e as Error).message}`); }
    const j = await res.json().catch(() => null) as { success?: boolean; result?: T; error?: unknown } | null;
    if (!res.ok || !j?.success) throw new BrokerError(`Delta ${path} failed [${res.status}]: ${JSON.stringify(j?.error ?? j)}`, res.status);
    return j.result as T;
  }

  /** Live perpetual futures (BTCUSD, ETHUSD, …). */
  async products(): Promise<DeltaProduct[]> {
    const r = await this.get<Array<Record<string, any>>>("/v2/products?contract_types=perpetual_futures&states=live");
    return r.map(p => ({ symbol: p.symbol, id: p.id, description: p.description ?? p.symbol, contractValue: Number(p.contract_value), contractUnit: p.contract_unit_currency ?? "",
      tickSize: Number(p.tick_size), takerFee: Number(p.taker_commission_rate), makerFee: Number(p.maker_commission_rate) }));
  }

  /** Completed candles only (the still-forming candle is dropped), oldest first, de-duplicated. */
  async getCandles(q: CandleQuery): Promise<Bar[]> {
    const key = String(q.interval), res = RES[key], sec = SEC[key];
    if (!res || !sec) throw new BrokerError(`Delta: interval ${q.interval} not supported (use 1/5/15/60/D)`);
    const now = Math.floor(this.clock().getTime() / 1000), end = Math.min(Math.floor(q.to.getTime() / 1000), now);
    const out = new Map<number, Bar>();
    for (let s = Math.floor(q.from.getTime() / 1000); s < end; s += MAX_PER_REQ * sec) {
      const e = Math.min(s + MAX_PER_REQ * sec, end);
      const rows = await this.get<Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>>(`/v2/history/candles?resolution=${res}&symbol=${encodeURIComponent(q.ref.securityId)}&start=${s}&end=${e}`);
      for (const r of rows) if (r.time + sec <= now) out.set(r.time, { t: r.time, o: +r.open, h: +r.high, l: +r.low, c: +r.close, v: +(r.volume ?? 0) });
    }
    return [...out.values()].sort((a, b) => a.t - b.t);
  }

  async getQuotes(refs: InstrumentRef[]): Promise<LiveQuote[]> {
    const out: LiveQuote[] = [];
    for (const ref of refs) {
      try {
        const t = await this.get<Record<string, any>>(`/v2/tickers/${encodeURIComponent(ref.securityId)}`);
        const num = (v: unknown) => v == null || v === "" ? null : Number(v);
        out.push({ securityId: ref.securityId, segment: "DELTA", ltp: Number(t.close ?? t.mark_price), bid: num(t.quotes?.best_bid), ask: num(t.quotes?.best_ask), volume: num(t.volume),
          open: num(t.open), high: num(t.high), low: num(t.low), prevClose: null, oi: num(t.oi), sourceTs: t.timestamp ? new Date(Number(t.timestamp) / 1000).toISOString() : null,
          receivedTs: this.clock().toISOString(), source: "DELTA" });
      } catch { /* skip symbols that fail; caller sees them as missing */ }
    }
    return out;
  }

  async healthCheck(): Promise<BrokerHealth> {
    try { const q = await this.getQuotes([{ securityId: "BTCUSD", segment: "DELTA", instrumentType: "CRYPTO_PERP", symbol: "BTCUSD" }]);
      return { connected: q.length > 0, source: "DELTA", detail: q.length ? `BTCUSD ${q[0]!.ltp}` : "no ticker", checkedAt: this.clock().toISOString() }; }
    catch (e) { return { connected: false, source: "DELTA", detail: (e as Error).message, checkedAt: this.clock().toISOString() }; }
  }
}
