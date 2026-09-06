'use strict';

const assert = require('assert');
const {
  normalizeDestination,
  normalizeTriggerSize,
  buildPraFile,
  praFilePath,
  parseDisconnectPosition,
  registerPraPath,
  unregisterPraPath,
} = require('../utils/teleportPolicy');

assert.deepStrictEqual(normalizeDestination({
  name: 'Trader Outpost',
  mapName: 'chernarusplus',
  position: [1234.5, 42, 6789.25],
  destinationType: 'punishment',
  isPrivate: true,
}), {
  name: 'Trader Outpost',
  mapName: 'chernarusplus',
  position: [1234.5, 42, 6789.25],
  destinationType: 'punishment',
  isPrivate: true,
});
assert.deepStrictEqual(normalizeDestination({
  name: 'Public Outpost', mapName: 'sakhal', position: [1, 2, 3],
}), {
  name: 'Public Outpost', mapName: 'sakhal', position: [1, 2, 3],
  destinationType: 'named', isPrivate: false,
});

assert.deepStrictEqual(normalizeTriggerSize(), [1.25, 2.5, 1.25]);
assert.deepStrictEqual(normalizeTriggerSize([1, 3, 1]), [1, 3, 1]);
assert.throws(() => normalizeTriggerSize([0, 2, 1]), /trigger size/i);
assert.throws(() => normalizeDestination({
  name: 'Bad', mapName: 'sakhal', position: [1, Number.NaN, 2],
}), /position/i);
assert.throws(() => normalizeDestination({
  name: 'Outside Sakhal', mapName: 'sakhal', position: [15361, 2, 3],
}), /outside the map bounds/i);
assert.throws(() => normalizeDestination({
  name: 'Unsupported', mapName: 'namalsk', position: [100, 2, 100],
}), /map bounds are unavailable/i);
assert.throws(() => normalizeDestination({
  name: 'Bad', mapName: '../sakhal', position: [1, 2, 3],
}), /map/i);
assert.throws(() => normalizeDestination({
  name: 'Bad', mapName: 'sakhal', position: [1, 2, 3], destinationType: 'unknown',
}), /type/i);
assert.throws(() => normalizeDestination({
  name: 'Bad', mapName: 'sakhal', position: [1, 2, 3], isPrivate: 'true',
}), /privacy/i);

assert.strictEqual(praFilePath(42), 'pra/dayz-dashboard-teleport-42.json');
assert.throws(() => praFilePath('../42'), /request ID/i);

assert.deepStrictEqual(buildPraFile({
  requestId: 42,
  sourcePosition: [100, 20, 200],
  destinationPosition: [300, 10, 400],
}), {
  areaName: 'DayZDashboardTeleport42',
  PRABoxes: [[
    [1.25, 2.5, 1.25],
    [0, 0, 0],
    [100, 20, 200],
  ]],
  safePositions3D: [[300, 10, 400]],
});

assert.deepStrictEqual(parseDisconnectPosition(
  '12:34:56 | Player "Kitty" (id=abc_123 pos=<100.5, 20, -200.25>) has been disconnected',
  '2026-08-31'
), {
  timestamp: '2026-08-31T12:34:56.000Z',
  playerGamertag: 'Kitty',
  platformUserId: 'abc_123',
  position: [100.5, 20, -200.25],
});
assert.strictEqual(parseDisconnectPosition(
  '12:34:56 | Player "Kitty" (id=abc_123) has been disconnected',
  '2026-08-31'
), null);

const gameplay = {
  version: 123,
  WorldsData: { playerRestrictedAreaFiles: ['pra/warheadstorage.json'] },
};
assert.deepStrictEqual(registerPraPath(gameplay, 'pra/dayz-dashboard-teleport-42.json'), {
  version: 123,
  WorldsData: {
    playerRestrictedAreaFiles: [
      'pra/warheadstorage.json',
      'pra/dayz-dashboard-teleport-42.json',
    ],
  },
});
assert.strictEqual(registerPraPath(gameplay, 'pra/warheadstorage.json')
  .WorldsData.playerRestrictedAreaFiles.length, 1);
const registered = registerPraPath(gameplay, 'pra/dayz-dashboard-teleport-42.json');
assert.deepStrictEqual(unregisterPraPath(registered, 'pra/dayz-dashboard-teleport-42.json'), gameplay);
assert.deepStrictEqual(unregisterPraPath(gameplay, 'pra/dayz-dashboard-teleport-42.json'), gameplay);
assert.throws(() => registerPraPath({}, 'pra/test.json'), /WorldsData/i);

console.log('✅ Teleport policy tests passed');
