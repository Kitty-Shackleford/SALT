'use strict';

/*
 * log-intelligence-test.js
 *
 * Unit tests for the AI log-intelligence feature (RPT / ADM / crash analysis).
 *
 * Covers:
 *   - deterministic signal extraction from realistic RPT lines (CE Loop,
 *     known-issue warnings, shutdown)
 *   - warning clustering / repeated offenders
 *   - crash & restart window building with ranked root-cause candidates
 *   - CE-Loop tick statistics
 *   - "why at moment" RPT-window selection + windowed evidence
 *   - the data-driven known-issue table (seed + operator override merge)
 *   - the full summarizeRptErrors / analyzeMoment pipeline with injected deps
 *   - the HTTP routes: present, exact-server gated, and a real handler run
 *     against a temp downloads/ tree (log-summary GET + log-why POST).
 *
 * No external fixture dir is required: all log content is built inline so the
 * suite is portable to any checkout (the dev-box dayzxb/ dir is NOT used).
 */

const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const ROOT = path.join(__dirname, '..');
const svc = require(path.join(ROOT, 'services', 'logIntelligenceService'));

// ─── Fixtures ────────────────────────────────────────────────────────────────

// A realistic RPT tail: several slow CE Loop ticks, a recurring spawn failure,
// a couple of benign warnings, a scheduled shutdown, and a fatal line.
function fixtureRptLines() {
  return [
    ' 12:00:01.100 Server tick start',
    ' 12:00:05.200   ***  CE Loop took 2.5 (sec)...',
    ' 12:00:05.200 players: 40, loot: 18000, infected: 90, animals: 12',
    ' 12:00:05.300 Error: Failed to spawn Object Litter_Small',
    ' 12:00:12.000   ***  CE Loop took 27.9 (sec)...',
    ' 12:00:12.000 players: 61, loot: 40210, infected: 133, animals: 20',
    ' 12:00:13.000 Error: Failed to spawn Object Litter_Small',
    ' 12:00:20.000 NULL pointer to instance in HumanInventory::Replace',
    ' 12:00:21.000 Error: Animation source anims\\man\\Run not found in bin',
    ' 12:00:30.000 Error: Failed to spawn Object Litter_Small',
    ' 12:00:45.000 [Shutdown] Shutting down in 300 seconds',
    ' 12:01:00.000   ***  CE Loop took 30.1 (sec)...',
    ' 12:01:00.000 players: 88, loot: 52000, infected: 201, animals: 25',
  ];
}

// A crash log block: one fatal exception with a divider.
function fixtureCrashLines() {
  return [
    '2.17 2026 02:17:00:00  DayZ Server crashed',
    'Exception: access violation reading 0x00000000 in module "DayZServer_X1_x64.dll"',
    '----',
    '2.17 2026 02:17:00:05  stack trace line',
  ];
}

function makeInMemoryFs(files) {
  // files: { [filename]: string[] of lines }
  const listFiles = () => Object.keys(files).map(name => ({ name }));
  const readTail = (rootDir, filename, maxBytes) => {
    const lines = files[filename] || [];
    return lines;
  };
  return { listFiles, readTail };
}

// ─── Service-level tests ────────────────────────────────────────────────────

function testExtractSignals() {
  const issues = svc.loadKnownIssues();
  const sig = svc.extractSignals(fixtureRptLines(), issues, '2026-03-05');
  // 3 CE Loop ticks (2.5, 27.9, 30.1)
  assert.equal(sig.ceLoops.length, 3, 'should parse 3 CE Loop samples');
  assert.equal(sig.ceLoops[0].durationSeconds, 2.5);
  assert.equal(sig.ceLoops[0].players, 40);
  assert.equal(sig.ceLoops[0].loot, 18000);
  // 1 shutdown
  assert.equal(sig.shutdowns.length, 1, 'should parse 1 shutdown');
  assert.equal(sig.shutdowns[0].remainingSeconds, 300);
  // spawn-failed x3, one null-pointer, one animation-missing
  const byId = {};
  for (const w of sig.warnings) byId[w.issueId] = (byId[w.issueId] || 0) + 1;
  assert.equal(byId['spawn-failed'], 3, 'spawn-failed should appear 3x');
  assert.equal(byId['null-pointer-script'], 1, 'null-pointer should appear 1x');
  assert.equal(byId['animation-missing'], 1, 'animation-missing should appear 1x');
  assert.ok(sig.firstMs !== null && sig.lastMs !== null, 'should bound the time range');
  console.log('✓ extractSignals');
}

function testClusterAndCrashWindows() {
  const issues = svc.loadKnownIssues();
  const sig = svc.extractSignals(fixtureRptLines(), issues, '2026-03-05');
  const offenders = svc.clusterWarnings(sig.warnings);
  const top = offenders.find(o => o.issueId === 'spawn-failed');
  assert.ok(top, 'spawn-failed should be clustered');
  assert.equal(top.count, 3, 'spawn-failed cluster count should be 3');
  assert.ok(top.actionable, 'spawn-failed is actionable');
  // Ranking puts actionable warnings ahead of benign info; on a count tie the
  // order among them is stable but not id-pinned, so assert the properties.
  assert.ok(offenders[0].actionable, 'the lead offender is actionable');
  assert.ok(['warning', 'fatal'].includes(offenders[0].severity), 'lead offender is a warning/fatal, not info');
  assert.ok(offenders.slice(0, 2).some(o => o.issueId === 'spawn-failed'), 'a repeated actionable offender surfaces near the top');
  // Benign info issues (animation-missing) must be ranked below actionable warnings.
  const animRank = offenders.findIndex(o => o.issueId === 'animation-missing');
  const spawnRank = offenders.findIndex(o => o.issueId === 'spawn-failed');
  assert.ok(animRank > spawnRank, 'benign info ranks below actionable warning');

  // A fatal signal forces a crash window.
  const fatal = [{ issueId: 'fatal-exception', severity: 'fatal', title: 'Fatal', actionable: true, atMs: sig.lastMs, sample: 'Exception' }];
  const windows = svc.buildCrashWindows([...sig.warnings, ...fatal], sig.shutdowns);
  assert.ok(windows.length >= 1, 'should produce at least one window');
  const last = windows[windows.length - 1];
  assert.ok(Array.isArray(last.rootCauseCandidates) && last.rootCauseCandidates.length > 0, 'window should carry root-cause candidates');
  console.log('✓ clusterWarnings + buildCrashWindows');
}

function testCeLoopStats() {
  const loops = [
    { atMs: 1000, durationSeconds: 2.5, players: 40, loot: 1, infected: 1 },
    { atMs: 2000, durationSeconds: 27.9, players: 61, loot: 2, infected: 2 },
    { atMs: 3000, durationSeconds: 30.1, players: 88, loot: 3, infected: 3 },
  ];
  const stats = svc.ceLoopStats(loops);
  assert.equal(stats.samples, 3);
  assert.equal(stats.slowSamples, 3, 'all three are >=2s');
  assert.ok(Math.abs(stats.avgSeconds - (2.5 + 27.9 + 30.1) / 3) < 0.01, 'avg computed');
  assert.equal(stats.maxSeconds, 30.1, 'max computed');
  assert.equal(stats.slowest[0].durationSeconds, 30.1, 'slowest is the 30.1s tick');
  assert.equal(svc.ceLoopStats([]), null, 'no samples -> null');
  console.log('✓ ceLoopStats');
}

function testKnownIssuesOverride() {
  const table = svc.loadKnownIssues();
  assert.ok(table.some(i => i.id === 'ce-loop-slow'), 'seed has ce-loop-slow');
  assert.ok(table.some(i => i.id === 'oom-crash'), 'seed has oom-crash');
  // Operator override file adds a new id and replaces an existing one.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'li-issues-'));
  const overridePath = path.join(dir, 'issues.json');
  fs.writeFileSync(overridePath, JSON.stringify({
    issues: [
      { id: 'oom-crash', title: 'OOM (custom)', severity: 'fatal', patterns: ['out of memory'], actionable: true },
      { id: 'my-custom', title: 'Custom', severity: 'warning', patterns: ['my-custom-marker'], actionable: true },
    ],
  }));
  const merged = svc.loadKnownIssues(overridePath);
  const oom = merged.find(i => i.id === 'oom-crash');
  assert.equal(oom.title, 'OOM (custom)', 'override replaces by id');
  assert.ok(merged.some(i => i.id === 'my-custom'), 'override adds a new id');
  assert.ok(merged.some(i => i.id === 'spawn-failed'), 'seed ids not overridden are preserved');
  // Malformed override must never break analysis.
  fs.writeFileSync(overridePath, '{ not json');
  const safe = svc.loadKnownIssues(overridePath);
  assert.ok(safe.some(i => i.id === 'ce-loop-slow'), 'malformed override falls back to seed');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('✓ loadKnownIssues (seed + override + malformed-safe)');
}

function testSummarizePipeline() {
  const files = {
    'DayZServer_X1_x64_2026-03-05_12-00-00.RPT': fixtureRptLines(),
    'crash_2026-02-19_00-44-35.log': fixtureCrashLines(),
  };
  const fsStub = makeInMemoryFs(files);
  const summary = svc.summarizeRptErrors({ ...fsStub, configDir: '/tmp/fake-config' });
  assert.equal(summary.filesScanned.length, 1, 'only the RPT file is in filesScanned');
  assert.equal(summary.filesScanned[0].file, 'DayZServer_X1_x64_2026-03-05_12-00-00.RPT');
  assert.ok(summary.totalWarnings >= 5, 'warnings aggregated across RPT');
  assert.ok(summary.repeatedOffenders.some(o => o.issueId === 'spawn-failed'), 'offenders include spawn-failed');
  assert.ok(summary.crashWindows.length >= 1, 'a fatal crash produces a window');
  assert.equal(summary.ceLoop.samples, 3, 'CE Loop stats from the RPT tail');
  // The digest is bounded and grounded (mentions real content).
  const digest = svc.buildAiDigest(summary);
  assert.ok(digest.length <= 24000 + 16, 'digest stays bounded');
  assert.ok(/CE Loop/.test(digest) || /tick/.test(digest), 'digest mentions tick data');
  console.log('✓ summarizeRptErrors pipeline');
}

function testWhyAtMoment() {
  const files = {
    'DayZServer_X1_x64_2026-03-05_12-00-00.RPT': fixtureRptLines(),
    'DayZServer_X1_x64_2026-03-05_20-00-00.RPT': [
      ' 20:00:01.000   ***  CE Loop took 29.0 (sec)...',
      ' 20:00:01.000 players: 90, loot: 60000, infected: 210, animals: 30',
      ' 20:00:02.000 Error: Failed to spawn Object Litter_Big',
    ],
  };
  const fsStub = makeInMemoryFs(files);
  // Moment inside the second file's lifetime.
  const atMs = Date.parse('2026-03-05T20:00:30.000Z');
  const result = svc.whyAtMoment({ ...fsStub, configDir: '/tmp/fake-config', atMs });
  assert.ok(result.tickSamples >= 1, 'should find tick samples in window');
  assert.ok(result.topWarnings.some(o => o.issueId === 'ce-loop-slow'), 'ce-loop-slow should be a top warning in window');
  assert.ok(result.rootCauseCandidates.length >= 1, 'should rank root-cause candidates');
  // window.since / window.until are ISO strings; parse back to compare.
  assert.ok(Date.parse(result.window.since) < atMs && Date.parse(result.window.until) > atMs, 'window should straddle the moment');
  // A moment far after all files -> still returns a coherent (possibly empty) shape.
  const late = svc.whyAtMoment({ ...fsStub, configDir: '/tmp/fake-config', atMs: Date.parse('2026-04-01T00:00:00Z') });
  assert.ok(late && Array.isArray(late.rootCauseCandidates), 'late moment returns a shape, not a throw');
  console.log('✓ whyAtMoment (window selection + evidence)');
}

async function testAnalyzeMomentWithStubDb() {
  const files = { 'DayZServer_X1_x64_2026-03-05_12-00-00.RPT': fixtureRptLines() };
  const fsStub = makeInMemoryFs(files);
  const seen = [];
  const db = {
    async query(sql, params) {
      seen.push(sql.slice(0, 30));
      if (/rpt_telemetry_events/.test(sql)) return [{ observed_at: new Date(params[2]).toISOString(), payload: { durationSeconds: 28.5 } }];
      if (/player_sessions/.test(sql)) return [{ login_at: new Date(params[3]).toISOString(), logout_at: null }];
      return [];
    },
    // kill/death counts are read via db.get (single row) — return the count row.
    async get(sql) {
      if (/kill_events/.test(sql)) return { c: 12 };
      if (/player_death_events/.test(sql)) return { c: 4 };
      return null;
    },
  };
  const atMs = Date.parse('2026-03-05T12:00:20.000Z');
  const result = await svc.analyzeMoment({ ...fsStub, configDir: '/tmp/fake-config', db, serverId: 7, atMs }, null, 'why?');
  assert.ok(Array.isArray(result.rootCauseCandidates), 'analyzeMoment returns candidates');
  assert.ok(result.dbEvidence && Array.isArray(result.dbEvidence.ceLoopRows), 'DB CE-Loop rows attached');
  assert.equal(result.dbEvidence.killsInWindow, 12, 'kill count from DB');
  assert.equal(result.dbEvidence.deathsInWindow, 4, 'death count from DB');
  assert.ok(seen.length >= 2, 'expected DB queries (telemetry + sessions) were issued');
  assert.equal(result.aiExplanation, null, 'no provider -> null AI explanation');
  console.log('✓ analyzeMoment with DB enrichment (no AI)');
}

// ─── Route tests ─────────────────────────────────────────────────────────────

function testRoutesRegisteredAndGated() {
  const router = require(path.join(ROOT, 'routes', 'ai'));
  const routes = router.stack
    .filter(layer => layer.route)
    .map(layer => ({ method: layer.route.methods.get ? 'get' : 'post', path: layer.route.path }));
  const get = (m, p) => routes.some(r => r.method === m && r.path === p);
  assert.ok(get('get', '/log-summary/:platformServerId'), 'log-summary GET route registered');
  assert.ok(get('post', '/log-summary/:platformServerId/explain'), 'log-summary explain route registered');
  assert.ok(get('post', '/log-why/:platformServerId'), 'log-why route registered');

  // All :platformServerId routes are gated by the param hook (ensureAiServerManage).
  const source = fs.readFileSync(path.join(ROOT, 'routes', 'ai.js'), 'utf8');
  assert.ok(source.includes("router.param('platformServerId', ensureAiServerManage)"), 'platformServerId param gate present');
  // The AI layers must go through the provider resolver + shared-router quota.
  assert.ok(source.includes('aiProviderService.resolveUserProvider'), 'routes resolve the provider via the resolver');
  assert.ok(source.includes('aiSharedRouterService.consumeCall'), 'routes consume the shared-router daily quota');
  assert.ok(source.includes('resolveExistingContainedPath'), 'config dir resolution is contained-path safe');
  console.log('✓ routes registered + exact-server gated + provider/quota wired');
}

async function testRouteHandlerEndToEnd() {
  const router = require(path.join(ROOT, 'routes', 'ai'));
  const findHandler = (method, routePath) => {
    const layer = router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
    assert.ok(layer, `route ${method} ${routePath} present`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  };

  // Build a temp downloads/<guild>/server_<psid>/config tree with real files.
  const guildId = '789326430571855893';
  const psid = '15580969';
  const downloadsRoot = path.join(ROOT, 'downloads');
  const configDir = path.join(downloadsRoot, guildId, `server_${psid}`, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  const rptName = 'DayZServer_X1_x64_2026-03-05_12-00-00.RPT';
  fs.writeFileSync(path.join(configDir, rptName), fixtureRptLines().join('\n'));
  const crashName = 'crash_2026-02-19_00-44-35.log';
  fs.writeFileSync(path.join(configDir, crashName), fixtureCrashLines().join('\n'));

  // The route handlers mutate the `res` mock they are given (res.json) and
  // return undefined, so capture the mock and inspect it after the await.
  const makeRes = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
  const access = { serverId: 7, guildId: 1, discordGuildId: guildId, platformServerId: psid };
  const db = { async query() { return []; }, async get() { return null; } };
  const reqBase = { app: { locals: { db } }, user: { id: 1 }, platformServerAccess: access, params: { platformServerId: psid } };

  try {
    // GET /log-summary/:platformServerId
    const summaryHandler = findHandler('get', '/log-summary/:platformServerId');
    const sumRes = makeRes();
    await summaryHandler({ ...reqBase, body: {} }, sumRes);
    assert.equal(sumRes.statusCode, 200, `log-summary should 200, got ${sumRes.statusCode}: ${JSON.stringify(sumRes.body)}`);
    assert.ok(sumRes.body && sumRes.body.summary, 'summary present');
    assert.equal(sumRes.body.summary.ceLoop.samples, 3, 'real RPT tail yields 3 CE Loop samples');
    assert.ok(sumRes.body.summary.repeatedOffenders.some(o => o.issueId === 'spawn-failed'), 'offenders from real file');

    // POST /log-why/:platformServerId
    const whyHandler = findHandler('post', '/log-why/:platformServerId');
    const whyRes = makeRes();
    await whyHandler({ ...reqBase, body: { atMs: Date.parse('2026-03-05T12:00:20Z') } }, whyRes);
    assert.equal(whyRes.statusCode, 200, `log-why should 200, got ${whyRes.statusCode}: ${JSON.stringify(whyRes.body)}`);
    assert.ok(whyRes.body.analysis && Array.isArray(whyRes.body.analysis.rootCauseCandidates), 'log-why analysis present');
    assert.ok(whyRes.body.at, 'log-why echoes the moment');
    assert.equal(whyRes.body.providerConfigured, false, 'no provider configured -> deterministic only');

    // Missing atMs -> 400.
    const badRes = makeRes();
    await whyHandler({ ...reqBase, body: {} }, badRes);
    assert.equal(badRes.statusCode, 400, 'log-why requires atMs');

    // POST /log-summary/:platformServerId/explain (no provider) -> 200, deterministic, null prose.
    const explainHandler = findHandler('post', '/log-summary/:platformServerId/explain');
    const expRes = makeRes();
    await explainHandler({ ...reqBase, body: { question: 'why the lag?' } }, expRes);
    assert.equal(expRes.statusCode, 200, `explain should 200, got ${expRes.statusCode}: ${JSON.stringify(expRes.body)}`);
    assert.equal(expRes.body.aiExplanation, null, 'no provider -> null explanation');
    assert.ok(expRes.body.summary, 'explain still returns the deterministic summary');

    console.log('✓ route handlers end-to-end (temp downloads/ tree)');
  } finally {
    // Clean up the temp tree so the suite leaves no residue.
    fs.rmSync(path.join(downloadsRoot, guildId), { recursive: true, force: true });
  }
}

async function main() {
  testExtractSignals();
  testClusterAndCrashWindows();
  testCeLoopStats();
  testKnownIssuesOverride();
  testSummarizePipeline();
  testWhyAtMoment();
  await testAnalyzeMomentWithStubDb();
  testRoutesRegisteredAndGated();
  await testRouteHandlerEndToEnd();
  console.log('\n✅ Log intelligence tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
