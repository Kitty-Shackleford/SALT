'use strict';

const {
  lockModeratorAuthorization,
  requestModeratorTeleport,
  teleportError,
} = require('./teleportService');

function positiveId(value, label) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`${label} is invalid`);
  return id;
}

async function imposePraRestriction(db, input) {
  const scope = await lockModeratorAuthorization(db, input);
  const identityId = positiveId(input.identityId, 'Player identity ID');
  const destinationId = positiveId(input.destinationId, 'Teleport destination ID');
  const destination = await db.get(
    `SELECT id, destination_type, is_active
     FROM teleport_destinations
     WHERE id = ? AND server_id = ? AND guild_id = ? AND is_active = TRUE
     FOR UPDATE`,
    [destinationId, scope.serverId, scope.guildId]
  );
  if (!destination || destination.destination_type !== 'punishment') {
    throw teleportError(
      'TELEPORT_DESTINATION_INVALID',
      'An active punishment destination on this server is required',
      400
    );
  }
  const existing = await db.get(
    `SELECT id FROM player_pra_restrictions
     WHERE server_id = ? AND identity_id = ? AND status = 'active'
     FOR UPDATE`,
    [scope.serverId, identityId]
  );
  if (existing) {
    throw teleportError('PRA_RESTRICTION_EXISTS', 'Player already has an active PRA restriction', 409);
  }

  const request = await requestModeratorTeleport(db, {
    serverId: scope.serverId,
    identityId,
    destinationId,
    actorUserId: scope.actorUserId,
    source: 'punishment',
    reason: input.reason,
    overridePra: true,
    notifyPlayer: input.notifyPlayer,
  });
  const rows = await db.query(
    `INSERT INTO player_pra_restrictions
       (guild_id, server_id, identity_id, destination_id, status, reason,
        imposed_by_user_id)
     VALUES (?, ?, ?, ?, 'active', ?, ?) RETURNING *`,
    [
      scope.guildId, scope.serverId, identityId, destinationId,
      input.reason == null ? null : String(input.reason).trim().slice(0, 500),
      scope.actorUserId,
    ]
  );
  const restriction = rows[0];
  await db.query(
    'UPDATE teleport_requests SET restriction_id = ? WHERE id = ? RETURNING id',
    [restriction.id, request.id]
  );
  await db.query(
    `INSERT INTO teleport_events
       (request_id, guild_id, server_id, identity_id, actor_user_id, event_type, metadata)
     VALUES (?, ?, ?, ?, ?, 'restriction_imposed', ?)`,
    [request.id, scope.guildId, scope.serverId, identityId, scope.actorUserId,
      JSON.stringify({ restrictionId: restriction.id, destinationId })]
  );
  return { restriction, request };
}

async function releasePraRestriction(db, input) {
  const scope = await lockModeratorAuthorization(db, input);
  const restrictionId = positiveId(input.restrictionId, 'Restriction ID');
  const restriction = await db.get(
    `SELECT id, guild_id, server_id, identity_id, status
     FROM player_pra_restrictions
     WHERE id = ? AND server_id = ? AND guild_id = ? AND status = 'active'
     FOR UPDATE`,
    [restrictionId, scope.serverId, scope.guildId]
  );
  if (!restriction) {
    throw teleportError('PRA_RESTRICTION_NOT_FOUND', 'Active PRA restriction was not found', 404);
  }
  const request = await db.get(
    `SELECT id, status FROM teleport_requests
     WHERE restriction_id = ? AND server_id = ?
     ORDER BY id DESC LIMIT 1 FOR UPDATE`,
    [restrictionId, scope.serverId]
  );
  if (!request) throw teleportError('PRA_RESTRICTION_INVALID', 'Restriction has no audit request', 409);
  if (['provisioning', 'armed'].includes(request.status)) {
    throw teleportError(
      'PRA_RESTRICTION_IN_FLIGHT',
      'Restriction cannot be released while its teleport is being provisioned',
      409
    );
  }
  if (request.status === 'waiting_disconnect') {
    await db.query(
      `UPDATE teleport_requests SET status = 'cancelled', updated_at = NOW()
       WHERE id = ? AND server_id = ? AND status = 'waiting_disconnect'`,
      [request.id, scope.serverId]
    );
    await db.query(
      `INSERT INTO teleport_events
         (request_id, guild_id, server_id, identity_id, actor_user_id, event_type, metadata)
       VALUES (?, ?, ?, ?, ?, 'cancelled', ?)`,
      [request.id, scope.guildId, scope.serverId, restriction.identity_id, scope.actorUserId,
        JSON.stringify({ reason: 'restriction_released' })]
    );
  }

  const rows = await db.query(
    `UPDATE player_pra_restrictions
     SET status = 'released', released_at = NOW(), released_by_user_id = ?
     WHERE id = ? AND status = 'active' RETURNING *`,
    [scope.actorUserId, restrictionId]
  );
  if (!rows[0]) throw teleportError('PRA_RESTRICTION_NOT_FOUND', 'Restriction is no longer active', 409);
  await db.query(
    `INSERT INTO teleport_events
       (request_id, guild_id, server_id, identity_id, actor_user_id, event_type, metadata)
     VALUES (?, ?, ?, ?, ?, 'restriction_released', ?)`,
    [request.id, scope.guildId, scope.serverId, restriction.identity_id, scope.actorUserId,
      JSON.stringify({ restrictionId })]
  );
  return rows[0];
}

module.exports = { imposePraRestriction, releasePraRestriction };
