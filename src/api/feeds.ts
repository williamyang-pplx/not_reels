import { Hono } from 'hono';
import { getDb, cuid } from '../db';
import { fail, ok, parseJson } from '../lib/api';
import { CreateFeedSchema, TopicSchema, UpdateFeedSchema } from '../lib/validations';
import { refreshSingleFeed } from '../lib/feed-refresh';
import { inferFeedSourceKind } from '../lib/local-feeds/registry';
import { findUnknownTopics, unknownTopicsMessage } from '../lib/topics';
import { getFeed, listFeeds } from '../lib/queries';

export const feedsApi = new Hono();

feedsApi.get('/', (c) => {
  const topic = c.req.query('topic');
  if (topic && topic !== 'ALL' && !TopicSchema.safeParse(topic).success) {
    return fail(c, 'Invalid topic', 'VALIDATION_ERROR', 400);
  }
  return ok(c, listFeeds({ topic }));
});

feedsApi.post('/', async (c) => {
  const parsed = await parseJson(c, CreateFeedSchema);
  if (!parsed.ok) return parsed.response;
  const db = getDb();
  const { name, url, topics } = parsed.data;

  if (db.prepare('SELECT 1 FROM "Feed" WHERE "url" = ?').get(url)) {
    return fail(c, 'Feed URL already exists', 'DUPLICATE', 409);
  }
  const unknown = findUnknownTopics(topics);
  if (unknown.length > 0) return fail(c, unknownTopicsMessage(unknown), 'VALIDATION_ERROR', 400);

  const id = cuid();
  const now = Date.now();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO "Feed" ("id", "name", "url", "sourceKind", "isActive", "fetchErrorCount", "createdAt", "updatedAt")
       VALUES (?, ?, ?, ?, 1, 0, ?, ?)`,
    ).run(id, name, url, inferFeedSourceKind(url), now, now);
    const link = db.prepare('INSERT OR IGNORE INTO "FeedTopic" ("feedId", "topicSlug") VALUES (?, ?)');
    for (const slug of topics) link.run(id, slug);
  })();

  // Immediate first fetch (best-effort; failures are only logged).
  try {
    await refreshSingleFeed(id);
  } catch (err) {
    console.error('[POST /api/feeds] initial fetch failed', err);
  }

  return ok(c, getFeed(id), 201);
});

feedsApi.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const parsed = await parseJson(c, UpdateFeedSchema);
  if (!parsed.ok) return parsed.response;
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM "Feed" WHERE "id" = ?').get(id)) return fail(c, 'Feed not found', 'NOT_FOUND', 404);

  const { topics, name, isActive } = parsed.data;
  if (topics) {
    const unknown = findUnknownTopics(topics);
    if (unknown.length > 0) return fail(c, unknownTopicsMessage(unknown), 'VALIDATION_ERROR', 400);
  }

  db.transaction(() => {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (name !== undefined) {
      sets.push('"name" = ?');
      args.push(name);
    }
    if (isActive !== undefined) {
      sets.push('"isActive" = ?');
      args.push(isActive ? 1 : 0);
    }
    if (sets.length > 0) {
      db.prepare(`UPDATE "Feed" SET ${sets.join(', ')}, "updatedAt" = ? WHERE "id" = ?`).run(...args, Date.now(), id);
    }
    if (topics) {
      db.prepare('DELETE FROM "FeedTopic" WHERE "feedId" = ?').run(id);
      const link = db.prepare('INSERT OR IGNORE INTO "FeedTopic" ("feedId", "topicSlug") VALUES (?, ?)');
      for (const slug of topics) link.run(id, slug);
    }
  })();

  return ok(c, getFeed(id));
});

feedsApi.delete('/:id', (c) => {
  const id = c.req.param('id');
  const { changes } = getDb().prepare('DELETE FROM "Feed" WHERE "id" = ?').run(id);
  if (changes === 0) return fail(c, 'Feed not found', 'NOT_FOUND', 404);
  return ok(c, { id });
});
