'use strict';

const express = require('express');
const { DEFAULT_STALE_AFTER_MS, applyStaleness, safeHealthMessage } = require('../services/serverHealthService');

const router = express.Router();

const AUTHORIZED_SERVER_CTE = `
  WITH authorized_servers AS (
    SELECT DISTINCT s.id, s.guild_id, s.name, s.platform, s.platform_server_id,
                    g.name AS guild_name, g.discord_guild_id
      FROM servers s
      JOIN guilds g ON g.id = s.guild_id
      LEFT JOIN guild_roles gr ON gr.guild_id = g.id AND gr.user_id = $1
      LEFT JOIN server_role_assignments sra
        ON sra.server_id = s.id AND sra.guild_id = g.id
       AND sra.user_id = $1 AND sra.status = 'active'
      LEFT JOIN server_player_memberships spm
        ON spm.server_id = s.id AND spm.guild_id = g.id
       AND spm.user_id = $1 AND spm.status = 'active'
      WHERE s.status = 'active' AND g.status = 'approved'
        AND ($2 = 1 OR gr.role IN ('owner', 'admin') OR sra.role IN ('admin', 'moderator') OR spm.id IS NOT NULL)
  )`;

function component(row, name) {
  const prefix = name === 'game_server' ? 'game' : name;
  if (!row[`${prefix}_state`]) {
    return applyStaleness({ state: 'unknown', detail: 'unknown', checkedAt: null }, DEFAULT_STALE_AFTER_MS);
  }
  return applyStaleness({
    state: row[`${prefix}_state`],
    detail: row[`${prefix}_detail`],
    checkedAt: row[`${prefix}_checked_at`],
    lastHealthyAt: row[`${prefix}_last_healthy_at`],
    errorCode: row[`${prefix}_error_code`] || null,
    message: safeHealthMessage(row[`${prefix}_detail`]),
  }, DEFAULT_STALE_AFTER_MS);
}

function serializeServer(row) {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    guild: { id: row.guild_id, discordGuildId: row.discord_guild_id, name: row.guild_name },
    health: {
      nitrado: component(row, 'nitrado'),
      discord: component(row, 'discord'),
      gameServer: component(row, 'game_server'),
    },
  };
}

function isGlobal(req) {
  return Boolean(req.user.platform_role || req.user.is_admin);
}

const HEALTH_SELECT = `
  SELECT a.*,
    n.state AS nitrado_state, n.detail AS nitrado_detail, n.checked_at AS nitrado_checked_at,
    n.last_healthy_at AS nitrado_last_healthy_at, n.error_code AS nitrado_error_code,
    d.state AS discord_state, d.detail AS discord_detail, d.checked_at AS discord_checked_at,
    d.last_healthy_at AS discord_last_healthy_at, d.error_code AS discord_error_code,
    gs.state AS game_state, gs.detail AS game_detail, gs.checked_at AS game_checked_at,
    gs.last_healthy_at AS game_last_healthy_at, gs.error_code AS game_error_code
  FROM authorized_servers a
  LEFT JOIN server_health_status n ON n.server_id = a.id AND n.component = 'nitrado'
  LEFT JOIN server_health_status d ON d.server_id = a.id AND d.component = 'discord'
  LEFT JOIN server_health_status gs ON gs.server_id = a.id AND gs.component = 'game_server'`;

router.get('/servers', async (req, res) => {
  try {
    const rows = await req.app.locals.db.query(
      `${AUTHORIZED_SERVER_CTE} ${HEALTH_SELECT} ORDER BY a.guild_name, a.name`,
      [req.user.id, isGlobal(req) ? 1 : 0]
    );
    return res.json({ servers: rows.map(serializeServer), staleAfterMs: DEFAULT_STALE_AFTER_MS });
  } catch (error) {
    console.error('Failed to list authorized server health:', error.message);
    return res.status(500).json({ error: 'Failed to load server health' });
  }
});

router.get('/servers/:serverId', async (req, res) => {
  if (!/^\d+$/.test(String(req.params.serverId))) return res.status(404).json({ error: 'Not found' });
  try {
    const row = await req.app.locals.db.get(
      `${AUTHORIZED_SERVER_CTE} ${HEALTH_SELECT} WHERE a.id = $3`,
      [req.user.id, isGlobal(req) ? 1 : 0, Number(req.params.serverId)]
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    return res.json({ server: serializeServer(row), staleAfterMs: DEFAULT_STALE_AFTER_MS });
  } catch (error) {
    console.error('Failed to load authorized server health:', error.message);
    return res.status(500).json({ error: 'Failed to load server health' });
  }
});

router.get('/guilds', async (req, res) => {
  try {
    const rows = await req.app.locals.db.query(
      `${AUTHORIZED_SERVER_CTE} ${HEALTH_SELECT} ORDER BY a.guild_name, a.name`,
      [req.user.id, isGlobal(req) ? 1 : 0]
    );
    const guilds = new Map();
    for (const row of rows) {
      const server = serializeServer(row);
      const guild = guilds.get(row.guild_id) || {
        id: row.guild_id, discordGuildId: row.discord_guild_id, name: row.guild_name,
        serverCount: 0, online: 0, degraded: 0, offline: 0, unknown: 0, state: 'healthy',
      };
      guild.serverCount += 1;
      const states = Object.values(server.health).map(value => value.stale ? 'unknown' : value.state);
      const gameState = server.health.gameServer.stale ? 'unknown' : server.health.gameServer.state;
      guild[gameState] = (guild[gameState] || 0) + 1;
      if (states.includes('offline')) guild.state = 'offline';
      else if (guild.state !== 'offline' && states.includes('degraded')) guild.state = 'degraded';
      else if (guild.state === 'healthy' && states.includes('unknown')) guild.state = 'unknown';
      guilds.set(row.guild_id, guild);
    }
    return res.json({ guilds: Array.from(guilds.values()), staleAfterMs: DEFAULT_STALE_AFTER_MS });
  } catch (error) {
    console.error('Failed to summarize authorized guild health:', error.message);
    return res.status(500).json({ error: 'Failed to load guild health' });
  }
});

router.post('/servers/:serverId/refresh', async (req, res) => {
  if (!/^\d+$/.test(String(req.params.serverId))) return res.status(404).json({ error: 'Not found' });
  try {
    const authorized = await req.app.locals.db.get(
      `${AUTHORIZED_SERVER_CTE} SELECT id FROM authorized_servers WHERE id = $3`,
      [req.user.id, isGlobal(req) ? 1 : 0, Number(req.params.serverId)]
    );
    if (!authorized) return res.status(404).json({ error: 'Not found' });
    await req.app.locals.db.run(
      `INSERT INTO server_health_refresh_requests (server_id, requested_by_user_id, requested_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT (server_id) DO UPDATE SET
         requested_by_user_id = EXCLUDED.requested_by_user_id, requested_at = CURRENT_TIMESTAMP`,
      [authorized.id, req.user.id]
    );
    return res.status(202).json({ accepted: true });
  } catch (error) {
    console.error('Failed to request health refresh:', error.message);
    return res.status(500).json({ error: 'Failed to request refresh' });
  }
});

module.exports = router;
