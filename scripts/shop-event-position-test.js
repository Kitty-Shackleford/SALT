'use strict';

const assert = require('assert');
const { XMLValidator } = require('fast-xml-parser');
const shop = require('../services/shopFileService');

async function main() {
  const missionDir = '/mission';
  let uploaded = null;
  const fileService = {
    async downloadFileFromServer() {
      return '<?xml version="1.0" encoding="UTF-8"?><eventposdef></eventposdef>';
    },
    async uploadFileToServer(_serverId, _directory, _name, content) {
      uploaded = content;
    },
  };

  assert.deepStrictEqual(
    shop.buildEventSpawnPosition({ posX: 1, posY: 0, posZ: 2, yaw: 90 }),
    { x: 1, z: 2, a: 90 },
    'surface-snapped CE events must omit the optional y attribute'
  );
  assert.deepStrictEqual(
    shop.buildEventSpawnPosition({ posX: 1, posY: 123.5, posZ: 2, yaw: 90 }),
    { x: 1, z: 2, a: 90, y: 123.5 },
    'non-zero explicit CE elevation must be preserved'
  );

  const entryId = await shop.addEventSpawnPosition(
    'server', 'token', missionDir, 'VehicleTest', 1, 2, 90, 0, fileService
  );
  assert.strictEqual(XMLValidator.validate(uploaded), true, 'generated event positions must be valid XML');
  assert.match(uploaded, /<pos\b[^>]*x="1"[^>]*z="2"[^>]*a="90"[^>]*\/>/,
    'event positions must use vanilla-style self-closing pos tags');
  assert.ok(!uploaded.includes(' y="0"'), 'surface-snapped event positions must not serialize y="0"');
  assert.ok(!/<pos\b[^>]*><\/pos>/.test(uploaded), 'event positions must not use paired closing tags');
  assert.deepStrictEqual(JSON.parse(entryId), { event: 'VehicleTest', x: 1, z: 2, a: 90 },
    'cleanup metadata must match the attributes actually written');

  const elevatedEntryId = await shop.addEventSpawnPosition(
    'server', 'token', missionDir, 'VehicleElevated', 3, 4, 180, 123.5, fileService
  );
  assert.match(uploaded, /<pos\b[^>]*x="3"[^>]*z="4"[^>]*a="180"[^>]*y="123\.5"[^>]*\/>/,
    'a non-zero explicit elevation must be serialized on the self-closing position');
  assert.deepStrictEqual(JSON.parse(elevatedEntryId),
    { event: 'VehicleElevated', x: 3, z: 4, a: 180, y: 123.5 });

  console.log('shop event position contract test passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
