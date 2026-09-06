'use strict';

const { PermissionFlagsBits } = require('discord.js');
const pool = require('../db');
const { decryptToken } = require('../../utils/encryption');
const nitradoService = require('../../services/nitradoService');
const {
  classifyGameServerStatus,
  classifyNitradoError,
  safeHealthMessage,
} = require('../../services/serverHealthService');

const INTERVAL_MS = 5 * 60 * 1000;
let running = false;

async function writeComponent(server, component, status) {
  await pool.query(
    `INSERT INTO server_health_status
       (server_id, guild_id, component, state, detail, checked_at,
        last_healthy_at, error_code, error_message)
     VALUES ($1, $2, $3, $4, $5, NOW(),
             CASE WHEN $4 = 'healthy' THEN NOW() ELSE NULL END, $6, $7)
     ON CONFLICT (server_id, component) DO UPDATE SET
       guild_id = EXCLUDED.guild_id,
       state = EXCLUDED.state,
       detail = EXCLUDED.detail,
       checked_at = NOW(),
       last_healthy_at = CASE WHEN EXCLUDED.state = 'healthy' THEN NOW()
                              ELSE server_health_status.last_healthy_at END,
       error_code = EXCLUDED.error_code,
       error_message = EXCLUDED.error_message`,
    [server.server_id, server.guild_id, component, status.state, status.detail,
      status.errorCode || null, safeHealthMessage(status.detail)]
  );
}

function discordStatus(client, discordGuildId) {
  const guild = client.guilds.cache.get(String(discordGuildId));
  if (!guild) return { state: 'offline', detail: 'bot_not_installed', errorCode: 'BOT_NOT_INSTALLED' };
  const botMember = guild.members.me;
  if (!botMember) return { state: 'offline', detail: 'disconnected', errorCode: 'BOT_MEMBER_MISSING' };
  const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];
  if (!required.every(permission => botMember.permissions.has(permission))) {
    return { state: 'degraded', detail: 'missing_permissions', errorCode: 'MISSING_PERMISSIONS' };
  }
  return { state: 'healthy', detail: 'connected' };
}

async function checkServer(client, server) {
  await writeComponent(server, 'discord', discordStatus(client, server.discord_guild_id));

  if (!server.token_hash) {
    await writeComponent(server, 'nitrado', { state: 'unknown', detail: 'unknown', errorCode: 'NO_CREDENTIALS' });
    await writeComponent(server, 'game_server', { state: 'unknown', detail: 'unknown', errorCode: 'NO_PROVIDER_STATUS' });
    return;
  }

  try {
    const token = decryptToken(server.token_hash);
    const gameserver = await nitradoService.getRawGameserver(token, server.platform_server_id);
    await writeComponent(server, 'nitrado', { state: 'healthy', detail: 'online' });
    await writeComponent(server, 'game_server', classifyGameServerStatus(gameserver));
  } catch (error) {
    const provider = classifyNitradoError(error);
    await writeComponent(server, 'nitrado', { ...provider, errorCode: error.code || 'PROVIDER_ERROR' });
    await writeComponent(server, 'game_server', {
      state: 'unknown', detail: 'unknown', errorCode: 'PROVIDER_STATUS_UNAVAILABLE',
    });
  }
}

async function runHealthChecks(client) {
  if (running) return;
  running = true;
  try {
    const result = await pool.query(
      `SELECT s.id AS server_id, s.guild_id, s.platform_server_id,
              g.discord_guild_id, gt.token_hash,
              request.requested_at AS refresh_requested_at
         FROM servers s
         JOIN guilds g ON g.id = s.guild_id AND g.status = 'approved'
         LEFT JOIN guild_tokens gt ON gt.guild_id = g.id AND gt.token_type = 'nitrado'
         LEFT JOIN server_health_refresh_requests request ON request.server_id = s.id
        WHERE s.status = 'active'
        ORDER BY request.requested_at NULLS LAST, s.id`
    );
    for (const server of result.rows) {
      await checkServer(client, server);
      if (server.refresh_requested_at) {
        await pool.query(
          `DELETE FROM server_health_refresh_requests
            WHERE server_id = $1 AND requested_at <= $2`,
          [server.server_id, server.refresh_requested_at]
        );
      }
    }
  } catch (error) {
    console.error('❌ Server health monitor failed:', error.message);
  } finally {
    running = false;
  }
}

function startServerHealthMonitor(client) {
  console.log(`🩺 Server health monitor started (interval: ${INTERVAL_MS / 1000}s)`);
  runHealthChecks(client);
  setInterval(() => runHealthChecks(client), INTERVAL_MS);
}

module.exports = { discordStatus, runHealthChecks, startServerHealthMonitor };
