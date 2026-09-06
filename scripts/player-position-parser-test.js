'use strict';

const assert = require('assert');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = '0'.repeat(64);
const { parseADMFileStream } = require('../routes/logParser');

(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dayz-position-'));
  const file = path.join(dir, 'test.ADM');
  try {
    await fs.writeFile(file, [
      '12:00:00 | ##### PlayerList log: 1 players',
      '12:00:00 | Player "CoordinateTest" (id=test-id pos=<-10.5, -2.25, 120.75>)',
      '12:00:00 | #### PlayerList log end',
      '12:01:00 | Player "HealthTest" (id=health-id pos=<-1.5, -2.5, 3.5>)[HP: 93.5]',
      '12:02:00 | Player "EmoteTest" (id=emote-id pos=<-4.5, -5.5, 6.5>) performed wave',
      '12:03:00 | Player "DeathTest" (DEAD) (id=death-id pos=<-7.5, -8.5, 9.5>) bled out',
    ].join('\n'));
    const parsed = await parseADMFileStream(file, new Date('2026-08-31T00:00:00Z'));
    assert.strictEqual(parsed.positionSnapshots.length, 1,
      'PlayerList snapshots must accept signed decimal coordinates');
    assert.deepStrictEqual(
      [parsed.positionSnapshots[0].posX, parsed.positionSnapshots[0].posY, parsed.positionSnapshots[0].posZ],
      [-10.5, -2.25, 120.75]
    );
    assert.deepStrictEqual(
      [parsed.healthUpdates[0].posX, parsed.healthUpdates[0].posY, parsed.healthUpdates[0].posZ],
      [-1.5, -2.5, 3.5],
      'health locations must accept signed decimal coordinates'
    );
    assert.deepStrictEqual(
      [parsed.emoteEvents[0].posX, parsed.emoteEvents[0].posY, parsed.emoteEvents[0].posZ],
      [-4.5, -5.5, 6.5],
      'emote locations must accept signed decimal coordinates'
    );
    assert.deepStrictEqual(
      [parsed.deathEvents[0].posX, parsed.deathEvents[0].posY, parsed.deathEvents[0].posZ],
      [-7.5, -8.5, 9.5],
      'death locations must accept signed decimal coordinates'
    );
    console.log('player position parser tests passed');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
