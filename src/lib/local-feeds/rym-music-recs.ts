import Database from 'better-sqlite3';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getDb } from '../../db';
import type { LocalFeedItemInput, LocalFeedContext } from './types';

const defaultDbPath = () => path.resolve(process.cwd(), 'data/rym_data.db');
const defaultPrefsPath = () => path.resolve(process.cwd(), 'data/rym_music_prefs.json');
const RYM_MUSIC_RECS_COUNT = 30;

interface RymPrefs {
  decades: Record<string, number>;
  genres: Record<string, number>;
}

interface AlbumRow {
  id: number;
  title: string | null;
  artist: string | null;
  release_date: string | null;
  rating: string | null;
  primary_genres: string | null;
  broad_genres: string | null;
}

interface WeightedAlbum {
  row: AlbumRow;
  decade: string;
  genres: string[];
  weight: number;
}

function clampPreference(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function normalizePrefs(input: unknown): RymPrefs {
  const raw = input as Partial<RymPrefs>;
  const decades: Record<string, number> = {};
  const genres: Record<string, number> = {};

  for (const [decade, weight] of Object.entries(raw.decades ?? {})) {
    decades[decade] = clampPreference(weight);
  }
  for (const [genre, weight] of Object.entries(raw.genres ?? {})) {
    genres[genre] = clampPreference(weight);
  }

  return { decades, genres };
}

function parseDecade(releaseDate: string | null): string | null {
  const match = releaseDate?.match(/\b(1[89]\d{2}|20\d{2})\b/);
  if (!match) return null;
  const year = Number.parseInt(match[1], 10);
  return String(Math.floor(year / 10) * 10);
}

function splitList(value: string | null): string[] {
  return (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function scoreAlbum(row: AlbumRow, prefs: RymPrefs): WeightedAlbum | null {
  const decade = parseDecade(row.release_date);
  if (!decade) return null;

  const genres = splitList(row.broad_genres);
  if (genres.length === 0) return null;

  const decadeWeight = prefs.decades[decade] ?? 0;
  const genreWeight = average(genres.map((genre) => prefs.genres[genre] ?? 0));
  const weight = decadeWeight * genreWeight;
  if (weight <= 0) return null;

  return { row, decade, genres, weight };
}

function weightedSampleWithoutReplacement<T extends { weight: number }>(
  items: T[],
  count: number,
): T[] {
  const pool = [...items];
  const selected: T[] = [];

  while (pool.length > 0 && selected.length < count) {
    const totalWeight = pool.reduce((sum, item) => sum + item.weight, 0);
    if (totalWeight <= 0) break;

    let cursor = Math.random() * totalWeight;
    let selectedIndex = pool.length - 1;
    for (let i = 0; i < pool.length; i += 1) {
      cursor -= pool[i].weight;
      if (cursor <= 0) {
        selectedIndex = i;
        break;
      }
    }

    const [picked] = pool.splice(selectedIndex, 1);
    selected.push(picked);
  }

  return selected;
}

function rymSearchUrl(album: AlbumRow): string {
  const query = `${album.artist ?? ''} ${album.title ?? ''}`.trim();
  return `https://rateyourmusic.com/search?searchterm=${encodeURIComponent(query)}`;
}

function itemSummary(album: WeightedAlbum): string {
  const primaryGenres = splitList(album.row.primary_genres);
  const parts = [
    primaryGenres.length > 0 ? primaryGenres.join(', ') : album.genres.join(', '),
    album.row.release_date,
    album.row.rating ? `RYM ${album.row.rating}` : null,
  ].filter(Boolean);
  return parts.join(' | ');
}

async function loadPrefs(): Promise<RymPrefs> {
  const prefsPath = process.env.RYM_MUSIC_RECS_PREFS_PATH ?? defaultPrefsPath();
  const raw = await readFile(prefsPath, 'utf8');
  return normalizePrefs(JSON.parse(raw));
}

/** Read the album rows with a read-only connection (replaces the `sqlite3 -readonly -json` shell-out). */
async function loadAlbums(): Promise<AlbumRow[]> {
  const dbPath = process.env.RYM_MUSIC_RECS_DB_PATH ?? defaultDbPath();
  const albums = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return albums
      .prepare(
        `SELECT id, title, artist, release_date, rating, primary_genres, broad_genres
           FROM albums
          WHERE title IS NOT NULL
            AND artist IS NOT NULL
            AND release_date IS NOT NULL
            AND broad_genres IS NOT NULL`,
      )
      .all() as AlbumRow[];
  } finally {
    albums.close();
  }
}

export async function rymMusicRecsProvider(
  context: LocalFeedContext,
): Promise<LocalFeedItemInput[]> {
  const [prefs, rows, existingItems] = await Promise.all([
    loadPrefs(),
    loadAlbums(),
    getDb().prepare('SELECT "guid" FROM "FeedItem" WHERE "feedId" = ?').all(context.feed.id) as { guid: string }[],
  ]);
  const existingGuids = new Set(existingItems.map((item) => item.guid));

  const candidates = rows
    .filter((row) => !existingGuids.has(`rym-album-${row.id}`))
    .map((row) => scoreAlbum(row, prefs))
    .filter((album): album is WeightedAlbum => album !== null);

  const sampled = weightedSampleWithoutReplacement(candidates, RYM_MUSIC_RECS_COUNT);

  return sampled.map((album, index) => ({
    guid: `rym-album-${album.row.id}`,
    title: album.row.title ?? '',
    link: rymSearchUrl(album.row),
    summary: itemSummary(album),
    author: album.row.artist,
    publishedAt: context.now,
    sourceRank: index,
  }));
}
