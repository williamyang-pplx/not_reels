// Dev-only end-to-end pass over every UI flow, against a throwaway copy of a DB.
// Usage: node scripts/e2e.mjs <source.db>
import { chromium, devices } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import assert from 'node:assert/strict';

const src = process.argv[2] ?? '/tmp/nr-dev.db';
const db = '/tmp/nr-e2e.db';
for (const s of ['', '-wal', '-shm']) rmSync(db + s, { force: true });
// .backup (not a file copy) so rows still sitting in the source's WAL come along.
execFileSync('sqlite3', [src, `.backup ${db}`]);
// A synthetic 120-item forum feed so New mode has a second page to scroll into.
const now = Date.now();
const rows = Array.from({ length: 120 }, (_, i) =>
  `('e2e-item-${i}','e2e-feed','g${i}','Synthetic item ${i}','https://example.com/e2e/${i}',${now - (i + 1) * 3600_000},${i},${now})`);
// The flows below use the NEWS and TECHNOLOGY topics; make sure the copy has them whatever the source DB holds.
execFileSync('sqlite3', [db, `INSERT OR IGNORE INTO Topic (slug,label) VALUES ('NEWS','News'),('TECHNOLOGY','Technology');`]);
execFileSync('sqlite3', [db, `INSERT INTO Feed (id,name,url,sourceKind,type,isActive,fetchErrorCount,createdAt,updatedAt) VALUES ('e2e-feed','Synthetic','https://example.invalid/feed.xml','RSS','FORUM',1,0,${now},${now});
INSERT INTO FeedTopic VALUES ('e2e-feed','TECHNOLOGY');
INSERT INTO FeedItem (id,feedId,guid,title,link,publishedAt,sourceRank,fetchedAt) VALUES ${rows.join(',')};`]);
// A YouTube item a minute in the future, so it is first under New on Blogs/Videos whatever the DB holds.
const YT = 'dQw4w9WgXcQ';
const LONG = Array.from({ length: 150 }, (_, i) => `word${i}`).join(' '); // longer than a card's 80-word excerpt
execFileSync('sqlite3', [db, `INSERT INTO Feed (id,name,url,sourceKind,type,isActive,fetchErrorCount,createdAt,updatedAt) VALUES ('e2e-yt','Synthetic YT','https://example.invalid/yt.xml','RSS','BLOG',1,0,${now},${now});
INSERT INTO FeedTopic VALUES ('e2e-yt','TECHNOLOGY');
INSERT INTO FeedItem (id,feedId,guid,title,link,summary,publishedAt,sourceRank,fetchedAt) VALUES ('e2e-yt-0','e2e-yt','yt0','Synthetic video','https://www.youtube.com/watch?v=${YT}','${LONG}',${now + 60_000},0,${now});`]);
const server = spawn('node', ['dist/server.mjs'], { env: { ...process.env, DATABASE_URL: `file:${db}`, PORT: '3300' }, stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 500));
const base = 'http://localhost:3300';

const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const ctx = await browser.newContext({ ...devices['iPhone 14 Pro'], permissions: ['clipboard-read', 'clipboard-write'] });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const ok = (name) => console.log('  ✓', name);
const count = (sel) => page.$$eval(sel, (e) => e.length);

try {
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  assert.equal(await page.getAttribute('[data-testid=type-pill-FORUM]', 'aria-current'), 'true');
  ok('default view is Forums / All');

  // Scroller is the default: snapping, one card per screen below the nav.
  assert.equal(await page.getAttribute('html', 'data-mode'), 'reels');
  const snap = await page.evaluate(() => {
    const card = document.querySelector('[data-testid=feed-card]').getBoundingClientRect().height;
    const nav = document.querySelector('[data-testid=nav-bar]').getBoundingClientRect().height;
    return { type: getComputedStyle(document.documentElement).scrollSnapType, card, rest: innerHeight - nav };
  });
  assert.match(snap.type, /mandatory/);
  assert.ok(snap.card >= snap.rest - 1, `card ${snap.card}px, screen below nav ${snap.rest}px`);
  ok('scroller is the default view');

  // Save the first card -> leaves the feed, shows up in Saved.
  const firstTitle = await page.textContent('[data-testid=feed-card] h3');
  await page.click('[data-testid=feed-card] [data-testid=save-feed-item-btn]');
  await page.waitForFunction((t) => document.querySelector('[data-testid=feed-card] h3')?.textContent !== t, firstTitle);
  ok('save removes the card');
  await page.click('[data-testid=type-pill-SAVED]');
  await page.waitForSelector('[data-testid=saved-link-card]');
  assert.equal((await page.textContent('[data-testid=saved-link-card] h3')).trim(), firstTitle.trim());
  ok('saved card appears on /saved');

  // Manual save via modal.
  await page.click('[data-testid=add-saved-link-btn]');
  await page.fill('[data-testid=add-saved-link-modal] input[name=url]', 'https://example.com/hand-saved');
  await page.fill('[data-testid=add-saved-link-modal] input[name=title]', 'Hand saved link');
  await page.fill('[data-testid=add-saved-link-modal] textarea', 'a note');
  await page.click('[data-testid=add-saved-link-modal] button[type=submit]');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid=saved-link-card] h3')].some((h) => h.textContent === 'Hand saved link'));
  assert.equal(await page.isHidden('[data-testid=add-saved-link-modal]'), true);
  ok('save-a-link modal creates a link and closes');

  // Overlay click closes the modal.
  await page.click('[data-testid=add-saved-link-btn]');
  await page.mouse.click(10, 10);
  assert.equal(await page.isHidden('[data-testid=add-saved-link-modal]'), true);
  ok('overlay click closes modal');

  // Delete a saved link.
  const before = await count('[data-testid=saved-link-card]');
  await page.click('[data-testid=saved-link-card] [data-testid=saved-link-delete]');
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid=saved-link-card]').length === n - 1, before);
  ok('delete saved link');

  // Hide on the feed.
  await page.click('[data-testid=type-pill-FORUM]');
  await page.waitForSelector('[data-testid=feed-card]');
  const hideHref = await page.getAttribute('[data-testid=feed-card] a', 'href');
  await page.click('[data-testid=feed-card] [data-testid=hide-feed-item-btn]');
  await page.waitForFunction((h) => ![...document.querySelectorAll('[data-testid=feed-card] > a')].some((a) => a.getAttribute('href') === h), hideHref);
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.$(`[data-testid=feed-card] > a[href="${hideHref}"]`), null);
  ok('hide persists across reload');

  // Sort persists across pill changes, resets after leaving "/".
  await page.click('[data-testid=sort-new]');
  await page.waitForFunction(() => document.querySelector('[data-testid=sort-new]')?.getAttribute('aria-selected') === 'true');
  await page.click('[data-testid=topic-pill-TECHNOLOGY]');
  await page.waitForURL(/topic=TECHNOLOGY/);
  await page.waitForFunction(() => document.querySelector('[data-testid=sort-new]')?.getAttribute('aria-selected') === 'true');
  assert.ok(!page.url().includes('sort='));
  ok('sort kept across pills and not in URL');

  // Infinite scroll in New mode (if enough items).
  await page.click('[data-testid=topic-pill-ALL]');
  await page.waitForURL((u) => !u.search.includes('topic'));
  const hasCursor = await page.$('[data-testid=sentinel][data-cursor]');
  if (hasCursor) {
    const n = await count('[data-testid=feed-card]');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid=feed-card]').length > n, n);
    ok('infinite scroll loads the next page');
  } else throw new Error('expected a second page in New mode');

  // Scroller autoplays the video in view, muted, and unloads it once it scrolls away.
  const ytFrame = `iframe[src*="youtube-nocookie.com/embed/${YT}"]`;
  const openBlogsNew = async () => {
    await page.click('[data-testid=type-pill-BLOG]');
    await page.waitForURL(/type=BLOG/);
    await page.click('[data-testid=sort-new]');
    await page.waitForSelector('[data-testid=feed-list][data-current-sort=new] [data-act=yt]', { state: 'attached' });
  };
  await openBlogsNew();
  await page.locator('[data-act=yt]').first().locator('..').scrollIntoViewIfNeeded();
  await page.waitForSelector(`${ytFrame}[src*="mute=1"]`, { state: 'attached' });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForSelector(ytFrame, { state: 'detached' });
  assert.equal(await page.locator('[data-act=yt]').first().isHidden(), false);
  ok('scroller autoplays muted and unloads off-screen');
  // The scroller swaps the card's excerpt for the whole summary.
  await page.waitForFunction(() => {
    const sum = document.querySelector('[data-act=yt]')?.closest('article')?.querySelector('.sum');
    return sum && !sum.hasAttribute('data-more') && sum.textContent.trim().endsWith('word149');
  });
  ok('scroller shows the whole summary, not the excerpt');

  await page.click('[data-testid=nav-manage-link]');
  await page.waitForSelector('[data-testid=topics-manager]');
  await page.click('[data-testid=type-pill-FORUM]').catch(() => {});
  assert.equal(await page.$('[data-testid=type-filter-row]'), null);
  ok('manage page hides filter rows');

  // View toggle: Tiles persists across reload and keeps tap-to-play; then back to the default.
  const selected = (m) => page.getAttribute(`[data-testid=view-mode-${m}]`, 'aria-selected');
  assert.equal(await selected('reels'), 'true');
  await page.click('[data-testid=view-mode-tiles]');
  assert.equal(await page.getAttribute('html', 'data-mode'), 'tiles');
  assert.equal(await selected('tiles'), 'true');
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.getAttribute('html', 'data-mode'), 'tiles');
  assert.equal(await selected('tiles'), 'true');
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await openBlogsNew();
  await page.locator('[data-act=yt]').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(1000);
  assert.equal(await page.$(ytFrame), null);
  await page.locator('[data-act=yt]').first().click();
  const src = await page.getAttribute(ytFrame, 'src');
  assert.ok(!src.includes('mute=1'), src);
  ok('tiles keep tap-to-play (unmuted)');
  await page.click('[data-testid=nav-manage-link]');
  await page.waitForSelector('[data-testid=topics-manager]');
  await page.click('[data-testid=view-mode-reels]');
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.getAttribute('html', 'data-mode'), 'reels');
  ok('view toggle persists across reload');

  // Topic add (slug derivation), duplicate error, delete with confirm.
  await page.fill('[data-testid=topic-input]', 'Board Games!');
  await page.click('[data-testid=add-topic-btn]');
  await page.waitForSelector('[data-testid=delete-topic-BOARD_GAMES]');
  ok('add topic derives slug BOARD_GAMES');
  await page.fill('[data-testid=topic-input]', 'board games');
  await page.click('[data-testid=add-topic-btn]');
  await page.waitForFunction(() => document.querySelector('[data-testid=topics-manager] .form-error')?.textContent?.includes('already exists'));
  ok('duplicate topic shows error');
  await page.fill('[data-testid=topic-input]', '!!!');
  await page.click('[data-testid=add-topic-btn]');
  await page.waitForFunction(() => document.querySelector('[data-testid=topics-manager] .form-error')?.textContent === 'Label must contain letters or digits');
  ok('empty slug error');
  page.once('dialog', (d) => d.accept());
  await page.click('[data-testid=delete-topic-BOARD_GAMES]');
  await page.waitForSelector('[data-testid=delete-topic-BOARD_GAMES]', { state: 'detached' });
  ok('delete topic after confirm');

  // Add a local feed via modal (submit disabled until a topic is checked).
  await page.click('[data-testid=add-feed-btn]');
  assert.equal(await page.isDisabled('[data-testid=add-feed-modal] button[type=submit]'), true);
  await page.fill('[data-testid=add-feed-modal] input[name=name]', 'Hacker News Best');
  await page.fill('[data-testid=add-feed-modal] input[name=url]', 'https://hnrss.org/best');
  await page.check('[data-testid=add-feed-modal] [data-testid=topic-checkbox-TECHNOLOGY]');
  await page.click('[data-testid=add-feed-modal] button[type=submit]');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid=feed-row]')].some((r) => r.dataset.name === 'Hacker News Best'), null, { timeout: 15000 });
  ok('add feed via modal (with initial fetch)');

  const row = '[data-testid=feed-row][data-name="Hacker News Best"]';
  await page.click(`${row} [data-testid=feed-edit-btn]`);
  assert.equal(await page.isChecked('[data-testid=edit-feed-modal] [data-testid=topic-checkbox-TECHNOLOGY]'), true);
  await page.check('[data-testid=edit-feed-modal] [data-testid=topic-checkbox-NEWS]');
  await page.click('[data-testid=edit-feed-modal] button[type=submit]');
  await page.waitForFunction((r) => document.querySelector(r)?.dataset.topics === 'NEWS,TECHNOLOGY', row);
  ok('edit topics');

  await page.click(`${row} [data-testid=feed-pause-btn]`);
  await page.waitForFunction((r) => document.querySelector(r + ' [data-testid=feed-pause-btn]')?.textContent?.trim() === 'Resume', row);
  ok('pause feed');
  await page.click(`${row} [data-testid=feed-pause-btn]`);
  await page.waitForFunction((r) => document.querySelector(r + ' [data-testid=feed-pause-btn]')?.textContent?.trim() === 'Pause', row);
  ok('resume feed');
  await page.click(`${row} [data-testid=feed-delete-btn]`);
  await page.waitForSelector(row, { state: 'detached' });
  ok('delete feed');

  // Refresh feeds status text.
  await page.click('[data-testid=type-pill-FORUM]').catch(() => page.goto(base + '/'));
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.click('[data-testid=refresh-button]');
  await page.waitForFunction(() => /^Refreshed \d+/.test(document.querySelector('[data-testid=refresh-status]')?.textContent ?? ''), null, { timeout: 60000 });
  ok('refresh status: ' + (await page.textContent('[data-testid=refresh-status]')));

  // Back button restores the previous view.
  await page.click('[data-testid=type-pill-BLOG]');
  await page.waitForURL(/type=BLOG/);
  await page.goBack();
  await page.waitForFunction(() => document.querySelector('[data-testid=type-pill-FORUM]')?.getAttribute('aria-current') === 'true');
  ok('back button');

  // Back gesture with a modal open must not leave the page scroll-locked.
  await page.click('[data-testid=type-pill-SAVED]');
  await page.waitForURL(/saved/);
  await page.click('[data-testid=add-saved-link-btn]');
  await page.goBack();
  await page.waitForFunction(() => !location.pathname.startsWith('/saved'));
  assert.equal(await page.evaluate(() => document.documentElement.style.overflow), '');
  assert.equal(await page.evaluate(() => document.getElementById('bar').className === 'on'), false);
  ok('back with modal open releases scroll lock; no stuck progress bar');

  assert.deepEqual(errors, []);
  ok('no page errors');
} catch (e) {
  console.error('FAILED:', e.message, errors);
  await page.screenshot({ path: '/tmp/e2e-fail.png' });
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
