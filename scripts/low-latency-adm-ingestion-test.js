'use strict';

const { ensureTestEncryptionKey } = require('./lib/test-env');
ensureTestEncryptionKey();

const assert = require('assert');
const {
  createLowLatencyAdmIngestion,
  loadLowLatencyAdmTargets,
  loadPersistedAdmCursors,
  persistAdmCursors,
  startLowLatencyAdmIngestion,
} = require('../services/lowLatencyAdmIngestionService');
const {
  ingestExactServerAdmFiles,
  publishExactServerOnlineSnapshot,
} = require('../services/logScanService');
const { syncExactServer: syncExactServerFromTui } = require('./tui-admin');
const { encryptToken } = require('../utils/encryption');
const {
  ProviderLogStorageUnavailableError,
  createProviderLogAvailabilityTracker,
} = require('../utils/providerLogAvailability');
const {
  selectLatestAdmEntries,
  syncLatestAdmForExactServer,
} = require('../services/logSyncService');

function successfulList(entries) {
  return { data: { status: 'success', data: { entries } } };
}

async function testSyncsOnlyCurrentAndPreviousAdmForExactServer() {
  const guildId = `test-low-latency-${process.pid}`;
  const downloaded = [];
  const httpGet = async url => {
    if (String(url).includes('/file_server/list?dir=')) {
      return successfulList([
        { type: 'file', name: 'DayZServer_X1_x64_2026-09-07_10-00-00.ADM', path: '/games/9001/noftp/dayzxb/config/DayZServer_X1_x64_2026-09-07_10-00-00.ADM', size: 10, modified_at: '2026-09-07T10:00:00.000Z' },
        { type: 'file', name: 'DayZServer_X1_x64_2026-09-07_11-00-00.ADM', path: '/games/9001/noftp/dayzxb/config/DayZServer_X1_x64_2026-09-07_11-00-00.ADM', size: 20, modified_at: '2026-09-07T11:00:00.000Z' },
        { type: 'file', name: 'DayZServer_X1_x64_2026-09-07_12-00-00.ADM', path: '/games/9001/noftp/dayzxb/config/DayZServer_X1_x64_2026-09-07_12-00-00.ADM', size: 30, modified_at: '2026-09-07T12:00:00.000Z' },
        { type: 'file', name: 'DayZServer_X1_x64_2026-09-07_12-00-00.RPT', path: '/games/9001/noftp/dayzxb/config/DayZServer_X1_x64_2026-09-07_12-00-00.RPT', size: 40, modified_at: 400 },
      ]);
    }
    return successfulList([{
      type: 'dir',
      name: 'dayzxb',
      path: '/games/9001/noftp/dayzxb',
    }]);
  };

  try {
    const result = await syncLatestAdmForExactServer({}, 41, 'token', {
      authorizeServer: async () => ({
        id: 41,
        platformServerId: '9001',
        guildDiscordId: guildId,
      }),
      getRawGameserver: async () => ({
        game: 'dayzxb',
        game_specific: { path: '/games/9001/noftp/dayzxb' },
      }),
      httpGet,
      downloadFile: async (_token, platformServerId, entry, localPath) => {
        downloaded.push({ platformServerId, name: entry.name, localPath });
        return entry.name.includes('_12-00-00.ADM');
      },
    });

    assert.deepStrictEqual(downloaded.map(item => item.name), [
      'DayZServer_X1_x64_2026-09-07_11-00-00.ADM',
      'DayZServer_X1_x64_2026-09-07_12-00-00.ADM',
    ]);
    assert(downloaded.every(item => item.platformServerId === '9001'));
    assert(downloaded.every(item => item.localPath.includes(`/downloads/${guildId}/server_9001/config/`)));
    assert.strictEqual(result.changed, true);
    assert.strictEqual(result.sourceObservedAt, '2026-09-07T12:00:00.000Z');
    assert(result.sourceObservedLogFile.endsWith('/DayZServer_X1_x64_2026-09-07_12-00-00.ADM'));
    assert.strictEqual(
      result.marker,
      'DayZServer_X1_x64_2026-09-07_11-00-00.ADM:2026-09-07T11:00:00.000Z:20|DayZServer_X1_x64_2026-09-07_12-00-00.ADM:2026-09-07T12:00:00.000Z:30'
    );
    assert(result.admFiles.every(file => file.remotePath.endsWith(`/config/${file.name}`)));
    const cursorWrites = [];
    const cursorDb = {
      async transaction(callback) {
        return callback({ async run(sql, params) { cursorWrites.push({ sql, params }); } });
      },
    };
    const emptyFingerprint = require('crypto').createHash('sha256').digest('hex');
    await persistAdmCursors(
      cursorDb,
      41,
      result.admFiles,
      new Map(result.admFiles.map(file => [file.name, {
        offset: 0,
        sourceLineBase: 0,
        previousLineTimestamp: null,
        fingerprint: emptyFingerprint,
      }]))
    );
    assert.strictEqual(cursorWrites.length, 3);
  } finally {
    require('fs').rmSync(
      require('path').join(__dirname, '..', 'downloads', guildId),
      { recursive: true, force: true }
    );
  }
}

async function testPersistsNumericProviderSecondsAsUtcTimestamp() {
  const writes = [];
  const db = {
    async transaction(callback) {
      return callback({ async run(sql, params) { writes.push({ sql, params }); } });
    },
  };
  const fingerprint = require('crypto').createHash('sha256').digest('hex');
  await persistAdmCursors(db, 41, [{
    name: 'DayZServer_X1_x64_2026-09-07_12-00-00.ADM',
    remotePath: '/games/9001/noftp/dayzxb/config/DayZServer_X1_x64_2026-09-07_12-00-00.ADM',
    size: 0,
    modifiedAt: 1788775200,
  }], new Map([['DayZServer_X1_x64_2026-09-07_12-00-00.ADM', {
    offset: 0,
    sourceLineBase: 0,
    previousLineTimestamp: null,
    fingerprint,
  }]]));
  assert.strictEqual(writes[1].params[8], '2026-09-07T10:00:00.000Z',
    'numeric provider seconds must not be persisted as a 1970 millisecond timestamp');
}

function testSelectsProviderNewestCurrentAndPreviousAdmOnly() {
  const entries = [
    { name: 'DayZServer_X1_x64_2026-09-07_10-00-00.ADM', modified_at: '2026-09-07T10:00:00.000Z', size: 10 },
    { name: 'DayZServer_X1_x64_2026-09-07_12-00-00.ADM', modified_at: '2026-09-07T12:00:00.000Z', size: 20 },
    { name: 'DayZServer_X1_x64_2026-09-07_11-00-00.ADM', modified_at: '2026-09-07T11:00:00.000Z', size: 30 },
    { name: 'unrelated.ADM', modified_at: 999, size: 50 },
    { name: 'DayZServer_X1_x64_2026-09-07_13-00-00.RPT', modified_at: 400, size: 40 },
  ];
  const selected = selectLatestAdmEntries(entries);

  assert.deepStrictEqual(
    selected.map(entry => entry.name),
    [
      'DayZServer_X1_x64_2026-09-07_11-00-00.ADM',
      'DayZServer_X1_x64_2026-09-07_12-00-00.ADM',
    ]
  );

  const clockRollback = selectLatestAdmEntries([
    { name: 'DayZServer_X1_x64_2026-09-07_12-00-00.ADM', modified_at: 1788775200, size: 10 },
    { name: 'DayZServer_X1_x64_2026-09-07_10-00-00.ADM', modified_at: 1788778800, size: 20 },
    { name: 'DayZServer_X1_x64_2026-09-07_11-00-00.ADM', modified_at: 1788782400, size: 30 },
  ]);
  assert.deepStrictEqual(
    clockRollback.map(entry => entry.name),
    [
      'DayZServer_X1_x64_2026-09-07_10-00-00.ADM',
      'DayZServer_X1_x64_2026-09-07_11-00-00.ADM',
    ]
  );
  assert.throws(
    () => selectLatestAdmEntries([
      { name: 'DayZServer_X1_x64_2026-09-07_12-00-00.ADM', modified_at: 'not-a-time', size: 10 },
    ]),
    /invalid modified_at/
  );
}

async function testIncrementalParserReadsOnlyCompleteAppendedBytes() {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..', 'downloads', `test-low-latency-parser-${process.pid}`);
  const configDir = path.join(root, 'server_9001', 'config');
  const name = 'DayZServer_X1_x64_2026-09-07_12-00-00.ADM';
  const localPath = path.join(configDir, name);
  const token = 'token';
  const tokenHash = encryptToken(token);
  const db = {
    async query() {
      return [{
        id: 41,
        platform: 'xbox',
        platform_server_id: '9001',
        discord_guild_id: 'guild-1',
        token_hash: tokenHash,
      }];
    },
  };
  const firstChunk = '12:00:01 | Administrative log started\n';
  const secondChunk = '12:00:02 | Administrative log heartbeat\n';
  const partialChunk = '12:00:03 | Administrative log heartbeat';

  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(localPath, firstChunk);
    let files = [{ name, localPath, size: Buffer.byteLength(firstChunk), modifiedAt: 1 }];
    const first = await ingestExactServerAdmFiles(db, '9001', token, 41, files, new Map());
    assert.strictEqual(first.processedBytes, Buffer.byteLength(firstChunk));

    fs.appendFileSync(localPath, secondChunk);
    files = [{ name, localPath, size: fs.statSync(localPath).size, modifiedAt: 2 }];
    const second = await ingestExactServerAdmFiles(db, '9001', token, 41, files, first.cursors);
    assert.strictEqual(second.processedBytes, Buffer.byteLength(secondChunk));

    fs.appendFileSync(localPath, partialChunk);
    files = [{ name, localPath, size: fs.statSync(localPath).size, modifiedAt: 3 }];
    const partial = await ingestExactServerAdmFiles(db, '9001', token, 41, files, second.cursors);
    assert.strictEqual(partial.processedBytes, 0);
    assert.strictEqual(partial.cursors.get(name).offset, second.cursors.get(name).offset);

    fs.appendFileSync(localPath, '\n');
    files = [{ name, localPath, size: fs.statSync(localPath).size, modifiedAt: 4 }];
    const completed = await ingestExactServerAdmFiles(db, '9001', token, 41, files, partial.cursors);
    assert.strictEqual(completed.processedBytes, Buffer.byteLength(partialChunk) + 1);

    const replacement = [
      '12:10:01 | Administrative log started',
      '12:10:02 | Administrative log heartbeat',
      '12:10:03 | Administrative log heartbeat',
      '12:10:04 | Administrative log heartbeat',
      '',
    ].join('\n');
    fs.writeFileSync(localPath, replacement);
    files = [{ name, localPath, size: fs.statSync(localPath).size, modifiedAt: 5 }];
    const replaced = await ingestExactServerAdmFiles(db, '9001', token, 41, files, completed.cursors);
    assert.strictEqual(replaced.processedBytes, Buffer.byteLength(replacement));

    const largePrefix = `${'A'.repeat(5000)}\n${'B'.repeat(5000)}\n`;
    fs.writeFileSync(localPath, largePrefix);
    files = [{ name, localPath, size: fs.statSync(localPath).size, modifiedAt: 6 }];
    const large = await ingestExactServerAdmFiles(db, '9001', token, 41, files, replaced.cursors);
    const changedMiddle = `${'A'.repeat(5000)}\n${'C'}${'B'.repeat(4999)}\n`;
    fs.writeFileSync(localPath, changedMiddle);
    const middleReplacement = await ingestExactServerAdmFiles(db, '9001', token, 41, files, large.cursors);
    assert.strictEqual(middleReplacement.processedBytes, Buffer.byteLength(changedMiddle));

    let credentialChecks = 0;
    const rotatedCredentialDb = {
      async query() {
        credentialChecks++;
        return [{
          id: 41,
          platform: 'xbox',
          platform_server_id: '9001',
          discord_guild_id: 'guild-1',
          token_hash: credentialChecks === 1 ? tokenHash : encryptToken('rotated-token'),
        }];
      },
    };
    await assert.rejects(
      ingestExactServerAdmFiles(rotatedCredentialDb, '9001', token, 41, files, new Map()),
      /credential or exact-server binding is no longer current/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testIncrementalParserReturnsLatestCompleteOnlineSnapshot() {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..', 'downloads', `test-low-latency-online-${process.pid}`);
  const configDir = path.join(root, 'server_9001', 'config');
  const name = 'DayZServer_X1_x64_2026-09-13_12-00-00.ADM';
  const localPath = path.join(configDir, name);
  const token = 'token';
  const tokenHash = encryptToken(token);
  const db = {
    async query() {
      return [{
        id: 41,
        platform: 'xbox',
        platform_server_id: '9001',
        discord_guild_id: 'guild-1',
        token_hash: tokenHash,
      }];
    },
  };
  const content = [
    '12:00:00 | ##### PlayerList log: 1 players',
    '12:00:00 | Player "Current Player" (id=AAAA1111 pos=<1.0, 2.0, 3.0>)',
    '12:00:00 | #####',
    '',
  ].join('\n');

  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(localPath, content);
    const result = await ingestExactServerAdmFiles(db, '9001', token, 41, [{
      name,
      localPath,
      size: Buffer.byteLength(content),
      modifiedAt: '2026-09-13T12:00:05.000Z',
    }], new Map());
    assert.deepStrictEqual(result.onlineUpdates, [{
      type: 'snapshot',
      sourceFileName: name,
      observedAt: '2026-09-13T12:00:00Z',
      players: [{
        playerGamertag: 'Current Player',
        platformUserId: 'AAAA1111',
      }],
    }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testIncompletePlayerListIsRetriedWithoutPublishingOlderSnapshot() {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..', 'downloads', `test-low-latency-partial-online-${process.pid}`);
  const configDir = path.join(root, 'server_9001', 'config');
  const name = 'DayZServer_X1_x64_2026-09-13_12-00-00.ADM';
  const localPath = path.join(configDir, name);
  const token = 'token';
  const tokenHash = encryptToken(token);
  const db = {
    async query() {
      return [{
        id: 41,
        platform: 'xbox',
        platform_server_id: '9001',
        discord_guild_id: 'guild-1',
        token_hash: tokenHash,
      }];
    },
  };
  const boundedPrefix = `${'X'.repeat(65520)}\n`;
  const completeA = [
    '12:00:00 | ##### PlayerList log: 1 players',
    '12:00:00 | Player "Player A" (id=AAAA1111 pos=<1.0, 2.0, 3.0>)',
    '12:00:00 | #####',
  ].join('\n') + '\n';
  const incompleteB = [
    '12:00:30 | ##### PlayerList log: 1 players',
    '12:00:30 | Player "Player B" (id=BBBB2222 pos=<4.0, 5.0, 6.0>)',
  ].join('\n') + '\n';

  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(localPath, boundedPrefix + completeA + incompleteB);
    const file = modifiedAt => ({
      name,
      localPath,
      size: fs.statSync(localPath).size,
      modifiedAt,
    });
    const first = await ingestExactServerAdmFiles(
      db,
      '9001',
      token,
      41,
      [file('2026-09-13T12:00:31.000Z')],
      new Map()
    );
    assert.deepStrictEqual(first.onlineUpdates, [], 'older snapshots must not refresh through a partial newer block');
    assert.strictEqual(
      first.cursors.get(name).offset,
      Buffer.byteLength(boundedPrefix + completeA)
    );

    fs.appendFileSync(localPath, '12:00:30 | #####\n');
    const second = await ingestExactServerAdmFiles(
      db,
      '9001',
      token,
      41,
      [file('2026-09-13T12:00:32.000Z')],
      first.cursors
    );
    assert.deepStrictEqual(second.onlineUpdates, [{
      type: 'snapshot',
      sourceFileName: name,
      observedAt: '2026-09-13T12:00:30Z',
      players: [{ playerGamertag: 'Player B', platformUserId: 'BBBB2222' }],
    }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testMalformedNewestSnapshotEmitsInvalidation() {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..', 'downloads', `test-low-latency-malformed-online-${process.pid}`);
  const configDir = path.join(root, 'server_9001', 'config');
  const name = 'DayZServer_X1_x64_2026-09-13_12-00-00.ADM';
  const localPath = path.join(configDir, name);
  const token = 'token';
  const tokenHash = encryptToken(token);
  const db = {
    async query() {
      return [{
        id: 41,
        platform: 'xbox',
        platform_server_id: '9001',
        discord_guild_id: 'guild-1',
        token_hash: tokenHash,
      }];
    },
  };
  const content = [
    '12:00:00 | ##### PlayerList log: 1 players',
    '12:00:00 | Player "Player A" (id=AAAA1111 pos=<1.0, 2.0, 3.0>)',
    '12:00:00 | #####',
    '12:05:00 | ##### PlayerList log: 2 players',
    '12:05:00 | Player "Player B" (id=BBBB2222 pos=<4.0, 5.0, 6.0>)',
    '12:05:00 | #####',
    '',
  ].join('\n');

  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(localPath, content);
    const result = await ingestExactServerAdmFiles(db, '9001', token, 41, [{
      name,
      localPath,
      size: Buffer.byteLength(content),
      modifiedAt: '2026-09-13T12:05:05.000Z',
    }], new Map());
    assert.deepStrictEqual(
      result.onlineUpdates.map(update => update.type),
      ['snapshot', 'snapshot_invalid'],
      'a malformed newest block must invalidate older snapshots from the same batch'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testMalformedNewestSnapshotIsNotPublished() {
  const calls = [];
  const service = createLowLatencyAdmIngestion({
    db: {},
    loadTargets: async () => [],
    decryptToken: value => value,
    acquireLocks: async () => ({ async release() {} }),
    beginStatus: async () => null,
    syncLatestAdm: async () => ({
      changed: true,
      marker: 'active.ADM:2:1',
      platformServerId: '9001',
      admFiles: [{
        name: 'active.ADM',
        localPath: '/downloads/active.ADM',
        size: 2,
        modifiedAt: '2026-09-13T12:05:05.000Z',
      }],
    }),
    ingestAdmFiles: async () => ({
      killEvents: 0,
      cursors: new Map(),
      onlineUpdates: [{
        type: 'snapshot',
        sourceFileName: 'active.ADM',
        observedAt: '2026-09-13T12:00:00Z',
        players: [{ playerGamertag: 'Player A', platformUserId: 'AAAA1111' }],
      }, {
        type: 'snapshot_invalid',
        sourceFileName: 'active.ADM',
        observedAt: '2026-09-13T12:05:00Z',
      }],
    }),
    publishOnlineSnapshot: async () => calls.push('publish'),
    saveCursors: async () => calls.push('save'),
    processServerFeeds: async () => {},
    logger: { log() {}, warn() {}, error() {} },
  });

  const outcome = await service.runTarget({
    serverId: 41,
    platformServerId: '9001',
    guildId: 'guild-1',
    tokenHash: 'token',
  });
  assert.strictEqual(outcome.status, 'succeeded');
  assert.deepStrictEqual(calls, ['save']);
}

async function testExactServerSnapshotPublisherPersistsThenReplacesCache() {
  const calls = [];
  const db = {};
  const snapshot = {
    sourceFileName: 'current.ADM',
    observedAt: '2026-09-13T14:00:00Z',
    players: [{
      playerGamertag: 'Current Player',
      platformUserId: 'AAAA1111',
      loginAt: '2026-09-13T13:55:00Z',
    }],
  };
  await publishExactServerOnlineSnapshot(
    db,
    '9001',
    'exact-token',
    41,
    snapshot,
    '2026-09-13T18:00:05.000Z',
    {
      resolveContext: async (...args) => {
        calls.push(['resolve', ...args]);
        return { id: 41, platform: 'xbox' };
      },
      savePlayers: async (...args) => calls.push(['save', ...args]),
      allocateGeneration: async (...args) => {
        calls.push(['allocate', ...args]);
        return 712;
      },
      updateCache: async (...args) => calls.push(['cache', ...args]),
    }
  );

  assert.deepStrictEqual(calls.map(call => call[0]), ['resolve', 'save', 'allocate', 'cache']);
  assert.deepStrictEqual(calls[1].slice(1), [
    db,
    null,
    '9001',
    [{
      playerName: 'Current Player',
      platformUserId: 'AAAA1111',
      dpnid: null,
      deviceId: null,
    }],
    'xbox',
    41,
  ]);
  assert.deepStrictEqual(calls[3].slice(1), [
    db,
    '9001',
    [{
      playerGamertag: 'Current Player',
      platformUserId: 'AAAA1111',
      loginAt: '2026-09-13T17:55:00.000Z',
    }],
    'xbox',
    41,
    '2026-09-13T18:00:05.000Z',
    712,
  ]);
}

async function testLowLatencyPathPublishesCompleteOnlineSnapshot() {
  const calls = [];
  let syncInvocation = 0;
  let ingestionInvocation = 0;
  const service = createLowLatencyAdmIngestion({
    db: {},
    loadTargets: async () => [],
    decryptToken: value => value,
    acquireLocks: async () => ({ async release() {} }),
    beginStatus: async () => null,
    syncLatestAdm: async () => {
      syncInvocation++;
      return {
        changed: true,
        marker: `${syncInvocation === 4 ? 'new.ADM' : 'active.ADM'}:${syncInvocation}:1`,
        platformServerId: '9001',
        admFiles: [{
          name: syncInvocation === 4 ? 'new.ADM' : 'active.ADM',
          localPath: '/downloads/active.ADM',
          size: syncInvocation,
          modifiedAt: [
            null,
            '2026-09-13T12:00:05.000Z',
            '2026-09-13T12:00:35.000Z',
            '2026-09-13T12:05:05.000Z',
            '2026-09-13T12:06:00.000Z',
          ][syncInvocation],
        }],
      };
    },
    ingestAdmFiles: async () => {
      ingestionInvocation++;
      return {
        killEvents: 0,
        cursors: new Map(),
        onlineUpdates: ingestionInvocation === 1 ? [{
          type: 'snapshot',
          sourceFileName: 'active.ADM',
          observedAt: '2026-09-13T12:00:00Z',
          players: [{ playerGamertag: 'Current Player', platformUserId: 'AAAA1111' }],
        }] : ingestionInvocation === 2 ? [{
          type: 'connect',
          sourceFileName: 'active.ADM',
          playerGamertag: 'New Player',
          platformUserId: 'BBBB2222',
          loginAt: '2026-09-13T12:00:30Z',
        }] : ingestionInvocation === 3 ? [{
          type: 'snapshot',
          sourceFileName: 'active.ADM',
          observedAt: '2026-09-13T12:05:00Z',
          players: [
            { playerGamertag: 'Current Player', platformUserId: 'AAAA1111' },
            { playerGamertag: 'New Player', platformUserId: 'BBBB2222' },
          ],
        }] : [],
      };
    },
    publishOnlineSnapshot: async (...args) => { calls.push(['publish', ...args]); return true; },
    saveCursors: async () => { calls.push(['save']); },
    processServerFeeds: async () => assert.fail('zero kills must not drain feeds'),
    logger: { log() {}, warn() {}, error() {} },
  });
  const target = {
    serverId: 41,
    platformServerId: '9001',
    guildId: 'guild-1',
    tokenHash: 'token',
  };

  assert.strictEqual((await service.runTarget(target)).status, 'succeeded');
  assert.strictEqual((await service.runTarget(target)).status, 'succeeded');
  assert.strictEqual((await service.runTarget(target)).status, 'succeeded');
  assert.strictEqual((await service.runTarget(target)).status, 'succeeded');
  assert.deepStrictEqual(
    calls.map(call => call[0]),
    ['publish', 'save', 'publish', 'save', 'publish', 'save', 'save'],
    'rotation without a complete snapshot must invalidate state without publishing old names'
  );
  assert.deepStrictEqual(calls[0].slice(2), [
    '9001',
    'token',
    41,
    {
      sourceFileName: 'active.ADM',
      observedAt: '2026-09-13T12:00:00Z',
      players: [{
        playerGamertag: 'Current Player',
        platformUserId: 'AAAA1111',
        loginAt: '2026-09-13T12:00:00Z',
      }],
    },
    '2026-09-13T12:00:05.000Z',
  ]);
  assert.deepStrictEqual(calls[2][5].players, [
    {
      playerGamertag: 'Current Player',
      platformUserId: 'AAAA1111',
      loginAt: '2026-09-13T12:00:00Z',
    },
    {
      playerGamertag: 'New Player',
      platformUserId: 'BBBB2222',
      loginAt: '2026-09-13T12:00:30Z',
    },
  ]);
  assert.strictEqual(calls[2][6], '2026-09-13T12:00:35.000Z');
  assert.deepStrictEqual(
    calls[4][5].players,
    calls[2][5].players,
    'a later complete snapshot must preserve known connection times'
  );
  assert.strictEqual(calls[4][6], '2026-09-13T12:05:05.000Z');
}

async function testAdminTuiSyncUsesExactServerCredentialAndLock() {
  let lockHeld = false;
  let released = false;
  const syncCalls = [];
  const result = await syncExactServerFromTui(
    {
      query: async (sql, params) => {
        assert.match(sql, /WHERE s\.id = \?/);
        assert.match(sql, /g\.status = \?/);
        assert.match(sql, /g\.disabled_at IS NULL/);
        assert.doesNotMatch(sql, /approval_status|removed_at/);
        assert.deepStrictEqual(params, ['nitrado', 41, 'active', 'approved']);
        return [{
          server_id: 41,
          platform_server_id: '9001',
          discord_guild_id: 'guild-1',
          token_hash: 'encrypted',
        }];
      },
    },
    41,
    {
      decrypt: value => {
        assert.strictEqual(value, 'encrypted');
        return 'token';
      },
      acquireLocks: async (db, ids) => {
        assert.deepStrictEqual(ids, [41]);
        lockHeld = true;
        return {
          release: async () => {
            lockHeld = false;
            released = true;
          },
        };
      },
      sync: async (...args) => {
        assert(lockHeld);
        syncCalls.push(args);
        return { totalFilesDownloaded: 1 };
      },
    }
  );
  assert.strictEqual(syncCalls[0][1], null);
  assert.strictEqual(syncCalls[0][2], 'token');
  assert.deepStrictEqual(syncCalls[0][3], ['9001']);
  assert(syncCalls[0][4] instanceof Map);
  assert.deepStrictEqual(syncCalls[0][4].get('9001'), {
    id: 41,
    platformServerId: '9001',
    guildDiscordId: 'guild-1',
  });
  assert.strictEqual(result.totalFilesDownloaded, 1);
  assert(released);
}

function testAllRuntimeScanPathsShareExactServerLock() {
  const fs = require('fs');
  const path = require('path');
  const read = relative => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
  const scheduler = read('scheduler.js');
  const automation = read('routes/automation.js');
  const parser = read('routes/logParser.js');
  const teleport = read('services/teleportProcessorService.js');
  const tui = read('scripts/tui-admin.js');
  assert.match(scheduler, /acquireExactServerLogLocks[\s\S]*ingestionLockHeld: true/);
  assert.match(automation, /acquireExactServerLogLocks[\s\S]*ingestionLockHeld: true/);
  assert.match(parser, /if \(!ingestionLockHeld\)[\s\S]*acquireExactServerLogLocks/);
  assert.match(teleport, /refreshRestartEvidence[\s\S]*acquireExactServerLogLocks[\s\S]*ingestionLockHeld: true/);
  assert.match(tui, /performLogSyncConcurrent[\s\S]*syncExactServer[\s\S]*acquireLocks\(db, \[serverId\]\)/);
}

function testBackendStartsDedicatedIngestionLoop() {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /startLowLatencyAdmIngestion/);
  assert.match(source, /startLowLatencyAdmIngestion\(db\)/);
}

async function testStartsThirtySecondLoopAndRunsImmediately() {
  const intervals = [];
  let loads = 0;
  const started = startLowLatencyAdmIngestion({}, {
    loadTargets: async () => { loads++; return []; },
    decryptToken: () => 'token',
    syncLatestAdm: async () => assert.fail('no targets should sync'),
    scanLogs: async () => assert.fail('no targets should scan'),
    processServerFeeds: async () => assert.fail('no targets should drain'),
    setIntervalFn(callback, milliseconds) {
      intervals.push({ callback, milliseconds });
      return { unref() {} };
    },
    logger: { log() {}, warn() {}, error() {} },
  });

  await started.initialRun;
  assert.strictEqual(loads, 1);
  assert.strictEqual(intervals.length, 1);
  assert.strictEqual(intervals[0].milliseconds, 30000);
  await intervals[0].callback();
  assert.strictEqual(loads, 2);
}

async function testLoadsOnlyExactActiveServersWithEnabledKillFeeds() {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      return [{
        server_id: 41,
        platform_server_id: '9001',
        discord_guild_id: 'guild-1',
        token_hash: 'encrypted-token',
      }];
    },
  };

  const targets = await loadLowLatencyAdmTargets(db);

  assert.deepStrictEqual(targets, [{
    serverId: 41,
    platformServerId: '9001',
    guildId: 'guild-1',
    tokenHash: 'encrypted-token',
  }]);
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].params, ['kill_feed', 'nitrado']);
  assert.match(calls[0].sql, /s\.status = 'active'/);
  assert.match(calls[0].sql, /g\.status = 'approved'/);
  assert.match(calls[0].sql, /df\.enabled = 1/);
  assert.match(calls[0].sql, /df\.server_id = s\.id/);
  assert.match(calls[0].sql, /COUNT\(DISTINCT gt\.id\) = 1/);
}

async function testPersistsAndReloadsExactGenerationCursor() {
  const runs = [];
  const fingerprint = 'a'.repeat(64);
  const file = {
    name: 'DayZServer_X1_x64_2026-09-07_12-00-00.ADM',
    remotePath: '/noftp/dayzxb/config/DayZServer_X1_x64_2026-09-07_12-00-00.ADM',
    size: 120,
    modifiedAt: '2026-09-07T12:00:30.000Z',
  };
  const cursor = {
    offset: 100,
    sourceLineBase: 8,
    previousLineTimestamp: '2026-09-07T12:00:08.000Z',
    fingerprint,
  };
  const db = {
    async transaction(callback) {
      return callback({ async run(sql, params) { runs.push({ sql, params }); } });
    },
    async query(sql, params) {
      assert.match(sql, /low_latency_adm_cursors/);
      assert.deepStrictEqual(params, [41]);
      return [{
        remote_name: file.name,
        byte_offset: '100',
        source_line_base: '8',
        previous_line_timestamp: cursor.previousLineTimestamp,
        content_fingerprint: fingerprint,
      }];
    },
  };

  await persistAdmCursors(db, 41, [file], new Map([[file.name, cursor]]));
  assert.strictEqual(runs.length, 2);
  assert.match(runs[0].sql, /DELETE FROM low_latency_adm_cursors/);
  assert.match(runs[1].sql, /INSERT INTO low_latency_adm_cursors/);
  const loaded = await loadPersistedAdmCursors(db, 41);
  assert.deepStrictEqual(loaded.get(file.name), cursor);
}

async function testHoldsDatabaseExactServerLockThroughParse() {
  let lockHeld = false;
  let released = false;
  const db = {
    type: 'postgres',
    async acquireSessionAdvisoryLocks(namespace, ids) {
      assert.strictEqual(typeof namespace, 'number');
      assert.deepStrictEqual(ids, [41]);
      lockHeld = true;
      return {
        async release() {
          lockHeld = false;
          released = true;
        },
      };
    },
  };
  const service = createLowLatencyAdmIngestion({
    db,
    loadTargets: async () => [{
      serverId: 41,
      platformServerId: '9001',
      guildId: 'guild-1',
      tokenHash: 'encrypted',
    }],
    decryptToken: () => 'token',
    syncLatestAdm: async () => {
      assert.strictEqual(lockHeld, true);
      return {
        changed: true,
        marker: 'active',
        platformServerId: '9001',
        admFiles: [{ name: 'active.ADM', localPath: '/downloads/active.ADM', size: 1 }],
      };
    },
    ingestAdmFiles: async (...args) => {
      assert.strictEqual(lockHeld, true);
      return { killEvents: 0, cursors: args[5] };
    },
    processServerFeeds: async () => {},
    logger: { log() {}, warn() {}, error() {} },
  });

  const result = await service.runOnce();
  assert.strictEqual(result.succeeded, 1);
  assert.strictEqual(released, true);
  assert.strictEqual(lockHeld, false);
}

async function testDoesNotOverlapTheSameExactServer() {
  let releaseFirst;
  let syncCalls = 0;
  const service = createLowLatencyAdmIngestion({
    db: {},
    loadTargets: async () => [],
    decryptToken: value => value,
    syncLatestAdm: async () => {
      syncCalls++;
      await new Promise(resolve => { releaseFirst = resolve; });
      return {
        changed: false,
        marker: 'active.ADM:1:1',
        platformServerId: '9001',
        sourceObservedAt: 1,
        sourceObservedLogFile: '/downloads/active.ADM',
        admFiles: [{ name: 'active.ADM', localPath: '/downloads/active.ADM', size: 1 }],
      };
    },
    ingestAdmFiles: async (...args) => ({ killEvents: 0, cursors: args[5] }),
    processServerFeeds: async () => {},
    logger: { log() {}, warn() {}, error() {} },
  });
  const target = {
    serverId: 41,
    platformServerId: '9001',
    guildId: 'guild-1',
    tokenHash: 'token',
  };

  const first = service.runTarget(target);
  await new Promise(resolve => setImmediate(resolve));
  const overlapping = await service.runTarget(target);
  assert.deepStrictEqual(overlapping, { status: 'skipped', kills: 0 });
  assert.strictEqual(syncCalls, 1);
  releaseFirst();
  await first;
}

async function testSkipsOverlappingTicksToPreserveGlobalBound() {
  let active = 0;
  const releases = [];
  const targets = [1, 2, 3].map(serverId => ({
    serverId,
    platformServerId: String(9000 + serverId),
    guildId: `guild-${serverId}`,
    tokenHash: `token-${serverId}`,
  }));
  const service = createLowLatencyAdmIngestion({
    db: {},
    concurrency: 2,
    loadTargets: async () => targets,
    decryptToken: value => value,
    syncLatestAdm: async (_db, serverId) => {
      active++;
      await new Promise(resolve => releases.push(resolve));
      active--;
      return {
        changed: false,
        marker: `active-${serverId}`,
        platformServerId: String(9000 + serverId),
        sourceObservedAt: '2026-09-07T18:00:00.000Z',
        sourceObservedLogFile: `/downloads/${serverId}.ADM`,
        admFiles: [{ name: `${serverId}.ADM`, localPath: `/downloads/${serverId}.ADM`, size: 1 }],
      };
    },
    ingestAdmFiles: async (...args) => ({ killEvents: 0, cursors: args[5] }),
    processServerFeeds: async () => {},
    logger: { log() {}, warn() {}, error() {} },
  });

  const firstTick = service.runOnce();
  await new Promise(resolve => setImmediate(resolve));
  const secondTickPromise = service.runOnce();
  const secondTick = await Promise.race([
    secondTickPromise,
    new Promise(resolve => setImmediate(() => resolve('blocked'))),
  ]);
  assert.strictEqual(active, 2);
  assert.deepStrictEqual(secondTick, {
    targets: 0, succeeded: 0, failed: 0, skipped: 0, kills: 0,
  });
  releases.splice(0).forEach(resolve => resolve());
  await new Promise(resolve => setImmediate(resolve));
  releases.splice(0).forEach(resolve => resolve());
  await Promise.all([firstTick, secondTickPromise]);
}

async function testBoundsConcurrentExactServerIngestion() {
  let active = 0;
  let maxActive = 0;
  const releases = [];
  const targets = [1, 2, 3].map(serverId => ({
    serverId,
    platformServerId: String(9000 + serverId),
    guildId: `guild-${serverId}`,
    tokenHash: `token-${serverId}`,
  }));
  const service = createLowLatencyAdmIngestion({
    db: {},
    concurrency: 2,
    loadTargets: async () => targets,
    decryptToken: value => value,
    syncLatestAdm: async (_db, serverId) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => releases.push(resolve));
      active--;
      return {
        changed: false,
        marker: `active-${serverId}`,
        platformServerId: String(9000 + serverId),
        sourceObservedAt: '2026-09-07T18:00:00.000Z',
        sourceObservedLogFile: `/downloads/${serverId}.ADM`,
        admFiles: [{ name: `${serverId}.ADM`, localPath: `/downloads/${serverId}.ADM`, size: 1 }],
      };
    },
    ingestAdmFiles: async (...args) => ({ killEvents: 0, cursors: args[5] }),
    processServerFeeds: async () => {},
    logger: { log() {}, warn() {}, error() {} },
  });

  const running = service.runOnce();
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(active, 2, 'only two exact servers may ingest concurrently');
  releases.splice(0).forEach(resolve => resolve());
  await new Promise(resolve => setImmediate(resolve));
  releases.splice(0).forEach(resolve => resolve());
  await running;
  assert.strictEqual(maxActive, 2);
}

async function testFailedParseRetriesUnchangedDownloadedGeneration() {
  let scanAttempts = 0;
  const target = {
    serverId: 42,
    platformServerId: '9002',
    guildId: 'guild-2',
    tokenHash: 'encrypted-token',
  };
  const service = createLowLatencyAdmIngestion({
    db: {},
    loadTargets: async () => [target],
    decryptToken: () => 'token',
    syncLatestAdm: async () => ({
      changed: false,
      marker: 'active.ADM:123:456',
      platformServerId: '9002',
      sourceObservedAt: '2026-09-07T18:00:00.000Z',
      sourceObservedLogFile: '/downloads/active.ADM',
      admFiles: [{ name: 'active.ADM', localPath: '/downloads/active.ADM', size: 456 }],
    }),
    ingestAdmFiles: async (...args) => {
      scanAttempts++;
      if (scanAttempts === 1) throw new Error('parse failed');
      return { killEvents: 0, cursors: args[5] };
    },
    processServerFeeds: async () => assert.fail('zero kills must not drain feeds'),
    logger: { log() {}, warn() {}, error() {} },
  });

  const first = await service.runOnce();
  const second = await service.runOnce();
  const third = await service.runOnce();

  assert.deepStrictEqual(first, { targets: 1, succeeded: 0, failed: 1, skipped: 0, kills: 0 });
  assert.deepStrictEqual(second, { targets: 1, succeeded: 1, failed: 0, skipped: 0, kills: 0 });
  assert.deepStrictEqual(third, { targets: 1, succeeded: 1, failed: 0, skipped: 0, kills: 0 });
  assert.strictEqual(scanAttempts, 2, 'failed generations retry, then unchanged parsed generations skip');
}

async function testAdvancesOnlyIncrementalAdmCursorsAfterAppend() {
  const cursorInputs = [];
  let syncCall = 0;
  const service = createLowLatencyAdmIngestion({
    db: {},
    loadTargets: async () => [{
      serverId: 41,
      platformServerId: '9001',
      guildId: 'guild-1',
      tokenHash: 'encrypted-token',
    }],
    decryptToken: () => 'token',
    syncLatestAdm: async () => ({
      changed: true,
      marker: `active.ADM:${++syncCall}:100`,
      platformServerId: '9001',
      sourceObservedAt: syncCall,
      sourceObservedLogFile: '/downloads/active.ADM',
      admFiles: [{ name: 'active.ADM', localPath: '/downloads/active.ADM', size: 100 }],
    }),
    ingestAdmFiles: async (_db, _platformId, _token, _serverId, _files, cursors) => {
      cursorInputs.push(new Map(cursors));
      return {
        killEvents: 0,
        cursors: new Map([['active.ADM', {
          offset: cursorInputs.length * 50,
          sourceLineBase: cursorInputs.length * 5,
          previousLineTimestamp: `2026-09-07T18:00:0${cursorInputs.length}.000Z`,
          fingerprint: `fingerprint-${cursorInputs.length}`,
        }]]),
      };
    },
    scanLogs: async () => assert.fail('low-latency ingestion must not invoke the retained-history scanner'),
    processServerFeeds: async () => {},
    logger: { log() {}, warn() {}, error() {} },
  });

  await service.runOnce();
  await service.runOnce();
  assert.strictEqual(cursorInputs.length, 2);
  assert.strictEqual(cursorInputs[0].size, 0);
  assert.deepStrictEqual(cursorInputs[1].get('active.ADM'), {
    offset: 50,
    sourceLineBase: 5,
    previousLineTimestamp: '2026-09-07T18:00:01.000Z',
    fingerprint: 'fingerprint-1',
  });
}

async function testUsesReauthorizedProviderIdentityForParsing() {
  const scans = [];
  const service = createLowLatencyAdmIngestion({
    db: {},
    loadTargets: async () => [{
      serverId: 41,
      platformServerId: 'stale-provider-id',
      guildId: 'guild-1',
      tokenHash: 'encrypted-token',
    }],
    decryptToken: () => 'token',
    syncLatestAdm: async () => ({
      changed: true,
      marker: 'active.ADM:123:456',
      platformServerId: 'current-provider-id',
      sourceObservedAt: '2026-09-07T18:00:00.000Z',
      sourceObservedLogFile: '/downloads/active.ADM',
      admFiles: [{ name: 'active.ADM', localPath: '/downloads/active.ADM', size: 456 }],
    }),
    ingestAdmFiles: async (...args) => {
      scans.push(args);
      return { killEvents: 0, cursors: args[5] };
    },
    processServerFeeds: async () => {},
    logger: { log() {}, warn() {}, error() {} },
  });

  await service.runOnce();
  assert.strictEqual(scans[0][1], 'current-provider-id');
}

async function testNewKillDrainsExactServerFeedImmediately() {
  const scans = [];
  const drains = [];
  const service = createLowLatencyAdmIngestion({
    db: {},
    loadTargets: async () => [{
      serverId: 41,
      platformServerId: '9001',
      guildId: 'guild-1',
      tokenHash: 'encrypted-token',
    }],
    decryptToken: () => 'token',
    syncLatestAdm: async () => ({
      changed: true,
      marker: 'active.ADM:123:456',
      platformServerId: '9001',
      sourceObservedAt: '2026-09-07T18:00:00.000Z',
      sourceObservedLogFile: '/downloads/active.ADM',
      admFiles: [{ name: 'active.ADM', localPath: '/downloads/active.ADM', size: 456 }],
    }),
    ingestAdmFiles: async (...args) => {
      scans.push(args);
      return { killEvents: 1, cursors: args[5] };
    },
    processServerFeeds: async (...args) => drains.push(args),
    logger: { log() {}, warn() {}, error() {} },
  });

  const result = await service.runOnce();

  assert.deepStrictEqual(result, { targets: 1, succeeded: 1, failed: 0, skipped: 0, kills: 1 });
  assert.strictEqual(scans.length, 1);
  assert.strictEqual(scans[0][1], '9001');
  assert.strictEqual(scans[0][3], 41);
  assert.deepStrictEqual(scans[0][4], [
    { name: 'active.ADM', localPath: '/downloads/active.ADM', size: 456 },
  ]);
  assert(scans[0][5] instanceof Map);
  assert.deepStrictEqual(drains, [[{}, 'guild-1', 41]]);
}

async function testRecordsHealthyPipelineCompletion() {
  const completions = [];
  const service = createLowLatencyAdmIngestion({
    db: {},
    intervalSeconds: 45,
    beginStatus: async (_db, input) => ({
      serverId: input.serverId,
      pipeline: input.pipeline,
      intervalSeconds: input.intervalSeconds,
      startedAt: new Date('2026-09-07T18:00:00.000Z'),
    }),
    finishStatus: async (_db, _run, input) => completions.push(input),
    decryptToken: value => value,
    syncLatestAdm: async () => ({
      changed: true,
      marker: 'active.ADM:123:456',
      platformServerId: '9001',
      admFiles: [{ name: 'active.ADM', localPath: '/downloads/active.ADM', size: 456 }],
    }),
    ingestAdmFiles: async (...args) => ({ killEvents: 0, cursors: args[5] }),
    processServerFeeds: async () => {},
    logger: { log() {}, warn() {}, error() {} },
  });

  const result = await service.runTarget({
    serverId: 41,
    platformServerId: '9001',
    guildId: 'guild-1',
    tokenHash: 'token',
  });

  assert.strictEqual(result.status, 'succeeded');
  assert.strictEqual(completions.length, 1);
  assert.strictEqual(completions[0].status, 'healthy');
  assert.deepStrictEqual(completions[0].counters, { kills: 0 });
}

async function testExpectedLockContentionDoesNotDegradePipeline() {
  const completions = [];
  let starts = 0;
  const service = createLowLatencyAdmIngestion({
    db: {},
    intervalSeconds: 30,
    beginStatus: async () => {
      starts++;
      throw new Error('status must not start without the ingestion lock');
    },
    finishStatus: async (_db, _run, input) => completions.push(input),
    acquireLocks: async () => null,
    decryptToken: value => value,
    logger: { log() {}, warn() {}, error() {} },
  });

  const result = await service.runTarget({
    serverId: 41,
    platformServerId: '9001',
    guildId: 'guild-1',
    tokenHash: 'token',
  });

  assert.deepStrictEqual(result, { status: 'skipped', kills: 0, errorCode: 'INGESTION_LOCK_BUSY' });
  assert.strictEqual(starts, 0);
  assert.strictEqual(completions.length, 0);
}

async function testBacksOffUnavailableProviderLogStoragePerExactServer() {
  let now = Date.parse('2026-09-13T15:00:00.000Z');
  let syncCalls = 0;
  const errors = [];
  const availabilityTracker = createProviderLogAvailabilityTracker({
    baseBackoffMs: 5 * 60 * 1000,
    maxBackoffMs: 5 * 60 * 1000,
  });
  const service = createLowLatencyAdmIngestion({
    db: {},
    loadTargets: async () => [],
    decryptToken: value => value,
    acquireLocks: async () => ({ async release() {} }),
    beginStatus: async () => null,
    syncLatestAdm: async () => {
      syncCalls++;
      if (syncCalls === 1) throw new ProviderLogStorageUnavailableError('9001');
      return {
        changed: false,
        marker: 'active.ADM:1:1',
        platformServerId: '9001',
        admFiles: [{ name: 'active.ADM', localPath: '/downloads/active.ADM', size: 1 }],
      };
    },
    ingestAdmFiles: async (...args) => ({ killEvents: 0, cursors: args[5] }),
    processServerFeeds: async () => {},
    availabilityTracker,
    nowMs: () => now,
    logger: { log() {}, warn() {}, error(...args) { errors.push(args); } },
  });
  const target = {
    serverId: 41,
    platformServerId: '9001',
    guildId: 'guild-1',
    tokenHash: 'token',
  };

  assert.deepStrictEqual(await service.runTarget(target), {
    status: 'failed', kills: 0, errorCode: 'LOG_STORAGE_UNAVAILABLE',
  });
  assert.strictEqual(syncCalls, 1);
  assert.strictEqual(errors.length, 1);

  assert.deepStrictEqual(await service.runTarget(target), {
    status: 'skipped', kills: 0, errorCode: 'LOG_STORAGE_BACKOFF',
  });
  assert.strictEqual(syncCalls, 1, 'provider must not be polled again during storage backoff');
  assert.strictEqual(errors.length, 1, 'backoff ticks must not repeat the same provider error');

  now += 5 * 60 * 1000;
  assert.strictEqual((await service.runTarget(target)).status, 'succeeded');
  assert.strictEqual(syncCalls, 2, 'provider storage must be probed again when backoff expires');
  assert.strictEqual(availabilityTracker.retryAt('9001'), null);
}

async function main() {
  testSelectsProviderNewestCurrentAndPreviousAdmOnly();
  await testPersistsNumericProviderSecondsAsUtcTimestamp();
  await testIncrementalParserReadsOnlyCompleteAppendedBytes();
  await testIncrementalParserReturnsLatestCompleteOnlineSnapshot();
  await testIncompletePlayerListIsRetriedWithoutPublishingOlderSnapshot();
  await testMalformedNewestSnapshotEmitsInvalidation();
  await testMalformedNewestSnapshotIsNotPublished();
  await testExactServerSnapshotPublisherPersistsThenReplacesCache();
  await testLowLatencyPathPublishesCompleteOnlineSnapshot();
  await testAdminTuiSyncUsesExactServerCredentialAndLock();
  testAllRuntimeScanPathsShareExactServerLock();
  testBackendStartsDedicatedIngestionLoop();
  await testSyncsOnlyCurrentAndPreviousAdmForExactServer();
  await testStartsThirtySecondLoopAndRunsImmediately();
  await testLoadsOnlyExactActiveServersWithEnabledKillFeeds();
  await testPersistsAndReloadsExactGenerationCursor();
  await testHoldsDatabaseExactServerLockThroughParse();
  await testDoesNotOverlapTheSameExactServer();
  await testSkipsOverlappingTicksToPreserveGlobalBound();
  await testBoundsConcurrentExactServerIngestion();
  await testFailedParseRetriesUnchangedDownloadedGeneration();
  await testAdvancesOnlyIncrementalAdmCursorsAfterAppend();
  await testUsesReauthorizedProviderIdentityForParsing();
  await testNewKillDrainsExactServerFeedImmediately();
  await testRecordsHealthyPipelineCompletion();
  await testExpectedLockContentionDoesNotDegradePipeline();
  await testBacksOffUnavailableProviderLogStoragePerExactServer();
  console.log('low-latency ADM ingestion tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
