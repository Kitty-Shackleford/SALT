/**
 * Migration 036: Add player_reports table
 *
 * Stores in-game player reports submitted via the Discord /report command.
 * Each report captures the reporter's Discord ID, the reported gamertag,
 * an optional reason, optional evidence (URL or text), and a status so
 * admins can track whether a report has been reviewed.
 */
async function up(pool) {
  console.log('🔄 Migration 036: Add player_reports table');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_reports (
      id          INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      guild_id    TEXT    NOT NULL,
      reporter_discord_id   TEXT NOT NULL,
      reporter_discord_name TEXT NOT NULL,
      reported_gamertag     TEXT NOT NULL,
      reason      TEXT,
      evidence    TEXT,
      status      TEXT NOT NULL DEFAULT 'open',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_player_reports_guild
      ON player_reports(guild_id)
  `);

  console.log('✅ Migration 036: player_reports table created');
}

async function down(pool) {
  await pool.query('DROP TABLE IF EXISTS player_reports');
}

module.exports = { up, down };
