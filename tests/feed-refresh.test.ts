import { describe, it, expect, beforeEach, vi } from 'vitest';
import { refreshSingleFeed, refreshAllFeeds, redditBackgroundPassDone } from '../src/lib/feed-refresh';
import type { ParsedFeed } from '../src/lib/rss-fetcher';
import { resetDb, createFeed, itemsOf, itemByGuid, countItems, feedRow } from './helpers';
import { MAX_ITEMS_PER_FEED } from '../src/lib/constants';
import { HttpStatusError } from '../src/lib/utils';

function fakeFetcher(items: Array<{ guid?: string; title?: string; link?: string; isoDate?: string }>): () => Promise<ParsedFeed> {
  return async () => ({ title: 'fake', items });
}

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

describe('refreshAllFeeds', () => {
  it('refreshes every active feed in one pass', async () => {
    const a = createFeed({ url: 'https://a.example' });
    const b = createFeed({ url: 'https://b.example' });
    const items = [{ guid: 'g', title: 'T', link: 'L', isoDate: '2026-04-14T10:00:00Z' }];
    const result = await refreshAllFeeds({ fetcher: fakeFetcher(items) });
    expect(result).toEqual({ refreshed: 2, newItems: 2, failed: 0, queued: 0 });
    expect(countItems(a.id)).toBe(1);
    expect(countItems(b.id)).toBe(1);
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

    expect(result).toEqual({ refreshed: 2, newItems: 2, failed: 0, queued: 0 });
    expect(countItems(rss.id)).toBe(1);
    expect(countItems(local.id)).toBe(1);
  });
});

describe('subreddit feeds in a full refresh', () => {
  const post = (sub: string, id: string) => ({
    guid: `t3_${id}`,
    title: `${sub} ${id}`,
    link: `https://www.reddit.com/r/${sub}/comments/${id}/slug/`,
    isoDate: '2026-04-14T10:00:00Z',
  });

  it('fetches every subreddit feed of one sort in a single multireddit request', async () => {
    const music = createFeed({ url: 'https://www.reddit.com/r/listentothis/hot.rss' });
    const tech = createFeed({ url: 'https://reddit.com/r/unixporn/hot.rss' });
    const other = createFeed({ url: 'https://other.example/feed.xml' });
    const urls: string[] = [];
    const fetcher = async (url: string): Promise<ParsedFeed> => {
      urls.push(url);
      if (url.includes('other.example')) return { items: [{ guid: 'o', title: 'O', link: 'https://other.example/o' }] };
      return {
        items: [post('unixporn', 'aaaaa'), post('ListenToThis', 'bbbbb'), post('unixporn', 'ccccc'), post('pics', 'ddddd')],
      };
    };

    const result = await refreshAllFeeds({ fetcher, redditIntervalMs: 0 });

    expect(result).toEqual({ refreshed: 3, newItems: 4, failed: 0, queued: 0 });
    expect(urls.filter((u) => u.includes('reddit.com'))).toEqual([
      'https://www.reddit.com/r/listentothis+unixporn/hot.rss?limit=100',
    ]);
    expect(itemsOf(music.id).map((i) => [i.guid, i.sourceRank])).toEqual([['t3_bbbbb', 0]]);
    expect(itemsOf(tech.id).map((i) => [i.guid, i.sourceRank])).toEqual([
      ['t3_aaaaa', 0],
      ['t3_ccccc', 1],
    ]);
    expect(countItems(other.id)).toBe(1);
  });

  it('fetches subreddit feeds with a query string on their own', async () => {
    createFeed({ url: 'https://www.reddit.com/r/unixporn/top.rss?t=week' });
    const urls: string[] = [];
    await refreshAllFeeds({ fetcher: async (url) => (urls.push(url), { items: [] }), redditIntervalMs: 0 });
    expect(urls).toEqual(['https://www.reddit.com/r/unixporn/top.rss?t=week']);
  });

  it('counts a failed multireddit request against every feed in it, without pausing them', async () => {
    const a = createFeed({ url: 'https://www.reddit.com/r/listentothis/hot.rss' });
    const b = createFeed({ url: 'https://www.reddit.com/r/unixporn/.rss' });
    const result = await refreshAllFeeds({
      fetcher: async () => {
        throw new Error('Status code 429');
      },
      redditIntervalMs: 0,
    });
    expect(result).toEqual({ refreshed: 0, newItems: 0, failed: 2, queued: 0 });
    for (const feed of [a, b]) {
      expect(feedRow(feed.id)).toMatchObject({ fetchErrorCount: 1, isActive: true });
    }
  });
});

describe('subreddit batches beyond the first', () => {
  const INTERVAL = 40;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const subs = Array.from({ length: 10 }, (_, i) => `sub${String(i).padStart(2, '0')}`);

  beforeEach(async () => {
    await redditBackgroundPassDone();
    await sleep(INTERVAL + 5); // let the Reddit slot from earlier tests expire
  });

  function recordingFetcher() {
    const calls: { url: string; at: number }[] = [];
    const fetcher = async (url: string): Promise<ParsedFeed> => {
      calls.push({ url, at: Date.now() });
      const inUrl = url.match(/\/r\/([^/]+)\//)?.[1].split('+') ?? [];
      return {
        items: inUrl.map((sub) => ({
          guid: `t3_${sub}`,
          title: sub,
          link: `https://www.reddit.com/r/${sub}/comments/abcde/x/`,
        })),
      };
    };
    return { calls, fetcher };
  }

  it('sends 8 subreddits per request, then the rest in the background after the interval', async () => {
    const feeds = subs.map((sub) => createFeed({ url: `https://www.reddit.com/r/${sub}/hot.rss` }));
    const { calls, fetcher } = recordingFetcher();

    const result = await refreshAllFeeds({ fetcher, redditIntervalMs: INTERVAL });

    expect(result).toEqual({ refreshed: 8, newItems: 8, failed: 0, queued: 2 });
    expect(calls.map((c) => c.url)).toEqual([`https://www.reddit.com/r/${subs.slice(0, 8).join('+')}/hot.rss?limit=100`]);
    expect(countItems(feeds[9].id)).toBe(0);

    await redditBackgroundPassDone();
    expect(calls.map((c) => c.url)).toEqual([
      `https://www.reddit.com/r/${subs.slice(0, 8).join('+')}/hot.rss?limit=100`,
      `https://www.reddit.com/r/${subs.slice(8).join('+')}/hot.rss?limit=100`,
    ]);
    expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(INTERVAL - 5);
    expect(feeds.map((f) => countItems(f.id))).toEqual(subs.map(() => 1));
  });

  it('retries a batch that got a 429 once, in the background', async () => {
    const a = createFeed({ url: 'https://www.reddit.com/r/sub00/hot.rss' });
    const { calls, fetcher } = recordingFetcher();
    let first = true;
    const limitedOnce = async (url: string) => {
      if (first) {
        first = false;
        calls.push({ url, at: Date.now() });
        throw new HttpStatusError(429);
      }
      return fetcher(url);
    };

    const result = await refreshAllFeeds({ fetcher: limitedOnce, redditIntervalMs: INTERVAL });
    expect(result).toEqual({ refreshed: 0, newItems: 0, failed: 0, queued: 1 });

    await redditBackgroundPassDone();
    expect(calls).toHaveLength(2);
    expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(INTERVAL - 5);
    expect(feedRow(a.id)).toMatchObject({ fetchErrorCount: 0 });
    expect(countItems(a.id)).toBe(1);
  });

  it('records the failure when the retry gets a 429 too', async () => {
    const a = createFeed({ url: 'https://www.reddit.com/r/sub00/hot.rss' });
    let calls = 0;
    const alwaysLimited = async (): Promise<ParsedFeed> => {
      calls += 1;
      throw new HttpStatusError(429);
    };

    await refreshAllFeeds({ fetcher: alwaysLimited, redditIntervalMs: INTERVAL });
    await redditBackgroundPassDone();

    expect(calls).toBe(2);
    expect(feedRow(a.id)).toMatchObject({ fetchErrorCount: 1, isActive: true });
  });

  it('leaves subreddit feeds to a background pass that is still running', async () => {
    subs.forEach((sub) => createFeed({ url: `https://www.reddit.com/r/${sub}/hot.rss` }));
    const { calls, fetcher } = recordingFetcher();

    await refreshAllFeeds({ fetcher, redditIntervalMs: INTERVAL });
    const second = await refreshAllFeeds({ fetcher, redditIntervalMs: INTERVAL });

    expect(second).toEqual({ refreshed: 0, newItems: 0, failed: 0, queued: 10 });
    await redditBackgroundPassDone();
    expect(calls).toHaveLength(2);
  });

  it('queues every batch when Reddit was called within the interval', async () => {
    const single = createFeed({ url: 'https://www.reddit.com/r/solo/hot.rss' });
    const { calls, fetcher } = recordingFetcher();
    await refreshSingleFeed(single.id, { fetcher, redditIntervalMs: INTERVAL });

    const result = await refreshAllFeeds({ fetcher, redditIntervalMs: INTERVAL });

    expect(result).toEqual({ refreshed: 0, newItems: 0, failed: 0, queued: 1 });
    await redditBackgroundPassDone();
    expect(calls).toHaveLength(2);
    expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(INTERVAL - 5);
  });
});
