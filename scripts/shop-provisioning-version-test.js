'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { provisioningFieldsChanged } = require('../utils/shopProvisioningVersion');

function source(file) {
  return fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
}

const existing = {
  spawn_method: 'event',
  item_class: 'OffroadHatchback',
  custom_json_file: null,
  event_config: { nominal: 1, flags: { deletable: 1, init_random: 0 } },
};

assert.strictEqual(provisioningFieldsChanged(existing, {
  ...existing,
  name: 'Renamed listing',
  price: 50,
}), false, 'display and price edits must not version provisioning');

assert.strictEqual(provisioningFieldsChanged(existing, {
  ...existing,
  event_config: { flags: { init_random: 0, deletable: 1 }, nominal: 1 },
}), false, 'JSON object key order must not version provisioning');

assert.strictEqual(provisioningFieldsChanged(existing, {
  ...existing,
  event_config: { nominal: 2, flags: { deletable: 1, init_random: 0 } },
}), true, 'event behavior edits must version provisioning');

assert.strictEqual(provisioningFieldsChanged(existing, {
  ...existing,
  item_class: 'OffroadHatchback_Blue',
}), true, 'class edits must version provisioning');

assert.strictEqual(provisioningFieldsChanged({
  ...existing,
  spawn_method: 'custom_json',
  object_spawner_config: { file: 'custom/shop.json', scale: 1, enableCEPersistency: false },
}, {
  ...existing,
  spawn_method: 'custom_json',
  object_spawner_config: { file: 'custom/shop.json', scale: 2, enableCEPersistency: false },
}), true, 'Object Spawner behavior edits must version provisioning');

assert.strictEqual(provisioningFieldsChanged({
  ...existing,
  item_type: 'item',
  rental_restarts: 1,
}, {
  ...existing,
  item_type: 'item',
  rental_restarts: null,
  name: 'Renamed listing',
}), false, 'non-rental default and browser null must not version provisioning');

const migration = source('db/migrations/065_shop_provisioning_snapshots.js');
for (const column of ['snapshot_schema_version', 'item_name_snapshot', 'image_url_snapshot', 'item_class_snapshot', 'item_type_snapshot', 'rental_restarts_snapshot', 'custom_json_file_snapshot', 'event_name_snapshot', 'event_config_snapshot', 'provisioning_version_snapshot', 'provisioning_version']) {
  assert.match(migration, new RegExp(column), `migration must create/backfill ${column}`);
}

const routes = source('routes/shop.js');
assert.match(routes, /item_class_snapshot/);
assert.match(routes, /event_name_snapshot/);
assert.match(routes, /provisioningFieldsChanged/);
assert.match(routes, /CASE WHEN soi\.snapshot_schema_version = 1 THEN soi\.item_type_snapshot ELSE si\.item_type END AS item_type/);
assert.ok((routes.match(/CASE WHEN soi\.snapshot_schema_version = 1 THEN soi\.item_type_snapshot ELSE si\.item_type END AS item_type/g) || []).length >= 4,
  'cart updates, cart display, order history, and active rentals must use item type snapshots');
assert.match(routes, /CASE WHEN soi\.snapshot_schema_version = 1 THEN soi\.rental_restarts_snapshot ELSE si\.rental_restarts END AS rental_restarts/);
assert.match(routes, /CASE WHEN soi\.snapshot_schema_version = 1 THEN soi\.item_type_snapshot ELSE si\.item_type END = 'event_rental'/);
assert.doesNotMatch(routes, /soi\.item_type = 'event_rental'/);
assert.match(routes, /force_provisioning_version === true/);
assert.match(routes, /provisioning_version = \$13/);
assert.match(routes, /generateEventName\([\s\S]{0,180}nextProvisioningVersion/);

const service = source('services/shopFileService.js');
assert.match(service, /\[order\.identity_id, order\.server_id, centsToDecimal\(-walletDeductCents\), order\.id\]/,
  'wallet shop purchases must record an exact negative debit amount linked to the exact order');
assert.match(service, /\[order\.identity_id, order\.server_id, centsToDecimal\(-bankDeductCents\), order\.id\]/,
  'bank shop purchases must record an exact negative debit amount linked to the exact order');
for (const snapshot of [
  /CASE WHEN soi\.snapshot_schema_version = 1 THEN soi\.item_class_snapshot ELSE si\.item_class END AS item_class/,
  /CASE WHEN soi\.snapshot_schema_version = 1 THEN soi\.event_name_snapshot ELSE si\.event_name END AS event_name/,
  /CASE WHEN soi\.snapshot_schema_version = 1 THEN soi\.event_config_snapshot ELSE si\.event_config END AS event_config/,
  /CASE WHEN soi\.snapshot_schema_version = 1 THEN soi\.item_name_snapshot ELSE si\.name END AS item_name/,
]) {
  assert.match(service, snapshot);
}

console.log('Shop provisioning snapshot/version tests passed');
