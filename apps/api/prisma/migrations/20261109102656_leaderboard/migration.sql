-- CreateTable
CREATE TABLE "LeaderboardRun" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dataSource" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "rows" JSONB NOT NULL,

    CONSTRAINT "LeaderboardRun_pkey" PRIMARY KEY ("id")
);
