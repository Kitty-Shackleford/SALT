'use strict';

const { lockUserRoleMutations } = require('../utils/roleMutationLocks');
const { normalizeDestination } = require('../utils/teleportPolicy');
const { teleportError } = require('./teleportService');

function positiveId(value, label) {
  const valid = typeof value === 'number'
    ? Number.isSafeInteger(value) && value > 0
    : typeof value === 'string' && /^[1-9]\d*$/.test(value);
  if (!valid) throw new Error(`${label} is required`);
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw new Error(`${label} is required`);
  return id;
}

async function lockDestinationManager(db, input) {
  const serverId = positiveId(input.serverId, 'Canonical server ID');
  const guildId = positiveId(input.guildId, 'Canonical guild ID');
  const actorUserId = positiveId(input.actorUserId, 'Actor user ID');
  await lockUserRoleMutations(db, [actorUserId]);
  const scope = await db.get(
    `SELECT s.id AS server_id, s.guild_id
     FROM guilds g
     JOIN servers s ON s.guild_id = g.id
     WHERE g.id = ? AND s.id = ? AND g.status = 'approved' AND s.status = 'active'
     FOR UPDATE OF g, s`,
    [guildId, serverId]
  );
  if (!scope) throw teleportError('TELEPORT_UNAUTHORIZED', 'Server is unavailable', 403);
  const guildRole = await db.get(
    `SELECT id, role FROM guild_roles
     WHERE guild_id = ? AND user_id = ? AND role IN ('owner', 'admin')
     FOR UPDATE`,
    [guildId, actorUserId]
  );
  let serverRole = null;
  if (!guildRole) {
    serverRole = await db.get(
      `SELECT id, role FROM server_role_assignments
       WHERE server_id = ? AND guild_id = ? AND user_id = ?
         AND role = 'admin' AND status = 'active'
       FOR UPDATE`,
      [serverId, guildId, actorUserId]
    );
  }
  if (!guildRole && !serverRole) {
    throw teleportError('TELEPORT_UNAUTHORIZED', 'Server management permission is required', 403);
  }
  return { serverId, guildId, actorUserId };
}

async function recordDestinationAudit(db, scope, action, destinationId, metadata = {}) {
  await db.query(
    `INSERT INTO security_audit_events
       (guild_id, server_id, actor_user_id, action, result, target_type, target_id, metadata)
     VALUES (?, ?, ?, ?, 'allowed', 'teleport_destination', ?, ?)`,
    [scope.guildId, scope.serverId, scope.actorUserId, action, String(destinationId),
      JSON.stringify(metadata)]
  );
}

async function listTeleportDestinations(db, input) {
  const serverId = positiveId(input.serverId, 'Canonical server ID');
  const guildId = positiveId(input.guildId, 'Canonical guild ID');
  return db.all(
    `SELECT id, server_id, guild_id, name, map_name, destination_type,
            pos_x, pos_y, pos_z, is_private, is_active, created_at, updated_at
     FROM teleport_destinations
     WHERE server_id = ? AND guild_id = ?
     ORDER BY is_active DESC, lower(name), id`,
    [serverId, guildId]
  );
}

async function createTeleportDestination(db, input) {
  const destination = normalizeDestination(input);
  const scope = await lockDestinationManager(db, input);
  const rows = await db.query(
    `INSERT INTO teleport_destinations
       (guild_id, server_id, name, map_name, destination_type,
        pos_x, pos_y, pos_z, is_private, created_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING *`,
    [scope.guildId, scope.serverId, destination.name, destination.mapName,
      destination.destinationType, ...destination.position, destination.isPrivate,
      scope.actorUserId]
  );
  const created = rows[0];
  await recordDestinationAudit(db, scope, 'teleport_destination.created', created.id, {
    destinationType: destination.destinationType,
    isPrivate: destination.isPrivate,
  });
  return created;
}

async function deactivateTeleportDestination(db, input) {
  const destinationId = positiveId(input.destinationId, 'Teleport destination ID');
  const scope = await lockDestinationManager(db, input);
  const destination = await db.get(
    `SELECT id, server_id, guild_id, is_active
     FROM teleport_destinations
     WHERE id = ? AND server_id = ? AND guild_id = ? AND is_active = TRUE
     FOR UPDATE`,
    [destinationId, scope.serverId, scope.guildId]
  );
  if (!destination) {
    throw teleportError('TELEPORT_DESTINATION_UNAVAILABLE', 'Teleport destination is unavailable', 404);
  }
  const liveRequest = await db.get(
    `SELECT id FROM teleport_requests
     WHERE destination_id = ? AND server_id = ? AND guild_id = ?
       AND status IN ('waiting_disconnect', 'provisioning', 'armed', 'cleanup_pending', 'cleanup_processing', 'cleanup_restart_pending')
     LIMIT 1 FOR UPDATE`,
    [destinationId, scope.serverId, scope.guildId]
  );
  if (liveRequest) {
    throw teleportError('TELEPORT_DESTINATION_IN_USE', 'Teleport destination has a pending request');
  }
  const activeRestriction = await db.get(
    `SELECT id FROM player_pra_restrictions
     WHERE destination_id = ? AND server_id = ? AND guild_id = ? AND status = 'active'
     LIMIT 1 FOR UPDATE`,
    [destinationId, scope.serverId, scope.guildId]
  );
  if (activeRestriction) {
    throw teleportError('TELEPORT_DESTINATION_IN_USE', 'Teleport destination has an active PRA restriction');
  }
  const rows = await db.query(
    `UPDATE teleport_destinations
     SET is_active = FALSE, updated_at = NOW()
     WHERE id = ? AND server_id = ? AND guild_id = ? AND is_active = TRUE
     RETURNING *`,
    [destinationId, scope.serverId, scope.guildId]
  );
  const deactivated = rows[0];
  if (!deactivated) {
    throw teleportError('TELEPORT_DESTINATION_UNAVAILABLE', 'Teleport destination is unavailable', 404);
  }
  await recordDestinationAudit(db, scope, 'teleport_destination.deactivated', destinationId);
  return deactivated;
}

module.exports = {
  createTeleportDestination,
  deactivateTeleportDestination,
  listTeleportDestinations,
};
