'use strict';

const { ensureTestEncryptionKey } = require('./lib/test-env');
ensureTestEncryptionKey();

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { normalizeDestination } = require('../utils/teleportPolicy');
const {
  createCoordinateDestination,
  listTeleportDestinations,
} = require('../services/teleportDestinationService');
const { loadCommands } = require('../bot/deploy-commands');

// --- Command shape: mod-only coordinate destination, subcommand 'add' ---
const commandSource = fs.readFileSync(path.join(__dirname, '..', 'bot', 'commands', 'tp-coord.js'), 'utf8');
assert.match(commandSource, /createCoordinateDestination/);
assert.match(commandSource, /interaction\.authorizedServerId/);
assert.match(commandSource, /destinationType: 'coords'/);
assert.match(commandSource, /setRequired\(true\)/);

const authorizationSource = fs.readFileSync(path.join(__dirname, '..', 'bot', 'utils', 'commandAuthorization.js'), 'utf8');
assert.match(authorizationSource, /'tp-coord':\s*'server_moderate'/);
assert.match(authorizationSource, /'tp-everyone':\s*'server_moderate'/);
assert.match(authorizationSource, /'tp-event':\s*'server_moderate'/);

// The tp-coord command must be loadable and expose an 'add' subcommand.
const commands = loadCommands();
const tpCoord = commands.find(c => c.name === 'tp-coord');
assert(tpCoord, 'tp-coord must be deployable');
assert(tpCoord.options.some(o => o.type === 1 && o.name === 'add'),
  'tp-coord must have an add subcommand');

// --- Policy: coords is now a valid destination type, bounds still enforced ---
assert.deepStrictEqual(normalizeDestination({
  name: 'North Gate',
  mapName: 'sakhal',
  position: [10.5, 2, 30.25],
  destinationType: 'coords',
}), {
  name: 'North Gate',
  mapName: 'sakhal',
  position: [10.5, 2, 30.25],
  destinationType: 'coords',
  isPrivate: false,
});
assert.throws(() => normalizeDestination({
  name: 'Beyond', mapName: 'sakhal', position: [20000, 5, 5], destinationType: 'coords',
}), /outside the map bounds/i);
assert.throws(() => normalizeDestination({
  name: 'NaN', mapName: 'sakhal', position: [NaN, 1, 2], destinationType: 'coords',
}), /position/i);
assert.throws(() => normalizeDestination({
  name: 'Bad type', mapName: 'sakhal', position: [1, 2, 3], destinationType: 'coords2',
}), /type/i);

// --- Service: creates with moderator auth and the coords type ---
function fakeModDb({ destinationType = 'coords', guildRole = 'owner' } = {}) {
  const calls = [];
  return {
    calls,
    async get(sql, params) {
      calls.push({ kind: 'get', sql, params });
      if (/pg_advisory_xact_lock/.test(sql)) return {};
      if (/FROM servers/.test(sql)) return { id: 1, guild_id: 2 };
      if (/FROM guilds/.test(sql)) return { id: 2 };
      if (/FROM guild_roles/.test(sql)) return { role: guildRole };
      if (/FROM server_role_assignments/.test(sql)) return null;
      throw new Error(`Unexpected get: ${sql}`);
    },
    async query(sql, params) {
      calls.push({ kind: 'query', sql, params });
      if (/INSERT INTO teleport_destinations/.test(sql)) {
        return [{
          id: 31, server_id: 1, guild_id: 2, name: 'North Gate',
          map_name: 'sakhal', destination_type: destinationType,
          pos_x: 10.5, pos_y: 2, pos_z: 30.25, is_private: false, is_active: true,
        }];
      }
      if (/INSERT INTO security_audit_events/.test(sql)) return [];
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

(async () => {
  const db = fakeModDb();
  const created = await createCoordinateDestination(db, {
    serverId: 1,
    actorUserId: 9,
    name: 'North Gate',
    mapName: 'sakhal',
    destinationType: 'coords',
    position: [10.5, 2, 30.25],
  });
  assert.strictEqual(created.id, 31);
  assert.strictEqual(created.destination_type, 'coords');
  const insertCall = db.calls.find(c => c.kind === 'query' && /INSERT INTO teleport_destinations/.test(c.sql));
  assert.match(insertCall.sql, /'coords'/, 'the INSERT must hardcode the coords destination type');
  assert.strictEqual(insertCall.params[0], 2, 'guild_id is the first parameter');
  assert.strictEqual(insertCall.params[2], 'North Gate', 'name is the third parameter');
  assert.deepStrictEqual(insertCall.params.slice(4, 7), [10.5, 2, 30.25],
    'position parameters follow the hardcoded type');
  assert(db.calls.some(c => c.kind === 'get' && /pg_advisory_xact_lock/.test(c.sql)),
    'moderator auth must lock the actor role');
  assert(db.calls.some(c => c.kind === 'query' && /INSERT INTO security_audit_events/.test(c.sql)),
    'coord destination creation must be audited');

  // A non-coords type must be rejected by this entry point.
  const badTypeDb = fakeModDb();
  await assert.rejects(createCoordinateDestination(badTypeDb, {
    serverId: 1, actorUserId: 9, name: 'X', mapName: 'sakhal',
    destinationType: 'named', position: [1, 2, 3],
  }), /must be of type coords/i);

  // A player with no moderation role must be denied.
  const deniedDb = fakeModDb({ guildRole: null });
  deniedDb.calls.length = 0;
  await assert.rejects(createCoordinateDestination(deniedDb, {
    serverId: 1, actorUserId: 9, name: 'X', mapName: 'sakhal',
    destinationType: 'coords', position: [1, 2, 3],
  }), error => error.code === 'TELEPORT_UNAUTHORIZED');
  assert(!deniedDb.calls.some(c => c.kind === 'query' && /INSERT INTO teleport_destinations/.test(c.sql)));

  // --- listTeleportDestinations: activeOnly filter + guild scoping (IDOR) ---
  const listDb = {
    async all(sql, params) {
      assert.match(sql, /WHERE server_id = \? AND guild_id = \? AND is_active = TRUE/);
      assert.deepStrictEqual(params, [1, 2]);
      return [{ id: 1, name: 'A', map_name: 'sakhal', destination_type: 'coords' }];
    },
  };
  const rows = await listTeleportDestinations(listDb, { serverId: 1, guildId: 2, activeOnly: true });
  assert.strictEqual(rows.length, 1);

  console.log('✅ tp-coord command + coordinate destination tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
