import pLimit from 'p-limit';
import { getDb, cuid } from '../db';
import type { FeedFetcher, NormalizedItem } from './rss-fetcher';
import {
  FETCH_CONCURRENCY,
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
import { fetchSubredditItems, parseSubredditFeedUrl, type PageFetcher } from './reddit-feeds';
import type { FeedSourceKind } from './types';
import { HttpStatusError } from './utils';
import { redlibUrl } from '../redlib';

export interface RefreshResult {
  refreshed: number;
  newItems: number;
  failed: number;
}

export interface FeedRefreshResult {
  newItems: number;
  ok: boolean;
}

export interface RefreshOptions {
  fetcher?: FeedFetcher;
  /** HTML fetch for Redlib listing pages (tests stub it). */
  pageFetcher?: PageFetcher;
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
    INSERT INTO "FeedItem" ("id", "feedId", "guid", "title", "link", "summary", "author", "publishedAt", "sourceRank", "fetchedAt", "media")
    VALUES (@id, @feedId, @guid, @title, @link, @summary, @author, @publishedAt, @sourceRank, @fetchedAt, @media)
    ON CONFLICT ("feedId", "guid") DO UPDATE SET
      "title" = excluded."title", "link" = excluded."link", "summary" = excluded."summary",
      "author" = excluded."author", "publishedAt" = excluded."publishedAt", "sourceRank" = excluded."sourceRank",
      "media" = excluded."media"`);
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
      media: it.media ?? null,
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
  if (sourceKind === 'RSS' || sourceKind === 'LOCAL' || sourceKind === 'REDDIT') return sourceKind;
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

  if (sourceKind === 'REDDIT') {
    const base = redlibUrl();
    if (!base) throw new Error('REDLIB_URL is not set');
    const sub = parseSubredditFeedUrl(feed.url);
    if (!sub) throw new Error(`Invalid subreddit URL: ${feed.url}`);
    return fetchSubredditItems(sub, base, fetcher, options.pageFetcher ?? defaultPageFetcher, now);
  }

  const parsed = await fetcher(feed.url);
  return normalizeAll(parsed.items, now);
}

/** GET a Redlib page as text with a 10 s timeout; non-2xx throws HttpStatusError, like defaultFetcher. */
async function defaultPageFetcher(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new HttpStatusError(res.status);
  return res.text();
}

function loadFeed(feedId: string): FeedRecord | undefined {
  return getDb().prepare('SELECT * FROM "Feed" WHERE "id" = ?').get(feedId) as FeedRecord | undefined;
}

/** Upsert, reset the error count and prune, in one transaction. Returns the number of new items. */
function storeItems(feed: FeedRecord, items: NormalizedItem[]): number {
  const db = getDb();
  return db.transaction(() => {
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
}

/** Count the failure. A failing feed stays active: only the user pauses feeds. */
function recordFailure(feed: FeedRecord, err: unknown): FeedRefreshResult {
  getDb()
    .prepare('UPDATE "Feed" SET "fetchErrorCount" = "fetchErrorCount" + 1, "updatedAt" = ? WHERE "id" = ?')
    .run(Date.now(), feed.id);
  console.error(`[feed-refresh] failed feed=${feed.id} url=${feed.url}:`, err);
  return { newItems: 0, ok: false };
}

async function refreshLoadedFeed(feed: FeedRecord, options: RefreshOptions): Promise<FeedRefreshResult> {
  try {
    const items = await fetchNormalizedItems(feed, options);
    return { newItems: storeItems(feed, items), ok: true };
  } catch (err) {
    return recordFailure(feed, err);
  }
}

export async function refreshSingleFeed(feedId: string, options: RefreshOptions = {}): Promise<FeedRefreshResult> {
  const feed = loadFeed(feedId);
  if (!feed) return { newItems: 0, ok: false };
  return refreshLoadedFeed(feed, options);
}

/**
 * Refresh every active feed. RSS and LOCAL feeds share one p-limit pool; REDDIT feeds run one at a time in their
 * own pool (each is 2 Redlib requests, so Redlib asks Reddit for one subreddit at a time). A per-feed refresh from
 * Manage is not pooled.
 */
export async function refreshAllFeeds(options: RefreshOptions = {}): Promise<RefreshResult> {
  const limit = pLimit(options.concurrency ?? FETCH_CONCURRENCY);
  const redditLimit = pLimit(1);
  const feeds = getDb().prepare('SELECT * FROM "Feed" WHERE "isActive" = 1').all() as FeedRecord[];
  const results = await Promise.all(
    feeds.map((feed) => (feed.sourceKind === 'REDDIT' ? redditLimit : limit)(() => refreshLoadedFeed(feed, options))),
  );
  return results.reduce<RefreshResult>(
    (acc, r) => ({
      refreshed: acc.refreshed + (r.ok ? 1 : 0),
      newItems: acc.newItems + r.newItems,
      failed: acc.failed + (r.ok ? 0 : 1),
    }),
    { refreshed: 0, newItems: 0, failed: 0 },
  );
}
