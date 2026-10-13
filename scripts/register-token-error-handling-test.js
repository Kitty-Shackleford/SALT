'use strict';

// Standalone error-handling contract for /register-token: verifies the
// Nitrado OAuth scope validation, the 5xx/timeout backoff, and the fallback
// to the legacy /user + /services flow. The HTTP layer is stubbed; the real
// command and the real service scope/retry logic are exercised.
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { ExternalApiError } = require('../utils/externalApiClient');

const root = path.resolve(__dirname, '..');
const tests = [];
const test = (name, run) => tests.push({ name, run });
const TOKEN = 'fixture-token-not-a-credential';

function buildInteraction() {
  const replies = [];
  return {
    replies,
    interaction: {
      guild: { id: '700', name: 'Fixture guild', iconURL: () => null },
      user: { id: '111', username: 'Fixture user', avatar: null },
      options: { getString: () => TOKEN },
      reply: async value => replies.push({ kind: 'reply', ...value }),
      deferReply: async () => {},
      editReply: async value => replies.push({ kind: 'edit', ...value }),
      client: { guilds: { fetch: async () => ({
        id: '700',
        ownerId: '111',
        members: { fetch: async ({ user }) => ({
          guild: { id: '700' },
          user: { id: user, username: 'Fixture user', avatar: null },
          permissions: { has: () => true },
        }) },
      }) } },
    },
  };
}

// Throws if the command reaches the database (it must not, in pre-DB paths).
function throwingPool() {
  return { connect: async () => ({
    query: async (sql) => { throw new Error(`unexpected DB access: ${String(sql).slice(0, 40)}`); },
    release() {},
  }) };
}

async function runCommand(serviceStub) {
  const { interaction, replies } = buildInteraction();
  const commandPath = path.join(root, 'bot/commands/register-token.js');
  const servicePath = path.join(root, 'bot/services/guildSetupService.js');
  const injected = new Map([
    [path.join(root, 'bot/db.js'), throwingPool()],
    [path.join(root, 'utils/encryption.js'), { encryptToken: () => 'encrypted-fixture' }],
    [path.join(root, 'services/nitradoService.js'), serviceStub],
    [path.join(root, 'bot/utils/website.js'), { getWebsiteLink: () => 'https://dashboard.invalid' }],
  ]);
  delete require.cache[commandPath];
  delete require.cache[servicePath];
  const originalLoad = Module._load;
  Module._load = function (request, parent, main) {
    if (request === 'discord.js') return {
      SlashCommandBuilder: function () {
        const builder = {};
        for (const key of ['setName', 'setDescription', 'addStringOption', 'setDefaultMemberPermissions']) {
          builder[key] = () => builder;
        }
        return builder;
      },
      PermissionFlagsBits: { Administrator: 8n },
      MessageFlags: { Ephemeral: 64 },
    };
    const resolved = Module._resolveFilename(request, parent);
    if (injected.has(resolved)) return injected.get(resolved);
    return originalLoad.call(this, request, parent, main);
  };
  const logs = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.log = (...args) => logs.push(args);
  console.warn = (...args) => logs.push(args);
  console.error = (...args) => logs.push(args);
  try {
    await require(commandPath).execute(interaction);
  } finally {
    Module._load = originalLoad;
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
    delete require.cache[commandPath];
    delete require.cache[servicePath];
  }
  return { replies, logs };
}

function lastEdit(replies) {
  return replies.filter(r => r.kind === 'edit').at(-1);
}

// ---------------------------------------------------------------------------
// (a) Valid token missing a required scope -> specific, actionable message.
// ---------------------------------------------------------------------------
test('valid token missing user_info/service gets a specific scope message', async () => {
  const calls = { validate: 0, data: 0 };
  const stub = {
    validateRegistrationToken: async () => {
      calls.validate += 1;
      return { status: 'valid', userId: '900', username: 'fixture', scopes: ['service'], missingScopes: ['user_info'] };
    },
    getRegistrationData: async () => {
      calls.data += 1;
      return { dayzServers: [{ id: '901', name: 'S', platform: 'xbox' }], user: { id: '900' } };
    },
  };
  const { replies } = await runCommand(stub);
  assert.equal(calls.validate, 1, 'scope validation must run exactly once');
  assert.equal(calls.data, 0, 'no provider read calls when a scope is missing');
  const content = lastEdit(replies).content;
  assert.match(content, /missing the permission scope/, 'must name the missing-scope condition');
  assert.match(content, /user_info/, 'must name the missing scope user_info');
  assert.match(content, /service/, 'must reference the service scope');
  assert.match(content, /API Tokens/i, 'must point at the Nitrado panel token settings');
  assert.match(content, /re-run this command/i, 'must tell the user to re-run');
  assert(!/registered successfully/.test(content));
  assert(!/temporarily unavailable/.test(content));
});

test('valid token missing both scopes lists both', async () => {
  const stub = {
    validateRegistrationToken: async () => ({ status: 'valid', userId: '900', username: 'f', scopes: [], missingScopes: ['user_info', 'service'] }),
    getRegistrationData: async () => {
      throw new Error('must not reach provider reads');
    },
  };
  const { replies } = await runCommand(stub);
  const content = lastEdit(replies).content;
  assert.match(content, /user_info/);
  assert.match(content, /service/);
});

// ---------------------------------------------------------------------------
// (b) 5xx / timeout -> friendly "temporarily unavailable" message + bounded
//     retry of the initial /user + /services calls.
// ---------------------------------------------------------------------------
test('5xx during provider reads is retried then reported as temporarily unavailable', async () => {
  const delays = [];
  const transient = new ExternalApiError('Nitrado', 'list DayZ services', 'upstream', 502);
  // Use the REAL service retry logic so the backoff is genuinely exercised.
  const { createNitradoService } = require('../services/nitradoService');
  const real = createNitradoService({
    request: async () => { throw transient; },
    registrationSleep: async ms => { delays.push(ms); },
    tokenInfoFetcher: async () => ({
      status: 200, ok: true, headers: {},
      json: async () => ({ data: { token: { user: { id: 900, username: 'f' }, scopes: ['user_info', 'service'] } } }),
    }),
  });
  const { replies } = await runCommand(real);
  const content = lastEdit(replies).content;
  assert.match(content, /temporarily unavailable/, '5xx must not say "check your token"');
  assert(!/check your token/i.test(content), 'temporary error must not ask the user to re-copy the token');
  assert(delays.length >= 1, 'bounded retry must insert at least one backoff delay');
  assert.ok(delays.every(d => d > 0 && d <= 5000), 'backoff delays must be bounded and positive');
});

test('timeout during provider reads is reported as temporarily unavailable (no 5xx-only retry)', async () => {
  const { createNitradoService } = require('../services/nitradoService');
  const delays = [];
  const real = createNitradoService({
    request: async () => { throw new ExternalApiError('Nitrado', 'list DayZ services', 'timeout', null); },
    registrationSleep: async ms => { delays.push(ms); },
    tokenInfoFetcher: async () => ({
      status: 200, ok: true, headers: {},
      json: async () => ({ data: { token: { user: { id: 900, username: 'f' }, scopes: ['user_info', 'service'] } } }),
    }),
  });
  const { replies } = await runCommand(real);
  const content = lastEdit(replies).content;
  assert.match(content, /temporarily unavailable/, 'a timeout must not say "check your token"');
  assert(!/check your token/i.test(content));
  assert.equal(delays.length, 0, 'timeouts must not be retried by the 5xx-only bounded retry');
});

test('retries are bounded (maxRegistrationRetries) and honor the cap', async () => {
  const { createNitradoService } = require('../services/nitradoService');
  const delays = [];
  let providerCalls = 0;
  const transient = new ExternalApiError('Nitrado', 'list DayZ services', 'upstream', 503);
  const real = createNitradoService({
    request: async () => {
      providerCalls += 1;
      throw transient;
    },
    maxRegistrationRetries: 2,
    registrationSleep: async ms => { delays.push(ms); },
    tokenInfoFetcher: async () => ({
      status: 200, ok: true, headers: {},
      json: async () => ({ data: { token: { user: { id: 900, username: 'f' }, scopes: ['user_info', 'service'] } } }),
    }),
  });
  await assert.rejects(
    () => real.getRegistrationData(TOKEN),
    error => error.category === 'upstream' && error.status === 503,
  );
  // 2 calls per attempt (listGameServers + getAuthenticatedUser) x (1 + 2 retries).
  assert.equal(providerCalls, 6, 'must stop after maxRegistrationRetries, not retry forever');
  assert.equal(delays.length, 2, 'exactly maxRegistrationRetries backoff delays');
});

// ---------------------------------------------------------------------------
// (c) Scope-check failure (token-info 5xx / network) falls back to the legacy
//     /user + /services flow.
// ---------------------------------------------------------------------------
test('token-info 5xx falls back to the legacy /user + /services flow', async () => {
  const { createNitradoService } = require('../services/nitradoService');
  const real = createNitradoService({
    request: async c => {
      if (c.path === '/services') return { data: { status: 'success', data: { services: [] } }, headers: {} };
      if (c.path === '/user') return { data: { status: 'success', data: { user: { id: 900, username: 'f' } } }, headers: {} };
      throw new Error(`unexpected ${c.path}`);
    },
    tokenInfoFetcher: async () => ({ status: 502, ok: false, headers: {}, json: async () => ({}) }),
  });
  const validation = await real.validateRegistrationToken(TOKEN);
  assert.equal(validation.status, 'unavailable', 'token-info failure must not hard-fail');
  // The legacy flow is reachable: getRegistrationData uses the normal requests.
  const data = await real.getRegistrationData(TOKEN);
  assert.equal(data.user.id, '900', 'fallback must still resolve the user via /user');
  assert.deepEqual(data.dayzServers, [], 'fallback must still list services');
});

test('token-info network failure falls back and does not report a bad token', async () => {
  const { createNitradoService } = require('../services/nitradoService');
  const real = createNitradoService({
    request: async c => {
      if (c.path === '/services') return { data: { status: 'success', data: { services: [] } }, headers: {} };
      if (c.path === '/user') return { data: { status: 'success', data: { user: { id: 900, username: 'f' } } }, headers: {} };
      throw new Error(`unexpected ${c.path}`);
    },
    tokenInfoFetcher: async () => {
      const networkError = new Error('network down');
      networkError.code = 'ECONNREFUSED';
      throw networkError;
    },
  });
  const validation = await real.validateRegistrationToken(TOKEN);
  assert.equal(validation.status, 'unavailable');
  assert.equal(validation.reason, 'network');
  const data = await real.getRegistrationData(TOKEN);
  assert.equal(data.user.id, '900');
});

test('command proceeds to registration when scope check is unavailable', async () => {
  const { createNitradoService } = require('../services/nitradoService');
  // token-info is down, but the real /services + /user work. The command must
  // proceed (no scope rejection) and reach the "no DayZ servers" early return,
  // which happens BEFORE any DB write, so throwingPool() is safe.
  const real = createNitradoService({
    request: async c => {
      if (c.path === '/services') return { data: { status: 'success', data: { services: [] } }, headers: {} };
      if (c.path === '/user') return { data: { status: 'success', data: { user: { id: 900, username: 'f' } } }, headers: {} };
      throw new Error(`unexpected ${c.path}`);
    },
    tokenInfoFetcher: async () => ({ status: 503, ok: false, headers: {}, json: async () => ({}) }),
  });
  const { replies } = await runCommand(real);
  const content = lastEdit(replies).content;
  assert.match(content, /No DayZ servers found/, 'fallback must reach the provider read flow, not a scope denial');
  assert(!/missing the permission scope/.test(content), 'unavailable scope check must not produce a scope denial');
});

test('invalid token (401 access_token_not_valid) keeps the friendly message', async () => {
  const calls = { validate: 0, data: 0 };
  const stub = {
    validateRegistrationToken: async () => {
      calls.validate += 1;
      return { status: 'invalid', errorCode: 'access_token_not_valid' };
    },
    getRegistrationData: async () => {
      calls.data += 1;
      return { dayzServers: [], user: { id: '900' } };
    },
  };
  const { replies } = await runCommand(stub);
  assert.equal(calls.validate, 1);
  assert.equal(calls.data, 0, 'an invalid token must not trigger provider reads');
  const content = lastEdit(replies).content;
  assert.match(content, /could not be used to sign in/, 'invalid token keeps a friendly message');
  assert.match(content, /check that you copied the full token/i);
  assert(!/temporarily unavailable/.test(content));
});

(async () => {
  const filter = process.argv[2];
  let count = 0;
  for (const entry of tests.filter(t => !filter || t.name.includes(filter))) {
    const timeout = setTimeout(() => { console.error(`Test timed out: ${entry.name}`); process.exit(1); }, 10000);
    try {
      await entry.run();
    } finally {
      clearTimeout(timeout);
    }
    count += 1;
    console.log(`PASS ${entry.name}`);
  }
  assert(count > 0, 'test filter matched no tests');
  console.log(`PASS ${count} register-token error-handling tests`);
})().catch(error => { console.error(error); process.exitCode = 1; });
