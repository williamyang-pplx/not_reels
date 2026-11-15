import type { MiddlewareHandler } from 'hono';

/**
 * Base URL of the Redlib container, from REDLIB_URL (scripts/restart.sh uses port 8180 on loopback), or null when
 * it is unset and Reddit windows are off. Read per call so tests can set it.
 */
export function redlibUrl(): string | null {
  const url = process.env.REDLIB_URL?.trim().replace(/\/+$/, '');
  return url || null;
}

// The Redlib routes a window can reach (Redlib's src/main.rs). Everything else stays ours: /, /manifest.json,
// /favicon.ico, /robots.txt, /saved, /manage, /_f/*, /api/*.
const REDLIB_PREFIXES = [
  '/r/', '/u/', '/user/', '/comments/', '/duplicates/', '/search', '/settings', '/wiki', '/w/',
  '/img/', '/vid/', '/hls/', '/packaged/', '/packaged-external/', '/thumb/', '/emoji/', '/emote/',
  '/preview/', '/style/', '/static/', '/giphy/', '/redgifs/',
];
const REDLIB_FILES = new Set([
  '/style.css', '/Inter.var.woff2', '/logo.png', '/touch-icon-iphone.png', '/opensearch.xml',
  '/info', '/playHLSVideo.js', '/autoplayVisible.js', '/hls.min.js', '/highlighted.js', '/check_update.js', '/copy.js',
  '/themePreview.js', '/downloadGallery.js', '/loadMoreComments.js', '/searchTabs.js',
]);

/** Where a frame goes when a Redlib link leads nowhere better (Redlib's "/" is our app). */
const REDLIB_HOME = '/r/popular';

/** Redlib's "home" for a page: its subreddit (/r/<sub>), or REDLIB_HOME outside one. */
function redlibHome(path: string): string {
  return /^\/r\/[^/]+/.exec(path)?.[0] ?? REDLIB_HOME;
}

function isRedlibPath(path: string): boolean {
  return REDLIB_FILES.has(path) || REDLIB_PREFIXES.some((p) => path.startsWith(p));
}

// How long to wait for Redlib's response headers. Its own Reddit calls can be slow when it falls back between
// backends. Cleared once headers arrive, so long video downloads are never cut off.
const HEADERS_TIMEOUT_MS = 20_000;

/** Request headers passed to Redlib. accept-encoding is always identity: `compress` re-encodes for the browser. */
const FORWARDED_REQUEST_HEADERS = ['accept', 'accept-language', 'cookie', 'content-type', 'range', 'if-none-match', 'user-agent'];

/** Response headers that describe the hop to Redlib, or that our origin must not take on. */
const DROPPED_RESPONSE_HEADERS = [
  'connection', 'keep-alive', 'transfer-encoding', 'content-encoding', 'content-length',
  'x-frame-options', 'strict-transport-security', // Redlib's HSTS must not pin our origin
];

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

function plainText(message: string, status: 502 | 503): Response {
  return new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}

/**
 * Same-origin reverse proxy to Redlib, mounted after `compress` so its HTML, CSS and JS are compressed like our
 * pages. Redlib forbids framing (X-Frame-Options: DENY, frame-ancestors 'none'); the response allows our own
 * origin instead. Its CSP is kept, so the CSP middleware leaves it alone.
 */
export const redlibProxy: MiddlewareHandler = async (c, next) => {
  const base = redlibUrl();
  if (!isRedlibPath(c.req.path)) {
    // Nothing frames our own pages, so a frame navigating to one is a Redlib link the allowlist and the HTML
    // rewrite missed. Our page would refuse to load ("localhost refused to connect"); send the frame back to Redlib.
    if (base && c.req.header('Sec-Fetch-Dest') === 'iframe') return c.redirect(REDLIB_HOME, 302);
    return next();
  }
  if (!base) return plainText('Reddit windows are off: REDLIB_URL is not set', 503);

  const headers = new Headers({ 'accept-encoding': 'identity' });
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = c.req.header(name);
    if (value) headers.set(name, value);
  }
  const method = c.req.method;
  // Settings and subscribe forms are tiny, so the body is buffered rather than streamed.
  const body = method === 'GET' || method === 'HEAD' ? undefined : await c.req.arrayBuffer();

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), HEADERS_TIMEOUT_MS);
  c.req.raw.signal?.addEventListener('abort', () => abort.abort(), { once: true });
  let res: Response;
  try {
    res = await fetch(base + c.req.path + new URL(c.req.url).search, {
      method,
      headers,
      body,
      redirect: 'manual', // Node returns the real 3xx; Redlib's Location headers are relative
      signal: abort.signal,
    });
  } catch (err) {
    // The browser left (a frame scrolled away or the view changed): nobody is waiting for the answer.
    if (c.req.raw.signal?.aborted) return plainText('Request cancelled', 502);
    if (abort.signal.aborted) console.error(`[redlib] ${method} ${c.req.path}: no response in ${HEADERS_TIMEOUT_MS / 1000} s`);
    else console.error(`[redlib] ${method} ${c.req.path} failed:`, err);
    return plainText('Redlib is not reachable', 502);
  } finally {
    clearTimeout(timer);
  }
  return frameableResponse(res, c.req.path);
};

/**
 * A new Response (the fetch one has immutable headers) with the headers our origin needs. HTML goes through
 * rewriteRedlibHtml, error pages included (they carry the same header links); every other body streams through.
 */
async function frameableResponse(res: Response, path: string): Promise<Response> {
  // new Headers() keeps every Set-Cookie (Redlib's settings), unlike copying with set().
  const headers = new Headers(res.headers);
  for (const name of DROPPED_RESPONSE_HEADERS) headers.delete(name);
  // Redlib redirects some requests (an empty search) to its front page, "/", which is our app.
  if (headers.get('location') === '/') headers.set('location', redlibHome(path));
  const csp = headers.get('content-security-policy');
  if (csp) headers.set('content-security-policy', csp.replace(/frame-ancestors[^;]*/i, "frame-ancestors 'self'"));

  const status = res.status;
  if (NULL_BODY_STATUSES.has(status)) return new Response(null, { status, headers });
  if ((headers.get('content-type') ?? '').startsWith('text/html')) {
    return new Response(rewriteRedlibHtml(await res.text(), path), { status, headers });
  }
  return new Response(res.body, { status, headers });
}

const ANCHOR_TAG = /<a\b[^>]*>/gi;
const EXTERNAL_HREF = /\shref\s*=\s*["']https?:\/\//i;
const HOME_HREF = /(\shref\s*=\s*)(["'])\/\2/gi;

/**
 * Two fixes for HTML shown inside a window. A link to another site would load that site in the frame (most refuse
 * to be framed), so every <a> with an absolute http(s) href and no target gets target="_blank". Redlib's logo
 * links to "/", which is our app, so href="/" becomes the subreddit the page belongs to (/r/<sub> from `path`),
 * or /r/popular outside a subreddit.
 */
export function rewriteRedlibHtml(html: string, path: string): string {
  const home = redlibHome(path);
  return html.replace(ANCHOR_TAG, (tag) => {
    let out = tag.replace(HOME_HREF, `$1$2${home}$2`);
    if (EXTERNAL_HREF.test(out) && !/\starget\s*=/i.test(out)) {
      out = out.replace(/^<a\b/i, /\srel\s*=/i.test(out) ? '<a target="_blank"' : '<a target="_blank" rel="noopener"');
    }
    return out;
  });
}
