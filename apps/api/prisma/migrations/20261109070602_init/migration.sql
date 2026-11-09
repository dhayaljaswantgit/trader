-- CreateEnum
CREATE TYPE "TradingMode" AS ENUM ('PAPER', 'LIVE');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('ACTIVE', 'HALTED_LOSS', 'HALTED_PROFIT', 'HALTED_CONSECUTIVE_LOSSES', 'EMERGENCY_STOP', 'CLOSED');

-- CreateTable
CREATE TABLE "TradingSession" (
    "id" TEXT NOT NULL,
    "tradingDate" TEXT NOT NULL,
    "mode" "TradingMode" NOT NULL DEFAULT 'PAPER',
    "capitalInr" DECIMAL(14,2) NOT NULL,
    "maxLossInr" DECIMAL(14,2) NOT NULL,
    "maxProfitInr" DECIMAL(14,2),
    "riskPerTradePct" DECIMAL(5,2) NOT NULL,
    "status" "SessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "realizedPnlInr" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "unrealizedPnlInr" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "consecutiveLosses" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradingSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Preferences" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "styles" TEXT[] DEFAULT ARRAY['INTRADAY']::TEXT[],
    "segments" TEXT[] DEFAULT ARRAY['OPTIONS']::TEXT[],
    "instrumentKeys" TEXT[],
    "strategies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "autoPaper" BOOLEAN NOT NULL DEFAULT false,
    "autoStartDaily" BOOLEAN NOT NULL DEFAULT false,
    "defaultCapital" DECIMAL(14,2) NOT NULL DEFAULT 100000,
    "defaultMaxLoss" DECIMAL(14,2) NOT NULL DEFAULT 1000,
    "defaultMaxProfit" DECIMAL(14,2),
    "defaultRiskPct" DECIMAL(5,2) NOT NULL DEFAULT 0.25,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Instrument" (
    "key" TEXT NOT NULL,
    "securityId" TEXT NOT NULL,
    "segment" TEXT NOT NULL,
    "instrumentType" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lotSize" INTEGER NOT NULL,
    "tickSize" DECIMAL(10,4) NOT NULL,
    "expiry" TEXT,
    "underlyingSecurityId" TEXT,
    "underlyingSymbol" TEXT,
    "fnoEligible" BOOLEAN NOT NULL DEFAULT false,
    "fnoLotSize" INTEGER,
    "source" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Instrument_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "Signal" (
    "id" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "strategyVersion" TEXT NOT NULL,
    "instrumentKey" TEXT NOT NULL,
    "underlying" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reasons" JSONB NOT NULL,
    "checks" JSONB NOT NULL,
    "entry" DOUBLE PRECISION,
    "stop" DOUBLE PRECISION,
    "target" DOUBLE PRECISION,
    "dataFresh" BOOLEAN NOT NULL,
    "mode" "TradingMode" NOT NULL,
    "dataSource" TEXT NOT NULL,
    "barTime" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Signal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskDecision" (
    "id" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "sessionId" TEXT,
    "mode" "TradingMode" NOT NULL,
    "approved" BOOLEAN NOT NULL,
    "reasons" JSONB NOT NULL,
    "intent" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiskDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderIntent" (
    "id" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "mode" "TradingMode" NOT NULL,
    "instrumentKey" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "limitPrice" DECIMAL(14,2) NOT NULL,
    "state" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaperTrade" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "underlying" TEXT NOT NULL,
    "instrumentKey" TEXT NOT NULL,
    "contract" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "lotSize" INTEGER NOT NULL,
    "entryPrice" DECIMAL(14,2) NOT NULL,
    "stopPrice" DECIMAL(14,2) NOT NULL,
    "targetPrice" DECIMAL(14,2) NOT NULL,
    "lastPrice" DECIMAL(14,2) NOT NULL,
    "exitPrice" DECIMAL(14,2),
    "entryCharges" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "exitCharges" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "pnlInr" DECIMAL(14,2),
    "exitReason" TEXT,
    "dataSource" TEXT NOT NULL,
    "fillNote" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "PaperTrade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BacktestRun" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "label" TEXT NOT NULL,
    "dataSource" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "metrics" JSONB NOT NULL,
    "result" JSONB NOT NULL,

    CONSTRAINT "BacktestRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" BIGSERIAL NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "mode" "TradingMode" NOT NULL,
    "correlationId" TEXT,
    "details" JSONB NOT NULL,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TradingSession_tradingDate_key" ON "TradingSession"("tradingDate");

-- CreateIndex
CREATE INDEX "Instrument_symbol_idx" ON "Instrument"("symbol");

-- CreateIndex
CREATE INDEX "Instrument_underlyingSecurityId_instrumentType_idx" ON "Instrument"("underlyingSecurityId", "instrumentType");

-- CreateIndex
CREATE UNIQUE INDEX "Signal_correlationId_key" ON "Signal"("correlationId");

-- CreateIndex
CREATE INDEX "Signal_createdAt_idx" ON "Signal"("createdAt");

-- CreateIndex
CREATE INDEX "RiskDecision_correlationId_idx" ON "RiskDecision"("correlationId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderIntent_correlationId_key" ON "OrderIntent"("correlationId");

-- CreateIndex
CREATE UNIQUE INDEX "PaperTrade_correlationId_key" ON "PaperTrade"("correlationId");

-- CreateIndex
CREATE INDEX "PaperTrade_closedAt_idx" ON "PaperTrade"("closedAt");

-- AddForeignKey
ALTER TABLE "RiskDecision" ADD CONSTRAINT "RiskDecision_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "TradingSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaperTrade" ADD CONSTRAINT "PaperTrade_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "TradingSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
