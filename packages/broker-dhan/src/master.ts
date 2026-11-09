/**
 * Dhan instrument master (public CSV, no credentials needed):
 *   https://images.dhan.co/api-data/api-scrip-master-detailed.csv  (verified 2026-11-09)
 * We keep: NSE/BSE indices, NSE equities (series EQ), and NSE/BSE index+stock FUTURES.
 * Options are resolved at trade time from the option-chain API (security ids come from the broker,
 * never constructed by string guessing).
 */
export const MASTER_URL = "https://images.dhan.co/api-data/api-scrip-master-detailed.csv";

export interface MasterRow {
  securityId: string; segment: "IDX_I" | "NSE_EQ" | "NSE_FNO" | "BSE_FNO"; instrumentType: "INDEX" | "EQUITY" | "FUTIDX" | "FUTSTK";
  symbol: string; name: string; lotSize: number; tickSize: number; expiry: string | null; underlyingSecurityId: string | null; underlyingSymbol: string | null;
}

export function parseMaster(csv: string): MasterRow[] {
  const lines = csv.split(/\r?\n/); const head = lines[0]!.split(",");
  const ix = (n: string) => { const i = head.indexOf(n); if (i < 0) throw new Error(`Instrument master missing column ${n}`); return i; };
  const E = ix("EXCH_ID"), S = ix("SEGMENT"), ID = ix("SECURITY_ID"), INS = ix("INSTRUMENT"), US = ix("UNDERLYING_SECURITY_ID"), USYM = ix("UNDERLYING_SYMBOL"),
    SYM = ix("SYMBOL_NAME"), DN = ix("DISPLAY_NAME"), SER = ix("SERIES"), LOT = ix("LOT_SIZE"), EXP = ix("SM_EXPIRY_DATE"), TICK = ix("TICK_SIZE");
  const out: MasterRow[] = [];
  for (let k = 1; k < lines.length; k++) {
    const c = lines[k]!.split(","); if (c.length < head.length - 1) continue;
    const ex = c[E], seg = c[S], ins = c[INS];
    let segment: MasterRow["segment"] | null = null;
    if (seg === "I" && (ex === "NSE" || ex === "BSE") && ins === "INDEX") segment = "IDX_I";
    else if (ex === "NSE" && seg === "E" && ins === "EQUITY" && c[SER] === "EQ") segment = "NSE_EQ";
    else if (seg === "D" && (ins === "FUTIDX" || ins === "FUTSTK")) segment = ex === "NSE" ? "NSE_FNO" : ex === "BSE" ? "BSE_FNO" : null;
    if (!segment) continue;
    const isEq = segment === "NSE_EQ" || segment === "IDX_I";
    out.push({ securityId: c[ID]!, segment, instrumentType: ins as MasterRow["instrumentType"],
      symbol: isEq ? (segment === "IDX_I" ? c[USYM] || c[SYM]! : c[USYM] || c[SYM]!) : c[DN]!, name: isEq ? c[DN] || c[SYM]! : c[DN]!,
      lotSize: Math.round(Number(c[LOT]) || 1), tickSize: Number(c[TICK]) || 0.05, expiry: isEq ? null : c[EXP]!.slice(0, 10),
      underlyingSecurityId: c[US] || null, underlyingSymbol: c[USYM] || null });
  }
  return out;
}
