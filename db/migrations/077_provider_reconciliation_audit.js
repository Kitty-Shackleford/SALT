'use strict';

const PROVIDER_RECONCILIATION_AUDIT_SQL = `
  ALTER TABLE provider_mutations
    ADD COLUMN IF NOT EXISTS reconciled_by TEXT,
    ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMPTZ;

  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conname = 'provider_mutations_reconciled_pair_chk'
        AND conrelid = 'provider_mutations'::regclass
    ) THEN
      ALTER TABLE provider_mutations
        ADD CONSTRAINT provider_mutations_reconciled_pair_chk
        CHECK ((reconciled_by IS NULL) = (reconciled_at IS NULL));
    END IF;
  END
  $$;
`;

async function up(pool) {
  await pool.query(PROVIDER_RECONCILIATION_AUDIT_SQL);
}

async function down() {
  throw new Error('Migration 077 is irreversible; provider reconciliation audit records must be preserved');
}

module.exports = { up, down, PROVIDER_RECONCILIATION_AUDIT_SQL };
