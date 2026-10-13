'use strict';

/*
 * data-tuning-test.js
 *
 * Unit + route tests for the data-driven tuning feature (AI feature 3/7).
 *
 *   - types.xml spawn-config parsing (base + custom merge, malformed-safe)
 *   - loot spawn/despawn imbalance report (despawns vs nominal ratio)
 *   - weapon kill-share + dominance detection (weekly, HHI, top-3)
 *   - hot death-zone grid clustering from kill positions
 *   - economy snapshot upsert + nominal drift/inflation flagging
 *   - deterministic before/after prediction text
 *   - provider-driven suggestion planning reusing the feature-2
 *     parse-and-materialize patch pipeline (stubbed provider, real patch
 *     validation) — every suggestion carries a prediction
 *   - HTTP routes: registered, exact-server gated, deterministic-only when
 *     no provider, and a full handler run against a temp downloads/ tree
 *
 * No external fixture dir required: all working-copy content is built inline
 * so the suite is portable to any checkout.
 */

const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const ROOT = path.join(__dirname, '..');
const svc = require(path.join(ROOT, 'services', 'dataTuningService'));

// ─── Fixtures ────────────────────────────────────────────────────────────────

function fixtureBaseTypes() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<types>',
    '  <type name="TestItem_A">',
    '    <nominal>10</nominal>',
    '    <min>2</min>',
    '    <lifetime>14400</lifetime>',
    '    <restock>1800</restock>',
    '  </type>',
    '  <type name="TestItem_B">',
    '    <nominal>5</nominal>',
    '    <min>1</min>',
    '    <lifetime>14400</lifetime>',
    '    <restock>1800</restock>',
    '  </type>',
    '</types>',
  ].join('\n');
}

function fixtureCustomTypes() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<types>',
    '  <type name="TestItem_B">',
    '    <nominal>9</nominal>',
    '    <min>1</min>',
    '  </type>',
    '  <type name="CustomItem_C">',
    '    <nominal>3</nominal>',
    '    <min>0</min>',
    '  </type>',
    '</types>',
  ].join('\n');
}

function buildTempWorkingCopy(guildId, psid, mapName) {
  const serverRoot = path.join(ROOT, 'downloads', guildId, `server_${psid}`);
  const mapDir = path.join(serverRoot, `dayzOffline.${mapName}`);
  fs.mkdirSync(path.join(mapDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(mapDir, 'custom'), { recursive: true });
  fs.writeFileSync(path.join(mapDir, 'db', 'types.xml'), fixtureBaseTypes());
  fs.writeFileSync(path.join(mapDir, 'custom', 'types.xml'), fixtureCustomTypes());
  fs.writeFileSync(path.join(mapDir, 'cfgrandompresets.xml'),
    '<?xml version="1.0"?>\n<randompresets>\n  <cargo chance="1.0" name="X">\n    <item name="TestItem_A" chance="1.0" />\n  </cargo>\n</randompresets>\n');
  return { serverRoot, mapDir };
}

// ─── Service-level tests ─────────────────────────────────────────────────────

function testParseTypesXml() {
  const base = svc.parseTypesXml(fixtureBaseTypes());
  assert.equal(base.TestItem_A.nominal, 10, 'base nominal parsed');
  assert.equal(base.TestItem_B.min, 1, 'base min parsed');
  assert.deepEqual(svc.parseTypesXml('not xml at all'), {}, 'malformed text -> {} (no crash)');
  assert.deepEqual(svc.parseTypesXml(''), {}, 'empty -> {}');
  console.log('✓ parseTypesXml (parse + malformed-safe)');
}

function testLoadSpawnConfigMerge() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-types-'));
  fs.mkdirSync(path.join(dir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'custom'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'db', 'types.xml'), fixtureBaseTypes());
  fs.writeFileSync(path.join(dir, 'custom', 'types.xml'), fixtureCustomTypes());
  fs.writeFileSync(path.join(dir, 'custom', 'cfgspawnabletypes_misc.xml'),
    '<?xml version="1.0"?>\n<types>\n  <type name="MiscItem_D"><nominal>7</nominal><min>0</min></type>\n</types>\n');
  const cfg = svc.loadSpawnConfig(dir);
  // Base item A kept; B overridden by custom (9); C/D added.
  assert.equal(cfg.items.TestItem_A.nominal, 10);
  assert.equal(cfg.items.TestItem_B.nominal, 9, 'custom overrides base nominal');
  assert.equal(cfg.items.CustomItem_C.nominal, 3, 'custom-only item present');
  assert.equal(cfg.items.MiscItem_D.nominal, 7, 'cfgspawnabletypes file merged');
  assert.ok(cfg.files.includes('db/types.xml'), 'base file listed');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('✓ loadSpawnConfig (base + custom + cfgspawnabletypes merge)');
}

function testDetectActiveMap() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-rpt-'));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'DayZServer_X1_2026-10-10_07-13-12.RPT'),
    ' 07:13:12.000 Storage: mpmissions\\dayzOffline.chernarusplus\\profiles\\\n more lines');
  assert.equal(svc.detectActiveMap(dir), 'chernarusplus', 'map detected from RPT header');
  // No RPT -> null.
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-rpt-empty-'));
  fs.mkdirSync(path.join(emptyDir, 'config'), { recursive: true });
  assert.equal(svc.detectActiveMap(emptyDir), null, 'no RPT -> null');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(emptyDir, { recursive: true, force: true });
  console.log('✓ detectActiveMap (RPT header)');
}

// Stub DB keyed by SQL pattern.
function stubDb(overrides = {}) {
  const log = [];
  const matchers = Object.entries(overrides).map(([k, rows]) => [k instanceof RegExp ? k : new RegExp(k), rows]);
  const db = {
    async query(sql, params) {
      log.push(sql);
      for (const [re, rows] of matchers) {
        if (re.test(sql)) return rows;
      }
      return [];
    },
    async get(sql, params) {
      for (const [re, rows] of matchers) {
        if (re.test(sql)) return rows[0] || null;
      }
      return null;
    },
    log,
  };
  return db;
}

async function testLootReport() {
  const spawnConfig = { items: { TestItem_A: { nominal: 10 }, TestItem_B: { nominal: 9 } }, files: ['db/types.xml'] };
  const db = stubDb({
    'loot_despawn_events': [
      { item_class: 'TestItem_A', despawns: 45 },   // 4.5x -> imbalanced
      { item_class: 'TestItem_B', despawns: 12 },   // 1.33x -> ok
      { item_class: 'UnknownItem', despawns: 99 },  // no nominal -> not imbalanced
    ],
  });
  const report = await svc.lootReport(db, 1, 7, spawnConfig);
  assert.equal(report.area, 'loot');
  assert.equal(report.total, 156);
  assert.equal(report.rows[0].class, 'UnknownItem', 'highest despawns first');
  const a = report.rows.find(r => r.class === 'TestItem_A');
  assert.equal(a.ratio, 4.5);
  assert.ok(a.imbalanced, '4.5x flagged imbalanced');
  const b = report.rows.find(r => r.class === 'TestItem_B');
  assert.ok(!b.imbalanced, '1.33x not imbalanced');
  assert.equal(report.imbalances.length, 1, 'exactly one imbalanced class');
  assert.match(report.summary, /4\.5x/, 'summary cites the ratio');
  console.log('✓ lootReport (ratio + imbalance + summary)');
}

async function testWeaponReport() {
  const db = stubDb({
    "date_trunc\\('week'": [
      { week: '2026-10-05', weapon: 'AK74', kills: 100 },
      { week: '2026-09-28', weapon: 'AK74', kills: 110 },
    ],
    'GROUP BY weapon': [
      { weapon: 'AK74', kills: 210 },   // 0.42 dominant
      { weapon: 'M4A1', kills: 105 },
      { weapon: 'AKM', kills: 105 },
      { weapon: 'SVD', kills: 105 },
      { weapon: 'Mosin9130', kills: 30 },
    ],
    'COUNT\\(\\*\\)': [{ c: 500 }],
  });
  const report = await svc.weaponReport(db, 1, 14);
  assert.equal(report.total, 500);
  assert.equal(report.top[0].weapon, 'AK74');
  assert.equal(report.top[0].share, 0.42);
  assert.equal(report.dominance.dominant.weapon, 'AK74', 'dominant weapon detected');
  assert.ok(report.dominance.top3Share > 0.7, 'top-3 concentration high');
  assert.ok(report.dominance.hhi > 0.2, 'HHI computed');
  assert.equal(report.weekly.length, 2, 'weekly rows returned');
  assert.match(report.summary, /DOMINANT/, 'summary flags dominance');
  console.log('✓ weaponReport (share + dominance + weekly)');
}

async function testDeathzoneReport() {
  // 5 kills clustered near (1000,2000) -> same 100m bin; 2 elsewhere.
  const positions = [];
  for (let i = 0; i < 5; i++) positions.push({ victim_position: `${1000 + i}, ${2000 + i}, 3.0` });
  positions.push({ victim_position: '5000, 5000, 3.0' });
  positions.push({ victim_position: '5010, 5010, 3.0' });
  positions.push({ victim_position: null }); // ignored
  const db = stubDb({ 'victim_position IS NOT NULL': positions });
  const report = await svc.deathzoneReport(db, 1, 7);
  assert.equal(report.total, 7, 'null position excluded');
  assert.equal(report.zones[0].kills, 5, 'hot cluster ranked first');
  assert.equal(report.zones[0].grid, '10,20', 'grid bin computed');
  assert.equal(report.zones[0].center.x, 1002, 'center x averaged');
  assert.equal(report.grid, 100, 'grid size reported');
  console.log('✓ deathzoneReport (grid clustering + ranking)');
}

async function testEconomyReportNoDrift() {
  const spawnConfig = { items: { A: { nominal: 10, min: 2, lifetime: 1, restock: 1 }, B: { nominal: 3, min: 0, lifetime: 1, restock: 1 } }, files: ['db/types.xml'] };
  const db = stubDb({ 'GROUP BY snapshot_date': [{ snapshot_date: '2026-10-10', min_nominal: 3, max_nominal: 10 }] });
  const report = await svc.economyReport(db, 1, spawnConfig);
  assert.equal(report.classes.length, 2);
  assert.equal(report.classes[0].item_class, 'A', 'highest nominal first');
  assert.equal(report.drift.length, 0, 'single snapshot -> no drift');
  // An economy_snapshots upsert was issued.
  assert.ok(db.log.some(s => /INSERT INTO economy_snapshots/i.test(s)), 'snapshot upsert issued');
  assert.match(report.summary, /Only one snapshot/, 'summary explains single snapshot');
  console.log('✓ economyReport (snapshot upsert + no-drift shape)');
}

async function testEconomyReportDrift() {
  const spawnConfig = { items: { A: { nominal: 20, min: 2, lifetime: 1, restock: 1 }, B: { nominal: 5, min: 0, lifetime: 1, restock: 1 } }, files: ['db/types.xml'] };
  const db = stubDb({
    'GROUP BY snapshot_date': [
      { snapshot_date: '2026-09-01', min_nominal: 10, max_nominal: 10 },
      { snapshot_date: '2026-10-10', min_nominal: 5, max_nominal: 20 },
    ],
    'MIN\\(snapshot_date\\)': [{ item_class: 'A', nominal: 10 }],
    'MAX\\(snapshot_date\\)': [{ item_class: 'A', nominal: 20 }],
  });
  const report = await svc.economyReport(db, 1, spawnConfig);
  assert.equal(report.drift.length, 1);
  assert.equal(report.drift[0].from, 10);
  assert.equal(report.drift[0].to, 20);
  assert.equal(report.drift[0].driftPct, 100, 'nominal doubled = +100%');
  assert.equal(report.flags.length, 1, '100% drift flagged');
  assert.match(report.summary, /1 inflating/, 'summary counts inflation');
  console.log('✓ economyReport (drift + inflation flag)');
}

function testDeterministicPrediction() {
  const report = { area: 'loot', days: 7 };
  const suggestion = { filename: 'db/types.xml', diffSummary: { summary: '+1 line(s), -1 line(s)' } };
  const p = svc.deterministicPrediction(report, suggestion);
  assert.match(p, /db\/types\.xml/, 'references the file');
  assert.match(p, /loot report/, 'tells the user how to verify');
  assert.ok(p.length > 40, 'a paragraph, not a token');
  console.log('✓ deterministicPrediction (one-paragraph, grounded)');
}

// ─── Provider-driven suggestion planning (stubbed) ──────────────────────────

async function testPlanSuggestionsStubbed() {
  const dir = buildTempDir();
  const spawnConfig = svc.loadSpawnConfig(dir.mapDir);
  const files = svc.targetFilesForArea('loot', dir.mapDir, spawnConfig);
  assert.ok(files.length >= 1, 'target files resolved');
  assert.ok(files.some(f => f.filename === 'db/types.xml'), 'types.xml targeted');

  const aiService = require(path.join(ROOT, 'services', 'aiService'));
  const originalCall = aiService.callProvider;
  const provider = { type: 'openai-compatible', source: 'user', apiKey: 'k', baseURL: 'https://x.test/v1/', model: 'm' };
  try {
    aiService.callProvider = async () => '```json\n' + JSON.stringify({
      suggestions: [
        {
          file: 'db/types.xml',
          rationale: 'Raise the nominal on TestItem_A to ease spawn/despawn pressure.',
          patch: { kind: 'xml-search-replace', edits: [{ search: '<nominal>10</nominal>', replace: '<nominal>20</nominal>' }] },
        },
      ],
    }) + '\n```';

    const report = { area: 'loot', days: 7, summary: 'TestItem_A imbalanced 4.5x' };
    const suggestions = await svc.planSuggestions('loot', report, files, provider);
    assert.equal(suggestions.length, 1, 'one materialized suggestion');
    assert.equal(suggestions[0].filename, 'db/types.xml');
    assert.match(suggestions[0].suggestedContent, /<nominal>20<\/nominal>/, 'patch applied');
    assert.ok(/^[a-f0-9]{64}$/.test(suggestions[0].baseContentHash), 'base hash present');
    assert.ok(suggestions[0].prediction, 'each suggestion carries a prediction');
    assert.match(suggestions[0].prediction, /loot report/, 'prediction grounded in the report');
  } finally {
    aiService.callProvider = originalCall;
    fs.rmSync(dir.root, { recursive: true, force: true });
  }
  console.log('✓ planSuggestions (stubbed provider, validated patch + prediction)');
}

function buildTempDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-plan-'));
  const mapDir = path.join(root, 'dayzOffline.sakhal');
  fs.mkdirSync(path.join(mapDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(mapDir, 'custom'), { recursive: true });
  fs.writeFileSync(path.join(mapDir, 'db', 'types.xml'), fixtureBaseTypes());
  fs.writeFileSync(path.join(mapDir, 'custom', 'types.xml'), fixtureCustomTypes());
  fs.writeFileSync(path.join(mapDir, 'cfgrandompresets.xml'), '<?xml version="1.0"?>\n<randompresets></randompresets>\n');
  return { root, mapDir };
}

// ─── Route tests ─────────────────────────────────────────────────────────────

function testRoutesRegisteredAndGated() {
  const router = require(path.join(ROOT, 'routes', 'ai'));
  const routes = router.stack
    .filter(layer => layer.route)
    .map(layer => ({ method: layer.route.methods.post ? 'post' : 'get', path: layer.route.path }));
  const has = (m, p) => routes.some(r => r.method === m && r.path === p);
  assert.ok(has('post', '/data-tuning/loot'), 'loot route registered');
  assert.ok(has('post', '/data-tuning/weapons'), 'weapons route registered');
  assert.ok(has('post', '/data-tuning/deathzones'), 'deathzones route registered');
  assert.ok(has('post', '/data-tuning/economy'), 'economy route registered');

  const source = fs.readFileSync(path.join(ROOT, 'routes', 'ai.js'), 'utf8');
  assert.ok(source.includes('ensureAiServerManage'), 'data-tuning routes are server-manage gated');
  assert.ok(source.includes('resolveExistingContainedPath'), 'working-copy reads are contained-path safe');
  assert.ok(source.includes("INSERT INTO ai_suggestion_groups"), 'suggestion groups persisted');
  assert.match(source, /prediction/i, 'prediction column written');
  console.log('✓ routes registered + gated + group/prediction persistence');
}

async function testRouteHandlerEndToEnd() {
  const router = require(path.join(ROOT, 'routes', 'ai'));
  const findHandler = (method, routePath) => {
    const layer = router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
    assert.ok(layer, `route ${method} ${routePath} present`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  };

  const guildId = '789326430571855893';
  const psid = '15580969';
  const mapName = 'sakhal';
  const { serverRoot } = buildTempWorkingCopy(guildId, psid, mapName);

  const capturedGroups = [];
  const db = stubDb({
    'loot_despawn_events': [{ item_class: 'TestItem_A', despawns: 45 }],
  });
  // Record group + suggestion inserts.
  const realQuery = db.query.bind(db);
  db.query = async (sql, params) => {
    if (/INSERT INTO ai_suggestion_groups/i.test(sql)) { capturedGroups.push({ sql, params }); return [{ id: 99 }]; }
    if (/INSERT INTO ai_suggestions/i.test(sql)) return [{ id: 1000 + capturedGroups.length }];
    if (/INSERT INTO economy_snapshots/i.test(sql)) return [];
    return realQuery(sql, params);
  };

  const makeRes = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
  const reqBase = {
    app: { locals: { db } },
    user: { id: 1 },
    platformServerAccess: { serverId: 7, guildId: 1, discordGuildId: guildId, platformServerId: psid },
    params: { platformServerId: psid },
  };

  try {
    // Deterministic-only loot report (no suggest).
    const lootHandler = findHandler('post', '/data-tuning/loot');
    const lootRes = makeRes();
    await lootHandler({ ...reqBase, body: { days: 7, suggest: false, map: mapName } }, lootRes);
    assert.equal(lootRes.statusCode, 200, `loot 200, got ${lootRes.statusCode}: ${JSON.stringify(lootRes.body)}`);
    assert.ok(lootRes.body.report, 'report present');
    assert.equal(lootRes.body.report.map, mapName);
    assert.equal(lootRes.body.suggestions, null, 'no suggest -> null suggestions');
    assert.equal(lootRes.body.report.rows[0].ratio, 4.5, 'deterministic ratio computed');

    // Weapons report deterministic-only.
    const weaponsHandler = findHandler('post', '/data-tuning/weapons');
    const wRes = makeRes();
    const weaponDb = stubDb({ 'GROUP BY weapon': [{ weapon: 'AK74', kills: 200 }], 'COUNT\\(\\*\\)': [{ c: 200 }] });
    await weaponsHandler({ app: { locals: { db: weaponDb } }, user: { id: 1 }, platformServerAccess: reqBase.platformServerAccess, body: { days: 7 } }, wRes);
    assert.equal(wRes.statusCode, 200);
    assert.ok(wRes.body.report, 'weapons report present');
    assert.equal(wRes.body.report.dominance.dominant.weapon, 'AK74', 'weapons deterministic dominance');

    // suggest=true with a stubbed provider -> group + suggestions with prediction.
    const aiProviderService = require(path.join(ROOT, 'services', 'aiProviderService'));
    const aiService = require(path.join(ROOT, 'services', 'aiService'));
    const originalResolve = aiProviderService.resolveUserProvider;
    const originalCall = aiService.callProvider;
    try {
      aiProviderService.resolveUserProvider = async () => ({ type: 'openai-compatible', source: 'user', apiKey: 'k', baseURL: 'https://x.test/v1/', model: 'm' });
      aiService.callProvider = async () => '```json\n' + JSON.stringify({
        suggestions: [{
          file: 'db/types.xml',
          rationale: 'Raise nominal on TestItem_A.',
          patch: { kind: 'xml-search-replace', edits: [{ search: '<nominal>10</nominal>', replace: '<nominal>20</nominal>' }] },
        }],
      }) + '\n```';

      const suggestRes = makeRes();
      await lootHandler({ ...reqBase, body: { days: 7, suggest: true, map: mapName } }, suggestRes);
      assert.equal(suggestRes.statusCode, 200, `suggest 200, got ${suggestRes.statusCode}: ${JSON.stringify(suggestRes.body)}`);
      assert.ok(Array.isArray(suggestRes.body.suggestions), 'suggestions produced');
      assert.equal(suggestRes.body.suggestions[0].group_id, 99, 'group link present');
      assert.ok(suggestRes.body.suggestions[0].prediction, 'suggestion carries a prediction');
      assert.equal(capturedGroups.length, 1, 'a data-tuning group was persisted');
      assert.ok(/'data-tuning'/.test(capturedGroups[0].sql), "group kind is data-tuning");
    } finally {
      aiProviderService.resolveUserProvider = originalResolve;
      aiService.callProvider = originalCall;
    }

    // Bad area is not reachable via a registered route (only the four exist);
    // an unknown map -> 404.
    const badMapRes = makeRes();
    await lootHandler({ ...reqBase, body: { days: 7, map: 'notamap' } }, badMapRes);
    assert.equal(badMapRes.statusCode, 404, 'unknown map -> 404');

    console.log('✓ route handlers end-to-end (temp downloads tree, deterministic + suggested)');
  } finally {
    fs.rmSync(serverRoot, { recursive: true, force: true });
  }
}

async function main() {
  testParseTypesXml();
  testLoadSpawnConfigMerge();
  testDetectActiveMap();
  await testLootReport();
  await testWeaponReport();
  await testDeathzoneReport();
  await testEconomyReportNoDrift();
  await testEconomyReportDrift();
  testDeterministicPrediction();
  await testPlanSuggestionsStubbed();
  testRoutesRegisteredAndGated();
  await testRouteHandlerEndToEnd();
  console.log('\n✅ Data tuning tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
