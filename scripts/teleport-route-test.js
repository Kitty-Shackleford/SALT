'use strict';

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');

const registrationSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'app', 'registerRoutes.js'), 'utf8'
);
assert.match(registrationSource, /const teleportRoutes = require\('\.\.\/\.\.\/routes\/teleports'\)/);
assert.match(registrationSource,
  /app\.use\('\/api\/teleports', ensureAuthenticated, teleportRoutes\)/);

const destinationService = require('../services/teleportDestinationService');
const teleportService = require('../services/teleportService');
const restrictionService = require('../services/teleportRestrictionService');

const calls = [];
destinationService.listTeleportDestinations = async (_db, input) => {
  calls.push({ operation: 'list', input });
  return [];
};
destinationService.createTeleportDestination = async (_db, input) => {
  calls.push({ operation: 'create', input });
  return { id: 7, name: input.name };
};
destinationService.deactivateTeleportDestination = async (_db, input) => {
  calls.push({ operation: 'deactivate', input });
  return { id: input.destinationId, is_active: false };
};
teleportService.requestModeratorTeleport = async (_db, input) => {
  calls.push({ operation: 'request', input });
  return { id: 9, status: 'waiting_disconnect' };
};
restrictionService.imposePraRestriction = async (_db, input) => {
  calls.push({ operation: 'restrict', input });
  return { restriction: { id: 11, status: 'active' }, request: { id: 12 } };
};
restrictionService.releasePraRestriction = async (_db, input) => {
  calls.push({ operation: 'release', input });
  return { id: input.restrictionId, status: 'released' };
};

const router = require('../routes/teleports');

function authorizationDb(role = 'admin') {
  return {
    async get(sql) {
      if (/FROM servers s/.test(sql) && /LEFT JOIN guild_roles/.test(sql)) {
        return {
          server_id: 1,
          guild_id: 2,
          platform_server_id: '9001',
          server_status: 'active',
          discord_guild_id: 'guild-2',
          guild_status: 'approved',
          guild_role: null,
          server_role: role,
          server_role_status: 'active',
          player_membership_id: null,
          identity_id: null,
          player_membership_status: null,
          player_verification_method: null,
        };
      }
      throw new Error(`Unexpected authorization query: ${sql}`);
    },
    async transaction(callback) { return callback(this); },
  };
}

async function startApp(db, authenticated = true) {
  const app = express();
  app.locals.db = db;
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = authenticated ? { id: 6, username: 'operator' } : null;
    req.isAuthenticated = () => authenticated;
    next();
  });
  app.use('/api/teleports', router);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function request(baseUrl, method, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

(async () => {
  const managerApp = await startApp(authorizationDb('admin'));
  try {
    const created = await request(managerApp.baseUrl, 'POST', '/api/teleports/1/destinations', {
      name: 'Outpost', mapName: 'sakhal', position: [100, 20, 200],
    });
    assert.strictEqual(created.status, 201);
    const createCall = calls.find(call => call.operation === 'create');
    assert.deepStrictEqual({
      serverId: createCall.input.serverId,
      guildId: createCall.input.guildId,
      actorUserId: createCall.input.actorUserId,
    }, { serverId: 1, guildId: 2, actorUserId: 6 });

    const queued = await request(managerApp.baseUrl, 'POST', '/api/teleports/1/requests', {
      identityId: 5, destinationId: 7, overridePra: true, source: 'punishment',
    });
    assert.strictEqual(queued.status, 202);
    const requestCall = calls.find(call => call.operation === 'request');
    assert.strictEqual(requestCall.input.source, 'admin');
    assert.strictEqual(requestCall.input.overridePra, true);

    const restricted = await request(managerApp.baseUrl, 'POST', '/api/teleports/1/restrictions', {
      identityId: 5, destinationId: 8, reason: 'Combat logging',
    });
    assert.strictEqual(restricted.status, 201);
    const restrictCall = calls.find(call => call.operation === 'restrict');
    assert.strictEqual(restrictCall.input.serverId, 1);
    assert.strictEqual(restrictCall.input.actorUserId, 6);

    const released = await request(managerApp.baseUrl, 'DELETE', '/api/teleports/1/restrictions/11');
    assert.strictEqual(released.status, 200);
    const releaseCall = calls.find(call => call.operation === 'release');
    assert.deepStrictEqual({
      serverId: releaseCall.input.serverId,
      restrictionId: releaseCall.input.restrictionId,
      actorUserId: releaseCall.input.actorUserId,
    }, { serverId: 1, restrictionId: '11', actorUserId: 6 });
  } finally {
    managerApp.server.close();
  }

  const moderatorApp = await startApp(authorizationDb('moderator'));
  try {
    const denied = await request(moderatorApp.baseUrl, 'POST', '/api/teleports/1/destinations', {
      name: 'Hidden', mapName: 'sakhal', position: [1, 2, 3],
    });
    assert.strictEqual(denied.status, 404);
    const queued = await request(moderatorApp.baseUrl, 'POST', '/api/teleports/1/requests', {
      identityId: 5, destinationId: 7,
    });
    assert.strictEqual(queued.status, 202);
  } finally {
    moderatorApp.server.close();
  }

  const anonymousApp = await startApp(authorizationDb('admin'), false);
  try {
    const denied = await request(anonymousApp.baseUrl, 'GET', '/api/teleports/1/destinations');
    assert.strictEqual(denied.status, 401);
  } finally {
    anonymousApp.server.close();
  }

  console.log('✅ Teleport route tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
