'use strict';

const { DEFAULT_LINK_SETTINGS, parseLinkSettings } = require('../../utils/linkPolicy');

const LINK_POLICY_LOCK_NAMESPACE = 2147483003;
const ACTOR_ROLE_LOCK_NAMESPACE = 2147483001;
const VERIFICATION_MODES = new Set(['admin_approval', 'emote', 'open']);
const ROLE_KEYS = new Set(['assignOnJoin', 'assignOnLink', 'removeOnLink', 'removeOnLeave']);

async function getLinkSettings(db, serverId, options = {}) {
  if (!Number.isInteger(Number(serverId)) || Number(serverId) <= 0) {
    throw new Error('A valid server ID is required for link settings');
  }
  const result = await db.query(
    `SELECT enabled, config
     FROM server_features
     WHERE server_id = $1 AND feature_name = 'player_linking'
     LIMIT 1${options.forUpdate ? ' FOR UPDATE' : ''}`,
    [Number(serverId)]
  );
  const row = result.rows[0];
  const enabled = row?.enabled === true || row?.enabled === 1 || row?.enabled === '1' || row?.enabled === 't';
  return parseLinkSettings(enabled ? row.config : null);
}

async function validateGuildRoleSettings(db, serverId, settings) {
  const normalized = parseLinkSettings(settings);
  const result = await db.query(
    `SELECT sf.server_id, sf.enabled, sf.config
     FROM server_features sf
     JOIN servers target ON target.id = $1
     JOIN servers sibling ON sibling.guild_id = target.guild_id
     JOIN guilds g ON g.id = sibling.guild_id
     WHERE sf.server_id = sibling.id
       AND sf.feature_name = 'player_linking'
       AND sf.server_id <> $1
       AND sibling.status = 'active'
       AND g.status = 'approved'`,
    [Number(serverId)]
  );
  const policies = [normalized];
  for (const row of (Array.isArray(result) ? result : result.rows || [])) {
    const enabled = row.enabled === true || row.enabled === 1 || row.enabled === '1' || row.enabled === 't';
    if (enabled) policies.push(parseLinkSettings(row.config));
  }
  const assigned = new Set(policies.flatMap(policy => policy.roles.assignOnLink));
  const removed = new Set(policies.flatMap(policy => policy.roles.removeOnLink));
  const conflicts = [...assigned].filter(roleId => removed.has(roleId));
  if (conflicts.length) {
    const error = new Error(`Contradictory guild-wide link role rules for: ${conflicts.join(', ')}`);
    error.code = 'CONTRADICTORY_LINK_ROLE_RULES';
    throw error;
  }
  return normalized;
}

async function saveLinkSettings(db, serverId, settings, options = {}) {
  if (!Number.isInteger(Number(serverId)) || Number(serverId) <= 0) {
    throw new Error('A valid server ID is required for link settings');
  }
  const runRoleJob = options.runRoleJob
    || require('../../utils/linkRoleReconciler').runRoleReconciliationJob;
  const client = typeof db.connect === 'function' ? await db.connect() : db;
  const ownsTransaction = client !== db;
  let clientReleased = false;
  let roleJobs = [];
  try {
    if (ownsTransaction) await client.query('BEGIN');
    const normalized = await validateGuildRoleSettings(client, serverId, settings);
    const previousResult = await client.query(
      `SELECT config FROM server_features
       WHERE server_id = $1 AND feature_name = 'player_linking' LIMIT 1`,
      [Number(serverId)]
    );
    const previousRows = Array.isArray(previousResult) ? previousResult : previousResult.rows || [];
    const previous = parseLinkSettings(previousRows[0]?.config);
    const managedRoleIds = [...new Set([
      ...previous.roles.assignOnLink,
      ...normalized.roles.assignOnLink,
    ])];
    if (managedRoleIds.length) {
      await client.query(
        `INSERT INTO discord_link_role_policy_history (server_id, role_id, last_managed_at)
         SELECT $1, role_id, NOW() FROM UNNEST($2::TEXT[]) AS role_id
         ON CONFLICT (server_id, role_id) DO UPDATE SET last_managed_at = NOW()`,
        [Number(serverId), managedRoleIds]
      );
    }
    await client.query(
      `INSERT INTO server_features (server_id, feature_name, enabled, config, updated_at)
       VALUES ($1, 'player_linking', 1, $2, NOW())
       ON CONFLICT (server_id, feature_name) DO UPDATE SET
         enabled = 1,
         config = EXCLUDED.config,
         updated_at = NOW()`,
      [Number(serverId), JSON.stringify(normalized)]
    );
    const roleJobsResult = await client.query(
      `INSERT INTO discord_role_reconciliation_jobs
         (discord_guild_id, discord_user_id, user_id, status, attempts, next_attempt_at,
          last_error, completed_at, locked_at, updated_at, generation)
       SELECT DISTINCT g.discord_guild_id, u.discord_id, spm.user_id, 'pending', 0, NOW(),
              NULL::TEXT, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, NOW(), 1
       FROM server_player_memberships spm
       JOIN servers member_server ON member_server.id = spm.server_id
       JOIN servers changed_server ON changed_server.id = $1
       JOIN guilds g ON g.id = member_server.guild_id
       JOIN users u ON u.id = spm.user_id
       WHERE member_server.guild_id = changed_server.guild_id
         AND spm.status = 'active'
         AND u.discord_id IS NOT NULL
       ON CONFLICT (discord_guild_id, discord_user_id, user_id) DO UPDATE SET
         status = 'pending', attempts = 0, next_attempt_at = NOW(),
         last_error = NULL, completed_at = NULL, locked_at = NULL, updated_at = NOW(),
         generation = discord_role_reconciliation_jobs.generation + 1
       RETURNING *`,
      [Number(serverId)]
    );
    roleJobs = Array.isArray(roleJobsResult) ? roleJobsResult : roleJobsResult.rows || [];
    if (ownsTransaction) {
      await client.query('COMMIT');
      client.release();
      clientReleased = true;
    }
    for (const job of roleJobs) {
      try {
        await runRoleJob({ db, job });
      } catch (error) {
        console.warn(`⚠️ Link settings saved, but Discord role reconciliation remains queued: ${error.message}`);
      }
    }
    return normalized;
  } catch (error) {
    if (ownsTransaction) await client.query('ROLLBACK');
    throw error;
  } finally {
    if (ownsTransaction && !clientReleased) client.release();
  }
}

async function mutateBotLinkSettings(db, options) {
  const serverId = Number(options.serverId);
  if (!Number.isInteger(serverId) || serverId <= 0) {
    throw new Error('A valid server ID is required for link settings');
  }
  if (typeof options.resolveNativePermissions !== 'function') {
    throw new Error('Current Discord permissions resolver is required');
  }
  const actor = options.actor || {};
  const client = await db.connect();
  let committed = false;
  let roleJobs = [];
  try {
    await client.query('BEGIN');
    const existingActor = await client.query(
      'SELECT id FROM users WHERE discord_id = $1',
      [String(actor.discordId)]
    );
    if (existingActor.rows[0]) {
      await client.query(
        'SELECT pg_advisory_xact_lock($1, $2)',
        [ACTOR_ROLE_LOCK_NAMESPACE, Number(existingActor.rows[0].id)]
      );
    }
    const actorResult = await client.query(
      `INSERT INTO users (discord_id, username, avatar)
       VALUES ($1, $2, $3)
       ON CONFLICT (discord_id) DO UPDATE SET
         username = EXCLUDED.username,
         avatar = EXCLUDED.avatar
       RETURNING id`,
      [String(actor.discordId), actor.username || null, actor.avatar || null]
    );
    const actorUserId = actorResult.rows[0].id;
    if (!existingActor.rows[0]) {
      await client.query(
        'SELECT pg_advisory_xact_lock($1, $2)',
        [ACTOR_ROLE_LOCK_NAMESPACE, Number(actorUserId)]
      );
    }
    const scopeResult = await client.query(
      `SELECT s.id AS server_id, s.guild_id
         FROM servers s
         JOIN guilds g ON g.id = s.guild_id
        WHERE s.id = $1
          AND g.discord_guild_id = $2
          AND s.status = 'active'
          AND g.status = 'approved'
        FOR UPDATE OF s, g`,
      [serverId, String(options.discordGuildId)]
    );
    const scope = scopeResult.rows[0];
    if (!scope) {
      const error = new Error('Server scope changed');
      error.code = 'AUTHORITY_REVOKED';
      throw error;
    }
    await client.query(
      'SELECT pg_advisory_xact_lock($1, $2)',
      [LINK_POLICY_LOCK_NAMESPACE, Number(scope.guild_id)]
    );

    const nativePermissions = await options.resolveNativePermissions();
    const guildRoleResult = await client.query(
      'SELECT role FROM guild_roles WHERE guild_id = $1 AND user_id = $2 FOR UPDATE',
      [scope.guild_id, actorUserId]
    );
    const serverRoleResult = await client.query(
      `SELECT role, status FROM server_role_assignments
        WHERE server_id = $1 AND guild_id = $2 AND user_id = $3 FOR UPDATE`,
      [serverId, scope.guild_id, actorUserId]
    );
    const guildOperator = ['owner', 'admin'].includes(guildRoleResult.rows[0]?.role);
    const serverAdmin = serverRoleResult.rows[0]?.status === 'active'
      && serverRoleResult.rows[0]?.role === 'admin';
    if (!nativePermissions.administrator && !guildOperator && !serverAdmin) {
      const error = new Error('Settings authority changed');
      error.code = 'AUTHORITY_REVOKED';
      throw error;
    }
    if (options.change?.type === 'role' && !nativePermissions.manageRoles) {
      const error = new Error('Discord Manage Roles permission changed');
      error.code = 'DISCORD_PERMISSION_REVOKED';
      throw error;
    }

    const currentResult = await client.query(
      `SELECT enabled, config FROM server_features
        WHERE server_id = $1 AND feature_name = 'player_linking'
        FOR UPDATE`,
      [serverId]
    );
    const currentRow = currentResult.rows[0];
    const enabled = currentRow?.enabled === true || currentRow?.enabled === 1
      || currentRow?.enabled === '1' || currentRow?.enabled === 't';
    const next = parseLinkSettings(enabled ? currentRow.config : null);
    const change = options.change || {};
    if (change.type === 'verification') {
      if (!VERIFICATION_MODES.has(change.mode)) {
        const error = new Error('Unsupported verification mode');
        error.code = 'INVALID_LINK_SETTING';
        throw error;
      }
      next.verificationMode = change.mode;
    } else if (change.type === 'role') {
      if (!ROLE_KEYS.has(change.roleKey) || !/^\d{17,20}$/.test(String(change.roleId))) {
        const error = new Error('Unsupported role setting');
        error.code = 'INVALID_LINK_SETTING';
        throw error;
      }
      const roles = new Set(next.roles[change.roleKey]);
      if (change.operation === 'add') roles.add(String(change.roleId));
      else if (change.operation === 'remove') roles.delete(String(change.roleId));
      else {
        const error = new Error('Unsupported role operation');
        error.code = 'INVALID_LINK_SETTING';
        throw error;
      }
      next.roles[change.roleKey] = [...roles];
    } else {
      const error = new Error('Unsupported settings change');
      error.code = 'INVALID_LINK_SETTING';
      throw error;
    }

    const normalized = await validateGuildRoleSettings(client, serverId, next);
    const previous = parseLinkSettings(enabled ? currentRow.config : null);
    const managedRoleIds = [...new Set([
      ...previous.roles.assignOnLink,
      ...normalized.roles.assignOnLink,
    ])];
    if (managedRoleIds.length) {
      await client.query(
        `INSERT INTO discord_link_role_policy_history (server_id, role_id, last_managed_at)
         SELECT $1, role_id, NOW() FROM UNNEST($2::TEXT[]) AS role_id
         ON CONFLICT (server_id, role_id) DO UPDATE SET last_managed_at = NOW()`,
        [serverId, managedRoleIds]
      );
    }
    await client.query(
      `INSERT INTO server_features (server_id, feature_name, enabled, config, updated_at)
       VALUES ($1, 'player_linking', 1, $2, NOW())
       ON CONFLICT (server_id, feature_name) DO UPDATE SET
         enabled = 1, config = EXCLUDED.config, updated_at = NOW()`,
      [serverId, JSON.stringify(normalized)]
    );
    await client.query(
      `INSERT INTO security_audit_events
        (actor_user_id, guild_id, server_id, action, result, target_type, target_id, metadata)
       VALUES ($1, $2, $3, 'player_link.settings_changed', 'allowed', 'server', $4, $5::JSONB)`,
      [actorUserId, scope.guild_id, serverId, String(serverId), JSON.stringify({
        source: 'discord_bot',
        change,
      })]
    );
    const jobsResult = await client.query(
      `INSERT INTO discord_role_reconciliation_jobs
         (discord_guild_id, discord_user_id, user_id, status, attempts, next_attempt_at,
          last_error, completed_at, locked_at, updated_at, generation)
       SELECT DISTINCT g.discord_guild_id, u.discord_id, spm.user_id, 'pending', 0, NOW(),
              NULL::TEXT, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ, NOW(), 1
       FROM server_player_memberships spm
       JOIN servers member_server ON member_server.id = spm.server_id
       JOIN servers changed_server ON changed_server.id = $1
       JOIN guilds g ON g.id = member_server.guild_id
       JOIN users u ON u.id = spm.user_id
       WHERE member_server.guild_id = changed_server.guild_id
         AND spm.status = 'active'
         AND u.discord_id IS NOT NULL
       ON CONFLICT (discord_guild_id, discord_user_id, user_id) DO UPDATE SET
         status = 'pending', attempts = 0, next_attempt_at = NOW(),
         last_error = NULL, completed_at = NULL, locked_at = NULL, updated_at = NOW(),
         generation = discord_role_reconciliation_jobs.generation + 1
       RETURNING *`,
      [serverId]
    );
    roleJobs = jobsResult.rows || [];
    await client.query('COMMIT');
    committed = true;

    const runRoleJob = options.runRoleJob
      || require('../../utils/linkRoleReconciler').runRoleReconciliationJob;
    for (const job of roleJobs) {
      try {
        await runRoleJob({ db, job });
      } catch (error) {
        console.warn(`⚠️ Link settings saved, but Discord role reconciliation remains queued: ${error.message}`);
      }
    }
    return normalized;
  } catch (error) {
    if (!committed) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  DEFAULT_LINK_SETTINGS,
  parseLinkSettings,
  getLinkSettings,
  validateGuildRoleSettings,
  saveLinkSettings,
  mutateBotLinkSettings,
};
