'use strict';

/*
 * nl-admin-test.js
 *
 * Unit + route tests for the natural-language admin feature (AI feature 4/7):
 *
 *   - query planner whitelist: out-of-whitelist templates, tables, columns
 *     and params are REJECTED (adversarial plans), valid plans normalize
 *     with default ordering
 *   - bounded execution: templates run through the standard read-only db
 *     adapter, server-scoped, rows capped
 *   - provider planning (stubbed): fenced JSON in, validated plan out;
 *     malformed / "none" / out-of-whitelist provider output is rejected
 *   - action planner: resolver catalog (open reports, near-last-kill,
 *     top killer, explicit gamertag) resolves deterministic targets with
 *     evidence; action/resolver mismatches are rejected
 *   - confirm gate: a plan never executes without explicit per-action
 *     confirmation (409 + unconfirmed list); unknown/stale plan -> 404;
 *     execution drives the EXISTING ownerDashboard handler (no new mutation
 *     path — proven by the handler 404-ing on a stubbed token lookup)
 *   - routes registered + ensureAiServerManage gated; nl-config reuses the
 *     card-1/2 suggestion pipeline (stubbed provider, patch materialized)
 *
 * No external fixtures: all content is built inline.
 */

const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');

if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);

const ROOT = path.join(__dirname, '..');
const nlQuery = require(path.join(ROOT, 'services', 'nlQueryPlannerService'));
const nlAction = require(path.join(ROOT, 'services', 'nlActionPlannerService'));

// ─── Stub helpers ────────────────────────────────────────────────────────────

function stubDb(overrides = {}) {
  const log = [];
  const matchers = Object.entries(overrides).map(([k, rows]) => [new RegExp(k), rows]);
  const db = {
    async query(sql, params) {
      log.push({ sql, params });
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

const makeRes = () => ({
  statusCode: 200,
  body: null,
  status(c) { this.statusCode = c; return this; },
  json(b) { this.body = b; return this; },
});

function findHandler(router, method, routePath) {
  const layer = router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  assert.ok(layer, `route ${method} ${routePath} present`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

const reqBase = () => ({
  app: { locals: { db: stubDb() } },
  user: { id: 1 },
  platformServerAccess: { serverId: 7, guildId: 1, discordGuildId: '789326430571855893', platformServerId: '15580969' },
  params: { platformServerId: '15580969' },
});

function stubProvider(fn) {
  const aiService = require(path.join(ROOT, 'services', 'aiService'));
  const aiProviderService = require(path.join(ROOT, 'services', 'aiProviderService'));
  const originalCall = aiService.callProvider;
  const originalResolve = aiProviderService.resolveUserProvider;
  aiService.callProvider = fn;
  aiProviderService.resolveUserProvider = async () => ({
    type: 'openai-compatible', source: 'user', apiKey: 'test-key', baseURL: 'https://x.test/v1/', model: 'm',
  });
  return () => { aiService.callProvider = originalCall; aiProviderService.resolveUserProvider = originalResolve; };
}

// ─── Query planner: whitelist rejection (adversarial) ────────────────────────

function testQueryWhitelistRejection() {
  // Unknown template.
  assert.throws(() => nlQuery.validatePlan({ template: 'drop_everything' }), e => e.code === 'NL_QUERY_TEMPLATE_NOT_WHITELISTED');
  // Provider names a non-whitelisted table.
  assert.throws(
    () => nlQuery.validatePlan({ template: 'killers_by_count', tables: ['servers'] }),
    e => e.code === 'NL_QUERY_TABLE_NOT_WHITELISTED'
  );
  // Provider names a non-whitelisted column.
  assert.throws(
    () => nlQuery.validatePlan({ template: 'killers_by_count', columns: ['password'] }),
    e => e.code === 'NL_QUERY_COLUMN_NOT_WHITELISTED'
  );
  // Unknown param key.
  assert.throws(
    () => nlQuery.validatePlan({ template: 'killers_by_count', params: { orderBy: 'x' } }),
    e => e.code === 'NL_QUERY_PARAM_NOT_WHITELISTED'
  );
  // Out-of-range param.
  assert.throws(
    () => nlQuery.validatePlan({ template: 'killers_by_count', params: { days: 9999 } }),
    e => e.code === 'NL_QUERY_PARAM_OUT_OF_RANGE'
  );
  // SQL injection attempt smuggled through a string param is rejected (no
  // string params exist in any template — every param is typed int).
  assert.throws(
    () => nlQuery.validatePlan({ template: 'killers_by_count', params: { days: "1; DROP TABLE kill_events--" } }),
    e => e.code === 'NL_QUERY_PARAM_OUT_OF_RANGE'
  );
  // Valid plan normalizes with defaults in spec order.
  const plan = nlQuery.validatePlan({ template: 'killers_by_count', params: { limit: 5 } });
  assert.deepEqual(plan.params, { days: 7, limit: 5 }, 'defaults applied, spec order');
  assert.deepEqual(nlQuery.buildParams(plan, 7), [7, 7, 5], 'serverId first, then params');
  // Every whitelisted template/param pair is executable (no throw).
  for (const [name, spec] of Object.entries(nlQuery.QUERY_TEMPLATES)) {
    const p = nlQuery.validatePlan({ template: name });
    assert.ok(nlQuery.buildParams(p, 1).length >= 1, `${name} params build`);
  }
  console.log('✓ query planner rejects out-of-whitelist (adversarial plans)');
}

async function testQueryBoundedExecution() {
  const db = stubDb({
    'FROM kill_events': [
      { gamertag: 'PlayerA', platform: 'xbox', kills: 30, last_kill: '2026-10-10T00:00:00Z' },
      { gamertag: 'PlayerB', platform: 'xbox', kills: 20, last_kill: '2026-10-09T00:00:00Z' },
    ],
  });
  const plan = nlQuery.validatePlan({ template: 'killers_by_count', params: { days: 7, limit: 2 } });
  const result = await nlQuery.executeQuery(db, 7, plan);
  assert.equal(result.template, 'killers_by_count');
  assert.equal(result.rows.length, 2);
  assert.equal(db.log.length, 1, 'exactly one db call');
  assert.deepEqual(db.log[0].params, [7, 7, 2], 'server-scoped, parameterized');
  // Row cap: even a "huge" result set is bounded to 100 rows.
  const bigDb = stubDb({ 'FROM kill_events': Array.from({ length: 500 }, (_, i) => ({ i })) });
  const capped = await nlQuery.executeQuery(bigDb, 7, plan);
  assert.equal(capped.rows.length, 100, 'rows capped at 100');
  console.log('✓ bounded execution (read-only, server-scoped, capped)');
}

async function testPlanQueryStubbed() {
  const stop = stubProvider(async () => '```json\n' + JSON.stringify({
    template: 'weapons_top', params: { days: 14, limit: 5 },
    tables: ['kill_events'], columns: ['weapon', 'timestamp'],
    explain: 'Top weapons over two weeks.',
  }) + '\n```');
  try {
    const { plan, explain } = await nlQuery.planQuery('which weapons are used most?', {});
    assert.equal(plan.template, 'weapons_top');
    assert.deepEqual(plan.params, { days: 14, limit: 5 });
    assert.match(explain, /weapons/i);
  } finally { stop(); }
  // Provider says "none" -> structured rejection, not execution.
  const stopNone = stubProvider(async () => '```json\n{"template":"none"}\n```');
  try {
    await assert.rejects(() => nlQuery.planQuery('shut down the server', {}), e => e.code === 'NL_QUERY_NO_FITTING_TEMPLATE');
  } finally { stopNone(); }
  // Adversarial provider output (invents a template) is rejected.
  const stopBad = stubProvider(async () => '```json\n' + JSON.stringify({ template: 'hack_users', params: {} }) + '\n```');
  try {
    await assert.rejects(() => nlQuery.planQuery('show me the user table', {}), e => e.code === 'NL_QUERY_TEMPLATE_NOT_WHITELISTED');
  } finally { stopBad(); }
  console.log('✓ planQuery (stubbed provider, bounded spec out)');
}

// ─── Action planner ──────────────────────────────────────────────────────────

function testActionValidation() {
  // Unknown action.
  assert.throws(() => nlAction.validateRequest({ action: 'explode_server', resolver: 'open_reports' }), e => e.code === 'NL_ACTION_NOT_WHITELISTED');
  // Action/resolver mismatch (open_reports cannot whitelist someone).
  assert.throws(() => nlAction.validateRequest({ action: 'whitelist_player', resolver: 'open_reports' }), e => e.code === 'NL_ACTION_RESOLVER_MISMATCH');
  // Out-of-range param.
  assert.throws(
    () => nlAction.validateRequest({ action: 'ban_player', resolver: 'near_last_kill', params: { within_m: 999999 } }),
    e => e.code === 'NL_ACTION_PARAM_OUT_OF_RANGE'
  );
  // Missing required param.
  assert.throws(() => nlAction.validateRequest({ action: 'ban_player', resolver: 'explicit_gamertag', params: {} }), e => e.code === 'NL_ACTION_PARAM_MISSING');
  // Valid.
  const ok = nlAction.validateRequest({ action: 'ban_player', resolver: 'explicit_gamertag', params: { gamertag: 'PlayerA' } });
  assert.equal(ok.action, 'ban_player');
  assert.equal(ok.destructive, undefined); // destructiveness lives on the catalog
  console.log('✓ action validation (whitelist + resolver/action matching)');
}

async function testResolverOpenReports() {
  const db = stubDb({
    'FROM player_reports': [
      { reported_gamertag: 'GrieferOne', reports: 3, latest: '2026-10-10T00:00:00Z' },
      { reported_gamertag: 'GrieferTwo', reports: 1, latest: '2026-10-09T00:00:00Z' },
    ],
  });
  const { targets, evidence } = await nlAction.RESOLVERS.open_reports.resolve(db, 7, {});
  assert.equal(targets.length, 2);
  assert.equal(targets[0].gamertag, 'GrieferOne');
  assert.match(evidence[0], /GrieferOne \(3 open report\(s\), latest/);
  // Plan materialization: destructive flag + exact existing API call.
  const plan = await nlAction.buildActionPlan(db, 7, {
    request: 'ban everyone with open reports', action: 'ban_player', resolver: 'open_reports', params: {},
  });
  assert.equal(plan.actions.length, 2);
  assert.ok(plan.actions[0].destructive, 'ban is destructive');
  assert.equal(plan.actions[0].api.method, 'POST');
  assert.equal(plan.actions[0].api.path, '/api/owner/servers/7/list/blacklist/add');
  assert.deepEqual(plan.actions[0].api.body, { gamertag: 'GrieferOne' });
  console.log('✓ resolver open_reports -> deterministic plan (exact API calls)');
}

async function testResolverNearLastKill() {
  const db = stubDb({
    'ORDER BY timestamp DESC': [{
      victim_position: '1000.5, 2000.5, 3.0',
      killer_gamertag: 'GriefBoss',
      weapon: 'AK74_7.62x39',
      timestamp: new Date(),
    }],
    'FROM player_position_snapshots': [
      { identity_id: 11, player_gamertag: 'NearPlayer', min_dist_m: 42 },
    ],
  });
  const { targets, evidence } = await nlAction.RESOLVERS.near_last_kill.resolve(db, 7, { within_m: 100, window_minutes: 60 });
  assert.equal(targets.length, 1);
  assert.equal(targets[0].gamertag, 'NearPlayer');
  assert.match(evidence[0], /GriefBoss/);
  assert.match(evidence[0], /~42m from anchor/);
  // No positioned kill -> structured no-anchor error.
  const emptyDb = stubDb({});
  await assert.rejects(() => nlAction.RESOLVERS.near_last_kill.resolve(emptyDb, 7, {}), e => e.code === 'NL_ACTION_NO_ANCHOR');
  console.log('✓ resolver near_last_kill (anchor + radius + no-anchor rejection)');
}

async function testResolverExplicitGamertag() {
  const db = stubDb({
    'FROM player_gamertags': [
      { identity_id: 3, platform_user_id: 'uid-3', platform: 'xbox', gamertag: 'PlayerA', exact_match: true },
    ],
  });
  const { targets } = await nlAction.RESOLVERS.explicit_gamertag.resolve(db, 7, { gamertag: 'PlayerA' });
  assert.equal(targets[0].identityId, 3);
  const wipeDb = stubDb({ 'FROM player_gamertags': [{ identity_id: 3, platform_user_id: 'u', platform: 'xbox', gamertag: 'PlayerA', exact_match: true }] });
  const plan = await nlAction.buildActionPlan(wipeDb, 7, {
    request: 'wipe PlayerA', action: 'wipe_player', resolver: 'explicit_gamertag', params: { gamertag: 'PlayerA' },
  });
  assert.equal(plan.actions[0].api.path, '/api/owner/servers/7/players/3/wipe');
  assert.equal(plan.actions[0].destructive, true);
  console.log('✓ resolver explicit_gamertag (incl. wipe path)');
}

async function testPlanActionStubbed() {
  const stop = stubProvider(async () => '```json\n' + JSON.stringify({
    action: 'ban_player', resolver: 'open_reports', params: {}, rationale: 'Reports say they are griefing.',
  }) + '\n```');
  try {
    const spec = await nlAction.planAction('ban the griefers', {});
    assert.equal(spec.action, 'ban_player');
    assert.equal(spec.resolver, 'open_reports');
  } finally { stop(); }
  const stopNone = stubProvider(async () => '```json\n{"action":"none"}\n```');
  try {
    await assert.rejects(() => nlAction.planAction('restart the moon base', {}), e => e.code === 'NL_ACTION_NO_FITTING_PLAN');
  } finally { stopNone(); }
  console.log('✓ planAction (stubbed provider, bounded spec out)');
}

// ─── Route tests ─────────────────────────────────────────────────────────────

function testRoutesRegisteredAndGated() {
  const router = require(path.join(ROOT, 'routes', 'ai'));
  const routes = router.stack
    .filter(layer => layer.route)
    .map(layer => ({ method: layer.route.methods.post ? 'post' : 'get', path: layer.route.path }));
  const has = (m, p) => routes.some(r => r.method === m && r.path === p);
  assert.ok(has('post', '/nl-query/:platformServerId'), 'nl-query route registered');
  assert.ok(has('post', '/nl-action/:platformServerId'), 'nl-action route registered');
  assert.ok(has('post', '/nl-action/:platformServerId/confirm'), 'nl-action confirm route registered');
  assert.ok(has('post', '/nl-config/:platformServerId'), 'nl-config route registered');

  const source = fs.readFileSync(path.join(ROOT, 'routes', 'ai.js'), 'utf8');
  assert.match(source, /router\.param\('platformServerId', ensureAiServerManage\)/, 'exact-server RBAC gate on all AI routes');
  assert.ok(!source.includes('executeImmediate'), 'no execution flag bypass exists');
  assert.match(source, /confirm: \[action indexes\]/, 'per-action confirmation is documented');
  console.log('✓ routes registered + ensureAiServerManage gated');
}

async function testNlQueryRouteDeterministic() {
  const router = require(path.join(ROOT, 'routes', 'ai'));
  const handler = findHandler(router, 'post', '/nl-query/:platformServerId');
  const db = stubDb({
    'FROM kill_events': [{ gamertag: 'TopKiller', platform: 'xbox', kills: 55, last_kill: '2026-10-10T00:00:00Z', last_weapon: 'M4A1' }],
  });
  const req = { ...reqBase(), app: { locals: { db } }, body: {
    question: 'top 10 killers this week with their server names',
    plan: { template: 'killers_by_count', params: { days: 7, limit: 10 } },
  } };
  const res = makeRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200, `nl-query 200: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.planned, false, 'explicit plan -> deterministic (no provider)');
  assert.equal(res.body.rows[0].gamertag, 'TopKiller');
  assert.deepEqual(res.body.params, { days: 7, limit: 10 });

  // Adversarial plan through the route -> rejected before any db call.
  const evilDb = stubDb({});
  const evilRes = makeRes();
  await handler({ ...req, app: { locals: { db: evilDb } }, body: { plan: { template: 'users_with_passwords' } } }, evilRes);
  assert.equal(evilRes.statusCode, 422);
  assert.match(evilRes.body.code, /NOT_WHITELISTED/);
  assert.equal(evilDb.log.length, 0, 'no db call for an out-of-whitelist plan');
  console.log('✓ nl-query route (deterministic + adversarial rejection)');
}

async function testNlQueryRoutePlanned() {
  const router = require(path.join(ROOT, 'routes', 'ai'));
  const handler = findHandler(router, 'post', '/nl-query/:platformServerId');
  const db = stubDb({ 'GROUP BY weapon': [{ weapon: 'AK74', kills: 90 }] });
  const stop = stubProvider(async () => '```json\n' + JSON.stringify({
    template: 'weapons_top', params: {}, tables: ['kill_events'], columns: ['weapon'], explain: 'Top weapons.',
  }) + '\n```');
  try {
    const res = makeRes();
    await handler({ ...reqBase(), app: { locals: { db } }, body: { question: 'what weapons are people using?' } }, res);
    assert.equal(res.statusCode, 200, `planned nl-query 200: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.planned, true);
    assert.equal(res.body.template, 'weapons_top');
    assert.deepEqual(res.body.params, { days: 7, limit: 10 }, 'provider got defaults');
    assert.equal(res.body.rows[0].weapon, 'AK74');
  } finally { stop(); }
  console.log('✓ nl-query route (provider-planned path)');
}

async function testNlActionPlanAndConfirmGate() {
  const router = require(path.join(ROOT, 'routes', 'ai'));
  const planHandler = findHandler(router, 'post', '/nl-action/:platformServerId');
  const confirmHandler = findHandler(router, 'post', '/nl-action/:platformServerId/confirm');

  let storedPlan = null;
  let updatedPlan = null;
  const innerDb = stubDb({ 'FROM player_reports': [
    { reported_gamertag: 'GrieferOne', reports: 2, latest: '2026-10-10T00:00:00Z' },
    { reported_gamertag: 'GrieferTwo', reports: 1, latest: '2026-10-09T00:00:00Z' },
  ]});
  const fullDb = {
    query: async (sql, params) => {
      if (/INSERT INTO nl_action_plans/i.test(sql)) { storedPlan = { sql, params }; return []; }
      if (/UPDATE nl_action_plans/i.test(sql)) { updatedPlan = { sql, params }; return []; }
      return innerDb.query(sql, params);
    },
    get: async (sql, params) => {
      if (/FROM nl_action_plans/i.test(sql)) {
        if (!storedPlan) return null;
        if (params[0] !== storedPlan.params[0]) return null; // unknown planId -> 404
        return {
          id: storedPlan.params[0],
          request: storedPlan.params[3],
          action: storedPlan.params[4],
          resolver: storedPlan.params[5],
          params: storedPlan.params[6],
          plan: storedPlan.params[7],
          expires_at: new Date(Date.now() + 600000),
        };
      }
      // The confirm-time execution drives the existing ownerDashboard
      // stack; its RBAC middleware (ensureServerAccess) reaches the servers
      // table first. No token row -> 404 'Resource not found', proving the
      // EXISTING authorization path is what rejected the execution.
      if (/FROM servers/i.test(sql)) return null;
      return innerDb.get(sql, params);
    },
    log: innerDb.log,
  };

  const req = {
    ...reqBase(),
    app: { locals: { db: fullDb } },
    authorization: {
      actor: { userId: 1, discordId: null, platformAdmin: false },
      guild: { id: 1, discordGuildId: '789326430571855893', role: 'owner', status: 'approved' },
      server: { id: 7, platformServerId: '15580969', role: 'owner', status: 'active' },
      player: null,
    },
  };

  // Plan: deterministic (action+resolver provided) -> 200 with the full
  // plan. No execution happens at plan time.
  const res = makeRes();
  await planHandler({ ...req, body: { request: 'ban the griefers', action: 'ban_player', resolver: 'open_reports', params: {} } }, res);
  assert.equal(res.statusCode, 200, `nl-action 200: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.actions.length, 2, 'two affected players');
  assert.ok(res.body.planId, 'planId issued');
  assert.ok(storedPlan, 'plan persisted pending');
  assert.ok(!res.body.results, 'no execution happened at plan time');
  const planId = res.body.planId;

  // Confirm WITHOUT listing every action -> 409, nothing executed.
  const partialRes = makeRes();
  await confirmHandler({ ...req, body: { planId, confirm: [0] } }, partialRes);
  assert.equal(partialRes.statusCode, 409, `partial confirm -> 409, got ${partialRes.statusCode}`);
  assert.equal(partialRes.body.unconfirmed.length, 1, 'unconfirmed action listed');
  assert.equal(updatedPlan, null, 'no plan update without full confirmation');

  // Confirm EVERYTHING -> drives the existing ownerDashboard handlers.
  // With no Nitrado token row, the existing ensureServerAccess middleware
  // 404s each action; both results report the rejection and the plan stays
  // pending for retry (502 all-failed).
  const fullRes = makeRes();
  await confirmHandler({ ...req, body: { planId, confirm: [0, 1] } }, fullRes);
  assert.equal(fullRes.statusCode, 502, `full confirm drives existing endpoints, got ${fullRes.statusCode}: ${JSON.stringify(fullRes.body)}`);
  assert.equal(fullRes.body.results.length, 2);
  assert.ok(
    fullRes.body.results.every(r => r.ok === false && r.error === 'NL_ACTION_EXECUTION_REJECTED'),
    'existing RBAC path rejected each action'
  );
  assert.match(fullRes.body.results[0].message, /authorization path/i);
  assert.equal(updatedPlan, null, 'all-failed -> plan stays pending for retry');

  // Unknown plan id -> 404.
  const missingRes = makeRes();
  await confirmHandler({ ...req, body: { planId: 'does-not-exist', confirm: [0] } }, missingRes);
  assert.equal(missingRes.statusCode, 404);
  console.log('✓ nl-action plan + confirm gate (no execution without explicit per-action confirm)');
}

// ─── Confirm-time route matching (regression: the WIP that timed out) ────────

function testConfirmRouteMatching() {
  const ownerDashboard = require(path.join(ROOT, 'routes', 'ownerDashboard'));
  // Concrete planned paths must bind to their Express template routes.
  const ban = nlAction.findOwnerRoute(ownerDashboard, 'POST', '/servers/7/list/blacklist/add');
  assert.ok(ban, 'ban (list add) route found');
  assert.equal(ban.params.id, '7');
  assert.equal(ban.params.listType, 'blacklist');
  const unban = nlAction.findOwnerRoute(ownerDashboard, 'POST', '/servers/7/list/blacklist/remove');
  assert.ok(unban, 'unban (list remove) route found');
  assert.equal(unban.params.listType, 'blacklist');
  const wipe = nlAction.findOwnerRoute(ownerDashboard, 'POST', '/servers/7/players/3/wipe');
  assert.ok(wipe, 'wipe route found');
  assert.deepEqual(wipe.params, { id: '7', identityId: '3' });
  // No matching route -> null, not a silent no-op.
  assert.equal(nlAction.findOwnerRoute(ownerDashboard, 'DELETE', '/servers/7/list/blacklist/add'), null);
  assert.equal(nlAction.findOwnerRoute(ownerDashboard, 'POST', '/servers/7/nonexistent/endpoint'), null);

  // Synthetic request carries the caller identity + server binding into
  // params/query/body so the ownerDashboard middleware resolves the same
  // exact server the NL route authorized.
  const synthetic = nlAction.buildSyntheticActionRequest(
    { app: {}, user: { id: 1 }, authorization: { ok: true } },
    '/servers/7/list/blacklist/add',
    ban.params,
    { gamertag: 'PlayerA' }
  );
  assert.equal(synthetic.user.id, 1);
  assert.deepEqual(synthetic.authorization, { ok: true });
  assert.equal(synthetic.params.id, '7');
  assert.equal(synthetic.params.serverId, '7');
  assert.equal(synthetic.query.serverId, '7');
  assert.deepEqual(synthetic.body, { gamertag: 'PlayerA' });
  assert.equal(synthetic.isAuthenticated(), true);
  console.log('✓ confirm-time route matching (template binding + synthetic request)');
}

async function testNlConfigRoute() {
  const router = require(path.join(ROOT, 'routes', 'ai'));
  const handler = findHandler(router, 'post', '/nl-config/:platformServerId');
  const captured = [];
  const db = stubDb({});
  db.query = async (sql, params) => {
    if (/INSERT INTO ai_suggestion_groups/i.test(sql)) return [{ id: 77 }];
    if (/INSERT INTO ai_suggestions/i.test(sql)) { captured.push(params); return [{ id: 500 }]; }
    return [];
  };
  const typesXml = '<?xml version="1.0" encoding="UTF-8"?>\n<types>\n\t<type name="TestItem_A">\n\t\t<nominal>10</nominal>\n\t</type>\n</types>\n';
  const stop = stubProvider(async () => '```json\n' + JSON.stringify({
    suggestions: [{
      file: 'types.xml',
      rationale: 'Lower the nominal on TestItem_A.',
      patch: { kind: 'xml-search-replace', edits: [{ search: '<nominal>10</nominal>', replace: '<nominal>8</nominal>' }] },
    }],
  }) + '\n```');
  try {
    const res = makeRes();
    await handler({
      ...reqBase(), app: { locals: { db } },
      body: { instruction: 'reduce TestItem_A spawns a bit', files: [{ filename: 'types.xml', fileContent: typesXml }] },
    }, res);
    assert.equal(res.statusCode, 200, `nl-config 200: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.groupId, 77, 'suggestion group persisted via existing pipeline');
    assert.match(res.body.applyHint, /never auto-apply/, 'apply hint present');
    assert.equal(captured.length, 1, 'suggestion row written');
    assert.match(captured[0][6], /nominal>8<\/nominal>/, 'patch materialized against the file');
  } finally { stop(); }
  console.log('✓ nl-config route (reuses card-1/2 suggestion pipeline)');
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  testQueryWhitelistRejection();
  await testQueryBoundedExecution();
  await testPlanQueryStubbed();
  testActionValidation();
  await testResolverOpenReports();
  await testResolverNearLastKill();
  await testResolverExplicitGamertag();
  await testPlanActionStubbed();
  testRoutesRegisteredAndGated();
  await testNlQueryRouteDeterministic();
  await testNlQueryRoutePlanned();
  await testNlActionPlanAndConfirmGate();
  testConfirmRouteMatching();
  await testNlConfigRoute();
  console.log('\nAll NL admin tests passed ✓');
}

main().catch(err => {
  console.error('❌ NL admin test failed:', err);
  process.exit(1);
});
