import { YOUTUBE_FEED_ITEMS, YOUTUBE_RECENT_DAYS, YOUTUBE_RECENT_MAX } from './constants';
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
 * skipped. The summary is the cleaned <media:description>, trimmed to 1,000 characters; the view count is
 * <media:statistics views>, or null.
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
      viewCount: rssViews(item),
    });
  }
  return videos;
}

function rssViews(item: RawRssItem): number | null {
  const views = Number(item.mediaGroup?.['media:community']?.[0]?.['media:statistics']?.[0]?.$?.views ?? NaN);
  return Number.isFinite(views) && views >= 0 ? views : null;
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
 * One YOUTUBE refresh, at most YOUTUBE_FEED_ITEMS (15) posts. The RSS videos (Shorts only when on) are all saved to
 * the archive table. With both sources on: the newest YOUTUBE_RECENT_MAX (4) RSS videos uploaded in the last
 * YOUTUBE_RECENT_DAYS (30), then archive picks for the rest (never-shown first, inside the date range, none of this
 * RSS feed's videos), then older RSS videos if the archive runs short. Recent only: up to 15 RSS videos; archive
 * only: 15 picks. Recent posts keep their RSS date; an archive post is dated `now`, so a re-picked video counts as
 * new again. Posts are interleaved (recent, pick, recent, pick, …) so archive picks reach the Hot pool, which takes
 * each feed's best ranks first. Nothing is marked shown here: storeItems does that once the posts are stored.
 */
export async function fetchYouTubeFeedItems(
  channelId: string,
  options: YouTubeFeedOptions,
  fetcher: FeedFetcher,
  now: Date,
): Promise<NormalizedItem[]> {
  let rss: YouTubeVideoRow[] = [];
  if (options.recent) {
    const parsed = await fetcher(youTubeRssUrl(channelId));
    rss = rssVideos(parsed.items, channelId);
    saveYouTubeVideos(rss);
  }
  const shown = rss.filter((v) => options.includeShorts || !v.isShort).sort((a, b) => b.uploadedAt - a.uploadedAt);
  if (!options.archive) return interleave(shown.slice(0, YOUTUBE_FEED_ITEMS), [], now);
  const monthAgo = now.getTime() - YOUTUBE_RECENT_DAYS * DAY_MS;
  const recent = shown.filter((v) => v.uploadedAt >= monthAgo).slice(0, YOUTUBE_RECENT_MAX);
  const picks = pickArchiveVideos(
    channelId,
    options,
    rss.map((v) => v.videoId),
    YOUTUBE_FEED_ITEMS - recent.length,
  );
  const spare = YOUTUBE_FEED_ITEMS - recent.length - picks.length;
  const rest = shown.filter((v) => !recent.includes(v)).slice(0, spare);
  return interleave([...recent, ...rest], picks, now);
}

/** Recent videos (their RSS date) and archive picks (dated `now`) as posts: recent, pick, recent, pick, … */
function interleave(recent: YouTubeVideoRow[], picks: YouTubeVideoRow[], now: Date): NormalizedItem[] {
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
