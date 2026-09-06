'use strict';

async function up(pool) {
  await pool.query(`
    ALTER TABLE faction_markers
      ADD COLUMN IF NOT EXISTS server_id INTEGER REFERENCES servers(id) ON DELETE CASCADE;

    CREATE INDEX IF NOT EXISTS idx_faction_markers_server_faction_map
      ON faction_markers (server_id, faction_id, map_name, created_at DESC)
      WHERE server_id IS NOT NULL;
  `);
}

async function down(pool) {
  await pool.query('DROP INDEX IF EXISTS idx_faction_markers_server_faction_map');
  await pool.query('ALTER TABLE faction_markers DROP COLUMN IF EXISTS server_id');
}

module.exports = { up, down };
