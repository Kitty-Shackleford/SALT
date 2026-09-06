'use strict';

const PROVIDER_SERVICE_IDENTITY_SQL = `
  ALTER TABLE provider_mutations
    ADD COLUMN IF NOT EXISTS provider_service_id TEXT;

  DO $$
  BEGIN
    IF EXISTS (
      SELECT 1
      FROM provider_mutations
      WHERE provider_service_id IS NULL
        AND status IN ('prepared', 'recovery_pending')
    ) THEN
      RAISE EXCEPTION 'Cannot guess provider identity for unresolved recovery records';
    END IF;
  END $$;

  UPDATE provider_mutations pm
  SET provider_service_id = s.platform_server_id::text
  FROM servers s
  WHERE s.id = pm.server_id
    AND pm.provider_service_id IS NULL
    AND pm.status IN ('completed', 'compensated');

  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM provider_mutations WHERE provider_service_id IS NULL) THEN
      RAISE EXCEPTION 'Cannot bind provider recovery records to immutable provider service identities';
    END IF;
  END $$;

  ALTER TABLE provider_mutations
    ALTER COLUMN provider_service_id SET NOT NULL;

  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'provider_mutations_provider_service_id_check'
        AND conrelid = 'provider_mutations'::regclass
    ) THEN
      ALTER TABLE provider_mutations
        ADD CONSTRAINT provider_mutations_provider_service_id_check
        CHECK (char_length(provider_service_id) > 0);
    END IF;
  END $$;
`;

async function up(pool) {
  await pool.query(PROVIDER_SERVICE_IDENTITY_SQL);
}

async function down() {
  throw new Error('Migration 079 is irreversible; provider recovery identities must remain auditable');
}

module.exports = { up, down, PROVIDER_SERVICE_IDENTITY_SQL };
