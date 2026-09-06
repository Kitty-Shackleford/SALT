/**
 * Migration 029: Coursing Game + Casino Constraint Fix
 *
 * 1. Fixes the casino_game_history game_type CHECK constraint to include
 *    'horse_racing' and 'blackjack_insurance' which are used by the code
 *    but were missing from the original 028 constraint.
 *
 * 2. Creates the coursing_dogs table — a persistent per-guild roster of
 *    greyhound dogs that gain XP, level up, and eventually retire.
 */
async function up(pool) {
  console.log('🐕 Migration 029: Coursing game + casino constraint fix');

  await pool.query(`
    ALTER TABLE casino_game_history
      DROP CONSTRAINT IF EXISTS casino_game_history_game_type_check
  `);
  await pool.query(`
    ALTER TABLE casino_game_history
      ADD CONSTRAINT casino_game_history_game_type_check
      CHECK (game_type IN (
        'slots', 'roulette', 'craps',
        'blackjack', 'blackjack_insurance',
        'holdem',
        'horse_race', 'horse_racing',
        'coursing'
      ))
  `);

  // Persistent greyhound dog roster shared per guild.
  // Each guild has one dog per breed (6 total).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coursing_dogs (
      id          SERIAL PRIMARY KEY,
      guild_id    INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      breed       TEXT NOT NULL,
      xp          INTEGER NOT NULL DEFAULT 0,
      wins        INTEGER NOT NULL DEFAULT 0,
      losses      INTEGER NOT NULL DEFAULT 0,
      races       INTEGER NOT NULL DEFAULT 0,
      is_retired  BOOLEAN NOT NULL DEFAULT FALSE,
      generation  INTEGER NOT NULL DEFAULT 1,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_coursing_dogs_guild
      ON coursing_dogs (guild_id, is_retired)
  `);

  console.log('✅ Migration 029 complete');
}

async function down(pool) {
  await pool.query('DROP TABLE IF EXISTS coursing_dogs');
}

module.exports = { up, down };
