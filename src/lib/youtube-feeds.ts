import { YOUTUBE_ARCHIVE_PICKS } from './constants';
import { extractYouTubeId } from './embed';
import type { FeedFetcher, NormalizedItem, RawRssItem } from './rss-fetcher';
import type { YouTubeFeedOptions, YouTubeSettings } from './types';
import { pickArchiveVideos, saveYouTubeVideos, videoSummary, type YouTubeVideoRow } from './youtube-archive';

/**
 * YouTube channel feeds (sourceKind YOUTUBE): a refresh reads the channel's RSS feed (its 15 newest videos), saves
 * them to the channel's archive, and picks videos from the archive (youtube-archive.ts). It makes no API call; the
 * URL helpers and the Data API client are in youtube-api.ts.
 */

const DAY_MS = 86_400_000;

/** The RSS feed of a channel: its 15 newest uploads, Shorts included (linked as /shorts/<id>). */
export function youTubeRssUrl(channelId: string): string {
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
}

/**
 * The videos in a channel's RSS items. A /shorts/<id> link marks a Short; items without a video ID or a date are
 * skipped. The summary is the cleaned <media:description>, trimmed to 1,000 characters.
 */
export function rssVideos(items: RawRssItem[], channelId: string): YouTubeVideoRow[] {
  const videos: YouTubeVideoRow[] = [];
  for (const item of items) {
    const link = item.link?.trim() ?? '';
    const videoId = extractYouTubeId(link);
    const uploadedAt = Date.parse(item.isoDate ?? item.pubDate ?? '');
    if (!videoId || Number.isNaN(uploadedAt)) continue;
    videos.push({
      videoId,
      channelId,
      title: item.title?.trim() || '(untitled)',
      summary: videoSummary(item.mediaGroup?.['media:description']?.[0]),
      author: (item.creator ?? item.author)?.trim() || null,
      uploadedAt,
      isShort: new URL(link).pathname.startsWith('/shorts/'),
    });
  }
  return videos;
}

/** One video as a post. The watch URL is guid and link, so a video is one post whichever source brings it. */
function toItem(video: YouTubeVideoRow, publishedAt: Date, rank: number): NormalizedItem {
  const link = `https://www.youtube.com/watch?v=${video.videoId}`;
  return {
    guid: link,
    title: video.title,
    link,
    summary: video.summary,
    author: video.author,
    publishedAt,
    uploadedAt: new Date(video.uploadedAt),
    sourceRank: rank,
  };
}

/**
 * One YOUTUBE refresh: the recent RSS videos (Shorts only when on), all saved to the archive table, and the archive
 * picks (never-shown first, inside the date range, none of the recent ones). Recent posts keep their RSS date; an
 * archive post is dated `now`, so a re-picked video counts as new again. Posts are interleaved (recent, pick,
 * recent, pick, …) so archive picks reach the Hot pool, which takes each feed's best ranks first. Nothing is marked
 * shown here: storeItems does that once the posts are stored.
 */
export async function fetchYouTubeFeedItems(
  channelId: string,
  options: YouTubeFeedOptions,
  fetcher: FeedFetcher,
  now: Date,
): Promise<NormalizedItem[]> {
  let recent: YouTubeVideoRow[] = [];
  if (options.recent) {
    const parsed = await fetcher(youTubeRssUrl(channelId));
    const videos = rssVideos(parsed.items, channelId);
    saveYouTubeVideos(videos);
    recent = videos.filter((v) => options.includeShorts || !v.isShort);
  }
  const picks = options.archive
    ? pickArchiveVideos(
        channelId,
        options,
        recent.map((v) => v.videoId),
        YOUTUBE_ARCHIVE_PICKS,
      )
    : [];
  const items: NormalizedItem[] = [];
  for (let i = 0; i < Math.max(recent.length, picks.length); i += 1) {
    if (i < recent.length) items.push(toItem(recent[i], new Date(recent[i].uploadedAt), items.length));
    if (i < picks.length) items.push(toItem(picks[i], now, items.length));
  }
  return items;
}

/** Feed columns as options. Null showRecent/showArchive (a converted RSS feed) read as on, null includeShorts as off. */
export function youTubeOptionsFromRow(row: {
  publishedAfter: number | null;
  publishedBefore: number | null;
  includeShorts: number | null;
  showRecent: number | null;
  showArchive: number | null;
}): YouTubeFeedOptions {
  return {
    recent: row.showRecent !== 0,
    archive: row.showArchive !== 0,
    includeShorts: row.includeShorts === 1,
    publishedAfter: row.publishedAfter === null ? null : Number(row.publishedAfter),
    publishedBefore: row.publishedBefore === null ? null : Number(row.publishedBefore),
  };
}

function utcDayMs(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** API settings as stored options: startDate → 00:00 UTC of that day, endDate → 00:00 UTC of the next day. */
export function youTubeOptionsFromSettings(settings: YouTubeSettings): YouTubeFeedOptions {
  return {
    recent: settings.recent,
    archive: settings.archive,
    includeShorts: settings.includeShorts,
    publishedAfter: settings.startDate ? utcDayMs(settings.startDate) : null,
    publishedBefore: settings.endDate ? utcDayMs(settings.endDate) + DAY_MS : null,
  };
}

/** Stored options in the API's form (UTC days, end date inclusive). */
export function youTubeSettingsFromOptions(options: YouTubeFeedOptions): YouTubeSettings {
  return {
    recent: options.recent,
    archive: options.archive,
    includeShorts: options.includeShorts,
    startDate: options.publishedAfter === null ? null : utcDay(options.publishedAfter),
    endDate: options.publishedBefore === null ? null : utcDay(options.publishedBefore - DAY_MS),
  };
}
