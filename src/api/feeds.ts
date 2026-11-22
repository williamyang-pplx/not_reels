import { Hono, type Context } from 'hono';
import { getDb, cuid } from '../db';
import { fail, ok, parseJson } from '../lib/api';
import { CreateFeedSchema, TopicSchema, UpdateFeedSchema } from '../lib/validations';
import { refreshSingleFeed } from '../lib/feed-refresh';
import { inferFeedSourceKind } from '../lib/local-feeds/registry';
import { findUnknownTopics, unknownTopicsMessage } from '../lib/topics';
import { getFeed, listFeeds } from '../lib/queries';
import { canonicalYouTubeFeedUrl, YouTubeLookupError } from '../lib/youtube-api';
import { youTubeOptionsFromRow, youTubeOptionsFromSettings, youTubeSettingsFromOptions } from '../lib/youtube-feeds';

export const feedsApi = new Hono();

feedsApi.get('/', (c) => {
  const topic = c.req.query('topic');
  if (topic && topic !== 'ALL' && !TopicSchema.safeParse(topic).success) {
    return fail(c, 'Invalid topic', 'VALIDATION_ERROR', 400);
  }
  return ok(c, listFeeds({ topic }));
});

/** A YouTube channel URL in its stored form, or the Response to return. Null when the URL is not a channel URL. */
async function youTubeUrlOrFail(c: Context, url: string): Promise<{ url: string } | Response | null> {
  try {
    const canonical = await canonicalYouTubeFeedUrl(url);
    return canonical ? { url: canonical } : null;
  } catch (err) {
    if (err instanceof YouTubeLookupError) return fail(c, err.message, err.code, err.status);
    throw err;
  }
}

/** A YouTube setting as a SQLite boolean; null when the feed is not a YouTube one. */
const bit = (v: boolean | undefined) => (v === undefined ? null : v ? 1 : 0);

const feedUrlTaken = (url: string, exceptId = '') =>
  !!getDb().prepare('SELECT 1 FROM "Feed" WHERE "url" = ? AND "id" != ?').get(url, exceptId);

feedsApi.post('/', async (c) => {
  const parsed = await parseJson(c, CreateFeedSchema);
  if (!parsed.ok) return parsed.response;
  const db = getDb();
  const { name, url, topics, startDate, endDate, includeShorts, recent, archive } = parsed.data;

  // Cheap checks first, so a request that fails anyway spends no YouTube quota on a handle lookup.
  const unknown = findUnknownTopics(topics);
  if (unknown.length > 0) return fail(c, unknownTopicsMessage(unknown), 'VALIDATION_ERROR', 400);
  if (feedUrlTaken(url)) return fail(c, 'Feed URL already exists', 'DUPLICATE', 409);

  const yt = await youTubeUrlOrFail(c, url);
  if (yt instanceof Response) return yt;
  const youTubeFields = [startDate, endDate, includeShorts, recent, archive].some((v) => v !== undefined);
  if (!yt && youTubeFields) {
    return fail(c, 'Only YouTube feeds take dates or Recent, Archive and Shorts settings', 'VALIDATION_ERROR', 400);
  }
  // Every form of a channel URL is stored as its /channel/ URL, so a channel is one feed.
  const feedUrl = yt?.url ?? url;
  if (feedUrl !== url && feedUrlTaken(feedUrl)) return fail(c, 'Feed URL already exists', 'DUPLICATE', 409);
  const options = yt
    ? youTubeOptionsFromSettings({
        recent: recent ?? true,
        archive: archive ?? true,
        includeShorts: includeShorts ?? false,
        startDate: startDate ?? null,
        endDate: endDate ?? null,
      })
    : null;

  const id = cuid();
  const now = Date.now();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO "Feed" ("id", "name", "url", "sourceKind", "isActive", "fetchErrorCount", "createdAt", "updatedAt",
         "publishedAfter", "publishedBefore", "includeShorts", "showRecent", "showArchive")
       VALUES (?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      name,
      feedUrl,
      inferFeedSourceKind(feedUrl),
      now,
      now,
      options?.publishedAfter ?? null,
      options?.publishedBefore ?? null,
      bit(options?.includeShorts),
      bit(options?.recent),
      bit(options?.archive),
    );
    const link = db.prepare('INSERT OR IGNORE INTO "FeedTopic" ("feedId", "topicSlug") VALUES (?, ?)');
    for (const slug of topics) link.run(id, slug);
  })();

  // Immediate first fetch (best-effort; failures are only logged). For a YouTube channel it also starts the archive fill.
  try {
    await refreshSingleFeed(id);
  } catch (err) {
    console.error('[POST /api/feeds] initial fetch failed', err);
  }

  return ok(c, getFeed(id), 201);
});

interface FeedRow {
  url: string;
  sourceKind: string;
  publishedAfter: number | null;
  publishedBefore: number | null;
  includeShorts: number | null;
  showRecent: number | null;
  showArchive: number | null;
}

feedsApi.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const parsed = await parseJson(c, UpdateFeedSchema);
  if (!parsed.ok) return parsed.response;
  const db = getDb();
  const row = db.prepare('SELECT * FROM "Feed" WHERE "id" = ?').get(id) as FeedRow | undefined;
  if (!row) return fail(c, 'Feed not found', 'NOT_FOUND', 404);

  const { topics, name, isActive, url, startDate, endDate, includeShorts, recent, archive } = parsed.data;
  if (topics) {
    const unknown = findUnknownTopics(topics);
    if (unknown.length > 0) return fail(c, unknownTopicsMessage(unknown), 'VALIDATION_ERROR', 400);
  }

  const touchesYouTube = [url, startDate, endDate, includeShorts, recent, archive].some((v) => v !== undefined);
  if (touchesYouTube && row.sourceKind !== 'YOUTUBE') {
    return fail(c, 'Only YouTube feeds take a channel URL, dates or Recent, Archive and Shorts settings', 'VALIDATION_ERROR', 400);
  }

  // The given fields replace the stored ones (null clears a date); compared as stored values, not day strings.
  // Checked before any handle lookup, so a request that fails anyway spends no quota.
  const current = youTubeOptionsFromRow(row);
  let next = current;
  if (touchesYouTube) {
    const stored = youTubeSettingsFromOptions(current);
    next = youTubeOptionsFromSettings({
      recent: recent ?? current.recent,
      archive: archive ?? current.archive,
      includeShorts: includeShorts ?? current.includeShorts,
      startDate: startDate === undefined ? stored.startDate : startDate,
      endDate: endDate === undefined ? stored.endDate : endDate,
    });
    if (next.publishedAfter !== null && next.publishedBefore !== null && next.publishedBefore <= next.publishedAfter) {
      return fail(c, 'End date is before start date', 'VALIDATION_ERROR', 400);
    }
    if (!next.recent && !next.archive) return fail(c, 'Turn on Recent or Archive', 'VALIDATION_ERROR', 400);
  }

  let feedUrl = row.url;
  if (url !== undefined && url !== row.url) {
    const yt = await youTubeUrlOrFail(c, url);
    if (yt instanceof Response) return yt;
    if (!yt) return fail(c, 'YouTube feeds must be a channel URL, like https://www.youtube.com/@name', 'VALIDATION_ERROR', 400);
    if (feedUrlTaken(yt.url, id)) return fail(c, 'Feed URL already exists', 'DUPLICATE', 409);
    feedUrl = yt.url;
  }

  const changed =
    feedUrl !== row.url ||
    next.recent !== current.recent ||
    next.archive !== current.archive ||
    next.publishedAfter !== current.publishedAfter ||
    next.publishedBefore !== current.publishedBefore ||
    next.includeShorts !== current.includeShorts;

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
    if (changed) {
      sets.push('"url" = ?', '"publishedAfter" = ?', '"publishedBefore" = ?', '"includeShorts" = ?');
      sets.push('"showRecent" = ?', '"showArchive" = ?');
      args.push(feedUrl, next.publishedAfter, next.publishedBefore, bit(next.includeShorts), bit(next.recent), bit(next.archive));
    }
    if (sets.length > 0) {
      db.prepare(`UPDATE "Feed" SET ${sets.join(', ')}, "updatedAt" = ? WHERE "id" = ?`).run(...args, Date.now(), id);
    }
    // New settings: the old posts go (Saved and Hidden links are separate tables and stay).
    if (changed) db.prepare('DELETE FROM "FeedItem" WHERE "feedId" = ?').run(id);
    if (topics) {
      db.prepare('DELETE FROM "FeedTopic" WHERE "feedId" = ?').run(id);
      const link = db.prepare('INSERT OR IGNORE INTO "FeedTopic" ("feedId", "topicSlug") VALUES (?, ?)');
      for (const slug of topics) link.run(id, slug);
    }
  })();

  // The refetch also starts the archive fill when Archive is on and the channel is not filled yet.
  if (changed) {
    try {
      await refreshSingleFeed(id);
    } catch (err) {
      console.error('[PATCH /api/feeds] refetch failed', err);
    }
  }

  return ok(c, getFeed(id));
});

feedsApi.delete('/:id', (c) => {
  const id = c.req.param('id');
  const { changes } = getDb().prepare('DELETE FROM "Feed" WHERE "id" = ?').run(id);
  if (changes === 0) return fail(c, 'Feed not found', 'NOT_FOUND', 404);
  return ok(c, { id });
});
