#!/usr/bin/env node
// Dopey — public Playwright smoke tests

(async () => {
  const baseUrl = process.env.BASE_URL || 'http://localhost:8080';
  const pages = (process.env.PAGES || '/').split(',').map(value => value.trim()).filter(Boolean);
  const saveScreenshots = process.env.SAVE_SCREENSHOTS === '1';

  let playwright;
  try {
    playwright = require('playwright');
  } catch (_error) {
    console.error('Playwright not installed. Install with `npm i -D playwright` or let CI install it.');
    process.exitCode = 78;
    return;
  }

  let browser;
  let failures = 0;
  try {
    browser = await playwright.chromium.launch({ args: ['--no-sandbox'] });
    const context = await browser.newContext();
    const page = await context.newPage();

  for (const pagePath of pages) {
    const url = pagePath.startsWith('http')
      ? pagePath
      : `${baseUrl.replace(/\/$/, '')}${pagePath.startsWith('/') ? '' : '/'}${pagePath}`;
    console.log(`Visiting ${url}`);

    try {
      const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
      if (!response) {
        console.error(`No response for ${url}`);
        failures++;
        continue;
      }

      const status = response.status();
      console.log(`  HTTP ${status}`);
      if (status >= 400) {
        console.error(`  FAIL: ${url} returned ${status}`);
        failures++;
        if (saveScreenshots) {
          await page.screenshot({ path: `dopey-fail-${Date.now()}.png`, fullPage: true });
        }
        continue;
      }

      const title = await page.title();
      console.log(`  title: ${title || '(no title)'}`);
      const hasBody = await page.$('body') !== null;
      if (!hasBody) {
        console.error(`  FAIL: ${url} missing <body>`);
        failures++;
        if (saveScreenshots) {
          await page.screenshot({ path: `dopey-fail-${Date.now()}.png`, fullPage: true });
        }
      } else {
        console.log(`  OK: ${url}`);
      }
    } catch (error) {
      console.error(`  ERROR loading ${url}:`, error.message);
      failures++;
      if (saveScreenshots) {
        try {
          await page.screenshot({ path: `dopey-ex-${Date.now()}.png`, fullPage: true });
        } catch (_error) {
          // Preserve the original navigation failure.
        }
      }
    }
    }
  } finally {
    if (browser) await browser.close();
  }

  if (failures > 0) {
    console.error(`Dopey: ${failures} page(s) failed smoke checks`);
    process.exitCode = 2;
    return;
  }

  console.log('Dopey: smoke tests passed');
})().catch(error => {
  console.error('Dopey failed:', error.message);
  process.exitCode = 2;
});
