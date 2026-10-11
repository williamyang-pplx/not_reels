// Service worker: opens the PWA instantly from the last rendered page while the (possibly
// cold) server is revalidated in the background. The page script then swaps in fresh HTML.

declare const __APP_JS__: string;

// Minimal worker typings (the project compiles against the DOM lib).
interface ExtendableEvent extends Event {
  waitUntil(p: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  request: Request;
  respondWith(r: Promise<Response> | Response): void;
}
const sw = self as unknown as {
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  addEventListener(type: 'install' | 'activate', fn: (e: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', fn: (e: FetchEvent) => void): void;
};

const PAGES = 'pages-v1';
const ASSETS = 'assets-v1';
const PAGE_PATHS = new Set(['/', '/saved', '/manage']);
const PRECACHE = [__APP_JS__, '/fonts/rambla-400.woff2', '/fonts/rambla-700.woff2', '/manifest.json', '/icons/galaxy.png'];

sw.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(ASSETS)
      .then((c) => c.addAll(PRECACHE))
      .then(() => sw.skipWaiting()),
  );
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(sw.clients.claim());
});

/** Stale-while-revalidate for the three HTML routes. */
async function page(event: FetchEvent): Promise<Response> {
  const cache = await caches.open(PAGES);
  const cached = await cache.match(event.request, { ignoreVary: true });
  const network = fetch(event.request).then((res) => {
    if (res.ok && res.type === 'basic') void cache.put(event.request, res.clone());
    return res;
  });
  if (cached) {
    event.waitUntil(network.catch(() => undefined));
    return cached;
  }
  return network.catch(async () => (await cache.match('/', { ignoreSearch: true })) ?? Response.error());
}

/** Hashed bundles, fonts and icons never change under the same URL: cache-first. */
async function asset(request: Request): Promise<Response> {
  const cache = await caches.open(ASSETS);
  const cached = await cache.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res.ok) void cache.put(request, res.clone());
  return res;
}

sw.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  if (request.mode === 'navigate' && PAGE_PATHS.has(url.pathname)) {
    event.respondWith(page(event));
  } else if (/^\/(app\.[0-9a-f]+\.js|fonts\/|icons\/|youtube_music_icon\.png)/.test(url.pathname)) {
    event.respondWith(asset(request));
  }
});
