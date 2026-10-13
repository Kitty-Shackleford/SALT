#!/usr/bin/env node

const { ensureTestEncryptionKey } = require('./lib/test-env');
ensureTestEncryptionKey();

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  buildEmbed,
  applyChangedOnlineCacheRows,
  safeEdit,
  selectChangedOnlineCacheRows,
  formatRestartChannelName,
  formatRestartEmbedLabel,
  selectNewestRptStartMs,
  fetchOnlinePlayers,
  logMissingOnlinePlayerEvidence,
  parseShutdownFromLogTail,
  providerStatusChangeMs,
} = require('../bot/services/serverStatusService');

function testRestartChannelUsesCountdownLabel() {
  const restartAtMs = Date.now() + (65 * 60 * 1000);
  assert.strictEqual(formatRestartChannelName(restartAtMs, '1h 5m'), '🔄 Restart: 1h 5m');
  assert.strictEqual(formatRestartChannelName(null), '🔄 Restart: Unknown');
}

function testRestartChannelDoesNotShowAnExpiredTime() {
  assert.strictEqual(
    formatRestartChannelName(Date.now() - 1000, 'Restarting…'),
    '🔄 Restart: Restarting…'
  );
}

function testRestartEmbedUsesDiscordLiveTimestamp() {
  const restartAtMs = Date.parse('2030-08-31T00:23:43.000Z');
  const epochSeconds = Math.floor(restartAtMs / 1000);
  assert.strictEqual(
    formatRestartEmbedLabel(restartAtMs, '1h 5m'),
    `<t:${epochSeconds}:t> • <t:${epochSeconds}:R>`
  );
  assert.strictEqual(formatRestartEmbedLabel(null, '1h 5m'), '1h 5m');
  assert.strictEqual(formatRestartEmbedLabel(null, null), 'Unknown');
}

function testNewestRptIsSelectedByEmbeddedTimestamp() {
  const selected = selectNewestRptStartMs([
    'DayZServer_X1_x64_2026-08-26_18-24-33.RPT',
    'DayZServerP_X1_x64_2026-08-30_14-03-32.RPT',
    'not-a-log.txt',
  ]);
  assert.strictEqual(selected, Date.parse('2026-08-30T14:03:32.000Z'));
}

function testUnanchoredFtpShutdownTimeIsRejected() {
  const serverStartMs = Date.parse('2026-09-13T14:00:00.000Z');
  const staleTail = '10:29:57 [Shutdown] Shutting down in 300 seconds (5 minutes).\n';
  assert.strictEqual(
    parseShutdownFromLogTail(staleTail, serverStartMs),
    null,
    'a time-only shutdown line without a current-session BIOS marker must not be projected into another day'
  );
}

function testStalePriorSessionFtpShutdownWithBiosMarkerIsRejected() {
  const serverStartMs = Date.parse('2026-09-13T14:00:00.000Z');
  const staleTail = [
    '09:00:02 Connected to BIOS (server registration) with id 11111111-1111-1111-1111-111111111111',
    '10:29:57 [Shutdown] Shutting down in 300 seconds (5 minutes).',
  ].join('\n');
  assert.strictEqual(
    parseShutdownFromLogTail(staleTail, serverStartMs),
    null,
    'a stale BIOS marker must not anchor prior-session shutdown evidence to the next day'
  );
}

function testCurrentSessionFtpShutdownTimeUsesBiosAnchor() {
  const serverStartMs = Date.parse('2026-09-13T14:00:00.000Z');
  const tail = [
    '13:59:57 [Shutdown] Shutting down in 300 seconds (5 minutes).',
    '14:00:02 Connected to BIOS (server registration) with id 11111111-1111-1111-1111-111111111111',
    '14:29:57 [Shutdown] Shutting down in 1800 seconds (30 minutes).',
  ].join('\n');
  assert.strictEqual(
    parseShutdownFromLogTail(tail, serverStartMs),
    Date.parse('2026-09-13T14:59:57.000Z')
  );
}

function testCurrentSessionFtpShutdownHandlesMidnightRollover() {
  const serverStartMs = Date.parse('2026-09-13T23:59:50.000Z');
  const tail = [
    '23:59:55 Connected to BIOS (server registration) with id 11111111-1111-1111-1111-111111111111',
    '00:10:00 [Shutdown] Shutting down in 300 seconds (5 minutes).',
  ].join('\n');
  assert.strictEqual(
    parseShutdownFromLogTail(tail, serverStartMs),
    Date.parse('2026-09-14T00:15:00.000Z')
  );
}

function testStatusEmbedContainsLiveRestartCountdown() {
  const restartAtMs = Date.parse('2030-08-31T00:23:43.000Z');
  const epochSeconds = Math.floor(restartAtMs / 1000);
  const embed = buildEmbed(
    'Test Server',
    { status: 'started', query: {}, settings: { config: {} } },
    '4y 0m',
    [],
    null,
    null,
    restartAtMs
  ).toJSON();
  const restartField = embed.fields.find(field => field.name.includes('Next Restart'));
  assert(restartField, 'restart field missing from status embed');
  assert(restartField.value.includes(`<t:${epochSeconds}:R>`), 'live restart countdown missing');
}

function testStatusEmbedExplainsUnavailablePlayerNames() {
  const embed = buildEmbed(
    'Test Server',
    {
      status: 'started',
      query: { player_current: 2, player_max: 20 },
      settings: { config: {} },
    },
    null,
    []
  ).toJSON();
  const playerField = embed.fields.find(field => field.name.includes('Online Players'));
  assert(playerField, 'online-player field missing from status embed');
  assert.match(playerField.value, /2 players online — current log evidence unavailable/);
}

function testStatusEmbedLabelsEstimatedNamesWithLastSeenTimes() {
  const seenAt = '2030-08-31T00:20:00.000Z';
  const epochSeconds = Math.floor(Date.parse(seenAt) / 1000);
  const embed = buildEmbed(
    'Test Server',
    {
      status: 'started',
      query: { player_current: 2, player_max: 20 },
      settings: { config: {} },
    },
    null,
    [
      { gamertag: 'PossiblePlayer', evidence_kind: 'estimated', last_seen_at: seenAt },
    ]
  ).toJSON();
  const playerField = embed.fields.find(field => field.name.includes('Estimated Players'));
  assert(playerField, 'estimated-player field missing from status embed');
  assert.match(playerField.value, /not confirmed online/i);
  assert.match(playerField.value, /PossiblePlayer/);
  assert.match(playerField.value, new RegExp(`<t:${epochSeconds}:R>`));
  assert.doesNotMatch(playerField.name, /^.*Online Players/);
}

async function testOnlinePlayerEvidenceIsExactServerRestartScopedAndCountMatched() {
  const calls = [];
  const queryPool = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return {
        rows: ['One', 'Two', 'Three'].map((gamertag, index) => ({
          gamertag,
          login_at: new Date(params[1].getTime() + index + 1),
          updated_at: new Date(),
          evidence_kind: 'authoritative',
        })),
      };
    },
  };
  const serverStartedAtMs = Date.now() - 60 * 60 * 1000;
  const players = await fetchOnlinePlayers(42, null, 3, serverStartedAtMs, queryPool);
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0].sql, /cache\.server_id = \$1/);
  assert.match(calls[0].sql, /cache\.login_at >= \$2/);
  assert.match(calls[0].sql, /snapshot\.source_observed_at >= \$2/);
  assert.strictEqual(calls[0].params[0], 42);
  assert.strictEqual(calls[0].params[1].getTime(), serverStartedAtMs);
  assert.strictEqual(players.length, 3);

  const mismatchPool = { query: async () => ({ rows: players.slice(0, 2) }) };
  const mismatched = await fetchOnlinePlayers(43, null, 3, serverStartedAtMs, mismatchPool);
  assert.deepStrictEqual(mismatched, [], 'a count mismatch must not guess which log-derived names are online');

  const hundredPlayers = Array.from({ length: 100 }, (_, index) => ({
    gamertag: `Player${index}`,
    login_at: new Date(serverStartedAtMs + index + 1),
    updated_at: new Date(),
    evidence_kind: 'authoritative',
  }));
  const overCapacity = await fetchOnlinePlayers(
    44,
    null,
    101,
    serverStartedAtMs,
    { query: async () => ({ rows: hundredPlayers }) }
  );
  assert.deepStrictEqual(overCapacity, [], 'provider counts above 100 must not be capped into a false match');

  let zeroCountQueries = 0;
  const zeroCount = await fetchOnlinePlayers(45, null, 0, serverStartedAtMs, {
    query: async () => { zeroCountQueries += 1; return { rows: players }; },
  });
  assert.deepStrictEqual(zeroCount, []);
  assert.strictEqual(zeroCountQueries, 0, 'zero-player servers must return empty before reading stale names');
}

async function testPcOnlinePlayersUseAuthoritativeProviderList() {
  let databaseQueries = 0;
  const queryPool = {
    query: async () => {
      databaseQueries += 1;
      return { rows: [] };
    },
  };
  const calls = [];
  const playerService = {
    listPlayers: async (token, serviceId) => {
      calls.push({ token, serviceId });
      return [
        { id: 'steam-1', name: 'Current One', online: true },
        { id: 'steam-2', name: 'Current Two', online: true },
        { id: 'steam-3', name: 'Offline Player', online: false },
      ];
    },
  };

  const players = await fetchOnlinePlayers(50, '9001', 2, null, queryPool, {
    platform: 'pc',
    token: 'test-token',
    playerService,
  });
  assert.deepStrictEqual(calls, [{ token: 'test-token', serviceId: '9001' }]);
  assert.strictEqual(databaseQueries, 0, 'PC names must not depend on the ADM cache');
  assert.deepStrictEqual(players.map(player => player.gamertag), ['Current One', 'Current Two']);
  assert(players.every(player => player.evidence_kind === 'authoritative'));

  const mismatched = await fetchOnlinePlayers(51, '9002', 3, null, queryPool, {
    platform: 'pc',
    token: 'test-token',
    playerService,
  });
  assert.deepStrictEqual(mismatched, [], 'PC provider names must match the live provider count');

  const duplicateIds = await fetchOnlinePlayers(52, '9003', 2, null, queryPool, {
    platform: 'pc',
    token: 'test-token',
    playerService: {
      listPlayers: async () => [
        { id: 'same', name: 'First', online: true },
        { id: 'same', name: 'Second', online: true },
      ],
    },
  });
  assert.deepStrictEqual(duplicateIds, [], 'PC provider identities must be unique');

  const invalidNames = await fetchOnlinePlayers(53, '9004', 2, null, queryPool, {
    platform: 'pc',
    token: 'test-token',
    playerService: {
      listPlayers: async () => [
        { id: '', name: 'Missing ID', online: true },
        { id: 'steam-4', name: 'Unknown', online: true },
      ],
    },
  });
  assert.deepStrictEqual(invalidNames, [], 'PC provider rows require valid identities and names');

  let missingCredentialCalls = 0;
  const missingCredentials = await fetchOnlinePlayers(54, '9005', 1, null, queryPool, {
    platform: 'pc',
    playerService: {
      listPlayers: async () => { missingCredentialCalls += 1; return []; },
    },
  });
  assert.deepStrictEqual(missingCredentials, []);
  assert.strictEqual(missingCredentialCalls, 0, 'missing PC credentials must fail before provider access');

  let consoleProviderCalls = 0;
  await fetchOnlinePlayers(55, '9006', 1, Date.now() - 1000, {
    query: async () => ({ rows: [] }),
  }, {
    platform: 'xbox',
    token: 'test-token',
    playerService: {
      listPlayers: async () => { consoleProviderCalls += 1; return []; },
    },
  });
  assert.strictEqual(consoleProviderCalls, 0, 'console names must never use the provider player API');
}

async function testOnlinePlayerEvidenceRequiresNormalizedServerStart() {
  assert.strictEqual(
    providerStatusChangeMs('1788302121'),
    1788302121000,
    'provider Unix-second strings must normalize to milliseconds'
  );

  let calls = 0;
  const queryPool = {
    query: async () => {
      calls += 1;
      return { rows: [] };
    },
  };
  await fetchOnlinePlayers(42, null, 3, null, queryPool);
  assert.strictEqual(calls, 0, 'names must not be queried without a valid server-start boundary');
}

function testMissingEvidenceWarningsIgnoreEmptyServersAndAreRateLimited() {
  const messages = [];
  const logger = { log: message => messages.push(message) };
  logMissingOnlinePlayerEvidence(50, 0, { logger, nowMs: 1000 });
  assert.deepStrictEqual(messages, [], 'zero-player servers must not emit missing-name warnings');

  logMissingOnlinePlayerEvidence(51, 2, { logger, nowMs: 1000 });
  logMissingOnlinePlayerEvidence(51, 2, { logger, nowMs: 2000 });
  assert.strictEqual(messages.length, 1, 'the same evidence delay must be rate-limited');
  assert.match(messages[0], /server_db_id=51/);
  assert.match(messages[0], /current exact-server log evidence is unavailable/);

  logMissingOnlinePlayerEvidence(51, 2, { logger, nowMs: 16 * 60 * 1000 });
  assert.strictEqual(messages.length, 2, 'a persistent delay should remain periodically visible');

  logMissingOnlinePlayerEvidence(52, 2, { logger, nowMs: 1000 });
  logMissingOnlinePlayerEvidence(52, 0, { logger, nowMs: 2000 });
  logMissingOnlinePlayerEvidence(52, 1, { logger, nowMs: 3000 });
  assert.strictEqual(messages.length, 4, 'an empty interval must reset warning suppression');
}

function testOnlineCacheUsesTheCurrentAdmGamertag() {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'routes', 'logParser.js'),
    'utf8'
  );
  const cacheWriter = source.slice(
    source.indexOf('async function updateOnlineCache'),
    source.indexOf('async function refreshPlayerServerActivityForIdentity')
  );
  assert.match(cacheWriter, /String\(session\.playerGamertag \|\| ''\)\.trim\(\)/);
  assert.doesNotMatch(
    cacheWriter,
    /SELECT gamertag FROM player_gamertags/,
    'online names must come from current ADM evidence, not historical aliases'
  );
}

function testStatusPlayerNamesRequireFreshProviderEvidence() {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'services', 'serverStatusService.js'),
    'utf8'
  );
  assert.match(source, /JOIN server_online_cache_snapshots/);
  assert.match(source, /source_observed_at >= clock_timestamp\(\) - INTERVAL '120 minutes'/);
  assert.match(source, /source_observed_at <= clock_timestamp\(\) \+ INTERVAL '5 minutes'/);
}

function testAllUserFacingOnlineListsRequireFreshProviderEvidence() {
  const sources = [
    path.join(__dirname, '..', 'bot', 'services', 'serverStatusService.js'),
    path.join(__dirname, '..', 'bot', 'commands', 'online.js'),
    path.join(__dirname, '..', 'bot', 'commands', 'location.js'),
    path.join(__dirname, '..', 'routes', 'guilds.js'),
    path.join(__dirname, 'tui-admin.js'),
  ];
  for (const sourcePath of sources) {
    const source = fs.readFileSync(sourcePath, 'utf8');
    assert.match(source, /JOIN server_online_cache_snapshots/);
    assert.match(source, /source_observed_at >= clock_timestamp\(\) - INTERVAL '120 minutes'/);
    assert.match(source, /source_observed_at <= clock_timestamp\(\) \+ INTERVAL '5 minutes'/);
  }
}

function testOnlineCacheChangesSelectOnlyExactChangedServers() {
  const baseline = new Map([['3', '2'], ['5', '8']]);
  const rows = [
    { server_db_id: 5, scan_generation: '8', discord_guild_id: 'guild-b' },
    { server_db_id: 3, scan_generation: '3', discord_guild_id: 'guild-a' },
  ];
  assert.deepStrictEqual(
    selectChangedOnlineCacheRows(baseline, rows),
    [rows[1]],
    'one server publication must refresh only that exact server/guild row'
  );
  assert.deepStrictEqual(
    selectChangedOnlineCacheRows(new Map([['3', '3'], ['5', '8']]), rows),
    [],
    'database row order must not trigger redundant Discord refreshes'
  );
}

function testStatusLoopRefreshesProviderEvidenceForChangedCache() {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'bot', 'services', 'serverStatusService.js'),
    'utf8'
  );
  assert.match(source, /const CACHE_REFRESH_INTERVAL_MS = 30 \* 1000/);
  assert.match(source, /server_online_cache_snapshots/);
  assert.match(source, /row => updateGuild\(client, row, \{ updateVoiceChannels: false \}\)/);
  assert.match(source, /setInterval\(\(\) => refreshStatusOnOnlineCacheChange\(client\), CACHE_REFRESH_INTERVAL_MS\)/);
}

async function testSafeEditOnlyAcknowledgesSuccessfulDiscordEdits() {
  assert.strictEqual(await safeEdit(async () => {}), true);

  const originalError = console.error;
  console.error = () => {};
  try {
    assert.strictEqual(
      await safeEdit(async () => { throw new Error('Discord edit failed'); }),
      false,
      'a failed Discord edit must remain retryable'
    );
  } finally {
    console.error = originalError;
  }
}

async function testCacheGenerationAcknowledgementRequiresExactServerSuccess() {
  const generations = new Map([['3', '1'], ['4', '1']]);
  const rows = [
    { server_db_id: 3, scan_generation: '2' },
    { server_db_id: 4, scan_generation: '2' },
  ];
  const attempted = [];

  await applyChangedOnlineCacheRows(generations, rows, async row => {
    attempted.push(row.server_db_id);
    return row.server_db_id === 3;
  });

  assert.deepStrictEqual(attempted, [3, 4]);
  assert.strictEqual(generations.get('3'), '2');
  assert.strictEqual(generations.get('4'), '1');
}

function statusTimeLines(settings, onlinePlayers) {
  const embed = buildEmbed('Test Server', {
    status: 'started', query: {}, settings,
  }, null, onlinePlayers).toJSON();
  const field = embed.fields.find(item => item.name.includes('Server Settings'));
  assert(field, 'server settings missing from real embed');
  return field.value.split('\n').filter(line => /Day Speed|Night Speed|stacked/.test(line));
}

function testStatusEmbedPreservesNormalDayNightFormatting() {
  for (const players of [[], [{ gamertag: 'TestPlayer' }]]) {
    for (const [day, night] of [[2, 4], ['2.0', '4.0'], [' 2 ', '4']]) {
      assert.deepStrictEqual(statusTimeLines({ config: {
        serverTimeAcceleration: day, serverNightTimeAcceleration: night,
      } }, players), [
        ' Day Speed　　　　2× (~6.0 hrs)',
        ' Night Speed　　　8× eff. (~1.5 hrs)',
        '　　2× day + 4× night stacked — varies by season',
      ]);
    }
    assert.deepStrictEqual(statusTimeLines({ config: {
      serverTimeAcceleration: '7', serverNightTimeAcceleration: '3',
    } }, players), [
      ' Day Speed　　　　7× (~1.7 hrs)',
      ' Night Speed　　　21× eff. (~0.6 hrs)',
      '　　7× day + 3× night stacked — varies by season',
    ]);
  }
}

function testStatusEmbedShowsUnknownForMissingOrInvalidDayNightSettings() {
  const invalid = [
    undefined, null, '', ' \t', true, false, [], [2], {}, 0, -2, NaN, Infinity,
    '2x', '0x10', '0b10', '0o10', '2 4', '1e309', '1e-999',
  ];
  const settingsCases = [undefined, null, {}, { config: null }, { config: {} }];
  for (const value of invalid) {
    settingsCases.push(
      { config: { serverTimeAcceleration: value, serverNightTimeAcceleration: 4 } },
      { config: { serverTimeAcceleration: 2, serverNightTimeAcceleration: value } }
    );
  }
  for (const [day, night] of [[Number.MAX_VALUE, 2], [1e-200, 1e-200], [Number.MIN_VALUE, 1], [1, Number.MIN_VALUE]]) {
    settingsCases.push({ config: { serverTimeAcceleration: day, serverNightTimeAcceleration: night } });
  }
  for (const players of [[], [{ gamertag: 'TestPlayer' }]]) {
    for (const settings of settingsCases) {
      assert.deepStrictEqual(statusTimeLines(settings, players), [
        ' Day Speed　　　　Unknown',
        ' Night Speed　　　Unknown',
      ], 'invalid or absent configuration must not invent default speeds or hours');
    }
  }
}

async function main() {
  testStatusEmbedPreservesNormalDayNightFormatting();
  testStatusEmbedShowsUnknownForMissingOrInvalidDayNightSettings();
  testRestartChannelUsesCountdownLabel();
  testRestartChannelDoesNotShowAnExpiredTime();
  testRestartEmbedUsesDiscordLiveTimestamp();
  testNewestRptIsSelectedByEmbeddedTimestamp();
  testUnanchoredFtpShutdownTimeIsRejected();
  testStalePriorSessionFtpShutdownWithBiosMarkerIsRejected();
  testCurrentSessionFtpShutdownTimeUsesBiosAnchor();
  testCurrentSessionFtpShutdownHandlesMidnightRollover();
  testStatusEmbedContainsLiveRestartCountdown();
  testStatusEmbedExplainsUnavailablePlayerNames();
  testStatusEmbedLabelsEstimatedNamesWithLastSeenTimes();
  await testOnlinePlayerEvidenceIsExactServerRestartScopedAndCountMatched();
  await testPcOnlinePlayersUseAuthoritativeProviderList();
  await testOnlinePlayerEvidenceRequiresNormalizedServerStart();
  testMissingEvidenceWarningsIgnoreEmptyServersAndAreRateLimited();
  testOnlineCacheUsesTheCurrentAdmGamertag();
  testStatusPlayerNamesRequireFreshProviderEvidence();
  testAllUserFacingOnlineListsRequireFreshProviderEvidence();
  testOnlineCacheChangesSelectOnlyExactChangedServers();
  testStatusLoopRefreshesProviderEvidenceForChangedCache();
  await testSafeEditOnlyAcknowledgesSuccessfulDiscordEdits();
  await testCacheGenerationAcknowledgementRequiresExactServerSuccess();
  console.log('✅ Restart timer accuracy tests passed');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
