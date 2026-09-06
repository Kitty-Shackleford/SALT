/**
 * Migration 026: Add shop system tables
 *
 * Creates four tables to support the in-game shop feature:
 *
 *   shop_items            — the product catalogue (global or per-server)
 *   shop_preset_locations — owner-defined spawn point presets per item
 *   shop_orders           — player shopping carts and completed orders
 *   shop_order_items      — individual line items within an order
 *
 * Spawn methods:
 *   cfgEffectArea — writes entries to cfgEffectArea.xml (single items)
 *   custom_json   — appends to a custom JSON object-array file
 *   event         — updates event.xml + cfgspawnabletypes.xml
 */
async function up(pool) {
  console.log('🔄 Migration 026: Add shop system tables');

  // Product catalogue
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shop_items (
      id              SERIAL PRIMARY KEY,
      guild_id        INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
      server_id       INTEGER REFERENCES servers(id) ON DELETE SET NULL,
      name            TEXT NOT NULL,
      item_class      TEXT NOT NULL,
      description     TEXT,
      price           NUMERIC(12, 2) NOT NULL DEFAULT 0,
      spawn_method    TEXT NOT NULL DEFAULT 'cfgEffectArea'
                        CHECK (spawn_method IN ('cfgEffectArea', 'custom_json', 'event')),
      custom_json_file TEXT,
      event_name      TEXT,
      image_url       TEXT,
      is_active       BOOLEAN NOT NULL DEFAULT TRUE,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Owner-defined preset spawn locations for a shop item
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shop_preset_locations (
      id            SERIAL PRIMARY KEY,
      shop_item_id  INTEGER NOT NULL REFERENCES shop_items(id) ON DELETE CASCADE,
      label         TEXT NOT NULL,
      pos_x         NUMERIC(12, 4) NOT NULL DEFAULT 0,
      pos_y         NUMERIC(12, 4) NOT NULL DEFAULT 0,
      pos_z         NUMERIC(12, 4) NOT NULL DEFAULT 0,
      ypr_x         NUMERIC(8, 4)  NOT NULL DEFAULT 0,
      ypr_y         NUMERIC(8, 4)  NOT NULL DEFAULT 0,
      ypr_z         NUMERIC(8, 4)  NOT NULL DEFAULT 0
    )
  `);

  // Player orders (status='cart' = open cart, 'completed' = paid + files written)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shop_orders (
      id              SERIAL PRIMARY KEY,
      identity_id     INTEGER NOT NULL REFERENCES player_identities(id) ON DELETE CASCADE,
      server_id       INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      status          TEXT NOT NULL DEFAULT 'cart'
                        CHECK (status IN ('cart', 'completed', 'refunded')),
      total_price     NUMERIC(12, 2) NOT NULL DEFAULT 0,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      checked_out_at  TIMESTAMPTZ,
      UNIQUE (identity_id, server_id, status) DEFERRABLE INITIALLY DEFERRED
    )
  `);

  // Line items within an order (one row per item added to cart)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shop_order_items (
      id            SERIAL PRIMARY KEY,
      order_id      INTEGER NOT NULL REFERENCES shop_orders(id) ON DELETE CASCADE,
      shop_item_id  INTEGER NOT NULL REFERENCES shop_items(id),
      quantity      INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
      unit_price    NUMERIC(12, 2) NOT NULL,
      pos_x         NUMERIC(12, 4) NOT NULL DEFAULT 0,
      pos_y         NUMERIC(12, 4) NOT NULL DEFAULT 0,
      pos_z         NUMERIC(12, 4) NOT NULL DEFAULT 0,
      ypr_x         NUMERIC(8, 4)  NOT NULL DEFAULT 0,
      ypr_y         NUMERIC(8, 4)  NOT NULL DEFAULT 0,
      ypr_z         NUMERIC(8, 4)  NOT NULL DEFAULT 0,
      spawn_method  TEXT NOT NULL,
      file_entry_id TEXT
    )
  `);

  // Performance index — most queries filter by identity + status
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_shop_orders_identity_status
      ON shop_orders (identity_id, status)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_shop_items_guild_active
      ON shop_items (guild_id, is_active)
  `);

  console.log('✅ Migration 026: Shop system tables created');
}

async function down(pool) {
  await pool.query('DROP TABLE IF EXISTS shop_order_items CASCADE');
  await pool.query('DROP TABLE IF EXISTS shop_orders CASCADE');
  await pool.query('DROP TABLE IF EXISTS shop_preset_locations CASCADE');
  await pool.query('DROP TABLE IF EXISTS shop_items CASCADE');
}

module.exports = { up, down };
