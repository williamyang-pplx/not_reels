import { Hono } from 'hono';
import { getDb, cuid } from '../db';
import { fail, ok, parseJson } from '../lib/api';
import { CreateSavedLinkSchema, TopicSchema, UpdateSavedLinkSchema } from '../lib/validations';
import { topicExists } from '../lib/topics';
import { getSavedLink, listSavedLinks } from '../lib/queries';

export const savedLinksApi = new Hono();

savedLinksApi.get('/', (c) => {
  const topic = c.req.query('topic');
  if (topic && topic !== 'ALL' && !TopicSchema.safeParse(topic).success) {
    return fail(c, 'Invalid topic', 'VALIDATION_ERROR', 400);
  }
  return ok(c, listSavedLinks(topic));
});

savedLinksApi.post('/', async (c) => {
  const parsed = await parseJson(c, CreateSavedLinkSchema);
  if (!parsed.ok) return parsed.response;
  const { url, title, topic, notes } = parsed.data;
  if (!topicExists(topic)) return fail(c, 'Unknown topic', 'VALIDATION_ERROR', 400);
  const id = cuid();
  const now = Date.now();
  getDb()
    .prepare(
      'INSERT INTO "SavedLink" ("id", "url", "title", "topic", "notes", "savedAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(id, url, title, topic, notes ?? null, now, now);
  return ok(c, getSavedLink(id), 201);
});

savedLinksApi.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const parsed = await parseJson(c, UpdateSavedLinkSchema);
  if (!parsed.ok) return parsed.response;
  if (!getSavedLink(id)) return fail(c, 'Saved link not found', 'NOT_FOUND', 404);
  const { title, topic, notes } = parsed.data;
  if (topic && !topicExists(topic)) return fail(c, 'Unknown topic', 'VALIDATION_ERROR', 400);

  const sets: string[] = [];
  const args: unknown[] = [];
  for (const [col, val] of [['title', title], ['topic', topic], ['notes', notes]] as const) {
    if (val !== undefined) {
      sets.push(`"${col}" = ?`);
      args.push(val);
    }
  }
  getDb()
    .prepare(`UPDATE "SavedLink" SET ${[...sets, '"updatedAt" = ?'].join(', ')} WHERE "id" = ?`)
    .run(...args, Date.now(), id);
  return ok(c, getSavedLink(id));
});

savedLinksApi.delete('/:id', (c) => {
  const id = c.req.param('id');
  const { changes } = getDb().prepare('DELETE FROM "SavedLink" WHERE "id" = ?').run(id);
  if (changes === 0) return fail(c, 'Saved link not found', 'NOT_FOUND', 404);
  return ok(c, { id });
});
