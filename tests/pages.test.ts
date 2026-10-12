import { describe, it, expect, beforeEach } from 'vitest';
import { CSP } from '../src/app';
import { createFeed, json, request, resetDb, seedItems } from './helpers';

beforeEach(() => {
  resetDb();
});

const html = (path: string, init?: RequestInit) => request(path, init).then(async (r) => ({ res: r, body: await r.text() }));

describe('GET /', () => {
  it('renders the full document with nav, pills and feed list', async () => {
    const feed = createFeed({ name: 'HN', type: 'FORUM', topic: 'TECHNOLOGY' });
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
      'type-pill-FORUM',
      'type-pill-BLOG',
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
    expect(body).toContain('Not Brain Rot');
    expect(body).toContain('rel="manifest" href="/manifest.json"');
    expect(body).toContain('name="apple-mobile-web-app-status-bar-style" content="black-translucent"');
  });

  it('sets the Content-Security-Policy header on pages, API and static responses', async () => {
    expect((await request('/')).headers.get('Content-Security-Policy')).toBe(CSP);
    expect((await request('/api/topics')).headers.get('Content-Security-Policy')).toBe(CSP);
    expect(CSP).toContain("frame-src https://www.youtube.com https://www.youtube-nocookie.com https://www.redditmedia.com https://embed.reddit.com");
  });

  it('marks the active type and topic pills from the query', async () => {
    const { body } = await html('/?type=BLOG&topic=MUSIC');
    expect(body).toMatch(/data-testid="type-pill-BLOG"[^>]*aria-current="true"/);
    expect(body).toMatch(/data-testid="topic-pill-MUSIC"[^>]*aria-current="true"/);
    expect(body).not.toMatch(/data-testid="type-pill-FORUM"[^>]*aria-current/);
  });

  it('shows the empty state when no items match', async () => {
    const { body } = await html('/');
    expect(body).toContain('No items match these filters yet.');
  });

  it('renders "Failed to load feed." for an invalid type', async () => {
    const { res, body } = await html('/?type=NOPE');
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
    const { res, body } = await html('/?type=BLOG', { headers: { 'X-Partial': '1' } });
    expect(res.headers.get('Vary')).toContain('X-Partial');
    expect(body).not.toContain('<html');
    expect(body).not.toContain('<head>');
    expect(body).toContain('data-testid="nav-bar"');
    expect(body).toContain('data-testid="feed-list"');
  });

  it('renders the RYM card variant with a YouTube Music link and no archive button', async () => {
    const feed = createFeed({ name: 'RYM', url: 'local/rym_music_recs', sourceKind: 'LOCAL', type: 'BLOG', topic: 'MUSIC' });
    const { getDb, cuid } = await import('../src/db');
    getDb()
      .prepare(
        `INSERT INTO "FeedItem" ("id", "feedId", "guid", "title", "link", "summary", "author", "publishedAt", "sourceRank", "fetchedAt")
         VALUES (?, ?, 'rym-album-1', 'OK Computer', 'https://rateyourmusic.com/search?searchterm=x', 'Alt Rock | 16 June 1997 | RYM 4.30', 'Radiohead', ?, 0, ?)`,
      )
      .run(cuid(), feed.id, Date.now(), Date.now());
    const { body } = await html('/?type=BLOG');
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

describe('GET /_f/items', () => {
  it('returns the next page of cards with a sentinel cursor for sort=new', async () => {
    const feed = createFeed();
    seedItems(feed.id, 150);
    const { res, body } = await html('/_f/items?type=FORUM&sort=new');
    expect(res.status).toBe(200);
    expect(body).not.toContain('<html');
    expect(body.match(/data-testid="feed-card"/g)).toHaveLength(100);
    const cursor = body.match(/data-testid="sentinel"[^>]*data-cursor="([^"]+)"/)?.[1];
    expect(cursor).toBeTruthy();

    const next = await html(`/_f/items?type=FORUM&sort=new&cursor=${encodeURIComponent(cursor!)}`);
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
    const feed = await createFeed({ type: 'FORUM' });
    getDb()
      .prepare(
        `INSERT INTO "FeedItem" ("id","feedId","guid","title","link","publishedAt","sourceRank","fetchedAt")
         VALUES ('x1', ?, 'g-js', 'Evil', 'javascript:alert(1)', ?, 0, ?)`,
      )
      .run(feed.id, Date.now(), Date.now());
    const { createApp } = await import('../src/app');
    const html = await (await createApp().request('/?type=FORUM')).text();
    expect(html).toContain('Evil');
    expect(html).not.toMatch(/\shref="javascript:/);
    expect(html).toContain('data-href="javascript:alert(1)"');
  });
});
