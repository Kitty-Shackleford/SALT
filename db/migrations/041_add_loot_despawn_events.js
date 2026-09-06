/**
 * Migration 041: Add loot_despawn_events table
 *
 * Stores cleanup/despawn events parsed from RPT logs.
 * Each row represents one item that was removed by the Central Economy
 * cleanup pass at a given position on a given day.
 *
 * Used by the Loot Heatmap dashboard page to visualise which areas have
 * the highest loot activity / throughput.
 */
async function up(pool) {
  console.log('🔄 Migration 041: Create loot_despawn_events table');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS loot_despawn_events (
      id         SERIAL PRIMARY KEY,
      server_id  INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      item_class TEXT    NOT NULL,
      pos_x      REAL    NOT NULL,
      pos_z      REAL    NOT NULL,
      damage     REAL,
      log_date   DATE    NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (server_id, item_class, pos_x, pos_z, log_date)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_loot_despawn_server_date
      ON loot_despawn_events (server_id, log_date)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_loot_despawn_item_class
      ON loot_despawn_events (item_class)
  `);

  console.log('✅ Migration 041: loot_despawn_events table created');
}

async function down(pool) {
  await pool.query(`DROP TABLE IF EXISTS loot_despawn_events`);
}

module.exports = { up, down };
