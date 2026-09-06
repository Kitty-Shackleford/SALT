'use strict';

const FINANCIAL_IDEMPOTENCY_SQL = `
  CREATE TABLE IF NOT EXISTS financial_idempotency_records (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE RESTRICT,
    identity_id INTEGER NOT NULL REFERENCES player_identities(id) ON DELETE RESTRICT,
    actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    operation TEXT NOT NULL CHECK (char_length(operation) BETWEEN 1 AND 64),
    idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
    request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
    response_status SMALLINT CHECK (response_status BETWEEN 200 AND 599),
    response_body JSONB,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
      (response_status IS NULL AND response_body IS NULL AND completed_at IS NULL)
      OR
      (response_status IS NOT NULL AND response_body IS NOT NULL AND completed_at IS NOT NULL)
    ),
    UNIQUE (server_id, actor_user_id, identity_id, idempotency_key)
  );

  CREATE INDEX IF NOT EXISTS financial_idempotency_created_idx
    ON financial_idempotency_records (created_at);
`;

async function up(pool) {
  await pool.query(FINANCIAL_IDEMPOTENCY_SQL);
}

async function down() {
  throw new Error('Migration 075 is irreversible; request records prevent duplicate financial mutations');
}

module.exports = { up, down, FINANCIAL_IDEMPOTENCY_SQL };
