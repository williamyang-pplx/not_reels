-- AlterTable
ALTER TABLE "FeedItem" ADD COLUMN "sourceRank" INTEGER;

-- Backfill existing rows using per-feed recency order as initial source ranking.
WITH ranked AS (
  SELECT
    "id",
    (ROW_NUMBER() OVER (
      PARTITION BY "feedId"
      ORDER BY "publishedAt" DESC, "id" ASC
    ) - 1) AS "rank"
  FROM "FeedItem"
)
UPDATE "FeedItem"
SET "sourceRank" = (
  SELECT "rank"
  FROM ranked
  WHERE ranked."id" = "FeedItem"."id"
);

-- CreateIndex
CREATE INDEX "FeedItem_feedId_sourceRank_idx" ON "FeedItem"("feedId", "sourceRank");
