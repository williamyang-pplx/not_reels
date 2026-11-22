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
import { CHANNEL_ID, playlistPage, seedVideos, video } from './fixtures/youtube';
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
  ...over,
});

const videoRow = (id: string) =>
  getDb().prepare('SELECT * FROM "YouTubeVideo" WHERE "videoId" = ?').get(id) as
    | { title: string; isShort: number; lastShownAt: number | null; summary: string | null }
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
});

describe('pickArchiveVideos', () => {
  it('takes never-shown videos first, then the least recently shown', async () => {
    const ids = await seedVideos(CHANNEL_ID, 5);
    markShown([ids[0]], 100);
    markShown([ids[1]], 200);
    markShown([ids[2], ids[3], ids[4]], 300);
    saveYouTubeVideos([row('fresh')]);
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
    expect(urls).toHaveLength(3);
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
    expect(urls).toHaveLength(3); // UU twice, UUSH once (404: no Shorts)
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

  it('counts a playlist cut short at the page cap as filled', async () => {
    const endless = playlistPage([video('e0000000000', '2026-11-01T00:00:00Z')], 'p1');
    const fetchJson = vi.fn(async (url: string) => {
      if (new URL(url).searchParams.get('playlistId') === UUSH) throw new Error('YouTube API 404 playlistNotFound');
      return endless;
    });
    await startYouTubeFill(CHANNEL_ID, { fetchJson });
    expect(fetchJson).toHaveBeenCalledTimes(401);
    expect(channelRow()?.filledAt).not.toBeNull();
  });
});
