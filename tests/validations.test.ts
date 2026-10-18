import { describe, it, expect } from 'vitest';
import {
  CreateFeedSchema,
  UpdateFeedSchema,
  CreateSavedLinkSchema,
  TopicSchema,
} from '../src/lib/validations';

describe('validations', () => {
  it('accepts valid CreateFeed payload', () => {
    const r = CreateFeedSchema.safeParse({
      name: 'HN',
      url: 'https://news.ycombinator.com/rss',
      topics: ['TECHNOLOGY'],
    });
    expect(r.success).toBe(true);
  });

  it('rejects invalid url', () => {
    const r = CreateFeedSchema.safeParse({
      name: 'X',
      url: 'not-a-url',
      topics: ['TECHNOLOGY'],
    });
    expect(r.success).toBe(false);
  });

  it('accepts registered local feed urls', () => {
    const r = CreateFeedSchema.safeParse({
      name: 'RYM Recs',
      url: 'local/rym_music_recs',
      topics: ['MUSIC'],
    });
    expect(r.success).toBe(true);
  });

  it('rejects unknown local feed providers', () => {
    const r = CreateFeedSchema.safeParse({
      name: 'Unknown',
      url: 'local/unknown_recs',
      topics: ['MUSIC'],
    });
    expect(r.success).toBe(false);
  });

  it('rejects malformed local feed urls', () => {
    for (const url of ['local/', 'local/../x', 'local/BadCase']) {
      const r = CreateFeedSchema.safeParse({
        name: 'Bad local feed',
        url,
        topics: ['MUSIC'],
      });
      expect(r.success).toBe(false);
    }
  });

  it('rejects invalid topic slug format', () => {
    const r = CreateFeedSchema.safeParse({
      name: 'X',
      url: 'https://x.com/rss',
      topics: ['lowercase'],
    });
    expect(r.success).toBe(false);
  });

  it('rejects empty name', () => {
    const r = CreateFeedSchema.safeParse({
      name: '',
      url: 'https://x.com/rss',
      topics: ['NEWS'],
    });
    expect(r.success).toBe(false);
  });

  it('UpdateFeedSchema accepts partial payload', () => {
    expect(UpdateFeedSchema.safeParse({ isActive: false }).success).toBe(true);
    expect(UpdateFeedSchema.safeParse({ topics: ['MUSIC'] }).success).toBe(true);
    expect(UpdateFeedSchema.safeParse({}).success).toBe(true);
  });

  it('CreateSavedLink accepts notes optionally', () => {
    expect(
      CreateSavedLinkSchema.safeParse({
        url: 'https://x.com',
        title: 'My link',
        topic: 'CULTURE',
      }).success,
    ).toBe(true);
  });

  it('TopicSchema accepts uppercase slug format and rejects bad formats', () => {
    for (const t of ['NEWS', 'GAMING', 'TRAVEL_2', 'A']) {
      expect(TopicSchema.safeParse(t).success).toBe(true);
    }
    for (const t of ['lowercase', 'News', 'has space', 'has-dash', '']) {
      expect(TopicSchema.safeParse(t).success).toBe(false);
    }
  });
});
