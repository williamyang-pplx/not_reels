import { describe, it, expect } from 'vitest';
import {
  mixSubredditWindows,
  parseSubredditFeedUrl,
  redlibSubredditPath,
  redlibThreadPath,
} from '../src/lib/reddit-feeds';

describe('parseSubredditFeedUrl', () => {
  it('accepts the subreddit page forms', () => {
    expect(parseSubredditFeedUrl('https://www.reddit.com/r/listentothis')).toEqual({ subreddit: 'listentothis', sort: 'hot' });
    expect(parseSubredditFeedUrl('https://www.reddit.com/r/ListenToThis/')).toEqual({ subreddit: 'listentothis', sort: 'hot' });
    expect(parseSubredditFeedUrl('https://reddit.com/r/unixporn/new')).toEqual({ subreddit: 'unixporn', sort: 'new' });
    expect(parseSubredditFeedUrl('https://old.reddit.com/r/unixporn/top/')).toEqual({ subreddit: 'unixporn', sort: 'top' });
  });

  it('accepts the old subreddit RSS forms', () => {
    expect(parseSubredditFeedUrl('https://www.reddit.com/r/unixporn/hot.rss')).toEqual({ subreddit: 'unixporn', sort: 'hot' });
    expect(parseSubredditFeedUrl('https://reddit.com/r/AlternateAngles/.rss')).toEqual({ subreddit: 'alternateangles', sort: 'hot' });
    expect(parseSubredditFeedUrl('https://old.reddit.com/r/listentothis.rss')).toEqual({ subreddit: 'listentothis', sort: 'hot' });
    expect(parseSubredditFeedUrl('https://www.reddit.com/r/listentothis/new/.rss')).toEqual({ subreddit: 'listentothis', sort: 'new' });
  });

  it('rejects other URLs', () => {
    expect(parseSubredditFeedUrl('https://www.reddit.com/r/unixporn/top.rss?t=week')).toBeNull();
    expect(parseSubredditFeedUrl('https://www.reddit.com/r/unixporn/?sort=new')).toBeNull();
    expect(parseSubredditFeedUrl('https://www.reddit.com/r/a+b/hot.rss')).toBeNull();
    expect(parseSubredditFeedUrl('https://www.reddit.com/r/unixporn/comments/abc12/x/')).toBeNull();
    expect(parseSubredditFeedUrl('https://www.reddit.com/user/someone/.rss')).toBeNull();
    expect(parseSubredditFeedUrl('https://notreddit.com/r/unixporn/hot.rss')).toBeNull();
    expect(parseSubredditFeedUrl('local/rym_music_recs')).toBeNull();
  });
});

describe('redlibSubredditPath', () => {
  it('builds the Redlib listing path', () => {
    expect(redlibSubredditPath({ subreddit: 'listentothis', sort: 'hot' })).toBe('/r/listentothis/hot');
  });
});

describe('redlibThreadPath', () => {
  it('builds the Redlib thread path, with the slug when there is one', () => {
    expect(redlibThreadPath({ subreddit: 'unixporn', postId: '1xv94f8', slug: 'lucid' })).toBe('/r/unixporn/comments/1xv94f8/lucid');
    expect(redlibThreadPath({ subreddit: 'unixporn', postId: '1xv94f8', slug: '' })).toBe('/r/unixporn/comments/1xv94f8');
  });
});

describe('mixSubredditWindows', () => {
  const items = Array.from({ length: 10 }, (_, i) => `i${i}`);
  const windows = (n: number) => Array.from({ length: n }, (_, i) => `W${i}`);
  /** The mixed list as labels, so a test reads like the feed. */
  const mix = (its: string[], ws: string[]) => mixSubredditWindows(its, ws).map((e) => ('window' in e ? e.window : e.item));

  it('leaves the items alone without windows', () => {
    expect(mix(items, [])).toEqual(items);
  });

  it('fills positions 0, 2, 4, then 1, 3, keeping window order', () => {
    expect(mix(items, windows(1)).slice(0, 3)).toEqual(['W0', 'i0', 'i1']);
    expect(mix(items, windows(2)).slice(0, 4)).toEqual(['W0', 'i0', 'W1', 'i1']);
    expect(mix(items, windows(4)).slice(0, 6)).toEqual(['W0', 'W1', 'W2', 'i0', 'W3', 'i1']);
    expect(mix(items, windows(5)).slice(0, 6)).toEqual(['W0', 'W1', 'W2', 'W3', 'W4', 'i0']);
  });

  it('puts windows past the fifth right after position 4', () => {
    expect(mix(items, windows(7)).slice(0, 8)).toEqual(['W0', 'W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'i0']);
    expect(mix(items, windows(7))).toHaveLength(17);
  });

  it('appends the remaining windows once the items run out', () => {
    expect(mix(['i0'], windows(3))).toEqual(['W0', 'i0', 'W1', 'W2']);
    expect(mix([], windows(2))).toEqual(['W0', 'W1']);
  });
});
