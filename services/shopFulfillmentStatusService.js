'use strict';

const { getEventHealth } = require('./eventHealthService');
const { getGuildDownloadPath } = require('./logSyncService');
const { listAvailableLogs } = require('./lootLiveService');
const { MISSION_SUBDIRS } = require('../utils/dayzPlatform');

const SHOP_EVIDENCE_WAIT_MS = 2 * 1000;

async function waitForShopEvidence(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Shop spawn evidence lookup timed out')), SHOP_EVIDENCE_WAIT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function eventNameForItem(item) {
  return item.event_name_snapshot || item.event_name || null;
}

function itemTypeForItem(item) {
  return item.item_type_snapshot || item.item_type || null;
}

function projectShopFulfillmentStatus(item, eventHealthByName = new Map(), evidence = {}) {
  const respawnsRemaining = itemTypeForItem(item) === 'event_rental'
    ? Math.max(0, Number(item.restarts_remaining) || 0)
    : null;

  if (!item.is_active) {
    return { state: 'inactive', label: 'Inactive', confirmed: false, confirmedAt: null, respawnsRemaining };
  }
  if (item.spawn_method === 'capability') {
    return { state: 'activated', label: 'Activated', confirmed: true, confirmedAt: null, respawnsRemaining };
  }
  if (item.spawn_method !== 'event') {
    return { state: 'provisioned', label: 'Provisioned', confirmed: false, confirmedAt: null, respawnsRemaining };
  }

  const health = eventHealthByName.get(eventNameForItem(item));
  const purchasedAt = Date.parse(item.checked_out_at || '');
  if (!Number.isFinite(purchasedAt)) {
    return {
      state: 'awaiting_spawn_evidence',
      label: 'Awaiting spawn confirmation',
      confirmed: false,
      confirmedAt: null,
      respawnsRemaining,
    };
  }
  if (!evidence.evidenceAvailable || !evidence.chronologyVerified) {
    return {
      state: 'evidence_unavailable',
      label: 'Spawn evidence unavailable',
      confirmed: false,
      confirmedAt: null,
      respawnsRemaining,
    };
  }
  const postPurchaseOutcomes = [
    Number(health?.successfulInstances) > 0 && {
      observation: health.lastSuccess,
      state: 'spawn_confirmed', label: 'Spawn confirmed', confirmed: true,
    },
    Number(health?.failures) > 0 && {
      observation: health.lastFailure,
      state: 'spawn_failed', label: 'Spawn failed', confirmed: false,
    },
    Number(health?.refusals) > 0 && {
      observation: health.lastRefusal,
      state: 'spawn_refused', label: 'Spawn refused', confirmed: false,
    },
    Number(health?.attempts) > 0 && {
      observation: health.lastAttempt,
      state: 'spawn_attempted', label: 'Spawn attempted', confirmed: false,
    },
  ].filter(Boolean).map(outcome => ({
    ...outcome,
    observedAtMs: Date.parse(outcome.observation?.observedAt || ''),
    sourceLine: Number.isFinite(Number(outcome.observation?.sourceLine))
      ? Number(outcome.observation.sourceLine)
      : -1,
  })).filter(outcome => Number.isFinite(outcome.observedAtMs) && outcome.observedAtMs >= purchasedAt)
    .sort((left, right) =>
      (right.observedAtMs - left.observedAtMs) || (right.sourceLine - left.sourceLine));

  if (postPurchaseOutcomes.length > 0) {
    const latest = postPurchaseOutcomes[0];
    return {
      state: latest.state,
      label: latest.label,
      confirmed: latest.confirmed,
      observedAt: latest.observation.observedAt,
      confirmedAt: latest.confirmed ? latest.observation.observedAt : null,
      respawnsRemaining,
    };
  }
  return {
    state: 'awaiting_spawn_evidence',
    label: 'Awaiting spawn confirmation',
    confirmed: false,
    confirmedAt: null,
    respawnsRemaining,
  };
}

async function loadEventHealthByName(db, serverId) {
  const server = await db.get(
    `SELECT s.platform_server_id, g.discord_guild_id
     FROM servers s
     JOIN guilds g ON g.id = s.guild_id
     WHERE s.id = ? AND s.status = 'active' AND g.status = 'approved'`,
    [serverId]
  );
  if (!server) return { eventHealthByName: new Map(), evidenceAvailable: false, chronologyVerified: false };

  const logs = listAvailableLogs(server.discord_guild_id, server.platform_server_id);
  const mapName = logs.find(log => log.map)?.map;
  if (!mapName) return { eventHealthByName: new Map(), evidenceAvailable: false, chronologyVerified: false };

  const restart = await db.get(
    `SELECT provider_started_at, evidence_source_file
     FROM server_restart_log
     WHERE server_id = ?
       AND provider_started_at IS NOT NULL
       AND evidence_source_file IS NOT NULL
     ORDER BY provider_started_at DESC
     LIMIT 1`,
    [serverId]
  );
  const serverPath = getGuildDownloadPath(server.discord_guild_id, server.platform_server_id);
  const health = await waitForShopEvidence(getEventHealth(serverPath, mapName, {
    missionSubdirs: MISSION_SUBDIRS,
    sessionStartedAt: restart?.provider_started_at || null,
    expectedSourceFile: restart?.evidence_source_file || null,
  }));
  return {
    eventHealthByName: new Map((health.events || []).map(event => [event.name, event])),
    evidenceAvailable: !health.error,
    chronologyVerified: health.chronologyVerified === true,
  };
}

async function attachShopFulfillmentStatuses(db, serverId, items) {
  if (!Array.isArray(items) || items.length === 0) return items || [];
  const needsEventEvidence = items.some(item => item.spawn_method === 'event');
  let evidence = {
    eventHealthByName: new Map(),
    evidenceAvailable: false,
    chronologyVerified: false,
  };
  if (needsEventEvidence) {
    try {
      evidence = await loadEventHealthByName(db, serverId);
    } catch (error) {
      console.warn(`Shop spawn evidence unavailable for server ${serverId}: ${error.message}`);
    }
  }
  return items.map(item => ({
    ...item,
    fulfillment: projectShopFulfillmentStatus(item, evidence.eventHealthByName, evidence),
  }));
}

module.exports = {
  projectShopFulfillmentStatus,
  attachShopFulfillmentStatuses,
};
