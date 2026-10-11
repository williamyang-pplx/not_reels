# Framework choice (spec §2.1)

**Decision: Hono on Node 22 with server-rendered HTML (hono/jsx), a hand-written vanilla-TS
client (4.5 KB gz), and better-sqlite3 with raw SQL. The server is bundled into one file by esbuild.**

## Shortlist

Ruled out on paper:

| Candidate | Why it lost before prototyping |
|---|---|
| Next.js (current) | Kept as the measured baseline. React + React Query alone is ~100 KB gz of JS. Prisma's engine adds cold-start time and memory. |
| React Router 7 / Remix | Ships the React runtime too, so it has the same JS floor as Next without its caching. No reason to expect it to beat SvelteKit. |
| SolidStart | Small runtime, but a younger SSR stack. On paper it lands near SvelteKit, so SvelteKit stood in for the "compiled framework" class. |
| Astro + islands | The feed page is almost all interactive (pills, sort, save/hide, infinite scroll), so islands would cover most of the page. It would end up a framework runtime plus Astro. |
| Vite SPA + Hono API | A blank page until JS loads and an API call returns. That is the same first-paint problem the Next app has (LCP 3.2 s). |
| HTMX + Hono | The right shape (server HTML, swap fragments), but htmx.min.js is ~14 KB gz for the few behaviors we need. The final design is this idea with ~4.5 KB of purpose-built JS instead. |

Finalists prototyped: **Next 14 (reference app as-is)**, **SvelteKit (adapter-node)**, and
**Hono + SSR + vanilla JS** (this repo).

## Results

Harness: `scripts/bench` (see its README). Page is `/?type=FORUM`, ~130 seeded items. Docker runs with
`--memory 512m --cpus 1`. Lighthouse uses mobile simulated throttling (Moto G, slow 4G). Pill and Hide timings
use 4× CPU throttling. Values are medians.

| | Next 14 | SvelteKit | **Hono + SSR** |
|---|---|---|---|
| Cold start → first byte | 763 ms (463 without boot migrate) | 194 ms | **184 ms** |
| Container + Node floor (same image, bare `http.createServer`) | 148 ms | 137 ms | 129 ms |
| Warm TTFB | 11 ms | 3.2 ms | 3.7 ms |
| JS on first load (gz) | 119 KB | 37.6 KB | **4.5 KB** |
| HTML + CSS + JS (gz) | 127 KB | 61.7 KB | **18.9 KB** |
| LCP (Lighthouse mobile) | 3166 ms | 1656 ms | **1204 ms** |
| TBT (INP proxy) | 0 | 0 | 0 |
| Lighthouse perf score | 93 | 99 | **100** |
| Pill tap → list updated (cached / uncached) | 45 / 41 ms | 38 / 34 ms | **19 / 33 ms** |
| Pill tap, uncached, +150 ms RTT | 337 ms | 170 ms | **166 ms** |
| Hide → card removed | 40 ms | 32 ms | **15 ms** |
| Hide, +150 ms RTT | 324 ms | 164 ms | **14 ms** (optimistic) |
| Peak memory (docker stats / process RSS) | 122 / 251 MB | 98 / 84 MB | **39–47 / 87 MB** |

Caveats:
- Cold starts were measured on OrbStack, not on a Fly machine. Compare each app against its floor, not as absolute numbers.
  Our app adds ~55 ms over a bare Node server. That time is module evaluation plus the first JIT-cold render.
- The SvelteKit prototype is feed-page-only, with a simplified Hot sort. The Hono numbers are for the full app.

## Why Hono + SSR wins here

1. **The first paint has the data.** The list is in the first HTML response. Next renders "Loading…" and then fetches
   after hydration (2 round trips), which is most of its LCP gap.
2. **There is almost no JS to download, parse or hydrate.** The client is one 4.5 KB gz file with event delegation and no framework.
3. **View switches are an HTML fragment swap.** A pill tap fetches `X-Partial` HTML. The fetch starts on `pointerdown`, before the click
   fires, and lands in a small view cache that mirrors React Query's 30 s staleTime. Cached views and the
   idle-prefetched sibling type views swap in about 1 frame.
4. **Cold start is close to the Node floor.** There is no Prisma engine. The server is one ~160 KB ESM file, and
   rss-parser/xml2js load lazily on the first refresh.
5. **A service worker hides the Fly cold start.** It caches the three HTML routes stale-while-revalidate, so the
   home-screen app opens from cache in ~25 ms even while the stopped machine boots. The page then swaps in fresh HTML.

What we kept unchanged, as §2.1 step 4 asks: the SQLite schema (same tables and columns, and Prisma's integer-ms dates), the
API contract (§4), the refresh pipeline (§5), and the recommender (§6). Prisma itself was replaced (see
`low_level_plan.md` → Deviations), because the analysis showed it was a cold-start and memory cost.

> Spec §2.1 step 3 says to stop and show this table before building the full app. The user told this run not
> to stop for approval, so the full app was built on this decision.
