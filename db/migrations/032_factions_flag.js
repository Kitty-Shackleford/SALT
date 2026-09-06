/**
 * Migration 032: Add flag_url to factions
 *
 * Adds an optional `flag_url` column to the factions table so faction
 * leaders can choose one of the in-game DayZ flag images to represent
 * their faction.  The column stores the full image URL (hosted on
 * static.wikia.nocookie.net) chosen from a curated picker in the UI.
 */
async function up(pool) {
  console.log('🚩 Migration 032: Add flag_url to factions');

  await pool.query(`
    ALTER TABLE factions
    ADD COLUMN IF NOT EXISTS flag_url TEXT
  `);

  console.log('   ✓ factions.flag_url added');
}

module.exports = { up };
