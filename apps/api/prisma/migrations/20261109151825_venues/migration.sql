-- DropIndex
DROP INDEX "TradingSession_tradingDate_key";

-- AlterTable
ALTER TABLE "PaperTrade" ADD COLUMN     "venue" TEXT NOT NULL DEFAULT 'DHAN';

-- AlterTable
ALTER TABLE "Signal" ADD COLUMN     "venue" TEXT NOT NULL DEFAULT 'DHAN';

-- AlterTable
ALTER TABLE "TradingSession" ADD COLUMN     "venue" TEXT NOT NULL DEFAULT 'DHAN';

-- CreateIndex
CREATE UNIQUE INDEX "TradingSession_tradingDate_venue_key" ON "TradingSession"("tradingDate", "venue");

