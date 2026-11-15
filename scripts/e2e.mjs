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
// Migrate the copy first (a legacy DB still has Feed.type), so the INSERT below matches the current schema.
execFileSync('node', ['dist/server.mjs', '--migrate-only'], { env: { ...process.env, DATABASE_URL: `file:${db}` }, stdio: 'inherit' });
// A synthetic 120-item feed so New mode has a second page to scroll into.
const now = Date.now();
const rows = Array.from({ length: 120 }, (_, i) =>
  `('e2e-item-${i}','e2e-feed','g${i}','Synthetic item ${i}','https://example.com/e2e/${i}',${now - (i + 1) * 3600_000},${i},${now})`);
// The flows below use the NEWS and TECHNOLOGY topics; make sure the copy has them whatever the source DB holds.
execFileSync('sqlite3', [db, `INSERT OR IGNORE INTO Topic (slug,label) VALUES ('NEWS','News'),('TECHNOLOGY','Technology');`]);
// The copy's own subreddit feeds are dropped, so the window checks see only the synthetic one (under NEWS).
execFileSync('sqlite3', [db, `PRAGMA foreign_keys = ON; DELETE FROM Feed WHERE sourceKind = 'REDDIT';
INSERT INTO Feed (id,name,url,sourceKind,isActive,fetchErrorCount,createdAt,updatedAt) VALUES ('e2e-feed','Synthetic','https://example.invalid/feed.xml','RSS',1,0,${now},${now});
INSERT INTO FeedTopic VALUES ('e2e-feed','TECHNOLOGY');
INSERT INTO Feed (id,name,url,sourceKind,isActive,fetchErrorCount,createdAt,updatedAt) VALUES ('e2e-reddit','r/listentothis','https://www.reddit.com/r/listentothis/','REDDIT',1,0,${now},${now});
INSERT INTO FeedTopic VALUES ('e2e-reddit','NEWS');
INSERT INTO FeedItem (id,feedId,guid,title,link,publishedAt,sourceRank,fetchedAt) VALUES ${rows.join(',')};`]);
// An item a minute in the future, so it is first under New whatever the DB holds, with a summary past the card's excerpt.
const LONG = Array.from({ length: 1500 }, (_, i) => `word${i}`).join(' '); // far more than 3 cards' worth
execFileSync('sqlite3', [db, `INSERT INTO FeedItem (id,feedId,guid,title,link,summary,publishedAt,sourceRank,fetchedAt) VALUES ('e2e-long','e2e-feed','glong','Synthetic long summary','https://example.com/e2e/long','${LONG}',${now + 60_000},0,${now});`]);
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
  assert.equal(await page.getAttribute('[data-testid=type-pill-FEED]', 'aria-current'), 'true');
  ok('default view is Feed / All');

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
  await page.click('[data-testid=type-pill-FEED]');
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

  // A cut summary: More shows the whole text in the card, Less puts the excerpt back.
  // The expanded card is capped at 3× its collapsed height; the rest of the text scrolls inside it.
  await page.evaluate(() => window.scrollTo(0, 0));
  const longCard = page.locator('[data-testid=feed-card]', { hasText: 'Synthetic long summary' });
  assert.match(await longCard.locator('.sum').textContent(), /word59…$/);
  await longCard.scrollIntoViewIfNeeded(); // off screen, content-visibility reports a placeholder height
  const collapsed = (await longCard.boundingBox()).height;
  await longCard.locator('[data-act=more]').click();
  await page.waitForFunction(() => document.querySelector('[data-act=more]')?.getAttribute('aria-expanded') === 'true');
  const panel = longCard.locator('.sum-full');
  assert.match(await panel.textContent(), /word1499$/);
  assert.equal(await longCard.locator('.sum').isHidden(), true);
  const expanded = (await longCard.boundingBox()).height;
  assert.ok(expanded <= collapsed * 3 + 1 && expanded > collapsed * 2.5, `collapsed ${collapsed}px, expanded ${expanded}px`);
  assert.ok(await panel.evaluate((el) => el.scrollHeight > el.clientHeight), 'panel scrolls');
  await longCard.locator('[data-act=more]').click();
  assert.equal(await panel.isHidden(), true);
  assert.match(await longCard.locator('.sum').textContent(), /word59…$/);
  assert.equal(await longCard.locator('[data-act=more]').textContent(), 'More');
  ok('More expands a cut summary into a scrolling panel (card ≤ 3× tall), Less collapses it');

  await page.click('[data-testid=nav-manage-link]');
  await page.waitForSelector('[data-testid=topics-manager]');
  await page.click('[data-testid=type-pill-FEED]').catch(() => {});
  assert.equal(await page.$('[data-testid=type-filter-row]'), null);
  ok('manage page hides filter rows');

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

  // Topic reorder: ‹/› moves the chip at once, and the nav pills follow once it is saved.
  const chipOrder = () => page.$$eval('[data-testid=topic-chip]', (els) => els.map((e) => e.dataset.slug));
  const pillOrder = () =>
    page.$$eval('[data-testid^="topic-pill-"]', (els) => els.map((e) => e.dataset.testid.slice('topic-pill-'.length)));
  const moveTopic = async (dir) => {
    const saved = page.waitForResponse((r) => r.url().endsWith('/api/topics/order') && r.ok());
    await page.click(`[data-testid=move-topic-${dir}-TECHNOLOGY]`);
    await saved;
  };
  const startOrder = await chipOrder();
  const from = startOrder.indexOf('TECHNOLOGY');
  const [dir, back] = from > 0 ? ['left', 'right'] : ['right', 'left'];
  await moveTopic(dir);
  const after = await chipOrder();
  assert.equal(after.indexOf('TECHNOLOGY'), from + (dir === 'left' ? -1 : 1));
  ok(`move topic ${dir} moves the chip at once`);
  await page.click('header a[href="/"]');
  await page.waitForSelector('[data-testid=topic-filter-row]');
  assert.deepEqual(await pillOrder(), ['ALL', ...after]);
  ok('nav pills follow the new topic order');
  await page.click('[data-testid=nav-manage-link]');
  await page.waitForSelector('[data-testid=topics-manager]');
  await moveTopic(back);
  assert.deepEqual(await chipOrder(), startOrder);
  ok(`move topic ${back} restores the order`);

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
  await page.click('[data-testid=type-pill-FEED]').catch(() => page.goto(base + '/'));
  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.click('[data-testid=refresh-button]');
  await page.waitForFunction(() => /^Refreshed \d+/.test(document.querySelector('[data-testid=refresh-status]')?.textContent ?? ''), null, { timeout: 60000 });
  ok('refresh status: ' + (await page.textContent('[data-testid=refresh-status]')));

  // Back button restores the previous view.
  await page.click('[data-testid=topic-pill-TECHNOLOGY]');
  await page.waitForURL(/topic=TECHNOLOGY/);
  await page.goBack();
  await page.waitForFunction(() => document.querySelector('[data-testid=topic-pill-ALL]')?.getAttribute('aria-current') === 'true');
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

  // A subreddit window is the first entry under its topic, and absent elsewhere. With Redlib running
  // (REDLIB_URL set), its frame lists posts, and a post opens in the frame with its comments.
  await page.goto(base + '/?topic=NEWS', { waitUntil: 'load' }); // a live frame never reaches networkidle
  assert.equal(await page.$eval('.feed-items > article', (a) => a.dataset.testid), 'subreddit-window');
  assert.match(await page.textContent('[data-testid=subreddit-window] .meta b'), /r\/listentothis/);
  if (process.env.REDLIB_URL) {
    await page.waitForSelector('[data-testid=subreddit-window] iframe[src="/r/listentothis/hot"]');
    const frame = page.frameLocator('[data-testid=subreddit-window] iframe');
    await frame.locator('.post').first().waitFor({ timeout: 30_000 });
    await frame.locator('.post_title a[href*="/comments/"]').first().click();
    await frame.locator('.comment').first().waitFor({ timeout: 30_000 });
  }
  await page.goto(base + '/?topic=TECHNOLOGY', { waitUntil: 'load' });
  assert.equal(await count('[data-testid=subreddit-window]'), 0);
  ok(process.env.REDLIB_URL ? 'subreddit window: posts, then a thread with comments' : 'subreddit window placement (no REDLIB_URL)');

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
