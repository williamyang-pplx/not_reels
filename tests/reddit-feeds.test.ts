import { describe, it, expect } from 'vitest';
import {
  chunkSubreddits,
  groupItemsBySubreddit,
  multiredditFeedUrl,
  parseSubredditFeedUrl,
} from '../src/lib/reddit-feeds';

describe('parseSubredditFeedUrl', () => {
  it('accepts the subreddit listing feed forms', () => {
    expect(parseSubredditFeedUrl('https://www.reddit.com/r/unixporn/hot.rss')).toEqual({ subreddit: 'unixporn', sort: 'hot' });
    expect(parseSubredditFeedUrl('https://reddit.com/r/AlternateAngles/.rss')).toEqual({ subreddit: 'alternateangles', sort: 'hot' });
    expect(parseSubredditFeedUrl('https://old.reddit.com/r/listentothis.rss')).toEqual({ subreddit: 'listentothis', sort: 'hot' });
    expect(parseSubredditFeedUrl('https://www.reddit.com/r/listentothis/new/.rss')).toEqual({ subreddit: 'listentothis', sort: 'new' });
  });

  it('rejects other URLs', () => {
    expect(parseSubredditFeedUrl('https://www.reddit.com/r/unixporn/top.rss?t=week')).toBeNull();
    expect(parseSubredditFeedUrl('https://www.reddit.com/r/a+b/hot.rss')).toBeNull();
    expect(parseSubredditFeedUrl('https://www.reddit.com/user/someone/.rss')).toBeNull();
    expect(parseSubredditFeedUrl('https://notreddit.com/r/unixporn/hot.rss')).toBeNull();
    expect(parseSubredditFeedUrl('local/rym_music_recs')).toBeNull();
  });
});

describe('multiredditFeedUrl', () => {
  it('joins unique subreddits with +', () => {
    expect(multiredditFeedUrl(['a1', 'b2', 'a1'], 'new')).toBe('https://www.reddit.com/r/a1+b2/new.rss?limit=100');
  });
});

describe('groupItemsBySubreddit', () => {
  it('groups entries by the lowercase subreddit of their post link, in order', () => {
    const groups = groupItemsBySubreddit([
      { link: 'https://www.reddit.com/r/UnixPorn/comments/aaaaa/x/' },
      { link: 'https://www.reddit.com/r/pics/comments/bbbbb/y/' },
      { link: 'https://www.reddit.com/r/unixporn/comments/ccccc/z/' },
      { link: 'https://example.com/not-a-post' },
      {},
    ]);
    expect([...groups.keys()]).toEqual(['unixporn', 'pics']);
    expect(groups.get('unixporn')?.map((i) => i.link)).toEqual([
      'https://www.reddit.com/r/UnixPorn/comments/aaaaa/x/',
      'https://www.reddit.com/r/unixporn/comments/ccccc/z/',
    ]);
  });
});

describe('chunkSubreddits', () => {
  it('dedupes, then splits into groups of the given size', () => {
    expect(chunkSubreddits(['a', 'b', 'a', 'c', 'd', 'e'], 2)).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
    expect(chunkSubreddits([])).toEqual([]);
  });
});

