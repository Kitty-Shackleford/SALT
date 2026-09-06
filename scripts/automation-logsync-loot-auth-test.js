'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { encryptToken } = require('../utils/encryption');

const root = path.join(__dirname, '..');
const compact = value => value.replace(/\s+/g, ' ');

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function handlerFor(router, routePath, method) {
  const layer = router.stack.find(entry => entry.route?.path === routePath && entry.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${routePath} route must exist`);
  return layer.route.stack.at(-1).handle;
}

async function testAutomationRejectsCrossTenantServerBeforeSaving() {
  const router = require('../routes/automation');
  const handler = handlerFor(router, '/log-sync', 'post');
  let writes = 0;
  const queries = [];
  const req = {
    user: { id: 501, is_admin: true },
    body: { enabled: true, interval: 15, autoScan: true, servers: ['foreign-service'] },
    app: { locals: { db: {
      get: async (sql, params) => { queries.push({ sql: compact(sql), params }); return null; },
      run: async () => { writes += 1; },
    } } },
  };
  const res = responseRecorder();

  await handler(req, res);

  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(writes, 0, 'unauthorized client server IDs must never be persisted');
  assert.ok(queries.some(query => query.sql.includes('guild_roles') && query.params.includes('foreign-service')));
  assert.ok(queries.every(query => !query.sql.includes('u.is_admin')));
}

async function testAutomationPersistsOnlyCanonicalAuthorizedServerIds() {
  const router = require('../routes/automation');
  const handler = handlerFor(router, '/log-sync', 'post');
  let savedSettings;
  const req = {
    user: { id: 505, is_admin: false },
    body: { enabled: true, interval: 15, autoScan: false, servers: ['000123', '000123'] },
    app: { locals: { db: {
      get: async () => ({ platform_server_id: 123, discord_guild_id: 'guild-a', token_hash: encryptToken('account-a') }),
      run: async (sql, params) => { savedSettings = JSON.parse(params[1]); },
    } } },
  };
  const res = responseRecorder();

  await handler(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(savedSettings.servers, ['123']);
}

async function testAutomationRejectsMixedProviderTokensBeforeSaving() {
  const router = require('../routes/automation');
  const handler = handlerFor(router, '/log-sync', 'post');
  let writes = 0;
  const encryptedTokens = {
    '101': encryptToken('account-a'),
    '202': encryptToken('account-b'),
  };
  const req = {
    user: { id: 506, is_admin: false },
    body: { enabled: true, interval: 15, autoScan: true, servers: ['101', '202'] },
    app: { locals: { db: {
      get: async (_sql, params) => ({
        platform_server_id: params[1],
        discord_guild_id: `guild-${params[1]}`,
        token_hash: encryptedTokens[String(params[1])],
      }),
      run: async () => { writes += 1; },
    } } },
  };
  const res = responseRecorder();

  await handler(req, res);

  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.body.success, false);
  assert.match(res.body.error, /same Nitrado account/i);
  assert.strictEqual(writes, 0);
}

async function testSyncNowReauthorizesSavedServersBeforeUsingCredentials() {
  const router = require('../routes/automation');
  const handler = handlerFor(router, '/sync-now', 'post');
  const queries = [];
  const req = {
    user: { id: 504, is_admin: true },
    app: { locals: { db: {
      get: async (sql, params) => {
        queries.push({ sql: compact(sql), params });
        if (sql.includes('automation_settings')) {
          return { auto_log_sync: JSON.stringify({ servers: ['foreign-saved-service'], autoScan: false }) };
        }
        return null;
      },
      run: async () => { throw new Error('unauthorized sync must not update settings'); },
    } } },
  };
  const res = responseRecorder();

  await handler(req, res);

  assert.strictEqual(res.statusCode, 403);
  assert.ok(queries.some(query => query.sql.includes('guild_roles') && query.params.includes('foreign-saved-service')));
  assert.ok(queries.every(query => !query.sql.includes('u.is_admin')));
}

async function testOperationalCredentialsRequireExactServerOperatorRole() {
  const { getDecryptedToken } = require('../services/logSyncService');
  let captured;
  const db = { get: async (sql, params) => {
    captured = { sql: compact(sql), params };
    return null;
  } };

  const token = await getDecryptedToken(db, 502, ['foreign-service']);

  assert.strictEqual(token, null);
  assert.ok(captured.sql.includes("gr.role IN ('owner', 'admin')"));
  assert.ok(captured.sql.includes('server_role_assignments'));
  assert.ok(captured.sql.includes("sra.role = 'admin'"));
  assert.ok(captured.sql.includes("s.status = 'active'"));
  assert.ok(captured.sql.includes('CAST(s.platform_server_id AS TEXT) = ?'));
  assert.doesNotMatch(captured.sql, /u\.is_admin/);
  assert.deepStrictEqual(captured.params, [502, 'foreign-service', 502]);
}

async function testLootResolutionRequiresExactServerMembershipWithoutAdminBypass() {
  const { resolveGuildDiscordId } = require('../services/logSyncService');
  let captured;
  const db = { get: async (sql, params) => {
    captured = { sql: compact(sql), params };
    return null;
  } };

  const guildId = await resolveGuildDiscordId(db, 503, 'foreign-service');

  assert.strictEqual(guildId, null);
  assert.ok(captured.sql.includes('LEFT JOIN guild_roles gr ON gr.guild_id = g.id AND gr.user_id = ?'));
  assert.ok(captured.sql.includes('server_role_assignments'));
  assert.ok(captured.sql.includes("s.status = 'active'"));
  assert.ok(captured.sql.includes('CAST(s.platform_server_id AS TEXT) = ?'));
  assert.doesNotMatch(captured.sql, /u\.is_admin/);
  assert.deepStrictEqual(captured.params, [503, 'foreign-service', 503]);
}

async function testCanonicalLogPathResolutionAllowsAssignedServerAdmin() {
  const { resolveGuildDiscordId } = require('../services/logSyncService');
  let captured;
  const db = { get: async (sql, params) => {
    captured = { sql: compact(sql), params };
    return { discord_guild_id: 'guild-a' };
  } };

  assert.strictEqual(await resolveGuildDiscordId(db, 503, 'service-a'), 'guild-a');
  assert.ok(captured.sql.includes('server_role_assignments'));
  assert.ok(captured.sql.includes("sra.role = 'admin'"));
  assert.ok(captured.sql.includes("sra.status = 'active'"));
  assert.deepStrictEqual(captured.params, [503, 'service-a', 503]);
}

async function testLootRouteDeniesCrossTenantGlobalAdminBeforeReadingLoot() {
  const router = require('../routes/lootFinder');
  const handler = handlerFor(router, '/categories', 'get');
  let captured;
  const req = {
    user: { id: 506, is_admin: true },
    query: { serverId: 'foreign-service' },
    app: { locals: { db: { get: async (sql, params) => {
      captured = { sql: compact(sql), params };
      return null;
    } } } },
  };
  const res = responseRecorder();

  await handler(req, res);

  assert.strictEqual(res.statusCode, 404);
  assert.doesNotMatch(captured.sql, /u\.is_admin/);
  assert.deepStrictEqual(captured.params, [506, 'foreign-service', 506]);
}

function testSyncImplementationsReauthorizeEveryServerAsOperator() {
  const source = fs.readFileSync(path.join(root, 'services/logSyncService.js'), 'utf8');
  const legacyStart = source.indexOf('async function performLogSync(');
  const concurrentStart = source.indexOf('async function performLogSyncConcurrent(');
  const exportsStart = source.indexOf('module.exports', concurrentStart);
  assert.match(source.slice(legacyStart, concurrentStart), /resolveOperationalServer\w*\(db, userId, serverId, token\)/);
  assert.match(source.slice(concurrentStart, exportsStart), /resolveOperationalServer\w*\(db, userId, serverId, token\)/);
}

function testOrdinaryMountsDoNotGrantGlobalAdminTenantBypass() {
  const routeRegistration = fs.readFileSync(path.join(root, 'src/app/registerRoutes.js'), 'utf8');
  const serverAccess = fs.readFileSync(path.join(root, 'middleware/serverAccess.js'), 'utf8');
  const start = serverAccess.indexOf('async function ensureApproved');
  const end = serverAccess.indexOf('async function ensurePlayerApproved', start);
  assert.ok(routeRegistration.includes("app.use('/api/loot', ensureAuthenticated, ensureApproved, lootFinderRoutes)"));
  assert.doesNotMatch(serverAccess.slice(start, end), /is_admin/);
}

async function testAssignedAdminCanReachLogAndAutomationSurfaces() {
  const { ensureHasOperableServers } = require('../middleware/serverAccess');
  let captured;
  const req = {
    user: { id: 77, username: 'assigned-admin' },
    isAuthenticated: () => true,
    originalUrl: '/logs',
    app: { locals: { db: { get: async (sql, params) => {
      captured = { sql: compact(sql), params };
      return { id: 42 };
    } } } },
  };
  const res = responseRecorder();
  res.redirect = location => { res.redirectLocation = location; return res; };
  let nextCalled = false;

  await ensureHasOperableServers(req, res, () => { nextCalled = true; });

  assert.strictEqual(nextCalled, true);
  assert.match(captured.sql, /server_role_assignments/);
  assert.match(captured.sql, /sra\.status = 'active'/);
  assert.match(captured.sql, /s\.status = 'active'/);
  assert.match(captured.sql, /g\.status = 'approved'/);
  assert.deepStrictEqual(captured.params, [77, 77]);

  const routeRegistration = fs.readFileSync(path.join(root, 'src/app/registerRoutes.js'), 'utf8');
  assert.match(routeRegistration, /app\.use\('\/api\/automation', ensureAuthenticated, ensureHasOperableServers, automationRoutes\)/);
  assert.match(routeRegistration, /app\.get\('\/dashboard\/automation',[\s\S]{0,100}ensureHasOperableServers/);
  assert.match(routeRegistration, /app\.get\('\/logs',[\s\S]{0,100}ensureHasOperableServers/);
}

async function main() {
  await testAutomationRejectsCrossTenantServerBeforeSaving();
  await testAutomationPersistsOnlyCanonicalAuthorizedServerIds();
  await testAutomationRejectsMixedProviderTokensBeforeSaving();
  await testSyncNowReauthorizesSavedServersBeforeUsingCredentials();
  await testOperationalCredentialsRequireExactServerOperatorRole();
  await testLootResolutionRequiresExactServerMembershipWithoutAdminBypass();
  await testCanonicalLogPathResolutionAllowsAssignedServerAdmin();
  await testLootRouteDeniesCrossTenantGlobalAdminBeforeReadingLoot();
  testSyncImplementationsReauthorizeEveryServerAsOperator();
  testOrdinaryMountsDoNotGrantGlobalAdminTenantBypass();
  await testAssignedAdminCanReachLogAndAutomationSurfaces();
  console.log('✅ Automation, log-sync, and loot tenant authorization tests passed');
}

main().catch(error => {
  console.error(`❌ ${error.stack || error.message}`);
  process.exit(1);
});
