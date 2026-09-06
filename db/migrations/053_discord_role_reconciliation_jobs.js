'use strict';

/** Migration 053: Durable Discord role reconciliation outbox/history. */
async function up(pool) {
  console.log('🔄 Migration 053: Add durable Discord role reconciliation jobs');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS discord_link_role_policy_history (
      server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      role_id TEXT NOT NULL,
      first_managed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_managed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (server_id, role_id)
    );

    CREATE TABLE IF NOT EXISTS discord_role_reconciliation_jobs (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      discord_guild_id TEXT NOT NULL,
      discord_user_id TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'completed')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      generation BIGINT NOT NULL DEFAULT 1 CHECK (generation > 0),
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      locked_at TIMESTAMPTZ,
      last_error TEXT,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (discord_guild_id, discord_user_id, user_id)
    );

    ALTER TABLE discord_role_reconciliation_jobs
      ADD COLUMN IF NOT EXISTS generation BIGINT NOT NULL DEFAULT 1 CHECK (generation > 0);

    CREATE INDEX IF NOT EXISTS discord_role_reconciliation_jobs_due_idx
      ON discord_role_reconciliation_jobs(status, next_attempt_at)
      WHERE status IN ('pending', 'processing');
  `);
  console.log('✅ Migration 053 complete');
}

async function down(pool) {
  await pool.query(`
    DROP TABLE IF EXISTS discord_role_reconciliation_jobs;
    DROP TABLE IF EXISTS discord_link_role_policy_history;
  `);
}

module.exports = { up, down };
