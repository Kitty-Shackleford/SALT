/**
 * Migration 108: Per-guild ops-alert Discord notifications (AI feature 7d)
 *
 *  - guild_ai_settings gains three columns so a guild can opt in to
 *    high/critical ops-warning alerts, posted by the existing bot identity
 *    (Hermes is the only token) into a configured channel:
 *       ops_alert_enabled      BOOLEAN (default OFF)
 *       ops_alert_channel_id   TEXT
 *       ops_alert_state        JSONB (per-guild watermark { lastId } so each
 *                              warning is posted at most once per 24h)
 *
 *  Reuses the digest column convention from migration 105 (digest_enabled /
 *  digest_channel_id / digest_state). Idempotent: ADD COLUMN IF NOT EXISTS.
 */
'use strict';

async function up(pool) {
  console.log('🔄 Migration 108: Add ops-alert columns to guild_ai_settings');

  await pool.query(`
    ALTER TABLE guild_ai_settings
      ADD COLUMN IF NOT EXISTS ops_alert_enabled BOOLEAN NOT NULL DEFAULT FALSE
  `);

  await pool.query(`
    ALTER TABLE guild_ai_settings
      ADD COLUMN IF NOT EXISTS ops_alert_channel_id TEXT
  `);

  await pool.query(`
    ALTER TABLE guild_ai_settings
      ADD COLUMN IF NOT EXISTS ops_alert_state JSONB NOT NULL DEFAULT '{}'::jsonb
  `);

  console.log('✅ Migration 108 complete');
}

module.exports = { up };
