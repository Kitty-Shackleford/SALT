'use strict';

const RESTART_EVIDENCE_SQL = `
  ALTER TABLE server_restart_log
    ADD COLUMN IF NOT EXISTS provider_started_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS evidence_source_file TEXT;

  CREATE UNIQUE INDEX IF NOT EXISTS server_restart_log_provider_start_uq
    ON server_restart_log (server_id, provider_started_at)
    WHERE provider_started_at IS NOT NULL;
`;

async function up(pool) {
  await pool.query(RESTART_EVIDENCE_SQL);
}

async function down() {
  throw new Error('Migration 072 is irreversible; restore a verified database backup instead');
}

module.exports = { up, down, RESTART_EVIDENCE_SQL };
