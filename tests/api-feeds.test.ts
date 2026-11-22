import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { cuid, getDb } from '../src/db';
import { count, createFeed, feedRow, json, request, resetDb, seedItems } from './helpers';
import { CHANNEL_ID, CHANNEL_URL, seedVideos } from './fixtures/youtube';
import { refreshSingleFeed } from '../src/lib/feed-refresh';

vi.mock('../src/lib/feed-refresh', () => ({
  refreshSingleFeed: vi.fn(async () => ({ ok: true, newItems: 0 })),
  refreshAllFeeds: vi.fn(async () => ({ refreshed: 0, newItems: 0, failed: 0 })),
}));

beforeEach(() => {
  resetDb();
});

describe('GET /api/feeds', () => {
  it('returns empty list initially', async () => {
    const res = await request('/api/feeds');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data).toEqual([]);
  });

  it('ignores a legacy type param', async () => {
    createFeed({ url: 'https://a' });
    createFeed({ url: 'https://b' });
    const body = await request('/api/feeds?type=FORUM').then((r) => r.json());
    expect(body.data).toHaveLength(2);
    expect(body.data.every((f: object) => !('type' in f))).toBe(true);
  });

  it('filters by topic (single-topic feed)', async () => {
    createFeed({ topics: ['NEWS'], url: 'https://a' });
    createFeed({ topics: ['MUSIC'], url: 'https://b' });
    const body = await request('/api/feeds?topic=MUSIC').then((r) => r.json());
    expect(body.data).toHaveLength(1);
    expect(body.data[0].topics).toEqual(['MUSIC']);
  });

  it('filters by topic (multi-topic feed appears in each)', async () => {
    createFeed({ topics: ['NEWS', 'MUSIC'], url: 'https://multi' });
    createFeed({ topics: ['TECHNOLOGY'], url: 'https://tech' });
    const news = await request('/api/feeds?topic=NEWS').then((r) => r.json());
    const music = await request('/api/feeds?topic=MUSIC').then((r) => r.json());
    expect(news.data).toHaveLength(1);
    expect(music.data).toHaveLength(1);
    expect(news.data[0].url).toBe('https://multi');
    expect(music.data[0].url).toBe('https://multi');
  });

  it('treats topic=ALL as no filter and orders by createdAt desc', async () => {
    createFeed({ url: 'https://first' });
    createFeed({ url: 'https://second' });
    const body = await request('/api/feeds?topic=ALL').then((r) => r.json());
    expect(body.data.map((f: { url: string }) => f.url)).toEqual(['https://second', 'https://first']);
  });
});

describe('POST /api/feeds', () => {
  it('creates a feed and returns it', async () => {
    const res = await json('POST', '/api/feeds', {
      name: 'HN',
      url: 'https://news.ycombinator.com/rss',
      topics: ['TECHNOLOGY'],
    });
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.data.name).toBe('HN');
    expect(body.data.sourceKind).toBe('RSS');
    expect(body.data.topics).toEqual(['TECHNOLOGY']);
    expect(count('Feed')).toBe(1);
  });

  it('runs the initial fetch for the new feed before responding', async () => {
    const { refreshSingleFeed } = await import('../src/lib/feed-refresh');
    const res = await json('POST', '/api/feeds', {
      name: 'HN',
      url: 'https://hn.example/rss',
      topics: ['TECHNOLOGY'],
    });
    const body = await res.json();
    expect(refreshSingleFeed).toHaveBeenCalledWith(body.data.id);
  });

  it('accepts and ignores a legacy type field', async () => {
    const res = await json('POST', '/api/feeds', {
      name: 'HN',
      url: 'https://legacy.example/rss',
      type: 'FORUM',
      topics: ['TECHNOLOGY'],
    });
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.data.type).toBeUndefined();
  });

  it('creates a local feed and infers sourceKind', async () => {
    const res = await json('POST', '/api/feeds', {
      name: 'RYM Recs',
      url: 'local/rym_music_recs',
      topics: ['MUSIC'],
    });
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.data.url).toBe('local/rym_music_recs');
    expect(body.data.sourceKind).toBe('LOCAL');
  });

  it('creates a subreddit feed as REDDIT under its page URL', async () => {
    const res = await json('POST', '/api/feeds', {
      name: 'r/listentothis',
      url: 'https://reddit.com/r/ListenToThis',
      topics: ['MUSIC'],
    });
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.data.sourceKind).toBe('REDDIT');
    expect(body.data.url).toBe('https://www.reddit.com/r/listentothis/');

    const again = await json('POST', '/api/feeds', { name: 'x', url: 'https://www.reddit.com/r/listentothis/', topics: ['MUSIC'] });
    expect(again.status).toBe(409);
  });

  it('rejects a subreddit RSS URL with 400', async () => {
    const res = await json('POST', '/api/feeds', { name: 'x', url: 'https://www.reddit.com/r/listentothis/hot.rss', topics: ['MUSIC'] });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain('subreddit URL');
  });

  it('rejects duplicate url with 409', async () => {
    createFeed({ url: 'https://dup' });
    const res = await json('POST', '/api/feeds', { name: 'X', url: 'https://dup', topics: ['NEWS'] });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toEqual({ message: 'Feed URL already exists', code: 'DUPLICATE' });
  });

  it('rejects unknown topics with 400', async () => {
    const one = await json('POST', '/api/feeds', { name: 'X', url: 'https://x', topics: ['NOPE'] });
    expect(one.status).toBe(400);
    expect((await one.json()).error.message).toBe('Unknown topic: NOPE');
    const two = await json('POST', '/api/feeds', { name: 'X', url: 'https://x', topics: ['NOPE', 'NADA'] });
    expect((await two.json()).error.message).toBe('Unknown topics: NOPE, NADA');
  });

  it('returns 400 on invalid payload', async () => {
    const res = await json('POST', '/api/feeds', { name: '', url: 'bad', type: 'X', topics: ['x'] });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 on invalid JSON', async () => {
    const res = await json('POST', '/api/feeds', 'not json');
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_JSON');
  });
});

describe('PATCH /api/feeds/[id]', () => {
  it('updates topics and isActive', async () => {
    const feed = createFeed();
    const res = await json('PATCH', `/api/feeds/${feed.id}`, { topics: ['MUSIC', 'NEWS'], isActive: false });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.topics.sort()).toEqual(['MUSIC', 'NEWS']);
    expect(body.data.isActive).toBe(false);
  });

  it('replaces the previous topics', async () => {
    const feed = createFeed({ topics: ['TECHNOLOGY', 'SCIENCE'] });
    await json('PATCH', `/api/feeds/${feed.id}`, { topics: ['MUSIC'] });
    expect(count('FeedTopic', '"feedId" = ?', feed.id)).toBe(1);
    expect(count('FeedTopic', '"feedId" = ? AND "topicSlug" = ?', feed.id, 'MUSIC')).toBe(1);
  });

  it('does not reset fetchErrorCount when resuming', async () => {
    const feed = createFeed({ isActive: false });
    getDb().prepare('UPDATE "Feed" SET "fetchErrorCount" = 5 WHERE "id" = ?').run(feed.id);
    const body = await json('PATCH', `/api/feeds/${feed.id}`, { isActive: true }).then((r) => r.json());
    expect(body.data.isActive).toBe(true);
    expect(body.data.fetchErrorCount).toBe(5);
  });

  it('rejects empty topics array', async () => {
    const feed = createFeed();
    const res = await json('PATCH', `/api/feeds/${feed.id}`, { topics: [] });
    expect(res.status).toBe(400);
  });

  it('rejects unknown topics', async () => {
    const feed = createFeed();
    const res = await json('PATCH', `/api/feeds/${feed.id}`, { topics: ['NOPE'] });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe('Unknown topic: NOPE');
  });

  it('returns 404 for unknown id', async () => {
    const res = await json('PATCH', '/api/feeds/nope', {});
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/feeds/[id]', () => {
  it('removes the feed', async () => {
    const feed = createFeed();
    const res = await request(`/api/feeds/${feed.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ id: feed.id });
    expect(count('Feed')).toBe(0);
  });

  it('cascades feed items deletion', async () => {
    const feed = createFeed();
    getDb()
      .prepare(
        'INSERT INTO "FeedItem" ("id", "feedId", "guid", "title", "link", "publishedAt", "fetchedAt") VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(cuid(), feed.id, 'g', 't', 'l', Date.now(), Date.now());
    await request(`/api/feeds/${feed.id}`, { method: 'DELETE' });
    expect(count('FeedItem')).toBe(0);
    expect(count('FeedTopic')).toBe(0);
  });

  it('returns 404 for unknown id', async () => {
    const res = await request('/api/feeds/nope', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});

describe('YouTube feeds', () => {
  const HANDLE_URL = 'https://www.youtube.com/@GoogleDevelopers';
  const RSS_URL = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    vi.stubEnv('YOUTUBE_API_KEY', 'test-key');
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify({ items: [{ id: CHANNEL_ID }] })));
    vi.mocked(refreshSingleFeed).mockClear();
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  const add = (body: Record<string, unknown>) => json('POST', '/api/feeds', { name: 'GD', topics: ['TECHNOLOGY'], ...body });
  const youTubeFeed = () =>
    createFeed({
      url: CHANNEL_URL,
      sourceKind: 'YOUTUBE',
      publishedAfter: Date.parse('2015-01-01T00:00:00Z'),
      publishedBefore: Date.parse('2018-01-01T00:00:00Z'),
      includeShorts: 0,
      lastFetched: Date.now(),
    });

  describe('POST /api/feeds', () => {
    it('creates a YOUTUBE feed from a handle under its channel URL', async () => {
      const res = await add({ url: HANDLE_URL, startDate: '2015-01-01', endDate: '2017-12-31', includeShorts: true });
      const body = await res.json();
      expect(res.status).toBe(201);
      expect(body.data).toMatchObject({
        url: CHANNEL_URL,
        sourceKind: 'YOUTUBE',
        youtube: { startDate: '2015-01-01', endDate: '2017-12-31', includeShorts: true },
      });
      expect(feedRow(body.data.id)).toMatchObject({
        publishedAfter: Date.parse('2015-01-01T00:00:00Z'),
        publishedBefore: Date.parse('2018-01-01T00:00:00Z'),
        includeShorts: 1,
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(refreshSingleFeed).toHaveBeenCalledWith(body.data.id);
    });

    it('needs no lookup for a channel URL and defaults to all dates without Shorts', async () => {
      const res = await add({ url: `https://youtube.com/channel/${CHANNEL_ID}/videos` });
      const body = await res.json();
      expect(body.data).toMatchObject({
        url: CHANNEL_URL,
        youtube: {
          recent: true,
          archive: true,
          includeShorts: false,
          startDate: null,
          endDate: null,
          archiveSize: 0,
          archiveFilled: false,
          archiveError: null,
        },
      });
      expect(feedRow(body.data.id)).toMatchObject({ includeShorts: 0, showRecent: 1, showArchive: 1 });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rejects every other form of a channel that already has a feed', async () => {
      await add({ url: CHANNEL_URL });
      for (const url of [RSS_URL, HANDLE_URL, CHANNEL_URL]) {
        expect((await add({ url })).status, url).toBe(409);
      }
      expect(count('Feed')).toBe(1);
    });

    it('rejects dates on a non-YouTube URL and an inverted range', async () => {
      expect((await add({ url: 'https://hn.example/rss', startDate: '2020-01-01' })).status).toBe(400);
      expect((await add({ url: 'https://hn.example/rss', includeShorts: false })).status).toBe(400);
      expect((await add({ url: 'https://hn.example/rss', archive: true })).status).toBe(400);
      const bothOff = await add({ url: HANDLE_URL, recent: false, archive: false });
      expect(bothOff.status).toBe(400);
      expect(fetchSpy).not.toHaveBeenCalled();
      const inverted = await add({ url: CHANNEL_URL, startDate: '2020-01-02', endDate: '2020-01-01' });
      expect(inverted.status).toBe(400);
      expect(count('Feed')).toBe(0);
    });

    it('answers 503 for a handle without YOUTUBE_API_KEY and 400 for an unknown handle', async () => {
      vi.stubEnv('YOUTUBE_API_KEY', '');
      const noKey = await add({ url: HANDLE_URL });
      expect(noKey.status).toBe(503);
      expect((await noKey.json()).error.code).toBe('YOUTUBE_UNAVAILABLE');
      vi.stubEnv('YOUTUBE_API_KEY', 'test-key');
      fetchSpy.mockImplementation(async () => new Response(JSON.stringify({})));
      expect((await add({ url: HANDLE_URL })).status).toBe(400);
    });

    it('spends no lookup on a request with unknown topics', async () => {
      const res = await json('POST', '/api/feeds', { name: 'GD', url: HANDLE_URL, topics: ['NOPE'] });
      expect(res.status).toBe(400);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('still adds a YouTube playlist feed as RSS', async () => {
      const res = await add({ url: 'https://www.youtube.com/feeds/videos.xml?playlist_id=PL123' });
      expect((await res.json()).data).toMatchObject({ sourceKind: 'RSS', youtube: null });
    });
  });

  describe('PATCH /api/feeds/[id]', () => {
    it('clears the items and fetches again when the range changes', async () => {
      const feed = youTubeFeed();
      seedItems(feed.id, 3);
      const res = await json('PATCH', `/api/feeds/${feed.id}`, { startDate: '2016-01-01', endDate: '2017-12-31', includeShorts: false });
      expect((await res.json()).data.youtube).toMatchObject({ startDate: '2016-01-01', endDate: '2017-12-31', includeShorts: false });
      expect(count('FeedItem', '"feedId" = ?', feed.id)).toBe(0);
      expect(refreshSingleFeed).toHaveBeenCalledWith(feed.id);
    });

    it('keeps everything when the same settings are saved again', async () => {
      const feed = youTubeFeed();
      seedItems(feed.id, 3);
      const before = feedRow(feed.id);
      const res = await json('PATCH', `/api/feeds/${feed.id}`, {
        topics: ['MUSIC'],
        url: CHANNEL_URL,
        startDate: '2015-01-01',
        endDate: '2017-12-31',
        includeShorts: false,
      });
      expect(res.status).toBe(200);
      expect(count('FeedItem', '"feedId" = ?', feed.id)).toBe(3);
      expect(feedRow(feed.id)?.lastFetched).toBe(before?.lastFetched);
      expect(refreshSingleFeed).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('changes the channel by handle, and rejects one another feed has or a non-channel URL', async () => {
      const feed = youTubeFeed();
      const other = createFeed({ url: 'https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa', sourceKind: 'YOUTUBE' });
      fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ items: [{ id: 'UCaaaaaaaaaaaaaaaaaaaaaa' }] })));
      expect((await json('PATCH', `/api/feeds/${feed.id}`, { url: HANDLE_URL })).status).toBe(409);
      expect((await json('PATCH', `/api/feeds/${feed.id}`, { url: 'https://www.youtube.com/watch?v=WN-JK-hMAyg' })).status).toBe(400);
      expect((await json('PATCH', `/api/feeds/${feed.id}`, { url: 'https://hn.example/rss' })).status).toBe(400);
      fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ items: [{ id: 'UCbbbbbbbbbbbbbbbbbbbbbb' }] })));
      const res = await json('PATCH', `/api/feeds/${feed.id}`, { url: HANDLE_URL });
      expect((await res.json()).data.url).toBe('https://www.youtube.com/channel/UCbbbbbbbbbbbbbbbbbbbbbb');
      expect(feedRow(other.id)?.url).toBe('https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa');
    });

    it('merges one date with the stored range and clears a date with null', async () => {
      const feed = youTubeFeed();
      expect((await json('PATCH', `/api/feeds/${feed.id}`, { startDate: '2019-01-01' })).status).toBe(400);
      const res = await json('PATCH', `/api/feeds/${feed.id}`, { startDate: null });
      expect((await res.json()).data.youtube).toMatchObject({ startDate: null, endDate: '2017-12-31', includeShorts: false });
    });

    it('applies a Recent or Archive toggle on its own, and rejects turning both off', async () => {
      const feed = youTubeFeed();
      seedItems(feed.id, 3);
      const res = await json('PATCH', `/api/feeds/${feed.id}`, { recent: false });
      expect((await res.json()).data.youtube).toMatchObject({ recent: false, archive: true });
      expect(feedRow(feed.id)).toMatchObject({ showRecent: 0, showArchive: 1 });
      expect(count('FeedItem', '"feedId" = ?', feed.id)).toBe(0);
      expect(refreshSingleFeed).toHaveBeenCalledWith(feed.id);
      const both = await json('PATCH', `/api/feeds/${feed.id}`, { archive: false });
      expect(both.status).toBe(400);
      expect((await both.json()).error.message).toBe('Turn on Recent or Archive');
    });

    it('returns the archive size and fill state', async () => {
      const feed = youTubeFeed();
      await seedVideos(CHANNEL_ID, 4);
      getDb().prepare('INSERT INTO "YouTubeChannel" ("channelId", "filledAt") VALUES (?, 1)').run(CHANNEL_ID);
      const patched = await json('PATCH', `/api/feeds/${feed.id}`, { topics: ['MUSIC'] });
      expect((await patched.json()).data.youtube).toMatchObject({ archiveSize: 4, archiveFilled: true, archiveError: null });
      const listed = await (await request('/api/feeds')).json();
      expect(listed.data[0].youtube).toMatchObject({ archiveSize: 4, archiveFilled: true });
    });

    it('rejects YouTube settings on another kind of feed', async () => {
      const feed = createFeed();
      expect((await json('PATCH', `/api/feeds/${feed.id}`, { startDate: '2020-01-01' })).status).toBe(400);
      expect((await json('PATCH', `/api/feeds/${feed.id}`, { url: CHANNEL_URL })).status).toBe(400);
      expect((await json('PATCH', `/api/feeds/${feed.id}`, { archive: true })).status).toBe(400);
    });
  });
});
