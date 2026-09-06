'use strict';

const { admTupleToWorld } = require('../utils/dayzCoordinates');
const { FINANCIAL_LINK_METHODS, isFinancialLinkMethod } = require('../utils/linkTrust');
const { lockUserRoleMutations } = require('../utils/roleMutationLocks');

const PLAYER_SOURCES = new Set(['shop']);

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
  lockModeratorAuthorization,
  lockPlayerTeleportEligibility,
  resolveTeleportSource,
  teleportError,
};
