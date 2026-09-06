'use strict';

const PROVIDER_RECOVERY_SQL = `
  CREATE TABLE IF NOT EXISTS provider_mutations (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE RESTRICT,
    provider_service_id TEXT NOT NULL CHECK (char_length(provider_service_id) > 0),
    workflow TEXT NOT NULL CHECK (char_length(workflow) BETWEEN 1 AND 64),
    action TEXT NOT NULL CHECK (char_length(action) BETWEEN 1 AND 64),
    context_type TEXT CHECK (context_type IS NULL OR char_length(context_type) BETWEEN 1 AND 64),
    context_id TEXT,
    plan_json JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'prepared' CHECK (
      status IN ('prepared', 'completed', 'compensated', 'recovery_pending')
    ),
    triggered_by TEXT NOT NULL,
    error_summary TEXT,
    reconciled_by TEXT,
    reconciled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    CHECK ((context_type IS NULL) = (context_id IS NULL)),
    CHECK ((reconciled_by IS NULL) = (reconciled_at IS NULL)),
    CHECK (
      (status IN ('prepared', 'recovery_pending') AND finished_at IS NULL)
      OR
      (status IN ('completed', 'compensated') AND finished_at IS NOT NULL)
    )
  );

  CREATE TABLE IF NOT EXISTS provider_mutation_files (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    mutation_id BIGINT NOT NULL REFERENCES provider_mutations(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL CHECK (char_length(file_path) > 0),
    original_exists BOOLEAN NOT NULL,
    original_content TEXT,
    CHECK (
      (original_exists AND original_content IS NOT NULL)
      OR
      (NOT original_exists AND original_content IS NULL)
    ),
    UNIQUE (mutation_id, file_path)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_mutations_unresolved_server
    ON provider_mutations (server_id)
    WHERE status IN ('prepared', 'recovery_pending');

  CREATE INDEX IF NOT EXISTS provider_mutations_server_status_idx
    ON provider_mutations (server_id, status, created_at DESC);
`;

async function up(pool) {
  await pool.query(PROVIDER_RECOVERY_SQL);
}

async function down() {
  throw new Error('Migration 076 is irreversible; provider snapshots are required for recovery');
}

module.exports = { up, down, PROVIDER_RECOVERY_SQL };
