/**
 * Middleware to ensure user is authenticated
 */
function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }

  if (!req.originalUrl?.startsWith('/api/') && req.accepts?.('html')) {
    return res.redirect('/');
  }

  res.status(401).json({ error: 'Not authenticated' });
}

/**
 * Middleware to ensure user is a global admin
 */
function ensureAdmin(req, res, next) {
  if (!req.isAuthenticated()) {
    if (req.originalUrl && req.originalUrl.startsWith('/api/')) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    return res.redirect('/');
  }

  const hasGlobalAdminRole = req.user.platform_role === 'dashboard_admin' ||
    req.user.platform_role === 'dashboard_owner';
  if (!req.user.is_admin && !hasGlobalAdminRole) {
    console.log(`⛔ Access denied for user ${req.user.username} (is_admin: ${req.user.is_admin})`);
    if (req.originalUrl && req.originalUrl.startsWith('/api/')) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    return res.redirect('/dashboard?error=admin_required');
  }

  console.log(`✅ Admin access granted for ${req.user.username}`);
  next();
}

/**
 * Middleware factory to require a minimum role within a guild.
 * Roles hierarchy (ascending): user < moderator < admin < owner
 * Usage: app.get('/api/guilds/:guildId/secure', requireRole('moderator'), handler)
 * The middleware looks for guild identifier in (in order):
 *  - req.params.guildId
 *  - req.body.guildId
 *  - req.query.guildId
 * The guild identifier can be either the numeric DB id or the Discord guild ID string.
 */
function requireRole(minRole) {
  const rank = { user: 0, moderator: 1, admin: 2, owner: 3 };
  const requiredRank = rank[minRole] ?? 0;

  return async function (req, res, next) {
    if (!req.isAuthenticated()) {
      if (req.originalUrl && req.originalUrl.startsWith('/api/')) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      return res.redirect('/');
    }

    const db = req.app && req.app.locals && req.app.locals.db;
    if (!db) {
      console.error('❌ requireRole: no db on app.locals');
      return res.status(500).json({ error: 'Server configuration error' });
    }

    // Find guild identifier in request
    const guildIdentifier = req.params && (req.params.guildId || req.params.guild_id)
      || req.body && (req.body.guildId || req.body.guild_id)
      || req.query && (req.query.guildId || req.query.guild_id);

    if (!guildIdentifier) {
      console.warn('⚠️ requireRole called without guild context');
      // If the required role is just 'user', allow signed-in users
      if (requiredRank <= 0) return next();
      if (req.originalUrl && req.originalUrl.startsWith('/api/')) {
        return res.status(403).json({ error: 'Guild context required for this operation' });
      }
      return res.redirect('/dashboard?error=guild_required');
    }

    try {
      // Resolve guild DB id: allow either numeric DB id or discord_guild_id string
      let guildRow = null;
      if (/^\d+$/.test(String(guildIdentifier))) {
        // numeric id — try numeric DB id first
        guildRow = await db.get('SELECT id, discord_guild_id FROM guilds WHERE id = ?', [guildIdentifier]);
      }
      if (!guildRow) {
        // fallback to discord_guild_id match
        guildRow = await db.get('SELECT id, discord_guild_id FROM guilds WHERE discord_guild_id = ?', [guildIdentifier]);
      }

      if (!guildRow) {
        console.warn(`⚠️ requireRole: guild not found (${guildIdentifier})`);
        if (req.originalUrl && req.originalUrl.startsWith('/api/')) {
          return res.status(404).json({ error: 'Guild not found' });
        }
        return res.redirect('/dashboard?error=guild_not_found');
      }

      const guildId = guildRow.id;
      const userId = req.user && req.user.id;

      if (!userId) {
        console.error('❌ requireRole: authenticated req without req.user.id');
        if (req.originalUrl && req.originalUrl.startsWith('/api/')) {
          return res.status(500).json({ error: 'Server error' });
        }
        return res.redirect('/dashboard?error=server_error');
      }

      const roleRow = await db.get('SELECT role FROM guild_roles WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
      // If no roleRow, treat as not a guild member (rank = -1)
      const userRole = roleRow && roleRow.role ? roleRow.role : null;
      const userRank = userRole ? (rank[userRole] ?? 0) : -1;

      console.log(`🔐 requireRole: user ${req.user.username} has role ${userRole || 'none'} (rank ${userRank}), requires ${minRole} (rank ${requiredRank}) for guild ${guildId}`);

      if (userRank >= requiredRank) {
        return next();
      }

      // Deny
      if (req.originalUrl && req.originalUrl.startsWith('/api/')) {
        return res.status(403).json({ error: 'Insufficient guild role' });
      }
      return res.redirect('/dashboard?error=insufficient_role');
    } catch (err) {
      console.error('❌ requireRole error:', err);
      if (req.originalUrl && req.originalUrl.startsWith('/api/')) {
        return res.status(500).json({ error: 'Server error' });
      }
      return res.redirect('/dashboard?error=server_error');
    }
  };
}

module.exports = {
  ensureAuthenticated,
  ensureAdmin,
  requireRole
};
