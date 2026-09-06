'use strict';

const DEFAULT_STALE_AFTER_MS = 10 * 60 * 1000;

function classifyGameServerStatus(gameserver) {
  const status = String(gameserver?.status || '').toLowerCase();
  if (['started', 'running', 'online'].includes(status)) return { state: 'healthy', detail: 'online' };
  if (['starting', 'restarting', 'restart', 'installing'].includes(status)) return { state: 'degraded', detail: 'starting' };
  if (['stopping'].includes(status)) return { state: 'degraded', detail: 'stopping' };
  if (['stopped', 'offline', 'suspended'].includes(status)) return { state: 'offline', detail: 'offline' };
  return { state: 'unknown', detail: 'unknown' };
}

function classifyNitradoError(error) {
  const status = Number(error?.statusCode || error?.status || error?.response?.status || 0);
  if (status === 401 || status === 403) return { state: 'offline', detail: 'authentication_error' };
  if (status === 429) return { state: 'degraded', detail: 'rate_limited' };
  if (status >= 500 || error?.code === 'ETIMEDOUT' || error?.code === 'ECONNREFUSED') {
    return { state: 'offline', detail: 'unreachable' };
  }
  return { state: 'unknown', detail: 'unknown' };
}

function applyStaleness(status, staleAfterMs = DEFAULT_STALE_AFTER_MS, now = Date.now()) {
  const checkedMs = status?.checkedAt ? new Date(status.checkedAt).getTime() : NaN;
  return { ...status, stale: !Number.isFinite(checkedMs) || now - checkedMs > staleAfterMs };
}

function safeHealthMessage(detail) {
  const messages = {
    online: 'Game server is responding.',
    starting: 'Game server is starting or restarting.',
    stopping: 'Game server is stopping.',
    offline: 'Game server is offline.',
    connected: 'Discord bot is connected.',
    disconnected: 'Discord bot is disconnected.',
    missing_permissions: 'Discord bot is missing required permissions.',
    bot_not_installed: 'Discord bot is not installed in this guild.',
    authentication_error: 'Provider authentication failed.',
    rate_limited: 'Provider rate limit is active.',
    unreachable: 'Provider is currently unreachable.',
    unknown: 'No reliable status is available.',
  };
  return messages[detail] || messages.unknown;
}

module.exports = {
  DEFAULT_STALE_AFTER_MS,
  applyStaleness,
  classifyGameServerStatus,
  classifyNitradoError,
  safeHealthMessage,
};
