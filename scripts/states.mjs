import { chromium, devices } from 'playwright-core';
const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const ctx = await b.newContext({ ...devices['iPhone 14 Pro'], deviceScaleFactor: 2 });
const p = await ctx.newPage();
await p.goto('http://localhost:3100/', { waitUntil: 'networkidle' });
await p.evaluate(() => { const s = document.querySelector('[data-testid=refresh-status]'); s.textContent = 'Refreshed 23, 204 new, 1 failed'; s.hidden = false; });
await p.screenshot({ path: '/tmp/shots/s-status.png', clip: { x: 0, y: 0, width: 393, height: 300 } });
for (const t of ['save-feed-item-btn','save-feed-item-btn']) { await p.click(`[data-testid=feed-card] [data-testid=${t}]`); await p.waitForTimeout(300); }
await p.goto('http://localhost:3100/saved', { waitUntil: 'networkidle' });
await p.screenshot({ path: '/tmp/shots/s-saved.png' });
await p.goto('http://localhost:3100/manage', { waitUntil: 'networkidle' });
await p.click('[data-testid=feed-row] [data-testid=feed-edit-btn]'); await p.waitForTimeout(250);
await p.screenshot({ path: '/tmp/shots/s-edit.png' });
const d = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
await d.goto('http://localhost:3100/', { waitUntil: 'networkidle' });
await d.screenshot({ path: '/tmp/shots/s-desktop.png' });
await b.close();
