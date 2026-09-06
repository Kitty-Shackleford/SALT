const express = require('express');
const router = express.Router();
const { getUserGuilds, verifyGuildMembership } = require('../utils/discordAPI');
const {
  buildAchievementProgress,
  calculatePlayerProgression,
  loadAchievementStats,
} = require('../services/achievementService');
const { admTupleToWorld } = require('../utils/dayzCoordinates');
const {
  isPlayerMapFeatureEnabled,
  parsePlayerMapSettings,
  projectPlayerHealthPayload,
  projectPlayerMapPayload,
} = require('../utils/playerMapPolicy');

function parseCanonicalServerId(req) {
  const queryId = req.query && req.query.serverId;
  const pathId = req.params && req.params.server_id;
  if (queryId !== undefined && pathId !== undefined && String(queryId) !== String(pathId)) {
    return { error: 'Conflicting server selections' };
  }
  const raw = pathId !== undefined ? pathId : queryId;
  if (raw === undefined || raw === null || raw === '') return { error: 'serverId is required' };
  if (!/^\d+$/.test(String(raw)) || Number(raw) < 1) return { error: 'serverId must be a canonical server ID' };
  return { serverId: Number(raw) };
}

async function loadPlayerMapSettings(db, serverId) {
  const row = await db.get(
    "SELECT config FROM server_features WHERE server_id = ? AND feature_name = 'player_map' LIMIT 1",
    [serverId]
  );
  return parsePlayerMapSettings(row?.config);
}

async function requirePlayerServerMembership(req, res, next) {
  const parsed = parseCanonicalServerId(req);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const identityValue = req.params && (req.params.identity_id || req.params.identityId);
  if (identityValue !== undefined && (!/^\d+$/.test(String(identityValue)) || Number(identityValue) < 1)) {
    return res.status(400).json({ error: 'Invalid identity ID' });
  }

  const db = req.app.locals.db;
  const params = [req.user.id, parsed.serverId];
  let identityClause = '';
  if (identityValue !== undefined) {
    identityClause = ' AND spm.identity_id = ?';
    params.push(Number(identityValue));
  }
  if (req.params && req.params.guild_id) {
    identityClause += ' AND g.discord_guild_id = ?';
    params.push(req.params.guild_id);
  }

  const membership = await db.get(
    `SELECT spm.server_id, spm.guild_id, spm.identity_id
     FROM server_player_memberships spm
     JOIN linked_accounts la
       ON spm.source_link_id = la.id
      AND la.user_id = spm.user_id
      AND la.identity_id = spm.identity_id
      AND la.verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')
     JOIN servers s ON s.id = spm.server_id AND s.guild_id = spm.guild_id AND s.status = 'active'
     JOIN guilds g ON g.id = spm.guild_id AND g.status = 'approved'
     WHERE spm.user_id = ? AND spm.server_id = ?
       AND spm.status = 'active'${identityClause}
     LIMIT 1`,
    params,
  );
  if (!membership) return res.status(403).json({ error: 'Access denied' });

  req.playerServer = {
    id: Number(membership.server_id),
    guildId: membership.guild_id,
    identityId: membership.identity_id ? Number(membership.identity_id) : null,
  };
  req.query.serverId = parsed.serverId;
  if (req.params) {
    if (membership.identity_id) {
      if (req.params.identity_id !== undefined) req.params.identity_id = String(membership.identity_id);
      if (req.params.identityId !== undefined) req.params.identityId = String(membership.identity_id);
    }
    if (req.params.server_id !== undefined) req.params.server_id = String(membership.server_id);
  }
  return next();
}

// Param callbacks run only after Express has matched a route and populated all
// path params. A router-wide guard cannot safely authorize identity/server paths.
router.param('identity_id', requirePlayerServerMembership);
router.param('identityId', requirePlayerServerMembership);

/**
 * GET /api/player/guilds
 * Get guilds where the logged-in user has active exact-server memberships.
 * Discord membership is used only to discover approved linking candidates.
 */
router.get('/guilds', async (req, res) => {
  const db = req.app.locals.db;
  const userId = req.user.id;
  const accessToken = req.user.access_token;

  try {
    // Primary: find guilds where this user has linked accounts with activity
    const linkedGuilds = await db.query(`
      SELECT
        g.id, g.discord_guild_id as guild_id, g.name as guild_name,
        g.icon_url, g.status,
        COUNT(DISTINCT s.id) as server_count,
        COUNT(DISTINCT spm2.user_id) as player_count
      FROM server_player_memberships spm
      JOIN linked_accounts la ON la.id = spm.source_link_id
        AND la.user_id = spm.user_id AND la.identity_id = spm.identity_id
        AND la.verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')
      JOIN servers s ON s.id = spm.server_id AND s.guild_id = spm.guild_id AND s.status = 'active'
      JOIN guilds g ON g.id = spm.guild_id
      LEFT JOIN server_player_memberships spm2 ON spm2.server_id = s.id AND spm2.status = 'active'
      WHERE spm.user_id = ? AND spm.status = 'active' AND g.status = 'approved'
      GROUP BY g.id, g.discord_guild_id, g.name, g.icon_url, g.status
      ORDER BY g.name ASC
    `, [userId]);

    const linkedServers = await db.query(`
      SELECT DISTINCT g.discord_guild_id AS guild_id, s.id, s.name
      FROM server_player_memberships spm
      JOIN linked_accounts la ON la.id = spm.source_link_id
        AND la.user_id = spm.user_id AND la.identity_id = spm.identity_id
        AND la.verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')
      JOIN servers s ON s.id = spm.server_id AND s.guild_id = spm.guild_id AND s.status = 'active'
      JOIN guilds g ON g.id = spm.guild_id AND g.status = 'approved'
      WHERE spm.user_id = ? AND spm.status = 'active'
      ORDER BY s.name ASC
    `, [userId]);

    // Secondary: also include guilds from Discord membership (for members who haven't linked yet)
    let discordGuilds = [];
    let discordServers = [];
    if (accessToken) {
      try {
        const userGuilds = await getUserGuilds(accessToken);
        const userGuildIds = userGuilds.map(g => g.id);
        const linkedGuildIds = new Set(linkedGuilds.map(g => g.guild_id));

        // Only fetch guilds not already found via linked_accounts
        const missingIds = userGuildIds.filter(id => !linkedGuildIds.has(id));

        if (missingIds.length > 0) {
          const placeholders = missingIds.map(() => '?').join(',');
          discordGuilds = await db.query(`
            SELECT
              g.id, g.discord_guild_id as guild_id, g.name as guild_name,
              g.icon_url, g.status,
              COUNT(DISTINCT s.id) as server_count,
              COUNT(DISTINCT la.user_id) as player_count
            FROM guilds g
            LEFT JOIN servers s ON g.id = s.guild_id
            LEFT JOIN player_server_activity psa ON psa.server_id = s.id
            LEFT JOIN player_identities pi ON pi.id = psa.identity_id
            LEFT JOIN linked_accounts la ON la.identity_id = pi.id
            WHERE g.discord_guild_id IN (${placeholders})
              AND g.status = 'approved'
            GROUP BY g.id, g.discord_guild_id, g.name, g.icon_url, g.status
            HAVING COUNT(DISTINCT s.id) > 0
            ORDER BY g.name ASC
          `, missingIds);
          discordServers = await db.query(`
            SELECT g.discord_guild_id AS guild_id, s.id, s.name
            FROM guilds g
            JOIN servers s ON s.guild_id = g.id AND s.status = 'active'
            WHERE g.discord_guild_id IN (${placeholders})
              AND g.status = 'approved'
            ORDER BY s.name ASC
          `, missingIds);
        }
      } catch (discordErr) {
        // Discord API failure is non-fatal — linked accounts path is enough
        console.warn('⚠️ Discord guild fetch failed (non-fatal):', discordErr.message);
      }
    }

    const serversByGuild = new Map();
    for (const server of [...linkedServers, ...discordServers]) {
      const key = String(server.guild_id);
      const servers = serversByGuild.get(key) || [];
      if (!servers.some(existing => Number(existing.id) === Number(server.id))) {
        servers.push({ id: Number(server.id), name: server.name });
      }
      serversByGuild.set(key, servers);
    }
    const guilds = [...linkedGuilds, ...discordGuilds]
      .map(guild => ({
        ...guild,
        servers: serversByGuild.get(String(guild.guild_id)) || [],
      }))
      .filter(guild => guild.servers.length > 0);
    res.json({ success: true, guilds });
  } catch (error) {
    console.error('❌ Error fetching player guilds:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/player/discover/:guild_id
 * Returns only the authenticated player's game accounts backed by trusted,
 * active exact-server memberships in this guild. Historical identity clusters
 * are never returned as alternate-account suggestions.
 */
router.get('/discover/:guild_id', async (req, res) => {
  const db     = req.app.locals.db;
  const userId = req.user.id;
  const accessToken = req.user.access_token;
  const guildId = req.params.guild_id;

  try {
    if (!accessToken || !(await verifyGuildMembership(accessToken, guildId))) {
      return res.status(403).json({ error: 'Discord guild membership required for account discovery' });
    }
    const guild = await db.get('SELECT id FROM guilds WHERE discord_guild_id = ? AND status = ?', [guildId, 'approved']);
    if (!guild) return res.json({ success: true, linked: [], alts: [] });
    // Discord membership alone may discover the route, but account/server details
    // are disclosed only from trusted active memberships on this exact guild's servers.
    const linkedRows = await db.query(`
      SELECT
        pi.id,
        pi.platform,
        pi.player_id,
        pg.gamertag,
        MAX(psa.last_seen) AS last_seen,
        STRING_AGG(DISTINCT s.name, ', ') AS server_names
      FROM server_player_memberships spm
      JOIN linked_accounts la
        ON spm.source_link_id = la.id
       AND spm.user_id = la.user_id
       AND spm.identity_id = la.identity_id
       AND la.verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')
      JOIN player_identities pi ON pi.id = spm.identity_id
      JOIN servers s
        ON s.id = spm.server_id
       AND s.guild_id = spm.guild_id
       AND s.status = 'active'
      LEFT JOIN player_gamertags pg
        ON pg.identity_id = pi.id
       AND pg.server_id = spm.server_id
       AND pg.is_current_gamertag = 1
      LEFT JOIN player_server_activity psa
        ON psa.identity_id = pi.id
       AND psa.server_id = spm.server_id
      WHERE spm.user_id = ?
        AND spm.guild_id = ?
        AND spm.status = 'active'
      GROUP BY pi.id, pi.platform, pi.player_id, pg.gamertag
      ORDER BY MAX(psa.last_seen) DESC NULLS LAST
    `, [userId, guild.id]);

    // Historical identity clustering is not authorization to disclose alternates.
    const altRows = [];

    const mapAccount = r => ({
      id:          r.id,
      gamertag:    r.gamertag,
      platform:    r.platform,
      lastSeen:    r.last_seen,
      serverNames: r.server_names ? r.server_names.split(', ').filter(Boolean) : [],
    });

    res.json({
      success: true,
      linked: linkedRows.map(mapAccount),
      alts:   altRows.map(mapAccount),
    });
  } catch (err) {
    console.error('❌ Error fetching player accounts:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/player/search
 * Search for game accounts by gamertag
 */
router.get('/search', async (req, res) => {
  const { guildId, serverId, gamertag } = req.query;
  const db = req.app.locals.db;
  const userId = req.user.id;
  const accessToken = req.user.access_token;

  if (!guildId || !serverId || !gamertag) {
    return res.status(400).json({ error: 'guildId, serverId, and gamertag are required' });
  }
  if (!/^\d+$/.test(String(serverId)) || Number(serverId) < 1) {
    return res.status(400).json({ error: 'serverId must be a canonical server ID' });
  }

  if (!accessToken) {
    return res.status(401).json({
      error: 'Discord access token not found'
    });
  }

  try {
    // Verify user is a member of this guild
    const isMember = await verifyGuildMembership(accessToken, guildId);
    if (!isMember) {
      return res.status(403).json({
        error: 'You are not a member of this Discord server'
      });
    }

    // Convert Discord Guild ID to database ID
    const guild = await db.get(
      `SELECT g.id
       FROM guilds g
       JOIN servers s ON s.guild_id = g.id
       WHERE g.discord_guild_id = ?
         AND g.status = 'approved'
         AND s.id = ?
         AND s.status = 'active'`,
      [guildId, Number(serverId)]
    );
    if (!guild) {
      return res.json({ success: true, accounts: [] });
    }

    // Search for accounts — route through player_gamertags.server_id so players
    // whose player_server_activity row was wiped by a reset still appear.
    const query = `
      SELECT
        pi.id,
        pi.platform,
        pg.gamertag,
        s.id as server_id,
        s.name as server_name,
        psa.last_seen,
        conflict.user_id as conflict_user_id
      FROM player_identities pi
      JOIN player_gamertags pg ON pi.id = pg.identity_id AND pg.is_current_gamertag = 1
      JOIN servers s ON pg.server_id = s.id AND s.status = 'active'
      JOIN guilds g ON s.guild_id = g.id AND g.status = 'approved'
      LEFT JOIN player_server_activity psa ON pi.id = psa.identity_id AND psa.server_id = s.id
      LEFT JOIN LATERAL (
        SELECT spm.user_id
        FROM server_player_memberships spm
        JOIN linked_accounts la
          ON spm.source_link_id = la.id
         AND la.user_id = spm.user_id
         AND la.identity_id = spm.identity_id
         AND la.verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')
        WHERE spm.server_id = s.id
          AND spm.guild_id = g.id
          AND spm.identity_id = pi.id
          AND spm.status = 'active'
        ORDER BY spm.id
        LIMIT 1
      ) conflict ON TRUE
      WHERE s.guild_id = ? AND s.id = ? AND pg.gamertag LIKE ?
      ORDER BY psa.last_seen DESC NULLS LAST, s.id
      LIMIT 20
    `;

    const rows = await db.query(query, [guild.id, Number(serverId), `%${gamertag}%`]);

    const accounts = rows.map(account => ({
      id: account.id,
      gamertag: account.gamertag,
      platform: account.platform,
      lastSeen: account.last_seen,
      serverId: account.server_id,
      serverIds: [String(account.server_id)],
      serverName: account.server_name,
      serverNames: [account.server_name],
      isAlreadyLinked: account.conflict_user_id === userId,
      linkedToOther: Boolean(account.conflict_user_id && account.conflict_user_id !== userId)
    }));

    res.json({
      success: true,
      accounts
    });
  } catch (error) {
    console.error('❌ Error searching accounts:', error);
    res.status(500).json({ error: error.message });
  }
});

// Every endpoint below returns player-private or server statistical data.
// Identity routes are protected by router.param callbacks above; routes without
// an identity param install the same exact-server guard locally.

/**
 * GET /api/player/stats
 * Get stats for current user's linked accounts
 */
router.get('/stats', requirePlayerServerMembership, async (req, res) => {
  const db = req.app.locals.db;
  const userId = req.user.id;
  const serverId = req.playerServer.id;

  let query = `
    SELECT
      pi.id as identity_id,
      pi.platform,
      pi.platform_user_id,
      pg.gamertag,
      s.id::text as server_ids,
      s.name as server_names,
      MAX(psa.last_seen) as last_seen,
      g.discord_guild_id as guild_id,
      g.name as guild_name,
      (SELECT COUNT(*) FROM kill_events ke WHERE ke.killer_identity_id = pi.id AND ke.server_id = ?) as total_kills,
      (SELECT COUNT(*) FROM kill_events ke WHERE ke.victim_identity_id = pi.id AND ke.server_id = ?) as total_deaths,
      (SELECT COALESCE(SUM(duration), 0) FROM player_sessions ps WHERE ps.identity_id = pi.id AND ps.server_id = ?) as total_playtime
    FROM player_identities pi
    JOIN player_gamertags pg ON pi.id = pg.identity_id AND pg.is_current_gamertag = 1
    JOIN server_player_memberships spm ON spm.identity_id = pi.id
      AND spm.server_id = ? AND spm.user_id = ? AND spm.status = 'active'
    JOIN linked_accounts la ON la.id = spm.source_link_id
      AND la.identity_id = spm.identity_id AND la.user_id = spm.user_id
      AND la.verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')
    JOIN player_server_activity psa ON pi.id = psa.identity_id AND psa.server_id = spm.server_id
    JOIN servers s ON s.id = spm.server_id
    LEFT JOIN guilds g ON s.guild_id = g.id
    WHERE s.id = ?
  `;

  const params = [serverId, serverId, serverId, serverId, userId, serverId];

  query += ' GROUP BY pi.id, pi.platform, pi.platform_user_id, pg.gamertag, s.id, s.name, g.discord_guild_id, g.name';
  query += ' ORDER BY MAX(psa.last_seen) DESC';

  try {
    const rows = await db.query(query, params);
    res.json({
      success: true,
      accounts: rows.map(row => ({
        identityId: row.identity_id,
        platform: row.platform,
        platformUserId: row.platform_user_id,
        gamertag: row.gamertag,
        serverIds: row.server_ids ? row.server_ids.split(',') : [],
        serverNames: row.server_names ? row.server_names.split(',') : [],
        server_names: row.server_names, // kept for legacy frontend refs
        lastSeenAt: row.last_seen,
        guildId: row.guild_id,
        guildName: row.guild_name,
        guild_name: row.guild_name, // kept for legacy frontend ref
        identity_id: row.identity_id, // kept for legacy frontend refs
        total_kills: parseInt(row.total_kills) || 0,
        total_deaths: parseInt(row.total_deaths) || 0,
        total_playtime: parseInt(row.total_playtime) || 0
      }))
    });
  } catch (err) {
    console.error('❌ Error fetching player stats:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

/**
 * GET /api/player/leaderboard/:guild_id
 * Get leaderboard for a guild
 */
router.get('/leaderboard/:guild_id', requirePlayerServerMembership, async (req, res) => {
  const { sortBy = 'kills', limit = 50 } = req.query;
  const db = req.app.locals.db;
  const serverId = req.playerServer.id;

  try {
    // Validate sortBy
    const validSortFields = {
      'kills': 'total_kills',
      'deaths': 'total_deaths',
      'playtime': 'total_playtime'
    };

    const sortField = validSortFields[sortBy] || validSortFields['kills'];

    const query = `
      SELECT
        pi.id as identity_id,
        pi.platform,
        pg.gamertag,
        (SELECT COUNT(*) FROM kill_events ke WHERE ke.killer_identity_id = pi.id AND ke.server_id = ?) as total_kills,
        (SELECT COUNT(*) FROM kill_events ke WHERE ke.victim_identity_id = pi.id AND ke.server_id = ?) as total_deaths,
        COALESCE((SELECT SUM(ps.duration) FROM player_sessions ps WHERE ps.identity_id = pi.id AND ps.server_id = ?), 0) as total_playtime,
        la.user_id as "userId",
        u.username as "discordUsername",
        u.avatar
      FROM player_identities pi
      JOIN player_gamertags pg
        ON pi.id = pg.identity_id AND pg.server_id = ? AND pg.is_current_gamertag = 1
      JOIN player_server_activity psa ON pi.id = psa.identity_id AND psa.server_id = ?
      JOIN servers s ON psa.server_id = s.id AND s.status = 'active'
      JOIN guilds g ON g.id = s.guild_id AND g.status = 'approved'
      LEFT JOIN server_player_memberships spm
        ON spm.identity_id = pi.id
       AND spm.server_id = s.id
       AND spm.guild_id = s.guild_id
       AND spm.status = 'active'
      LEFT JOIN linked_accounts la
        ON spm.source_link_id = la.id
       AND la.identity_id = spm.identity_id
       AND la.user_id = spm.user_id
       AND la.verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')
      LEFT JOIN users u ON la.user_id = u.id
      WHERE s.id = ?
      GROUP BY pi.id, pg.gamertag, pi.platform, la.user_id, u.username, u.avatar
      ORDER BY ` + sortField + ` DESC
      LIMIT ?
    `;

    const rows = await db.query(query, [serverId, serverId, serverId, serverId, serverId, serverId, parseInt(limit)]);
    res.json({
      success: true,
      leaderboard: rows,
      sortBy
    });
  } catch (error) {
    console.error('❌ Error fetching leaderboard:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/player/sessions/:identity_id
 * Get session history for a player identity
 */
router.get('/sessions/:identity_id', async (req, res) => {
  const db = req.app.locals.db;
  const { identity_id: identityId } = req.params;
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const { serverId } = req.query;

  try {
    let query = `
      SELECT
        ps.*,
        s.name as server_name,
        s.platform
      FROM player_sessions ps
      JOIN servers s ON ps.server_id = s.id
      WHERE ps.identity_id = ?
    `;

    const params = [identityId];

    if (serverId) {
      query += ' AND ps.server_id = ?';
      params.push(serverId);
    }

    query += ' ORDER BY ps.login_at DESC LIMIT ?';
    params.push(limit);

    const rows = await db.query(query, params);
    res.json({
      success: true,
      sessions: rows
    });
  } catch (err) {
    console.error('❌ Error fetching sessions:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/**
 * GET /api/player/sessions/:identity_id/stats
 * Get session statistics for a player identity
 */
router.get('/sessions/:identity_id/stats', async (req, res) => {
  const db = req.app.locals.db;
  const { identity_id: identityId } = req.params;
  const { serverId } = req.query;

  try {
    let query = `
      SELECT
        COUNT(*) as total_sessions,
        SUM(duration) as total_playtime,
        AVG(duration) as avg_session_length,
        MAX(login_at) as last_played,
        s.name as server_name
      FROM player_sessions ps
      JOIN servers s ON ps.server_id = s.id
      WHERE ps.identity_id = ? AND ps.duration IS NOT NULL
    `;

    const params = [identityId];

    if (serverId) {
      query += ' AND ps.server_id = ?';
      params.push(serverId);
    }

    query += ' GROUP BY s.id, s.name';

    const rows = await db.query(query, params);
    res.json({
      success: true,
      stats: rows
    });
  } catch (err) {
    console.error('❌ Error fetching session stats:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/**
 * GET /api/player/health/:identity_id
 * Get player health status across all servers
 */
router.get('/health/:identity_id', async (req, res) => {
  const db = req.app.locals.db;
  const { identity_id: identityId } = req.params;
  const serverId = req.playerServer.id;

  try {
    const rows = await db.query(
      `SELECT
        phs.*,
        s.name as server_name,
        s.platform
      FROM player_health_status phs
      JOIN servers s ON phs.server_id = s.id
      WHERE phs.identity_id = ? AND phs.server_id = ?
      ORDER BY phs.last_updated DESC`,
      [identityId, serverId]
    );
    const playerMapSettings = await loadPlayerMapSettings(db, serverId);
    res.json({
      success: true,
      healthStatus: rows.map(row => projectPlayerHealthPayload({
        id: row.id,
        identityId: row.identity_id,
        serverId: row.server_id,
        serverName: row.server_name,
        platform: row.platform,
        currentHP: parseFloat(row.current_hp) || 0,
        maxHP: parseFloat(row.max_hp) || 100,
        status: row.status,
        lastPosition: row.last_position,
        posX: row.pos_x !== null ? parseFloat(row.pos_x) : null,
        posY: row.pos_y !== null ? parseFloat(row.pos_y) : null,
        posZ: row.pos_z !== null ? parseFloat(row.pos_z) : null,
        lastUpdated: row.last_updated
      }, playerMapSettings))
    });
  } catch (err) {
    console.error('❌ Error fetching health:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/**
 * GET /api/player/damage/:identity_id
 * Get recent damage events for a player
 */
router.get('/damage/:identity_id', async (req, res) => {
  const db = req.app.locals.db;
  const { identity_id: identityId } = req.params;
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const { serverId } = req.query;

  try {
    let query = `
      SELECT
        de.*,
        s.name as server_name
      FROM damage_events de
      JOIN servers s ON de.server_id = s.id
      WHERE de.victim_identity_id = ?
    `;

    const params = [identityId];

    if (serverId) {
      query += ' AND de.server_id = ?';
      params.push(serverId);
    }

    query += ' ORDER BY de.timestamp DESC LIMIT ?';
    params.push(limit);

    const rows = await db.query(query, params);
    // Map snake_case DB columns to camelCase for the frontend
    const damageEvents = rows.map(row => ({
      id: row.id,
      serverId: row.server_id,
      serverName: row.server_name,
      victimIdentityId: row.victim_identity_id,
      victimGamertag: row.victim_gamertag,
      victimPosition: row.victim_position,
      attackerIdentityId: row.attacker_identity_id,
      attackerGamertag: row.attacker_gamertag,
      attackerType: row.attacker_type,
      weapon: row.weapon,
      bodyPart: row.body_part,
      bodyPartId: row.body_part_id,
      damage: row.damage !== null ? parseFloat(row.damage) : null,
      hpBefore: row.hp_before !== null ? parseFloat(row.hp_before) : null,
      hpAfter: row.hp_after !== null ? parseFloat(row.hp_after) : null,
      timestamp: row.timestamp
    }));
    res.json({
      success: true,
      damageEvents,
      total: damageEvents.length
    });
  } catch (err) {
    console.error('❌ Error fetching damage events:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/**
 * Calculate threat level based on frequency and damage
 */
const THREAT_CRITICAL_THRESHOLD = 200;
const THREAT_HIGH_THRESHOLD = 100;
const THREAT_MEDIUM_THRESHOLD = 50;

function calculateThreatLevel(hit_count, avg_damage, max_damage) {
  const frequencyScore = hit_count * avg_damage;
  const maxDamageBonus = max_damage * 0.5;
  const threatScore = frequencyScore + maxDamageBonus;

  if (threatScore > THREAT_CRITICAL_THRESHOLD) return 'critical';
  if (threatScore > THREAT_HIGH_THRESHOLD) return 'high';
  if (threatScore > THREAT_MEDIUM_THRESHOLD) return 'medium';
  return 'low';
}

/**
 * GET /api/player/damage/:identity_id/weapons
 * Get weapon/damage type analysis for a player
 */
router.get('/damage/:identity_id/weapons', async (req, res) => {
  const db = req.app.locals.db;
  const { identity_id: identityId } = req.params;
  const { serverId, limit = 20, sortBy = 'hitCount' } = req.query;

  try {
    // Validate sortBy parameter
    const validSortOptions = {
      'hit_count': 'COUNT(*)',
      'total_damage': 'SUM(damage)',
      'avg_damage': 'AVG(damage)',
      'max_damage': 'MAX(damage)'
    };

    // orderBy is safe: value comes from a whitelist, not raw user input
    const orderBy = validSortOptions[sortBy] || 'COUNT(*)';

    let query = `
      SELECT
        weapon,
        attacker_type,
        COUNT(*) as hit_count,
        SUM(damage) as total_damage,
        AVG(damage) as avg_damage,
        MAX(damage) as max_damage,
        MIN(damage) as min_damage
      FROM damage_events
      WHERE victim_identity_id = ?
    `;

    const params = [identityId];

    if (serverId) {
      query += ' AND server_id = ?';
      params.push(serverId);
    }

    query += ` GROUP BY weapon, attacker_type ORDER BY ${orderBy} DESC LIMIT ?`;
    params.push(parseInt(limit));

    const rows = await db.query(query, params);
    const total_hits = rows.reduce((sum, row) => sum + parseInt(row.hit_count), 0);
    const weaponStats = rows.map(row => ({
      weapon: row.weapon,
      attackerType: row.attacker_type,
      hitCount: parseInt(row.hit_count),
      totalDamage: parseFloat(row.total_damage) || 0,
      avgDamage: parseFloat(row.avg_damage) || 0,
      maxDamage: parseFloat(row.max_damage) || 0,
      minDamage: parseFloat(row.min_damage) || 0,
      percentage: total_hits > 0 ? ((parseInt(row.hit_count) / total_hits) * 100).toFixed(1) : 0,
      threatLevel: calculateThreatLevel(parseInt(row.hit_count), parseFloat(row.avg_damage) || 0, parseFloat(row.max_damage) || 0)
    }));

    res.json({
      success: true,
      weapons: weaponStats,
      total_hits,
      sortedBy: sortBy
    });
  } catch (err) {
    console.error('❌ Error fetching weapon stats:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/**
 * GET /api/player/damage/:identity_id/weapons/category
 * Get weapon stats grouped by attacker type category
 */
router.get('/damage/:identity_id/weapons/category', async (req, res) => {
  const db = req.app.locals.db;
  const { identity_id: identityId } = req.params;
  const { serverId } = req.query;

  try {
    let query = `
      SELECT
        attacker_type,
        COUNT(*) as hit_count,
        SUM(damage) as total_damage,
        AVG(damage) as avg_damage
      FROM damage_events
      WHERE victim_identity_id = ?
    `;

    const params = [identityId];

    if (serverId) {
      query += ' AND server_id = ?';
      params.push(serverId);
    }

    query += ' GROUP BY attacker_type ORDER BY hit_count DESC';

    const rows = await db.query(query, params);
    const total_hits = rows.reduce((sum, row) => sum + parseInt(row.hit_count), 0);
    const categories = rows.map(row => ({
      attackerType: row.attacker_type,
      hitCount: parseInt(row.hit_count),
      totalDamage: parseFloat(row.total_damage) || 0,
      avgDamage: parseFloat(row.avg_damage) || 0,
      percentage: total_hits > 0 ? ((parseInt(row.hit_count) / total_hits) * 100).toFixed(1) : 0
    }));

    res.json({ success: true, categories, totalHits: total_hits });
  } catch (err) {
    console.error('❌ Error fetching weapon categories:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/**
 * GET /api/player/damage/:identity_id/top-threats
 * Get top threats (weapons/attackers) for a player
 */
router.get('/damage/:identity_id/top-threats', async (req, res) => {
  const db = req.app.locals.db;
  const { identity_id: identityId } = req.params;
  const { serverId, limit = 5 } = req.query;

  try {
    let query = `
      SELECT
        weapon,
        attacker_type,
        COUNT(*) as hit_count,
        SUM(damage) as total_damage,
        AVG(damage) as avg_damage
      FROM damage_events
      WHERE victim_identity_id = ?
    `;

    const params = [identityId];

    if (serverId) {
      query += ' AND server_id = ?';
      params.push(serverId);
    }

    query += ' GROUP BY weapon, attacker_type ORDER BY hit_count DESC LIMIT ?';
    params.push(parseInt(limit));

    const rows = await db.query(query, params);
    res.json({ success: true, topThreats: rows.map(row => ({
      weapon: row.weapon,
      attackerType: row.attacker_type,
      hitCount: parseInt(row.hit_count),
      totalDamage: parseFloat(row.total_damage) || 0,
      avgDamage: parseFloat(row.avg_damage) || 0
    })) });
  } catch (err) {
    console.error('❌ Error fetching top threats:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/**
 * GET /api/player/damage/:identity_id/weapon-types
 * Get damage grouped by general weapon categories
 */
router.get('/damage/:identity_id/weapon-types', async (req, res) => {
  const db = req.app.locals.db;
  const { identity_id: identityId } = req.params;
  const { serverId } = req.query;

  try {
    let query = `
      SELECT
        CASE
          WHEN weapon LIKE '%Melee%' THEN 'Melee'
          WHEN weapon LIKE '%Bullet%' OR weapon LIKE '%Shot%' THEN 'Firearms'
          WHEN weapon LIKE '%Explosion%' OR weapon LIKE '%Grenade%' THEN 'Explosives'
          WHEN weapon LIKE '%Fall%' THEN 'Fall Damage'
          WHEN weapon LIKE '%Bleed%' OR weapon LIKE '%Shock%' THEN 'Status Effects'
          ELSE 'Other'
        END as weapon_category,
        COUNT(*) as hit_count,
        SUM(damage) as total_damage,
        AVG(damage) as avg_damage
      FROM damage_events
      WHERE victim_identity_id = ?
    `;

    const params = [identityId];

    if (serverId) {
      query += ' AND server_id = ?';
      params.push(serverId);
    }

    query += ' GROUP BY weapon_category ORDER BY hit_count DESC';

    const rows = await db.query(query, params);
    const totalHits = rows.reduce((sum, row) => sum + parseInt(row.hit_count), 0);
    const weaponTypes = rows.map(row => ({
      weaponCategory: row.weapon_category,
      hitCount: parseInt(row.hit_count),
      totalDamage: parseFloat(row.total_damage) || 0,
      avgDamage: parseFloat(row.avg_damage) || 0,
      percentage: totalHits > 0 ? ((parseInt(row.hit_count) / totalHits) * 100).toFixed(1) : 0
    }));
    res.json({ success: true, weaponTypes });
  } catch (err) {
    console.error('❌ Error fetching weapon types:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/**
 * GET /api/player/damage/:identity_id/bodyparts
 * Get body part hit analysis for a player
 */
router.get('/damage/:identity_id/bodyparts', async (req, res) => {
  const db = req.app.locals.db;
  const { identity_id: identityId } = req.params;
  const { serverId } = req.query;

  try {
      let query = `
        SELECT
          body_part,
          body_part_id,
          COUNT(*) as hit_count,
          SUM(damage) as total_damage,
          AVG(damage) as avg_damage,
          MAX(damage) as max_damage,
          MIN(damage) as min_damage
        FROM damage_events
        WHERE victim_identity_id = ?
      `;

      const params = [identityId];

      if (serverId) {
        query += ' AND server_id = ?';
        params.push(serverId);
      }

      query += ' GROUP BY body_part, body_part_id ORDER BY hit_count DESC';

    const rows = await db.query(query, params);
    const total_hits = rows.reduce((sum, row) => sum + parseInt(row.hit_count), 0);
    const bodyPartStats = rows.map(row => ({
      bodyPart: row.body_part,
      bodyPartId: row.body_part_id,
      hitCount: parseInt(row.hit_count),
      totalDamage: parseFloat(row.total_damage) || 0,
      avgDamage: parseFloat(row.avg_damage) || 0,
      maxDamage: parseFloat(row.max_damage) || 0,
      minDamage: parseFloat(row.min_damage) || 0,
      percentage: total_hits > 0 ? ((parseInt(row.hit_count) / total_hits) * 100).toFixed(1) : 0
    }));
    res.json({
      success: true,
      bodyParts: bodyPartStats,
      totalHits: total_hits
    });
  } catch (err) {
    console.error('❌ Error fetching body part stats:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/**
 * GET /api/player/damage/:identity_id/bodyparts/:body_part
 * Get detailed stats for a specific body part
 */
router.get('/damage/:identity_id/bodyparts/:body_part', async (req, res) => {
  const db = req.app.locals.db;
  const { identity_id: identityId, body_part: bodyPart } = req.params;
  const { serverId, limit = 10 } = req.query;

  try {
    let query = `
      SELECT
        attacker_type,
        weapon,
        COUNT(*) as hit_count,
        AVG(damage) as avg_damage
      FROM damage_events
      WHERE victim_identity_id = ? AND body_part = ?
    `;

    const params = [identityId, bodyPart];

    if (serverId) {
      query += ' AND server_id = ?';
      params.push(serverId);
    }

    query += ' GROUP BY attacker_type, weapon ORDER BY hit_count DESC LIMIT ?';
    params.push(parseInt(limit));

    const rows = await db.query(query, params);
    res.json({ success: true, body_part: bodyPart, attacks: rows });
  } catch (err) {
    console.error('❌ Error fetching body part details:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/**
 * GET /api/player/health/:identity_id/:server_id
 * Get player health for a specific server
 */
router.get('/health/:identity_id/:server_id', async (req, res) => {
  const db = req.app.locals.db;
  const { identity_id: identityId, server_id: serverId } = req.params;

  try {
    const row = await db.get(
      `SELECT
        phs.*,
        s.name as server_name,
        s.platform
      FROM player_health_status phs
      JOIN servers s ON phs.server_id = s.id
      WHERE phs.identity_id = ? AND phs.server_id = ?`,
      [identityId, serverId]
    );
    if (!row) {
      return res.status(404).json({ error: 'No health data found for this server' });
    }
    const playerMapSettings = await loadPlayerMapSettings(db, req.playerServer.id);
    res.json({ success: true, health: projectPlayerHealthPayload(row, playerMapSettings) });
  } catch (err) {
    console.error('❌ Error fetching health:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/**
 * GET /api/player/territory/:identity_id
 * Get territory events for a player
 */
router.get('/territory/:identity_id', async (req, res) => {
  const db = req.app.locals.db;
  const { identity_id: identityId } = req.params;
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const { eventType, structureType } = req.query;
  const serverId = req.playerServer.id;

  try {
    const playerMapSettings = await loadPlayerMapSettings(db, serverId);
    if (!isPlayerMapFeatureEnabled(playerMapSettings, 'structures')) {
      return res.json({ success: true, territoryEvents: [], total: 0 });
    }
    let query = `
      SELECT
        te.*,
        s.name as server_name
      FROM territory_events te
      JOIN servers s ON te.server_id = s.id
      WHERE te.identity_id = ?
    `;

    const params = [identityId];

    if (serverId) {
      query += ' AND te.server_id = ?';
      params.push(serverId);
    }

    if (eventType) {
      query += ' AND te.event_type = ?';
      params.push(eventType);
    }

    if (structureType) {
      query += ' AND te.structure_type = ?';
      params.push(structureType);
    }

    query += ' ORDER BY te.timestamp DESC LIMIT ?';
    params.push(limit);

    const rows = await db.query(query, params);
    res.json({ success: true, territoryEvents: rows.map(row => ({
      id: row.id,
      serverId: row.server_id,
      identityId: row.identity_id,
      playerGamertag: row.player_gamertag,
      eventType: row.event_type,
      structureType: row.structure_type,
      structurePart: row.structure_part,
      toolUsed: row.tool_used,
      posX: row.pos_x,
      posY: row.pos_y,
      posZ: row.pos_z,
      timestamp: row.timestamp,
      serverName: row.server_name
    })), total: rows.length });
  } catch (err) {
    console.error('❌ Error fetching territory events:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/**
 * GET /api/player/territory/:identity_id/stats
 * Get territory statistics for a player
 */
router.get('/territory/:identity_id/stats', async (req, res) => {
  const db = req.app.locals.db;
  const { identity_id: identityId } = req.params;
  const serverId = req.playerServer.id;

  try {
    const playerMapSettings = await loadPlayerMapSettings(db, serverId);
    if (!isPlayerMapFeatureEnabled(playerMapSettings, 'structures')) {
      return res.json({ success: true, stats: [] });
    }
    let query = `
      SELECT
        event_type,
        structure_type,
        COUNT(*) as count
      FROM territory_events
      WHERE identity_id = ?
    `;

    const params = [identityId];

    if (serverId) {
      query += ' AND server_id = ?';
      params.push(serverId);
    }

    query += ' GROUP BY event_type, structure_type ORDER BY count DESC';

    const rows = await db.query(query, params);
    res.json({ success: true, stats: rows.map(row => ({
      eventType: row.event_type,
      structureType: row.structure_type,
      count: parseInt(row.count)
    })) });
  } catch (err) {
    console.error('❌ Error fetching territory stats:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/**
 * GET /api/player/map-data/:identity_id
 * Aggregated positional data for the player map: territory events, deaths,
 * position trail snapshots, and last known position.
 */
router.get('/map-data/:identity_id', async (req, res) => {
  const db = req.app.locals.db;
  const identityId = req.playerServer.identityId;
  const serverId = req.playerServer.id;

  try {
    const serverParam = [serverId];
    const playerMapSettings = await loadPlayerMapSettings(db, serverId);

    // Territory events (structures built/placed/mounted)
    const territoryRows = await db.all(
      `SELECT te.event_type, te.structure_type, te.structure_part, te.tool_used,
              te.pos_x, te.pos_y, te.pos_z, te.timestamp,
              s.name AS server_name, s.platform_server_id AS server_platform_id
       FROM territory_events te
       JOIN servers s ON s.id = te.server_id
       WHERE te.identity_id = ? AND te.server_id = ?
         AND te.pos_x IS NOT NULL AND te.pos_y IS NOT NULL
       ORDER BY te.timestamp DESC
       LIMIT 2000`,
      [identityId, ...serverParam]
    );

    // Death locations
    const deathRows = await db.all(
      `SELECT de.death_type, de.pos_x, de.pos_y, de.pos_z, de.timestamp,
              s.name AS server_name
       FROM player_death_events de
       JOIN servers s ON s.id = de.server_id
       WHERE de.identity_id = ? AND de.server_id = ?
         AND de.pos_x IS NOT NULL AND de.pos_y IS NOT NULL
       ORDER BY de.timestamp DESC
       LIMIT 500`,
      [identityId, ...serverParam]
    );

    // Purchase records prove requested/provisioned placement, not current live presence.
    const purchaseRows = await db.all(
      `SELECT soi.id AS placement_id,
              COALESCE(soi.item_name_snapshot, si.name, soi.item_class_snapshot, 'Purchased item') AS item_name,
              COALESCE(soi.item_class_snapshot, si.item_class) AS item_class,
              soi.spawn_method, soi.quantity, soi.pos_x, soi.pos_y, soi.pos_z,
              soi.ypr_x, soi.ypr_y, soi.ypr_z, soi.is_active,
              so.checked_out_at AS completed_at
       FROM shop_order_items soi
       JOIN shop_orders so ON so.id = soi.order_id
       LEFT JOIN shop_items si ON si.id = soi.shop_item_id
       WHERE so.identity_id = ?
         AND so.server_id = ?
         AND so.status = 'completed'
       ORDER BY so.checked_out_at DESC NULLS LAST, soi.id DESC
       LIMIT 500`,
      [identityId, serverId]
    );

    // Position trail (most recent 500 snapshots, oldest first for polyline drawing)
    const trailRows = await db.all(
      `SELECT recent.pos_x, recent.pos_y, recent.pos_z, recent.timestamp
       FROM (
         SELECT ps.id, ps.pos_x, ps.pos_y, ps.pos_z, ps.timestamp
         FROM player_position_snapshots ps
         WHERE ps.identity_id = ? AND ps.server_id = ?
           AND ps.pos_x IS NOT NULL AND ps.pos_y IS NOT NULL
         ORDER BY ps.timestamp DESC, ps.id DESC
         LIMIT 500
       ) recent
       ORDER BY recent.timestamp ASC, recent.id ASC`,
      [identityId, ...serverParam]
    );

    // Last known position from the regular PlayerList snapshots. Combat health
    // timestamps remain independent so a newer location cannot suppress an
    // older health/status event discovered during a historical scan.
    const lastPosition = await db.get(
      `SELECT ps.pos_x, ps.pos_y, ps.pos_z, ps.timestamp,
              s.name AS server_name, s.platform_server_id AS server_platform_id
       FROM player_position_snapshots ps
       JOIN servers s ON s.id = ps.server_id
       WHERE ps.identity_id = ? AND ps.server_id = ?
         AND ps.pos_x IS NOT NULL AND ps.pos_y IS NOT NULL
       ORDER BY ps.timestamp DESC, ps.id DESC
       LIMIT 1`,
      [identityId, ...serverParam]
    );

    // Look up player's current gamertag for display
    const playerInfo = await db.get(
      `SELECT pg.gamertag FROM player_gamertags pg
       WHERE pg.identity_id = ? AND pg.server_id = ? AND pg.is_current_gamertag = 1
       LIMIT 1`,
      [identityId, serverId]
    );

    res.json(projectPlayerMapPayload({
      success: true,
      playerName: playerInfo ? playerInfo.gamertag : identityId,
      territory: territoryRows.map(r => ({
        eventType: r.event_type,
        structureType: r.structure_type,
        structurePart: r.structure_part,
        toolUsed: r.tool_used,
        posX: r.pos_x !== null ? parseFloat(r.pos_x) : null,
        posY: r.pos_y !== null ? parseFloat(r.pos_y) : null,
        posZ: r.pos_z !== null ? parseFloat(r.pos_z) : null,
        position: admTupleToWorld(r),
        timestamp: r.timestamp,
        serverName: r.server_name,
        serverPlatformId: r.server_platform_id
      })),
      deaths: deathRows.map(r => ({
        deathType: r.death_type,
        posX: r.pos_x !== null ? parseFloat(r.pos_x) : null,
        posY: r.pos_y !== null ? parseFloat(r.pos_y) : null,
        posZ: r.pos_z !== null ? parseFloat(r.pos_z) : null,
        position: admTupleToWorld(r),
        timestamp: r.timestamp,
        serverName: r.server_name
      })),
      trail: trailRows.map(r => ({
        posX: parseFloat(r.pos_x),
        posY: parseFloat(r.pos_y),
        posZ: parseFloat(r.pos_z),
        position: admTupleToWorld(r),
        timestamp: r.timestamp
      })),
      purchases: purchaseRows.map(r => ({
        placementId: r.placement_id,
        itemName: r.item_name,
        itemClass: r.item_class,
        spawnMethod: r.spawn_method,
        quantity: Number(r.quantity || 1),
        posX: Number(r.pos_x),
        posY: Number(r.pos_y),
        posZ: Number(r.pos_z),
        orientation: {
          yaw: Number(r.ypr_x || 0),
          pitch: Number(r.ypr_y || 0),
          roll: Number(r.ypr_z || 0)
        },
        lifecycleState: Number(r.is_active) === 1 ? 'recorded_active' : 'recorded_inactive',
        completedAt: r.completed_at,
        presence: 'unknown'
      })),
      lastPosition: lastPosition ? {
        posX: lastPosition.pos_x !== null ? parseFloat(lastPosition.pos_x) : null,
        posY: lastPosition.pos_y !== null ? parseFloat(lastPosition.pos_y) : null,
        posZ: lastPosition.pos_z !== null ? parseFloat(lastPosition.pos_z) : null,
        position: admTupleToWorld(lastPosition),
        timestamp: lastPosition.timestamp,
        serverName: lastPosition.server_name,
        serverPlatformId: lastPosition.server_platform_id
      } : null
    }, playerMapSettings));

  } catch (err) {
    console.error('❌ Error fetching player map data:', err);
    res.status(500).json({ success: false, error: 'Database error', details: err.message });
  }
});

/**
 * GET /api/player/favorite-weapons/:identity_id
 * Get kill counts by weapon for a player (sorted by kills descending)
 */
router.get('/favorite-weapons/:identity_id', async (req, res) => {
  const db = req.app.locals.db;
  const { identity_id: identityId } = req.params;
  const limit = Math.min(parseInt(req.query.limit) || 5, 20);
  const serverId = req.playerServer.id;

  try {
    const query = `
      SELECT
        weapon,
        COUNT(*) as kill_count,
        AVG(distance) as avg_distance,
        MAX(distance) as max_distance
      FROM kill_events
      WHERE killer_identity_id = ? AND server_id = ?
        AND weapon IS NOT NULL
      GROUP BY weapon
      ORDER BY kill_count DESC
      LIMIT ?
    `;

    const rows = await db.query(query, [identityId, serverId, limit]);
    res.json({ success: true, weapons: rows.map(row => ({
      weapon: row.weapon,
      killCount: parseInt(row.kill_count),
      avgDistance: row.avg_distance ? parseFloat(row.avg_distance) : null,
      maxDistance: row.max_distance ? parseFloat(row.max_distance) : null
    })) });
  } catch (err) {
    console.error('❌ Error fetching favorite weapons:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/**
 * GET /api/player/recent-kills/:identity_id
 * Get recent kills for a player
 */
router.get('/recent-kills/:identity_id', async (req, res) => {
  const db = req.app.locals.db;
  const { identity_id: identityId } = req.params;
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  const serverId = req.playerServer.id;

  try {
    const query = `
      SELECT
        ke.*,
        s.name as server_name
      FROM kill_events ke
      JOIN servers s ON ke.server_id = s.id
      WHERE ke.killer_identity_id = ? AND ke.server_id = ?
      ORDER BY ke.timestamp DESC
      LIMIT ?
    `;

    const rows = await db.query(query, [identityId, serverId, limit]);
    const kills = rows.map(row => ({
      id: row.id,
      serverId: row.server_id,
      serverName: row.server_name,
      killerIdentityId: row.killer_identity_id,
      killerGamertag: row.killer_gamertag,
      killerPosition: row.killer_position,
      victimIdentityId: row.victim_identity_id,
      victimGamertag: row.victim_gamertag,
      victimPosition: row.victim_position,
      weapon: row.weapon,
      distance: row.distance,
      timestamp: row.timestamp
    }));
    res.json({ success: true, kills });
  } catch (err) {
    console.error('❌ Error fetching recent kills:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/**
 * GET /api/player/recent-deaths/:identity_id
 * Get recent deaths for a player
 */
router.get('/recent-deaths/:identity_id', async (req, res) => {
  const db = req.app.locals.db;
  const { identity_id: identityId } = req.params;
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  const serverId = req.playerServer.id;

  try {
    const query = `
      SELECT
        ke.*,
        s.name as server_name
      FROM kill_events ke
      JOIN servers s ON ke.server_id = s.id
      WHERE ke.victim_identity_id = ? AND ke.server_id = ?
      ORDER BY ke.timestamp DESC
      LIMIT ?
    `;

    const rows = await db.query(query, [identityId, serverId, limit]);
    const deaths = rows.map(row => ({
      id: row.id,
      serverId: row.server_id,
      serverName: row.server_name,
      killerIdentityId: row.killer_identity_id,
      killerGamertag: row.killer_gamertag,
      killerPosition: row.killer_position,
      victimIdentityId: row.victim_identity_id,
      victimGamertag: row.victim_gamertag,
      victimPosition: row.victim_position,
      weapon: row.weapon,
      distance: row.distance,
      timestamp: row.timestamp
    }));
    res.json({ success: true, deaths });
  } catch (err) {
    console.error('❌ Error fetching recent deaths:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/**
 * GET /api/player/location-heatmap/:identity_id
 * Get kill/death location data for a player
 */
router.get('/location-heatmap/:identity_id', async (req, res) => {
  const db = req.app.locals.db;
  const { identity_id: identityId } = req.params;
  const serverId = req.playerServer.id;

  try {
    const [kills, deaths] = await Promise.all([
      db.query(
        `SELECT killer_position as position, 'kill' as type FROM kill_events WHERE killer_identity_id = ? AND server_id = ? AND killer_position IS NOT NULL`,
        [identityId, serverId]
      ),
      db.query(
        `SELECT victim_position as position, 'death' as type FROM kill_events WHERE victim_identity_id = ? AND server_id = ? AND victim_position IS NOT NULL`,
        [identityId, serverId]
      )
    ]);

    res.json({ success: true, kills, deaths });
  } catch (err) {
    console.error('❌ Error fetching locations:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/**
 * GET /api/player/playtime-breakdown/:identity_id
 * Get playtime broken down by hour of day
 */
router.get('/playtime-breakdown/:identity_id', async (req, res) => {
  const db = req.app.locals.db;
  const { identity_id: identityId } = req.params;
  const serverId = req.playerServer.id;

  try {
    const query = `
      SELECT
        EXTRACT(HOUR FROM login_at)::int as hour,
        COUNT(*) as sessions,
        SUM(duration) as totalTime
      FROM player_sessions
      WHERE identity_id = ? AND server_id = ?
        AND login_at IS NOT NULL
        AND duration IS NOT NULL
      GROUP BY EXTRACT(HOUR FROM login_at)
      ORDER BY hour ASC
    `;

    const rows = await db.query(query, [identityId, serverId]);
    const breakdown = rows.map(row => ({
      hour: parseInt(row.hour),
      sessions: row.sessions,
      minutes: Math.floor((row.totalTime || 0) / 60)
    }));
    res.json({ success: true, breakdown });
  } catch (err) {
    console.error('❌ Error fetching playtime breakdown:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/**
 * GET /api/player/achievements/:identity_id
 * Get achievements for a player (and calculate new ones)
 */
router.get('/achievements/:identity_id', async (req, res) => {
  const db = req.app.locals.db;
  const { identity_id: identityId } = req.params;
  const serverId = req.playerServer.id;

  try {
    // Achievements are read only from server-tagged rows. The legacy calculator
    // is intentionally not invoked because its uniqueness key is global and
    // cannot safely create per-server achievements without a schema migration.
    const rows = await db.query(
      `SELECT * FROM player_achievements
       WHERE identity_id = ? AND (metadata::jsonb)->>'server_id' = ?
       ORDER BY achieved_at DESC`,
      [identityId, String(serverId)]
    );
    res.json({ success: true, achievements: rows.map(row => ({
      id: row.id,
      identityId: row.identity_id,
      achievementType: row.achievement_type,
      achievementName: row.achievement_name,
      achievedAt: row.achieved_at,
      metadata: row.metadata
    })) });
  } catch (err) {
    console.error('❌ Error fetching achievements:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/**
 * GET /api/player/achievement-progress/:identity_id
 * Get progress towards incomplete achievements
 */
router.get('/achievement-progress/:identity_id', async (req, res) => {
  const db = req.app.locals.db;
  const { identity_id: identityId } = req.params;
  const serverId = req.playerServer.id;

  try {
    const stats = await loadAchievementStats(db, identityId, serverId);
    res.json({
      success: true,
      stats,
      achievements: buildAchievementProgress(stats),
      progression: calculatePlayerProgression(stats),
    });
  } catch (err) {
    console.error('❌ Error fetching achievement progress:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/**
 * GET /api/player/performance-timeline/:identity_id
 * Get kill count per day for a player over the last N days
 */
router.get('/performance-timeline/:identity_id', async (req, res) => {
  const db = req.app.locals.db;
  const { identity_id: identityId } = req.params;
  const days = Math.min(parseInt(req.query.days) || 30, 90);
  const serverId = req.playerServer.id;

  try {
    const query = `
      SELECT
        DATE(timestamp) as date,
        COUNT(*) as kills
      FROM kill_events
      WHERE killer_identity_id = ? AND server_id = ?
        AND timestamp >= NOW() - ($3 * INTERVAL '1 day')
      GROUP BY DATE(timestamp)
      ORDER BY date ASC
    `;

    const rows = await db.query(query, [identityId, serverId, days]);
    res.json({ success: true, timeline: rows.map(row => ({ date: row.date, kills: parseInt(row.kills) })), days });
  } catch (err) {
    console.error('❌ Error fetching performance timeline:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

/**
 * GET /api/player/death-stats/:identity_id
 * Returns breakdown of how this player has died (cause of death, zombie deaths, bleed outs, etc.)
 * and unconscious event counts.
 */
router.get('/death-stats/:identity_id', async (req, res) => {
  const db = req.app.locals.db;
  const { identity_id: identityId } = req.params;
  const serverId = req.playerServer.id;

  try {
    // Death cause breakdown
    const deathRows = await db.query(
      `SELECT death_type, COUNT(*) as count
       FROM player_death_events
       WHERE identity_id = ? AND server_id = ?
       GROUP BY death_type
       ORDER BY count DESC`,
      [identityId, serverId]
    ).catch(() => []);

    // Most common NPC killers (zombie types)
    const npcKillers = await db.query(
      `SELECT killed_by, COUNT(*) as count
       FROM player_death_events
       WHERE identity_id = ? AND server_id = ? AND death_type = 'killed_by_npc' AND killed_by IS NOT NULL
       GROUP BY killed_by
       ORDER BY count DESC
       LIMIT 5`,
      [identityId, serverId]
    ).catch(() => []);

    // Unconscious event counts
    const unconsciousRow = await db.get(
      `SELECT
         COUNT(*) FILTER (WHERE event_type = 'unconscious') AS times_knocked_out,
         COUNT(*) FILTER (WHERE event_type = 'regained_consciousness') AS times_revived,
         COUNT(*) FILTER (WHERE event_type = 'disconnect_unconscious') AS times_disconnected_ko
       FROM player_unconscious_events
       WHERE identity_id = ? AND server_id = ?`,
      [identityId, serverId]
    ).catch(() => null);

    res.json({
      success: true,
      deathBreakdown: deathRows.map(r => ({ deathType: r.death_type, count: parseInt(r.count) })),
      npcKillers: npcKillers.map(r => ({ killedBy: r.killed_by, count: parseInt(r.count) })),
      unconscious: {
        timesKnockedOut: parseInt(unconsciousRow?.times_knocked_out || 0),
        timesRevived: parseInt(unconsciousRow?.times_revived || 0),
        timesDisconnectedWhileKO: parseInt(unconsciousRow?.times_disconnected_ko || 0)
      }
    });
  } catch (err) {
    console.error('❌ Error fetching death stats:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/player/emotes/:identityId
// Returns emote usage statistics for a player identity.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns total emote count, top-10 emote types by frequency, and the last
 * 20 emote events for the given identity.
 */
router.get('/emotes/:identityId', async (req, res) => {
  const db         = req.app.locals.db;
  const identityId = parseInt(req.params.identityId, 10);
  const serverId = req.playerServer.id;

  if (isNaN(identityId)) {
    return res.status(400).json({ ok: false, error: 'Invalid identityId' });
  }

  try {
    const totalRow = await db.get(
      'SELECT COUNT(*)::int AS cnt FROM player_emote_events WHERE identity_id = ? AND server_id = ?',
      [identityId, serverId]
    );

    const topEmotes = await db.query(
      `SELECT emote_type, COUNT(*)::int AS count
       FROM player_emote_events
       WHERE identity_id = ? AND server_id = ?
       GROUP BY emote_type
       ORDER BY count DESC
       LIMIT 10`,
      [identityId, serverId]
    );

    const recent = await db.query(
      `SELECT emote_type, item_name, pos_x, pos_z, timestamp
       FROM player_emote_events
       WHERE identity_id = ? AND server_id = ?
       ORDER BY timestamp DESC
       LIMIT 20`,
      [identityId, serverId]
    );

    res.json({
      ok:        true,
      total:     totalRow?.cnt || 0,
      topEmotes,
      recent,
    });
  } catch (err) {
    console.error('❌ /api/player/emotes error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/player/session-analytics
// Server-wide session analytics used by the Dashboard's Session Analytics section.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/player/session-analytics?serverId=&days=30
 *
 * Returns:
 *   avgSessionMinutes  — average session duration in minutes
 *   totalSessions      — total session count in the window
 *   dailyActive        — distinct players per calendar day
 *   peakHours          — session starts by hour-of-day (0–23)
 *   newPlayersPerDay   — first-ever session per player, grouped by day
 */
router.get('/session-analytics', requirePlayerServerMembership, async (req, res) => {
  const db = req.app.locals.db;
  const { serverId, days = 30 } = req.query;

  if (!serverId) return res.status(400).json({ ok: false, error: 'serverId required' });

  const window = Math.max(1, Math.min(365, parseInt(days, 10) || 30));

  try {
    const server = await db.get(
      'SELECT id FROM servers WHERE id = ?',
      [serverId]
    );
    if (!server) return res.status(404).json({ ok: false, error: 'Server not found' });

    const sid   = server.id;
    const since = `login_at >= NOW() - ($2 || ' days')::INTERVAL`;

    // Average session length and total count
    const summaryRow = await db.get(
      `SELECT
         ROUND(AVG(duration) / 60.0, 1)::float AS avg_minutes,
         COUNT(*)::int                          AS total
       FROM player_sessions
       WHERE server_id = $1 AND ${since} AND duration IS NOT NULL`,
      [sid, window]
    );

    // Daily active players (distinct identity_ids per day)
    const dailyActive = await db.query(
      `SELECT
         DATE(login_at)                      AS date,
         COUNT(DISTINCT identity_id)::int    AS count
       FROM player_sessions
       WHERE server_id = $1 AND ${since}
       GROUP BY 1
       ORDER BY 1 ASC`,
      [sid, window]
    );

    // Peak hours (session starts by hour-of-day, all-time for this server)
    const peakHours = await db.query(
      `SELECT
         EXTRACT(HOUR FROM login_at)::int    AS hour,
         COUNT(*)::int                       AS count
       FROM player_sessions
       WHERE server_id = $1
       GROUP BY 1
       ORDER BY 1 ASC`,
      [sid]
    );

    // New players per day (first session per identity on this server)
    const newPlayersPerDay = await db.query(
      `SELECT
         DATE(first_seen) AS date,
         COUNT(*)::int    AS count
       FROM (
         SELECT identity_id, MIN(login_at) AS first_seen
         FROM player_sessions
         WHERE server_id = $1
         GROUP BY identity_id
       ) AS first_sessions
       WHERE first_seen >= NOW() - ($2 || ' days')::INTERVAL
       GROUP BY 1
       ORDER BY 1 ASC`,
      [sid, window]
    );

    res.json({
      ok:                 true,
      avgSessionMinutes:  summaryRow?.avg_minutes || 0,
      totalSessions:      summaryRow?.total       || 0,
      dailyActive:        dailyActive.map(r => ({ date: r.date, count: r.count })),
      peakHours:          peakHours.map(r => ({ hour: r.hour, count: r.count })),
      newPlayersPerDay:   newPlayersPerDay.map(r => ({ date: r.date, count: r.count })),
    });
  } catch (err) {
    console.error('❌ /api/player/session-analytics error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
