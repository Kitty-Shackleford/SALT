'use strict';

const FLAG_POLE_RADIUS_METERS = 60;
const FLAG_POLE_SOURCE = 'https://dayz.fandom.com/wiki/Flag_Pole';
const SUPPORTED_TERRITORY_MAPS = Object.freeze({
  chernarusplus: Object.freeze({ minEast: 0, maxEast: 15360, minNorth: 0, maxNorth: 15360 }),
});
const TERRITORY_STATUSES = Object.freeze(['pending', 'approved', 'rejected', 'revoked']);
const DECISION_NOTE_MAX_LENGTH = 500;

function positiveInteger(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || String(value).trim() !== String(parsed)) {
    throw new TypeError(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

function validateTerritorySubmission(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('territory submission must be an object');
  }
  if (Object.prototype.hasOwnProperty.call(input, 'radiusMeters') ||
      Object.prototype.hasOwnProperty.call(input, 'radius')) {
    throw new TypeError('flag-pole radius is server-defined');
  }
  const mapName = String(input.mapName || '').trim().toLowerCase();
  const bounds = SUPPORTED_TERRITORY_MAPS[mapName];
  if (!bounds) throw new TypeError('mapName is unsupported');
  if (typeof input.poleEast !== 'number' || !Number.isFinite(input.poleEast) ||
      typeof input.poleNorth !== 'number' || !Number.isFinite(input.poleNorth)) {
    throw new TypeError('pole coordinates must be finite numbers');
  }
  if (input.poleEast < bounds.minEast || input.poleEast > bounds.maxEast ||
      input.poleNorth < bounds.minNorth || input.poleNorth > bounds.maxNorth) {
    throw new TypeError('pole coordinates are outside the map bounds');
  }
  return { mapName, poleEast: input.poleEast, poleNorth: input.poleNorth };
}

function nextTerritoryStatus(currentStatus, decision) {
  const allowed = currentStatus === 'pending'
    ? new Set(['approved', 'rejected'])
    : currentStatus === 'approved' ? new Set(['revoked']) : new Set();
  if (!allowed.has(decision)) throw new TypeError('Invalid territory status transition');
  return decision;
}

function normalizeDecisionInput(input) {
  const expectedVersion = positiveInteger(input?.expectedVersion, 'expectedVersion');
  const decision = String(input?.decision || '').trim().toLowerCase();
  if (!TERRITORY_STATUSES.includes(decision) || decision === 'pending') {
    throw new TypeError('decision must be approved, rejected, or revoked');
  }
  const note = input?.note == null ? null : String(input.note).trim();
  if (note && note.length > DECISION_NOTE_MAX_LENGTH) {
    throw new TypeError(`note cannot exceed ${DECISION_NOTE_MAX_LENGTH} characters`);
  }
  return { expectedVersion, decision, note: note || null };
}

function serializeTerritory(row) {
  return {
    id: Number(row.id),
    factionId: Number(row.faction_id),
    factionName: row.faction_name || undefined,
    mapName: row.map_name,
    pole: { east: Number(row.pole_east), north: Number(row.pole_north) },
    radiusMeters: FLAG_POLE_RADIUS_METERS,
    radiusSource: FLAG_POLE_SOURCE,
    status: row.status,
    version: Number(row.version),
    submittedAt: row.submitted_at ? new Date(row.submitted_at).toISOString() : null,
    reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
    decisionNote: row.decision_note || null,
  };
}

async function listTerritories(db, serverId, options = {}) {
  const canonicalServerId = positiveInteger(serverId, 'serverId');
  const page = positiveInteger(options.page ?? 1, 'page');
  const pageSize = positiveInteger(options.pageSize ?? 50, 'pageSize');
  if (pageSize > 100 || page > 100) throw new TypeError('territory page bounds exceeded');
  const status = options.status == null || options.status === ''
    ? null : String(options.status).trim().toLowerCase();
  if (status && !TERRITORY_STATUSES.includes(status)) throw new TypeError('status is invalid');
  const params = [canonicalServerId];
  let statusClause = '';
  if (status) {
    statusClause = ' AND ft.status = ?';
    params.push(status);
  }
  params.push(pageSize, (page - 1) * pageSize);
  const rows = await db.query(
    `SELECT ft.*, f.name AS faction_name
       FROM faction_territories ft
       JOIN factions f ON f.id = ft.faction_id AND f.guild_id = ft.guild_id
      WHERE ft.server_id = ?${statusClause}
      ORDER BY CASE ft.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
               ft.submitted_at DESC, ft.id DESC
      LIMIT ? OFFSET ?`,
    params
  );
  return rows.map(serializeTerritory);
}

async function reviewTerritory(db, context, territoryId, actorUserId, input) {
  const canonicalTerritoryId = positiveInteger(territoryId, 'territoryId');
  const decision = normalizeDecisionInput(input);
  const row = await db.get(
    `SELECT * FROM faction_territories
      WHERE id = ? AND server_id = ? AND guild_id = ?
      FOR UPDATE`,
    [canonicalTerritoryId, context.server.id, context.guild.id]
  );
  if (!row) return null;
  nextTerritoryStatus(row.status, decision.decision);
  if (Number(row.version) !== decision.expectedVersion) {
    const error = new Error('Territory changed since it was loaded');
    error.code = 'STALE_TERRITORY';
    throw error;
  }
  const updated = await db.get(
    `UPDATE faction_territories
        SET status = ?, version = version + 1, reviewed_by_user_id = ?,
            reviewed_at = NOW(), decision_note = ?, updated_at = NOW()
      WHERE id = ? AND server_id = ? AND guild_id = ? AND version = ? AND status = ?
      RETURNING *`,
    [decision.decision, actorUserId, decision.note, canonicalTerritoryId,
      context.server.id, context.guild.id, decision.expectedVersion, row.status]
  );
  if (!updated) {
    const error = new Error('Territory changed since it was loaded');
    error.code = 'STALE_TERRITORY';
    throw error;
  }
  await db.run(
    `INSERT INTO security_audit_events
       (guild_id, server_id, actor_user_id, action, result, target_type, target_id, metadata)
     VALUES (?, ?, ?, ?, 'allowed', 'faction_territory', ?, ?::jsonb)`,
    [context.guild.id, context.server.id, actorUserId,
      `faction_territory.${decision.decision}`, String(updated.id),
      JSON.stringify({ fromStatus: row.status, toStatus: decision.decision, version: updated.version })]
  );
  return serializeTerritory({ ...updated, faction_name: row.faction_name });
}

module.exports = {
  FLAG_POLE_RADIUS_METERS,
  FLAG_POLE_SOURCE,
  SUPPORTED_TERRITORY_MAPS,
  TERRITORY_STATUSES,
  validateTerritorySubmission,
  nextTerritoryStatus,
  normalizeDecisionInput,
  serializeTerritory,
  listTerritories,
  reviewTerritory,
};
