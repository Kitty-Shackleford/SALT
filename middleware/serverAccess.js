/* eslint-disable require-atomic-updates */
const {
  CAPABILITIES,
  authorizeServer,
} = require('../services/authorizationService');

/**
 * Require a capability on an exact internal dashboard server ID and attach the
 * canonical trusted context to req.authorization.
 */
function requireServerCapability(capability, options = {}) {
  return async function serverCapabilityMiddleware(req, res, next) {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const serverId = options.getServerId
      ? options.getServerId(req)
      : (req.params?.serverId || req.params?.id);
    if (!/^\d+$/.test(String(serverId || '')) || !Number.isSafeInteger(Number(serverId)) || Number(serverId) <= 0) {
      return res.status(404).json({ error: 'Resource not found' });
    }

    try {
      const context = await authorizeServer(
        req.app.locals.db,
        req.user,
        serverId,
        capability
      );
      if (!context) {
        return res.status(404).json({ error: 'Resource not found' });
      }
      req.authorization = context;
      return next();
    } catch (error) {
      console.error('❌ Server authorization failed:', error.message);
      return res.status(500).json({ error: 'Server error' });
    }
  };
}

/**
 * Middleware to ensure user owns the server (delegates to requireRole('owner') after resolving guild)
 */
async function ensureServerOwner(req, res, next) {
  return requireServerCapability(CAPABILITIES.SERVER_OWNER)(req, res, next);
}

/**
 * Middleware to ensure user can manage the exact approved server.
 * Authorization is bound to the actor's tenant/server role.
 */
async function ensureServerAccess(req, res, next) {
  return requireServerCapability(CAPABILITIES.SERVER_MANAGE)(req, res, next);
}

/** Require owner/admin authority for the exact Nitrado service and approved guild. */
async function ensurePlatformServerOwner(req, res, next) {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const serverCandidates = [
    req.params?.serverId,
    req.params?.serviceId,
    req.params?.platformServerId,
    req.query?.serverId,
    req.query?.platformServerId,
    req.body?.serverId,
    req.body?.platformServerId,
  ].filter(candidate => candidate !== undefined && candidate !== null && candidate !== '').map(String);
  const guildCandidates = [req.params?.guildId, req.query?.guildId, req.body?.guildId]
    .filter(candidate => candidate !== undefined && candidate !== null && candidate !== '')
    .map(String);
  if (new Set(serverCandidates).size > 1 || new Set(guildCandidates).size > 1) {
    return res.status(400).json({ error: 'Conflicting resource identifiers' });
  }
  const platformServerId = serverCandidates[0];
  const requestedGuildId = guildCandidates[0] || null;
  if (!platformServerId) {
    return res.status(403).json({ error: 'Server access required' });
  }

  try {
    const db = req.app.locals.db;
    const row = await db.get(
      `SELECT s.id, s.guild_id, s.platform, g.discord_guild_id
       FROM servers s
       JOIN guilds g ON g.id = s.guild_id
       WHERE CAST(s.platform_server_id AS TEXT) = ?
         AND g.status = 'approved'
         AND s.status = 'active'
         AND (
           EXISTS (
             SELECT 1 FROM guild_roles gr
             WHERE gr.guild_id = g.id AND gr.user_id = ? AND gr.role IN ('owner', 'admin')
           )
           OR EXISTS (
             SELECT 1 FROM server_role_assignments sra
             WHERE sra.server_id = s.id AND sra.guild_id = s.guild_id
               AND sra.user_id = ? AND sra.role = 'admin' AND sra.status = 'active'
           )
         )
         AND (CAST(? AS TEXT) IS NULL OR g.discord_guild_id = ? OR CAST(g.id AS TEXT) = ?)
       LIMIT 1`,
      [String(platformServerId), req.user.id, req.user.id,
        requestedGuildId, requestedGuildId, requestedGuildId]
    );

    if (!row) {
      return res.status(403).json({ error: 'Access denied for this server' });
    }
    req.platformServerAccess = {
      serverId: row.id,
      guildId: row.guild_id,
      discordGuildId: row.discord_guild_id,
      platformServerId: String(platformServerId),
      platform: row.platform,
    };
    const canonicalPlatformId = String(platformServerId);
    for (const source of [req.params, req.query, req.body]) {
      if (!source || typeof source !== 'object') continue;
      source.serverId = canonicalPlatformId;
      source.serviceId = canonicalPlatformId;
      source.platformServerId = canonicalPlatformId;
      source.guildId = String(row.discord_guild_id);
    }
    return next();
  } catch (err) {
    console.error('❌ Database error checking platform server access:', err);
    return res.status(500).json({ error: 'Database error' });
  }
}

/** Require owner/admin role for the exact approved guild selected by the request. */
async function ensureApprovedGuildOperator(req, res, next) {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const guildId = req.params?.guildId || req.query?.guildId || req.body?.guildId;
  if (!guildId) {
    return res.status(403).json({ error: 'Guild access required' });
  }

  try {
    const db = req.app.locals.db;
    const row = await db.get(
      `SELECT g.id, g.discord_guild_id, gr.role
       FROM guilds g
       JOIN guild_roles gr ON gr.guild_id = g.id AND gr.user_id = ?
       WHERE g.status = 'approved'
         AND gr.role IN ('owner', 'admin')
         AND (g.discord_guild_id = ? OR CAST(g.id AS TEXT) = ?)
       LIMIT 1`,
      [req.user.id, String(guildId), String(guildId)]
    );
    if (!row) {
      return res.status(403).json({ error: 'Access denied for this guild' });
    }
    req.guildAccess = { guildId: row.id, discordGuildId: row.discord_guild_id };
    return next();
  } catch (err) {
    console.error('❌ Database error checking approved guild operator access:', err);
    return res.status(500).json({ error: 'Database error' });
  }
}

/** Require the exact approved guild's owner role without a global-admin bypass. */
async function ensureGuildOwner(req, res, next) {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const guildId = req.params?.guildId || req.query?.guildId || req.body?.guildId;
  if (!guildId) {
    return res.status(403).json({ error: 'Guild access required' });
  }

  try {
    const row = await req.app.locals.db.get(
      `SELECT g.id, g.discord_guild_id, gr.role
       FROM guilds g
       JOIN guild_roles gr ON gr.guild_id = g.id AND gr.user_id = ?
       WHERE g.status = 'approved'
         AND gr.role = 'owner'
         AND (g.discord_guild_id = ? OR CAST(g.id AS TEXT) = ?)
       LIMIT 1`,
      [req.user.id, String(guildId), String(guildId)]
    );
    if (!row) {
      return res.status(403).json({ error: 'Access denied for this guild' });
    }
    req.guildAccess = { guildId: row.id, discordGuildId: row.discord_guild_id };
    return next();
  } catch (err) {
    console.error('❌ Database error checking guild owner access:', err);
    return res.status(500).json({ error: 'Database error' });
  }
}

/**
 * Middleware to ensure the user can operate at least one active server in an
 * approved guild, either through a guild owner/admin role or an exact active
 * server-admin assignment. This is intentionally narrower than changing the
 * shared guild-membership guard used by unrelated routes.
 */
async function ensureHasOperableServers(req, res, next) {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const row = await req.app.locals.db.get(
      `SELECT s.id
       FROM servers s
       JOIN guilds g ON g.id = s.guild_id
       LEFT JOIN guild_roles gr
         ON gr.guild_id = g.id AND gr.user_id = ? AND gr.role IN ('owner', 'admin')
       LEFT JOIN server_role_assignments sra
         ON sra.server_id = s.id AND sra.guild_id = s.guild_id
        AND sra.user_id = ? AND sra.role = 'admin' AND sra.status = 'active'
       WHERE g.status = 'approved'
         AND s.status = 'active'
         AND (gr.user_id IS NOT NULL OR sra.user_id IS NOT NULL)
       LIMIT 1`,
      [req.user.id, req.user.id]
    );

    if (!row) {
      if (req.originalUrl.startsWith('/api/')) {
        return res.status(403).json({ error: 'You do not have access to any operable servers.' });
      }
      return res.redirect('/dashboard?error=no_servers');
    }

    req.serverInfo = row;
    return next();
  } catch (err) {
    console.error('❌ Database error checking operable server access:', err.message);
    return res.status(500).json({ error: 'Database error' });
  }
}

/**
 * Middleware to ensure user has access to at least one server via guild_roles.
 */
async function ensureHasServers(req, res, next) {
  const db = req.app.locals.db;
  const userId = req.user.id;

  const query = `
    SELECT s.id
    FROM servers s
    LEFT JOIN guild_roles gr ON gr.guild_id = s.guild_id AND gr.user_id = ?
    WHERE gr.role IS NOT NULL
    LIMIT 1
  `;

  try {
    const row = await db.get(query, [userId]);

    if (!row) {
      console.log(`⛔ User ${req.user.username} has no servers - redirecting to dashboard`);

      // For API routes, return JSON error
      if (req.originalUrl.startsWith('/api/')) {
        return res.status(403).json({
          error: 'You do not have access to any servers.',
          hint: 'Sign up your server or visit the player portal.'
        });
      }

      // For HTML pages, redirect to dashboard with error
      return res.redirect('/dashboard?error=no_servers');
    }

    req.serverInfo = row;
    next();
  } catch (err) {
    console.error('❌ Database error:', err);
    return res.status(500).json({ error: 'Database error' });
  }
}

/**
 * Middleware to restrict dashboard APIs to admins or members of an approved guild.
 */
async function ensureApproved(req, res, next) {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const db = req.app.locals.db;

  try {
    const approvedGuild = await db.get(
      `SELECT g.id
       FROM guilds g
       JOIN guild_roles gr ON gr.guild_id = g.id
       WHERE gr.user_id = ? AND g.status = 'approved'
       LIMIT 1`,
      [req.user.id]
    );

    if (approvedGuild) {
      return next();
    }

    return res.status(403).json({ error: 'Access requires membership in an approved guild' });
  } catch (err) {
    console.error('❌ Database error checking approved guild access:', err);
    return res.status(500).json({ error: 'Database error' });
  }
}

/**
 * Player-facing approved-guild guard. Unlike ensureApproved, this accepts a
 * Discord-verified game-account link without granting access to operational
 * dashboard APIs. New links record verified_by_guild_id directly. Historical
 * bot links are accepted only when the linked identity's current gamertag is
 * attached to an approved server in the guild where the command could run.
 */
async function ensurePlayerApproved(req, res, next) {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const db = req.app.locals.db;

  try {
    const approvedGuild = await db.get(
      `SELECT g.id
       FROM guilds g
       WHERE g.status = 'approved'
         AND (
           EXISTS (
             SELECT 1 FROM guild_roles gr
             WHERE gr.guild_id = g.id AND gr.user_id = ?
           )
           OR EXISTS (
             SELECT 1
             FROM server_player_memberships spm
             JOIN servers s
               ON s.id = spm.server_id
              AND s.guild_id = spm.guild_id
              AND s.status = 'active'
             JOIN linked_accounts la
               ON la.id = spm.source_link_id
              AND la.identity_id = spm.identity_id
              AND la.user_id = spm.user_id
             WHERE spm.user_id = ?
               AND spm.guild_id = g.id
               AND spm.status = 'active'
               AND la.verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')
           )
         )
       LIMIT 1`,
      [req.user.id, req.user.id]
    );

    if (approvedGuild) {
      return next();
    }

    return res.status(403).json({ error: 'Access requires a verified account in an approved guild' });
  } catch (err) {
    console.error('❌ Database error checking approved player access:', err);
    return res.status(500).json({ error: 'Database error' });
  }
}

/**
 * Require player/operator evidence for the exact approved guild requested by
 * a player-facing router. Supports Express router.param callbacks via `value`.
 */
async function ensurePlayerGuildAccess(req, res, next, value) {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const guildId = value || req.params?.guildId || req.query?.guildId || req.body?.guildId;
  if (!guildId) {
    return res.status(403).json({ error: 'Guild access required' });
  }

  try {
    const row = await req.app.locals.db.get(
      `SELECT g.id
       FROM guilds g
       WHERE g.status = 'approved'
         AND (g.discord_guild_id = ? OR CAST(g.id AS TEXT) = ?)
         AND (
           EXISTS (
             SELECT 1 FROM guild_roles gr
             WHERE gr.guild_id = g.id AND gr.user_id = ?
               AND gr.role IN ('owner', 'admin')
           )
           OR EXISTS (
             SELECT 1
             FROM servers s
             JOIN server_role_assignments sra
               ON sra.server_id = s.id
              AND sra.guild_id = g.id
              AND sra.user_id = ?
             WHERE s.guild_id = g.id
               AND s.status = 'active'
               AND sra.status = 'active'
               AND sra.role IN ('admin', 'moderator')
           )
           OR EXISTS (
             SELECT 1
             FROM server_player_memberships spm
             JOIN servers s
               ON s.id = spm.server_id
              AND s.guild_id = spm.guild_id
              AND s.status = 'active'
             JOIN linked_accounts la
               ON la.id = spm.source_link_id
              AND la.identity_id = spm.identity_id
              AND la.user_id = spm.user_id
             WHERE spm.user_id = ?
               AND spm.guild_id = g.id
               AND spm.status = 'active'
               AND la.verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')
           )
         )
       LIMIT 1`,
      [String(guildId), String(guildId), req.user.id, req.user.id, req.user.id]
    );
    if (row) return next();
    return res.status(403).json({ error: 'Access denied for this guild' });
  } catch (err) {
    console.error('❌ Database error checking player guild access:', err);
    return res.status(500).json({ error: 'Database error' });
  }
}

/** Require ownership and same-guild verification for an exact player identity. */
async function ensurePlayerIdentityAccess(req, res, next, value) {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const identityId = value || req.params?.identityId || req.body?.identityId || req.body?.fromIdentityId;
  if (!identityId) {
    return res.status(403).json({ error: 'Player identity access required' });
  }

  try {
    const row = await req.app.locals.db.get(
      `SELECT spm.identity_id AS id, s.id AS server_id, g.id AS guild_id
       FROM server_player_memberships spm
       JOIN linked_accounts la
         ON la.id = spm.source_link_id
        AND la.identity_id = spm.identity_id
        AND la.user_id = spm.user_id
       JOIN servers s ON s.id = spm.server_id AND s.guild_id = spm.guild_id
       JOIN guilds g ON g.id = s.guild_id
       WHERE spm.user_id = ?
         AND spm.identity_id = ?
         AND spm.status = 'active'
         AND s.status = 'active'
         AND g.status = 'approved'
         AND la.verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')
       ORDER BY spm.server_id
       LIMIT 1`,
      [req.user.id, identityId]
    );
    if (row) {
      req.playerAccess = {
        identityId: Number(row.id),
        serverId: row.server_id,
        guildId: row.guild_id,
      };
      return next();
    }
    return res.status(403).json({ error: 'Access denied for this player identity' });
  } catch (err) {
    console.error('❌ Database error checking player identity access:', err);
    return res.status(500).json({ error: 'Database error' });
  }
}

/** Require player/operator evidence for the exact approved server requested. */
async function ensurePlayerServerAccess(req, res, next) {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  // Express passes (value, name) as arguments 4 and 5 for router.param callbacks.
  // Keep the declared arity at three so Express also executes this as ordinary
  // route middleware instead of classifying it as a four-argument error handler.
  const parameterValue = arguments[3];
  const parameterName = arguments[4];
  const parameterServerId = parameterName === 'serverId' ? parameterValue : undefined;
  const parameterIdentityId = parameterName === 'identityId' ? parameterValue : undefined;
  const serverCandidates = [parameterServerId, req.params?.serverId, req.query?.serverId, req.body?.serverId]
    .filter(candidate => candidate !== undefined && candidate !== null && candidate !== '')
    .map(String);
  const identityCandidates = [parameterIdentityId, req.params?.identityId, req.query?.identityId, req.body?.identityId]
    .filter(candidate => candidate !== undefined && candidate !== null && candidate !== '')
    .map(String);
  if (new Set(serverCandidates).size > 1 || new Set(identityCandidates).size > 1) {
    return res.status(400).json({ error: 'Conflicting resource identifiers' });
  }
  const serverId = serverCandidates[0];
  const identityId = identityCandidates[0] || null;
  if (!serverId) {
    return res.status(403).json({ error: 'Server access required' });
  }

  try {
    const authorization = await authorizeServer(
      req.app.locals.db,
      req.user,
      String(serverId),
      CAPABILITIES.SERVER_VIEW
    );
    const authorizedIdentityId = authorization?.player?.identityId || null;
    if (authorization && (!identityId || String(authorizedIdentityId) === String(identityId))) {
      req.playerServerAccess = {
        serverId: authorization.server.id,
        guildId: authorization.guild.id,
        identityId: authorizedIdentityId ? Number(authorizedIdentityId) : null,
      };
      for (const source of [req.params, req.query, req.body]) {
        if (!source || typeof source !== 'object') continue;
        source.serverId = authorization.server.id;
        source.guildId = authorization.guild.id;
        if (authorizedIdentityId) source.identityId = Number(authorizedIdentityId);
      }
      return next();
    }
    return res.status(403).json({ error: 'Access denied for this server' });
  } catch (err) {
    console.error('❌ Database error checking player server access:', err);
    return res.status(500).json({ error: 'Database error' });
  }
}

module.exports = {
  CAPABILITIES,
  requireServerCapability,
  ensureServerOwner,
  ensureServerAccess,
  ensureGuildOwner,
  ensureHasOperableServers,
  ensureHasServers,
  ensureApproved,
  ensurePlayerApproved,
  ensurePlayerGuildAccess,
  ensurePlayerIdentityAccess,
  ensurePlayerServerAccess,
  ensurePlatformServerOwner,
  ensureApprovedGuildOperator
};
