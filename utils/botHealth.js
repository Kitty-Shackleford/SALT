'use strict';

const BOT_HEARTBEAT_STALE_MS = 90 * 1000;

function toFiniteNumber(value) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function classifyBotHealth(row, nowMs = Date.now()) {
  if (!row?.last_heartbeat) {
    return {
      status: 'offline',
      message: 'No heartbeat received',
      lastHeartbeat: null,
      startedAt: null,
      guildCount: 0,
      websocketPingMs: null,
      uptimeSeconds: null,
    };
  }

  const heartbeatMs = new Date(row.last_heartbeat).getTime();
  const ageMs = nowMs - heartbeatMs;
  const fresh = Number.isFinite(heartbeatMs) && ageMs >= 0 && ageMs <= BOT_HEARTBEAT_STALE_MS;
  const online = fresh && row.status === 'online';

  return {
    status: online ? 'online' : 'offline',
    message: online ? 'Connected to Discord' : fresh ? 'Discord connection unavailable' : 'Heartbeat is stale',
    lastHeartbeat: row.last_heartbeat,
    startedAt: row.started_at || null,
    guildCount: toFiniteNumber(row.guild_count) ?? 0,
    websocketPingMs: toFiniteNumber(row.websocket_ping_ms),
    uptimeSeconds: toFiniteNumber(row.process_uptime_seconds),
  };
}

module.exports = { BOT_HEARTBEAT_STALE_MS, classifyBotHealth };
