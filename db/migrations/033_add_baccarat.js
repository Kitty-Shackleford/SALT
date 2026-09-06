/**
 * Migration 033: Add Baccarat to casino game types
 *
 * Extends the casino_game_history game_type CHECK constraint to include
 * 'baccarat'. Follows the same pattern as migration 029.
 *
 * Drops and recreates the PostgreSQL named constraint.
 */
async function up(pool) {
  console.log('🎴 Migration 033: Add baccarat to casino game types');

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
        'coursing',
        'baccarat'
      ))
  `);
  console.log('✓ casino_game_history CHECK constraint updated');
}

async function down(pool) {
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
}

module.exports = { up, down };
