'use strict';

const crypto = require('crypto');
const { createExternalApiClient, ExternalApiError } = require('../utils/externalApiClient');
const { detectDayzPlatform } = require('../utils/dayzPlatform');
const { normalizeNitradoServiceId } = require('../utils/nitradoIds');
const { normalizeProviderServerName } = require('../utils/serverNames');

const DEFAULT_API_BASE_URL = 'https://api.nitrado.net';
const DEFAULT_CACHE_TTL_MS = 10000;
const DEFAULT_CACHE_MAX_ENTRIES = 500;

function invalidResponse(operation) {
  return new ExternalApiError('Nitrado', operation, 'invalid_response', 502);
}

function mutationMessage(response, operation, fallback) {
  const body = response?.data;
  if (body?.status !== 'success' ||
      (body?.data?.status !== undefined && body.data.status !== 'success')) {
    throw invalidResponse(operation);
  }
  const message = body?.message || body?.data?.message;
  if (typeof message === 'string' && message.trim()) return message;
  if (body?.status === 'success' || body?.data?.status === 'success') return fallback;
  throw invalidResponse(operation);
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function requireToken(token) {
  if (!token || typeof token !== 'string') throw new Error('Nitrado access token is required');
  return token;
}

function resourceId(value, label = 'resource ID') {
  if (label === 'service ID') return normalizeNitradoServiceId(value);
  const normalized = String(value ?? '').trim();
  if (!normalized || !/^[A-Za-z0-9._-]+$/.test(normalized)) throw new Error(`Invalid Nitrado ${label}`);
  return encodeURIComponent(normalized);
}

function tokenKey(token) {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
}

function isDayzService(service) {
  const details = service?.details || {};
  return `${details.game || ''} ${details.folder_short || ''} ${details.portlist_short || ''}`.toLowerCase().includes('dayz');
}

function normalizeService(service) {
  const id = normalizeNitradoServiceId(service.id ?? service.service_id);
  return {
    id,
    name: normalizeProviderServerName(
      service.details?.name || service.details?.label || service.name,
      id
    ),
    status: service.status || null,
    type: service.type || service.type_human || null,
    game: service.details?.game || null,
    gameFolder: service.details?.folder_short || null,
    platform: detectDayzPlatform(service),
    address: service.details?.address || null,
  };
}

function hasResourceId(resource, ...fields) {
  return resource && typeof resource === 'object' && !Array.isArray(resource) &&
    fields.some(field => resource[field] !== undefined && resource[field] !== null && String(resource[field]).trim());
}

function validateService(service, operation) {
  if (!hasResourceId(service, 'id', 'service_id')) throw invalidResponse(operation);
  try {
    normalizeNitradoServiceId(service.id ?? service.service_id);
  } catch (_) {
    throw invalidResponse(operation);
  }
  return service;
}

function validateGameserver(gameserver, operation) {
  if (!hasResourceId(gameserver, 'service_id', 'id')) throw invalidResponse(operation);
  try {
    normalizeNitradoServiceId(gameserver.service_id ?? gameserver.id);
  } catch (_) {
    throw invalidResponse(operation);
  }
  return gameserver;
}

function matchesResourceId(resource, expectedId, ...fields) {
  return fields.some(field => resource?.[field] !== undefined && resource?.[field] !== null &&
    String(resource[field]).trim() === String(expectedId));
}

function validatePlayer(player, operation) {
  if (!hasResourceId(player, 'id', 'player_id') || typeof (player.name ?? player.player_name) !== 'string') {
    throw invalidResponse(operation);
  }
  return player;
}

function validateBoosting(boosting, operation) {
  if (!boosting || typeof boosting !== 'object' || Array.isArray(boosting) ||
      typeof boosting.enabled !== 'boolean' ||
      (boosting.code != null && typeof boosting.code !== 'string') ||
      (boosting.message != null && typeof boosting.message !== 'string') ||
      (boosting.welcome_message != null && typeof boosting.welcome_message !== 'string')) {
    throw invalidResponse(operation);
  }
  return boosting;
}

function validateBackupGroups(groups, operation, type) {
  if (!groups || typeof groups !== 'object' || Array.isArray(groups)) throw invalidResponse(operation);
  for (const entries of Object.values(groups)) {
    if (!Array.isArray(entries) || entries.some(entry => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
          !Number.isFinite(Number(entry.backup_timestamp)) || !Number.isFinite(Number(entry.backup_size))) return true;
      return type === 'database'
        ? typeof entry.backup_file !== 'string' || !entry.backup_file
        : typeof entry.backup_type !== 'string' || !Number.isFinite(Number(entry.backup_number));
    })) {
      throw invalidResponse(operation);
    }
  }
  return groups;
}

function displayMap(value) {
  const map = String(value || '');
  if (/chernarus/i.test(map)) return 'Chernarus';
  if (/livonia|enoch/i.test(map)) return 'Livonia';
  if (/namalsk/i.test(map)) return 'Namalsk';
  if (/sakhal/i.test(map)) return 'Sakhal';
  return map.replace(/^dayzOffline\./i, '') || 'Unknown';
}

function normalizeServerStatus(gameserver) {
  const query = gameserver?.query || {};
  const config = gameserver?.settings?.config || {};
  const id = String(gameserver?.service_id ?? gameserver?.id ?? '');
  return {
    id,
    status: gameserver?.status || 'unknown',
    name: normalizeProviderServerName(gameserver?.label, id),
    game: gameserver?.game_human || 'DayZ',
    map: displayMap(query.map || config.mission),
    version: query.version || null,
    playerCurrent: Number(query.player_current ?? 0),
    playerMax: Number(query.player_max ?? gameserver?.slots ?? 0),
    lastStatusChange: gameserver?.last_status_change || null,
    whitelist: config.enableWhitelist === '1' || config.enableWhitelist === true,
    crosshair: config.disableCrosshair !== '1' && config.disableCrosshair !== true,
    thirdPerson: config.disable3rdPerson !== '1' && config.disable3rdPerson !== true,
  };
}

function normalizePlayer(player) {
  const rawOnline = player.online;
  const online = rawOnline === true || rawOnline === 1 ||
    (typeof rawOnline === 'string' && ['true', '1', 'online'].includes(rawOnline.toLowerCase()));
  return {
    id: String(player.id ?? player.player_id ?? ''),
    name: player.name || player.player_name || 'Unknown',
    online,
  };
}

function createNitradoService(options = {}) {
  const apiBaseUrl = options.apiBaseUrl || process.env.NITRADO_API_BASE_URL || DEFAULT_API_BASE_URL;
  const cacheTtlMs = positiveInteger(options.cacheTtlMs ?? process.env.NITRADO_CACHE_TTL_MS, DEFAULT_CACHE_TTL_MS);
  const cacheMaxEntries = positiveInteger(options.cacheMaxEntries ?? process.env.NITRADO_CACHE_MAX_ENTRIES, DEFAULT_CACHE_MAX_ENTRIES);
  const client = options.request
    ? { request: options.request }
    : createExternalApiClient({
      serviceName: 'Nitrado',
      baseURL: apiBaseUrl,
      timeoutMs: process.env.NITRADO_API_TIMEOUT_MS || process.env.NITRADO_HTTP_TIMEOUT_MS,
      maxRetries: Number(process.env.NITRADO_API_RETRIES ?? process.env.NITRADO_HTTP_MAX_RETRIES ?? 2),
      maxRetryDelayMs: process.env.EXTERNAL_API_MAX_RETRY_DELAY_MS,
    });
  const cache = new Map();
  const inflight = new Map();

  function authHeaders(token) {
    return { Authorization: 'Bearer ' + requireToken(token), Accept: 'application/json' };
  }

  async function cached(key, loader, ttl = cacheTtlMs) {
    const now = Date.now();
    for (const [cacheKey, entry] of cache) if (entry.expiresAt <= now) cache.delete(cacheKey);
    const current = cache.get(key);
    if (current) return current.value;
    if (inflight.has(key)) return inflight.get(key);
    const pending = Promise.resolve().then(loader).then(value => {
      while (cache.size >= cacheMaxEntries) cache.delete(cache.keys().next().value);
      cache.set(key, { value, expiresAt: Date.now() + ttl });
      return value;
    }).finally(() => inflight.delete(key));
    inflight.set(key, pending);
    return pending;
  }

  function invalidate(serviceId) {
    const marker = `:${String(serviceId)}:`;
    for (const key of cache.keys()) if (key.includes(marker)) cache.delete(key);
  }

  async function request(token, config) {
    const response = await client.request({ ...config, headers: { ...authHeaders(token), ...(config.headers || {}) } });
    if (String(config.method || 'GET').toUpperCase() === 'GET' && response?.data?.status !== 'success') {
      throw invalidResponse(config.operation || 'read provider data');
    }
    return response;
  }

  async function publicRequest(config) {
    const response = await client.request(config);
    if (String(config.method || 'GET').toUpperCase() === 'GET' && response?.data?.status !== 'success') {
      throw invalidResponse(config.operation || 'read public provider data');
    }
    return response;
  }

  async function listServices(token) {
    const key = `${tokenKey(requireToken(token))}:services`;
    return cached(key, async () => {
      const response = await request(token, { method: 'GET', path: '/services', operation: 'list services' });
      const services = response.data?.data?.services;
      if (!Array.isArray(services)) throw invalidResponse('list services');
      return services.map(service => normalizeService(validateService(service, 'list services')));
    });
  }

  async function getAuthenticatedUser(token) {
    const response = await request(token, { method: 'GET', path: '/user', operation: 'get authenticated user' });
    const user = response.data?.data?.user || response.data?.data;
    const id = user?.id ?? user?.user_id ?? user?.customer_id;
    if (id === undefined || id === null) throw invalidResponse('get authenticated user');
    return { id: String(id), username: user.username || user.name || null };
  }

  async function listGameServers(token) {
    const response = await request(token, { method: 'GET', path: '/services', operation: 'list DayZ services' });
    const services = response.data?.data?.services;
    if (!Array.isArray(services)) throw invalidResponse('list DayZ services');
    return services.map(service => validateService(service, 'list DayZ services')).filter(isDayzService).map(normalizeService);
  }

  async function loadRawGameserver(token, id) {
    const response = await request(token, { method: 'GET', path: `/services/${id}/gameservers`, operation: 'get gameserver' });
    const gameserver = response.data?.data?.gameserver;
    validateGameserver(gameserver, 'get gameserver');
    if (!matchesResourceId(gameserver, id, 'service_id', 'id')) throw invalidResponse('get gameserver');
    return gameserver;
  }

  async function getRawGameserver(token, serviceId) {
    const id = resourceId(serviceId, 'service ID');
    const key = `${tokenKey(requireToken(token))}:${id}:gameserver`;
    return cached(key, () => loadRawGameserver(token, id));
  }

  async function getRawGameserverFresh(token, serviceId) {
    const id = resourceId(serviceId, 'service ID');
    return loadRawGameserver(token, id);
  }

  async function getServerStatus(token, serviceId) {
    return normalizeServerStatus(await getRawGameserver(token, serviceId));
  }

  async function getServiceDetails(token, serviceId) {
    const id = resourceId(serviceId, 'service ID');
    const response = await request(token, { method: 'GET', path: `/services/${id}`, operation: 'get service details' });
    const service = response.data?.data?.service;
    validateService(service, 'get service details');
    if (!matchesResourceId(service, id, 'id', 'service_id')) throw invalidResponse('get service details');
    return {
      ...normalizeService(service),
      suspendDate: service.suspend_date || null,
      suspendingIn: service.suspending_in || null,
      autoExtension: Boolean(service.auto_extension),
      username: service.username || null,
    };
  }

  async function listPlayers(token, serviceId) {
    const id = resourceId(serviceId, 'service ID');
    const response = await request(token, { method: 'GET', path: `/services/${id}/gameservers/games/players`, operation: 'list players' });
    const players = response.data?.data?.players;
    if (!Array.isArray(players)) throw invalidResponse('list players');
    return players.map(player => normalizePlayer(validatePlayer(player, 'list players')));
  }

  async function getSettings(token, serviceId) {
    const id = resourceId(serviceId, 'service ID');
    const response = await request(token, { method: 'GET', path: `/services/${id}/gameservers/settings`, operation: 'get settings' });
    const settings = response.data?.data?.settings;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw invalidResponse('get settings');
    return settings;
  }

  async function updateSetting(token, serviceId, category, key, value) {
    const id = resourceId(serviceId, 'service ID');
    if (!category || !key) throw new Error('Nitrado setting category and key are required');
    const response = await request(token, {
      method: 'POST', path: `/services/${id}/gameservers/settings`, operation: 'update setting',
      data: { category, key, value }, headers: { 'Content-Type': 'application/json' },
    });
    const message = mutationMessage(response, 'update setting', 'Setting updated');
    invalidate(serviceId);
    return { message };
  }

  async function controlServer(token, serviceId, action) {
    if (!['restart', 'start', 'stop'].includes(action)) throw new Error(`Unsupported Nitrado server action: ${action}`);
    const id = resourceId(serviceId, 'service ID');
    const response = await request(token, { method: 'POST', path: `/services/${id}/gameservers/${action}`, data: {}, operation: `${action} server` });
    const message = mutationMessage(response, `${action} server`, `${action} initiated`);
    invalidate(serviceId);
    return { message };
  }

  async function getNotifications(token, serviceId) {
    const id = resourceId(serviceId, 'service ID');
    const response = await request(token, { method: 'GET', path: `/services/${id}/notifications`, operation: 'get notifications' });
    const notifications = response.data?.data?.notifications;
    if (!Array.isArray(notifications)) throw invalidResponse('get notifications');
    if (notifications.some(item => !hasResourceId(item, 'id') || !hasResourceId(item, 'service_id') ||
      !matchesResourceId(item, id, 'service_id') || typeof item.message !== 'string')) {
      throw invalidResponse('get notifications');
    }
    return notifications.map(item => ({ ...item, severity: item.severity || item.level || 'INFO' }));
  }

  async function getStats(token, serviceId, hours = 24) {
    const id = resourceId(serviceId, 'service ID');
    const boundedHours = Math.min(48, Math.max(1, Number.parseInt(hours, 10) || 24));
    const response = await request(token, { method: 'GET', path: `/services/${id}/gameservers/stats`, params: { hours: boundedHours }, operation: 'get statistics' });
    const stats = response.data?.data?.stats;
    if (!stats || typeof stats !== 'object' || Array.isArray(stats)) throw invalidResponse('get statistics');
    return stats;
  }

  async function getLogs(token, serviceId, page = 1) {
    const id = resourceId(serviceId, 'service ID');
    const currentPage = Math.max(1, Number.parseInt(page, 10) || 1);
    const response = await request(token, { method: 'GET', path: `/services/${id}/logs`, params: { page: currentPage }, operation: 'get service logs' });
    const data = response.data?.data;
    if (!data || !Array.isArray(data.logs)) throw invalidResponse('get service logs');
    if (data.logs.some(item => !item || typeof item !== 'object' || Array.isArray(item) ||
      typeof item.message !== 'string' || typeof item.created_at !== 'string' ||
      typeof item.category !== 'string' || typeof item.severity !== 'string')) {
      throw invalidResponse('get service logs');
    }
    return { logs: data.logs, currentPage: data.current_page || currentPage, pageCount: data.page_count || 1, logCount: data.log_count || 0 };
  }

  async function command(token, serviceId, commandText) {
    const id = resourceId(serviceId, 'service ID');
    if (!commandText || typeof commandText !== 'string') throw new Error('Nitrado console command is required');
    const response = await request(token, { method: 'POST', path: `/services/${id}/gameservers/app_server/command`, data: { command: commandText.trim() }, operation: 'send console command' });
    return { message: mutationMessage(response, 'send console command', 'Command sent') };
  }

  async function availableTasks(token, serviceId) {
    const id = resourceId(serviceId, 'service ID');
    const response = await request(token, { method: 'GET', path: `/services/${id}/tasks/list`, operation: 'list available tasks' });
    const tasks = response.data?.data?.tasks;
    if (!Array.isArray(tasks)) throw invalidResponse('list available tasks');
    return tasks.map(entry => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).length !== 1) {
        throw invalidResponse('list available tasks');
      }
      const actionMethod = Object.keys(entry)[0];
      if (!actionMethod || !entry[actionMethod] || typeof entry[actionMethod].desc !== 'string') {
        throw invalidResponse('list available tasks');
      }
      return { actionMethod, description: entry[actionMethod]?.desc || actionMethod };
    });
  }

  async function listTasks(token, serviceId) {
    const id = resourceId(serviceId, 'service ID');
    const response = await request(token, { method: 'GET', path: `/services/${id}/tasks`, operation: 'list tasks' });
    const tasks = response.data?.data?.tasks;
    if (!Array.isArray(tasks)) throw invalidResponse('list tasks');
    if (tasks.some(task => !hasResourceId(task, 'id') || typeof task.action_method !== 'string' ||
      typeof task.minute !== 'string' || typeof task.hour !== 'string')) {
      throw invalidResponse('list tasks');
    }
    return tasks;
  }

  function taskPayload(task = {}) {
    if (!task.minute || !task.hour || !task.action_method) throw new Error('minute, hour, and action_method are required');
    return { minute: task.minute, hour: task.hour, day: task.day || '*', month: task.month || '*', weekday: task.weekday || '*', action_method: task.action_method, action_data: task.action_data || '' };
  }

  async function createTask(token, serviceId, task) {
    const id = resourceId(serviceId, 'service ID');
    const response = await request(token, { method: 'POST', path: `/services/${id}/tasks`, data: taskPayload(task), operation: 'create task' });
    return { message: mutationMessage(response, 'create task', 'Task created') };
  }

  async function updateTask(token, serviceId, taskId, task) {
    const id = resourceId(serviceId, 'service ID');
    const tid = resourceId(taskId, 'task ID');
    const response = await request(token, { method: 'PUT', path: `/services/${id}/tasks/${tid}`, data: taskPayload(task), operation: 'update task' });
    return { message: mutationMessage(response, 'update task', 'Task updated') };
  }

  async function deleteTask(token, serviceId, taskId) {
    const id = resourceId(serviceId, 'service ID');
    const tid = resourceId(taskId, 'task ID');
    const response = await request(token, { method: 'DELETE', path: `/services/${id}/tasks/${tid}`, operation: 'delete task' });
    return { message: mutationMessage(response, 'delete task', 'Task deleted') };
  }

  async function getBoostHistory(token, serviceId, page = 1) {
    const id = resourceId(serviceId, 'service ID');
    const currentPage = Math.max(1, Number.parseInt(page, 10) || 1);
    const response = await request(token, {
      method: 'GET', path: `/services/${id}/gameservers/boost/history`, params: { page: currentPage }, operation: 'get boost history',
    });
    const body = response.data;
    const data = body?.data;
    if (body?.status !== 'success' || !data || !Array.isArray(data.boosts) ||
        !Number.isInteger(Number(data.boosts_count)) || !Number.isInteger(Number(data.current_page)) ||
        !Number.isInteger(Number(data.page_count)) || !Number.isInteger(Number(data.boosts_per_page)) ||
        Number(data.boosts_count) < 0 || Number(data.current_page) < 1 || Number(data.page_count) < 1 ||
        Number(data.boosts_per_page) < 1 || data.boosts.some(boost => !boost || typeof boost !== 'object' ||
          !hasResourceId(boost, 'id') || typeof boost.username !== 'string' || typeof boost.amount !== 'string' ||
          !Number.isFinite(Number(boost.extended_for)) || typeof boost.boosted_at !== 'string' ||
          (boost.message != null && typeof boost.message !== 'string') ||
          (boost.avatar != null && typeof boost.avatar !== 'string'))) {
      throw invalidResponse('get boost history');
    }
    return body;
  }

  async function getBoostSettings(token, serviceId) {
    const id = resourceId(serviceId, 'service ID');
    const response = await request(token, { method: 'GET', path: `/services/${id}/gameservers/boost`, operation: 'get boost settings' });
    const body = response.data;
    if (body?.status !== 'success') throw invalidResponse('get boost settings');
    validateBoosting(body.boosting, 'get boost settings');
    return { status: body.status, data: { boosting: body.boosting } };
  }

  async function updateBoostSettings(token, serviceId, settings = {}) {
    const id = resourceId(serviceId, 'service ID');
    const allowed = {};
    if (typeof settings.enabled === 'boolean') allowed.enable = settings.enabled ? 0 : 1;
    if (typeof settings.message === 'string') allowed.message = settings.message;
    if (typeof settings.welcome_message === 'string') allowed.welcome_message = settings.welcome_message;
    if (!Object.keys(allowed).length) throw new Error('At least one valid boost setting is required');
    const response = await request(token, {
      method: 'PUT', path: `/services/${id}/gameservers/boost`, data: allowed, operation: 'update boost settings',
    });
    if (response.data?.status !== 'success') throw invalidResponse('update boost settings');
    validateBoosting(response.data.boosting, 'update boost settings');
    invalidate(serviceId);
    return { status: response.data.status, data: { boosting: response.data.boosting } };
  }

  async function listBackups(token, serviceId) {
    const id = resourceId(serviceId, 'service ID');
    const response = await request(token, { method: 'GET', path: `/services/${id}/gameservers/backups`, operation: 'list backups' });
    const backups = response.data?.data?.backups;
    if (!backups || typeof backups !== 'object' || Array.isArray(backups)) throw invalidResponse('list backups');
    validateBackupGroups(backups.gameserver, 'list backups', 'gameserver');
    validateBackupGroups(backups.database, 'list backups', 'database');
    return backups;
  }

  function requiredText(value, label) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
    return value.trim();
  }

  async function restoreGameserverBackup(token, serviceId, folder, backup) {
    const id = resourceId(serviceId, 'service ID');
    const response = await request(token, {
      method: 'POST', path: `/services/${id}/gameservers/backups/gameserver`,
      data: { folder: requiredText(folder, 'folder'), backup: requiredText(backup, 'backup') }, operation: 'restore gameserver backup',
    });
    return { message: mutationMessage(response, 'restore gameserver backup', 'Restore initiated') };
  }

  async function restoreDatabaseBackup(token, serviceId, database, timestamp) {
    const id = resourceId(serviceId, 'service ID');
    const response = await request(token, {
      method: 'POST', path: `/services/${id}/gameservers/backups/database`,
      data: { database: requiredText(database, 'database'), timestamp: requiredText(timestamp, 'timestamp') }, operation: 'restore database backup',
    });
    return { message: mutationMessage(response, 'restore database backup', 'Database restore initiated') };
  }

  async function getSupportChannels() {
    const response = await publicRequest({ method: 'GET', path: '/support/channels', operation: 'get support channels' });
    const body = response.data;
    const channels = body?.data?.support_channels;
    if (body?.status !== 'success' || !channels || typeof channels !== 'object' || Array.isArray(channels) ||
        Object.entries(channels).some(([name, channel]) =>
          !/^[a-z][a-z0-9_-]{0,63}$/i.test(name) || !channel || typeof channel !== 'object' || Array.isArray(channel) ||
          !['enabled', 'disabled'].includes(channel.status) ||
          (channel.contacts !== undefined && (!Array.isArray(channel.contacts) || channel.contacts.some(contact =>
            !contact || typeof contact.contact !== 'string' || !contact.contact.trim() || !Array.isArray(contact.slots) ||
            contact.slots.some(slot => !slot || typeof slot !== 'object' || Array.isArray(slot) ||
              !Array.isArray(slot.languages) || slot.languages.some(language => typeof language !== 'string' || !language.trim()) ||
              typeof slot.cronFrom !== 'string' || !slot.cronFrom.trim() ||
              !Number.isFinite(Number(slot.duration)) || Number(slot.duration) < 0 ||
              typeof slot.timezone !== 'string' || !slot.timezone.trim())))))) {
      throw invalidResponse('get support channels');
    }
    return body;
  }

  return {
    getAuthenticatedUser, listServices, listGameServers, getRawGameserver, getRawGameserverFresh,
    getServerStatus, getServiceDetails, listPlayers,
    getSettings, updateSetting, controlServer, getNotifications, getStats, getLogs, command,
    availableTasks, listTasks, createTask, updateTask, deleteTask, invalidate,
    getBoostHistory, getBoostSettings, updateBoostSettings, listBackups,
    restoreGameserverBackup, restoreDatabaseBackup, getSupportChannels,
  };
}

const nitradoService = createNitradoService();
module.exports = Object.assign(nitradoService, {
  DEFAULT_API_BASE_URL,
  createNitradoService,
  detectPlatform: detectDayzPlatform,
  normalizePlayer,
  normalizeServerStatus,
  normalizeService,
});
