/**
 * Migration 040: Add resolution columns to player_reports
 *
 * Adds fields so moderators can close/resolve reports with a note and
 * track who actioned them.
 */
async function up(pool) {
  console.log('🔄 Migration 040: Add resolution columns to player_reports');

  await pool.query(`
    ALTER TABLE player_reports
      ADD COLUMN IF NOT EXISTS resolved_by_discord_id   TEXT,
      ADD COLUMN IF NOT EXISTS resolved_by_discord_name TEXT,
      ADD COLUMN IF NOT EXISTS resolution_note          TEXT,
      ADD COLUMN IF NOT EXISTS resolved_at              TIMESTAMPTZ
  `);

  console.log('✅ Migration 040: resolution columns added to player_reports');
}

async function down(pool) {
  await pool.query(`
    ALTER TABLE player_reports
      DROP COLUMN IF EXISTS resolved_by_discord_id,
      DROP COLUMN IF EXISTS resolved_by_discord_name,
      DROP COLUMN IF EXISTS resolution_note,
      DROP COLUMN IF EXISTS resolved_at
  `);
}

module.exports = { up, down };
