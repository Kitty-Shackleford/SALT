#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function source(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function finalHandler(router, routePath, method = 'get') {
  const layer = router.stack.find(entry => entry.route?.path === routePath && entry.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${routePath} must exist`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function testStorageIdentifiersCannotEscapeAuthorizedRoots() {
  const {
    listContainedDirectorySync,
    normalizeStorageIdentifier,
    openContainedDirectorySync,
    statContainedFileSync,
  } = require('../utils/safePath');
  assert.strictEqual(typeof openContainedDirectorySync, 'function',
    'descriptor-anchored directory opening must be available to route consumers');
  assert.strictEqual(normalizeStorageIdentifier('service-41', 'server ID'), 'service-41');
  for (const value of ['../outside', 'a/b', 'a\\b', '.', '..', '', 'name with spaces']) {
    assert.throws(
      () => normalizeStorageIdentifier(value, 'server ID'),
      /Invalid server ID/,
      `storage identifier should reject ${JSON.stringify(value)}`
    );
  }
  if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);
  const { getGuildDownloadPath } = require('../services/logSyncService');
  assert.throws(
    () => getGuildDownloadPath('guild-a', '../outside'),
    /Invalid server storage identifier/
  );

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'salt-codeql-path-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'salt-codeql-outside-'));
  try {
    fs.mkdirSync(path.join(tempRoot, 'safe'));
    fs.writeFileSync(path.join(tempRoot, 'safe', 'types.xml'), '<types/>');
    fs.symlinkSync(outside, path.join(tempRoot, 'escape'));
    assert.deepStrictEqual(
      listContainedDirectorySync(tempRoot, 'safe').map(entry => entry.name),
      ['types.xml']
    );
    assert.strictEqual(statContainedFileSync(tempRoot, 'safe/types.xml').isFile(), true);
    assert.throws(() => listContainedDirectorySync(tempRoot, 'escape'), /Invalid file path/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

function testBrowserRenderingKeepsUntrustedTextOutOfHtmlSinks() {
  const boost = source('public/js/boostManager.js');
  assert(!/wrap\.innerHTML\s*=\s*`[^`]*\$\{err\.message\}/s.test(boost),
    'boost API exceptions must not be interpolated into innerHTML');
  assert(boost.includes("wrap.textContent = `❌ ${err.message}`"),
    'boost errors should be rendered as text');

  const assistant = source('public/js/ai-assistant.js');
  assert(!/chatMessages'\)\.innerHTML\s*=\s*`[\s\S]*?\$\{filename\} loaded/.test(assistant),
    'mission filenames must not be interpolated into chat HTML');
  assert(assistant.includes('loadedFileName.textContent = `${filename} loaded`;'),
    'mission filenames should be rendered as text');

  const analytics = source('public/js/admin/economy-analytics.js');
  assert(!analytics.includes('${p.gamertag}'),
    'gamertags must not be interpolated into analytics HTML');
  assert(analytics.includes('name.textContent = `#${index + 1} ${player.gamertag ||'),
    'analytics ranking names should be rendered as text');
  assert(analytics.includes('encodeURIComponent(currentServerId)'),
    'analytics export must encode the selected server identifier');
  assert(analytics.includes("['7', '30', '90'].includes(selectedDays)"),
    'analytics export must allowlist the selected date range');

  const map = source('public/js/map.js');
  assert(!map.includes("getElementById('radius-results').innerHTML = resultText"),
    'map event names must not flow through innerHTML');
  assert(map.includes('results.replaceChildren(summary);'),
    'map radius results should be assembled with DOM text nodes');
}

function testCsrfAndPageRateLimitMiddlewareOrder() {
  const middleware = source('src/app/registerMiddleware.js');
  assert(middleware.includes('app.use(csrfProtection);'),
    'CSRF protection should be registered directly so static analysis and Express share one global guard');

  const routes = source('src/app/registerRoutes.js');
  for (const signature of [
    "app.get('/metrics', apiLimiter, ensureAuthenticated, ensureAdmin,",
    "app.get('/favicon.ico', apiLimiter,",
    "app.get('/player', apiLimiter, ensureAuthenticated,",
    "app.get('/player-map', apiLimiter, ensureAuthenticated,",
    "app.get('/dashboard', apiLimiter, ensureAuthenticated,",
    "app.use('/admin/*', apiLimiter, ensureAuthenticated, ensureAdmin);",
    "app.get('/admin', apiLimiter, ensureAuthenticated, ensureAdmin,",
    "app.get('/dashboard/roles', apiLimiter, ensureAuthenticated,",
  ]) {
    assert(routes.includes(signature), `rate limiter must precede protected work: ${signature}`);
  }
  assert(!/app\.get\([^\n]+ensureAuthenticated, apiLimiter/.test(routes),
    'page routes must rate-limit before authentication work');
  assert(routes.includes("app.get('/logout', apiLimiter, ensureAuthenticated"),
    'logout navigation should render a confirmation without mutating the session');
  assert(routes.includes("app.post('/logout', apiLimiter, ensureAuthenticated"),
    'logout must use a CSRF-protected unsafe method');
  const getLogoutBlock = routes.slice(
    routes.indexOf("app.get('/logout'"),
    routes.indexOf("app.post('/logout'")
  );
  assert(!getLogoutBlock.includes('req.logout('), 'GET /logout must not mutate authentication state');
}

function testRegexAndDiagnosticHardening() {
  const validation = source('services/validationService.js');
  assert(!validation.includes('/\\s+$/.test(item.line)'),
    'trailing-whitespace detection should not use an ambiguous end-anchored repetition');
  assert(!validation.includes("line.replace(/\\s+$/, '')"),
    'trailing-whitespace removal should use the linear-time string primitive');

  const platform = source('utils/dayzPlatform.js');
  assert(!platform.includes("value.replace(/\\/+$/, '')"),
    'provider path normalization should avoid an end-anchored repetition');

  const scanScript = source('scripts/run-scan-save-container.js');
  assert(!scanScript.includes("JSON.stringify(rows, null, 2)"),
    'diagnostic scans must not print identity records');
  assert(!scanScript.includes("JSON.stringify(gamertags, null, 2)"),
    'diagnostic scans must not print gamertag records');

  const unitTests = source('scripts/unit-test.js');
  assert(unitTests.includes('/\\son[a-z]+\\s*=/i'),
    'the inline-handler security check must reject uppercase HTML attributes');
  assert(!unitTests.includes("source.includes('api.nitrado.net')"),
    'source inventory checks must not resemble substring URL validation');

  const integrationTests = source('scripts/external-integrations-test.js');
  assert(!integrationTests.includes("aiServiceSource.includes('models.inference.ai.azure.com')"),
    'retired-host checks must not resemble substring URL validation');
}

async function testLootParserRejectsDeclaredPathTraversal() {
  const guildId = `codeql-test-${process.pid}`;
  const serverId = 'service-41';
  const guildRoot = path.join(ROOT, 'downloads', guildId);
  const mapDir = path.join(guildRoot, `server_${serverId}`, 'mpmissions', 'dayzOffline.chernarusplus');
  fs.mkdirSync(path.join(mapDir, 'db'), { recursive: true });
  fs.writeFileSync(
    path.join(mapDir, 'cfgeconomycore.xml'),
    '<economycore><ce folder="../outside"><file type="types" name="types.xml"/></ce></economycore>'
  );
  try {
    const { getLootData, invalidateCache } = require('../services/lootParserService');
    invalidateCache();
    await assert.rejects(
      getLootData('chernarusplus', guildId, serverId),
      /Invalid mission folder/
    );
    await assert.rejects(
      getLootData('chernarusplus', guildId, '../outside'),
      /Invalid server storage identifier/
    );
  } finally {
    fs.rmSync(guildRoot, { recursive: true, force: true });
  }
}

async function testMissionFileReadsStayAnchoredToTheMatchedLegacyRoot() {
  if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);
  const suffix = String(process.pid);
  const guildId = `codeql-guild-${suffix}`;
  const userDiscordId = `codeql-user-${suffix}`;
  const serverId = `service-${suffix}`;
  const canonicalRoot = path.join(ROOT, 'downloads', guildId, `server_${serverId}`);
  const legacyRoot = path.join(ROOT, 'downloads', userDiscordId, `server_${serverId}`);
  fs.mkdirSync(canonicalRoot, { recursive: true });
  fs.mkdirSync(legacyRoot, { recursive: true });
  fs.writeFileSync(path.join(legacyRoot, 'types.xml'), '<types><type name="Legacy"/></types>');

  try {
    const router = require('../routes/missionFiles');
    const handler = finalHandler(router, '/mission-files/:serverId/:fileName(*)');
    const req = {
      params: { serverId, fileName: 'types.xml' },
      user: { id: 7, discord_id: userDiscordId, username: 'tester' },
      app: { locals: { db: { async get() {
        return {
          server_id: 41,
          guild_id: 4,
          platform_server_id: serverId,
          server_status: 'active',
          discord_guild_id: guildId,
          guild_status: 'approved',
          guild_role: 'owner',
        };
      } } } },
    };
    const res = responseRecorder();
    await handler(req, res);
    assert.strictEqual(res.statusCode, 200,
      'mission files found in a legacy root must be read relative to that same root');
    assert.strictEqual(res.body?.content, '<types><type name="Legacy"/></types>');
  } finally {
    fs.rmSync(path.join(ROOT, 'downloads', guildId), { recursive: true, force: true });
    fs.rmSync(path.join(ROOT, 'downloads', userDiscordId), { recursive: true, force: true });
  }
}

async function testDiscordWebhookHostIsValidatedAtTheRequestSink() {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), redirect: options.redirect });
    return {
      ok: true,
      async text() { return ''; },
    };
  };

  try {
    const { postViaWebhook } = require('../utils/discordPoster');
    const rejected = await postViaWebhook(
      'https://discord.com.attacker.invalid/api/webhooks/123/token',
      'test message'
    );
    assert.strictEqual(rejected, false, 'a lookalike Discord hostname must be rejected');
    assert.deepStrictEqual(calls, [], 'an invalid webhook URL must not reach fetch');

    const accepted = await postViaWebhook(
      'https://discord.com/api/webhooks/123/token',
      'test message'
    );
    assert.strictEqual(accepted, true, 'a canonical Discord webhook URL should be accepted');
    assert.deepStrictEqual(calls, [{
      url: 'https://discord.com/api/webhooks/123/token',
      redirect: 'error',
    }]);
  } finally {
    global.fetch = originalFetch;
  }
}

async function testDiscordChannelIdsAreValidatedAtTheRequestSink() {
  const originalFetch = global.fetch;
  const originalBotToken = process.env.DISCORD_BOT_TOKEN;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), redirect: options.redirect });
    return { ok: true };
  };
  process.env.DISCORD_BOT_TOKEN = 'non-secret-test-token';

  try {
    const { postViaBot } = require('../utils/discordPoster');
    const rejected = await postViaBot('123/../../webhooks/456/token', 'test message');
    assert.strictEqual(rejected, false, 'a malformed Discord channel ID must be rejected');
    assert.deepStrictEqual(calls, [], 'an invalid channel ID must not reach fetch');

    const accepted = await postViaBot('900000000000000099', 'test message');
    assert.strictEqual(accepted, true, 'a canonical Discord channel ID should be accepted');
    assert.deepStrictEqual(calls, [{
      url: 'https://discord.com/api/v10/channels/900000000000000099/messages',
      redirect: 'error',
    }]);
  } finally {
    global.fetch = originalFetch;
    if (originalBotToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
    else process.env.DISCORD_BOT_TOKEN = originalBotToken;
  }
}

async function main() {
  testStorageIdentifiersCannotEscapeAuthorizedRoots();
  testBrowserRenderingKeepsUntrustedTextOutOfHtmlSinks();
  testCsrfAndPageRateLimitMiddlewareOrder();
  testRegexAndDiagnosticHardening();
  await testLootParserRejectsDeclaredPathTraversal();
  await testMissionFileReadsStayAnchoredToTheMatchedLegacyRoot();
  await testDiscordWebhookHostIsValidatedAtTheRequestSink();
  await testDiscordChannelIdsAreValidatedAtTheRequestSink();
  console.log('Code-scanning regression tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
