/**
 * Approximate Indian statutory + broker charges. Rates are ASSUMPTIONS (as understood late-2025)
 * and must be verified against Dhan's current pricing page and NSE/BSE circulars. All configurable.
 */
export type ProductKind = "EQUITY_INTRADAY" | "EQUITY_DELIVERY" | "FUTURES" | "OPTIONS" | "CRYPTO_PERP";
export interface CostModel {
  brokeragePerOrder: number; brokeragePct: number; // brokerage = min(perOrder, pct*turnover); delivery uses pct (0)
  sttBuyPct: number; sttSellPct: number; txnPct: number; sebiPerCrore: number; stampBuyPct: number; gstPct: number;
}
export const COSTS: Record<ProductKind, CostModel> = {
  EQUITY_INTRADAY: { brokeragePerOrder: 20, brokeragePct: 0.03, sttBuyPct: 0, sttSellPct: 0.025, txnPct: 0.00297, sebiPerCrore: 10, stampBuyPct: 0.003, gstPct: 18 },
  EQUITY_DELIVERY: { brokeragePerOrder: 0, brokeragePct: 0, sttBuyPct: 0.1, sttSellPct: 0.1, txnPct: 0.00297, sebiPerCrore: 10, stampBuyPct: 0.015, gstPct: 18 },
  FUTURES: { brokeragePerOrder: 20, brokeragePct: 0.03, sttBuyPct: 0, sttSellPct: 0.02, txnPct: 0.00173, sebiPerCrore: 10, stampBuyPct: 0.002, gstPct: 18 },
  /** Delta Exchange perpetual futures: taker fee 0.05% of notional per side + 18% GST on the fee. No STT/stamp. Funding NOT included. */
  CRYPTO_PERP: { brokeragePerOrder: Infinity, brokeragePct: 0.05, sttBuyPct: 0, sttSellPct: 0, txnPct: 0, sebiPerCrore: 0, stampBuyPct: 0, gstPct: 18 },
  OPTIONS: { brokeragePerOrder: 20, brokeragePct: 100, sttBuyPct: 0, sttSellPct: 0.1, txnPct: 0.03503, sebiPerCrore: 10, stampBuyPct: 0.003, gstPct: 18 },
};
/** Charges for one side. turnover = price * qty (premium for options). */
export function orderCharges(kind: ProductKind, side: "BUY" | "SELL", turnover: number, m: CostModel = COSTS[kind]): number {
  const brokerage = Math.min(m.brokeragePerOrder, (m.brokeragePct / 100) * turnover);
  const stt = ((side === "BUY" ? m.sttBuyPct : m.sttSellPct) / 100) * turnover;
  const txn = (m.txnPct / 100) * turnover, sebi = (m.sebiPerCrore / 1e7) * turnover;
  const stamp = side === "BUY" ? (m.stampBuyPct / 100) * turnover : 0;
  const gst = (m.gstPct / 100) * (brokerage + txn + sebi);
  return Math.round((brokerage + stt + txn + sebi + stamp + gst) * 100) / 100;
}
