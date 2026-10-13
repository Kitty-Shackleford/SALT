/**
 * Migration 106: Ops intelligence state
 *
 *  - ops_warnings: per-server deterministic crash/lag precursor warnings
 *    (AI feature 7/7). Detection is pure pattern-matching against the
 *    ingested RPT/ADM data (no provider); this table persists the current
 *    picture per server so the dashboard panel can render alerts without
 *    re-scanning on every load. Rows are idempotent per (server, precursor,
 *    day) via fingerprint; stale rows are soft-deleted by the detector.
 */
'use strict';

async function up(pool) {
  console.log('🔄 Migration 106: Add ops_warnings (ops intelligence)');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ops_warnings (
      id              BIGSERIAL PRIMARY KEY,
      server_id       INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      precursor_id    TEXT    NOT NULL,
      severity        TEXT    NOT NULL DEFAULT 'medium'
        CHECK (severity IN ('critical', 'high', 'medium', 'low')),
      fingerprint     TEXT    NOT NULL,
      payload         JSONB   NOT NULL DEFAULT '{}'::jsonb,
      detected_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      deleted_at      TIMESTAMPTZ
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ops_warnings_server_active
      ON ops_warnings (server_id, detected_at DESC)
      WHERE deleted_at IS NULL;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ops_warnings_fingerprint_lookup
      ON ops_warnings (server_id, fingerprint)
      WHERE deleted_at IS NULL;
  `);

  console.log('✅ Migration 106 complete');
}

module.exports = { up };
