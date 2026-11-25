-- AlterTable
ALTER TABLE "PaperTrade" ADD COLUMN     "brokerOrderId" TEXT,
ADD COLUMN     "exitOrderId" TEXT,
ADD COLUMN     "mode" TEXT NOT NULL DEFAULT 'PAPER';

-- AlterTable
ALTER TABLE "Preferences" ADD COLUMN     "liveMaxLots" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "liveTrading" BOOLEAN NOT NULL DEFAULT false;

