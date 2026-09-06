'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  ensurePlatformServerOwner,
  ensurePlayerServerAccess,
} = require('../middleware/serverAccess');

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function main() {
  assert.strictEqual(
    ensurePlayerServerAccess.length,
    3,
    'player server access must be normal Express middleware, not a four-argument error handler'
  );

  let queried = false;
  const conflictReq = {
    isAuthenticated: () => true,
    user: { id: 1, is_admin: true },
    params: {},
    query: { serverId: '100' },
    body: { platformServerId: '200' },
    app: { locals: { db: { get: async () => { queried = true; } } } },
  };
  const conflictRes = responseRecorder();
  await ensurePlatformServerOwner(conflictReq, conflictRes, () => {});
  assert.strictEqual(conflictRes.statusCode, 400);
  assert.strictEqual(queried, false, 'conflicting server IDs must be rejected before database access');

  const platformReq = {
    isAuthenticated: () => true,
    user: { id: 1, is_admin: true },
    params: { serviceId: '100' },
    query: {},
    body: {},
    app: { locals: { db: { get: async () => ({
      id: 7,
      guild_id: 8,
      discord_guild_id: 'guild-1',
    }) } } },
  };
  let platformNext = false;
  await ensurePlatformServerOwner(platformReq, responseRecorder(), () => { platformNext = true; });
  assert.ok(platformNext);
  assert.strictEqual(platformReq.params.serviceId, '100');
  assert.strictEqual(platformReq.query.serverId, '100');
  assert.strictEqual(platformReq.body.serverId, '100');
  assert.strictEqual(platformReq.body.platformServerId, '100');
  assert.strictEqual(platformReq.body.guildId, 'guild-1');

  const playerReq = {
    isAuthenticated: () => true,
    user: { id: 5, is_admin: false },
    params: {},
    query: { serverId: '42' },
    body: { identityId: '11' },
    app: { locals: { db: { get: async () => ({
      server_id: 42,
      guild_id: 8,
      platform_server_id: 'service-42',
      server_status: 'active',
      guild_status: 'approved',
      discord_guild_id: 'guild-8',
      player_membership_id: 91,
      player_membership_status: 'active',
      identity_id: 11,
    }) } } },
  };
  let playerNext = false;
  await ensurePlayerServerAccess(playerReq, responseRecorder(), () => { playerNext = true; });
  assert.ok(playerNext);
  assert.strictEqual(playerReq.query.serverId, 42);
  assert.strictEqual(playerReq.body.serverId, 42);
  assert.strictEqual(playerReq.body.identityId, 11);

  const identityParamReq = {
    isAuthenticated: () => true,
    user: { id: 5, is_admin: false },
    params: { identityId: '11' },
    query: { serverId: '42' },
    body: {},
    app: playerReq.app,
  };
  let identityParamNext = false;
  await ensurePlayerServerAccess(
    identityParamReq,
    responseRecorder(),
    () => { identityParamNext = true; },
    '11',
    'identityId'
  );
  assert.ok(identityParamNext, 'identity router.param middleware must authorize against the separate server ID');
  assert.strictEqual(identityParamReq.params.identityId, 11);
  assert.strictEqual(identityParamReq.query.serverId, 42);

  for (const relative of ['src/app/registerRoutes.js', 'routes/ai.js', 'routes/logParser.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
    assert.ok(
      source.includes('req.platformServerAccess.platformServerId') ||
        source.includes('req.platformServerAccess.serverId'),
      `${relative} must consume canonical authorized server context`
    );
  }

  console.log('✅ Server identifier confusion tests passed');
}

main().catch(error => {
  console.error(`❌ ${error.message}`);
  process.exit(1);
});
