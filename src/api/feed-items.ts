import { Hono } from 'hono';
import { getDb } from '../db';
import { fail, ok, parseJson } from '../lib/api';
import { FeedTypeSchema, RefreshBodySchema, TopicSchema } from '../lib/validations';
import { PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX } from '../lib/constants';
import { listFeedItems, type FeedItemsQuery } from '../lib/queries';
import { refreshAllFeeds, refreshSingleFeed } from '../lib/feed-refresh';
import type { SortOrder } from '../lib/types';

export const feedItemsApi = new Hono();

const SORTS: readonly SortOrder[] = ['recommended', 'new', 'random'];

/**
 * Validate the feed-items query string exactly like the reference route (spec §4.4).
 * Returns the parsed query or an error message.
 */
export function parseFeedItemsQuery(params: Record<string, string | undefined>): FeedItemsQuery | { error: string } {
  const sort = (params.sort ?? 'recommended') as SortOrder;
  if (!SORTS.includes(sort)) return { error: 'Invalid sort' };

  let limit = PAGE_SIZE_DEFAULT;
  if (params.limit) {
    const n = Number.parseInt(params.limit, 10);
    if (!Number.isFinite(n) || n < 1) return { error: 'Invalid limit' };
    limit = Math.min(n, PAGE_SIZE_MAX);
  }

  if (params.type === 'SAVED') return { type: 'SAVED', sort, limit };

  const q: FeedItemsQuery = { sort, limit };
  if (params.type) {
    const t = FeedTypeSchema.safeParse(params.type);
    if (!t.success) return { error: 'Invalid type' };
    q.type = t.data;
  }
  if (params.topic && params.topic !== 'ALL') {
    const t = TopicSchema.safeParse(params.topic);
    if (!t.success) return { error: 'Invalid topic' };
    q.topic = t.data;
  }
  if (sort === 'new' && params.cursor) {
    const cursor = new Date(params.cursor);
    if (Number.isNaN(cursor.getTime())) return { error: 'Invalid cursor' };
    q.cursor = cursor;
  }
  return q;
}

feedItemsApi.get('/', (c) => {
  const q = parseFeedItemsQuery(c.req.query());
  if ('error' in q) return fail(c, q.error, 'VALIDATION_ERROR', 400);
  return ok(c, listFeedItems(q));
});

feedItemsApi.post('/refresh', async (c) => {
  const parsed = await parseJson(c, RefreshBodySchema);
  if (!parsed.ok) return parsed.response;

  const { feedId } = parsed.data;
  if (feedId) {
    if (!getDb().prepare('SELECT 1 FROM "Feed" WHERE "id" = ?').get(feedId)) {
      return fail(c, 'Feed not found', 'NOT_FOUND', 404);
    }
    const r = await refreshSingleFeed(feedId);
    return ok(c, { refreshed: r.ok ? 1 : 0, newItems: r.newItems, failed: r.ok ? 0 : 1 });
  }
  return ok(c, await refreshAllFeeds());
});
