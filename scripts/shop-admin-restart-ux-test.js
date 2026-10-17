/**
 * shop-admin-restart-ux-test.js
 *
 * Hermetic gate for the admin shop restart UX:
 *  - routes/shop.js exposes GET /admin/restarts/:serverId (owner-gated) and
 *    keeps the owner-restart recording route intact
 *  - shop-admin.html ships the Restarts tab with the counting explainer,
 *    the owner-restart recording button, and the rentals/orders explainers
 *  - shop-admin.js renders restart rows (type badge + rental consumption)
 *    and records owner restarts through the CSRF-protected route, with
 *    stale-context guards
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

let passed = 0;
function ok(condition, message) {
  assert(condition, message);
  passed += 1;
}

function routeBlock(source, marker) {
  const start = source.indexOf(marker);
  assert(start >= 0, `routes/shop.js must define ${marker}`);
  return source.slice(start, source.indexOf('module.exports', start));
}

function testRestartsHistoryRouteIsOwnerGated() {
  const source = read('routes/shop.js');
  const route = routeBlock(source, "router.get('/admin/restarts/:serverId'");

  ok(route.includes('verifyServerOwner(db, req.user.id, serverId)'),
    'GET /admin/restarts/:serverId must require owner/admin of the exact server');
  ok(route.includes('FROM server_restart_log srl'),
    'restart history must read the recorded server restart log');
  ok(route.includes('FROM shop_rental_consumption_events srce'),
    'restart history must join the durable rental consumption evidence');
  ok(route.includes('ORDER BY srl.detected_at DESC NULLS LAST, srl.id DESC'),
    'restart history must be newest-first with a stable tiebreak');
  ok(route.includes('LIMIT 100'),
    'restart history must be capped so a long-running server cannot flood the admin view');
  ok(route.includes('IN (${placeholders})'),
    'consumption lookup must bind restart ids as placeholders, not interpolation');
  ok(route.includes('consumption: consumptionByRestart.get(row.id) || []'),
    'restarts without consumption must still render with an empty list');
}

function testOwnerRestartRouteStaysSerialized() {
  const source = read('routes/shop.js');
  const route = routeBlock(source, "router.post('/admin/server/:serverId/restart'");

  ok(route.includes('assertServerOwnerForMutation('),
    'owner restart authorization is not transaction-bound');
  ok(route.includes('await shopRestartService.recordOwnerRestart(transactionDb, serverId);'),
    'owner restart markers are not serialized transactionally');
}

function testAdminHtmlShipsRestartsTabAndExplainers() {
  const html = read('public/dashboard/shop-admin.html');

  ok(html.includes('id="tab-btn-restarts"'), 'shop admin is missing the Restarts tab button');
  ok(html.includes('id="tab-restarts"'), 'shop admin is missing the Restarts tab panel');
  ok(html.includes('id="restarts-tbody"'), 'shop admin is missing the restart history table body');
  ok(html.includes('id="record-owner-restart-btn"'),
    'shop admin has no control to record an owner-triggered restart');
  ok(html.includes('id="restart-status"'), 'shop admin has no feedback slot for owner restart recording');
  ok(html.includes('How rental restarts are counted'),
    'shop admin does not explain how rental restarts are counted');
  ok(/scheduled[\s\S]{0,400}do not count/.test(html),
    'shop admin does not state which restart types consume rentals and which do not');
  ok(html.includes('The next detected restart within 10 minutes'),
    'shop admin does not document the owner-restart correlation window');
  ok(html.includes('Normal refunds are prorated from unused scheduled restarts'),
    'shop admin does not connect the rental counter to refund proration');
  ok(html.includes('expand an order for per-line evidence'),
    'shop admin does not explain the fulfillment states on the orders tab');
}

function testAdminJsWiresRestartsTab() {
  const js = read('public/js/shop-admin.js');

  ok(/ALL_TABS\s*=\s*\[[^\]]*'restarts'[^\]]*\]/.test(js),
    'shop admin tab switching does not include the restarts tab');
  ok(js.includes("loadRestarts();") && js.includes("loadRadarAudit();"),
    'server selection does not load the restart history');
  ok(js.includes("getElementById('restarts-tbody')"),
    'shop admin does not render the restart history table');
  ok(js.includes("getElementById('restart-status')"),
    'shop admin does not surface owner restart recording feedback');
  ok(js.includes("fetchWithCsrf('/api/shop/admin/server/' + serverId + '/restart'"),
    'owner restart recording must use the CSRF-protected owner restart route');
  ok(js.includes("fetch('/api/shop/admin/restarts/' + serverId)"),
    'restart history must come from the owner-gated restarts route');
  for (const type of ['scheduled', 'owner_triggered', 'crash']) {
    ok(js.includes(type), `restart badge mapping is missing the ${type} type`);
  }
  const loadBlock = js.slice(js.indexOf('async function loadRestarts'), js.indexOf('// \u2500\u2500 Restarts') === -1
    ? js.indexOf('// \u2500\u2500 Trusted radar audit')
    : js.length);
  ok(loadBlock.includes('adminContextGeneration') && loadBlock.includes('nextAdminRequestId(\'restarts\')'),
    'restart history loading lacks the stale-response generation guard');
}

async function testRestartRowRendering() {
  const js = read('public/js/shop-admin.js');

  const elements = {};
  const makeElement = id => elements[id] || (elements[id] = {
    innerHTML: '',
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    style: {},
    dataset: {},
    children: [],
    classList: { toggle() {}, add() {}, remove() {} },
    appendChild(child) { this.children.push(child); },
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });
  const rows = [];
  const tbody = makeElement('restarts-tbody');
  tbody.appendChild = child => rows.push(child);

  let fetchCalls = 0;
  const context = vm.createContext({
    console,
    document: {
      addEventListener() {},
      getElementById: makeElement,
      createElement: () => ({ innerHTML: '', className: '', dataset: {} }),
      querySelectorAll: () => [],
    },
    fetch: async url => {
      fetchCalls += 1;
      assert(String(url).startsWith('/api/shop/admin/restarts/'),
        `restart history must hit the admin restarts route, got ${url}`);
      return {
        ok: true,
        json: async () => ({
          success: true,
          data: [
            {
              id: 11,
              restart_type: 'scheduled',
              detected_at: '2026-10-17T03:00:00.000Z',
              provider_started_at: '2026-10-17T03:00:00.000Z',
              evidence_source_file: 'config/server.log',
              consumption: [{
                player_name: 'Salt',
                item_name: 'C130 Wreck',
                previous_restarts_remaining: 3,
                resulting_restarts_remaining: 2,
              }],
            },
            {
              id: 10,
              restart_type: 'owner_triggered',
              detected_at: null,
              provider_started_at: null,
              evidence_source_file: null,
              consumption: [],
            },
          ],
        }),
      };
    },
    fetchWithCsrf: async () => ({ ok: true, json: async () => ({}) }),
    confirm: () => true,
    alert() {},
    prompt: () => null,
  });
  vm.runInContext(`${js}\n    currentServerId = '7';\n    adminContextGeneration = 1;\n    loadRestarts();`, context);
  await new Promise(resolve => setImmediate(resolve));

  ok(fetchCalls === 1, 'restart history load must issue exactly one request per server selection');
  assert.strictEqual(rows.length, 2, 'one row per recorded restart');
  const scheduledRow = rows[0].innerHTML;
  ok(scheduledRow.includes('Scheduled'), 'scheduled restart badge missing');
  ok(scheduledRow.includes('Salt \u2014 C130 Wreck: 3 \u2192 2 remaining'),
    'consumption must show player, item, and before/after counters');
  const ownerRow = rows[1].innerHTML;
  ok(ownerRow.includes('Owner-triggered'), 'owner-triggered restart badge missing');
  ok(ownerRow.includes('None (no rental restarts consumed)'),
    'owner-triggered restarts must state that no rentals were consumed');
}

async function testOwnerRestartRecordingFlow() {
  const js = read('public/js/shop-admin.js');

  const elements = {};
  const makeElement = id => elements[id] || (elements[id] = {
    innerHTML: '',
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    style: {},
    dataset: {},
    children: [],
    classList: { toggle() {}, add() {}, remove() {} },
    appendChild() {},
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });

  let postCalls = 0;
  let postUrl = '';
  const statuses = [];
  const context = vm.createContext({
    console,
    document: {
      addEventListener() {},
      getElementById: makeElement,
      createElement: () => ({ innerHTML: '', className: '', dataset: {} }),
      querySelectorAll: () => [],
    },
    fetch: async () => ({ ok: true, json: async () => ({ data: [] }) }),
    fetchWithCsrf: async (url, options) => {
      postCalls += 1;
      postUrl = url;
      assert(options && options.method === 'POST', 'owner restart recording must be a POST');
      return { ok: true, json: async () => ({ success: true }) };
    },
    confirm: () => true,
    alert: message => statuses.push(message),
    prompt: () => null,
  });
  vm.runInContext(`${js}\n    currentServerId = '7';\n    adminContextGeneration = 1;\n    recordPromise = recordOwnerRestart();`, context);
  await context.recordPromise;

  ok(postCalls === 1, 'owner restart recording must call the API exactly once');
  ok(postUrl === '/api/shop/admin/server/7/restart',
    `owner restart must target the owner restart route, got ${postUrl}`);
  ok(String(elements['restart-status'].textContent).includes('Owner restart recorded'),
    'successful recording must surface a confirmation in the UI');
  ok(statuses.length === 0, 'successful recording must not surface an error dialog');
}

async function testStaleOwnerRestartResponseIsDropped() {
  const js = read('public/js/shop-admin.js');

  const elements = {};
  const makeElement = id => elements[id] || (elements[id] = {
    innerHTML: '',
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    style: {},
    dataset: {},
    children: [],
    classList: { toggle() {}, add() {}, remove() {} },
    appendChild() {},
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  });

  let resolvePostBody;
  const postBody = new Promise(resolve => { resolvePostBody = resolve; });
  const context = vm.createContext({
    console,
    document: {
      addEventListener() {},
      getElementById: makeElement,
      createElement: () => ({ innerHTML: '', className: '', dataset: {} }),
      querySelectorAll: () => [],
    },
    fetch: async () => ({ ok: true, json: async () => ({ data: [] }) }),
    fetchWithCsrf: async () => postBody,
    confirm: () => true,
    alert() {},
    prompt: () => null,
  });
  vm.runInContext(`${js}\n    currentServerId = '7';\n    adminContextGeneration = 1;\n    recordPromise = recordOwnerRestart();`, context);
  vm.runInContext("adminContextGeneration++; currentServerId = '8';", context);
  resolvePostBody({ ok: true, json: async () => ({ success: true }) });
  await context.recordPromise;

  ok(!String(elements['restart-status'].textContent).includes('Owner restart recorded'),
    'a response body resolved after a server switch must not display a stale confirmation');
}

(async () => {
  testRestartsHistoryRouteIsOwnerGated();
  testOwnerRestartRouteStaysSerialized();
  testAdminHtmlShipsRestartsTabAndExplainers();
  testAdminJsWiresRestartsTab();
  await testRestartRowRendering();
  await testOwnerRestartRecordingFlow();
  await testStaleOwnerRestartResponseIsDropped();
  console.log(`✅ Shop admin restart UX suite passed: ${passed}/${passed} assertions`);
})().catch(err => {
  console.error('❌ Shop admin restart UX suite failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
