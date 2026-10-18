import { cuid, getDb } from '../src/db';
import { createApp } from '../src/app';
import { ensureDefaultTopics } from '../src/lib/topics';

export function resetDb() {
  const db = getDb();
  db.exec('DELETE FROM "FeedItem"; DELETE FROM "FeedTopic"; DELETE FROM "Feed"; DELETE FROM "SavedLink"; DELETE FROM "HiddenLink"; DELETE FROM "Topic";');
  ensureDefaultTopics();
}

export interface TestFeed {
  id: string;
  name: string;
  url: string;
  sourceKind: string;
  isActive: boolean;
  topics: { topicSlug: string }[];
}

let createdAtTick = Date.now();

export function createFeed(
  overrides: Partial<{
    name: string;
    url: string;
    sourceKind: string;
    topic: string;
    topics: string[];
    isActive: boolean;
  }> = {},
): TestFeed {
  const db = getDb();
  const topics = overrides.topics ?? [overrides.topic ?? 'TECHNOLOGY'];
  const feed = {
    id: cuid(),
    name: overrides.name ?? 'Test Feed',
    url: overrides.url ?? `https://example.com/${Math.random()}.xml`,
    sourceKind: overrides.sourceKind ?? 'RSS',
    isActive: overrides.isActive ?? true,
  };
  const now = ++createdAtTick;
  db.prepare(
    `INSERT INTO "Feed" ("id", "name", "url", "sourceKind", "isActive", "fetchErrorCount", "createdAt", "updatedAt")
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(feed.id, feed.name, feed.url, feed.sourceKind, feed.isActive ? 1 : 0, now, now);
  const link = db.prepare('INSERT INTO "FeedTopic" ("feedId", "topicSlug") VALUES (?, ?)');
  for (const slug of topics) link.run(feed.id, slug);
  return { ...feed, topics: [...topics].sort().map((topicSlug) => ({ topicSlug })) };
}

export function seedItems(feedId: string, count: number, startDate: Date = new Date('2026-04-14T00:00:00Z')) {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO "FeedItem" ("id", "feedId", "guid", "title", "link", "publishedAt", "fetchedAt")
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      insert.run(
        cuid(),
        feedId,
        `item-${feedId}-${i}`,
        `Item ${i}`,
        `https://example.com/items/${feedId}-${i}`,
        startDate.getTime() - i * 60_000,
        Date.now(),
      );
    }
  })();
}

// ---------- DB inspection (replaces Prisma reads in the reference tests) ----------

export interface ItemRow {
  id: string;
  feedId: string;
  guid: string;
  title: string;
  link: string;
  summary: string | null;
  author: string | null;
  publishedAt: number;
  sourceRank: number | null;
}

export function itemsOf(feedId: string): ItemRow[] {
  return getDb()
    .prepare('SELECT * FROM "FeedItem" WHERE "feedId" = ? ORDER BY "sourceRank" ASC, "publishedAt" DESC')
    .all(feedId) as ItemRow[];
}

export function itemByGuid(feedId: string, guid: string): ItemRow | undefined {
  return getDb().prepare('SELECT * FROM "FeedItem" WHERE "feedId" = ? AND "guid" = ?').get(feedId, guid) as
    | ItemRow
    | undefined;
}

export function countItems(feedId?: string): number {
  const db = getDb();
  const row = feedId
    ? db.prepare('SELECT COUNT(*) AS n FROM "FeedItem" WHERE "feedId" = ?').get(feedId)
    : db.prepare('SELECT COUNT(*) AS n FROM "FeedItem"').get();
  return (row as { n: number }).n;
}

export function feedRow(id: string) {
  const row = getDb().prepare('SELECT * FROM "Feed" WHERE "id" = ?').get(id) as
    | { id: string; name: string; isActive: number; fetchErrorCount: number; lastFetched: number | null }
    | undefined;
  return row ? { ...row, isActive: row.isActive === 1 } : null;
}

export function count(table: 'Topic' | 'Feed' | 'FeedTopic' | 'SavedLink' | 'HiddenLink' | 'FeedItem', where = '', ...args: unknown[]) {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM "${table}" ${where ? `WHERE ${where}` : ''}`).get(...args) as { n: number }).n;
}

// ---------- in-process HTTP ----------

const app = createApp({ staticRoots: [] });

export async function request(path: string, init?: RequestInit): Promise<Response> {
  return app.request(`http://localhost${path}`, init);
}

export function json(method: string, path: string, body?: unknown) {
  return request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}
