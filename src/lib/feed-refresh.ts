import pLimit from 'p-limit';
import { getDb, cuid } from '../db';
import type { FeedFetcher, NormalizedItem } from './rss-fetcher';
import {
  FETCH_CONCURRENCY,
  FETCH_ERROR_THRESHOLD,
  MAX_ITEMS_PER_FEED,
  RYM_FEED_URL,
  RYM_ITEMS_PER_REFRESH,
  STALE_SOURCE_RANK,
} from './constants';
import { normalizeLocalFeedItems } from './local-feeds/normalize';
import {
  getLocalFeedProvider,
  parseLocalFeedUrl,
  type LocalFeedProviderRegistry,
} from './local-feeds/registry';
import type { FeedSourceKind } from './types';

export interface RefreshResult {
  refreshed: number;
  newItems: number;
  failed: number;
}

export interface RefreshOptions {
  fetcher?: FeedFetcher;
  localProviders?: LocalFeedProviderRegistry;
  concurrency?: number;
}

interface FeedRecord {
  id: string;
  name: string;
  url: string;
  sourceKind: string;
  isActive: number;
  fetchErrorCount: number;
}

/** Upsert on (feedId, guid), mark unseen items stale, return the number of new rows. */
function upsertItems(feedId: string, items: NormalizedItem[]): number {
  if (items.length === 0) return 0;
  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO "FeedItem" ("id", "feedId", "guid", "title", "link", "summary", "author", "publishedAt", "sourceRank", "fetchedAt")
    VALUES (@id, @feedId, @guid, @title, @link, @summary, @author, @publishedAt, @sourceRank, @fetchedAt)
    ON CONFLICT ("feedId", "guid") DO UPDATE SET
      "title" = excluded."title", "link" = excluded."link", "summary" = excluded."summary",
      "author" = excluded."author", "publishedAt" = excluded."publishedAt", "sourceRank" = excluded."sourceRank"`);
  const guids = Array.from(new Set(items.map((i) => i.guid)));
  const placeholders = guids.map(() => '?').join(',');
  const existing = new Set(
    (db.prepare(`SELECT "guid" FROM "FeedItem" WHERE "feedId" = ? AND "guid" IN (${placeholders})`).all(feedId, ...guids) as {
      guid: string;
    }[]).map((r) => r.guid),
  );
  let inserted = 0;
  const now = Date.now();
  for (const it of items) {
    if (!existing.has(it.guid)) inserted += 1;
    upsert.run({
      id: cuid(),
      feedId,
      guid: it.guid,
      title: it.title,
      link: it.link,
      summary: it.summary,
      author: it.author,
      publishedAt: it.publishedAt.getTime(),
      sourceRank: it.sourceRank,
      fetchedAt: now,
    });
  }
  db.prepare(
    `UPDATE "FeedItem" SET "sourceRank" = ? WHERE "feedId" = ? AND "guid" NOT IN (${placeholders})`,
  ).run(STALE_SOURCE_RANK, feedId, ...guids);
  return inserted;
}

/** Keep the top `keep` items by (sourceRank asc, publishedAt desc); delete the rest. */
function pruneFeed(feedId: string, keep: number): void {
  getDb()
    .prepare(
      `DELETE FROM "FeedItem" WHERE "feedId" = ? AND "id" NOT IN (
         SELECT "id" FROM "FeedItem" WHERE "feedId" = ? ORDER BY "sourceRank" ASC, "publishedAt" DESC LIMIT ?)`,
    )
    .run(feedId, feedId, keep);
}

function pruneLimitForFeed(feed: { url: string }): number {
  return feed.url === RYM_FEED_URL ? RYM_ITEMS_PER_REFRESH : MAX_ITEMS_PER_FEED;
}

function resolveFeedSourceKind(sourceKind: string): FeedSourceKind {
  if (sourceKind === 'RSS' || sourceKind === 'LOCAL') return sourceKind;
  throw new Error(`Unsupported feed source kind: ${sourceKind}`);
}

async function fetchNormalizedItems(feed: FeedRecord, options: RefreshOptions): Promise<NormalizedItem[]> {
  const sourceKind = resolveFeedSourceKind(feed.sourceKind);
  const now = new Date();

  if (sourceKind === 'LOCAL') {
    const providerId = parseLocalFeedUrl(feed.url);
    if (!providerId) throw new Error(`Invalid local feed URL: ${feed.url}`);
    const provider = getLocalFeedProvider(providerId, options.localProviders);
    if (!provider) throw new Error(`Unknown local feed provider: ${providerId}`);
    const items = await provider({
      feed: { id: feed.id, name: feed.name, url: feed.url, sourceKind },
      now,
    });
    return normalizeLocalFeedItems(items, now);
  }

  // rss-parser (and xml2js) load lazily so they stay off the cold-start path.
  const { defaultFetcher, normalizeAll } = await import('./rss-fetcher');
  const fetcher = options.fetcher ?? defaultFetcher;
  const parsed = await fetcher(feed.url);
  return normalizeAll(parsed.items, now);
}

export async function refreshSingleFeed(
  feedId: string,
  options: RefreshOptions = {},
): Promise<{ newItems: number; ok: boolean }> {
  const db = getDb();
  const feed = db.prepare('SELECT * FROM "Feed" WHERE "id" = ?').get(feedId) as FeedRecord | undefined;
  if (!feed) return { newItems: 0, ok: false };

  try {
    const items = await fetchNormalizedItems(feed, options);
    const inserted = db.transaction(() => {
      const n = upsertItems(feed.id, items);
      const now = Date.now();
      db.prepare('UPDATE "Feed" SET "lastFetched" = ?, "fetchErrorCount" = 0, "updatedAt" = ? WHERE "id" = ?').run(
        now,
        now,
        feed.id,
      );
      pruneFeed(feed.id, pruneLimitForFeed(feed));
      return n;
    })();
    return { newItems: inserted, ok: true };
  } catch (err) {
    const errorCount = feed.fetchErrorCount + 1;
    const isActive = errorCount >= FETCH_ERROR_THRESHOLD ? 0 : feed.isActive;
    db.prepare('UPDATE "Feed" SET "fetchErrorCount" = ?, "isActive" = ?, "updatedAt" = ? WHERE "id" = ?').run(
      errorCount,
      isActive,
      Date.now(),
      feed.id,
    );
    console.error(`[feed-refresh] failed feed=${feed.id} url=${feed.url}:`, err);
    return { newItems: 0, ok: false };
  }
}

/** Refresh every active feed through one p-limit pool. */
export async function refreshAllFeeds(options: RefreshOptions = {}): Promise<RefreshResult> {
  const limit = pLimit(options.concurrency ?? FETCH_CONCURRENCY);
  const feeds = getDb().prepare('SELECT "id" FROM "Feed" WHERE "isActive" = 1').all() as { id: string }[];

  const results = await Promise.all(feeds.map((f) => limit(() => refreshSingleFeed(f.id, options))));

  return results.reduce<RefreshResult>(
    (acc, r) => ({
      refreshed: acc.refreshed + (r.ok ? 1 : 0),
      newItems: acc.newItems + r.newItems,
      failed: acc.failed + (r.ok ? 0 : 1),
    }),
    { refreshed: 0, newItems: 0, failed: 0 },
  );
}
