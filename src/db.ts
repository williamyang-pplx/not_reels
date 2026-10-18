import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

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
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
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
}

/** Drop the old FORUM/BLOG column (and its index, which SQLite requires first). No-op once gone. */
function dropLegacyFeedType(conn: DB): void {
  if (!conn.prepare(`SELECT 1 FROM pragma_table_info('Feed') WHERE "name" = 'type'`).get()) return;
  conn.transaction(() => {
    conn.exec('DROP INDEX IF EXISTS "Feed_type_idx"; ALTER TABLE "Feed" DROP COLUMN "type";');
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
