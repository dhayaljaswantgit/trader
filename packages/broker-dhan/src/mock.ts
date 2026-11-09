import type { Bar } from "@dat/quant";
import type { BrokerHealth, CandleQuery, IBrokerAdapter, InstrumentRef, LiveQuote, OptionChain } from "./index.ts";

/**
 * Deterministic synthetic market. Same symbol+day always produces the same bars, so live quotes,
 * charts and backtests agree. PRICES ARE NOT REAL. Base levels are illustrative only.
 */
const BASE: Record<string, number> = { "13": 25000, "25": 55000, "51": 82000, "1333": 1000, "1922": 2000, "10666": 110, "4668": 250, "2885": 1400, "18143": 300, "15355": 400, "24184": 3500, "1997": 600, "14552": 1600 };
const hash = (s: string) => { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const rng = (seed: number) => () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());
const SESSION_START = 555, SESSION_MIN = 375; // 09:15 IST, 375 minutes
const dayIndex = (t: number) => Math.floor((t + 19800) / 86400);
const isWeekday = (d: number) => { const w = (d + 4) % 7; return w !== 0 && w !== 6; }; // 1970-01-01 was Thursday
const round = (x: number, tick: number) => Number((Math.round(x / tick) * tick).toFixed(2));

export class MockBrokerAdapter implements IBrokerAdapter {
  readonly source = "MOCK" as const;
  private dayCache = new Map<string, Bar[]>();
  private closeCache = new Map<string, number>();
  constructor(private clock: () => Date = () => new Date()) {}

  private basePrice(id: string) { return BASE[id] ?? 100 + (hash(id) % 2000); }
  /** Previous close via a daily random walk anchored at an epoch day (deterministic). */
  private dayOpen(id: string, d: number): number {
    const key = `${id}:${d}`; const c = this.closeCache.get(key); if (c) return c;
    // Walk from anchor in yearly blocks to keep it cheap: log-price = base * exp(sum of daily shocks)
    const anchor = 20393; /* 2025-11-01: mock levels ≈ BASE near today */ let lp = Math.log(this.basePrice(id));
    const r = rng(hash(id)); const drift = (r() - 0.45) * 0.0004; // per-instrument drift
    // deterministic per-day shock depends only on (id, day)
    let s = 0; for (let k = Math.min(anchor, d); k < Math.max(anchor, d); k++) { const g = gauss(rng(hash(`${id}|${k}`))) * 0.012 + drift; s += d >= anchor ? g : -g; }
    lp += s; const v = Math.exp(lp); this.closeCache.set(key, v); return v;
  }
  /** Full 1-minute session for an IST day. */
  private session(id: string, d: number): Bar[] {
    const key = `${id}:${d}`; const hit = this.dayCache.get(key); if (hit) return hit;
    const r = rng(hash(`${id}#${d}`)); let p = this.dayOpen(id, d) * (1 + gauss(r) * 0.004);
    const isIdx = ["13", "25", "51"].includes(id), tick = 0.05, out: Bar[] = [];
    const trend = gauss(r) * 0.00012, vol = 0.0009 * (0.6 + r()), dayVol = Math.exp(gauss(r) * 0.45) * (1 + Math.abs(trend) * 4000);
    for (let m = 0; m < SESSION_MIN; m++) {
      const o = p; const ret = trend + gauss(r) * vol; p = Math.max(tick, p * (1 + ret));
      const h = Math.max(o, p) * (1 + Math.abs(gauss(r)) * vol * 0.4), l = Math.min(o, p) * (1 - Math.abs(gauss(r)) * vol * 0.4);
      const u = m / SESSION_MIN, smile = 1.8 - 3.2 * u * (1 - u);
      out.push({ t: d * 86400 - 19800 + (SESSION_START + m) * 60, o: round(o, tick), h: round(h, tick), l: round(l, tick), c: round(p, tick),
        v: isIdx ? 0 : Math.floor((5000 + r() * 20000) * smile * dayVol * (1 + Math.abs(ret) / vol)) });
    }
    if (this.dayCache.size > 4000) this.dayCache.clear();
    this.dayCache.set(key, out); return out;
  }
  private nowS() { return Math.floor(this.clock().getTime() / 1000); }

  async healthCheck(): Promise<BrokerHealth> { return { connected: true, source: "MOCK", detail: "Synthetic market (no broker). Prices are NOT real.", checkedAt: this.clock().toISOString() }; }

  async getCandles(q: CandleQuery): Promise<Bar[]> {
    const id = q.ref.securityId, now = this.nowS();
    const d0 = dayIndex(q.from.getTime() / 1000), d1 = dayIndex(Math.min(q.to.getTime() / 1000, now));
    const out: Bar[] = [];
    for (let d = d0; d <= d1; d++) {
      if (!isWeekday(d)) continue;
      if (q.interval === "D") {
        const s = this.session(id, d).filter(b => b.t + 60 <= now); if (!s.length) continue;
        out.push({ t: d * 86400 - 19800, o: s[0]!.o, h: Math.max(...s.map(b => b.h)), l: Math.min(...s.map(b => b.l)), c: s[s.length - 1]!.c, v: s.reduce((a, b) => a + b.v, 0) });
      } else {
        const iv = q.interval; const s = this.session(id, d);
        for (let k = 0; k < s.length; k += iv) {
          const chunk = s.slice(k, k + iv).filter(b => b.t + 60 <= now); if (!chunk.length) break;
          out.push({ t: chunk[0]!.t, o: chunk[0]!.o, h: Math.max(...chunk.map(b => b.h)), l: Math.min(...chunk.map(b => b.l)), c: chunk[chunk.length - 1]!.c, v: chunk.reduce((a, b) => a + b.v, 0) });
        }
      }
    }
    return out.filter(b => b.t >= q.from.getTime() / 1000 - 86400 && b.t <= q.to.getTime() / 1000);
  }

  async getQuotes(refs: InstrumentRef[]): Promise<LiveQuote[]> {
    const now = this.nowS(), d = dayIndex(now), received = this.clock().toISOString();
    return refs.map(ref => {
      let day = d; while (!isWeekday(day) || !this.session(ref.securityId, day).some(b => b.t <= now)) day--;
      const s = this.session(ref.securityId, day).filter(b => b.t <= now), last = s[s.length - 1]!;
      const isIdx = ref.segment === "IDX_I", half = isIdx ? null : Math.max(0.05, round(last.c * 0.00025, 0.05));
      return { securityId: ref.securityId, segment: ref.segment, ltp: last.c, bid: half ? round(last.c - half, 0.05) : null, ask: half ? round(last.c + half, 0.05) : null,
        volume: isIdx ? null : s.reduce((a, b) => a + b.v, 0), open: s[0]!.o, high: Math.max(...s.map(b => b.h)), low: Math.min(...s.map(b => b.l)),
        prevClose: null, oi: null, sourceTs: new Date(Math.min(now, last.t + 59) * 1000).toISOString(), receivedTs: received, source: "MOCK" as const };
    });
  }

  async getExpiries(_u: InstrumentRef): Promise<string[]> {
    const out: string[] = []; const t = this.clock();
    for (let k = 0; out.length < 4 && k < 60; k++) { const d = new Date(t.getTime() + k * 86400000); if (d.getUTCDay() === 2) out.push(d.toISOString().slice(0, 10)); }
    return out;
  }

  /** Black-Scholes synthetic chain, clearly labelled MOCK. */
  async getOptionChain(u: InstrumentRef, expiry: string): Promise<OptionChain> {
    const [q] = await this.getQuotes([u]); const S = q!.ltp;
    const step = S > 40000 ? 100 : S > 10000 ? 50 : S > 2000 ? 20 : S > 500 ? 10 : S > 100 ? 2.5 : 1;
    const T = Math.max((Date.parse(expiry + "T10:00:00Z") - this.clock().getTime()) / (365 * 86400000), 0.5 / 365);
    const atm = Math.round(S / step) * step, strikes = [];
    for (let k = -10; k <= 10; k++) {
      const K = atm + k * step, iv = 0.14 + Math.abs(k) * 0.004;
      const leg = (call: boolean) => {
        const p = bs(S, K, T, iv, call); const sp = Math.max(0.05, round(p.price * 0.004, 0.05));
        return { securityId: null, ltp: round(p.price, 0.05), bid: round(Math.max(0.05, p.price - sp), 0.05), ask: round(p.price + sp, 0.05), volume: Math.floor(1e5 / (1 + k * k)), oi: Math.floor(5e5 / (1 + Math.abs(k))),
          iv: iv * 100, delta: p.delta, theta: p.theta, gamma: p.gamma, vega: p.vega };
      };
      strikes.push({ strike: K, ce: leg(true), pe: leg(false) });
    }
    return { underlying: u, expiry, spot: S, strikes, source: "MOCK", fetchedAt: this.clock().toISOString() };
  }
}

function cnd(x: number) { const a = [0.31938153, -0.356563782, 1.781477937, -1.821255978, 1.330274429], k = 1 / (1 + 0.2316419 * Math.abs(x));
  const w = 1 - (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-x * x / 2) * k * (a[0]! + k * (a[1]! + k * (a[2]! + k * (a[3]! + k * a[4]!)))); return x < 0 ? 1 - w : w; }
function bs(S: number, K: number, T: number, v: number, call: boolean) {
  const r = 0.065, d1 = (Math.log(S / K) + (r + v * v / 2) * T) / (v * Math.sqrt(T)), d2 = d1 - v * Math.sqrt(T), pdf = Math.exp(-d1 * d1 / 2) / Math.sqrt(2 * Math.PI);
  const price = call ? S * cnd(d1) - K * Math.exp(-r * T) * cnd(d2) : K * Math.exp(-r * T) * cnd(-d2) - S * cnd(-d1);
  return { price: Math.max(price, 0.05), delta: call ? cnd(d1) : cnd(d1) - 1, gamma: pdf / (S * v * Math.sqrt(T)), vega: S * pdf * Math.sqrt(T) / 100,
    theta: (-(S * pdf * v) / (2 * Math.sqrt(T)) - (call ? 1 : -1) * r * K * Math.exp(-r * T) * cnd(call ? d2 : -d2)) / 365 };
}
