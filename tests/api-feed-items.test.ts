import { describe, it, expect, beforeEach } from 'vitest';
import { cuid, getDb } from '../src/db';
import { createFeed, json, request, resetDb, seedItems } from './helpers';

beforeEach(() => {
  resetDb();
});

function insertItem(
  feedId: string,
  item: { id?: string; guid: string; title: string; link: string; publishedAt: Date; sourceRank?: number | null },
) {
  getDb()
    .prepare(
      `INSERT INTO "FeedItem" ("id", "feedId", "guid", "title", "link", "publishedAt", "sourceRank", "fetchedAt")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(item.id ?? cuid(), feedId, item.guid, item.title, item.link, item.publishedAt.getTime(), item.sourceRank ?? null, Date.now());
}

const GET = (qs = '') => request(`/api/feed-items${qs}`);

describe('GET /api/feed-items', () => {
  it("returns a Reddit post's media parsed, and null for other items", async () => {
    const feed = createFeed({ url: 'https://www.reddit.com/r/x/', sourceKind: 'REDDIT' });
    const media = { images: ['/preview/pre/a.jpg?s=1'], video: null, url: null, score: '5', comments: 2 };
    getDb()
      .prepare(
        `INSERT INTO "FeedItem" ("id", "feedId", "guid", "title", "link", "publishedAt", "fetchedAt", "media")
         VALUES (?, ?, 'g', 'Post', 'https://www.reddit.com/r/x/comments/abc12/t/', ?, ?, ?)`,
      )
      .run(cuid(), feed.id, Date.now(), Date.now(), JSON.stringify(media));
    seedItems(createFeed().id, 1);
    const items = (await (await GET('?sort=new')).json()).data.items as { title: string; media: unknown }[];
    expect(items.find((i) => i.title === 'Post')?.media).toEqual(media);
    expect(items.find((i) => i.title !== 'Post')?.media).toBeNull();
  });

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
    // Fixed ids keep the Hot noise the same on every run.
    insertItem(feed.id, {
      id: 'popular-older',
      guid: 'popular-older',
      title: 'Popular but older',
      link: 'https://example.com/popular-older',
      publishedAt: new Date('2026-04-14T10:00:00Z'),
      sourceRank: 0,
    });
    insertItem(feed.id, {
      id: 'fresh-lower-rank',
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

  it('builds the recommended pool round-robin over feeds, so a busy feed cannot crowd out a quiet one', async () => {
    const busy = createFeed({ name: 'Busy', topic: 'TECHNOLOGY' });
    const quiet = createFeed({ name: 'Quiet', topic: 'TECHNOLOGY', url: 'https://example.com/quiet.xml' });
    // More rank-0 items than the 300-item pool, all newer than the quiet feed's one post.
    for (let i = 0; i < 350; i++) {
      insertItem(busy.id, {
        guid: `busy-${i}`,
        title: `Busy ${i}`,
        link: `https://example.com/busy/${i}`,
        publishedAt: new Date(Date.UTC(2026, 3, 17) - i * 60_000),
        sourceRank: 0,
      });
    }
    insertItem(quiet.id, {
      guid: 'quiet-0',
      title: 'Quiet',
      link: 'https://example.com/quiet/0',
      publishedAt: new Date('2026-03-01T00:00:00Z'),
      sourceRank: 0,
    });

    // Without the round-robin pool, the 350 newer busy items would push it past the 300 cut.
    const body = await (await GET('?sort=recommended')).json();
    expect(body.data.items.map((i: { guid: string }) => i.guid)).toContain('quiet-0');
  });

  it('keeps the Hot order until a feed is stored, then reshuffles it', async () => {
    const feeds = Array.from({ length: 20 }, (_, i) =>
      createFeed({ name: `F${i}`, url: `https://example.com/${i}.xml`, topic: 'TECHNOLOGY', lastFetched: 1 }));
    feeds.forEach((feed, i) =>
      insertItem(feed.id, {
        id: `item-${i}`,
        guid: `g${i}`,
        title: `T${i}`,
        link: `https://example.com/item/${i}`,
        publishedAt: new Date('2026-04-17T00:00:00Z'),
        sourceRank: 0,
      }));
    const order = async () =>
      ((await GET('?sort=recommended').then((r) => r.json())).data.items as { id: string }[]).map((i) => i.id);

    const first = await order();
    expect(await order()).toEqual(first);
    getDb().prepare('UPDATE "Feed" SET "lastFetched" = 2 WHERE "id" = ?').run(feeds[0].id);
    expect(await order()).not.toEqual(first);
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
      ['author', 'feedId', 'feedName', 'feedTopics', 'feedUrl', 'guid', 'id', 'link', 'media', 'publishedAt', 'summary', 'title', 'uploadedAt'].sort(),
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

  it('shows the whole list, up to 300 items, for Hot and Shuffle', async () => {
    const feed = createFeed();
    seedItems(feed.id, 320);
    for (const sort of ['recommended', 'random']) {
      expect((await GET(`?sort=${sort}`).then((r) => r.json())).data.items).toHaveLength(300);
      expect((await GET(`?sort=${sort}&limit=999`).then((r) => r.json())).data.items).toHaveLength(300);
    }
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
