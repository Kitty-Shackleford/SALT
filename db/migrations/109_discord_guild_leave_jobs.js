'use strict';

/**
 * Migration 109: Durable Discord guild-leave outbox.
 *
 * When an admin removes a guild from the dashboard (DELETE /api/admin/guilds/:guildId),
 * the backend enqueues one pending job here. The bot's guildLeaveService consumes
 * due jobs and makes the Discord client leave the guild.
 */
async function up(pool) {
  console.log('🔄 Migration 109: Add durable Discord guild leave jobs');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discord_guild_leave_jobs (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      discord_guild_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'completed')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      locked_at TIMESTAMPTZ,
      last_error TEXT,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS discord_guild_leave_jobs_due_idx
      ON discord_guild_leave_jobs(status, next_attempt_at)
      WHERE status IN ('pending', 'processing');
  `);
  console.log('✅ Migration 109 complete');
}

async function down(pool) {
  await pool.query(`
    DROP INDEX IF EXISTS discord_guild_leave_jobs_due_idx;
    DROP TABLE IF EXISTS discord_guild_leave_jobs;
  `);
}

module.exports = { up, down };
