'use strict';

const express = require('express');
const {
  canGrantRole,
  canRemoveRole,
  resolveActorAuthority,
} = require('../services/roleManagementService');
const { verifyDiscordGuildMembership } = require('../services/discordGuildMembershipService');
const { lockUserRoleMutations } = require('../utils/roleMutationLocks');

const router = express.Router();

function positiveId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function recordAudit(db, event) {
  await db.run(
    `INSERT INTO security_audit_events
      (actor_user_id, guild_id, server_id, action, result, target_type, target_id, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [event.actorUserId, event.guildId || null, event.serverId || null, event.action,
      event.result, event.targetType, String(event.targetId), JSON.stringify(event.metadata || {})]
  );
}

async function resolveScope(db, body, options = {}) {
  const serverId = positiveId(body.serverId);
  const requestedGuildId = body.guildId == null ? null : String(body.guildId);
  const lockClause = options.lockScope ? ' FOR UPDATE' : '';
  if (serverId) {
    const server = await db.get(
      `SELECT s.id, s.guild_id, s.name, g.discord_guild_id, g.name AS guild_name
         FROM servers s JOIN guilds g ON g.id = s.guild_id
        WHERE s.id = ? AND s.status = 'active' AND g.status = 'approved'${lockClause ? ' FOR UPDATE OF s, g' : ''}`,
      [serverId]
    );
    if (!server) return null;
    if (requestedGuildId && requestedGuildId !== String(server.guild_id) &&
        requestedGuildId !== String(server.discord_guild_id)) return null;
    return { serverId: server.id, guildId: server.guild_id, server };
  }
  if (!requestedGuildId) return {};
  const guild = await db.get(
    `SELECT id, discord_guild_id, name FROM guilds
      WHERE (CAST(id AS TEXT) = ? OR discord_guild_id = ?)
        AND status = 'approved'${lockClause}`,
    [requestedGuildId, requestedGuildId]
  );
  return guild ? { guildId: guild.id, guild } : null;
}

async function loadRoleAssignment(db, assignmentType, assignmentId, targetUserId, options = {}) {
  const lockClause = options.lock ? ' FOR UPDATE' : '';
  if (assignmentType === 'platform') {
    return db.get(
      `SELECT id, id AS user_id, NULL::integer AS guild_id, NULL::integer AS server_id,
              platform_role AS role
         FROM users
        WHERE id = ? AND id = ? AND platform_role = 'dashboard_admin'${lockClause}`,
      [assignmentId, targetUserId]
    );
  }
  if (assignmentType === 'guild') {
    const scopeClause = options.scope?.guildId == null ? '' : ' AND guild_id = ?';
    const params = [assignmentId, targetUserId];
    if (options.scope?.guildId != null) params.push(options.scope.guildId);
    return db.get(
      `SELECT id, user_id, guild_id, NULL::integer AS server_id,
              CASE role WHEN 'owner' THEN 'guild_owner' WHEN 'admin' THEN 'guild_admin' ELSE role END AS role
         FROM guild_roles
        WHERE id = ? AND user_id = ?${scopeClause}${lockClause}`,
      params
    );
  }

  const table = assignmentType === 'server' ? 'server_role_assignments' : 'server_player_memberships';
  const roleExpression = assignmentType === 'server'
    ? "CASE role WHEN 'admin' THEN 'server_admin' ELSE role END"
    : "'player'";
  const scopeClause = options.scope?.serverId == null
    ? ''
    : ' AND guild_id = ? AND server_id = ?';
  const params = [assignmentId, targetUserId];
  if (options.scope?.serverId != null) params.push(options.scope.guildId, options.scope.serverId);
  return db.get(
    `SELECT id, user_id, guild_id, server_id, ${roleExpression} AS role
       FROM ${table}
      WHERE id = ? AND user_id = ? AND status = 'active'${scopeClause}${lockClause}`,
    params
  );
}

async function targetHasScopeRelationship(db, target, scope, verifyMembership) {
  if (!scope.guildId) return true;
  const storedRelationship = await db.get(
    `SELECT 1
       FROM users u
      WHERE u.id = ? AND (
        EXISTS (SELECT 1 FROM guild_roles gr WHERE gr.user_id = u.id AND gr.guild_id = ?)
        OR EXISTS (SELECT 1 FROM server_role_assignments sra
                    WHERE sra.user_id = u.id AND sra.guild_id = ? AND sra.status = 'active')
        OR EXISTS (SELECT 1 FROM server_player_memberships spm
                    WHERE spm.user_id = u.id AND spm.guild_id = ? AND spm.status = 'active')
      )`,
    [target.id, scope.guildId, scope.guildId, scope.guildId]
  );
  if (storedRelationship) return true;

  const discordGuildId = scope.guild?.discord_guild_id || scope.server?.discord_guild_id;
  if (!discordGuildId || !target.discord_id) return false;
  return verifyMembership(String(discordGuildId), String(target.discord_id));
}

router.get('/context', async (req, res) => {
  const db = req.app.locals.db;
  try {
    const platformRole = req.user.platform_role || (req.user.is_admin ? 'dashboard_admin' : null);
    const global = platformRole === 'dashboard_owner' || platformRole === 'dashboard_admin';
    const scopes = await db.query(
      `SELECT DISTINCT g.id AS guild_id, g.discord_guild_id, g.name AS guild_name,
              s.id AS server_id, s.name AS server_name,
              gr.role AS guild_role, sra.role AS server_role
         FROM guilds g
         LEFT JOIN guild_roles gr ON gr.guild_id = g.id AND gr.user_id = ?
         LEFT JOIN servers s ON s.guild_id = g.id AND s.status = 'active'
         LEFT JOIN server_role_assignments sra
           ON sra.server_id = s.id AND sra.guild_id = g.id
          AND sra.user_id = ? AND sra.status = 'active'
        WHERE g.status = 'approved'
          AND (? = 1 OR gr.role IN ('owner', 'admin') OR sra.role = 'admin')
        ORDER BY g.name, s.name`,
      [req.user.id, req.user.id, global ? 1 : 0]
    );
    const availableGrants = [];
    if (platformRole === 'dashboard_owner') availableGrants.push({ role: 'dashboard_admin', scope: 'global' });
    for (const scope of scopes) {
      const authority = {
        userId: req.user.id,
        platformRole,
        guildId: scope.guild_id,
        guildRole: scope.guild_role,
        serverId: scope.server_id,
        serverRole: scope.server_role,
      };
      for (const role of ['guild_admin', 'server_admin', 'moderator', 'player']) {
        if (canGrantRole(authority, { role, guildId: scope.guild_id, serverId: scope.server_id, targetUserId: -1 })) {
          availableGrants.push({ role, guildId: scope.guild_id, serverId: scope.server_id || null });
        }
      }
    }
    return res.json({ actor: { id: req.user.id, platformRole }, scopes, availableGrants });
  } catch (error) {
    console.error('Failed to load role context:', error.message);
    return res.status(500).json({ error: 'Failed to load role context' });
  }
});

router.get('/users', async (req, res) => {
  const db = req.app.locals.db;
  const search = String(req.query.search || '').trim().toLowerCase();
  const status = String(req.query.status || 'authorized').toLowerCase();
  if (!['authorized', 'unassigned', 'all'].includes(status)) {
    return res.status(400).json({ error: 'Invalid user status filter' });
  }
  const global = Boolean(req.user.platform_role || req.user.is_admin);
  try {
    const users = await db.query(
      `WITH classified_users AS (
         SELECT u.id, u.discord_id, u.username, u.avatar, u.platform_role, u.is_admin,
                (u.platform_role IS NOT NULL OR u.is_admin = 1
                 OR EXISTS (SELECT 1 FROM guild_roles own_gr
                             JOIN guilds own_g ON own_g.id = own_gr.guild_id
                            WHERE own_gr.user_id = u.id AND own_g.status = 'approved')
                 OR EXISTS (SELECT 1 FROM server_role_assignments own_sra
                             JOIN servers own_s ON own_s.id = own_sra.server_id
                                                       AND own_s.guild_id = own_sra.guild_id
                             JOIN guilds own_sg ON own_sg.id = own_sra.guild_id
                            WHERE own_sra.user_id = u.id AND own_sra.status = 'active'
                              AND own_s.status = 'active' AND own_sg.status = 'approved')
                 OR EXISTS (SELECT 1 FROM server_player_memberships own_spm
                             JOIN servers own_ps ON own_ps.id = own_spm.server_id
                                                        AND own_ps.guild_id = own_spm.guild_id
                             JOIN guilds own_pg ON own_pg.id = own_spm.guild_id
                            WHERE own_spm.user_id = u.id AND own_spm.status = 'active'
                              AND own_ps.status = 'active' AND own_pg.status = 'approved')) AS has_access
           FROM users u
       )
       SELECT DISTINCT u.id, u.discord_id, u.username, u.avatar, u.platform_role, u.is_admin,
              u.has_access AS "hasAccess"
         FROM classified_users u
        WHERE ($1 = '' OR LOWER(COALESCE(u.username, '')) LIKE '%' || $1 || '%' OR u.discord_id = $1)
          AND ($4 = 'all' OR ($4 = 'authorized' AND u.has_access) OR ($4 = 'unassigned' AND NOT u.has_access))
          AND (
            $3 = 1
            OR EXISTS (
              SELECT 1 FROM guild_roles actor_gr
              JOIN guilds actor_g ON actor_g.id = actor_gr.guild_id AND actor_g.status = 'approved'
              WHERE actor_gr.user_id = $2 AND actor_gr.role IN ('owner', 'admin')
                AND (
                  EXISTS (SELECT 1 FROM guild_roles target_gr
                           WHERE target_gr.guild_id = actor_gr.guild_id AND target_gr.user_id = u.id)
                  OR EXISTS (SELECT 1 FROM server_role_assignments target_sra
                             JOIN servers target_s ON target_s.id = target_sra.server_id
                                                        AND target_s.guild_id = target_sra.guild_id
                                                        AND target_s.status = 'active'
                            WHERE target_sra.guild_id = actor_gr.guild_id
                              AND target_sra.user_id = u.id AND target_sra.status = 'active')
                  OR EXISTS (SELECT 1 FROM server_player_memberships target_spm
                             JOIN servers target_ps ON target_ps.id = target_spm.server_id
                                                         AND target_ps.guild_id = target_spm.guild_id
                                                         AND target_ps.status = 'active'
                            WHERE target_spm.guild_id = actor_gr.guild_id
                              AND target_spm.user_id = u.id AND target_spm.status = 'active')
                )
            )
            OR EXISTS (
              SELECT 1 FROM server_role_assignments actor_sra
              JOIN servers actor_s ON actor_s.id = actor_sra.server_id
                                          AND actor_s.guild_id = actor_sra.guild_id
                                          AND actor_s.status = 'active'
              JOIN guilds actor_sg ON actor_sg.id = actor_sra.guild_id AND actor_sg.status = 'approved'
              WHERE actor_sra.user_id = $2 AND actor_sra.role = 'admin' AND actor_sra.status = 'active'
                AND (
                  EXISTS (SELECT 1 FROM server_role_assignments target_sra
                           WHERE target_sra.server_id = actor_sra.server_id AND target_sra.user_id = u.id AND target_sra.status = 'active')
                  OR EXISTS (SELECT 1 FROM server_player_memberships target_spm
                             WHERE target_spm.server_id = actor_sra.server_id AND target_spm.user_id = u.id AND target_spm.status = 'active')
                )
            )
          )
        ORDER BY u.username ASC
        LIMIT 100`,
      [search, req.user.id, global ? 1 : 0, status]
    );
    return res.json({ users });
  } catch (error) {
    console.error('Failed to load role users:', error.message);
    return res.status(500).json({ error: 'Failed to load users' });
  }
});

router.get('/users/:userId', async (req, res) => {
  const db = req.app.locals.db;
  const targetUserId = positiveId(req.params.userId);
  if (!targetUserId) return res.status(404).json({ error: 'Not found' });
  try {
    const target = await db.get('SELECT id, discord_id, username, avatar, platform_role, is_admin FROM users WHERE id = ?', [targetUserId]);
    if (!target) return res.status(404).json({ error: 'Not found' });
    const global = Boolean(req.user.platform_role || req.user.is_admin);
    const sharedScope = global ? { allowed: 1 } : await db.get(
      `SELECT 1 AS allowed
         FROM users target
        WHERE target.id = ? AND (
          EXISTS (
            SELECT 1 FROM guild_roles actor_gr
            JOIN guilds actor_g ON actor_g.id = actor_gr.guild_id AND actor_g.status = 'approved'
            WHERE actor_gr.user_id = ? AND actor_gr.role IN ('owner', 'admin')
              AND (
                EXISTS (SELECT 1 FROM guild_roles target_gr WHERE target_gr.guild_id = actor_gr.guild_id AND target_gr.user_id = target.id)
                OR EXISTS (SELECT 1 FROM server_role_assignments target_sra
                           JOIN servers target_s ON target_s.id = target_sra.server_id AND target_s.guild_id = target_sra.guild_id AND target_s.status = 'active'
                           JOIN guilds target_sg ON target_sg.id = target_sra.guild_id AND target_sg.status = 'approved'
                          WHERE target_sra.guild_id = actor_gr.guild_id AND target_sra.user_id = target.id AND target_sra.status = 'active')
                OR EXISTS (SELECT 1 FROM server_player_memberships target_spm
                           JOIN servers target_ps ON target_ps.id = target_spm.server_id AND target_ps.guild_id = target_spm.guild_id AND target_ps.status = 'active'
                           JOIN guilds target_pg ON target_pg.id = target_spm.guild_id AND target_pg.status = 'approved'
                          WHERE target_spm.guild_id = actor_gr.guild_id AND target_spm.user_id = target.id AND target_spm.status = 'active')
              )
          )
          OR EXISTS (
            SELECT 1 FROM server_role_assignments actor_sra
            JOIN servers actor_s ON actor_s.id = actor_sra.server_id AND actor_s.guild_id = actor_sra.guild_id AND actor_s.status = 'active'
            JOIN guilds actor_sg ON actor_sg.id = actor_sra.guild_id AND actor_sg.status = 'approved'
            WHERE actor_sra.user_id = ? AND actor_sra.role = 'admin' AND actor_sra.status = 'active'
              AND (
                EXISTS (SELECT 1 FROM server_role_assignments target_sra WHERE target_sra.server_id = actor_sra.server_id AND target_sra.user_id = target.id AND target_sra.status = 'active')
                OR EXISTS (SELECT 1 FROM server_player_memberships target_spm WHERE target_spm.server_id = actor_sra.server_id AND target_spm.user_id = target.id AND target_spm.status = 'active')
              )
          )
        )`,
      [targetUserId, req.user.id, req.user.id]
    );
    const visible = Boolean(sharedScope);
    if (!visible) return res.status(404).json({ error: 'Not found' });

    const assignments = await db.query(
      `SELECT 'guild' AS assignment_type, gr.id, gr.user_id, gr.guild_id, NULL::integer AS server_id,
              CASE gr.role WHEN 'owner' THEN 'guild_owner' WHEN 'admin' THEN 'guild_admin' ELSE gr.role END AS role,
              gr.assigned_at AS granted_at, assigner.username AS granted_by,
              g.name AS scope_name
         FROM guild_roles gr JOIN guilds g ON g.id = gr.guild_id AND g.status = 'approved'
         LEFT JOIN users assigner ON assigner.id = gr.assigned_by
        WHERE gr.user_id = $1 AND ($3 = 1 OR EXISTS (
         SELECT 1 FROM guild_roles actor_gr
         JOIN guilds actor_g ON actor_g.id = actor_gr.guild_id AND actor_g.status = 'approved'
          WHERE actor_gr.user_id = $2 AND actor_gr.guild_id = gr.guild_id AND actor_gr.role IN ('owner', 'admin')
       ))
       UNION ALL
       SELECT 'server', sra.id, sra.user_id, sra.guild_id, sra.server_id,
              CASE sra.role WHEN 'admin' THEN 'server_admin' ELSE sra.role END,
              sra.created_at, assigner.username, s.name
         FROM server_role_assignments sra JOIN servers s ON s.id = sra.server_id AND s.guild_id = sra.guild_id AND s.status = 'active'
         JOIN guilds g ON g.id = sra.guild_id AND g.status = 'approved'
         LEFT JOIN users assigner ON assigner.id = sra.assigned_by_user_id
        WHERE sra.user_id = $1 AND sra.status = 'active' AND ($3 = 1
         OR EXISTS (SELECT 1 FROM guild_roles actor_gr JOIN guilds actor_g ON actor_g.id = actor_gr.guild_id AND actor_g.status = 'approved' WHERE actor_gr.user_id = $2 AND actor_gr.guild_id = sra.guild_id AND actor_gr.role IN ('owner', 'admin'))
         OR EXISTS (SELECT 1 FROM server_role_assignments actor_sra JOIN servers actor_s ON actor_s.id = actor_sra.server_id AND actor_s.guild_id = actor_sra.guild_id AND actor_s.status = 'active' JOIN guilds actor_sg ON actor_sg.id = actor_sra.guild_id AND actor_sg.status = 'approved' WHERE actor_sra.user_id = $2 AND actor_sra.server_id = sra.server_id AND actor_sra.role = 'admin' AND actor_sra.status = 'active'))
       UNION ALL
       SELECT 'player', spm.id, spm.user_id, spm.guild_id, spm.server_id, 'player',
              spm.created_at, verifier.username, s.name
         FROM server_player_memberships spm JOIN servers s ON s.id = spm.server_id AND s.guild_id = spm.guild_id AND s.status = 'active'
         JOIN guilds g ON g.id = spm.guild_id AND g.status = 'approved'
         LEFT JOIN users verifier ON verifier.id = spm.verified_by_user_id
        WHERE spm.user_id = $1 AND spm.status = 'active' AND ($3 = 1
         OR EXISTS (SELECT 1 FROM guild_roles actor_gr JOIN guilds actor_g ON actor_g.id = actor_gr.guild_id AND actor_g.status = 'approved' WHERE actor_gr.user_id = $2 AND actor_gr.guild_id = spm.guild_id AND actor_gr.role IN ('owner', 'admin'))
         OR EXISTS (SELECT 1 FROM server_role_assignments actor_sra JOIN servers actor_s ON actor_s.id = actor_sra.server_id AND actor_s.guild_id = actor_sra.guild_id AND actor_s.status = 'active' JOIN guilds actor_sg ON actor_sg.id = actor_sra.guild_id AND actor_sg.status = 'approved' WHERE actor_sra.user_id = $2 AND actor_sra.server_id = spm.server_id AND actor_sra.role = 'admin' AND actor_sra.status = 'active'))
       ORDER BY granted_at DESC`,
      [targetUserId, req.user.id, global ? 1 : 0]
    );
    if (global && (target.platform_role || target.is_admin)) assignments.unshift({
      assignment_type: 'platform', id: target.id, user_id: target.id,
      role: target.platform_role || 'dashboard_admin', scope_name: 'Global',
    });
    return res.json({ user: target, assignments });
  } catch (error) {
    console.error('Failed to load user roles:', error.message);
    return res.status(500).json({ error: 'Failed to load roles' });
  }
});

router.post('/users/:userId', async (req, res) => {
  const db = req.app.locals.db;
  const targetUserId = positiveId(req.params.userId);
  const role = String(req.body.role || '').toLowerCase();
  if (!targetUserId) return res.status(404).json({ error: 'Not found' });
  try {
    await db.transaction(async transactionDb => {
      await lockUserRoleMutations(transactionDb, [req.user.id, targetUserId]);
      const scope = await resolveScope(transactionDb, req.body, { lockScope: true });
      if (!scope) { const error = new Error('Not found'); error.code = 'NOT_FOUND'; throw error; }
      const actor = await resolveActorAuthority(transactionDb, req.user, scope, { lockAuthority: true });
      const request = { role, targetUserId, guildId: scope.guildId, serverId: scope.serverId };
      if (!canGrantRole(actor, request)) {
        const error = new Error('Role grant not permitted'); error.code = 'FORBIDDEN'; throw error;
      }
      const target = await transactionDb.get('SELECT id, discord_id FROM users WHERE id = ?', [targetUserId]);
      const membershipVerifier = req.app.locals.verifyDiscordGuildMembership || verifyDiscordGuildMembership;
      if (!target || (!(role.startsWith('dashboard_')) &&
          !await targetHasScopeRelationship(transactionDb, target, scope, membershipVerifier))) {
        const error = new Error('Not found'); error.code = 'NOT_FOUND'; throw error;
      }

      if (role === 'dashboard_admin') {
        await transactionDb.run("UPDATE users SET platform_role = 'dashboard_admin', is_admin = 1 WHERE id = ?", [targetUserId]);
      } else if (role === 'guild_admin') {
        const existing = await transactionDb.get(
          'SELECT role FROM guild_roles WHERE guild_id = ? AND user_id = ? FOR UPDATE',
          [scope.guildId, targetUserId]
        );
        if (existing) {
          const error = new Error(existing.role === 'owner'
            ? 'Ownership cannot be replaced by a role grant' : 'Role is already assigned');
          error.code = 'ROLE_CONFLICT';
          throw error;
        }
        await transactionDb.run(
          `INSERT INTO guild_roles (guild_id, user_id, role, assigned_by)
           VALUES (?, ?, 'admin', ?)`,
          [scope.guildId, targetUserId, req.user.id]
        );
      } else if (role === 'server_admin' || role === 'moderator') {
        const existing = await transactionDb.get(
          `SELECT role FROM server_role_assignments
            WHERE server_id = ? AND user_id = ? AND status = 'active' FOR UPDATE`,
          [scope.serverId, targetUserId]
        );
        if (existing) {
          const error = new Error(existing.role === (role === 'server_admin' ? 'admin' : role)
            ? 'Role is already assigned' : 'Remove the existing server role before assigning a different role');
          error.code = 'ROLE_CONFLICT';
          throw error;
        }
        await transactionDb.run(
          `INSERT INTO server_role_assignments
             (server_id, guild_id, user_id, role, status, assigned_by_user_id, updated_at)
           VALUES (?, ?, ?, ?, 'active', ?, CURRENT_TIMESTAMP)
           ON CONFLICT (server_id, user_id) DO UPDATE SET
             guild_id = EXCLUDED.guild_id, role = EXCLUDED.role, status = 'active',
             assigned_by_user_id = EXCLUDED.assigned_by_user_id, updated_at = CURRENT_TIMESTAMP`,
          [scope.serverId, scope.guildId, targetUserId, role === 'server_admin' ? 'admin' : role, req.user.id]
        );
      } else if (role === 'player') {
        const identityId = positiveId(req.body.identityId);
        const link = identityId && await transactionDb.get(
          `SELECT la.id
             FROM linked_accounts la
             JOIN player_server_activity psa ON psa.identity_id = la.identity_id AND psa.server_id = ?
            WHERE la.user_id = ? AND la.identity_id = ?
              AND la.verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')
            FOR UPDATE OF la`,
          [scope.serverId, targetUserId, identityId]
        );
        if (!link) { const error = new Error('Player identity not eligible'); error.code = 'NOT_ELIGIBLE'; throw error; }
        await transactionDb.run(
          `INSERT INTO server_player_memberships
             (server_id, guild_id, identity_id, user_id, source_link_id, status,
              verification_method, verified_by_user_id, updated_at)
           VALUES (?, ?, ?, ?, ?, 'active', 'admin_approved', ?, CURRENT_TIMESTAMP)
           ON CONFLICT (server_id, identity_id) DO UPDATE SET
             user_id = EXCLUDED.user_id, source_link_id = EXCLUDED.source_link_id,
             status = 'active', verification_method = 'admin_approved',
             verified_by_user_id = EXCLUDED.verified_by_user_id, updated_at = CURRENT_TIMESTAMP`,
          [scope.serverId, scope.guildId, identityId, targetUserId, link.id, req.user.id]
        );
      } else {
        const error = new Error('Unsupported role'); error.code = 'INVALID_ROLE'; throw error;
      }
      await recordAudit(transactionDb, {
        actorUserId: req.user.id, guildId: scope.guildId, serverId: scope.serverId,
        action: 'role.granted', result: 'allowed', targetType: 'user', targetId: targetUserId,
        metadata: { role },
      });
    });
    return res.status(201).json({ success: true });
  } catch (error) {
    if (error.code === 'NOT_FOUND') return res.status(404).json({ error: 'Not found' });
    if (error.code === 'FORBIDDEN') return res.status(403).json({ error: 'Role grant not permitted' });
    if (error.code === 'DISCORD_MEMBERSHIP_UNAVAILABLE') {
      return res.status(503).json({ error: 'Discord membership verification is temporarily unavailable' });
    }
    if (error.code === 'NOT_ELIGIBLE' || error.code === 'INVALID_ROLE') return res.status(400).json({ error: error.message });
    if (error.code === 'ROLE_CONFLICT' || error.code === '23505') return res.status(409).json({ error: error.message });
    console.error('Failed to grant role:', error.message);
    return res.status(500).json({ error: 'Failed to grant role' });
  }
});

router.delete('/users/:userId', async (req, res) => {
  const db = req.app.locals.db;
  const targetUserId = positiveId(req.params.userId);
  if (!targetUserId) return res.status(404).json({ error: 'Not found' });

  try {
    await db.transaction(async transactionDb => {
      await lockUserRoleMutations(transactionDb, [req.user.id, targetUserId]);
      const actor = await resolveActorAuthority(transactionDb, req.user, {}, { lockAuthority: true });
      if (actor?.platformRole !== 'dashboard_owner' || Number(actor.userId) === targetUserId) {
        const error = new Error('User removal not permitted');
        error.code = 'FORBIDDEN';
        throw error;
      }

      const target = await transactionDb.get(
        `SELECT id, discord_id, username, platform_role, is_admin
           FROM users
          WHERE id = ?
          FOR UPDATE`,
        [targetUserId]
      );
      if (!target) {
        const error = new Error('Not found');
        error.code = 'NOT_FOUND';
        throw error;
      }
      if (target.platform_role === 'dashboard_owner') {
        const error = new Error('Dashboard Owner cannot be removed');
        error.code = 'PROTECTED_OWNER';
        throw error;
      }

      const targetGuildRoles = await transactionDb.query(
        `SELECT guild_id, role
           FROM guild_roles
          WHERE user_id = ?
          ORDER BY guild_id, id
          FOR UPDATE`,
        [targetUserId]
      );
      const ownedGuild = targetGuildRoles.find(assignment => assignment.role === 'owner');
      if (ownedGuild) {
        const error = new Error('Transfer guild ownership before removing this user');
        error.code = 'GUILD_OWNER';
        throw error;
      }

      await transactionDb.run(
        `DELETE FROM session
          WHERE sess::jsonb #>> '{passport,user}' = ?`,
        [String(target.discord_id)]
      );
      await transactionDb.run(
        `DELETE FROM sessions
          WHERE sess::jsonb #>> '{passport,user}' = ?`,
        [String(target.discord_id)]
      );

      await recordAudit(transactionDb, {
        actorUserId: actor.userId,
        action: 'user.kicked',
        result: 'allowed',
        targetType: 'user',
        targetId: targetUserId,
        metadata: { removedPlatformRole: target.platform_role || null },
      });

      const result = await transactionDb.run(
        `DELETE FROM users
          WHERE id = ? AND platform_role IS DISTINCT FROM 'dashboard_owner'`,
        [targetUserId]
      );
      if (!result?.changes) {
        const error = new Error('User changed during removal');
        error.code = 'ROLE_CONFLICT';
        throw error;
      }
    });
    return res.status(204).end();
  } catch (error) {
    if (error.code === 'NOT_FOUND') return res.status(404).json({ error: 'Not found' });
    if (error.code === 'FORBIDDEN') return res.status(403).json({ error: 'User removal not permitted' });
    if (['PROTECTED_OWNER', 'GUILD_OWNER', 'ROLE_CONFLICT', '23503'].includes(error.code)) {
      return res.status(409).json({ error: error.message });
    }
    console.error('Failed to remove dashboard user:', error.message);
    return res.status(500).json({ error: 'Failed to remove dashboard user' });
  }
});

router.delete('/users/:userId/roles/:assignmentId', async (req, res) => {
  const db = req.app.locals.db;
  const targetUserId = positiveId(req.params.userId);
  const assignmentId = positiveId(req.params.assignmentId);
  const assignmentType = String(req.body.assignmentType || '');
  if (!targetUserId || !assignmentId || !['platform', 'guild', 'server', 'player'].includes(assignmentType)) {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    await db.transaction(async transactionDb => {
      await lockUserRoleMutations(transactionDb, [req.user.id, targetUserId]);
      let assignment = await loadRoleAssignment(
        transactionDb,
        assignmentType,
        assignmentId,
        targetUserId
      );
      if (!assignment) { const error = new Error('Not found'); error.code = 'NOT_FOUND'; throw error; }

      const scope = await resolveScope(transactionDb, {
        guildId: assignment.guild_id,
        serverId: assignment.server_id,
      }, { lockScope: true });
      if (!scope) { const error = new Error('Not found'); error.code = 'NOT_FOUND'; throw error; }

      assignment = await loadRoleAssignment(
        transactionDb,
        assignmentType,
        assignmentId,
        targetUserId,
        { lock: true, scope }
      );
      if (!assignment) { const error = new Error('Not found'); error.code = 'NOT_FOUND'; throw error; }

      const actor = await resolveActorAuthority(transactionDb, req.user, scope, { lockAuthority: true });
      if (!canRemoveRole(actor, {
        role: assignment.role,
        targetUserId: assignment.user_id,
        guildId: assignment.guild_id,
        serverId: assignment.server_id,
      })) {
        const error = new Error('Role removal not permitted');
        error.code = 'FORBIDDEN';
        throw error;
      }

      let result;
      if (assignmentType === 'platform') {
        result = await transactionDb.run(
          "UPDATE users SET platform_role = NULL, is_admin = 0 WHERE id = ? AND platform_role = 'dashboard_admin'",
          [targetUserId]
        );
      } else if (assignmentType === 'guild') {
        const administrators = await transactionDb.query(
          "SELECT id FROM guild_roles WHERE guild_id = ? AND role IN ('owner', 'admin') FOR UPDATE",
          [assignment.guild_id]
        );
        if (administrators.length <= 1) {
          const error = new Error('Cannot remove the final guild owner or administrator');
          error.code = 'LAST_GUILD_ADMIN';
          throw error;
        }
        result = await transactionDb.run(
          "DELETE FROM guild_roles WHERE id = ? AND user_id = ? AND guild_id = ? AND role = 'admin'",
          [assignmentId, targetUserId, assignment.guild_id]
        );
      } else if (assignmentType === 'server') {
        result = await transactionDb.run(
          `UPDATE server_role_assignments SET status = 'revoked', updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND user_id = ? AND guild_id = ? AND server_id = ? AND role = ? AND status = 'active'`,
          [assignmentId, targetUserId, assignment.guild_id, assignment.server_id,
            assignment.role === 'server_admin' ? 'admin' : assignment.role]
        );
      } else if (assignmentType === 'player') {
        result = await transactionDb.run(
          `UPDATE server_player_memberships SET status = 'revoked', updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND user_id = ? AND guild_id = ? AND server_id = ? AND status = 'active'`,
          [assignmentId, targetUserId, assignment.guild_id, assignment.server_id]
        );
      }
      if (!result?.changes) { const error = new Error('Not found'); error.code = 'NOT_FOUND'; throw error; }
      await recordAudit(transactionDb, {
        actorUserId: req.user.id, guildId: assignment.guild_id, serverId: assignment.server_id,
        action: 'role.removed', result: 'allowed', targetType: 'user', targetId: targetUserId,
        metadata: { role: assignment.role, assignmentType },
      });
    });
    return res.status(204).end();
  } catch (error) {
    if (error.code === 'NOT_FOUND') return res.status(404).json({ error: 'Not found' });
    if (error.code === 'FORBIDDEN') return res.status(403).json({ error: 'Role removal not permitted' });
    if (error.code === 'LAST_GUILD_ADMIN') return res.status(409).json({ error: error.message });
    console.error('Failed to remove role:', error.message);
    return res.status(500).json({ error: 'Failed to remove role' });
  }
});

router.post('/guilds/:guildId/transfer-owner', async (req, res) => {
  const db = req.app.locals.db;
  const targetUserId = positiveId(req.body.targetUserId);
  if (!targetUserId) return res.status(404).json({ error: 'Not found' });
  try {
    await db.transaction(async transactionDb => {
      await lockUserRoleMutations(transactionDb, [req.user.id, targetUserId]);
      const scope = await resolveScope(transactionDb, { guildId: req.params.guildId }, { lockScope: true });
      if (!scope) { const error = new Error('Not found'); error.code = 'NOT_FOUND'; throw error; }
      const owners = await transactionDb.query(
        "SELECT id, user_id FROM guild_roles WHERE guild_id = ? AND role = 'owner' FOR UPDATE",
        [scope.guildId]
      );
      if (owners.length !== 1) { const error = new Error('Ownership reconciliation required'); error.code = 'AMBIGUOUS_OWNER'; throw error; }
      const actor = await resolveActorAuthority(transactionDb, req.user, scope, { lockAuthority: true });
      if (!(actor?.platformRole === 'dashboard_owner' || actor?.guildRole === 'owner')) {
        const error = new Error('Ownership transfer not permitted'); error.code = 'FORBIDDEN'; throw error;
      }
      const targetAdministrator = await transactionDb.get(
        "SELECT id FROM guild_roles WHERE guild_id = ? AND user_id = ? AND role = 'admin' FOR UPDATE",
        [scope.guildId, targetUserId]
      );
      if (!targetAdministrator) {
        const error = new Error('Target must already be an administrator of this guild'); error.code = 'NOT_ELIGIBLE'; throw error;
      }
      const previousOwnerId = owners[0].user_id;
      if (previousOwnerId === targetUserId) {
        const error = new Error('Target is already the guild owner'); error.code = 'ROLE_CONFLICT'; throw error;
      }
      if (req.body.retainPreviousAsAdmin === false) {
        await transactionDb.run('DELETE FROM guild_roles WHERE guild_id = ? AND user_id = ?', [scope.guildId, previousOwnerId]);
      } else {
        await transactionDb.run("UPDATE guild_roles SET role = 'admin' WHERE guild_id = ? AND user_id = ?", [scope.guildId, previousOwnerId]);
      }
      await transactionDb.run(
        `INSERT INTO guild_roles (guild_id, user_id, role, assigned_by)
         VALUES (?, ?, 'owner', ?)
         ON CONFLICT (guild_id, user_id) DO UPDATE SET role = 'owner', assigned_by = EXCLUDED.assigned_by, assigned_at = CURRENT_TIMESTAMP`,
        [scope.guildId, targetUserId, req.user.id]
      );
      await recordAudit(transactionDb, {
        actorUserId: req.user.id, guildId: scope.guildId, action: 'guild_owner.transferred',
        result: 'allowed', targetType: 'user', targetId: targetUserId,
        metadata: { previousOwnerId, retainedAsAdmin: req.body.retainPreviousAsAdmin !== false },
      });
    });
    return res.json({ success: true });
  } catch (error) {
    if (error.code === 'AMBIGUOUS_OWNER' || error.code === 'ROLE_CONFLICT' || error.code === '23505') {
      return res.status(409).json({ error: error.message });
    }
    if (error.code === 'NOT_FOUND') return res.status(404).json({ error: 'Not found' });
    if (error.code === 'FORBIDDEN') return res.status(403).json({ error: 'Ownership transfer not permitted' });
    if (error.code === 'NOT_ELIGIBLE') return res.status(400).json({ error: error.message });
    console.error('Failed to transfer ownership:', error.message);
    return res.status(500).json({ error: 'Failed to transfer ownership' });
  }
});

module.exports = router;
