'use strict';

const { admTupleToWorld } = require('../utils/dayzCoordinates');
const { FINANCIAL_LINK_METHODS, isFinancialLinkMethod } = require('../utils/linkTrust');
const { lockUserRoleMutations } = require('../utils/roleMutationLocks');
const { chargeTeleportCost } = require('./teleportCostService');

// Player-sourced teleport paths. 'shop' is the shop checkout (paid via the
// shop order, no wallet cost); 'player' is a self-service teleport request
// (the Phase B /player command) and is the path the per-teleport wallet cost
// is charged to, when the server has the feature enabled.
const PLAYER_SOURCES = new Set(['shop', 'player']);

function positiveId(value, label) {
  const canonical = typeof value === 'number'
    ? Number.isSafeInteger(value) && value > 0
    : typeof value === 'string' && /^[1-9]\d*$/.test(value);
  if (!canonical) throw new Error(`${label} is required`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${label} is required`);
  return number;
}

function boundedText(value, maximum, label) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > maximum) throw new Error(`${label} is invalid`);
  return value.trim() || null;
}

function teleportError(code, message, status = 409) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

async function lockActiveServer(db, serverId) {
  const server = await db.get(
    "SELECT id, guild_id FROM servers WHERE id = ? AND status = 'active' FOR UPDATE",
    [serverId]
  );
  if (!server) throw teleportError('SERVER_UNAVAILABLE', 'Server is unavailable', 404);
  return server;
}

async function lockPlayerAuthority(db, { serverId, identityId, actorUserId }) {
  const methods = [...FINANCIAL_LINK_METHODS];
  const link = await db.get(
    `SELECT id, verification_method FROM linked_accounts
     WHERE user_id = ? AND identity_id = ?
       AND verification_method IN (${methods.map(() => '?').join(', ')})
     FOR UPDATE`,
    [actorUserId, identityId, ...methods]
  );
  if (!link || !isFinancialLinkMethod(link.verification_method)) {
    throw teleportError('TELEPORT_UNAUTHORIZED', 'Player identity link was revoked', 403);
  }
  const membership = await db.get(
    `SELECT id, server_id, guild_id, identity_id, user_id, source_link_id
     FROM server_player_memberships
     WHERE server_id = ? AND identity_id = ? AND user_id = ? AND source_link_id = ?
       AND status = 'active'
     FOR UPDATE`,
    [serverId, identityId, actorUserId, link.id]
  );
  if (!membership) {
    throw teleportError('TELEPORT_UNAUTHORIZED', 'Player identity is not active on this server', 403);
  }
  return membership;
}

async function lockDestination(db, { serverId, guildId, destinationId, allowPrivate = false }) {
  const privateClause = allowPrivate ? '' : ' AND is_private = FALSE';
  const destination = await db.get(
    `SELECT id, server_id, guild_id, name, map_name, destination_type,
            pos_x, pos_y, pos_z, is_private, is_active
     FROM teleport_destinations
     WHERE id = ? AND server_id = ? AND guild_id = ? AND is_active = TRUE${privateClause}
     FOR UPDATE`,
    [destinationId, serverId, guildId]
  );
  if (!destination) {
    throw teleportError('TELEPORT_DESTINATION_UNAVAILABLE', 'Teleport destination is unavailable', 404);
  }
  return destination;
}

async function lockActiveRestriction(db, serverId, identityId) {
  return db.get(
    `SELECT id, destination_id, status FROM player_pra_restrictions
     WHERE server_id = ? AND identity_id = ? AND status = 'active'
     FOR UPDATE`,
    [serverId, identityId]
  );
}

async function assertNoLiveRequest(db, serverId, identityId) {
  const existing = await db.get(
    `SELECT id, status FROM teleport_requests
     WHERE server_id = ? AND identity_id = ?
       AND status IN ('waiting_disconnect', 'provisioning', 'armed', 'cleanup_pending', 'cleanup_processing', 'cleanup_restart_pending')
     FOR UPDATE`,
    [serverId, identityId]
  );
  if (existing) {
    throw teleportError('TELEPORT_ALREADY_PENDING', 'Player already has a pending teleport request');
  }
}

async function lockPlayerTeleportEligibility(db, input) {
  const serverId = positiveId(input.serverId, 'Canonical server ID');
  const identityId = positiveId(input.identityId, 'Player identity ID');
  const actorUserId = positiveId(input.actorUserId, 'Actor user ID');
  const destinationId = positiveId(input.destinationId, 'Teleport destination ID');
  const source = boundedText(input.source, 32, 'Teleport source');
  if (!PLAYER_SOURCES.has(source)) throw new Error('Player teleport source is invalid');

  const server = await lockActiveServer(db, serverId);
  const membership = await lockPlayerAuthority(db, { serverId, identityId, actorUserId });
  if (Number(membership.guild_id) !== Number(server.guild_id)) {
    throw teleportError('TELEPORT_UNAUTHORIZED', 'Player membership does not belong to this server', 403);
  }
  const destination = await lockDestination(db, {
    serverId, guildId: server.guild_id, destinationId, allowPrivate: false,
  });
  const restriction = await lockActiveRestriction(db, serverId, identityId);
  if (restriction && Number(restriction.destination_id) !== destinationId) {
    throw teleportError('PRA_RESTRICTED', 'Active PRA restriction prevents this teleport');
  }
  await assertNoLiveRequest(db, serverId, identityId);
  return { server, membership, destination, restriction, source };
}

async function requestPlayerTeleport(db, input) {
  const eligible = await lockPlayerTeleportEligibility(db, input);
  const reason = boundedText(input.reason, 500, 'Teleport reason');
  const orderItemId = input.orderItemId == null
    ? null : positiveId(input.orderItemId, 'Shop order item ID');
  const rows = await db.query(
    `INSERT INTO teleport_requests
       (guild_id, server_id, identity_id, destination_id, restriction_id,
        requested_by_user_id, order_item_id, source, reason, forced, respect_pra,
        notify_player, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, FALSE, TRUE, ?, 'waiting_disconnect')
     RETURNING *`,
    [
      eligible.server.guild_id, Number(input.serverId), Number(input.identityId),
      eligible.destination.id, eligible.restriction?.id || null, Number(input.actorUserId),
      orderItemId, eligible.source, reason, input.notifyPlayer !== false,
    ]
  );
  const request = rows[0];
  // Player-sourced teleports pay the per-teleport wallet cost (when the
  // server has the feature enabled). Shop-sourced teleports are paid through
  // the shop order and must never carry a second wallet charge. Charging
  // here (inside the caller's transaction) means a failed charge rolls the
  // request back atomically.
  if (eligible.source !== 'shop') {
    await chargeTeleportCost(db, {
      serverId: Number(input.serverId),
      identityId: Number(input.identityId),
      requestId: request.id,
    });
  }
  await db.query(
    `INSERT INTO teleport_events
       (request_id, guild_id, server_id, identity_id, actor_user_id, event_type, metadata)
     VALUES (?, ?, ?, ?, ?, 'requested', ?)`,
    [request.id, request.guild_id, request.server_id, request.identity_id,
      Number(input.actorUserId), JSON.stringify({ source: eligible.source, destinationId: eligible.destination.id })]
  );
  return request;
}

async function lockModeratorAuthorization(db, input) {
  const serverId = positiveId(input.serverId, 'Canonical server ID');
  const actorUserId = positiveId(input.actorUserId, 'Actor user ID');
  await lockUserRoleMutations(db, [actorUserId]);
  const server = await db.get(
    "SELECT id, guild_id FROM servers WHERE id = ? AND status = 'active' FOR UPDATE",
    [serverId]
  );
  if (!server) throw teleportError('TELEPORT_UNAUTHORIZED', 'Server is unavailable', 403);
  const guildId = Number(server.guild_id);
  const guild = await db.get(
    "SELECT id FROM guilds WHERE id = ? AND status = 'approved' FOR UPDATE", [guildId]
  );
  if (!guild) throw teleportError('TELEPORT_UNAUTHORIZED', 'Guild is unavailable', 403);
  const guildRole = await db.get(
    'SELECT role FROM guild_roles WHERE guild_id = ? AND user_id = ? FOR UPDATE',
    [guildId, actorUserId]
  );
  const serverRole = await db.get(
    `SELECT role, status FROM server_role_assignments
     WHERE server_id = ? AND guild_id = ? AND user_id = ? FOR UPDATE`,
    [serverId, guildId, actorUserId]
  );
  const authorized = ['owner', 'admin'].includes(guildRole?.role) ||
    (['admin', 'moderator'].includes(serverRole?.role) && serverRole.status === 'active');
  if (!authorized) throw teleportError('TELEPORT_UNAUTHORIZED', 'Server moderation permission is required', 403);
  return { serverId, guildId, actorUserId };
}

async function requestModeratorTeleport(db, input) {
  const { serverId, guildId, actorUserId } = await lockModeratorAuthorization(db, input);
  const identityId = positiveId(input.identityId, 'Player identity ID');
  const destinationId = positiveId(input.destinationId, 'Teleport destination ID');
  const source = boundedText(input.source, 32, 'Teleport source');
  if (!['admin', 'console', 'punishment', 'pra_enforcement'].includes(source)) {
    throw new Error('Moderator teleport source is invalid');
  }
  const membership = await db.get(
    `SELECT id FROM server_player_memberships
     WHERE server_id = ? AND guild_id = ? AND identity_id = ? AND status = 'active'
     FOR UPDATE`,
    [serverId, guildId, identityId]
  );
  if (!membership) throw teleportError('TELEPORT_TARGET_UNAVAILABLE', 'Player is not active on this server', 404);
  await lockDestination(db, {
    serverId, guildId, destinationId, allowPrivate: true,
  });
  const restriction = await lockActiveRestriction(db, serverId, identityId);
  const overridePra = input.overridePra === true;
  if (restriction && Number(restriction.destination_id) !== destinationId && !overridePra) {
    throw teleportError('PRA_RESTRICTED', 'Active PRA restriction prevents this teleport');
  }
  await assertNoLiveRequest(db, serverId, identityId);
  const rows = await db.query(
    `INSERT INTO teleport_requests
       (guild_id, server_id, identity_id, destination_id, restriction_id,
        requested_by_user_id, source, reason, forced, respect_pra, notify_player, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting_disconnect') RETURNING *`,
    [guildId, serverId, identityId, destinationId, restriction?.id || null, actorUserId,
      source, boundedText(input.reason, 500, 'Teleport reason'), overridePra,
      !overridePra, input.notifyPlayer !== false]
  );
  const request = rows[0];
  await db.query(
    `INSERT INTO teleport_events
       (request_id, guild_id, server_id, identity_id, actor_user_id, event_type, metadata)
     VALUES (?, ?, ?, ?, ?, 'requested', ?)`,
    [request.id, guildId, serverId, identityId, actorUserId,
      JSON.stringify({ source, destinationId, overridePra })]
  );
  return request;
}

async function requestModeratorTeleportCoords(db, input) {
  // Coordinate/mass teleport variant of requestModeratorTeleport: the destination
  // is a real (possibly 'coords') destination ID, and the player's current
  // snapshot position is bound as the request source at insert time. Binding
  // the source up front is what lets the processor claim an ONLINE player
  // immediately (the normal next-login path instead waits for a disconnect /
  // logout snapshot that may not arrive for a player still in-game).
  const { serverId, guildId, actorUserId } = await lockModeratorAuthorization(db, input);
  const identityId = positiveId(input.identityId, 'Player identity ID');
  const destinationId = positiveId(input.destinationId, 'Teleport destination ID');
  const source = boundedText(input.source, 32, 'Teleport source');
  if (!['admin', 'console', 'punishment', 'pra_enforcement'].includes(source)) {
    throw new Error('Moderator teleport source is invalid');
  }
  const sourcePosition = [input.sourcePosX, input.sourcePosY, input.sourcePosZ].map(Number);
  if (sourcePosition.some(coordinate => typeof coordinate !== 'number' || !Number.isFinite(coordinate))) {
    throw new Error('Teleport source coordinate position is invalid');
  }
  const membership = await db.get(
    `SELECT id FROM server_player_memberships
     WHERE server_id = ? AND guild_id = ? AND identity_id = ? AND status = 'active'
     FOR UPDATE`,
    [serverId, guildId, identityId]
  );
  if (!membership) throw teleportError('TELEPORT_TARGET_UNAVAILABLE', 'Player is not active on this server', 404);
  await lockDestination(db, { serverId, guildId, destinationId, allowPrivate: true });
  const restriction = await lockActiveRestriction(db, serverId, identityId);
  // A coordinate mass-teleport has no single destination to compare a PRA
  // restriction against, so any active PRA restriction blocks it. Callers that
  // want to skip (and report) restricted players filter them before calling.
  if (restriction) {
    throw teleportError('PRA_RESTRICTED', 'Active PRA restriction prevents this teleport');
  }
  await assertNoLiveRequest(db, serverId, identityId);
  const observedAt = input.sourceObservedAt || new Date();
  const rows = await db.query(
    `INSERT INTO teleport_requests
       (guild_id, server_id, identity_id, destination_id, restriction_id,
        requested_by_user_id, source, reason, forced, respect_pra, notify_player,
        status, source_pos_x, source_pos_y, source_pos_z, source_observed_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, FALSE, TRUE, ?,
             'waiting_disconnect', ?, ?, ?, ?) RETURNING *`,
    [guildId, serverId, identityId, destinationId, actorUserId, source,
      boundedText(input.reason, 500, 'Teleport reason'), input.notifyPlayer !== false,
      sourcePosition[0], sourcePosition[1], sourcePosition[2], observedAt]
  );
  const request = rows[0];
  await db.query(
    `INSERT INTO teleport_events
       (request_id, guild_id, server_id, identity_id, actor_user_id, event_type, metadata)
     VALUES (?, ?, ?, ?, ?, 'requested', ?)`,
    [request.id, guildId, serverId, identityId, actorUserId,
      JSON.stringify({ source, destinationId, sourceType: 'mass_snapshot', sourcePosition })]
  );
  return request;
}

/**
 * Mass teleport preview: find online players on the server whose latest
 * position snapshot is fresh within `ttlMinutes`, minus those under an active
 * PRA restriction, capped at `cap`. The preview returns the full eligible list
 * with overflow counted but NOT queued — the caller shows it, then invokes
 * executeMassTeleport to queue the same identities (re-verified there).
 */
async function previewMassTeleport(db, input) {
  const { serverId, guildId } = await lockModeratorAuthorization(db, input);
  const destinationId = positiveId(input.destinationId, 'Teleport destination ID');
  const ttlMinutes = Number(input.ttlMinutes ?? 10);
  if (!Number.isFinite(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 1440) {
    throw new Error('Mass teleport TTL must be between 1 and 1440 minutes');
  }
  const cap = Number(input.cap ?? 25);
  if (!Number.isInteger(cap) || cap < 1 || cap > 500) {
    throw new Error('Mass teleport cap must be between 1 and 500');
  }
  await lockDestination(db, { serverId, guildId, destinationId, allowPrivate: true });
  const rows = await db.query(
    `SELECT ps.identity_id, ps.pos_x, ps.pos_y, ps.pos_z, ps.timestamp,
            pr.id AS pra_restriction_id
     FROM player_position_snapshots ps
     JOIN player_sessions psn
       ON psn.server_id = ps.server_id
      AND psn.identity_id = ps.identity_id
      AND psn.logout_at IS NULL
     JOIN server_player_memberships spm
       ON spm.server_id = ps.server_id
      AND spm.identity_id = ps.identity_id
      AND spm.status = 'active'
     LEFT JOIN player_pra_restrictions pr
       ON pr.server_id = ps.server_id
      AND pr.identity_id = ps.identity_id
      AND pr.status = 'active'
     WHERE ps.server_id = ?
       AND ps.identity_id IS NOT NULL
       AND ps.pos_x IS NOT NULL AND ps.pos_y IS NOT NULL AND ps.pos_z IS NOT NULL
       AND ps.timestamp >= NOW() - (? || ' minutes')::interval
     ORDER BY ps.timestamp DESC, ps.id DESC, ps.identity_id`,
    [serverId, String(Math.floor(ttlMinutes))]
  );
  // One row per identity: keep only the freshest snapshot, then classify.
  const latestByIdentity = new Map();
  for (const row of rows) {
    if (!latestByIdentity.has(row.identity_id)) latestByIdentity.set(row.identity_id, row);
  }
  const eligible = [];
  const skippedPra = [];
  for (const row of latestByIdentity.values()) {
    if (row.pra_restriction_id != null) {
      skippedPra.push(row.identity_id);
      continue;
    }
    eligible.push({
      identityId: row.identity_id,
      position: [Number(row.pos_x), Number(row.pos_y), Number(row.pos_z)],
      observedAt: row.timestamp,
    });
  }
  eligible.sort((a, b) => new Date(b.observedAt) - new Date(a.observedAt));
  return {
    destinationId,
    ttlMinutes,
    cap,
    totalEligible: eligible.length,
    skippedPraCount: skippedPra.length,
    overflowCount: Math.max(0, eligible.length - cap),
    preview: eligible.slice(0, cap),
    skippedPraIds: skippedPra,
  };
}

/**
 * Queue teleports for the given identities (as returned by
 * previewMassTeleport.preview). Each identity is queued independently via the
 * coordinate variant so one bad player cannot sink the rest; failures are
 * reported, not fatal.
 */
async function executeMassTeleport(db, input) {
  const { serverId, actorUserId } = await lockModeratorAuthorization(db, input);
  const destinationId = positiveId(input.destinationId, 'Teleport destination ID');
  const identities = Array.isArray(input.identities) ? input.identities : [];
  if (identities.length === 0) {
    return { queued: 0, failed: 0, skipped: 0, results: [] };
  }
  const results = [];
  for (const identity of identities) {
    const identityId = positiveId(identity.identityId, 'Player identity ID');
    try {
      const request = await requestModeratorTeleportCoords(db, {
        serverId,
        identityId,
        destinationId,
        actorUserId,
        source: 'admin',
        reason: input.reason || 'mass teleport',
        sourcePosX: identity.position[0],
        sourcePosY: identity.position[1],
        sourcePosZ: identity.position[2],
        sourceObservedAt: identity.observedAt || new Date(),
      });
      results.push({ identityId, requestId: request.id, status: 'queued' });
    } catch (error) {
      results.push({
        identityId,
        status: 'failed',
        reason: error.code || error.message,
      });
    }
  }
  return {
    queued: results.filter(r => r.status === 'queued').length,
    failed: results.filter(r => r.status === 'failed').length,
    skipped: 0,
    results,
  };
}

async function resolveTeleportSource(db, request) {
  const toEnforceVector = row => {
    const world = admTupleToWorld(row);
    if (world.elevation === null) throw new Error('Teleport source elevation is unavailable');
    return [world.east, world.elevation, world.north];
  };
  const disconnect = await db.get(
    `SELECT pos_x, pos_y, pos_z, observed_at
     FROM player_disconnect_positions
     WHERE server_id = ? AND identity_id = ?
       AND observed_at >= ? AND observed_at <= ?
     ORDER BY observed_at DESC, id DESC
     LIMIT 1`,
    [request.server_id, request.identity_id, request.requested_at, request.expires_at]
  );
  if (disconnect) {
    return {
      position: toEnforceVector(disconnect),
      observedAt: disconnect.observed_at instanceof Date
        ? disconnect.observed_at.toISOString() : disconnect.observed_at,
      sourceType: 'disconnect',
    };
  }
  const session = await db.get(
    `SELECT logout_at FROM player_sessions
     WHERE server_id = ? AND identity_id = ?
       AND logout_at >= ? AND logout_at <= ?
     ORDER BY logout_at DESC, id DESC
     LIMIT 1`,
    [request.server_id, request.identity_id, request.requested_at, request.expires_at]
  );
  if (!session) return null;
  const snapshot = await db.get(
    `SELECT pos_x, pos_y, pos_z, timestamp
     FROM player_position_snapshots
     WHERE server_id = ? AND identity_id = ?
       AND timestamp <= ? AND timestamp >= ?::timestamptz - INTERVAL '10 minutes'
       AND pos_x IS NOT NULL AND pos_y IS NOT NULL AND pos_z IS NOT NULL
     ORDER BY timestamp DESC, id DESC
     LIMIT 1`,
    [request.server_id, request.identity_id, session.logout_at, session.logout_at]
  );
  if (!snapshot) return null;
  return {
    position: toEnforceVector(snapshot),
    observedAt: session.logout_at instanceof Date ? session.logout_at.toISOString() : session.logout_at,
    sourceType: 'logout_snapshot',
  };
}

module.exports = {
  requestPlayerTeleport,
  requestModeratorTeleport,
  requestModeratorTeleportCoords,
  previewMassTeleport,
  executeMassTeleport,
  lockModeratorAuthorization,
  lockPlayerTeleportEligibility,
  lockDestination,
  resolveTeleportSource,
  teleportError,
};
