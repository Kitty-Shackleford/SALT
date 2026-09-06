/**
 * Migration 048: Allow order history while preserving one open cart.
 */
async function up(pool) {
  console.log('🔄 Migration 048: Fix shop order uniqueness');

  await pool.query(`
    ALTER TABLE shop_orders
      DROP CONSTRAINT IF EXISTS shop_orders_identity_id_server_id_status_key
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS shop_orders_open_cart_uq
      ON shop_orders (identity_id, server_id)
      WHERE status = 'cart'
  `);

  console.log('✅ Migration 048 complete');
}

async function down(pool) {
  void pool;
  throw new Error('Migration 048 is irreversible after repeat shop orders are permitted');
}

module.exports = { up, down };