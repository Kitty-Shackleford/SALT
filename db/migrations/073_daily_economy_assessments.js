'use strict';

const DAILY_ECONOMY_ASSESSMENTS_SQL = `
  CREATE TABLE IF NOT EXISTS economy_daily_assessments (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE RESTRICT,
    identity_id INTEGER NOT NULL REFERENCES player_identities(id) ON DELETE RESTRICT,
    assessment_type TEXT NOT NULL CHECK (assessment_type IN ('bank_fee', 'inactivity_tax')),
    business_date DATE NOT NULL,
    amount NUMERIC(20,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (server_id, identity_id, assessment_type, business_date)
  );

  CREATE INDEX IF NOT EXISTS economy_daily_assessments_date_idx
    ON economy_daily_assessments (business_date, server_id);
`;

async function up(pool) {
  await pool.query(DAILY_ECONOMY_ASSESSMENTS_SQL);
}

async function down() {
  throw new Error('Migration 073 is irreversible; assessment history prevents duplicate financial charges');
}

module.exports = { up, down, DAILY_ECONOMY_ASSESSMENTS_SQL };
