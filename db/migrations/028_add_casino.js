/**
 * Migration 028: Casino System
 *
 * Adds the casino_game_history table to record every bet placed across all
 * casino games, and optional casino configuration columns to guild_economy_config.
 */
async function up(pool) {
  console.log('🎰 Migration 028: Casino system');

  // Detailed record of every casino game played
  await pool.query(`
    CREATE TABLE IF NOT EXISTS casino_game_history (
      id              SERIAL PRIMARY KEY,
      identity_id     INTEGER NOT NULL REFERENCES player_identities(id),
      server_id       INTEGER REFERENCES servers(id),
      guild_id        INTEGER REFERENCES guilds(id),
      game_type       TEXT NOT NULL CHECK (game_type IN (
                        'slots', 'roulette', 'craps', 'blackjack', 'holdem',
                        'horse_race', 'coursing'
                      )),
      wager           NUMERIC(12, 2) NOT NULL,
      payout          NUMERIC(12, 2) NOT NULL DEFAULT 0,
      net             NUMERIC(12, 2) GENERATED ALWAYS AS (payout - wager) STORED,
      result          TEXT NOT NULL CHECK (result IN ('win', 'loss', 'push')),
      result_data     TEXT,
      played_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_casino_history_identity
      ON casino_game_history (identity_id, played_at DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_casino_history_guild
      ON casino_game_history (guild_id, played_at DESC)
  `);

  // Optional per-guild casino configuration columns
  await pool.query(`
    ALTER TABLE guild_economy_config
      ADD COLUMN IF NOT EXISTS casino_enabled      BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS casino_min_bet      NUMERIC(12, 2) NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS casino_max_bet      NUMERIC(12, 2) NOT NULL DEFAULT 10000
  `);

  console.log('✅ Migration 028 complete');
}

async function down(pool) {
  await pool.query('DROP TABLE IF EXISTS casino_game_history');
  await pool.query('ALTER TABLE guild_economy_config DROP COLUMN IF EXISTS casino_enabled');
  await pool.query('ALTER TABLE guild_economy_config DROP COLUMN IF EXISTS casino_min_bet');
  await pool.query('ALTER TABLE guild_economy_config DROP COLUMN IF EXISTS casino_max_bet');
}

module.exports = { up, down };
