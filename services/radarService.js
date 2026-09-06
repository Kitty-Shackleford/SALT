'use strict';

const crypto = require('crypto');
const { normalizeRadarCapabilityConfig } = require('../utils/radarPolicy');

const DEFAULT_MAX_LOCATION_AGE_SECONDS = 900;
const SYNTHETIC_BUCKET_MS = 5 * 60 * 1000;

function parseConfig(value) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return normalizeRadarCapabilityConfig(parsed);
}

function deterministicUnit(seed) {
  const digest = crypto.createHash('sha256').update(seed).digest();
  return digest.readUInt32BE(0) / 0xffffffff;
}

function bucketIso(now = new Date()) {
  const time = now instanceof Date ? now.getTime() : new Date(now).getTime();
  return new Date(Math.floor(time / SYNTHETIC_BUCKET_MS) * SYNTHETIC_BUCKET_MS).toISOString();
}

function clampCoordinate(value) {
  return Math.max(0, Math.min(25000, value));
}

function generateSyntheticEvents({ activationId, displayName, config, center, bucket }) {
  const normalized = parseConfig(config);
  if (normalized.capability !== 'jammer' || normalized.jammerEffect === 'suppress') return [];
  if (!center || !Number.isFinite(Number(center.east)) || !Number.isFinite(Number(center.north))) return [];
  const radius = normalized.jammerScope === 'full_map'
    ? 12500
    : Math.max(1, Number(normalized.radiusMeters));

  return normalized.deceptionActions.map(action => {
    const angle = deterministicUnit(`${activationId}:${bucket}:${action}:angle`) * Math.PI * 2;
    const distance = Math.sqrt(deterministicUnit(`${activationId}:${bucket}:${action}:distance`)) * radius;
    return {
      action,
      displayName,
      position: {
        east: clampCoordinate(Number(center.east) + Math.cos(angle) * distance),
        north: clampCoordinate(Number(center.north) + Math.sin(angle) * distance),
      },
      timestamp: bucket,
    };
  });
}

function distanceBetween(a, b) {
  return Math.hypot(Number(a.east) - Number(b.east), Number(a.north) - Number(b.north));
}

function audienceIncludesViewer(jammer, viewerFactionId, ownerFactionId, viewerIdentityId) {
  if (jammer.config.jammerTargets === 'everyone') return true;
  if (jammer.config.jammerTargets === 'everyone_except_owner') {
    return Number(jammer.identity_id) !== Number(viewerIdentityId);
  }
  const allied = viewerFactionId != null && ownerFactionId != null
    && Number(viewerFactionId) === Number(ownerFactionId);
  return jammer.config.jammerTargets === 'allies' ? allied : !allied;
}

function jammerCenter(jammer) {
  if (jammer.config.jammerScope === 'full_map') return { east: 12500, north: 12500 };
  if (jammer.config.jammerScope === 'area') {
    if (jammer.center_x == null || jammer.center_y == null) return null;
    return { east: Number(jammer.center_x), north: Number(jammer.center_y) };
  }
  if (jammer.owner_pos_x == null || jammer.owner_pos_y == null) return null;
  return { east: Number(jammer.owner_pos_x), north: Number(jammer.owner_pos_y) };
}

function jammerCoversPosition(jammer, position) {
  if (jammer.config.jammerScope === 'full_map') return true;
  const center = jammerCenter(jammer);
  return Boolean(center) && distanceBetween(center, position) <= Number(jammer.config.radiusMeters);
}

function revealTarget(target, mode, viewerIdentityId, bucket) {
  if (mode === 'presence') {
    return {
      identityId: Number(target.identity_id),
      displayName: target.player_name,
      presence: true,
      observedAt: target.timestamp,
    };
  }
  let east = Number(target.pos_x);
  let north = Number(target.pos_y);
  if (mode === 'approximate') {
    const angle = deterministicUnit(`${viewerIdentityId}:${target.identity_id}:${bucket}:approx`) * Math.PI * 2;
    const distance = deterministicUnit(`${target.identity_id}:${bucket}:distance`) * 250;
    east = clampCoordinate(east + Math.cos(angle) * distance);
    north = clampCoordinate(north + Math.sin(angle) * distance);
  }
  return {
    identityId: Number(target.identity_id),
    displayName: target.player_name,
    presence: true,
    position: { east, north },
    observedAt: target.timestamp,
    approximate: mode === 'approximate',
  };
}

async function loadLiveAuthority(db, { userId, identityId, serverId }) {
  return db.get(
    `SELECT spm.id AS membership_id, spm.guild_id, spm.source_link_id
     FROM server_player_memberships spm
     JOIN linked_accounts la
       ON la.id = spm.source_link_id
      AND la.user_id = spm.user_id
      AND la.identity_id = spm.identity_id
      AND la.verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')
     JOIN servers s ON s.id = spm.server_id AND s.guild_id = spm.guild_id AND s.status = 'active'
     JOIN guilds g ON g.id = spm.guild_id AND g.status = 'approved'
     WHERE spm.user_id = ? AND spm.identity_id = ? AND spm.server_id = ?
       AND spm.status = 'active'
     LIMIT 1`,
    [userId, identityId, serverId]
  );
}

async function activateRadarCapabilities(db, order, items, actorUserId) {
  const capabilityItems = items.filter(item => item.capability_config);
  if (capabilityItems.length === 0) return;
  const authority = await loadLiveAuthority(db, {
    userId: actorUserId,
    identityId: order.identity_id,
    serverId: order.server_id,
  });
  if (!authority) throw new Error('Radar capability activation requires active exact-server authority');

  for (const item of capabilityItems) {
    const config = parseConfig(item.capability_config);
    if (config.jammerScope === 'area' && (item.pos_x == null || item.pos_y == null)) {
      throw new Error('Area jammer activation requires map coordinates');
    }
    await db.run(
      `INSERT INTO radar_activations
        (guild_id, server_id, user_id, identity_id, source_link_id, membership_id,
         order_id, order_item_id, capability_config, center_x, center_y)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (order_item_id) DO NOTHING`,
      [
        authority.guild_id,
        order.server_id,
        actorUserId,
        order.identity_id,
        authority.source_link_id,
        authority.membership_id,
        order.id,
        item.id,
        JSON.stringify(config),
        config.jammerScope === 'area' ? item.pos_x : null,
        config.jammerScope === 'area' ? item.pos_y : null,
      ]
    );
  }
}

async function persistSyntheticEvents(db, jammer, events, bucket) {
  if (jammer.config.deceptionPersistence === 'transient') return;
  for (const event of events) {
    await db.run(
      `INSERT INTO radar_synthetic_events
        (activation_id, guild_id, server_id, purchaser_identity_id, action,
         display_name, pos_x, pos_y, bucket_start)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (activation_id, action, bucket_start, seed_version) DO NOTHING`,
      [
        jammer.id, jammer.guild_id, jammer.server_id, jammer.identity_id,
        event.action, event.displayName, event.position.east, event.position.north, bucket,
      ]
    );
  }
}

async function getPlayerRadarResponse(db, context) {
  const { userId, identityId, serverId } = context;
  const authority = await loadLiveAuthority(db, context);
  if (!authority) return null;
  const now = context.now ? new Date(context.now) : new Date();
  const bucket = bucketIso(now);
  const cutoff = new Date(now.getTime() - DEFAULT_MAX_LOCATION_AGE_SECONDS * 1000).toISOString();

  const entitlements = await db.query(
    `SELECT ra.*,
            CASE WHEN soi.snapshot_schema_version = 1
              THEN soi.capability_config_snapshot ELSE si.capability_config END AS effective_config
     FROM radar_activations ra
     JOIN shop_order_items soi ON soi.id = ra.order_item_id AND soi.is_active = TRUE
     JOIN shop_orders so ON so.id = ra.order_id AND so.status = 'completed'
     JOIN shop_items si ON si.id = soi.shop_item_id
     WHERE ra.user_id = ? AND ra.identity_id = ? AND ra.server_id = ?
       AND ra.status = 'active'
       AND (soi.restarts_remaining IS NULL OR soi.restarts_remaining > 0)
     ORDER BY ra.id DESC`,
    [userId, identityId, serverId]
  );
  const radarEntitlements = entitlements.map(row => {
    try { return { ...row, config: parseConfig(row.effective_config || row.capability_config) }; }
    catch (_) { return null; }
  }).filter(row => row?.config.capability === 'radar');
  if (radarEntitlements.length === 0) return { enabled: false, targets: [], activity: [] };

  const priority = { presence: 0, approximate: 1, exact: 2 };
  radarEntitlements.sort((a, b) => priority[b.config.radarRevealMode] - priority[a.config.radarRevealMode]);
  const radar = radarEntitlements[0];
  let viewerPosition = null;
  let viewerPoint = null;
  if (radar.config.radiusMeters) {
    viewerPosition = await db.get(
      `SELECT pos_x, pos_y, timestamp
       FROM player_position_snapshots
       WHERE server_id = ? AND identity_id = ? AND timestamp >= ?
         AND pos_x IS NOT NULL AND pos_y IS NOT NULL
       ORDER BY timestamp DESC, id DESC LIMIT 1`,
      [serverId, identityId, cutoff]
    );
    if (!viewerPosition) return { enabled: true, stale: true, targets: [], activity: [] };
    viewerPoint = { east: Number(viewerPosition.pos_x), north: Number(viewerPosition.pos_y) };
  }

  const targets = await db.query(
    `SELECT ps.identity_id, ps.pos_x, ps.pos_y, ps.timestamp,
            COALESCE(pg.gamertag, pi.platform_username) AS player_name
     FROM (
       SELECT DISTINCT ON (identity_id) identity_id, pos_x, pos_y, timestamp
       FROM player_position_snapshots
       WHERE server_id = ? AND timestamp >= ? AND identity_id IS NOT NULL
         AND pos_x IS NOT NULL AND pos_y IS NOT NULL
       ORDER BY identity_id, timestamp DESC, id DESC
     ) ps
     JOIN player_identities pi ON pi.id = ps.identity_id
     LEFT JOIN LATERAL (
       SELECT gamertag FROM player_gamertags
       WHERE server_id = ? AND identity_id = ps.identity_id
         AND is_current_gamertag = 1
       ORDER BY last_seen DESC NULLS LAST LIMIT 1
     ) pg ON TRUE
     WHERE ps.identity_id <> ?`,
    [serverId, cutoff, serverId, identityId]
  );

  const jammers = (await db.query(
    `SELECT ra.*,
            COALESCE(pg.gamertag, pi.platform_username) AS owner_name,
            ps.pos_x AS owner_pos_x, ps.pos_y AS owner_pos_y,
            CASE WHEN soi.snapshot_schema_version = 1
              THEN soi.capability_config_snapshot ELSE si.capability_config END AS effective_config
     FROM radar_activations ra
     JOIN shop_order_items soi ON soi.id = ra.order_item_id AND soi.is_active = TRUE
     JOIN shop_orders so ON so.id = ra.order_id AND so.status = 'completed'
     JOIN shop_items si ON si.id = soi.shop_item_id
     JOIN server_player_memberships jammer_membership
       ON jammer_membership.id = ra.membership_id
      AND jammer_membership.server_id = ra.server_id
      AND jammer_membership.guild_id = ra.guild_id
      AND jammer_membership.user_id = ra.user_id
      AND jammer_membership.identity_id = ra.identity_id
      AND jammer_membership.source_link_id = ra.source_link_id
      AND jammer_membership.status = 'active'
     JOIN linked_accounts jammer_link
       ON jammer_link.id = ra.source_link_id
      AND jammer_link.user_id = ra.user_id
      AND jammer_link.identity_id = ra.identity_id
      AND jammer_link.verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')
     JOIN player_identities pi ON pi.id = ra.identity_id
     LEFT JOIN LATERAL (
       SELECT gamertag FROM player_gamertags
       WHERE server_id = ra.server_id AND identity_id = ra.identity_id
         AND is_current_gamertag = 1
       ORDER BY last_seen DESC NULLS LAST LIMIT 1
     ) pg ON TRUE
     LEFT JOIN LATERAL (
       SELECT pos_x, pos_y FROM player_position_snapshots
       WHERE server_id = ra.server_id AND identity_id = ra.identity_id
         AND timestamp >= ? AND pos_x IS NOT NULL AND pos_y IS NOT NULL
       ORDER BY timestamp DESC, id DESC LIMIT 1
     ) ps ON TRUE
     WHERE ra.server_id = ? AND ra.status = 'active'
       AND (soi.restarts_remaining IS NULL OR soi.restarts_remaining > 0)`,
    [cutoff, serverId]
  )).map(row => {
    try { return { ...row, config: parseConfig(row.effective_config || row.capability_config) }; }
    catch (_) { return null; }
  }).filter(row => row?.config.capability === 'jammer');

  const factionIdentityIds = [...new Set([
    Number(identityId),
    ...targets.map(target => Number(target.identity_id)),
    ...jammers.map(jammer => Number(jammer.identity_id)),
  ])];
  const factionRows = await db.query(
    `SELECT fm.identity_id, fm.faction_id
     FROM faction_members fm
     JOIN factions f ON f.id = fm.faction_id
     JOIN servers s ON s.id = ? AND f.guild_id = s.guild_id
     WHERE fm.identity_id IN (${factionIdentityIds.map(() => '?').join(', ')})
       AND f.guild_id = s.guild_id`,
    [serverId, ...factionIdentityIds]
  );
  const factions = new Map(factionRows.map(row => [Number(row.identity_id), row.faction_id]));
  const applicableJammers = jammers.filter(jammer => audienceIncludesViewer(
    jammer,
    factions.get(Number(identityId)),
    factions.get(Number(jammer.identity_id)),
    identityId
  ));

  const visibleTargets = targets.filter(target => {
    const point = { east: Number(target.pos_x), north: Number(target.pos_y) };
    if (radar.config.radiusMeters && distanceBetween(viewerPoint, point) > radar.config.radiusMeters) return false;
    return !applicableJammers.some(jammer =>
      jammer.config.jammerEffect !== 'deceive' && jammerCoversPosition(jammer, point));
  }).map(target => revealTarget(target, radar.config.radarRevealMode, identityId, bucket));

  const syntheticEvents = [];
  for (const jammer of applicableJammers) {
    if (jammer.config.jammerEffect === 'suppress') continue;
    const center = jammerCenter(jammer);
    const eventBucket = jammer.config.deceptionPersistence === 'activation'
      ? jammer.activated_at
      : bucket;
    const events = generateSyntheticEvents({
      activationId: jammer.id,
      displayName: jammer.owner_name,
      config: jammer.config,
      center,
      bucket: eventBucket,
    });
    await persistSyntheticEvents(db, jammer, events, eventBucket);
    syntheticEvents.push(...events);
  }

  return {
    enabled: true,
    stale: false,
    revealMode: radar.config.radarRevealMode,
    observedAt: viewerPosition?.timestamp || targets.reduce((latest, target) => {
      if (!latest || new Date(target.timestamp).getTime() > new Date(latest).getTime()) {
        return target.timestamp;
      }
      return latest;
    }, null),
    targets: visibleTargets,
    activity: syntheticEvents,
  };
}

async function getTrustedRadarAudit(db, serverId) {
  const activations = await db.query(
    `SELECT ra.id, ra.server_id, ra.guild_id, ra.identity_id, ra.order_item_id,
            ra.capability_config, ra.status, ra.source_type, ra.activated_at, ra.revoked_at,
            COALESCE(pg.gamertag, pi.platform_username) AS purchaser_name
     FROM radar_activations ra
     JOIN player_identities pi ON pi.id = ra.identity_id
     LEFT JOIN LATERAL (
       SELECT gamertag FROM player_gamertags
       WHERE server_id = ra.server_id AND identity_id = ra.identity_id
         AND is_current_gamertag = 1
       ORDER BY last_seen DESC NULLS LAST LIMIT 1
     ) pg ON TRUE
     WHERE ra.server_id = ? ORDER BY ra.id DESC LIMIT 500`,
    [serverId]
  );
  const syntheticEvents = await db.query(
    `SELECT id, activation_id, server_id, guild_id, purchaser_identity_id,
            source_type, action, display_name, pos_x, pos_y, bucket_start, seed_version
     FROM radar_synthetic_events
     WHERE server_id = ? ORDER BY bucket_start DESC, id DESC LIMIT 1000`,
    [serverId]
  );
  return { activations, syntheticEvents };
}

module.exports = {
  activateRadarCapabilities,
  generateSyntheticEvents,
  getPlayerRadarResponse,
  getTrustedRadarAudit,
};
