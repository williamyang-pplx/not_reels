import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshSingleFeed } from '../src/lib/feed-refresh';
import { rymMusicRecsProvider } from '../src/lib/local-feeds/rym-music-recs';
import type { LocalFeedRecord } from '../src/lib/local-feeds/types';
import { createFeed, itemsOf, resetDb } from './helpers';

let tmpDir: string;
let oldDbPath: string | undefined;
let oldPrefsPath: string | undefined;

function createRymFixture(
  albums: Array<{ title: string; artist: string; releaseDate: string; broadGenres: string; rating?: string }>,
): { dbPath: string; prefsPath: string } {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'rym-recs-'));
  const dbPath = path.join(tmpDir, 'rym_data.db');
  const prefsPath = path.join(tmpDir, 'rym_music_prefs.json');

  const db = new Database(dbPath);
  db.exec(`CREATE TABLE albums (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT, artist TEXT, release_date TEXT, primary_genres TEXT, secondary_genres TEXT,
    descriptors TEXT, rating TEXT, broad_genres TEXT,
    UNIQUE(title, artist)
  );`);
  const insert = db.prepare(
    `INSERT INTO albums (title, artist, release_date, primary_genres, secondary_genres, descriptors, rating, broad_genres)
     VALUES (?, ?, ?, ?, '', '', ?, ?)`,
  );
  for (const a of albums) insert.run(a.title, a.artist, a.releaseDate, a.broadGenres, a.rating ?? '4.00', a.broadGenres);
  db.close();

  writeFileSync(
    prefsPath,
    JSON.stringify({
      decades: { '1980': 0, '1990': 1, '2000': 0.5, '2010': 1 },
      genres: { Rock: 1, Jazz: 0, Electronic: 0.5, 'Hip Hop': 1 },
    }),
  );
  return { dbPath, prefsPath };
}

function useFixture(albums: Parameters<typeof createRymFixture>[0]) {
  const { dbPath, prefsPath } = createRymFixture(albums);
  process.env.RYM_MUSIC_RECS_DB_PATH = dbPath;
  process.env.RYM_MUSIC_RECS_PREFS_PATH = prefsPath;
}

function rymFeed(): LocalFeedRecord {
  const feed = createFeed({ url: 'local/rym_music_recs', sourceKind: 'LOCAL', type: 'BLOG', topic: 'MUSIC' });
  return { id: feed.id, name: feed.name, url: feed.url, sourceKind: 'LOCAL', type: feed.type };
}

beforeEach(() => {
  oldDbPath = process.env.RYM_MUSIC_RECS_DB_PATH;
  oldPrefsPath = process.env.RYM_MUSIC_RECS_PREFS_PATH;
  resetDb();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (oldDbPath === undefined) delete process.env.RYM_MUSIC_RECS_DB_PATH;
  else process.env.RYM_MUSIC_RECS_DB_PATH = oldDbPath;
  if (oldPrefsPath === undefined) delete process.env.RYM_MUSIC_RECS_PREFS_PATH;
  else process.env.RYM_MUSIC_RECS_PREFS_PATH = oldPrefsPath;
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = '';
});

describe('rymMusicRecsProvider', () => {
  it('filters albums with zero decade or genre preference weight', async () => {
    useFixture([
      { title: 'Allowed Rock', artist: 'A', releaseDate: '1 January 1999', broadGenres: 'Rock' },
      { title: 'Blocked Decade', artist: 'B', releaseDate: '1 January 1989', broadGenres: 'Rock' },
      { title: 'Blocked Genre', artist: 'C', releaseDate: '1 January 1999', broadGenres: 'Jazz' },
      { title: 'Allowed Electronic', artist: 'D', releaseDate: '1 January 2001', broadGenres: 'Electronic' },
    ]);
    const items = await rymMusicRecsProvider({ feed: rymFeed(), now: new Date('2026-05-04T12:00:00Z') });

    expect(items.map((item) => item.title).sort()).toEqual(['Allowed Electronic', 'Allowed Rock']);
    expect(items.map((item) => item.summary).sort()).toEqual([
      'Electronic | 1 January 2001 | RYM 4.00',
      'Rock | 1 January 1999 | RYM 4.00',
    ]);
  });

  it('maps albums to items with the RYM search link, artist and guid', async () => {
    useFixture([{ title: "Don't Stop", artist: 'The Band', releaseDate: '16 June 1997', broadGenres: 'Rock', rating: '4.30' }]);
    const now = new Date('2026-05-04T12:00:00Z');
    const [item] = await rymMusicRecsProvider({ feed: rymFeed(), now });
    expect(item).toEqual({
      guid: 'rym-album-1',
      title: "Don't Stop",
      link: `https://rateyourmusic.com/search?searchterm=${encodeURIComponent("The Band Don't Stop")}`,
      summary: 'Rock | 16 June 1997 | RYM 4.30',
      author: 'The Band',
      publishedAt: now,
      sourceRank: 0,
    });
  });

  it('uses weighted random sampling without replacement', async () => {
    useFixture([
      { title: 'Rock 1', artist: 'A', releaseDate: '1 January 1999', broadGenres: 'Rock' },
      { title: 'Electronic 1', artist: 'B', releaseDate: '1 January 2001', broadGenres: 'Electronic' },
      { title: 'Rock 2', artist: 'C', releaseDate: '1 January 2010', broadGenres: 'Rock' },
    ]);
    const feed = rymFeed();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const items = await rymMusicRecsProvider({ feed, now: new Date('2026-05-04T12:00:00Z') });

    expect(items).toHaveLength(3);
    expect(new Set(items.map((item) => item.guid)).size).toBe(3);
    expect(items[0].title).toBe('Rock 1');
    expect(items.map((item) => item.sourceRank)).toEqual([0, 1, 2]);
  });

  it('excludes albums whose guid already exists in this feed', async () => {
    useFixture([
      { title: 'Rock 1', artist: 'A', releaseDate: '1 January 1999', broadGenres: 'Rock' },
      { title: 'Rock 2', artist: 'B', releaseDate: '1 January 1999', broadGenres: 'Rock' },
    ]);
    const feed = rymFeed();
    const first = await rymMusicRecsProvider({ feed, now: new Date() });
    expect(first).toHaveLength(2);
    await refreshSingleFeed(feed.id);
    const after = await rymMusicRecsProvider({ feed, now: new Date() });
    expect(after).toEqual([]);
  });

  it('refreshes to a distinct current set of 30 albums', async () => {
    useFixture(
      Array.from({ length: 65 }, (_, index) => ({
        title: `Album ${index}`,
        artist: `Artist ${index}`,
        releaseDate: '1 January 1999',
        broadGenres: 'Rock',
      })),
    );
    const feed = rymFeed();

    const first = await refreshSingleFeed(feed.id);
    const firstGuids = new Set(itemsOf(feed.id).map((item) => item.guid));
    const second = await refreshSingleFeed(feed.id);
    const secondGuids = new Set(itemsOf(feed.id).map((item) => item.guid));

    expect(first).toEqual({ ok: true, newItems: 30 });
    expect(second).toEqual({ ok: true, newItems: 30 });
    expect(firstGuids.size).toBe(30);
    expect(secondGuids.size).toBe(30);
    expect([...secondGuids].some((guid) => firstGuids.has(guid))).toBe(false);
  });

  it('fails the refresh when the env-overridden DB path does not exist', async () => {
    process.env.RYM_MUSIC_RECS_DB_PATH = path.join(os.tmpdir(), 'definitely-missing-rym.db');
    const feed = rymFeed();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await refreshSingleFeed(feed.id);
    expect(r).toEqual({ ok: false, newItems: 0 });
  });
});
