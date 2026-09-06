'use strict';

const COMMAND_CLASSES = Object.freeze({
  'register-token': 'registration',
  'server-control': 'server_manage',
  'setup-status': 'server_manage',
  'setup-feeds': 'server_manage',
  'alert-threshold': 'server_manage',
  'link-settings': 'server_manage',
  'link-admin': 'server_moderate',
  'report:setup': 'server_manage',
  'ban': 'server_moderate',
  'ban-list': 'server_moderate',
  'whitelist': 'server_moderate',
  'priority': 'server_moderate',
  'location': 'server_moderate',
  'teleport': 'server_moderate',
  'mod-log': 'server_moderate',
  'economy': 'player',
  'stats': 'player',
  'leaderboard': 'player',
  'my-stats': 'player',
  'unlink': 'player',
  'notify-restart': 'player',
  'report:player': 'player',
  'link': 'prelink',
  'uptime': 'public_server',
  'online': 'public_server',
  'wipe-info:show': 'public_server',
  'wipe-info:set': 'server_manage',
  'wipe-info:clear': 'server_manage',
  'server-status': 'public_server',
  'radar-audit': 'server_manage',
  'github': 'server_manage',
  'mission-init': 'server_manage',
});

function commandClass(commandName) {
  return COMMAND_CLASSES[commandName] || null;
}

function commandAuthorizationKey(commandName, subcommand = null, subcommandGroup = null) {
  if (commandName === 'report') return `report:${subcommand}`;
  if (commandName === 'wipe-info') return `wipe-info:${subcommandGroup || subcommand}`;
  return commandName;
}

async function canExecuteGuildCommand(db, discordGuildId, commandName) {
  if (!discordGuildId || !commandClass(commandName)) return false;
  if (commandClass(commandName) === 'registration') return true;
  const result = await db.query(
    'SELECT status FROM guilds WHERE discord_guild_id = $1 LIMIT 1',
    [String(discordGuildId)]
  );
  return result.rows[0]?.status === 'approved';
}

function selectAuthorizedServer(rows, requestedServerId) {
  if (!rows.length) return null;
  if (requestedServerId !== undefined && requestedServerId !== null && requestedServerId !== '') {
    const requested = String(requestedServerId);
    return rows.find(row => String(row.platform_server_id) === requested) || null;
  }
  return rows.length === 1 ? rows[0] : null;
}

function serverAllowsCapability(server, capabilityClass, isDiscordAdministrator) {
  if (capabilityClass === 'public_server' || capabilityClass === 'prelink') return true;
  if (capabilityClass === 'player') return Boolean(server.player_membership_id);

  const activeRole = server.server_role_status === 'active' ? server.server_role : null;
  const isGuildOperator = ['owner', 'admin'].includes(server.guild_role);
  const isServerAdmin = activeRole === 'admin';
  const isServerModerator = activeRole === 'moderator';
  return Boolean(isDiscordAdministrator || isGuildOperator || isServerAdmin ||
    (capabilityClass === 'server_moderate' && isServerModerator));
}

async function listAuthorizedCommandServers(db, discordGuildId, commandName, actor = {}) {
  const capabilityClass = commandClass(commandName);
  if (!discordGuildId || !actor.discordUserId || !capabilityClass || capabilityClass === 'registration') {
    return [];
  }

  const result = await db.query(
    `SELECT s.id AS server_id,
            s.platform_server_id,
            s.name AS server_name,
            s.platform,
            sf.config AS custom_name_config,
            gr.role AS guild_role,
            sra.role AS server_role,
            sra.status AS server_role_status,
            membership.id AS player_membership_id
     FROM guilds g
     JOIN servers s ON s.guild_id = g.id
     LEFT JOIN server_features sf
       ON sf.server_id = s.id
      AND sf.feature_name = 'custom_name'
     LEFT JOIN users u ON u.discord_id = $2
     LEFT JOIN guild_roles gr
       ON gr.guild_id = g.id
      AND gr.user_id = u.id
     LEFT JOIN server_role_assignments sra
       ON sra.server_id = s.id
      AND sra.guild_id = g.id
      AND sra.user_id = u.id
     LEFT JOIN LATERAL (
       SELECT spm.id
       FROM server_player_memberships spm
       JOIN linked_accounts la
         ON la.id = spm.source_link_id
        AND la.identity_id = spm.identity_id
        AND la.user_id = spm.user_id
       WHERE spm.server_id = s.id
         AND spm.guild_id = g.id
         AND spm.user_id = u.id
         AND spm.status = 'active'
         AND la.verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')
       ORDER BY spm.id
       LIMIT 1
     ) membership ON TRUE
     WHERE g.discord_guild_id = $1
       AND g.status = 'approved'
       AND s.status = 'active'
     ORDER BY s.id`,
    [String(discordGuildId), String(actor.discordUserId)]
  );
  const rows = result.rows || [];
  return rows.filter(server => serverAllowsCapability(
    server,
    capabilityClass,
    actor.isDiscordAdministrator === true
  ));
}

async function authorizeGuildCommand(db, discordGuildId, commandName, actor = {}) {
  const capabilityClass = commandClass(commandName);
  if (!discordGuildId || !actor.discordUserId || !capabilityClass) return { allowed: false };
  if (capabilityClass === 'registration') {
    return actor.isDiscordAdministrator
      ? { allowed: true, serverId: null }
      : { allowed: false };
  }

  const rows = await listAuthorizedCommandServers(db, discordGuildId, commandName, actor);
  const server = selectAuthorizedServer(rows, actor.requestedServerId);
  return server
    ? { allowed: true, serverId: server.server_id }
    : { allowed: false };
}

module.exports = {
  COMMAND_CLASSES,
  commandAuthorizationKey,
  canExecuteGuildCommand,
  listAuthorizedCommandServers,
  authorizeGuildCommand,
};
