import { describe, it, expect, beforeEach } from 'vitest';
import { count, json, request, resetDb } from './helpers';

beforeEach(() => {
  resetDb();
});

async function createLink(body: { url: string; title: string; topic: string; notes?: string }) {
  const res = await json('POST', '/api/saved-links', body);
  return (await res.json()).data as { id: string; url: string };
}

describe('saved-links API', () => {
  it('POST creates a saved link', async () => {
    const res = await json('POST', '/api/saved-links', {
      url: 'https://blog.example.com/post',
      title: 'Cool post',
      topic: 'TECHNOLOGY',
      notes: 'Read later',
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.title).toBe('Cool post');
    expect(body.data.notes).toBe('Read later');
    expect(count('SavedLink')).toBe(1);
  });

  it('POST allows duplicate URLs', async () => {
    await createLink({ url: 'https://a', title: 'A', topic: 'NEWS' });
    const res = await json('POST', '/api/saved-links', { url: 'https://a', title: 'A again', topic: 'NEWS' });
    expect(res.status).toBe(201);
    expect(count('SavedLink')).toBe(2);
  });

  it('GET returns saved links sorted by savedAt desc', async () => {
    const a = await createLink({ url: 'https://a', title: 'A', topic: 'NEWS' });
    await new Promise((r) => setTimeout(r, 10));
    const b = await createLink({ url: 'https://b', title: 'B', topic: 'NEWS' });
    const body = await request('/api/saved-links').then((r) => r.json());
    expect(body.data[0].id).toBe(b.id);
    expect(body.data[1].id).toBe(a.id);
  });

  it('GET filters by topic', async () => {
    await createLink({ url: 'https://a', title: 'A', topic: 'NEWS' });
    await createLink({ url: 'https://b', title: 'B', topic: 'MUSIC' });
    const body = await request('/api/saved-links?topic=MUSIC').then((r) => r.json());
    expect(body.data).toHaveLength(1);
    expect(body.data[0].topic).toBe('MUSIC');
    const all = await request('/api/saved-links?topic=ALL').then((r) => r.json());
    expect(all.data).toHaveLength(2);
  });

  it('PATCH updates title/topic/notes', async () => {
    const link = await createLink({ url: 'https://a', title: 'A', topic: 'NEWS' });
    const res = await json('PATCH', `/api/saved-links/${link.id}`, { title: 'New', topic: 'CULTURE', notes: 'n' });
    const body = await res.json();
    expect(body.data.title).toBe('New');
    expect(body.data.topic).toBe('CULTURE');
    expect(body.data.notes).toBe('n');
  });

  it('PATCH rejects unknown topic', async () => {
    const link = await createLink({ url: 'https://a', title: 'A', topic: 'NEWS' });
    const res = await json('PATCH', `/api/saved-links/${link.id}`, { topic: 'NOPE' });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe('Unknown topic');
  });

  it('DELETE removes a saved link', async () => {
    const link = await createLink({ url: 'https://a', title: 'A', topic: 'NEWS' });
    const res = await request(`/api/saved-links/${link.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ id: link.id });
    expect(count('SavedLink')).toBe(0);
  });

  it('DELETE 404 on missing id', async () => {
    const res = await request('/api/saved-links/nope', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('PATCH 404 on missing id', async () => {
    const res = await json('PATCH', '/api/saved-links/nope', {});
    expect(res.status).toBe(404);
  });

  it('POST rejects invalid url', async () => {
    const res = await json('POST', '/api/saved-links', { url: 'not-url', title: 'x', topic: 'NEWS' });
    expect(res.status).toBe(400);
  });

  it('POST rejects unknown topic', async () => {
    const res = await json('POST', '/api/saved-links', { url: 'https://x', title: 'x', topic: 'NOPE' });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe('Unknown topic');
  });
});

describe('hidden-links API', () => {
  it('POST upserts by url (idempotent)', async () => {
    const a = await json('POST', '/api/hidden-links', { url: 'https://h' });
    const b = await json('POST', '/api/hidden-links', { url: 'https://h' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect((await a.json()).data.id).toBe((await b.json()).data.id);
    expect(count('HiddenLink')).toBe(1);
  });

  it('POST rejects invalid url', async () => {
    expect((await json('POST', '/api/hidden-links', { url: 'nope' })).status).toBe(400);
  });

  it('DELETE removes by url and never 404s', async () => {
    await json('POST', '/api/hidden-links', { url: 'https://h' });
    const res = await request(`/api/hidden-links?url=${encodeURIComponent('https://h')}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ url: 'https://h' });
    expect(count('HiddenLink')).toBe(0);
    expect((await request('/api/hidden-links?url=https%3A%2F%2Fmissing', { method: 'DELETE' })).status).toBe(200);
  });

  it('DELETE requires url', async () => {
    const res = await request('/api/hidden-links', { method: 'DELETE' });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe('Missing url');
  });
});
