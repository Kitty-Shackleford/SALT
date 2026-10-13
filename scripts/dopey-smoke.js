#!/usr/bin/env node
// Dopey — simple Playwright smoke tests (fast, minimal assertions)

(async () => {
  const BASE_URL = process.env.BASE_URL || 'http://localhost:8080';
  const PAGES = (process.env.PAGES || '/').split(',').map(p => p.trim()).filter(Boolean);
  const SAVE_SCREENSHOTS = process.env.SAVE_SCREENSHOTS === '1';

  let playwright;
  try {
    playwright = require('playwright');
  } catch (err) {
    console.error('Playwright not installed. Install with `npm i -D playwright` or let CI install it.');
    process.exit(78);
  }

  const browser = await playwright.chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext();
  const page = await context.newPage();

  let failures = 0;

  for (const p of PAGES) {
    const url = p.startsWith('http') ? p : `${BASE_URL.replace(/\/$/, '')}${p.startsWith('/') ? '' : '/'}${p}`;
    console.log(`Visiting ${url}`);
    try {
      const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
      if (!resp) {
        console.error(`No response for ${url}`);
        failures++;
        continue;
      }
      const status = resp.status();
      console.log(`  HTTP ${status}`);
      if (status >= 400) {
        console.error(`  FAIL: ${url} returned ${status}`);
        failures++;
        if (SAVE_SCREENSHOTS) await page.screenshot({ path: `dopey-fail-${Date.now()}.png`, fullPage: true });
        continue;
      }

      // Basic title check (optional)
      const title = await page.title();
      console.log(`  title: ${title || '(no title)'}`);

      // Basic DOM check: body exists
      const hasBody = await page.$('body') !== null;
      if (!hasBody) {
        console.error(`  FAIL: ${url} missing <body>`);
        failures++;
        if (SAVE_SCREENSHOTS) await page.screenshot({ path: `dopey-fail-${Date.now()}.png`, fullPage: true });
      } else {
        console.log(`  OK: ${url}`);
      }
    } catch (err) {
      console.error(`  ERROR loading ${url}:`, err.message);
      failures++;
      if (SAVE_SCREENSHOTS) {
        try { await page.screenshot({ path: `dopey-ex-${Date.now()}.png`, fullPage: true }); } catch (_) {}
      }
    }
  }

  await browser.close();

  if (failures > 0) {
    console.error(`Dopey: ${failures} page(s) failed smoke checks`);
    process.exit(2);
  }

  console.log('Dopey: smoke tests passed');
  process.exit(0);
})();
