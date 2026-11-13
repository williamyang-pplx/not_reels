import pLimit from 'p-limit';
import { getDb, cuid } from '../db';
import type { FeedFetcher, NormalizedItem, RawRssItem } from './rss-fetcher';
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
import { detectEmbedKind } from './embed';
import {
  REDDIT_REQUEST_INTERVAL_MS,
  chunkSubreddits,
  groupItemsBySubreddit,
  msUntilNextRedditRequest,
  multiredditFeedUrl,
  noteRedditRequest,
  parseSubredditFeedUrl,
} from './reddit-feeds';
import type { FeedSourceKind } from './types';

export interface RefreshResult {
  refreshed: number;
  newItems: number;
  failed: number;
  /** Subreddit feeds left to the background Reddit pass. */
  queued: number;
}

export interface FeedRefreshResult {
  newItems: number;
  ok: boolean;
}

export interface RefreshOptions {
  fetcher?: FeedFetcher;
  localProviders?: LocalFeedProviderRegistry;
  concurrency?: number;
  /** Gap between Reddit requests in a pass (tests shorten it). */
  redditIntervalMs?: number;
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
  if (feed.sourceKind === 'RSS' && detectEmbedKind(feed.url) === 'reddit') noteRedditRequest();
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

interface SubredditBatch {
  sort: string;
  subreddits: string[];
  feeds: { feed: FeedRecord; subreddit: string }[];
}

/** A batch gets this many requests if Reddit answers 429 (a fresh process does not know the spent budget). */
const MAX_BATCH_ATTEMPTS = 2;

function isRateLimited(err: unknown): boolean {
  return (err as { status?: unknown } | null)?.status === 429;
}

/**
 * One multireddit request for the feeds of one batch (see reddit-feeds.ts). Returns null, without
 * recording failures, when Reddit answered 429 and the batch has attempts left.
 */
async function refreshSubredditBatch(
  batch: SubredditBatch,
  attempt: number,
  options: RefreshOptions,
): Promise<FeedRefreshResult[] | null> {
  const { defaultFetcher, normalizeAll } = await import('./rss-fetcher');
  const fetcher = options.fetcher ?? defaultFetcher;
  let groups: Map<string, RawRssItem[]>;
  noteRedditRequest();
  try {
    const parsed = await fetcher(multiredditFeedUrl(batch.subreddits, batch.sort));
    groups = groupItemsBySubreddit(parsed.items);
  } catch (err) {
    if (isRateLimited(err) && attempt < MAX_BATCH_ATTEMPTS) return null;
    return batch.feeds.map(({ feed }) => recordFailure(feed, err));
  }
  const now = new Date();
  return batch.feeds.map(({ feed, subreddit }) => {
    try {
      return { newItems: storeItems(feed, normalizeAll(groups.get(subreddit) ?? [], now)), ok: true };
    } catch (err) {
      return recordFailure(feed, err);
    }
  });
}

/** Split feeds into the ones fetched on their own and the subreddit batches (one sort and ≤ 8 subreddits each). */
function planRefresh(feeds: FeedRecord[]): { singles: FeedRecord[]; batches: SubredditBatch[] } {
  const singles: FeedRecord[] = [];
  const bySort = new Map<string, { feed: FeedRecord; subreddit: string }[]>();
  for (const feed of feeds) {
    const subredditFeed = feed.sourceKind === 'RSS' ? parseSubredditFeedUrl(feed.url) : null;
    if (!subredditFeed) {
      singles.push(feed);
      continue;
    }
    const group = bySort.get(subredditFeed.sort) ?? [];
    group.push({ feed, subreddit: subredditFeed.subreddit });
    bySort.set(subredditFeed.sort, group);
  }
  const batches: SubredditBatch[] = [];
  for (const [sort, group] of bySort) {
    for (const subreddits of chunkSubreddits(group.map((g) => g.subreddit))) {
      batches.push({ sort, subreddits, feeds: group.filter((g) => subreddits.includes(g.subreddit)) });
    }
  }
  return { singles, batches };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// The pass over one refresh's subreddit batches. It outlives the HTTP request that started it.
let redditPass: Promise<void> | null = null;

/** Resolves when no Reddit pass is running. */
export function redditBackgroundPassDone(): Promise<void> {
  return redditPass ?? Promise.resolve();
}

async function waitForRedditSlot(intervalMs: number): Promise<void> {
  // Loop: a per-feed Reddit refresh during the wait moves the next free slot.
  for (let wait = msUntilNextRedditRequest(intervalMs); wait > 0; wait = msUntilNextRedditRequest(intervalMs)) {
    await sleep(wait);
  }
}

interface FirstBatchReport {
  results: FeedRefreshResult[];
  /** Feeds still waiting in the pass after the first batch. */
  queued: number;
}

/**
 * Run the batches one at a time, REDDIT_REQUEST_INTERVAL_MS after the last Reddit request. A batch that
 * gets a 429 goes to the back of the queue. The returned promise resolves after the first batch when no
 * Reddit request was made within the interval, else at once; the rest of the pass continues in the
 * background.
 */
function startRedditPass(batches: SubredditBatch[], options: RefreshOptions): Promise<FirstBatchReport> {
  const queue = batches.map((batch) => ({ batch, attempt: 0 }));
  const queuedFeeds = () => queue.reduce((n, e) => n + e.batch.feeds.length, 0);
  let report!: (r: FirstBatchReport) => void;
  const firstBatch = new Promise<FirstBatchReport>((resolve) => (report = resolve));
  const intervalMs = options.redditIntervalMs ?? REDDIT_REQUEST_INTERVAL_MS;
  let inline = msUntilNextRedditRequest(intervalMs) === 0;
  if (!inline) report({ results: [], queued: queuedFeeds() });

  redditPass = (async () => {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      if (!inline) await waitForRedditSlot(intervalMs);
      entry.attempt += 1;
      const results = await refreshSubredditBatch(entry.batch, entry.attempt, options);
      const label = `sort=${entry.batch.sort} subs=${entry.batch.subreddits.join('+')}`;
      if (results) {
        console.log(`[feed-refresh] reddit batch ${label} failed=${results.filter((r) => !r.ok).length}`);
      } else {
        console.warn(`[feed-refresh] reddit batch ${label} got 429, retrying after the interval`);
        queue.push(entry);
      }
      if (inline) {
        inline = false;
        report({ results: results ?? [], queued: queuedFeeds() });
      }
    }
  })()
    .catch((err) => console.error('[feed-refresh] reddit pass failed:', err))
    .finally(() => {
      redditPass = null;
      report({ results: [], queued: 0 }); // no-op unless the pass threw before the first report
    });
  return firstBatch;
}

/**
 * Refresh every active feed through one p-limit pool. Subreddit feeds go through one Reddit pass: the
 * request waits for its first batch when no Reddit request was made within the interval, and the rest
 * are counted in `queued`. While a pass runs, a new refresh leaves the subreddit feeds to it.
 */
export async function refreshAllFeeds(options: RefreshOptions = {}): Promise<RefreshResult> {
  const limit = pLimit(options.concurrency ?? FETCH_CONCURRENCY);
  const feeds = getDb().prepare('SELECT * FROM "Feed" WHERE "isActive" = 1').all() as FeedRecord[];
  const { singles, batches } = planRefresh(feeds);

  let reddit: Promise<FirstBatchReport>;
  if (batches.length === 0) reddit = Promise.resolve({ results: [], queued: 0 });
  else if (redditPass) reddit = Promise.resolve({ results: [], queued: batches.reduce((n, b) => n + b.feeds.length, 0) });
  else reddit = startRedditPass(batches, options);

  const [first, singleResults] = await Promise.all([
    reddit,
    Promise.all(singles.map((feed) => limit(() => refreshLoadedFeed(feed, options)))),
  ]);

  return [...first.results, ...singleResults].reduce<RefreshResult>(
    (acc, r) => ({
      ...acc,
      refreshed: acc.refreshed + (r.ok ? 1 : 0),
      newItems: acc.newItems + r.newItems,
      failed: acc.failed + (r.ok ? 0 : 1),
    }),
    { refreshed: 0, newItems: 0, failed: 0, queued: first.queued },
  );
}
