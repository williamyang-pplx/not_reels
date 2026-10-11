import { describe, it, expect, beforeEach, vi } from 'vitest';
import { refreshSingleFeed, refreshFeeds, refreshAllFeeds } from '../src/lib/feed-refresh';
import type { ParsedFeed } from '../src/lib/rss-fetcher';
import { resetDb, createFeed, itemsOf, itemByGuid, countItems, feedRow } from './helpers';
import { FETCH_ERROR_THRESHOLD, MAX_ITEMS_PER_FEED } from '../src/lib/constants';

function fakeFetcher(items: Array<{ guid?: string; title?: string; link?: string; isoDate?: string }>): () => Promise<ParsedFeed> {
  return async () => ({ title: 'fake', items });
}

beforeEach(() => {
  resetDb();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('refreshSingleFeed', () => {
  it('upserts new items and updates lastFetched', async () => {
    const feed = createFeed({ type: 'BLOG' });
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
    const feed = createFeed({ type: 'BLOG' });
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

  it('disables feed after FETCH_ERROR_THRESHOLD failures', async () => {
    const feed = createFeed();
    const broken = async (): Promise<ParsedFeed> => { throw new Error('boom'); };
    for (let i = 0; i < FETCH_ERROR_THRESHOLD; i++) {
      await refreshSingleFeed(feed.id, { fetcher: broken });
    }
    const updated = feedRow(feed.id);
    expect(updated?.fetchErrorCount).toBe(FETCH_ERROR_THRESHOLD);
    expect(updated?.isActive).toBe(false);
  });

  it('prunes forum feeds above MAX_ITEMS_PER_FEED', async () => {
    const feed = createFeed({ type: 'FORUM' });
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

  it('prunes blog feeds above MAX_ITEMS_PER_FEED', async () => {
    const feed = createFeed({ type: 'BLOG' });
    const total = MAX_ITEMS_PER_FEED + 3;
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
    const feed = createFeed({ type: 'FORUM' });
    const items = Array.from({ length: MAX_ITEMS_PER_FEED + 5 }, (_, i) => ({
      guid: `g${i}`,
      title: `T${i}`,
      link: `L${i}`,
      isoDate: new Date(2026, 0, 1, 0, i).toISOString(),
    }));
    await refreshSingleFeed(feed.id, { fetcher: fakeFetcher(items) });
    expect(itemsOf(feed.id).map((i) => i.guid)).toEqual(items.slice(0, MAX_ITEMS_PER_FEED).map((i) => i.guid));
  });

  it('prunes the RYM feed to 30 items instead of 15', async () => {
    const feed = createFeed({ type: 'BLOG', url: 'local/rym_music_recs', sourceKind: 'LOCAL', topic: 'MUSIC' });
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
      type: 'BLOG',
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

describe('refreshFeeds (by type)', () => {
  it('only refreshes feeds of the given type', async () => {
    const forum = createFeed({ type: 'FORUM', url: 'https://f.example' });
    const blog = createFeed({ type: 'BLOG', url: 'https://b.example' });
    const items = [{ guid: 'g', title: 'T', link: 'L', isoDate: '2026-04-14T10:00:00Z' }];
    const result = await refreshFeeds('FORUM', { fetcher: fakeFetcher(items) });
    expect(result.refreshed).toBe(1);
    expect(countItems(forum.id)).toBe(1);
    expect(countItems(blog.id)).toBe(0);
  });

  it('skips inactive feeds', async () => {
    const feed = createFeed({ type: 'BLOG', isActive: false });
    const result = await refreshFeeds('BLOG', {
      fetcher: fakeFetcher([{ guid: 'g', title: 'T', link: 'L' }]),
    });
    expect(result.refreshed).toBe(0);
    expect(countItems(feed.id)).toBe(0);
  });

  it('counts failures separately from successes', async () => {
    createFeed({ type: 'BLOG', url: 'https://ok.example' });
    createFeed({ type: 'BLOG', url: 'https://bad.example' });
    let calls = 0;
    const mixed = async (): Promise<ParsedFeed> => {
      calls += 1;
      if (calls === 1) return { items: [{ guid: 'g', title: 'T', link: 'L' }] };
      throw new Error('bad');
    };
    const result = await refreshFeeds('BLOG', { fetcher: mixed, concurrency: 1 });
    expect(result.refreshed).toBe(1);
    expect(result.failed).toBe(1);
  });

  it('refreshes RSS and local feeds across all feed types', async () => {
    const rss = createFeed({ type: 'FORUM', url: 'https://rss.example/feed.xml' });
    const local = createFeed({
      type: 'BLOG',
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
