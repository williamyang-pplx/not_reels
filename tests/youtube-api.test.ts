import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  canonicalYouTubeFeedUrl,
  defaultJsonFetcher,
  pagePlaylist,
  parseYouTubeChannelUrl,
  parseYouTubeFeedUrl,
  YouTubeLookupError,
} from '../src/lib/youtube-api';
import { CHANNEL_ID, CHANNEL_URL, dailyPages, pagedFetcher, playlistPage, privateVideo, video } from './fixtures/youtube';

const KEY = 'test-key';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('parseYouTubeChannelUrl', () => {
  it('reads a handle, a channel ID and the RSS feed', () => {
    expect(parseYouTubeChannelUrl('https://www.youtube.com/@GoogleDevelopers')).toEqual({ handle: 'GoogleDevelopers' });
    expect(parseYouTubeChannelUrl('https://youtube.com/@GoogleDevelopers/videos')).toEqual({ handle: 'GoogleDevelopers' });
    expect(parseYouTubeChannelUrl('https://m.youtube.com/channel/' + CHANNEL_ID + '/featured')).toEqual({ channelId: CHANNEL_ID });
    expect(parseYouTubeChannelUrl('https://music.youtube.com/channel/' + CHANNEL_ID)).toEqual({ channelId: CHANNEL_ID });
    expect(parseYouTubeChannelUrl(`https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`)).toEqual({
      channelId: CHANNEL_ID,
    });
  });

  it('returns null for anything that is not a channel', () => {
    for (const url of [
      'https://www.youtube.com/watch?v=WN-JK-hMAyg',
      'https://www.youtube.com/playlist?list=PL123',
      'https://www.youtube.com/feeds/videos.xml?playlist_id=PL123',
      'https://www.youtube.com/c/GoogleDevelopers',
      'https://www.youtube.com/user/GoogleDevelopers',
      'https://www.youtube.com/channel/UCshort',
      'https://example.com/@GoogleDevelopers',
      'not a url',
    ]) {
      expect(parseYouTubeChannelUrl(url), url).toBeNull();
    }
  });
});

describe('parseYouTubeFeedUrl', () => {
  it('accepts only the stored form', () => {
    expect(parseYouTubeFeedUrl(CHANNEL_URL)).toBe(CHANNEL_ID);
    expect(parseYouTubeFeedUrl(`${CHANNEL_URL}/videos`)).toBeNull();
    expect(parseYouTubeFeedUrl(`${CHANNEL_URL}?x=1`)).toBeNull();
    expect(parseYouTubeFeedUrl(`https://youtube.com/channel/${CHANNEL_ID}`)).toBeNull();
    expect(parseYouTubeFeedUrl('https://www.youtube.com/@GoogleDevelopers')).toBeNull();
  });
});

describe('canonicalYouTubeFeedUrl', () => {
  it('needs no request for a channel or RSS URL', async () => {
    const fetchJson = vi.fn();
    expect(await canonicalYouTubeFeedUrl(`https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`, fetchJson)).toBe(
      CHANNEL_URL,
    );
    expect(await canonicalYouTubeFeedUrl('https://example.com/feed.xml', fetchJson)).toBeNull();
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it('resolves a handle with one channels.list call', async () => {
    vi.stubEnv('YOUTUBE_API_KEY', KEY);
    const fetchJson = vi.fn(async (_url: string) => ({ items: [{ id: CHANNEL_ID }] }));
    expect(await canonicalYouTubeFeedUrl('https://www.youtube.com/@GoogleDevelopers', fetchJson)).toBe(CHANNEL_URL);
    expect(fetchJson).toHaveBeenCalledTimes(1);
    const url = new URL(fetchJson.mock.calls[0][0]);
    expect(url.pathname).toBe('/youtube/v3/channels');
    expect(url.searchParams.get('forHandle')).toBe('@GoogleDevelopers');
  });

  it('fails with 400 for an unknown handle, 503 without a key and 502 when the API fails', async () => {
    const handle = 'https://www.youtube.com/@nobody';
    await expect(canonicalYouTubeFeedUrl(handle, vi.fn())).rejects.toMatchObject({ status: 503, code: 'YOUTUBE_UNAVAILABLE' });
    vi.stubEnv('YOUTUBE_API_KEY', KEY);
    await expect(canonicalYouTubeFeedUrl(handle, async () => ({}))).rejects.toMatchObject({ status: 400 });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = async () => {
      throw new Error('YouTube API 403 quotaExceeded');
    };
    const err = await canonicalYouTubeFeedUrl(handle, failing).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(YouTubeLookupError);
    expect(err).toMatchObject({ status: 502 });
    expect(String(logged.mock.calls[0][0])).toContain('quotaExceeded');
    expect(String(logged.mock.calls[0][0])).not.toContain(KEY);
  });
});

describe('defaultJsonFetcher', () => {
  it('names the API reason on an error status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { errors: [{ reason: 'playlistNotFound' }] } }), { status: 404 }),
    );
    await expect(defaultJsonFetcher(`https://www.googleapis.com/youtube/v3/playlistItems?key=${KEY}`)).rejects.toThrow(
      'YouTube API 404 playlistNotFound',
    );
  });

  it('keeps the URL, and so the key, out of a network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError(`fetch failed for ...?key=${KEY}`));
    const err = (await defaultJsonFetcher(`https://www.googleapis.com/youtube/v3/channels?key=${KEY}`).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe('YouTube API request failed: TypeError');
  });
});

describe('pagePlaylist', () => {
  it('reads every page, newest first', async () => {
    const { fetchJson, urls } = pagedFetcher(dailyPages(3, '2026-11-20T12:00:00Z'));
    const { entries, truncated } = await pagePlaylist('UU' + CHANNEL_ID.slice(2), KEY, fetchJson, 400);
    expect(entries).toHaveLength(150);
    expect(truncated).toBe(false);
    expect(urls).toHaveLength(3);
    expect(new URL(urls[0]).searchParams.get('playlistId')).toBe('UU' + CHANNEL_ID.slice(2));
    expect(entries[0]).toEqual({
      videoId: 'v0000000000',
      uploadedAt: Date.parse('2026-11-20T12:00:00Z'),
      title: 'Video v0000000000',
      description: 'About v0000000000\nhttps://sponsor.example/v0000000000',
      author: 'Google for Developers',
    });
  });

  it('stops at maxPages and says it was truncated', async () => {
    const { fetchJson, urls } = pagedFetcher(dailyPages(3, '2026-11-20T12:00:00Z'));
    const { entries, truncated } = await pagePlaylist('UUx', KEY, fetchJson, 2);
    expect(entries).toHaveLength(100);
    expect(truncated).toBe(true);
    expect(urls).toHaveLength(2);
  });

  it('skips private and deleted videos', async () => {
    const { fetchJson } = pagedFetcher([playlistPage([privateVideo('p1'), video('ok', '2026-11-01T00:00:00Z')])]);
    const { entries } = await pagePlaylist('UUx', KEY, fetchJson, 400);
    expect(entries.map((e) => e.videoId)).toEqual(['ok']);
  });

  it('reads a missing playlist as empty, and passes on other errors', async () => {
    const missing = async () => {
      throw new Error('YouTube API 404 playlistNotFound');
    };
    expect(await pagePlaylist('UUSHx', KEY, missing, 400)).toEqual({ entries: [], truncated: false });
    const quota = async () => {
      throw new Error('YouTube API 403 quotaExceeded');
    };
    await expect(pagePlaylist('UUx', KEY, quota, 400)).rejects.toThrow('quotaExceeded');
  });
});
