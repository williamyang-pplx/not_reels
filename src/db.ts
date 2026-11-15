import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseLegacySubredditRssUrl, parseSubredditFeedUrl, subredditFeedUrl } from './lib/reddit-feeds';

export type DB = Database.Database;

/** Turn a Prisma-style `file:` URL into a filesystem path. Relative paths resolve against cwd. */
export function resolveDbPath(url = process.env.DATABASE_URL ?? 'file:./data/dev.db'): string {
  let p = url.replace(/^file:(\/\/)?/, '');
  if (p === ':memory:') return p;
  return path.resolve(process.cwd(), p);
}

let db: DB | null = null;

/** Lazily open the process-wide connection and run migrations once. */
export function getDb(): DB {
  if (db) return db;
  const file = resolveDbPath();
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const conn = new Database(file);
  conn.pragma('journal_mode = WAL');
  conn.pragma('synchronous = NORMAL');
  conn.pragma('foreign_keys = ON');
  conn.pragma('busy_timeout = 5000');
  migrate(conn);
  db = conn;
  return db;
}

export function closeDb(): void {
  db?.close();
  db = null;
}

/**
 * Same tables, columns and indexes as the Prisma schema (spec §3), minus `Feed.type` (dropped when
 * the forum/blog split went away). DateTime columns hold integer milliseconds, which is how Prisma
 * stores them in SQLite. A database created by the previous app is upgraded in place by
 * dropLegacyFeedType().
 */
export function migrate(conn: DB): void {
  conn.exec(`
CREATE TABLE IF NOT EXISTS "Topic" (
  "slug" TEXT NOT NULL PRIMARY KEY,
  "label" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "position" INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS "Feed" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "sourceKind" TEXT NOT NULL DEFAULT 'RSS',
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "fetchErrorCount" INTEGER NOT NULL DEFAULT 0,
  "lastFetched" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "Feed_url_key" ON "Feed"("url");
CREATE INDEX IF NOT EXISTS "Feed_sourceKind_idx" ON "Feed"("sourceKind");
CREATE TABLE IF NOT EXISTS "FeedTopic" (
  "feedId" TEXT NOT NULL,
  "topicSlug" TEXT NOT NULL,
  PRIMARY KEY ("feedId", "topicSlug"),
  CONSTRAINT "FeedTopic_feedId_fkey" FOREIGN KEY ("feedId") REFERENCES "Feed" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FeedTopic_topicSlug_fkey" FOREIGN KEY ("topicSlug") REFERENCES "Topic" ("slug") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "FeedTopic_topicSlug_idx" ON "FeedTopic"("topicSlug");
CREATE TABLE IF NOT EXISTS "FeedItem" (
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
CREATE UNIQUE INDEX IF NOT EXISTS "FeedItem_feedId_guid_key" ON "FeedItem"("feedId", "guid");
CREATE INDEX IF NOT EXISTS "FeedItem_feedId_idx" ON "FeedItem"("feedId");
CREATE INDEX IF NOT EXISTS "FeedItem_publishedAt_idx" ON "FeedItem"("publishedAt");
CREATE INDEX IF NOT EXISTS "FeedItem_feedId_publishedAt_idx" ON "FeedItem"("feedId", "publishedAt");
CREATE INDEX IF NOT EXISTS "FeedItem_feedId_sourceRank_idx" ON "FeedItem"("feedId", "sourceRank");
CREATE INDEX IF NOT EXISTS "FeedItem_link_idx" ON "FeedItem"("link");
CREATE TABLE IF NOT EXISTS "SavedLink" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "url" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "topic" TEXT NOT NULL,
  "notes" TEXT,
  "savedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE INDEX IF NOT EXISTS "SavedLink_topic_idx" ON "SavedLink"("topic");
CREATE INDEX IF NOT EXISTS "SavedLink_url_idx" ON "SavedLink"("url");
CREATE TABLE IF NOT EXISTS "HiddenLink" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "url" TEXT NOT NULL,
  "hiddenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "HiddenLink_url_key" ON "HiddenLink"("url");
`);
  dropLegacyFeedType(conn);
  addTopicPosition(conn);
  convertSubredditFeeds(conn);
}

/** Drop the old FORUM/BLOG column (and its index, which SQLite requires first). No-op once gone. */
function dropLegacyFeedType(conn: DB): void {
  if (!conn.prepare(`SELECT 1 FROM pragma_table_info('Feed') WHERE "name" = 'type'`).get()) return;
  conn.transaction(() => {
    conn.exec('DROP INDEX IF EXISTS "Feed_type_idx"; ALTER TABLE "Feed" DROP COLUMN "type";');
  })();
}

/** Add Topic.position to a DB created before topic ordering, numbered in the old createdAt order. No-op once present. */
function addTopicPosition(conn: DB): void {
  if (conn.prepare(`SELECT 1 FROM pragma_table_info('Topic') WHERE "name" = 'position'`).get()) return;
  conn.transaction(() => {
    conn.exec(`
ALTER TABLE "Topic" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;
WITH r AS (SELECT "slug", ROW_NUMBER() OVER (ORDER BY "createdAt", rowid) - 1 AS p FROM "Topic")
UPDATE "Topic" SET "position" = (SELECT p FROM r WHERE r."slug" = "Topic"."slug");`);
  })();
}

/**
 * Turn subreddit feeds into REDDIT feeds (shown as Redlib windows) stored under their page URL
 * (https://www.reddit.com/r/<sub>/), whether they were RSS feeds or REDDIT feeds still holding an old .rss URL.
 * Their stored items are deleted. A feed whose page URL another feed already has is folded into that one (oldest
 * kept, topics merged). Runs at every boot; once every subreddit feed is converted it is a no-op.
 */
function convertSubredditFeeds(conn: DB): void {
  const rows = conn
    .prepare(`SELECT "id", "url", "sourceKind" FROM "Feed" WHERE "sourceKind" IN ('RSS', 'REDDIT') ORDER BY "createdAt", rowid`)
    .all() as { id: string; url: string; sourceKind: string }[];
  const changes = rows.flatMap((row) => {
    const sub = parseSubredditFeedUrl(row.url) ?? parseLegacySubredditRssUrl(row.url);
    if (!sub) return [];
    const url = subredditFeedUrl(sub);
    return row.sourceKind === 'REDDIT' && row.url === url ? [] : [{ id: row.id, url }];
  });
  if (changes.length === 0) return;
  const owner = conn.prepare('SELECT "id" FROM "Feed" WHERE "url" = ? AND "id" != ?');
  const mergeTopics = conn.prepare(
    'INSERT OR IGNORE INTO "FeedTopic" ("feedId", "topicSlug") SELECT ?, "topicSlug" FROM "FeedTopic" WHERE "feedId" = ?',
  );
  const convert = conn.prepare(
    `UPDATE "Feed" SET "sourceKind" = 'REDDIT', "url" = ?, "fetchErrorCount" = 0, "updatedAt" = ? WHERE "id" = ?`,
  );
  const dropItems = conn.prepare('DELETE FROM "FeedItem" WHERE "feedId" = ?');
  const dropTopics = conn.prepare('DELETE FROM "FeedTopic" WHERE "feedId" = ?');
  const dropFeed = conn.prepare('DELETE FROM "Feed" WHERE "id" = ?');
  conn.transaction(() => {
    const now = Date.now();
    for (const { id, url } of changes) {
      dropItems.run(id);
      const kept = owner.get(url, id) as { id: string } | undefined;
      if (!kept) {
        convert.run(url, now, id);
        continue;
      }
      mergeTopics.run(kept.id, id);
      dropTopics.run(id);
      dropFeed.run(id);
    }
  })();
}

/** Run `fn` inside a transaction on the shared connection. */
export function tx<T>(fn: () => T): T {
  return getDb().transaction(fn)();
}

let counter = Math.floor(Math.random() * 1679616);

/** Collision-resistant, roughly time-ordered id in the shape of a Prisma cuid (25 chars, starts with "c"). */
export function cuid(): string {
  counter = (counter + 1) % 1679616;
  const time = Date.now().toString(36).padStart(8, '0');
  const count = counter.toString(36).padStart(4, '0');
  const rand = BigInt('0x' + randomBytes(8).toString('hex')).toString(36).padStart(12, '0').slice(-12);
  return `c${time}${count}${rand}`;
}

/** SQLite booleans come back as 0/1. */
export const bool = (v: unknown): boolean => v === 1 || v === true;

/** Dates are stored as integer ms (Prisma-compatible). Tolerates legacy text timestamps. */
export function toDate(v: unknown): Date {
  if (typeof v === 'number' || typeof v === 'bigint') return new Date(Number(v));
  if (typeof v === 'string') return new Date(/^\d+$/.test(v) ? Number(v) : v.replace(' ', 'T') + (v.includes('Z') ? '' : 'Z'));
  return new Date(NaN);
}
