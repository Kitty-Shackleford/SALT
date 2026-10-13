#!/usr/bin/env node
'use strict';

/*
 * Operations alerts panel test (AI 7c — dashboard ops panel).
 *
 * 1. Module unit tests (public/js/dashboard-ops.js, mocked fetch):
 *    - one server's ops-fetch failure does not blank the panel
 *      (per-server error row; sibling servers render)
 *    - warnings render with severity badges (danger/warning tier) and
 *      "preceded this server's crash on <date>" context when present
 *    - empty state, rollback headline with confirm-gated restore link
 *    - suggestions are ADVISE-ONLY (no apply endpoint in rendered HTML)
 *    - XSS: server-sourced values are escaped in rendered HTML
 *    - runLagRemediation POSTs once and never from a poll cadence
 *      (it is a page-load action, not a widget)
 * 2. Page pins: the ops widget rides the card 4/9 polling loop (no second
 *    interval), dashboard.html carries the panel + freshness indicator.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
const dzcOps = require(path.join(root, 'public', 'js', 'dashboard-ops.js'));

function jsonRes(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

// Fake fetch: per-URL responders; anything not matched rejects (network fail).
function makeFetch(responders) {
  const calls = [];
  return {
    calls,
    fn: (url, opts) => {
      calls.push({ url, opts });
      const responder = responders.find(r => url.indexOf(r.prefix) !== -1);
      if (!responder) return Promise.reject(new Error('network unreachable: ' + url));
      return Promise.resolve(responder.fn(url, opts));
    },
  };
}

const warningsBody = {
  summary: {
    lastCrashAt: '2026-10-11T20:18:53.294Z',
    recentCrashCount: 10,
    ceLoop: { samples: 1604, avgSeconds: 26.89, maxSeconds: 26.9, slowSamples: 1604 },
    activeWarnings: [
      {
        id: 1,
        precursorId: 'ce-loop-slow',
        label: 'Server tick (CE Loop) over budget',
        severity: 'high',
        occurrences: 1604,
        lastSeenAt: '2026-10-11T23:00:00.000Z',
        lastCrashPreceded: { at: '2026-10-11T20:18:53.294Z', occurrences: 10 },
      },
      {
        id: 2,
        precursorId: 'spawn-failed',
        label: 'Repeated object spawn failures',
        severity: 'medium',
        occurrences: 33421,
        lastSeenAt: '2026-10-11T23:00:00.000Z',
        lastCrashPreceded: null,
      },
    ],
  },
};

const rollbackBody = {
  serverId: 7,
  filesAnalyzed: 1,
  backupFiles: 16,
  results: [],
  headline: {
    fileName: 'cfgrandompresets.xml',
    editAt: '2026-10-10T12:00:00.000Z',
    deltaPct: -34.2,
    backupFile: 'cfgrandompresets.xml.1770000000.backup',
    message: 'Your edit to cfgrandompresets.xml at 2026-10-10T12:00:00.000Z degraded tick time ~34.2%. Consider restoring cfgrandompresets.xml.1770000000.backup via the existing restore endpoint.',
  },
};

async function testOneServerFailureDoesNotBlankPanel() {
  // Server 101 fails on both ops endpoints; server 102 is healthy.
  const fetch = makeFetch([
    { prefix: '/api/ai/ops-intelligence/102', fn: () => jsonRes(warningsBody) },
    { prefix: '/api/ai/ops-rollback/102', fn: () => jsonRes(rollbackBody) },
    { prefix: '/api/ai/ops-intelligence/101', fn: () => jsonRes({ error: 'boom' }, false, 500) },
    { prefix: '/api/ai/ops-rollback/101', fn: () => Promise.reject(new Error('network unreachable')) },
  ]);

  const state101 = await dzcOps.fetchOpsForServer('101', fetch.fn);
  const state102 = await dzcOps.fetchOpsForServer('102', fetch.fn);
  state101.serverName = 'Salty 101';
  state102.serverName = 'Salty 102';

  assert.strictEqual(state101.warningsError, 'HTTP 500', 'failed server captures its warnings error');
  assert.ok(state101.rollbackError, 'failed server captures its rollback error');
  assert.deepStrictEqual(state102.summary.activeWarnings.length, 2, 'healthy server keeps its data');

  const html = dzcOps.renderOpsPanel({ 101: state101, 102: state102 }, { 102: { atMs: Date.now(), causes: [], sampleCount: 200, suggestions: [] } });
  assert.ok(html.includes('Salty 102'), 'panel still renders the healthy server');
  assert.ok(html.includes('Server tick (CE Loop) over budget'), 'healthy server warnings render');
  assert.ok(html.includes('Warnings unavailable'), 'failed server shows its own error row');
  assert.ok(html.includes('dzc-error-row'), 'error row uses the card 4/9 panel error pattern');
  assert.ok(html.includes('Salty 101'), 'failed server is still named (not dropped)');
}

async function testWarningBadgesAndPrecededContext() {
  const fetch = makeFetch([
    { prefix: '/api/ai/ops-intelligence/5', fn: () => jsonRes(warningsBody) },
    { prefix: '/api/ai/ops-rollback/5', fn: () => jsonRes({ serverId: 5, filesAnalyzed: 0, backupFiles: 16, results: [], headline: null }) },
  ]);
  const state = await dzcOps.fetchOpsForServer('5', fetch.fn);
  state.serverName = 'SALT XB';
  const html = dzcOps.renderOpsPanel({ 5: state }, {});

  assert.ok(html.includes('data-sev="high"') && html.includes('data-tier="danger"'), 'high warning uses the danger tier badge');
  assert.ok(html.includes('data-sev="medium"') && html.includes('data-tier="warning"'), 'medium warning uses the warning tier badge');
  assert.ok(html.includes('preceded this server\'s crash on'), 'crash-preceded context renders');
  assert.ok(new Date('2026-10-11T20:18:53.294Z').toLocaleString().split(' ')[0] &&
    html.includes(new Date('2026-10-11T20:18:53.294Z').toLocaleString()),
    'preceded context carries the crash date');
  assert.ok(html.includes('1604×'), 'occurrence count renders');
  assert.ok(html.includes('No active warnings') === false, 'warnings present, so no empty line');
}

async function testEmptyAndLoadingStates() {
  const emptyHtml = dzcOps.renderOpsPanel({}, {});
  assert.ok(emptyHtml.includes('No active servers'), 'no servers: honest empty state');

  const noWarnings = dzcOps.renderOpsPanel(
    { 9: { serverId: 9, serverName: 'Quiet', summary: { lastCrashAt: null, recentCrashCount: 0, ceLoop: null, activeWarnings: [] }, warningsError: null, rollback: null, rollbackError: null } },
    { 9: { atMs: Date.now(), causes: [], sampleCount: 12, suggestions: [] } },
  );
  assert.ok(noWarnings.includes('No active warnings'), 'no warnings: honest empty line');
  assert.ok(noWarnings.includes('No lag causes in the last 24h'), 'no causes: honest empty line with sample count');

  const loadingHtml = dzcOps.renderOpsPanel(
    { 9: { serverId: 9, serverName: 'Quiet', summary: { activeWarnings: [] }, warningsError: null, rollback: null, rollbackError: null } },
    {},
  );
  assert.ok(loadingHtml.includes('Lag analysis running…'), 'before the one-shot POST settles, the section says so');
}

async function testRollbackHeadlineWithConfirmGatedLink() {
  const fetch = makeFetch([
    { prefix: '/api/ai/ops-intelligence/7', fn: () => jsonRes(warningsBody) },
    { prefix: '/api/ai/ops-rollback/7', fn: () => jsonRes(rollbackBody) },
  ]);
  const state = await dzcOps.fetchOpsForServer('7', fetch.fn);
  state.serverName = 'SALT XB';
  const html = dzcOps.renderOpsPanel({ 7: state }, {});

  assert.ok(html.includes('degraded tick time ~34.2%'), 'headline degradation renders (server-provided message)');
  const linkMatch = html.match(/<a class="dzc-ops-link dzc-ops-restore-link" href="([^"]+)" data-confirm="[^"]*">/);
  assert.ok(linkMatch, 'restore link renders with data-confirm gate');
  assert.ok(linkMatch[1].includes('/mission-editor?server=7'), 'restore link targets the existing restore-flow page for this server');
  assert.ok(html.includes('restore this version?'), 'asks the question the advisor found');

  // Confirm declined: no navigation.
  let navigated = null;
  const el = { getAttribute: name => (name === 'href' ? '/mission-editor?server=7' : 'confirm?') };
  const okDeclined = dzcOps.gatedRestore(el, { confirm: () => false, navigate: h => { navigated = h; } });
  assert.strictEqual(okDeclined, false, 'declined confirm does not navigate');
  assert.strictEqual(navigated, null, 'no navigation on decline');

  // Confirm accepted: navigates exactly once, to the restore-flow page.
  const okAccepted = dzcOps.gatedRestore(el, { confirm: () => true, navigate: h => { navigated = h; } });
  assert.strictEqual(okAccepted, true, 'accepted confirm navigates');
  assert.strictEqual(navigated, '/mission-editor?server=7', 'navigates to the restore flow');
}

async function testXssEscaping() {
  const evilBody = {
    summary: {
      lastCrashAt: null,
      recentCrashCount: 0,
      ceLoop: null,
      activeWarnings: [{
        label: '"><script>alert(1)</script>',
        severity: 'high',
        occurrences: 3,
        lastCrashPreceded: null,
      }],
    },
  };
  const fetch = makeFetch([
    { prefix: '/api/ai/ops-intelligence/13', fn: () => jsonRes(evilBody) },
    { prefix: '/api/ai/ops-rollback/13', fn: () => jsonRes({ headline: null, backupFiles: 0, filesAnalyzed: 0, results: [] }) },
  ]);
  const state = await dzcOps.fetchOpsForServer('13', fetch.fn);
  state.serverName = '<img src=x onerror=alert(2)>';
  const html = dzcOps.renderOpsPanel({ 13: state }, {});

  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'warning label is escaped');
  assert.ok(html.includes('&lt;img src=x onerror=alert(2)&gt;'), 'server name is escaped');
  assert.ok(!/["'][^"']*<script/i.test(html), 'no raw script tag survives into the HTML');
  assert.strictEqual(dzcOps.escapeHtml(`<b>"a" & 'b'</b>`), '&lt;b&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/b&gt;', 'escapeHtml covers all five specials');
}

async function testSuggestionsAreAdviseOnly() {
  const html = dzcOps.renderOpsPanel(
    { 3: { serverId: 3, serverName: 'S', summary: { activeWarnings: [] }, warningsError: null, rollback: null, rollbackError: null } },
    {
      3: {
        atMs: Date.now(),
        causes: [{ id: 'entity-density', severity: 'high', label: 'Entity density overload', evidence: 'slow ticks', fix: 'cap density' }],
        sampleCount: 200,
        suggestions: [
          { filename: 'cfgrandompresets.xml', diff_summary: 'halve Xmas_Clothes_Small spawn chance 1.0→0.5' },
          { filename: 'server.cfg', diff_summary: 'cap maxPlayers' },
        ],
      },
    },
  );
  assert.ok(html.includes('cfgrandompresets.xml'), 'top suggestion filename renders');
  assert.ok(html.includes('halve Xmas_Clothes_Small spawn chance'), 'suggestion summary renders');
  assert.ok(html.includes('/dashboard/ai-assistant'), 'links out to the config/suggestions page for review');
  assert.ok(!html.includes('/suggestions/') && !html.includes('apply'),
    'panel never references the apply endpoint or an apply action (ADVISE-ONLY)');
  assert.ok(!html.includes('<button'), 'no buttons at all in the panel body');
}

async function testRunLagRemediationPostContract() {
  const calls = [];
  const fetchImpl = (url, opts) => {
    calls.push({ url, opts });
    return Promise.resolve(jsonRes({
      success: true,
      serverId: 11,
      analysis: {
        causes: [
          { id: 'entity-density', severity: 'high', label: 'Entity density overload', evidence: '200/200', fix: 'x', lever: 'loot-infection-density' },
          { id: 'ce-loop-extreme', severity: 'critical', label: 'Extreme tick overrun', evidence: 'max 26.9s', fix: 'x', lever: 'max-players' },
          { id: 'recent-crashes', severity: 'critical', label: '1 crash window(s) in the last 24h', evidence: '…', fix: 'x', lever: 'crash-investigation' },
        ],
        sampleCount: 200,
      },
      suggestionCount: 4,
      savedCount: 4,
      groupId: 42,
      suggestions: [1, 2, 3, 4].map(n => ({ id: n, filename: 'f' + n + '.xml', diff_summary: 's' + n })),
    }));
  };
  const result = await dzcOps.runLagRemediation(11, fetchImpl);
  assert.strictEqual(calls.length, 1, 'exactly one request');
  assert.strictEqual(calls[0].url, '/api/ai/ops-remediation/11', 'POSTs to the per-server remediation endpoint');
  assert.strictEqual(calls[0].opts.method, 'POST', 'remediation is a POST (analysis persists server-side)');
  assert.strictEqual(result.causes.length, 3, 'all causes returned');
  assert.strictEqual(result.suggestions.length, 3, 'top 3 suggestions only');
  assert.strictEqual(result.sampleCount, 200, 'sample count carried for the honest empty state');

  const badFetch = () => Promise.resolve(jsonRes({ error: 'nope' }, false, 500));
  await assert.rejects(() => dzcOps.runLagRemediation(11, badFetch), /HTTP 500/, 'non-OK response rejects');
}

function testOpsAttentionItems() {
  const state = {
    1: {
      serverName: 'A',
      summary: { activeWarnings: [{ label: 'tick slow', severity: 'high', occurrences: 10 }, { label: 'spawns', severity: 'medium', occurrences: 5 }] },
      rollback: { headline: { fileName: 'cfg.xml', deltaPct: -40 } },
    },
    2: {
      serverName: 'B',
      summary: { activeWarnings: [{ label: 'oom', severity: 'critical', occurrences: 1 }] },
      rollback: null,
    },
  };
  const items = dzcOps.opsAttentionItems(state);
  assert.ok(items.length <= 4, 'strip is capped at 4 ops items');
  assert.ok(items.some(i => i.severity === 'danger' && i.text.includes('A: tick slow')), 'high warning -> danger strip item with server prefix');
  assert.ok(items.some(i => i.severity === 'warning' && i.text.includes('rollback advisor')), 'rollback headline -> warning strip item');
  assert.ok(items.every(i => i.icon && i.text), 'every strip item has a non-color cue (icon + text)');
  assert.deepStrictEqual(dzcOps.opsAttentionItems({}), [], 'no ops data -> no strip items');
}

function testPagePins() {
  const js = read('public/js/dashboard.js');
  const html = read('public/dashboard.html');

  // Ops rides the card 4/9 shared loop — no second independent interval.
  assert(/ops:\s*\{\s*intervalMs:\s*WIDGET_INTERVALS\.ops,\s*run:\s*refreshOpsAlerts\s*\}/.test(js),
    'ops must be a widget in the shared polling loop, not its own interval');
  assert(!/setInterval\([^)]*refreshOpsAlerts/.test(js), 'no dedicated setInterval for ops');
  const rawIntervals = (js.match(/setInterval\(/g) || []).length;
  assert.strictEqual(rawIntervals, 1, `only the per-job sync monitor may keep its own interval (found ${rawIntervals})`);
  assert(js.includes('ops: \'dzc-freshness-ops\''), 'ops freshness indicator wired into the loop\'s labels');

  // The lag-cause POST is a page-load action, not a widget.
  assert(js.includes('runOpsRemediationOnce'), 'one-shot remediation exists');
  assert(!/run:\s*runOpsRemediationOnce/.test(js), 'remediation must NOT be a polling widget (it persists groups server-side)');

  for (const marker of [
    'id="ops-alerts-body"',
    'id="dzc-freshness-ops"',
    '/js/dashboard-ops.js',
  ]) {
    assert(html.includes(marker), `dashboard.html missing ${marker}`);
  }
  const opsIdx = html.indexOf('/js/dashboard-ops.js');
  const dashIdx = html.indexOf('/js/dashboard.js');
  assert(opsIdx !== -1 && opsIdx < dashIdx, 'dashboard-ops.js must load before dashboard.js');
}

async function main() {
  let failures = 0;
  const run = (name, fn) => Promise.resolve()
    .then(fn)
    .then(() => console.log(`✅ ${name}`))
    .catch(err => { failures += 1; console.error(`❌ ${name} — ${err.message}`); });

  await run('one server failure does not blank the panel', testOneServerFailureDoesNotBlankPanel);
  await run('warning severity badges + preceded-crash context', testWarningBadgesAndPrecededContext);
  await run('empty / loading states are honest', testEmptyAndLoadingStates);
  await run('rollback headline + confirm-gated restore link', testRollbackHeadlineWithConfirmGatedLink);
  await run('XSS: server-sourced values escaped', testXssEscaping);
  await run('suggestions are advise-only', testSuggestionsAreAdviseOnly);
  await run('runLagRemediation POST contract', testRunLagRemediationPostContract);
  await run('attention strip items (capped, non-color cues)', testOpsAttentionItems);
  await run('page pins (shared loop, no second interval, panel present)', testPagePins);

  if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
  }
  console.log('\nAll dashboard ops panel tests passed.');
}

main();
