import { chromium, devices } from 'playwright-core';
const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const p = await (await b.newContext({ ...devices['iPhone 14 Pro'], deviceScaleFactor: 2 })).newPage();
const go = async (u, out, y = 0) => { await p.goto('http://localhost:4000' + u, { waitUntil: 'networkidle' }); await p.evaluate((y) => scrollTo(0, y), y); await p.waitForTimeout(600); await p.screenshot({ path: out }); };
await go('/', '/tmp/shots/show-feed.png');
await go('/?topic=SCIENCE', '/tmp/shots/show-science.png', 0);
await go('/?topic=LITERATURE', '/tmp/shots/show-lit.png');
await go('/?topic=MUSIC', '/tmp/shots/show-music.png');
await b.close();
