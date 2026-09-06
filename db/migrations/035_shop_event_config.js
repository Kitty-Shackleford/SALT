/**
 * Migration 035: Add event_config to shop_items
 *
 * Stores the full DayZ CE event definition parameters per shop item so the
 * server owner can customise how the spawned event behaves (nominal, lifetime,
 * safe radius, secondary spawner, flags, etc.) without touching server files
 * manually.
 *
 * Stored as a JSON TEXT column; defaults to an empty object (service fills
 * in sensible defaults at write-time).
 */
async function up(pool) {
  console.log('🔄 Migration 035: Add event_config to shop_items');

  await pool.query(`
    ALTER TABLE shop_items
      ADD COLUMN IF NOT EXISTS event_config JSONB NOT NULL DEFAULT '{}'
  `);

  console.log('✅ Migration 035: event_config column added');
}

async function down(pool) {
  await pool.query(`
    ALTER TABLE shop_items DROP COLUMN IF EXISTS event_config
  `);
}

module.exports = { up, down };
