import { Hono, type MiddlewareHandler } from 'hono';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync, constants as zc } from 'node:zlib';
import { topicsApi } from './api/topics';
import { feedsApi } from './api/feeds';
import { feedItemsApi } from './api/feed-items';
import { savedLinksApi } from './api/saved-links';
import { hiddenLinksApi } from './api/hidden-links';
import { pagesRouter } from './pages';

export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://www.youtube.com https://www.youtube-nocookie.com https://s.ytimg.com https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "img-src 'self' data: https: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  'frame-src https://www.youtube.com https://www.youtube-nocookie.com https://www.redditmedia.com https://embed.reddit.com',
  "media-src 'self' https:",
].join('; ');

const COMPRESSIBLE = /^(text\/|application\/(json|javascript|manifest\+json)|image\/svg)/;

type Encoding = 'br' | 'gzip' | null;

function pickEncoding(accept: string | undefined): Encoding {
  if (!accept) return null;
  if (/\bbr\b/.test(accept)) return 'br';
  if (/\bgzip\b/.test(accept)) return 'gzip';
  return null;
}

function encode(buf: Buffer, enc: Exclude<Encoding, null>, quality: number): Buffer {
  return enc === 'br'
    ? brotliCompressSync(buf, { params: { [zc.BROTLI_PARAM_QUALITY]: quality, [zc.BROTLI_PARAM_SIZE_HINT]: buf.length } })
    : gzipSync(buf, { level: 6 });
}

/** Brotli/gzip for dynamic HTML and JSON. Sync zlib is ~1 ms for a 100-card page. */
const compress: MiddlewareHandler = async (c, next) => {
  await next();
  const res = c.res;
  const enc = pickEncoding(c.req.header('Accept-Encoding'));
  const type = res.headers.get('Content-Type') ?? '';
  if (!enc || !res.body || res.headers.has('Content-Encoding') || !COMPRESSIBLE.test(type)) return;
  const buf = Buffer.from(await res.arrayBuffer());
  // Merge into the existing Vary on the old response too: Hono's c.res setter copies the old
  // response's headers onto the new one, which would otherwise drop Accept-Encoding.
  const vary = [res.headers.get('Vary'), 'Accept-Encoding'].filter(Boolean).join(', ');
  res.headers.set('Vary', vary);
  res.headers.delete('Content-Length');
  const headers = new Headers(res.headers);
  if (buf.length < 1024) {
    c.res = new Response(buf, { status: res.status, headers });
    return;
  }
  headers.set('Content-Encoding', enc);
  headers.delete('Content-Length');
  c.res = new Response(new Uint8Array(encode(buf, enc, 5)), { status: res.status, headers });
};

const MIME: Record<string, string> = {
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

interface StaticFile {
  type: string;
  cache: string;
  raw: Buffer;
  br?: Buffer;
  gzip?: Buffer;
}

/**
 * Serves /public and the built client bundle from memory. Each file is read and compressed
 * once (max brotli quality, since it is a one-off), then reused for every request.
 */
function staticFiles(roots: string[]): MiddlewareHandler {
  const cache = new Map<string, StaticFile>(); // hits only, so arbitrary paths can't grow it
  const load = (urlPath: string): StaticFile | null => {
    const hit = cache.get(urlPath);
    if (hit) return hit;
    let file: StaticFile | null = null;
    let rel: string;
    try {
      rel = path.posix.normalize(decodeURIComponent(urlPath));
    } catch {
      return null; // malformed escape: let the router 404 it
    }
    if (!rel.includes('..') && path.extname(rel)) {
      for (const root of roots) {
        const abs = path.join(root, rel);
        if (!existsSync(abs)) continue;
        const raw = readFileSync(abs);
        const type = MIME[path.extname(abs)] ?? 'application/octet-stream';
        const hashed = /\.[0-9a-f]{8,}\.(js|css)$/.test(rel) || rel.startsWith('/fonts/');
        file = {
          type,
          raw,
          cache: hashed ? 'public, max-age=31536000, immutable' : rel === '/sw.js' ? 'no-cache' : 'public, max-age=86400',
        };
        if (COMPRESSIBLE.test(type) && raw.length > 512) {
          file.br = encode(raw, 'br', 11);
          file.gzip = gzipSync(raw, { level: 9 });
        }
        break;
      }
    }
    if (file) cache.set(urlPath, file);
    return file;
  };
  return async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();
    const file = load(c.req.path);
    if (!file) return next();
    const enc = file.br ? pickEncoding(c.req.header('Accept-Encoding')) : null;
    const body = enc ? file[enc]! : file.raw;
    const headers: Record<string, string> = { 'Content-Type': file.type, 'Cache-Control': file.cache };
    if (file.br) headers.Vary = 'Accept-Encoding';
    if (enc) headers['Content-Encoding'] = enc;
    return c.body(new Uint8Array(body), 200, headers);
  };
}

export function createApp(opts: { staticRoots?: string[] } = {}): Hono {
  const app = new Hono();
  // Resolve against the server bundle (dist/), not cwd, so the server can start from anywhere.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const roots = opts.staticRoots ?? [path.join(here, 'public'), path.join(here, '../public'), path.join(here, '../dist/public')];

  app.use('*', async (c, next) => {
    await next();
    c.res.headers.set('Content-Security-Policy', CSP);
  });
  app.use('*', staticFiles(roots));
  app.use('*', compress);

  app.use('/api/*', async (c, next) => {
    await next();
    c.res.headers.set('Cache-Control', 'no-store');
  });
  app.route('/api/topics', topicsApi);
  app.route('/api/feeds', feedsApi);
  app.route('/api/feed-items', feedItemsApi);
  app.route('/api/saved-links', savedLinksApi);
  app.route('/api/hidden-links', hiddenLinksApi);
  app.route('/', pagesRouter);
  return app;
}
