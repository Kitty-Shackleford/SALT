async function up(pool) {
  await pool.query(`
    ALTER TABLE shop_items
      ADD COLUMN IF NOT EXISTS provisioning_version INTEGER NOT NULL DEFAULT 1;

    ALTER TABLE shop_order_items
      ADD COLUMN IF NOT EXISTS snapshot_schema_version SMALLINT,
      ADD COLUMN IF NOT EXISTS item_name_snapshot TEXT,
      ADD COLUMN IF NOT EXISTS image_url_snapshot TEXT,
      ADD COLUMN IF NOT EXISTS item_class_snapshot TEXT,
      ADD COLUMN IF NOT EXISTS item_type_snapshot TEXT,
      ADD COLUMN IF NOT EXISTS rental_restarts_snapshot INTEGER,
      ADD COLUMN IF NOT EXISTS custom_json_file_snapshot TEXT,
      ADD COLUMN IF NOT EXISTS event_name_snapshot TEXT,
      ADD COLUMN IF NOT EXISTS event_config_snapshot JSONB,
      ADD COLUMN IF NOT EXISTS provisioning_version_snapshot INTEGER NOT NULL DEFAULT 1;
  `);

  await pool.query(`
    UPDATE shop_order_items soi
       SET item_name_snapshot = COALESCE(soi.item_name_snapshot, si.name),
           image_url_snapshot = COALESCE(soi.image_url_snapshot, si.image_url),
           item_class_snapshot = COALESCE(soi.item_class_snapshot, si.item_class),
           item_type_snapshot = COALESCE(soi.item_type_snapshot, si.item_type),
           rental_restarts_snapshot = COALESCE(soi.rental_restarts_snapshot, si.rental_restarts),
           custom_json_file_snapshot = COALESCE(soi.custom_json_file_snapshot, si.custom_json_file),
           event_name_snapshot = COALESCE(soi.event_name_snapshot, si.event_name),
           event_config_snapshot = COALESCE(soi.event_config_snapshot, si.event_config, '{}'::jsonb),
           provisioning_version_snapshot = si.provisioning_version,
           snapshot_schema_version = 1
      FROM shop_items si
     WHERE si.id = soi.shop_item_id
       AND soi.snapshot_schema_version IS NULL;
  `);
}

module.exports = { up };
