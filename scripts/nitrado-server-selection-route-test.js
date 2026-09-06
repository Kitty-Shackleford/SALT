'use strict';

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const express = require('express');

if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

const nitradoService = require('../services/nitradoService');
const providerSettingMutationService = require('../services/providerSettingMutationService');
const { encryptToken } = require('../utils/encryption');
let router;

async function startApp(db, authState) {
  const app = express();
  app.locals.db = db;
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 10, username: 'owner' };
    req.isAuthenticated = () => authState.authenticated;
    next();
  });
  app.use('/api/nitrado', router);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  };
}

async function request(baseUrl, method, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function run() {
  const originals = {
    listGameServers: nitradoService.listGameServers,
    getAuthenticatedUser: nitradoService.getAuthenticatedUser,
    getSettings: nitradoService.getSettings,
    updateSetting: nitradoService.updateSetting,
    mutateProviderSettings: providerSettingMutationService.mutateProviderSettings,
  };
  const calls = { provider: 0, runs: [], hostnameUpdates: [] };
  const state = {
    ownerRow: { id: 7, discord_guild_id: '700', role: 'owner' },
    transactionOwnerRow: { id: 7 },
    principalId: '55',
    services: [{ id: '9001', name: 'Switch\u0000Name', status: 'active', platform: 'switch2' }],
    existing: null,
    customConfig: null,
    registered: [],
    namingServer: null,
    settings: { config: { hostname: 'Visible Server' } },
    verifyMismatch: false,
    activeBounty: null,
    activeCasino: null,
  };
  const db = {
    async get(sql) {
      if (sql.includes('FROM servers s') && sql.includes('JOIN guilds g')) {
        return state.namingServer
          ? { id: state.namingServer.id, guild_id: 7, discord_guild_id: '700', role: 'admin' }
          : null;
      }
      if (sql.includes('FROM guilds g')) {
        return sql.includes('FOR UPDATE') ? state.transactionOwnerRow : state.ownerRow;
      }
      if (sql.includes('FROM guild_tokens')) {
        return { token_hash: encryptToken('test-token'), nitrado_user_id: '55' };
      }
      if (sql.includes('FROM servers WHERE platform_server_id')) return state.existing;
      if (sql.includes("FROM bounties") && sql.includes("status = 'active'")) return state.activeBounty;
      if (sql.includes("FROM casino_sessions") && sql.includes("status = 'active'")) return state.activeCasino;
      if (sql.includes('SELECT s.id, s.name')) return state.namingServer;
      if (sql.includes('SELECT id FROM servers')) return state.namingServer ? { id: state.namingServer.id } : null;
      if (sql.includes('FROM server_features')) return state.customConfig ? { config: state.customConfig } : null;
      throw new Error(`Unexpected get query: ${sql}`);
    },
    async query(sql) {
      if (sql.includes('FROM servers s')) return state.registered;
      throw new Error(`Unexpected query: ${sql}`);
    },
    async run(sql, params) {
      calls.runs.push({ sql, params });
      if (sql.includes('INSERT INTO servers')) return { lastID: 42, changes: 1 };
      return { lastID: null, changes: 1 };
    },
    async transaction(callback) {
      return callback();
    },
  };
  const authState = { authenticated: true };
  nitradoService.listGameServers = async () => {
    calls.provider += 1;
    return state.services;
  };
  nitradoService.getAuthenticatedUser = async () => ({ id: state.principalId });
  nitradoService.getSettings = async () => state.verifyMismatch
    ? { config: { hostname: 'Different value' } }
    : state.settings;
  nitradoService.updateSetting = async (_token, serviceId, category, key, value) => {
    calls.hostnameUpdates.push({ serviceId, category, key, value });
    state.settings = { ...state.settings, config: { ...state.settings.config, hostname: value } };
  };

  providerSettingMutationService.mutateProviderSettings = async options => {
    if (!state.transactionOwnerRow) {
      const error = new Error('Server operator access was revoked; retry after refreshing');
      error.status = 403;
      throw error;
    }
    if (state.principalId !== '55') {
      const error = new Error('The current Nitrado credential no longer matches the bound account');
      error.status = 409;
      throw error;
    }
    const service = state.services.find(item => String(item.id) === String(options.expectedPlatformServerId));
    if (!service) {
      const error = new Error('The current Nitrado credential cannot access this server');
      error.status = 403;
      throw error;
    }
    if (options.allowedPlatforms && !options.allowedPlatforms.includes(service.platform)) {
      const error = new Error('This provider setting is unavailable for the current server platform');
      error.status = 422;
      throw error;
    }
    const entry = options.entries[0];
    calls.hostnameUpdates.push({
      serviceId: options.expectedPlatformServerId,
      category: entry.category,
      key: entry.key,
      value: entry.value,
    });
    if (state.verifyMismatch) {
      const error = new Error('Provider setting verification failed for config.hostname');
      error.status = 502;
      throw error;
    }
    state.settings = { ...state.settings, config: { ...state.settings.config, hostname: entry.value } };
    return { updated: 1, operationId: '1' };
  };
  router = require('../routes/nitrado');

  const { server, baseUrl } = await startApp(db, authState);
  try {
    authState.authenticated = false;
    let result = await request(baseUrl, 'GET', '/api/nitrado/account-servers?guildId=7');
    assert.strictEqual(result.status, 401);

    authState.authenticated = true;
    state.ownerRow = null;
    calls.provider = 0;
    result = await request(baseUrl, 'GET', '/api/nitrado/account-servers?guildId=8');
    assert.strictEqual(result.status, 403);
    assert.strictEqual(calls.provider, 0, 'cross-guild denial must happen before provider access');

    state.ownerRow = { id: 7, discord_guild_id: '700', role: 'owner' };
    result = await request(baseUrl, 'GET', '/api/nitrado/account-servers?guildId=7');
    assert.strictEqual(result.status, 200);
    assert.deepStrictEqual(result.body.servers[0], {
      serviceId: '9001',
      providerName: '9001',
      customName: null,
      displayName: '9001',
      platform: 'switch2',
      platformLabel: 'Switch 2',
      providerStatus: 'active',
      enabled: false,
      registeredServerId: null,
    });

    state.principalId = 'different-account';
    result = await request(baseUrl, 'GET', '/api/nitrado/account-servers?guildId=7');
    assert.strictEqual(result.status, 409);
    state.principalId = '55';

    state.transactionOwnerRow = null;
    calls.provider = 0;
    result = await request(baseUrl, 'PUT', '/api/nitrado/account-servers/9001', {
      guildId: 7,
      enabled: true,
    });
    assert.strictEqual(result.status, 403);
    assert.strictEqual(calls.provider, 0, 'revoked ownership must fail inside the transaction before provider access');
    state.transactionOwnerRow = { id: 7 };

    result = await request(baseUrl, 'PUT', '/api/nitrado/account-servers/9001', {
      guildId: 7,
      enabled: true,
      customName: 'My Switch Server',
    });
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.body.server.enabled, true);
    assert.strictEqual(result.body.server.displayName, 'My Switch Server');
    const insert = calls.runs.find(call => call.sql.includes('INSERT INTO servers'));
    assert(insert, 'enabling must insert an exact server registration');
    assert.strictEqual(insert.sql.includes('last_sync_at'), false, 'new registration must not claim that a file sync occurred');
    assert.deepStrictEqual(insert.params.slice(0, 4), [7, '9001', 'My Switch Server', 'switch2']);

    calls.runs.length = 0;
    state.existing = null;
    result = await request(baseUrl, 'PUT', '/api/nitrado/account-servers/9001', {
      guildId: 7,
      enabled: false,
      customName: 'Cannot Persist Yet',
    });
    assert.strictEqual(result.status, 409);
    assert.strictEqual(calls.runs.length, 0, 'an unregistered disabled service cannot claim a persisted custom name');

    calls.runs.length = 0;
    state.existing = { id: 42, guild_id: 7, status: 'active' };
    state.activeBounty = { id: 500 };
    result = await request(baseUrl, 'PUT', '/api/nitrado/account-servers/9001', {
      guildId: 7,
      enabled: false,
    });
    assert.strictEqual(result.status, 409);
    assert.strictEqual(calls.runs.length, 0, 'active bounty escrow must block server disable');

    state.activeBounty = null;
    state.activeCasino = { session_id: 'held' };
    result = await request(baseUrl, 'PUT', '/api/nitrado/account-servers/9001', {
      guildId: 7,
      enabled: false,
    });
    assert.strictEqual(result.status, 409);
    assert.strictEqual(calls.runs.length, 0, 'active casino escrow must block server disable');

    state.activeCasino = null;
    result = await request(baseUrl, 'PUT', '/api/nitrado/account-servers/9001', {
      guildId: 7,
      enabled: false,
    });
    assert.strictEqual(result.status, 200);
    const update = calls.runs.find(call => call.sql.includes('UPDATE servers'));
    assert(update, 'disabling must update rather than delete the server');
    assert.strictEqual(update.sql.includes('last_sync_at'), false, 'server selection must not claim that a file sync occurred');
    assert.strictEqual(update.params[2], 'inactive');
    assert.strictEqual(calls.runs.some(call => call.sql.includes('DELETE FROM servers')), false);

    state.existing = { id: 99, guild_id: 8, status: 'active' };
    result = await request(baseUrl, 'PUT', '/api/nitrado/account-servers/9001', {
      guildId: 7,
      enabled: true,
    });
    assert.strictEqual(result.status, 409);

    state.existing = null;
    state.services = [];
    result = await request(baseUrl, 'PUT', '/api/nitrado/account-servers/9001', {
      guildId: 7,
      enabled: true,
    });
    assert.strictEqual(result.status, 403);

    calls.provider = 0;
    result = await request(baseUrl, 'PUT', '/api/nitrado/account-servers/9001', {
      guildId: 7,
      enabled: true,
      customName: 'bad\u0000name',
    });
    assert.strictEqual(result.status, 400);
    assert.strictEqual(calls.provider, 0, 'invalid names must fail before provider access');

    state.services = [{ id: '9001', name: 'Provider Server', status: 'active', platform: 'switch2' }];
    state.namingServer = {
      id: 42,
      name: 'Provider Server',
      custom_name_config: JSON.stringify({ value: 'Shop Server' }),
    };
    state.settings = { config: { hostname: '\u0001'.repeat(80) } };
    result = await request(baseUrl, 'GET', '/api/nitrado/account-servers/9001/naming?guildId=7');
    assert.strictEqual(result.status, 200);
    assert.deepStrictEqual(result.body.naming, {
      displayName: 'Shop Server',
      customName: 'Shop Server',
      platform: 'switch2',
      supportsInvisibleHostname: true,
      mode: 'invisible',
      hostname: null,
    });
    assert(!JSON.stringify(result.body).includes('\\u0001'), 'raw invisible hostname must not reach clients');

    calls.runs.length = 0;
    result = await request(baseUrl, 'PUT', '/api/nitrado/account-servers/9001/display-name', {
      guildId: 7,
    });
    assert.strictEqual(result.status, 400, 'displayName must be explicit');
    assert.strictEqual(calls.runs.length, 0);

    result = await request(baseUrl, 'PUT', '/api/nitrado/account-servers/9001/display-name', {
      guildId: 7,
      displayName: 'Easy Shop Name',
    });
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.body.naming.displayName, 'Easy Shop Name');
    assert(calls.runs.some(call => call.sql.includes("feature_name, enabled, config") &&
      call.params[1] === JSON.stringify({ value: 'Easy Shop Name' })));
    assert(calls.runs.some(call => call.sql.includes('UPDATE servers SET name') &&
      call.params[0] === 'Easy Shop Name'));

    state.verifyMismatch = false;
    for (const platform of ['xbox', 'playstation', 'switch2']) {
      state.services[0].platform = platform;
      calls.hostnameUpdates.length = 0;
      result = await request(baseUrl, 'PUT', '/api/nitrado/account-servers/9001/hostname', {
        guildId: 7,
        mode: 'invisible',
      });
      assert.strictEqual(result.status, 200, `${platform} must support invisible hostname mode`);
      assert.deepStrictEqual(result.body.naming, { mode: 'invisible', hostname: null });
      assert.strictEqual(calls.hostnameUpdates[0].value, '\u0001'.repeat(80));
      assert(!JSON.stringify(result.body).includes('\\u0001'), 'hostname mutation response must remain display-safe');
    }

    state.services[0].platform = 'pc';
    calls.hostnameUpdates.length = 0;
    result = await request(baseUrl, 'PUT', '/api/nitrado/account-servers/9001/hostname', {
      guildId: 7,
      mode: 'invisible',
    });
    assert.strictEqual(result.status, 422, 'invisible hostname mode must be limited to console servers');
    assert.strictEqual(calls.hostnameUpdates.length, 0);
    result = await request(baseUrl, 'PUT', '/api/nitrado/account-servers/9001/hostname', {
      guildId: 7,
      mode: 'visible',
      hostname: 'PC Name',
    });
    assert.strictEqual(result.status, 422, 'all dedicated hostname modes must be limited to console servers');
    assert.strictEqual(calls.hostnameUpdates.length, 0);
    state.services[0].platform = 'switch2';

    state.principalId = 'stale-account';
    result = await request(baseUrl, 'PUT', '/api/nitrado/account-servers/9001/hostname', {
      guildId: 7,
      mode: 'invisible',
    });
    assert.strictEqual(result.status, 409, 'hostname mutation must revalidate the bound Nitrado principal');
    assert.strictEqual(calls.hostnameUpdates.length, 0);
    state.principalId = '55';

    state.verifyMismatch = true;
    result = await request(baseUrl, 'PUT', '/api/nitrado/account-servers/9001/hostname', {
      guildId: 7,
      mode: 'visible',
      hostname: 'Visible Server',
    });
    assert.strictEqual(result.status, 502, 'provider hostname readback mismatch must fail closed');
    state.verifyMismatch = false;

    calls.hostnameUpdates.length = 0;
    state.transactionOwnerRow = null;
    result = await request(baseUrl, 'PUT', '/api/nitrado/account-servers/9001/hostname', {
      guildId: 7,
      mode: 'visible',
      hostname: 'Visible Server',
    });
    assert.strictEqual(result.status, 403);
    assert.strictEqual(calls.hostnameUpdates.length, 0, 'revoked ownership must block hostname mutation');
    state.transactionOwnerRow = { id: 7 };

    console.log('Nitrado server-selection route tests passed');
  } finally {
    nitradoService.listGameServers = originals.listGameServers;
    nitradoService.getAuthenticatedUser = originals.getAuthenticatedUser;
    nitradoService.getSettings = originals.getSettings;
    nitradoService.updateSetting = originals.updateSetting;
    providerSettingMutationService.mutateProviderSettings = originals.mutateProviderSettings;
    await new Promise(resolve => server.close(resolve));
  }
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
