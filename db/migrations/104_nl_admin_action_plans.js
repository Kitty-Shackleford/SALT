/*
 * Migration 104: NL admin action plans
 *
 * Supports the natural-language admin feature (AI feature 4/7): NL requests
 * are resolved into an explicit, human-confirmable action plan. The plan is
 * stored pending (with a TTL) so the confirm route can re-check ownership,
 * plan freshness, and per-action confirmation before driving the EXISTING
 * ownerDashboard endpoints. No mutation logic lives in this table — it is
 * purely the confirm-gate state.
 */
'use strict';

async function up(pool) {
  console.log('🔄 Migration 104: NL admin action plans');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS nl_action_plans (
      id            UUID PRIMARY KEY,
      server_id     INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      user_id       INTEGER NOT NULL,
      request       TEXT    NOT NULL,
      action        TEXT    NOT NULL,
      resolver      TEXT    NOT NULL,
      params        JSONB   NOT NULL DEFAULT '{}',
      plan          JSONB   NOT NULL,
      status        TEXT    NOT NULL DEFAULT 'pending',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at    TIMESTAMPTZ NOT NULL,
      executed_at   TIMESTAMPTZ,
      results       JSONB
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_nl_action_plans_server_status
      ON nl_action_plans (server_id, status, created_at DESC);
  `);

  console.log('✅ Migration 104: NL admin action plans');
}

async function down(pool) {
  await pool.query('DROP INDEX IF EXISTS idx_nl_action_plans_server_status');
  await pool.query('DROP TABLE IF EXISTS nl_action_plans');
}

module.exports = { up, down };
