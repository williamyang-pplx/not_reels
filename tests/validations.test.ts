import { describe, it, expect } from 'vitest';
import {
  CreateFeedSchema,
  UpdateFeedSchema,
  CreateSavedLinkSchema,
  TopicSchema,
} from '../src/lib/validations';

describe('YouTube feed fields', () => {
  const base = { name: 'GD', url: 'https://www.youtube.com/@GoogleDevelopers', topics: ['TECHNOLOGY'] };

  it('rejects a YouTube URL that is not a channel, but keeps playlist RSS feeds', () => {
    const watch = CreateFeedSchema.safeParse({ ...base, url: 'https://www.youtube.com/watch?v=WN-JK-hMAyg' });
    expect(watch.success).toBe(false);
    expect(!watch.success && watch.error.issues[0].message).toBe('YouTube feeds must be a channel URL, like https://www.youtube.com/@name');
    expect(CreateFeedSchema.safeParse({ ...base, url: 'https://www.youtube.com/feeds/videos.xml?playlist_id=PL123' }).success).toBe(true);
  });

  it('takes real calendar days or null', () => {
    expect(CreateFeedSchema.safeParse({ ...base, startDate: '2016-02-29', endDate: null }).success).toBe(true);
    for (const startDate of ['2026-02-30', '2026-1-1', '20260101']) {
      expect(CreateFeedSchema.safeParse({ ...base, startDate }).success, startDate).toBe(false);
    }
  });

  it('rejects turning off both Recent and Archive', () => {
    const r = CreateFeedSchema.safeParse({ ...base, recent: false, archive: false });
    expect(r.success).toBe(false);
    expect(!r.success && r.error.issues[0].message).toBe('Turn on Recent or Archive');
    expect(CreateFeedSchema.safeParse({ ...base, recent: false }).success).toBe(true);
    expect(UpdateFeedSchema.safeParse({ recent: false, archive: true }).success).toBe(true);
  });

  it('rejects an end date before the start date on create and update', () => {
    const range = { startDate: '2020-01-02', endDate: '2020-01-01' };
    expect(CreateFeedSchema.safeParse({ ...base, ...range }).success).toBe(false);
    expect(UpdateFeedSchema.safeParse(range).success).toBe(false);
    expect(UpdateFeedSchema.safeParse({ startDate: '2020-01-01', endDate: '2020-01-01' }).success).toBe(true);
  });
});

describe('validations', () => {
  it('accepts valid CreateFeed payload', () => {
    const r = CreateFeedSchema.safeParse({
      name: 'HN',
      url: 'https://news.ycombinator.com/rss',
      topics: ['TECHNOLOGY'],
    });
    expect(r.success).toBe(true);
  });

  it('stores a subreddit page URL in one form', () => {
    for (const url of ['https://reddit.com/r/ListenToThis', 'https://old.reddit.com/r/listentothis/', 'https://www.reddit.com/r/listentothis/hot']) {
      const r = CreateFeedSchema.safeParse({ name: 'L', url, topics: ['MUSIC'] });
      expect(r.success && r.data.url, url).toBe('https://www.reddit.com/r/listentothis/');
    }
  });

  it('rejects Reddit URLs that are not subreddit pages, RSS feeds included', () => {
    for (const url of [
      'https://www.reddit.com/r/listentothis/hot.rss',
      'https://www.reddit.com/r/listentothis/.rss',
      'https://www.reddit.com/r/a+b/',
      'https://www.reddit.com/user/someone/',
      'https://www.reddit.com/r/listentothis/comments/abc12/x/',
    ]) {
      const r = CreateFeedSchema.safeParse({ name: 'L', url, topics: ['MUSIC'] });
      expect(r.success, url).toBe(false);
      if (!r.success) expect(r.error.issues[0].message).toContain('subreddit URL');
    }
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
