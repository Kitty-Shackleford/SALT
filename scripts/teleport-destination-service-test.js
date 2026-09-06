'use strict';

const assert = require('assert');
const {
  createTeleportDestination,
  deactivateTeleportDestination,
  listTeleportDestinations,
} = require('../services/teleportDestinationService');

function destinationDb({ authorized = true, liveRequest = null, activeRestriction = null } = {}) {
  const calls = [];
  return {
    calls,
    async get(sql, params) {
      calls.push({ kind: 'get', sql, params });
      if (/pg_advisory_xact_lock/.test(sql)) return {};
      if (/FROM guilds/.test(sql) && /JOIN servers/.test(sql)) {
        return { server_id: 1, guild_id: 2 };
      }
      if (/FROM guild_roles/.test(sql)) return authorized ? { id: 30, role: 'admin' } : null;
      if (/FROM server_role_assignments/.test(sql)) return null;
      if (/FROM teleport_destinations/.test(sql) && /FOR UPDATE/.test(sql)) {
        return { id: 7, server_id: 1, guild_id: 2, is_active: true };
      }
      if (/FROM teleport_requests/.test(sql)) return liveRequest;
      if (/FROM player_pra_restrictions/.test(sql)) return activeRestriction;
      throw new Error(`Unexpected get: ${sql}`);
    },
    async all(sql, params) {
      calls.push({ kind: 'all', sql, params });
      if (/FROM teleport_destinations/.test(sql)) {
        return [{ id: 7, server_id: 1, guild_id: 2, name: 'Outpost', map_name: 'sakhal',
          destination_type: 'named', pos_x: 100, pos_y: 20, pos_z: 200,
          is_private: false, is_active: true }];
      }
      throw new Error(`Unexpected all: ${sql}`);
    },
    async query(sql, params) {
      calls.push({ kind: 'query', sql, params });
      if (/INSERT INTO teleport_destinations/.test(sql)) {
        return [{ id: 7, server_id: 1, guild_id: 2, name: 'Outpost', map_name: 'sakhal',
          destination_type: 'named', pos_x: 100, pos_y: 20, pos_z: 200,
          is_private: false, is_active: true }];
      }
      if (/UPDATE teleport_destinations/.test(sql)) return [{ id: 7, is_active: false }];
      if (/INSERT INTO security_audit_events/.test(sql)) return [];
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

(async () => {
  const db = destinationDb();
  const created = await createTeleportDestination(db, {
    serverId: 1,
    guildId: 2,
    actorUserId: 6,
    name: ' Outpost ',
    mapName: 'SAKHAL',
    position: [100, 20, 200],
  });
  assert.strictEqual(created.id, 7);
  const parentLock = db.calls.findIndex(call => /FROM guilds/.test(call.sql) && /JOIN servers/.test(call.sql));
  const authorityLock = db.calls.findIndex(call => /FROM guild_roles/.test(call.sql));
  const write = db.calls.findIndex(call => /INSERT INTO teleport_destinations/.test(call.sql));
  const audit = db.calls.findIndex(call => /INSERT INTO security_audit_events/.test(call.sql));
  assert(parentLock >= 0 && authorityLock > parentLock && write > authorityLock && audit > write);
  assert.deepStrictEqual(db.calls[write].params.slice(0, 3), [2, 1, 'Outpost']);

  const deniedDb = destinationDb({ authorized: false });
  await assert.rejects(createTeleportDestination(deniedDb, {
    serverId: 1, guildId: 2, actorUserId: 6,
    name: 'Outpost', mapName: 'sakhal', position: [100, 20, 200],
  }), error => error.code === 'TELEPORT_UNAUTHORIZED');
  assert(!deniedDb.calls.some(call => /INSERT INTO teleport_destinations/.test(call.sql)));

  const listed = await listTeleportDestinations(db, { serverId: 1, guildId: 2 });
  assert.strictEqual(listed.length, 1);
  assert(db.calls.some(call => /server_id = \? AND guild_id = \?/.test(call.sql)));

  const busyDb = destinationDb({ liveRequest: { id: 88 } });
  await assert.rejects(deactivateTeleportDestination(busyDb, {
    serverId: 1, guildId: 2, actorUserId: 6, destinationId: 7,
  }), error => error.code === 'TELEPORT_DESTINATION_IN_USE');
  assert(!busyDb.calls.some(call => /UPDATE teleport_destinations/.test(call.sql)));
  assert.match(
    busyDb.calls.find(call => /FROM teleport_requests/.test(call.sql)).sql,
    /cleanup_pending.*cleanup_processing.*cleanup_restart_pending/
  );

  const restrictedDb = destinationDb({ activeRestriction: { id: 99 } });
  await assert.rejects(deactivateTeleportDestination(restrictedDb, {
    serverId: 1, guildId: 2, actorUserId: 6, destinationId: 7,
  }), error => error.code === 'TELEPORT_DESTINATION_IN_USE');
  assert(!restrictedDb.calls.some(call => /UPDATE teleport_destinations/.test(call.sql)));

  console.log('✅ Teleport destination service tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
