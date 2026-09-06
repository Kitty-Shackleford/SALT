'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  DEFAULT_OBJECT_SPAWNER_POLICY,
  normalizeObjectSpawnerConfig,
  buildManagedSpawnDefinition,
  appendSpawnDefinitions,
  removeManagedSpawnDefinitions,
  registerObjectSpawnerFile,
} = require('../services/objectSpawner');
const { OBJECT_SPAWNER_PRODUCTS_SQL } = require('../db/migrations/081_shop_object_spawner_products');
const shopFileService = require('../services/shopFileService');

function expectError(fn, pattern) {
  assert.throws(fn, pattern);
}

(async function run() {
  const config = normalizeObjectSpawnerConfig({
    file: 'custom/shops/walls.json',
    scale: 1.25,
    enableCEPersistency: true,
    customString: 'north gate',
  });
  assert.deepStrictEqual(config, {
    file: 'custom/shops/walls.json',
    scale: 1.25,
    enableCEPersistency: true,
    customString: 'north gate',
  });
  assert.deepStrictEqual(normalizeObjectSpawnerConfig(JSON.stringify(config)), config,
    'JSONB/string configuration must normalize through one contract');
  assert.strictEqual(
    shopFileService.normalizeEventObjectSpawnerComponent({
      name: 'Land_Wall_Gate_FenR', offset: [0, 0, 0],
    }).file,
    'custom/shop.json',
    'legacy event companions without a file must use the same path during planning and provisioning'
  );

  const entryId = 'DAYZ_DASHBOARD_SHOP_test-entry';
  const definition = buildManagedSpawnDefinition({
    name: 'Land_Wall_Gate_FenR',
    pos: [100, 12.5, 200],
    ypr: [90, 0, 0],
    ...config,
  }, entryId);
  assert.strictEqual(definition.name, 'Land_Wall_Gate_FenR');
  assert.deepStrictEqual(definition.pos, [100, 12.5, 200]);
  assert.deepStrictEqual(definition.ypr, [90, 0, 0]);
  assert.strictEqual(definition.scale, 1.25);
  assert.strictEqual(definition.enableCEPersistency, true);
  assert.strictEqual(typeof definition.customString, 'string');
  assert(!Object.prototype.hasOwnProperty.call(definition, '_shopEntryId'),
    'new Object Spawner output must use only official DayZ fields');

  const p3d = buildManagedSpawnDefinition({
    name: 'DZ/rocks/bliss/rock.p3d',
    pos: [0, 0, 0],
    ypr: [0, 0, 0],
  }, 'DAYZ_DASHBOARD_SHOP_p3d-entry');
  assert.strictEqual(p3d.name, 'DZ/rocks/bliss/rock.p3d');

  for (const invalidName of ['', '../tree.p3d', '/DZ/plants/tree.p3d',
    'DZ/animals/wolf.p3d', 'DZ/plants/../../tree.p3d', 'Land Wall']) {
    expectError(() => buildManagedSpawnDefinition({
      name: invalidName,
      pos: [0, 0, 0],
      ypr: [0, 0, 0],
    }, 'DAYZ_DASHBOARD_SHOP_invalid-entry'), /name|P3D|path/i);
  }
  expectError(() => buildManagedSpawnDefinition({
    name: 'Land_Wall_Gate_FenR', pos: [0, 0], ypr: [0, 0, 0],
  }, entryId), /position/i);
  expectError(() => buildManagedSpawnDefinition({
    name: 'Land_Wall_Gate_FenR', pos: [0, 0, 0], ypr: [0, Infinity, 0],
  }, entryId), /rotation/i);
  expectError(() => buildManagedSpawnDefinition({
    name: 'Land_Wall_Gate_FenR', pos: [0, 0, 0], ypr: [0, 0, 0], scale: 0,
  }, entryId), /scale/i);
  expectError(() => normalizeObjectSpawnerConfig({ customString: 'x'.repeat(1024) }), /customString/i);
  for (const unsafePath of [
    'custom/a\u0000.json',
    'custom/%2e%2e/escape.json',
    'custom/%2fescape.json',
  ]) {
    expectError(() => normalizeObjectSpawnerConfig({ file: unsafePath }), /safe mission-relative/i);
  }
  expectError(() => normalizeObjectSpawnerConfig({ enableCEPersistancy: true }), /unknown field/i);
  expectError(() => normalizeObjectSpawnerConfig({ unexpected: 'discarded' }), /unknown field/i);
  expectError(() => normalizeObjectSpawnerConfig({ file: 42 }), /file must be a string/i);
  expectError(() => normalizeObjectSpawnerConfig({ scale: '1' }), /scale must be a number/i);
  expectError(() => normalizeObjectSpawnerConfig({ customString: 42 }), /customString must be a string/i);

  const original = {
    Metadata: { owner: 'server' },
    Objects: [{ name: 'Land_Barn_Wood2', pos: [1, 2, 3], ypr: [0, 0, 0], scale: 1 }],
  };
  const appended = appendSpawnDefinitions(original, [definition]);
  assert.strictEqual(appended.Metadata.owner, 'server');
  assert.strictEqual(appended.Objects.length, 2);
  expectError(() => appendSpawnDefinitions(appended, [definition]), /duplicate/i);
  expectError(() => appendSpawnDefinitions({ Objects: [
    { name: 'Land_Barn_Wood2', pos: [1, 2, 3], ypr: [0, 0, 0], scale: 1 },
    { name: 'Land_Barn_Wood2', pos: [1, 2, 3], ypr: [0, 0, 0], scale: 1 },
  ] }, [definition]), /duplicate/i);
  for (const invalidExistingDefinition of [
    { name: 'Land_Barn_Wood2', pos: [1, 2, 3], ypr: [0, 0, 0], scale: '1' },
    { name: 'Land_Barn_Wood2', pos: [1, 2, 3], ypr: [0, 0, 0], scale: true },
    { name: 'Land_Barn_Wood2', pos: ['1', 2, 3], ypr: [0, 0, 0], scale: 1 },
    { name: 'Land_Barn_Wood2', pos: [1, 2, 3], ypr: ['0', 0, 0], scale: 1 },
    { name: 'Land_Barn_Wood2', pos: [1, 2, 3], ypr: [0, 0, 0], scale: 1, unexpected: true },
  ]) {
    expectError(() => appendSpawnDefinitions({ Objects: [invalidExistingDefinition] }, [definition]),
      /finite numbers|scale must be a number|unknown field/i);
  }
  expectError(() => appendSpawnDefinitions({ Objects: [
    { name: 'Land_Barn_Wood2', pos: [1, 2, 3], ypr: [0, 0, 0], scale: 'bad' },
  ] }, [definition]), /scale/i);
  expectError(() => appendSpawnDefinitions({ Objects: [
    { name: 'Land_Barn_Wood2', pos: [1, 2, 3], ypr: [0, 0, 0], enableCEPersistency: 'bad' },
  ] }, [definition]), /enableCEPersistency/i);
  const duplicateManagedId = buildManagedSpawnDefinition({
    name: 'Land_Barn_Wood2', pos: [9, 9, 9], ypr: [0, 0, 0],
  }, entryId);
  expectError(() => appendSpawnDefinitions(appended, [duplicateManagedId]), /duplicate managed/i);
  expectError(() => appendSpawnDefinitions({ Objects: new Array(DEFAULT_OBJECT_SPAWNER_POLICY.maxDefinitionsPerFile).fill({
    name: 'Land_Barn_Wood2', pos: [1, 2, 3], ypr: [0, 0, 0], scale: 1,
  }) }, [definition]), /limit/i);
  expectError(() => appendSpawnDefinitions({ nope: [] }, [definition]), /Objects/i);

  const removed = removeManagedSpawnDefinitions(appended, new Set([entryId]));
  assert.strictEqual(removed.Objects.length, 1);
  assert.strictEqual(removed.Metadata.owner, 'server');
  expectError(() => removeManagedSpawnDefinitions(removed, new Set([entryId])), /match/i);
  expectError(() => removeManagedSpawnDefinitions({ Objects: [
    { name: 'Land_Barn_Wood2', pos: [1, 2, 3], ypr: [0, 0, 0], scale: 'bad' },
    definition,
  ] }, new Set([entryId])), /scale/i);
  expectError(() => removeManagedSpawnDefinitions({ Objects: [
    { name: 'Land_Barn_Wood2', pos: [1, 2, 3], ypr: [0, 0, 0], enableCEPersistency: 'bad' },
    definition,
  ] }, new Set([entryId])), /enableCEPersistency/i);
  expectError(() => removeManagedSpawnDefinitions({ Objects: [
    { name: 'Land_Barn_Wood2', pos: [1, 2, 3], ypr: [0, 0, 0], scale: 1 },
    { name: 'Land_Barn_Wood2', pos: [1, 2, 3], ypr: [0, 0, 0], scale: 1 },
    definition,
  ] }, new Set([entryId])), /duplicate/i);
  expectError(() => removeManagedSpawnDefinitions({ Objects: [
    ...Array.from({ length: DEFAULT_OBJECT_SPAWNER_POLICY.maxDefinitionsPerFile + 1 }, (_, index) => ({
      name: 'Land_Barn_Wood2', pos: [index, 2, 3], ypr: [0, 0, 0], scale: 1,
    })),
    definition,
  ] }, new Set([entryId])), /limit/i);

  const legacy = removeManagedSpawnDefinitions({ Objects: [
    { name: 'Land_Wall_Gate_FenR', pos: [0, 0, 0], ypr: [0, 0, 0], _shopEntryId: entryId },
  ] }, new Set([entryId]));
  assert.deepStrictEqual(legacy.Objects, []);
  expectError(() => removeManagedSpawnDefinitions({ Objects: [{
    name: 'Land_Wall_Gate_FenR', pos: [0, 0, 0], ypr: [0, 0, 0],
    _shopEntryId: entryId,
    customString: JSON.stringify({ dayzDashboardShopEntryId: 'malformed-conflict' }),
  }] }, new Set([entryId])), /identifiers disagree/i);
  expectError(() => removeManagedSpawnDefinitions({ Objects: [{
    name: 'Land_Wall_Gate_FenR', pos: [1, 0, 0], ypr: [0, 0, 0],
    customString: JSON.stringify({ dayzDashboardShopEntryId: 'malformed-marker' }),
  }] }, new Set([entryId])), /invalid managed Object Spawner entry ID/i);
  expectError(() => removeManagedSpawnDefinitions({ Objects: [{
    name: 'Land_Wall_Gate_FenR', pos: [2, 0, 0], ypr: [0, 0, 0],
    _shopEntryId: 'malformed-marker',
  }] }, new Set([entryId])), /invalid managed Object Spawner entry ID/i);

  const gameplay = {
    GeneralData: { disableBaseDamage: true },
    WorldsData: { lightingConfig: 1, objectSpawnersArr: ['./custom/existing.json'] },
  };
  const registered = registerObjectSpawnerFile(gameplay, 'custom/shops/walls.json');
  assert.deepStrictEqual(registered.WorldsData.objectSpawnersArr, [
    './custom/existing.json', './custom/shops/walls.json',
  ]);
  const registeredAgain = registerObjectSpawnerFile(registered, './custom/shops/walls.json');
  assert.deepStrictEqual(registeredAgain.WorldsData.objectSpawnersArr, registered.WorldsData.objectSpawnersArr);
  for (const invalidRegistration of [42, '../escape.json', './custom/%2fescape.json']) {
    expectError(() => registerObjectSpawnerFile({
      WorldsData: { objectSpawnersArr: [invalidRegistration] },
    }, 'custom/shop.json'), /string|safe mission-relative/i);

    const uploads = [];
    const fileService = {
      downloadFileFromServer: async () => JSON.stringify({
        WorldsData: { objectSpawnersArr: ['custom/shop.json', invalidRegistration] },
      }),
      uploadFileToServer: async (...args) => uploads.push(args),
    };
    await assert.rejects(
      shopFileService.ensureObjectSpawnerRegistered(
        'test-server', 'test-token', '/mission', 'custom/shop.json', fileService
      ),
      /string|safe mission-relative/i
    );
    assert.deepStrictEqual(uploads, [], 'invalid existing registrations must prevent every upload');
  }
  expectError(() => registerObjectSpawnerFile({}, 'custom/shop.json'), /objectSpawnersArr/i);

  assert.match(OBJECT_SPAWNER_PRODUCTS_SQL, /shop_items\s+ADD COLUMN IF NOT EXISTS object_spawner_config JSONB/i);
  assert.match(OBJECT_SPAWNER_PRODUCTS_SQL, /shop_order_items\s+ADD COLUMN IF NOT EXISTS object_spawner_config_snapshot JSONB/i);
  const disableRetentionIndex = OBJECT_SPAWNER_PRODUCTS_SQL.indexOf(
    'ALTER TABLE shop_order_items DISABLE TRIGGER retain_shop_order_items_update'
  );
  const orderItemBackfillIndex = OBJECT_SPAWNER_PRODUCTS_SQL.indexOf('UPDATE shop_order_items');
  const enableRetentionIndex = OBJECT_SPAWNER_PRODUCTS_SQL.indexOf(
    'ALTER TABLE shop_order_items ENABLE TRIGGER retain_shop_order_items_update'
  );
  assert.ok(disableRetentionIndex >= 0 && disableRetentionIndex < orderItemBackfillIndex,
    'migration must suspend the retention trigger before its controlled snapshot backfill');
  assert.ok(enableRetentionIndex > orderItemBackfillIndex,
    'migration must restore the retention trigger after its controlled snapshot backfill');
  assert.match(OBJECT_SPAWNER_PRODUCTS_SQL, /spawn_method = 'custom_json'/i,
    'legacy custom_json rows must receive canonical Object Spawner defaults');
  assert.match(OBJECT_SPAWNER_PRODUCTS_SQL, /COALESCE\(NULLIF\(custom_json_file(?:_snapshot)?, ''\), 'custom\/shop\.json'\)/,
    'legacy rows with no stored path must retain the historical custom/shop.json location');
  assert.deepStrictEqual(
    shopFileService.collectShopCheckoutFilePaths('/mission', [{
      spawn_method: 'custom_json', custom_json_file: null, object_spawner_config: null,
    }]),
    ['/mission/custom/shop.json', '/mission/cfggameplay.json', '/mission/cfgGameplay.json'],
    'legacy null-path catalog rows must still target the historical Object Spawner file'
  );
  expectError(() => shopFileService.assertObjectSpawnerCheckoutLimit(
    Array.from({ length: DEFAULT_OBJECT_SPAWNER_POLICY.maxDefinitionsPerCheckout + 1 }, () => ({
      spawn_method: 'custom_json', quantity: 1,
    }))
  ), /limit/i);
  const shopServiceSource = fs.readFileSync(path.join(__dirname, '../services/shopFileService.js'), 'utf8');
  assert.doesNotMatch(shopServiceSource, /objects\.map\(entry => entry\?\._shopEntryId\)/,
    'integrated cleanup must not prefilter only the legacy undocumented ownership field');

  const adminHtml = fs.readFileSync(path.join(__dirname, '../public/dashboard/shop-admin.html'), 'utf8');
  const adminJs = fs.readFileSync(path.join(__dirname, '../public/js/shop-admin.js'), 'utf8');
  assert.match(adminHtml, /option value="custom_json"[^>]*>Object Spawner/);
  assert.match(adminHtml, /id="object-spawner-config"/);
  assert.match(adminJs, /object_spawner_config/);

  console.log('Object Spawner module tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
