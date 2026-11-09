import { Decimal, type DailySession, type OrderIntent, toIstHHMM } from "@dat/shared";

export interface ExecutionGates {
  tradingMode: string;
  liveTradingEnabled: boolean;
  autoExecutionEnabled: boolean;
}

export interface RiskContext {
  gates: ExecutionGates;
  session: DailySession | null;
  openPositions: number;
  maxOpenPositions: number;
  maxConsecutiveLosses: number;
  quoteAgeMs: number | null;
  maxQuoteAgeMs: number;
  spreadPct: number | null;
  maxSpreadPct: number;
  brokerConnected: boolean;
  positionMismatch: boolean;
  unknownOrderState: boolean;
  now: Date;
  entryCutoffIst: string; // "HH:MM"
}

export interface RiskDecision {
  approved: boolean;
  reasons: string[];
  /** Max premium-at-risk allowed for this trade */
  allowedRiskInr: string | null;
  intendedRiskInr: string | null;
}

/** Milestone 1: live execution does not exist. This is a hard block, independent of config. */
export const LIVE_EXECUTION_IMPLEMENTED = false as const;

export function sessionPnl(s: DailySession): Decimal {
  return new Decimal(s.realizedPnlInr).plus(s.unrealizedPnlInr);
}

/** Decide session status from P&L. Loss limit includes unrealized P&L. Profit null => unlimited. */
export function evaluateSessionLimits(s: DailySession, maxConsecutiveLosses: number): DailySession["status"] {
  if (s.status === "EMERGENCY_STOP" || s.status === "CLOSED") return s.status;
  const pnl = sessionPnl(s);
  if (pnl.lte(new Decimal(s.maxLossInr).negated())) return "HALTED_LOSS";
  if (s.maxProfitInr !== null && pnl.gte(s.maxProfitInr)) return "HALTED_PROFIT";
  if (s.consecutiveLosses >= maxConsecutiveLosses) return "HALTED_CONSECUTIVE_LOSSES";
  return s.status === "ACTIVE" ? "ACTIVE" : s.status;
}

/** Worst-case loss of a long option entry: (entry - stop) * qty, or full premium if no stop. Stops are NOT guaranteed fills. */
export function intendedRisk(i: OrderIntent): Decimal {
  const entry = new Decimal(i.limitPrice);
  if (i.stopPrice === null) return i.side === "BUY" ? entry.times(i.quantity) : new Decimal(Infinity);
  const perUnit = Decimal.max(i.side === "BUY" ? entry.minus(i.stopPrice) : new Decimal(i.stopPrice).minus(entry), 0);
  return perUnit.times(i.quantity);
}

export function preTradeCheck(intent: OrderIntent, ctx: RiskContext): RiskDecision {
  const r: string[] = [];
  const g = ctx.gates;

  // --- Execution mode gates (never bypassable) ---
  if (intent.mode !== "PAPER") {
    if (!LIVE_EXECUTION_IMPLEMENTED) r.push("LIVE_NOT_IMPLEMENTED: live execution is not available in this build");
    if (g.tradingMode !== "LIVE" || !g.liveTradingEnabled) r.push("LIVE_GATE_CLOSED: TRADING_MODE/LIVE_TRADING_ENABLED not set");
  }
  if (g.tradingMode !== "PAPER" && intent.mode === "PAPER") r.push("MODE_MISMATCH: paper intent while system not in PAPER");

  // Exits are always allowed through (risk-reducing) except for mode gates
  if (!intent.isEntry) {
    return { approved: r.length === 0, reasons: r.length ? r : ["EXIT_ALLOWED"], allowedRiskInr: null, intendedRiskInr: null };
  }

  const s = ctx.session;
  if (!s) {
    r.push("NO_SESSION: start the trading day (capital + max loss) first");
    return { approved: false, reasons: r, allowedRiskInr: null, intendedRiskInr: null };
  }
  const status = evaluateSessionLimits(s, ctx.maxConsecutiveLosses);
  if (status !== "ACTIVE") r.push(`SESSION_${status}`);
  if (s.mode !== intent.mode) r.push("MODE_MISMATCH: intent mode differs from session mode");

  if (ctx.openPositions >= ctx.maxOpenPositions) r.push(`MAX_OPEN_POSITIONS (${ctx.maxOpenPositions})`);
  if (!ctx.brokerConnected) r.push("BROKER_DISCONNECTED");
  if (ctx.positionMismatch) r.push("POSITION_MISMATCH");
  if (ctx.unknownOrderState) r.push("UNKNOWN_ORDER_STATE");
  if (ctx.quoteAgeMs === null || ctx.quoteAgeMs > ctx.maxQuoteAgeMs) r.push("STALE_DATA");
  if (ctx.spreadPct === null) r.push("SPREAD_UNAVAILABLE");
  else if (ctx.spreadPct > ctx.maxSpreadPct) r.push(`SPREAD_TOO_WIDE (${ctx.spreadPct.toFixed(2)}%)`);
  if (toIstHHMM(ctx.now) >= ctx.entryCutoffIst) r.push(`AFTER_ENTRY_CUTOFF (${ctx.entryCutoffIst} IST)`);
  const kind = intent.kind ?? "OPTIONS";
  if (intent.side !== "BUY" && kind === "OPTIONS") r.push("ONLY_LONG_OPTIONS: option selling not allowed");
  if (intent.side !== "BUY" && kind === "EQUITY" && intent.product === "CARRY_FORWARD") r.push("NO_DELIVERY_SHORT: equity shorts are intraday-only");
  if (intent.stopPrice === null && intent.side === "SELL") r.push("STOP_REQUIRED: short entries need a stop");
  if (intent.quantity <= 0 || intent.quantity % intent.lotSize !== 0) r.push("INVALID_QUANTITY: must be a positive multiple of lot size");

  const risk = intendedRisk(intent);
  const perTradeCap = new Decimal(s.capitalInr).times(s.riskPerTradePct).div(100);
  const remainingLoss = new Decimal(s.maxLossInr).plus(sessionPnl(s)); // pnl negative reduces budget
  const allowed = Decimal.min(perTradeCap, Decimal.max(remainingLoss, 0));
  if (risk.gt(allowed)) r.push(`RISK_TOO_HIGH: ₹${risk.toFixed(2)} > allowed ₹${allowed.toFixed(2)}`);
  // Futures/intraday equity use margin; we conservatively require full notional only for options & delivery.
  const cost = new Decimal(intent.limitPrice).times(intent.quantity);
  const needsFull = kind === "OPTIONS" || (kind === "EQUITY" && intent.product === "CARRY_FORWARD");
  if (needsFull && cost.gt(s.capitalInr)) r.push("INSUFFICIENT_CAPITAL");

  return { approved: r.length === 0, reasons: r.length ? r : ["ALL_CHECKS_PASSED"], allowedRiskInr: allowed.toFixed(2), intendedRiskInr: risk.toFixed(2) };
}

/** Limits may only be tightened after a session starts. */