import { describe, it, expect } from 'vitest';
import {
  CreateFeedSchema,
  UpdateFeedSchema,
  CreateSavedLinkSchema,
  FeedTypeSchema,
  FeedItemsQuerySchema,
  TopicSchema,
} from '../src/lib/validations';

describe('validations', () => {
  it('accepts valid CreateFeed payload', () => {
    const r = CreateFeedSchema.safeParse({
      name: 'HN',
      url: 'https://news.ycombinator.com/rss',
      type: 'FORUM',
      topics: ['TECHNOLOGY'],
    });
    expect(r.success).toBe(true);
  });

  it('rejects invalid url', () => {
    const r = CreateFeedSchema.safeParse({
      name: 'X',
      url: 'not-a-url',
      type: 'FORUM',
      topics: ['TECHNOLOGY'],
    });
    expect(r.success).toBe(false);
  });

  it('accepts registered local feed urls', () => {
    const r = CreateFeedSchema.safeParse({
      name: 'RYM Recs',
      url: 'local/rym_music_recs',
      type: 'BLOG',
      topics: ['MUSIC'],
    });
    expect(r.success).toBe(true);
  });

  it('rejects unknown local feed providers', () => {
    const r = CreateFeedSchema.safeParse({
      name: 'Unknown',
      url: 'local/unknown_recs',
      type: 'BLOG',
      topics: ['MUSIC'],
    });
    expect(r.success).toBe(false);
  });

  it('rejects malformed local feed urls', () => {
    for (const url of ['local/', 'local/../x', 'local/BadCase']) {
      const r = CreateFeedSchema.safeParse({
        name: 'Bad local feed',
        url,
        type: 'BLOG',
        topics: ['MUSIC'],
      });
      expect(r.success).toBe(false);
    }
  });

  it('rejects invalid feed type', () => {
    const r = CreateFeedSchema.safeParse({
      name: 'X',
      url: 'https://x.com/rss',
      type: 'PODCAST',
      topics: ['TECHNOLOGY'],
    });
    expect(r.success).toBe(false);
  });

  it('rejects invalid topic slug format', () => {
    const r = CreateFeedSchema.safeParse({
      name: 'X',
      url: 'https://x.com/rss',
      type: 'BLOG',
      topics: ['lowercase'],
    });
    expect(r.success).toBe(false);
  });

  it('rejects empty name', () => {
    const r = CreateFeedSchema.safeParse({
      name: '',
      url: 'https://x.com/rss',
      type: 'BLOG',
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

  it('FeedTypeSchema enumerates FORUM and BLOG only', () => {
    expect(FeedTypeSchema.safeParse('FORUM').success).toBe(true);
    expect(FeedTypeSchema.safeParse('BLOG').success).toBe(true);
    expect(FeedTypeSchema.safeParse('OTHER').success).toBe(false);
  });

  it('TopicSchema accepts uppercase slug format and rejects bad formats', () => {
    for (const t of ['NEWS', 'GAMING', 'TRAVEL_2', 'A']) {
      expect(TopicSchema.safeParse(t).success).toBe(true);
    }
    for (const t of ['lowercase', 'News', 'has space', 'has-dash', '']) {
      expect(TopicSchema.safeParse(t).success).toBe(false);
    }
  });

  it('FeedItemsQuerySchema accepts recommended/new/random sort values', () => {
    for (const sort of ['recommended', 'new', 'random']) {
      expect(FeedItemsQuerySchema.safeParse({ sort }).success).toBe(true);
    }
    expect(FeedItemsQuerySchema.safeParse({ sort: 'oldest' }).success).toBe(false);
  });
});
