'use strict';

function normalizeRoleIds(value) {
  return Array.isArray(value) ? [...new Set(value.map(String).filter(Boolean))] : [];
}

function normalizePolicy(policy) {
  const roles = policy?.roles || {};
  const enabled = policy?.enabled !== false;
  const membershipActive = policy?.active === true;
  return {
    enabled,
    membershipActive,
    active: enabled && membershipActive,
    managedRoleIds: normalizeRoleIds(policy?.managedRoleIds),
    roles: {
      assignOnLink: normalizeRoleIds(roles.assignOnLink),
      removeOnLink: normalizeRoleIds(roles.removeOnLink),
      removeOnLeave: normalizeRoleIds(roles.removeOnLeave),
    },
  };
}

function computeRoleReconciliation(policies, currentRoleIds = []) {
  const normalized = (policies || []).map(normalizePolicy);
  const membershipActive = normalized.filter(policy => policy.membershipActive);
  const active = normalized.filter(policy => policy.active);
  const required = new Set();
  const assignmentManaged = new Set();
  const removable = new Set();

  for (const policy of normalized) {
    for (const roleId of policy.managedRoleIds) assignmentManaged.add(roleId);
    for (const roleId of policy.roles.assignOnLink) assignmentManaged.add(roleId);
  }
  for (const roleId of assignmentManaged) removable.add(roleId);
  for (const policy of normalized) {
    if (!policy.membershipActive) {
      for (const roleId of policy.roles.removeOnLeave) removable.add(roleId);
    }
  }
  for (const policy of membershipActive) {
    for (const roleId of policy.roles.removeOnLeave) {
      if (!assignmentManaged.has(roleId)) removable.delete(roleId);
    }
  }
  for (const policy of active) {
    for (const roleId of policy.roles.assignOnLink) required.add(roleId);
    for (const roleId of policy.roles.removeOnLink) removable.add(roleId);
  }

  const current = new Set((currentRoleIds || []).map(String));
  const add = new Set([...required].filter(roleId => !current.has(roleId)));
  const remove = new Set(
    [...removable].filter(roleId => current.has(roleId) && !required.has(roleId))
  );
  return { add, remove, required, managed: removable };
}

function parseConfig(config) {
  if (!config) return {};
  if (typeof config === 'object') return config;
  try {
    return JSON.parse(config);
  } catch {
    return {};
  }
}

function rowsFrom(result) {
  return Array.isArray(result) ? result : result?.rows || [];
}

async function loadRolePoliciesForUser(db, discordGuildId, userId) {
  const result = await db.query(
    `SELECT sf.enabled, sf.config,
            COALESCE(history.role_ids, ARRAY[]::TEXT[]) AS managed_role_ids,
            CASE WHEN spm.id IS NULL THEN FALSE ELSE TRUE END AS active
     FROM server_features sf
     JOIN servers s ON s.id = sf.server_id
     JOIN guilds g ON g.id = s.guild_id
     LEFT JOIN LATERAL (
       SELECT ARRAY_AGG(role_id) AS role_ids
       FROM discord_link_role_policy_history
       WHERE server_id = s.id
     ) history ON TRUE
     LEFT JOIN LATERAL (
       SELECT membership.id
       FROM server_player_memberships membership
       JOIN linked_accounts la
         ON la.id = membership.source_link_id
        AND la.identity_id = membership.identity_id
        AND la.user_id = membership.user_id
        AND la.verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')
       WHERE membership.server_id = s.id
         AND membership.guild_id = s.guild_id
         AND membership.user_id = $2
         AND membership.status = 'active'
         AND s.status = 'active'
         AND g.status = 'approved'
       LIMIT 1
     ) spm ON TRUE
     WHERE g.discord_guild_id = $1
       AND sf.feature_name = 'player_linking'`,
    [String(discordGuildId), userId]
  );
  return rowsFrom(result).map(row => ({
    enabled: row.enabled === true || row.enabled === 1 || row.enabled === '1' || row.enabled === 't',
    active: row.active === true || row.active === 1 || row.active === 't',
    managedRoleIds: row.managed_role_ids || [],
    roles: parseConfig(row.config).roles || {},
  }));
}

async function applyMemberRoleChanges(member, changes, reason) {
  if (!member?.roles) throw new Error('Discord member role manager is unavailable');
  let availableRoles = member.guild?.roles?.cache;
  if (typeof member.guild?.roles?.fetch === 'function') {
    const fetched = await member.guild.roles.fetch();
    if (fetched?.has) availableRoles = fetched;
  }
  const roleExists = roleId => !availableRoles?.has || availableRoles.has(roleId);
  const add = [...changes.add].filter(roleExists);
  const remove = [...changes.remove].filter(roleExists);
  if (add.length) await member.roles.add(add, reason);
  if (remove.length) await member.roles.remove(remove, reason);
}

async function applyRestRoleChanges(discordGuildId, discordUserId, changes, options = {}) {
  const token = options.botToken || process.env.DISCORD_BOT_TOKEN;
  const fetchImpl = options.fetchImpl || global.fetch;
  if (!token || typeof fetchImpl !== 'function') {
    throw new Error('Discord role reconciliation is unavailable');
  }
  const base = `https://discord.com/api/v10/guilds/${discordGuildId}/members/${discordUserId}/roles`;
  const headers = { Authorization: 'Bot ' + token };
  for (const roleId of changes.add) {
    const response = await fetchImpl(`${base}/${roleId}`, { method: 'PUT', headers });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      if (response.status === 404 && body.code === 10011) continue;
      throw new Error(`Discord role add failed (${response.status})`);
    }
  }
  for (const roleId of changes.remove) {
    const response = await fetchImpl(`${base}/${roleId}`, { method: 'DELETE', headers });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      if (response.status === 404 && body.code === 10011) continue;
      throw new Error(`Discord role removal failed (${response.status})`);
    }
  }
}

async function reconcileDiscordMemberRolesOnce({
  db,
  discordGuildId,
  discordUserId,
  userId,
  member = null,
  botToken,
  fetchImpl,
}) {
  if (!db || !discordGuildId || !discordUserId || !userId) {
    throw new Error('Exact guild and user context is required for role reconciliation');
  }
  const policies = await loadRolePoliciesForUser(db, discordGuildId, userId);
  let currentRoleIds;
  if (member) {
    currentRoleIds = member.roles?.cache ? [...member.roles.cache.keys()] : [];
  } else {
    const token = botToken || process.env.DISCORD_BOT_TOKEN;
    const request = fetchImpl || global.fetch;
    if (!token || typeof request !== 'function') throw new Error('Discord role reconciliation is unavailable');
    const response = await request(
      `https://discord.com/api/v10/guilds/${discordGuildId}/members/${discordUserId}`,
      { headers: { Authorization: ['Bot', token].join(' ') } }
    );
    if (response.status === 404) return { add: new Set(), remove: new Set() };
    if (!response.ok) throw new Error(`Discord member lookup failed (${response.status})`);
    const discordMember = await response.json();
    currentRoleIds = discordMember.roles || [];
  }

  const changes = computeRoleReconciliation(policies, currentRoleIds);
  if (member) {
    await applyMemberRoleChanges(member, changes, 'DayZ exact-server membership reconciliation');
  } else {
    await applyRestRoleChanges(discordGuildId, discordUserId, changes, { botToken, fetchImpl });
  }
  return changes;
}

async function retryRoleOperation(operation, maxAttempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function sqlForDb(db, sql) {
  if (typeof db?.run === 'function') return sql;
  let parameter = 0;
  return sql.replace(/\?/g, () => `$${++parameter}`);
}

async function queryRows(db, sql, params = []) {
  const result = await db.query(sqlForDb(db, sql), params);
  return rowsFrom(result);
}

async function enqueueRoleReconciliationJob(db, { discordGuildId, discordUserId, userId }) {
  if (!db || !discordGuildId || !discordUserId || !userId) {
    throw new Error('Exact guild and user context is required to enqueue role reconciliation');
  }
  const rows = await queryRows(db,
    `INSERT INTO discord_role_reconciliation_jobs
       (discord_guild_id, discord_user_id, user_id, status, attempts, next_attempt_at, last_error, completed_at, updated_at, generation)
     VALUES (?, ?, ?, 'pending', 0, NOW(), NULL, NULL, NOW(), 1)
     ON CONFLICT (discord_guild_id, discord_user_id, user_id) DO UPDATE SET
       status = 'pending',
       attempts = 0,
       next_attempt_at = NOW(),
       last_error = NULL,
       completed_at = NULL,
       updated_at = NOW(),
       generation = discord_role_reconciliation_jobs.generation + 1
     RETURNING *`,
    [String(discordGuildId), String(discordUserId), userId]
  );
  return rows[0] || null;
}

async function runRoleReconciliationJob({ db, job, member = null, botToken, fetchImpl, reconcile }) {
  if (!job?.id) throw new Error('A durable role reconciliation job is required');
  const operation = reconcile || reconcileDiscordMemberRoles;
  try {
    const result = await operation({
      db,
      discordGuildId: job.discord_guild_id,
      discordUserId: job.discord_user_id,
      userId: job.user_id,
      member,
      botToken,
      fetchImpl,
    });
    await queryRows(db,
      `UPDATE discord_role_reconciliation_jobs
       SET status = 'completed', completed_at = NOW(), locked_at = NULL,
           last_error = NULL, updated_at = NOW()
       WHERE id = ? AND generation = ?`,
      [job.id, job.generation]
    );
    return result;
  } catch (error) {
    await queryRows(db,
      `UPDATE discord_role_reconciliation_jobs
       SET status = 'pending', attempts = attempts + 1,
           next_attempt_at = NOW() + (LEAST(3600, POWER(2, attempts + 1)) * INTERVAL '1 second'),
           last_error = ?, locked_at = NULL, updated_at = NOW()
       WHERE id = ? AND generation = ?`,
      [String(error.message || error).slice(0, 2000), job.id, job.generation]
    );
    throw error;
  }
}

async function claimRoleReconciliationJob(db) {
  const rows = await queryRows(db,
    `UPDATE discord_role_reconciliation_jobs
     SET status = 'processing', locked_at = NOW(), updated_at = NOW()
     WHERE id = (
       SELECT id FROM discord_role_reconciliation_jobs
       WHERE (status = 'pending' AND next_attempt_at <= NOW())
          OR (status = 'processing' AND locked_at < NOW() - INTERVAL '5 minutes')
       ORDER BY next_attempt_at, id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING *`
  );
  return rows[0] || null;
}

async function drainRoleReconciliationJobs({ db, limit = 25, botToken, fetchImpl }) {
  const results = [];
  for (let index = 0; index < limit; index++) {
    const job = await claimRoleReconciliationJob(db);
    if (!job) break;
    try {
      await runRoleReconciliationJob({ db, job, botToken, fetchImpl });
      results.push({ id: job.id, status: 'completed' });
    } catch (error) {
      results.push({ id: job.id, status: 'pending', error });
    }
  }
  return results;
}

async function reconcileDiscordMemberRoles(options) {
  return retryRoleOperation(() => reconcileDiscordMemberRolesOnce(options), 3);
}

module.exports = {
  computeRoleReconciliation,
  loadRolePoliciesForUser,
  retryRoleOperation,
  enqueueRoleReconciliationJob,
  runRoleReconciliationJob,
  drainRoleReconciliationJobs,
  reconcileDiscordMemberRoles,
};
