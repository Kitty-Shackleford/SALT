'use strict';

const missionFileService = require('./missionFileService');
const logSyncService = require('./logSyncService');
const { processDownloadedRestartEvidence } = require('./logRestartProcessingService');
const nitradoService = require('./nitradoService');
const { provisionPraTeleport, cleanupPraTeleport } = require('./teleportPraService');
const { resolveTeleportSource, teleportError } = require('./teleportService');
const {
  acquireProviderMutationLock,
  createFileMutationJournal,
  processRefund,
} = require('./shopFileService');
const {
  prepareProviderMutation,
  registerProviderMutationRollback,
  updatePreparedProviderMutation,
} = require('./providerMutationRecoveryService');
const { praFilePath } = require('../utils/teleportPolicy');
const {
  captureDatabaseClock,
  markServerLogParseSuccessful,
} = require('../utils/logSyncScheduling');

async function restartServerWithMissionLock(db, serverId, dependencies) {
  return db.transaction(async tx => {
    await acquireMissionMutationLock(tx, serverId);
    const context = await (dependencies.resolveServerControlContext || resolveServerControlContext)(
      tx, serverId
    );
    await (dependencies.assertTeleportProviderContext || assertTeleportProviderContext)(
      tx, serverId, context
    );
    return (dependencies.controlServer || nitradoService.controlServer)(
      context.token, context.platformServerId, 'restart'
    );
  });
}

async function acquireMissionMutationLock(db, serverId) {
  await acquireProviderMutationLock(db, serverId);
}

function assertDestinationMap(destinationMap, activeMap) {
  const expected = String(destinationMap || '').trim().toLowerCase();
  const actual = String(activeMap || '').trim().toLowerCase();
  if (!expected || !actual || actual === 'unknown' || expected !== actual) {
    throw teleportError(
      'TELEPORT_MAP_CHANGED',
      'Teleport destination does not match the server active mission map'
    );
  }
}

function collectTeleportMutationPaths(missionDir, requestId) {
  return [
    `${missionDir}/${praFilePath(requestId)}`,
    `${missionDir}/cfggameplay.json`,
    `${missionDir}/cfgGameplay.json`,
  ];
}

async function prepareTeleportProviderMutation(db, context, requestId, action, dependencies) {
  const filePaths = collectTeleportMutationPaths(context.missionDir, requestId);
  const fileService = dependencies.fileService || missionFileService;
  const snapshots = new Map();
  for (const filePath of filePaths) {
    snapshots.set(filePath, await fileService.downloadFileFromServer(
      context.platformServerId, filePath, context.token
    ));
  }
  const operationId = await prepareProviderMutation(db, {
    serverId: context.internalServerId,
    providerServiceId: context.platformServerId,
    workflow: 'teleport',
    action,
    contextType: 'teleport_request',
    contextId: requestId,
    plan: { filePaths, requestId },
    snapshots,
    triggeredBy: 'system:teleport_processor',
  });
  return { operationId, snapshots };
}

function buildTeleportFileJournal(context, dependencies, durableSnapshots) {
  const factory = dependencies.createFileMutationJournal || createFileMutationJournal;
  return factory(
    context.platformServerId,
    context.token,
    dependencies.fileService || missionFileService,
    durableSnapshots
  );
}

async function claimTeleportRequest(db, requestId, serverId) {
  const server = await db.get(
    "SELECT id, guild_id FROM servers WHERE id = ? AND status = 'active' FOR UPDATE",
    [serverId]
  );
  if (!server) return null;
  const request = await db.get(
    `SELECT tr.*, td.pos_x, td.pos_y, td.pos_z, td.map_name
     FROM teleport_requests tr
     JOIN teleport_destinations td
       ON td.id = tr.destination_id AND td.server_id = tr.server_id AND td.guild_id = tr.guild_id
     WHERE tr.id = ? AND tr.server_id = ?
       AND (
         tr.status = 'waiting_disconnect' OR (
           tr.status = 'provisioning' AND
           tr.updated_at < clock_timestamp() - INTERVAL '10 minutes'
         )
       )
       AND tr.expires_at > clock_timestamp()
       AND td.is_active = TRUE
     FOR UPDATE OF tr, td`,
    [requestId, serverId]
  );
  if (!request) return null;
  const restriction = await db.get(
    `SELECT id, destination_id FROM player_pra_restrictions
     WHERE server_id = ? AND identity_id = ? AND status = 'active'
     FOR UPDATE`,
    [serverId, request.identity_id]
  );
  if (request.respect_pra && restriction &&
      Number(restriction.destination_id) !== Number(request.destination_id)) {
    throw teleportError('PRA_CHANGED', 'PRA restriction changed before teleport provisioning');
  }

  let source;
  if (request.source_pos_x != null && request.source_observed_at) {
    source = {
      position: [Number(request.source_pos_x), Number(request.source_pos_y), Number(request.source_pos_z)],
      observedAt: request.source_observed_at,
      sourceType: 'previously_bound',
    };
  } else {
    source = await resolveTeleportSource(db, request);
  }
  if (!source) return null;

  const rows = await db.query(
    `UPDATE teleport_requests
     SET status = 'provisioning', source_pos_x = ?, source_pos_y = ?, source_pos_z = ?,
         source_observed_at = ?, failure_code = NULL, failure_message = NULL, updated_at = NOW()
     WHERE id = ? AND server_id = ? AND (
       status = 'waiting_disconnect' OR (
         status = 'provisioning' AND
         updated_at < clock_timestamp() - INTERVAL '10 minutes'
       )
     )
     AND expires_at > clock_timestamp()
     RETURNING *`,
    [...source.position, source.observedAt, request.id, serverId]
  );
  if (!rows[0]) return null;
  await db.query(
    `INSERT INTO teleport_events
       (request_id, guild_id, server_id, identity_id, actor_user_id, event_type, metadata)
     VALUES (?, ?, ?, ?, ?, 'source_bound', ?)`,
    [request.id, request.guild_id, request.server_id, request.identity_id,
      request.requested_by_user_id || null, JSON.stringify({ sourceType: source.sourceType })]
  );
  return {
    request: { ...request, ...rows[0] },
    sourcePosition: source.position,
    destinationPosition: [Number(request.pos_x), Number(request.pos_y), Number(request.pos_z)],
  };
}

async function assertTeleportProviderContext(db, serverId, context) {
  const row = await db.get(
    `SELECT s.platform_server_id, gt.token_hash
     FROM servers s
     JOIN guilds g ON g.id = s.guild_id AND g.status = 'approved'
     JOIN guild_tokens gt ON gt.guild_id = s.guild_id
       AND gt.token_type = 'nitrado' AND gt.nitrado_user_id IS NOT NULL
     WHERE s.id = ? AND s.status = 'active'
     FOR NO KEY UPDATE OF s, g, gt`,
    [serverId]
  );
  const { decryptToken } = require('../utils/encryption');
  if (!row || String(row.platform_server_id) !== String(context.platformServerId) ||
      decryptToken(row.token_hash) !== context.token) {
    throw new Error('Teleport provider context changed before execution');
  }
}

async function resolveServerControlContext(db, serverId) {
  const row = await db.get(
    `SELECT s.platform_server_id, gt.token_hash
     FROM servers s
     JOIN guilds g ON g.id = s.guild_id AND g.status = 'approved'
     JOIN guild_tokens gt ON gt.guild_id = s.guild_id
       AND gt.token_type = 'nitrado' AND gt.nitrado_user_id IS NOT NULL
     WHERE s.id = ? AND s.status = 'active'`,
    [serverId]
  );
  if (!row?.token_hash) throw new Error('Authorized Nitrado token is unavailable');
  const { decryptToken } = require('../utils/encryption');
  return { platformServerId: row.platform_server_id, token: decryptToken(row.token_hash) };
}

async function resolveProvisioningContext(db, serverId) {
  const row = await db.get(
    `SELECT s.platform_server_id, gt.token_hash
     FROM servers s
     JOIN guilds g ON g.id = s.guild_id AND g.status = 'approved'
     JOIN guild_tokens gt ON gt.guild_id = s.guild_id
       AND gt.token_type = 'nitrado' AND gt.nitrado_user_id IS NOT NULL
     WHERE s.id = ? AND s.status = 'active'`,
    [serverId]
  );
  if (!row?.token_hash) throw new Error('Authorized Nitrado token is unavailable');
  const { decryptToken } = require('../utils/encryption');
  const token = decryptToken(row.token_hash);
  const mission = await missionFileService.getActiveMission(row.platform_server_id, token);
  if (!mission?.missionPath) throw new Error('Active mission is unavailable');
  return {
    platformServerId: row.platform_server_id,
    token,
    missionDir: mission.missionPath,
    mapName: mission.mapName,
  };
}

async function persistProvisioningContext(db, request, context) {
  const expectedPraPath = praFilePath(request.id);
  const rows = await db.query(
    `UPDATE teleport_requests
     SET mission_dir = ?, mission_map_name = ?, pra_file_path = ?, updated_at = NOW()
     WHERE id = ? AND server_id = ? AND status = 'provisioning'
     RETURNING *`,
    [context.missionDir, context.mapName, expectedPraPath, request.id, request.server_id]
  );
  if (!rows[0]) throw new Error('Teleport request changed before provisioning context was saved');
  return rows[0];
}

async function markArmed(db, claim, provision, context) {
  const rows = await db.query(
    `UPDATE teleport_requests
     SET status = 'armed', pra_file_path = ?, mission_dir = ?, mission_map_name = ?,
         arm_configured_at = clock_timestamp(), restart_requested_at = clock_timestamp(),
         restart_attempt_count = 1, expires_at = clock_timestamp() + INTERVAL '7 days',
         updated_at = NOW()
     WHERE id = ? AND server_id = ? AND status = 'provisioning'
     RETURNING *`,
    [provision.praFilePath, context.missionDir, context.mapName,
      claim.request.id, claim.request.server_id]
  );
  if (!rows[0]) throw new Error('Teleport request changed before it could be armed');
  await db.query(
    `INSERT INTO teleport_events
       (request_id, guild_id, server_id, identity_id, actor_user_id, event_type, metadata)
     VALUES (?, ?, ?, ?, ?, 'provisioned', ?)`,
    [claim.request.id, claim.request.guild_id, claim.request.server_id,
      claim.request.identity_id, claim.request.requested_by_user_id || null,
      JSON.stringify({ praFilePath: provision.praFilePath, missionMapName: context.mapName })]
  );
  return rows[0];
}

async function recordRestartOutcome(db, request, error = null) {
  if (error) {
    await db.query(
      `UPDATE teleport_requests
       SET failure_code = 'RESTART_REQUEST_FAILED', failure_message = ?, updated_at = NOW()
       WHERE id = ? AND server_id = ? AND status = 'armed'`,
      [String(error.message || error).slice(0, 500), request.id, request.server_id]
    );
  } else {
    await db.query(
      `UPDATE teleport_requests
       SET failure_code = NULL, failure_message = NULL, updated_at = NOW()
       WHERE id = ? AND server_id = ? AND status = 'armed'
         AND failure_code = 'RESTART_REQUEST_FAILED'`,
      [request.id, request.server_id]
    );
  }
  await db.query(
    `INSERT INTO teleport_events
       (request_id, guild_id, server_id, identity_id, actor_user_id, event_type, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [request.id, request.guild_id, request.server_id, request.identity_id,
      request.requested_by_user_id || null,
      error ? 'restart_request_failed' : 'restart_requested',
      JSON.stringify(error ? { message: String(error.message || error).slice(0, 500) } : {})]
  );
}

async function markTeleportArrivals(db, serverId) {
  const candidates = await db.query(
    `SELECT tr.id, tr.guild_id, tr.server_id, tr.identity_id, tr.requested_by_user_id,
            arrival.observed_at
     FROM teleport_requests tr
     JOIN teleport_destinations td
       ON td.id = tr.destination_id AND td.server_id = tr.server_id AND td.guild_id = tr.guild_id
     JOIN LATERAL (
       SELECT srl.detected_at
       FROM server_restart_log srl
       WHERE srl.server_id = tr.server_id
         AND srl.bios_session_id IS NOT NULL
         AND srl.detected_at >= tr.arm_configured_at
       ORDER BY srl.detected_at ASC, srl.id ASC
       LIMIT 1
     ) arm_restart ON TRUE
     JOIN LATERAL (
       SELECT ps.timestamp AS observed_at
       FROM player_position_snapshots ps
       WHERE ps.server_id = tr.server_id
         AND ps.identity_id = tr.identity_id
         AND ps.timestamp >= arm_restart.detected_at
         AND ps.timestamp <= tr.expires_at
         AND ps.pos_x IS NOT NULL AND ps.pos_y IS NOT NULL AND ps.pos_z IS NOT NULL
         AND power(ps.pos_x - td.pos_x, 2) + power(ps.pos_z - td.pos_y, 2) +
             power(ps.pos_y - td.pos_z, 2) <= power(25, 2)
       ORDER BY ps.timestamp ASC, ps.id ASC
       LIMIT 1
     ) arrival ON TRUE
     WHERE tr.server_id = ? AND tr.status = 'armed'
     ORDER BY tr.id
     FOR UPDATE OF tr, td`,
    [serverId]
  );
  const arrivals = [];
  for (const candidate of candidates) {
    const rows = await db.query(
      `UPDATE teleport_requests
       SET status = 'cleanup_pending', arrival_observed_at = ?, updated_at = NOW()
       WHERE id = ? AND server_id = ? AND status = 'armed'
       RETURNING id, status`,
      [candidate.observed_at, candidate.id, serverId]
    );
    if (!rows[0]) continue;
    await db.query(
      `INSERT INTO teleport_events
         (request_id, guild_id, server_id, identity_id, actor_user_id, event_type, metadata)
       VALUES (?, ?, ?, ?, ?, 'arrival_observed', ?)`,
      [candidate.id, candidate.guild_id, candidate.server_id, candidate.identity_id,
        candidate.requested_by_user_id || null,
        JSON.stringify({ observedAt: candidate.observed_at, radiusMeters: 25 })]
    );
    arrivals.push(rows[0]);
  }
  return arrivals;
}

async function claimTeleportCleanup(db, requestId, serverId) {
  const server = await db.get(
    "SELECT id, guild_id FROM servers WHERE id = ? AND status = 'active' FOR UPDATE",
    [serverId]
  );
  if (!server) return null;
  const rows = await db.query(
    `UPDATE teleport_requests
     SET status = 'cleanup_processing', cleanup_requested_at = clock_timestamp(),
         failure_code = NULL, failure_message = NULL, updated_at = NOW()
     WHERE id = ? AND server_id = ? AND (
       status = 'cleanup_pending' OR (
         status = 'cleanup_processing' AND
         cleanup_requested_at < clock_timestamp() - INTERVAL '10 minutes'
       )
     )
     RETURNING *`,
    [requestId, serverId]
  );
  return rows[0] || null;
}

async function markCleanupRestartPending(db, request) {
  const rows = await db.query(
    `UPDATE teleport_requests
     SET status = 'cleanup_restart_pending', cleanup_config_removed_at = clock_timestamp(),
         cleanup_restart_requested_at = clock_timestamp(), cleanup_restart_attempt_count = 1,
         failure_code = CASE WHEN final_status = 'failed' THEN failure_code ELSE NULL END,
         failure_message = CASE WHEN final_status = 'failed' THEN failure_message ELSE NULL END,
         updated_at = NOW()
     WHERE id = ? AND server_id = ? AND status = 'cleanup_processing'
     RETURNING *`,
    [request.id, request.server_id]
  );
  if (!rows[0]) throw new Error('Teleport cleanup claim changed after provider cleanup');
  await db.query(
    `INSERT INTO teleport_events
       (request_id, guild_id, server_id, identity_id, actor_user_id, event_type, metadata)
     VALUES (?, ?, ?, ?, ?, 'cleanup_config_removed', ?)`,
    [request.id, request.guild_id, request.server_id, request.identity_id,
      request.requested_by_user_id || null, JSON.stringify({})]
  );
  return rows[0];
}

async function completeTeleportCleanup(db, request) {
  const rows = await db.query(
    `UPDATE teleport_requests tr
     SET status = tr.final_status,
         completed_at = CASE WHEN tr.final_status = 'completed' THEN clock_timestamp() ELSE tr.completed_at END,
         failed_at = CASE WHEN tr.final_status = 'failed' THEN clock_timestamp() ELSE tr.failed_at END,
         updated_at = NOW()
     WHERE tr.id = ? AND tr.server_id = ? AND tr.status = 'cleanup_restart_pending'
       AND EXISTS (
         SELECT 1 FROM server_restart_log srl
         WHERE srl.server_id = tr.server_id
          AND srl.bios_session_id IS NOT NULL
           AND srl.detected_at >= tr.cleanup_config_removed_at
       )
     RETURNING tr.id, tr.status`,
    [request.id, request.server_id]
  );
  if (!rows[0]) throw new Error('Teleport cleanup claim changed before completion');
  for (const eventType of ['cleanup_completed', rows[0].status]) {
    await db.query(
      `INSERT INTO teleport_events
         (request_id, guild_id, server_id, identity_id, actor_user_id, event_type, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [request.id, request.guild_id, request.server_id, request.identity_id,
        request.requested_by_user_id || null, eventType, JSON.stringify({})]
    );
  }
  return rows[0];
}

async function recordCleanupRestartOutcome(db, request, error = null) {
  if (error) {
    await db.query(
      `UPDATE teleport_requests
       SET failure_code = CASE WHEN final_status = 'failed' THEN failure_code ELSE 'CLEANUP_RESTART_FAILED' END,
           failure_message = CASE WHEN final_status = 'failed' THEN failure_message ELSE ? END,
           updated_at = NOW()
       WHERE id = ? AND server_id = ? AND status = 'cleanup_restart_pending'`,
      [String(error.message || error).slice(0, 500), request.id, request.server_id]
    );
  } else {
    await db.query(
      `UPDATE teleport_requests
       SET failure_code = NULL, failure_message = NULL, updated_at = NOW()
       WHERE id = ? AND server_id = ? AND status = 'cleanup_restart_pending'
         AND failure_code = 'CLEANUP_RESTART_FAILED'`,
      [request.id, request.server_id]
    );
  }
  await db.query(
    `INSERT INTO teleport_events
       (request_id, guild_id, server_id, identity_id, actor_user_id, event_type, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [request.id, request.guild_id, request.server_id, request.identity_id,
      request.requested_by_user_id || null,
      error ? 'cleanup_restart_failed' : 'cleanup_restart_requested',
      JSON.stringify(error ? { message: String(error.message || error).slice(0, 500) } : {})]
  );
}

async function refreshRestartEvidence(db, serverId, dependencies = {}) {
  const fetchStartedAt = await (dependencies.captureDatabaseClock || captureDatabaseClock)(db);
  const context = await (dependencies.resolveServerControlContext || resolveServerControlContext)(db, serverId);
  const sync = dependencies.performExactServerLogSync || logSyncService.performExactServerLogSync;
  const result = await sync(db, serverId, context.token);
  if (result.failedServerIds?.map(String).includes(String(context.platformServerId))) {
    throw new Error(`Log evidence refresh failed for server ${serverId}`);
  }
  const evidence = result.restartEvidence?.[String(context.platformServerId)];
  if (!evidence) {
    throw new Error(`Restart evidence is unavailable for server ${serverId}`);
  }
  await (dependencies.processDownloadedRestartEvidence || processDownloadedRestartEvidence)(
    db,
    { serverId, platformServerId: context.platformServerId },
    evidence
  );
  const scanExactServerLogs = dependencies.scanExactServerLogs ||
    require('./logScanService').scanExactServerLogs;
  const scanResult = await scanExactServerLogs(
    db,
    context.platformServerId,
    context.token,
    serverId
  );
  if (!scanResult) {
    throw new Error(`ADM evidence logs are unavailable for server ${serverId}`);
  }
  if (scanResult.onlineCachePublished !== true) {
    throw new Error(`Fresh ADM evidence is unavailable for server ${serverId}`);
  }
  await (dependencies.markServerLogParseSuccessful || markServerLogParseSuccessful)(
    db,
    serverId,
    fetchStartedAt,
    { lifecycleEvidenceReady: true }
  );
}

async function claimRestartRetry(db, requestId, serverId) {
  const server = await db.get(
    "SELECT id FROM servers WHERE id = ? AND status = 'active' FOR UPDATE",
    [serverId]
  );
  if (!server) return null;
  const request = await db.get(
    `SELECT tr.* FROM teleport_requests tr
     JOIN servers s ON s.id = tr.server_id
     WHERE tr.id = ? AND tr.server_id = ? AND (
       (tr.status = 'armed'
         AND tr.restart_attempt_count > 0
         AND tr.restart_requested_at < clock_timestamp() - INTERVAL '10 minutes'
         AND s.log_parse_watermark_at >= tr.restart_requested_at
         AND NOT EXISTS (
           SELECT 1 FROM server_restart_log
           WHERE server_id = ? AND bios_session_id IS NOT NULL AND detected_at >= tr.arm_configured_at
         )) OR
       (tr.status = 'cleanup_restart_pending'
         AND tr.cleanup_restart_attempt_count > 0
         AND tr.cleanup_restart_requested_at < clock_timestamp() - INTERVAL '10 minutes'
         AND s.log_parse_watermark_at >= tr.cleanup_restart_requested_at
         AND NOT EXISTS (
           SELECT 1 FROM server_restart_log
           WHERE server_id = ? AND bios_session_id IS NOT NULL AND detected_at >= tr.cleanup_config_removed_at
         ))
     )
     FOR UPDATE OF tr`,
    [requestId, serverId, serverId, serverId]
  );
  if (!request) return null;
  const cleanup = request.status === 'cleanup_restart_pending';
  const rows = await db.query(
    cleanup
      ? `UPDATE teleport_requests
         SET cleanup_restart_requested_at = clock_timestamp(),
             cleanup_restart_attempt_count = cleanup_restart_attempt_count + 1,
             updated_at = NOW()
         WHERE id = ? AND server_id = ? AND status = 'cleanup_restart_pending'
         RETURNING *`
      : `UPDATE teleport_requests
         SET restart_requested_at = clock_timestamp(),
             restart_attempt_count = restart_attempt_count + 1,
             updated_at = NOW()
         WHERE id = ? AND server_id = ? AND status = 'armed'
         RETURNING *`,
    [requestId, serverId]
  );
  return rows[0] || null;
}

async function processTeleportRestarts(db, serverId, dependencies = {}) {
  const candidates = await db.query(
    `SELECT tr.id FROM teleport_requests tr
     JOIN servers s ON s.id = tr.server_id
     WHERE tr.server_id = ? AND (
       (tr.status = 'armed'
         AND tr.restart_attempt_count > 0
         AND tr.restart_requested_at < clock_timestamp() - INTERVAL '10 minutes'
         AND s.log_parse_watermark_at >= tr.restart_requested_at
         AND NOT EXISTS (
           SELECT 1 FROM server_restart_log
           WHERE server_id = ? AND bios_session_id IS NOT NULL AND detected_at >= tr.arm_configured_at
         )) OR
       (tr.status = 'cleanup_restart_pending'
         AND tr.cleanup_restart_attempt_count > 0
         AND tr.cleanup_restart_requested_at < clock_timestamp() - INTERVAL '10 minutes'
         AND s.log_parse_watermark_at >= tr.cleanup_restart_requested_at
         AND NOT EXISTS (
           SELECT 1 FROM server_restart_log
           WHERE server_id = ? AND bios_session_id IS NOT NULL AND detected_at >= tr.cleanup_config_removed_at
         ))
     )
     ORDER BY tr.requested_at, tr.id`,
    [serverId, serverId, serverId]
  );
  const outcomes = [];
  for (const candidate of candidates) {
    try {
      const request = await db.transaction(tx => claimRestartRetry(tx, candidate.id, serverId));
      if (!request) continue;
      let restartError = null;
      try {
        await restartServerWithMissionLock(db, serverId, dependencies);
      } catch (error) {
        restartError = error;
      }
      await db.transaction(tx => request.status === 'cleanup_restart_pending'
        ? recordCleanupRestartOutcome(tx, request, restartError)
        : recordRestartOutcome(tx, request, restartError));
      outcomes.push({ id: request.id, status: request.status, restartRequested: !restartError });
    } catch (error) {
      outcomes.push({ id: candidate.id, status: 'retry', error: error.message });
    }
  }
  return outcomes;
}

async function refundPaidTeleport(db, request, dependencies) {
  const refund = dependencies.processRefund || processRefund;
  const result = await refund(db, request.order_id, request.server_id);
  if (!result.success) throw new Error(result.error || 'Teleport refund failed');
  const rows = await db.query(
    `UPDATE teleport_requests
     SET refunded_at = clock_timestamp(), updated_at = NOW()
     WHERE id = ? AND server_id = ? AND refunded_at IS NULL
     RETURNING id, status, refunded_at`,
    [request.id, request.server_id]
  );
  if (!rows[0]) throw new Error('Teleport refund provenance could not be recorded');
  return { id: request.id, status: rows[0].status, refunded: true };
}

async function processExpiredTeleports(db, serverId, dependencies = {}) {
  const allowLifecycleExpiry = dependencies.allowLifecycleExpiry !== false;
  const candidates = await db.query(
    `SELECT tr.id FROM teleport_requests tr
     JOIN servers s ON s.id = tr.server_id
     WHERE tr.server_id = ? AND (
       (? = TRUE AND tr.status IN ('waiting_disconnect', 'provisioning', 'armed')
         AND tr.expires_at <= clock_timestamp()
         AND s.log_parse_watermark_at >= tr.expires_at) OR
       (tr.status = 'failed' AND tr.order_item_id IS NOT NULL AND tr.refunded_at IS NULL)
     )
     ORDER BY tr.expires_at, tr.id`,
    [serverId, allowLifecycleExpiry]
  );
  const outcomes = [];
  for (const candidate of candidates) {
    try {
      const outcome = await db.transaction(async tx => {
        await acquireMissionMutationLock(tx, serverId);
        const request = await tx.get(
          `SELECT tr.*, soi.order_id
           FROM teleport_requests tr
           JOIN servers s ON s.id = tr.server_id
           LEFT JOIN shop_order_items soi ON soi.id = tr.order_item_id
           WHERE tr.id = ? AND tr.server_id = ? AND (
             (? = TRUE AND tr.status IN ('waiting_disconnect', 'provisioning', 'armed')
               AND tr.expires_at <= clock_timestamp()
               AND s.log_parse_watermark_at >= tr.expires_at) OR
             (tr.status = 'failed' AND tr.order_item_id IS NOT NULL AND tr.refunded_at IS NULL)
           )
           FOR UPDATE OF tr`,
          [candidate.id, serverId, allowLifecycleExpiry]
        );
        if (!request) return null;
        if (request.status === 'failed' && request.order_id) {
          return refundPaidTeleport(tx, request, dependencies);
        }
        if (request.status === 'waiting_disconnect' && request.order_id) {
          return refundPaidTeleport(tx, request, dependencies);
        }
        if (request.status === 'waiting_disconnect') {
          const rows = await tx.query(
            `UPDATE teleport_requests
             SET status = 'failed', final_status = 'failed', failed_at = clock_timestamp(),
                 failure_code = 'DISCONNECT_TIMEOUT',
                 failure_message = 'No qualifying disconnect was observed before expiry',
                 updated_at = NOW()
             WHERE id = ? AND server_id = ? AND status = 'waiting_disconnect'
             RETURNING id, status`,
            [request.id, serverId]
          );
          if (!rows[0]) return null;
          await tx.query(
            `INSERT INTO teleport_events
               (request_id, guild_id, server_id, identity_id, actor_user_id, event_type, metadata)
             VALUES (?, ?, ?, ?, ?, 'failed', ?)`,
            [request.id, request.guild_id, request.server_id, request.identity_id,
              request.requested_by_user_id || null,
              JSON.stringify({ code: 'DISCONNECT_TIMEOUT' })]
          );
          return rows[0];
        }
        if (request.status === 'provisioning' && !request.mission_dir) {
          const rows = await tx.query(
            `UPDATE teleport_requests
             SET status = 'failed', final_status = 'failed', failed_at = clock_timestamp(),
                 failure_code = 'PROVISIONING_TIMEOUT',
                 failure_message = 'Provider provisioning did not begin before expiry',
                 updated_at = NOW()
             WHERE id = ? AND server_id = ? AND status = 'provisioning'
             RETURNING id, status`,
            [request.id, serverId]
          );
          if (!rows[0]) return null;
          if (request.order_id) {
            return refundPaidTeleport(tx, { ...request, ...rows[0] }, dependencies);
          }
          await tx.query(
            `INSERT INTO teleport_events
               (request_id, guild_id, server_id, identity_id, actor_user_id, event_type, metadata)
             VALUES (?, ?, ?, ?, ?, 'failed', ?)`,
            [request.id, request.guild_id, request.server_id, request.identity_id,
              request.requested_by_user_id || null,
              JSON.stringify({ code: 'PROVISIONING_TIMEOUT' })]
          );
          return rows[0];
        }
        const rows = await tx.query(
          `UPDATE teleport_requests
           SET status = 'cleanup_pending', final_status = 'failed',
               failure_code = ?, failure_message = ?, updated_at = NOW()
           WHERE id = ? AND server_id = ? AND status IN ('provisioning', 'armed')
           RETURNING id, status`,
          [request.status === 'provisioning' ? 'PROVISIONING_TIMEOUT' : 'ARRIVAL_TIMEOUT',
            request.status === 'provisioning'
              ? 'Provider provisioning did not complete before expiry'
              : 'Arrival was not observed before expiry',
            request.id, serverId]
        );
        return rows[0] || null;
      });
      if (outcome) outcomes.push(outcome);
    } catch (error) {
      outcomes.push({ id: candidate.id, status: 'retry', error: error.message });
    }
  }
  return outcomes;
}

async function processTeleportCleanups(db, serverId, dependencies = {}) {
  const candidates = await db.query(
    `SELECT tr.id, tr.status FROM teleport_requests tr
     WHERE tr.server_id = ? AND (
       tr.status = 'cleanup_pending' OR (
         tr.status = 'cleanup_processing' AND
         tr.cleanup_requested_at < clock_timestamp() - INTERVAL '10 minutes'
       ) OR (
         tr.status = 'cleanup_restart_pending' AND EXISTS (
           SELECT 1 FROM server_restart_log srl
           WHERE srl.server_id = tr.server_id
          AND srl.bios_session_id IS NOT NULL
             AND srl.detected_at >= tr.cleanup_config_removed_at
         )
       )
     )
     ORDER BY tr.requested_at, tr.id`,
    [serverId]
  );
  const outcomes = [];
  for (const candidate of candidates) {
    try {
      if (candidate.status === 'cleanup_restart_pending') {
        const completed = await db.transaction(tx => completeTeleportCleanup(tx, candidate));
        outcomes.push(completed);
        continue;
      }
      const claim = await db.transaction(async tx => {
        await acquireMissionMutationLock(tx, serverId);
        return claimTeleportCleanup(tx, candidate.id, serverId);
      });
      if (!claim) continue;
      const activeContext = await (dependencies.resolveProvisioningContext || resolveProvisioningContext)(
        db, serverId
      );
      if (!claim.mission_dir) throw new Error('Teleport cleanup mission path is unavailable');
      const context = { ...activeContext, missionDir: claim.mission_dir, internalServerId: serverId };
      const pending = await db.transaction(async tx => {
        await acquireMissionMutationLock(tx, serverId);
        await (dependencies.assertTeleportProviderContext || assertTeleportProviderContext)(
          tx, serverId, context
        );
        const prepareTeleport = dependencies.prepareTeleportProviderMutation ||
          prepareTeleportProviderMutation;
        const prepared = await prepareTeleport(
          db, context, claim.id, 'cleanup', dependencies
        );
        const journal = buildTeleportFileJournal(context, dependencies, prepared.snapshots);
        registerProviderMutationRollback(tx, {
          operationId: prepared.operationId,
          journal,
        });
        await (dependencies.cleanupPraTeleport || cleanupPraTeleport)({
          ...context, requestId: claim.id, fileService: journal,
        });
        const result = await markCleanupRestartPending(tx, claim);
        const finalizeProviderMutation = dependencies.updatePreparedProviderMutation ||
          updatePreparedProviderMutation;
        await finalizeProviderMutation(tx, prepared.operationId, 'completed');
        return result;
      });
      let restartError = null;
      try {
        await restartServerWithMissionLock(db, serverId, dependencies);
      } catch (error) {
        restartError = error;
      }
      await db.transaction(tx => recordCleanupRestartOutcome(
        tx, { ...claim, ...pending }, restartError
      ));
      outcomes.push({
        id: pending.id,
        status: pending.status,
        restartRequested: !restartError,
      });
    } catch (error) {
      outcomes.push({ id: candidate.id, status: 'retry', error: error.message });
    }
  }
  return outcomes;
}

async function processWaitingTeleports(db, serverId, dependencies = {}) {
  const rows = await db.query(
    `SELECT id FROM teleport_requests
     WHERE server_id = ? AND (
       status = 'waiting_disconnect' OR (
         status = 'provisioning' AND
         updated_at < clock_timestamp() - INTERVAL '10 minutes'
       )
     )
     ORDER BY requested_at, id`,
    [serverId]
  );
  const outcomes = [];
  for (const row of rows) {
    let claim;
    try {
      claim = await db.transaction(async tx => {
        await acquireMissionMutationLock(tx, serverId);
        return claimTeleportRequest(tx, row.id, serverId);
      });
      if (!claim) continue;
      let context;
      const armed = await db.transaction(async tx => {
        await acquireMissionMutationLock(tx, serverId);
        const resolvedContext = await (dependencies.resolveProvisioningContext || resolveProvisioningContext)(
          tx, serverId
        );
        context = { ...resolvedContext, internalServerId: serverId };
        assertDestinationMap(claim.request.map_name, context.mapName);
        const persistedContext = await persistProvisioningContext(tx, claim.request, context);
        claim.request = { ...claim.request, ...persistedContext };
        await (dependencies.assertTeleportProviderContext || assertTeleportProviderContext)(
          tx, serverId, context
        );
        const prepareTeleport = dependencies.prepareTeleportProviderMutation ||
          prepareTeleportProviderMutation;
        const prepared = await prepareTeleport(
          db, context, claim.request.id, 'provision', dependencies
        );
        const journal = buildTeleportFileJournal(context, dependencies, prepared.snapshots);
        registerProviderMutationRollback(tx, {
          operationId: prepared.operationId,
          journal,
        });
        const provision = await (dependencies.provisionPraTeleport || provisionPraTeleport)({
          ...context,
          requestId: claim.request.id,
          sourcePosition: claim.sourcePosition,
          destinationPosition: claim.destinationPosition,
          fileService: journal,
        });
        const result = await markArmed(tx, claim, provision, context);
        const finalizeProviderMutation = dependencies.updatePreparedProviderMutation ||
          updatePreparedProviderMutation;
        await finalizeProviderMutation(tx, prepared.operationId, 'completed');
        return result;
      });
      let restartError = null;
      try {
        await restartServerWithMissionLock(db, serverId, dependencies);
      } catch (error) {
        restartError = error;
      }
      await db.transaction(tx => recordRestartOutcome(tx, { ...claim.request, ...armed }, restartError));
      outcomes.push({
        id: armed.id,
        status: armed.status,
        restartRequested: !restartError,
      });
    } catch (error) {
      outcomes.push({ id: row.id, status: 'retry', error: error.message });
    }
  }
  return outcomes;
}

module.exports = {
  acquireMissionMutationLock,
  assertDestinationMap,
  claimTeleportRequest,
  collectTeleportMutationPaths,
  markTeleportArrivals,
  processExpiredTeleports,
  processTeleportCleanups,
  processTeleportRestarts,
  processWaitingTeleports,
  refreshRestartEvidence,
  resolveProvisioningContext,
  resolveServerControlContext,
};
