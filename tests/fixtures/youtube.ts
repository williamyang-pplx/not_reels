/** Data API JSON builders for YouTube tests, in the shape playlistItems.list and channels.list answer with. */

export const CHANNEL_ID = 'UC_x5XG1OV2P6uZZ5FSM9Ttw';
export const CHANNEL_URL = `https://www.youtube.com/channel/${CHANNEL_ID}`;

export interface FakeVideo {
  snippet?: { title?: string; description?: string; videoOwnerChannelTitle?: string };
  contentDetails?: { videoId?: string; videoPublishedAt?: string };
}

/** A public video; `isoDate` is its videoPublishedAt. */
export function video(id: string, isoDate: string, title = `Video ${id}`): FakeVideo {
  return {
    snippet: { title, description: `About ${id}\nhttps://sponsor.example/${id}`, videoOwnerChannelTitle: 'Google for Developers' },
    contentDetails: { videoId: id, videoPublishedAt: isoDate },
  };
}

/** A private or deleted video: the API leaves out videoPublishedAt. */
export function privateVideo(id: string): FakeVideo {
  return { snippet: { title: 'Private video' }, contentDetails: { videoId: id } };
}

export function playlistPage(videos: FakeVideo[], nextPageToken?: string) {
  return nextPageToken ? { nextPageToken, items: videos } : { items: videos };
}

/** `count` videos one day apart, newest first, starting at `newest`. Ids are v<offset + i>. */
export function dailyVideos(count: number, newest: string, offset = 0): FakeVideo[] {
  const start = Date.parse(newest);
  return Array.from({ length: count }, (_, i) =>
    video(`v${String(offset + i).padStart(10, '0')}`, new Date(start - (offset + i) * 86_400_000).toISOString()),
  );
}

/** A JsonFetcher that serves `pages` in order by pageToken (p1, p2, …) and records every URL it was asked for. */
export function pagedFetcher(pages: ReturnType<typeof playlistPage>[]) {
  const urls: string[] = [];
  const fetchJson = async (url: string) => {
    urls.push(url);
    const token = new URL(url).searchParams.get('pageToken');
    const index = token ? Number(token.slice(1)) : 0;
    const page = pages[index];
    if (!page) throw new Error(`no page ${index}`);
    return page;
  };
  return { fetchJson, urls };
}

/** `count` pages of 50 daily videos, chained p1, p2, …, newest first from `newest`. */
export function dailyPages(count: number, newest: string) {
  return Array.from({ length: count }, (_, p) =>
    playlistPage(dailyVideos(50, newest, p * 50), p + 1 < count ? `p${p + 1}` : undefined),
  );
}

/** A YouTube RSS entry as rss-parser hands it over (Atom: no <guid>, link to /watch or /shorts/). */
export function rssItem(id: string, isoDate: string, opts: { short?: boolean; title?: string; description?: string } = {}) {
  return {
    title: opts.title ?? `Video ${id}`,
    link: opts.short ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`,
    isoDate,
    author: 'Google for Developers',
    mediaGroup: { 'media:description': [opts.description ?? `About ${id}\nhttps://sponsor.example/${id}`] },
  };
}

/** Insert `count` archive videos for a channel, one day apart from `newest` back. Ids are a<channel tail><i>. */
export async function seedVideos(
  channelId: string,
  count: number,
  opts: { newest?: string; shortEvery?: number; prefix?: string } = {},
): Promise<string[]> {
  const { saveYouTubeVideos } = await import('../../src/lib/youtube-archive');
  const newest = Date.parse(opts.newest ?? '2015-12-31T12:00:00Z');
  const prefix = opts.prefix ?? 'a';
  const rows = Array.from({ length: count }, (_, i) => ({
    videoId: `${prefix}${String(i).padStart(10, '0')}`,
    channelId,
    title: `Archive ${i}`,
    summary: `Old video ${i}`,
    author: 'Vsauce',
    uploadedAt: newest - i * 86_400_000,
    isShort: opts.shortEvery ? i % opts.shortEvery === 0 : false,
  }));
  saveYouTubeVideos(rows);
  return rows.map((r) => r.videoId);
}
