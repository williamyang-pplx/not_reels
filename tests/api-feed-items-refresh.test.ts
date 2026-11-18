import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFeed, json, resetDb } from './helpers';

vi.mock('../src/lib/feed-refresh', () => ({
  refreshSingleFeed: vi.fn(async () => ({ ok: true, newItems: 3 })),
  refreshAllFeeds: vi.fn(async () => ({ refreshed: 2, newItems: 5, failed: 0 })),
}));

beforeEach(() => {
  resetDb();
});

describe('POST /api/feed-items/refresh', () => {
  it('refreshes a single feed when feedId provided', async () => {
    const feed = createFeed();
    const { refreshSingleFeed } = await import('../src/lib/feed-refresh');
    const res = await json('POST', '/api/feed-items/refresh', { feedId: feed.id });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ refreshed: 1, newItems: 3, failed: 0, queued: 0 });
    expect(refreshSingleFeed).toHaveBeenCalledWith(feed.id);
  });

  it('counts a Reddit feed that waits for its turn as queued, not refreshed', async () => {
    const feed = createFeed();
    const { refreshSingleFeed } = await import('../src/lib/feed-refresh');
    vi.mocked(refreshSingleFeed).mockResolvedValueOnce({ ok: true, newItems: 0, queued: true });
    const res = await json('POST', '/api/feed-items/refresh', { feedId: feed.id });
    expect((await res.json()).data).toEqual({ refreshed: 0, newItems: 0, failed: 0, queued: 1 });
  });

  it('refreshes an inactive feed when targeted directly', async () => {
    const feed = createFeed({ isActive: false });
    const { refreshSingleFeed } = await import('../src/lib/feed-refresh');
    const res = await json('POST', '/api/feed-items/refresh', { feedId: feed.id });
    expect(res.status).toBe(200);
    expect(refreshSingleFeed).toHaveBeenCalledWith(feed.id);
  });

  it('returns 404 when feedId not found', async () => {
    const res = await json('POST', '/api/feed-items/refresh', { feedId: 'nonexistent' });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toEqual({ message: 'Feed not found', code: 'NOT_FOUND' });
  });

  it('refreshes all when no feedId given', async () => {
    const { refreshAllFeeds } = await import('../src/lib/feed-refresh');
    const res = await json('POST', '/api/feed-items/refresh', {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ refreshed: 2, newItems: 5, failed: 0 });
    expect(refreshAllFeeds).toHaveBeenCalled();
  });
});
