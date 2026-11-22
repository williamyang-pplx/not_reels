import { getDb } from '../db';
import { YOUTUBE_FILL_MAX_PAGES } from './constants';
import type { YouTubeFeedOptions } from './types';
import { cleanVideoDescription } from './utils';
import { defaultJsonFetcher, pagePlaylist, youTubeApiKey, type JsonFetcher, type PlaylistEntry } from './youtube-api';

/**
 * A YouTube channel's archive: every video the app has seen for it (the YouTubeVideo table), from RSS refreshes and
 * from one back catalog fill through the Data API. Archive picks and the Manage counts read it.
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
}

/** A video description as an archive summary: the cleaned prose, at most 1,000 characters, or null. */
export function videoSummary(description: string | undefined): string | null {
  return cleanVideoDescription(description ?? '').trim().slice(0, SUMMARY_MAX).trim() || null;
}

const INSERT_COLUMNS = `"videoId", "channelId", "title", "summary", "author", "uploadedAt", "isShort"`;
const INSERT_VALUES = `@videoId, @channelId, @title, @summary, @author, @uploadedAt, @isShort`;

const bindRow = (v: YouTubeVideoRow) => ({ ...v, isShort: v.isShort ? 1 : 0 });

/** INSERT OR IGNORE each video; returns how many were new. A known video keeps its row and lastShownAt. */
export function saveYouTubeVideos(videos: YouTubeVideoRow[]): number {
  if (videos.length === 0) return 0;
  const db = getDb();
  const insert = db.prepare(`INSERT OR IGNORE INTO "YouTubeVideo" (${INSERT_COLUMNS}) VALUES (${INSERT_VALUES})`);
  return db.transaction(() => videos.reduce((n, v) => n + insert.run(bindRow(v)).changes, 0))();
}

interface VideoRecord extends Omit<YouTubeVideoRow, 'isShort'> {
  isShort: number;
}

/**
 * `count` of the channel's videos for an archive refresh: inside the range, Shorts only when on, none of `exclude`;
 * never-shown first, then the least recently shown, random among equals.
 */
export function pickArchiveVideos(
  channelId: string,
  options: YouTubeFeedOptions,
  exclude: string[],
  count: number,
): YouTubeVideoRow[] {
  const rows = getDb()
    .prepare(
      `SELECT ${INSERT_COLUMNS} FROM "YouTubeVideo"
        WHERE "channelId" = ? AND (? = 1 OR "isShort" = 0)
          AND (? IS NULL OR "uploadedAt" >= ?) AND (? IS NULL OR "uploadedAt" < ?)
          AND "videoId" NOT IN (${exclude.map(() => '?').join(',')})
        ORDER BY "lastShownAt" IS NOT NULL, "lastShownAt", random()
        LIMIT ?`,
    )
    .all(
      channelId,
      options.includeShorts ? 1 : 0,
      options.publishedAfter,
      options.publishedAfter,
      options.publishedBefore,
      options.publishedBefore,
      ...exclude,
      count,
    ) as VideoRecord[];
  return rows.map((r) => ({ ...r, uploadedAt: Number(r.uploadedAt), isShort: r.isShort === 1 }));
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
 * Start the channel's back catalog fill unless it is filled or already running; `onFilled` runs after a successful
 * fill. Detached on purpose: a fill is ~25 API calls and the refresh that starts it must not wait. A failed fill
 * leaves the channel unfilled, so the next refresh tries again. Returns the fill's promise for tests.
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
  if (row?.filledAt != null) return Promise.resolve();
  const fill = fillYouTubeChannel(channelId, opts.fetchJson ?? defaultJsonFetcher)
    .then(async () => {
      await opts.onFilled?.();
    })
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

/** Wait for every running fill; tests await it so no fill outlives its test. */
export async function settleYouTubeFills(): Promise<void> {
  await Promise.all(Array.from(fills.values()));
}
