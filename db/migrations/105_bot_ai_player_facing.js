/**
 * Migration 105: Player-facing bot AI state
 *
 *  - guild_ai_settings: per-guild settings for the bot's player-facing AI
 *    features (ask-the-server, digests, onboarding). All features default
 *    OFF; enabling any of them is an explicit per-guild opt-in.
 *    digest_state carries the last posted window so digests never
 *    double-post the same period.
 *  - bot_ai_user_usage: per-Discord-user daily budget for ask-the-server.
 *    The bot has no users.id row for plain members, so the counter is keyed
 *    by (discord_user_id, guild_id, day) — a bot-specific mirror of
 *    ai_shared_usage (the shared router's own pool stays protected by the
 *    dashboard-side per-user limits for registered users).
 *  - discord_member_events: append-only join/leave record for Discord
 *    members, used by the digests (joins/leaves) and available for future
 *    onboarding analytics.
 */
'use strict';

async function up(pool) {
  console.log('🔄 Migration 105: Add guild_ai_settings + bot_ai_user_usage + discord_member_events');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS guild_ai_settings (
      guild_id          INTEGER PRIMARY KEY REFERENCES guilds(id) ON DELETE CASCADE,
      ask_enabled       BOOLEAN NOT NULL DEFAULT FALSE,
      ask_daily_limit   INTEGER NOT NULL DEFAULT 20
        CHECK (ask_daily_limit BETWEEN 1 AND 200),
      digest_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
      digest_channel_id TEXT,
      digest_interval   TEXT NOT NULL DEFAULT 'daily'
        CHECK (digest_interval IN ('daily', 'weekly')),
      digest_state      JSONB NOT NULL DEFAULT '{}'::jsonb,
      onboarding_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      onboarding_channel_id TEXT,
      ask_rules_channel_id TEXT,
      updated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot_ai_user_usage (
      discord_user_id TEXT    NOT NULL,
      guild_id        INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
      day             DATE    NOT NULL,
      calls           INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (discord_user_id, guild_id, day)
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_bot_ai_user_usage_day
      ON bot_ai_user_usage (day);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS discord_member_events (
      id              BIGSERIAL PRIMARY KEY,
      guild_id        INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
      discord_user_id TEXT    NOT NULL,
      kind            TEXT    NOT NULL CHECK (kind IN ('join', 'leave')),
      occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_discord_member_events_guild_time
      ON discord_member_events (guild_id, occurred_at);
  `);

  console.log('✅ Migration 105 complete');
}

module.exports = { up };
