# Feed-page benchmark harness

Measures a not-brainrot feed-page implementation for the framework decision (spec §2.1).
Every run uses a fresh copy of the same seeded SQLite DB.

## Setup

```sh
cd scripts/bench
pnpm install --ignore-workspace     # playwright-core + lighthouse; uses system Chrome
```

You need Docker, Node 22.5+ (for `node:sqlite`), and Google Chrome. The default Chrome path is
`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`. To use another path, set
`CHROME_PATH` or pass `--chrome`.

## Seed DB

```sh
node seed.mjs /tmp/bench.db [--migrations <dir>] [--no-prisma-table] [--now <ms>]
```

- The script applies `migrations/*/migration.sql` in order. These files are a copy of the
  reference repo's Prisma migrations, so the DB has the spec §3 schema.
- It also writes `_prisma_migrations` rows with Prisma's sha256 checksums, so
  `prisma migrate deploy` at boot does nothing. If the app does not use Prisma, pass
  `--no-prisma-table`. If the app has its own migrations, pass `--migrations <dir>`.
- The data is 8 default topics and 10 feeds (7 FORUM, 3 BLOG, some multi-topic).
  There are 132 items: 105 FORUM and 27 BLOG, with `sourceRank` from 0 to 14. All
  `publishedAt` values are in the last 3 days. Five items have YouTube links (3 of them
  FORUM). No items have Reddit links.
- The PRNG has a fixed seed. Only the timestamps depend on `--now`.

## Measure

```sh
node measure.mjs <name> <target> [options]
node measure.mjs --table          # markdown table of every results/*.json
```

`<target>` can be one of these:

| Target | What happens |
|---|---|
| `my-image:tag` | The harness runs `docker create --memory 512m --memory-swap 512m --cpus 1 -p 127.0.0.1:3900:3000 -v <tmpdir>:/data -e DATABASE_URL=file:///data/sqlite.db`. |
| `cmd:<shell command>` | The harness runs the command locally with `PORT=3900` and `DATABASE_URL=file://<tmp db>`. RSS is the sum over the process tree. |
| `http://host:port` | The server is already running. Cold start and memory are skipped, and the server's own DB is used (the Hide test removes 5 items). |

Each run measures the following. The page is `--path`, which defaults to `/?type=FORUM`.

| Metric | How |
|---|---|
| Cold TTFB | The container already exists. Time runs from spawning `docker start` to the first response byte with status <400. A node `http.get` loop polls every 10 ms. There is 1 priming start (not counted), then 5 measured starts with `docker kill` between them. The result is the median. |
| Cold floor | The same as Cold TTFB, but for a bare `node -e http.createServer` in the **same image** with the same limits. It shows how much is Docker/Node overhead. Skip it with `--no-floor`. |
| Warm TTFB | 10 warm-up requests, then the median of 30 sequential requests. Each request uses a new connection and sends `accept-encoding: gzip`. |
| JS gz | Chrome (playwright-core) loads the page until network idle. The harness gzips (level 9) the body of every script response and adds them up. It reports first-party and third-party JS separately. HTML+CSS+JS is the same sum over document, stylesheet and script responses. |
| LCP / TBT | Lighthouse with `--only-categories=performance --form-factor=mobile --throttling-method=simulate` (Moto G, slow 4G). The result is the median of 3 runs. TBT stands in for INP. |
| Pill→list | Viewport 390x844, 4x CPU throttle (CDP), no network throttle. A capture listener records the click time. The end is the first frame after the URL has the new topic and the `feed-card` list has changed (count or first card text). The harness alternates `topic-pill-TECHNOLOGY` and `ALL` 5 times (if TECHNOLOGY is missing, it uses the second pill) and reports the median. Client caches can serve the repeat visits. |
| Pill (uncached) | The same measurement, but each click goes to a topic this page has not visited yet: TECHNOLOGY, NEWS, SCIENCE, CULTURE, POLITICS. |
| Hide→removed | The harness clicks `hide-feed-item-btn` on the first card. The end is the first frame after that card is detached or is no longer the first card. The result is the median of 5. |
| Peak memory | The harness reads the Docker API every 200 ms during the whole run. `peakUsageMb` is the same figure as `docker stats` MEM USAGE (cgroup usage minus inactive_file). `peakRssMb` is the sum of process RSS from `docker top`. |

Options that you will usually need:

- `--container-port 3000` and `--data-dir /data` set where the app listens and where it
  expects `sqlite.db`.
- `--env K=V` adds environment variables. You can use it more than once.
- `--cmd "<args>"` replaces the image CMD. For example, `--cmd "pnpm exec next start -H 0.0.0.0 -p 3000"`
  skips the reference app's boot-time `prisma migrate deploy`.
- `--seed-arg --no-prisma-table` passes arguments through to the seeder.
- `--skip cold,warm,js,lighthouse,pill,pillfresh,hide` skips phases.
- `--rtt 150` adds request latency to the pill and hide timings. Use it to see the cost of
  network round trips.
- `--cold-runs`, `--warm-runs`, `--lh-runs`, `--click-runs` and `--cpu-throttle` change the
  run counts and the CPU slowdown.

The harness writes the results to `results/<name>.json` and prints a table row. Phases that
fail are listed in `notes`, and the run continues.

### Measure the Hono app (repo root)

The app needs these things:

- A Dockerfile.
- It listens on port 3000.
- It reads `DATABASE_URL=file:///data/sqlite.db`.
- It renders `/?type=FORUM` with the spec §8.9 test IDs (`feed-list`, `feed-card`,
  `topic-pill-*`, `hide-feed-item-btn`).

```sh
docker build -t nr-hono /path/to/not_brainrot
cd scripts/bench
node measure.mjs hono nr-hono                    # add --seed-arg --no-prisma-table if it does not use Prisma
node measure.mjs hono-rtt150 nr-hono --rtt 150 --skip cold,warm,js,lighthouse --no-floor
node measure.mjs --table
```

## Notes

- The container runs as whatever user the image uses. The temp DB directory has mode 0777
  and the DB file has mode 0666, so a non-root user can write to them.
- Local Docker (OrbStack or Docker Desktop) is not a Fly machine. Compare cold-start numbers
  between apps on the same host, and look at the cold floor as well. Do not read them as
  absolute values.
- Localhost has almost no network latency. The pill and hide timings mostly show client
  render and JS cost. Run the `--rtt` variant to see the cost of round trips.
- If `npm`/`pnpm` cannot reach the registry inside `docker build`, pass the host npmrc as a
  BuildKit secret: add `RUN --mount=type=secret,id=npmrc,target=/root/.npmrc ...` to the
  Dockerfile and run `docker build --secret id=npmrc,src=$HOME/.npmrc ...`.
