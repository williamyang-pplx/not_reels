#!/usr/bin/env node
// Framework benchmark harness for the not-brainrot feed page. See README.md.
//
//   node measure.mjs <name> <target> [options]
//   node measure.mjs --table            # print a markdown table of results/*.json
//
// <target> is one of:
//   <docker image>       run it with --memory 512m --cpus 1 and the seeded DB at /data/sqlite.db
//   cmd:<shell command>  run a local process (PORT and DATABASE_URL are set for it)
//   http(s)://host:port  an already-running server (cold start and RSS are skipped; its DB is used as-is)
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, constants as zc } from 'node:zlib';
import { seed } from './seed.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(HERE, 'results');
const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PHASES = ['cold', 'warm', 'js', 'lighthouse', 'pill', 'pillfresh', 'hide'];

// ---------- args ----------
function parseArgs(argv) {
  const o = {
    name: null, target: null, path: '/?type=FORUM', containerPort: 3000, hostPort: 3900,
    dataDir: '/data', dbFile: 'sqlite.db', env: [], seedArgs: [], coldRuns: 5, warmRuns: 30,
    lhRuns: 3, clickRuns: 5, cpuThrottle: 4, pillTopic: 'TECHNOLOGY',
    freshPills: ['TECHNOLOGY', 'NEWS', 'SCIENCE', 'CULTURE', 'POLITICS'], skip: new Set(), floor: true,
    chrome: process.env.CHROME_PATH || DEFAULT_CHROME, memory: '512m', cpus: '1', keep: false, table: false,
    readyTimeoutMs: 60000, rtt: 0, cmd: [],
  };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--table': o.table = true; break;
      case '--path': o.path = next(); break;
      case '--container-port': o.containerPort = Number(next()); break;
      case '--host-port': o.hostPort = Number(next()); break;
      case '--data-dir': o.dataDir = next(); break;
      case '--db-file': o.dbFile = next(); break;
      case '--env': o.env.push(next()); break;
      case '--seed-arg': o.seedArgs.push(next()); break;
      case '--cold-runs': o.coldRuns = Number(next()); break;
      case '--warm-runs': o.warmRuns = Number(next()); break;
      case '--lh-runs': o.lhRuns = Number(next()); break;
      case '--click-runs': o.clickRuns = Number(next()); break;
      case '--cpu-throttle': o.cpuThrottle = Number(next()); break;
      case '--rtt': o.rtt = Number(next()); break;
      case '--cmd': o.cmd = next().split(/\s+/).filter(Boolean); break;
      case '--pill': o.pillTopic = next(); break;
      case '--fresh-pills': o.freshPills = next().split(','); break;
      case '--skip': for (const s of next().split(',')) o.skip.add(s.trim()); break;
      case '--no-floor': o.floor = false; break;
      case '--chrome': o.chrome = next(); break;
      case '--memory': o.memory = next(); break;
      case '--cpus': o.cpus = next(); break;
      case '--keep': o.keep = true; break;
      case '-h': case '--help': usage(0); break;
      default:
        if (a.startsWith('--')) { console.error(`unknown option ${a}`); usage(1); }
        pos.push(a);
    }
  }
  if (!o.table) {
    if (pos.length !== 2) usage(1);
    [o.name, o.target] = pos;
  }
  return o;
}

function usage(code) {
  console.log(`usage: node measure.mjs <name> <image | cmd:<shell> | http://url> [options]
       node measure.mjs --table
options:
  --path <p>             page to measure (default /?type=FORUM)
  --container-port <n>   port the app listens on inside the container (default 3000)
  --host-port <n>        host port to publish on / PORT for cmd: mode (default 3900)
  --data-dir <dir>       DB directory inside the container (default /data); DB file is <dir>/sqlite.db
  --db-file <f>          DB file name (default sqlite.db)
  --env K=V              extra env for the app (repeatable)
  --cmd "<args>"         override the image CMD (whitespace-split), e.g. to skip boot-time migrations
  --seed-arg <a>         extra arg for seed.mjs, e.g. --seed-arg --no-prisma-table (repeatable)
  --cold-runs/--warm-runs/--lh-runs/--click-runs <n>   (defaults 5/30/3/5)
  --cpu-throttle <n>     CPU slowdown for pill/hide timings (default 4)
  --rtt <ms>             extra request latency for pill/hide timings via CDP (default 0 = none)
  --pill <slug>          topic pill to toggle against ALL (default TECHNOLOGY)
  --fresh-pills a,b,..   topics visited once each for the uncached pill timing
                         (default TECHNOLOGY,NEWS,SCIENCE,CULTURE,POLITICS; each must have FORUM items)
  --skip a,b             skip phases: ${PHASES.join(',')}
  --no-floor             skip the "bare node http server in the same image" cold-start floor
  --memory/--cpus        container limits (default 512m / 1)
  --chrome <path>        Chrome binary (default $CHROME_PATH or ${DEFAULT_CHROME})
  --keep                 keep the container and temp DB dir afterwards`);
  process.exit(code);
}

// ---------- utils ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const round = (x, d = 1) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);
const nowMs = () => Number(process.hrtime.bigint()) / 1e6;
const log = (...a) => console.error('[bench]', ...a);

function docker(args, { allowFail = false } = {}) {
  try {
    return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    if (allowFail) return null;
    throw new Error(`docker ${args.join(' ')} failed: ${e.stderr || e.message}`);
  }
}

// One GET; resolves at first response byte (headers) with { ttfb, total, status }.
function timedGet(url, { timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const t0 = nowMs();
    const req = lib.get(url, { agent: false, headers: { 'accept-encoding': 'gzip', 'user-agent': 'nr-bench' } }, (res) => {
      const ttfb = nowMs() - t0;
      res.on('data', () => {});
      res.on('end', () => resolve({ ttfb, total: nowMs() - t0, status: res.statusCode }));
      res.on('error', reject);
    });
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// Tight poll loop: resolves with the timestamp of the first successful (2xx/3xx) first byte.
async function pollUntilUp(url, deadlineMs) {
  for (;;) {
    if (nowMs() > deadlineMs) throw new Error(`server at ${url} did not come up`);
    const t0 = nowMs();
    try {
      const r = await new Promise((resolve, reject) => {
        const req = http.get(url, { agent: false }, (res) => {
          const at = nowMs();
          res.resume();
          resolve({ at, status: res.statusCode });
        });
        req.setTimeout(10000, () => req.destroy(new Error('timeout')));
        req.on('error', reject);
      });
      if (r.status < 400) return r.at;
    } catch {}
    const wait = 10 - (nowMs() - t0);
    if (wait > 0) await sleep(wait);
  }
}

// ---------- memory sampling ----------
function dockerSocketPath() {
  const host = docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { allowFail: true }) || '';
  if (host.startsWith('unix://')) return host.slice('unix://'.length);
  return '/var/run/docker.sock';
}

function dockerStatsOnce(socketPath, container) {
  return new Promise((resolve) => {
    const req = http.get({ socketPath, path: `/containers/${container}/stats?stream=false&one-shot=true` }, (res) => {
      let s = '';
      res.on('data', (d) => (s += d));
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch { resolve(null); } });
    });
    req.setTimeout(2000, () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

function processTreeRssKb(rootPid) {
  try {
    const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss='], { encoding: 'utf8' });
    const rows = out.trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
    const kids = new Map();
    for (const [pid, ppid] of rows) { if (!kids.has(ppid)) kids.set(ppid, []); kids.get(ppid).push(pid); }
    const rss = new Map(rows.map(([pid, , r]) => [pid, r]));
    let total = 0;
    const stack = [rootPid];
    while (stack.length) { const p = stack.pop(); total += rss.get(p) ?? 0; stack.push(...(kids.get(p) ?? [])); }
    return total;
  } catch { return 0; }
}

function startMemorySampler(getSample) {
  const state = { peakUsageMb: 0, peakAnonMb: 0, peakRssMb: 0, samples: 0, running: true };
  (async () => {
    while (state.running) {
      const t0 = nowMs();
      const s = await getSample();
      if (s) {
        state.samples++;
        state.peakUsageMb = Math.max(state.peakUsageMb, s.usageMb ?? 0);
        state.peakAnonMb = Math.max(state.peakAnonMb, s.anonMb ?? 0);
        state.peakRssMb = Math.max(state.peakRssMb, s.rssMb ?? 0);
      }
      const wait = 200 - (nowMs() - t0);
      if (wait > 0) await sleep(wait);
    }
  })();
  return state;
}

// Sum of RSS (KB) of all processes in the container, via the API behind `docker top`.
function dockerTopRssKb(socketPath, container) {
  return new Promise((resolve) => {
    const req = http.get({ socketPath, path: `/containers/${container}/top?ps_args=-o%20pid,rss` }, (res) => {
      let s = '';
      res.on('data', (d) => (s += d));
      res.on('end', () => {
        try {
          const j = JSON.parse(s);
          const i = j.Titles.findIndex((t) => t.toUpperCase() === 'RSS');
          // Values may carry a unit suffix ("41m"); bare numbers are KB.
          const kb = (v) => {
            const m = /^([\d.]+)([kmg]?)$/i.exec(String(v).trim());
            if (!m) return 0;
            return Number(m[1]) * ({ '': 1, k: 1, m: 1024, g: 1024 * 1024 }[m[2].toLowerCase()]);
          };
          resolve(j.Processes.reduce((sum, p) => sum + kb(p[i]), 0));
        } catch { resolve(0); }
      });
    });
    req.setTimeout(2000, () => req.destroy());
    req.on('error', () => resolve(0));
  });
}

function dockerMemSample(socketPath, container) {
  return async () => {
    const [st, rssKb] = await Promise.all([dockerStatsOnce(socketPath, container), dockerTopRssKb(socketPath, container)]);
    const m = st?.memory_stats;
    if (!m || !m.usage) return null;
    const inactive = m.stats?.inactive_file ?? m.stats?.total_inactive_file ?? 0;
    // usageMb = `docker stats` MEM USAGE (cgroup usage - inactive_file, includes active page cache);
    // anonMb = cgroup anonymous memory; rssMb = sum of process RSS (`docker top`).
    return { usageMb: (m.usage - inactive) / 2 ** 20, anonMb: (m.stats?.anon ?? m.stats?.rss ?? 0) / 2 ** 20, rssMb: rssKb / 1024 };
  };
}

// ---------- server drivers ----------
function makeDockerDriver(o, dbDir) {
  const cname = `nrbench-${o.name}`.replace(/[^a-zA-Z0-9_.-]/g, '-');
  const envArgs = o.env.flatMap((e) => ['-e', e]);
  const create = (name, extra = [], cmd = []) => {
    docker(['rm', '-f', name], { allowFail: true });
    docker(['create', '--name', name, '--memory', o.memory, '--memory-swap', o.memory, '--cpus', o.cpus,
      '-p', `127.0.0.1:${o.hostPort}:${o.containerPort}`, '-v', `${dbDir}:${o.dataDir}`,
      '-e', `DATABASE_URL=file://${o.dataDir}/${o.dbFile}`, ...envArgs, ...extra, o.target, ...cmd]);
  };
  const startTimed = async (name) => {
    const url = `http://127.0.0.1:${o.hostPort}${o.path}`;
    const t0 = nowMs();
    const proc = spawn('docker', ['start', name], { stdio: 'ignore' });
    const exited = new Promise((r) => proc.on('exit', r));
    const up = await pollUntilUp(url, t0 + o.readyTimeoutMs);
    await exited;
    return up - t0;
  };
  return {
    kind: 'docker',
    cname,
    url: `http://127.0.0.1:${o.hostPort}`,
    async prepare() { create(cname, [], o.cmd); },
    startTimed: () => startTimed(cname),
    async stop() { docker(['kill', cname], { allowFail: true }); await sleep(300); },
    async ensureRunning() {
      const running = docker(['inspect', '-f', '{{.State.Running}}', cname], { allowFail: true }) === 'true';
      if (!running) await startTimed(cname);
    },
    memSampler: () => dockerMemSample(dockerSocketPath(), cname),
    // Cold-start floor: a bare node http server in the same image, same limits.
    async floor(runs) {
      const fname = `${cname}-floor`;
      const js = `require('http').createServer((q,s)=>s.end('ok')).listen(${o.containerPort},'0.0.0.0')`;
      try {
        create(fname, ['--entrypoint', 'node'], ['-e', js]);
        await startTimed(fname); // priming, not counted
        docker(['kill', fname], { allowFail: true });
        await sleep(300);
        const xs = [];
        for (let i = 0; i < runs; i++) {
          xs.push(await startTimed(fname));
          docker(['kill', fname], { allowFail: true });
          await sleep(300);
        }
        return xs;
      } finally {
        docker(['rm', '-f', fname], { allowFail: true });
      }
    },
    async cleanup() { if (!o.keep) docker(['rm', '-f', cname], { allowFail: true }); },
    logs() { return docker(['logs', '--tail', '30', cname], { allowFail: true }); },
  };
}

function makeCmdDriver(o, dbDir) {
  const cmd = o.target.slice('cmd:'.length);
  let proc = null;
  const env = {
    ...process.env, PORT: String(o.hostPort), HOST: '127.0.0.1',
    DATABASE_URL: `file://${join(dbDir, o.dbFile)}`,
    ...Object.fromEntries(o.env.map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)])),
  };
  const url = `http://127.0.0.1:${o.hostPort}`;
  const startTimed = async () => {
    const t0 = nowMs();
    proc = spawn('sh', ['-c', cmd], { env, stdio: 'ignore', detached: true });
    const up = await pollUntilUp(url + o.path, t0 + o.readyTimeoutMs);
    return up - t0;
  };
  const stop = async () => {
    if (proc) { try { process.kill(-proc.pid, 'SIGKILL'); } catch {} proc = null; await sleep(300); }
  };
  return {
    kind: 'cmd', url, async prepare() {}, startTimed, stop,
    async ensureRunning() { if (!proc) await startTimed(); },
    memSampler: () => async () => {
      if (!proc) return null;
      const mb = processTreeRssKb(proc.pid) / 1024;
      return { usageMb: mb, anonMb: 0, rssMb: mb };
    },
    floor: null,
    cleanup: stop,
    logs: () => '',
  };
}

function makeUrlDriver(o) {
  const url = o.target.replace(/\/$/, '');
  return {
    kind: 'url', url, async prepare() {}, startTimed: null, async stop() {}, async ensureRunning() {},
    memSampler: null, floor: null, async cleanup() {}, logs: () => '',
  };
}

// ---------- phases ----------
async function measureWarm(url, runs) {
  for (let i = 0; i < 10; i++) await timedGet(url);
  const ttfb = [];
  const total = [];
  for (let i = 0; i < runs; i++) {
    const r = await timedGet(url);
    if (r.status >= 400) throw new Error(`warm request got ${r.status}`);
    ttfb.push(r.ttfb);
    total.push(r.total);
  }
  return { ttfbMs: median(ttfb), totalMs: median(total), ttfbSamples: ttfb.map((x) => round(x, 2)) };
}

async function launchChrome(o) {
  const { chromium } = await import('playwright-core');
  return chromium.launch({ executablePath: o.chrome, headless: true });
}

async function measureJs(browser, url) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const responses = [];
  page.on('response', (r) => responses.push(r));
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const origin = new URL(url).origin;
  const out = { scripts: [], bytes: { html: 0, css: 0, js: 0, js1p: 0, js3p: 0, font: 0 } };
  for (const r of responses) {
    const type = r.request().resourceType();
    if (!['document', 'stylesheet', 'script', 'font'].includes(type)) continue;
    let body;
    try { body = await r.body(); } catch { continue; }
    const gz = gzipSync(body, { level: zc.Z_BEST_COMPRESSION }).length;
    const thirdParty = new URL(r.url()).origin !== origin;
    if (type === 'document') out.bytes.html += gz;
    else if (type === 'stylesheet') out.bytes.css += gz;
    else if (type === 'font') out.bytes.font += body.length; // fonts are already compressed
    else {
      out.bytes.js += gz;
      if (thirdParty) out.bytes.js3p += gz; else out.bytes.js1p += gz;
      out.scripts.push({ url: r.url(), rawBytes: body.length, gzBytes: gz, thirdParty });
    }
  }
  await ctx.close();
  const kb = (b) => round(b / 1024, 1);
  return {
    jsGzKb: kb(out.bytes.js), jsGzFirstPartyKb: kb(out.bytes.js1p), jsGzThirdPartyKb: kb(out.bytes.js3p),
    htmlGzKb: kb(out.bytes.html), cssGzKb: kb(out.bytes.css), fontKb: kb(out.bytes.font),
    totalGzKb: kb(out.bytes.html + out.bytes.css + out.bytes.js), scripts: out.scripts,
  };
}

async function measureLighthouse(o, url) {
  const runs = [];
  const errors = [];
  const lhCli = join(HERE, 'node_modules', 'lighthouse', 'cli', 'index.js');
  for (let i = 0; i < o.lhRuns; i++) {
    const outPath = join(mkdtempSync(join(tmpdir(), 'nrbench-lh-')), 'report.json');
    try {
      execFileSync(process.execPath, [lhCli, url, '--quiet', '--output=json', `--output-path=${outPath}`,
        '--only-categories=performance', '--form-factor=mobile', '--throttling-method=simulate',
        `--chrome-path=${o.chrome}`, '--chrome-flags=--headless=new --no-first-run'],
      { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, CHROME_PATH: o.chrome }, timeout: 180000 });
      const rep = JSON.parse(readFileSync(outPath, 'utf8'));
      if (rep.runtimeError) throw new Error(rep.runtimeError.message);
      const a = rep.audits;
      runs.push({
        score: Math.round((rep.categories.performance.score ?? 0) * 100),
        fcpMs: a['first-contentful-paint'].numericValue, lcpMs: a['largest-contentful-paint'].numericValue,
        tbtMs: a['total-blocking-time'].numericValue, cls: a['cumulative-layout-shift'].numericValue,
        siMs: a['speed-index'].numericValue,
      });
    } catch (e) {
      errors.push(String(e.stderr || e.message).slice(0, 500));
    } finally {
      rmSync(dirname(outPath), { recursive: true, force: true });
    }
  }
  const med = (k) => round(median(runs.map((r) => r[k])), 0);
  return {
    lcpMs: med('lcpMs'), tbtMs: med('tbtMs'), fcpMs: med('fcpMs'), siMs: med('siMs'),
    cls: round(median(runs.map((r) => r.cls)), 3), score: med('score'), runs, errors,
  };
}

async function newThrottledPage(browser, url, rate, rtt = 0) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: false });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid=feed-card]', { timeout: 30000 });
  await page.waitForTimeout(500);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  if (rtt > 0) {
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: rtt, downloadThroughput: -1, uploadThroughput: -1 });
  }
  return { ctx, page };
}

// In-page: t0 = click (capture listener), t1 = first frame after `done()` becomes true.
// Installed before the click; awaited after it.
function installMeasurer(page, kind, arg) {
  return page.evaluate(([kind, arg]) => {
    const cards = () => document.querySelectorAll('[data-testid=feed-card]');
    const first = cards()[0] ?? null;
    const before = { count: cards().length, first, firstText: first?.textContent ?? '' };
    let done;
    if (kind === 'pill') {
      const wantTopic = arg; // 'ALL' or slug
      done = () => {
        const sp = new URLSearchParams(location.search);
        const urlOk = wantTopic === 'ALL' ? !sp.has('topic') : sp.get('topic') === wantTopic;
        const list = cards();
        if (!urlOk || list.length === 0) return false;
        return list.length !== before.count || (list[0].textContent ?? '') !== before.firstText;
      };
    } else {
      done = () => !before.first.isConnected || cards()[0] !== before.first;
    }
    window.__bench = new Promise((resolve) => {
      let t0 = null;
      let matched = false;
      const stop = (v) => { matched = true; clearTimeout(timer); mo.disconnect(); resolve(v); };
      const timer = setTimeout(() => stop(null), 20000);
      const check = () => {
        if (t0 == null || matched || !done()) return;
        matched = true;
        mo.disconnect();
        clearTimeout(timer);
        // Count until the frame that shows the change has been produced.
        requestAnimationFrame(() => setTimeout(() => resolve(performance.now() - t0), 0));
      };
      const mo = new MutationObserver(check);
      mo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
      document.addEventListener('click', () => { t0 = performance.now(); queueMicrotask(check); }, { capture: true, once: true });
      const poll = () => { if (!matched) { check(); requestAnimationFrame(poll); } };
      requestAnimationFrame(poll);
    });
    return true;
  }, [kind, arg]);
}

async function measurePill(browser, o, url) {
  const { ctx, page } = await newThrottledPage(browser, url, o.cpuThrottle, o.rtt);
  let slug = o.pillTopic;
  if (!(await page.$(`[data-testid=topic-pill-${slug}]`))) {
    const pills = await page.$$('[data-testid^=topic-pill-]');
    slug = (await pills[1]?.getAttribute('data-testid'))?.replace('topic-pill-', '');
    if (!slug) throw new Error('no topic pills found');
  }
  const samples = [];
  for (let i = 0; i < o.clickRuns; i++) {
    const target = i % 2 === 0 ? slug : 'ALL';
    await installMeasurer(page, 'pill', target);
    await page.click(`[data-testid=topic-pill-${target}]`);
    samples.push(await page.evaluate(() => window.__bench));
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(700);
  }
  await ctx.close();
  return { ms: median(samples), pill: slug, samples: samples.map((x) => round(x, 1)) };
}

// Each click goes to a topic not visited before in this page, so no client cache can serve it.
async function measureFreshPills(browser, o, url) {
  const { ctx, page } = await newThrottledPage(browser, url, o.cpuThrottle, o.rtt);
  const samples = [];
  for (const slug of o.freshPills) {
    if (!(await page.$(`[data-testid=topic-pill-${slug}]`))) throw new Error(`no pill for ${slug}`);
    await installMeasurer(page, 'pill', slug);
    await page.click(`[data-testid=topic-pill-${slug}]`);
    samples.push(await page.evaluate(() => window.__bench));
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(700);
  }
  await ctx.close();
  return { ms: median(samples), pills: o.freshPills, samples: samples.map((x) => round(x, 1)) };
}

async function measureHide(browser, o, url) {
  const { ctx, page } = await newThrottledPage(browser, url, o.cpuThrottle, o.rtt);
  const samples = [];
  for (let i = 0; i < o.clickRuns; i++) {
    await installMeasurer(page, 'hide');
    await page.click('[data-testid=feed-card] >> nth=0 >> [data-testid=hide-feed-item-btn]');
    samples.push(await page.evaluate(() => window.__bench));
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(700);
  }
  await ctx.close();
  return { ms: median(samples), samples: samples.map((x) => round(x, 1)) };
}

// ---------- table ----------
const COLS = [
  ['App', (r) => r.name],
  ['Cold TTFB ms', (r) => r.coldStart?.medianMs],
  ['Cold floor ms', (r) => r.coldStart?.floorMedianMs],
  ['Warm TTFB ms', (r) => r.warm?.ttfbMs],
  ['JS gz KB (1st/3rd)', (r) => (r.js ? `${r.js.jsGzKb} (${r.js.jsGzFirstPartyKb}/${r.js.jsGzThirdPartyKb})` : null)],
  ['HTML+CSS+JS gz KB', (r) => r.js?.totalGzKb],
  ['LCP ms', (r) => r.lighthouse?.lcpMs],
  ['TBT ms', (r) => r.lighthouse?.tbtMs],
  ['LH score', (r) => r.lighthouse?.score],
  ['Pill→list ms', (r) => r.pill?.ms],
  ['Pill (uncached) ms', (r) => r.pillFresh?.ms],
  ['Hide→removed ms', (r) => r.hide?.ms],
  ['Peak mem MB (docker stats)', (r) => r.memory?.peakUsageMb],
  ['Peak RSS MB (procs)', (r) => r.memory?.peakRssMb],
];
const fmt = (v) => (v == null ? 'n/a' : typeof v === 'number' ? String(round(v, v >= 100 ? 0 : 1)) : String(v));
const header = () => `| ${COLS.map((c) => c[0]).join(' | ')} |\n|${COLS.map(() => '---').join('|')}|`;
const row = (r) => `| ${COLS.map((c) => fmt(c[1](r))).join(' | ')} |`;

function printTable() {
  const files = readdirSync(RESULTS_DIR).filter((f) => f.endsWith('.json')).sort();
  console.log(header());
  for (const f of files) console.log(row(JSON.parse(readFileSync(join(RESULTS_DIR, f), 'utf8'))));
}

// ---------- main ----------
async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.table) return printTable();
  mkdirSync(RESULTS_DIR, { recursive: true });

  const mode = o.target.startsWith('http') ? 'url' : o.target.startsWith('cmd:') ? 'cmd' : 'docker';
  let dbDir = null;
  if (mode !== 'url') {
    dbDir = mkdtempSync(join(tmpdir(), `nrbench-${o.name}-`));
    chmodSync(dbDir, 0o777);
    const seedOpts = { now: Date.now() };
    for (let i = 0; i < o.seedArgs.length; i++) {
      if (o.seedArgs[i] === '--no-prisma-table') seedOpts.prismaTable = false;
      else if (o.seedArgs[i] === '--migrations') seedOpts.migrations = o.seedArgs[++i];
    }
    const s = seed(join(dbDir, o.dbFile), seedOpts);
    chmodSync(join(dbDir, o.dbFile), 0o666);
    log(`seeded ${s.items} items into ${dbDir}/${o.dbFile}`);
  }
  const driver = mode === 'docker' ? makeDockerDriver(o, dbDir) : mode === 'cmd' ? makeCmdDriver(o, dbDir) : makeUrlDriver(o);
  const pageUrl = driver.url + o.path;
  const result = {
    name: o.name, target: o.target, mode, path: o.path, measuredAt: new Date().toISOString(),
    config: { memory: o.memory, cpus: o.cpus, cpuThrottle: o.cpuThrottle, rttMs: o.rtt, coldRuns: o.coldRuns, warmRuns: o.warmRuns, lhRuns: o.lhRuns, clickRuns: o.clickRuns },
    notes: [],
  };
  const run = async (phase, fn) => {
    if (o.skip.has(phase)) { result.notes.push(`${phase}: skipped`); return null; }
    log(`phase ${phase}...`);
    try { return await fn(); } catch (e) {
      log(`phase ${phase} failed: ${e.message}`);
      result.notes.push(`${phase}: failed: ${e.message.slice(0, 300)}`);
      return null;
    }
  };

  let mem = null;
  let browser = null;
  try {
    await driver.prepare();
    if (driver.memSampler) mem = startMemorySampler(driver.memSampler());

    if (driver.startTimed) {
      result.coldStart = await run('cold', async () => {
        // One unmeasured priming start: the first start after `docker create` pays one-off
        // container setup (network, mounts) that a restarted machine doesn't.
        const primingMs = await driver.startTimed();
        log(`  priming start: ${round(primingMs)} ms (not counted)`);
        await driver.stop();
        const xs = [];
        for (let i = 0; i < o.coldRuns; i++) {
          xs.push(await driver.startTimed());
          log(`  cold #${i + 1}: ${round(xs.at(-1))} ms`);
          if (i < o.coldRuns - 1) await driver.stop();
        }
        return { medianMs: round(median(xs)), samples: xs.map((x) => round(x)), primingMs: round(primingMs) };
      });
    } else result.notes.push('cold: not measurable in url mode');
    await driver.ensureRunning();

    result.warm = await run('warm', () => measureWarm(pageUrl, o.warmRuns));
    browser = await launchChrome(o);
    result.js = await run('js', () => measureJs(browser, pageUrl));
    result.lighthouse = await run('lighthouse', () => measureLighthouse(o, pageUrl));
    if (result.lighthouse && result.lighthouse.runs.length === 0) result.notes.push(`lighthouse: all runs failed: ${result.lighthouse.errors[0]}`);
    result.pill = await run('pill', () => measurePill(browser, o, pageUrl));
    result.pillFresh = await run('pillfresh', () => measureFreshPills(browser, o, pageUrl));
    result.hide = await run('hide', () => measureHide(browser, o, pageUrl));

    if (mem) {
      mem.running = false;
      await sleep(250);
      result.memory = { peakUsageMb: round(mem.peakUsageMb), peakRssMb: round(mem.peakRssMb), peakAnonMb: round(mem.peakAnonMb), samples: mem.samples };
    } else result.notes.push('memory: not measurable in url mode');

    // Floor last so the app's own memory peak isn't polluted.
    if (driver.floor && o.floor && !o.skip.has('cold')) {
      await driver.stop();
      const xs = await run('floor', () => driver.floor(o.coldRuns));
      if (xs) result.coldStart = { ...result.coldStart, floorMedianMs: round(median(xs)), floorSamples: xs.map((x) => round(x)) };
    }
  } catch (e) {
    result.notes.push(`fatal: ${e.message}`);
    log('fatal', e.message, driver.logs?.() ?? '');
  } finally {
    if (mem) mem.running = false;
    await browser?.close().catch(() => {});
    await driver.cleanup();
    if (dbDir && !o.keep) rmSync(dbDir, { recursive: true, force: true });
  }

  const outPath = join(RESULTS_DIR, `${o.name}.json`);
  writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
  log(`wrote ${outPath}`);
  if (result.notes.length) log('notes:', result.notes.join(' | '));
  console.log(header());
  console.log(row(result));
}

main().catch((e) => { console.error(e); process.exit(1); });
