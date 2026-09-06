'use strict';

const assert = require('assert');
const teleportService = require('../services/teleportService');

teleportService.lockModeratorAuthorization = async () => ({
  serverId: 10, guildId: 20, actorUserId: 30,
});
teleportService.requestModeratorTeleport = async (_db, input) => ({
  id: 40,
  server_id: input.serverId,
  identity_id: input.identityId,
});

const { imposePraRestriction, releasePraRestriction } = require('../services/teleportRestrictionService');

(async () => {
  const calls = [];
  const db = {
    async get(sql) {
      calls.push(sql);
      if (/FROM teleport_destinations/.test(sql)) {
        return { id: 50, destination_type: 'punishment', is_active: true };
      }
      if (/FROM player_pra_restrictions/.test(sql)) return null;
      if (/FROM teleport_requests/.test(sql)) return { id: 40, status: 'waiting_disconnect' };
      throw new Error(`Unexpected get: ${sql}`);
    },
    async query(sql) {
      calls.push(sql);
      if (/INSERT INTO player_pra_restrictions/.test(sql)) {
        return [{ id: 60, destination_id: 50, status: 'active' }];
      }
      if (/UPDATE teleport_requests/.test(sql)) return [{ id: 40 }];
      if (/INSERT INTO teleport_events/.test(sql)) return [];
      if (/UPDATE player_pra_restrictions/.test(sql)) return [{ id: 60, status: 'released' }];
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const imposed = await imposePraRestriction(db, {
    serverId: 10,
    identityId: 70,
    destinationId: 50,
    actorUserId: 30,
    reason: 'Repeated combat logging',
  });
  assert.strictEqual(imposed.restriction.id, 60);
  assert.strictEqual(imposed.request.id, 40);
  assert(calls.some(sql => /restriction_imposed/.test(sql)));

  const badDb = {
    async get(sql) {
      if (/FROM teleport_destinations/.test(sql)) {
        return { id: 51, destination_type: 'named', is_active: true };
      }
      return null;
    },
  };
  await assert.rejects(
    imposePraRestriction(badDb, {
      serverId: 10, identityId: 70, destinationId: 51, actorUserId: 30,
    }),
    error => error.code === 'TELEPORT_DESTINATION_INVALID'
  );

  const releaseCalls = [];
  const releaseDb = {
    async get(sql) {
      releaseCalls.push(sql);
      if (/FROM player_pra_restrictions/.test(sql)) {
        return { id: 60, guild_id: 20, server_id: 10, identity_id: 70, status: 'active' };
      }
      if (/FROM teleport_requests/.test(sql)) return { id: 40, status: 'waiting_disconnect' };
      throw new Error(`Unexpected release get: ${sql}`);
    },
    async query(sql) {
      releaseCalls.push(sql);
      if (/UPDATE teleport_requests/.test(sql)) return [];
      if (/UPDATE player_pra_restrictions/.test(sql)) return [{ id: 60, status: 'released' }];
      if (/INSERT INTO teleport_events/.test(sql)) return [];
      throw new Error(`Unexpected release query: ${sql}`);
    },
  };
  const released = await releasePraRestriction(releaseDb, {
    serverId: 10, restrictionId: 60, actorUserId: 30,
  });
  assert.strictEqual(released.status, 'released');
  assert(releaseCalls.some(sql => /UPDATE teleport_requests SET status = 'cancelled'/.test(sql)));
  assert.strictEqual(releaseCalls.filter(sql => /INSERT INTO teleport_events/.test(sql)).length, 2);

  const inFlightDb = {
    ...releaseDb,
    async get(sql) {
      if (/FROM player_pra_restrictions/.test(sql)) {
        return { id: 60, guild_id: 20, server_id: 10, identity_id: 70, status: 'active' };
      }
      if (/FROM teleport_requests/.test(sql)) return { id: 40, status: 'armed' };
      throw new Error(`Unexpected in-flight release get: ${sql}`);
    },
  };
  await assert.rejects(
    releasePraRestriction(inFlightDb, { serverId: 10, restrictionId: 60, actorUserId: 30 }),
    error => error.code === 'PRA_RESTRICTION_IN_FLIGHT'
  );
  assert(releaseCalls.some(sql => /restriction_released/.test(sql)));

  console.log('✅ Teleport restriction service tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
