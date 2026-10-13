/*
 * Migration 103: AI data-driven tuning
 *
 * Supports the data-driven tuning feature (AI feature 3/7): loot
 * spawn/despawn imbalance, weapon balancing from kill data, hot
 * death-zone mapping and the economy health monitor.
 *
 *   - ai_suggestions gains `prediction`: a one-paragraph before/after
 *     prediction that every generated suggestion carries (deliverable 5).
 *     NULL for legacy rows and for suggestions that predate the column.
 *
 *   - economy_snapshots: one row per item class per snapshot date,
 *     recorded deterministically each time the economy health report
 *     runs against a server's working copy. Drift between the oldest
 *     and newest snapshot is what flags inflation creep.
 */
'use strict';

async function up(pool) {
  console.log('🔄 Migration 103: AI data-driven tuning');

  await pool.query(`
    ALTER TABLE ai_suggestions
      ADD COLUMN IF NOT EXISTS prediction TEXT;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS economy_snapshots (
      id            SERIAL PRIMARY KEY,
      server_id     INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      item_class    TEXT    NOT NULL,
      nominal       INTEGER NOT NULL DEFAULT 0,
      min           INTEGER NOT NULL DEFAULT 0,
      lifetime      INTEGER NOT NULL DEFAULT 0,
      restock       INTEGER NOT NULL DEFAULT 0,
      snapshot_date DATE    NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (server_id, item_class, snapshot_date)
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_economy_snapshots_server_date
      ON economy_snapshots (server_id, snapshot_date DESC);
  `);

  console.log('✅ Migration 103: AI data-driven tuning');
}

async function down(pool) {
  await pool.query('DROP TABLE IF EXISTS economy_snapshots');
  await pool.query(`ALTER TABLE ai_suggestions DROP COLUMN IF EXISTS prediction`);
}

module.exports = { up, down };
