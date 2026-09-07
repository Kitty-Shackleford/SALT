'use strict';

const GLOBAL_ROLES = new Set(['dashboard_owner', 'dashboard_admin']);
const GUILD_ROLES = new Set(['guild_owner', 'guild_admin']);
const SERVER_ROLES = new Set(['server_admin', 'moderator', 'player']);

function sameGuild(actor, request) {
  return actor.guildId != null && request.guildId != null && String(actor.guildId) === String(request.guildId);
}

function sameServer(actor, request) {
  return sameGuild(actor, request) && actor.serverId != null && request.serverId != null &&
    String(actor.serverId) === String(request.serverId);
}

function isPlatformOwner(actor) {
  return actor?.platformRole === 'dashboard_owner';
}

function isPlatformOperator(actor) {
  return isPlatformOwner(actor) || actor?.platformRole === 'dashboard_admin';
}

function canGrantRole(actor, request) {
  if (!actor || !request || !request.role || !request.targetUserId) return false;
  const role = request.role;

  if (GLOBAL_ROLES.has(role)) {
    return isPlatformOwner(actor) && role === 'dashboard_admin' &&
      String(actor.userId) !== String(request.targetUserId);
  }

  if (isPlatformOperator(actor)) return GUILD_ROLES.has(role) || SERVER_ROLES.has(role);
  if (role === 'guild_owner') return false;
  if (role === 'guild_admin') return actor.guildRole === 'owner' && sameGuild(actor, request);
  if (role === 'server_admin') return actor.guildRole === 'owner' && sameGuild(actor, request);
  if (role === 'moderator' || role === 'player') {
    if (['owner', 'admin'].includes(actor.guildRole) && sameGuild(actor, request)) return true;
    if (actor.serverRole === 'admin' && sameServer(actor, request)) return true;
    return role === 'player' && actor.serverRole === 'moderator' && sameServer(actor, request);
  }
  return false;
}

function canRemoveRole(actor, request) {
  if (!actor || !request) return false;
  if (request.role === 'dashboard_owner' || request.role === 'guild_owner') return false;
  return canGrantRole(actor, request);
}

async function resolveActorAuthority(db, actor, scope = {}, options = {}) {
  if (!db || !actor?.id) return null;
  const lockClause = options.lockAuthority ? ' FOR UPDATE' : '';
  const storedActor = options.lockAuthority
    ? await db.get(`SELECT id, platform_role, is_admin FROM users WHERE id = ?${lockClause}`, [actor.id])
    : actor;
  if (!storedActor) return null;
  const platformRole = storedActor.platform_role || (storedActor.is_admin ? 'dashboard_admin' : null);
  const authority = { userId: storedActor.id, platformRole };
  if (isPlatformOperator(authority)) return authority;

  if (scope.guildId == null) return authority;
  const guild = await db.get(
    `SELECT g.id
       FROM guilds g
      WHERE (CAST(g.id AS TEXT) = ? OR g.discord_guild_id = ?)
        AND g.status = 'approved'
      LIMIT 1`,
    [String(scope.guildId), String(scope.guildId)]
  );
  if (!guild) return authority;
  authority.guildId = guild.id;
  const guildAuthority = await db.get(
    `SELECT role FROM guild_roles
      WHERE guild_id = ? AND user_id = ?${lockClause}`,
    [guild.id, storedActor.id]
  );
  authority.guildRole = guildAuthority?.role || null;

  if (scope.serverId == null) return authority;
  const server = await db.get(
    `SELECT s.id
       FROM servers s
      WHERE s.id = ? AND s.guild_id = ? AND s.status = 'active'
      LIMIT 1`,
    [scope.serverId, guild.id]
  );
  if (server) {
    authority.serverId = server.id;
    const serverAuthority = await db.get(
      `SELECT role, status FROM server_role_assignments
        WHERE server_id = ? AND guild_id = ? AND user_id = ? AND status = 'active'${lockClause}`,
      [server.id, guild.id, storedActor.id]
    );
    authority.serverRole = serverAuthority?.role || null;
  }
  return authority;
}

module.exports = {
  GLOBAL_ROLES,
  GUILD_ROLES,
  SERVER_ROLES,
  canGrantRole,
  canRemoveRole,
  resolveActorAuthority,
};
