'use strict';

const SHOP_RENTAL_REFUND_EVIDENCE_SQL = `
  ALTER TABLE economy_transactions
    ADD COLUMN IF NOT EXISTS shop_order_id INTEGER,
    ADD COLUMN IF NOT EXISTS refund_claim_id BIGINT;

  CREATE UNIQUE INDEX IF NOT EXISTS economy_transactions_refund_claim_id_key
    ON economy_transactions(refund_claim_id)
    WHERE refund_claim_id IS NOT NULL;

  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'shop_orders_evidence_scope_key'
        AND conrelid = 'shop_orders'::regclass
    ) THEN
      ALTER TABLE shop_orders
        ADD CONSTRAINT shop_orders_evidence_scope_key UNIQUE (id, server_id, identity_id);
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'shop_orders_server_scope_key'
        AND conrelid = 'shop_orders'::regclass
    ) THEN
      ALTER TABLE shop_orders
        ADD CONSTRAINT shop_orders_server_scope_key UNIQUE (id, server_id);
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'shop_order_items_order_scope_key'
        AND conrelid = 'shop_order_items'::regclass
    ) THEN
      ALTER TABLE shop_order_items
        ADD CONSTRAINT shop_order_items_order_scope_key UNIQUE (id, order_id);
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'economy_transactions_shop_allocation_scope_key'
        AND conrelid = 'economy_transactions'::regclass
    ) THEN
      ALTER TABLE economy_transactions
        ADD CONSTRAINT economy_transactions_shop_allocation_scope_key
        UNIQUE (id, server_id, identity_id, account_type);
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'economy_transactions_shop_refund_scope_key'
        AND conrelid = 'economy_transactions'::regclass
    ) THEN
      ALTER TABLE economy_transactions
        ADD CONSTRAINT economy_transactions_shop_refund_scope_key
        UNIQUE (id, server_id, identity_id);
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'economy_transactions_shop_order_scope_fk'
        AND conrelid = 'economy_transactions'::regclass
    ) THEN
      ALTER TABLE economy_transactions
        ADD CONSTRAINT economy_transactions_shop_order_scope_fk
        FOREIGN KEY (shop_order_id, server_id, identity_id)
        REFERENCES shop_orders(id, server_id, identity_id) ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'server_restart_log_evidence_scope_key'
        AND conrelid = 'server_restart_log'::regclass
    ) THEN
      ALTER TABLE server_restart_log
        ADD CONSTRAINT server_restart_log_evidence_scope_key UNIQUE (id, server_id);
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'financial_refund_claims_evidence_scope_key'
        AND conrelid = 'financial_refund_claims'::regclass
    ) THEN
      ALTER TABLE financial_refund_claims
        ADD CONSTRAINT financial_refund_claims_evidence_scope_key
        UNIQUE (id, server_id, identity_id, amount);
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'economy_transactions_refund_claim_scope_fk'
        AND conrelid = 'economy_transactions'::regclass
    ) THEN
      ALTER TABLE economy_transactions
        ADD CONSTRAINT economy_transactions_refund_claim_scope_fk
        FOREIGN KEY (refund_claim_id, server_id, identity_id, amount)
        REFERENCES financial_refund_claims(id, server_id, identity_id, amount)
        ON DELETE RESTRICT;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'economy_transactions_refund_claim_required_check'
        AND conrelid = 'economy_transactions'::regclass
    ) THEN
      ALTER TABLE economy_transactions
        ADD CONSTRAINT economy_transactions_refund_claim_required_check CHECK (
          (source <> 'deferred_refund_claim' AND refund_claim_id IS NULL)
          OR (
            source = 'deferred_refund_claim'
            AND refund_claim_id IS NOT NULL
            AND transaction_type = 'earn'
            AND account_type = 'wallet'
          )
        ) NOT VALID;
    END IF;
  END;
  $$;

  CREATE TABLE IF NOT EXISTS shop_order_payment_allocations (
    id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    order_id INTEGER NOT NULL REFERENCES shop_orders(id) ON DELETE RESTRICT,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE RESTRICT,
    identity_id INTEGER NOT NULL REFERENCES player_identities(id) ON DELETE RESTRICT,
    account_type TEXT NOT NULL CHECK (account_type IN ('wallet', 'bank')),
    amount NUMERIC(20,2) NOT NULL CHECK (amount >= 0),
    economy_transaction_id INTEGER NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (order_id, account_type),
    FOREIGN KEY (order_id, server_id, identity_id)
      REFERENCES shop_orders(id, server_id, identity_id) ON DELETE RESTRICT,
    FOREIGN KEY (economy_transaction_id, server_id, identity_id, account_type)
      REFERENCES economy_transactions(id, server_id, identity_id, account_type) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS shop_rental_consumption_events (
    id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE RESTRICT,
    order_id INTEGER NOT NULL REFERENCES shop_orders(id) ON DELETE RESTRICT,
    order_item_id INTEGER NOT NULL REFERENCES shop_order_items(id) ON DELETE RESTRICT,
    restart_log_id INTEGER NOT NULL REFERENCES server_restart_log(id) ON DELETE RESTRICT,
    previous_restarts_remaining INTEGER NOT NULL CHECK (previous_restarts_remaining > 0),
    resulting_restarts_remaining INTEGER NOT NULL CHECK (resulting_restarts_remaining >= 0),
    consumed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (order_item_id, restart_log_id),
    CHECK (resulting_restarts_remaining = previous_restarts_remaining - 1),
    FOREIGN KEY (order_id, server_id)
      REFERENCES shop_orders(id, server_id) ON DELETE RESTRICT,
    FOREIGN KEY (order_item_id, order_id)
      REFERENCES shop_order_items(id, order_id) ON DELETE RESTRICT,
    FOREIGN KEY (restart_log_id, server_id)
      REFERENCES server_restart_log(id, server_id) ON DELETE RESTRICT
  );

  CREATE TABLE IF NOT EXISTS shop_refund_decisions (
    id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    order_id INTEGER NOT NULL UNIQUE REFERENCES shop_orders(id) ON DELETE RESTRICT,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE RESTRICT,
    identity_id INTEGER NOT NULL REFERENCES player_identities(id) ON DELETE RESTRICT,
    approved_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    reason_code TEXT NOT NULL,
    admin_note TEXT NOT NULL DEFAULT '',
    calculated_amount NUMERIC(20,2) NOT NULL CHECK (calculated_amount >= 0),
    approved_amount NUMERIC(20,2) NOT NULL CHECK (approved_amount >= 0),
    paid_amount NUMERIC(20,2) NOT NULL CHECK (paid_amount >= 0),
    override_applied BOOLEAN NOT NULL DEFAULT FALSE,
    policy_snapshot JSONB NOT NULL,
    payment_status TEXT NOT NULL CHECK (payment_status IN ('credited', 'deferred')),
    economy_transaction_id INTEGER UNIQUE,
    refund_claim_id BIGINT,
    decided_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK (approved_amount <= paid_amount),
    CHECK (override_applied OR approved_amount = calculated_amount),
    CHECK (
      (payment_status = 'credited' AND refund_claim_id IS NULL AND economy_transaction_id IS NOT NULL)
      OR (payment_status = 'deferred' AND refund_claim_id IS NOT NULL AND economy_transaction_id IS NULL)
    ),
    FOREIGN KEY (order_id, server_id, identity_id)
      REFERENCES shop_orders(id, server_id, identity_id) ON DELETE RESTRICT,
    FOREIGN KEY (economy_transaction_id, server_id, identity_id)
      REFERENCES economy_transactions(id, server_id, identity_id) ON DELETE RESTRICT,
    FOREIGN KEY (refund_claim_id, server_id, identity_id, approved_amount)
      REFERENCES financial_refund_claims(id, server_id, identity_id, amount) ON DELETE RESTRICT
  );

  CREATE INDEX IF NOT EXISTS shop_rental_consumption_order_item_idx
    ON shop_rental_consumption_events(order_item_id, consumed_at DESC);
  CREATE INDEX IF NOT EXISTS shop_refund_decisions_server_idx
    ON shop_refund_decisions(server_id, decided_at DESC);

  CREATE OR REPLACE FUNCTION validate_shop_order_payment_allocation()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1
      FROM economy_transactions et
      WHERE et.id = NEW.economy_transaction_id
        AND et.server_id = NEW.server_id
        AND et.identity_id = NEW.identity_id
        AND et.account_type = NEW.account_type
        AND et.shop_order_id = NEW.order_id
        AND et.transaction_type = 'debit'
        AND et.source = 'shop_purchase'
        AND et.amount = -NEW.amount
    ) THEN
      RAISE EXCEPTION 'Shop payment allocation does not match its debit transaction';
    END IF;
    RETURN NEW;
  END;
  $$;

  DROP TRIGGER IF EXISTS validate_shop_order_payment_allocation_insert
    ON shop_order_payment_allocations;
  CREATE TRIGGER validate_shop_order_payment_allocation_insert
    BEFORE INSERT ON shop_order_payment_allocations
    FOR EACH ROW EXECUTE FUNCTION validate_shop_order_payment_allocation();

  CREATE OR REPLACE FUNCTION validate_shop_rental_consumption_event()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    PERFORM 1
    FROM server_restart_log srl
    JOIN shop_orders so
      ON so.id = NEW.order_id AND so.server_id = NEW.server_id
    JOIN shop_order_items soi
      ON soi.id = NEW.order_item_id AND soi.order_id = so.id
    JOIN shop_items si ON si.id = soi.shop_item_id
    WHERE srl.id = NEW.restart_log_id
      AND srl.server_id = NEW.server_id
      AND srl.restart_type = 'scheduled'
      AND srl.detected_at >= so.checked_out_at
      AND NEW.consumed_at = srl.detected_at
      AND soi.restarts_remaining = NEW.previous_restarts_remaining
      AND CASE WHEN soi.snapshot_schema_version = 1
        THEN soi.item_type_snapshot ELSE si.item_type END = 'event_rental'
    FOR UPDATE OF soi;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Rental consumption requires the current counter and a scheduled restart on the same server';
    END IF;
    RETURN NEW;
  END;
  $$;

  DROP TRIGGER IF EXISTS validate_shop_rental_consumption_event_insert
    ON shop_rental_consumption_events;
  CREATE TRIGGER validate_shop_rental_consumption_event_insert
    BEFORE INSERT ON shop_rental_consumption_events
    FOR EACH ROW EXECUTE FUNCTION validate_shop_rental_consumption_event();

  CREATE OR REPLACE FUNCTION validate_shop_rental_counter_update()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW.restarts_remaining IS NOT DISTINCT FROM OLD.restarts_remaining THEN
      RETURN NEW;
    END IF;
    IF EXISTS (
      SELECT 1 FROM shop_orders
      WHERE id = OLD.order_id AND status = 'completed'
    ) AND NOT EXISTS (
      SELECT 1
      FROM shop_rental_consumption_events srce
      WHERE srce.order_item_id = OLD.id
        AND srce.order_id = OLD.order_id
        AND srce.previous_restarts_remaining = OLD.restarts_remaining
        AND srce.resulting_restarts_remaining = NEW.restarts_remaining
    ) THEN
      RAISE EXCEPTION 'Completed rental counter changes require matching consumption evidence';
    END IF;
    RETURN NEW;
  END;
  $$;

  DROP TRIGGER IF EXISTS validate_shop_rental_counter_update_evidence
    ON shop_order_items;
  CREATE TRIGGER validate_shop_rental_counter_update_evidence
    BEFORE UPDATE OF restarts_remaining ON shop_order_items
    FOR EACH ROW EXECUTE FUNCTION validate_shop_rental_counter_update();

  CREATE OR REPLACE FUNCTION protect_consumed_restart_evidence()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM shop_rental_consumption_events
      WHERE restart_log_id = OLD.id
    ) THEN
      RAISE EXCEPTION 'Consumed restart evidence is immutable';
    END IF;
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END;
  $$;

  DROP TRIGGER IF EXISTS retain_consumed_restart_evidence ON server_restart_log;
  CREATE TRIGGER retain_consumed_restart_evidence
    BEFORE UPDATE OR DELETE ON server_restart_log
    FOR EACH ROW EXECUTE FUNCTION protect_consumed_restart_evidence();

  CREATE OR REPLACE FUNCTION validate_shop_refund_credit_link()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW.economy_transaction_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM economy_transactions et
      WHERE et.id = NEW.economy_transaction_id
        AND et.server_id = NEW.server_id
        AND et.identity_id = NEW.identity_id
        AND et.account_type = 'wallet'
        AND et.shop_order_id = NEW.order_id
        AND et.transaction_type = 'credit'
        AND et.source = 'shop_refund'
        AND et.amount = NEW.approved_amount
    ) THEN
      RAISE EXCEPTION 'Shop refund decision does not match its wallet credit transaction';
    END IF;
    RETURN NEW;
  END;
  $$;

  DROP TRIGGER IF EXISTS validate_shop_refund_credit_link_insert
    ON shop_refund_decisions;
  CREATE TRIGGER validate_shop_refund_credit_link_insert
    BEFORE INSERT ON shop_refund_decisions
    FOR EACH ROW EXECUTE FUNCTION validate_shop_refund_credit_link();

  CREATE OR REPLACE FUNCTION validate_shop_refund_claim_link()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW.refund_claim_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM financial_refund_claims frc
      WHERE frc.id = NEW.refund_claim_id
        AND frc.server_id = NEW.server_id
        AND frc.identity_id = NEW.identity_id
        AND frc.amount = NEW.approved_amount
        AND frc.source_type = 'shop_order_refund'
        AND frc.source_key = NEW.order_id::text
    ) THEN
      RAISE EXCEPTION 'Shop refund decision does not match its deferred claim';
    END IF;
    RETURN NEW;
  END;
  $$;

  DROP TRIGGER IF EXISTS validate_shop_refund_claim_link_insert
    ON shop_refund_decisions;
  CREATE TRIGGER validate_shop_refund_claim_link_insert
    BEFORE INSERT ON shop_refund_decisions
    FOR EACH ROW EXECUTE FUNCTION validate_shop_refund_claim_link();

  CREATE OR REPLACE FUNCTION reject_shop_financial_evidence_mutation()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION 'Shop financial evidence is append-only';
  END;
  $$;

  DROP TRIGGER IF EXISTS retain_shop_order_payment_allocations ON shop_order_payment_allocations;
  CREATE TRIGGER retain_shop_order_payment_allocations
    BEFORE UPDATE OR DELETE ON shop_order_payment_allocations
    FOR EACH ROW EXECUTE FUNCTION reject_shop_financial_evidence_mutation();
  DROP TRIGGER IF EXISTS retain_shop_order_payment_allocations_truncate ON shop_order_payment_allocations;
  CREATE TRIGGER retain_shop_order_payment_allocations_truncate
    BEFORE TRUNCATE ON shop_order_payment_allocations
    FOR EACH STATEMENT EXECUTE FUNCTION reject_shop_financial_evidence_mutation();
  DROP TRIGGER IF EXISTS retain_shop_rental_consumption_events ON shop_rental_consumption_events;
  CREATE TRIGGER retain_shop_rental_consumption_events
    BEFORE UPDATE OR DELETE ON shop_rental_consumption_events
    FOR EACH ROW EXECUTE FUNCTION reject_shop_financial_evidence_mutation();
  DROP TRIGGER IF EXISTS retain_shop_rental_consumption_events_truncate ON shop_rental_consumption_events;
  CREATE TRIGGER retain_shop_rental_consumption_events_truncate
    BEFORE TRUNCATE ON shop_rental_consumption_events
    FOR EACH STATEMENT EXECUTE FUNCTION reject_shop_financial_evidence_mutation();
  DROP TRIGGER IF EXISTS retain_shop_refund_decisions ON shop_refund_decisions;
  CREATE TRIGGER retain_shop_refund_decisions
    BEFORE UPDATE OR DELETE ON shop_refund_decisions
    FOR EACH ROW EXECUTE FUNCTION reject_shop_financial_evidence_mutation();
  DROP TRIGGER IF EXISTS retain_shop_refund_decisions_truncate ON shop_refund_decisions;
  CREATE TRIGGER retain_shop_refund_decisions_truncate
    BEFORE TRUNCATE ON shop_refund_decisions
    FOR EACH STATEMENT EXECUTE FUNCTION reject_shop_financial_evidence_mutation();
`;

async function up(pool) {
  await pool.query(SHOP_RENTAL_REFUND_EVIDENCE_SQL);
}

async function down() {
  throw new Error('Migration 084 is irreversible; refund and rental evidence must remain immutable');
}

module.exports = { up, down, SHOP_RENTAL_REFUND_EVIDENCE_SQL };
