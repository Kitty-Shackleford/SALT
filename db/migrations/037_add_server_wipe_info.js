/**
 * Migration 037: Add server_wipe_info table
 *
 * Stores the last wipe date, optional next wipe date, and optional notes
 * for each server. Managed via the /wipe-info bot command.
 */
async function up(pool) {
  console.log('🔄 Migration 037: Add server_wipe_info table');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS server_wipe_info (
      server_id         INTEGER PRIMARY KEY,
      last_wipe_at      TIMESTAMPTZ,
      next_wipe_at      TIMESTAMPTZ,
      notes             TEXT,
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by_discord_id   TEXT,
      updated_by_discord_name TEXT,
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
    )
  `);

  console.log('✅ Migration 037: server_wipe_info table created');
}

async function down(pool) {
  await pool.query('DROP TABLE IF EXISTS server_wipe_info');
}

module.exports = { up, down };
