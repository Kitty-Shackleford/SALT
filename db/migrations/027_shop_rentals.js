/**
 * Migration 027: Shop rental enhancements
 *
 * Extends the shop system (migration 026) to support event rentals that persist
 * across multiple server restarts.
 *
 * Changes:
 *   shop_items        — add item_type ('item' | 'event_rental') and rental_restarts
 *   shop_order_items  — add restarts_remaining and is_active tracking
 *   shop_orders       — add 'expired' to the status constraint
 *   server_restart_log — new table for tracking detected server restart events
 */
async function up(pool) {
  console.log('🔄 Migration 027: Shop rental enhancements');

  // Differentiate regular item purchases from timed event rentals
  await pool.query(`
    ALTER TABLE shop_items
      ADD COLUMN IF NOT EXISTS item_type TEXT NOT NULL DEFAULT 'item'
        CHECK (item_type IN ('item', 'event_rental')),
      ADD COLUMN IF NOT EXISTS rental_restarts INTEGER NOT NULL DEFAULT 1
  `);

  // Track how many scheduled restarts remain before the rental expires
  await pool.query(`
    ALTER TABLE shop_order_items
      ADD COLUMN IF NOT EXISTS restarts_remaining INTEGER,
      ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE
  `);

  // Drop and recreate the status constraint to include 'expired'
  // PostgreSQL does not support ALTER CONSTRAINT inline, so we drop and re-add.
  await pool.query(`
    ALTER TABLE shop_orders
      DROP CONSTRAINT IF EXISTS shop_orders_status_check
  `);
  await pool.query(`
    ALTER TABLE shop_orders
      ADD CONSTRAINT shop_orders_status_check
        CHECK (status IN ('cart', 'completed', 'refunded', 'expired'))
  `);

  // Log of every server restart event detected from server.log parsing.
  // bios_session_id is the UUID from "Connected to BIOS" lines and uniquely
  // identifies each server session; used to avoid double-counting restarts.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS server_restart_log (
      id              SERIAL PRIMARY KEY,
      server_id       INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      restart_type    TEXT NOT NULL DEFAULT 'scheduled'
                        CHECK (restart_type IN ('scheduled', 'owner_triggered', 'crash')),
      bios_session_id TEXT UNIQUE
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_server_restart_log_server
      ON server_restart_log (server_id, detected_at DESC)
  `);

  console.log('✅ Migration 027: Shop rental enhancements complete');
}

async function down(pool) {
  await pool.query('DROP TABLE IF EXISTS server_restart_log CASCADE');

  await pool.query(`
    ALTER TABLE shop_orders
      DROP CONSTRAINT IF EXISTS shop_orders_status_check
  `);
  await pool.query(`
    ALTER TABLE shop_orders
      ADD CONSTRAINT shop_orders_status_check
        CHECK (status IN ('cart', 'completed', 'refunded'))
  `);

  await pool.query(`
    ALTER TABLE shop_order_items
      DROP COLUMN IF EXISTS restarts_remaining,
      DROP COLUMN IF EXISTS is_active
  `);

  await pool.query(`
    ALTER TABLE shop_items
      DROP COLUMN IF EXISTS item_type,
      DROP COLUMN IF EXISTS rental_restarts
  `);
}

module.exports = { up, down };
