import { getDb } from '../db';
import { YOUTUBE_FILL_MAX_PAGES, YOUTUBE_TOP_SHARE } from './constants';
import type { YouTubeFeedOptions } from './types';
import { cleanVideoDescription } from './utils';
import {
  defaultJsonFetcher,
  fetchViewCounts,
  pagePlaylist,
  youTubeApiKey,
  type JsonFetcher,
  type PlaylistEntry,
} from './youtube-api';

/**
 * A YouTube channel's archive: every video the app has seen for it (the YouTubeVideo table), from RSS refreshes and
 * from one back catalog fill through the Data API, with each video's view count (from RSS, or one Data API pass).
 * Archive picks and the Manage counts read it.
 */

const SUMMARY_MAX = 1000;

/** One row of YouTubeVideo (without lastShownAt). */
export interface YouTubeVideoRow {
  videoId: string;
  channelId: string;
  title: string;
  summary: string | null;
  author: string | null;
  uploadedAt: number;
  isShort: boolean;
  /** Views from RSS or the Data API pass; null until checked, -1 when the API says the video is gone. */
  viewCount: number | null;
}

/** A video description as an archive summary: the cleaned prose, at most 1,000 characters, or null. */
export function videoSummary(description: string | undefined): string | null {
  return cleanVideoDescription(description ?? '').trim().slice(0, SUMMARY_MAX).trim() || null;
}

// Shared by the save insert, the pick SELECT and the fill upsert.
const INSERT_COLUMNS = `"videoId", "channelId", "title", "summary", "author", "uploadedAt", "isShort", "viewCount"`;
const INSERT_VALUES = `@videoId, @channelId, @title, @summary, @author, @uploadedAt, @isShort, @viewCount`;

const bindRow = (v: YouTubeVideoRow) => ({ ...v, isShort: v.isShort ? 1 : 0 });

/**
 * INSERT OR IGNORE each video, then give a known one the RSS view count when the item has one (free and fresher). A
 * known video keeps its row and lastShownAt. Returns how many were new.
 */
export function saveYouTubeVideos(videos: YouTubeVideoRow[]): number {
  if (videos.length === 0) return 0;
  const db = getDb();
  const insert = db.prepare(`INSERT OR IGNORE INTO "YouTubeVideo" (${INSERT_COLUMNS}) VALUES (${INSERT_VALUES})`);
  const count = db.prepare(
    `UPDATE "YouTubeVideo" SET "viewCount" = @viewCount WHERE "videoId" = @videoId AND @viewCount IS NOT NULL`,
  );
  return db.transaction(() =>
    videos.reduce((n, v) => {
      const added = insert.run(bindRow(v)).changes;
      count.run(bindRow(v));
      return n + added;
    }, 0),
  )();
}

interface VideoRecord extends Omit<YouTubeVideoRow, 'isShort'> {
  isShort: number;
  grp: 1 | 2 | 3;
}

/**
 * `count` of the channel's videos for an archive refresh, of those inside the range, Shorts only when on, not gone,
 * none of `exclude`, nor saved or hidden. Counted videos are split into halves by views; YOUTUBE_TOP_SHARE of the
 * picks come from the top half and the rest from the bottom, a short half made up from the other; videos not counted
 * yet only fill what the counted ones can't. Inside each group: never-shown first, then the least recently shown,
 * random among equals. Top-half picks first.
 */
export function pickArchiveVideos(
  channelId: string,
  options: YouTubeFeedOptions,
  exclude: string[],
  count: number,
): YouTubeVideoRow[] {
  if (count <= 0) return [];
  const { top, bottom, uncounted } = rankedGroups(channelId, options, exclude, count);
  const counted = Math.min(count, top.length + bottom.length);
  const takeTop = Math.min(top.length, Math.max(Math.round(count * YOUTUBE_TOP_SHARE), counted - bottom.length));
  return [...top.slice(0, takeTop), ...bottom.slice(0, counted - takeTop), ...uncounted.slice(0, count - counted)];
}

/**
 * Up to `limit` videos of each group, in pick order, in one query: 1 = top half, 2 = bottom half (NTILE(2) over the
 * eligible counted videos by viewCount, videoId breaking ties; an odd count puts the middle video on top), 3 = not
 * counted yet. Halves are set before `exclude` and saved/hidden videos are taken out, so a video's half doesn't move
 * as others are picked. Saved and hidden URLs are excluded in the SQL, as in the feed query.
 */
function rankedGroups(
  channelId: string,
  options: YouTubeFeedOptions,
  exclude: string[],
  limit: number,
): { top: YouTubeVideoRow[]; bottom: YouTubeVideoRow[]; uncounted: YouTubeVideoRow[] } {
  const rows = getDb()
    .prepare(
      `WITH eligible AS (
         SELECT ${INSERT_COLUMNS}, "lastShownAt",
           CASE WHEN "viewCount" IS NULL THEN 3
                ELSE NTILE(2) OVER (PARTITION BY "viewCount" IS NULL ORDER BY "viewCount" DESC, "videoId") END AS grp
         FROM "YouTubeVideo"
         WHERE "channelId" = ? AND ("viewCount" IS NULL OR "viewCount" >= 0) AND (? = 1 OR "isShort" = 0)
           AND (? IS NULL OR "uploadedAt" >= ?) AND (? IS NULL OR "uploadedAt" < ?)
       ), ranked AS (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY grp ORDER BY "lastShownAt" IS NOT NULL, "lastShownAt", random()) AS rk
         FROM eligible
         WHERE "videoId" NOT IN (${exclude.map(() => '?').join(',')})
           AND 'https://www.youtube.com/watch?v=' || "videoId" NOT IN (SELECT "url" FROM "SavedLink" UNION SELECT "url" FROM "HiddenLink")
       )
       SELECT ${INSERT_COLUMNS}, grp FROM ranked WHERE rk <= ? ORDER BY grp, rk`,
    )
    .all(
      channelId,
      options.includeShorts ? 1 : 0,
      options.publishedAfter,
      options.publishedAfter,
      options.publishedBefore,
      options.publishedBefore,
      ...exclude,
      limit,
    ) as VideoRecord[];
  const groups = { top: [] as YouTubeVideoRow[], bottom: [] as YouTubeVideoRow[], uncounted: [] as YouTubeVideoRow[] };
  for (const { grp, ...r } of rows) {
    const video = {
      ...r,
      uploadedAt: Number(r.uploadedAt),
      isShort: r.isShort === 1,
      viewCount: r.viewCount === null ? null : Number(r.viewCount),
    };
    (grp === 1 ? groups.top : grp === 2 ? groups.bottom : groups.uncounted).push(video);
  }
  return groups;
}

/** Set lastShownAt for these videos; called once a refresh has stored them. */
export function markShown(videoIds: string[], at: number): void {
  if (videoIds.length === 0) return;
  getDb()
    .prepare(`UPDATE "YouTubeVideo" SET "lastShownAt" = ? WHERE "videoId" IN (${videoIds.map(() => '?').join(',')})`)
    .run(at, ...videoIds);
}

export interface ArchiveInfo {
  archiveSize: number;
  archiveFilled: boolean;
  archiveError: string | null;
}

/** Archive size and fill state per channel, for the feed DTO. A channel with no YouTubeChannel row is unfilled. */
export function archiveInfo(channelIds: string[]): Map<string, ArchiveInfo> {
  const out = new Map<string, ArchiveInfo>();
  const ids = Array.from(new Set(channelIds));
  if (ids.length === 0) return out;
  for (const id of ids) out.set(id, { archiveSize: 0, archiveFilled: false, archiveError: null });
  const db = getDb();
  const marks = ids.map(() => '?').join(',');
  const sizes = db
    .prepare(`SELECT "channelId", COUNT(*) AS n FROM "YouTubeVideo" WHERE "channelId" IN (${marks}) GROUP BY "channelId"`)
    .all(...ids) as { channelId: string; n: number }[];
  for (const r of sizes) out.get(r.channelId)!.archiveSize = r.n;
  const fills = db
    .prepare(`SELECT "channelId", "filledAt", "fillError" FROM "YouTubeChannel" WHERE "channelId" IN (${marks})`)
    .all(...ids) as { channelId: string; filledAt: number | null; fillError: string | null }[];
  for (const r of fills) {
    const info = out.get(r.channelId)!;
    info.archiveFilled = r.filledAt !== null;
    info.archiveError = r.fillError;
  }
  return out;
}

const fills = new Map<string, Promise<void>>();

/**
 * Start the channel's background job unless it is running or has nothing to do: the back catalog fill (once), then
 * view counts for the videos never checked (once each). `onFilled` runs when the job saved videos or counts, so the
 * feed re-picks with them. Detached on purpose: a fill is ~25 API calls and the refresh that starts it must not
 * wait. A failed fill is stored in fillError; a failed count pass only logs (a filled channel's label ignores
 * fillError). Either is tried again on the next refresh. Returns the job's promise for tests.
 */
export function startYouTubeFill(
  channelId: string,
  opts: { fetchJson?: JsonFetcher; onFilled?: () => Promise<unknown> } = {},
): Promise<void> {
  const running = fills.get(channelId);
  if (running) return running;
  const row = getDb().prepare('SELECT "filledAt" FROM "YouTubeChannel" WHERE "channelId" = ?').get(channelId) as
    | { filledAt: number | null }
    | undefined;
  const filled = row?.filledAt != null;
  if (filled && !hasUncheckedViews(channelId)) return Promise.resolve();
  const fetchJson = opts.fetchJson ?? defaultJsonFetcher;
  const fill = (async () => {
    if (!filled) await fillYouTubeChannel(channelId, fetchJson);
    let counted = 0;
    try {
      counted = await fillViewCounts(channelId, fetchJson);
    } catch (err) {
      console.error(`[youtube] view counts failed channel=${channelId}:`, err instanceof Error ? err.message : err);
    }
    if (!filled || counted > 0) await opts.onFilled?.();
  })()
    .catch((err: unknown) => {
      console.error(`[youtube] fill failed channel=${channelId}:`, err instanceof Error ? err.message : err);
    })
    .finally(() => {
      fills.delete(channelId);
    });
  fills.set(channelId, fill);
  return fill;
}

/** A playlist entry as a YouTubeVideo row. */
function entryRow(channelId: string, entry: PlaylistEntry, isShort: boolean): YouTubeVideoRow {
  return {
    videoId: entry.videoId,
    channelId,
    title: entry.title,
    summary: videoSummary(entry.description),
    author: entry.author,
    uploadedAt: entry.uploadedAt,
    isShort,
    viewCount: null, // checked by fillViewCounts after the fill
  };
}

/**
 * Page the channel's uploads (UU) and Shorts (UUSH) playlists once and save every video, Shorts tagged. On success
 * sets filledAt (also when a playlist hit YOUTUBE_FILL_MAX_PAGES, so a huge channel is not re-paged) and clears
 * fillError; on failure stores the reason in fillError (the fetcher's messages hold no URL) and rethrows.
 * ~1 unit per 50 videos.
 */
async function fillYouTubeChannel(channelId: string, fetchJson: JsonFetcher): Promise<void> {
  const db = getDb();
  const recordError = db.prepare(
    `INSERT INTO "YouTubeChannel" ("channelId", "fillError") VALUES (?, ?)
     ON CONFLICT ("channelId") DO UPDATE SET "fillError" = excluded."fillError"`,
  );
  try {
    const key = youTubeApiKey();
    if (!key) throw new Error('YOUTUBE_API_KEY is not set');
    const suffix = channelId.slice(2);
    const uploads = await pagePlaylist(`UU${suffix}`, key, fetchJson, YOUTUBE_FILL_MAX_PAGES);
    const shorts = await pagePlaylist(`UUSH${suffix}`, key, fetchJson, YOUTUBE_FILL_MAX_PAGES);
    const shortIds = new Set(shorts.entries.map((e) => e.videoId));
    // The fill's Shorts list wins over an RSS row's link-based guess, but never un-marks a Short.
    const upsert = db.prepare(
      `INSERT INTO "YouTubeVideo" (${INSERT_COLUMNS}) VALUES (${INSERT_VALUES})
       ON CONFLICT ("videoId") DO UPDATE SET "isShort" = MAX("isShort", excluded."isShort")`,
    );
    db.transaction(() => {
      for (const entry of uploads.entries) upsert.run(bindRow(entryRow(channelId, entry, shortIds.has(entry.videoId))));
      db.prepare(
        `INSERT INTO "YouTubeChannel" ("channelId", "filledAt", "fillError") VALUES (?, ?, NULL)
         ON CONFLICT ("channelId") DO UPDATE SET "filledAt" = excluded."filledAt", "fillError" = NULL`,
      ).run(channelId, Date.now());
    })();
    const truncated = uploads.truncated || shorts.truncated ? ', truncated' : '';
    console.log(`[youtube] filled channel=${channelId}: ${uploads.entries.length} videos${truncated}`);
  } catch (err) {
    recordError.run(channelId, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

/** Whether the channel has a video whose views were never checked (by RSS or the Data API pass). */
function hasUncheckedViews(channelId: string): boolean {
  return (
    getDb()
      .prepare('SELECT EXISTS(SELECT 1 FROM "YouTubeVideo" WHERE "channelId" = ? AND "viewCount" IS NULL) AS e')
      .get(channelId) as { e: number }
  ).e === 1;
}

/**
 * Fetch the views of every unchecked video of the channel (50 a call, 1 unit each), then store them in one
 * transaction: the count, or -1 for a video the API didn't return (gone: never picked, never asked again). A video
 * RSS counted meanwhile keeps its count. Returns how many were checked. Throws, storing nothing, on a missing key or
 * an API error.
 */
async function fillViewCounts(channelId: string, fetchJson: JsonFetcher): Promise<number> {
  const db = getDb();
  const ids = (
    db.prepare('SELECT "videoId" FROM "YouTubeVideo" WHERE "channelId" = ? AND "viewCount" IS NULL').all(channelId) as {
      videoId: string;
    }[]
  ).map((r) => r.videoId);
  if (ids.length === 0) return 0;
  const key = youTubeApiKey();
  if (!key) throw new Error('YOUTUBE_API_KEY is not set');
  const counts = await fetchViewCounts(ids, key, fetchJson);
  const store = db.prepare('UPDATE "YouTubeVideo" SET "viewCount" = ? WHERE "videoId" = ? AND "viewCount" IS NULL');
  db.transaction(() => {
    for (const id of ids) store.run(counts.get(id) ?? -1, id);
  })();
  console.log(`[youtube] view counts channel=${channelId}: ${ids.length} videos`);
  return ids.length;
}

/** Wait for every running fill; tests await it so no fill outlives its test. */
export async function settleYouTubeFills(): Promise<void> {
  await Promise.all(Array.from(fills.values()));
}
