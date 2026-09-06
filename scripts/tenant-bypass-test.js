'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
const compact = source => source.replace(/\s+/g, ' ');

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function testGlobalAdminCannotBypassExactGuildOperatorRole() {
  const { ensureApprovedGuildOperator } = require('../middleware/serverAccess');
  let captured;
  const req = {
    isAuthenticated: () => true,
    user: { id: 71, is_admin: true },
    params: {},
    query: { guildId: 'guild-b' },
    body: {},
    app: { locals: { db: { get: async (sql, params) => {
      captured = { sql: compact(sql), params };
      return null;
    } } } },
  };
  let nextCalled = false;
  const res = responseRecorder();
  await ensureApprovedGuildOperator(req, res, () => { nextCalled = true; });

  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(nextCalled, false);
  assert.ok(captured.sql.includes('JOIN guild_roles gr ON gr.guild_id = g.id AND gr.user_id = ?'));
  assert.ok(captured.sql.includes("gr.role IN ('owner', 'admin')"));
  assert.deepStrictEqual(captured.params, [71, 'guild-b', 'guild-b']);
}

async function testExactGuildOwnerStillPassesOperatorGuard() {
  const { ensureApprovedGuildOperator } = require('../middleware/serverAccess');
  const req = {
    isAuthenticated: () => true,
    user: { id: 72, is_admin: false },
    params: { guildId: 'guild-a' }, query: {}, body: {},
    app: { locals: { db: { get: async () => ({ id: 4, discord_guild_id: 'guild-a', role: 'owner' }) } } },
  };
  let nextCalled = false;
  await ensureApprovedGuildOperator(req, responseRecorder(), () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true);
  assert.deepStrictEqual(req.guildAccess, { guildId: 4, discordGuildId: 'guild-a' });
}

async function testGuildOwnerAndPlayerIdentityDoNotUseGlobalAdminBypasses() {
  const { ensureGuildOwner } = require('../middleware/serverAccess');
  let captured;
  const req = {
    isAuthenticated: () => true,
    user: { id: 73, is_admin: true },
    params: { guildId: 'guild-c' }, query: {}, body: {},
    app: { locals: { db: { get: async (sql, params) => {
      captured = { sql: compact(sql), params };
      return null;
    } } } },
  };
  let nextCalled = false;
  const res = responseRecorder();
  await ensureGuildOwner(req, res, () => { nextCalled = true; });
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(nextCalled, false);
  assert.ok(captured.sql.includes("gr.role = 'owner'"));
  assert.deepStrictEqual(captured.params, [73, 'guild-c', 'guild-c']);

  const source = read('middleware/serverAccess.js');
  const start = source.indexOf('async function ensurePlayerIdentityAccess');
  const end = source.indexOf('async function ensurePlayerServerAccess', start);
  assert.doesNotMatch(source.slice(start, end), /is_admin/);

  for (const [name, nextName] of [
    ['ensureApproved', 'ensurePlayerApproved'],
    ['ensurePlayerApproved', 'ensurePlayerGuildAccess'],
    ['ensurePlayerGuildAccess', 'ensurePlayerIdentityAccess'],
  ]) {
    const guardStart = source.indexOf(`async function ${name}`);
    const guardEnd = source.indexOf(`async function ${nextName}`, guardStart);
    assert.doesNotMatch(source.slice(guardStart, guardEnd), /is_admin/, `${name} has a global-admin shortcut`);
  }
}

async function testSharedRequireRoleHasNoGlobalAdminBypass() {
  const { requireRole } = require('../middleware/auth');
  const guard = requireRole('owner');
  const calls = [];
  const req = {
    isAuthenticated: () => true,
    user: { id: 74, username: 'global-only', is_admin: true },
    originalUrl: '/api/guilds/guild-d/token',
    params: { guildId: 'guild-d' }, query: {}, body: {},
    app: { locals: { db: { get: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('FROM guilds')) return { id: 9, discord_guild_id: 'guild-d' };
      return null;
    } } } },
  };
  let nextCalled = false;
  const res = responseRecorder();
  await guard(req, res, () => { nextCalled = true; });
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(nextCalled, false);
  assert.ok(calls.some(call => call.sql.includes('guild_roles')));
}

function testServerTenantRoutesUseCanonicalGuardsInsteadOfRequireRole() {
  for (const file of ['routes/tasks.js', 'routes/console.js', 'routes/serverControl.js', 'routes/backups.js']) {
    const source = read(file);
    assert.ok(source.includes("router.use('/:serverId', ensureServerOwner)"), `${file}: missing canonical server guard`);
    assert.doesNotMatch(source, /requireRole\(/, `${file}: redundant role guard does not resolve server tenant`);
  }
  const logParser = read('routes/logParser.js');
  assert.doesNotMatch(logParser, /requireRole\('owner'\), ensurePlatformServerOwner/);
}

function testAdditionalOrdinaryRoutesHaveNoPlatformAdminShortcuts() {
  const checks = [
    ['routes/missionFiles.js', /is_admin|isAdmin/],
    ['routes/access.js', /is_admin|platform_admin|\?\s*=\s*1/],
  ];
  for (const [file, pattern] of checks) assert.doesNotMatch(read(file), pattern, `${file}: platform-admin tenant shortcut`);

  const guilds = read('routes/guilds.js');
  const guildServers = guilds.slice(guilds.indexOf("router.get('/:guildId/servers'"));
  assert.doesNotMatch(guildServers, /is_admin|platform_admin|\?\s*=\s*1/);

  const routes = read('src/app/registerRoutes.js');
  const userGuilds = routes.slice(routes.indexOf("app.get('/api/user/guilds'"), routes.indexOf('// Guilds that have registered servers'));
  assert.doesNotMatch(userGuilds, /is_admin|isAdmin/);

  const dashboard = routes.slice(routes.indexOf("app.get('/dashboard'"), routes.indexOf("app.get('/setup'"));
  assert.doesNotMatch(dashboard, /is_admin|isAdmin/, 'ordinary dashboard has a platform-admin tenant shortcut');

  const owner = read('routes/ownerDashboard.js');
  const ownerGuard = owner.slice(owner.indexOf('async function ensureGuildApproved'), owner.indexOf('// Apply to owner routes'));
  assert.doesNotMatch(ownerGuard, /is_admin/);
}

function assertTrustedMembershipJoin(source, label) {
  const sql = compact(source);
  assert.ok(sql.includes('la.id = spm.source_link_id') || sql.includes('la.id = membership.source_link_id') || sql.includes('account.id = membership.source_link_id'), `${label}: source link id is not bound`);
  assert.ok(sql.includes('la.user_id = spm.user_id') || sql.includes('la.user_id = membership.user_id') || sql.includes('account.user_id = membership.user_id'), `${label}: linked user is not bound`);
  assert.ok(sql.includes('la.identity_id = spm.identity_id') || sql.includes('la.identity_id = membership.identity_id') || sql.includes('account.identity_id = membership.identity_id'), `${label}: linked identity is not bound`);
  assert.ok(sql.includes("la.verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')") || sql.includes("account.verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')"), `${label}: untrusted link methods are accepted`);
}

function testMapHeatmapHasNoGlobalAdminBypass() {
  const source = read('routes/mapHeatmap.js');
  const authorization = read('services/authorizationService.js');
  assert.doesNotMatch(source, /user\.is_admin/);
  assert.ok(source.includes('authorizePlatformServer'));
  assertTrustedMembershipJoin(authorization, 'map heatmap central authorization');
}

function testAiRoutesRequireExactTenantRoles() {
  const source = read('routes/ai.js');
  assert.doesNotMatch(source, /is_admin/);
  const sql = compact(source);
  assert.ok(source.includes('authorizePlatformServer') && source.includes('authorizeServer'));
  assert.ok(source.includes('CAPABILITIES.SERVER_MANAGE'));
  assert.ok(sql.includes("s.status = 'active'"));
  assert.ok(sql.includes('sra.server_id = s.id AND sra.guild_id = s.guild_id'));
  assert.ok(sql.includes("gr.role IN ('owner', 'admin') OR (sra.role = 'admin' AND sra.status = 'active')"));
  assert.doesNotMatch(sql, /OR EXISTS \(SELECT 1 FROM users u WHERE u\.id = \$\d+ AND u\.is_admin = 1\)/);
}

function testRegisteredServersHasNoGlobalAdminBypass() {
  const source = read('routes/nitrado.js');
  const start = source.indexOf("router.get('/registered-servers'");
  const end = source.indexOf("router.get('/servers'", start);
  const route = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(route, /is_admin|\?\s*=\s*1/);
  assert.ok(compact(route).includes("gr.role IN ('owner', 'admin') OR sra.role IN ('admin', 'moderator')"));
}

function testGuildsWithServersHasNoBypassAndUsesTrustedMembership() {
  const source = read('src/app/registerRoutes.js');
  const start = source.indexOf("app.get('/api/user/guilds-with-servers'");
  const end = source.indexOf('// Public server list placeholder', start);
  const route = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(route, /is_admin|\?\s*=\s*1/);
  assertTrustedMembershipJoin(route, 'guilds-with-servers');
}

async function main() {
  await testGlobalAdminCannotBypassExactGuildOperatorRole();
  await testExactGuildOwnerStillPassesOperatorGuard();
  await testGuildOwnerAndPlayerIdentityDoNotUseGlobalAdminBypasses();
  await testSharedRequireRoleHasNoGlobalAdminBypass();
  testServerTenantRoutesUseCanonicalGuardsInsteadOfRequireRole();
  testAdditionalOrdinaryRoutesHaveNoPlatformAdminShortcuts();
  testMapHeatmapHasNoGlobalAdminBypass();
  testAiRoutesRequireExactTenantRoles();
  testRegisteredServersHasNoGlobalAdminBypass();
  testGuildsWithServersHasNoBypassAndUsesTrustedMembership();
  console.log('✅ Tenant bypass and trusted membership join tests passed');
}

main().catch(error => {
  console.error(`❌ ${error.stack || error.message}`);
  process.exit(1);
});
