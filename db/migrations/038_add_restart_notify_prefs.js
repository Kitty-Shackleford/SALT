/**
 * Migration 038: Add restart_notify_prefs table
 *
 * Stores per-user opt-in preferences for DM notifications before server restarts.
 * Users can choose how many minutes in advance they want to be notified.
 */
async function up(pool) {
  console.log('🔄 Migration 038: Add restart_notify_prefs table');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS restart_notify_prefs (
      id                INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      guild_id          TEXT NOT NULL,
      discord_user_id   TEXT NOT NULL,
      minutes_before    INTEGER NOT NULL DEFAULT 15,
      enabled           BOOLEAN NOT NULL DEFAULT TRUE,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(guild_id, discord_user_id)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_restart_notify_guild
      ON restart_notify_prefs(guild_id)
    WHERE enabled = TRUE
  `);

  console.log('✅ Migration 038: restart_notify_prefs table created');
}

async function down(pool) {
  await pool.query('DROP TABLE IF EXISTS restart_notify_prefs');
}

module.exports = { up, down };
