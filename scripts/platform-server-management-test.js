'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

function testCanonicalPlatformDetection() {
  const {
    detectDayzPlatform,
    platformLabel,
  } = require('../utils/dayzPlatform');

  assert.strictEqual(detectDayzPlatform({ details: { game: 'DayZ (Xbox One)' } }), 'xbox');
  assert.strictEqual(detectDayzPlatform({ details: { game: 'DayZ (PS4)' } }), 'playstation');
  assert.strictEqual(detectDayzPlatform({ details: { game: 'DayZ (Switch 2)' } }), 'switch2');
  assert.strictEqual(detectDayzPlatform({ game: 'dayzswitch' }), 'switch2');
  assert.strictEqual(detectDayzPlatform({ game: 'dayzstandalone' }), 'pc');
  assert.strictEqual(detectDayzPlatform({ details: { game: 'Minecraft' } }), 'unknown');
  assert.strictEqual(platformLabel('switch2'), 'Switch 2');
}

function testProviderMissionPaths() {
  const { platformDataDirectory, resolveMissionBasePath } = require('../utils/dayzPlatform');

  assert.strictEqual(resolveMissionBasePath({
    game: 'dayzxb',
    game_specific: { path: '/games/account/noftp/dayzxb/' },
  }), '/games/account/ftproot/dayzxb_missions');
  assert.strictEqual(resolveMissionBasePath({
    game: 'dayzps',
    game_specific: { path: '/games/account/noftp/dayzps/' },
  }), '/games/account/ftproot/dayzps_missions');
  assert.strictEqual(resolveMissionBasePath({
    game: 'dayzswitch',
    game_specific: { path: '/games/account/noftp/dayzswitch/' },
  }), '/games/account/ftproot/dayzswitch_missions');
  assert.strictEqual(resolveMissionBasePath({
    game: 'dayzstandalone',
    game_specific: { path: '/games/account/ftproot/dayzstandalone/' },
  }), '/games/account/ftproot/dayzstandalone/mpmissions');
  assert.strictEqual(platformDataDirectory('pc', 'dayz'), 'dayz');
  assert.throws(() => resolveMissionBasePath({
    game: 'dayzswitch',
    game_specific: { path: '/games/account/noftp/dayzxb/' },
  }), /invalid game path metadata/i);
}

function testRootStructureDetection() {
  const {
    inspectNitradoRootEntries,
    isProviderPathWithinRoots,
    MISSION_SUBDIRS,
    resolveGameDataPath,
  } = require('../utils/dayzPlatform');
  const dir = (name, filePath) => ({ name, path: filePath, type: 'dir' });
  const switchGameserver = { game: 'dayzswitch', game_specific: { path: '/games/account/noftp/dayzswitch' } };
  const standaloneGameserver = { game: 'dayzstandalone', game_specific: { path: '/games/account/ftproot/dayzstandalone' } };
  const legacyPcGameserver = { game: 'dayz', game_specific: { path: '/games/account/noftp/dayz' } };

  for (const [game, directory, platform] of [
    ['dayzxb', 'dayzxb', 'xbox'],
    ['dayzps', 'dayzps', 'playstation'],
    ['dayzswitch', 'dayzswitch', 'switch2'],
  ]) {
    const gameserver = { game, game_specific: { path: `/games/account/noftp/${directory}` } };
    assert.deepStrictEqual(inspectNitradoRootEntries([
      dir(directory, `/games/account/ftproot/${directory}`),
    ], gameserver), {
      platform,
      missionsPath: null,
      configPath: `/games/account/ftproot/${directory}/config`,
      pathsToSync: [`/games/account/ftproot/${directory}`],
    });
  }

  assert.deepStrictEqual(inspectNitradoRootEntries([
    dir('dayzswitch_missions', '/games/account/ftproot/dayzswitch_missions'),
  ], switchGameserver), {
    platform: 'switch2',
    missionsPath: '/games/account/ftproot/dayzswitch_missions',
    configPath: null,
    pathsToSync: ['/games/account/ftproot/dayzswitch_missions'],
  });
  assert.deepStrictEqual(inspectNitradoRootEntries([
    dir('dayzstandalone', '/games/account/ftproot/dayzstandalone'),
  ], standaloneGameserver), {
    platform: 'pc',
    missionsPath: '/games/account/ftproot/dayzstandalone/mpmissions',
    configPath: '/games/account/ftproot/dayzstandalone/config',
    pathsToSync: ['/games/account/ftproot/dayzstandalone'],
  });
  assert.deepStrictEqual(inspectNitradoRootEntries([
    dir('dayz', '/games/account/noftp/dayz'),
  ], legacyPcGameserver), {
    platform: 'pc',
    missionsPath: '/games/account/noftp/dayz/mpmissions',
    configPath: '/games/account/noftp/dayz/config',
    pathsToSync: ['/games/account/noftp/dayz'],
  });
  assert.throws(
    () => inspectNitradoRootEntries([
      dir('dayzswitch_missions', '/outside/account/ftproot/dayzswitch_missions'),
    ], switchGameserver),
    /invalid game path metadata/i,
    'provider roots must remain under the Nitrado games boundary'
  );
  assert.throws(
    () => inspectNitradoRootEntries([
      dir('dayzswitch_missions', '/games/account/ftproot/not-the-advertised-root'),
    ], switchGameserver),
    /invalid game path metadata/i,
    'provider root names must agree with their absolute paths'
  );
  assert(MISSION_SUBDIRS.includes('dayzswitch_missions'));
  const roots = ['/games/account/ftproot/dayzswitch_missions'];
  assert.strictEqual(isProviderPathWithinRoots('/games/account/ftproot/dayzswitch_missions', roots), true);
  assert.strictEqual(isProviderPathWithinRoots('/games/account/ftproot/dayzswitch_missions/dayzOffline/db', roots), true);
  assert.strictEqual(isProviderPathWithinRoots('/games/account/ftproot/dayzswitch_missions_other', roots), false);
  assert.strictEqual(isProviderPathWithinRoots('/games/account/ftproot/dayzswitch_missions/../other', roots), false);
  assert.strictEqual(isProviderPathWithinRoots('/games/other/ftproot/dayzswitch_missions', roots), false);
  assert.throws(
    () => inspectNitradoRootEntries([
      dir('dayzswitch_missions', '/games/other-account/ftproot/dayzswitch_missions'),
    ], switchGameserver),
    /invalid game path metadata/i,
    'provider roots must match the selected gameserver account namespace'
  );
  assert.strictEqual(resolveGameDataPath(legacyPcGameserver), '/games/account/noftp/dayz');
  const { getFilePaths } = require('../bot/utils/nitrado');
  assert.deepStrictEqual(getFilePaths(legacyPcGameserver), {
    ftpBase: '/games/account/noftp/dayz/',
    ftpRootBase: '/games/account/ftproot/',
  });
}

function testSafeServerNames() {
  const {
    normalizeProviderServerName,
    normalizeCustomServerName,
    resolveServerDisplayName,
  } = require('../utils/serverNames');

  assert.strictEqual(normalizeProviderServerName('Chernarus PvP', '90000001'), 'Chernarus PvP');
  assert.strictEqual(normalizeProviderServerName('Serveur Élite 🎮', '90000001'), 'Serveur Élite 🎮');
  assert.strictEqual(normalizeProviderServerName('Bad\u0000Name', '90000001'), '90000001');
  assert.strictEqual(normalizeProviderServerName('<img src=x>', '90000001'), '90000001');
  assert.strictEqual(normalizeProviderServerName('@everyone', '90000001'), '90000001');
  assert.throws(() => normalizeProviderServerName('<img src=x>', '@everyone'), /service ID/i);
  assert.strictEqual(normalizeProviderServerName('   ', '90000001'), '90000001');
  assert.strictEqual(normalizeCustomServerName('  My Server  '), 'My Server');
  assert.strictEqual(normalizeCustomServerName('   '), null);
  assert.throws(() => normalizeCustomServerName('Bad\u0007Name'), /printable/i);
  assert.throws(() => normalizeCustomServerName('<b>Admin</b>'), /safe characters/i);
  assert.throws(() => normalizeCustomServerName('@everyone'), /safe characters/i);
  assert.throws(() => normalizeCustomServerName('x'.repeat(201)), /200/);
  assert.strictEqual(resolveServerDisplayName('Provider', 'Custom', '1'), 'Custom');
  assert.strictEqual(resolveServerDisplayName('Bad\u0000Name', null, '1'), '1');
}

function testLogEntriesStayInsideAuthorizedConfigRoot() {
  const { validateLogFileEntry } = require('../services/logSyncService');
  const configRoot = '/games/account/noftp/dayzxb/config';
  assert.strictEqual(
    validateLogFileEntry(configRoot, {
      type: 'file',
      name: 'DayZServer.ADM',
      path: '/games/account/ftproot/dayzxb/config/DayZServer.ADM',
    }).path,
    '/games/account/ftproot/dayzxb/config/DayZServer.ADM'
  );
  for (const entry of [
    { type: 'file', name: 'DayZServer.ADM', path: '/games/other/ftproot/dayzxb/config/DayZServer.ADM' },
    { type: 'file', name: 'DayZServer.ADM', path: '/games/account/ftproot/dayzxb/DayZServer.ADM' },
    { type: 'file', name: '../DayZServer.ADM', path: '/games/account/ftproot/dayzxb/config/DayZServer.ADM' },
    { type: 'file', name: 'DayZServer.ADM', path: '/games/account/ftproot/dayzxb/config/other.ADM' },
  ]) {
    assert.throws(() => validateLogFileEntry(configRoot, entry), /invalid log file path/i);
  }
}

function testDashboardSelectionContract() {
  const route = read('routes/nitrado.js');
  const client = read('public/js/dashboard.js');
  const page = read('public/dashboard.html');
  const registerToken = read('bot/commands/register-token.js');

  assert(route.includes("router.get('/account-servers', ensureGuildOwner"));
  assert(route.includes("router.put('/account-servers/:serviceId', ensureGuildOwner"));
  assert(route.includes('FOR UPDATE'), 'selection writes must lock the current account binding');
  assert(route.includes('getAuthenticatedUser'), 'selection writes must revalidate the current Nitrado principal');
  assert(route.includes('nitrado_user_id'), 'selection writes must bind the provider principal to the stored account');
  assert(route.includes("enabled ? 'active' : 'inactive'"), 'disabling must revoke operational access without deleting server data');
  assert(route.includes("feature_name = 'custom_name'"), 'custom display names must persist separately from provider identity');

  assert(page.includes('nitrado-account-servers'));
  assert(client.includes("fetch('/api/user/guilds')"));
  assert(client.includes('/api/nitrado/account-servers'));
  assert(client.includes('fetchWithCsrf'));
  assert(client.includes('textContent'), 'provider names must be rendered as text');

  const autoRegistration = registerToken.slice(
    registerToken.indexOf('// Link servers to guild'),
    registerToken.indexOf("await client.query('COMMIT')")
  );
  assert(!autoRegistration.includes('INSERT INTO servers'), '/register-token must not auto-register discovered services');
  assert(registerToken.includes('toggle'), '/register-token response must direct owners to dashboard toggles');
  assert(registerToken.includes('allowedMentions'), '/register-token replies containing provider data must disable mentions');
}

function testPlatformConsumersUseCanonicalMapping() {
  const expectedConsumers = [
    'services/nitradoService.js',
    'services/logSyncService.js',
    'services/lootParserService.js',
    'bot/services/lootService.js',
    'bot/utils/nitrado.js',
    'bot/services/serverStatusService.js',
    'routes/ownerDashboard.js',
    'src/app/registerRoutes.js',
  ];
  for (const relative of expectedConsumers) {
    assert(
      read(relative).includes('dayzPlatform'),
      `${relative} does not use the canonical DayZ platform mapping`
    );
  }

  const registerRoutes = read('src/app/registerRoutes.js');
  assert(registerRoutes.includes('resolveAuthorizedProviderStructure'), 'sync and browse routes must derive roots from the selected service');
  assert(registerRoutes.includes('isProviderPathWithinRoots'), 'browse routes must reject paths outside the selected service roots');
  assert(!registerRoutes.includes('const syncPaths = paths && paths.length > 0 ? paths'), 'sync routes must not trust browser-supplied provider paths');

  const serverPlayers = read('public/js/server-players.js');
  assert(serverPlayers.includes("p.includes('switch2')"), 'server player platform badges must render Switch 2 explicitly');
  const aiAssistant = read('public/js/ai-assistant.js');
  assert(!aiAssistant.includes("s.platform || 'xbox'"), 'missing AI server platform metadata must not be mislabeled as Xbox');

  const automation = read('public/js/automation.js');
  const automationServerList = automation.slice(
    automation.indexOf('if (data.servers && data.servers.length > 0)'),
    automation.indexOf('async function toggleAutoLogSync')
  );
  assert(!automationServerList.includes("getElementById('serverCheckboxes').innerHTML = html"), 'server names must not be rendered through automation HTML');
  assert(automationServerList.includes('name.textContent ='), 'automation server names must be rendered as text');

  const ownerDashboard = read('routes/ownerDashboard.js');
  assert(ownerDashboard.includes('resolveGameDataPath'), 'owner list files must use validated provider path metadata');
  const botNitrado = read('bot/utils/nitrado.js');
  assert(botNitrado.includes('resolveGameDataPath'), 'bot list files must use validated provider path metadata');
}

async function testBotListCommandsUseMetadataPathWithoutUsername() {
  const nitradoPath = require.resolve('../bot/utils/nitrado');
  const originalNitrado = require.cache[nitradoPath];
  const actualNitrado = require('../bot/utils/nitrado');
  const reads = [];
  const gameserver = {
    game: 'dayz',
    game_specific: { path: '/games/account/noftp/dayz' },
  };
  let returnedGameserver = gameserver;
  require.cache[nitradoPath] = {
    id: nitradoPath,
    filename: nitradoPath,
    loaded: true,
    exports: {
      getServerCreds: async () => ({
        token: 'test-token',
        platformServerId: '123',
        serverName: 'Test server',
        gameserver: returnedGameserver,
      }),
      getFilePaths: actualNitrado.getFilePaths,
      readNitradoList: async (_token, _serviceId, providerPath) => {
        reads.push(providerPath);
        return [];
      },
      writeNitradoList: async () => {},
    },
  };

  try {
    for (const [commandFile, expectedPath] of [
      ['whitelist', '/games/account/noftp/dayz/whitelist.txt'],
      ['ban', '/games/account/noftp/dayz/ban.txt'],
      ['ban-list', '/games/account/noftp/dayz/ban.txt'],
      ['priority', '/games/account/ftproot/priority.txt'],
    ]) {
      const commandPath = require.resolve(`../bot/commands/${commandFile}`);
      delete require.cache[commandPath];
      const command = require(commandPath);
      const replies = [];
      await command.execute({
        guild: { id: 'guild' },
        authorizedServerId: '123',
        deferReply: async () => {},
        editReply: async value => { replies.push(value); return value; },
        options: {
          getSubcommand: () => 'list',
          getString: () => null,
          getInteger: () => null,
        },
      });
      assert.strictEqual(reads.pop(), expectedPath, `${commandFile} must use game_specific.path without requiring username`);
      assert(!replies.some(value => typeof value === 'string' && value.includes('determine server file paths')));
      delete require.cache[commandPath];
    }

    returnedGameserver = null;
    for (const commandFile of ['whitelist', 'ban', 'ban-list', 'priority']) {
      const commandPath = require.resolve(`../bot/commands/${commandFile}`);
      delete require.cache[commandPath];
      const command = require(commandPath);
      const replies = [];
      await command.execute({
        guild: { id: 'guild' },
        authorizedServerId: '123',
        deferReply: async () => {},
        editReply: async value => { replies.push(value); return value; },
        options: {
          getSubcommand: () => 'list',
          getString: () => null,
          getInteger: () => null,
        },
      });
      assert(
        replies.some(value => typeof value === 'string' && value.includes('server file paths')),
        `${commandFile} must report unavailable provider path metadata`
      );
      delete require.cache[commandPath];
    }
  } finally {
    if (originalNitrado) require.cache[nitradoPath] = originalNitrado;
    else delete require.cache[nitradoPath];
  }
}

async function run() {
  testCanonicalPlatformDetection();
  testProviderMissionPaths();
  testRootStructureDetection();
  testSafeServerNames();
  testLogEntriesStayInsideAuthorizedConfigRoot();
  testDashboardSelectionContract();
  testPlatformConsumersUseCanonicalMapping();
  await testBotListCommandsUseMetadataPathWithoutUsername();
  console.log('Platform and server-selection tests passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
