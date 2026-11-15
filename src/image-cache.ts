import type { MiddlewareHandler } from 'hono';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pLimit from 'p-limit';
import { resolveDbPath } from './db';
import { redlibUrl } from './redlib';

/**
 * GET /_img/<redlib image path>: a Reddit image, fetched through Redlib, shrunk to MAX_WIDTH as WebP and cached on
 * disk. Reddit posts link full-resolution originals (4–5 MB each); cards show them at about 150–300 KB. Only Redlib's
 * image paths are accepted, so this is not an open proxy.
 */

const PREFIX = '/_img';
const IMAGE_PATH = /^\/(preview|img|thumb|emoji)\//;
const MAX_WIDTH = 1080; // px; narrower images are re-encoded, never enlarged
const QUALITY = 72; // WebP quality
const CACHE_LIMIT_BYTES = 512 * 1024 * 1024; // past this, the oldest files are deleted down to 90%
const FETCH_TIMEOUT_MS = 20_000;
const resizeLimit = pLimit(2); // sharp is CPU-bound; two at a time keeps page renders responsive

/** IMAGE_CACHE_DIR, else img-cache next to the DB (the Fly volume in production), else a temp dir for an in-memory DB. */
function cacheDir(): string {
  if (process.env.IMAGE_CACHE_DIR) return process.env.IMAGE_CACHE_DIR;
  const db = resolveDbPath();
  return db === ':memory:' ? path.join(tmpdir(), 'nr-img-cache') : path.join(path.dirname(db), 'img-cache');
}

/** The card's src for a Redlib image path. */
export function shrunkImageSrc(redlibPath: string): string {
  return PREFIX + redlibPath;
}

let cacheBytes: number | null = null; // total size of the cache dir, counted on first write

async function listCache(dir: string): Promise<{ file: string; size: number; mtime: number }[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const files = await Promise.all(
    names
      .filter((n) => n.endsWith('.webp'))
      .map(async (n) => {
        const s = await stat(path.join(dir, n)).catch(() => null);
        return s ? { file: path.join(dir, n), size: s.size, mtime: s.mtimeMs } : null;
      }),
  );
  return files.filter((f): f is { file: string; size: number; mtime: number } => f !== null);
}

/** Count a new file; past the limit, delete the oldest files down to 90% of it. */
async function account(dir: string, added: number): Promise<void> {
  if (cacheBytes === null) cacheBytes = (await listCache(dir)).reduce((n, f) => n + f.size, 0);
  else cacheBytes += added;
  if (cacheBytes <= CACHE_LIMIT_BYTES) return;
  const files = (await listCache(dir)).sort((a, b) => a.mtime - b.mtime);
  cacheBytes = files.reduce((n, f) => n + f.size, 0);
  for (const f of files) {
    if (cacheBytes <= CACHE_LIMIT_BYTES * 0.9) break;
    await unlink(f.file).catch(() => {});
    cacheBytes -= f.size;
  }
}

const inFlight = new Map<string, Promise<Buffer | Response>>();

/** Fetch from Redlib and shrink. A Response means "pass this through" (an upstream error, or an image sharp can't read). */
async function shrink(base: string, redlibPath: string, file: string): Promise<Buffer | Response> {
  const res = await fetch(base + redlibPath, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) return new Response(null, { status: res.status === 404 ? 404 : 502, headers: { 'Cache-Control': 'no-store' } });
  const original = Buffer.from(await res.arrayBuffer());
  let out: Buffer;
  try {
    const { default: sharp } = await import('sharp');
    out = await resizeLimit(() =>
      sharp(original).rotate().resize({ width: MAX_WIDTH, withoutEnlargement: true }).webp({ quality: QUALITY }).toBuffer(),
    );
  } catch (err) {
    console.error(`[img] could not shrink ${redlibPath}:`, err);
    return new Response(original, {
      headers: { 'Content-Type': res.headers.get('content-type') ?? 'application/octet-stream', 'Cache-Control': 'no-store' },
    });
  }
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, out);
  await rename(tmp, file);
  await account(dir, out.length);
  return out;
}

function webp(body: Buffer): Response {
  return new Response(new Uint8Array(body), {
    headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=31536000, immutable' },
  });
}

export const imageCache: MiddlewareHandler = async (c, next) => {
  if (!c.req.path.startsWith(PREFIX + '/')) return next();
  const url = new URL(c.req.url);
  const redlibPath = url.pathname.slice(PREFIX.length) + url.search;
  if (!IMAGE_PATH.test(redlibPath)) return c.text('Not found', 404);
  const base = redlibUrl();
  if (!base) return c.text('Reddit images are off: REDLIB_URL is not set', 503);

  const key = createHash('sha1').update(redlibPath).digest('hex');
  const file = path.join(cacheDir(), `${key}.webp`);
  const cached = await readFile(file).catch(() => null);
  if (cached) return webp(cached);

  let pending = inFlight.get(key);
  if (!pending) {
    pending = shrink(base, redlibPath, file).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  try {
    const result = await pending;
    return result instanceof Response ? result.clone() : webp(result);
  } catch (err) {
    console.error(`[img] ${redlibPath} failed:`, err);
    return new Response(null, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
};
