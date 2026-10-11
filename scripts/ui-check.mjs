// Dev-only UI check: iPhone-sized screenshots + interaction timings against a running server.
// Usage: node scripts/ui-check.mjs [baseUrl] [outDir]
import { chromium, devices } from 'playwright-core';

const base = process.argv[2] ?? 'http://localhost:3100';
const out = process.argv[3] ?? '/tmp/shots';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const ctx = await browser.newContext({ ...devices['iPhone 14 Pro'], deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

const shot = (name, full = false) => page.screenshot({ path: `${out}/${name}.png`, fullPage: full });

await page.goto(base + '/', { waitUntil: 'networkidle' });
await shot('01-forums');
await page.click('[data-testid=type-pill-BLOG]');
await page.waitForURL(/type=BLOG/);
await page.waitForTimeout(300);
await shot('02-blogs');
await page.evaluate(() => window.scrollTo(0, 900));
await page.waitForTimeout(400);
await shot('03-blogs-scrolled');
await page.click('[data-testid=topic-pill-MUSIC]');
await page.waitForURL(/topic=MUSIC/);
await page.waitForTimeout(300);
await shot('04-blogs-music');

// timings
const t = async (fn) => { const s = Date.now(); await fn(); return Date.now() - s; };
const pill = [];
for (const slug of ['TECHNOLOGY', 'ALL', 'TECHNOLOGY', 'ALL', 'SCIENCE']) {
  pill.push(await t(async () => {
    await page.evaluate(() => (document.querySelector('[data-testid=feed-list]').__old = true));
    await page.click(`[data-testid=topic-pill-${slug}]`);
    await page.waitForFunction(() => !document.querySelector('[data-testid=feed-list]')?.__old);
  }));
}
const hide = await t(async () => {
  const link = await page.$eval('[data-testid=feed-card] a', (e) => e.getAttribute('href'));
  await page.click('[data-testid=feed-card] [data-testid=hide-feed-item-btn]');
  await page.waitForFunction((l) => ![...document.querySelectorAll('[data-testid=feed-card] > a')].some((a) => a.getAttribute('href') === l), link);
});
await page.click('[data-testid=sort-new]');
await page.waitForTimeout(400);
await shot('05-new');
await page.click('[data-testid=type-pill-SAVED]');
await page.waitForURL(/saved/);
await page.waitForTimeout(300);
await shot('06-saved');
await page.click('[data-testid=add-saved-link-btn]');
await page.waitForTimeout(250);
await shot('07-save-modal');
await page.keyboard.press('Escape');
await page.click('[data-testid=nav-manage-link]');
await page.waitForURL(/manage/);
await page.waitForTimeout(300);
await shot('08-manage');
await page.click('[data-testid=add-feed-btn]');
await page.waitForTimeout(250);
await shot('09-add-feed');

console.log(JSON.stringify({ pillMs: pill, hideMs: hide, errors }, null, 1));
await browser.close();
