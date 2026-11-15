import { describe, it, expect } from 'vitest';
import {
  fetchSubredditItems,
  parseLegacySubredditRssUrl,
  parseListingExtras,
  parseRssMedia,
  parseSubredditFeedUrl,
  subredditFeedUrl,
  redlibSubredditPath,
  redlibThreadPath,
} from '../src/lib/reddit-feeds';
import { GALLERY_CONTENT, LISTING_HTML, RSS_ITEMS, TEXT_CONTENT, VIDEO_CONTENT } from './fixtures/redlib';

describe('parseSubredditFeedUrl', () => {
  it('accepts the subreddit page forms', () => {
    expect(parseSubredditFeedUrl('https://www.reddit.com/r/listentothis')).toEqual({ subreddit: 'listentothis', sort: 'hot' });
    expect(parseSubredditFeedUrl('https://www.reddit.com/r/ListenToThis/')).toEqual({ subreddit: 'listentothis', sort: 'hot' });
    expect(parseSubredditFeedUrl('https://reddit.com/r/unixporn/new')).toEqual({ subreddit: 'unixporn', sort: 'new' });
    expect(parseSubredditFeedUrl('https://old.reddit.com/r/unixporn/top/')).toEqual({ subreddit: 'unixporn', sort: 'top' });
  });

  it('rejects other URLs, the old RSS feeds included', () => {
    expect(parseSubredditFeedUrl('https://www.reddit.com/r/unixporn/hot.rss')).toBeNull();
    expect(parseSubredditFeedUrl('https://www.reddit.com/r/unixporn/.rss')).toBeNull();
    expect(parseSubredditFeedUrl('https://www.reddit.com/r/unixporn/top.rss?t=week')).toBeNull();
    expect(parseSubredditFeedUrl('https://www.reddit.com/r/unixporn/?sort=new')).toBeNull();
    expect(parseSubredditFeedUrl('https://www.reddit.com/r/a+b/hot.rss')).toBeNull();
    expect(parseSubredditFeedUrl('https://www.reddit.com/r/unixporn/comments/abc12/x/')).toBeNull();
    expect(parseSubredditFeedUrl('https://www.reddit.com/user/someone/.rss')).toBeNull();
    expect(parseSubredditFeedUrl('https://notreddit.com/r/unixporn/hot.rss')).toBeNull();
    expect(parseSubredditFeedUrl('local/rym_music_recs')).toBeNull();
  });
});

describe('parseLegacySubredditRssUrl', () => {
  it('accepts the old subreddit RSS forms and nothing else', () => {
    expect(parseLegacySubredditRssUrl('https://www.reddit.com/r/unixporn/hot.rss')).toEqual({ subreddit: 'unixporn', sort: 'hot' });
    expect(parseLegacySubredditRssUrl('https://reddit.com/r/AlternateAngles/.rss')).toEqual({ subreddit: 'alternateangles', sort: 'hot' });
    expect(parseLegacySubredditRssUrl('https://old.reddit.com/r/listentothis.rss')).toEqual({ subreddit: 'listentothis', sort: 'hot' });
    expect(parseLegacySubredditRssUrl('https://www.reddit.com/r/listentothis/new/.rss')).toEqual({ subreddit: 'listentothis', sort: 'new' });
    expect(parseLegacySubredditRssUrl('https://www.reddit.com/r/listentothis/')).toBeNull();
    expect(parseLegacySubredditRssUrl('https://www.reddit.com/r/a+b/hot.rss')).toBeNull();
  });
});

describe('subredditFeedUrl', () => {
  it('is the www page URL, with the sort unless it is hot', () => {
    expect(subredditFeedUrl({ subreddit: 'unixporn', sort: 'hot' })).toBe('https://www.reddit.com/r/unixporn/');
    expect(subredditFeedUrl({ subreddit: 'unixporn', sort: 'new' })).toBe('https://www.reddit.com/r/unixporn/new/');
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

describe('parseRssMedia', () => {
  const base = 'http://127.0.0.1:8180';

  it('takes every gallery image in order, as same-origin paths with entities decoded', () => {
    expect(parseRssMedia(GALLERY_CONTENT, base)).toEqual({
      images: [
        '/preview/pre/6m6frwds2o1i1.jpeg?width=4284&format=pjpg&auto=webp&s=443c',
        '/preview/pre/x4qkbzds2o1i1.jpeg?width=3024&format=pjpg&s=99a7',
      ],
      video: null,
    });
  });

  it('reduces absolute Redlib URLs (REDLIB_FULL_URL) to paths', () => {
    const absolute = GALLERY_CONTENT.replaceAll('src="/preview', 'src="http://127.0.0.1:3200/preview');
    expect(parseRssMedia(absolute, base).images[0]).toBe('/preview/pre/6m6frwds2o1i1.jpeg?width=4284&format=pjpg&auto=webp&s=443c');
  });

  it("takes a video's source and poster", () => {
    expect(parseRssMedia(VIDEO_CONTENT, base)).toEqual({
      images: [],
      video: { src: '/vid/z541z5rqzm1i1/CMAF/1080.mp4', poster: '/preview/external-pre/ZHN1aWls.png?format=pjpg&auto=webp&s=c49d' },
    });
  });

  it('finds no media in a text post', () => {
    expect(parseRssMedia(TEXT_CONTENT, base)).toEqual({ images: [], video: null });
  });
});

describe('parseListingExtras', () => {
  const extras = parseListingExtras(LISTING_HTML);

  it('keys a stickied post with flair by its post ID, not the flair link', () => {
    expect(extras.get('1xre9hw')).toEqual({ url: null, score: '18', comments: 35 });
  });

  it("takes a link post's URL from its thumbnail link, entities decoded, and reads a hidden score as null", () => {
    expect(extras.get('1xwqj5c')).toEqual({ url: 'https://www.youtube.com/watch?v=OpG_9PRNzOA&list=x', score: null, comments: 1 });
  });

  it('gives a gallery post no URL (its thumbnail links back to the thread)', () => {
    expect(extras.get('1xwh3rz')).toEqual({ url: null, score: '197', comments: 7 });
  });

  it('reads nothing from markup it does not know', () => {
    expect(parseListingExtras('<html><body>Reddit blocked this request</body></html>').size).toBe(0);
  });
});

describe('fetchSubredditItems', () => {
  const base = 'http://127.0.0.1:8180';
  const feed = { subreddit: 'listentothis', sort: 'hot' };
  const now = new Date('2026-11-15T12:00:00Z');

  it('turns Redlib posts into items with reddit.com links, text and media', async () => {
    const asked: string[] = [];
    const items = await fetchSubredditItems(
      feed,
      base,
      async (url) => (asked.push(url), { items: RSS_ITEMS }),
      async (url) => (asked.push(url), LISTING_HTML),
      now,
    );
    expect(asked.sort()).toEqual([`${base}/r/listentothis/hot`, `${base}/r/listentothis/hot.rss`]);
    expect(items.map((i) => [i.guid, i.link, i.sourceRank])).toEqual([
      ['/r/listentothis/comments/1xre9hw/music_melting_pot_week_of_november_09_2026/', 'https://www.reddit.com/r/listentothis/comments/1xre9hw/music_melting_pot_week_of_november_09_2026/', 0],
      ['/r/listentothis/comments/1xwqj5c/neo_boys_rich_mans_dreams_punk_1980/', 'https://www.reddit.com/r/listentothis/comments/1xwqj5c/neo_boys_rich_mans_dreams_punk_1980/', 1],
      ['/r/listentothis/comments/1xwh3rz/concrete_city_pa_usa/', 'https://www.reddit.com/r/listentothis/comments/1xwh3rz/concrete_city_pa_usa/', 2],
    ]);
    const [text, link, gallery] = items;
    expect(text.summary).toBe("The melting pot is a free-for-all music sharing thread.\nAnything you've been listening to.");
    expect(link.summary).toBeNull();
    expect(gallery.summary).toBeNull();
    expect(JSON.parse(link.media!)).toEqual({ images: [], video: null, url: 'https://www.youtube.com/watch?v=OpG_9PRNzOA&list=x', score: null, comments: 1 });
    expect(JSON.parse(gallery.media!)).toMatchObject({ images: [expect.stringContaining('6m6frwds2o1i1'), expect.stringContaining('x4qkbzds2o1i1')], score: '197', comments: 7 });
    expect(text.author).toBe('AutoModerator');
    expect(text.publishedAt.toISOString()).toBe('2026-11-09T01:00:07.000Z');
  });

  it('fails when the listing page cannot be fetched', async () => {
    await expect(
      fetchSubredditItems(feed, base, async () => ({ items: RSS_ITEMS }), async () => Promise.reject(new Error('503')), now),
    ).rejects.toThrow('503');
  });

  it('fails when the feed has items but none is a Reddit thread (rather than storing nothing)', async () => {
    await expect(
      fetchSubredditItems(feed, base, async () => ({ items: [{ title: 'x', link: '/settings' }] }), async () => '', now),
    ).rejects.toThrow(/No Reddit posts/);
  });
});
