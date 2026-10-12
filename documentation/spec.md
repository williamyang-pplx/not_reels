# Rebuild Spec: not-reels

This spec describes every feature of the current app, front end and back end, so that an agent can rebuild it from scratch. It describes the behavior of the code as it is now. Where `CLAUDE.md` or `documentation/technical_design.md` disagree with this spec, this spec is correct.

---

## 1. Product summary

not-reels is a personal RSS aggregator for one user. There are no accounts and no auth. The main target is an iPhone home-screen PWA, so the UI must be compact and dark.

- The user registers **feeds**. Each feed has a **type** (`FORUM` or `BLOG`) and one or more user-defined **topics**.
- A feed is either a remote **RSS/Atom** URL or a **local provider** (`local/<provider_id>`). The only local provider is `rym_music_recs`, which samples album recommendations from a bundled SQLite DB.
- The main page shows one stream of feed items, filtered by type and topic. It has three sort modes: Hot, New and Random.
- The user can **Save** an item, which moves it to the Saved list, or **Hide** it, which removes it permanently. Saved and hidden URLs never show in the main stream.
- The user can also add saved links by hand.
- Refresh is **manual only**. There is no cron or scheduler.

## 2. Stack

### 2.1 Step 0: choose the framework for front-end speed and latency
Do **not** assume that you must keep the current stack (§2.2). Before you write feature code, compare candidate frameworks and choose the one that gives the fastest experience on an iPhone. Behavior must not change: every feature in §3–§9 must work the same way. Read the Next/React-specific details in this spec (React Query keys, `next.config.js`, `@next/third-parties`, route handlers) as descriptions of behavior to port. They are not requirements.

**Runtime limits** (they apply to every framework, and they change which option wins):
- Fly.io: 1 shared CPU, 512MB RAM, `auto_stop_machines` and `min_machines_running = 0`. **Cold start is part of the user's latency.** Measure the time from process start to the first byte.
- SQLite is a file on the `/data` volume. There is one machine and no edge replicas, so "edge" frameworks don't help with data latency.
- The main use is an iPhone home-screen PWA on a mobile network. A small JS payload and fast first paint matter more than desktop throughput.
- You must keep: the YouTube lite embed, the Reddit iframe embed, the CSP (§9.3), the PWA manifest and the Apple meta tags (§9.2).

**Candidates to evaluate (at minimum):**
- Next.js (current version), with server components, streaming, and as little client JS as possible.
- React Router 7 / Remix.
- SvelteKit.
- SolidStart.
- Astro with islands, and a small API.
- A Vite SPA with a light API server (Hono or Fastify).
- A server-rendered HTMX app with a Hono or Go back end.

**Method:**
1. Build the same **feed page prototype** in each finalist. The prototype is the nav bar with type and topic pills, the Hot sort, and about 100 FeedCards from a seeded SQLite DB. Pick finalists by first ruling out the clearly weaker candidates on paper.
2. Measure each prototype:
   - Cold-start TTFB, in a 512MB container with the server started from zero.
   - Warm TTFB.
   - JS shipped on first load (gzipped).
   - LCP and INP with Lighthouse mobile throttling (Moto G / slow 4G profile) or WebPageTest on an iPhone profile.
   - The time from tapping a pill (type or topic) to the updated list.
   - The time for a Save or Hide to remove the card.
   - Peak server RSS memory.
3. Put the results in a short table with your recommendation in `documentation/framework_choice.md`. **Stop and show it to the user before you build the full app.**
4. Keep whatever does not depend on the framework unless the analysis shows that it is a bottleneck: SQLite, the schema (§3), the API contract (§4) if you keep a separate API, the refresh pipeline (§5), and the recommender (§6).

### 2.2 Current stack (reference)
- Next.js 14 App Router, React 18, TypeScript (strict). Path alias `@/*` points to the repo root.
- Tailwind CSS (dark palette in §9.1). The `Rambla` Google font (400/700, normal and italic) through `next/font/google`.
- Prisma 5 on SQLite. Zod for validation. TanStack React Query 5. `rss-parser`. `p-limit`.
- `@next/third-parties/google` `YouTubeEmbed` (lite-youtube) for video embeds.
- Vitest (`pool: 'forks'`, `singleFork: true`, timeout 20s). Tests use a real SQLite test DB at `prisma/test.db`. A setup file deletes it, runs `prisma migrate deploy` and seeds the default topics.
- pnpm. Deployed to Fly.io through Docker (§11).
- `next.config.js`: put `@prisma/client`, `rss-parser` and `xml2js` in `experimental.serverComponentsExternalPackages`. Keep these packages out of client components.

### Assets to carry over unchanged (you cannot regenerate them)
- `data/rym_data.db`: the SQLite album DB (about 3,900 albums). It must stay tracked in git: `.gitignore` ignores `*.db` but has `!data/rym_data.db`.
- `data/rym_music_prefs.json`: genre and decade weights.
- `public/youtube_music_icon.png`, `public/icons/galaxy.png`, `public/icons/icon-192.png`, `public/icons/icon-512.png`, `app/icon.png`, `app/favicon.ico`.

## 3. Data model (Prisma, SQLite)

```prisma
model Topic {
  slug      String      @id            // e.g. "TECHNOLOGY"; regex ^[A-Z0-9_]+$, 1–50 chars
  label     String                     // display name, 1–50 chars
  createdAt DateTime    @default(now())
  feeds     FeedTopic[]
}

model Feed {
  id              String      @id @default(cuid())
  name            String
  url             String      @unique   // http(s) URL or "local/<provider_id>"
  sourceKind      String      @default("RSS")   // "RSS" | "LOCAL" (inferred from url)
  type            String                // "FORUM" | "BLOG" (plain string column)
  isActive        Boolean     @default(true)
  fetchErrorCount Int         @default(0)
  lastFetched     DateTime?
  createdAt       DateTime    @default(now())
  updatedAt       DateTime    @updatedAt
  items           FeedItem[]
  topics          FeedTopic[]
  @@index([type])
  @@index([sourceKind])
}

model FeedTopic {                        // many-to-many Feed <-> Topic
  feedId    String
  topicSlug String
  feed      Feed  @relation(fields: [feedId], references: [id], onDelete: Cascade)
  topic     Topic @relation(fields: [topicSlug], references: [slug], onDelete: Cascade)
  @@id([feedId, topicSlug])
  @@index([topicSlug])
}

model FeedItem {
  id          String   @id @default(cuid())
  feedId      String
  guid        String
  title       String
  link        String
  summary     String?
  author      String?
  publishedAt DateTime
  sourceRank  Int?                     // position in the source feed (0 = top); 10000 = stale
  fetchedAt   DateTime @default(now())
  feed        Feed     @relation(fields: [feedId], references: [id], onDelete: Cascade)
  @@unique([feedId, guid])
  @@index([feedId]) @@index([publishedAt]) @@index([feedId, publishedAt]) @@index([feedId, sourceRank])
}

model SavedLink {
  id        String   @id @default(cuid())
  url       String                     // NOT unique — duplicates allowed
  title     String
  topic     String                     // topic slug (no FK)
  notes     String?
  savedAt   DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@index([topic])
}

model HiddenLink {
  id       String   @id @default(cuid())
  url      String   @unique
  hiddenAt DateTime @default(now())
}
```

### Constants (`lib/constants.ts`)
| Name | Value |
|---|---|
| `FEED_TYPES` | `['FORUM','BLOG']` |
| `FEED_TYPE_LABELS` | `{ FORUM: 'Forum', BLOG: 'Blog' }` |
| `FEED_SOURCE_KINDS` | `['RSS','LOCAL']` |
| `LOCAL_FEED_PREFIX` | `'local/'` |
| `DEFAULT_TOPICS` | NEWS/News, MUSIC/Music, LITERATURE/Literature, TECHNOLOGY/Tech, SCIENCE/Science, CULTURE/Culture, POLITICS/Politics, OTHER/Other (in this order) |
| `PAGE_SIZE_DEFAULT` / `PAGE_SIZE_MAX` | 100 / 100 |
| `RELEVANT_FETCH_SIZE` | 200 (candidate pool for Hot and Random) |
| `MAX_ITEMS_PER_FEED` | 15 |
| `FETCH_ERROR_THRESHOLD` | 5 |
| `FETCH_CONCURRENCY` | 6 |

### Default topic seeding
`ensureDefaultTopics()` inserts `DEFAULT_TOPICS` only if the Topic table is empty. It runs on every `GET /api/topics`, so if the user deletes all topics, the defaults come back on the next load.

## 4. API

All routes are `force-dynamic`. Routes that fetch or refresh feeds use `runtime = 'nodejs'`.

**Response envelope:**
- Success: `{ data: T }` (status 200, or 201 on create).
- Error: `{ error: { message, code } }`.

**Error codes:**
- `INVALID_JSON` (400)
- `VALIDATION_ERROR` (400). The message joins Zod issues as `path: message; path: message`.
- `DUPLICATE` (409)
- `NOT_FOUND` (404)
- `CONSTRAINT` (409)

Build shared helpers `ok(data, status)`, `fail(message, code, status)`, `parseJson(req, schema)` and `parseQuery(url, schema)`.

### 4.1 Validation schemas (Zod, one source of truth)
- `TopicSchema`: string, 1–50 chars, `/^[A-Z0-9_]+$/`, message `"Topic slug must be uppercase letters, digits, or underscores"`.
- `FeedUrlSchema`: trimmed, non-empty.
  - If it starts with `local/`: the provider id must match `/^[a-z0-9_]+$/` (else `"Local feed URL must use local/<provider_id>"`), and it must be a registered provider (else `"Unknown local feed provider"`).
  - Otherwise it must be a valid URL (else `"Invalid feed URL"`).
- `CreateFeedSchema`: `{ name: 1–100, url: FeedUrlSchema, type: FORUM|BLOG, topics: TopicSlug[1..10] }`.
- `UpdateFeedSchema`: `{ name?, topics?: [1..10], isActive?: boolean }`.
- `CreateTopicSchema`: `{ slug: TopicSchema, label: 1–50 }`.
- `CreateSavedLinkSchema`: `{ url: url, title: 1–200, topic: TopicSchema, notes?: ≤1000 }`.
- `UpdateSavedLinkSchema`: `{ title?, topic?, notes? }`.
- `RefreshBodySchema`: `{ feedId?: string }`.

### 4.2 Topics
- **`GET /api/topics`**: seeds the defaults if the table is empty. Returns all topics ordered by `createdAt asc`: `[{slug,label,createdAt}]`.
- **`POST /api/topics`** `{slug,label}`: returns 409 `DUPLICATE` `"Topic already exists"` if the slug exists. Otherwise returns 201 with the topic.
- **`DELETE /api/topics/:slug`**:
  - 404 if the topic is missing.
  - A feed is "orphaned" if this topic is its *only* topic. If any feed would be orphaned, the route returns 409 `CONSTRAINT` with the message `"Cannot delete topic — these feeds would have no topic: <names>. Reassign them first."`.
  - Otherwise, in one transaction, it deletes all SavedLinks whose `topic` equals the slug, then deletes the Topic. The FeedTopic rows cascade.
  - Returns `{ slug, deletedSavedLinks }`.

### 4.3 Feeds
- **`GET /api/feeds?type=&topic=`**:
  - Optional `type` filter (validated).
  - Optional `topic` filter (`ALL` means no filter). Matches feeds that have that topic.
  - Ordered by `createdAt desc`.
  - Each feed is returned with `topics: string[]` (flattened slugs).
- **`POST /api/feeds`**:
  1. Validate the body.
  2. If the URL exists, return 409 `DUPLICATE` `"Feed URL already exists"`.
  3. If any topic slug is unknown, return 400 `"Unknown topic: X"` or `"Unknown topics: X, Y"`.
  4. Create the feed with `sourceKind` inferred: `LOCAL` if the URL parses as a local feed URL, else `RSS`. Create the FeedTopic rows.
  5. **Run one refresh of this feed synchronously before responding.** It is best-effort; errors are only logged.
  6. Re-read the feed and return 201 with the flattened feed. It reflects `lastFetched` and `fetchErrorCount`.
- **`PATCH /api/feeds/:id`** `{name?, topics?, isActive?}`:
  - 404 if the feed is missing. Unknown topics give a 400 with the same message as POST.
  - In one transaction: update the scalar fields if any. If `topics` is given, delete all FeedTopic rows for the feed and recreate them.
  - Returns the flattened feed.
  - Setting `isActive` does **not** reset `fetchErrorCount`.
- **`DELETE /api/feeds/:id`**: 404 if missing. Deletes the feed (items and FeedTopic rows cascade). Returns `{id}`.

### 4.4 Feed items
**`GET /api/feed-items?type=&topic=&sort=&cursor=&limit=`**
- `sort` is one of `recommended` (default), `new`, `random`. Any other value gives 400 `"Invalid sort"`.
- `limit` is parsed as an int. If it is under 1 or NaN, return 400 `"Invalid limit"`. Values above 100 are capped to 100. The default is 100.
- `type=SAVED` returns `{ items: [], nextCursor: null }` right away.
- Base filter:
  - `feed.isActive = true`.
  - `feed.type = type` if `type` is given (validated).
  - The feed has topic `topic` if `topic` is given and is not `ALL` (validated).
- **Exclusion:** load all `SavedLink.url` and `HiddenLink.url`. Add `link NOT IN (...)` **to the DB query**. Do not filter these out in memory.
- **`recommended` (shown as "Hot"):**
  1. Fetch up to 200 items ordered by `sourceRank asc, publishedAt desc`.
  2. Give each item a "primary topic": the first entry of its feed's topics. In practice that is the lowest slug alphabetically, because the join rows come back in PK order.
  3. Run the recommender (§6). Pass `topicCounts` (the number of SavedLinks per topic). Set `applyTopicBalance = true` only when no topic filter is set or the filter is `ALL`.
  4. Slice to `limit`. `nextCursor` is always `null`.
- **`random`:** fetch the 200 most recent items (`publishedAt desc`), shuffle them with Fisher–Yates, slice to `limit`. `nextCursor` is always `null`.
- **`new`:**
  - If `cursor` is given (ISO datetime; invalid gives 400 `"Invalid cursor"`), add `publishedAt < cursor`.
  - Fetch `limit+1` items ordered by `publishedAt desc`.
  - If there are more than `limit` items, `nextCursor` is the last returned item's `publishedAt` as an ISO string.
- **Item shape:** `{ id, feedId, guid, title, link, summary, author, publishedAt (ISO), feedName, feedUrl, feedType, feedTopics: string[] }`.

**`POST /api/feed-items/refresh`** `{feedId?}`
- With `feedId`: 404 `"Feed not found"` if missing. Otherwise call `refreshSingleFeed`. This runs even if the feed is inactive. Returns `{ refreshed: 0|1, newItems, failed: 0|1 }`.
- Without `feedId`: call `refreshAllFeeds()` and return `{ refreshed, newItems, failed }`.

### 4.5 Saved links
- **`GET /api/saved-links?topic=`**: optional topic filter (`ALL` means none). Ordered by `savedAt desc`.
- **`POST /api/saved-links`** `{url,title,topic,notes?}`: unknown topic gives 400 `"Unknown topic"`. Creates the link (duplicate URLs are allowed) and returns 201.
- **`PATCH /api/saved-links/:id`** `{title?,topic?,notes?}`: 404 if missing; unknown topic gives 400. Returns the updated link. *(There is no UI for this yet.)*
- **`DELETE /api/saved-links/:id`**: 404 if missing. Returns `{id}`.

### 4.6 Hidden links
- **`POST /api/hidden-links`** `{url}` (must be a valid URL): upserts by URL, so it is idempotent. Returns 201 with the record.
- **`DELETE /api/hidden-links?url=...`**: missing `url` gives 400 `"Missing url"`. Uses `deleteMany` on the URL, so it never 404s. Returns `{url}`. *(There is no UI to unhide yet.)*

## 5. Feed refresh pipeline

### 5.1 `refreshAllFeeds()`
1. Run `refreshFeeds('FORUM')` and `refreshFeeds('BLOG')` in parallel, then sum the results.
2. `refreshFeeds(type)` loads the **active** feeds of that type. It refreshes each one through `refreshSingleFeed`, with a `p-limit(FETCH_CONCURRENCY=6)` limiter per type.
3. For the result: `refreshed` counts successes, `failed` counts failures, and `newItems` is the sum of `newItems`.

Make the fetcher, the local provider registry and the concurrency injectable through an options object, so tests can stub them.

### 5.2 `refreshSingleFeed(feedId)`
1. Load the feed. If it is missing, return `{newItems:0, ok:false}`.
2. Get normalized items:
   - **LOCAL:** parse the provider id from the URL and look up the provider; throw if either is invalid. Call `provider({ feed: {id,name,url,sourceKind,type}, now })`, then run `normalizeLocalFeedItems` on the result (§5.5).
   - **RSS:** call `fetcher(url)` and normalize all items (§5.4). `sourceRank` is the item's index in the feed.
   - Any other `sourceKind` throws.
3. **Upsert:**
   - For each item, upsert on `(feedId, guid)`. On create, set all fields. On update, overwrite title, link, summary, author, publishedAt and sourceRank. Count only the rows that are actually new.
   - Then set `sourceRank = 10000` on every item in this feed whose guid was **not** in this fetch. These are "stale" items.
4. Set `lastFetched = now` and `fetchErrorCount = 0`.
5. **Prune:** keep the top N items ordered by `sourceRank asc, publishedAt desc` and delete the rest. N is **30** for the feed with URL `local/rym_music_recs` and **15** for all other feeds.
6. Return `{newItems, ok:true}`.
7. **If any step throws:** increment `fetchErrorCount`. If it reaches 5 or more, set `isActive=false`. Log `[feed-refresh] failed feed=<id> url=<url>:` and the error. Return `{newItems:0, ok:false}`.

### 5.3 Default RSS fetcher
- Uses `fetch` with redirects followed and a **10s timeout** through `AbortController`.
- Request headers:
  - `User-Agent: not-reels/1.0 (RSS reader; +https://github.com/williamyang-pplx/not_reels)`
  - `Accept: application/rss+xml, application/atom+xml, application/xml, text/xml, */*`
- A non-2xx response throws `Status code <n>`.
- The body is parsed with `rss-parser.parseString`. Custom item fields: `media:content` becomes `mediaContent`, and `content:encoded` becomes `contentEncoded`.

### 5.4 RSS item normalization
| Field | Rule |
|---|---|
| `guid` | the first non-empty trimmed value of `guid` or `link`. If both are empty, use the sha256 hex of `` `${title}|${isoDate ?? pubDate ?? ''}` `` |
| `title` | trimmed `title`, or `"(untitled)"` |
| `link` | trimmed `link`, or `""` |
| `summary` | the first defined value of `contentSnippet`, `content`, `contentEncoded`; trimmed; empty becomes null |
| `author` | `creator` if defined, else `author`; trimmed; empty becomes null |
| `publishedAt` | parse `isoDate ?? pubDate`. If it is missing or invalid, use `now` |
| `sourceRank` | the item's index in the source feed |

### 5.5 Local providers
- **Registry:** `{ rym_music_recs: rymMusicRecsProvider }`.
- **Helpers:**
  - `parseLocalFeedUrl(url)` returns the provider id, or null if the URL does not start with `local/` or the id fails `/^[a-z0-9_]+$/`.
  - `inferFeedSourceKind(url)` returns `LOCAL` or `RSS`.
  - `hasLocalFeedProvider(id)` checks the registry with an own-property check.
  - `getLocalFeedProvider(id)` returns the provider or null.
- **Provider contract:** `(ctx: { feed, now }) => Promise<Item[]> | Item[]`, where an Item is `{ guid, title, link, summary?, author?, publishedAt?: Date|string|null, sourceRank?: int≥0|null }`.
- **`normalizeLocalFeedItems`:**
  - Validates the items with Zod: guid and title trimmed and non-empty, link a valid URL, sourceRank an int ≥ 0.
  - Trims summary and author; empty becomes null.
  - If `publishedAt` is null or missing, it becomes `now`. An invalid date **throws** `"Local feed item has invalid publishedAt"`.
  - `sourceRank` defaults to the item's index when it is `undefined`. An explicit `null` stays null.

### 5.6 `rym_music_recs` provider
- **Inputs:**
  - The album DB at `process.env.RYM_MUSIC_RECS_DB_PATH ?? <cwd>/data/rym_data.db`.
  - The prefs at `process.env.RYM_MUSIC_RECS_PREFS_PATH ?? <cwd>/data/rym_music_prefs.json`.
- **Reading the DB:**
  - It shells out to the `sqlite3` CLI: `sqlite3 -readonly -json <db> "<query>"` with `maxBuffer` 16MB.
  - Query: `SELECT id, title, artist, release_date, rating, primary_genres, broad_genres FROM albums WHERE title, artist, release_date and broad_genres are all NOT NULL`.
  - The production image must install `sqlite3`.
- **Album table schema:** `albums(id INTEGER PK AUTOINCREMENT, title, artist, release_date TEXT like "16 June 1997", primary_genres CSV, secondary_genres CSV, descriptors CSV, rating TEXT like "4.30", broad_genres CSV, UNIQUE(title, artist))`.
- **Prefs JSON:** `{ decades: { "1960": 0..1, … }, genres: { "<broad genre>": 0..1, … } }`. Values are clamped to [0,1]; non-numbers become 0.
- **Algorithm:**
  1. Load the prefs, all album rows, and the existing guids for this feed, in parallel.
  2. Drop albums whose guid `rym-album-<id>` already exists in this feed.
  3. Score each album:
     - The decade comes from the first 4-digit year (1800–2099) in `release_date`, floored to the decade.
     - The genres are `broad_genres` split on commas.
     - `weight = decadeWeight × mean(genreWeights)`. A missing key counts as 0.
     - Drop albums with no decade, no genres, or weight ≤ 0.
  4. Draw **30** albums by weighted random sampling without replacement.
  5. Map each album to an item:
     - `guid`: `rym-album-<id>`
     - `title`: album title
     - `author`: artist
     - `link`: `https://rateyourmusic.com/search?searchterm=<encodeURIComponent("artist title")>`
     - `summary`: `"<primary_genres joined ', ' (or broad genres if none)> | <release_date> | RYM <rating>"`. Leave out empty parts.
     - `publishedAt`: `now`
     - `sourceRank`: sample index
- **Net effect:** each refresh adds 30 new albums at ranks 0–29. The previous albums go stale and are pruned, since the prune keeps 30. Each refresh therefore replaces the whole batch.

## 6. Recommendation ("Hot") algorithm (`lib/recommendation.ts`)

This is a pure function, `recommendItems(items, opts)`. Each item has `{id, feedId, publishedAt, sourceRank?, feed: {name, type, topic}}`.

- If there are 1 or fewer items, return them as they are.
- **Weights** (overridable): popularity 0.6, recency 0.15, topicAffinity 0.15, feedVelocity 0.1.
- **recency:** `exp(-ln2/halfLife × ageHours)`. `halfLife` is 72h for `BLOG` and 18h otherwise. `ageHours` is floored at 0.
- **popularity:** if `sourceRank` is a finite number ≥ 0, use `exp(-ln2/4 × sourceRank)`. Otherwise fall back to recency.
- **topicAffinity:** uses `topicCounts`, the number of saved links per topic.
  - If the total is 0, every topic gets 0.5.
  - Otherwise use the Laplace-smoothed share `(count+1)/(total + #uniqueTopicsInItems)`.
- **feedVelocity:** the number of candidate items from this feed divided by the largest per-feed count.
- **baseScore:** the weighted sum of the four scores.
- **Tie-break (`compareItems`):** `sourceRank asc` (null counts as +∞), then `publishedAt desc`, then `id` ascending.
- **If `applyTopicBalance` is false:** sort by baseScore desc, then use the tie-break.
- **Soft topic balance** (the default). Strength `0.25`, targetBlend `0.7`. If there are 2 or fewer items, just sort.
  - `observed[t]` is topic t's share of the candidates. `uniform` is `1/#topics`.
  - `target[t] = 0.7×observed[t] + 0.3×uniform`.
  - Greedy selection, one position at a time. For each remaining candidate:
    - `projectedShare = (selectedCount[t]+1)/position`
    - `adjusted = baseScore − 0.25×max(0, projectedShare − target[t])`
  - Pick the highest `adjusted`. Ties go to the earlier item under `compareItems`.

## 7. Embeds and URL helpers

- **`detectEmbedKind(link)`:**
  - Returns `youtube` for these hosts: `youtube.com`, `www.`, `m.`, `music.youtube.com`, `youtu.be`.
  - Returns `reddit` for these hosts: `reddit.com`, `www.`, `old.`, `new.`, `np.`, `m.`, `i.reddit.com`.
  - Returns null for anything else, including invalid URLs.
- **`extractYouTubeId`:**
  - The ID must match `/^[A-Za-z0-9_-]{11}$/`.
  - For `youtu.be`, take the first path segment.
  - Otherwise take the `?v=` value, then try `/shorts/<id>`, `/embed/<id>` and `/live/<id>`.
  - Return null on failure.
- **`extractRedditPost`:**
  - The path must be `/r/<sub>/comments/<id>/<slug?>`.
  - `sub` must match `^[A-Za-z0-9_]{2,21}$` and `id` must match `^[a-z0-9]{5,12}$`.
  - Returns `{subreddit, postId, slug}`.
- **`cleanUrl(url)`** (`lib/archive.ts`): removes the query string and the fragment.
- **`formatRelativeTime`:** `just now` (<60s), `Nm ago`, `Nh ago`, `Nd ago` (<30d), `Nmo ago` (<12mo, months = 30 days), `Ny ago`.
- **`truncate(str,max)`:** adds an ellipsis `…`. **`cn(...)`:** joins classes, skipping falsy ones.
- **Topic color:** a djb2-xor hash of the slug (`h=5381; h = ((h<<5)+h) ^ charCode`), then `hsl(|h|%360, 70%, 60%)`. The card border and the topic badge both use it. With no topic, the border is `hsl(220,10%,40%)`.

## 8. Front end

### 8.1 Routes
| Route | Page |
|---|---|
| `/?type=FORUM\|BLOG&topic=<slug>` | Feed stream. Defaults: `type=FORUM`, `topic=ALL` |
| `/saved?topic=<slug>` | Saved links |
| `/manage` | Topics and feeds management |

All pages are `force-dynamic`. The root layout wraps the page in the React Query provider, then the `NavBar` (inside `Suspense`; the fallback is an empty `h-24` bar with a bottom border), then `<main class="mx-auto max-w-2xl px-3 pb-10">`.

**React Query defaults:** `staleTime 30s`, `refetchOnWindowFocus false`, `retry 1`.

**Query keys:**
- `['topics']` (staleTime 60s, through the shared `useTopics()` hook)
- `['feeds']`
- `['feed-items', type, topic, sort]`
- `['saved-links', topic]`. Invalidate with the prefix `['saved-links']`.

### 8.2 NavBar (sticky, on every page)
- **Header:** sticky, `z-40`, translucent background with backdrop blur, bottom border. Top padding is `env(safe-area-inset-top)`.
- **Row 1:** the title link **"Not Reels"** (to `/`, `text-2xl` semibold) on the left. A **"Manage"** link (to `/manage`, small, muted) on the right.
- **Rows 2 and 3** show only on `/` and `/saved`.
  - **Type pills:** **Forums** (FORUM), **Blogs/Videos** (BLOG), **Saved** (SAVED). They are horizontally scrollable, with the scrollbar hidden. The active pill is filled with the primary color.
  - **Topic pills:** **All**, then every topic label in API order. The active pill uses the accent color.
- **Current state:**
  - The type is `SAVED` when the path is `/saved`. Otherwise it is the `type` param, defaulting to `FORUM`.
  - The topic is the `topic` param, defaulting to `ALL`.
- **Clicking a pill** changes only that dimension and keeps the other one. The type picks the path: SAVED goes to `/saved`, anything else goes to `/`. Query params: set `type` unless it is SAVED; set `topic` unless it is ALL. Navigate with `router.push`.

### 8.3 Feed page (`/`)
- **Toolbar** (one row):
  - **"Refresh feeds"** button (rounded-full outline). It shows "Refreshing…" and is disabled while pending. It calls `POST /api/feed-items/refresh {}`.
    - On success, the status text reads `Refreshed N · M new`, or `Refreshed N, M new, F failed` if any feed failed. Then it invalidates `['feed-items']`.
    - On error, the status text reads `Refresh failed`.
    - The status text clears when a new refresh starts.
  - **Sort segmented control:** **Hot** (`recommended`, the default), **New**, **Random**. This is local component state and is not in the URL.
  - The status text sits right-aligned and muted.
- **List:** uses `useInfiniteQuery`. `getNextPageParam` is `nextCursor`, so only New mode pages.
  - An `IntersectionObserver` watches a sentinel `div` (`h-8`) after the list. It calls `fetchNextPage` when the sentinel is visible, `hasNextPage` is true and nothing is fetching.
  - While fetching, it shows "Loading more…".
- **Empty, loading and error states** use a centered muted message: `Failed to load feed.`, `Loading…`, or `No items match these filters yet.`.

### 8.4 FeedCard (standard)
- **Container:** `rounded-lg border-2 bg-card p-4`, with the border color from the first feed topic (§7).
- **Link area:** the whole top section is an `<a target=_blank rel="noopener noreferrer">` to `item.link`. It contains:
  - Header row: the feed name (truncated, or `Unknown`) and the relative time.
  - The title.
  - The summary, cut to its **first 20 words** with `…` and also `line-clamp-2`.
- **Embeds** below the link area:
  - **YouTube:** a lite-youtube embed in an `aspect-video` box with `params="rel=0"` and the play label `Play: <title>`.
  - **Reddit:** an iframe of `https://www.redditmedia.com/r/<sub>/comments/<id>/<slug>/?ref_source=embed&ref=share&embed=true`, 500px tall, lazy-loaded. Its sandbox is `allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox`.
- **Badges:** the TopicBadge for the first topic and a TypeBadge.
- **Actions** (small text buttons):
  - **Save:** shown only if the item has at least one topic. It runs `POST /api/saved-links {url: link, title, topic: feedTopics[0]}`. The label goes "Saving…", then "Saved!", and the button stays disabled after success. On success it invalidates **both** `['feed-items']` and `['saved-links']`.
  - **Hide:** runs `POST /api/hidden-links {url: link}`. The label goes "Hiding…", then "Hidden", and the button stays disabled. On success it invalidates `['feed-items']`.
  - **archive.\*:** opens `https://archive.is/<encodeURIComponent(cleanUrl(link))>` in a new tab with `noopener,noreferrer`.
  - **press released:** copies `link` to the clipboard, then opens `https://pressreleased.alwaysdata.net/` in a new tab.
  - Mutation errors show inline in red.

### 8.5 FeedCard (RYM music rec variant)
An item uses this variant when `feedUrl === 'local/rym_music_recs'` or its guid starts with `rym-album-`.

- It uses the same container, border, badges, and Save and Hide buttons as the standard card.
- The link area holds: the feed name (fallback `Rate Your Music`) and the relative time; the **album title**; the **artist** on a muted line; then the genres, release date and rating on separate lines (date and rating muted).
- **Parsing:**
  - Album title: the item title with a leading `"<author> - "` removed if present.
  - The summary is split on `|` and trimmed. If the first part starts with `RYM`, the order is rating, date, genres. Otherwise it is genres, date, and then the rating (the part matching `/^RYM\b/i`, else the third part).
- **No embeds, no archive.\*, no press released.** Instead there is a **YouTube Music** link: `https://music.youtube.com/search?q=<album title words, each URI-encoded, joined with +>`, with the `/youtube_music_icon.png` icon at 16px. It searches by album title only.

### 8.6 Badges
- **TopicBadge:** a pill (`h-5`, 10px, uppercase, tracking-wide, black text) with the background from the topic color. It shows the slug, not the label.
- **TypeBadge:** a muted pill with a border, showing `Forum` or `Blog`.

### 8.7 Saved page (`/saved`)
- A **"+ Save link"** primary button opens the **Save a link** modal. The fields are:
  - URL (`type=url`, required)
  - Title (required)
  - Topic `<select>`, defaulting to the first topic. If there are no topics, it shows a disabled "No topics — add one in Manage" option.
  - Notes textarea (optional, 2 rows)
  - Buttons: Cancel and Save ("Saving…" while pending). On success, the form resets and the modal closes. An API error message shows inline.
- The list comes from `GET /api/saved-links?topic=`. The empty state reads `No saved links yet.`.
- **SavedLinkCard:**
  - Header row: the TopicBadge and the relative `savedAt` time on the right.
  - The title as an external link.
  - The notes, if any.
  - Actions: **Delete** (red, no confirm), **archive.\***, **press released** (both work the same as on FeedCard).
  - Creating or deleting a link invalidates `['saved-links']`.

### 8.8 Manage page (`/manage`)
1. **Topics section** (a card):
   - The header "Topics" and the topic count.
   - An inline form: a text input (placeholder `New topic (e.g. Gaming)`) and an **Add** button.
     - The slug comes from the label: uppercase it, replace each run of non-`[A-Z0-9]` characters with `_`, and trim leading and trailing `_`.
     - If the slug is empty, show the error `Label must contain letters or digits`.
     - API errors (for example a duplicate) show inline. On success, the input clears and `['topics']` is invalidated.
   - Topic chips (label plus a red **×**). Clicking × opens `window.confirm("Delete topic "<label>"? This will also delete all feeds and saved links under this topic.")`. If confirmed, it calls DELETE and invalidates topics, feeds, feed-items and saved-links.
2. **"+ Add feed"** button. It opens the **Add a feed** modal, which has:
   - Name (required)
   - URL (text, required, placeholder `https://example.com/rss.xml or local/rym_music_recs`)
   - A type `<select>` (Forum or Blog, default Forum)
   - A **TopicCheckboxList**
   - Buttons: Cancel and "Add feed" ("Adding…" while pending). Submit is disabled until at least one topic is checked, and it validates again on submit ("Pick at least one topic").
   - On success, the form resets, the modal closes and `['feeds']` is invalidated.
3. **The feed list.** The states are `Loading…` and `No feeds yet. Add your first one above.`. Each feed row (a card) shows:
   - The TypeBadge, a TopicBadge for **every** topic, and a red uppercase `paused` tag when the feed is inactive.
   - The name, and the URL (muted, `break-all`).
   - Buttons:
     - **Refresh:** `POST /api/feed-items/refresh {feedId}`. It is disabled when the feed is paused, and it invalidates nothing.
     - **Pause/Resume:** PATCH `isActive`, then invalidate feeds and feed-items.
     - **Edit:** opens the **Edit topics** modal. It shows the feed name, a TopicCheckboxList pre-filled with the feed's topics, and Save. At least one topic is required. Save runs PATCH `topics`, then invalidates feeds and feed-items.
     - **Delete:** red, **no confirm**. Runs DELETE, then invalidates feeds.

**Modal pattern** (shared by all modals):
- A full-screen `bg-black/60` overlay. The sheet sits at the bottom on mobile (`items-end`) and is centered on `sm` screens and up.
- Clicking the overlay closes the modal; clicks inside the form do not.
- The form is a card: `max-w-md`, `rounded-lg`, `p-4`, `gap-3`. Inputs are `h-10`.

**TopicCheckboxList:** a bordered box that scrolls past `max-h-40`. It has one checkbox row per topic, showing the label. With no topics, it shows "No topics — add one in Manage".

### 8.9 Test IDs (keep them for test parity)
- Layout and nav: `nav-bar`, `nav-manage-link`, `type-filter-row`, `type-pill-{FORUM|BLOG|SAVED}`, `topic-filter-row`, `topic-pill-{slug|ALL}`.
- Feed page: `feed-list`, `refresh-button`, `refresh-status`, `sort-{recommended|new|random}`, `sentinel`, `empty-state`.
- Feed cards: `feed-card`, `save-feed-item-btn`, `hide-feed-item-btn`, `archive-feed-item-btn`, `youtube-music-feed-item-link`.
- Saved page: `saved-link-card`, `saved-link-delete`, `add-saved-link-btn`, `add-saved-link-modal`.
- Manage page: `add-feed-btn`, `add-feed-modal`, `edit-feed-modal`, `feed-row`, `feed-pause-btn`, `feed-edit-btn`, `feed-delete-btn`, `topics-manager`, `topic-input`, `add-topic-btn`, `topic-chip`, `delete-topic-{slug}`, `topic-checkbox-{slug}`.

## 9. Visual design, PWA and security

### 9.1 Theme (Tailwind `extend.colors`)
| Token | Value |
|---|---|
| `background` | hsl(0 0% 4%) |
| `foreground` | hsl(0 0% 98%) |
| `card` | hsl(0 0% 7%) |
| `card-foreground` | hsl(0 0% 98%) |
| `muted` | hsl(0 0% 15%) |
| `muted-foreground` | hsl(0 0% 64%) |
| `border` | hsl(0 0% 18%) |
| `primary` | hsl(210 90% 56%) |
| `primary-foreground` | hsl(0 0% 100%) |
| `accent` | hsl(210 30% 20%) |
| `destructive` | hsl(0 70% 50%) |

Global CSS:
- `html` and `body` are `height: 100%` with `-webkit-tap-highlight-color: transparent`.
- A `.scrollbar-hide` utility hides scrollbars in WebKit, IE and Firefox.
- The body uses the Rambla font class.

### 9.2 PWA and metadata
- **Metadata:** title `not-reels`, description `Personal RSS feed compiler`, `manifest: /manifest.json`.
- **appleWebApp:** `capable: true`, `statusBarStyle: 'black-translucent'`, title `not-reels`. The apple icon is `/icons/galaxy.png`.
- **Viewport:** `themeColor #0a0a0a`, `width=device-width`, `initialScale 1`, `viewportFit cover`.
- **`public/manifest.json`:** name and short_name `not-reels`, `start_url /`, `display standalone`, background and theme color `#0a0a0a`, `orientation portrait`. Icons: 192, 512, and 512 maskable.

### 9.3 Content-Security-Policy (set on every path through `next.config.js` `headers()`)
```
default-src 'self';
script-src 'self' 'unsafe-inline' 'unsafe-eval' https://www.youtube.com https://www.youtube-nocookie.com https://s.ytimg.com https://cdn.jsdelivr.net;
style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net;
img-src 'self' data: https: blob:;
font-src 'self' data:;
connect-src 'self';
frame-src https://www.youtube.com https://www.youtube-nocookie.com https://www.redditmedia.com https://embed.reddit.com;
media-src 'self' https:
```

## 10. Environment
- `DATABASE_URL`: `file:./dev.db` locally (relative to `prisma/`). In production it is `file:///data/sqlite.db`.
- `RYM_MUSIC_RECS_DB_PATH` and `RYM_MUSIC_RECS_PREFS_PATH`: optional overrides.
- The `sqlite3` CLI must be on `PATH` (the RYM provider needs it).
- Scripts:
  - `dev`: `next dev`
  - `build`
  - `start`: `next start -H 0.0.0.0 -p 3000`
  - `lint`
  - `test`: `vitest run`
  - `test:watch`
  - `db:migrate`, `db:deploy`, `db:studio`, `db:generate`
- With pnpm, run `prisma generate` explicitly after install, because postinstall scripts may be skipped.

## 11. Deployment (Fly.io)
- **Dockerfile:**
  - Multi-stage on `node:22-slim`, with pnpm installed globally.
  - The build stage installs the build tools and `openssl`, runs `pnpm install --frozen-lockfile --prod=false` and `prisma generate`, copies the source, runs `next build --experimental-build-mode compile`, then `pnpm prune --prod`.
  - The runtime stage installs `ca-certificates`, `openssl` and **`sqlite3`**. It creates the `/data` volume, sets `DATABASE_URL=file:///data/sqlite.db` and `EXPOSE 3000`, and runs `CMD pnpm run start`.
- **`docker-entrypoint.js`:** if the command is `pnpm run start`, it first runs `pnpm exec prisma migrate deploy`, then runs the command.
- **`.dockerignore`:** `node_modules`, `.next`, `.env*`, logs, `prisma/dev.db*`, `prisma/test.db*`, `coverage`. Note that `data/rym_data.db` **is** included in the image.
- **`fly.toml`:**
  - App `not-reels`, region `ams`.
  - Mount `data` at `/data`, auto-extending (80% threshold, +1GB, up to 10GB).
  - HTTP service on internal port 3000 with `force_https`, auto stop and start, and `min_machines_running 0`.
  - VM: 1 CPU, 512MB.

## 12. Tests to reproduce
Write Vitest suites with the same coverage as these existing files:
- `validations`: each schema's accept and reject cases, including the local URL rules.
- `utils`: relative time buckets, truncate, cn.
- `embed`: YouTube and Reddit detection and ID extraction edge cases.
- `archive`: `cleanUrl` removes the query and fragment and keeps the path.
- `rss-fetcher`: the normalization fallbacks and guid hashing.
- `recommendation`: the scoring order, the topic-balance effect, and the deterministic tie-breaks.
- `feed-refresh`:
  - Inserts and dedupes.
  - Overwrites on update.
  - Marks stale items with rank 10000.
  - Prunes to 15, and to 30 for RYM.
  - Increments the error count and deactivates the feed at 5.
  - Resets the error count on success.
  - Skips inactive feeds.
  - Local provider items flow through.
- `rym-music-recs`: weighting, excluding existing guids, the summary and link format, and the env path overrides. Use a temp sqlite DB and a temp prefs file.
- API suites. Call the handlers in-process, without a network server. The current code imports Next route handlers and passes them `Request` objects; use the closest equivalent in the framework you choose:
  - feeds: CRUD, duplicate URL 409, unknown topics, the initial fetch on create, replacing topics.
  - feed-items: filters, saved and hidden exclusion, the three sort modes, cursor paging, limit validation.
  - refresh: all feeds versus one feed, and 404.
  - topics: seeding, create, duplicate, delete constraint 409, and the cascade delete of saved links.
  - saved-links: CRUD and the unknown-topic check.

## 13. Known quirks (copy them as they are unless told otherwise)
- The confirm text for deleting a topic says it "will also delete all feeds". In fact the server **refuses** with 409 if any feed would be left with no topic. It deletes only saved links that have that topic.
- The "primary topic" of an item (used for Save, the border color, the badge and topic balance) is the first FeedTopic row, which means the lowest slug alphabetically. It is not the first topic the user selected.
- Hot and Random never page (`nextCursor: null`), so you see at most 100 items.
- Feed-row Refresh on Manage does not invalidate any query. The UI does not show the result.
- Hiding an item does not invalidate `['saved-links']`. Saving invalidates both.
- There is no UI to edit saved links or to unhide hidden links, but the APIs exist.
- `fetchErrorCount` is not reset when the user resumes a feed by hand. A feed that was auto-deactivated at 5 errors will be deactivated again after one more failure.
- `CLAUDE.md` says `p-limit(4)` and "prune by publishedAt desc". The code uses concurrency 6 and prunes by `sourceRank asc, publishedAt desc`. This spec follows the code.
