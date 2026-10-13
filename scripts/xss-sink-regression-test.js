'use strict';

/**
 * XSS-sink regression test (P0 security, UI modernization card 1/9).
 *
 * The Aug release-plan audit flagged two unescaped-API-value-into-innerHTML
 * sinks:
 *   - public/js/loot-finder.js  renderItemList / renderItemDetailFull
 *   - public/js/dashboard.js    loadRecentActivity (activity feed)
 *
 * Both are now escaped with the shared `escapeHtml` helper (newer screens
 * already did this). This test feeds an adversarial string through each render
 * path and asserts the rendered markup contains NO raw HTML tag — only the
 * escaped form. It is written to FAIL against the pre-fix (unescaped) code, so
 * it would have caught the original vulnerability.
 *
 * Hermetic: no DOM, no network. The two browser scripts are executed inside a
 * Node `vm` context with a minimal fake DOM + stubbed fetch, mirroring the
 * pattern in scripts/admin-onboarding-ui-test.js.
 *
 * Run standalone:   node scripts/xss-sink-regression-test.js [basePath]
 *   basePath defaults to <repo>/public/js. Supplying a directory that holds
 *   `loot-finder.js` + `dashboard.js` with the `escapeHtml(...)` wrappers
 *   removed reproduces the vulnerable state and makes this suite fail
 *   (red-on-old proof).
 */

const { ensureTestEncryptionKey } = require('./lib/test-env');
ensureTestEncryptionKey();

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '..');
const basePath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(repoRoot, 'public', 'js');

const ADV_SCRIPT = '<script>alert(1)</script>';
const ADV_IMG = '<img src=x onerror=alert(1)>';
const ADV_QUOTED = '"onmouseover="alert(2)';

function makeElement(id) {
  const el = {
    id,
    innerHTML: '',
    textContent: '',
    value: '',
    style: {},
    className: '',
    children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {},
    removeEventListener() {},
    querySelectorAll() { return []; },
    setAttribute() {},
    insertRow() { return makeElement('tr'); },
    appendChild(child) { el.children.push(child); return child; },
  };
  Object.defineProperty(el, 'firstChild', {
    get() { return el.children[0] || null; },
  });
  el.removeChild = function (child) {
    el.children = el.children.filter((c) => c !== child);
    return child;
  };
  return el;
}

function buildDocument() {
  const elements = new Map();
  return {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
    createElement(tag) { return makeElement(tag); },
    querySelector() { return makeElement('q'); },
    querySelectorAll() { return []; },
    addEventListener() {},
    _elements: elements,
  };
}

/** Load one browser script into an isolated context with a fake DOM. */
function loadScript(file, { fetchImpl, withWindowLocation } = {}) {
  const document = buildDocument();
  const context = vm.createContext({
    document,
    window: withWindowLocation ? { location: {} } : {},
    console,
    alert() {},
    confirm() { return false; },
    fetch: fetchImpl || (() => new Promise(() => {})),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    Date,
    Math,
    Object,
    Array,
    JSON,
    Promise,
    encodeURIComponent,
    // loot-finder.js reads this at module scope for MAP_DEFINITIONS.
    DayzMapCoordinates: { MAP_DEFINITIONS: {} },
  });
  const source = fs.readFileSync(path.join(basePath, file), 'utf8');
  vm.runInContext(source, context, { filename: file });
  return context;
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function collectRenderedHtml(rootEl) {
  const parts = [rootEl.innerHTML];
  for (const child of rootEl.children) {
    if (typeof child.innerHTML === 'string') parts.push(child.innerHTML);
  }
  return parts.join('\n');
}

const RAW_TAG = /<script[\s>]|<img[\s>]/i;
const ESCAPED_SCRIPT = '&lt;script&gt;';

function assertNoRawInjection(html, where, ...rawPayloads) {
  assert.ok(!RAW_TAG.test(html),
    `${where} leaked a raw <script>/<img> tag from an API value`);
  for (const payload of rawPayloads) {
    assert.ok(!html.includes(payload),
      `${where} contains the unescaped adversarial value: ${payload}`);
  }
}

function testLootFinderItemCardEscapesNameAndCategory() {
  const ctx = loadScript('loot-finder.js');
  // Populate the module's cached DOM refs from the fake document so the
  // render functions (which read `dom.*`) have real elements to write to.
  ctx.cacheDomElements();
  const doc = ctx.document;

  const malicious = {
    name: ADV_SCRIPT,
    category: [ADV_IMG, ADV_QUOTED],
    values: ['Tier1'],
    nominal: 3,
    min: 1,
    spawnCount: 2,
  };

  ctx.renderItemList([malicious]);
  const listHtml = collectRenderedHtml(doc.getElementById('itemList'));
  assertNoRawInjection(listHtml, 'loot-finder item card', ADV_SCRIPT, ADV_IMG, ADV_QUOTED);
  assert.ok(listHtml.includes(ESCAPED_SCRIPT),
    'loot-finder item card must render the escaped item name');

  ctx.renderItemDetailFull(malicious);
  const detailHtml = doc.getElementById('itemDetail').innerHTML;
  assertNoRawInjection(detailHtml, 'loot-finder item detail', ADV_SCRIPT, ADV_IMG, ADV_QUOTED);
  assert.ok(detailHtml.includes('&lt;img'),
    'loot-finder item detail must escape the category list');
}

function testDashboardActivityFeedEscapesDescription() {
  // Path-aware fetch: /api/user is the script's top-level bootstrap (return
  // not-ok so it bails into its catch and never starts the real load* chain);
  // the activity endpoint returns the adversarial feed we want to render.
  const ctx = loadScript('dashboard.js', {
    withWindowLocation: true,
    fetchImpl: (url) => {
      if (String(url).includes('/api/owner/dashboard/activity')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            activities: [
              { type: 'feed_posted', description: ADV_SCRIPT, timestamp: new Date().toISOString() },
              { type: 'guild_created', description: ADV_IMG, timestamp: new Date().toISOString() },
            ],
          }),
        });
      }
      return Promise.resolve({ ok: false, json: async () => ({}) });
    },
  });

  ctx.loadRecentActivity();
  return flush().then(flush).then(() => {
    const feedHtml = ctx.document.getElementById('activity-feed').innerHTML;
    assertNoRawInjection(feedHtml, 'dashboard activity feed', ADV_SCRIPT, ADV_IMG);
    assert.ok(feedHtml.includes(ESCAPED_SCRIPT),
      'dashboard activity feed must render the escaped description');
  });
}

function main() {
  let failures = 0;

  try {
    testLootFinderItemCardEscapesNameAndCategory();
    console.log('✅ loot-finder item card/detail escape adversarial values');
  } catch (err) {
    failures++;
    console.error('❌ loot-finder sink:', err.message);
  }

  return testDashboardActivityFeedEscapesDescription()
    .then(() => {
      console.log('✅ dashboard activity feed escapes adversarial descriptions');
    })
    .catch((err) => {
      failures++;
      console.error('❌ dashboard feed sink:', err.message);
    })
    .then(() => {
      if (failures) {
        console.error(`\n❌ XSS sink regression failed: ${failures}`);
        process.exit(1);
      }
      console.log('\n✅ XSS sink regression passed');
      // dashboard.js opens a top-level setInterval for its live sync loop, which
      // would otherwise hold the event loop open after the assertions are done.
      process.exit(0);
    });
}

main().catch((err) => {
  console.error('❌ xss-sink-regression-test crashed:', err);
  process.exit(1);
});
