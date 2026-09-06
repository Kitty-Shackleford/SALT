#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { XMLValidator } = require('fast-xml-parser');
const shop = require('../services/shopFileService');

const repoRoot = path.join(__dirname, '..');
const fixtureRoot = path.join(repoRoot, 'bin', 'dayzOffline.chernarusplus');
const missionDir = '/fixture';
const files = new Map();

function load(remotePath, relativePath) {
  files.set(remotePath, fs.readFileSync(path.join(fixtureRoot, relativePath), 'utf8'));
}

load(missionDir + '/cfgEffectArea.json', 'cfgEffectArea.json');
load(missionDir + '/custom/shop.json', 'custom/skalislandfull.json');
load(missionDir + '/cfggameplay.json', 'cfggameplay.json');
load(missionDir + '/cfgeventgroups.xml', 'cfgeventgroups.xml');
load(missionDir + '/cfgeventspawns.xml', 'cfgeventspawns.xml');
load(missionDir + '/cfgeconomycore.xml', 'cfgeconomycore.xml');

const fileService = {
  downloadFileFromServer: async (_serverId, remotePath) => files.has(remotePath) ? files.get(remotePath) : null,
  uploadFileToServer: async (_serverId, dir, name, content) => files.set(dir + '/' + name, content),
};

async function main() {
  const x = 4169.9641;
  const y = 0;
  const z = 10728.7067;
  const eventName = 'StaticFixtureShopEvent';
  const groupName = eventName + '_Group';

  await shop.appendEffectAreaEntries('fixture-server', 'fixture-token', missionDir, [
    shop.buildEffectAreaEntry({ entryId: 'DAYZ_DASHBOARD_SHOP_fixture_effect', itemClass: 'Flag_APA', posX: x, posY: y, posZ: z }),
  ], fileService);
  const effectRoot = JSON.parse(files.get(missionDir + '/cfgEffectArea.json'));
  const areas = Array.isArray(effectRoot) ? effectRoot : effectRoot.Areas;
  assert.deepStrictEqual(areas.at(-1).Data.Pos, [x, y, z]);

  await shop.ensureObjectSpawnerRegistered('fixture-server', 'fixture-token', missionDir, 'custom/shop.json', fileService);
  await shop.appendCustomJsonEntries('fixture-server', 'fixture-token', missionDir + '/custom/shop.json', [
    shop.buildObjectSpawnerEntry({ entryId: 'DAYZ_DASHBOARD_SHOP_fixture_object', itemClass: 'AKM', posX: x, posY: y, posZ: z, yaw: 90, pitch: 0, roll: 0 }),
  ], fileService);
  const gameplay = JSON.parse(files.get(missionDir + '/cfggameplay.json'));
  assert(gameplay.WorldsData.objectSpawnersArr.some(entry => entry.replace(/^\.\//, '') === 'custom/shop.json'));
  const objects = JSON.parse(files.get(missionDir + '/custom/shop.json')).Objects;
  assert.deepStrictEqual(objects.at(-1).pos, [x, y, z]);

  await shop.ensureShopEventGroupDefinition('fixture-server', 'fixture-token', missionDir, groupName, [
    { type: 'Land_Wreck_C130J', x: 0, y: 0, z: 0, a: 0, deloot: 10, lootmin: 4, lootmax: 8 },
    { type: 'AKM', x: 1.5, y: 0, z: -2, a: 90, spawnsecondary: false },
  ], fileService);
  await shop.ensureCfgEconomyCoreShopEntry('fixture-server', 'fixture-token', missionDir, fileService);
  await shop.ensureShopEventDefinition('fixture-server', 'fixture-token', missionDir, eventName, 'AKM', {
    eventGroupChildren: [{ type: 'AKM', x: 0, y: 0, z: 0, a: 0 }],
    secondary: 'InfectedIndustrial',
  }, { itemName: 'Fixture bundle' }, fileService);
  await shop.addEventSpawnPosition('fixture-server', 'fixture-token', missionDir, eventName, x, z, 90, y, fileService, { group: groupName });

  for (const remotePath of [
    missionDir + '/cfgeventgroups.xml',
    missionDir + '/cfgeventspawns.xml',
    missionDir + '/cfgeconomycore.xml',
    missionDir + '/custom/shop_events.xml',
  ]) {
    assert.strictEqual(XMLValidator.validate(files.get(remotePath)), true, remotePath + ' became invalid XML');
  }
  assert(files.get(missionDir + '/cfgeventgroups.xml').includes('name="' + groupName + '"'));
  assert(files.get(missionDir + '/cfgeventspawns.xml').includes('group="' + groupName + '"'));
  assert(files.get(missionDir + '/custom/shop_events.xml').includes('<secondary>InfectedIndustrial</secondary>'));

  console.log('✅ Shop mission fixture composition passed (no provider writes)');
}

main().catch(error => {
  console.error('❌ Shop mission fixture test failed:', error.message);
  process.exitCode = 1;
});
