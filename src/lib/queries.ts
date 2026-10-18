import { getDb, bool, toDate } from '../db';
import { RELEVANT_FETCH_SIZE } from './constants';
import { recommendItems } from './recommendation';
import type { Feed, FeedItem, SavedLink, SortOrder } from './types';

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

function mapFeed(row: FeedRow, topics: string[]): FeedDTO {
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
  return rows.map((r) => mapFeed(r, topics.get(r.id) ?? []));
}

export function getFeed(id: string): FeedDTO | null {
  const row = getDb().prepare('SELECT * FROM "Feed" WHERE "id" = ?').get(id) as FeedRow | undefined;
  if (!row) return null;
  return mapFeed(row, topicsByFeed([id]).get(id) ?? []);
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
}

const ITEM_COLUMNS = `i."id", i."feedId", i."guid", i."title", i."link", i."summary", i."author",
  i."publishedAt", i."sourceRank", f."name" AS feedName, f."url" AS feedUrl`;

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
  };
}

function shuffle<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * The feed stream (spec §4.4). Saved and hidden URLs are excluded inside the SQL query.
 * Hot ("recommended") and Random never page; New pages on publishedAt.
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

  let orderBy: string;
  let take: number;
  if (q.sort === 'recommended') {
    orderBy = 'i."sourceRank" ASC, i."publishedAt" DESC';
    take = RELEVANT_FETCH_SIZE;
  } else if (q.sort === 'random') {
    orderBy = 'i."publishedAt" DESC';
    take = RELEVANT_FETCH_SIZE;
  } else {
    if (q.cursor) {
      where.push('i."publishedAt" < ?');
      args.push(q.cursor.getTime());
    }
    orderBy = 'i."publishedAt" DESC';
    take = q.limit + 1;
  }

  const rows = db
    .prepare(
      `SELECT ${ITEM_COLUMNS} FROM "FeedItem" i JOIN "Feed" f ON f."id" = i."feedId"
       WHERE ${where.join(' AND ')} ORDER BY ${orderBy} LIMIT ?`,
    )
    .all(...args, take) as ItemRow[];
  const topics = topicsByFeed(rows.map((r) => r.feedId));
  const topicsOf = (r: ItemRow) => topics.get(r.feedId) ?? [];

  if (q.sort === 'recommended') {
    const counts = db
      .prepare('SELECT "topic", COUNT(*) AS n FROM "SavedLink" GROUP BY "topic"')
      .all() as { topic: string; n: number }[];
    const topicCounts = Object.fromEntries(counts.map((c) => [c.topic, c.n]));
    const candidates = rows.map((r) => ({
      id: r.id,
      feedId: r.feedId,
      publishedAt: toDate(r.publishedAt),
      sourceRank: r.sourceRank,
      feed: { name: r.feedName, topic: topicsOf(r)[0] ?? '' },
      row: r,
    }));
    const ranked = recommendItems(candidates, { topicCounts, applyTopicBalance: !topicFiltered });
    return { items: ranked.slice(0, q.limit).map((c) => mapItem(c.row, topicsOf(c.row))), nextCursor: null };
  }

  if (q.sort === 'random') {
    return { items: shuffle(rows).slice(0, q.limit).map((r) => mapItem(r, topicsOf(r))), nextCursor: null };
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
