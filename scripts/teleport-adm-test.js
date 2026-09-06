'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);
const logParserSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'logParser.js'), 'utf8');
assert.match(logParserSource, /markTeleportArrivals/);
assert.match(logParserSource, /processTeleportCleanups/);
const arrivalStep = logParserSource.lastIndexOf('markTeleportArrivals(');
const cleanupStep = logParserSource.lastIndexOf('processTeleportCleanups(');
const waitingStep = logParserSource.lastIndexOf('processWaitingTeleports(');
assert(arrivalStep > 0 && cleanupStep > arrivalStep && waitingStep > cleanupStep);
const { parseADMFileStream, saveDisconnectPositions } = require('../routes/logParser');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teleport-adm-'));
  const file = path.join(dir, 'DayZServer_X1_2026-08-31_12-00-00.ADM');
  fs.writeFileSync(file,
    '12:34:56 | Player "Kitty" (id=abc_123 pos=<100.5, 20, -200.25>) has been disconnected\n');
  try {
    const parsed = await parseADMFileStream(file, '2026-08-31', { fullHistory: true });
    assert.deepStrictEqual(parsed.disconnectPositions, [{
      timestamp: '2026-08-31T12:34:56Z',
      playerGamertag: 'Kitty',
      platformUserId: 'abc_123',
      posX: 100.5,
      posY: 20,
      posZ: -200.25,
      sourceFile: path.basename(file),
    }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const writes = [];
  const db = {
    async get(sql) {
      if (/FROM servers/.test(sql)) return { id: 1 };
      throw new Error(`Unexpected get: ${sql}`);
    },
    async all(sql) {
      if (/FROM player_identities/.test(sql)) return [{ platform_user_id: 'abc_123', id: 5 }];
      throw new Error(`Unexpected all: ${sql}`);
    },
    async run(sql, params) {
      writes.push({ sql, params });
      return { changes: 1 };
    },
  };
  const saved = await saveDisconnectPositions(db, 'service-1', [{
    timestamp: '2026-08-31T12:34:56Z', playerGamertag: 'Kitty',
    platformUserId: 'abc_123', posX: 100.5, posY: 20, posZ: -200.25,
    sourceFile: 'server.ADM',
  }], 'xbox', 1);
  assert.strictEqual(saved, 1);
  assert.strictEqual(writes.length, 1);
  assert.match(writes[0].sql, /INSERT INTO player_disconnect_positions/);
  assert.match(writes[0].sql, /server_player_memberships/);

  console.log('✅ Teleport ADM parsing tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
