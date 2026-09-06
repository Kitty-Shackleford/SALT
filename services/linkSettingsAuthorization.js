'use strict';

const { lockUserRoleMutations } = require('../utils/roleMutationLocks');

async function lockAndVerifyLinkSettingsManager(db, userId, serverId) {
  await lockUserRoleMutations(db, [userId]);
  const scope = await db.get(
    `SELECT s.id, s.guild_id
       FROM servers s
       JOIN guilds g ON g.id = s.guild_id
      WHERE s.id = ? AND s.status = 'active' AND g.status = 'approved'
      FOR UPDATE OF s, g`,
    [serverId]
  );
  if (!scope) return null;
  const guildRole = await db.get(
    'SELECT role FROM guild_roles WHERE guild_id = ? AND user_id = ? FOR UPDATE',
    [scope.guild_id, userId]
  );
  const serverRole = await db.get(
    `SELECT role, status FROM server_role_assignments
      WHERE server_id = ? AND guild_id = ? AND user_id = ? FOR UPDATE`,
    [serverId, scope.guild_id, userId]
  );
  const allowed = ['owner', 'admin'].includes(guildRole?.role)
    || (serverRole?.status === 'active' && serverRole?.role === 'admin');
  return allowed ? scope : null;
}

module.exports = { lockAndVerifyLinkSettingsManager };
