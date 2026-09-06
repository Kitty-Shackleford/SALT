'use strict';

const pool = require('../db');

const HEARTBEAT_INTERVAL_MS = 30 * 1000;

async function writeBotHeartbeat(client, startedAt) {
  const isOnline = client.isReady();
  const ping = Number(client.ws?.ping);
  const websocketPingMs = Number.isFinite(ping) && ping >= 0 ? Math.round(ping) : null;

  await pool.query(
    `INSERT INTO bot_health (
       id, status, started_at, last_heartbeat, guild_count,
       websocket_ping_ms, process_uptime_seconds
     ) VALUES (1, $1, $2, NOW(), $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET
       status = EXCLUDED.status,
       started_at = EXCLUDED.started_at,
       last_heartbeat = EXCLUDED.last_heartbeat,
       guild_count = EXCLUDED.guild_count,
       websocket_ping_ms = EXCLUDED.websocket_ping_ms,
       process_uptime_seconds = EXCLUDED.process_uptime_seconds`,
    [
      isOnline ? 'online' : 'disconnected',
      startedAt,
      client.guilds.cache.size,
      websocketPingMs,
      Math.floor(process.uptime()),
    ]
  );
}

async function startBotHealthHeartbeat(client) {
  const startedAt = new Date();
  await writeBotHeartbeat(client, startedAt);
  const update = () => writeBotHeartbeat(client, startedAt)
    .catch(error => console.warn('⚠️  Bot health heartbeat failed:', error.message));

  const timer = setInterval(update, HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return timer;
}

module.exports = { HEARTBEAT_INTERVAL_MS, startBotHealthHeartbeat, writeBotHeartbeat };
