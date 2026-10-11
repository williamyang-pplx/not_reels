import { getDb } from '../db';
import { DEFAULT_TOPICS } from './constants';
import type { TopicRecord } from './types';

/** Insert DEFAULT_TOPICS only when the Topic table is empty (runs on every topics read). */
export function ensureDefaultTopics(): void {
  const db = getDb();
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM "Topic"').get() as { n: number };
  if (n > 0) return;
  const insert = db.prepare('INSERT INTO "Topic" ("slug", "label", "createdAt") VALUES (?, ?, ?)');
  const now = Date.now();
  // Same createdAt for the whole batch (like Prisma createMany); listTopics breaks ties by rowid.
  db.transaction(() => {
    for (const t of DEFAULT_TOPICS) insert.run(t.slug, t.label, now);
  })();
}

export function topicExists(slug: string): boolean {
  return getDb().prepare('SELECT 1 FROM "Topic" WHERE "slug" = ?').get(slug) !== undefined;
}

export function findUnknownTopics(slugs: string[]): string[] {
  const unique = Array.from(new Set(slugs));
  if (unique.length === 0) return [];
  const rows = getDb()
    .prepare(`SELECT "slug" FROM "Topic" WHERE "slug" IN (${unique.map(() => '?').join(',')})`)
    .all(...unique) as { slug: string }[];
  const found = new Set(rows.map((r) => r.slug));
  return unique.filter((s) => !found.has(s));
}

export function listTopics(): TopicRecord[] {
  ensureDefaultTopics();
  const rows = getDb()
    .prepare('SELECT "slug", "label", "createdAt" FROM "Topic" ORDER BY "createdAt" ASC, rowid ASC')
    .all() as { slug: string; label: string; createdAt: number }[];
  return rows.map((r) => ({ slug: r.slug, label: r.label, createdAt: new Date(r.createdAt).toISOString() }));
}

export function unknownTopicsMessage(unknown: string[]): string {
  return `Unknown topic${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`;
}
