'use strict';

const assert = require('assert');
const economyRouter = require('../routes/economy');

const SERVER_ID = 41;
const BASE_ROW = {
  server_id: SERVER_ID,
  guild_id: 4,
  platform_server_id: 'service-41',
  server_status: 'active',
  discord_guild_id: 'guild-4',
  guild_status: 'approved',
  guild_role: null,
  server_role: null,
  server_role_status: null,
  player_membership_id: null,
  identity_id: null,
  player_membership_status: null,
};

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function adminGuard() {
  const route = economyRouter.stack.find(layer =>
    layer.route?.path === '/admin/:serverId/config' && layer.route.methods.get
  );
  assert.ok(route, 'GET /admin/:serverId/config must exist');
  assert.ok(route.route.stack.length >= 2, 'admin route must have an authorization guard before its handler');
  return route.route.stack[0].handle;
}

async function authorize(row) {
  const calls = [];
  const req = {
    isAuthenticated: () => true,
    user: { id: 7, discord_id: 'user-7', is_admin: false },
    params: { serverId: String(SERVER_ID) },
    query: {},
    body: {},
    app: { locals: { db: {
      async get(sql, params) {
        calls.push({ sql, params });
        return row;
      },
    } } },
  };
  const res = responseRecorder();
  let nextCalled = false;
  await adminGuard()(req, res, () => { nextCalled = true; });
  return { req, res, nextCalled, calls };
}

async function assertAllowed(name, row) {
  const result = await authorize(row);
  assert.strictEqual(result.nextCalled, true, `${name} should be allowed`);
  assert.strictEqual(result.res.statusCode, 200, `${name} should not receive a denial`);
  assert.strictEqual(result.req.authorization?.server?.id, SERVER_ID,
    `${name} must receive canonical exact-server context`);
  assert.strictEqual(result.req.authorization?.guild?.id, 4,
    `${name} must receive canonical tenant context`);
  assert.deepStrictEqual(result.calls[0]?.params, [7, 7, 7, String(SERVER_ID)],
    `${name} authorization must use the populated route serverId`);
}

async function assertDenied(name, row) {
  const result = await authorize(row);
  assert.strictEqual(result.nextCalled, false, `${name} must be denied`);
  assert.strictEqual(result.res.statusCode, 404, `${name} denial must be enumeration-safe`);
  assert.strictEqual(result.req.authorization, undefined, `${name} must not receive trusted context`);
}

async function main() {
  await assertAllowed('guild owner', { ...BASE_ROW, guild_role: 'owner' });
  await assertAllowed('guild admin', { ...BASE_ROW, guild_role: 'admin' });
  await assertAllowed('active exact-server admin', {
    ...BASE_ROW,
    server_role: 'admin',
    server_role_status: 'active',
  });
  await assertDenied('server moderator', {
    ...BASE_ROW,
    server_role: 'moderator',
    server_role_status: 'active',
  });
  await assertDenied('unrelated tenant actor', null);
  await assertDenied('revoked exact-server admin', {
    ...BASE_ROW,
    server_role: 'admin',
    server_role_status: 'revoked',
  });

  const source = require('fs').readFileSync(require.resolve('../routes/economy'), 'utf8');
  assert.match(source, /requireServerCapability\(CAPABILITIES\.SERVER_MANAGE\)/,
    'economy management must use centralized server.manage capability authorization');
  assert.match(source, /router\.param\(['"]identityId['"],\s*ensurePlayerServerAccess\)/,
    'player identity endpoints must preserve player-only identity authorization');
  assert.doesNotMatch(source, /router\.param\(['"]serverId['"],\s*ensurePlayerServerAccess\)/,
    'admin server route params must not be intercepted by the player-only guard');

  console.log('✅ Economy exact-server admin capability tests passed');
}

main().catch(error => {
  console.error(`❌ ${error.stack || error.message}`);
  process.exit(1);
});
