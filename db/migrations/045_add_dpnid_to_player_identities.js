/**
 * Migration 045: Add dpnid to player_identities
 *
 * Adds a nullable dpnid column to player_identities so parsers can persist
 * the DayZ-provided identity token (dpnid) extracted from RPT/ADM logs.
 */
async function up(pool) {
  console.log('🔄 Migration 045: Add dpnid to player_identities');
  await pool.query(`
    ALTER TABLE player_identities
      ADD COLUMN IF NOT EXISTS dpnid TEXT;
  `);

  // Add an index to speed up lookups by dpnid when resolving identities
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_player_identities_dpnid
      ON player_identities (dpnid);
  `);

  console.log('✅ Migration 045 complete');
}

async function down(pool) {
  console.log('↩️  Reverting Migration 045: remove dpnid from player_identities');
  await pool.query(`
    DROP INDEX IF EXISTS idx_player_identities_dpnid;
  `);
  await pool.query(`
    ALTER TABLE player_identities
      DROP COLUMN IF EXISTS dpnid;
  `);
}

module.exports = { up, down };
