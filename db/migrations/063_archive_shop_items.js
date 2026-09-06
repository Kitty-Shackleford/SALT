/*
 * Migration 063 — Distinguish deleted shop entries from deactivated entries
 */

async function up(pool) {
  console.log('🗃️ Migration 063: Archive deleted shop catalog entries');

  await pool.query(`
    ALTER TABLE shop_items
      ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_shop_items_server_visible
      ON shop_items(server_id, created_at DESC)
      WHERE deleted_at IS NULL
  `);

  console.log('✅ Migration 063 complete');
}

module.exports = { up };
