'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const http = require('../utils/httpRetry');
const {
  classifyLogEntry,
  downloadLogFile,
  normalizeNitradoFilePath,
  resolveOperationalServers,
  selectLogSyncBatch,
  validateLogFileEntry,
} = require('../services/logSyncService');
const { compareLogFileEntries, logStartTimeMs } = require('../utils/logFileChronology');
const {
  buildScheduledLogSyncPlan,
  isLogSyncRunSuccessful,
  hasUnparsedLogFiles,
  filterServerIdsWithoutSyncErrors,
  isLogSourceObservationFresh,
  markServerLogParseSuccessful,
  selectServerIdsToParse,
  scheduledLogSyncDue,
} = require('../utils/logSyncScheduling');

function handlerFor(router, routePath, method) {
  const layer = router.stack.find(entry => entry.route?.path === routePath && entry.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${routePath} route must exist`);
  return layer.route.stack.at(-1).handle;
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function createAdmOnlyScanDb(guildId) {
  const db = {
    async get(sql) {
      if (sql.includes("nextval('server_online_cache_scan_generation_seq')")) {
        return { scan_generation: '1' };
      }
      if (sql.includes('SELECT s.id, s.guild_id, s.platform')) {
        return { id: 1, guild_id: 10, platform: 'xbox', discord_guild_id: guildId };
      }
      if (sql.includes('SELECT platform FROM servers')) return { platform: 'xbox' };
      if (sql.includes('SELECT id FROM servers WHERE id = ?')) return { id: 1 };
      if (sql.includes('AS fresh')) return { fresh: false, plausible: true };
      return null;
    },
    async run() { return { changes: 0 }; },
    async transaction(callback) { return callback(this); },
  };
  return db;
}

async function scanAdmOnlyForTest(guildId) {
  const { scanLogsForServer } = require('../routes/logParser');
  return scanLogsForServer(createAdmOnlyScanDb(guildId), 7, '101', null, {
    includeRptLogs: false,
    systemAuthorizedInternalServerId: 1,
    sourceObservedAt: new Date().toISOString(),
  });
}

function testRotatedLogWithDifferentSizeIsUpdated() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayz-log-sync-'));
  try {
    const filename = 'DayZServer_x64_2026-08-29_01-00-00.ADM';
    fs.writeFileSync(path.join(directory, filename), 'partial');

    assert.strictEqual(
      classifyLogEntry(directory, { name: filename, size: 100 }),
      'updated',
      'a rotated log must still be updated when its provider size differs'
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function testSameSizeProviderLogIsStillRefreshed() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayz-log-same-size-'));
  try {
    const filename = 'active.ADM';
    fs.writeFileSync(path.join(directory, filename), 'old!');
    assert.strictEqual(
      classifyLogEntry(directory, { name: filename, size: 4 }),
      'updated',
      'provider content can change without changing byte length'
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function testSyncClassificationRejectsDestinationSymlinks() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayz-log-symlink-'));
  const outside = path.join(os.tmpdir(), `dayz-log-outside-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(outside, 'data');
    fs.symlinkSync(outside, path.join(directory, 'active.ADM'));
    assert.throws(
      () => classifyLogEntry(directory, { name: 'active.ADM', size: 4 }),
      /symbolic link/i
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
}

function testPcProviderPathsNormalizeToNoFtp() {
  assert.strictEqual(
    normalizeNitradoFilePath('/games/101/ftproot/dayzstandalone/config'),
    '/games/101/noftp/dayzstandalone/config'
  );
  assert.strictEqual(
    normalizeNitradoFilePath('/games/101/ftproot/dayz/config'),
    '/games/101/noftp/dayz/config'
  );
}

function testValidatedPcFileEntryPreservesProviderTransferPath() {
  const entry = validateLogFileEntry(
    '/games/101/noftp/dayzstandalone/config',
    {
      type: 'file',
      name: 'server.ADM',
      path: '/games/101/ftproot/dayzstandalone/config/server.ADM',
      size: 10,
    }
  );
  assert.strictEqual(entry.path, '/games/101/ftproot/dayzstandalone/config/server.ADM');
}

function testRoutineSyncPreservesHistoryInBoundedDurableBatches() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayz-log-batch-'));
  const entries = Array.from({ length: 5 }, (_, index) => ({
    name: `DayZServer_X1_x64_2026-08-29_0${index + 1}-00-00.ADM`,
    size: 10,
    modified_at: Date.UTC(2026, 7, 29, index + 1),
  }));
  try {
    const first = selectLogSyncBatch(directory, entries, { maxFiles: 3, maxBytes: 30 });
    assert.deepStrictEqual(first.map(entry => entry.name), [entries[0].name, entries[3].name, entries[4].name]);
    assert(first.length <= 3);
    assert(first.reduce((total, entry) => total + entry.size, 0) <= 30);

    for (const entry of first) fs.writeFileSync(path.join(directory, entry.name), Buffer.alloc(entry.size));
    const second = selectLogSyncBatch(directory, entries, { maxFiles: 3, maxBytes: 30 });
    assert.deepStrictEqual(second.map(entry => entry.name), [entries[1].name, entries[3].name, entries[4].name],
      'atomically retained local files must durably advance the historical backfill');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function testRoutineSyncIncludesProviderLatestAdmAcrossBatchBoundary() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayz-log-provider-latest-'));
  const admEntries = Array.from({ length: 8 }, (_, index) => ({
    name: `DayZServer_X1_x64_2026-08-29_0${index + 1}-00-00.ADM`,
    size: 10,
    modified_at: index === 0 ? 9999 : index + 1,
  }));
  const entries = [
    ...admEntries,
    { name: 'DayZServer_X1_x64_2026-08-29_09-00-00.RPT', size: 10, modified_at: 9 },
    { name: 'DayZServer_X1_x64_2026-08-29_10-00-00.RPT', size: 10, modified_at: 10 },
  ];
  try {
    for (const entry of entries) {
      fs.writeFileSync(path.join(directory, entry.name), Buffer.alloc(entry.size));
    }
    const selected = selectLogSyncBatch(directory, entries);
    assert.ok(selected.some(entry => entry.name === admEntries[0].name),
      'the provider-most-recent ADM must remain mandatory even when its filename clock is older');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function testRoutineSyncSkipsTemporarilyUnfittableHistoryWithoutStarvingLaterFiles() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayz-log-batch-fit-'));
  const entries = [
    { name: 'DayZServer_X1_x64_2026-08-29_01-00-00.ADM', size: 8 },
    { name: 'DayZServer_X1_x64_2026-08-29_02-00-00.ADM', size: 2 },
    { name: 'DayZServer_X1_x64_2026-08-29_03-00-00.ADM', size: 3 },
    { name: 'DayZServer_X1_x64_2026-08-29_04-00-00.ADM', size: 3 },
  ];
  try {
    const selected = selectLogSyncBatch(directory, entries, { maxFiles: 3, maxBytes: 8 });
    assert.deepStrictEqual(selected.map(entry => entry.name), [
      entries[1].name,
      entries[2].name,
      entries[3].name,
    ]);
    assert.throws(
      () => selectLogSyncBatch(directory, entries, { maxFiles: 4, maxBytes: 6 }),
      /history.*capacity/i,
      'mandatory current artifacts must not silently starve every historical artifact'
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function testRoutineSyncRejectsInvalidMandatoryArtifactSizes() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayz-log-batch-invalid-current-'));
  const currentArtifacts = [
    { name: 'DayZServer_X1_x64_2026-08-29_03-00-00.ADM', size: 90 },
    { name: 'DayZServer_X1_x64_2026-08-29_04-00-00.ADM', size: 90 },
    { name: 'DayZServer_X1_x64_2026-08-29_03-00-00.RPT', size: 90 },
    { name: 'DayZServer_X1_x64_2026-08-29_04-00-00.RPT', size: -200 },
  ];
  try {
    assert.throws(
      () => selectLogSyncBatch(directory, currentArtifacts, { maxFiles: 4, maxBytes: 100 }),
      /invalid log artifact size/i,
      'negative mandatory sizes must not offset valid bytes in aggregate accounting'
    );
    assert.throws(
      () => selectLogSyncBatch(directory, [{
        name: 'DayZServer_X1_x64_2026-08-29_04-00-00.ADM',
        size: (128 * 1024 * 1024) + 1,
      }]),
      /invalid log artifact size/i,
      'mandatory artifacts must obey the per-file transfer limit before selection'
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function testParserOrdersByLogStartInsteadOfDownloadTime() {
  const entries = [
    { name: 'DayZServer_X1_x64_2026-08-29_02-00-00.ADM', mtimeMs: 100 },
    { name: 'DayZServer_X1_x64_2026-08-29_01-00-00.ADM', mtimeMs: 200 },
  ];

  entries.sort(compareLogFileEntries);

  assert.deepStrictEqual(entries.map(entry => entry.name), [
    'DayZServer_X1_x64_2026-08-29_01-00-00.ADM',
    'DayZServer_X1_x64_2026-08-29_02-00-00.ADM',
  ]);
}

function testInvalidFilenameTimestampUsesFallbackChronology() {
  for (const filename of [
    'DayZServer_X1_x64_2026-02-30_01-00-00.ADM',
    'DayZServer_X1_x64_2026-13-01_01-00-00.ADM',
    'DayZServer_X1_x64_2026-08-29_25-00-00.ADM',
  ]) {
    assert.strictEqual(logStartTimeMs(filename), null, `${filename} must not be normalized`);
  }

  const entries = [
    { name: 'DayZServer_X1_x64_2026-13-01_01-00-00.ADM', mtimeMs: 200 },
    { name: 'legacy.ADM', mtimeMs: 100 },
  ];
  entries.sort(compareLogFileEntries);
  assert.deepStrictEqual(entries.map(entry => entry.name), [
    'legacy.ADM',
    'DayZServer_X1_x64_2026-13-01_01-00-00.ADM',
  ]);
}

function testLogsPageLoadsServersFromEveryGuild() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'logs.js'), 'utf8');
  assert.doesNotMatch(source, /const firstGuild =/);
  assert.match(source, /Promise\.all\(guilds\.map\(/);
}

function testLogsPageEscapesProviderAndLogDerivedValues() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'logs.js'), 'utf8');
  for (const unsafeInterpolation of [
    /\$\{alt\.deviceId\.substring/,
    /\$\{p\.platform \|\|/,
    /\$\{\(p\.platformUserId \|\|/,
    /\$\{p\.deviceId \? p\.deviceId/,
    /\$\{p\.playerName\}/,
    /\$\{userId\.substring/,
    /\$\{err\.message\}/,
    /\$\{data\.error\}/,
  ]) {
    assert.doesNotMatch(source, unsafeInterpolation, `unsafe logs-page interpolation: ${unsafeInterpolation}`);
  }
}

function testServerLogUsesMissingFileClassification() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'logSyncService.js'), 'utf8');
  assert.match(source, /classifyLogEntry\(configPath, serverLogEntry\)/);
  assert.doesNotMatch(source, /localSize !== serverLogEntry\.size/);
  assert.doesNotMatch(
    source,
    /downloadLogFile\(token, serverId, serverLogEntry[\s\S]{0,250}serverChanged = true/
  );
}

function testSchedulerUsesPerServerChangeSet() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scheduler.js'), 'utf8');
  assert.match(source, /selectServerIdsToParse/);
  assert.match(source, /result\.changedServerIds/);
  assert.match(source, /SELECT last_sync_at/);
  assert.match(source, /hasUnparsedLogFiles\(row\.last_sync_at, mtimes\)/);
  assert.match(source, /serverId => needsLogParse\(serverByPlatformId\.get\(String\(serverId\)\)\)/);
  assert.match(source,
    /markServerLogParseSuccessful\([\s\S]{0,100}serverByPlatformId\.get\(String\(serverId\)\)\.id/,
    'successful parses must update the authorized internal server row');
  assert.doesNotMatch(source, /isOnlineCacheEmpty/);
  assert.doesNotMatch(source, /serversToParse\.push\(\.\.\.serverIds\)/);
}

function testFailedSyncOrParseCannotAdvanceSuccessfulRunState() {
  assert.strictEqual(isLogSyncRunSuccessful({
    syncErrors: ['provider failure'],
    parseErrors: [],
    requiredParseCount: 0,
    parsedCount: 0,
  }), false);
  assert.strictEqual(isLogSyncRunSuccessful({
    syncErrors: [],
    parseErrors: ['parse failure'],
    requiredParseCount: 1,
    parsedCount: 0,
  }), false);
  assert.strictEqual(isLogSyncRunSuccessful({
    syncErrors: [],
    parseErrors: [],
    requiredParseCount: 1,
    parsedCount: 1,
  }), true);

  const schedulerSource = fs.readFileSync(path.join(__dirname, '..', 'scheduler.js'), 'utf8');
  const automationSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'automation.js'), 'utf8');
  assert.match(schedulerSource, /isLogSyncRunSuccessful/);
  assert.match(automationSource, /isLogSyncRunSuccessful/);
  assert.match(automationSource, /await db\.run\(/);
}

function testAutoScanMeansParseSelectedServersAfterSync() {
  assert.deepStrictEqual(
    buildScheduledLogSyncPlan({ servers: ['101'], autoScan: true }),
    { serverIds: ['101'], parseAfterSync: true }
  );
  assert.deepStrictEqual(
    buildScheduledLogSyncPlan({ servers: ['101'], autoScan: false }),
    { serverIds: ['101'], parseAfterSync: false }
  );

  const schedulerSource = fs.readFileSync(path.join(__dirname, '..', 'scheduler.js'), 'utf8');
  assert.doesNotMatch(schedulerSource, /listGameServers/);
  assert.doesNotMatch(schedulerSource, /settings\.autoScan \? \[\] : serverIds/);
}

async function testSchedulerParsesOnlyChangedOrUncachedServers() {
  const selected = await selectServerIdsToParse(
    ['server-a', 'server-b', 'server-c'],
    ['server-a'],
    async serverId => serverId === 'server-c'
  );

  assert.deepStrictEqual(selected, ['server-a', 'server-c']);
}

function testSyncFailuresGatePerServerParsingAndCheckpointing() {
  assert.deepStrictEqual(
    filterServerIdsWithoutSyncErrors(['101', '102', '103'], ['102', '999']),
    ['101', '103']
  );
  assert.deepStrictEqual(
    filterServerIdsWithoutSyncErrors(['101', '102', '103'], new Set(['102', '999'])),
    ['101', '103'],
    'manual sync passes a Set of parse-blocked server IDs'
  );

  const schedulerSource = fs.readFileSync(path.join(__dirname, '..', 'scheduler.js'), 'utf8');
  const automationSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'automation.js'), 'utf8');
  const parserSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'logParser.js'), 'utf8');
  assert.match(schedulerSource, /filterServerIdsWithoutSyncErrors\([\s\S]*?result\.parseBlockedServerIds/);
  assert.match(automationSource, /result\.parseBlockedServerIds \|\| result\.failedServerIds/);
  assert.match(automationSource, /filterServerIdsWithoutSyncErrors\(serverIds, parseBlockedServerIds\)/);
  assert.match(parserSource, /includeRptLogs\s*=\s*true/,
    'the scanner must expose an explicit fail-closed RPT inclusion control');
  assert.match(parserSource, /allRptLogs\s*=\s*includeRptLogs\s*\?/,
    'RPT discovery must be disabled when the current provider transfer failed');
  for (const source of [schedulerSource, automationSource]) {
    assert.match(source, /rptBlockedServerIds/,
      'scan orchestration must consume per-server RPT failure attribution');
    assert.match(source, /includeRptLogs:\s*!rptBlockedServerIds\.has\(String\(serverId\)\)/,
      'scan orchestration must disable RPT parsing only for the affected server');
  }
}

async function testSchedulerRetriesFailedParseAfterDownloadStopsChanging() {
  const previousSuccessfulParse = '2026-08-29T10:00:00.000Z';
  const downloadedAfterCheckpoint = Date.parse('2026-08-29T10:05:00.000Z');

  assert.strictEqual(
    hasUnparsedLogFiles(previousSuccessfulParse, [downloadedAfterCheckpoint]),
    true
  );
  const selected = await selectServerIdsToParse(
    ['server-a'],
    [],
    async () => hasUnparsedLogFiles(previousSuccessfulParse, [downloadedAfterCheckpoint])
  );
  assert.deepStrictEqual(selected, ['server-a']);
}

async function testManualAndScheduledParsesShareDurableCheckpoint() {
  let captured;
  const db = { run: async (sql, params) => { captured = { sql, params }; } };

  await markServerLogParseSuccessful(db, 101, '2026-08-30T12:00:00.000Z', {
    lifecycleEvidenceReady: false,
  });

  assert.match(captured.sql, /last_sync_at = CURRENT_TIMESTAMP/);
  assert.match(captured.sql, /CASE WHEN \? THEN GREATEST/,
    'historical parsing must checkpoint without unconditionally advancing lifecycle coverage');
  assert.deepStrictEqual(captured.params, [false, '2026-08-30T12:00:00.000Z', 101]);
  assert.strictEqual(await isLogSourceObservationFresh({
    get: async () => ({ fresh: false, plausible: true }),
  }, '2026-08-30T10:00:00.000Z'), false,
  'stale provider observations must not authorize lifecycle coverage');
  let normalizedObservationParams;
  assert.strictEqual(await isLogSourceObservationFresh({
    get: async (_sql, params) => {
      normalizedObservationParams = params;
      return { fresh: true, plausible: true };
    },
  }, 1767225600), true);
  assert.deepStrictEqual(normalizedObservationParams, [
    new Date(1767225600 * 1000).toISOString(),
    new Date(1767225600 * 1000).toISOString(),
  ], 'provider epoch seconds must be normalized before freshness validation');

  const automationSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'automation.js'), 'utf8');
  const schedulerSource = fs.readFileSync(path.join(__dirname, '..', 'scheduler.js'), 'utf8');
  const teleportSource = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'teleportProcessorService.js'), 'utf8'
  );
  assert.match(automationSource,
    /markServerLogParseSuccessful\([\s\S]{0,180}lifecycleEvidenceReady:\s*scanResult\.onlineCachePublished === true/,
    'manual historical parsing must carry cache-publication evidence into lifecycle watermarking');
  assert.match(schedulerSource,
    /markServerLogParseSuccessful\([\s\S]{0,180}lifecycleEvidenceReady:\s*scanResult\.onlineCachePublished === true/,
    'scheduled historical parsing must carry cache-publication evidence into lifecycle watermarking');
  assert.match(teleportSource,
    /markServerLogParseSuccessful \|\| markServerLogParseSuccessful\)\([\s\S]{0,220}lifecycleEvidenceReady:\s*true/,
    'teleport refresh may advance coverage only after its strict fresh-publication check');
  assert.doesNotMatch(automationSource, /const syncStartedAt = new Date\(\)/,
    'manual finality must not trust the application clock');
  assert.doesNotMatch(schedulerSource, /const syncStartedAt = new Date\(\)/,
    'scheduled finality must not trust the application clock');
  assert.match(schedulerSource,
    /const alreadyParsedServers = filterServerIdsWithoutSyncErrors[\s\S]*isLogSourceObservationFresh\([\s\S]{0,180}latestAdmModifiedAt[\s\S]*markServerLogParseSuccessful\([\s\S]{0,180}lifecycleEvidenceReady/,
    'verified unchanged logs must advance lifecycle coverage only when provider observation is fresh');
}

async function testParseWatermarkUsesUnambiguousInternalServerId() {
  await assert.rejects(
    () => markServerLogParseSuccessful({ run: async () => assert.fail('database touched') }, '42', new Date()),
    /internal server id/i
  );
  const duplicateDb = {
    async query() {
      return [
        { id: 41, platform_server_id: '101', discord_guild_id: 'guild-a', token_hash: 'a' },
        { id: 42, platform_server_id: '101', discord_guild_id: 'guild-b', token_hash: 'b' },
      ];
    },
  };
  assert.strictEqual(
    await resolveOperationalServers(duplicateDb, 7, ['101']),
    null,
    'duplicate provider IDs must not resolve to an arbitrary tenant for a financial finality watermark'
  );

  const exactDb = {
    async query() {
      return [{
        id: 42,
        platform_server_id: '101',
        discord_guild_id: 'guild-a',
        token_hash: 'ciphertext',
      }];
    },
  };
  assert.deepStrictEqual(await resolveOperationalServers(exactDb, 7, ['101']), [{
    id: 42,
    platformServerId: '101',
    guildDiscordId: 'guild-a',
    tokenHash: 'ciphertext',
  }]);

  let captured;
  await markServerLogParseSuccessful({
    run: async (sql, params) => { captured = { sql, params }; },
  }, 42, '2026-08-30T12:00:00.000Z', { lifecycleEvidenceReady: true });
  assert.match(captured.sql, /WHERE id = \?/);
  assert.doesNotMatch(captured.sql, /WHERE platform_server_id = \?/);
  assert.deepStrictEqual(captured.params, [true, '2026-08-30T12:00:00.000Z', 42]);
}

async function testOversizedAdvertisedLogIsRejectedBeforeTransfer() {
  const originalGet = http.get;
  let requestCount = 0;
  http.get = async () => { requestCount++; throw new Error('network must not be touched'); };
  try {
    await assert.rejects(
      downloadLogFile('test-token', '101', {
        name: 'active.ADM',
        path: '/noftp/dayz/config/active.ADM',
        size: 128 * 1024 * 1024 + 1,
      }, path.join(__dirname, '..', 'downloads', 'oversized.ADM')),
      /exceeds.*limit/i
    );
    assert.strictEqual(requestCount, 0);
  } finally {
    http.get = originalGet;
  }
}

async function testIncompleteDownloadPreservesExistingFile() {
  const relativeDirectory = path.join('.test-log-sync', String(process.pid));
  const localPath = path.join(__dirname, '..', 'downloads', relativeDirectory, 'active.ADM');
  const originalGet = http.get;
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, 'complete-old-copy');

  let requestCount = 0;
  http.get = async () => {
    requestCount++;
    if (requestCount === 1) {
      return {
        data: {
          status: 'success',
          data: { token: { url: 'https://download.example.test/active.ADM' } },
        },
      };
    }
    return { data: Buffer.from('short') };
  };

  try {
    await assert.rejects(
      downloadLogFile('test-token', '101', {
        name: 'active.ADM',
        path: '/noftp/dayz/config/active.ADM',
        size: 20,
      }, localPath),
      /incomplete/i
    );
    assert.strictEqual(fs.readFileSync(localPath, 'utf8'), 'complete-old-copy');
  } finally {
    http.get = originalGet;
    fs.rmSync(path.join(__dirname, '..', 'downloads', '.test-log-sync'), { recursive: true, force: true });
  }
}

async function testVerifiedIdenticalDownloadDoesNotRewriteOrMarkChanged() {
  const relativeDirectory = path.join('.test-log-sync-identical', String(process.pid));
  const localPath = path.join(__dirname, '..', 'downloads', relativeDirectory, 'active.ADM');
  const originalGet = http.get;
  fs.mkdirSync(path.dirname(localPath), { recursive: true });
  fs.writeFileSync(localPath, 'same');
  const originalMtime = new Date('2026-08-29T10:00:00.000Z');
  fs.utimesSync(localPath, originalMtime, originalMtime);

  let requestCount = 0;
  http.get = async () => {
    requestCount++;
    if (requestCount === 1) {
      return { data: { status: 'success', data: { token: { url: 'https://download.example.test/active.ADM' } } } };
    }
    return { data: Buffer.from('same') };
  };

  try {
    const changed = await downloadLogFile('test-token', '101', {
      name: 'active.ADM',
      path: '/noftp/dayz/config/active.ADM',
      size: 4,
    }, localPath);
    assert.strictEqual(changed, false, 'verified identical bytes must not trigger parsing');
    assert.strictEqual(fs.statSync(localPath).mtimeMs, originalMtime.getTime(), 'identical downloads must preserve the parse generation');
  } finally {
    http.get = originalGet;
    fs.rmSync(path.join(__dirname, '..', 'downloads', '.test-log-sync-identical'), { recursive: true, force: true });
  }
}

async function testSerialAndConcurrentSyncStayServerScoped() {
  const encryption = require('../utils/encryption');
  const nitradoModule = require('../services/nitradoService');
  const servicePath = require.resolve('../services/logSyncService');
  const originalDecryptToken = encryption.decryptToken;
  const originalCreateNitradoService = nitradoModule.createNitradoService;
  const originalGet = http.get;
  const guildId = `test-sync-${process.pid}`;
  let includeAdmLogs = true;
  let includeRptLogs = false;
  let includeServerLog = true;
  let incompleteRptDownloads = true;
  let extraLogNames = [];
  let extraLogEntries = [];
  const requestedUrls = [];

  encryption.decryptToken = () => 'test-token';
  nitradoModule.createNitradoService = () => ({
    getRawGameserver: async (_token, serverId) => serverId === '102'
      ? {
        game: 'dayzstandalone',
        game_specific: { path: `/games/${serverId}/ftproot/dayzstandalone` },
      }
      : {
        game: 'dayzxb',
        game_specific: { path: `/games/${serverId}/noftp/dayzxb` },
      },
  });
  delete require.cache[servicePath];
  const syncService = require(servicePath);

  http.get = async url => {
    requestedUrls.push(String(url));
    const serverId = String(url).match(/services\/(\d+)/)?.[1];
    const dataDirectory = serverId === '102' ? 'dayzstandalone' : 'dayzxb';
    const dialect = serverId === '102' ? 'ftproot' : 'noftp';
    if (String(url).includes('/file_server/list?dir=')) {
      return {
        data: {
          status: 'success',
          data: {
            entries: [
              ...(includeAdmLogs ? [{
                type: 'file',
                name: `server-${serverId}.ADM`,
                path: `/games/${serverId}/${dialect}/${dataDirectory}/config/server-${serverId}.ADM`,
                size: 8,
              }] : []),
              ...(includeRptLogs ? [{
                type: 'file',
                name: `DayZServer_x64_2026-09-04_22-00-00.RPT`,
                path: `/games/${serverId}/${dialect}/${dataDirectory}/config/DayZServer_x64_2026-09-04_22-00-00.RPT`,
                size: 8,
              }] : []),
              ...(includeServerLog ? [{
                type: 'file',
                name: 'server.log',
                path: `/games/${serverId}/${dialect}/${dataDirectory}/config/server.log`,
                size: 8,
              }] : []),
              ...extraLogNames.map(name => ({
                type: 'file',
                name,
                path: `/games/${serverId}/${dialect}/${dataDirectory}/config/${name}`,
                size: 8,
              })),
              ...extraLogEntries,
            ],
          },
        },
      };
    }
    if (String(url).endsWith('/file_server/list')) {
      return {
        data: {
          status: 'success',
          data: {
            entries: [{
              type: 'dir',
              name: dataDirectory,
              path: `/games/${serverId}/${dialect}/${dataDirectory}`,
            }],
          },
        },
      };
    }
    if (String(url).includes('/file_server/download?file=')) {
      const fileName = decodeURIComponent(String(url).split('file=')[1]);
      return {
        data: {
          status: 'success',
          data: { token: { url: `https://download.example.test/${path.posix.basename(fileName)}` } },
        },
      };
    }
    if (String(url).startsWith('https://download.example.test/')) {
      const incomplete = String(url).endsWith('/server.log') ||
        (incompleteRptDownloads && String(url).endsWith('.RPT'));
      return { data: Buffer.from(incomplete ? 'short' : 'complete') };
    }
    throw new Error(`Unexpected test URL: ${url}`);
  };

  const db = {
    get: async (_sql, params) => {
      const serverId = String(params[1]);
      if (!['101', '102'].includes(serverId)) return null;
      return {
        platform_server_id: serverId,
        discord_guild_id: guildId,
        token_hash: 'encrypted-test-token',
      };
    },
  };

  try {
    for (const sync of [syncService.performLogSync, syncService.performLogSyncConcurrent]) {
      fs.rmSync(path.join(__dirname, '..', 'downloads', guildId), { recursive: true, force: true });
      const result = await sync(db, 7, 'test-token', ['101', '102', '999']);
      assert.strictEqual(result.totalFilesDownloaded, 2);
      assert.strictEqual(result.totalFilesUpdated, 0);
      assert.deepStrictEqual([...result.changedServerIds].sort(), ['101', '102']);
      assert.strictEqual(result.errors.length, 3);
      assert.deepStrictEqual([...result.failedServerIds].sort(), ['101', '102', '999']);
      assert.deepStrictEqual(
        [...result.parseBlockedServerIds].sort(),
        ['999'],
        'server.log failures must not block parsing independently verified ADM files'
      );
      assert.ok(result.errors.some(error => /Server 999/.test(error)));
      assert.strictEqual(result.serverLogPaths['101'], null);
      assert.strictEqual(result.serverLogPaths['102'], null);
      const pcConfigPath = encodeURIComponent('/games/102/ftproot/dayzstandalone/config');
      assert.ok(
        requestedUrls.some(url => url.includes(`/services/102/gameservers/file_server/list?dir=${pcConfigPath}`)),
        'PC log sync must list the authoritative ftproot data directory returned by Nitrado'
      );
      assert.ok(
        requestedUrls.some(url => url.includes(`/services/102/gameservers/file_server/download?file=${pcConfigPath}%2Fserver-102.ADM`)),
        'PC log sync must download through the authoritative ftproot path returned by Nitrado'
      );

      const unchangedResult = await sync(db, 7, 'test-token', ['101', '102']);
      assert.deepStrictEqual(unchangedResult.changedServerIds, [], 'identical verified ADM bytes must not schedule replay');
      assert.strictEqual(unchangedResult.totalFilesUpdated, 0);
      assert.strictEqual(unchangedResult.totalFilesSkipped, 2);
    }

    includeRptLogs = true;
    for (const sync of [syncService.performLogSync, syncService.performLogSyncConcurrent]) {
      fs.rmSync(path.join(__dirname, '..', 'downloads', guildId), { recursive: true, force: true });
      const result = await sync(db, 7, 'test-token', ['101']);
      assert.ok(result.errors.some(error => /\.RPT: Nitrado returned an incomplete log file download/.test(error)));
      assert.deepStrictEqual(result.changedServerIds, ['101']);
      assert.deepStrictEqual(result.failedServerIds, ['101']);
      assert.deepStrictEqual(
        result.parseBlockedServerIds,
        [],
        'an incomplete RPT must not block parsing a complete ADM from the same server'
      );
      assert.deepStrictEqual(
        result.rptBlockedServerIds,
        ['101'],
        'an incomplete RPT must disable local RPT parsing for only that server'
      );
    }
    const rptFilename = 'DayZServer_x64_2026-09-04_22-00-00.RPT';
    const outsideRpt = path.join(os.tmpdir(), `dayz-log-sync-rpt-${process.pid}-${Date.now()}`);
    fs.writeFileSync(outsideRpt, 'outside');
    try {
      for (const sync of [syncService.performLogSync, syncService.performLogSyncConcurrent]) {
        const configPath = path.join(__dirname, '..', 'downloads', guildId, 'server_101', 'config');
        fs.rmSync(path.join(__dirname, '..', 'downloads', guildId), { recursive: true, force: true });
        fs.mkdirSync(configPath, { recursive: true });
        fs.symlinkSync(outsideRpt, path.join(configPath, rptFilename));
        const result = await sync(db, 7, 'test-token', ['101']);
        assert.ok(result.errors.some(error => /\.RPT: Local log destination is a symbolic link/.test(error)));
        assert.deepStrictEqual(result.changedServerIds, ['101']);
        assert.deepStrictEqual(result.failedServerIds, ['101']);
        assert.deepStrictEqual(
          result.parseBlockedServerIds,
          [],
          'a rejected local RPT destination must not block parsing a complete ADM'
        );
        assert.deepStrictEqual(
          result.rptBlockedServerIds,
          ['101'],
          'a rejected local RPT destination must disable only RPT parsing for that server'
        );
        const scanResult = await scanAdmOnlyForTest(guildId);
        assert.deepStrictEqual(scanResult.filesScanned, { admCount: 1, rptCount: 0 },
          'an RPT-blocked scan must ignore a rejected recent RPT destination');
      }
    } finally {
      fs.rmSync(outsideRpt, { force: true });
    }

    includeRptLogs = false;
    const historicalCases = ['RPT', 'ADM'].flatMap(extension =>
      ['symlink', 'directory'].map(destinationKind => ({
        extension,
        destinationKind,
        expectedParseBlocked: extension === 'ADM' ? ['101'] : [],
        expectedRptBlocked: extension === 'RPT' ? ['101'] : [],
      }))
    );
    for (const testCase of historicalCases) {
      includeAdmLogs = testCase.extension !== 'ADM';
      extraLogNames = [1, 2, 3].map(day =>
        `DayZServer_x64_2026-09-0${day}_22-00-00.${testCase.extension}`
      );
      const historicalName = extraLogNames[0];
      const outside = path.join(
        os.tmpdir(),
        `dayz-log-sync-historical-${testCase.extension}-${process.pid}-${Date.now()}`
      );
      if (testCase.destinationKind === 'symlink') fs.writeFileSync(outside, 'outside');
      try {
        for (const sync of [syncService.performLogSync, syncService.performLogSyncConcurrent]) {
          const configPath = path.join(__dirname, '..', 'downloads', guildId, 'server_101', 'config');
          const localPath = path.join(configPath, historicalName);
          fs.rmSync(path.join(__dirname, '..', 'downloads', guildId), { recursive: true, force: true });
          fs.mkdirSync(configPath, { recursive: true });
          if (testCase.destinationKind === 'symlink') {
            fs.symlinkSync(outside, localPath);
          } else {
            fs.mkdirSync(localPath);
            if (testCase.extension === 'RPT') {
              fs.writeFileSync(path.join(localPath, 'nested.ADM'), 'untrusted nested ADM');
            }
          }
          const result = await sync(db, 7, 'test-token', ['101']);
          const expectedError = testCase.destinationKind === 'symlink'
            ? 'Local log destination is a symbolic link'
            : 'Local log destination is not a regular file';
          assert.ok(result.errors.some(error =>
            error.includes(`${historicalName}: ${expectedError}`)
          ));
          assert.deepStrictEqual(result.changedServerIds, ['101'],
            'valid current logs must still synchronize after a historical destination rejection');
          assert.deepStrictEqual(result.parseBlockedServerIds, testCase.expectedParseBlocked);
          assert.deepStrictEqual(result.rptBlockedServerIds, testCase.expectedRptBlocked);
          if (testCase.extension === 'RPT') {
            const scanResult = await scanAdmOnlyForTest(guildId);
            assert.deepStrictEqual(scanResult.filesScanned, { admCount: 1, rptCount: 0 },
              'an RPT-blocked scan must ignore rejected RPT destinations and nested files');
          }
        }
      } finally {
        fs.rmSync(outside, { force: true });
      }
    }

    incompleteRptDownloads = false;
    includeAdmLogs = false;
    extraLogNames = [
      ...[1, 2, 3, 4, 5, 6, 7, 8].map(day =>
        `DayZServer_x64_2026-09-0${day}_22-00-00.ADM`
      ),
      ...[5, 6, 7].map(day =>
        `DayZServer_x64_2026-09-0${day}_22-00-00.RPT`
      ),
    ];
    const omittedHistoricalRpt = 'DayZServer_x64_2026-09-05_22-00-00.RPT';
    for (const destinationKind of ['symlink', 'directory']) {
      const outside = path.join(
        os.tmpdir(),
        `dayz-log-sync-unselected-rpt-${destinationKind}-${process.pid}-${Date.now()}`
      );
      if (destinationKind === 'symlink') fs.writeFileSync(outside, 'outside');
      try {
        for (const sync of [syncService.performLogSync, syncService.performLogSyncConcurrent]) {
          const configPath = path.join(__dirname, '..', 'downloads', guildId, 'server_101', 'config');
          const localPath = path.join(configPath, omittedHistoricalRpt);
          fs.rmSync(path.join(__dirname, '..', 'downloads', guildId), { recursive: true, force: true });
          fs.mkdirSync(configPath, { recursive: true });
          if (destinationKind === 'symlink') {
            fs.symlinkSync(outside, localPath);
          } else {
            fs.mkdirSync(localPath);
            fs.writeFileSync(path.join(localPath, 'nested.ADM'), 'untrusted nested ADM');
          }
          const requestStart = requestedUrls.length;
          const result = await sync(db, 7, 'test-token', ['101']);
          const expectedError = destinationKind === 'symlink'
            ? 'Local log destination is a symbolic link'
            : 'Local log destination is not a regular file';
          assert.ok(result.errors.some(error =>
            error.includes(`${omittedHistoricalRpt}: ${expectedError}`)
          ), 'all listed destinations must be classified even when an artifact exceeds batch capacity');
          assert.deepStrictEqual(result.parseBlockedServerIds, [],
            'an unselected historical RPT destination must not block complete ADM evidence');
          assert.deepStrictEqual(result.rptBlockedServerIds, ['101'],
            'an unselected historical RPT destination must disable RPT scanning');
          assert.ok(!requestedUrls.slice(requestStart).some(url => url.includes(omittedHistoricalRpt)),
            'a rejected destination beyond batch capacity must not be downloaded');
          const scanResult = await scanAdmOnlyForTest(guildId);
          assert.deepStrictEqual(scanResult.filesScanned, { admCount: 6, rptCount: 0 },
            'ADM-only scanning must not traverse nested ADM files in a rejected RPT directory');
        }
      } finally {
        fs.rmSync(outside, { force: true });
      }
    }

    extraLogNames = [];
    includeAdmLogs = true;
    const rejectedProviderRptCases = [
      {
        label: 'directory entry',
        entry: {
          type: 'dir',
          name: 'provider-artifact.RPT',
          path: '/games/101/noftp/dayzxb/config/provider-artifact.RPT',
        },
        expectedError: 'Nitrado returned an invalid log file path',
        createLocalDirectory: true,
      },
      {
        label: 'malformed provider path',
        entry: {
          type: 'file',
          name: 'provider-artifact.RPT',
          path: '/games/101/noftp/dayzxb/config/different.RPT',
          size: 8,
        },
        expectedError: 'Nitrado returned an invalid log file path',
      },
      {
        label: 'invalid advertised size',
        entry: {
          type: 'file',
          name: 'provider-artifact.RPT',
          path: '/games/101/noftp/dayzxb/config/provider-artifact.RPT',
          size: -1,
        },
        expectedError: 'Invalid log artifact size',
      },
    ];
    for (const testCase of rejectedProviderRptCases) {
      extraLogEntries = [testCase.entry];
      for (const sync of [syncService.performLogSync, syncService.performLogSyncConcurrent]) {
        const configPath = path.join(__dirname, '..', 'downloads', guildId, 'server_101', 'config');
        fs.rmSync(path.join(__dirname, '..', 'downloads', guildId), { recursive: true, force: true });
        fs.mkdirSync(configPath, { recursive: true });
        if (testCase.createLocalDirectory) {
          const rejectedPath = path.join(configPath, testCase.entry.name);
          fs.mkdirSync(rejectedPath);
          fs.writeFileSync(path.join(rejectedPath, 'nested.ADM'), 'untrusted nested ADM');
        }
        const result = await sync(db, 7, 'test-token', ['101']);
        assert.ok(result.errors.some(error =>
          error.includes(`${testCase.entry.name}: ${testCase.expectedError}`)
        ), `${testCase.label} must retain RPT-specific failure attribution`);
        assert.deepStrictEqual(result.changedServerIds, ['101']);
        assert.deepStrictEqual(result.parseBlockedServerIds, [],
          `${testCase.label} must not block complete ADM evidence`);
        assert.deepStrictEqual(result.rptBlockedServerIds, ['101'],
          `${testCase.label} must disable RPT scanning`);
        const scanResult = await scanAdmOnlyForTest(guildId);
        assert.deepStrictEqual(scanResult.filesScanned, { admCount: 1, rptCount: 0 });
      }
    }

    includeAdmLogs = false;
    extraLogEntries = [
      {
        type: 'file',
        name: 'lowercase.adm',
        path: '/games/101/noftp/dayzxb/config/lowercase.adm',
        size: 8,
      },
      {
        type: 'file',
        name: 'lowercase.rpt',
        path: '/games/101/noftp/dayzxb/config/lowercase.rpt',
        size: 8,
      },
    ];
    for (const sync of [syncService.performLogSync, syncService.performLogSyncConcurrent]) {
      const configPath = path.join(__dirname, '..', 'downloads', guildId, 'server_101', 'config');
      fs.rmSync(path.join(__dirname, '..', 'downloads', guildId), { recursive: true, force: true });
      const result = await sync(db, 7, 'test-token', ['101']);
      assert.deepStrictEqual(result.parseBlockedServerIds, []);
      assert.deepStrictEqual(result.rptBlockedServerIds, []);
      assert.deepStrictEqual(result.changedServerIds, ['101'],
        'lowercase ADM/RPT provider artifacts must participate in synchronization');
      assert.ok(fs.statSync(path.join(configPath, 'lowercase.adm')).isFile());
      assert.ok(fs.statSync(path.join(configPath, 'lowercase.rpt')).isFile());
    }

    extraLogNames = [];
    extraLogEntries = [];
    includeAdmLogs = true;
    includeRptLogs = false;
    incompleteRptDownloads = true;

    includeAdmLogs = false;
    for (const sync of [syncService.performLogSync, syncService.performLogSyncConcurrent]) {
      fs.rmSync(path.join(__dirname, '..', 'downloads', guildId), { recursive: true, force: true });
      const result = await sync(db, 7, 'test-token', ['101']);
      assert.ok(result.errors.some(error => /Server 101.*No ADM\/RPT log files/i.test(error)));
      assert.deepStrictEqual(result.changedServerIds, []);
      assert.deepStrictEqual(result.failedServerIds, ['101']);
      assert.deepStrictEqual(result.parseBlockedServerIds, ['101']);
    }

    includeAdmLogs = true;
    includeServerLog = false;
    for (const sync of [syncService.performLogSync, syncService.performLogSyncConcurrent]) {
      fs.rmSync(path.join(__dirname, '..', 'downloads', guildId), { recursive: true, force: true });
      const result = await sync(db, 7, 'test-token', ['101']);
      assert.ok(result.errors.some(error => /Server 101.*No server\.log file found/i.test(error)));
      assert.strictEqual(result.serverLogPaths['101'], null);
      assert.deepStrictEqual(result.failedServerIds, ['101']);
      assert.deepStrictEqual(
        result.parseBlockedServerIds,
        [],
        'missing server.log must not block parsing independently verified ADM files'
      );
    }
  } finally {
    http.get = originalGet;
    encryption.decryptToken = originalDecryptToken;
    nitradoModule.createNitradoService = originalCreateNitradoService;
    delete require.cache[servicePath];
    fs.rmSync(path.join(__dirname, '..', 'downloads', guildId), { recursive: true, force: true });
  }
}

function testFullRescanIncludesLogsOlderThanIncrementalWindow() {
  const { findAllLogFiles } = require('../routes/logParser');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayz-log-full-scan-'));
  const recent = path.join(directory, 'recent.ADM');
  const old = path.join(directory, 'old.ADM');
  fs.writeFileSync(recent, 'recent');
  fs.writeFileSync(old, 'old');
  const oldTime = new Date(Date.now() - 26 * 60 * 60 * 1000);
  fs.utimesSync(old, oldTime, oldTime);

  try {
    assert.deepStrictEqual(findAllLogFiles(directory, /\.ADM$/i).map(file => path.basename(file)), ['recent.ADM']);
    assert.deepStrictEqual(
      findAllLogFiles(directory, /\.ADM$/i, Infinity).map(file => path.basename(file)).sort(),
      ['old.ADM', 'recent.ADM']
    );
    const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'logParser.js'), 'utf8');
    const fullRoute = source.slice(source.indexOf("router.post('/scan-all-logs'"), source.indexOf('// Helper: Fetch server info'));
    assert.match(fullRoute, /scanLogsForServer\([\s\S]*?fullHistory:\s*true[\s\S]*?\)/);
    assert.match(source, /fullHistory \? Infinity : 25 \* 60 \* 60 \* 1000/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function testLogInventoryPropagatesFilesystemFailures() {
  const { findAllLogFiles } = require('../routes/logParser');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayz-log-inventory-error-'));
  const logPath = path.join(directory, 'broken.ADM');
  fs.writeFileSync(logPath, 'data');
  const originalLstatSync = fs.lstatSync;
  fs.lstatSync = candidate => {
    if (candidate === logPath) throw new Error('stat failed');
    return originalLstatSync(candidate);
  };

  try {
    assert.throws(() => findAllLogFiles(directory, /\.ADM$/i, Infinity), /stat failed/);
  } finally {
    fs.lstatSync = originalLstatSync;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function testLogInventoryRejectsSymlinkEscapes() {
  const { findAllLogFiles } = require('../routes/logParser');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayz-log-inventory-symlink-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dayz-log-inventory-outside-'));
  fs.writeFileSync(path.join(outside, 'foreign.ADM'), 'foreign');
  fs.symlinkSync(outside, path.join(directory, 'linked'));

  try {
    assert.throws(
      () => findAllLogFiles(directory, /\.ADM$/i, Infinity),
      /symbolic link/i
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

function testMixedFilenameChronologyIsTransitive() {
  const { compareLogFileEntries } = require('../utils/logFileChronology');
  const january = Date.UTC(2026, 0, 1);
  const february = Date.UTC(2026, 1, 1);
  const march = Date.UTC(2026, 2, 1);
  const entries = [
    { name: 'DayZServer_X1_x64_2026-03-01_00-00-00.ADM', mtimeMs: january },
    { name: 'invalid.ADM', mtimeMs: february },
    { name: 'DayZServer_X1_x64_2026-01-01_00-00-00.ADM', mtimeMs: march },
  ];

  assert.deepStrictEqual(
    entries.sort(compareLogFileEntries).map(entry => entry.name),
    [
      'DayZServer_X1_x64_2026-01-01_00-00-00.ADM',
      'invalid.ADM',
      'DayZServer_X1_x64_2026-03-01_00-00-00.ADM',
    ]
  );
}

function testRptDateUsesStrictFilenameValidation() {
  const { extractRPTLogDate } = require('../routes/logParser');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayz-rpt-date-'));
  const invalid = path.join(directory, 'DayZServer_X1_x64_2026-02-30_01-00-00.RPT');
  const fallbackTime = new Date('2026-02-28T12:00:00.000Z');
  fs.writeFileSync(invalid, 'RPT data');
  fs.utimesSync(invalid, fallbackTime, fallbackTime);

  try {
    assert.strictEqual(extractRPTLogDate(invalid), '2026-02-28');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function testAdmDateUsesStrictHeaderAndFileMtimeFallback() {
  const { extractLogDateFromFilePath } = require('../routes/logParser');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayz-adm-date-'));
  const invalid = path.join(directory, 'invalid.ADM');
  const fallbackTime = new Date('2026-02-28T12:00:00.000Z');
  fs.writeFileSync(invalid, 'AdminLog started on 2026-02-30 at 25:00:00\n');
  fs.utimesSync(invalid, fallbackTime, fallbackTime);

  try {
    assert.strictEqual(extractLogDateFromFilePath(invalid), '2026-02-28');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function testStreamingReadRejectsReplacementSymlink() {
  const { streamLogLines } = require('../routes/logParser');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayz-stream-contained-'));
  const outside = path.join(os.tmpdir(), `dayz-outside-${process.pid}-${Date.now()}.ADM`);
  const logPath = path.join(directory, 'active.ADM');
  fs.writeFileSync(outside, '01:00:00 | outside\n');
  fs.symlinkSync(outside, logPath);

  try {
    await assert.rejects(async () => {
      for await (const entry of streamLogLines(logPath, { rootDir: directory })) {
        if (entry) break;
      }
    }, /symbolic link|invalid|outside/i);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
}

function testLogInventoryRejectsSymlinkBaseDirectory() {
  const { findAllLogFiles } = require('../routes/logParser');
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'dayz-inventory-base-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dayz-inventory-outside-'));
  const linkedBase = path.join(parent, 'config');
  fs.writeFileSync(path.join(outside, 'foreign.ADM'), 'outside');
  fs.symlinkSync(outside, linkedBase, 'dir');

  try {
    assert.throws(() => findAllLogFiles(linkedBase, /\.ADM$/i, Infinity), /symbolic link|invalid/i);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

async function testMissingEventIdentityFailsClosed() {
  const { saveDamageEvents } = require('../routes/logParser');
  const db = {
    get: async sql => sql.includes('SELECT id FROM servers') ? { id: 42 } : null,
    all: async () => [],
  };
  await assert.rejects(
    saveDamageEvents(db, '101', [{
      victimGamertag: 'Victim',
      victimPlatformUserId: 'BBBBBBBB',
      attackerType: 'environment',
      timestamp: '2026-08-29T01:00:00Z',
    }], 'xbox', 42),
    /identity/i,
    'a parsed event without an exact persisted identity must fail the file scan'
  );
}

async function testStreamingParserDiscoversEventOnlyParticipants() {
  const { parseADMFileStream } = require('../routes/logParser');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayz-event-participants-'));
  const logPath = path.join(directory, 'events.ADM');
  fs.writeFileSync(logPath,
    '15:22:42 | Player "Victim" (DEAD) (id=BBBBBBBB pos=<1, 2, 3>)[HP: 0] hit by Player "Attacker" (id=CCCCCCCC pos=<4, 5, 6>) into Torso(16) for 94 damage (Bullet_556x45) with M4-A1 from 5 meters\n'
  );

  try {
    const parsed = await parseADMFileStream(logPath, '2026-08-29');
    assert.deepStrictEqual(
      parsed.players.map(player => player.platformUserId).sort(),
      ['BBBBBBBB', 'CCCCCCCC'],
      'event-only participants must receive identities before event persistence'
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function testStreamingParserRejectsUnknownDisconnectIdentity() {
  const { parseADMFileStream } = require('../routes/logParser');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayz-unknown-disconnect-'));
  const logPath = path.join(directory, 'events.ADM');
  fs.writeFileSync(logPath, '00:01:00 | Player "Anonymous" (id=Unknown) has been disconnected\n');

  try {
    const parsed = await parseADMFileStream(logPath, '2026-08-29');
    assert.deepStrictEqual(parsed.players, []);
    assert.deepStrictEqual(parsed.sessions, []);
    assert.deepStrictEqual(parsed.onlineUpdates, []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function testStreamingParserPreservesConsoleBase64UrlIdentity() {
  const { parseADMFileStream, parseADMLog } = require('../routes/logParser');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayz-console-identity-'));
  const logPath = path.join(directory, 'events.ADM');
  const platformUserId = `AbCd_-${'x'.repeat(37)}=`;
  const opaqueHexId = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';
  fs.writeFileSync(logPath, [
    `01:00:00 | Player "Console Survivor" (id=${platformUserId}) is connecting`,
    `01:01:00 | Player "Console Survivor" (id=${platformUserId} pos=<1.0, 2.0, 3.0>) is connected`,
    `01:02:00 | Player "Console Survivor" (id=${platformUserId} pos=<1.0, 2.0, 3.0>) has been disconnected`,
    `01:03:00 | Player "Hex Survivor" (id=${opaqueHexId}) is connecting`,
    `01:04:00 | Player "Hex Survivor" (id=${opaqueHexId} pos=<1.0, 2.0, 3.0>) has been disconnected`,
  ].join('\n'));

  try {
    assert.strictEqual(platformUserId.length, 44);
    const parsed = await parseADMFileStream(logPath, '2026-08-29', { platform: 'playstation' });
    assert.deepStrictEqual(
      parsed.players.map(player => player.platformUserId),
      [platformUserId, opaqueHexId],
    );
    assert.deepStrictEqual(
      parsed.onlineUpdates.map(update => update.platformUserId),
      [platformUserId, platformUserId, opaqueHexId, opaqueHexId],
    );
    assert.deepStrictEqual(
      parsed.sessions.map(session => session.platformUserId),
      [platformUserId, opaqueHexId],
    );
    assert.deepStrictEqual(
      parseADMLog(fs.readFileSync(logPath, 'utf8'), 'playstation').map(player => player.platformUserId),
      [platformUserId, opaqueHexId],
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function testStreamingParserNormalizesAndFiltersEveryEventIdentity() {
  const { normalizeParsedEventIdentities } = require('../routes/logParser');
  const consoleId = `AbCd_-${'x'.repeat(37)}=`;
  const eventGroups = {
    healthUpdates: [{ platformUserId: 'abcdef12' }, { platformUserId: 'Unknown' }],
    damageEvents: [
      { victimPlatformUserId: consoleId, attackerPlatformUserId: 'abcdef12' },
      { victimPlatformUserId: 'x'.repeat(129), attackerPlatformUserId: null },
    ],
    killEvents: [{ victimPlatformUserId: 'abcdef12', killerPlatformUserId: consoleId }],
    territoryEvents: [{ platformUserId: consoleId }],
    deathEvents: [{ platformUserId: 'abcdef12' }],
    unconsciousEvents: [{ platformUserId: consoleId }],
    respawnEvents: [{ platformUserId: 'abcdef12' }],
    positionSnapshots: [{ platformUserId: consoleId }],
    emoteEvents: [{ platformUserId: 'abcdef12' }],
  };

  const normalized = normalizeParsedEventIdentities(eventGroups, 'xbox');
  assert.deepStrictEqual(normalized.healthUpdates, [{ platformUserId: 'ABCDEF12' }]);
  assert.deepStrictEqual(normalized.damageEvents, [{
    victimPlatformUserId: consoleId,
    attackerPlatformUserId: 'ABCDEF12',
  }]);
  assert.deepStrictEqual(normalized.killEvents, [{
    victimPlatformUserId: 'ABCDEF12',
    killerPlatformUserId: consoleId,
  }]);
  for (const group of ['territoryEvents', 'unconsciousEvents', 'positionSnapshots']) {
    assert.strictEqual(normalized[group][0].platformUserId, consoleId);
  }
  for (const group of ['deathEvents', 'respawnEvents', 'emoteEvents']) {
    assert.strictEqual(normalized[group][0].platformUserId, 'ABCDEF12');
  }

  const opaqueHex = normalizeParsedEventIdentities({
    healthUpdates: [{ platformUserId: 'abcdef12' }],
  }, 'playstation');
  assert.deepStrictEqual(opaqueHex.healthUpdates, [{ platformUserId: 'abcdef12' }]);
}

async function testCombatParserUsesPlatformAwareIdentityBoundary() {
  const { parseCombatEvents } = require('../routes/logParser');
  const oversizedId = 'a'.repeat(129);
  const lines = [
    '12:00:00 | Player "Victim" (DEAD) (id=abcdef12 pos=<1.0, 2.0, 3.0>)[HP: 0] hit by Player "Killer" (id=deadbeef pos=<4.0, 5.0, 6.0>) into Torso(16) for 10 damage (Bullet_556x45) with M4-A1 from 5 meters',
    '12:00:00 | Player "Victim" (DEAD) (id=abcdef12 pos=<1.0, 2.0, 3.0>) killed by Player "Killer" (id=deadbeef pos=<4.0, 5.0, 6.0>) with M4-A1 from 5 meters',
    '12:01:00 | Player "Anonymous" (id=Unknown pos=<1.0, 2.0, 3.0>)[HP: 50] hit by FallDamage',
    `12:02:00 | Player "Oversized" (id=${oversizedId} pos=<1.0, 2.0, 3.0>)[HP: 50] hit by FallDamage`,
  ];

  const parsed = parseCombatEvents(lines, '2026-08-29', 'playstation');
  assert.strictEqual(parsed.damageEvents.length, 1);
  assert.strictEqual(parsed.damageEvents[0].victimPlatformUserId, 'abcdef12');
  assert.strictEqual(parsed.damageEvents[0].attackerPlatformUserId, 'deadbeef');
  assert.strictEqual(parsed.killEvents.length, 1);
  assert.strictEqual(parsed.killEvents[0].victimPlatformUserId, 'abcdef12');
  assert.strictEqual(parsed.killEvents[0].killerPlatformUserId, 'deadbeef');
}

async function testPlatformResolutionUsesExactStoredServerAfterProviderFailure() {
  const { resolveServerPlatform } = require('../routes/logParser');
  const queries = [];
  const db = {
    async get(sql, params) {
      queries.push({ sql, params });
      return { platform: 'switch2' };
    },
  };

  const platform = await resolveServerPlatform(db, 'token', '90000001', {
    fetchPlatform: async () => 'unknown',
    internalServerId: 42,
  });
  assert.strictEqual(platform, 'switch2');
  assert.deepStrictEqual(queries[0].params, [42]);
  assert.match(queries[0].sql, /WHERE id = \?/);
  assert.doesNotMatch(queries[0].sql, /platform_server_id/);

  await assert.rejects(
    () => resolveServerPlatform({ get: async () => ({ platform: 'unknown' }) }, 'token', '90000001', {
      fetchPlatform: async () => 'unknown',
      internalServerId: 42,
    }),
    /unable to determine platform/i,
  );
}

async function testStreamingParserCarriesMidnightRolloverAcrossEvents() {
  const { parseADMFileStream } = require('../routes/logParser');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayz-midnight-stream-'));
  const logPath = path.join(directory, 'events.ADM');
  fs.writeFileSync(logPath, [
    '23:59:00 | Player "First" (DEAD) (id=A1 pos=<1.0, 2.0, 3.0>) bled out',
    '00:01:00 | Player "Second" (DEAD) (id=B2 pos=<1.0, 2.0, 3.0>) bled out',
    '00:02:00 | Player "Online" (id=C3) is connected',
  ].join('\n'));

  try {
    const parsed = await parseADMFileStream(logPath, '2026-08-28');
    assert.deepStrictEqual(parsed.deathEvents.map(event => event.timestamp), [
      '2026-08-28T23:59:00Z',
      '2026-08-29T00:01:00Z',
    ]);
    assert.deepStrictEqual(parsed.onlineUpdates, [{
      type: 'connect',
      playerGamertag: 'Online',
      platformUserId: 'C3',
      loginAt: '2026-08-29T00:02:00Z',
    }]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function testStreamingParserPreservesUnconsciousEventParity() {
  const { parseADMFileStream } = require('../routes/logParser');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayz-unconscious-stream-'));
  const logPath = path.join(directory, 'events.ADM');
  fs.writeFileSync(logPath, [
    '01:00:00 | Player "Survivor" (id=A1 pos=<1.0, 2.0, 3.0>) is unconscious',
    '01:01:00 | Player "Survivor" (id=A1 pos=<1.0, 2.0, 3.0>) regained consciousness',
    '01:02:00 | Player "Survivor" (id=A1 pos=<1.0, 2.0, 3.0>) is disconnecting while being unconscious',
  ].join('\n'));
  try {
    const parsed = await parseADMFileStream(logPath, '2026-08-29');
    assert.deepStrictEqual(parsed.unconsciousEvents.map(event => event.eventType), [
      'unconscious',
      'regained_consciousness',
      'disconnect_unconscious',
    ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function testStreamingSessionsSpanRotatedAdmFiles() {
  const { parseADMFileStream } = require('../routes/logParser');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayz-session-rotation-'));
  const first = path.join(directory, 'first.ADM');
  const second = path.join(directory, 'second.ADM');
  fs.writeFileSync(first, '23:59:00 | Player "Survivor" (id=A1) is connected\n');
  fs.writeFileSync(second, '00:01:00 | Player "Survivor" (id=A1) has been disconnected\n');
  const sessionState = new Map();
  try {
    const firstParsed = await parseADMFileStream(first, '2026-08-28', {
      sessionState,
      includeActiveSessions: false,
    });
    assert.deepStrictEqual(firstParsed.sessions, []);
    const secondParsed = await parseADMFileStream(second, '2026-08-29', {
      sessionState,
      includeActiveSessions: true,
    });
    assert.strictEqual(secondParsed.sessions.length, 1);
    assert.strictEqual(secondParsed.sessions[0].loginAt, '2026-08-28T23:59:00Z');
    assert.strictEqual(secondParsed.sessions[0].logoutAt, '2026-08-29T00:01:00Z');
    assert.strictEqual(sessionState.size, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function testKillFeedQueueFailurePropagates() {
  const { queueKillEvent } = require('../utils/feedEventQueue');
  const db = {
    run: async () => { throw new Error('feed insert failed'); },
    get: async () => ({ id: 7 }),
  };

  await assert.rejects(
    queueKillEvent(db, 1, 2, 'kill_feed', 'player_kill', {}),
    /feed insert failed/,
    'a missing coupled feed row must roll back kill persistence so retry remains possible'
  );
}

async function testDisconnectWithoutWindowLocalConnectClosesPersistedSession() {
  const { saveSessions } = require('../routes/logParser');
  const economyHelper = require('../utils/economyHelper');
  const originalGetEconomyConfig = economyHelper.getEconomyConfigForIdentity;
  economyHelper.getEconomyConfigForIdentity = async () => null;
  const queries = [];
  const db = {
    all: async () => [{ platform_user_id: 'A1', id: 7 }],
    get: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes('SELECT id FROM servers')) return { id: 42 };
      if (sql.includes('FROM player_sessions') && sql.includes('logout_at IS NULL')) {
        return { id: 9, login_at: '2026-08-28T23:00:00Z' };
      }
      if (sql.includes('UPDATE player_sessions')) return { id: 9 };
      throw new Error(`Unexpected query: ${sql}`);
    },
    run: async (sql, params) => {
      queries.push({ sql, params });
      return { changes: 1 };
    },
    transaction: async callback => callback(),
  };

  try {
    await saveSessions(db, '101', [{
      playerGamertag: 'Survivor',
      platformUserId: 'A1',
      loginAt: null,
      logoutAt: '2026-08-29T00:01:00Z',
    }], 'xbox', 42);
    assert.ok(queries.some(query => query.sql.includes('UPDATE player_sessions')),
      'a disconnect-only record must close the latest persisted open session');
    assert.ok(!queries.some(query => query.sql.includes('INSERT INTO player_sessions')),
      'a disconnect-only record must not attempt a NULL login_at insert');
  } finally {
    economyHelper.getEconomyConfigForIdentity = originalGetEconomyConfig;
  }
}

async function testStreamingParserUsesHistoricalFilenameDate() {
  const { extractLogDateFromFilePath } = require('../routes/logParser');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayz-log-date-'));
  const logPath = path.join(directory, 'DayZServer_X1_x64_2026-08-28_01-00-00.ADM');
  fs.writeFileSync(logPath, '01:00:00 | unrelated line\n');
  try {
    assert.strictEqual(extractLogDateFromFilePath(logPath), '2026-08-28');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function testFullHistoryStreamingStartsAtBeginningOfOversizedLog() {
  const { streamLogLines } = require('../routes/logParser');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayz-log-oversized-'));
  const logPath = path.join(directory, 'oversized.ADM');
  const fd = fs.openSync(logPath, 'w');
  try {
    fs.writeSync(fd, 'historical-first-line\n');
    fs.writeSync(fd, Buffer.alloc((20 * 1024 * 1024) + 1024, 0x78));
    fs.writeSync(fd, '\nrecent-last-line\n');
  } finally {
    fs.closeSync(fd);
  }

  try {
    const fullHistory = [];
    for await (const entry of streamLogLines(logPath, { fullHistory: true })) {
      fullHistory.push(entry.line);
      break;
    }
    assert.deepStrictEqual(fullHistory, ['historical-first-line']);

    const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'logParser.js'), 'utf8');
    const fullRoute = source.slice(source.indexOf("router.post('/scan-all-logs'"), source.indexOf('// Helper: Fetch server info'));
    assert.match(fullRoute, /scanLogsForServer\([\s\S]*?req\.user\.id,[\s\S]*?serverId,[\s\S]*?token,[\s\S]*?fullHistory:\s*true[\s\S]*?\)/);
    assert.doesNotMatch(fullRoute, /catch \(err\) \{[\s\S]*?console\.error\(`Error reading/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function testRecoveryScriptsPassUserIdInUserSlot() {
  for (const filename of ['run-scan-save.js', 'run-scan-save-container.js']) {
    const source = fs.readFileSync(path.join(__dirname, filename), 'utf8');
    assert.match(source, /process\.env\.USER_ID/);
    assert.match(source, /scanLogsForServer\(db, userId, platformServerId/);
    assert.doesNotMatch(source, /scanLogsForServer\(db, serverId, platformServerId/);
  }
}

async function testTrackedPlayersAreScopedToAuthorizedServer() {
  const router = require('../routes/logParser');
  const handler = handlerFor(router, '/tracked-players', 'get');
  const calls = [];
  const db = {
    get: async (sql, params) => {
      calls.push({ sql, params });
      return { total: 1 };
    },
    query: async (sql, params) => {
      calls.push({ sql, params });
      return [];
    },
  };
  const req = {
    user: { id: 7, username: 'test-admin' },
    query: { serverId: '101', page: '1', limit: '100' },
    platformServerAccess: { serverId: 42, platformServerId: '101', discordGuildId: 'guild-a' },
    app: { locals: { db } },
  };
  const res = responseRecorder();

  await handler(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.ok(calls.every(call => call.sql.includes('player_server_activity')));
  assert.ok(calls.every(call => call.params.includes(42)));
  const routeMiddleware = router.stack.find(entry => entry.route?.path === '/tracked-players').route.stack;
  assert.ok(routeMiddleware.some(layer => layer.handle.name === 'ensurePlatformServerOwner'));
  assert.ok(!routeMiddleware.some(layer => layer.handle.name === 'ensureAdmin'),
    'exact-server operators must not require global dashboard admin access');
}

async function testAltDetectionIsScopedToAuthorizedServer() {
  const router = require('../routes/logParser');
  const handler = handlerFor(router, '/detect-alts', 'get');
  let captured;
  const req = {
    user: { id: 7 },
    query: { serverId: '101' },
    platformServerAccess: { serverId: 42, platformServerId: '101' },
    app: { locals: { db: {
      query: async (sql, params) => { captured = { sql, params }; return []; },
    } } },
  };
  const res = responseRecorder();

  await handler(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.match(captured.sql, /player_server_activity/);
  assert.match(captured.sql, /psa\.server_id = \?/);
  assert.deepStrictEqual(captured.params, [42]);
  const routeMiddleware = router.stack.find(entry => entry.route?.path === '/detect-alts').route.stack;
  assert.ok(routeMiddleware.some(layer => layer.handle.name === 'ensurePlatformServerOwner'));
  assert.ok(!routeMiddleware.some(layer => layer.handle.name === 'ensureAdmin'),
    'exact-server operators must not require global dashboard admin access');
  const frontend = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'logs.js'), 'utf8');
  assert.match(frontend, /\/api\/detect-alts\?serverId=/);
}

async function testOperableGuildDiscoveryIncludesAssignedAdmins() {
  const { listOperableGuilds } = require('../src/app/registerRoutes');
  let captured;
  const expected = [
    { id: 'guild-a', name: 'A', icon: null },
    { id: 'guild-b', name: 'B', icon: null },
  ];
  const db = {
    query: async (sql, params) => {
      captured = { sql, params };
      return expected;
    },
  };

  assert.deepStrictEqual(await listOperableGuilds(db, 7), expected);
  assert.match(captured.sql, /gr\.role IN \('owner', 'admin'\)/);
  assert.match(captured.sql, /server_role_assignments/);
  assert.match(captured.sql, /sra\.status = 'active'/);
  assert.match(captured.sql, /s\.status = 'active'/);
  assert.deepStrictEqual(captured.params, [7, 7]);
}

async function testScanRejectsWhenAnyLogCannotBeRead() {
  const { scanLogsForServer } = require('../routes/logParser');
  const guildId = `test-scan-${process.pid}`;
  const configPath = path.join(__dirname, '..', 'downloads', guildId, 'server_101', 'config');
  const logPath = path.join(configPath, 'DayZServer_X1_x64_2026-08-29_01-00-00.ADM');
  fs.mkdirSync(configPath, { recursive: true });
  fs.writeFileSync(logPath, 'unreadable');
  fs.chmodSync(logPath, 0o000);

  let exactContextQuery;
  const db = {
    get: async sql => {
      if (sql.includes("nextval('server_online_cache_scan_generation_seq')")) return { scan_generation: '1' };
      if (sql.includes('JOIN guild_roles')) return { discord_guild_id: guildId };
      if (sql.includes('SELECT s.id, s.guild_id, s.platform')) {
        exactContextQuery = sql;
        return { id: 1, guild_id: 10, platform: 'xbox', discord_guild_id: guildId };
      }
      if (sql.includes('SELECT g.discord_guild_id')) return { discord_guild_id: guildId };
      if (sql.includes('SELECT platform FROM servers')) return { platform: 'xbox' };
      if (sql.includes('SELECT id FROM servers')) return { id: 1 };
      return null;
    },
    run: async () => null,
  };

  try {
    await assert.rejects(
      scanLogsForServer(db, 7, '101', null),
      /failed to parse/i
    );
    assert.match(exactContextQuery, /NOT EXISTS[\s\S]*other\.platform_server_id[\s\S]*s\.platform_server_id/);
    assert.match(exactContextQuery, /other\.id <> s\.id/);
  } finally {
    fs.chmodSync(logPath, 0o600);
    fs.rmSync(path.join(__dirname, '..', 'downloads', guildId), { recursive: true, force: true });
  }
}

function testSingleFileScanChoosesNewestStrictChronology() {
  const { findLogFile } = require('../routes/logParser');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayz-single-log-order-'));
  const older = path.join(directory, 'DayZServer_X1_x64_2026-08-28_23-00-00.ADM');
  const newer = path.join(directory, 'DayZServer_X1_x64_2026-08-29_01-00-00.ADM');
  fs.writeFileSync(older, 'old');
  fs.writeFileSync(newer, 'new');
  fs.utimesSync(older, new Date('2026-08-29T03:00:00Z'), new Date('2026-08-29T03:00:00Z'));
  fs.utimesSync(newer, new Date('2026-08-29T02:00:00Z'), new Date('2026-08-29T02:00:00Z'));

  try {
    assert.strictEqual(findLogFile(directory, /\.ADM$/i), newer);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function testManualUploadAwaitsPersistenceBeforeSuccess() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'logParser.js'), 'utf8');
  const route = source.slice(source.indexOf("router.post('/parse-logs'"), source.indexOf('// Scan local downloaded logs'));
  assert.match(route, /router\.post\('\/parse-logs',[\s\S]*?async \(req, res\)/);
  assert.match(route, /await savePlayersToDatabase\(/);
  assert.doesNotMatch(route, /savePlayersToDatabase\([^;]+,\s*\(err\) =>/);
}

async function testManualUploadUsesAuthorizedServerPlatform() {
  const router = require('../routes/logParser');
  const handler = handlerFor(router, '/parse-logs', 'post');
  const identityLookups = [];
  const serverLookups = [];
  const db = {
    get: async (sql, params) => {
      if (sql.includes('SELECT id FROM servers')) {
        serverLookups.push({ sql, params });
        return { id: 42 };
      }
      if (sql.includes('FROM player_identities WHERE platform')) {
        identityLookups.push(params);
        return { id: 7, player_id: 8 };
      }
      if (sql.includes('FROM player_gamertags')) return { id: 9 };
      if (sql.includes('FROM player_server_activity')) return { id: 10 };
      return null;
    },
    run: async () => ({ changes: 1 }),
  };
  const req = {
    user: { id: 7 },
    body: {
      serverId: '101',
      platform: 'playstation',
      admLog: '00:01:00 | Player "Survivor" (id=A1) is connected',
    },
    platformServerAccess: {
      serverId: 42,
      platformServerId: '101',
      platform: 'xbox',
      discordGuildId: 'guild-a',
    },
    app: { locals: { db } },
  };
  const res = responseRecorder();

  await handler(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(serverLookups.length, 1);
  assert.match(serverLookups[0].sql, /WHERE id = \?/);
  assert.deepStrictEqual(serverLookups[0].params, [42],
    'manual uploads must bind persistence to the authorized internal server ID');
  assert.deepStrictEqual(identityLookups, [['xbox', 'A1']],
    'manual uploads must ignore a client-supplied platform and use the authorized server platform');
}

function testPlayerActivityIsDerivedIdempotentlyFromSessions() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'logParser.js'), 'utf8');
  const saveStart = source.indexOf('async function savePlayersToDatabase');
  const saveEnd = source.indexOf('/**\n * Parse player health updates', saveStart);
  const savePlayers = source.slice(saveStart, saveEnd);
  assert.doesNotMatch(savePlayers, /total_sessions\s*=\s*total_sessions\s*\+\s*1/,
    'identity discovery must not increment session aggregates');
  assert.match(savePlayers, /VALUES \(\?, \?, NULL, NULL, 0\)[\s\S]*?ON CONFLICT\s*\(identity_id, server_id\)\s*DO NOTHING/,
    'identity discovery should only ensure a zeroed activity association');

  const refreshStart = source.indexOf('async function refreshPlayerServerActivity');
  const refreshEnd = source.indexOf('\nasync function ', refreshStart + 1);
  assert.notStrictEqual(refreshStart, -1, 'missing activity aggregate refresh');
  const refresh = source.slice(refreshStart, refreshEnd);
  assert.match(refresh, /COUNT\(\*\)/);
  assert.match(refresh, /first_seen\s*=\s*\(\s*SELECT MIN\(login_at\)/,
    'first_seen must be reset to the earliest persisted session, including NULL when none exist');
  assert.doesNotMatch(refresh, /COALESCE\(\(\s*SELECT MIN\(login_at\)/,
    'legacy scan-time first_seen values must not survive when no persisted session exists');
  assert.match(refresh, /MAX\(COALESCE\(logout_at, login_at\)\)/);
  assert.doesNotMatch(refresh, /CURRENT_TIMESTAMP/,
    'activity timestamps must come from parsed sessions, not scan time');

  const sessionsStart = source.indexOf('async function saveSessions');
  const sessionsEnd = source.indexOf('// Save players to database', sessionsStart);
  const saveSessions = source.slice(sessionsStart, sessionsEnd);
  assert.match(saveSessions, /db\.transaction\([\s\S]*?await refreshPlayerServerActivityForIdentity\(db, dbServerId, identityId\)[\s\S]*?return inserted/,
    'each persisted session and its derived activity aggregate must commit atomically');

  const scanner = source.slice(source.indexOf('async function scanLogsForServer'));
  assert.match(scanner, /await refreshPlayerServerActivity\(db, serverId, serverContext\.id\)/,
    'every successful scan must repair activity aggregates from persisted sessions');
}

function testScannerPersistenceUsesExactInternalServerId() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'logParser.js'), 'utf8');
  const scanner = source.slice(source.indexOf('async function scanLogsForServer'));
  const exactCalls = [
    /saveSessions\(db, serverId,[^;]+serverContext\.id\)/,
    /saveDamageEvents\(db, serverId,[^;]+serverContext\.id\)/,
    /saveKillEvents\(db, serverId,[^;]+guildId, serverContext\.id\)/,
    /saveTerritoryEvents\(db, serverId,[^;]+serverContext\.id\)/,
    /saveDeathEvents\(db, serverId,[^;]+serverContext\.id\)/,
    /saveUnconsciousEvents\(db, serverId,[^;]+serverContext\.id\)/,
    /saveRespawnEvents\(db, serverId,[^;]+serverContext\.id\)/,
    /savePositionSnapshots\(db, serverId,[^;]+serverContext\.id\)/,
    /saveEmoteEvents\(db, serverId,[^;]+serverContext\.id\)/,
    /saveCleanupEvents\(db, serverId,[^;]+serverContext\.id\)/,
    /refreshPlayerServerActivity\(db, serverId, serverContext\.id\)/,
    /saveHealthUpdates\(db, serverId,[^;]+serverContext\.id\)/,
    /updateOnlineCache\([\s\S]*?db,[\s\S]*?serverId,[\s\S]*?serverContext\.id,[\s\S]*?latestSourceObservedAt[\s\S]*?\)/,
  ];
  for (const callPattern of exactCalls) {
    assert.match(scanner, callPattern,
      'every scanner persistence call must carry the resolved internal server ID');
  }

  const resolverStart = source.indexOf('async function getExactServerForPersistence');
  const resolverEnd = source.indexOf('\nasync function ', resolverStart + 1);
  const resolver = source.slice(resolverStart, resolverEnd);
  assert.match(resolver, /WHERE id = \?/);
  assert.doesNotMatch(resolver, /WHERE platform_server_id = \?/);

  for (const functionName of [
    'updateOnlineCache', 'saveSessions', 'refreshPlayerServerActivity', 'saveHealthUpdates',
    'saveDamageEvents', 'saveKillEvents', 'saveTerritoryEvents', 'saveDeathEvents',
    'saveUnconsciousEvents', 'saveCleanupEvents', 'saveRespawnEvents',
    'savePositionSnapshots', 'saveEmoteEvents',
  ]) {
    const start = source.indexOf(`async function ${functionName}(db, platformServerId`);
    const next = source.indexOf('\nasync function ', start + 1);
    const body = source.slice(start, next === -1 ? source.length : next);
    assert.doesNotMatch(body, /WHERE platform_server_id = \?/,
      `${functionName} must not re-resolve a duplicate-capable provider ID`);
    assert.match(body, /getExactServerForPersistence\(\s*(?:db|transactionDb),\s*platformServerId,\s*internalServerId\s*\)/,
      `${functionName} must resolve only the trusted internal server ID`);
  }
}

async function testPersistenceHelperQueriesExactInternalServerId() {
  const parser = require('../routes/logParser');
  const lookups = [];
  const writes = [];
  const db = {
    get: async (sql, params) => {
      lookups.push({ sql, params });
      if (sql.includes('WHERE id = ?') && params[0] === 42) return { id: 42 };
      if (sql.includes('platform_server_id')) return { id: 99 };
      return null;
    },
    run: async (sql, params) => {
      writes.push({ sql, params });
      return { changes: 1 };
    },
  };

  await parser.saveCleanupEvents(db, '101', [{
    itemClass: 'Item', posX: 1, posZ: 2, logDate: '2026-08-29',
  }], 42);

  assert.strictEqual(lookups.length, 1);
  assert.match(lookups[0].sql, /WHERE id = \?/);
  assert.deepStrictEqual(lookups[0].params, [42]);
  assert.strictEqual(writes[0].params[0], 42,
    'persistence must ignore a concurrently introduced duplicate provider row');
}

async function testPersistenceFailuresRejectInsteadOfCheckpointing() {
  const parser = require('../routes/logParser');
  const databaseFailure = new Error('database unavailable');
  const db = {
    get: async () => ({ id: 42 }),
    all: async (_sql, params) => [{ platform_user_id: params[1], id: 7 }],
    run: async () => { throw databaseFailure; },
  };
  const damage = {
    victimPlatformUserId: 'A1', victimGamertag: 'Player', victimPosition: '1,2,3',
    victimPosX: 1, victimPosY: 2, victimPosZ: 3, attackerType: 'infected',
    timestamp: '2026-08-29T01:00:00.000Z',
  };
  const territory = {
    platformUserId: 'A1', playerGamertag: 'Player', eventType: 'built',
    structureType: 'Fence', position: '1,2,3', posX: 1, posY: 2, posZ: 3,
    timestamp: '2026-08-29T01:00:00.000Z',
  };

  await assert.rejects(parser.saveDamageEvents(db, '101', [damage], 'xbox', 42), /database unavailable/);
  await assert.rejects(parser.saveTerritoryEvents(db, '101', [territory], 'xbox', 42), /database unavailable/);
  const killDb = {
    ...db,
    all: async () => [
      { platform_user_id: 'A1', id: 7 },
      { platform_user_id: 'B2', id: 8 },
    ],
    transaction: async callback => callback(),
  };
  await assert.rejects(parser.saveKillEvents(killDb, '101', [{
    victimPlatformUserId: 'A1', killerPlatformUserId: 'B2',
    victimGamertag: 'Victim', killerGamertag: 'Killer',
    timestamp: '2026-08-29T01:00:00.000Z',
  }], 'xbox', 'guild-a', 42), /database unavailable/);

  await assert.rejects(
    () => parser.saveCleanupEvents({ get: async () => null }, '101', [{
      itemClass: 'Item', posX: 1, posZ: 2, logDate: '2026-08-29',
    }], 42),
    /Exact server 42 not found in database/
  );

  const economyHelper = require('../utils/economyHelper');
  const originalGetEconomyConfig = economyHelper.getEconomyConfigForIdentity;
  const originalAwardMoneyInTransaction = economyHelper.awardMoneyInTransaction;
  let transactionCalls = 0;
  economyHelper.getEconomyConfigForIdentity = async () => ({
    enabled: true,
    playtime_rewards_enabled: true,
    playtime_reward_per_hour: 10,
    currency_symbol: '$',
  });
  economyHelper.awardMoneyInTransaction = async () => { throw databaseFailure; };
  const sessionDb = {
    get: async sql => sql.includes('INSERT INTO player_sessions') ? { id: 1, inserted: true } : { id: 42 },
    all: async () => [{ platform_user_id: 'A1', id: 7 }],
    transaction: async callback => { transactionCalls++; return callback(); },
  };
  try {
    await assert.rejects(parser.saveSessions(sessionDb, '101', [{
      platformUserId: 'A1', playerGamertag: 'Player',
      loginAt: '2026-08-29T01:00:00.000Z', logoutAt: '2026-08-29T02:00:00.000Z',
    }], 'xbox', 42), /database unavailable/);
    assert.strictEqual(transactionCalls, 1);
  } finally {
    economyHelper.getEconomyConfigForIdentity = originalGetEconomyConfig;
    economyHelper.awardMoneyInTransaction = originalAwardMoneyInTransaction;
  }

  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'logParser.js'), 'utf8');
  for (const functionName of [
    'saveSessions', 'savePlayersToDatabase', 'saveHealthUpdates', 'saveDamageEvents',
    'saveKillEvents', 'saveTerritoryEvents', 'saveDeathEvents', 'saveUnconsciousEvents',
    'saveCleanupEvents', 'saveRespawnEvents', 'savePositionSnapshots', 'saveEmoteEvents',
    'updateOnlineCache',
  ]) {
    const start = source.indexOf(`async function ${functionName}`);
    assert.notStrictEqual(start, -1, `missing persistence helper ${functionName}`);
    const nextFunction = source.indexOf('\nasync function ', start + 1);
    const body = source.slice(start, nextFunction === -1 ? source.length : nextFunction);
    assert.doesNotMatch(
      body,
      /catch \(err\) \{\s*(?:if \([^}]+\) continue;\s*)?console\.error\([^}]+\);\s*\}/,
      `${functionName} must not swallow persistence failures`
    );
  }
}

function testNestedParserSideEffectsAreAtomicAndFailuresPropagate() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'logParser.js'), 'utf8');
  const sessionStart = source.indexOf('async function saveSessions');
  const sessions = source.slice(sessionStart, source.indexOf('// Save players to database', sessionStart));
  const killStart = source.indexOf('async function saveKillEvents');
  const kills = source.slice(killStart, source.indexOf('/**\n * Parse territory', killStart));

  assert.match(sessions, /db\.transaction\(/);
  assert.match(sessions, /awardMoneyInTransaction\(/);
  assert.doesNotMatch(sessions, /economyHelper\.awardMoney\(/);
  assert.match(kills, /\[KILL FEED\][\s\S]*?catch \(error\) \{[\s\S]*?throw error;/);
  assert.match(kills, /\[FACTION FEED\][\s\S]*?catch \(error\) \{[\s\S]*?throw error;/);
}

function testTrackedPlayerResponseUsesFrontendFieldNames() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'logParser.js'), 'utf8');
  const route = source.slice(source.indexOf("router.get('/tracked-players'"), source.indexOf("router.get('/detect-alts'"));
  assert.match(route, /pi\.platform_user_id\s+as\s+"platformUserId"/i);
  assert.match(route, /pi\.device_id\s+as\s+"deviceId"/i);
}

function testLocalScanUsesSharedCompleteScanner() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'logParser.js'), 'utf8');
  const localRoute = source.slice(
    source.indexOf("router.post('/scan-local-logs'"),
    source.indexOf('// Scan ALL local downloaded logs')
  );
  assert.match(localRoute, /await scanLogsForServer\([\s\S]*?req\.user\.id,[\s\S]*?serverId,[\s\S]*?token/,
    'local scanning must use the same complete parser/persistence pipeline as automation');
  assert.doesNotMatch(localRoute, /parsePlayerSessions|parseCombatEvents|parseCleanupEvents/,
    'local scanning must not maintain a feature-incomplete parser path');
}

async function testHistoricalRestartCannotConsumeNewerRentalOrOwnerMarker() {
  const shopFileService = require('../services/shopFileService');
  const restartService = require('../services/shopRestartService');
  const originalAcquireLock = shopFileService.acquireShopServerLock;
  shopFileService.acquireShopServerLock = async () => {};
  const calls = [];
  const db = {
    transaction: async callback => callback(db),
    get: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('SELECT id FROM server_restart_log WHERE bios_session_id')) return null;
      if (sql.includes("restart_type = 'owner_triggered'")) return null;
      if (sql.includes('INSERT INTO server_restart_log')) return { id: 1 };
      return null;
    },
    run: async (sql, params) => { calls.push({ sql, params }); return { changes: 0 }; },
    all: async (sql, params) => { calls.push({ sql, params }); return []; },
  };

  try {
    await restartService.processRestartEvents(db, 42, [{
      biosSessionId: '00000000-0000-0000-0000-000000000001',
      detectedAt: '2026-08-01 01:00:00',
      isScheduled: true,
    }]);
    const decrement = calls.find(call => call.sql.includes('FOR UPDATE OF soi'));
    assert.ok(decrement, 'a scheduled restart should evaluate eligible rentals');
    assert.match(decrement.sql, /checked_out_at\s*<=\s*\?/,
      'restart decrement must exclude rentals checked out after the historical event');
    assert.ok(decrement.params.includes('2026-08-01T01:00:00.000Z'));
    const markerClaim = calls.find(call => call.sql.includes("restart_type = 'owner_triggered'"));
    assert.match(markerClaim.sql, /detected_at\s+BETWEEN\s+\?::timestamptz\s+-\s+INTERVAL '10 minutes'[\s\S]*AND\s+\?::timestamptz(?!\s+\+)/,
      'an owner marker must precede the observed restart and remain within its claim window');
    assert.match(markerClaim.sql, /ORDER BY detected_at DESC, id DESC/,
      'the newest eligible owner marker must be claimed first');
    const restartSource = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'shopRestartService.js'),
      'utf8'
    );
    assert.match(restartSource, /SET bios_session_id = \?,[\s\S]*detected_at = COALESCE\(\?::timestamptz, detected_at\)/,
      'claiming an owner marker must replace its dispatch timestamp with observed restart time');
  } finally {
    shopFileService.acquireShopServerLock = originalAcquireLock;
  }
}

function testFailedRunsRespectConfiguredRetryInterval() {
  const now = Date.parse('2026-09-02T22:30:00Z');
  assert.strictEqual(typeof scheduledLogSyncDue, 'function');
  assert.strictEqual(scheduledLogSyncDue({
    interval: 3,
    lastRun: null,
    lastAttempt: '2026-09-02T22:29:00Z',
  }, now), false, 'a failed run must not retry on every 30-second scheduler tick');
  assert.strictEqual(scheduledLogSyncDue({
    interval: 3,
    lastRun: null,
    lastAttempt: '2026-09-02T22:26:59Z',
  }, now), true, 'a failed run must remain retryable after the configured interval');

  const scheduler = fs.readFileSync(path.join(__dirname, '..', 'scheduler.js'), 'utf8');
  assert.match(scheduler, /settings\.lastAttempt\s*=\s*now\.toISOString\(\)/);
  assert.match(scheduler, /UPDATE automation_settings SET auto_log_sync = \?/,
    'the failed-run backoff timestamp must be persisted before provider work');
}

function testRestartEvidenceSelectsNewestLogsAndProviderStart() {
  const { buildRestartEvidence } = require('../services/logSyncService');
  assert.strictEqual(typeof buildRestartEvidence, 'function');
  const configPath = path.join('/tmp', 'server_101', 'config');
  const evidence = buildRestartEvidence(configPath, {
    status: 'started',
    last_status_change: 1788302121,
  }, path.join(configPath, 'server.log'), [
    { name: 'DayZServerP_X1_x64_2026-09-01_11-55-34.RPT', modified_at: 1788290000 },
    { name: 'DayZServerP_X1_x64_2026-09-01_15-15-27.RPT', modified_at: 1788302121 },
    { name: 'unrelated_2026-09-01_16-00-00.RPT', modified_at: 1788303000 },
    { name: 'DayZServerP_X1_x64_2026-09-01_11-55-34.ADM', modified_at: 1788302222 },
    { name: 'DayZServerP_X1_x64_2026-09-01_15-15-27.ADM', modified_at: 1788291000 },
  ]);
  assert.deepStrictEqual(evidence, {
    serverLogPath: path.join(configPath, 'server.log'),
    latestRptPath: path.join(configPath, 'DayZServerP_X1_x64_2026-09-01_15-15-27.RPT'),
    latestRptModifiedAt: 1788302121,
    previousRptPath: path.join(configPath, 'DayZServerP_X1_x64_2026-09-01_11-55-34.RPT'),
    previousRptModifiedAt: 1788290000,
    latestAdmPath: path.join(configPath, 'DayZServerP_X1_x64_2026-09-01_11-55-34.ADM'),
    latestAdmModifiedAt: 1788302222,
    gameserverStatus: 'started',
    lastStatusChange: 1788302121,
  });
}

function testProviderModifiedAtNormalizesOnlineCacheObservation() {
  const { normalizeSourceObservedAt } = require('../routes/logParser');
  assert.strictEqual(typeof normalizeSourceObservedAt, 'function');
  assert.strictEqual(
    normalizeSourceObservedAt('2026-09-02T17:41:05Z', 1788385265),
    '2026-09-02T21:41:05.000Z',
    'provider file metadata must normalize configured DayZ log clock offsets'
  );
  assert.strictEqual(
    normalizeSourceObservedAt('2026-09-02T17:41:05Z', 'invalid'),
    '2026-09-02T17:41:05.000Z',
    'invalid provider metadata must not replace the parsed source observation'
  );
  assert.strictEqual(
    normalizeSourceObservedAt('2026-09-02T17:41:05Z', '2026-09-31T00:00:00Z'),
    '2026-09-02T17:41:05.000Z',
    'impossible provider calendar dates must fail closed to parsed source evidence'
  );
  assert.strictEqual(
    normalizeSourceObservedAt('invalid', '2026-02-30T00:00:00Z'),
    null,
    'impossible provider dates without valid parsed evidence must remain unavailable'
  );
  assert.strictEqual(
    normalizeSourceObservedAt('2026-09-02T17:41:05Z', Number.MAX_VALUE),
    '2026-09-02T17:41:05.000Z',
    'out-of-range numeric provider timestamps must fail closed to parsed source evidence'
  );
}

function testProviderClockNormalizesLatestAdmPositions() {
  const { normalizeLatestAdmPositionTimestamps } = require('../routes/logParser');
  const snapshots = [
    { platformUserId: 'CURRENT', timestamp: '2026-09-05T16:52:50.000Z' },
    { platformUserId: 'OLDER', timestamp: '2026-09-05T15:52:50.000Z' },
  ];
  const normalized = normalizeLatestAdmPositionTimestamps(
    snapshots,
    '2026-09-05T16:52:50.000Z',
    1788641616
  );
  assert.deepStrictEqual(normalized.map(snapshot => snapshot.timestamp), [
    '2026-09-05T20:52:50.000Z',
    '2026-09-05T19:52:50.000Z',
  ], 'provider UTC evidence must correct the latest ADM file clock while preserving relative age');
  assert.deepStrictEqual(snapshots.map(snapshot => snapshot.timestamp), [
    '2026-09-05T16:52:50.000Z',
    '2026-09-05T15:52:50.000Z',
  ], 'clock normalization must not mutate parser output shared with other event consumers');
  assert.deepStrictEqual(
    normalizeLatestAdmPositionTimestamps(
      snapshots,
      '2026-09-05T16:10:00.000Z',
      '2026-09-05T20:53:36.000Z'
    ),
    snapshots,
    'non-timezone-sized clock differences must fail closed instead of making stale positions fresh'
  );
  assert.deepStrictEqual(
    normalizeLatestAdmPositionTimestamps(
      snapshots,
      '2026-09-05T16:05:00.000Z',
      '2026-09-05T20:00:00.000Z'
    ),
    snapshots,
    'normalization must reject corrected timestamps after the provider observation'
  );
  assert.deepStrictEqual(
    normalizeLatestAdmPositionTimestamps(
      snapshots,
      '2026-09-05T21:52:50.000Z',
      '2026-09-05T20:53:36.000Z'
    ),
    snapshots,
    'negative shifts must fail closed because older raw rows cannot be safely reconciled'
  );
}

function testScheduledScannerReceivesProviderSourceObservation() {
  const scheduler = fs.readFileSync(path.join(__dirname, '..', 'scheduler.js'), 'utf8');
  assert.match(
    scheduler,
    /scanLogsForServer\(db, row\.id, serverId, token,\s*\{[\s\S]{0,400}sourceObservedAt:\s*evidence\?\.latestAdmModifiedAt[\s\S]{0,200}sourceObservedLogFile:\s*evidence\?\.latestAdmPath/,
    'scheduled scanning must receive the provider UTC observation and exact ADM source file'
  );
}

function testRestartEvidenceAcceptsEverySupportedPlatformRptName() {
  const { isSupportedRptFilename } = require('../services/logRestartProcessingService');
  assert.strictEqual(typeof isSupportedRptFilename, 'function');
  for (const name of [
    'DayZServer_X1_x64_2026-09-02_14-24-21.RPT',
    'DayZServerP_X1_x64_2026-09-02_14-24-21.RPT',
    'DayZServer_PS4_x64_2026-09-02_12-48-56.RPT',
    'DayZServer_NSW2_x64_2026-09-02_20-21-26.RPT',
    'DayZServer_x64_2026-09-02_17-20-07.RPT',
  ]) {
    assert.strictEqual(isSupportedRptFilename(name), true, `${name} must be accepted`);
  }
  assert.strictEqual(isSupportedRptFilename('../DayZServer_x64_2026-09-02_17-20-07.RPT'), false);
  assert.strictEqual(isSupportedRptFilename('not-a-dayz-log.RPT'), false);
  assert.strictEqual(isSupportedRptFilename('DayZServer_PS4_x64_2026-02-30_12-00-00.RPT'), false);
  assert.strictEqual(isSupportedRptFilename('DayZServer_x64_2026-09-02_24-00-00.RPT'), false);
}

function testRestartEvidenceRejectsImpossibleTimestamps() {
  const {
    normalizeProviderTimestampMs,
    serverLogTimestampMatchesProviderStart,
  } = require('../services/logRestartProcessingService');
  assert.strictEqual(typeof normalizeProviderTimestampMs, 'function');
  assert.strictEqual(typeof serverLogTimestampMatchesProviderStart, 'function');
  assert.strictEqual(normalizeProviderTimestampMs('2026-02-30T00:00:00Z'), null);
  assert.strictEqual(normalizeProviderTimestampMs(Number.MAX_VALUE), null);
  assert.strictEqual(
    serverLogTimestampMatchesProviderStart('2026-02-30 00:00:00', Date.parse('2026-03-02T00:00:00Z')),
    false,
    'impossible server.log timestamps must not correlate to provider restart evidence'
  );
}

async function testProviderStartFallbackProcessesEmptyServerLog() {
  const restartProcessingSource = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'logRestartProcessingService.js'), 'utf8'
  );
  assert.match(restartProcessingSource, /bios_session_id = \?[\s\S]*providerRestartId/,
    'only the durable provider restart identity may suppress provider fallback');
  assert.match(restartProcessingSource, /evidenceSourceFile/,
    'server.log and provider evidence must persist one exact RPT-bound restart identity');
  const { processDownloadedRestartEvidence } = require('../services/logRestartProcessingService');
  assert.strictEqual(typeof processDownloadedRestartEvidence, 'function');
  const shopFileService = require('../services/shopFileService');
  const originalAcquireLock = shopFileService.acquireShopServerLock;
  shopFileService.acquireShopServerLock = async () => {};
  const downloadRoot = path.join(__dirname, '..', 'downloads');
  const guildId = `restart-fallback-test-${process.pid}-${Date.now()}`;
  const directory = path.join(downloadRoot, guildId, 'server_101', 'config');
  fs.mkdirSync(directory, { recursive: true });
  const latestRptPath = path.join(directory, 'DayZServer_X1_x64_2026-09-01_18-35-17.RPT');
  const previousRptPath = path.join(directory, 'DayZServer_X1_x64_2026-09-01_15-15-27.RPT');
  fs.writeFileSync(latestRptPath, 'x'.repeat(1024 * 1024) + '\n18:36:00 Current session\n');
  fs.writeFileSync(previousRptPath,
    'x'.repeat(1024 * 1024) + '\n' +
    '18:28:00 [Shutdown] Shutting down in 60 seconds (1 minutes).\n' +
    '18:29:00 [Shutdown] Saving players, locking server and kicking all players.\n');
  const calls = [];
  const db = {
    transaction: async callback => callback(db),
    get: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM servers s/.test(sql)) return { id: 42, discord_guild_id: guildId };
      if (/SELECT id FROM server_restart_log WHERE bios_session_id/.test(sql)) return null;
      if (/restart_type = 'owner_triggered'/.test(sql)) return null;
      if (/INSERT INTO server_restart_log/.test(sql)) return { id: 1 };
      return null;
    },
    run: async (sql, params) => { calls.push({ sql, params }); return { changes: 0 }; },
    all: async (sql, params) => { calls.push({ sql, params }); return []; },
  };

  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function boundedEvidenceGuard(target, ...args) {
    if (Number.isInteger(target)) throw new Error('RPT evidence used an unbounded whole-file read');
    return originalReadFileSync.call(this, target, ...args);
  };
  try {
    const staleEvidenceCallCount = calls.length;
    assert.strictEqual(await processDownloadedRestartEvidence(db, {
      serverId: 42,
      platformServerId: '101',
    }, {
      serverLogPath: null,
      latestRptPath,
      latestRptModifiedAt: 1788307049,
      previousRptPath,
      previousRptModifiedAt: 1785700000,
      gameserverStatus: 'started',
      lastStatusChange: 1788302121,
    }), 0, 'an unrelated old previous RPT must not classify the current restart as scheduled');
    assert.strictEqual(calls.length, staleEvidenceCallCount,
      'uncorrelated previous RPT evidence must not touch restart or rental state');

    assert.strictEqual(await processDownloadedRestartEvidence(db, {
      serverId: 42,
      platformServerId: '101',
    }, {
      serverLogPath: null,
      latestRptPath,
      latestRptModifiedAt: 1788307049,
      previousRptPath,
      previousRptModifiedAt: 1788302121,
      gameserverStatus: 'started',
      lastStatusChange: 1788302121,
    }), 1);
    const serverLookup = calls.find(call => /FROM servers s/.test(call.sql));
    assert.deepStrictEqual(serverLookup.params, [42, '101']);
    assert.match(serverLookup.sql, /s\.id = \?/,
      'restart evidence must retain the already-authorized internal server id');
    assert.doesNotMatch(serverLookup.sql, /LIMIT 1/,
      'restart evidence must not resolve an ambiguous provider id arbitrarily');
    const decrement = calls.find(call => call.sql.includes('FOR UPDATE OF soi'));
    assert.ok(decrement, 'scheduled provider start did not evaluate eligible rentals');
    assert.ok(decrement.params.includes('2026-09-01T22:35:21.000Z'));
    const insert = calls.find(call => call.sql.includes('INSERT INTO server_restart_log'));
    assert.match(insert.params[2], /^provider-start:101:1788302121000$/);

    const staleServerLogPath = path.join(directory, 'server.log');
    fs.writeFileSync(staleServerLogPath,
      '2026-08-01 01:00:00 Connected to BIOS (server registration) with id 11111111-1111-1111-1111-111111111111\n');
    const staleLogCallStart = calls.length;
    fs.readFileSync = originalReadFileSync;
    const staleLogResult = await processDownloadedRestartEvidence(db, {
      serverId: 42,
      platformServerId: '101',
    }, {
      serverLogPath: staleServerLogPath,
      latestRptPath,
      latestRptModifiedAt: 1788307049,
      previousRptPath,
      previousRptModifiedAt: 1788302121,
      gameserverStatus: 'started',
      lastStatusChange: 1788302121,
    });
    fs.readFileSync = function boundedEvidenceGuard(target, ...args) {
      if (Number.isInteger(target)) throw new Error('RPT evidence used an unbounded whole-file read');
      return originalReadFileSync.call(this, target, ...args);
    };
    assert.strictEqual(staleLogResult, 1);
    const staleLogInserts = calls.slice(staleLogCallStart)
      .filter(call => call.sql.includes('INSERT INTO server_restart_log'));
    assert.ok(staleLogInserts.some(call => /^provider-start:101:1788302121000$/.test(call.params[2])),
      'historical server.log sessions must not suppress the current provider-start fallback');

    const callCount = calls.length;
    assert.strictEqual(await processDownloadedRestartEvidence(db, {
      serverId: 42,
      platformServerId: '101',
    }, {
      serverLogPath: null,
      latestRptPath,
      latestRptModifiedAt: 1788307049,
      previousRptPath,
      previousRptModifiedAt: 1788302121,
      gameserverStatus: 'started',
      lastStatusChange: 1788310000,
    }), 0, 'stale RPT shutdown evidence must not classify a later provider start');
    assert.strictEqual(calls.length, callCount,
      'stale RPT shutdown evidence must not touch restart or rental state');
  } finally {
    fs.readFileSync = originalReadFileSync;
    shopFileService.acquireShopServerLock = originalAcquireLock;
    fs.rmSync(path.join(downloadRoot, guildId), { recursive: true, force: true });
  }
}

async function testProviderAndServerLogShareDurableRestartIdentity() {
  const { processDownloadedRestartEvidence } = require('../services/logRestartProcessingService');
  const shopFileService = require('../services/shopFileService');
  const originalAcquireLock = shopFileService.acquireShopServerLock;
  shopFileService.acquireShopServerLock = async () => {};
  const downloadRoot = path.join(__dirname, '..', 'downloads');
  const guildId = `restart-identity-test-${process.pid}-${Date.now()}`;
  const directory = path.join(downloadRoot, guildId, 'server_101', 'config');
  fs.mkdirSync(directory, { recursive: true });
  const serverLogPath = path.join(directory, 'server.log');
  const latestRptPath = path.join(directory, 'DayZServer_X1_x64_2026-09-01_18-35-17.RPT');
  const previousRptPath = path.join(directory, 'DayZServer_X1_x64_2026-09-01_15-15-27.RPT');
  fs.writeFileSync(latestRptPath, 'current session');
  fs.writeFileSync(previousRptPath,
    '18:29:00 [Shutdown] Saving players, locking server and kicking all players.\n');

  const makeDb = () => {
    const rows = new Map();
    const providerStarts = new Set();
    let decrements = 0;
    let nextId = 1;
    const db = {
      transaction: async callback => callback(db),
      get: async (sql, params) => {
        if (/FROM servers s/.test(sql)) return { id: 42, discord_guild_id: guildId };
        if (/restart_type = 'owner_triggered'/.test(sql)) return null;
        if (/SELECT id FROM server_restart_log WHERE bios_session_id/.test(sql)) {
          return rows.get(params[0]) || null;
        }
        if (/WHERE server_id = \? AND bios_session_id = \?/.test(sql)) {
          return rows.get(params[1]) || null;
        }
        if (/INSERT INTO server_restart_log/.test(sql)) {
          const biosSessionId = params[2];
          const providerStartedAt = params[4];
          if (rows.has(biosSessionId) || (providerStartedAt && providerStarts.has(providerStartedAt))) return null;
          const row = { id: nextId++, biosSessionId, providerStartedAt };
          rows.set(biosSessionId, row);
          if (providerStartedAt) providerStarts.add(providerStartedAt);
          return row;
        }
        return null;
      },
      run: async () => ({ changes: 0 }),
      all: async sql => {
        if (sql.includes('FOR UPDATE OF soi')) decrements++;
        return [];
      },
    };
    return { db, rows, get decrements() { return decrements; } };
  };

  const evidence = {
    serverLogPath,
    latestRptPath,
    latestRptModifiedAt: 1788307049,
    previousRptPath,
    previousRptModifiedAt: 1788302121,
    gameserverStatus: 'started',
    lastStatusChange: 1788302121,
  };
  try {
    fs.writeFileSync(serverLogPath,
      '2026-09-01 18:34:00 [Shutdown] Shutting down in 60 seconds (1 minutes).\n' +
      '2026-09-01 18:35:21 Connected to BIOS (server registration) with id 22222222-2222-2222-2222-222222222222\n');
    const dated = makeDb();
    await processDownloadedRestartEvidence(dated.db, { serverId: 42, platformServerId: '101' }, evidence);
    assert.strictEqual(dated.decrements, 1,
      'server.log and provider evidence for one transition must consume a rental once');
    assert.ok(dated.rows.has('provider-start:101:1788302121000'),
      'the correlated server.log event must use the durable provider restart identity');
    assert.ok(!dated.rows.has('22222222-2222-2222-2222-222222222222'));

    fs.writeFileSync(serverLogPath,
      '18:34:00 [Shutdown] Shutting down in 60 seconds (1 minutes).\n' +
      '18:35:21 Connected to BIOS (server registration) with id 33333333-3333-3333-3333-333333333333\n');
    const timeOnly = makeDb();
    await processDownloadedRestartEvidence(timeOnly.db, { serverId: 42, platformServerId: '101' }, evidence);
    assert.strictEqual(timeOnly.decrements, 1,
      'a time-only historical BIOS row must not suppress or duplicate provider restart consumption');
    assert.ok(timeOnly.rows.has('provider-start:101:1788302121000'));
  } finally {
    shopFileService.acquireShopServerLock = originalAcquireLock;
    fs.rmSync(path.join(downloadRoot, guildId), { recursive: true, force: true });
  }
}

async function testDownloadedServerLogProcessingUsesContainedExactServerBinding() {
  const { processDownloadedServerLog } = require('../services/logRestartProcessingService');
  const downloadRoot = path.join(__dirname, '..', 'downloads');
  const guildId = `restart-processing-test-${process.pid}-${Date.now()}`;
  const directory = path.join(downloadRoot, guildId, 'server_101', 'config');
  fs.mkdirSync(directory, { recursive: true });
  const serverLogPath = path.join(directory, 'server.log');
  fs.writeFileSync(serverLogPath, 'no restart events\n');
  let lookup;
  const db = {
    get: async (sql, params) => {
      lookup = { sql, params };
      return { id: 42, discord_guild_id: guildId };
    },
  };

  try {
    assert.strictEqual(await processDownloadedServerLog(db, {
      serverId: 42,
      platformServerId: '101',
    }, serverLogPath), 0);
    assert.match(lookup.sql, /s\.id = \?/);
    assert.match(lookup.sql, /s\.platform_server_id = \?/);
    assert.match(lookup.sql, /s\.status = 'active'/);
    assert.match(lookup.sql, /g\.status = 'approved'/);
    assert.deepStrictEqual(lookup.params, [42, '101']);

    await assert.rejects(
      processDownloadedServerLog({ get: async () => null }, {
        serverId: 42,
        platformServerId: '101',
      }, serverLogPath),
      /Active server 42\/101 not found/
    );
  } finally {
    fs.rmSync(path.join(downloadRoot, guildId), { recursive: true, force: true });
  }
}

function testManualAndScheduledRunsProcessDownloadedRestartEvidence() {
  const schedulerSource = fs.readFileSync(path.join(__dirname, '..', 'scheduler.js'), 'utf8');
  const automationSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'automation.js'), 'utf8');
  for (const [name, source] of [['scheduler', schedulerSource], ['manual automation', automationSource]]) {
    assert.match(source, /processDownloadedRestartEvidence/,
      `${name} must process exact-server restart evidence before run success`);
    assert.match(source, /result\.restartEvidence/,
      `${name} must consume server-specific restart evidence`);
  }
}

function testFullScanResponseRetainsPlayerCountContract() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'logParser.js'), 'utf8');
  const scannerReturn = source.slice(source.indexOf('return {', source.indexOf('async function scanLogsForServer')),
    source.indexOf('\n}', source.indexOf('return {', source.indexOf('async function scanLogsForServer'))));
  assert.match(scannerReturn, /totalPlayers:\s*players\.length/);

  const frontend = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'logs.js'), 'utf8');
  assert.match(frontend, /Found \$\{data\.totalPlayers\} unique players/);
  assert.doesNotMatch(frontend, /<li>\$\{p\.playerName/);
  assert.doesNotMatch(frontend, /\(\$\{userId\.substring/);
}

async function testPositionSnapshotsRemainIndependentFromCombatHealth() {
  const parser = require('../routes/logParser');
  const writes = [];
  const db = {
    get: async (sql, params) => {
      assert.match(sql, /WHERE id = \?/);
      assert.deepStrictEqual(params, [42]);
      return { id: 42 };
    },
    all: async () => [{ platform_user_id: 'A1', id: 7 }],
    run: async (sql, params) => {
      writes.push({ sql, params });
      return { changes: 1 };
    },
  };
  const timestamp = '2026-08-29T21:05:00.000Z';

  await parser.savePositionSnapshots(db, '101', [{
    platformUserId: 'A1', playerGamertag: 'Player',
    // ADM wire/storage order is east, north, elevation.
    posX: 100, posY: 200, posZ: 12, timestamp,
  }], 'xbox', 42);

  assert.strictEqual(writes.length, 1,
    'position snapshots must not advance the combat health timestamp or create default health state');
  assert.match(writes[0].sql, /INSERT INTO player_position_snapshots/);
  assert.match(writes[0].sql, /ON CONFLICT DO NOTHING/);

  const playerPortal = fs.readFileSync(path.join(__dirname, '..', 'routes', 'playerPortal.js'), 'utf8');
  const mapRoute = playerPortal.slice(playerPortal.indexOf("router.get('/map-data/:identity_id'"),
    playerPortal.indexOf('\n});', playerPortal.indexOf("router.get('/map-data/:identity_id'")) + 4);
  assert.match(mapRoute, /player_position_snapshots[\s\S]*ORDER BY ps\.timestamp DESC[\s\S]*LIMIT 1/,
    'player map last-known location must come from the newest position snapshot');

  const factions = fs.readFileSync(path.join(__dirname, '..', 'routes', 'factions.js'), 'utf8');
  const factionMap = factions.slice(factions.indexOf("router.get('/:guildId/:factionId/map'"),
    factions.indexOf('\n});', factions.indexOf("router.get('/:guildId/:factionId/map'")) + 4);
  assert.match(factionMap, /player_position_snapshots[\s\S]*server_id = \?/,
    'faction map member locations must use exact-server position snapshots');
  assert.match(factionMap, /ps\.pos_y/,
    'faction member locations must select the stored ADM northing slot');
  assert.match(factionMap, /position:\s*member\.pos_x[\s\S]{0,160}admTupleToWorld\(member\)/,
    'faction member locations must decode ADM tuples into semantic positions');

  const mapClient = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'player-map-standalone.js'), 'utf8');
  assert.match(mapClient, /mapName=\$\{encodeURIComponent\(mapName\)\}&serverId=\$\{encodeURIComponent\(currentServerId\)\}/,
    'faction polling must include the authorized internal server ID');
  assert.match(mapClient, /gameToLeaflet\(m\.position\.east, m\.position\.north, mapName\)/,
    'faction members must be plotted from their semantic position adapter');
  assert.match(mapClient, /gameToLeaflet\(lp\.position\.east, lp\.position\.north, mapName\)/,
    'last-known player position must be plotted from its semantic position adapter');
  assert.match(mapClient, /gameToLeaflet\(p\.position\.east, p\.position\.north, mapName\)/,
    'player trails must be plotted from their semantic position adapter');

  const locationCommand = fs.readFileSync(path.join(__dirname, '..', 'bot', 'commands', 'location.js'), 'utf8');
  const snapshotLookup = locationCommand.indexOf('FROM player_position_snapshots');
  const healthLookup = locationCommand.indexOf('FROM player_health_status');
  assert.ok(snapshotLookup >= 0 && healthLookup >= 0 && snapshotLookup < healthLookup,
    'the location command must prefer newer regular position snapshots over combat-only positions');
}

function testFastLocationRefreshCadenceIsWired() {
  const scheduler = fs.readFileSync(path.join(__dirname, '..', 'scheduler.js'), 'utf8');
  assert.match(scheduler, /cron\.schedule\('\*\/30 \* \* \* \* \*', checkAndRunLogSync\)/,
    '30-second automation option must be backed by a 30-second scheduler tick');

  const map = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'player-map-standalone.js'), 'utf8');
  assert.match(map, /setInterval\([^]*loadPlayerData\(currentIdentityId[^]*30000\)/,
    'an open player map must refresh its location data every 30 seconds');
  assert.match(map,
    /if \(playerDataRequestInFlight\)[\s\S]{0,500}pendingPlayerDataLoad = \{ identityId, options, mapName, serverId \};[\s\S]*finally \{[\s\S]{0,500}playerDataRequestInFlight = false;[\s\S]{0,500}loadPlayerData\(pending\.identityId, pending\.options\)/,
    'slow same-context requests must not overlap, while terrain changes queue a replacement load');
  const plotData = map.slice(map.indexOf('function plotData'), map.indexOf('// --- Structures', map.indexOf('function plotData')));
  assert.doesNotMatch(plotData, /Object\.values\(layers\)/,
    'player refresh must not erase independently refreshed faction layers');
  assert.match(plotData, /\['built', 'placed', 'mounted', 'deaths', 'trail', 'lastpos', 'purchases'\]/);
}

function testStaleOnlineEvidenceCannotAdvanceTeleportLifecycle() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'logParser.js'), 'utf8');
  const scanner = source.slice(source.indexOf('async function scanLogsForServer'));
  assert.match(
    scanner,
    /const onlineCachePublished = await updateOnlineCache\([\s\S]*?if \(onlineCachePublished\) \{[\s\S]*?markTeleportArrivals[\s\S]*?processTeleportCleanups[\s\S]*?processWaitingTeleports[\s\S]*?\n\s*\}/,
    'stale online evidence must not advance teleport lifecycle work after historical parsing'
  );
}

async function testStaleOnlineEvidenceDoesNotBlockHistoricalParseFinality() {
  const { updateOnlineCache } = require('../routes/logParser');
  const writes = [];
  const db = {
    transaction: async callback => callback(db),
    async get(sql) {
      if (/SELECT id FROM servers/.test(sql)) return { id: 42 };
      if (/WHERE id = \? FOR UPDATE/.test(sql)) return { id: 42 };
      if (/server_online_cache_snapshots/.test(sql)) {
        return { source_observed_at: '2026-07-31T00:00:00.000Z', scan_generation: 0 };
      }
      if (/AS fresh/.test(sql)) return { fresh: false, plausible: true };
      throw new Error(`Unexpected query: ${sql}`);
    },
    async run(sql) {
      writes.push(sql);
      return { changes: 1 };
    },
  };

  const published = await updateOnlineCache(
    db,
    'provider-42',
    [],
    'xbox',
    42,
    '2026-08-01T00:00:00.000Z',
    1
  );

  assert.strictEqual(published, false,
    'stale provider evidence must skip online publication without failing historical parsing');
  assert.deepStrictEqual(writes, [],
    'stale evidence must not create a freshness marker or modify the existing online cache');
}

async function testEqualTimestampOnlineCacheUsesMonotonicScanGeneration() {
  const { updateOnlineCache } = require('../routes/logParser');
  assert.strictEqual(typeof updateOnlineCache, 'function');
  const marker = { source_observed_at: null, scan_generation: 0 };
  const cache = new Map();
  let tail = Promise.resolve();
  const identities = new Map([['OLD', 1], ['NEW', 2], ['NEXT', 3]]);
  const db = {
    transaction(callback) {
      const run = tail.then(() => callback(this));
      tail = run.catch(() => {});
      return run;
    },
    async get(sql, params) {
      if (/SELECT id FROM servers/.test(sql)) return { id: 42 };
      if (/server_online_cache_snapshots/.test(sql)) return { ...marker };
      if (/AS fresh/.test(sql)) return { fresh: true, plausible: true };
      if (/player_gamertags/.test(sql)) return { gamertag: `Player-${params[0]}` };
      return null;
    },
    async all(sql, params) {
      if (/FROM player_identities/.test(sql)) {
        return params.slice(1).map(id => ({ platform_user_id: id, id: identities.get(id) }));
      }
      return [];
    },
    async run(sql, params) {
      if (/INSERT INTO server_online_cache_snapshots/.test(sql)) {
        if (marker.source_observed_at === null) {
          marker.source_observed_at = params[1];
          marker.scan_generation = 0;
        }
      } else if (/DELETE FROM server_online_cache/.test(sql)) {
        cache.clear();
      } else if (/INSERT INTO server_online_cache \(/.test(sql)) {
        cache.set(params[1], params[2]);
      } else if (/UPDATE server_online_cache_snapshots/.test(sql)) {
        if (marker.scan_generation < params[1]) {
          marker.source_observed_at = params[0];
          marker.scan_generation = params[1];
        }
      }
      return { changes: 1 };
    },
  };
  const observedAt = new Date().toISOString();
  await updateOnlineCache(db, 'provider-42', [
    { platformUserId: 'NEW', playerGamertag: 'New', loginAt: observedAt },
  ], 'xbox', 42, observedAt, 2);
  await updateOnlineCache(db, 'provider-42', [
    { platformUserId: 'OLD', playerGamertag: 'Old', loginAt: observedAt },
  ], 'xbox', 42, observedAt, 1);
  assert.deepStrictEqual([...cache.keys()], [2],
    'an older equal-timestamp scan generation must not overwrite newer players');
  await updateOnlineCache(db, 'provider-42', [
    { platformUserId: 'NEXT', playerGamertag: 'Next', loginAt: observedAt },
  ], 'xbox', 42, observedAt, 3);
  assert.deepStrictEqual([...cache.keys()], [3],
    'a later sequential generation may publish even when source timestamp is unchanged');
}

async function main() {
  testRotatedLogWithDifferentSizeIsUpdated();
  testSameSizeProviderLogIsStillRefreshed();
  testSyncClassificationRejectsDestinationSymlinks();
  testPcProviderPathsNormalizeToNoFtp();
  testValidatedPcFileEntryPreservesProviderTransferPath();
  testRoutineSyncPreservesHistoryInBoundedDurableBatches();
  testRoutineSyncIncludesProviderLatestAdmAcrossBatchBoundary();
  testRoutineSyncSkipsTemporarilyUnfittableHistoryWithoutStarvingLaterFiles();
  testRoutineSyncRejectsInvalidMandatoryArtifactSizes();
  await testOversizedAdvertisedLogIsRejectedBeforeTransfer();
  await testIncompleteDownloadPreservesExistingFile();
  await testVerifiedIdenticalDownloadDoesNotRewriteOrMarkChanged();
  testParserOrdersByLogStartInsteadOfDownloadTime();
  testInvalidFilenameTimestampUsesFallbackChronology();
  testLogsPageLoadsServersFromEveryGuild();
  testLogsPageEscapesProviderAndLogDerivedValues();
  testServerLogUsesMissingFileClassification();
  testSchedulerUsesPerServerChangeSet();
  testFailedSyncOrParseCannotAdvanceSuccessfulRunState();
  testAutoScanMeansParseSelectedServersAfterSync();
  await testSchedulerParsesOnlyChangedOrUncachedServers();
  testSyncFailuresGatePerServerParsingAndCheckpointing();
  await testSchedulerRetriesFailedParseAfterDownloadStopsChanging();
  await testManualAndScheduledParsesShareDurableCheckpoint();
  await testParseWatermarkUsesUnambiguousInternalServerId();
  await testSerialAndConcurrentSyncStayServerScoped();
  testFullRescanIncludesLogsOlderThanIncrementalWindow();
  testLogInventoryPropagatesFilesystemFailures();
  testLogInventoryRejectsSymlinkEscapes();
  testMixedFilenameChronologyIsTransitive();
  testRptDateUsesStrictFilenameValidation();
  testAdmDateUsesStrictHeaderAndFileMtimeFallback();
  await testStreamingReadRejectsReplacementSymlink();
  testLogInventoryRejectsSymlinkBaseDirectory();
  await testMissingEventIdentityFailsClosed();
  await testStreamingParserDiscoversEventOnlyParticipants();
  await testStreamingParserRejectsUnknownDisconnectIdentity();
  await testStreamingParserPreservesConsoleBase64UrlIdentity();
  await testStreamingParserNormalizesAndFiltersEveryEventIdentity();
  await testCombatParserUsesPlatformAwareIdentityBoundary();
  await testPlatformResolutionUsesExactStoredServerAfterProviderFailure();
  await testStreamingParserCarriesMidnightRolloverAcrossEvents();
  await testStreamingParserPreservesUnconsciousEventParity();
  await testStreamingSessionsSpanRotatedAdmFiles();
  await testKillFeedQueueFailurePropagates();
  await testDisconnectWithoutWindowLocalConnectClosesPersistedSession();
  await testStreamingParserUsesHistoricalFilenameDate();
  await testFullHistoryStreamingStartsAtBeginningOfOversizedLog();
  testRecoveryScriptsPassUserIdInUserSlot();
  await testTrackedPlayersAreScopedToAuthorizedServer();
  await testAltDetectionIsScopedToAuthorizedServer();
  await testOperableGuildDiscoveryIncludesAssignedAdmins();
  await testScanRejectsWhenAnyLogCannotBeRead();
  testSingleFileScanChoosesNewestStrictChronology();
  testManualUploadAwaitsPersistenceBeforeSuccess();
  await testManualUploadUsesAuthorizedServerPlatform();
  testPlayerActivityIsDerivedIdempotentlyFromSessions();
  testScannerPersistenceUsesExactInternalServerId();
  await testPersistenceHelperQueriesExactInternalServerId();
  await testPersistenceFailuresRejectInsteadOfCheckpointing();
  testNestedParserSideEffectsAreAtomicAndFailuresPropagate();
  testTrackedPlayerResponseUsesFrontendFieldNames();
  testLocalScanUsesSharedCompleteScanner();
  await testHistoricalRestartCannotConsumeNewerRentalOrOwnerMarker();
  testFailedRunsRespectConfiguredRetryInterval();
  testRestartEvidenceSelectsNewestLogsAndProviderStart();
  testProviderModifiedAtNormalizesOnlineCacheObservation();
  testProviderClockNormalizesLatestAdmPositions();
  testScheduledScannerReceivesProviderSourceObservation();
  testRestartEvidenceAcceptsEverySupportedPlatformRptName();
  testRestartEvidenceRejectsImpossibleTimestamps();
  await testProviderStartFallbackProcessesEmptyServerLog();
  await testProviderAndServerLogShareDurableRestartIdentity();
  await testDownloadedServerLogProcessingUsesContainedExactServerBinding();
  testManualAndScheduledRunsProcessDownloadedRestartEvidence();
  testFullScanResponseRetainsPlayerCountContract();
  await testPositionSnapshotsRemainIndependentFromCombatHealth();
  testStaleOnlineEvidenceCannotAdvanceTeleportLifecycle();
  await testStaleOnlineEvidenceDoesNotBlockHistoricalParseFinality();
  await testEqualTimestampOnlineCacheUsesMonotonicScanGeneration();
  testFastLocationRefreshCadenceIsWired();
  console.log('Log sync multi-server regression tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
