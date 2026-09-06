const express = require('express');
const router = express.Router();
const { requireRole } = require('../middleware/auth');
const { encryptToken } = require('../utils/encryption');
const { sanitizeServerName, sanitizeForLog } = require('../utils/textSanitizer');
const nitradoService = require('../services/nitradoService');
const { sendExternalApiError } = require('../utils/externalApiResponse');

/**
 * POST /api/guilds/:guildId/token
 * Save/update a guild-scoped Nitrado token from the dashboard.
 * Allowed for website admins or guild owners.
 */
router.post('/:guildId/token', requireRole('owner'), async (req, res) => {
  const { guildId } = req.params;
  const { token } = req.body || {};
  const db = req.app.locals.db;

  if (!token || typeof token !== 'string' || !token.trim()) {
    return res.status(400).json({ success: false, error: 'Token is required' });
  }

  try {
    const guild = await db.get(
      'SELECT id, name, status FROM guilds WHERE discord_guild_id = ? LIMIT 1',
      [guildId]
    );
    if (!guild) {
      return res.status(404).json({
        success: false,
        error: 'Guild not found. Ask an admin to add/approve this Discord server first.'
      });
    }
    if (guild.status === 'disabled') {
      return res.status(403).json({
        success: false,
        error: 'This Discord server is disabled and cannot register a Nitrado account'
      });
    }

    // Validate both service access and the stable Nitrado account identity.
    const [services, identity] = await Promise.all([
      nitradoService.listServices(token.trim()),
      nitradoService.getAuthenticatedUser(token.trim()),
    ]);

    if (!Array.isArray(services)) {
      return res.status(400).json({ success: false, error: 'Invalid Nitrado API token' });
    }
    const nitradoUserId = identity.id;
    if (!nitradoUserId) {
      return res.status(400).json({ success: false, error: 'Token does not expose a stable Nitrado user ID' });
    }

    const encryptedToken = encryptToken(token.trim());
    await db.transaction(async () => {
      await db.get('SELECT id FROM guilds WHERE id = ? FOR UPDATE', [guild.id]);
      const conflicting = await db.get(
        'SELECT guild_id FROM guild_tokens WHERE nitrado_user_id = ? AND guild_id <> ? LIMIT 1',
        [nitradoUserId, guild.id]
      );
      if (conflicting) {
        const conflict = new Error('Nitrado account is already assigned to another Discord guild');
        conflict.statusCode = 409;
        throw conflict;
      }
      const existing = await db.get(
        `SELECT nitrado_user_id FROM guild_tokens
         WHERE guild_id = ? AND token_type = 'nitrado' LIMIT 1`,
        [guild.id]
      );
      if (existing?.nitrado_user_id && String(existing.nitrado_user_id) !== nitradoUserId) {
        const conflict = new Error('This Discord guild is already assigned to a different Nitrado account');
        conflict.statusCode = 409;
        throw conflict;
      }
      await db.run(
        `INSERT INTO guild_tokens (guild_id, token_hash, token_type, nitrado_user_id)
         VALUES (?, ?, 'nitrado', ?)
         ON CONFLICT(guild_id, token_type) DO UPDATE SET
           token_hash = EXCLUDED.token_hash,
           nitrado_user_id = EXCLUDED.nitrado_user_id,
           last_used = CURRENT_TIMESTAMP`,
        [guild.id, encryptedToken, nitradoUserId]
      );
    });

    res.json({
      success: true,
      message: 'Token saved successfully',
      guild: { id: guildId, name: guild.name, status: guild.status }
    });
  } catch (err) {
    if (err.statusCode === 409 || err.code === '23505') {
      return res.status(409).json({
        success: false,
        error: err.statusCode === 409 ? err.message : 'Nitrado account ownership conflict'
      });
    }
    if (err.category === 'authentication') {
      return res.status(400).json({ success: false, error: 'Invalid Nitrado API token' });
    }
    console.error('❌ Error saving guild token:', err.code || err.name);
    return sendExternalApiError(res, err, 'Nitrado');
  }
});

/**
 * GET /api/guilds/:guildId/token-status
 * Check if guild has a token (for frontend)
 */
router.get('/:guildId/token-status', requireRole('owner'), async (req, res) => {
  const { guildId } = req.params;
  const db = req.app.locals.db;

  try {
    const row = await db.get(`
      SELECT gt.token_hash as nitradoToken
      FROM guilds g
      LEFT JOIN guild_tokens gt ON g.id = gt.guild_id AND gt.token_type = 'nitrado'
      WHERE g.discord_guild_id = ?
      AND g.status = 'approved'
      AND gt.nitrado_user_id IS NOT NULL
      ORDER BY gt.created_at DESC
      LIMIT 1
    `, [guildId]);

    res.json({
      success: true,
      hasToken: !!row?.nitradoToken
    });
  } catch (err) {
    return res.status(500).json({ error: 'Database error' });
  }
});

/**
 * GET /api/guilds/:guildId/servers
 * Get servers for a specific guild
 * Returns only servers the actor can operate: guild owner/admin or an explicit
 * active server assignment. Player-facing access uses the player routes.
 */
router.get('/:guildId/servers', async (req, res) => {
  const { guildId } = req.params;
  const db = req.app.locals.db;

  try {
    const rows = await db.query(`
      SELECT
        s.id,
        s.platform_server_id as nitrado_server_id,
        s.name as server_name,
        s.platform,
        s.guild_id as guildDbId,
        CASE
          WHEN gr.role IN ('owner', 'admin') THEN gr.role
          ELSE sra.role
        END AS access_role
      FROM servers s
      JOIN guilds g ON s.guild_id = g.id
      LEFT JOIN guild_roles gr
        ON gr.guild_id = g.id AND gr.user_id = ?
      LEFT JOIN server_role_assignments sra
        ON sra.server_id = s.id
       AND sra.guild_id = g.id
       AND sra.user_id = ?
       AND sra.status = 'active'
      WHERE g.discord_guild_id = ?
        AND g.status = 'approved'
        AND s.status = 'active'
        AND (
          gr.role IN ('owner', 'admin')
          OR sra.id IS NOT NULL
        )
      ORDER BY s.name ASC
    `, [
      req.user.id,
      req.user.id,
      guildId,
    ]);

    // Add sanitized display names while preserving original. Respect a per-server
    // custom name stored in server_features (feature_name='custom_name'). Also include
    // currently-online players and basic stats when available.
    const servers = [];
    for (const server of rows) {
      try {
        const feature = await db.get(
          `SELECT config FROM server_features WHERE server_id = ? AND feature_name = 'custom_name' LIMIT 1`,
          [server.id]
        );
        let custom = null;
        if (feature && feature.config) {
          try { custom = JSON.parse(feature.config).value; } catch (e) { /* ignore malformed */ }
        }

        const display = (custom && String(custom).trim()
          ? sanitizeServerName(String(custom))
          : sanitizeServerName(server.server_name)) || String(server.nitrado_server_id);

        // Fetch online players from server_online_cache (if present) and enrich with player_stats
        let onlinePlayers = [];
        try {
          const rowsPlayers = await db.query(
            `SELECT cache.gamertag, cache.login_at, cache.updated_at, cache.identity_id
               FROM server_online_cache cache
               JOIN server_online_cache_snapshots snapshot
                 ON snapshot.server_id = cache.server_id
              WHERE cache.server_id = ?
                AND snapshot.source_observed_at >= clock_timestamp() - INTERVAL '120 minutes'
                AND snapshot.source_observed_at <= clock_timestamp() + INTERVAL '5 minutes'
              ORDER BY cache.login_at ASC`,
            [server.id]
          );

          for (const p of rowsPlayers) {
            let stats = null;
            try {
              stats = await db.get(
                `SELECT kills, deaths, total_playtime_seconds FROM player_stats WHERE identity_id = ? AND server_id = ? LIMIT 1`,
                [p.identity_id, server.id]
              );
            } catch (e) {
              // ignore per-player stat lookup errors
            }

            onlinePlayers.push({
              gamertag: sanitizeServerName(p.gamertag),
              login_at: p.login_at,
              updated_at: p.updated_at,
              kills: stats ? stats.kills || 0 : 0,
              deaths: stats ? stats.deaths || 0 : 0,
              total_playtime_seconds: stats ? stats.total_playtime_seconds || 0 : 0
            });
          }
        } catch (e) {
          // If the online cache or player stats tables are not present yet, just return empty list
          onlinePlayers = [];
        }

        servers.push({ ...server, server_name: display, displayName: display, onlinePlayers });
      } catch (err) {
        // On error, fall back to basic sanitized name and no players
        const display = sanitizeServerName(server.server_name) || String(server.nitrado_server_id);
        servers.push({ ...server, server_name: display, displayName: display, onlinePlayers: [] });
      }
    }

    console.log('✅ [API] Found', servers.length, 'server(s)');
    servers.forEach((server, idx) => {
      // Use sanitized name for logging
      console.log(`   ${idx + 1}. ${sanitizeForLog(server.server_name)} (${server.nitrado_server_id})`);
    });

    res.json({
      success: true,
      servers: servers
    });
  } catch (error) {
    console.error('❌ [API] Error:', error);
    console.error('   Stack:', error.stack);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
