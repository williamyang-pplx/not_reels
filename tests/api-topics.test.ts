import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getDb } from '../src/db';
import { count, createFeed, json, request, resetDb } from './helpers';

vi.mock('../src/lib/feed-refresh', () => ({
  refreshSingleFeed: vi.fn(async () => ({ ok: true, newItems: 0 })),
  refreshAllFeeds: vi.fn(async () => ({ refreshed: 0, newItems: 0, failed: 0 })),
}));

beforeEach(() => {
  resetDb();
});

describe('GET /api/topics', () => {
  it('returns the seeded default topics', async () => {
    const res = await request('/api/topics');
    const body = await res.json();
    expect(res.status).toBe(200);
    const slugs = body.data.map((t: { slug: string }) => t.slug);
    expect(slugs).toContain('NEWS');
    expect(slugs).toContain('TECHNOLOGY');
    expect(slugs.length).toBeGreaterThanOrEqual(8);
  });

  it('returns topics in creation order, defaults first', async () => {
    await json('POST', '/api/topics', { slug: 'GAMING', label: 'Gaming' });
    const body = await request('/api/topics').then((r) => r.json());
    expect(body.data.map((t: { slug: string }) => t.slug)).toEqual([
      'NEWS',
      'MUSIC',
      'LITERATURE',
      'TECHNOLOGY',
      'SCIENCE',
      'CULTURE',
      'POLITICS',
      'OTHER',
      'GAMING',
    ]);
  });

  it('re-seeds the defaults when the table is empty', async () => {
    getDb().exec('DELETE FROM "Topic"');
    const body = await request('/api/topics').then((r) => r.json());
    expect(body.data).toHaveLength(8);
    expect(body.data[3]).toMatchObject({ slug: 'TECHNOLOGY', label: 'Tech' });
  });
});

describe('POST /api/topics', () => {
  it('creates a new topic', async () => {
    const res = await json('POST', '/api/topics', { slug: 'GAMING', label: 'Gaming' });
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.data.slug).toBe('GAMING');
    expect(body.data.label).toBe('Gaming');
  });

  it('rejects duplicate slugs with 409', async () => {
    const res = await json('POST', '/api/topics', { slug: 'NEWS', label: 'News' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toEqual({ message: 'Topic already exists', code: 'DUPLICATE' });
  });

  it('rejects invalid slugs (lowercase, spaces) with 400', async () => {
    for (const bad of ['news', 'News', 'NEW S', 'NEW-S', '']) {
      const res = await json('POST', '/api/topics', { slug: bad, label: 'X' });
      expect(res.status).toBe(400);
    }
  });

  it('rejects empty label with 400', async () => {
    const res = await json('POST', '/api/topics', { slug: 'GAMING', label: '' });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/topics/[slug]', () => {
  it('refuses to delete with 409 when it would orphan a single-topic feed', async () => {
    createFeed({ topics: ['MUSIC'], name: 'OnlyMusic', url: 'https://m' });
    const res = await request('/api/topics/MUSIC', { method: 'DELETE' });
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error.code).toBe('CONSTRAINT');
    expect(body.error.message).toBe(
      'Cannot delete topic — these feeds would have no topic: OnlyMusic. Reassign them first.',
    );
    expect(count('Topic', '"slug" = ?', 'MUSIC')).toBe(1);
  });

  it('deletes the topic and cascades saved links when no feeds would be orphaned', async () => {
    createFeed({ topics: ['MUSIC', 'NEWS'], url: 'https://multi' });
    await json('POST', '/api/saved-links', { url: 'https://x', title: 'T', topic: 'MUSIC' });
    createFeed({ topics: ['TECHNOLOGY'], url: 'https://n' });

    const res = await request('/api/topics/MUSIC', { method: 'DELETE' });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data).toEqual({ slug: 'MUSIC', deletedSavedLinks: 1 });
    expect(count('Topic', '"slug" = ?', 'MUSIC')).toBe(0);
    expect(count('SavedLink', '"topic" = ?', 'MUSIC')).toBe(0);
    const survivor = getDb().prepare('SELECT "id" FROM "Feed" WHERE "url" = ?').get('https://multi') as { id: string };
    expect(survivor).toBeTruthy();
    const topics = getDb().prepare('SELECT "topicSlug" FROM "FeedTopic" WHERE "feedId" = ?').all(survivor.id);
    expect(topics).toEqual([{ topicSlug: 'NEWS' }]);
    expect(count('Feed')).toBe(2);
  });

  it('returns 404 for unknown topic', async () => {
    const res = await request('/api/topics/NOPE', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});

describe('topic validation on create', () => {
  it('rejects feed creation with a non-existent topic', async () => {
    const res = await json('POST', '/api/feeds', { name: 'X', url: 'https://new', topics: ['NONEXISTENT'] });
    expect(res.status).toBe(400);
  });

  it('rejects saved-link creation with a non-existent topic', async () => {
    const res = await json('POST', '/api/saved-links', { url: 'https://x', title: 'T', topic: 'NONEXISTENT' });
    expect(res.status).toBe(400);
  });

  it('allows feed creation against a newly-added custom topic', async () => {
    await json('POST', '/api/topics', { slug: 'GAMING', label: 'Gaming' });
    const res = await json('POST', '/api/feeds', { name: 'GameDev', url: 'https://gd', topics: ['GAMING'] });
    expect(res.status).toBe(201);
  });
});
