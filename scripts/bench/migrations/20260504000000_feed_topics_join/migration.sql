-- CreateTable
CREATE TABLE "FeedTopic" (
    "feedId" TEXT NOT NULL,
    "topicSlug" TEXT NOT NULL,

    PRIMARY KEY ("feedId", "topicSlug"),
    CONSTRAINT "FeedTopic_feedId_fkey" FOREIGN KEY ("feedId") REFERENCES "Feed" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "FeedTopic_topicSlug_fkey" FOREIGN KEY ("topicSlug") REFERENCES "Topic" ("slug") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "FeedTopic_topicSlug_idx" ON "FeedTopic"("topicSlug");

-- Backfill: ensure every Feed.topic value exists in Topic before we wire up the FK.
INSERT OR IGNORE INTO "Topic" ("slug", "label", "createdAt")
SELECT DISTINCT "topic", "topic", CURRENT_TIMESTAMP FROM "Feed";

-- Backfill: copy existing one-to-one Feed.topic mapping into the join table.
INSERT INTO "FeedTopic" ("feedId", "topicSlug")
SELECT "id", "topic" FROM "Feed";

-- RedefineTables: drop Feed.topic column via SQLite table rebuild.
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Feed" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL DEFAULT 'RSS',
    "type" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "fetchErrorCount" INTEGER NOT NULL DEFAULT 0,
    "lastFetched" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Feed" ("id", "name", "url", "sourceKind", "type", "isActive", "fetchErrorCount", "lastFetched", "createdAt", "updatedAt")
SELECT "id", "name", "url", "sourceKind", "type", "isActive", "fetchErrorCount", "lastFetched", "createdAt", "updatedAt" FROM "Feed";
DROP TABLE "Feed";
ALTER TABLE "new_Feed" RENAME TO "Feed";
CREATE UNIQUE INDEX "Feed_url_key" ON "Feed"("url");
CREATE INDEX "Feed_type_idx" ON "Feed"("type");
CREATE INDEX "Feed_sourceKind_idx" ON "Feed"("sourceKind");
PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;
