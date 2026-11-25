import type { DeltaAdapter } from "@dat/broker-dhan";
import type { PrismaClient, Instrument } from "@prisma/client";
import { MASTER_URL, parseMaster, type InstrumentRef, type Segment, type InstrumentType } from "@dat/broker-dhan";

/** Verified from Dhan master on 2026-11-09 — used only as an offline fallback until the full sync completes. */
const SEED: Array<[string, Segment, InstrumentType, string, string]> = [
  ["13", "IDX_I", "INDEX", "NIFTY", "Nifty 50"], ["25", "IDX_I", "INDEX", "BANKNIFTY", "Nifty Bank"], ["51", "IDX_I", "INDEX", "SENSEX", "Sensex"],
  ["1333", "NSE_EQ", "EQUITY", "HDFCBANK", "HDFC Bank"], ["1922", "NSE_EQ", "EQUITY", "KOTAKBANK", "Kotak Bank"], ["10666", "NSE_EQ", "EQUITY", "PNB", "Punjab National Bank"],
  ["4668", "NSE_EQ", "EQUITY", "BANKBARODA", "Bank of Baroda"], ["2885", "NSE_EQ", "EQUITY", "RELIANCE", "Reliance Industries"], ["18143", "NSE_EQ", "EQUITY", "JIOFIN", "Jio Financial Services"],
  ["15355", "NSE_EQ", "EQUITY", "RECLTD", "REC"], ["24184", "NSE_EQ", "EQUITY", "PIIND", "PI Industries"], ["1997", "NSE_EQ", "EQUITY", "LICHSGFIN", "LIC Housing Finance"], ["14552", "NSE_EQ", "EQUITY", "PHOENIXLTD", "Phoenix Mills"],
];
export const DEFAULT_KEYS = SEED.map(([id, seg]) => `${seg}:${id}`);
export const keyOf = (segment: string, securityId: string) => `${segment}:${securityId}`;
export const refOf = (i: Pick<Instrument, "securityId" | "segment" | "instrumentType" | "symbol">): InstrumentRef =>
  ({ securityId: i.securityId, segment: i.segment as Segment, instrumentType: i.instrumentType as InstrumentType, symbol: i.symbol });

export async function seedInstruments(prisma: PrismaClient) {
  if (await prisma.instrument.count()) return;
  await prisma.instrument.createMany({ data: SEED.map(([securityId, segment, instrumentType, symbol, name]) => ({
    key: keyOf(segment, securityId), securityId, segment, instrumentType, symbol, name, lotSize: 1, tickSize: 0.05, source: "SEED", fnoEligible: true })) });
}

export const syncState = { running: false, lastSync: null as string | null, count: 0, error: null as string | null };

export async function syncInstruments(prisma: PrismaClient, fetchFn: typeof fetch = fetch) {
  if (syncState.running) return syncState;
  syncState.running = true; syncState.error = null;
  try {
    const r = await fetchFn(MASTER_URL); if (!r.ok) throw new Error(`Master download failed: HTTP ${r.status}`);
    const rows = parseMaster(await r.text()).filter(x => !isTestScrip(x.symbol, x.name)); const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
    const futs = rows.filter(x => x.instrumentType !== "INDEX" && x.instrumentType !== "EQUITY" && x.expiry! >= today);
    const nearestLot = new Map<string, { lot: number; exp: string }>();
    for (const f of futs) { const k = f.instrumentType === "FUTIDX" ? `S:${f.underlyingSymbol}` : `I:${f.underlyingSecurityId}`; const cur = nearestLot.get(k); if (!cur || f.expiry! < cur.exp) nearestLot.set(k, { lot: f.lotSize, exp: f.expiry! }); }
    const data = rows.filter(x => x.instrumentType === "INDEX" || x.instrumentType === "EQUITY" || x.expiry! >= today).map(x => {
      const fl = x.instrumentType === "EQUITY" ? nearestLot.get(`I:${x.securityId}`) : x.instrumentType === "INDEX" ? nearestLot.get(`S:${x.symbol}`) : undefined;
      return { key: keyOf(x.segment, x.securityId), securityId: x.securityId, segment: x.segment, instrumentType: x.instrumentType, symbol: x.symbol, name: x.name,
        lotSize: x.lotSize, tickSize: x.tickSize, expiry: x.expiry, underlyingSecurityId: x.underlyingSecurityId, underlyingSymbol: x.underlyingSymbol,
        fnoEligible: !!fl, fnoLotSize: fl?.lot ?? null, source: "DHAN_MASTER" };
    });
    await prisma.$transaction(async tx => { await tx.instrument.deleteMany({}); await tx.instrument.createMany({ data }); }, { timeout: 120000 });
    syncState.count = data.length; syncState.lastSync = new Date().toISOString();
  } catch (e) { syncState.error = (e as Error).message; }
  finally { syncState.running = false; }
  return syncState;
}

/** Nearest non-expired future for an underlying (index matched by symbol; stocks by underlying security id). */
export async function nearestFuture(prisma: PrismaClient, u: Instrument, todayIst: string) {
  return prisma.instrument.findFirst({
    where: u.instrumentType === "INDEX" ? { instrumentType: "FUTIDX", underlyingSymbol: u.symbol, expiry: { gte: todayIst } }
      : { instrumentType: "FUTSTK", underlyingSecurityId: u.securityId, expiry: { gte: todayIst } },
    orderBy: { expiry: "asc" },
  });
}

/** Exchange mock/test scrips (e.g. "011NSETEST") must never be tradable. */
export const isTestScrip = (symbol: string, name = "") => /(NSE|BSE)TEST/i.test(symbol) || /(NSE|BSE)TEST/i.test(name);

const NIFTY50_URL = "https://www.niftyindices.com/IndexConstituent/ind_nifty50list.csv";
let n50Cache: { at: number; symbols: string[] } | null = null;
/** Current NIFTY 50 constituents from NSE Indices (official CSV), cached for 12h. Never hard-coded. */
export async function nifty50Symbols(fetchFn: typeof fetch = fetch): Promise<string[]> {
  if (n50Cache && Date.now() - n50Cache.at < 12 * 3600_000) return n50Cache.symbols;
  const r = await fetchFn(NIFTY50_URL, { headers: { "User-Agent": "Mozilla/5.0 (local dhan-ai-trader)" } });
  if (!r.ok) throw new Error(`NIFTY 50 list download failed: HTTP ${r.status}`);
  const lines = (await r.text()).trim().split(/\r?\n/); const head = lines[0]!.split(","); const si = head.indexOf("Symbol");
  if (si < 0) throw new Error("NIFTY 50 list format changed (no Symbol column)");
  const symbols = lines.slice(1).map(l => l.split(",")[si]!.trim()).filter(Boolean);
  n50Cache = { at: Date.now(), symbols }; return symbols;
}

/** Delta Exchange perpetual futures → instrument list (key DELTA:<symbol>). Prices are USD; contractValue = units per contract. */
export const deltaSyncState = { running: false, lastSync: null as string | null, count: 0, error: null as string | null };
export async function syncDeltaInstruments(prisma: PrismaClient, delta: DeltaAdapter) {
  if (deltaSyncState.running) return deltaSyncState;
  deltaSyncState.running = true; deltaSyncState.error = null;
  try {
    const ps = await delta.products();
    for (const p of ps) {
      const data = { securityId: p.symbol, segment: "DELTA", instrumentType: "CRYPTO_PERP", symbol: p.symbol, name: `${p.description} (Delta)`, lotSize: 1,
        tickSize: p.tickSize, contractValue: p.contractValue, takerFee: p.takerFee, fnoEligible: false, source: "DELTA" };
      await prisma.instrument.upsert({ where: { key: `DELTA:${p.symbol}` }, update: data, create: { key: `DELTA:${p.symbol}`, ...data } });
    }
    deltaSyncState.count = ps.length; deltaSyncState.lastSync = new Date().toISOString();
  } catch (e) { deltaSyncState.error = (e as Error).message; }
  finally { deltaSyncState.running = false; }
  return deltaSyncState;
}
