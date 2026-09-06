/**
 * Wipe Service — Modular, plugin-style full-wipe registry
 *
 * Handlers register themselves for two operations:
 *   wipePlayerOnServer(db, { serverId, identityId, requestedByUserId })
 *   wipeServer(db, { serverId, requestedByUserId })
 *
 * Each handler is an object with up to two async functions:
 *   { name, wipePlayer, wipeServer }
 *
 * Call registerWipeHandler() once at module load time (or startup).
 * Call wipePlayer() / wipeServer() from route handlers.
 */

'use strict';

/** @type {{ name: string, wipePlayer?: Function, wipeServer?: Function }[]} */
const handlers = [];

/**
 * Register a wipe handler module.
 * @param {{ name: string, wipePlayer?: Function, wipeServer?: Function }} handler
 */
function registerWipeHandler(handler) {
  if (!handler || !handler.name) throw new Error('Wipe handler must have a name');
  handlers.push(handler);
}

// ─── Utility helpers ────────────────────────────────────────────────────────

/**
 * Run a db.run safely, skipping if the table does not exist.
 * Logs a warning on skip so operators can diagnose schema differences.
 * @param {object} db
 * @param {string} sql
 * @param {Array}  params
 * @param {string} tableName  Human-readable table name for warning messages
 */
async function dbRunSafe(db, sql, params, tableName) {
  try {
    await db.run(sql, params);
  } catch (err) {
    if (err && (err.message.includes('no such table') || err.message.includes('does not exist'))) {
      console.warn(`[wipeService] Skipping missing table "${tableName}" — ${err.message}`);
    } else {
      throw err;
    }
  }
}

async function assertActiveOwnerServer(db, { serverId, identityId = null, requestedByUserId }) {
  const identityClause = identityId === null
    ? ''
    : `AND EXISTS (
         SELECT 1
         FROM player_server_activity psa
         WHERE psa.server_id = s.id AND psa.identity_id = ?
       )`;
  const params = [requestedByUserId, serverId];
  if (identityId !== null) params.push(identityId);
  const row = await db.get(
    `SELECT s.id
     FROM servers s
     JOIN guilds g ON g.id = s.guild_id
     JOIN guild_roles gr ON gr.guild_id = g.id AND gr.user_id = ?
     WHERE s.id = ?
       AND s.status = 'active'
       AND g.status = 'approved'
       AND gr.role = 'owner'
       ${identityClause}
     FOR UPDATE OF s, g, gr`,
    params
  );
  if (!row) {
    const error = new Error('Resource not found');
    error.code = 'RESOURCE_NOT_FOUND';
    throw error;
  }
}

async function assertNoActiveBountyEscrow(db, { serverId, identityId = null }) {
  const identityClause = identityId === null
    ? ''
    : 'AND (target_identity_id = ? OR poster_identity_id = ? OR claimed_by_identity_id = ?)';
  const params = [serverId];
  if (identityId !== null) params.push(identityId, identityId, identityId);
  const activeBounty = await db.get(
    `SELECT id FROM bounties
     WHERE server_id = ? AND status = 'active' ${identityClause}
     ORDER BY id
     LIMIT 1
     FOR UPDATE`,
    params
  );
  if (activeBounty) throw new Error('Cannot wipe history with active bounty escrow');
  const casinoParams = [serverId];
  const casinoIdentityClause = identityId === null ? '' : 'AND identity_id = ?';
  if (identityId !== null) casinoParams.push(identityId);
  const activeCasino = await db.get(
    `SELECT session_id FROM casino_sessions
     WHERE server_id = ? AND status = 'active' AND reserved_wager > 0 ${casinoIdentityClause}
     ORDER BY session_id LIMIT 1 FOR UPDATE`, casinoParams
  );
  if (activeCasino) throw new Error('Cannot wipe history with active casino escrow');
}

// ─── Default handlers ────────────────────────────────────────────────────────

/**
 * Stats handler — clears server-scoped combat/session data for a player or server.
 */
registerWipeHandler({
  name: 'stats',

  async wipePlayer(db, { serverId, identityId }) {
    // Delete server-scoped stats rows
    await dbRunSafe(db,
      'DELETE FROM player_stats WHERE identity_id = ? AND server_id = ?',
      [identityId, serverId], 'player_stats');

    await dbRunSafe(db,
      'DELETE FROM player_sessions WHERE identity_id = ? AND server_id = ?',
      [identityId, serverId], 'player_sessions');

    // Kill events are retained because bounty claims and other financial audit
    // rows reference them. A stats wipe clears derived aggregates, not evidence.

    await dbRunSafe(db,
      'DELETE FROM damage_events WHERE server_id = ? AND (attacker_identity_id = ? OR victim_identity_id = ?)',
      [serverId, identityId, identityId], 'damage_events');

    await dbRunSafe(db,
      'DELETE FROM player_health_status WHERE identity_id = ? AND server_id = ?',
      [identityId, serverId], 'player_health_status');

    // Reset activity counters (keep the row so the player is still associated
    // with the server, but zero out all derived fields)
    await dbRunSafe(db,
      `UPDATE player_server_activity
          SET total_sessions = 0, last_seen = NULL
        WHERE identity_id = ? AND server_id = ?`,
      [identityId, serverId], 'player_server_activity');
  },

  async wipeServer(db, { serverId }) {
    await dbRunSafe(db,
      'DELETE FROM player_stats WHERE server_id = ?',
      [serverId], 'player_stats');

    await dbRunSafe(db,
      'DELETE FROM player_sessions WHERE server_id = ?',
      [serverId], 'player_sessions');

    // Retain kill_events for durable bounty/financial audit history.

    await dbRunSafe(db,
      'DELETE FROM damage_events WHERE server_id = ?',
      [serverId], 'damage_events');

    await dbRunSafe(db,
      'DELETE FROM player_health_status WHERE server_id = ?',
      [serverId], 'player_health_status');

    await dbRunSafe(db,
      `UPDATE player_server_activity
          SET total_sessions = 0, last_seen = NULL
        WHERE server_id = ?`,
      [serverId], 'player_server_activity');
  }
});

/**
 * Economy handler — intentionally preserves all balances, escrows, purchases,
 * ledger rows, supply logs, and financial history during stats/history wipes.
 */
registerWipeHandler({
  name: 'economy',
  async wipePlayer() {},
  async wipeServer() {}
});

/**
 * Achievements handler.
 *
 * player_achievements is identity-scoped and does not include server/guild
 * scoping in the current schema, so wipe operations intentionally leave it
 * untouched to avoid cross-server data loss.
 */
registerWipeHandler({
  name: 'achievements',

  async wipePlayer() {},
  async wipeServer() {}
});

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Wipe all tracked data for a single player on a specific server.
 * Runs all registered handlers inside a BEGIN/COMMIT transaction where possible.
 *
 * @param {object} db                    - PostgreSQL db adapter (req.app.locals.db)
 * @param {object} opts
 * @param {number|string} opts.serverId
 * @param {number|string} opts.identityId
 * @param {number|string} opts.requestedByUserId
 */
async function wipePlayer(db, { serverId, identityId, requestedByUserId }) {
  await db.transaction(async () => {
    await assertActiveOwnerServer(db, { serverId, identityId, requestedByUserId });
    await assertNoActiveBountyEscrow(db, { serverId, identityId });
    for (const handler of handlers) {
      if (typeof handler.wipePlayer === 'function') {
        // eslint-disable-next-line no-await-in-loop
        await handler.wipePlayer(db, { serverId, identityId, requestedByUserId });
      }
    }
  });
}

/**
 * Wipe ALL tracked data for every player on a server.
 * Runs all registered handlers inside a single BEGIN/COMMIT transaction.
 *
 * @param {object} db                    - PostgreSQL db adapter (req.app.locals.db)
 * @param {object} opts
 * @param {number|string} opts.serverId
 * @param {number|string} opts.requestedByUserId
 */
async function wipeServer(db, { serverId, requestedByUserId }) {
  await db.transaction(async () => {
    await assertActiveOwnerServer(db, { serverId, requestedByUserId });
    await assertNoActiveBountyEscrow(db, { serverId });
    for (const handler of handlers) {
      if (typeof handler.wipeServer === 'function') {
        // eslint-disable-next-line no-await-in-loop
        await handler.wipeServer(db, { serverId, requestedByUserId });
      }
    }
  });
}

module.exports = { registerWipeHandler, wipePlayer, wipeServer };
