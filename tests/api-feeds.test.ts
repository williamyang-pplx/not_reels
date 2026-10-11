import { describe, it, expect, beforeEach, vi } from 'vitest';
import { cuid, getDb } from '../src/db';
import { count, createFeed, json, request, resetDb } from './helpers';

vi.mock('../src/lib/feed-refresh', () => ({
  refreshSingleFeed: vi.fn(async () => ({ ok: true, newItems: 0 })),
  refreshAllFeeds: vi.fn(async () => ({ refreshed: 0, newItems: 0, failed: 0 })),
  refreshFeeds: vi.fn(async () => ({ refreshed: 0, newItems: 0, failed: 0 })),
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

  it('filters by type', async () => {
    createFeed({ type: 'FORUM', url: 'https://a' });
    createFeed({ type: 'BLOG', url: 'https://b' });
    const body = await request('/api/feeds?type=FORUM').then((r) => r.json());
    expect(body.data).toHaveLength(1);
    expect(body.data[0].type).toBe('FORUM');
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

  it('returns 400 on invalid type', async () => {
    const res = await request('/api/feeds?type=NOPE');
    expect(res.status).toBe(400);
  });
});

describe('POST /api/feeds', () => {
  it('creates a feed and returns it', async () => {
    const res = await json('POST', '/api/feeds', {
      name: 'HN',
      url: 'https://news.ycombinator.com/rss',
      type: 'FORUM',
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
      type: 'FORUM',
      topics: ['TECHNOLOGY'],
    });
    const body = await res.json();
    expect(refreshSingleFeed).toHaveBeenCalledWith(body.data.id);
  });

  it('creates a local feed and infers sourceKind', async () => {
    const res = await json('POST', '/api/feeds', {
      name: 'RYM Recs',
      url: 'local/rym_music_recs',
      type: 'BLOG',
      topics: ['MUSIC'],
    });
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.data.url).toBe('local/rym_music_recs');
    expect(body.data.sourceKind).toBe('LOCAL');
  });

  it('rejects duplicate url with 409', async () => {
    createFeed({ url: 'https://dup' });
    const res = await json('POST', '/api/feeds', { name: 'X', url: 'https://dup', type: 'FORUM', topics: ['NEWS'] });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toEqual({ message: 'Feed URL already exists', code: 'DUPLICATE' });
  });

  it('rejects unknown topics with 400', async () => {
    const one = await json('POST', '/api/feeds', { name: 'X', url: 'https://x', type: 'FORUM', topics: ['NOPE'] });
    expect(one.status).toBe(400);
    expect((await one.json()).error.message).toBe('Unknown topic: NOPE');
    const two = await json('POST', '/api/feeds', { name: 'X', url: 'https://x', type: 'FORUM', topics: ['NOPE', 'NADA'] });
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
