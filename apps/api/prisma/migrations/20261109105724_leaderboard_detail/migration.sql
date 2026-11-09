-- CreateTable
CREATE TABLE "LeaderboardDetail" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "data" JSONB NOT NULL,

    CONSTRAINT "LeaderboardDetail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LeaderboardDetail_runId_strategyId_key" ON "LeaderboardDetail"("runId", "strategyId");
