#!/usr/bin/env node
// Writes a deterministic benchmark SQLite DB with the spec §3 schema.
//
// Usage: node scripts/bench/seed.mjs <out.db> [--migrations <dir>] [--no-prisma-table] [--now <ms>]
//
// - Applies every <dir>/*/migration.sql in name order (default: ./migrations, a copy of the
//   reference repo's Prisma migrations), then records them in _prisma_migrations with the same
//   sha256 checksums Prisma uses, so `prisma migrate deploy` at boot is a no-op.
// - DateTime columns are stored as integer milliseconds (Prisma's SQLite encoding).
// - Data: 8 default topics, 10 feeds (7 FORUM, 3 BLOG, some multi-topic), 132 FeedItems
//   (FORUM 7x15, BLOG 3x9), sourceRank 0..14 per feed, publishedAt within the last 3 days,
//   5 YouTube links, no Reddit links. Seeded PRNG, so the output only depends on --now.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.removeAllListeners('warning'); // silence node:sqlite ExperimentalWarning
const { DatabaseSync } = await import('node:sqlite');

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { out: null, migrations: join(HERE, 'migrations'), prismaTable: true, now: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--migrations') args.migrations = resolve(argv[++i]);
    else if (a === '--no-prisma-table') args.prismaTable = false;
    else if (a === '--now') args.now = Number(argv[++i]);
    else if (!args.out) args.out = resolve(a);
    else throw new Error(`Unknown arg ${a}`);
  }
  if (!args.out) throw new Error('Usage: seed.mjs <out.db> [--migrations dir] [--no-prisma-table] [--now ms]');
  return args;
}

// mulberry32
function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEFAULT_TOPICS = [
  ['NEWS', 'News'], ['MUSIC', 'Music'], ['LITERATURE', 'Literature'], ['TECHNOLOGY', 'Tech'],
  ['SCIENCE', 'Science'], ['CULTURE', 'Culture'], ['POLITICS', 'Politics'], ['OTHER', 'Other'],
];

// [name, url, type, topics[], itemCount, linkHost]
const FEEDS = [
  ['Hacker News: Front Page', 'https://hnrss.org/frontpage', 'FORUM', ['TECHNOLOGY', 'SCIENCE'], 15, 'news.ycombinator.com'],
  ['Lobsters', 'https://lobste.rs/rss', 'FORUM', ['TECHNOLOGY'], 15, 'lobste.rs'],
  ['Slashdot', 'https://rss.slashdot.org/Slashdot/slashdotMain', 'FORUM', ['TECHNOLOGY', 'SCIENCE'], 15, 'slashdot.org'],
  ['Tildes ~news', 'https://tildes.net/~news/topics.rss', 'FORUM', ['NEWS', 'POLITICS'], 15, 'tildes.net'],
  ['MetaFilter', 'https://rss.metafilter.com/metafilter.rss', 'FORUM', ['CULTURE', 'OTHER'], 15, 'www.metafilter.com'],
  ['Physics Forums', 'https://www.physicsforums.com/forums/-/index.rss', 'FORUM', ['SCIENCE'], 15, 'www.physicsforums.com'],
  ['Lemmy World: World News', 'https://lemmy.world/feeds/c/worldnews.xml', 'FORUM', ['NEWS'], 15, 'lemmy.world'],
  ['Pitchfork Reviews', 'https://pitchfork.com/feed/feed-album-reviews/rss', 'BLOG', ['MUSIC', 'CULTURE'], 9, 'pitchfork.com'],
  ['The Marginalian', 'https://www.themarginalian.org/feed/', 'BLOG', ['LITERATURE'], 9, 'www.themarginalian.org'],
  ['Stratechery', 'https://stratechery.com/feed/', 'BLOG', ['TECHNOLOGY', 'POLITICS'], 9, 'stratechery.com'],
];

// 5 YouTube links: 3 on FORUM feeds (so they render on /?type=FORUM), 2 on BLOG feeds.
// [feedIndex, itemIndex, videoId]
const YOUTUBE = [
  [0, 4, 'aircAruvnKk'],
  [2, 9, 'dQw4w9WgXcQ'],
  [5, 6, 'kTXTPe3wahc'],
  [7, 2, 'jNQXAC9IVRw'],
  [9, 5, '9bZkp7q19f0'],
];

const VOCAB = {
  TECHNOLOGY: {
    titles: [
      'Show HN: {proj} – a {adj} {thing} written in {lang}',
      '{co} quietly deprecates its {thing} API',
      'Why we moved our {thing} from {lang} to {lang2}',
      'The hidden cost of {thing} at scale',
      '{lang} {ver} released with faster {thing}',
      'Ask HN: How do you manage {thing} in production?',
      'A deep dive into {co}\'s new {thing}',
      'Reverse-engineering the {thing} in a 1990s {device}',
      'We cut our {thing} bill by 70% with SQLite',
      '{proj}: {adj} {thing} for small teams',
    ],
    s: [
      'The authors benchmark the approach against three popular alternatives and find it holds up well under load.',
      'Most of the gains come from avoiding unnecessary allocations in the hot path.',
      'Commenters point out that the trade-offs only make sense for read-heavy workloads.',
      'The project is open source under the MIT license and already has a small community of contributors.',
      'A migration guide covers the breaking changes and the tooling needed to upgrade.',
      'The post walks through the design, the failure modes they hit, and what they would do differently.',
      'Early adopters report fewer incidents but note that the documentation still has gaps.',
      'It runs on a single machine and stays under 100 MB of memory for typical use.',
    ],
  },
  SCIENCE: {
    titles: [
      'Researchers observe {phen} in {place} for the first time',
      'New study links {phen} to {phen2}',
      'Physicists propose a simpler model of {phen}',
      'What the latest {inst} data says about {phen}',
      'A decades-old puzzle about {phen} may finally be solved',
      'Why {phen} is harder to measure than we thought',
    ],
    s: [
      'The team used a decade of observations to rule out the most common explanations.',
      'Independent groups will need to replicate the result before it is widely accepted.',
      'The paper, published this week, includes the full dataset and analysis code.',
      'The effect is small but statistically significant across all three experiments.',
      'Critics argue the sample size is too small to draw firm conclusions.',
      'If confirmed, the finding would change how textbooks describe the process.',
    ],
  },
  NEWS: {
    titles: [
      '{city} approves plan to expand {infra} by 2030',
      'Talks resume between {country} and {country2} over {issue}',
      'Officials in {city} respond to criticism over {issue}',
      '{country} announces new measures on {issue}',
      'Floods disrupt {infra} across northern {country}',
      'Court ruling in {country} sets precedent on {issue}',
    ],
    s: [
      'The decision follows months of public consultation and several delayed votes.',
      'Opposition groups say the measures do not go far enough and plan further protests.',
      'Analysts expect the change to take effect early next year, pending legal review.',
      'Local residents interviewed on Tuesday were divided on the proposal.',
      'The government said it would publish a detailed timeline within weeks.',
      'International observers welcomed the move but urged more transparency.',
    ],
  },
  POLITICS: {
    titles: [
      'Parliament in {country} debates a bill on {issue}',
      'Inside the fight over {issue} in {city}',
      'Polls tighten ahead of the {country} election',
      'The quiet policy shift on {issue} nobody is talking about',
    ],
    s: [
      'Lawmakers from both major parties have signalled conditional support.',
      'The bill would be the most significant reform in the area in two decades.',
      'Campaign spending has already surpassed the record set four years ago.',
      'Experts warn that the details matter more than the headline promises.',
    ],
  },
  CULTURE: {
    titles: [
      'The strange afterlife of {media}',
      'How a small {place2} became the center of {scene}',
      'An oral history of {media}',
      'Why everyone is suddenly talking about {scene}',
      'The best {media} of the year so far',
    ],
    s: [
      'The piece traces the story through interviews with the people who were there.',
      'What started as a niche hobby has turned into a minor cultural phenomenon.',
      'Readers share their own memories and recommendations in the comments.',
      'It is a reminder of how much culture now happens outside the mainstream.',
    ],
  },
  OTHER: {
    titles: [
      'A visual guide to {thing2}',
      'Someone mapped every {thing2} in {city}',
      'The surprisingly long history of {thing2}',
      'I tried {habit} for a year. Here is what happened',
    ],
    s: [
      'The interactive version lets you explore the data by year and region.',
      'It took three years of weekends and a lot of spreadsheets.',
      'Some of the results are surprising, and a few are just funny.',
    ],
  },
  MUSIC: {
    titles: [
      '{artist}: {album}',
      '{artist} returns with {album}, their most {adj2} record yet',
      'Review: {artist} – {album}',
    ],
    s: [
      'The record leans into the textures of their early work while pushing into new territory.',
      'Several tracks stretch past seven minutes without losing momentum.',
      'It is a confident, sometimes difficult album that rewards repeat listens.',
      'The production is warmer and more spacious than on their last release.',
    ],
  },
  LITERATURE: {
    titles: [
      '{writer} on {idea}',
      'What {writer} can teach us about {idea}',
      'The letters of {writer} and the art of {idea}',
    ],
    s: [
      'The essay draws on letters, diaries and a handful of overlooked early poems.',
      'It is a meditation on attention, patience and the slow work of making things.',
      'The passages quoted here remain startlingly relevant more than a century later.',
    ],
  },
};

const FILL = {
  proj: ['Tinybase', 'Quill', 'Ferrite', 'Lumen', 'Gale', 'Pico', 'Strata', 'Murmur', 'Harbor', 'Kite'],
  adj: ['minimal', 'fast', 'local-first', 'zero-dependency', 'embeddable', 'type-safe', 'tiny'],
  thing: ['message queue', 'build system', 'database', 'static site generator', 'scheduler', 'search engine', 'image pipeline', 'logging stack', 'CI pipeline', 'cache'],
  lang: ['Rust', 'Go', 'Zig', 'OCaml', 'TypeScript', 'Python', 'Elixir'],
  lang2: ['C', 'Rust', 'Go', 'Kotlin', 'Haskell'],
  co: ['Google', 'Apple', 'Mozilla', 'Cloudflare', 'GitHub', 'Microsoft', 'Fly.io'],
  ver: ['2.0', '3.4', '1.12', '5.0', '0.9'],
  device: ['pager', 'graphing calculator', 'arcade cabinet', 'fax machine', 'synthesizer'],
  phen: ['fast radio bursts', 'quantum entanglement', 'protein misfolding', 'dark matter halos', 'gravitational waves', 'superconductivity', 'cloud seeding', 'bird migration'],
  phen2: ['sleep quality', 'soil microbes', 'ocean temperatures', 'gut bacteria', 'solar activity'],
  place: ['the Antarctic ice', 'a distant galaxy', 'deep-sea vents', 'the human retina', 'a lab in Geneva'],
  inst: ['JWST', 'LIGO', 'CERN', 'Hubble', 'IceCube'],
  city: ['Lisbon', 'Montreal', 'Osaka', 'Nairobi', 'Melbourne', 'Bogotá', 'Helsinki'],
  country: ['Canada', 'Japan', 'Brazil', 'Kenya', 'Germany', 'Indonesia', 'Chile'],
  country2: ['Mexico', 'South Korea', 'Argentina', 'Ethiopia', 'France'],
  infra: ['light rail', 'bike lanes', 'public housing', 'rail freight', 'broadband'],
  issue: ['water rights', 'data privacy', 'housing costs', 'fishing quotas', 'energy prices', 'tariffs'],
  media: ['the mixtape', 'Saturday morning cartoons', 'zines', 'the video rental store', 'web forums'],
  place2: ['town in Ohio', 'island in Scotland', 'neighbourhood in Seoul', 'village in Portugal'],
  scene: ['ambient music', 'competitive birdwatching', 'retro computing', 'sourdough baking', 'speedrunning'],
  thing2: ['public benches', 'street trees', 'payphones', 'lighthouses', 'subway tiles'],
  habit: ['writing by hand', 'walking to work', 'reading only paper books', 'cooking every meal'],
  artist: ['Big Thief', 'Floating Points', 'Mdou Moctar', 'Jessica Pratt', 'Kali Malone', 'Nala Sinephro', 'Boards of Canada'],
  album: ['Double Infinity', 'Cascade', 'Funeral for Justice', 'Here in the Pitch', 'All Life Long', 'Endlessness', 'Tomorrow\'s Harvest'],
  adj2: ['tender', 'restless', 'ambitious', 'stripped-back', 'expansive'],
  writer: ['Virginia Woolf', 'Rilke', 'Mary Oliver', 'Seneca', 'Ursula K. Le Guin', 'James Baldwin', 'Simone Weil'],
  idea: ['solitude', 'attention', 'grief', 'work', 'friendship', 'wonder', 'time'],
};

function pick(rand, arr) { return arr[Math.floor(rand() * arr.length)]; }

function fill(rand, template) {
  return template.replace(/\{(\w+)\}/g, (_, k) => pick(rand, FILL[k]));
}

function cuid(rand) {
  let s = 'c';
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  for (let i = 0; i < 24; i++) s += alphabet[Math.floor(rand() * 36)];
  return s;
}

function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

function makeSummary(rand, topic) {
  const pool = VOCAB[topic].s;
  const n = 2 + Math.floor(rand() * 2);
  const used = new Set();
  const out = [];
  while (out.length < n) {
    const s = pick(rand, pool);
    if (used.has(s)) continue;
    used.add(s);
    out.push(s);
  }
  return out.join(' ');
}

export function seed(outPath, { migrations = join(HERE, 'migrations'), prismaTable = true, now = Date.now() } = {}) {
  if (existsSync(outPath)) rmSync(outPath);
  for (const ext of ['-journal', '-wal', '-shm']) if (existsSync(outPath + ext)) rmSync(outPath + ext);
  const db = new DatabaseSync(outPath);
  const migrationDirs = readdirSync(migrations, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(migrations, d.name, 'migration.sql')))
    .map((d) => d.name)
    .sort();
  if (migrationDirs.length === 0) throw new Error(`No migrations in ${migrations}`);

  const rand = prng(0x5eed);
  if (prismaTable) {
    db.exec(`CREATE TABLE "_prisma_migrations" (
      "id" TEXT PRIMARY KEY NOT NULL, "checksum" TEXT NOT NULL, "finished_at" DATETIME,
      "migration_name" TEXT NOT NULL, "logs" TEXT, "rolled_back_at" DATETIME,
      "started_at" DATETIME NOT NULL DEFAULT current_timestamp,
      "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0)`);
  }
  for (const name of migrationDirs) {
    const sql = readFileSync(join(migrations, name, 'migration.sql'), 'utf8');
    db.exec(sql);
    if (prismaTable) {
      const checksum = createHash('sha256').update(sql).digest('hex');
      db.prepare(`INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
                  VALUES (?, ?, ?, ?, ?, 1)`).run(`bench-${name}`, checksum, now, name, now);
    }
  }

  db.exec('BEGIN');
  const insTopic = db.prepare('INSERT INTO "Topic" (slug, label, createdAt) VALUES (?, ?, ?)');
  DEFAULT_TOPICS.forEach(([slug, label], i) => insTopic.run(slug, label, now - 7 * 86400e3 + i));

  const insFeed = db.prepare(`INSERT INTO "Feed" (id, name, url, sourceKind, type, isActive, fetchErrorCount, lastFetched, createdAt, updatedAt)
                              VALUES (?, ?, ?, 'RSS', ?, 1, 0, ?, ?, ?)`);
  const insFT = db.prepare('INSERT INTO "FeedTopic" (feedId, topicSlug) VALUES (?, ?)');
  const insItem = db.prepare(`INSERT INTO "FeedItem" (id, feedId, guid, title, link, summary, author, publishedAt, sourceRank, fetchedAt)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const yt = new Map(YOUTUBE.map(([f, i, id]) => [`${f}:${i}`, id]));
  let itemCount = 0;
  FEEDS.forEach(([name, url, type, topics, count, host], fi) => {
    const feedId = cuid(rand);
    insFeed.run(feedId, name, url, type, now - 3600e3, now - 7 * 86400e3 + fi, now - 3600e3);
    for (const t of topics) insFT.run(feedId, t);
    // Newer items get better ranks, with some shuffle so Hot != New.
    const times = Array.from({ length: count }, () => now - Math.floor(rand() * 3 * 86400e3)).sort((a, b) => b - a);
    for (let i = 0; i < count; i++) {
      const topic = topics[Math.floor(rand() * topics.length)];
      const title = fill(rand, pick(rand, VOCAB[topic].titles));
      const ytId = yt.get(`${fi}:${i}`);
      const n = 40000000 + Math.floor(rand() * 999999);
      const link = ytId ? `https://www.youtube.com/watch?v=${ytId}` : `https://${host}/item/${n}/${slugify(title)}`;
      const jitter = Math.floor((rand() - 0.5) * 4);
      const rank = Math.min(14, Math.max(0, i + jitter));
      insItem.run(cuid(rand), feedId, `${host}-${n}`, title, link, makeSummary(rand, topic),
        rand() < 0.5 ? null : pick(rand, ['dang', 'jcs', 'msmash', 'kfwyre', 'cortex', 'staff', 'Ben Thompson', 'Maria Popova']),
        times[i], rank, now - 3600e3);
      itemCount++;
    }
  });
  db.exec('COMMIT');
  db.close();
  return { feeds: FEEDS.length, items: itemCount, topics: DEFAULT_TOPICS.length, migrations: migrationDirs.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const r = seed(args.out, { migrations: args.migrations, prismaTable: args.prismaTable, now: args.now ?? Date.now() });
  console.log(`seeded ${args.out}: ${r.topics} topics, ${r.feeds} feeds, ${r.items} items (${r.migrations} migrations)`);
}
