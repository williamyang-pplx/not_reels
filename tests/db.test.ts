import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../src/db';

/** The Feed table as it was before the forum/blog split was removed. */
const LEGACY_SCHEMA = `
CREATE TABLE "Topic" (
  "slug" TEXT NOT NULL PRIMARY KEY,
  "label" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "Feed" (
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
CREATE UNIQUE INDEX "Feed_url_key" ON "Feed"("url");
CREATE INDEX "Feed_type_idx" ON "Feed"("type");
CREATE INDEX "Feed_sourceKind_idx" ON "Feed"("sourceKind");
CREATE TABLE "FeedTopic" (
  "feedId" TEXT NOT NULL,
  "topicSlug" TEXT NOT NULL,
  PRIMARY KEY ("feedId", "topicSlug"),
  CONSTRAINT "FeedTopic_feedId_fkey" FOREIGN KEY ("feedId") REFERENCES "Feed" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FeedTopic_topicSlug_fkey" FOREIGN KEY ("topicSlug") REFERENCES "Topic" ("slug") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "FeedItem" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "feedId" TEXT NOT NULL,
  "guid" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "link" TEXT NOT NULL,
  "summary" TEXT,
  "author" TEXT,
  "publishedAt" DATETIME NOT NULL,
  "sourceRank" INTEGER,
  "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FeedItem_feedId_fkey" FOREIGN KEY ("feedId") REFERENCES "Feed" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
`;

function open() {
  const conn = new Database(':memory:');
  conn.pragma('foreign_keys = ON');
  return conn;
}

const columns = (conn: Database.Database) =>
  (conn.prepare(`SELECT "name" FROM pragma_table_info('Feed')`).all() as { name: string }[]).map((r) => r.name);
const indexes = (conn: Database.Database) =>
  (conn.prepare(`SELECT "name" FROM pragma_index_list('Feed')`).all() as { name: string }[]).map((r) => r.name);

describe('migrate', () => {
  it('drops the legacy Feed.type column and index, keeping rows', () => {
    const conn = open();
    conn.exec(LEGACY_SCHEMA);
    conn.exec(`
      INSERT INTO "Topic" ("slug", "label") VALUES ('NEWS', 'News');
      INSERT INTO "Feed" ("id", "name", "url", "type", "updatedAt") VALUES ('f1', 'Blog', 'https://b.example', 'BLOG', 0);
      INSERT INTO "FeedTopic" VALUES ('f1', 'NEWS');
      INSERT INTO "FeedItem" ("id", "feedId", "guid", "title", "link", "publishedAt") VALUES ('i1', 'f1', 'g', 'T', 'https://b.example/1', 0);
    `);

    migrate(conn);

    expect(columns(conn)).not.toContain('type');
    expect(indexes(conn)).not.toContain('Feed_type_idx');
    expect(conn.prepare('SELECT "name" FROM "Feed" WHERE "id" = ?').get('f1')).toEqual({ name: 'Blog' });
    expect(conn.prepare('SELECT COUNT(*) AS n FROM "FeedTopic"').get()).toEqual({ n: 1 });
    expect(conn.prepare('SELECT COUNT(*) AS n FROM "FeedItem"').get()).toEqual({ n: 1 });
  });

  it('is idempotent on a fresh DB', () => {
    const conn = open();
    migrate(conn);
    migrate(conn);
    expect(columns(conn)).not.toContain('type');
    expect(columns(conn)).toContain('sourceKind');
  });
});
