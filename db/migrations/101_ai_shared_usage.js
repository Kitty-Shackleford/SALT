/*
 * Migration 101: ai_shared_usage
 *
 * Per-user daily call counter for the shared (free) AI router fallback.
 * The shared router is operator-configured and rate-limited so one user
 * cannot exhaust the shared free-tier quotas. Users who connect their own
 * AI provider (see ai_provider_connections) bypass this counter entirely.
 */
'use strict';

async function up(pool) {
  console.log('🔄 Migration 101: Add ai_shared_usage table');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_shared_usage (
      user_id  INTEGER NOT NULL,
      day      DATE NOT NULL,
      calls    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ai_shared_usage_day ON ai_shared_usage (day);
  `);
  console.log('✅ Migration 101: ai_shared_usage table created');
}

async function down(pool) {
  await pool.query('DROP TABLE IF EXISTS ai_shared_usage');
}

module.exports = { up, down };
