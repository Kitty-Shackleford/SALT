'use strict';

const { decryptToken } = require('../utils/encryption');
const nitradoService = require('./nitradoService');
const { CAPABILITIES, authorizeServerMutation } = require('./authorizationService');
const {
  acquireProviderMutationLock,
  createFileMutationJournal,
} = require('./shopFileService');
const {
  prepareProviderMutation,
  registerProviderMutationRollback,
  updatePreparedProviderMutation,
} = require('./providerMutationRecoveryService');

const SETTING_RESOURCE_ROOT = '/provider-settings';

function settingName(value, label) {
  if (typeof value !== 'string' || !value || value.length > 128) {
    throw new Error(`Invalid Nitrado setting ${label}`);
  }
  return value;
}

function settingResourcePath(category, key) {
  return `${SETTING_RESOURCE_ROOT}/${encodeURIComponent(settingName(category, 'category'))}/${encodeURIComponent(settingName(key, 'key'))}.json`;
}

function parseSettingResourcePath(resourcePath) {
  const match = /^\/provider-settings\/([^/]+)\/([^/]+)\.json$/.exec(String(resourcePath || ''));
  if (!match) throw new Error('Invalid provider setting recovery path');
  let category;
  let key;
  try {
    category = decodeURIComponent(match[1]);
    key = decodeURIComponent(match[2]);
  } catch (_) {
    throw new Error('Invalid provider setting recovery path');
  }
  if (settingResourcePath(category, key) !== resourcePath) {
    throw new Error('Invalid provider setting recovery path');
  }
  return { category, key };
}

function settingEnvelope(value) {
  return JSON.stringify({ value });
}

function parseSettingEnvelope(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (_) {
    throw new Error('Invalid provider setting snapshot');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      Object.keys(parsed).length !== 1 || !Object.prototype.hasOwnProperty.call(parsed, 'value')) {
    throw new Error('Invalid provider setting snapshot');
  }
  return parsed.value;
}

function createProviderSettingFileService(provider = nitradoService) {
  return {
    async downloadFileFromServer(platformServerId, resourcePath, token) {
      const { category, key } = parseSettingResourcePath(resourcePath);
      const settings = await provider.getSettings(token, platformServerId);
      const categorySettings = settings?.[category];
      if (!categorySettings || typeof categorySettings !== 'object' ||
          !Object.prototype.hasOwnProperty.call(categorySettings, key) ||
          categorySettings[key] === undefined) {
        return null;
      }
      return settingEnvelope(categorySettings[key]);
    },

    async uploadFileToServer(platformServerId, directory, filename, content, token) {
      const resourcePath = `${String(directory).replace(/\/$/, '')}/${filename}`;
      const { category, key } = parseSettingResourcePath(resourcePath);
      const value = parseSettingEnvelope(content);
      await provider.updateSetting(token, platformServerId, category, key, value);
      const verified = await this.downloadFileFromServer(platformServerId, resourcePath, token);
      if (verified !== content) throw new Error(`Provider setting verification failed for ${category}.${key}`);
    },

    async deleteFileFromServer() {
      throw new Error('Provider setting recovery cannot restore an absent setting');
    },
  };
}

function validateSettingEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 200) {
    throw new Error('Provider settings must contain between 1 and 200 values');
  }
  const paths = new Set();
  return entries.map(entry => {
    const category = settingName(entry?.category, 'category');
    const key = settingName(entry?.key, 'key');
    const value = entry?.value;
    if (value === undefined || (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) ||
        (typeof value === 'number' && !Number.isFinite(value))) {
      throw new Error(`Invalid value for Nitrado setting ${category}.${key}`);
    }
    const resourcePath = settingResourcePath(category, key);
    if (paths.has(resourcePath)) throw new Error(`Duplicate Nitrado setting ${category}.${key}`);
    paths.add(resourcePath);
    return { category, key, value, resourcePath, content: settingEnvelope(value) };
  });
}

async function resolveProviderContext(
  transactionDb,
  internalServerId,
  expectedPlatformServerId,
  allowedPlatforms = null
) {
  const row = await transactionDb.get(
    `SELECT s.platform_server_id, gt.token_hash, gt.nitrado_user_id
     FROM servers s
     JOIN guilds g ON g.id = s.guild_id
     JOIN guild_tokens gt ON gt.guild_id = g.id AND gt.token_type = 'nitrado'
     WHERE s.id = ? AND s.status = 'active' AND g.status = 'approved'
       AND gt.nitrado_user_id IS NOT NULL
     FOR NO KEY UPDATE OF s, g, gt`,
    [internalServerId]
  );
  if (!row?.platform_server_id || !row?.token_hash) {
    throw new Error('No authorized Nitrado token found for provider setting mutation');
  }
  if (expectedPlatformServerId !== undefined &&
      String(row.platform_server_id) !== String(expectedPlatformServerId)) {
    const error = new Error('Provider service identity changed before setting mutation');
    error.code = 'SERVER_AUTHORIZATION_MISMATCH';
    error.status = 409;
    throw error;
  }
  const token = decryptToken(row.token_hash);
  const identity = await nitradoService.getAuthenticatedUser(token);
  if (String(identity.id) !== String(row.nitrado_user_id)) {
    const error = new Error('The current Nitrado credential no longer matches the bound account');
    error.code = 'SERVER_AUTHORIZATION_MISMATCH';
    error.status = 409;
    throw error;
  }
  const services = await nitradoService.listGameServers(token);
  const service = services.find(item => String(item.id) === String(row.platform_server_id));
  if (!service) {
    const error = new Error('The current Nitrado credential cannot access this server');
    error.code = 'SERVER_AUTHORIZATION_MISMATCH';
    error.status = 403;
    throw error;
  }
  if (allowedPlatforms && !allowedPlatforms.includes(service.platform)) {
    const error = new Error('This provider setting is unavailable for the current server platform');
    error.code = 'PROVIDER_SETTING_UNSUPPORTED';
    error.status = 422;
    throw error;
  }
  return { platformServerId: String(row.platform_server_id), token, service };
}

async function mutateProviderSettings({
  db,
  internalServerId,
  expectedPlatformServerId,
  allowedPlatforms = null,
  actor,
  entries,
  action = 'update',
  contextType = null,
  contextId = null,
}) {
  if (!db || typeof db.transaction !== 'function') {
    throw new Error('Provider setting mutations require a database transaction');
  }
  if (!actor?.id) throw new Error('Provider setting mutation actor is required');
  const numericServerId = Number(internalServerId);
  if (!Number.isSafeInteger(numericServerId) || numericServerId <= 0) {
    throw new Error('Invalid canonical server ID');
  }
  const normalizedEntries = validateSettingEntries(entries);

  return db.transaction(async transactionDb => {
    await acquireProviderMutationLock(transactionDb, numericServerId);
    const authorization = await authorizeServerMutation(
      transactionDb,
      actor,
      numericServerId,
      CAPABILITIES.NITRADO_MANAGE
    );
    if (!authorization || Number(authorization.server.id) !== numericServerId) {
      const error = new Error('Provider setting mutation authority was revoked');
      error.code = 'SERVER_AUTHORIZATION_MISMATCH';
      error.status = 403;
      throw error;
    }
    const context = await resolveProviderContext(
      transactionDb,
      numericServerId,
      expectedPlatformServerId,
      allowedPlatforms
    );
    const fileService = createProviderSettingFileService();
    const currentSettings = await nitradoService.getSettings(context.token, context.platformServerId);
    const snapshots = new Map();
    const changedEntries = [];
    for (const entry of normalizedEntries) {
      const categorySettings = currentSettings?.[entry.category];
      if (!categorySettings || typeof categorySettings !== 'object' ||
          !Object.prototype.hasOwnProperty.call(categorySettings, entry.key) ||
          categorySettings[entry.key] === undefined) {
        throw new Error(`Nitrado setting ${entry.category}.${entry.key} has no restorable provider preimage`);
      }
      const snapshot = settingEnvelope(categorySettings[entry.key]);
      if (snapshot === entry.content) continue;
      snapshots.set(entry.resourcePath, snapshot);
      changedEntries.push(entry);
    }
    if (changedEntries.length === 0) return { updated: 0, operationId: null };
    if (changedEntries.length > 5) {
      const error = new Error('At most 5 changed provider settings may be applied atomically');
      error.code = 'PROVIDER_SETTING_BATCH_TOO_LARGE';
      error.status = 413;
      throw error;
    }

    const operationId = await prepareProviderMutation(db, {
      serverId: numericServerId,
      providerServiceId: context.platformServerId,
      workflow: 'provider_settings',
      action,
      contextType,
      contextId,
      plan: { filePaths: changedEntries.map(entry => entry.resourcePath) },
      snapshots,
      triggeredBy: `user:${actor.id}`,
    });
    const journal = createFileMutationJournal(
      context.platformServerId,
      context.token,
      fileService,
      snapshots
    );
    registerProviderMutationRollback(transactionDb, { operationId, journal });

    for (const entry of changedEntries) {
      const slash = entry.resourcePath.lastIndexOf('/');
      await journal.uploadFileToServer(
        context.platformServerId,
        entry.resourcePath.slice(0, slash),
        entry.resourcePath.slice(slash + 1),
        entry.content,
        context.token
      );
    }
    await updatePreparedProviderMutation(transactionDb, operationId, 'completed');
    return { updated: changedEntries.length, operationId: String(operationId) };
  });
}

module.exports = {
  createProviderSettingFileService,
  mutateProviderSettings,
  parseSettingResourcePath,
  settingResourcePath,
};
