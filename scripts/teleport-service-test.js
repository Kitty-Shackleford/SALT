'use strict';

const assert = require('assert');
const { requestPlayerTeleport, requestModeratorTeleport, resolveTeleportSource } = require('../services/teleportService');

function fakeDb({ restriction = null, liveRequest = null } = {}) {
  const calls = [];
  return {
    calls,
    async get(sql, params) {
      calls.push({ kind: 'get', sql, params });
      if (/FROM servers/.test(sql)) return { id: 1, guild_id: 2 };
      if (/FROM linked_accounts/.test(sql)) return { id: 3, verification_method: 'self_asserted' };
      if (/FROM server_player_memberships/.test(sql)) {
        return { id: 4, server_id: 1, guild_id: 2, identity_id: 5, user_id: 6, source_link_id: 3 };
      }
      if (/FROM teleport_destinations/.test(sql)) {
        return { id: 7, server_id: 1, guild_id: 2, name: 'Outpost', map_name: 'sakhal',
          destination_type: 'named', pos_x: 100, pos_y: 20, pos_z: 200,
          is_private: false, is_active: true };
      }
      if (/FROM player_pra_restrictions/.test(sql)) return restriction;
      if (/FROM teleport_requests/.test(sql)) return liveRequest;
      throw new Error(`Unexpected get: ${sql}`);
    },
    async query(sql, params) {
      calls.push({ kind: 'query', sql, params });
      if (/INSERT INTO teleport_requests/.test(sql)) {
        return [{ id: 9, server_id: 1, guild_id: 2, identity_id: 5,
          destination_id: 7, source: 'shop', status: 'waiting_disconnect',
          forced: false, respect_pra: true }];
      }
      if (/INSERT INTO teleport_events/.test(sql)) return [];
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

(async () => {
  const db = fakeDb();
  const request = await requestPlayerTeleport(db, {
    serverId: 1,
    identityId: 5,
    actorUserId: 6,
    destinationId: 7,
    source: 'shop',
    reason: 'Purchased travel',
    orderItemId: 11,
  });
  assert.strictEqual(request.id, 9);
  assert.strictEqual(request.status, 'waiting_disconnect');
  assert(db.calls.some(call => /FROM servers/.test(call.sql) && /FOR UPDATE/.test(call.sql)));
  assert(db.calls.some(call => /FROM linked_accounts/.test(call.sql) && /FOR UPDATE/.test(call.sql)));
  assert(db.calls.some(call => /FROM server_player_memberships/.test(call.sql) && /FOR UPDATE/.test(call.sql)));
  assert(db.calls.some(call => /INSERT INTO teleport_events/.test(call.sql)));

  const restrictedDb = fakeDb({
    restriction: { id: 12, destination_id: 99, status: 'active' },
  });
  await assert.rejects(
    requestPlayerTeleport(restrictedDb, {
      serverId: 1, identityId: 5, actorUserId: 6, destinationId: 7, source: 'shop',
    }),
    error => error.code === 'PRA_RESTRICTED'
  );
  assert(!restrictedDb.calls.some(call => /INSERT INTO teleport_requests/.test(call.sql)));

  const duplicateDb = fakeDb({ liveRequest: { id: 22, status: 'armed' } });
  await assert.rejects(
    requestPlayerTeleport(duplicateDb, {
      serverId: 1, identityId: 5, actorUserId: 6, destinationId: 7, source: 'shop',
    }),
    error => error.code === 'TELEPORT_ALREADY_PENDING'
  );
  assert(!duplicateDb.calls.some(call => /INSERT INTO teleport_requests/.test(call.sql)));
  const duplicateQuery = duplicateDb.calls.find(call => /FROM teleport_requests/.test(call.sql));
  assert.match(duplicateQuery.sql, /cleanup_pending/);
  assert.match(duplicateQuery.sql, /cleanup_processing/);
  assert.match(duplicateQuery.sql, /cleanup_restart_pending/);

  let disconnectQuery;
  const explicitSource = await resolveTeleportSource({
    async get(sql) {
      if (/player_disconnect_positions/.test(sql)) {
        disconnectQuery = sql;
        return { pos_x: 10, pos_y: 20, pos_z: 30, observed_at: '2026-08-31T13:00:00Z' };
      }
      throw new Error(`Unexpected source query: ${sql}`);
    },
  }, {
    server_id: 1, identity_id: 5,
    requested_at: '2026-08-31T12:00:00Z', expires_at: '2026-09-01T12:00:00Z',
  });
  assert.match(disconnectQuery, /observed_at <= \?/,
    'teleport source must reject disconnect evidence after request expiry');
  assert.match(disconnectQuery, /ORDER BY observed_at DESC, id DESC/,
    'teleport source must use the latest qualifying disconnect');
  assert.deepStrictEqual(explicitSource, {
    position: [10, 30, 20], observedAt: '2026-08-31T13:00:00Z', sourceType: 'disconnect',
  });

  let sessionQuery;
  const fallbackDb = {
    async get(sql) {
      if (/player_disconnect_positions/.test(sql)) return null;
      if (/player_sessions/.test(sql)) {
        sessionQuery = sql;
        return { logout_at: '2026-08-31T13:00:00Z' };
      }
      if (/player_position_snapshots/.test(sql)) {
        return { pos_x: 11, pos_y: 21, pos_z: 31, timestamp: '2026-08-31T12:55:00Z' };
      }
      throw new Error(`Unexpected fallback query: ${sql}`);
    },
  };
  const fallbackSource = await resolveTeleportSource(fallbackDb, {
    server_id: 1, identity_id: 5,
    requested_at: '2026-08-31T12:00:00Z', expires_at: '2026-09-01T12:00:00Z',
  });
  assert.match(sessionQuery, /logout_at <= \?/,
    'teleport source fallback must reject logout evidence after request expiry');
  assert.match(sessionQuery, /ORDER BY logout_at DESC, id DESC/,
    'teleport source fallback must use the latest qualifying logout');
  assert.deepStrictEqual(fallbackSource, {
    position: [11, 31, 21], observedAt: '2026-08-31T13:00:00Z', sourceType: 'logout_snapshot',
  });

  const deniedCalls = [];
  let moderatorServerParams;
  const deniedDb = {
    async get(sql, params) {
      deniedCalls.push(sql);
      if (/pg_advisory_xact_lock/.test(sql)) return {};
      if (/FROM guilds/.test(sql)) return { id: 2 };
      if (/FROM servers/.test(sql)) {
        moderatorServerParams = params;
        return { id: 1, guild_id: 2 };
      }
      if (/FROM guild_roles/.test(sql) || /FROM server_role_assignments/.test(sql)) return null;
      throw new Error(`Unexpected moderator query: ${sql}`);
    },
    async run(sql) { deniedCalls.push(sql); return { changes: 1 }; },
    async query(sql) { deniedCalls.push(sql); return []; },
  };
  await assert.rejects(requestModeratorTeleport(deniedDb, {
    serverId: 1, guildId: 999, identityId: 5, actorUserId: 6,
    destinationId: 7, source: 'admin', overridePra: true,
  }), error => error.code === 'TELEPORT_UNAUTHORIZED');
  assert.deepStrictEqual(moderatorServerParams, [1]);
  assert(!deniedCalls.some(sql => /INSERT INTO teleport_requests/.test(sql)));

  console.log('✅ Teleport service tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
