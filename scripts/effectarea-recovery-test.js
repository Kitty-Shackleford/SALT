#!/usr/bin/env node
'use strict';

const assert = require('assert');

function fixture(overrides = {}) {
  const entries = [
    {
      AreaName: 'ContaminatedArea_One',
      Type: 'ContaminatedArea_Static',
      Data: { Pos: [1, 0, 2], Radius: 100 },
    },
    {
      AreaName: 'LEGACY_SHOP_alpha',
      _shopEntryId: 'LEGACY_SHOP_alpha',
      Type: 'Land_Barn_Wood1',
      Data: { Pos: [10, 0, 20], Radius: 1 },
    },
    {
      AreaName: 'LEGACY_SHOP_beta',
      _shopEntryId: 'LEGACY_SHOP_beta',
      Type: 'Land_Shed_W4',
      Data: { Pos: [30, 0, 40], Radius: 1 },
    },
  ];
  return {
    server: { id: 7, platformServerId: '15580969' },
    effectAreaContent: JSON.stringify({ Areas: entries, SafePositions: [[100, 0, 100]] }, null, 2),
    orderLines: [
      {
        id: 101,
        order_id: 501,
        server_id: 7,
        identity_id: 801,
        order_status: 'completed',
        is_active: true,
        spawn_method: 'cfgEffectArea',
        file_entry_id: 'LEGACY_SHOP_alpha',
        quantity: 1,
        unit_price: '12.34',
        snapshot_schema_version: 1,
        item_class_snapshot: 'Land_Barn_Wood1',
        order_line_count: 2,
      },
      {
        id: 102,
        order_id: 502,
        server_id: 7,
        identity_id: 802,
        order_status: 'completed',
        is_active: true,
        spawn_method: 'cfgEffectArea',
        file_entry_id: 'LEGACY_SHOP_beta',
        quantity: 1,
        unit_price: '20.00',
        snapshot_schema_version: 1,
        item_class_snapshot: 'Land_Shed_W4',
        order_line_count: 1,
      },
    ],
    ...overrides,
  };
}

function expectFailure(buildRecoveryManifest, input, pattern) {
  assert.throws(() => buildRecoveryManifest(input), pattern);
}

function main() {
  const { buildRecoveryManifest } = require('../services/effectAreaRecoveryService');

  const first = buildRecoveryManifest(fixture());
  const second = buildRecoveryManifest(fixture({
    orderLines: [...fixture().orderLines].reverse(),
  }));

  assert.strictEqual(first.manifest.schemaVersion, 1);
  assert.strictEqual(first.manifest.serverId, 7);
  assert.strictEqual(first.manifest.providerServiceId, '15580969');
  assert.strictEqual(first.manifest.lines.length, 2);
  assert.deepStrictEqual(first.manifest.lines.map(line => line.orderItemId), [101, 102]);
  assert.deepStrictEqual(first.manifest.lines.map(line => line.lineAmountCents), [1234, 2000]);
  assert.strictEqual(first.manifest.providerFileHash.length, 64);
  assert.strictEqual(first.manifestHash.length, 64);
  assert.strictEqual(first.manifestHash, second.manifestHash, 'manifest hash must not depend on row order');
  assert.deepStrictEqual(first.summary, {
    serverId: 7,
    affectedLineCount: 2,
    affectedOrderCount: 2,
    affectedIdentityCount: 2,
    mixedOrderCount: 1,
    affectedAmount: '32.34',
    providerFileHash: first.manifest.providerFileHash,
    manifestHash: first.manifestHash,
  });
  const publicText = JSON.stringify(first.summary);
  for (const forbidden of ['identityId', 'position', 'coordinate', 'token', 'providerPath']) {
    assert(!publicText.toLowerCase().includes(forbidden.toLowerCase()), `summary leaked ${forbidden}`);
  }

  const base = fixture();
  expectFailure(buildRecoveryManifest, {
    ...base,
    orderLines: [base.orderLines[0], { ...base.orderLines[1], id: 101 }],
  }, /duplicate order item/i);
  expectFailure(buildRecoveryManifest, {
    ...base,
    orderLines: [
      base.orderLines[0],
      { ...base.orderLines[1], file_entry_id: 'LEGACY_SHOP_alpha', item_class_snapshot: 'Land_Barn_Wood1' },
    ],
  }, /duplicate provider entry/i);
  expectFailure(buildRecoveryManifest, {
    ...base,
    orderLines: [{ ...base.orderLines[0], server_id: 8 }, base.orderLines[1]],
  }, /exact server/i);
  expectFailure(buildRecoveryManifest, {
    ...base,
    orderLines: [{ ...base.orderLines[0], order_status: 'refunded' }, base.orderLines[1]],
  }, /completed order/i);
  expectFailure(buildRecoveryManifest, {
    ...base,
    orderLines: [{ ...base.orderLines[0], is_active: false }, base.orderLines[1]],
  }, /active order line/i);
  expectFailure(buildRecoveryManifest, {
    ...base,
    orderLines: [{ ...base.orderLines[0], spawn_method: 'event' }, base.orderLines[1]],
  }, /cfgeffectarea/i);
  expectFailure(buildRecoveryManifest, {
    ...base,
    orderLines: [{ ...base.orderLines[0], snapshot_schema_version: null }, base.orderLines[1]],
  }, /immutable provisioning snapshot/i);
  expectFailure(buildRecoveryManifest, {
    ...base,
    orderLines: [{ ...base.orderLines[0], quantity: 2 }, base.orderLines[1]],
  }, /quantity one/i);
  expectFailure(buildRecoveryManifest, {
    ...base,
    orderLines: [{ ...base.orderLines[0], unit_price: '12.345' }, base.orderLines[1]],
  }, /two decimals/i);
  expectFailure(buildRecoveryManifest, {
    ...base,
    orderLines: [{ ...base.orderLines[0], item_class_snapshot: 'DifferentClass' }, base.orderLines[1]],
  }, /type does not match/i);
  expectFailure(buildRecoveryManifest, {
    ...base,
    orderLines: [base.orderLines[0]],
  }, /unmapped historical shop entry/i);
  expectFailure(buildRecoveryManifest, {
    ...base,
    effectAreaContent: JSON.stringify({ Areas: JSON.parse(base.effectAreaContent).Areas.slice(0, 2) }),
  }, /missing provider entry/i);
  expectFailure(buildRecoveryManifest, {
    ...base,
    effectAreaContent: JSON.stringify({
      Areas: [...JSON.parse(base.effectAreaContent).Areas, JSON.parse(base.effectAreaContent).Areas[1]],
    }),
  }, /duplicate live provider entry/i);
  expectFailure(buildRecoveryManifest, {
    ...base,
    server: { ...base.server, platformServerId: '015580969' },
  }, /canonical numeric identifier/i);
  expectFailure(buildRecoveryManifest, {
    ...base,
    orderLines: [
      { ...base.orderLines[0], order_id: 501, order_line_count: 1 },
      { ...base.orderLines[1], order_id: 501, order_line_count: 1 },
    ],
  }, /selected recovery lines exceed order line count/i);
  const malformedCurrentId = 'DAYZ_DASHBOARD_SHOP_../../unexpected';
  const malformedAreas = JSON.parse(base.effectAreaContent).Areas.map(area =>
    area.AreaName === 'LEGACY_SHOP_alpha'
      ? { ...area, AreaName: malformedCurrentId, _shopEntryId: malformedCurrentId }
      : area
  );
  expectFailure(buildRecoveryManifest, {
    ...base,
    effectAreaContent: JSON.stringify({ Areas: malformedAreas }),
    orderLines: [
      { ...base.orderLines[0], file_entry_id: malformedCurrentId },
      base.orderLines[1],
    ],
  }, /invalid historical shop entry identifier/i);
  const conflictingMarkerAreas = JSON.parse(base.effectAreaContent).Areas.map(area =>
    area.AreaName === 'LEGACY_SHOP_alpha'
      ? { ...area, _shopEntryId: 'not-a-shop-marker' }
      : area
  );
  expectFailure(buildRecoveryManifest, {
    ...base,
    effectAreaContent: JSON.stringify({ Areas: conflictingMarkerAreas }),
  }, /provider shop entry identifiers disagree/i);

  console.log('✅ EffectArea recovery manifest tests passed');
}

try {
  main();
} catch (error) {
  console.error('❌ EffectArea recovery manifest tests failed:', error.message);
  process.exitCode = 1;
}
