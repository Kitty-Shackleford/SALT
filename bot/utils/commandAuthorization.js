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
  'tp-coord': 'server_moderate',
  'tp-everyone': 'server_moderate',
  'tp-event': 'server_moderate',
  'birthday:list': 'server_moderate',
  'mod-log': 'server_moderate',
  'economy': 'player',
  // Phase 3: IRL + in-character birthdays. Subcommands are classified
  // individually (see commandAuthorizationKey): set = any linked player,
  // view = any guild member, list = moderators (same class as 'teleport').
  'birthday:set': 'player',
  'birthday:view': 'general',
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
  // Phase 1: general utility commands (no server scope).
  'poll': 'general',
  'roll': 'general',
  'flip': 'general',
  'count': 'general',
  // Phase 1: per-guild admin configuration (no server scope).
  'setup-welcome': 'guild_admin',
  'setup-reactions': 'guild_admin',
  // Phase 2: identity-linked moderation (server-scoped; Discord
  // ModerateMembers/ManageMessages gate at the command boundary).
  'warn': 'server_moderate',
  'notes': 'server_moderate',
  'cases': 'server_moderate',
  'purge': 'server_moderate',
  // Phase 2: guild-scoped admin configuration (no server scope).
  'say': 'guild_admin',
  'ticket': 'guild_admin',
  'lock': 'guild_admin',
  // Anti-spam configuration (per-guild opt-in rate limiter).
  'setup-antispam': 'guild_admin',
  // Player-facing AI: asking is any approved-guild member (feature-gated +
  // rate-limited per member in the service); configuration is admin-only.
  'ask': 'general',
  'setup-ai': 'guild_admin',
  // Suggestions: sending is any approved-guild member; setup is admin.
  'suggestions:send': 'general',
  'suggestions:setup': 'guild_admin',
});

function commandClass(commandName) {
  return COMMAND_CLASSES[commandName] || null;
}

function commandAuthorizationKey(commandName, subcommand = null, subcommandGroup = null) {
  if (commandName === 'report') return `report:${subcommand}`;
  if (commandName === 'wipe-info') return `wipe-info:${subcommandGroup || subcommand}`;
  if (commandName === 'birthday') return `birthday:${subcommand}`;
  if (commandName === 'suggestions') return `suggestions:${subcommand}`;
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
            s.guild_id,
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

  // Guild-scoped (no server scope) capability classes.
  if (capabilityClass === 'general' || capabilityClass === 'guild_admin') {
    const guild = await db.query(
      'SELECT status FROM guilds WHERE discord_guild_id = $1 LIMIT 1',
      [String(discordGuildId)]
    );
    if (guild.rows[0]?.status !== 'approved') return { allowed: false };
    if (capabilityClass === 'general') return { allowed: true, serverId: null };
    // guild_admin: Discord Administrator, a guild-level owner/admin role, or an
    // active server-level admin (setup commands are guild-scoped; a server
    // admin still configures the guild's feature set).
    if (actor.isDiscordAdministrator === true) return { allowed: true, serverId: null };
    const roleRow = await db.query(
      `SELECT gr.role AS guild_role
       FROM guild_roles gr
       JOIN users u ON u.id = gr.user_id
       WHERE u.discord_id = $1 AND gr.guild_id = (
         SELECT id FROM guilds WHERE discord_guild_id = $2 LIMIT 1
       )
       LIMIT 1`,
      [String(actor.discordUserId), String(discordGuildId)]
    );
    const guildRole = roleRow.rows[0]?.guild_role;
    if (['owner', 'admin'].includes(guildRole)) return { allowed: true, serverId: null };
    const serverRoleRow = await db.query(
      `SELECT sra.role
       FROM server_role_assignments sra
       JOIN users u ON u.id = sra.user_id
       JOIN servers s ON s.id = sra.server_id
       WHERE u.discord_id = $1 AND s.guild_id = (
         SELECT id FROM guilds WHERE discord_guild_id = $2 LIMIT 1
       )
         AND sra.status = 'active' AND sra.role IN ('admin', 'owner')
       LIMIT 1`,
      [String(actor.discordUserId), String(discordGuildId)]
    );
    return ['owner', 'admin'].includes(serverRoleRow.rows[0]?.role)
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
  selectAuthorizedServer,
  authorizeGuildCommand,
};
