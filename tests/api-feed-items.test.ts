import { describe, it, expect, beforeEach } from 'vitest';
import { cuid, getDb } from '../src/db';
import { createFeed, json, request, resetDb, seedItems } from './helpers';

beforeEach(() => {
  resetDb();
});

function insertItem(feedId: string, item: { guid: string; title: string; link: string; publishedAt: Date; sourceRank?: number | null }) {
  getDb()
    .prepare(
      `INSERT INTO "FeedItem" ("id", "feedId", "guid", "title", "link", "publishedAt", "sourceRank", "fetchedAt")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(cuid(), feedId, item.guid, item.title, item.link, item.publishedAt.getTime(), item.sourceRank ?? null, Date.now());
}

const GET = (qs = '') => request(`/api/feed-items${qs}`);

describe('GET /api/feed-items', () => {
  it('returns items sorted by publishedAt desc in sort=new mode', async () => {
    const feed = createFeed({ topic: 'TECHNOLOGY' });
    seedItems(feed.id, 5);
    const res = await GET('?sort=new');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.items).toHaveLength(5);
    const dates = body.data.items.map((i: { publishedAt: string }) => i.publishedAt);
    const sorted = [...dates].sort().reverse();
    expect(dates).toEqual(sorted);
  });

  it('prioritizes popularity rank over recency in recommended mode', async () => {
    const feed = createFeed({ topic: 'TECHNOLOGY' });
    insertItem(feed.id, {
      guid: 'popular-older',
      title: 'Popular but older',
      link: 'https://example.com/popular-older',
      publishedAt: new Date('2026-04-14T10:00:00Z'),
      sourceRank: 0,
    });
    insertItem(feed.id, {
      guid: 'fresh-lower-rank',
      title: 'Fresh but lower rank',
      link: 'https://example.com/fresh-lower-rank',
      publishedAt: new Date('2026-04-17T11:00:00Z'),
      sourceRank: 10,
    });

    const res = await GET('?sort=recommended');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.items[0].guid).toBe('popular-older');
    expect(body.data.items[1].guid).toBe('fresh-lower-rank');
    expect(body.data.nextCursor).toBeNull();
  });

  it('returns a shuffled permutation of the window in random mode', async () => {
    const feed = createFeed();
    seedItems(feed.id, 10);
    const body = await GET('?sort=random').then((r) => r.json());
    expect(body.data.items).toHaveLength(10);
    expect(body.data.nextCursor).toBeNull();
    expect(new Set(body.data.items.map((i: { id: string }) => i.id)).size).toBe(10);
  });

  it('joins feed name/url/topics onto items', async () => {
    const feed = createFeed({ name: 'HN', topic: 'TECHNOLOGY' });
    seedItems(feed.id, 1);
    const body = await GET().then((r) => r.json());
    const item = body.data.items[0];
    expect(item.feedName).toBe('HN');
    expect(item.feedUrl).toBe(feed.url);
    expect(item.feedTopics).toEqual(['TECHNOLOGY']);
    expect(Object.keys(item).sort()).toEqual(
      ['author', 'feedId', 'feedName', 'feedTopics', 'feedUrl', 'guid', 'id', 'link', 'publishedAt', 'summary', 'title'].sort(),
    );
  });

  it('returns items from every feed and ignores a legacy type param', async () => {
    const a = createFeed({ url: 'https://f' });
    const b = createFeed({ url: 'https://b' });
    seedItems(a.id, 2);
    seedItems(b.id, 3);
    const body = await GET('?type=FORUM').then((r) => r.json());
    expect(body.data.items).toHaveLength(5);
  });

  it('filters by topic', async () => {
    const news = createFeed({ topic: 'NEWS', url: 'https://n' });
    const music = createFeed({ topic: 'MUSIC', url: 'https://m' });
    seedItems(news.id, 1);
    seedItems(music.id, 1);
    const body = await GET('?topic=MUSIC').then((r) => r.json());
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].feedTopics).toContain('MUSIC');
  });

  it('shows multi-topic feed items under each of its topics', async () => {
    const multi = createFeed({ topics: ['NEWS', 'MUSIC'], url: 'https://multi' });
    seedItems(multi.id, 1);
    const news = await GET('?topic=NEWS').then((r) => r.json());
    const music = await GET('?topic=MUSIC').then((r) => r.json());
    expect(news.data.items).toHaveLength(1);
    expect(music.data.items).toHaveLength(1);
    // Topics come back in FeedTopic PK order: the lowest slug is the "primary" one.
    expect(news.data.items[0].feedTopics).toEqual(['MUSIC', 'NEWS']);
  });

  it('excludes items from paused (isActive=false) feeds', async () => {
    const active = createFeed({ url: 'https://active', isActive: true });
    const paused = createFeed({ url: 'https://paused', isActive: false });
    seedItems(active.id, 2);
    seedItems(paused.id, 3);

    for (const sort of ['new', 'recommended', 'random'] as const) {
      const res = await GET(`?sort=${sort}`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.data.items).toHaveLength(2);
      expect(body.data.items.every((i: { feedId: string }) => i.feedId === active.id)).toBe(true);
    }
  });

  it('excludes saved and hidden links in every sort mode', async () => {
    const feed = createFeed({ topic: 'NEWS' });
    seedItems(feed.id, 4);
    const savedUrl = `https://example.com/items/${feed.id}-0`;
    const hiddenUrl = `https://example.com/items/${feed.id}-1`;
    expect((await json('POST', '/api/saved-links', { url: savedUrl, title: 'S', topic: 'NEWS' })).status).toBe(201);
    expect((await json('POST', '/api/hidden-links', { url: hiddenUrl })).status).toBe(201);

    for (const sort of ['new', 'recommended', 'random'] as const) {
      const body = await GET(`?sort=${sort}`).then((r) => r.json());
      const links = body.data.items.map((i: { link: string }) => i.link);
      expect(links).toHaveLength(2);
      expect(links).not.toContain(savedUrl);
      expect(links).not.toContain(hiddenUrl);
    }
  });

  it('paginates with cursor', async () => {
    const feed = createFeed();
    seedItems(feed.id, 50);
    const body1 = await GET('?sort=new&limit=20').then((r) => r.json());
    expect(body1.data.items).toHaveLength(20);
    expect(body1.data.nextCursor).toBeTruthy();
    expect(body1.data.nextCursor).toBe(body1.data.items[19].publishedAt);

    const body2 = await GET(`?sort=new&limit=20&cursor=${encodeURIComponent(body1.data.nextCursor)}`).then((r) => r.json());
    expect(body2.data.items).toHaveLength(20);
    const ids1 = new Set(body1.data.items.map((i: { id: string }) => i.id));
    expect(body2.data.items.every((i: { id: string }) => !ids1.has(i.id))).toBe(true);
  });

  it('returns nextCursor=null when exhausted', async () => {
    const feed = createFeed();
    seedItems(feed.id, 3);
    const body = await GET('?sort=new&limit=10').then((r) => r.json());
    expect(body.data.items).toHaveLength(3);
    expect(body.data.nextCursor).toBeNull();
  });

  it('caps limit at PAGE_SIZE_MAX (100)', async () => {
    const feed = createFeed();
    seedItems(feed.id, 150);
    const body = await GET('?sort=new&limit=999').then((r) => r.json());
    expect(body.data.items.length).toBe(100);
  });

  it('returns 400 on invalid cursor', async () => {
    const res = await GET('?sort=new&cursor=not-a-date');
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe('Invalid cursor');
  });

  it('returns 400 on invalid sort', async () => {
    const res = await GET('?sort=oldest');
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe('Invalid sort');
  });

  it('returns 400 on invalid topic slug format', async () => {
    const res = await GET('?topic=lowercase');
    expect(res.status).toBe(400);
  });

  it('returns 400 on invalid limit', async () => {
    const res = await GET('?limit=abc');
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe('Invalid limit');
    expect((await GET('?limit=0')).status).toBe(400);
  });
});
