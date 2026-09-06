/**
 * Migration 039: Add player_count_alerts table
 *
 * Stores player count threshold alerts per guild.
 * When the server's online player count reaches or exceeds a configured
 * threshold (crossing from below), the bot pings the specified role or user
 * in a designated channel.
 */
async function up(pool) {
  console.log('🔄 Migration 039: Add player_count_alerts table');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_count_alerts (
      id                    INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      guild_id              TEXT NOT NULL,
      threshold             INTEGER NOT NULL,
      channel_id            TEXT NOT NULL,
      mention_target        TEXT NOT NULL,
      mention_type          TEXT NOT NULL CHECK (mention_type IN ('role', 'user')),
      enabled               BOOLEAN NOT NULL DEFAULT TRUE,
      created_by_discord_id TEXT,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_player_count_alerts_guild
      ON player_count_alerts(guild_id)
    WHERE enabled = TRUE
  `);

  console.log('✅ Migration 039: player_count_alerts table created');
}

async function down(pool) {
  await pool.query('DROP TABLE IF EXISTS player_count_alerts');
}

module.exports = { up, down };
