'use strict';

const express = require('express');
const {
  CAPABILITIES,
  requireServerCapability,
} = require('../middleware/serverAccess');
const { lockUserRoleMutations } = require('../utils/roleMutationLocks');

const router = express.Router();
const requireServerManage = requireServerCapability(CAPABILITIES.GUILD_MANAGE);

async function lockActiveServerTenant(db, serverId, guildId) {
  return db.get(
    `SELECT s.id, s.guild_id
       FROM guilds g
       JOIN servers s ON s.guild_id = g.id
      WHERE g.id = ? AND s.id = ?
        AND g.status = 'approved' AND s.status = 'active'
      FOR UPDATE OF g, s`,
    [guildId, serverId]
  );
}

async function hasLockedServerManageAuthority(db, actorUserId, serverId, guildId) {
  const actor = await db.get(
    'SELECT id FROM users WHERE id = ? FOR UPDATE',
    [actorUserId]
  );
  if (!actor) return false;
  const guildRole = await db.get(
    `SELECT role FROM guild_roles
      WHERE guild_id = ? AND user_id = ? AND role IN ('owner', 'admin')
      FOR UPDATE`,
    [guildId, actorUserId]
  );
  if (guildRole) return true;
  const serverRole = await db.get(
    `SELECT role FROM server_role_assignments
      WHERE server_id = ? AND guild_id = ? AND user_id = ?
        AND role = 'admin' AND status = 'active'
      FOR UPDATE`,
    [serverId, guildId, actorUserId]
  );
  return Boolean(serverRole);
}

async function recordAudit(db, event) {
  await db.run(
    `INSERT INTO security_audit_events
      (actor_user_id, guild_id, server_id, action, result,
       target_type, target_id, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.actorUserId,
      event.guildId,
      event.serverId,
      event.action,
      event.result,
      event.targetType || null,
      event.targetId || null,
      JSON.stringify(event.metadata || {}),
    ]
  );
}

router.get('/setup', async (req, res) => {
  const db = req.app.locals.db;
  try {
    const guilds = await db.all(
      `SELECT g.id, g.discord_guild_id, g.name, g.status, gr.role,
              EXISTS (
                SELECT 1 FROM guild_tokens gt
                WHERE gt.guild_id = g.id
                  AND gt.token_type = 'nitrado'
                  AND gt.nitrado_user_id IS NOT NULL
              ) AS nitrado_connected,
              (SELECT COUNT(*) FROM servers s
               WHERE s.guild_id = g.id AND s.status = 'active') AS server_count,
              (SELECT COUNT(*) FROM server_features sf
               JOIN servers configured_server ON configured_server.id = sf.server_id
               WHERE configured_server.guild_id = g.id
                 AND configured_server.status = 'active'
                 AND sf.enabled = 1
                 AND sf.feature_name IN ('server_status', 'restart_countdown')) AS discord_config_count,
              (SELECT COUNT(*) FROM server_role_assignments sra
               WHERE sra.guild_id = g.id AND sra.status = 'active') AS assignment_count
       FROM guilds g
       LEFT JOIN guild_roles gr
         ON gr.guild_id = g.id AND gr.user_id = ?
       WHERE g.status IN ('pending', 'approved')
         AND gr.role IN ('owner', 'admin')
       ORDER BY g.name ASC, g.id ASC`,
      [req.user.id]
    );

    const setup = guilds.map(guild => {
      const serverCount = Number(guild.server_count || 0);
      const discordConfigCount = Number(guild.discord_config_count || 0);
      const assignmentCount = Number(guild.assignment_count || 0);
      const checks = {
        discordConnected: true,
        guildVerified: guild.status === 'approved',
        nitradoConnected: Boolean(guild.nitrado_connected),
        serverRegistered: serverCount > 0,
        discordConfigured: discordConfigCount > 0,
        moderatorsConfigured: assignmentCount > 0,
      };
      return {
        guild: {
          id: guild.discord_guild_id,
          name: guild.name,
          status: guild.status,
          role: guild.role,
        },
        checks,
        ready: checks.guildVerified && checks.nitradoConnected &&
          checks.serverRegistered && checks.discordConfigured,
      };
    });

    return res.json({ setup });
  } catch (error) {
    console.error('Failed to load setup status:', error.message);
    return res.status(500).json({ error: 'Failed to load setup status' });
  }
});

router.get('/servers/:serverId/roles', requireServerManage, async (req, res) => {
  const db = req.app.locals.db;
  const serverId = req.authorization.server.id;
  const guildId = req.authorization.guild.id;
  if (!serverId) return res.status(404).json({ error: 'Not found' });

  try {
    const assignments = await db.all(
      `SELECT sra.id, sra.role, sra.status, sra.created_at, sra.updated_at,
              u.discord_id, u.username, u.avatar
       FROM server_role_assignments sra
       JOIN users u ON u.id = sra.user_id
       WHERE sra.server_id = ?
         AND sra.guild_id = ?
       ORDER BY u.username ASC, u.discord_id ASC`,
      [serverId, guildId]
    );
    return res.json({ assignments });
  } catch (error) {
    console.error('Failed to list server role assignments:', error.message);
    return res.status(500).json({ error: 'Failed to load server assignments' });
  }
});

router.post('/servers/:serverId/roles', requireServerManage, async (req, res) => {
  const db = req.app.locals.db;
  const serverId = req.authorization.server.id;
  const guildId = req.authorization.guild.id;
  const discordId = String(req.body?.discordId || '').trim();
  const role = String(req.body?.role || '').trim().toLowerCase();

  if (!serverId || !/^\d{15,22}$/.test(discordId) || !['admin', 'moderator'].includes(role)) {
    return res.status(400).json({ error: 'Invalid assignment request' });
  }

  try {
    const discoveredAssignee = await db.get(
      'SELECT id FROM users WHERE discord_id = ?',
      [discordId]
    );
    if (!discoveredAssignee) return res.status(404).json({ error: 'Not found' });

    let assignee;
    await db.transaction(async transactionDb => {
      await lockUserRoleMutations(transactionDb, [req.user.id, discoveredAssignee.id]);
      const tenant = await lockActiveServerTenant(transactionDb, serverId, guildId);
      if (!tenant) {
        const error = new Error('Not found');
        error.code = 'NOT_FOUND';
        throw error;
      }
      if (!await hasLockedServerManageAuthority(transactionDb, req.user.id, serverId, guildId)) {
        const error = new Error('Server role assignment not permitted');
        error.code = 'FORBIDDEN';
        throw error;
      }
      assignee = await transactionDb.get(
        `SELECT u.id, u.discord_id, u.username
           FROM users u
           JOIN guild_roles gr ON gr.user_id = u.id
          WHERE u.id = ? AND u.discord_id = ?
            AND gr.guild_id = ?
            AND gr.role IN ('owner', 'admin', 'moderator')
          FOR UPDATE OF u, gr`,
        [discoveredAssignee.id, discordId, guildId]
      );
      if (!assignee) {
        const error = new Error('Not found');
        error.code = 'NOT_FOUND';
        throw error;
      }
      await transactionDb.run(
        `INSERT INTO server_role_assignments
          (server_id, guild_id, user_id, role, status, assigned_by_user_id, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, CURRENT_TIMESTAMP)
         ON CONFLICT (server_id, user_id) DO UPDATE SET
           guild_id = EXCLUDED.guild_id,
           role = EXCLUDED.role,
           status = 'active',
           assigned_by_user_id = EXCLUDED.assigned_by_user_id,
           updated_at = CURRENT_TIMESTAMP`,
        [serverId, guildId, assignee.id, role, req.user.id]
      );
      await recordAudit(transactionDb, {
        actorUserId: req.user.id,
        guildId,
        serverId,
        action: 'server_role.assigned',
        result: 'allowed',
        targetType: 'user',
        targetId: assignee.id,
        metadata: { role },
      });
    });

    return res.status(201).json({
      assignment: {
        discordId: assignee.discord_id,
        username: assignee.username,
        role,
        status: 'active',
      },
    });
  } catch (error) {
    if (error.code === 'NOT_FOUND') return res.status(404).json({ error: 'Not found' });
    if (error.code === 'FORBIDDEN') {
      return res.status(403).json({ error: 'Server role assignment not permitted' });
    }
    console.error('Failed to assign server role:', error.message);
    return res.status(500).json({ error: 'Failed to assign server role' });
  }
});

router.delete('/servers/:serverId/roles/:assignmentId', requireServerManage, async (req, res) => {
  const db = req.app.locals.db;
  const serverId = req.authorization.server.id;
  const guildId = req.authorization.guild.id;
  const assignmentId = Number.parseInt(req.params.assignmentId, 10);
  if (!serverId || !Number.isSafeInteger(assignmentId) || assignmentId <= 0) {
    return res.status(404).json({ error: 'Not found' });
  }

  try {
    const discoveredAssignment = await db.get(
      `SELECT user_id
         FROM server_role_assignments
        WHERE id = ? AND server_id = ? AND guild_id = ? AND status = 'active'`,
      [assignmentId, serverId, guildId]
    );
    if (!discoveredAssignment) return res.status(404).json({ error: 'Not found' });

    await db.transaction(async transactionDb => {
      await lockUserRoleMutations(transactionDb, [req.user.id, discoveredAssignment.user_id]);
      const tenant = await lockActiveServerTenant(transactionDb, serverId, guildId);
      if (!tenant) {
        const error = new Error('Assignment not found');
        error.code = 'ASSIGNMENT_NOT_FOUND';
        throw error;
      }
      if (!await hasLockedServerManageAuthority(transactionDb, req.user.id, serverId, guildId)) {
        const error = new Error('Server role revocation not permitted');
        error.code = 'FORBIDDEN';
        throw error;
      }
      const assignment = await transactionDb.get(
        `SELECT user_id, role
           FROM server_role_assignments
          WHERE id = ? AND server_id = ? AND guild_id = ?
            AND user_id = ? AND status = 'active'
          FOR UPDATE`,
        [assignmentId, serverId, guildId, discoveredAssignment.user_id]
      );
      if (!assignment) {
        const notFound = new Error('Assignment not found');
        notFound.code = 'ASSIGNMENT_NOT_FOUND';
        throw notFound;
      }
      const result = await transactionDb.run(
        `UPDATE server_role_assignments
            SET status = 'revoked', updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND server_id = ? AND guild_id = ?
            AND user_id = ? AND status = 'active'`,
        [assignmentId, serverId, guildId, assignment.user_id]
      );
      if (!result?.changes) {
        const notFound = new Error('Assignment not found');
        notFound.code = 'ASSIGNMENT_NOT_FOUND';
        throw notFound;
      }
      await recordAudit(transactionDb, {
        actorUserId: req.user.id,
        guildId,
        serverId,
        action: 'server_role.revoked',
        result: 'allowed',
        targetType: 'user',
        targetId: assignment.user_id,
        metadata: { previousRole: assignment.role },
      });
    });

    return res.status(204).end();
  } catch (error) {
    if (error.code === 'ASSIGNMENT_NOT_FOUND') {
      return res.status(404).json({ error: 'Not found' });
    }
    if (error.code === 'FORBIDDEN') {
      return res.status(403).json({ error: 'Server role revocation not permitted' });
    }
    console.error('Failed to revoke server role:', error.message);
    return res.status(500).json({ error: 'Failed to revoke server role' });
  }
});

module.exports = router;
