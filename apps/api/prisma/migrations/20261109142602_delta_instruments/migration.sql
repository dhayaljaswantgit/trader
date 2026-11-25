-- AlterTable
ALTER TABLE "Instrument" ADD COLUMN     "contractValue" DECIMAL(18,8),
ADD COLUMN     "takerFee" DECIMAL(8,6);
