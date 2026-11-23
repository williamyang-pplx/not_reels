import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDb } from '../src/db';
import type { YouTubeFeedOptions } from '../src/lib/types';
import {
  archiveInfo,
  markShown,
  pickArchiveVideos,
  saveYouTubeVideos,
  startYouTubeFill,
  type YouTubeVideoRow,
} from '../src/lib/youtube-archive';
import { CHANNEL_ID, playlistPage, seedVideos, statsAnswer, video } from './fixtures/youtube';
import { resetDb } from './helpers';

const ALL: YouTubeFeedOptions = { recent: true, archive: true, includeShorts: false, publishedAfter: null, publishedBefore: null };
const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const UU = 'UU' + CHANNEL_ID.slice(2);
const UUSH = 'UUSH' + CHANNEL_ID.slice(2);

const row = (videoId: string, over: Partial<YouTubeVideoRow> = {}): YouTubeVideoRow => ({
  videoId,
  channelId: CHANNEL_ID,
  title: `T ${videoId}`,
  summary: null,
  author: null,
  uploadedAt: day('2015-06-01'),
  isShort: false,
  viewCount: 1,
  ...over,
});

const videoRow = (id: string) =>
  getDb().prepare('SELECT * FROM "YouTubeVideo" WHERE "videoId" = ?').get(id) as
    | { title: string; isShort: number; lastShownAt: number | null; summary: string | null; viewCount: number | null }
    | undefined;
const channelRow = () =>
  getDb().prepare('SELECT * FROM "YouTubeChannel" WHERE "channelId" = ?').get(CHANNEL_ID) as
    | { filledAt: number | null; fillError: string | null }
    | undefined;

/** A JsonFetcher serving each playlist's pages (by playlistId and pageToken p1, p2, …). */
function playlistsFetcher(playlists: Record<string, ReturnType<typeof playlistPage>[] | Error>) {
  const urls: string[] = [];
  const fetchJson = async (url: string) => {
    urls.push(url);
    if (url.includes('/videos?')) return statsAnswer(url);
    const params = new URL(url).searchParams;
    const pages = playlists[params.get('playlistId')!];
    if (!pages) throw new Error('YouTube API 404 playlistNotFound');
    if (pages instanceof Error) throw pages;
    const token = params.get('pageToken');
    return pages[token ? Number(token.slice(1)) : 0];
  };
  return { fetchJson, urls };
}

beforeEach(() => {
  resetDb();
  vi.stubEnv('YOUTUBE_API_KEY', 'test-key');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('saveYouTubeVideos', () => {
  it('adds new videos and leaves known ones as they are', () => {
    expect(saveYouTubeVideos([row('a'), row('b')])).toBe(2);
    markShown(['a'], 123);
    expect(saveYouTubeVideos([row('a', { title: 'changed' }), row('c')])).toBe(1);
    expect(videoRow('a')).toMatchObject({ title: 'T a', lastShownAt: 123 });
  });

  it('takes a known video\'s RSS view count, keeping its lastShownAt, and keeps the count when RSS has none', () => {
    saveYouTubeVideos([row('a', { viewCount: 10 })]);
    markShown(['a'], 123);
    expect(saveYouTubeVideos([row('a', { viewCount: 20 })])).toBe(0);
    expect(videoRow('a')).toMatchObject({ viewCount: 20, lastShownAt: 123 });
    saveYouTubeVideos([row('a', { viewCount: null })]);
    expect(videoRow('a')?.viewCount).toBe(20);
  });
});

describe('pickArchiveVideos by view count', () => {
  const ids = (videos: YouTubeVideoRow[]) => videos.map((v) => v.videoId);
  const setViews = (id: string, n: number | null) =>
    getDb().prepare('UPDATE "YouTubeVideo" SET "viewCount" = ? WHERE "videoId" = ?').run(n, id);

  it('takes 75% of the picks from the top half by views and the rest from the bottom, top first', async () => {
    const seeded = await seedVideos(CHANNEL_ID, 40); // views 1000 - i: the first 20 are the top half
    const top = new Set(seeded.slice(0, 20));
    const picked = ids(pickArchiveVideos(CHANNEL_ID, ALL, [], 11));
    expect(picked).toHaveLength(11);
    expect(picked.slice(0, 8).every((id) => top.has(id))).toBe(true);
    expect(picked.slice(8).every((id) => !top.has(id))).toBe(true);
  });

  it('makes up a short half from the other', async () => {
    const seeded = await seedVideos(CHANNEL_ID, 40);
    const top = new Set(seeded.slice(0, 20));
    const fewTop = ids(pickArchiveVideos(CHANNEL_ID, ALL, seeded.slice(0, 18), 11));
    expect(fewTop.filter((id) => top.has(id))).toHaveLength(2);
    expect(fewTop).toHaveLength(11);
    const fewBottom = ids(pickArchiveVideos(CHANNEL_ID, ALL, seeded.slice(20, 39), 11));
    expect(fewBottom.filter((id) => !top.has(id))).toEqual([seeded[39]]);
    expect(fewBottom).toHaveLength(11);
  });

  it('keeps each video in the half it has among all eligible videos, whatever is excluded', async () => {
    // Without 15 of the bottom 20, halves recomputed over the rest would move top videos 13–19 into the bottom; as
    // never-shown videos they would then beat the 5 remaining (shown) bottom videos.
    const seeded = await seedVideos(CHANNEL_ID, 40);
    const bottomLeft = seeded.slice(35);
    markShown(bottomLeft, 100);
    const picked = ids(pickArchiveVideos(CHANNEL_ID, ALL, seeded.slice(20, 35), 11));
    expect(picked.slice(8).every((id) => bottomLeft.includes(id))).toBe(true);
  });

  it('puts the middle video of an odd count in the top half, and orders equal counts by video ID', async () => {
    const five = await seedVideos(CHANNEL_ID, 5);
    const picked = ids(pickArchiveVideos(CHANNEL_ID, ALL, [], 4));
    expect(picked.slice(0, 3).sort()).toEqual(five.slice(0, 3));
    resetDb();
    const equal = await seedVideos(CHANNEL_ID, 4, { views: () => 7 });
    expect(ids(pickArchiveVideos(CHANNEL_ID, ALL, [], 2)).sort()).toEqual(equal.slice(0, 2));
  });

  it('fills with videos not counted yet only after the counted ones', async () => {
    const counted = await seedVideos(CHANNEL_ID, 3, { prefix: 'c' });
    await seedVideos(CHANNEL_ID, 20, { prefix: 'u', views: () => null });
    const picked = ids(pickArchiveVideos(CHANNEL_ID, ALL, [], 11));
    expect(picked).toHaveLength(11);
    expect(picked.slice(0, 3).sort()).toEqual(counted);
    expect(picked.slice(3).every((id) => id.startsWith('u'))).toBe(true);
  });

  it('never picks a gone, saved or hidden video', async () => {
    const seeded = await seedVideos(CHANNEL_ID, 5);
    setViews(seeded[0], -1);
    const watch = (id: string) => `https://www.youtube.com/watch?v=${id}`;
    getDb()
      .prepare('INSERT INTO "SavedLink" ("id", "url", "title", "topic", "updatedAt") VALUES (?, ?, ?, ?, ?)')
      .run('s1', watch(seeded[1]), 'Saved', 'NEWS', Date.now());
    getDb().prepare('INSERT INTO "HiddenLink" ("id", "url") VALUES (?, ?)').run('h1', watch(seeded[2]));
    expect(ids(pickArchiveVideos(CHANNEL_ID, ALL, [], 11)).sort()).toEqual(seeded.slice(3));
  });

  it('splits by views inside the date range', async () => {
    const seeded = await seedVideos(CHANNEL_ID, 10, { newest: '2015-01-10T12:00:00Z' }); // ids[i]: 2015-01-(10 - i)
    const range = { ...ALL, publishedAfter: day('2015-01-01'), publishedBefore: day('2015-01-05') }; // ids 6–9
    // Halves over the whole channel would put all four in the bottom, where never-shown 8 and 9 come first.
    markShown(seeded.slice(6, 8), 100);
    const picked = ids(pickArchiveVideos(CHANNEL_ID, range, [], 4));
    expect(picked.slice(0, 2).sort()).toEqual(seeded.slice(6, 8));
  });
});

describe('pickArchiveVideos', () => {
  it('takes never-shown videos first, then the least recently shown (within a group: here, all uncounted)', async () => {
    const ids = await seedVideos(CHANNEL_ID, 5, { views: () => null });
    markShown([ids[0]], 100);
    markShown([ids[1]], 200);
    markShown([ids[2], ids[3], ids[4]], 300);
    saveYouTubeVideos([row('fresh', { viewCount: null })]);
    expect(pickArchiveVideos(CHANNEL_ID, ALL, [], 3).map((v) => v.videoId)).toEqual(['fresh', ids[0], ids[1]]);
  });

  it('keeps to the date range, drops Shorts unless they are on, and skips excluded videos', async () => {
    const ids = await seedVideos(CHANNEL_ID, 10, { newest: '2015-01-10T12:00:00Z', shortEvery: 3 });
    // ids[i] is 2015-01-(10 - i); Shorts are ids 0, 3, 6, 9.
    const range = { ...ALL, publishedAfter: day('2015-01-03'), publishedBefore: day('2015-01-09') };
    const picked = pickArchiveVideos(CHANNEL_ID, range, [ids[4]], 30).map((v) => v.videoId).sort();
    expect(picked).toEqual([ids[2], ids[5], ids[7]].sort());
    const withShorts = pickArchiveVideos(CHANNEL_ID, { ...range, includeShorts: true }, [], 30);
    expect(withShorts).toHaveLength(6);
    expect(withShorts.find((v) => v.videoId === ids[3])?.isShort).toBe(true);
  });

  it('returns only the channel’s own videos, at most `count`', async () => {
    await seedVideos(CHANNEL_ID, 40);
    await seedVideos('UCbbbbbbbbbbbbbbbbbbbbbb', 5, { prefix: 'b' });
    const picked = pickArchiveVideos(CHANNEL_ID, ALL, [], 30);
    expect(picked).toHaveLength(30);
    expect(picked.every((v) => v.channelId === CHANNEL_ID)).toBe(true);
  });
});

describe('archiveInfo', () => {
  it('reports each channel’s size and fill state', async () => {
    await seedVideos(CHANNEL_ID, 3);
    getDb().exec(`INSERT INTO "YouTubeChannel" ("channelId", "filledAt") VALUES ('${CHANNEL_ID}', 1);
      INSERT INTO "YouTubeChannel" ("channelId", "fillError") VALUES ('UCfailed', 'YouTube API 403 quotaExceeded');`);
    const info = archiveInfo([CHANNEL_ID, 'UCfailed', 'UCnothing']);
    expect(info.get(CHANNEL_ID)).toEqual({ archiveSize: 3, archiveFilled: true, archiveError: null });
    expect(info.get('UCfailed')).toEqual({ archiveSize: 0, archiveFilled: false, archiveError: 'YouTube API 403 quotaExceeded' });
    expect(info.get('UCnothing')).toEqual({ archiveSize: 0, archiveFilled: false, archiveError: null });
  });
});

describe('startYouTubeFill', () => {
  const uploads = [
    playlistPage([video('u0000000000', '2026-11-01T00:00:00Z'), video('s0000000000', '2026-10-01T00:00:00Z')], 'p1'),
    playlistPage([video('u0000000001', '2015-01-01T00:00:00Z')]),
  ];
  const shorts = [playlistPage([video('s0000000000', '2026-10-01T00:00:00Z')])];

  it('saves every upload with its Shorts tagged, marks the channel filled and calls onFilled', async () => {
    const { fetchJson, urls } = playlistsFetcher({ [UU]: uploads, [UUSH]: shorts });
    const onFilled = vi.fn(async () => {});
    await startYouTubeFill(CHANNEL_ID, { fetchJson, onFilled });
    expect(urls).toHaveLength(4); // UU (2 pages), UUSH, the view counts
    expect(videoRow('u0000000001')).toMatchObject({ isShort: 0, summary: 'About u0000000001' });
    expect(videoRow('s0000000000')?.isShort).toBe(1);
    expect(channelRow()).toMatchObject({ fillError: null });
    expect(channelRow()?.filledAt).not.toBeNull();
    expect(onFilled).toHaveBeenCalledTimes(1);
  });

  it('corrects a Short that RSS saved as a regular video, and keeps its lastShownAt', async () => {
    saveYouTubeVideos([row('s0000000000', { isShort: false })]);
    markShown(['s0000000000'], 42);
    const { fetchJson } = playlistsFetcher({ [UU]: uploads, [UUSH]: shorts });
    await startYouTubeFill(CHANNEL_ID, { fetchJson });
    expect(videoRow('s0000000000')).toMatchObject({ isShort: 1, lastShownAt: 42 });
  });

  it('runs once: a filled channel is skipped, and a call during a fill shares it', async () => {
    const { fetchJson, urls } = playlistsFetcher({ [UU]: uploads });
    const first = startYouTubeFill(CHANNEL_ID, { fetchJson });
    expect(startYouTubeFill(CHANNEL_ID, { fetchJson })).toBe(first);
    await first;
    await startYouTubeFill(CHANNEL_ID, { fetchJson });
    expect(urls).toHaveLength(4); // UU twice, UUSH once (404: no Shorts), the view counts once
  });

  it('records a failure, skips onFilled and tries again next time', async () => {
    const onFilled = vi.fn(async () => {});
    const failing = playlistsFetcher({ [UU]: new Error('YouTube API 403 quotaExceeded') });
    await startYouTubeFill(CHANNEL_ID, { fetchJson: failing.fetchJson, onFilled });
    expect(channelRow()).toEqual(expect.objectContaining({ filledAt: null, fillError: 'YouTube API 403 quotaExceeded' }));
    expect(onFilled).not.toHaveBeenCalled();
    const working = playlistsFetcher({ [UU]: uploads });
    await startYouTubeFill(CHANNEL_ID, { fetchJson: working.fetchJson });
    expect(channelRow()).toMatchObject({ fillError: null });
    expect(channelRow()?.filledAt).not.toBeNull();
  });

  it('records a missing key without calling the API', async () => {
    vi.stubEnv('YOUTUBE_API_KEY', '');
    const fetchJson = vi.fn();
    await startYouTubeFill(CHANNEL_ID, { fetchJson });
    expect(fetchJson).not.toHaveBeenCalled();
    expect(channelRow()?.fillError).toBe('YOUTUBE_API_KEY is not set');
  });

  it('checks the views of the filled videos once, marking the ones the API leaves out as gone', async () => {
    const urls: string[] = [];
    const fetchJson = async (url: string) => {
      urls.push(url);
      if (url.includes('/videos?')) return statsAnswer(url, (id) => (id === 'u0000000001' ? undefined : 42));
      const params = new URL(url).searchParams;
      if (params.get('playlistId') === UUSH) throw new Error('YouTube API 404 playlistNotFound');
      return params.get('pageToken') ? uploads[1] : uploads[0];
    };
    await startYouTubeFill(CHANNEL_ID, { fetchJson });
    expect(urls.filter((u) => u.includes('/videos?'))).toHaveLength(1);
    expect(videoRow('u0000000000')).toMatchObject({ viewCount: 42 });
    expect(videoRow('u0000000001')).toMatchObject({ viewCount: -1 });
  });

  it('on a filled channel, checks only unchecked videos, calls onFilled, and does nothing once all are checked', async () => {
    getDb().exec(`INSERT INTO "YouTubeChannel" ("channelId", "filledAt") VALUES ('${CHANNEL_ID}', 1)`);
    await seedVideos(CHANNEL_ID, 3, { views: (i) => (i === 0 ? 7 : null) });
    const { fetchJson, urls } = playlistsFetcher({});
    const onFilled = vi.fn(async () => {});
    await startYouTubeFill(CHANNEL_ID, { fetchJson, onFilled });
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]).searchParams.get('id')!.split(',').sort()).toEqual(['a0000000001', 'a0000000002']);
    expect(videoRow('a0000000000')?.viewCount).toBe(7);
    expect(onFilled).toHaveBeenCalledTimes(1);
    await startYouTubeFill(CHANNEL_ID, { fetchJson, onFilled });
    expect(urls).toHaveLength(1);
    expect(onFilled).toHaveBeenCalledTimes(1);
  });

  it('logs a failed count pass without storing fillError, leaving the videos unchecked', async () => {
    getDb().exec(`INSERT INTO "YouTubeChannel" ("channelId", "filledAt") VALUES ('${CHANNEL_ID}', 1)`);
    await seedVideos(CHANNEL_ID, 2, { views: () => null });
    const fetchJson = async () => {
      throw new Error('YouTube API 403 quotaExceeded');
    };
    await startYouTubeFill(CHANNEL_ID, { fetchJson });
    expect(channelRow()?.fillError).toBeNull();
    expect(videoRow('a0000000000')?.viewCount).toBeNull();
    expect(console.error).toHaveBeenCalledWith(`[youtube] view counts failed channel=${CHANNEL_ID}:`, 'YouTube API 403 quotaExceeded');
  });

  it('keeps a count RSS stored while the API was being asked', async () => {
    getDb().exec(`INSERT INTO "YouTubeChannel" ("channelId", "filledAt") VALUES ('${CHANNEL_ID}', 1)`);
    await seedVideos(CHANNEL_ID, 1, { views: () => null });
    const fetchJson = async (url: string) => {
      saveYouTubeVideos([row('a0000000000', { viewCount: 99 })]); // an RSS refresh lands meanwhile
      return statsAnswer(url, () => 5);
    };
    await startYouTubeFill(CHANNEL_ID, { fetchJson });
    expect(videoRow('a0000000000')?.viewCount).toBe(99);
  });

  it('counts a playlist cut short at the page cap as filled', async () => {
    const endless = playlistPage([video('e0000000000', '2026-11-01T00:00:00Z')], 'p1');
    const fetchJson = vi.fn(async (url: string) => {
      if (new URL(url).searchParams.get('playlistId') === UUSH) throw new Error('YouTube API 404 playlistNotFound');
      return endless;
    });
    await startYouTubeFill(CHANNEL_ID, { fetchJson });
    expect(fetchJson).toHaveBeenCalledTimes(402); // 400 UU pages, UUSH, the view counts
    expect(channelRow()?.filledAt).not.toBeNull();
  });
});
