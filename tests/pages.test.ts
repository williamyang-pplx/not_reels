import { describe, it, expect, beforeEach } from 'vitest';
import { CSP } from '../src/app';
import { createFeed, json, request, resetDb, seedItems } from './helpers';

beforeEach(() => {
  resetDb();
});

const html = (path: string, init?: RequestInit) => request(path, init).then(async (r) => ({ res: r, body: await r.text() }));

describe('GET /', () => {
  it('renders the full document with nav, pills and feed list', async () => {
    const feed = createFeed({ name: 'HN', topic: 'TECHNOLOGY' });
    seedItems(feed.id, 3);
    const { res, body } = await html('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(body.startsWith('<!doctype html>')).toBe(true);
    for (const id of [
      'nav-bar',
      'nav-manage-link',
      'type-filter-row',
      'type-pill-FEED',
      'type-pill-SAVED',
      'topic-filter-row',
      'topic-pill-ALL',
      'topic-pill-TECHNOLOGY',
      'feed-list',
      'refresh-button',
      'sort-recommended',
      'sort-new',
      'sort-random',
      'sentinel',
      'feed-card',
      'save-feed-item-btn',
      'hide-feed-item-btn',
      'archive-feed-item-btn',
    ]) {
      expect(body, id).toContain(`data-testid="${id}"`);
    }
    expect(body.match(/data-testid="feed-card"/g)).toHaveLength(3);
    expect(body).not.toContain('class="ty"');
    expect(body).toContain('Not Brain Rot');
    expect(body).toContain('rel="manifest" href="/manifest.json"');
    expect(body).toContain('name="apple-mobile-web-app-status-bar-style" content="black-translucent"');
  });

  it('sets the Content-Security-Policy header on pages, API and static responses', async () => {
    expect((await request('/')).headers.get('Content-Security-Policy')).toBe(CSP);
    expect((await request('/api/topics')).headers.get('Content-Security-Policy')).toBe(CSP);
    expect(CSP).toContain("frame-src https://www.youtube.com https://www.youtube-nocookie.com https://www.redditmedia.com https://embed.reddit.com");
  });

  it('marks the Feed pill and the topic pill from the query', async () => {
    const { body } = await html('/?topic=MUSIC');
    expect(body).toMatch(/data-testid="type-pill-FEED"[^>]*aria-current="true"/);
    expect(body).toMatch(/data-testid="topic-pill-MUSIC"[^>]*aria-current="true"/);
    expect(body).not.toMatch(/data-testid="type-pill-SAVED"[^>]*aria-current/);
  });

  it('ignores a legacy ?type= param and shows every feed', async () => {
    const a = createFeed({ url: 'https://a.example' });
    const b = createFeed({ url: 'https://b.example' });
    seedItems(a.id, 2);
    seedItems(b.id, 3);
    const { body } = await html('/?type=BLOG');
    expect(body.match(/data-testid="feed-card"/g)).toHaveLength(5);
    expect(body).toMatch(/data-testid="type-pill-FEED"[^>]*aria-current="true"/);
  });

  it('shows the empty state when no items match', async () => {
    const { body } = await html('/');
    expect(body).toContain('No items match these filters yet.');
  });

  it('renders "Failed to load feed." for an invalid topic', async () => {
    const { res, body } = await html('/?topic=nope');
    expect(res.status).toBe(200);
    expect(body).toContain('Failed to load feed.');
  });

  it('excludes saved items from the rendered stream', async () => {
    const feed = createFeed({ topic: 'NEWS' });
    seedItems(feed.id, 2);
    await json('POST', '/api/saved-links', { url: `https://example.com/items/${feed.id}-0`, title: 'S', topic: 'NEWS' });
    const { body } = await html('/');
    expect(body.match(/data-testid="feed-card"/g)).toHaveLength(1);
  });

  it('returns only nav + main (no <html>) for X-Partial requests', async () => {
    const { res, body } = await html('/', { headers: { 'X-Partial': '1' } });
    expect(res.headers.get('Vary')).toContain('X-Partial');
    expect(body).not.toContain('<html');
    expect(body).not.toContain('<head>');
    expect(body).toContain('data-testid="nav-bar"');
    expect(body).toContain('data-testid="feed-list"');
  });

  it('stamps the document and partials with the build id, so a stale page can tell', async () => {
    const full = await html('/');
    expect(full.body).toContain('<html lang="en" data-build="dev">');
    const partial = await request('/', { headers: { 'X-Partial': '1' } });
    expect(partial.headers.get('X-Build')).toBe('dev');
  });

  it('renders the RYM card variant with a YouTube Music link and no archive button', async () => {
    const feed = createFeed({ name: 'RYM', url: 'local/rym_music_recs', sourceKind: 'LOCAL', topic: 'MUSIC' });
    const { getDb, cuid } = await import('../src/db');
    getDb()
      .prepare(
        `INSERT INTO "FeedItem" ("id", "feedId", "guid", "title", "link", "summary", "author", "publishedAt", "sourceRank", "fetchedAt")
         VALUES (?, ?, 'rym-album-1', 'OK Computer', 'https://rateyourmusic.com/search?searchterm=x', 'Alt Rock | 16 June 1997 | RYM 4.30', 'Radiohead', ?, 0, ?)`,
      )
      .run(cuid(), feed.id, Date.now(), Date.now());
    const { body } = await html('/');
    expect(body).toContain('data-testid="youtube-music-feed-item-link"');
    expect(body).toContain('https://music.youtube.com/search?q=OK+Computer');
    expect(body).not.toContain('data-testid="archive-feed-item-btn"');
    expect(body).toContain('Radiohead');
    expect(body).toContain('RYM 4.30');
  });
});

describe('GET /saved and /manage', () => {
  it('renders the saved page with its test ids', async () => {
    await json('POST', '/api/saved-links', { url: 'https://a.example', title: 'A link', topic: 'NEWS', notes: 'note' });
    const { res, body } = await html('/saved');
    expect(res.status).toBe(200);
    for (const id of ['nav-bar', 'type-filter-row', 'topic-filter-row', 'add-saved-link-btn', 'add-saved-link-modal', 'saved-link-card', 'saved-link-delete']) {
      expect(body, id).toContain(`data-testid="${id}"`);
    }
    expect(body).toMatch(/data-testid="type-pill-SAVED"[^>]*aria-current="true"/);
    expect(body).toContain('A link');
  });

  it('shows the saved empty state', async () => {
    const { body } = await html('/saved');
    expect(body).toContain('No saved links yet.');
  });

  it('renders the manage page with its test ids and no filter rows', async () => {
    createFeed({ name: 'Paused one', isActive: false, topics: ['NEWS', 'MUSIC'] });
    const { res, body } = await html('/manage');
    expect(res.status).toBe(200);
    for (const id of [
      'topics-manager',
      'topic-input',
      'add-topic-btn',
      'topic-chip',
      'delete-topic-NEWS',
      'add-feed-btn',
      'add-feed-modal',
      'edit-feed-modal',
      'feed-row',
      'feed-pause-btn',
      'feed-edit-btn',
      'feed-delete-btn',
      'topic-checkbox-NEWS',
    ]) {
      expect(body, id).toContain(`data-testid="${id}"`);
    }
    expect(body).not.toContain('data-testid="type-filter-row"');
    expect(body).toContain('paused');
    expect(body).toContain('Resume');
  });

  it('shows the manage empty state', async () => {
    const { body } = await html('/manage');
    expect(body).toContain('No feeds yet. Add your first one above.');
  });
});

describe('summaries', () => {
  const long = Array.from({ length: 120 }, (_, i) => `w${i}`).join(' ') + '\n\nLast &amp; paragraph.';
  const seedSummaries = async () => {
    const feed = createFeed();
    seedItems(feed.id, 2);
    const { getDb } = await import('../src/db');
    const ids = getDb().prepare('SELECT "id" FROM "FeedItem" WHERE "feedId" = ? ORDER BY "publishedAt" DESC').all(feed.id) as { id: string }[];
    getDb().prepare('UPDATE "FeedItem" SET "summary" = ? WHERE "id" = ?').run(long, ids[0].id);
    getDb().prepare('UPDATE "FeedItem" SET "summary" = ? WHERE "id" = ?').run('Short one.', ids[1].id);
    return ids.map((r) => r.id);
  };

  it('cards carry a 60-word excerpt, and a cut one gets a More button with the item id', async () => {
    const [longId] = await seedSummaries();
    const { body } = await html('/?sort=new');
    expect(body).toContain('<p class="sum">w0 w1');
    expect(body).toContain('w59…</p>');
    expect(body).not.toContain('w60');
    expect(body).toContain(`<button data-act="more" data-id="${longId}" aria-expanded="false" class="more">More</button>`);
    expect(body).toContain('<p class="sum">Short one.</p>');
    expect(body.match(/data-act="more"/g)).toHaveLength(1);
  });

  it('GET /_f/summary/:id returns the whole summary as plain text, entities decoded', async () => {
    const [longId] = await seedSummaries();
    const res = await request(`/_f/summary/${longId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/plain');
    const text = await res.text();
    expect(text.split(/\s+/)).toHaveLength(123);
    expect(text.endsWith('\n\nLast & paragraph.')).toBe(true);
    expect((await request('/_f/summary/nope')).status).toBe(404);
  });
});

describe('GET /_f/items', () => {
  it('returns the next page of cards with a sentinel cursor for sort=new', async () => {
    const feed = createFeed();
    seedItems(feed.id, 150);
    // A legacy `type` param (from stale cached HTML) is ignored.
    const { res, body } = await html('/_f/items?type=FORUM&sort=new');
    expect(res.status).toBe(200);
    expect(body).not.toContain('<html');
    expect(body.match(/data-testid="feed-card"/g)).toHaveLength(100);
    const cursor = body.match(/data-testid="sentinel"[^>]*data-cursor="([^"]+)"/)?.[1];
    expect(cursor).toBeTruthy();

    const next = await html(`/_f/items?sort=new&cursor=${encodeURIComponent(cursor!)}`);
    expect(next.body.match(/data-testid="feed-card"/g)).toHaveLength(50);
    expect(next.body).not.toMatch(/data-testid="sentinel"[^>]*data-cursor=/);
  });

  it('returns 400 for an invalid sort', async () => {
    const res = await request('/_f/items?sort=oldest');
    expect(res.status).toBe(400);
  });
});

describe('link safety', () => {
  it('never renders a javascript: URL as a clickable href', async () => {
    const { getDb } = await import('../src/db');
    const { resetDb, createFeed } = await import('./helpers');
    await resetDb();
    const feed = await createFeed();
    getDb()
      .prepare(
        `INSERT INTO "FeedItem" ("id","feedId","guid","title","link","publishedAt","sourceRank","fetchedAt")
         VALUES ('x1', ?, 'g-js', 'Evil', 'javascript:alert(1)', ?, 0, ?)`,
      )
      .run(feed.id, Date.now(), Date.now());
    const { createApp } = await import('../src/app');
    const html = await (await createApp().request('/')).text();
    expect(html).toContain('Evil');
    expect(html).not.toMatch(/\shref="javascript:/);
    expect(html).toContain('data-href="javascript:alert(1)"');
  });
});
