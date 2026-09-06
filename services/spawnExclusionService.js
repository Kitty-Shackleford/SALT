'use strict';

const DEFAULT_CLUSTER_RADIUS_METERS = 100;
const DEFAULT_EXCLUSION_RADIUS_METERS = 200;
const DEFAULT_LOOKBACK_DAYS = 90;
const DEFAULT_MAX_EVIDENCE_ROWS = 500;
const DEFAULT_ZONE_PAGE_SIZE = 100;
const MAX_ZONE_PAGE_SIZE = 200;
const MAX_ZONE_PAGE = 100;

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} must be a finite number`);
  return number;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer`);
  return number;
}

function distanceSquared(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

function clusterFlagEvidence(rows, options = {}) {
  const clusterRadius = finiteNumber(
    options.clusterRadius ?? DEFAULT_CLUSTER_RADIUS_METERS,
    'clusterRadius'
  );
  const defaultExclusionRadius = finiteNumber(
    options.defaultExclusionRadius ?? DEFAULT_EXCLUSION_RADIUS_METERS,
    'defaultExclusionRadius'
  );
  if (clusterRadius <= 0 || defaultExclusionRadius <= 0) {
    throw new Error('Spawn exclusion radii must be positive');
  }

  const evidence = rows.map(row => ({
    id: positiveInteger(row.id, 'territory event id'),
    x: finiteNumber(row.pos_x, 'flag pos_x'),
    // territory_events preserves ADM tuple order: east, north, elevation.
    z: finiteNumber(row.pos_y, 'flag ADM northing'),
    timestamp: new Date(row.timestamp),
  })).filter(row => !Number.isNaN(row.timestamp.getTime()))
    .sort((a, b) => a.id - b.id);

  let clusters = [];
  const radiusSquared = clusterRadius * clusterRadius;
  for (const event of evidence) {
    const connected = clusters.filter(candidate =>
      candidate.events.some(existing => distanceSquared(event, existing) <= radiusSquared)
    );
    if (!connected.length) {
      clusters.push({ events: [event] });
      continue;
    }
    const connectedSet = new Set(connected);
    clusters = clusters.filter(candidate => !connectedSet.has(candidate));
    clusters.push({
      events: [event, ...connected.flatMap(candidate => candidate.events)],
    });
  }

  return clusters.map(cluster => {
    const sourceEventIds = cluster.events.map(event => event.id).sort((a, b) => a - b);
    const centerX = cluster.events.reduce((sum, event) => sum + event.x, 0) / cluster.events.length;
    const centerZ = cluster.events.reduce((sum, event) => sum + event.z, 0) / cluster.events.length;
    const timestamps = cluster.events.map(event => event.timestamp.getTime());
    return {
      sourceKey: `territory-flag:${sourceEventIds[0]}`,
      sourceType: 'territory_flag',
      sourceEventIds,
      centerX,
      centerZ,
      radius: defaultExclusionRadius,
      evidenceCount: cluster.events.length,
      firstEvidenceAt: new Date(Math.min(...timestamps)).toISOString(),
      lastEvidenceAt: new Date(Math.max(...timestamps)).toISOString(),
    };
  });
}

async function refreshFlagCandidates(db, serverId, options = {}) {
  const canonicalServerId = positiveInteger(serverId, 'serverId');
  const lookbackDays = positiveInteger(options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS, 'lookbackDays');
  const maxEvidenceRows = positiveInteger(
    options.maxEvidenceRows ?? DEFAULT_MAX_EVIDENCE_ROWS,
    'maxEvidenceRows'
  );
  if (maxEvidenceRows > 2000) throw new Error('maxEvidenceRows cannot exceed 2000');
  const rows = await db.query(
    `SELECT id, pos_x, pos_y, pos_z, timestamp
     FROM territory_events
     WHERE server_id = $1
       AND event_type = 'raised'
       AND structure_type = 'TerritoryFlag'
       AND pos_x IS NOT NULL
       AND pos_y IS NOT NULL
       AND timestamp >= NOW() - ($2::int * INTERVAL '1 day')
     ORDER BY timestamp DESC, id DESC
     LIMIT $3`,
    [canonicalServerId, lookbackDays, maxEvidenceRows]
  );
  const candidates = clusterFlagEvidence(rows, options);
  const existingZones = await db.query(
    `SELECT source_key, center_x, center_z
     FROM spawn_exclusion_zones
     WHERE server_id = $1
       AND source_type = 'territory_flag'
     ORDER BY last_evidence_at DESC NULLS LAST, id DESC
     LIMIT 500`,
    [canonicalServerId]
  );
  const unmatchedExisting = new Set(existingZones);
  const reuseRadius = finiteNumber(
    options.clusterRadius ?? DEFAULT_CLUSTER_RADIUS_METERS,
    'clusterRadius'
  );
  for (const candidate of candidates) {
    const center = { x: candidate.centerX, z: candidate.centerZ };
    let nearest = null;
    let nearestDistance = Infinity;
    for (const existing of unmatchedExisting) {
      const squared = distanceSquared(center, {
        x: finiteNumber(existing.center_x, 'existing center_x'),
        z: finiteNumber(existing.center_z, 'existing center_z'),
      });
      if (squared <= reuseRadius * reuseRadius && squared < nearestDistance) {
        nearest = existing;
        nearestDistance = squared;
      }
    }
    if (nearest) {
      candidate.sourceKey = nearest.source_key;
      unmatchedExisting.delete(nearest);
    }
  }

  for (const candidate of candidates) {
    await db.query(
      `INSERT INTO spawn_exclusion_zones (
         server_id, source_key, source_type, label,
         center_x, center_z, radius_m, evidence_count,
         evidence_event_ids, first_evidence_at, last_evidence_at, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending')
       ON CONFLICT (server_id, source_key) DO UPDATE SET
         center_x = CASE
           WHEN spawn_exclusion_zones.status = 'pending' THEN EXCLUDED.center_x
           ELSE spawn_exclusion_zones.center_x
         END,
         center_z = CASE
           WHEN spawn_exclusion_zones.status = 'pending' THEN EXCLUDED.center_z
           ELSE spawn_exclusion_zones.center_z
         END,
         radius_m = CASE
           WHEN spawn_exclusion_zones.status = 'pending' THEN EXCLUDED.radius_m
           ELSE spawn_exclusion_zones.radius_m
         END,
         evidence_count = EXCLUDED.evidence_count,
         evidence_event_ids = EXCLUDED.evidence_event_ids,
         first_evidence_at = EXCLUDED.first_evidence_at,
         last_evidence_at = EXCLUDED.last_evidence_at,
         status = spawn_exclusion_zones.status,
         updated_at = NOW()`,
      [
        canonicalServerId,
        candidate.sourceKey,
        candidate.sourceType,
        'Flag-derived base candidate',
        candidate.centerX,
        candidate.centerZ,
        candidate.radius,
        candidate.evidenceCount,
        candidate.sourceEventIds,
        candidate.firstEvidenceAt,
        candidate.lastEvidenceAt,
      ]
    );
  }

  return candidates;
}

async function listExclusionZones(db, serverId, options = {}) {
  const canonicalServerId = positiveInteger(serverId, 'serverId');
  const page = positiveInteger(options.page ?? 1, 'page');
  const pageSize = positiveInteger(options.pageSize ?? DEFAULT_ZONE_PAGE_SIZE, 'pageSize');
  if (page > MAX_ZONE_PAGE) throw new Error(`page cannot exceed ${MAX_ZONE_PAGE}`);
  if (pageSize > MAX_ZONE_PAGE_SIZE) {
    throw new Error(`pageSize cannot exceed ${MAX_ZONE_PAGE_SIZE}`);
  }
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset)) throw new Error('page offset is too large');
  return db.query(
    `SELECT id, source_key, source_type, label, center_x, center_z, radius_m,
            status, evidence_count, evidence_event_ids, first_evidence_at,
            last_evidence_at, reviewed_by, reviewed_at, created_at, updated_at
     FROM spawn_exclusion_zones
     WHERE server_id = $1
     ORDER BY
       CASE status WHEN 'pending' THEN 0 WHEN 'confirmed' THEN 1 ELSE 2 END,
       last_evidence_at DESC NULLS LAST,
       id
     LIMIT $2 OFFSET $3`,
    [canonicalServerId, pageSize, offset]
  );
}

async function reviewExclusionZone(db, serverId, zoneId, reviewerUserId, review) {
  const canonicalServerId = positiveInteger(serverId, 'serverId');
  const canonicalZoneId = positiveInteger(zoneId, 'zoneId');
  const canonicalReviewerId = positiveInteger(reviewerUserId, 'reviewerUserId');
  if (!review || !['confirmed', 'dismissed'].includes(review.status)) {
    throw new Error('status must be confirmed or dismissed');
  }
  const radius = finiteNumber(review.radius, 'radius');
  if (radius < 50 || radius > 1000) throw new Error('radius must be between 50 and 1000 meters');
  const label = String(review.label || 'Flag-derived base candidate').trim();
  if (!label || label.length > 120) throw new Error('label must be between 1 and 120 characters');

  return db.get(
    `UPDATE spawn_exclusion_zones
     SET status = $3,
         radius_m = $4,
         label = $5,
         reviewed_by = $6,
         reviewed_at = NOW(),
         updated_at = NOW()
     WHERE id = $1 AND server_id = $2
     RETURNING *`,
    [canonicalZoneId, canonicalServerId, review.status, radius, label, canonicalReviewerId]
  );
}

async function findConfirmedExclusion(db, serverId, x, z) {
  const canonicalServerId = positiveInteger(serverId, 'serverId');
  const posX = finiteNumber(x, 'x');
  const posZ = finiteNumber(z, 'z');
  return db.get(
    `SELECT id, label, center_x, center_z, radius_m
     FROM spawn_exclusion_zones
     WHERE server_id = $1
       AND status = 'confirmed'
       AND POWER(center_x - $2, 2) + POWER(center_z - $3, 2) <= POWER(radius_m, 2)
     ORDER BY radius_m, id
     LIMIT 1`,
    [canonicalServerId, posX, posZ]
  );
}

async function assertEventPlacementsAllowed(db, serverId, placements) {
  for (const placement of placements) {
    if (placement.spawn_method !== 'event') continue;
    const match = await findConfirmedExclusion(
      db,
      serverId,
      placement.pos_x,
      placement.pos_z
    );
    if (match) {
      const error = new Error('Directed event location is inside a protected gameplay zone');
      error.code = 'SPAWN_EXCLUDED';
      throw error;
    }
  }
}

module.exports = {
  DEFAULT_CLUSTER_RADIUS_METERS,
  DEFAULT_EXCLUSION_RADIUS_METERS,
  DEFAULT_MAX_EVIDENCE_ROWS,
  clusterFlagEvidence,
  refreshFlagCandidates,
  listExclusionZones,
  reviewExclusionZone,
  findConfirmedExclusion,
  assertEventPlacementsAllowed,
};
