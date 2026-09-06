'use strict';

const FINANCIAL_REPLAY_RETENTION_SQL = `
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'economy_daily_assessments'
        AND column_name = 'completed_at'
    ) THEN
      ALTER TABLE economy_daily_assessments ADD COLUMN completed_at TIMESTAMPTZ;
      UPDATE economy_daily_assessments SET completed_at = created_at;
    END IF;
  END;
  $$;

  CREATE OR REPLACE FUNCTION protect_financial_replay_evidence_update()
  RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE old_row JSONB := to_jsonb(OLD); new_row JSONB := to_jsonb(NEW);
  BEGIN
    IF TG_TABLE_NAME = 'economy_daily_assessments'
       AND old_row->>'completed_at' IS NULL
       AND new_row->>'completed_at' IS NOT NULL
       AND (new_row - ARRAY['amount', 'details', 'completed_at'])
           = (old_row - ARRAY['amount', 'details', 'completed_at']) THEN
      RETURN NEW;
    END IF;
    IF TG_TABLE_NAME = 'financial_idempotency_records'
       AND old_row->>'response_status' IS NULL
       AND old_row->>'response_body' IS NULL
       AND old_row->>'completed_at' IS NULL
       AND new_row->>'response_status' IS NOT NULL
       AND new_row->'response_body' IS NOT NULL
       AND new_row->'response_body' <> 'null'::jsonb
       AND new_row->>'completed_at' IS NOT NULL
       AND (new_row - ARRAY['response_status', 'response_body', 'completed_at'])
           = (old_row - ARRAY['response_status', 'response_body', 'completed_at']) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Cannot update financial replay evidence in %', TG_TABLE_NAME;
  END;
  $$;

  CREATE OR REPLACE FUNCTION protect_financial_replay_evidence_delete()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION 'Cannot delete financial replay evidence from %', TG_TABLE_NAME;
    RETURN OLD;
  END;
  $$;

  CREATE OR REPLACE FUNCTION protect_financial_replay_evidence_truncate()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION 'Cannot truncate financial replay evidence from %', TG_TABLE_NAME;
    RETURN NULL;
  END;
  $$;

  DROP TRIGGER IF EXISTS retain_economy_daily_assessments_update ON economy_daily_assessments;
  CREATE TRIGGER retain_economy_daily_assessments_update
    BEFORE UPDATE ON economy_daily_assessments
    FOR EACH ROW EXECUTE FUNCTION protect_financial_replay_evidence_update();
  DROP TRIGGER IF EXISTS retain_economy_daily_assessments_delete ON economy_daily_assessments;
  CREATE TRIGGER retain_economy_daily_assessments_delete
    BEFORE DELETE ON economy_daily_assessments
    FOR EACH ROW EXECUTE FUNCTION protect_financial_replay_evidence_delete();
  DROP TRIGGER IF EXISTS retain_economy_daily_assessments_truncate ON economy_daily_assessments;
  CREATE TRIGGER retain_economy_daily_assessments_truncate
    BEFORE TRUNCATE ON economy_daily_assessments
    FOR EACH STATEMENT EXECUTE FUNCTION protect_financial_replay_evidence_truncate();

  DROP TRIGGER IF EXISTS retain_financial_idempotency_records_update ON financial_idempotency_records;
  CREATE TRIGGER retain_financial_idempotency_records_update
    BEFORE UPDATE ON financial_idempotency_records
    FOR EACH ROW EXECUTE FUNCTION protect_financial_replay_evidence_update();
  DROP TRIGGER IF EXISTS retain_financial_idempotency_records_delete ON financial_idempotency_records;
  CREATE TRIGGER retain_financial_idempotency_records_delete
    BEFORE DELETE ON financial_idempotency_records
    FOR EACH ROW EXECUTE FUNCTION protect_financial_replay_evidence_delete();
  DROP TRIGGER IF EXISTS retain_financial_idempotency_records_truncate ON financial_idempotency_records;
  CREATE TRIGGER retain_financial_idempotency_records_truncate
    BEFORE TRUNCATE ON financial_idempotency_records
    FOR EACH STATEMENT EXECUTE FUNCTION protect_financial_replay_evidence_truncate();
`;

async function up(pool) {
  await pool.query(FINANCIAL_REPLAY_RETENTION_SQL);
}

async function down() {
  throw new Error('Migration 080 is irreversible; financial replay evidence must remain immutable');
}

module.exports = { up, down, FINANCIAL_REPLAY_RETENTION_SQL };
