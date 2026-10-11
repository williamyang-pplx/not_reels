import { Hono } from 'hono';
import { z } from 'zod';
import { getDb, cuid, toDate } from '../db';
import { fail, ok, parseJson } from '../lib/api';

export const hiddenLinksApi = new Hono();

const CreateHiddenLinkSchema = z.object({ url: z.string().url() });

hiddenLinksApi.post('/', async (c) => {
  const parsed = await parseJson(c, CreateHiddenLinkSchema);
  if (!parsed.ok) return parsed.response;
  const db = getDb();
  db.prepare('INSERT INTO "HiddenLink" ("id", "url", "hiddenAt") VALUES (?, ?, ?) ON CONFLICT ("url") DO NOTHING').run(
    cuid(),
    parsed.data.url,
    Date.now(),
  );
  const row = db.prepare('SELECT * FROM "HiddenLink" WHERE "url" = ?').get(parsed.data.url) as {
    id: string;
    url: string;
    hiddenAt: number;
  };
  return ok(c, { id: row.id, url: row.url, hiddenAt: toDate(row.hiddenAt).toISOString() }, 201);
});

hiddenLinksApi.delete('/', (c) => {
  const url = c.req.query('url');
  if (!url) return fail(c, 'Missing url', 'VALIDATION_ERROR', 400);
  getDb().prepare('DELETE FROM "HiddenLink" WHERE "url" = ?').run(url);
  return ok(c, { url });
});
