/*
 * Migration 100: suggestions
 *
 * Per-guild suggestion box. Each suggestion is a row, so:
 *   - accept/deny stay idempotent (a pending row flips once)
 *   - the submitter's Discord id is recorded (reliable DM on decision,
 *     no username-guessing)
 *   - history survives even if the posted message is deleted
 *
 * The suggestion *channel* itself lives in guild_features (feature_name
 * 'suggestions') like welcome/goodbye — off by default per guild.
 */
'use strict';

async function up(pool) {
  console.log('🔄 Migration 100: Add suggestions table');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS suggestions (
      id                     INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      guild_id               INTEGER NOT NULL,
      discord_channel_id     TEXT NOT NULL,
      discord_message_id     TEXT NOT NULL,
      body                   TEXT NOT NULL,
      submitter_discord_id   TEXT NOT NULL,
      status                 TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'denied')),
      decided_by_discord_id  TEXT,
      decided_at             TIMESTAMPTZ,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (guild_id, discord_message_id),
      FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE
    );
  `);
  console.log('✅ Migration 100: suggestions table created');
}

async function down(pool) {
  await pool.query('DROP TABLE IF EXISTS suggestions');
}

module.exports = { up, down };
