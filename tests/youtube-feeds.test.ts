import { describe, it, expect, beforeEach } from 'vitest';
import { getDb } from '../src/db';
import type { ParsedFeed } from '../src/lib/rss-fetcher';
import type { YouTubeFeedOptions } from '../src/lib/types';
import {
  fetchYouTubeFeedItems,
  rssVideos,
  youTubeOptionsFromRow,
  youTubeOptionsFromSettings,
  youTubeRssUrl,
  youTubeSettingsFromOptions,
} from '../src/lib/youtube-feeds';
import { CHANNEL_ID, rssItem, seedVideos } from './fixtures/youtube';
import { resetDb } from './helpers';

const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const BOTH: YouTubeFeedOptions = { recent: true, archive: true, includeShorts: false, publishedAfter: null, publishedBefore: null };
const NOW = new Date('2026-11-22T10:00:00Z');

/** A FeedFetcher serving one channel's RSS items, recording the URLs it was asked for. */
function rssFetcher(items: ReturnType<typeof rssItem>[]) {
  const urls: string[] = [];
  const fetcher = async (url: string): Promise<ParsedFeed> => {
    urls.push(url);
    return { items };
  };
  return { fetcher, urls };
}

const archiveRows = () =>
  getDb().prepare('SELECT "videoId", "isShort" FROM "YouTubeVideo" ORDER BY "videoId"').all() as { videoId: string; isShort: number }[];

beforeEach(() => {
  resetDb();
});

describe('rssVideos', () => {
  it('reads the video ID from watch and Shorts links and marks Shorts by the link', () => {
    const videos = rssVideos(
      [rssItem('WN-JK-hMAyg', '2026-11-20T20:00:04Z'), rssItem('cv8tEbKtEvk', '2026-11-19T10:00:00Z', { short: true })],
      CHANNEL_ID,
    );
    expect(videos).toEqual([
      {
        videoId: 'WN-JK-hMAyg',
        channelId: CHANNEL_ID,
        title: 'Video WN-JK-hMAyg',
        summary: 'About WN-JK-hMAyg',
        author: 'Google for Developers',
        uploadedAt: Date.parse('2026-11-20T20:00:04Z'),
        isShort: false,
      },
      expect.objectContaining({ videoId: 'cv8tEbKtEvk', isShort: true }),
    ]);
  });

  it('falls back to (untitled), trims the summary and skips items without a video or a date', () => {
    const long = 'x'.repeat(2000);
    const videos = rssVideos(
      [
        { ...rssItem('aaaaaaaaaaa', '2026-11-20T00:00:00Z', { description: long }), title: '  ' },
        { ...rssItem('bbbbbbbbbbb', '2026-11-20T00:00:00Z'), link: 'https://example.com/not-a-video' },
        { ...rssItem('ccccccccccc', ''), isoDate: undefined },
      ],
      CHANNEL_ID,
    );
    expect(videos).toHaveLength(1);
    expect(videos[0].title).toBe('(untitled)');
    expect(videos[0].summary).toHaveLength(1000);
  });
});

describe('fetchYouTubeFeedItems', () => {
  const recent = [
    rssItem('r0000000000', '2026-11-21T00:00:00Z'),
    rssItem('r0000000001', '2026-11-20T00:00:00Z', { short: true }),
    rssItem('r0000000002', '2026-11-19T00:00:00Z'),
  ];

  it('reads the recent videos from the channel RSS feed and saves every one, Shorts included', async () => {
    const { fetcher, urls } = rssFetcher(recent);
    const items = await fetchYouTubeFeedItems(CHANNEL_ID, { ...BOTH, archive: false }, fetcher, NOW);
    expect(urls).toEqual([youTubeRssUrl(CHANNEL_ID)]);
    expect(items.map((i) => i.link)).toEqual([
      'https://www.youtube.com/watch?v=r0000000000',
      'https://www.youtube.com/watch?v=r0000000002',
    ]);
    expect(items[0]).toMatchObject({
      guid: 'https://www.youtube.com/watch?v=r0000000000',
      publishedAt: new Date('2026-11-21T00:00:00Z'),
      uploadedAt: new Date('2026-11-21T00:00:00Z'),
    });
    expect(archiveRows()).toEqual([
      { videoId: 'r0000000000', isShort: 0 },
      { videoId: 'r0000000001', isShort: 1 },
      { videoId: 'r0000000002', isShort: 0 },
    ]);
  });

  it('keeps Shorts in the recent videos when Shorts are on', async () => {
    const { fetcher } = rssFetcher(recent);
    const items = await fetchYouTubeFeedItems(CHANNEL_ID, { ...BOTH, archive: false, includeShorts: true }, fetcher, NOW);
    expect(items).toHaveLength(3);
  });

  it('picks 15 archive videos only, dated now with their upload date, without reading RSS', async () => {
    await seedVideos(CHANNEL_ID, 40);
    const { fetcher, urls } = rssFetcher(recent);
    const items = await fetchYouTubeFeedItems(CHANNEL_ID, { ...BOTH, recent: false }, fetcher, NOW);
    expect(urls).toEqual([]);
    expect(items).toHaveLength(15);
    expect(items.every((i) => i.publishedAt.getTime() === NOW.getTime())).toBe(true);
    expect(items.every((i) => i.uploadedAt!.getTime() < day('2016-01-01'))).toBe(true);
  });

  it('interleaves recent videos and archive picks, with no video twice', async () => {
    await seedVideos(CHANNEL_ID, 40);
    const { fetcher } = rssFetcher(recent);
    const items = await fetchYouTubeFeedItems(CHANNEL_ID, BOTH, fetcher, NOW);
    expect(items).toHaveLength(15);
    expect(items.slice(0, 4).map((i) => i.link.slice(-11, -10))).toEqual(['r', 'a', 'r', 'a']);
    expect(items.map((i) => i.sourceRank)).toEqual(items.map((_, i) => i));
    expect(new Set(items.map((i) => i.guid)).size).toBe(items.length);
  });
});

describe('fetchYouTubeFeedItems: 15 posts, up to 4 of them recent', () => {
  /** RSS videos `days` days before NOW (newest first), ids r0000000000, r0000000001, … */
  const daysAgo = (...days: number[]) =>
    days.map((d, i) => rssItem(`r${String(i).padStart(10, '0')}`, new Date(NOW.getTime() - d * 86_400_000).toISOString()));
  const recentIds = (items: { link: string; publishedAt: Date }[]) =>
    items.filter((i) => i.publishedAt.getTime() !== NOW.getTime()).map((i) => i.link.slice(-11));

  it('takes the 4 newest videos from the past 30 days and 11 archive picks, none of them from the RSS feed', async () => {
    await seedVideos(CHANNEL_ID, 40);
    const { fetcher } = rssFetcher(daysAgo(1, 2, 3, 4, 5, 6, 40, 50));
    const items = await fetchYouTubeFeedItems(CHANNEL_ID, BOTH, fetcher, NOW);
    expect(items).toHaveLength(15);
    expect(recentIds(items)).toEqual(['r0000000000', 'r0000000001', 'r0000000002', 'r0000000003']);
    expect(items.filter((i) => i.link.slice(-11, -10) === 'r')).toHaveLength(4);
  });

  it('gives the archive more posts when fewer videos are from the past month', async () => {
    await seedVideos(CHANNEL_ID, 40);
    const { fetcher } = rssFetcher(daysAgo(10, 20, 29, 31, 60));
    const items = await fetchYouTubeFeedItems(CHANNEL_ID, BOTH, fetcher, NOW);
    expect(recentIds(items)).toEqual(['r0000000000', 'r0000000001', 'r0000000002']);
    expect(items).toHaveLength(15);
    const none = await fetchYouTubeFeedItems(CHANNEL_ID, BOTH, rssFetcher(daysAgo(40, 50)).fetcher, NOW);
    expect(recentIds(none)).toEqual([]);
    expect(none).toHaveLength(15);
  });

  it('tops up with older RSS videos when the archive runs short', async () => {
    await seedVideos(CHANNEL_ID, 3);
    const { fetcher } = rssFetcher(daysAgo(1, 2, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150));
    const items = await fetchYouTubeFeedItems(CHANNEL_ID, BOTH, fetcher, NOW);
    expect(items).toHaveLength(15);
    expect(recentIds(items)).toHaveLength(12);
    expect(items.filter((i) => i.publishedAt.getTime() === NOW.getTime())).toHaveLength(3);
  });

  it('with Archive off, shows up to 15 RSS videos of any age', async () => {
    const { fetcher } = rssFetcher(daysAgo(1, 40, 400));
    const items = await fetchYouTubeFeedItems(CHANNEL_ID, { ...BOTH, archive: false }, fetcher, NOW);
    expect(recentIds(items)).toEqual(['r0000000000', 'r0000000001', 'r0000000002']);
  });
});

describe('youTubeOptionsFromRow', () => {
  it('reads null toggles as on and a null Shorts setting as off', () => {
    const row = { publishedAfter: null, publishedBefore: null, includeShorts: null, showRecent: null, showArchive: null };
    expect(youTubeOptionsFromRow(row)).toEqual(BOTH);
    expect(youTubeOptionsFromRow({ ...row, showRecent: 0, showArchive: 1, includeShorts: 1 })).toMatchObject({
      recent: false,
      archive: true,
      includeShorts: true,
    });
  });
});

describe('youTubeOptionsFromSettings and youTubeSettingsFromOptions', () => {
  it('store UTC days with the end day included, and read them back', () => {
    const settings = { recent: true, archive: false, includeShorts: true, startDate: '2015-01-01', endDate: '2017-12-31' };
    const options = youTubeOptionsFromSettings(settings);
    expect(options).toEqual({
      recent: true,
      archive: false,
      includeShorts: true,
      publishedAfter: day('2015-01-01'),
      publishedBefore: day('2018-01-01'),
    });
    expect(youTubeSettingsFromOptions(options)).toEqual(settings);
    const open = { ...settings, startDate: null, endDate: null };
    expect(youTubeSettingsFromOptions(youTubeOptionsFromSettings(open))).toEqual(open);
  });
});
