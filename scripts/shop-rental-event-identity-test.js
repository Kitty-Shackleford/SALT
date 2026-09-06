/*
 * Regression coverage for per-purchase CE rental event identity.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const shopFileService = require('../services/shopFileService');

async function main() {
  assert.strictEqual(
    typeof shopFileService.assignPurchaseEventNames,
    'function',
    'checkout must expose per-purchase rental event assignment'
  );

  const updates = [];
  const db = {
    query: async (sql, params) => {
      updates.push({ sql, params });
      return [];
    },
  };
  const items = [
    { id: 139, spawn_method: 'event', item_type: 'event_rental', event_name: 'VehicleOlgaabc123' },
    { id: 140, spawn_method: 'event', item_type: 'event_rental', event_name: 'VehicleOlgaabc123' },
    { id: 141, spawn_method: 'event', item_type: 'permanent', event_name: 'ItemTentdef456' },
  ];

  await shopFileService.assignPurchaseEventNames(db, items);

  assert.strictEqual(items[0].event_name, 'VehicleRental139');
  assert.strictEqual(items[1].event_name, 'VehicleRental140');
  assert.notStrictEqual(items[0].event_name, items[1].event_name);
  assert.strictEqual(items[2].event_name, 'ItemTentdef456');
  assert.deepStrictEqual(
    updates.map(update => update.params),
    [['VehicleRental139', 139], ['VehicleRental140', 140]],
    'each rental order line must persist its unique event snapshot'
  );
  assert(updates.every(update =>
    update.sql.includes('UPDATE shop_order_items') &&
    update.sql.includes('event_name_snapshot = $1') &&
    update.sql.includes('WHERE id = $2')
  ));

  const invalidItems = [
    { id: 142, spawn_method: 'event', item_type: 'event_rental', event_name: 'UnsupportedName' },
  ];
  await assert.rejects(
    () => shopFileService.assignPurchaseEventNames(db, invalidItems),
    /supported DayZ CE spawner type/
  );

  assert.strictEqual(
    typeof shopFileService.assertEventRentalPlacementsAvailable,
    'function',
    'checkout must expose event-rental placement collision validation'
  );
  const eventConfig = {
    saferadius: 10,
    distanceradius: 10,
    cleanupradius: 10,
    placement_clearance: 10,
  };
  const placementDbCalls = [];
  const placementDb = {
    query: async (sql, params) => {
      placementDbCalls.push({ sql, params });
      return [{
        id: 500,
        pos_x: '100',
        pos_z: '100',
        event_config: eventConfig,
      }];
    },
  };
  const rentalAt = (id, x, z) => ({
    id,
    spawn_method: 'event',
    item_type: 'event_rental',
    pos_x: x,
    pos_z: z,
    event_config: eventConfig,
  });
  await assert.rejects(
    () => shopFileService.assertEventRentalPlacementsAvailable(
      { query: async () => [] }, 42, [rentalAt(501, 0, 0), rentalAt(502, 15, 0)]
    ),
    /too close to another active rental/
  );
  await assert.rejects(
    () => shopFileService.assertEventRentalPlacementsAvailable(
      placementDb, 42, [rentalAt(501, 115, 100)]
    ),
    /too close to another active rental/
  );
  await shopFileService.assertEventRentalPlacementsAvailable(
    placementDb, 42, [rentalAt(501, 121, 100)]
  );
  const ceRadiusOnlyConfig = { saferadius: 100, distanceradius: 100, cleanupradius: 100 };
  await shopFileService.assertEventRentalPlacementsAvailable({
    query: async () => [{
      id: 600, pos_x: 100, pos_z: 100, event_config: ceRadiusOnlyConfig,
    }],
  }, 42, [{
    ...rentalAt(601, 101, 100),
    event_config: ceRadiusOnlyConfig,
  }]);
  await assert.rejects(
    () => shopFileService.assertEventRentalPlacementsAvailable(
      { query: async () => [] },
      42,
      [
        { ...rentalAt(602, 0, 0), event_config: ceRadiusOnlyConfig },
        { ...rentalAt(603, 0, 0), event_config: ceRadiusOnlyConfig },
      ]
    ),
    /too close to another active rental/,
    'exact coordinate overlap must remain forbidden without configured clearance'
  );
  assert(placementDbCalls.every(call => call.params[0] === 42));
  assert(placementDbCalls.every(call =>
    /so\.server_id = \$1/.test(call.sql) &&
    /so\.status = 'completed'/.test(call.sql) &&
    /soi\.is_active = TRUE/.test(call.sql)
  ), 'placement collision lookup must use active completed rentals on the exact server');
  const adminClientSource = fs.readFileSync(
    path.join(__dirname, '../public/js/shop-admin.js'), 'utf8'
  );
  const adminPageSource = fs.readFileSync(
    path.join(__dirname, '../public/dashboard/shop-admin.html'), 'utf8'
  );
  assert.match(adminClientSource, /placement_clearance:\s+parseInt\(document\.getElementById\('ec-placement-clearance'\)/);
  assert.match(adminPageSource, /id="ec-placement-clearance"/);

  const serviceSource = fs.readFileSync(
    path.join(__dirname, '../services/shopFileService.js'),
    'utf8'
  );
  const checkoutSource = serviceSource.slice(
    serviceSource.indexOf('async function processCheckout'),
    serviceSource.indexOf('// Rental expiry')
  );
  const assignment = checkoutSource.indexOf('await assignPurchaseEventNames(db, fileItems);');
  const placementCheck = checkoutSource.indexOf(
    'await assertEventRentalPlacementsAvailable(db, order.server_id, fileItems);'
  );
  const insufficientFunds = checkoutSource.indexOf('if (bankBal < bankDeduct)');
  const deductions = checkoutSource.indexOf('// Deduct currency');
  const eventGrouping = checkoutSource.indexOf("const byMethod = { cfgEffectArea: [], custom_json: {}, event: {} }");
  assert(assignment >= 0, 'checkout does not assign per-purchase rental event names');
  assert(placementCheck >= 0 && placementCheck < deductions,
    'event rental placement conflicts must be rejected before currency deductions');
  assert(assignment > insufficientFunds, 'failed checkout mutates rental event snapshots before confirming funds');
  assert(assignment < deductions, 'rental event snapshots are not persisted before currency deductions');
  assert(assignment < eventGrouping, 'checkout groups rental events before assigning purchase identity');

  assert.strictEqual(
    typeof shopFileService.assertPurchaseEventNamesAvailable,
    'function',
    'checkout must reject purchase event names that collide with base mission events'
  );
  const collisionProvider = {
    downloadFileFromServer: async (_serverId, filePath) => {
      if (filePath.endsWith('/db/events.xml')) {
        return '<events><event name="VehicleRental139"><nominal>1</nominal></event></events>';
      }
      if (filePath.endsWith('/cfgeconomycore.xml')) return '<economycore/>';
      return null;
    },
  };
  await assert.rejects(
    () => shopFileService.assertPurchaseEventNamesAvailable(
      'provider-server',
      'token',
      '/mission',
      [{ id: 139, spawn_method: 'event', item_type: 'event_rental', event_name: 'VehicleRental139' }],
      collisionProvider
    ),
    /conflicts with an existing mission event/
  );

  const extensionProvider = {
    downloadFileFromServer: async (_serverId, filePath) => {
      if (filePath.endsWith('/db/events.xml')) return '<events/>';
      if (filePath.endsWith('/custom/shop_events.xml')) return '<events/>';
      if (filePath.endsWith('/cfgeconomycore.xml')) {
        return '<economycore><ce folder="custom"><file name="seasonal_events.xml" type="events"/></ce></economycore>';
      }
      if (filePath.endsWith('/custom/seasonal_events.xml')) {
        return '<events><event name="VehicleRental139"><nominal>1</nominal></event></events>';
      }
      return null;
    },
  };
  await assert.rejects(
    () => shopFileService.assertPurchaseEventNamesAvailable(
      'provider-server',
      'token',
      '/mission',
      [{ id: 139, spawn_method: 'event', item_type: 'event_rental', event_name: 'VehicleRental139' }],
      extensionProvider
    ),
    /conflicts with an existing mission event/
  );

  const missingRegisteredProvider = {
    downloadFileFromServer: async (_serverId, filePath) => {
      if (filePath.endsWith('/db/events.xml')) return '<events/>';
      if (filePath.endsWith('/custom/shop_events.xml')) return '<events/>';
      if (filePath.endsWith('/cfgeconomycore.xml')) {
        return '<economycore><ce folder="custom"><file name="rotation_events.xml" type="events"/></ce></economycore>';
      }
      if (filePath.endsWith('/custom/rotation_events.xml')) return null;
      throw new Error('Unexpected provider path: ' + filePath);
    },
  };
  await shopFileService.assertPurchaseEventNamesAvailable(
    'provider-server',
    'token',
    '/mission',
    [{ id: 139, spawn_method: 'event', item_type: 'event_rental', event_name: 'VehicleRental139' }],
    missingRegisteredProvider
  );

  const installedPurchaseProvider = {
    downloadFileFromServer: async (_serverId, filePath) => {
      if (filePath.endsWith('/db/events.xml')) return '<events/>';
      if (filePath.endsWith('/custom/shop_events.xml')) {
        return '<events><event name="VehicleRental139"><nominal>1</nominal></event></events>';
      }
      if (filePath.endsWith('/cfgeconomycore.xml')) return '<economycore/>';
      return null;
    },
  };
  await shopFileService.assertPurchaseEventNamesAvailable(
    'provider-server',
    'token',
    '/mission',
    [{ id: 139, spawn_method: 'event', item_type: 'event_rental', event_name: 'VehicleRental139' }],
    installedPurchaseProvider,
    { allowShopPurchaseNames: true }
  );

  const journalCreation = checkoutSource.indexOf('fileJournal = createFileMutationJournal(');
  const collisionChecks = checkoutSource.match(/assertPurchaseEventNamesAvailable\(/g) || [];
  assert(journalCreation !== -1 && journalCreation < assignment, 'provider collision baseline is not captured by the mutation journal');
  assert(collisionChecks.length === 2, 'checkout does not revalidate provider collision sources after writing');
  assert(checkoutSource.includes(
    'platformServerId, token, missionDir, fileItems, fileJournal, { allowShopPurchaseNames: true }'
  ), 'post-write collision validation does not use the mutation journal');
  const shopRouteSource = fs.readFileSync(path.join(__dirname, '../routes/shop.js'), 'utf8');
  assert.match(
    shopRouteSource,
    /err\.code === 'SHOP_PLACEMENT_CONFLICT'[\s\S]*?status\(409\)/,
    'placement conflicts must return an actionable checkout conflict instead of HTTP 500'
  );

  console.log('Shop rental event identity regression test passed.');
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
