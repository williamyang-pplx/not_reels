import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../src/db';

/** The Feed table as it was before the forum/blog split was removed. */
const LEGACY_SCHEMA = `
CREATE TABLE "Topic" (
  "slug" TEXT NOT NULL PRIMARY KEY,
  "label" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "Feed" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "sourceKind" TEXT NOT NULL DEFAULT 'RSS',
  "type" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "fetchErrorCount" INTEGER NOT NULL DEFAULT 0,
  "lastFetched" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "Feed_url_key" ON "Feed"("url");
CREATE INDEX "Feed_type_idx" ON "Feed"("type");
CREATE INDEX "Feed_sourceKind_idx" ON "Feed"("sourceKind");
CREATE TABLE "FeedTopic" (
  "feedId" TEXT NOT NULL,
  "topicSlug" TEXT NOT NULL,
  PRIMARY KEY ("feedId", "topicSlug"),
  CONSTRAINT "FeedTopic_feedId_fkey" FOREIGN KEY ("feedId") REFERENCES "Feed" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "FeedTopic_topicSlug_fkey" FOREIGN KEY ("topicSlug") REFERENCES "Topic" ("slug") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "FeedItem" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "feedId" TEXT NOT NULL,
  "guid" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "link" TEXT NOT NULL,
  "summary" TEXT,
  "author" TEXT,
  "publishedAt" DATETIME NOT NULL,
  "sourceRank" INTEGER,
  "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FeedItem_feedId_fkey" FOREIGN KEY ("feedId") REFERENCES "Feed" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
`;

function open() {
  const conn = new Database(':memory:');
  conn.pragma('foreign_keys = ON');
  return conn;
}

const columns = (conn: Database.Database) =>
  (conn.prepare(`SELECT "name" FROM pragma_table_info('Feed')`).all() as { name: string }[]).map((r) => r.name);
const indexes = (conn: Database.Database) =>
  (conn.prepare(`SELECT "name" FROM pragma_index_list('Feed')`).all() as { name: string }[]).map((r) => r.name);

describe('migrate', () => {
  it('drops the legacy Feed.type column and index, keeping rows', () => {
    const conn = open();
    conn.exec(LEGACY_SCHEMA);
    conn.exec(`
      INSERT INTO "Topic" ("slug", "label") VALUES ('NEWS', 'News');
      INSERT INTO "Feed" ("id", "name", "url", "type", "updatedAt") VALUES ('f1', 'Blog', 'https://b.example', 'BLOG', 0);
      INSERT INTO "FeedTopic" VALUES ('f1', 'NEWS');
      INSERT INTO "FeedItem" ("id", "feedId", "guid", "title", "link", "publishedAt") VALUES ('i1', 'f1', 'g', 'T', 'https://b.example/1', 0);
    `);

    migrate(conn);

    expect(columns(conn)).not.toContain('type');
    expect(indexes(conn)).not.toContain('Feed_type_idx');
    expect(conn.prepare('SELECT "name" FROM "Feed" WHERE "id" = ?').get('f1')).toEqual({ name: 'Blog' });
    expect(conn.prepare('SELECT COUNT(*) AS n FROM "FeedTopic"').get()).toEqual({ n: 1 });
    expect(conn.prepare('SELECT COUNT(*) AS n FROM "FeedItem"').get()).toEqual({ n: 1 });
  });

  it('adds Topic.position numbered in the old createdAt order', () => {
    const conn = open();
    conn.exec(LEGACY_SCHEMA);
    conn.exec(`
      INSERT INTO "Topic" ("slug", "label", "createdAt") VALUES ('LATER', 'Later', 2000);
      INSERT INTO "Topic" ("slug", "label", "createdAt") VALUES ('EARLIER', 'Earlier', 1000);
    `);

    migrate(conn);

    expect(conn.prepare('SELECT "slug", "position" FROM "Topic" ORDER BY "position"').all()).toEqual([
      { slug: 'EARLIER', position: 0 },
      { slug: 'LATER', position: 1 },
    ]);
  });

  it('converts subreddit RSS feeds to REDDIT page-URL feeds and deletes their items', () => {
    const conn = open();
    migrate(conn);
    conn.exec(`
      INSERT INTO "Feed" ("id", "name", "url", "sourceKind", "fetchErrorCount", "updatedAt") VALUES
        ('sub', 'Listen', 'https://www.reddit.com/r/listentothis/hot.rss', 'RSS', 3, 0),
        ('old', 'Unix', 'https://reddit.com/r/unixporn/new/.rss', 'REDDIT', 0, 0),
        ('rss', 'Blog', 'https://b.example/feed.xml', 'RSS', 0, 0);
      INSERT INTO "FeedItem" ("id", "feedId", "guid", "title", "link", "publishedAt") VALUES
        ('i1', 'sub', 'g1', 'T', 'https://www.reddit.com/r/listentothis/comments/abcde/x/', 0),
        ('i2', 'rss', 'g2', 'T', 'https://b.example/1', 0);
    `);

    migrate(conn);

    const feeds = () => conn.prepare('SELECT "id", "url", "sourceKind", "fetchErrorCount" FROM "Feed" ORDER BY "id"').all();
    expect(feeds()).toEqual([
      { id: 'old', url: 'https://www.reddit.com/r/unixporn/new/', sourceKind: 'REDDIT', fetchErrorCount: 0 },
      { id: 'rss', url: 'https://b.example/feed.xml', sourceKind: 'RSS', fetchErrorCount: 0 },
      { id: 'sub', url: 'https://www.reddit.com/r/listentothis/', sourceKind: 'REDDIT', fetchErrorCount: 0 },
    ]);
    expect(conn.prepare('SELECT "id" FROM "FeedItem"').all()).toEqual([{ id: 'i2' }]);
    const before = feeds();
    migrate(conn);
    expect(feeds()).toEqual(before);
  });

  it('folds a subreddit feed into an older one with the same page URL, merging topics', () => {
    const conn = open();
    migrate(conn);
    conn.exec(`
      INSERT INTO "Topic" ("slug", "label") VALUES ('MUSIC', 'Music'), ('REDDIT', 'Reddit');
      INSERT INTO "Feed" ("id", "name", "url", "sourceKind", "createdAt", "updatedAt") VALUES
        ('a', 'Listen', 'https://www.reddit.com/r/listentothis/hot.rss', 'RSS', 1, 0),
        ('b', 'Listen too', 'https://old.reddit.com/r/ListenToThis/.rss', 'RSS', 2, 0);
      INSERT INTO "FeedTopic" VALUES ('a', 'MUSIC'), ('b', 'REDDIT');
    `);

    migrate(conn);

    expect(conn.prepare('SELECT "id", "url" FROM "Feed"').all()).toEqual([{ id: 'a', url: 'https://www.reddit.com/r/listentothis/' }]);
    expect(conn.prepare('SELECT "feedId", "topicSlug" FROM "FeedTopic" ORDER BY "topicSlug"').all()).toEqual([
      { feedId: 'a', topicSlug: 'MUSIC' },
      { feedId: 'a', topicSlug: 'REDDIT' },
    ]);
  });

  it('adds FeedItem.media to an older database', () => {
    const conn = open();
    conn.exec(LEGACY_SCHEMA);
    migrate(conn);
    expect(conn.prepare(`SELECT 1 AS ok FROM pragma_table_info('FeedItem') WHERE "name" = 'media'`).get()).toEqual({ ok: 1 });
    migrate(conn);
    expect(conn.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('FeedItem') WHERE "name" = 'media'`).get()).toEqual({ n: 1 });
  });

  it('converts YouTube RSS feeds to YOUTUBE channel feeds, keeping their items', () => {
    const conn = open();
    migrate(conn);
    const channel = 'UC_x5XG1OV2P6uZZ5FSM9Ttw';
    const watch = 'https://www.youtube.com/watch?v=WN-JK-hMAyg';
    conn.exec(`
      INSERT INTO "Feed" ("id", "name", "url", "sourceKind", "fetchErrorCount", "updatedAt") VALUES
        ('yt', 'GD', 'https://www.youtube.com/feeds/videos.xml?channel_id=${channel}', 'RSS', 2, 0),
        ('pl', 'Playlist', 'https://www.youtube.com/feeds/videos.xml?playlist_id=PL123', 'RSS', 0, 0);
      INSERT INTO "FeedItem" ("id", "feedId", "guid", "title", "link", "publishedAt") VALUES ('i1', 'yt', '${watch}', 'T', '${watch}', 0);
    `);

    migrate(conn);

    const feeds = () =>
      conn.prepare('SELECT "id", "url", "sourceKind", "fetchErrorCount", "includeShorts" FROM "Feed" ORDER BY "id"').all();
    expect(feeds()).toEqual([
      { id: 'pl', url: 'https://www.youtube.com/feeds/videos.xml?playlist_id=PL123', sourceKind: 'RSS', fetchErrorCount: 0, includeShorts: null },
      { id: 'yt', url: `https://www.youtube.com/channel/${channel}`, sourceKind: 'YOUTUBE', fetchErrorCount: 0, includeShorts: null },
    ]);
    expect(conn.prepare('SELECT "id" FROM "FeedItem"').all()).toEqual([{ id: 'i1' }]);
    const before = feeds();
    migrate(conn);
    expect(feeds()).toEqual(before);
  });

  it('folds a YouTube RSS feed into an existing feed for the same channel, merging topics', () => {
    const conn = open();
    migrate(conn);
    const channel = 'UC_x5XG1OV2P6uZZ5FSM9Ttw';
    conn.exec(`
      INSERT INTO "Topic" ("slug", "label") VALUES ('MUSIC', 'Music'), ('NEWS', 'News');
      INSERT INTO "Feed" ("id", "name", "url", "sourceKind", "createdAt", "updatedAt") VALUES
        ('new', 'GD', 'https://www.youtube.com/channel/${channel}', 'YOUTUBE', 1, 0),
        ('rss', 'GD RSS', 'https://www.youtube.com/feeds/videos.xml?channel_id=${channel}', 'RSS', 2, 0);
      INSERT INTO "FeedTopic" ("feedId", "topicSlug") VALUES ('new', 'MUSIC'), ('rss', 'NEWS');
    `);

    migrate(conn);

    expect(conn.prepare('SELECT "id" FROM "Feed"').all()).toEqual([{ id: 'new' }]);
    expect(conn.prepare('SELECT "topicSlug" FROM "FeedTopic" WHERE "feedId" = ? ORDER BY 1').all('new')).toEqual([
      { topicSlug: 'MUSIC' },
      { topicSlug: 'NEWS' },
    ]);
  });

  it('adds the YouTube columns to an older database', () => {
    const conn = open();
    conn.exec(LEGACY_SCHEMA);
    migrate(conn);
    migrate(conn);
    for (const name of ['publishedAfter', 'publishedBefore', 'includeShorts', 'showRecent', 'showArchive']) {
      expect(columns(conn).filter((c) => c === name), name).toHaveLength(1);
    }
    expect(conn.prepare(`SELECT 1 AS ok FROM pragma_table_info('FeedItem') WHERE "name" = 'uploadedAt'`).get()).toEqual({ ok: 1 });
    const tables = conn.prepare(`SELECT "name" FROM sqlite_master WHERE "type" = 'table' AND "name" LIKE 'YouTube%' ORDER BY 1`).all();
    expect(tables).toEqual([{ name: 'YouTubeChannel' }, { name: 'YouTubeVideo' }]);
  });

  it('adds the remaining YouTube columns to a DB with only the first three', () => {
    const conn = open();
    conn.exec(LEGACY_SCHEMA);
    conn.exec(`DROP INDEX "Feed_type_idx"; ALTER TABLE "Feed" DROP COLUMN "type";
      ALTER TABLE "Feed" ADD COLUMN "publishedAfter" DATETIME;
      ALTER TABLE "Feed" ADD COLUMN "publishedBefore" DATETIME;
      ALTER TABLE "Feed" ADD COLUMN "includeShorts" BOOLEAN;`);
    migrate(conn);
    expect(columns(conn)).toEqual(expect.arrayContaining(['showRecent', 'showArchive', 'includeShorts']));
    expect(columns(conn).filter((c) => c === 'includeShorts')).toHaveLength(1);
  });

  it('is idempotent on a fresh DB', () => {
    const conn = open();
    migrate(conn);
    migrate(conn);
    expect(columns(conn)).not.toContain('type');
    expect(columns(conn)).toContain('sourceKind');
    expect(conn.prepare(`SELECT 1 AS ok FROM pragma_table_info('Topic') WHERE "name" = 'position'`).get()).toEqual({ ok: 1 });
  });
});
