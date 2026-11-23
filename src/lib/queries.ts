import { getDb, bool, toDate } from '../db';
import { RANKED_LIST_SIZE, SHUFFLE_NOISE_SCALE } from './constants';
import { recommendItems } from './recommendation';
import { parseYouTubeFeedUrl } from './youtube-api';
import { archiveInfo, type ArchiveInfo } from './youtube-archive';
import { youTubeOptionsFromRow, youTubeSettingsFromOptions } from './youtube-feeds';
import type { Feed, FeedItem, RedditMedia, SavedLink, SortOrder } from './types';

// ---------- feeds ----------

interface FeedRow {
  id: string;
  name: string;
  url: string;
  sourceKind: string;
  isActive: number;
  fetchErrorCount: number;
  lastFetched: number | null;
  createdAt: number;
  updatedAt: number;
  publishedAfter: number | null;
  publishedBefore: number | null;
  includeShorts: number | null;
  showRecent: number | null;
  showArchive: number | null;
}

export type FeedDTO = Feed & { updatedAt: string };

/** feedId → topic slugs in FeedTopic primary-key order (lowest slug first, like Prisma). */
function topicsByFeed(feedIds: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (feedIds.length === 0) return out;
  const unique = Array.from(new Set(feedIds));
  const rows = getDb()
    .prepare(
      `SELECT "feedId", "topicSlug" FROM "FeedTopic" WHERE "feedId" IN (${unique.map(() => '?').join(',')})
       ORDER BY "feedId", "topicSlug"`,
    )
    .all(...unique) as { feedId: string; topicSlug: string }[];
  for (const r of rows) {
    const list = out.get(r.feedId);
    if (list) list.push(r.topicSlug);
    else out.set(r.feedId, [r.topicSlug]);
  }
  return out;
}

/** The archive info of every YOUTUBE row's channel, in one query. */
function archiveFor(rows: FeedRow[]): Map<string, ArchiveInfo> {
  return archiveInfo(
    rows.flatMap((r) => (r.sourceKind === 'YOUTUBE' ? [parseYouTubeFeedUrl(r.url) ?? ''] : [])).filter(Boolean),
  );
}

const NO_ARCHIVE: ArchiveInfo = { archiveSize: 0, archiveFilled: false, archiveError: null };

function mapFeed(row: FeedRow, topics: string[], archive: Map<string, ArchiveInfo>): FeedDTO {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    sourceKind: row.sourceKind as Feed['sourceKind'],
    isActive: bool(row.isActive),
    fetchErrorCount: row.fetchErrorCount,
    lastFetched: row.lastFetched === null ? null : toDate(row.lastFetched).toISOString(),
    createdAt: toDate(row.createdAt).toISOString(),
    updatedAt: toDate(row.updatedAt).toISOString(),
    topics,
    youtube:
      row.sourceKind === 'YOUTUBE'
        ? {
            ...youTubeSettingsFromOptions(youTubeOptionsFromRow(row)),
            ...(archive.get(parseYouTubeFeedUrl(row.url) ?? '') ?? NO_ARCHIVE),
          }
        : null,
  };
}

export function listFeeds(filter: { topic?: string } = {}): FeedDTO[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.topic && filter.topic !== 'ALL') {
    where.push('EXISTS (SELECT 1 FROM "FeedTopic" ft WHERE ft."feedId" = f."id" AND ft."topicSlug" = ?)');
    args.push(filter.topic);
  }
  const rows = getDb()
    .prepare(
      `SELECT * FROM "Feed" f ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY f."createdAt" DESC, f.rowid DESC`,
    )
    .all(...args) as FeedRow[];
  const topics = topicsByFeed(rows.map((r) => r.id));
  const archive = archiveFor(rows);
  return rows.map((r) => mapFeed(r, topics.get(r.id) ?? [], archive));
}

export function getFeed(id: string): FeedDTO | null {
  const row = getDb().prepare('SELECT * FROM "Feed" WHERE "id" = ?').get(id) as FeedRow | undefined;
  if (!row) return null;
  return mapFeed(row, topicsByFeed([id]).get(id) ?? [], archiveFor([row]));
}

// ---------- feed items ----------

export interface FeedItemsQuery {
  topic?: string;
  sort: SortOrder;
  cursor?: Date;
  limit: number;
}

export type FeedItemDTO = Required<FeedItem>;

interface ItemRow {
  id: string;
  feedId: string;
  guid: string;
  title: string;
  link: string;
  summary: string | null;
  author: string | null;
  publishedAt: number;
  sourceRank: number | null;
  feedName: string;
  feedUrl: string;
  media: string | null;
  uploadedAt: number | null;
  sourceKind: string;
}

const ITEM_COLUMNS = `i."id", i."feedId", i."guid", i."title", i."link", i."summary", i."author",
  i."publishedAt", i."sourceRank", f."name" AS feedName, f."url" AS feedUrl, i."media", i."uploadedAt", f."sourceKind"`;

/** A Reddit post's stored media, or null (other feeds, or JSON that no longer parses). */
function parseMedia(json: string | null): RedditMedia | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as RedditMedia;
  } catch {
    return null;
  }
}

function mapItem(row: ItemRow, topics: string[]): FeedItemDTO {
  return {
    id: row.id,
    feedId: row.feedId,
    guid: row.guid,
    title: row.title,
    link: row.link,
    summary: row.summary,
    author: row.author,
    publishedAt: toDate(row.publishedAt).toISOString(),
    feedName: row.feedName,
    feedUrl: row.feedUrl,
    feedTopics: topics,
    media: parseMedia(row.media),
    uploadedAt: row.uploadedAt === null ? null : toDate(row.uploadedAt).toISOString(),
  };
}

/**
 * The feed stream (spec §4.4). Saved and hidden URLs are excluded inside the SQL query.
 * Hot ("recommended") and Shuffle ("random", Hot with a fresh seed and more noise) never page; New pages on publishedAt.
 */
export function listFeedItems(q: FeedItemsQuery): { items: FeedItemDTO[]; nextCursor: string | null } {
  const db = getDb();

  const where = [
    'f."isActive" = 1',
    'i."link" NOT IN (SELECT "url" FROM "SavedLink" UNION SELECT "url" FROM "HiddenLink")',
  ];
  const args: unknown[] = [];
  const topicFiltered = Boolean(q.topic && q.topic !== 'ALL');
  if (topicFiltered) {
    where.push('EXISTS (SELECT 1 FROM "FeedTopic" ft WHERE ft."feedId" = f."id" AND ft."topicSlug" = ?)');
    args.push(q.topic);
  }
  if (q.sort === 'new' && q.cursor) {
    where.push('i."publishedAt" < ?');
    args.push(q.cursor.getTime());
  }

  const from = `FROM "FeedItem" i JOIN "Feed" f ON f."id" = i."feedId" WHERE ${where.join(' AND ')}`;
  let sql: string;
  let take: number;
  const ranked = q.sort === 'recommended' || q.sort === 'random';
  if (ranked) {
    // Round-robin over feeds (each feed's best item, then each one's second, ...), so a feed that posts a lot
    // can't crowd the others out of the pool.
    sql = `SELECT * FROM (
             SELECT ${ITEM_COLUMNS},
               ROW_NUMBER() OVER (
                 PARTITION BY i."feedId" ORDER BY i."sourceRank" ASC, i."publishedAt" DESC, i."id" ASC
               ) AS feedRank
             ${from}
           ) ORDER BY feedRank ASC, "sourceRank" ASC, "publishedAt" DESC, "id" ASC LIMIT ?`;
    take = RANKED_LIST_SIZE;
  } else {
    sql = `SELECT ${ITEM_COLUMNS} ${from} ORDER BY i."publishedAt" DESC LIMIT ?`;
    take = q.limit + 1;
  }

  const rows = db.prepare(sql).all(...args, take) as ItemRow[];
  const topics = topicsByFeed(rows.map((r) => r.feedId));
  const topicsOf = (r: ItemRow) => topics.get(r.feedId) ?? [];

  if (ranked) {
    const counts = db
      .prepare('SELECT "topic", COUNT(*) AS n FROM "SavedLink" GROUP BY "topic"')
      .all() as { topic: string; n: number }[];
    const topicCounts = Object.fromEntries(counts.map((c) => [c.topic, c.n]));
    // Hot: any successful feed store moves the seed, so the order reshuffles then and stays put across reloads.
    // Shuffle: a fresh seed on every request.
    const lastStore = db.prepare('SELECT MAX("lastFetched") AS ms FROM "Feed" WHERE "isActive" = 1').get() as {
      ms: number | null;
    };
    const seed = q.sort === 'random' ? Math.floor(Math.random() * 2 ** 32) : lastStore.ms ?? 0;
    const candidates = rows.map((r) => ({
      id: r.id,
      feedId: r.feedId,
      publishedAt: toDate(r.publishedAt),
      sourceRank: r.sourceRank,
      // YouTube and Reddit are buckets of their own; any other feed is in its topic's (spec §6).
      bucket: r.sourceKind === 'YOUTUBE' || r.sourceKind === 'REDDIT'
        ? r.sourceKind
        : (topicFiltered ? q.topic! : topicsOf(r)[0] ?? ''),
      feed: { name: r.feedName, topic: topicsOf(r)[0] ?? '' },
      row: r,
    }));
    const noiseScale = q.sort === 'random' ? SHUFFLE_NOISE_SCALE : undefined;
    const order = recommendItems(candidates, { topicCounts, seed, noiseScale });
    return { items: order.slice(0, q.limit).map((c) => mapItem(c.row, topicsOf(c.row))), nextCursor: null };
  }

  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;
  return {
    items: page.map((r) => mapItem(r, topicsOf(r))),
    nextCursor: hasMore ? toDate(page[page.length - 1].publishedAt).toISOString() : null,
  };
}

/** The whole stored summary of one item; cards only carry an excerpt. `undefined` if there is no such item. */
export function getItemSummary(id: string): string | null | undefined {
  const row = getDb().prepare('SELECT "summary" FROM "FeedItem" WHERE "id" = ?').get(id) as { summary: string | null } | undefined;
  return row && row.summary;
}

// ---------- saved links ----------

interface SavedLinkRow {
  id: string;
  url: string;
  title: string;
  topic: string;
  notes: string | null;
  savedAt: number;
  updatedAt: number;
}

export type SavedLinkDTO = SavedLink & { updatedAt: string };

export function mapSavedLink(r: SavedLinkRow): SavedLinkDTO {
  return {
    id: r.id,
    url: r.url,
    title: r.title,
    topic: r.topic,
    notes: r.notes,
    savedAt: toDate(r.savedAt).toISOString(),
    updatedAt: toDate(r.updatedAt).toISOString(),
  };
}

export function getSavedLink(id: string): SavedLinkDTO | null {
  const row = getDb().prepare('SELECT * FROM "SavedLink" WHERE "id" = ?').get(id) as SavedLinkRow | undefined;
  return row ? mapSavedLink(row) : null;
}

export function listSavedLinks(topic?: string): SavedLinkDTO[] {
  const filtered = topic && topic !== 'ALL';
  const rows = getDb()
    .prepare(
      `SELECT * FROM "SavedLink" ${filtered ? 'WHERE "topic" = ?' : ''} ORDER BY "savedAt" DESC, rowid DESC`,
    )
    .all(...(filtered ? [topic] : [])) as SavedLinkRow[];
  return rows.map(mapSavedLink);
}
