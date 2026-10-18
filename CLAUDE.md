# CLAUDE.md

not-brainrot: personal RSS aggregator (iPhone home-screen PWA). The behavior spec is `documentation/spec.md` (the rebuild spec).
The design is in `documentation/low_level_plan.md` and `documentation/framework_choice.md`.

## Commands
- `pnpm build`: Tailwind (inlined into pages), the client bundle `dist/public/app.<hash>.js`, `sw.js`, and `dist/server.mjs`
- `pnpm start`: `node dist/server.mjs` (PORT, default 3000; DATABASE_URL, default `file:./data/dev.db`). Migrates at boot.
- `pnpm test`: Vitest (forks, single fork). `pnpm lint` is `tsc --noEmit`.
- `./scripts/restart.sh`: rebuild, then serve on :3100 against `/tmp/nr-dev.db`.
- `node scripts/e2e.mjs [db]`: browser pass over every UI flow on a copy of a DB. `node scripts/ui-check.mjs`: screenshots and timings.
- `scripts/bench/`: the framework benchmark harness (see its README).
- With a broken `NODE_OPTIONS` preload in the shell, prefix commands with `unset NODE_OPTIONS;`.

## Architecture
- **Server:** Hono (`src/app.ts`) has the CSP on every response, an in-memory static server (brotli/gzip once per file),
  and brotli/gzip for HTML and JSON. JSON API routes are in `src/api/*`. HTML routes are in `src/pages.tsx`, with views in `src/views/*` (hono/jsx).
- **DB:** better-sqlite3 with raw SQL (`src/db.ts`). The schema matches the old Prisma one, and dates are integer ms. Reads shared by the API and pages
  are in `src/lib/queries.ts`. Saved and hidden URLs are excluded **inside the SQL** (`NOT IN (SELECT url …)`). Keep it there.
- **"Primary topic"** is the lowest topic slug (FeedTopic PK order). It drives Save, the border color, the badge and topic balance.
- **Client** (`client/app.ts`, the only browser JS):
  - It swaps `#app` with `X-Partial: 1` fragments from a view cache (fresh for 30 s; `invalidate()` mirrors the
    old React Query keys) and prefetches on `pointerdown`.
  - Save, Hide and saved-link Delete are optimistic: the card leaves on tap and comes back on error.
  - Sort is client state. It is kept across pill changes on `/` and reset when `/` is entered from another page. It never goes in the URL.
  - View mode (`reels`, the default, or `tiles`) is `localStorage['nr-view']`. An inline head script applies it to `<html data-mode>`.
    Pages are mode-agnostic. The reels layout is CSS under `html[data-mode=reels]`, and the YouTube autoplay observer is attached in `hydrate()`.
  - Cards carry an 80-word summary excerpt (`data-more` marks cut ones). In reels the client loads the whole text from `/_f/summary/:id`; never inline full summaries, some are whole articles.
- **Service worker** (`client/sw.ts`): stale-while-revalidate for `/`, `/saved` and `/manage`; cache-first for hashed assets.
  Pages carry `data-rendered`. The client revalidates a page that is older than 5 s.
- **Refresh** is manual only (`POST /api/feed-items/refresh`). rss-parser is imported lazily to keep it off the cold path.

## Conventions
- API errors use `fail(c, message, code, status)` and the `{ error: { message, code } }` envelope. Validate with the Zod schemas in `src/lib/validations.ts`.
- Feed links are rendered through `safeHref` (only http(s) links are clickable). Keep that guard on any new link output.
- Keep card markup short (semantic classes in `src/styles.css`), because a page renders up to 100 cards.
