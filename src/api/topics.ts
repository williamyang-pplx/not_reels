import { Hono } from 'hono';
import { getDb } from '../db';
import { fail, ok, parseJson } from '../lib/api';
import { CreateTopicSchema, ReorderTopicsSchema } from '../lib/validations';
import { listTopics, setTopicOrder, topicExists } from '../lib/topics';

export const topicsApi = new Hono();

topicsApi.get('/', (c) => ok(c, listTopics()));

topicsApi.post('/', async (c) => {
  const parsed = await parseJson(c, CreateTopicSchema);
  if (!parsed.ok) return parsed.response;
  if (topicExists(parsed.data.slug)) return fail(c, 'Topic already exists', 'DUPLICATE', 409);
  const createdAt = Date.now();
  getDb()
    .prepare(
      `INSERT INTO "Topic" ("slug", "label", "createdAt", "position")
       VALUES (?, ?, ?, (SELECT COALESCE(MAX("position"), -1) + 1 FROM "Topic"))`,
    )
    .run(parsed.data.slug, parsed.data.label, createdAt);
  return ok(c, { slug: parsed.data.slug, label: parsed.data.label, createdAt: new Date(createdAt).toISOString() }, 201);
});

/** Replace the topic order. 400 unless `slugs` lists every topic exactly once. */
topicsApi.put('/order', async (c) => {
  const parsed = await parseJson(c, ReorderTopicsSchema);
  if (!parsed.ok) return parsed.response;
  const { slugs } = parsed.data;
  const existing = new Set(listTopics().map((t) => t.slug));
  if (new Set(slugs).size !== slugs.length || slugs.length !== existing.size || !slugs.every((s) => existing.has(s))) {
    return fail(c, 'Order must list every topic exactly once', 'VALIDATION_ERROR', 400);
  }
  setTopicOrder(slugs);
  return ok(c, listTopics());
});

topicsApi.delete('/:slug', (c) => {
  const slug = c.req.param('slug');
  const db = getDb();
  if (!topicExists(slug)) return fail(c, 'Topic not found', 'NOT_FOUND', 404);

  // A feed is orphaned by this delete iff this topic is its ONLY topic.
  const orphans = db
    .prepare(
      `SELECT f."name" FROM "Feed" f
        WHERE EXISTS (SELECT 1 FROM "FeedTopic" ft WHERE ft."feedId" = f."id" AND ft."topicSlug" = ?)
          AND NOT EXISTS (SELECT 1 FROM "FeedTopic" ft WHERE ft."feedId" = f."id" AND ft."topicSlug" <> ?)`,
    )
    .all(slug, slug) as { name: string }[];
  if (orphans.length > 0) {
    return fail(
      c,
      `Cannot delete topic — these feeds would have no topic: ${orphans.map((f) => f.name).join(', ')}. Reassign them first.`,
      'CONSTRAINT',
      409,
    );
  }

  const deletedSavedLinks = db.transaction(() => {
    const { changes } = db.prepare('DELETE FROM "SavedLink" WHERE "topic" = ?').run(slug);
    db.prepare('DELETE FROM "Topic" WHERE "slug" = ?').run(slug);
    return changes;
  })();
  return ok(c, { slug, deletedSavedLinks });
});
