'use strict';

const { admTupleToWorld, worldVectorToWorld } = require('../utils/dayzCoordinates');
const { FLAG_POLE_RADIUS_METERS, FLAG_POLE_SOURCE } = require('./factionTerritoryService');

const DEFAULT_WINDOW_MINUTES = 60;
const MIN_WINDOW_MINUTES = 15;
const MAX_WINDOW_MINUTES = 1440;
const PRESENCE_MAX_AGE_MS = 120 * 60 * 1000;
const PRESENCE_FUTURE_SKEW_MS = 5 * 60 * 1000;
const POSITION_MAX_AGE_MS = 15 * 60 * 1000;
const STREAM_LIMIT = 250;
const SUPPORTED_MAPS = new Set(['chernarusplus', 'enoch', 'sakhal']);

function parseWindowMinutes(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_WINDOW_MINUTES;
  return Math.min(MAX_WINDOW_MINUTES, Math.max(MIN_WINDOW_MINUTES, parsed));
}

function isSupportedMapName(value) {
  return SUPPORTED_MAPS.has(String(value || '').trim().toLowerCase());
}

function iso(value) {
  if (!value) return null;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function admPosition(row) {
  try {
    return admTupleToWorld(row);
  } catch {
    return null;
  }
}

function worldVectorPosition(row) {
  try {
    return worldVectorToWorld({ x: row.pos_x, y: row.pos_y, z: row.pos_z });
  } catch {
    return null;
  }
}

function isFresh(value, nowMs, maxAgeMs, futureSkewMs = PRESENCE_FUTURE_SKEW_MS) {
  const observedMs = Date.parse(value || '');
  return Number.isFinite(observedMs) && observedMs >= nowMs - maxAgeMs && observedMs <= nowMs + futureSkewMs;
}

function recentEventRows(rows, type, projector) {
  return rows.map(row => ({
    id: `${type}:${row.id}`,
    type,
    timestamp: iso(row.timestamp),
    ...projector(row),
  })).filter(event => event.position);
}

function positiveInteger(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new TypeError(`${fieldName} must be a positive integer`);
  return parsed;
}

function noteVersion(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new TypeError('expectedVersion must be a non-negative integer');
  return parsed;
}

function normalizePlayerStaffNote(value) {
  if (typeof value !== 'string') throw new TypeError('note must be a string');
  const note = value.trim();
  if (note.includes('\0')) throw new TypeError('note contains an unsupported character');
  if (note.length > 1000) throw new TypeError('note must be 1000 characters or fewer');
  return note;
}

function serializePlayerStaffNote(row) {
  return {
    text: row?.note || '',
    version: Number(row?.version || 0),
    updatedAt: iso(row?.updated_at),
    updatedBy: row?.updated_by || null,
  };
}

async function savePlayerStaffNote(db, {
  serverId, identityId, actorUserId, note, expectedVersion,
}) {
  const canonicalServerId = positiveInteger(serverId, 'serverId');
  const canonicalIdentityId = positiveInteger(identityId, 'identityId');
  const canonicalActorUserId = positiveInteger(actorUserId, 'actorUserId');
  const canonicalVersion = noteVersion(expectedVersion);
  const canonicalNote = normalizePlayerStaffNote(note);

  const activity = await db.get(
    `SELECT identity_id FROM player_server_activity
      WHERE server_id = ? AND identity_id = ?
      FOR UPDATE`,
    [canonicalServerId, canonicalIdentityId]
  );
  if (!activity) return null;

  const existing = await db.get(
    `SELECT version FROM player_staff_notes
      WHERE server_id = ? AND identity_id = ?
      FOR UPDATE`,
    [canonicalServerId, canonicalIdentityId]
  );
  if (Number(existing?.version || 0) !== canonicalVersion) {
    const error = new Error('Player note changed; refresh and try again');
    error.code = 'STALE_PLAYER_NOTE';
    throw error;
  }

  const returning = `RETURNING note, version, updated_at,
    (SELECT username FROM users WHERE id = ?) AS updated_by`;
  const row = existing
    ? await db.get(
      `UPDATE player_staff_notes
          SET note = ?, version = version + 1, updated_by_user_id = ?, updated_at = NOW()
        WHERE server_id = ? AND identity_id = ? AND version = ?
        ${returning}`,
      [canonicalNote, canonicalActorUserId, canonicalServerId, canonicalIdentityId,
        canonicalVersion, canonicalActorUserId]
    )
    : await db.get(
      `INSERT INTO player_staff_notes
         (server_id, identity_id, note, version, updated_by_user_id)
       VALUES (?, ?, ?, 1, ?)
       ${returning}`,
      [canonicalServerId, canonicalIdentityId, canonicalNote, canonicalActorUserId, canonicalActorUserId]
    );
  if (!row) {
    const error = new Error('Player note changed; refresh and try again');
    error.code = 'STALE_PLAYER_NOTE';
    throw error;
  }
  return serializePlayerStaffNote(row);
}

async function buildOperationsMapSnapshot({
  db, serverId, mapName, windowMinutes, activeSessionStartedAt, now = new Date(),
}) {
  const canonicalServerId = Number(serverId);
  if (!Number.isSafeInteger(canonicalServerId) || canonicalServerId <= 0) {
    throw new TypeError('serverId must be a positive integer');
  }
  const canonicalMapName = String(mapName || '').trim().toLowerCase();
  if (!SUPPORTED_MAPS.has(canonicalMapName)) throw new TypeError('mapName is unsupported');
  const nowMs = now.getTime();
  const sessionStartedMs = Date.parse(activeSessionStartedAt || '');
  if (!Number.isFinite(sessionStartedMs) || sessionStartedMs > nowMs + PRESENCE_FUTURE_SKEW_MS) {
    throw new TypeError('activeSessionStartedAt is invalid');
  }

  const boundedWindow = parseWindowMinutes(windowMinutes);
  const requestedSinceMs = nowMs - boundedWindow * 60 * 1000;
  const since = new Date(Math.max(requestedSinceMs, sessionStartedMs)).toISOString();
  const presenceSnapshot = await db.get(
    `SELECT source_observed_at, published_at
       FROM server_online_cache_snapshots
      WHERE server_id = ?
      ORDER BY source_observed_at DESC, published_at DESC
      LIMIT 1`,
    [canonicalServerId]
  );
  const presenceObservedMs = Date.parse(presenceSnapshot?.source_observed_at || '');
  const presenceFresh = isFresh(presenceSnapshot?.source_observed_at, nowMs, PRESENCE_MAX_AGE_MS) &&
    presenceObservedMs >= sessionStartedMs;

  const playersPromise = presenceFresh ? db.query(
    `SELECT cache.identity_id, cache.gamertag, cache.login_at,
            cache.updated_at AS roster_observed_at,
            position.timestamp AS position_observed_at,
            position.pos_x, position.pos_y, position.pos_z,
            COALESCE(stats.kills, 0) AS kills,
            COALESCE(stats.deaths, 0) AS deaths,
            COALESCE(stats.total_playtime_seconds, 0) AS total_playtime_seconds,
            COALESCE(activity.total_sessions, 0) AS total_sessions,
            staff_note.note AS staff_note,
            staff_note.version AS note_version,
            staff_note.updated_at AS note_updated_at,
            note_author.username AS note_updated_by
       FROM server_online_cache cache
       LEFT JOIN player_stats stats
         ON stats.server_id = cache.server_id AND stats.identity_id = cache.identity_id
       LEFT JOIN player_server_activity activity
         ON activity.server_id = cache.server_id AND activity.identity_id = cache.identity_id
       LEFT JOIN player_staff_notes staff_note
         ON staff_note.server_id = cache.server_id AND staff_note.identity_id = cache.identity_id
       LEFT JOIN users note_author ON note_author.id = staff_note.updated_by_user_id
       LEFT JOIN LATERAL (
         SELECT snapshot.timestamp, snapshot.pos_x, snapshot.pos_y, snapshot.pos_z
           FROM player_position_snapshots snapshot
          WHERE snapshot.server_id = cache.server_id
            AND snapshot.identity_id = cache.identity_id
            AND snapshot.timestamp >= ?
          ORDER BY snapshot.timestamp DESC, snapshot.id DESC
          LIMIT 1
       ) position ON TRUE
      WHERE cache.server_id = ?
      ORDER BY cache.gamertag ASC
      LIMIT 100`,
    [new Date(sessionStartedMs).toISOString(), canonicalServerId]
  ) : Promise.resolve([]);

  const [players, kills, deaths, damage, territory, purchases, factionMarkers, factionTerritories, zones] = await Promise.all([
    playersPromise,
    db.query(
      `SELECT id, killer_gamertag, victim_gamertag, weapon, distance, timestamp,
              CASE WHEN SPLIT_PART(victim_position, ',', 1) ~ '^[+-]?[0-9]+([.][0-9]+)?$'
                   THEN CAST(SPLIT_PART(victim_position, ',', 1) AS DOUBLE PRECISION) END AS east,
              CASE WHEN SPLIT_PART(victim_position, ',', 2) ~ '^[+-]?[0-9]+([.][0-9]+)?$'
                   THEN CAST(SPLIT_PART(victim_position, ',', 2) AS DOUBLE PRECISION) END AS north
         FROM kill_events
        WHERE server_id = ? AND timestamp >= ? AND victim_position IS NOT NULL
        ORDER BY timestamp DESC, id DESC LIMIT ${STREAM_LIMIT}`,
      [canonicalServerId, since]
    ),
    db.query(
      `SELECT id, player_gamertag, death_type, killed_by, pos_x, pos_y, pos_z, timestamp
         FROM player_death_events
        WHERE server_id = ? AND timestamp >= ? AND pos_x IS NOT NULL AND pos_y IS NOT NULL
        ORDER BY timestamp DESC, id DESC LIMIT ${STREAM_LIMIT}`,
      [canonicalServerId, since]
    ),
    db.query(
      `SELECT id, victim_gamertag, attacker_gamertag, attacker_type, weapon, body_part,
              damage, victim_pos_x AS pos_x, victim_pos_y AS pos_y, victim_pos_z AS pos_z, timestamp
         FROM damage_events
        WHERE server_id = ? AND timestamp >= ? AND victim_pos_x IS NOT NULL AND victim_pos_y IS NOT NULL
        ORDER BY timestamp DESC, id DESC LIMIT ${STREAM_LIMIT}`,
      [canonicalServerId, since]
    ),
    db.query(
      `SELECT id, player_gamertag AS gamertag, event_type, structure_type, structure_part,
              tool_used, pos_x, pos_y, pos_z, timestamp
         FROM territory_events
        WHERE server_id = ? AND timestamp >= ? AND pos_x IS NOT NULL AND pos_y IS NOT NULL
        ORDER BY timestamp DESC, id DESC LIMIT ${STREAM_LIMIT}`,
      [canonicalServerId, since]
    ),
    db.query(
      `SELECT soi.id, so.identity_id, COALESCE(pg.gamertag, 'Unknown player') AS gamertag,
              COALESCE(soi.item_name_snapshot, si.name, soi.item_class_snapshot, si.item_class, 'Purchased item') AS item_name,
              COALESCE(soi.item_class_snapshot, si.item_class) AS item_class,
              soi.quantity, soi.spawn_method, soi.is_active, soi.pos_x, soi.pos_y, soi.pos_z,
              so.checked_out_at
         FROM shop_order_items soi
         JOIN shop_orders so ON so.id = soi.order_id
         LEFT JOIN shop_items si ON si.id = soi.shop_item_id
         LEFT JOIN player_gamertags pg ON pg.identity_id = so.identity_id
              AND pg.server_id = so.server_id AND pg.is_current_gamertag = 1
        WHERE so.server_id = ? AND so.status = 'completed' AND so.checked_out_at >= ?
          AND soi.spawn_method IN ('cfgEffectArea', 'custom_json', 'event')
        ORDER BY so.checked_out_at DESC NULLS LAST, soi.id DESC LIMIT ${STREAM_LIMIT}`,
      [canonicalServerId, since]
    ),
    db.query(
      `SELECT fm.id, fm.faction_id, f.name AS faction_name, fm.title, fm.note, fm.icon,
              fm.pos_x, fm.pos_y, fm.updated_at
         FROM faction_markers fm
         JOIN factions f ON f.id = fm.faction_id
         JOIN servers marker_server ON marker_server.id = fm.server_id AND marker_server.guild_id = f.guild_id
        WHERE fm.server_id = ? AND LOWER(fm.map_name) = ?
        ORDER BY fm.updated_at DESC, fm.id DESC LIMIT ${STREAM_LIMIT}`,
      [canonicalServerId, canonicalMapName]
    ),
    db.query(
      `SELECT ft.id, ft.faction_id, f.name AS faction_name, ft.map_name,
              ft.pole_east, ft.pole_north, ft.radius_m, ft.status, ft.version,
              ft.submitted_at, ft.reviewed_at, ft.decision_note
         FROM faction_territories ft
         JOIN factions f ON f.id = ft.faction_id AND f.guild_id = ft.guild_id
        WHERE ft.server_id = ? AND ft.map_name = ?
        ORDER BY CASE ft.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
                 ft.submitted_at DESC, ft.id DESC
        LIMIT 200`,
      [canonicalServerId, canonicalMapName]
    ),
    db.query(
      `SELECT id, source_type AS zone_type, label, center_x, center_z,
              radius_m AS radius_meters, status, evidence_count,
              first_evidence_at, last_evidence_at AS evidence_observed_at, reviewed_at
         FROM spawn_exclusion_zones
        WHERE server_id = ? AND first_evidence_at >= ? AND last_evidence_at >= ?
        ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'confirmed' THEN 1 ELSE 2 END,
                 last_evidence_at DESC NULLS LAST, id DESC
        LIMIT 200`,
      [canonicalServerId, new Date(sessionStartedMs).toISOString(), new Date(sessionStartedMs).toISOString()]
    ),
  ]);

  const recentEvents = [
    ...recentEventRows(kills, 'kill', row => ({
      actor: row.killer_gamertag || 'Unknown', subject: row.victim_gamertag || 'Unknown',
      detail: row.weapon || 'Unknown weapon', distance: finite(row.distance),
      position: finite(row.east) === null || finite(row.north) === null
        ? null : { east: finite(row.east), north: finite(row.north), elevation: null },
    })),
    ...recentEventRows(deaths, 'death', row => ({
      actor: row.killed_by || null, subject: row.player_gamertag || 'Unknown', detail: row.death_type,
      position: admPosition(row),
    })),
    ...recentEventRows(damage, 'damage', row => ({
      actor: row.attacker_gamertag || row.attacker_type || 'Unknown', subject: row.victim_gamertag || 'Unknown',
      detail: [row.weapon, row.body_part, finite(row.damage) !== null ? `${finite(row.damage)} damage` : null].filter(Boolean).join(' · '),
      position: admPosition(row),
    })),
  ].sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp)).slice(0, STREAM_LIMIT);

  const onlinePlayers = players.map(row => {
    const kills = Math.max(0, Number(row.kills) || 0);
    const deaths = Math.max(0, Number(row.deaths) || 0);
    const loginMs = Date.parse(row.login_at || '');
    const positionObservedMs = Date.parse(row.position_observed_at || '');
    const position = Number.isFinite(positionObservedMs) && positionObservedMs >= sessionStartedMs
      ? admPosition(row)
      : null;
    return {
      identityId: Number(row.identity_id),
      gamertag: row.gamertag || 'Unknown player',
      loginAt: iso(row.login_at),
      rosterObservedAt: iso(row.roster_observed_at) || iso(presenceSnapshot?.source_observed_at),
      positionObservedAt: iso(row.position_observed_at),
      positionFresh: Boolean(position) && isFresh(row.position_observed_at, nowMs, POSITION_MAX_AGE_MS) &&
        positionObservedMs >= sessionStartedMs,
      position,
      stats: {
        kills,
        deaths,
        killDeathRatio: deaths > 0 ? Number((kills / deaths).toFixed(2)) : null,
        totalPlaytimeSeconds: Math.max(0, Number(row.total_playtime_seconds) || 0),
        totalSessions: Math.max(0, Number(row.total_sessions) || 0),
        currentSessionSeconds: Number.isFinite(loginMs)
          ? Math.max(0, Math.floor((nowMs - loginMs) / 1000))
          : 0,
      },
      staffNote: serializePlayerStaffNote({
        note: row.staff_note,
        version: row.note_version,
        updated_at: row.note_updated_at,
        updated_by: row.note_updated_by,
      }),
    };
  });

  return {
    success: true,
    generatedAt: now.toISOString(),
    serverId: canonicalServerId,
    mapName: canonicalMapName,
    windowMinutes: boundedWindow,
    telemetry: {
      mode: 'log-derived',
      activeSessionStartedAt: new Date(sessionStartedMs).toISOString(),
      presenceObservedAt: iso(presenceSnapshot?.source_observed_at),
      presencePublishedAt: iso(presenceSnapshot?.published_at),
      presenceFresh,
      rosterCount: onlinePlayers.length,
      positionedCount: onlinePlayers.filter(player => player.position).length,
      eventMapScope: 'verified_active_session',
      limitation: 'Positions and events update when retained ADM/RPT logs are synchronized; this is not real-time GPS. Spatial rows are restricted to the verified active server session because historical rows do not record terrain identity.',
    },
    onlinePlayers,
    recentEvents,
    territoryObservations: territory.map(row => ({
      id: row.id,
      gamertag: row.gamertag || 'Unknown',
      eventType: row.event_type,
      structureType: row.structure_type,
      structurePart: row.structure_part,
      toolUsed: row.tool_used,
      timestamp: iso(row.timestamp),
      position: admPosition(row),
      presence: 'observation_only',
    })).filter(item => item.position),
    purchases: purchases
      .filter(row => ['cfgEffectArea', 'custom_json', 'event'].includes(row.spawn_method))
      .map(row => ({
      id: row.id,
      identityId: row.identity_id,
      gamertag: row.gamertag,
      itemName: row.item_name,
      itemClass: row.item_class,
      quantity: Number(row.quantity || 1),
      spawnMethod: row.spawn_method,
      lifecycleState: row.is_active ? 'recorded_active' : 'recorded_inactive',
      completedAt: iso(row.checked_out_at),
      position: worldVectorPosition(row),
      presence: 'unknown',
    })).filter(item => item.position),
    factionMarkers: factionMarkers.map(row => ({
      id: row.id,
      factionId: row.faction_id,
      factionName: row.faction_name,
      title: row.title,
      note: row.note,
      icon: row.icon,
      updatedAt: iso(row.updated_at),
      position: { east: finite(row.pos_x), north: finite(row.pos_y), elevation: null },
      kind: 'marker_not_territory',
    })).filter(marker => marker.position.east !== null && marker.position.north !== null),
    factionTerritories: factionTerritories.map(row => ({
      id: Number(row.id),
      factionId: Number(row.faction_id),
      factionName: row.faction_name,
      mapName: row.map_name,
      pole: { east: finite(row.pole_east), north: finite(row.pole_north) },
      radiusMeters: FLAG_POLE_RADIUS_METERS,
      radiusSource: FLAG_POLE_SOURCE,
      status: row.status,
      version: Number(row.version),
      submittedAt: iso(row.submitted_at),
      reviewedAt: iso(row.reviewed_at),
      decisionNote: row.decision_note || null,
    })).filter(item => item.pole.east !== null && item.pole.north !== null && item.radiusMeters === 60),
    zones: zones
      .filter(row => Date.parse(row.first_evidence_at || '') >= sessionStartedMs &&
        Date.parse(row.evidence_observed_at || '') >= sessionStartedMs)
      .map(row => ({
      id: row.id,
      type: row.zone_type,
      label: row.label,
      status: row.status,
      radiusMeters: finite(row.radius_meters),
      evidenceCount: Number(row.evidence_count || 0),
      evidenceObservedAt: iso(row.evidence_observed_at),
      reviewedAt: iso(row.reviewed_at),
      position: { east: finite(row.center_x), north: finite(row.center_z), elevation: null },
    })).filter(zone => zone.position.east !== null && zone.position.north !== null && zone.radiusMeters !== null),
  };
}

module.exports = {
  buildOperationsMapSnapshot,
  parseWindowMinutes,
  isSupportedMapName,
  savePlayerStaffNote,
};
