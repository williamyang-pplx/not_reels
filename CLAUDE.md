# CLAUDE.md

not-brainrot: personal RSS aggregator (iPhone home-screen PWA). The behavior spec is `documentation/spec.md` (the rebuild spec).
The design is in `documentation/low_level_plan.md` and `documentation/framework_choice.md`.

## Commands
- `pnpm build`: Tailwind (inlined into pages), the client bundle `dist/public/app.<hash>.js`, `sw.js`, and `dist/server.mjs`
- `pnpm start`: `node dist/server.mjs` (PORT, default 3000; DATABASE_URL, default `file:./data/dev.db`). Migrates at boot.
- `pnpm test`: Vitest (forks, single fork). `pnpm lint` is `tsc --noEmit`.
- `./scripts/restart.sh`: rebuild, start (or reuse) the `nr-redlib` Docker container on :8180 (with `REDLIB_ENABLE_RSS=on`), then serve on :3100 against `/tmp/nr-dev.db` with `REDLIB_URL` set. `docker rm -f nr-redlib` applies changed Redlib settings. The server inherits `YOUTUBE_API_KEY` from the shell.
- `node scripts/e2e.mjs [db]`: browser pass over every UI flow on a copy of a DB. `node scripts/ui-check.mjs`: screenshots and timings.
- `scripts/bench/`: the framework benchmark harness (see its README).
- Deploy (Fly): the image bundles the Redlib binary and sharp (its Linux binary only); `scripts/fly-start.sh` runs Redlib on 127.0.0.1:8080 and then the server. `fly.toml` `[env]` has `REDLIB_URL`, `REDLIB_ENABLE_RSS=on` and Redlib's defaults. `YOUTUBE_API_KEY` is a Fly secret, never in `fly.toml`.
- With a broken `NODE_OPTIONS` preload in the shell, prefix commands with `unset NODE_OPTIONS;`.

## Architecture
- **Server:** Hono (`src/app.ts`) has the CSP on every response (except proxied Redlib pages, which keep their own), an in-memory static server (brotli/gzip once per file),
  and brotli/gzip for HTML and JSON. JSON API routes are in `src/api/*`. HTML routes are in `src/pages.tsx`, with views in `src/views/*` (hono/jsx).
- **DB:** better-sqlite3 with raw SQL (`src/db.ts`). The schema matches the old Prisma one, and dates are integer ms. Reads shared by the API and pages
  are in `src/lib/queries.ts`. Saved and hidden URLs are excluded **inside the SQL** (`NOT IN (SELECT url …)`). Keep it there.
- **"Primary topic"** is the lowest topic slug (FeedTopic PK order). It drives Save, the border color, the badge and topic balance.
- **Client** (`client/app.ts`, plus `client/youtube.ts` bundled into the same script; the only browser JS):
  - It swaps `#app` with `X-Partial: 1` fragments from a view cache (fresh for 30 s; `invalidate()` mirrors the
    old React Query keys) and prefetches on `pointerdown`.
  - Save, Hide and saved-link Delete are optimistic: the card leaves on tap and comes back on error.
  - Sort is client state. It is kept across pill changes on `/` and reset when `/` is entered from another page. It never goes in the URL.
  - YouTube (`client/youtube.ts`): one player at a time, normally one IFrame-API player laid over the playing
    card's box and switched with `loadVideoById` (per-card iframes are the fallback). Autoplay picks the most
    centered box once scrolling settles; view loads hold it (`holdAutoplay`). Never set a Referrer-Policy that
    drops the Referer: YouTube's player needs it.
- **Service worker** (`client/sw.ts`): stale-while-revalidate for top-level loads of `/`, `/saved` and `/manage` (never frame navigations, so a Redlib page in the sheet that reaches `/` hits the server's redirect); cache-first for hashed assets.
  Pages carry `data-rendered`. The client revalidates a page that is older than 5 s.
  Pages carry `data-build` (CSS + JS hash) and page/partial responses send `X-Build`. On a mismatch the client drops
  the cached pages and reloads once, so a page cached before a deploy never runs new markup with old JS.
- **Refresh** is manual only (`POST /api/feed-items/refresh`); REDDIT feeds go one at a time, and a YOUTUBE refresh may start a detached archive fill. rss-parser is imported lazily to keep it off the cold path.
- **Reddit (Redlib):** subreddit feeds (sourceKind REDDIT) are refreshed from a self-hosted Redlib (`src/redlib.ts` proxies it
  same-origin): its RSS output for text and every image/video, its HTML listing for link, score and comments
  (`src/lib/reddit-feeds.ts`), stored as normal cards with `FeedItem.media` (JSON). Card images go through `/_img/…`
  (`src/image-cache.ts`: shrunk to 1080px WebP, cached on disk). A post or its subreddit opens on tap in one sheet outside
  `#app` (a fresh frame per open). `REDLIB_URL` unset: REDDIT refreshes fail and the sheet is off. See spec §7.1.
- **YouTube:** one feed per channel (sourceKind YOUTUBE, stored as `https://www.youtube.com/channel/UC…`) with two
  sources: its RSS feed (Recent, 15 newest; Shorts are `/shorts/` links) and an archive, the `YouTubeVideo` table
  (`src/lib/youtube-archive.ts`), which every RSS video joins and which a one-time background fill per channel pages
  through the Data API (`src/lib/youtube-api.ts`). Each refresh makes at most 15 posts, replacing the last batch: up
  to 4 RSS videos from the past 30 days and never-shown-first archive picks for the rest, 75% from the channel's top
  half by views (`YouTubeVideo.viewCount`, from RSS or one `videos.list` pass per video; uncounted videos only fill
  gaps). A refresh never calls the API; `YOUTUBE_API_KEY` (a Fly secret) is used for handle lookups, fills and view
  counts only. Never put a request URL in an error or log: it carries the key. See spec §7.2.

## Conventions
- API errors use `fail(c, message, code, status)` and the `{ error: { message, code } }` envelope. Validate with the Zod schemas in `src/lib/validations.ts`.
- Feed links are rendered through `safeHref` (only http(s) links are clickable). Keep that guard on any new link output.
- Keep card markup short (semantic classes in `src/styles.css`), because a Hot or Shuffle page renders up to 300 cards.
