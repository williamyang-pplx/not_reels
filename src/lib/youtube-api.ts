import { YOUTUBE_HOSTS } from './embed';

/**
 * YouTube channel URLs and the YouTube Data API v3 client: handle lookups and playlist paging. A leaf module (it
 * imports nothing from the app's DB or feeds), so db.ts, youtube-archive.ts and youtube-feeds.ts can all use it.
 * search.list (100 units) is never used. The API key travels in the query string, so no request URL goes into an
 * error message or a log line.
 */

const API = 'https://www.googleapis.com/youtube/v3';
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const HANDLE = /^[A-Za-z0-9._-]{3,30}$/;
const FETCH_TIMEOUT_MS = 10_000;
const PAGE_FIELDS =
  'nextPageToken,items(snippet(title,description,videoOwnerChannelTitle),contentDetails(videoId,videoPublishedAt))';

export type YouTubeChannelRef = { channelId: string } | { handle: string };

/**
 * A channel from any URL form we accept, on a YouTube host: /@name (with /videos, /featured, … after it),
 * /channel/UC…, and the RSS feed /feeds/videos.xml?channel_id=UC…. Null for anything else.
 */
export function parseYouTubeChannelUrl(url: string): YouTubeChannelRef | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (parsed.pathname === '/feeds/videos.xml') {
    const id = parsed.searchParams.get('channel_id');
    return id && CHANNEL_ID.test(id) ? { channelId: id } : null;
  }
  if (segments[0] === 'channel') {
    return segments[1] && CHANNEL_ID.test(segments[1]) ? { channelId: segments[1] } : null;
  }
  if (segments[0]?.startsWith('@')) {
    const handle = decodeURIComponent(segments[0].slice(1));
    return HANDLE.test(handle) ? { handle } : null;
  }
  return null;
}

/** The channel ID of a stored YOUTUBE feed URL (the canonical form only), or null. */
export function parseYouTubeFeedUrl(url: string): string | null {
  const match = /^https:\/\/www\.youtube\.com\/channel\/([^/?#]+)$/.exec(url);
  return match && CHANNEL_ID.test(match[1]) ? match[1] : null;
}

/** The one stored form of a channel feed's URL. */
export function youTubeFeedUrl(channelId: string): string {
  return `https://www.youtube.com/channel/${channelId}`;
}

/** YOUTUBE_API_KEY, or null when unset (handle lookups and archive fills then fail; RSS refreshes still work). Read per call. */
export function youTubeApiKey(): string | null {
  return process.env.YOUTUBE_API_KEY?.trim() || null;
}

/** GET a Data API URL and return its JSON. Tests stub it (RefreshOptions.youTubeFetcher for archive fills). */
export type JsonFetcher = (url: string) => Promise<unknown>;

/**
 * fetch with a 10 s timeout. A non-2xx answer throws Error(`YouTube API <status> <reason>`), reason being
 * error.errors[0].reason from the body (playlistNotFound, quotaExceeded, …). A network error throws
 * Error(`YouTube API request failed: <err.name>`). Neither message holds the URL, which carries the key.
 */
export const defaultJsonFetcher: JsonFetcher = async (url) => {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`YouTube API request failed: ${err instanceof Error ? err.name : 'Error'}`);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { errors?: { reason?: string }[] } } | null;
    const reason = body?.error?.errors?.[0]?.reason ?? 'unknown';
    throw new Error(`YouTube API ${res.status} ${reason}`);
  }
  return res.json();
};

/** A handle lookup that failed in a way the user should see; the feeds API answers with fail(). */
export class YouTubeLookupError extends Error {
  constructor(
    message: string,
    readonly code: 'VALIDATION_ERROR' | 'YOUTUBE_UNAVAILABLE',
    readonly status: 400 | 502 | 503,
  ) {
    super(message);
  }
}

/**
 * The canonical feed URL for a YouTube channel URL, or null when `url` is not a channel URL. A /channel/ or RSS URL
 * needs no request; a handle costs one channels.list?forHandle call (1 unit).
 */
export async function canonicalYouTubeFeedUrl(
  url: string,
  fetchJson: JsonFetcher = defaultJsonFetcher,
): Promise<string | null> {
  const ref = parseYouTubeChannelUrl(url);
  if (!ref) return null;
  if ('channelId' in ref) return youTubeFeedUrl(ref.channelId);
  const key = youTubeApiKey();
  if (!key) throw new YouTubeLookupError('YOUTUBE_API_KEY is not set', 'YOUTUBE_UNAVAILABLE', 503);
  let body: { items?: { id?: string }[] };
  try {
    body = (await fetchJson(
      `${API}/channels?part=id&forHandle=${encodeURIComponent('@' + ref.handle)}&key=${encodeURIComponent(key)}`,
    )) as typeof body;
  } catch (err) {
    console.error(`[youtube] handle lookup failed for @${ref.handle}: ${err instanceof Error ? err.message : 'error'}`);
    throw new YouTubeLookupError('YouTube lookup failed', 'YOUTUBE_UNAVAILABLE', 502);
  }
  const id = body.items?.[0]?.id;
  if (!id || !CHANNEL_ID.test(id)) throw new YouTubeLookupError('YouTube channel not found', 'VALIDATION_ERROR', 400);
  return youTubeFeedUrl(id);
}

/** One video in a playlist. */
export interface PlaylistEntry {
  videoId: string;
  uploadedAt: number;
  title: string;
  description: string;
  author: string | null;
}

interface PlaylistItemsPage {
  nextPageToken?: string;
  items?: {
    snippet?: { title?: string; description?: string; videoOwnerChannelTitle?: string };
    /** videoPublishedAt is missing on private and deleted videos. */
    contentDetails?: { videoId?: string; videoPublishedAt?: string };
  }[];
}

/**
 * Every video in a playlist, newest first, paging playlistItems.list (50 a page, 1 unit each) to the last page or
 * `maxPages` (then `truncated`). Private and deleted videos (no videoPublishedAt) are skipped. A 404
 * playlistNotFound (a channel with no Shorts asked for UUSH) is an empty playlist; any other error throws.
 */
export async function pagePlaylist(
  playlistId: string,
  key: string,
  fetchJson: JsonFetcher,
  maxPages: number,
): Promise<{ entries: PlaylistEntry[]; truncated: boolean }> {
  const base =
    `${API}/playlistItems?part=snippet,contentDetails&maxResults=50&playlistId=${encodeURIComponent(playlistId)}` +
    `&fields=${encodeURIComponent(PAGE_FIELDS)}&key=${encodeURIComponent(key)}`;
  const entries: PlaylistEntry[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    let body: PlaylistItemsPage;
    try {
      body = (await fetchJson(pageToken ? `${base}&pageToken=${encodeURIComponent(pageToken)}` : base)) as PlaylistItemsPage;
    } catch (err) {
      if (page === 0 && err instanceof Error && err.message.includes('404 playlistNotFound')) {
        return { entries: [], truncated: false };
      }
      throw err;
    }
    for (const item of body.items ?? []) {
      const videoId = item.contentDetails?.videoId;
      const uploadedAt = Date.parse(item.contentDetails?.videoPublishedAt ?? '');
      if (!videoId || Number.isNaN(uploadedAt)) continue;
      entries.push({
        videoId,
        uploadedAt,
        title: item.snippet?.title?.trim() || '(untitled)',
        description: item.snippet?.description ?? '',
        author: item.snippet?.videoOwnerChannelTitle?.trim() || null,
      });
    }
    pageToken = body.nextPageToken;
    if (!pageToken) return { entries, truncated: false };
  }
  return { entries, truncated: true };
}
