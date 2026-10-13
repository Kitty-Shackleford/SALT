'use strict';

const { ensureTestEncryptionKey } = require('./lib/test-env');
ensureTestEncryptionKey();

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  previewMassTeleport,
  executeMassTeleport,
  requestModeratorTeleportCoords,
} = require('../services/teleportService');

// --- Command wiring ---
const commandSource = fs.readFileSync(path.join(__dirname, '..', 'bot', 'commands', 'tp-everyone.js'), 'utf8');
assert.match(commandSource, /previewMassTeleport/);
assert.match(commandSource, /executeMassTeleport/);
assert.match(commandSource, /MASS_CAP\s*=\s*25/);
const authorizationSource = fs.readFileSync(path.join(__dirname, '..', 'bot', 'utils', 'commandAuthorization.js'), 'utf8');
assert.match(authorizationSource, /'tp-everyone':\s*'server_moderate'/);

// --- Fake db: preview ---
// 3 fresh online players; one (identity 2) is under an active PRA restriction.
function previewDb() {
  const calls = [];
  return {
    calls,
    async get(sql, params) {
      calls.push({ kind: 'get', sql, params });
      if (/pg_advisory_xact_lock/.test(sql)) return {};
      if (/FROM servers/.test(sql)) return { id: 1, guild_id: 2 };
      if (/FROM guilds/.test(sql)) return { id: 2 };
      if (/FROM guild_roles/.test(sql)) return { role: 'owner' };
      if (/FROM server_role_assignments/.test(sql)) return null;
      if (/FROM teleport_destinations/.test(sql)) {
        return { id: 7, server_id: 1, guild_id: 2, name: 'HQ', map_name: 'sakhal',
          destination_type: 'named', pos_x: 1, pos_y: 2, pos_z: 3, is_private: false, is_active: true };
      }
      throw new Error(`Unexpected preview get: ${sql}`);
    },
    async query(sql, params) {
      calls.push({ kind: 'query', sql, params });
      if (/FROM player_position_snapshots/.test(sql)) {
        // identity 1 (fresh, ok), identity 2 (fresh, PRA-restricted), identity 3 (fresh, ok)
        return [
          { identity_id: 1, pos_x: 10, pos_y: 5, pos_z: 20, timestamp: '2026-01-01T00:00:00Z', pra_restriction_id: null },
          { identity_id: 2, pos_x: 11, pos_y: 6, pos_z: 21, timestamp: '2026-01-01T00:00:00Z', pra_restriction_id: 99 },
          { identity_id: 3, pos_x: 12, pos_y: 7, pos_z: 22, timestamp: '2026-01-01T00:00:00Z', pra_restriction_id: null },
        ];
      }
      throw new Error(`Unexpected preview query: ${sql}`);
    },
  };
}

// --- Fake db: execute (per-identity coordinator) ---
// Identity 3 already has a live request -> should fail, not sink the others.
function executeDb() {
  const calls = [];
  return {
    calls,
    async get(sql, params) {
      calls.push({ kind: 'get', sql, params });
      if (/pg_advisory_xact_lock/.test(sql)) return {};
      if (/FROM servers/.test(sql)) return { id: 1, guild_id: 2 };
      if (/FROM guilds/.test(sql)) return { id: 2 };
      if (/FROM guild_roles/.test(sql)) return { role: 'owner' };
      if (/FROM server_role_assignments/.test(sql)) return null;
      if (/FROM server_player_memberships/.test(sql)) return { id: 4 };
      if (/FROM teleport_destinations/.test(sql)) {
        return { id: 7, server_id: 1, guild_id: 2, name: 'HQ', map_name: 'sakhal',
          destination_type: 'named', pos_x: 1, pos_y: 2, pos_z: 3, is_private: false, is_active: true };
      }
      if (/FROM player_pra_restrictions/.test(sql)) {
        // PRA restriction blocks identity 2.
        return Number(params[1]) === 2 ? { id: 99, destination_id: 1, status: 'active' } : null;
      }
      if (/FROM teleport_requests/.test(sql)) {
        // Identity 3 has a live request -> TELEPORT_ALREADY_PENDING.
        return Number(params[1]) === 3 ? { id: 50, status: 'armed' } : null;
      }
      throw new Error(`Unexpected execute get: ${sql}`);
    },
    async query(sql, params) {
      calls.push({ kind: 'query', sql, params });
      if (/INSERT INTO teleport_requests/.test(sql)) {
        return [{ id: 200, status: 'waiting_disconnect', source_pos_x: params[13] }];
      }
      if (/INSERT INTO teleport_events/.test(sql)) return [];
      throw new Error(`Unexpected execute query: ${sql}`);
    },
  };
}

(async () => {
  // Preview: fresh-only filter (timestamp >= NOW() - ttl) present, PRA skipped,
  // cap applied, overflow counted.
  const pdb = previewDb();
  const preview = await previewMassTeleport(pdb, {
    serverId: 1, destinationId: 7, actorUserId: 9, ttlMinutes: 10, cap: 25,
  });
  const snapQuery = pdb.calls.find(c => c.kind === 'query' && /FROM player_position_snapshots/.test(c.sql));
  assert.match(snapQuery.sql, /ps\.timestamp >= NOW\(\) - \(\? \|\| ' minutes'\)::interval/,
    'preview must filter by snapshot freshness within the TTL');
  assert.match(snapQuery.sql, /logout_at IS NULL/,
    'preview must require the player to still be online (no logout)');
  assert.match(snapQuery.sql, /player_pra_restrictions/,
    'preview must LEFT JOIN PRA restrictions to skip them');
  assert.strictEqual(preview.totalEligible, 2, 'PRA-restricted player must be excluded from eligible');
  assert.strictEqual(preview.skippedPraCount, 1, 'PRA-restricted player must be counted as skipped');
  assert.deepStrictEqual(preview.skippedPraIds, [2]);
  assert.strictEqual(preview.overflowCount, 0);
  assert.strictEqual(preview.preview.length, 2);
  assert.deepStrictEqual(preview.preview.map(p => p.identityId), [1, 3]);

  // Cap + overflow: cap=1 with 2 eligible -> preview=1, overflow=1.
  const pdb2 = previewDb();
  const capped = await previewMassTeleport(pdb2, {
    serverId: 1, destinationId: 7, actorUserId: 9, ttlMinutes: 10, cap: 1,
  });
  assert.strictEqual(capped.preview.length, 1);
  assert.strictEqual(capped.overflowCount, 1, 'overflow beyond the cap must be reported');

  // TTL bounds validation.
  await assert.rejects(previewMassTeleport(previewDb(), {
    serverId: 1, destinationId: 7, actorUserId: 9, ttlMinutes: 0,
  }), /TTL/i);

  // Execute: queues the eligible ones; PRA (id 2) and live-request (id 3) fail
  // per-identity without sinking the others.
  const edb = executeDb();
  const executed = await executeMassTeleport(edb, {
    serverId: 1, actorUserId: 9, destinationId: 7,
    identities: [
      { identityId: 1, position: [10, 5, 20], observedAt: new Date() },
      { identityId: 2, position: [11, 6, 21], observedAt: new Date() },
      { identityId: 3, position: [12, 7, 22], observedAt: new Date() },
    ],
  });
  assert.strictEqual(executed.queued, 1, 'only the unrestricted, non-pending identity should queue');
  assert.strictEqual(executed.failed, 2);
  const byId = Object.fromEntries(executed.results.map(r => [r.identityId, r]));
  assert.strictEqual(byId[1].status, 'queued');
  assert.strictEqual(byId[2].reason, 'PRA_RESTRICTED');
  assert.strictEqual(byId[3].reason, 'TELEPORT_ALREADY_PENDING');
  // The queued request must bind the snapshot coords as the source so the
  // processor can claim the online player immediately.
  const insertCall = edb.calls.find(c => c.kind === 'query' && /INSERT INTO teleport_requests/.test(c.sql));
  assert.match(insertCall.sql, /source_pos_x, source_pos_y, source_pos_z, source_observed_at/);
  // Column order: guild_id, server_id, identity_id, destination_id,
  //   restriction_id(NULL), requested_by, source, reason, forced, respect_pra,
  //   notify_player, status -> then source_pos_x/y/z, source_observed_at.
  assert.strictEqual(insertCall.params[8], 10, 'source east bound from the snapshot');
  assert.strictEqual(insertCall.params[9], 5, 'source elevation bound from the snapshot');
  assert.strictEqual(insertCall.params[10], 20, 'source north bound from the snapshot');

  // requestModeratorTeleportCoords rejects a bad source position.
  const badCoordDb = executeDb();
  await assert.rejects(requestModeratorTeleportCoords(badCoordDb, {
    serverId: 1, identityId: 1, destinationId: 7, actorUserId: 9, source: 'admin',
    sourcePosX: Number.NaN, sourcePosY: 5, sourcePosZ: 20,
  }), /source coordinate position/i);

  console.log('✅ tp-everyone mass teleport tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
