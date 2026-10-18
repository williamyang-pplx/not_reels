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

  it('takes the full <content:encoded> text over a shorter <description>', () => {
    const out = normalizeItem({ guid: 'g', link: 'L', contentSnippet: 'Teaser.', 'content:encodedSnippet': 'Full body.\nSecond para.' });
    expect(out.summary).toBe('Full body.\nSecond para.');
  });

  it('keeps the description when it is the longer text', () => {
    const out = normalizeItem({ guid: 'g', link: 'L', contentSnippet: 'A long description here.', 'content:encodedSnippet': 'Short.' });
    expect(out.summary).toBe('A long description here.');
  });

  it('reads an Atom <summary>, tags removed', () => {
    const out = normalizeItem({ guid: 'g', link: 'L', summary: '<p>One &amp; two</p><p>Three</p>' });
    expect(out.summary).toBe('One &amp; two\nThree');
  });

  it('reads a YouTube description from media:group without links, timestamps, dividers or hashtags', () => {
    const description = 'What this video is about.\nPatreon: https://patreon.com/x\n\n0:00 Intro\n(1:02:03) Outro\n-----\n#math #science\nMore prose.';
    const out = normalizeItem({ guid: 'g', link: 'L', mediaGroup: { 'media:description': [description] } });
    expect(out.summary).toBe('What this video is about.\n\nMore prose.');
  });

  it('drops emptied link labels and the credits roll from a YouTube description', () => {
    const description = 'How a CPU works.\nSocial media:\nhttps://x.com/y\nIt is simpler than it looks.\nSpecial thanks to these supporters:\nAlice, Bob';
    const out = normalizeItem({ guid: 'g', link: 'L', mediaGroup: { 'media:description': [description] } });
    expect(out.summary).toBe('How a CPU works.\nIt is simpler than it looks.');
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
