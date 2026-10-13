#!/usr/bin/env node
'use strict';

/*
 * B1.3 smoke test — boots the real Express app (stub DB, no Postgres) and
 * exercises the consistency-pass surfaces:
 *   1. static assets exist and are served (theme.css, shared-nav.js,
 *      destination-preview.js, tailwind.css)
 *   2. every wired page links /css/theme.css before /css/tailwind.css
 *      (token cascade) and no page carries a copied nav block (the card 3
 *      shell is the only nav; card 8/9 sweep removed all copied variants)
 *   3. /map renders with the destination-preview panel + script
 *   4. destination-preview.js math is correct (tile + in-tile offset)
 *   5. /admin/theme renders; /api/guilds/:id/theme enforces site-admin
 */

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

const { ensureTestEncryptionKey } = require(path.join(__dirname, 'lib/test-env.js'));
ensureTestEncryptionKey();
// Dummy OAuth creds so passport-discord can construct (strategy is never exercised here).
process.env.DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || 'test-client-id';
process.env.DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || 'test-client-secret';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret';

const root = path.resolve(__dirname, '..');

function stubDb() {
  const empty = { rows: [] };
  return {
    async get() { return empty; },
    async query() { return empty; },
    async all() { return []; },
    async execute() { return empty; },
    async getClient() { return { async query() { return empty; }, async release() {} }; },
    async begin() {},
    async commit() {},
    async rollback() {},
    async transaction(fn) { return fn(this); },
    async close() {},
  };
}

function request(server, method, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path: urlPath, headers }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

// Tolerant fetch: the connect-pg session store pings a (missing) Postgres in
// this stub environment, and concurrent DB errors can drop a request with
// ECONNRESET. Retry a couple of times before treating it as a failure.
async function softRequest(server, method, urlPath) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await request(server, method, urlPath);
      if (r.status !== 0) return r;
    } catch (err) {
      // fall through to retry
    }
    await new Promise(res => setTimeout(res, 150));
  }
  return { status: 0, text: '', headers: {}, error: 'gave up after retries' };
}

async function main() {
  let failures = 0;
  const check = (name, ok, detail) => {
    if (ok) console.log(`✅ ${name}`);
    else { failures++; console.log(`❌ ${name}${detail ? ' — ' + detail : ''}`); }
  };

  // ---- 1. destination-preview.js math (pure, no app) ----
  const preview = require(path.join(root, 'public/js/destination-preview.js'));
  // CP: image size = 31*480+512 = 15392; world 7680 -> image px 7696 -> tile 16.
  const t = preview.tileForWorld('chernarusplus', { east: 7680, north: 7680 });
  check('preview tile at CP center -> tile 16/16', t.tileX === 16 && t.tileY === 16, JSON.stringify(t));
  check('preview tile url uses flipped file-y', t.tileUrl === '/maps/chernarusplus/tiles/16/15.png', t.tileUrl);
  // Enoch center: image = 12800*(15392/12800)... worldSize 12800 -> image 15392; center -> 7696 -> tile 16.
  const tE = preview.tileForWorld('enoch', { east: 6400, north: 6400 });
  check('preview tile at enoch center -> tile 16/16', tE.tileX === 16 && tE.tileY === 16, JSON.stringify(tE));
  check('preview rejects namalsk (no tiles)', preview.tileForWorld('namalsk', { east: 1, north: 1 }) === null);
  check('preview rejects bad coords', preview.tileForWorld('enoch', { east: 'x', north: 1 }) === null);
  const html = preview.previewHtml({ mapName: 'enoch', east: 6400, north: 6400, name: '<b>"spot"</b>' });
  check('previewHtml escapes label', html.includes('&lt;b&gt;') && !html.includes('<b>'), html.slice(0, 200));
  check('previewHtml emits marker + tile img', html.includes('/maps/enoch/tiles/') && html.includes('aria-label'), html.slice(0, 120));

  // ---- boot the app ----
  const { createApp } = require(path.join(root, 'src/app/createApp.js'));
  const app = createApp(stubDb());
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  console.log(`(smoke app on port ${server.address().port})`);

  try {
    // ---- 2. static assets ----
    for (const asset of ['/css/theme.css', '/js/shared-nav.js', '/js/destination-preview.js', '/css/tailwind.css']) {
      const r = await softRequest(server, 'GET', asset);
      check(`static ${asset} served 200`, r.status === 200, `status ${r.status}`);
    }
    const themeCss = await softRequest(server, 'GET', '/css/theme.css');
    check('theme.css has B1.3 helpers (skeleton/empty/nav)', /dzc-skeleton/.test(themeCss.text) && /dzc-empty/.test(themeCss.text) && /dzc-nav\b/.test(themeCss.text));
    const tokens = await softRequest(server, 'GET', '/css/theme.css');
    check('theme.css still carries B1.1 tokens', /--dzc-bg:/.test(tokens.text) && /--dzc-stat:/.test(tokens.text));

    // ---- 3. /map integration (auth-guarded route: 302 to login expected unauthenticated) ----
    const mapPage = await softRequest(server, 'GET', '/map');
    check('/map is auth-guarded (302 redirect when anonymous)', mapPage.status === 302 && mapPage.headers.location === '/', `status ${mapPage.status} loc ${mapPage.headers.location}`);
    // Panel + script wiring verified at file level (page is behind login above).
    const mapHtml = fs.readFileSync(path.join(root, 'public/map.html'), 'utf8');
    check('/map.html has destination preview panel', mapHtml.includes('destination-preview-panel'));
    check('/map.html loads destination-preview.js', mapHtml.includes('src="/js/destination-preview.js"'));
    const mapScript = await softRequest(server, 'GET', '/js/map.js');
    check('map.js wires preview on click', mapScript.text.includes('updateDestinationPreview') && mapScript.text.includes('bindDestinationPreviewPanel'));

    // ---- 4. theme toggle + guild theme API guards ----
    const toggle = await softRequest(server, 'GET', '/js/theme-toggle.js');
    check('theme-toggle.js served', toggle.status === 200 && toggle.text.length > 100);
    const adminTheme = await softRequest(server, 'GET', '/admin/theme');
    check('/admin/theme is auth-guarded (302 when anonymous)', adminTheme.status === 302 && adminTheme.headers.location === '/', `status ${adminTheme.status} loc ${adminTheme.headers.location}`);
    const themeApi = await softRequest(server, 'GET', '/api/guilds/999999/theme');
    check('guild theme API enforces auth (401/403/redirect, not 200/500)', [302, 401, 403].includes(themeApi.status), `status ${themeApi.status}`);

    // ---- 5. file-level cascade + nav-sweep assertions ----
    const htmlDirs = [root + '/public', root + '/public/dashboard', root + '/public/admin'];
    let checked = 0, cascadeBad = 0, copiedNav = 0;
    for (const dir of htmlDirs) {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.html')) continue;
        const s = fs.readFileSync(path.join(dir, f), 'utf8');
        if (s.includes('/css/tailwind.css')) {
          checked++;
          const t = s.search('css/theme.css');
          const w = s.search('css/tailwind.css');
          if (t === -1 || w < t) { cascadeBad++; console.log('   cascade bad:', path.join(dir, f)); }
        }
        // Copied nav signatures: B1.3 slot/script, inline copied nav bars.
        // (The shell composes its own nav server-side; pages must not carry
        // another. splash.html's landing <nav class="tiles"> is a different
        // component and does not match the signatures below.)
        if (s.includes('dzc-nav-slot') || s.includes('/js/shared-nav.js') ||
            /<nav class="bg-gray-800/.test(s) || s.includes('id="playerNav"')) {
          copiedNav++;
          console.log('   copied nav:', path.join(dir, f));
        }
      }
    }
    check(`tailwind pages all load theme.css first (${checked} pages)`, cascadeBad === 0, `${cascadeBad} bad`);
    check('nav sweep: no copied nav blocks remain on any page', copiedNav === 0, `${copiedNav} pages still carry a copied nav`);
  } finally {
    server.close();
  }

  console.log(failures === 0 ? '\n✅ B1.3 smoke tests passed' : `\n❌ B1.3 smoke tests failed (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
