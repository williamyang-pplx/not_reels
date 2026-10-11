import { chromium, devices } from 'playwright-core';
const [,, url, out, scrollY = '0', full] = process.argv;
const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
const p = await (await b.newContext({ ...devices['iPhone 14 Pro'], deviceScaleFactor: 2 })).newPage();
await p.goto(url, { waitUntil: 'networkidle' });
await p.evaluate((y) => window.scrollTo(0, y), Number(scrollY)); await p.waitForTimeout(500);
await p.screenshot({ path: out, fullPage: !!full }); await b.close();
