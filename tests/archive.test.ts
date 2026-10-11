import { describe, it, expect } from 'vitest';
import { cleanUrl } from '../src/lib/archive';

describe('cleanUrl', () => {
  it('strips query string', () => {
    expect(cleanUrl('https://example.com/a?utm=1&x=2')).toBe('https://example.com/a');
  });

  it('strips fragment', () => {
    expect(cleanUrl('https://example.com/a#section')).toBe('https://example.com/a');
  });

  it('strips query and fragment together', () => {
    expect(cleanUrl('https://example.com/a/b?x=1#y')).toBe('https://example.com/a/b');
  });

  it('preserves path', () => {
    expect(cleanUrl('https://example.com/one/two/three')).toBe(
      'https://example.com/one/two/three',
    );
  });
});
