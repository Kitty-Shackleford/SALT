'use strict';

const { createMissionInitCapabilityService } = require('./missionInitCapabilityService');

const HASH_PATTERN = /^[a-f0-9]{64}$/;

function controlledError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function parsePositiveId(value, label) {
  const text = String(value || '');
  if (!/^[1-9]\d*$/.test(text)) throw new TypeError(`A valid ${label} is required`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) throw new TypeError(`A valid ${label} is required`);
  return parsed;
}

function parsePlan(value) {
  try {
    const plan = typeof value === 'string' ? JSON.parse(value) : value;
    return plan && typeof plan === 'object' && !Array.isArray(plan) ? plan : null;
  } catch (_) {
    return null;
  }
}

function hashOrNull(value) {
  return typeof value === 'string' && HASH_PATTERN.test(value) ? value : null;
}

function isoOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function projectOperation(row) {
  if (!row) return null;
  const plan = parsePlan(row.plan_json);
  return {
    id: String(row.id),
    action: typeof row.action === 'string' ? row.action : 'unknown',
    status: typeof row.status === 'string' ? row.status : 'unknown',
    sourceHash: hashOrNull(plan?.expectedSourceHash),
    candidateHash: hashOrNull(plan?.expectedCandidateHash || plan?.expectedCurrentHash),
    configurationHash: hashOrNull(plan?.configurationHash),
    restoredHash: hashOrNull(plan?.restoredHash),
    createdAt: isoOrNull(row.created_at),
    finishedAt: isoOrNull(row.finished_at),
  };
}

function projectCapability(capability) {
  return {
    capability: capability?.capability || 'mission.init_c',
    status: capability?.status || 'unknown',
    reasonCode: capability?.reasonCode || 'provider_unavailable',
    platform: capability?.platform || 'unknown',
    observedAt: capability?.observedAt || null,
    readable: capability?.readable === true,
    supportLevel: capability?.supportLevel || 'unknown',
    rolloutEnabled: capability?.rolloutEnabled === true,
    size: Number.isSafeInteger(capability?.size) && capability.size >= 0 ? capability.size : null,
  };
}

function providerState(capability, latestOperation, unresolvedOperation) {
  if (unresolvedOperation) return 'recovery_required';
  if (capability?.status !== 'supported' || !hashOrNull(capability?.hash)) return 'unknown';
  if (!latestOperation) return 'unmanaged';
  if (latestOperation.status !== 'completed') return 'unknown';
  if (latestOperation.action === 'deploy' &&
      latestOperation.candidateHash === capability.hash) return 'candidate_present';
  if (latestOperation.action === 'restore' &&
      latestOperation.restoredHash === capability.hash) return 'original_restored';
  return 'drifted';
}

function createMissionInitStatusService(options = {}) {
  const capabilityService = options.capabilityService || createMissionInitCapabilityService(options);
  const decryptToken = options.decryptToken || require('../utils/encryption').decryptToken;

  async function getStatus({ db, internalServerId, discordGuildId }) {
    if (!db || typeof db.query !== 'function') {
      throw new TypeError('Mission init status database is required');
    }
    const serverId = parsePositiveId(internalServerId, 'internal server ID');
    const guildId = String(discordGuildId || '');
    if (!/^\d{16,22}$/.test(guildId)) {
      throw new TypeError('A valid Discord guild ID is required');
    }

    const contexts = await db.query(
      `SELECT s.id AS server_id, s.platform_server_id, gt.token_hash
       FROM servers s
       JOIN guilds g ON g.id = s.guild_id
       JOIN guild_tokens gt
         ON gt.guild_id = g.id
        AND gt.token_type = 'nitrado'
        AND gt.nitrado_user_id IS NOT NULL
       WHERE s.id = ? AND g.discord_guild_id = ?
         AND s.status = 'active' AND g.status = 'approved'`,
      [serverId, guildId]
    );
    if (!Array.isArray(contexts) || contexts.length !== 1 ||
        !contexts[0].platform_server_id || !contexts[0].token_hash) {
      throw controlledError(404, 'MISSION_INIT_STATUS_UNAVAILABLE',
        'Mission init status is unavailable for this server');
    }
    const context = contexts[0];
    const token = decryptToken(context.token_hash);
    if (typeof token !== 'string' || !token) {
      throw controlledError(409, 'MISSION_INIT_STATUS_UNAVAILABLE',
        'Mission init status is unavailable for this server');
    }

    const [capability, latestRows, unresolvedRows] = await Promise.all([
      capabilityService.probe({
        platformServerId: String(context.platform_server_id),
        token,
        includeContent: false,
        includeProviderPath: false,
      }),
      db.query(
        `SELECT pm.id, pm.action, pm.status, pm.plan_json, pm.created_at, pm.finished_at
         FROM provider_mutations pm
         JOIN servers scoped_server ON scoped_server.id = pm.server_id
         JOIN guilds scoped_guild ON scoped_guild.id = scoped_server.guild_id
         WHERE pm.server_id = ? AND scoped_guild.discord_guild_id = ?
           AND pm.provider_service_id = ?
           AND scoped_server.status = 'active' AND scoped_guild.status = 'approved'
           AND pm.workflow = 'mission_init'
         ORDER BY pm.created_at DESC, pm.id DESC
         LIMIT 1`,
        [serverId, guildId, String(context.platform_server_id)]
      ),
      db.query(
        `SELECT pm.id, pm.workflow, pm.status
         FROM provider_mutations pm
         JOIN servers scoped_server ON scoped_server.id = pm.server_id
         JOIN guilds scoped_guild ON scoped_guild.id = scoped_server.guild_id
         WHERE pm.server_id = ? AND scoped_guild.discord_guild_id = ?
           AND pm.provider_service_id = ?
           AND scoped_server.status = 'active' AND scoped_guild.status = 'approved'
           AND pm.status IN ('prepared', 'recovery_pending')
         ORDER BY pm.created_at, pm.id
         LIMIT 1`,
        [serverId, guildId, String(context.platform_server_id)]
      ),
    ]);
    const latestOperation = projectOperation(Array.isArray(latestRows) ? latestRows[0] : null);
    const unresolved = Array.isArray(unresolvedRows) ? unresolvedRows[0] : null;

    return {
      capability: projectCapability(capability),
      liveSourceHash: hashOrNull(capability?.hash),
      providerState: providerState(capability, latestOperation, unresolved),
      latestOperation,
      providerRecovery: unresolved ? {
        operationId: String(unresolved.id),
        workflow: String(unresolved.workflow || 'unknown'),
        status: String(unresolved.status || 'unknown'),
      } : null,
      runtimeEvidence: 'not_recorded',
      controlPlane: {
        desiredState: 'not_persisted',
        approval: 'not_persisted',
        deploymentActionAvailable: false,
        restoreActionAvailable: false,
        restartActionAvailable: false,
      },
    };
  }

  return { getStatus };
}

module.exports = {
  createMissionInitStatusService,
  projectOperation,
  providerState,
};
