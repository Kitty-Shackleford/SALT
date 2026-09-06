'use strict';

const OBJECT_SPAWNER_PRODUCTS_SQL = `
  ALTER TABLE shop_items
    ADD COLUMN IF NOT EXISTS object_spawner_config JSONB;

  ALTER TABLE shop_order_items
    ADD COLUMN IF NOT EXISTS object_spawner_config_snapshot JSONB;

  -- Migration 067 protects retained order lines from ordinary updates. This
  -- migration holds an ACCESS EXCLUSIVE table lock while temporarily disabling
  -- only that update trigger for its controlled immutable-snapshot backfill.
  ALTER TABLE shop_order_items DISABLE TRIGGER retain_shop_order_items_update;

  UPDATE shop_items
  SET object_spawner_config = jsonb_build_object(
    'file', COALESCE(NULLIF(custom_json_file, ''), 'custom/shop.json'),
    'scale', 1,
    'enableCEPersistency', false,
    'customString', ''
  )
  WHERE spawn_method = 'custom_json'
    AND object_spawner_config IS NULL;

  UPDATE shop_order_items
  SET object_spawner_config_snapshot = jsonb_build_object(
    'file', COALESCE(NULLIF(custom_json_file_snapshot, ''), 'custom/shop.json'),
    'scale', 1,
    'enableCEPersistency', false,
    'customString', ''
  )
  WHERE spawn_method = 'custom_json'
    AND object_spawner_config_snapshot IS NULL;

  ALTER TABLE shop_order_items ENABLE TRIGGER retain_shop_order_items_update;
`;

async function up(pool) {
  await pool.query(OBJECT_SPAWNER_PRODUCTS_SQL);
}

async function down(pool) {
  await pool.query(`
    ALTER TABLE shop_order_items DROP COLUMN IF EXISTS object_spawner_config_snapshot;
    ALTER TABLE shop_items DROP COLUMN IF EXISTS object_spawner_config;
  `);
}

module.exports = { up, down, OBJECT_SPAWNER_PRODUCTS_SQL };
