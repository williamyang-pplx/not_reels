import { describe, it, expect } from 'vitest';
import { formatRelativeTime, reflowText, truncate, cn } from '../src/lib/utils';
import { computeGuid } from '../src/lib/guid';

describe('utils', () => {
  describe('cn', () => {
    it('joins truthy class names', () => {
      expect(cn('a', false, 'b', null, undefined, 'c')).toBe('a b c');
    });
  });

  describe('truncate', () => {
    it('returns string unchanged when under limit', () => {
      expect(truncate('hello', 10)).toBe('hello');
    });
    it('truncates and adds ellipsis when over limit', () => {
      expect(truncate('hello world', 6)).toBe('hello…');
    });
  });

  describe('reflowText', () => {
    it('joins hard-wrapped lines and keeps a break after a sentence', () => {
      expect(reflowText('Hello! I needed bike lights. And I\nalready had some that I\nbought.\nI tried to fix them.')).toBe(
        'Hello! I needed bike lights. And I already had some that I bought.\n\nI tried to fix them.',
      );
    });
    it('treats blank lines and CRLF as paragraph breaks and trims the lines', () => {
      expect(reflowText('  one\r\n\r\n two  \n\n\nthree')).toBe('one\n\ntwo\n\nthree');
    });
    it('leaves single-line text alone', () => {
      expect(reflowText('Just one line')).toBe('Just one line');
      expect(reflowText('')).toBe('');
    });
  });

  describe('formatRelativeTime', () => {
    const NOW = new Date('2026-04-14T12:00:00Z');
    it('returns "just now" for < 60s', () => {
      expect(formatRelativeTime(new Date(NOW.getTime() - 30_000), NOW)).toBe('just now');
    });
    it('returns minutes', () => {
      expect(formatRelativeTime(new Date(NOW.getTime() - 5 * 60_000), NOW)).toBe('5m ago');
    });
    it('returns hours', () => {
      expect(formatRelativeTime(new Date(NOW.getTime() - 3 * 3600_000), NOW)).toBe('3h ago');
    });
    it('returns days', () => {
      expect(formatRelativeTime(new Date(NOW.getTime() - 2 * 86400_000), NOW)).toBe('2d ago');
    });
    it('returns months', () => {
      expect(formatRelativeTime(new Date(NOW.getTime() - 60 * 86400_000), NOW)).toBe('2mo ago');
    });
    it('returns years', () => {
      expect(formatRelativeTime(new Date(NOW.getTime() - 400 * 86400_000), NOW)).toBe('1y ago');
    });
  });

  describe('computeGuid', () => {
    it('prefers item.guid', () => {
      expect(computeGuid({ guid: 'g1', link: 'L', title: 'T', pubDate: 'P' })).toBe('g1');
    });
    it('falls back to link if no guid', () => {
      expect(computeGuid({ link: 'https://x/1', title: 'T', pubDate: 'P' })).toBe('https://x/1');
    });
    it('hashes title+pubDate when no guid or link', () => {
      const a = computeGuid({ title: 'A', pubDate: '2026-04-14' });
      const b = computeGuid({ title: 'A', pubDate: '2026-04-14' });
      const c = computeGuid({ title: 'B', pubDate: '2026-04-14' });
      expect(a).toBe(b);
      expect(a).not.toBe(c);
      expect(a).toMatch(/^[a-f0-9]{64}$/);
    });
    it('treats whitespace-only guid/link as missing', () => {
      const result = computeGuid({ guid: '  ', link: '  ', title: 'T', pubDate: 'P' });
      expect(result).toMatch(/^[a-f0-9]{64}$/);
    });
    it('uses isoDate as fallback for hashing when no pubDate', () => {
      const a = computeGuid({ title: 'X', isoDate: '2026-04-14T00:00:00Z' });
      const b = computeGuid({ title: 'X', isoDate: '2026-04-14T00:00:00Z' });
      expect(a).toBe(b);
    });
  });
});
