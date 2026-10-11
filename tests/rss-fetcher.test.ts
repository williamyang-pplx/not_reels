import { describe, it, expect } from 'vitest';
import { normalizeItem, normalizeAll } from '../src/lib/rss-fetcher';

describe('rss-fetcher normalization', () => {
  it('normalizes a fully populated item', () => {
    const out = normalizeItem({
      guid: 'g1',
      title: 'Hello world',
      link: 'https://x.com/1',
      contentSnippet: 'A summary',
      creator: 'alice',
      isoDate: '2026-04-14T00:00:00Z',
    });
    expect(out.guid).toBe('g1');
    expect(out.title).toBe('Hello world');
    expect(out.link).toBe('https://x.com/1');
    expect(out.summary).toBe('A summary');
    expect(out.author).toBe('alice');
    expect(out.publishedAt.toISOString()).toBe('2026-04-14T00:00:00.000Z');
    expect(out.sourceRank).toBeNull();
  });

  it('falls back to "(untitled)" for missing title', () => {
    const out = normalizeItem({ guid: 'g', link: 'L' });
    expect(out.title).toBe('(untitled)');
  });

  it('uses now() for missing/invalid dates', () => {
    const now = new Date('2026-04-14T12:00:00Z');
    const out = normalizeItem({ guid: 'g', link: 'L' }, now);
    expect(out.publishedAt.toISOString()).toBe(now.toISOString());
  });

  it('uses pubDate when isoDate missing', () => {
    const out = normalizeItem({
      guid: 'g',
      link: 'L',
      pubDate: 'Sat, 14 Apr 2026 10:00:00 GMT',
    });
    expect(out.publishedAt.toISOString()).toBe('2026-04-14T10:00:00.000Z');
  });

  it('falls back to contentEncoded for summary', () => {
    const out = normalizeItem({ guid: 'g', link: 'L', contentEncoded: '<p>full</p>' });
    expect(out.summary).toBe('<p>full</p>');
  });

  it('returns null author/summary when absent', () => {
    const out = normalizeItem({ guid: 'g', link: 'L', title: 'x' });
    expect(out.author).toBeNull();
    expect(out.summary).toBeNull();
  });

  it('normalizeAll maps over items', () => {
    const items = [
      { guid: 'a', title: 'A', link: 'la' },
      { guid: 'b', title: 'B', link: 'lb' },
    ];
    const result = normalizeAll(items);
    expect(result.map((r) => r.guid)).toEqual(['a', 'b']);
    expect(result.map((r) => r.sourceRank)).toEqual([0, 1]);
  });
});
