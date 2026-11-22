import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { refreshSingleFeed, refreshAllFeeds } from '../src/lib/feed-refresh';
import type { ParsedFeed } from '../src/lib/rss-fetcher';
import { resetDb, createFeed, itemsOf, itemByGuid, countItems, feedRow } from './helpers';
import { MAX_ITEMS_PER_FEED } from '../src/lib/constants';
import { LISTING_HTML, RSS_ITEMS } from './fixtures/redlib';
import { CHANNEL_ID, CHANNEL_URL, playlistPage, rssItem, seedVideos, video } from './fixtures/youtube';
import { getDb } from '../src/db';

function fakeFetcher(items: Array<{ guid?: string; title?: string; link?: string; isoDate?: string }>): () => Promise<ParsedFeed> {
  return async () => ({ title: 'fake', items });
}

const REDLIB = 'http://127.0.0.1:8180';
const savedRedlibUrl = process.env.REDLIB_URL;
afterEach(() => {
  if (savedRedlibUrl === undefined) delete process.env.REDLIB_URL;
  else process.env.REDLIB_URL = savedRedlibUrl;
});

beforeEach(() => {
  resetDb();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('refreshSingleFeed', () => {
  it('upserts new items and updates lastFetched', async () => {
    const feed = createFeed();
    const items = [
      { guid: 'a', title: 'A', link: 'https://x/a', isoDate: '2026-04-14T10:00:00Z' },
      { guid: 'b', title: 'B', link: 'https://x/b', isoDate: '2026-04-14T11:00:00Z' },
    ];
    const result = await refreshSingleFeed(feed.id, { fetcher: fakeFetcher(items) });
    expect(result.ok).toBe(true);
    expect(result.newItems).toBe(2);

    const stored = itemsOf(feed.id);
    expect(stored).toHaveLength(2);
    expect(stored.map((s) => s.guid).sort()).toEqual(['a', 'b']);

    const updated = feedRow(feed.id);
    expect(updated?.lastFetched).not.toBeNull();
    expect(updated?.fetchErrorCount).toBe(0);
  });

  it('is idempotent: re-running with same items inserts none', async () => {
    const feed = createFeed();
    const items = [{ guid: 'a', title: 'A', link: 'L', isoDate: '2026-04-14T10:00:00Z' }];
    await refreshSingleFeed(feed.id, { fetcher: fakeFetcher(items) });
    const result = await refreshSingleFeed(feed.id, { fetcher: fakeFetcher(items) });
    expect(result.newItems).toBe(0);
    const count = countItems(feed.id);
    expect(count).toBe(1);
  });

  it('increments fetchErrorCount on failure', async () => {
    const feed = createFeed();
    const broken = async (): Promise<ParsedFeed> => { throw new Error('boom'); };
    const r = await refreshSingleFeed(feed.id, { fetcher: broken });
    expect(r.ok).toBe(false);
    const updated = feedRow(feed.id);
    expect(updated?.fetchErrorCount).toBe(1);
    expect(updated?.isActive).toBe(true);
  });

  it('keeps a feed active however often it fails', async () => {
    const feed = createFeed();
    const broken = async (): Promise<ParsedFeed> => { throw new Error('boom'); };
    for (let i = 0; i < 8; i++) {
      await refreshSingleFeed(feed.id, { fetcher: broken });
    }
    const updated = feedRow(feed.id);
    expect(updated?.fetchErrorCount).toBe(8);
    expect(updated?.isActive).toBe(true);
  });

  it('prunes feeds above MAX_ITEMS_PER_FEED', async () => {
    const feed = createFeed();
    const total = MAX_ITEMS_PER_FEED + 5;
    const items = Array.from({ length: total }, (_, i) => ({
      guid: `g${i}`,
      title: `T${i}`,
      link: `L${i}`,
      isoDate: new Date(2026, 0, 1, 0, i).toISOString(),
    }));
    await refreshSingleFeed(feed.id, { fetcher: fakeFetcher(items) });
    const count = countItems(feed.id);
    expect(count).toBe(MAX_ITEMS_PER_FEED);
  });

  it('keeps the top-ranked items when pruning', async () => {
    const feed = createFeed();
    const items = Array.from({ length: MAX_ITEMS_PER_FEED + 5 }, (_, i) => ({
      guid: `g${i}`,
      title: `T${i}`,
      link: `L${i}`,
      isoDate: new Date(2026, 0, 1, 0, i).toISOString(),
    }));
    await refreshSingleFeed(feed.id, { fetcher: fakeFetcher(items) });
    expect(itemsOf(feed.id).map((i) => i.guid)).toEqual(items.slice(0, MAX_ITEMS_PER_FEED).map((i) => i.guid));
  });

  it('prunes the RYM feed to one batch of 30 albums', async () => {
    const feed = createFeed({ url: 'local/rym_music_recs', sourceKind: 'LOCAL', topic: 'MUSIC' });
    const r = await refreshSingleFeed(feed.id, {
      localProviders: {
        rym_music_recs: () =>
          Array.from({ length: 40 }, (_, i) => ({ guid: `rym-album-${i}`, title: `A${i}`, link: `https://rym.example/${i}` })),
      },
    });
    expect(r).toEqual({ ok: true, newItems: 40 });
    expect(countItems(feed.id)).toBe(30);
  });

  it('resets fetchErrorCount after a successful refresh', async () => {
    const feed = createFeed();
    const broken = async (): Promise<ParsedFeed> => { throw new Error('boom'); };
    await refreshSingleFeed(feed.id, { fetcher: broken });
    await refreshSingleFeed(feed.id, { fetcher: broken });
    expect(feedRow(feed.id)?.fetchErrorCount).toBe(2);
    await refreshSingleFeed(feed.id, { fetcher: fakeFetcher([{ guid: 'a', title: 'A', link: 'L' }]) });
    expect(feedRow(feed.id)?.fetchErrorCount).toBe(0);
  });

  it('refreshes a REDDIT feed from Redlib', async () => {
    process.env.REDLIB_URL = REDLIB;
    const feed = createFeed({ url: 'https://www.reddit.com/r/listentothis/', sourceKind: 'REDDIT' });
    const r = await refreshSingleFeed(feed.id, { fetcher: async () => ({ items: RSS_ITEMS }), pageFetcher: async () => LISTING_HTML });
    expect(r).toEqual({ newItems: 3, ok: true });
    const stored = itemByGuid(feed.id, '/r/listentothis/comments/1xwqj5c/neo_boys_rich_mans_dreams_punk_1980/')!;
    expect(stored.link).toBe('https://www.reddit.com/r/listentothis/comments/1xwqj5c/neo_boys_rich_mans_dreams_punk_1980/');
    expect(JSON.parse(stored.media!)).toMatchObject({ url: 'https://www.youtube.com/watch?v=OpG_9PRNzOA&list=x', comments: 1 });
  });

  it('increments fetchErrorCount when REDLIB_URL is unset', async () => {
    delete process.env.REDLIB_URL;
    const feed = createFeed({ url: 'https://www.reddit.com/r/listentothis/', sourceKind: 'REDDIT' });
    expect(await refreshSingleFeed(feed.id, { fetcher: async () => ({ items: RSS_ITEMS }) })).toEqual({ newItems: 0, ok: false });
    expect(feedRow(feed.id)?.fetchErrorCount).toBe(1);
  });

  it('returns ok:false when feed does not exist', async () => {
    const r = await refreshSingleFeed('does-not-exist');
    expect(r.ok).toBe(false);
  });

  it('updates fields when item content changes', async () => {
    const feed = createFeed();
    await refreshSingleFeed(feed.id, {
      fetcher: fakeFetcher([{ guid: 'g', title: 'old', link: 'L', isoDate: '2026-04-14T10:00:00Z' }]),
    });
    await refreshSingleFeed(feed.id, {
      fetcher: fakeFetcher([{ guid: 'g', title: 'new', link: 'L', isoDate: '2026-04-14T10:00:00Z' }]),
    });
    const item = itemByGuid(feed.id, 'g');
    expect(item?.title).toBe('new');
  });

  it('refreshes local feed providers and stores normalized items', async () => {
    const feed = createFeed({
      url: 'local/test_recs',
      sourceKind: 'LOCAL',
      topic: 'MUSIC',
    });
    let seenFeedUrl: string | null = null;

    const result = await refreshSingleFeed(feed.id, {
      localProviders: {
        test_recs: ({ feed: localFeed }) => {
          seenFeedUrl = localFeed.url;
          return [
            {
              guid: 'local-a',
              title: 'Local A',
              link: 'https://example.com/local-a',
              summary: 'Generated locally',
              author: 'local',
              publishedAt: '2026-04-14T12:00:00Z',
            },
            {
              guid: 'local-b',
              title: 'Local B',
              link: 'https://example.com/local-b',
              publishedAt: '2026-04-14T11:00:00Z',
            },
          ];
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.newItems).toBe(2);
    expect(seenFeedUrl).toBe('local/test_recs');

    const stored = itemsOf(feed.id).map(({ guid, summary, author, sourceRank }) => ({ guid, summary, author, sourceRank }));
    expect(stored).toEqual([
      { guid: 'local-a', summary: 'Generated locally', author: 'local', sourceRank: 0 },
      { guid: 'local-b', summary: null, author: null, sourceRank: 1 },
    ]);
  });

  it('increments fetchErrorCount when a local provider fails', async () => {
    const feed = createFeed({
      url: 'local/test_recs',
      sourceKind: 'LOCAL',
    });

    const result = await refreshSingleFeed(feed.id, {
      localProviders: {
        test_recs: () => {
          throw new Error('boom');
        },
      },
    });

    expect(result.ok).toBe(false);
    const updated = feedRow(feed.id);
    expect(updated?.fetchErrorCount).toBe(1);
  });

  it('stores and updates sourceRank based on feed order', async () => {
    const feed = createFeed();
    await refreshSingleFeed(feed.id, {
      fetcher: fakeFetcher([
        { guid: 'a', title: 'A', link: 'https://x/a', isoDate: '2026-04-14T10:00:00Z' },
        { guid: 'b', title: 'B', link: 'https://x/b', isoDate: '2026-04-14T09:00:00Z' },
        { guid: 'c', title: 'C', link: 'https://x/c', isoDate: '2026-04-14T08:00:00Z' },
      ]),
    });

    await refreshSingleFeed(feed.id, {
      fetcher: fakeFetcher([
        { guid: 'c', title: 'C', link: 'https://x/c', isoDate: '2026-04-14T08:00:00Z' },
        { guid: 'a', title: 'A', link: 'https://x/a', isoDate: '2026-04-14T10:00:00Z' },
        { guid: 'b', title: 'B', link: 'https://x/b', isoDate: '2026-04-14T09:00:00Z' },
      ]),
    });

    const ranked = itemsOf(feed.id);
    expect(ranked.map((x) => x.guid)).toEqual(['c', 'a', 'b']);
    expect(ranked.map((x) => x.sourceRank)).toEqual([0, 1, 2]);
  });

  it('demotes items that are no longer returned by the feed', async () => {
    const feed = createFeed();
    await refreshSingleFeed(feed.id, {
      fetcher: fakeFetcher([
        { guid: 'a', title: 'A', link: 'https://x/a', isoDate: '2026-04-14T10:00:00Z' },
        { guid: 'b', title: 'B', link: 'https://x/b', isoDate: '2026-04-14T09:00:00Z' },
      ]),
    });

    await refreshSingleFeed(feed.id, {
      fetcher: fakeFetcher([
        { guid: 'b', title: 'B', link: 'https://x/b', isoDate: '2026-04-14T09:00:00Z' },
      ]),
    });

    const itemA = itemByGuid(feed.id, 'a');
    const itemB = itemByGuid(feed.id, 'b');

    expect(itemB?.sourceRank).toBe(0);
    expect(itemA?.sourceRank).toBe(10_000);
  });
});

describe('refreshSingleFeed (YOUTUBE)', () => {
  const recent = Array.from({ length: 15 }, (_, i) =>
    rssItem(`r${String(i).padStart(10, '0')}`, new Date(Date.parse('2026-11-21T00:00:00Z') - i * 86_400_000).toISOString()),
  );
  const rss = async (): Promise<ParsedFeed> => ({ items: recent });
  // A filled channel: no fill starts, so these cases need no API stub.
  const filled = () =>
    getDb().prepare('INSERT INTO "YouTubeChannel" ("channelId", "filledAt") VALUES (?, 1)').run(CHANNEL_ID);
  const youTubeFeed = (overrides: Parameters<typeof createFeed>[0] = {}) =>
    createFeed({ url: CHANNEL_URL, sourceKind: 'YOUTUBE', ...overrides });
  const shownAt = (link: string) =>
    (getDb().prepare('SELECT "lastShownAt" FROM "YouTubeVideo" WHERE "videoId" = ?').get(link.slice(-11)) as
      | { lastShownAt: number | null }
      | undefined)?.lastShownAt ?? null;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('refreshes a YOUTUBE feed from its RSS feed and archive', async () => {
    filled();
    await seedVideos(CHANNEL_ID, 40);
    const feed = youTubeFeed();
    expect(await refreshSingleFeed(feed.id, { fetcher: rss })).toEqual({ newItems: 45, ok: true });
    const stored = itemsOf(feed.id);
    expect(stored).toHaveLength(45);
    expect(stored.slice(0, 2).map((i) => i.link.slice(-11, -10))).toEqual(['r', 'a']);
  });

  it('replaces a YOUTUBE feed’s archive batch on the next refresh with never-shown videos', async () => {
    filled();
    await seedVideos(CHANNEL_ID, 60);
    const feed = youTubeFeed({ showRecent: 0 });
    await refreshSingleFeed(feed.id, { fetcher: rss });
    const first = new Set(itemsOf(feed.id).map((i) => i.guid));
    await refreshSingleFeed(feed.id, { fetcher: rss });
    const second = itemsOf(feed.id).map((i) => i.guid);
    expect(second).toHaveLength(30);
    expect(second.some((g) => first.has(g))).toBe(false);
  });

  it('marks a YOUTUBE batch shown once it is stored', async () => {
    filled();
    await seedVideos(CHANNEL_ID, 5);
    const feed = youTubeFeed();
    await refreshSingleFeed(feed.id, { fetcher: rss });
    expect(itemsOf(feed.id).every((i) => shownAt(i.link) !== null)).toBe(true);
  });

  it('stores uploadedAt on a YOUTUBE post', async () => {
    filled();
    await seedVideos(CHANNEL_ID, 1, { newest: '2014-03-04T15:00:00Z' });
    const feed = youTubeFeed({ showRecent: 0 });
    await refreshSingleFeed(feed.id, { fetcher: rss });
    const [item] = itemsOf(feed.id) as (ReturnType<typeof itemsOf>[number] & { uploadedAt: number })[];
    expect(item.uploadedAt).toBe(Date.parse('2014-03-04T15:00:00Z'));
    expect(Number(item.publishedAt)).toBeGreaterThan(Date.parse('2026-01-01T00:00:00Z'));
  });

  it('starts the archive fill on a YOUTUBE refresh, and refreshes the feed when it finishes', async () => {
    vi.stubEnv('YOUTUBE_API_KEY', 'test-key');
    const feed = youTubeFeed({ showRecent: 0 });
    const uploads = playlistPage([video('f0000000000', '2012-05-01T00:00:00Z'), video('f0000000001', '2012-04-01T00:00:00Z')]);
    const youTubeFetcher = vi.fn(async (url: string) => {
      if (new URL(url).searchParams.get('playlistId')!.startsWith('UUSH')) throw new Error('YouTube API 404 playlistNotFound');
      return uploads;
    });
    expect(await refreshSingleFeed(feed.id, { fetcher: rss, youTubeFetcher })).toEqual({ newItems: 0, ok: true });
    const { settleYouTubeFills } = await import('../src/lib/youtube-archive');
    await settleYouTubeFills();
    expect(itemsOf(feed.id).map((i) => i.link.slice(-11))).toEqual(expect.arrayContaining(['f0000000000', 'f0000000001']));
    expect(youTubeFetcher).toHaveBeenCalledTimes(2);
    vi.unstubAllEnvs();
  });

  it('drops a YOUTUBE fetch whose settings changed while it ran, without marking anything shown', async () => {
    filled();
    const feed = youTubeFeed({ showArchive: 0 });
    const fetcher = async (): Promise<ParsedFeed> => {
      // An Edit lands mid-fetch: the range changes.
      getDb().prepare('UPDATE "Feed" SET "publishedAfter" = ? WHERE "id" = ?').run(Date.parse('2026-11-15T00:00:00Z'), feed.id);
      return { items: recent };
    };
    expect(await refreshSingleFeed(feed.id, { fetcher })).toEqual({ newItems: 0, ok: true });
    expect(countItems(feed.id)).toBe(0);
    expect(shownAt(recent[0].link)).toBeNull();
    expect(feedRow(feed.id)?.lastFetched).toBeNull();
  });
});

describe('refreshAllFeeds', () => {
  it('refreshes every active feed in one pass', async () => {
    const a = createFeed({ url: 'https://a.example' });
    const b = createFeed({ url: 'https://b.example' });
    const items = [{ guid: 'g', title: 'T', link: 'L', isoDate: '2026-04-14T10:00:00Z' }];
    const result = await refreshAllFeeds({ fetcher: fakeFetcher(items) });
    expect(result).toEqual({ refreshed: 2, newItems: 2, failed: 0 });
    expect(countItems(a.id)).toBe(1);
    expect(countItems(b.id)).toBe(1);
  });

  it('refreshes REDDIT feeds from Redlib, beside the RSS feeds', async () => {
    process.env.REDLIB_URL = REDLIB;
    const rss = createFeed({ url: 'https://a.example' });
    const reddit = createFeed({ url: 'https://www.reddit.com/r/listentothis/', sourceKind: 'REDDIT' });
    const urls: string[] = [];
    const items = [{ guid: 'g', title: 'T', link: 'L', isoDate: '2026-04-14T10:00:00Z' }];
    const result = await refreshAllFeeds({
      fetcher: async (url) => (urls.push(url), { title: 'fake', items: url.startsWith(REDLIB) ? RSS_ITEMS : items }),
      pageFetcher: async (url) => (urls.push(url), LISTING_HTML),
    });
    expect(result).toEqual({ refreshed: 2, newItems: 4, failed: 0 });
    expect(urls.sort()).toEqual([`${REDLIB}/r/listentothis/hot`, `${REDLIB}/r/listentothis/hot.rss`, 'https://a.example']);
    expect(countItems(rss.id)).toBe(1);
    expect(countItems(reddit.id)).toBe(3);
  });

  it('skips inactive feeds', async () => {
    const feed = createFeed({ isActive: false });
    const result = await refreshAllFeeds({
      fetcher: fakeFetcher([{ guid: 'g', title: 'T', link: 'L' }]),
    });
    expect(result.refreshed).toBe(0);
    expect(countItems(feed.id)).toBe(0);
  });

  it('counts failures separately from successes', async () => {
    createFeed({ url: 'https://ok.example' });
    createFeed({ url: 'https://bad.example' });
    let calls = 0;
    const mixed = async (): Promise<ParsedFeed> => {
      calls += 1;
      if (calls === 1) return { items: [{ guid: 'g', title: 'T', link: 'L' }] };
      throw new Error('bad');
    };
    const result = await refreshAllFeeds({ fetcher: mixed, concurrency: 1 });
    expect(result.refreshed).toBe(1);
    expect(result.failed).toBe(1);
  });

  it('refreshes RSS and local feeds', async () => {
    const rss = createFeed({ url: 'https://rss.example/feed.xml' });
    const local = createFeed({
      url: 'local/test_recs',
      sourceKind: 'LOCAL',
    });

    const result = await refreshAllFeeds({
      fetcher: fakeFetcher([
        {
          guid: 'rss-a',
          title: 'RSS A',
          link: 'https://example.com/rss-a',
          isoDate: '2026-04-14T10:00:00Z',
        },
      ]),
      localProviders: {
        test_recs: () => [
          {
            guid: 'local-a',
            title: 'Local A',
            link: 'https://example.com/local-a',
            publishedAt: '2026-04-14T11:00:00Z',
          },
        ],
      },
      concurrency: 1,
    });

    expect(result).toEqual({ refreshed: 2, newItems: 2, failed: 0 });
    expect(countItems(rss.id)).toBe(1);
    expect(countItems(local.id)).toBe(1);
  });
});

