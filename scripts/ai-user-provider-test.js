'use strict';

const assert = require('assert').strict;
const fs = require('fs');
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '11'.repeat(32);

async function main() {
  const providerService = require('../services/aiProviderService');
  const aiService = require('../services/aiService');
  const { createPublicAddressLookup, isPublicAddress } = require('../utils/publicAddressLookup');

  assert.throws(
    () => providerService.validateOpenAiConnection({
      token: 'user-provider-secret',
      baseURL: 'http://127.0.0.1:11434/v1/',
      model: 'local-model',
    }),
    error => error.code === 'AI_PROVIDER_HOST_NOT_ALLOWED',
    'a user-controlled provider URL must not reach loopback services',
  );
  assert.throws(
    () => providerService.validateOpenAiConnection({
      token: 'user-provider-secret',
      baseURL: 'https://embedded:credential@api.openai.com/v1/',
      model: 'gpt-4o-mini',
    }),
    error => error.code === 'AI_PROVIDER_URL_CREDENTIALS',
    'provider URLs must not persist or expose embedded credentials',
  );

  const encrypted = require('../utils/encryption').encryptToken('user-provider-secret');
  const openAiDb = {
    async get(sql) {
      assert(sql.includes('ai_provider_connections'));
      return {
        provider_type: 'openai-compatible',
        credential_hash: encrypted,
        base_url: 'https://ai.example.test/v1/',
        model: 'user-model',
      };
    },
  };
  const openAi = await providerService.resolveUserProvider(openAiDb, 7, {});
  assert.deepEqual(openAi, {
    type: 'openai-compatible',
    source: 'user',
    apiKey: 'user-provider-secret',
    baseURL: 'https://ai.example.test/v1/',
    model: 'user-model',
    enforcePublicAddress: true,
  });

  let openAiSaveSql;
  await providerService.saveOpenAiConnection({
    async query(sql) {
      openAiSaveSql = sql;
      return [];
    },
  }, 7, {
    token: 'replacement-provider-secret',
    baseURL: 'https://api.openai.com/v1/',
    model: 'replacement-model',
  });
  assert(
    openAiSaveSql.includes('credential_binding_hash = NULL'),
    'switching from Copilot to OpenAI must clear the prior credential binding',
  );

  const operator = await providerService.resolveUserProvider({ async get() { return null; } }, 7, {
    AI_API_KEY: 'operator-secret',
    AI_API_BASE_URL: 'https://operator.example/v1/',
    AI_MODEL: 'operator-model',
  });
  assert.equal(operator.source, 'operator');
  assert.equal(operator.apiKey, 'operator-secret');

  let openAiTransportConfig;
  const openAiReply = await aiService.callAiApi([{ role: 'user', content: 'hello' }], 0, {
    apiKey: 'user-provider-secret',
    baseURL: 'https://api.openai.com/v1/',
    model: 'user-model',
    enforcePublicAddress: true,
    transport: async config => {
      openAiTransportConfig = config;
      return { data: { choices: [{ finish_reason: 'stop', message: { content: 'openai world' } }] } };
    },
  });
  assert.equal(openAiReply, 'openai world');
  assert.equal(openAiTransportConfig.maxRedirects, 0, 'user provider requests must not follow redirects');
  assert.equal(openAiTransportConfig.proxy, false, 'user provider requests must not use environment proxies');
  assert.equal(typeof openAiTransportConfig.lookup, 'function');

  const privateLookup = createPublicAddressLookup((hostname, options, callback) => {
    callback(null, [{ address: '127.0.0.1', family: 4 }]);
  });
  await assert.rejects(
    () => new Promise((resolve, reject) => privateLookup('api.openai.com', {}, (error, address) => {
      if (error) reject(error);
      else resolve(address);
    })),
    error => error.code === 'AI_PROVIDER_ADDRESS_NOT_ALLOWED',
    'allow-listed provider names must not resolve to private destinations',
  );
  for (const address of ['2001:db8::1', 'fec0::1', '::127.0.0.1']) {
    assert.equal(isPublicAddress(address), false, `${address} must not be treated as public`);
  }

  const copilotToken = require('../utils/encryption').encryptToken('github_pat_copilot-user-token');
  const preparedCopilot = await providerService.prepareCopilotProvider({
    async get() { return { token_hash: copilotToken, token_type: 'pat' }; },
  }, 9, 'auto');
  assert.notEqual(preparedCopilot.credentialBinding, copilotToken);
  assert.match(preparedCopilot.credentialBinding, /^[a-f0-9]{64}$/);
  assert.equal(preparedCopilot.expectedCredentialHash, copilotToken);
  let copilotQueryCount = 0;
  const copilot = await providerService.resolveUserProvider({
    async get(sql) {
      copilotQueryCount += 1;
      if (sql.includes('ai_provider_connections')) {
        return {
          provider_type: 'copilot',
          model: 'auto',
          credential_binding_hash: preparedCopilot.credentialBinding,
        };
      }
      if (sql.includes('github_connections')) return { token_hash: copilotToken, token_type: 'pat' };
      throw new Error(`Unexpected query: ${sql}`);
    },
  }, 9, {});
  assert.equal(copilotQueryCount, 2);
  assert.equal(copilot.type, 'copilot');
  assert.equal(copilot.githubToken, 'github_pat_copilot-user-token');
  assert.equal(copilot.source, 'user');

  await assert.rejects(
    () => providerService.resolveUserProvider({
      async get(sql) {
        if (sql.includes('ai_provider_connections')) {
          return { provider_type: 'copilot', model: 'auto', credential_binding_hash: copilotToken };
        }
        return { token_hash: require('../utils/encryption').encryptToken('ghp_classic-token'), token_type: 'pat' };
      },
    }, 10, {}),
    error => error.code === 'COPILOT_TOKEN_UNSUPPORTED',
  );

  let capturedClientOptions;
  let capturedSessionOptions;
  let capturedPrompt;
  let stopped = false;
  const copilotReply = await aiService.callCopilotApi(
    [{ role: 'system', content: 'system rules' }, { role: 'user', content: 'hello' }],
    {
      githubToken: 'github_pat_copilot-user-token',
      model: 'auto',
      sdkFactory: async options => {
        capturedClientOptions = options;
        return {
          async createSession(sessionOptions) {
            capturedSessionOptions = sessionOptions;
            return {
              async sendAndWait({ prompt }) {
                capturedPrompt = prompt;
                return { data: { content: 'copilot world' } };
              },
            };
          },
          async stop() { stopped = true; },
        };
      },
    },
  );
  assert.equal(copilotReply, 'copilot world');
  assert.equal(capturedClientOptions.mode, 'empty');
  assert(capturedClientOptions.baseDirectory, 'empty mode requires an isolated session directory');
  assert.equal(capturedClientOptions.workingDirectory, capturedClientOptions.baseDirectory);
  assert.equal(capturedClientOptions.gitHubToken, 'github_pat_copilot-user-token');
  assert.equal(capturedClientOptions.useLoggedInUser, false);
  assert.notEqual(capturedClientOptions.env, process.env);
  assert.equal(capturedClientOptions.env.AI_API_KEY, undefined);
  assert.deepEqual(capturedSessionOptions.availableTools, []);
  assert.equal(capturedSessionOptions.gitHubToken, 'github_pat_copilot-user-token');
  assert(capturedSessionOptions.systemMessage.content.includes('system rules'));
  assert(!capturedPrompt.includes('system rules') && capturedPrompt.includes('hello'));
  assert(stopped, 'Copilot client must be stopped after the request');
  assert(!fs.existsSync(capturedClientOptions.baseDirectory), 'Copilot session directory must be removed');

  let timedOutClientStopped = false;
  let timedOutClientForceStopped = false;
  await assert.rejects(
    () => aiService.callCopilotApi([{ role: 'user', content: 'wait' }], {
      githubToken: 'github_pat_copilot-user-token',
      timeoutMs: 5,
      cleanupTimeoutMs: 5,
      sdkFactory: async () => ({
        async createSession() {
          return { async sendAndWait() { return new Promise(resolve => setTimeout(resolve, 50)); } };
        },
        async stop() {
          timedOutClientStopped = true;
          return new Promise(resolve => setTimeout(resolve, 50));
        },
        async forceStop() { timedOutClientForceStopped = true; },
      }),
    }),
    error => error.code === 'AI_COPILOT_TIMEOUT',
  );
  assert(timedOutClientStopped, 'timed-out Copilot clients must be stopped');
  assert(timedOutClientForceStopped, 'hung Copilot cleanup must escalate to forceStop');

  let startupDirectory;
  await assert.rejects(
    () => aiService.callCopilotApi([{ role: 'user', content: 'wait' }], {
      githubToken: 'github_pat_copilot-user-token',
      timeoutMs: 5,
      sdkFactory: async options => {
        startupDirectory = options.baseDirectory;
        return new Promise(resolve => setTimeout(() => resolve({}), 50));
      },
    }),
    error => error.code === 'AI_COPILOT_TIMEOUT',
    'Copilot client startup must share the request deadline',
  );
  assert(!fs.existsSync(startupDirectory), 'timed-out Copilot startup directory must be removed');

  await assert.rejects(
    () => providerService.selectCopilot({
      async transaction(callback) {
        return callback({
          async get(sql, params) {
            assert(sql.includes('FOR UPDATE'));
            assert.equal(params[0], 9);
            return { token_hash: 'replacement-ciphertext' };
          },
          async query() {
            throw new Error('stale credentials must be rejected before persistence');
          },
        });
      },
    }, 9, {
      model: 'auto',
      credentialBinding: 'expected-binding',
      expectedCredentialHash: 'expected-ciphertext',
    }),
    error => error.code === 'COPILOT_GITHUB_CHANGED',
    'Copilot selection must fail if the verified GitHub credential changed before persistence',
  );

  const status = await providerService.getUserProviderStatus({
    async get(sql) {
      if (sql.includes('ai_provider_connections')) return { provider_type: 'openai-compatible', base_url: 'https://ai.example.test/v1/', model: 'user-model' };
      return null;
    },
  }, 7, {});
  assert.deepEqual(status, { configured: true, type: 'openai-compatible', source: 'user', model: 'user-model', baseURL: 'https://ai.example.test/v1/' });
  assert(!JSON.stringify(status).includes('secret'));

  const unsupportedCopilotStatus = await providerService.getUserProviderStatus({
    async get(sql) {
      if (sql.includes('ai_provider_connections')) {
        return { provider_type: 'copilot', model: 'auto', credential_binding_hash: 'classic-binding' };
      }
      return { token_hash: require('../utils/encryption').encryptToken('ghp_classic-token'), token_type: 'pat' };
    },
  }, 7, {});
  assert.equal(unsupportedCopilotStatus.configured, false);
  assert.equal(unsupportedCopilotStatus.requiresGitHubReconnect, true);

  const supportedCopilotStatus = await providerService.getUserProviderStatus({
    async get(sql) {
      if (sql.includes('ai_provider_connections')) {
        return {
          provider_type: 'copilot',
          model: 'auto',
          credential_binding_hash: preparedCopilot.credentialBinding,
        };
      }
      return { token_hash: copilotToken, token_type: 'pat' };
    },
  }, 9, {});
  assert.equal(supportedCopilotStatus.configured, true);
  assert.equal(supportedCopilotStatus.requiresGitHubReconnect, false);

  const contextQueries = [];
  const contextDb = {
    async get(sql, params) {
      contextQueries.push({ sql, params });
      if (sql.includes('FROM servers')) {
        return { name: 'Test Server', platform: 'pc', platform_server_id: 'provider-123' };
      }
      if (sql.includes('COUNT(DISTINCT killer_identity_id)')) {
        assert(sql.includes('timestamp >= $2'), 'player activity must use kill_events.timestamp');
        return { approx_players: 4 };
      }
      if (sql.includes('FROM server_features')) return null;
      throw new Error(`Unexpected context get query: ${sql}`);
    },
    async query(sql, params) {
      contextQueries.push({ sql, params });
      if (sql.includes('FROM kill_events')) {
        assert(sql.includes('timestamp >= $2'), 'kill summary must use kill_events.timestamp');
        return [{ weapon: 'M4A1', cnt: '2' }];
      }
      if (sql.includes('FROM loot_despawn_events')) {
        assert(sql.includes('log_date >= $2'), 'loot summary must use loot_despawn_events.log_date');
        assert(!sql.includes('event_type'), 'loot despawn rows do not have an event_type column');
        return [{ item_class: 'Ammo_556x45', cnt: '3' }];
      }
      throw new Error(`Unexpected context query: ${sql}`);
    },
  };
  const serverContext = await aiService.buildServerContext(contextDb, 42, 7);
  assert(serverContext.includes('2 total kills | Top weapons: M4A1 (2)'));
  assert(serverContext.includes('3 despawn events | Most despawned: Ammo_556x45 (3)'));
  assert(serverContext.includes('Approximate unique active players: 4'));
  assert(contextQueries.every(({ params }) => params[0] === 42), 'all context queries must use the internal server ID');

  const routeSource = fs.readFileSync(require.resolve('../routes/ai'), 'utf8');
  const pageSource = fs.readFileSync(require.resolve('../public/dashboard/ai-assistant.html'), 'utf8');
  const browserSource = fs.readFileSync(require.resolve('../public/js/ai-assistant.js'), 'utf8');
  const migrationSource = fs.readFileSync(require.resolve('../db/migrations/059_user_ai_providers'), 'utf8');
  const dockerfileSource = fs.readFileSync(require.resolve('../Dockerfile'), 'utf8');
  assert(routeSource.includes("router.put('/provider/connection'"));
  assert(routeSource.includes("router.delete('/provider/connection'"));
  assert(routeSource.includes('resolveUserProvider(db, userId)'));
  assert(routeSource.includes('selectCopilot(db, userId, provider)'));
  assert(pageSource.includes('aiProviderModal') && pageSource.includes('AI provider token'));
  assert(pageSource.includes('Copilot Requests'));
  assert(pageSource.includes('aiProviderDisconnectBtn'));
  assert(browserSource.includes("data.source === 'operator'"));
  assert(browserSource.includes('/api/ai/provider/connection'));
  assert(browserSource.includes('Network error while connecting AI provider.'));
  assert.match(
    browserSource,
    /function closeConnectModal\(\)\s*\{[^}]*patInput[^}]*\.value\s*=\s*''/s,
    'closing the GitHub connection modal must clear the plaintext PAT field',
  );
  assert.match(
    browserSource,
    /function updateAiProviderFields\(\)\s*\{[^}]*copilot[^}]*aiProviderToken[^}]*\.value\s*=\s*''/s,
    'switching to Copilot must immediately clear the hidden OpenAI provider token',
  );
  assert(migrationSource.includes('UNIQUE(user_id)'));
  assert.match(
    dockerfileSource,
    /^FROM node:(?:2[2-9]|[3-9][0-9])(?:\s|$)/m,
    'backend runtime must provide Promise.withResolvers for the pinned Copilot CLI',
  );
  assert(!routeSource.includes('res.json({ token'));

  console.log('✅ Per-user AI provider and Copilot tests passed');
}

main().catch(error => {
  console.error('❌ Per-user AI provider test failed:', error);
  process.exitCode = 1;
});
