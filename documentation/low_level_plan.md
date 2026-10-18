# Low-level plan: not-reels rebuild

## Summary
Rebuild not-reels from scratch (empty worktree) against `.kitchen/plan.md` (the "spec").
Stack choice (spec §2.1, measured in `documentation/framework_choice.md`): **Hono on Node 22,
server-rendered HTML (hono/jsx), a hand-written vanilla-TS client (<8 KB gz), better-sqlite3
with raw SQL**, one esbuild-bundled server file. Every behavior in spec §3–§9 is kept; the API
contract (§4) is byte-compatible; the DB schema (§3) keeps Prisma's table/column names and
its integer-ms DateTime encoding so an existing Prisma DB opens unchanged.

Why this wins on paper (prototype numbers go in framework_choice.md):
- Cold start: no Prisma query engine (≈150–400 ms + ~60 MB RSS), no Next server boot. One
  bundled ESM file + one native addon → expect <150 ms process start to first byte.
- First paint: the feed list is in the first HTML response (the Next app fetches it client-side
  after hydration → "Loading…" first). No framework runtime to download or hydrate.
- Pill tap: fetch an HTML fragment (prefetched on `pointerdown`), swap `innerHTML`; cached
  views swap with zero network.

## Directory layout  [all new]
```
package.json  tsconfig.json  vitest.config.ts  tailwind.config.js  build.mjs
.gitignore  .dockerignore  Dockerfile  fly.toml  .env.example
src/
  server.ts                 # entry: migrate, serve
  app.ts                    # createApp(): Hono — CSP, static, api, pages
  db.ts                     # better-sqlite3 handle, migrations, cuid, tx helper
  lib/  constants.ts types.ts validations.ts api.ts utils.ts embed.ts archive.ts
        guid.ts recommendation.ts rss-fetcher.ts feed-refresh.ts topics.ts
        queries.ts            # read queries shared by API + pages
        local-feeds/ types.ts registry.ts normalize.ts rym-music-recs.ts
  api/  topics.ts feeds.ts feed-items.ts saved-links.ts hidden-links.ts
  views/ layout.tsx nav-bar.tsx badges.tsx feed-card.tsx feed-page.tsx
         saved-page.tsx manage-page.tsx modal.tsx empty-state.tsx
  pages.tsx                 # Hono router: /, /saved, /manage (+ partial mode), /_f/items
client/app.ts               # all browser JS
src/styles.css              # tailwind input
public/  manifest.json youtube_music_icon.png icons/{galaxy,icon-192,icon-512}.png
         favicon.ico icon.png fonts/rambla-{400,700,400i,700i}.woff2
data/  rym_data.db rym_music_prefs.json        # copied unchanged
tests/ *.test.ts setup.ts helpers.ts
scripts/ seed-demo.ts bench/*                 # dev-only
documentation/ framework_choice.md low_level_plan.md
```

## package.json  [new]
```json
{
  "name": "not-reels",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "node build.mjs --watch",
    "build": "node build.mjs",
    "start": "node dist/server.mjs",
    "lint": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:migrate": "node dist/server.mjs --migrate-only",
    "db:deploy": "node dist/server.mjs --migrate-only"
  },
  "dependencies": { "better-sqlite3": "^11", "hono": "^4", "@hono/node-server": "^1",
                    "rss-parser": "^3.13", "zod": "^3.23", "p-limit": "^6" },
  "devDependencies": { "esbuild": "...", "tailwindcss": "^3.4", "typescript": "^5.6",
                       "vitest": "^2", "@types/better-sqlite3": "...", "@types/node": "^22",
                       "playwright-core": "...", "tsx": "..." }
}
```
`db:studio`/`db:generate` are dropped (no Prisma) — see Deviations.

## build.mjs  [new]
```js
// B1 build: (1) tailwind → dist/styles.css (minified)  (2) esbuild client/app.ts →
// dist/public/app.<hash>.js (minify, es2020, iife)  (3) esbuild src/server.ts →
// dist/server.mjs (bundle, platform=node, format=esm, splitting, external=better-sqlite3)
// (4) write dist/manifest.json { css: <inline string>, js: '/app.<hash>.js' } read by layout.
// --watch: rebuild on change + restart node child process.
```

## src/db.ts  [new]
```ts
import Database from 'better-sqlite3';

export type DB = Database.Database;

export function resolveDbPath(url = process.env.DATABASE_URL ?? 'file:./data/dev.db'): string  // D1
  // strip "file:" / "file://"; relative paths resolve against cwd

let db: DB | null = null;

export function getDb(): DB  // D2
  // lazily open resolveDbPath(); pragmas: journal_mode=WAL, synchronous=NORMAL,
  // foreign_keys=ON, busy_timeout=5000; run migrate(db) once

export function closeDb(): void  // D3 (tests)

export function migrate(db: DB): void  // D4
  // CREATE TABLE IF NOT EXISTS for Topic, Feed, FeedTopic, FeedItem, SavedLink, HiddenLink
  // with the exact Prisma column names/types/indexes from spec §3 (DATETIME stored as
  // INTEGER ms like Prisma). Idempotent: an existing Prisma-created DB is left as is.

export function tx<T>(fn: () => T): T  // D5 — getDb().transaction(fn)()

export function cuid(): string  // D6 — 'c' + Date.now().toString(36) + counter + random b36 (25 chars)
```

## src/lib/*  [new — ported 1:1 from the reference, Prisma → SQL]
Pure modules ported verbatim (logic unchanged): `constants.ts` (+ `RYM_FEED_URL`),
`types.ts`, `validations.ts`, `utils.ts` (+ `topicColor(slug)` from spec §7), `embed.ts`,
`archive.ts`, `guid.ts`, `recommendation.ts`, `rss-fetcher.ts` (UA string per spec §5.3),
`local-feeds/{types,registry,normalize}.ts`.

```ts
// src/lib/api.ts — Hono flavour of the shared helpers
export function ok<T>(c: Context, data: T, status: 200 | 201 = 200): Response   // A1
export function fail(c: Context, message: string, code: ErrorCode, status: StatusCode): Response  // A2
export async function parseJson<T>(c: Context, schema: ZodSchema<T>):
  Promise<{ ok: true; data: T } | { ok: false; response: Response }>   // A3 — INVALID_JSON / VALIDATION_ERROR "path: msg; path: msg"
export function parseQuery<T>(c: Context, schema: ZodSchema<T>): ...  // A4

// src/lib/topics.ts
export function ensureDefaultTopics(): void        // T1 — insert DEFAULT_TOPICS iff Topic empty (createdAt = now + i ms to keep order)
export function topicExists(slug: string): boolean // T2
export function findUnknownTopics(slugs: string[]): string[]  // T3

// src/lib/queries.ts — read paths used by both JSON API and HTML pages
export interface FeedItemsQuery { type?: FeedType | 'SAVED'; topic?: string; sort: SortOrder; cursor?: Date; limit: number }
export function listFeedItems(q: FeedItemsQuery): { items: FeedItemDTO[]; nextCursor: string | null }  // Q1
  // SAVED → empty. WHERE f.isActive=1 [AND f.type=?] [AND EXISTS FeedTopic topic=?]
  // AND i.link NOT IN (SELECT url FROM SavedLink UNION SELECT url FROM HiddenLink)   ← in SQL
  // recommended: ORDER BY sourceRank ASC NULLS?, publishedAt DESC LIMIT 200 → attach topics
  //   (one query: SELECT feedId, topicSlug FROM FeedTopic WHERE feedId IN (...) ORDER BY feedId, topicSlug)
  //   → recommendItems(topicCounts from SavedLink GROUP BY topic, applyTopicBalance = !topic||ALL) → slice
  // random: publishedAt DESC LIMIT 200 → Fisher–Yates → slice
  // new: [publishedAt < cursor] ORDER BY publishedAt DESC LIMIT limit+1 → nextCursor
export function listTopics(): TopicRecord[]        // Q2 — ensureDefaultTopics() then ORDER BY createdAt, rowid
export function listFeeds(f: { type?: string; topic?: string }): FeedDTO[]  // Q3 — createdAt DESC, topics flattened
export function getFeed(id: string): FeedDTO | null // Q4
export function listSavedLinks(topic?: string): SavedLinkDTO[]  // Q5 — savedAt DESC
```
Note on `sourceRank asc`: Prisma/SQLite sorts NULL first on ASC; we keep SQLite default (NULLs first) to match.

```ts
// src/lib/feed-refresh.ts — same exported API as reference
export interface RefreshOptions { fetcher?: FeedFetcher; localProviders?: LocalFeedProviderRegistry; concurrency?: number }
export async function refreshSingleFeed(feedId: string, options?: RefreshOptions): Promise<{ newItems: number; ok: boolean }>  // R1
  // fetch normalized items (LOCAL provider | RSS fetcher, lazy-imported) → in one tx:
  // upsert (INSERT ... ON CONFLICT(feedId,guid) DO UPDATE), count new, mark stale (rank 10000),
  // set lastFetched/fetchErrorCount=0, prune to 30 (RYM) / 15 (sourceRank asc, publishedAt desc)
  // catch: fetchErrorCount+1, deactivate at ≥5, log "[feed-refresh] failed feed=<id> url=<url>:"
export async function refreshFeeds(type: FeedType, options?: RefreshOptions): Promise<RefreshResult>  // R2 — p-limit(6) per type
export async function refreshAllFeeds(options?: RefreshOptions): Promise<RefreshResult>  // R3

// src/lib/local-feeds/rym-music-recs.ts
export async function rymMusicRecsProvider(ctx: LocalFeedContext): Promise<LocalFeedItemInput[]>  // L1
  // same algorithm; albums read with better-sqlite3 {readonly:true} instead of the sqlite3 CLI
```

## src/api/*.ts  [new]
One Hono sub-router per resource, mounted under `/api` by `createApp()`. Bodies are the
reference route handlers with Prisma calls swapped for SQL; status codes/messages identical.
```ts
export const topicsApi = new Hono()        // GET / POST /api/topics, DELETE /api/topics/:slug   (H1)
export const feedsApi = new Hono()         // GET / POST /api/feeds, PATCH / DELETE /api/feeds/:id (H2)
export const feedItemsApi = new Hono()     // GET /api/feed-items (validates sort/limit/type/topic/cursor, calls Q1),
                                           // POST /api/feed-items/refresh (H3)
export const savedLinksApi = new Hono()    // GET / POST, PATCH / DELETE /:id (H4)
export const hiddenLinksApi = new Hono()   // POST (upsert), DELETE ?url= (H5)
```

## src/app.ts  [new]
```ts
export function createApp(): Hono  // P1
  // middleware: CSP header (spec §9.3, exact string) on every response
  // static: /app.<hash>.js, /fonts/*, /icons/* → Cache-Control: public, max-age=31536000, immutable
  //         /manifest.json, /youtube_music_icon.png, /favicon.ico, /icon.png → max-age=86400
  // gzip/brotli: precompressed .br/.gz for static at build time; HTML/JSON via hono compress()
  // route('/api', ...H1–H5); route('/', pagesRouter)
```

## src/pages.tsx  [new]
```tsx
export const pagesRouter = new Hono()  // V1
// GET /        ?type=FORUM|BLOG&topic=&sort=   → Layout(NavBar + FeedPage) ; sort param is internal (client never puts it in the address bar)
// GET /saved   ?topic=                         → Layout(NavBar + SavedPage)
// GET /manage                                  → Layout(NavBar + ManagePage)
// Header "X-Partial: 1" → return only the #app inner HTML (nav + main) with no <html>/<head>; Vary: X-Partial
// GET /_f/items?type&topic&sort=new&cursor     → next page of FeedCards + new sentinel (infinite scroll)
// All HTML: Cache-Control: no-store
```

## src/views/*.tsx  [new]  (hono/jsx, server only)
```tsx
export function Layout(p: { title?: string; children: Child }): JSX  // W1 — head: meta viewport (cover), theme-color,
  // apple-mobile-web-app-* tags, manifest, apple-touch-icon, <link rel=preload font 400>, inline <style> (tailwind + @font-face),
  // <script src=/app.<hash>.js defer>; body: <div id="app">…</div><main class="mx-auto max-w-2xl px-3 pb-10">
export function NavBar(p: { path: string; type: FilterType; topic: string; topics: TopicRecord[] }): JSX  // W2 — test ids per spec §8.9; pills are <a href> (work without JS) with data-nav
export function TopicBadge(p: { topic: string }): JSX; export function TypeBadge(p: { type: FeedType }): JSX  // W3
export function FeedCard(p: { item: FeedItemDTO; now: Date }): JSX  // W4 — standard + RYM variant (spec §8.4/8.5);
  // YouTube: <lite-yt data-id> facade (thumbnail img + play button, iframe on tap); Reddit: lazy iframe (500px)
export function FeedPage(p: { type; topic; sort; data: {items; nextCursor} }): JSX  // W5 — toolbar, list, sentinel data-cursor
export function SavedPage(p: { links: SavedLinkDTO[]; topics: TopicRecord[] }): JSX  // W6 — + Save link modal
export function ManagePage(p: { topics: TopicRecord[]; feeds: FeedDTO[] }): JSX  // W7 — topics manager, add-feed modal, edit modal, feed rows
export function Modal(p: { id: string; testId: string; title: string; children }): JSX  // W8 — overlay pattern (spec §8.8)
export function EmptyState(p: { message: string }): JSX  // W9
```

## client/app.ts  [new] — the only browser JS
```ts
// C1 navigation: intercept clicks on a[data-nav]; build view URL (+ current sort for "/");
//   cache Map<url, {html, at}> (fresh 30 s like React Query staleTime); prefetch on pointerdown;
//   swap #app innerHTML, keep pill-row scrollLeft, history.pushState(url without sort); popstate → same.
// C2 sort control: [data-sort] buttons → set module-level sort, reload "/" view (not in URL).
// C3 refresh: [data-testid=refresh-button] → POST /api/feed-items/refresh {} → status text, drop feed caches, reload view.
// C4 card actions (event delegation): save (POST /api/saved-links) / hide (POST /api/hidden-links):
//   label Saving…/Hiding… → Saved!/Hidden, then collapse+remove card; errors inline red; invalidate caches
//   (save: feed + saved; hide: feed only). archive.* / press released / YouTube facade.
// C5 infinite scroll: IntersectionObserver on [data-testid=sentinel][data-cursor] → GET /_f/items → append.
// C6 modals: open/close via [data-open]/[data-close]; overlay click closes; forms → JSON API → on success reset,
//   close, invalidate, reload current view. Topic add (slug derivation + errors), topic delete (window.confirm text
//   verbatim), feed refresh/pause/edit/delete, saved-link delete.
```

## Tests  [new] — `pnpm test` (vitest, pool forks, singleFork, 20 s timeout)
- setup.ts: `DATABASE_URL=file:<tmp>/test.db`, delete it, `getDb()` (migrates), `ensureDefaultTopics()`.
- helpers.ts: `resetDb()`, `createFeed(overrides)`, `seedItems(feedId, n, start)` (SQL).
- Ported suites (same cases as reference): validations, utils, embed, archive, rss-fetcher,
  recommendation, feed-refresh, rym-music-recs, api-feeds, api-feed-items, api-feed-items-refresh,
  api-topics, api-saved-links. API suites call `createApp().request(path, init)` in-process.
- New: `pages.test.ts` — `/`, `/saved`, `/manage` render with the spec §8.9 test ids; partial mode; `/_f/items`; CSP header.
- E2E/UI (dev-only, playwright-core + system Chrome): `scripts/ui-check.mjs` — screenshots + pill/save/hide timings.

## Dockerfile / fly.toml  [new]
- node:22-slim multi-stage; build stage: `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm prune --prod`.
- runtime: `ca-certificates` only (no openssl/sqlite3 needed), copies `dist/`, `node_modules` (better-sqlite3 only + deps),
  `data/`, `public/`; `DATABASE_URL=file:///data/sqlite.db`; `CMD ["node","dist/server.mjs"]` (migrations run in-process at boot; no entrypoint script, no pnpm at runtime).
- fly.toml: app `not-reels`, region `ams`, mount `data`→`/data` auto-extend 80%/1GB/10GB, port 3000, force_https,
  auto stop/start, min 0, 1 CPU / 512 MB.

## Deviations from the spec
1. **Prisma → better-sqlite3 + raw SQL.** Same tables, columns, indexes, cascade FKs and integer-ms dates. Removes the
   Prisma engine from cold start and memory. `db:studio` / `db:generate` scripts drop out.
2. **RYM provider reads the album DB with better-sqlite3 (read-only) instead of shelling out to `sqlite3`.** Same query,
   same rows; the runtime image no longer needs the `sqlite3` CLI. Env overrides unchanged.
3. **lite-youtube → in-house facade** (thumbnail + play button → `youtube-nocookie` iframe with `rel=0&autoplay=1`). Same
   UX, no third-party script; fits the existing CSP.
4. **Save/Hide remove the card in place** instead of refetching the whole list (same end state as the invalidation; no
   reshuffle in Random mode). Other cached views are invalidated exactly as the spec's query-key rules say.
5. **Data is server-rendered into the first HTML**, so the initial "Loading…" state only appears on client re-fetches.
6. **docker-entrypoint.js removed**; `server.ts` migrates at boot (idempotent `CREATE TABLE IF NOT EXISTS`).
7. **Service worker** (`client/sw.ts`, added after measuring): it caches the HTML routes stale-while-revalidate, so the PWA opens
   instantly while a stopped Fly machine boots. The client swaps in fresh HTML once it arrives.
8. **Save / Hide / saved-link Delete are optimistic**: the card leaves on tap and is restored, with an inline error, if the request fails.
   The "Saving…" step is never visible as a result.
9. **Reddit iframes start loading via IntersectionObserver ~300 px before view**, instead of the browser's 1250–2500 px
   `loading=lazy` distance. Same iframe, src and sandbox.
10. **Feed/saved links render only http(s) URLs as clickable** (`safeHref`), because the CSP allows inline script and a feed could ship `javascript:` links.
11. HTML entities that feeds leave in titles and summaries (`What&#39;s`) are decoded for display only. Stored data is unchanged.
12. **Topic delete shows the 409 error inline.** The original UI dropped it silently.
13. **Default topics are also seeded at boot**, not only on topic reads. Otherwise a fresh DB rejected `POST /api/feeds` with "Unknown topic" until something had listed topics.
14. **Spec §2.1 step 3 says "stop and show the framework table before building". Per the user's instruction this run does
   not stop; the table is written to `documentation/framework_choice.md` and summarized at the end.
15. **The feed is a scroller, with autoplay** (the spec's card list is gone). One card per screen, snapping under the
   sticky nav; the layout is CSS only. The YouTube video in view autoplays muted, because iOS blocks unmuted autoplay.
   Summaries are never cut: cards carry an 80-word excerpt (not 20) and the client swaps in the whole summary from
   `/_f/summary/:id` before the card comes into view, because some summaries are whole articles (up to ~330 KB).
16. **Summary is the longest text the feed sends** (spec §5.4 said the first of `contentSnippet`/`content`/`contentEncoded`).
   Feeds like Book Riot and Lit Hub send a one-line `<description>` beside the full `<content:encoded>`, and YouTube's
   only text is `media:description`, so the first-defined rule kept the teaser or nothing.

## Open questions (recommended answer used)
- Inline CSS vs cached file? → inline (≈3 KB gz) — saves a render-blocking round trip on the cold path.
- Service worker? → not in v1; revisit after measuring (cold Fly start dominates, a SW can't hide it without showing stale data).
