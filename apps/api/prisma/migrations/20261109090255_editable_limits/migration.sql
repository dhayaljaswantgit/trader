-- AlterTable
ALTER TABLE "Preferences" ADD COLUMN     "defaultMaxConsecutiveLosses" INTEGER NOT NULL DEFAULT 3;

-- AlterTable
ALTER TABLE "TradingSession" ADD COLUMN     "maxConsecutiveLosses" INTEGER NOT NULL DEFAULT 3;
