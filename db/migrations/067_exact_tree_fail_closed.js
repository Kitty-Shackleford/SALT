'use strict';

const EXACT_TREE_FAIL_CLOSED_SQL = `
  -- A successful sync+parse watermark is distinct from last_sync_at: the latter
  -- is a local parse-generation checkpoint, while this cutoff proves that a
  -- provider download begun at or after the timestamp was parsed successfully.
  ALTER TABLE servers
    ADD COLUMN IF NOT EXISTS log_parse_watermark_at TIMESTAMPTZ;
  CREATE SEQUENCE IF NOT EXISTS server_online_cache_scan_generation_seq AS BIGINT;
  ALTER TABLE server_online_cache_snapshots
    ADD COLUMN IF NOT EXISTS scan_generation BIGINT NOT NULL DEFAULT 0
      CHECK (scan_generation >= 0);
  ALTER TABLE bounties
    ADD COLUMN IF NOT EXISTS cancellation_requested_at TIMESTAMPTZ;
  CREATE INDEX IF NOT EXISTS idx_bounties_pending_finality
    ON bounties (server_id, cancellation_requested_at, expires_at)
    WHERE status = 'active';

  CREATE TABLE IF NOT EXISTS financial_refund_claims (
    id BIGSERIAL PRIMARY KEY,
    server_id BIGINT NOT NULL REFERENCES servers(id),
    identity_id BIGINT NOT NULL REFERENCES player_identities(id),
    amount NUMERIC(20, 2) NOT NULL CHECK (amount > 0),
    source_type TEXT NOT NULL,
    source_key TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    claimed_at TIMESTAMPTZ,
    CONSTRAINT financial_refund_claims_status_time_check CHECK (
      (status = 'pending' AND claimed_at IS NULL)
      OR (status = 'claimed' AND claimed_at IS NOT NULL)
    ),
    UNIQUE (source_type, source_key),
    CONSTRAINT financial_refund_claims_membership_fk
      FOREIGN KEY (server_id, identity_id)
      REFERENCES server_player_memberships (server_id, identity_id)
  );
  CREATE INDEX IF NOT EXISTS idx_financial_refund_claims_pending
    ON financial_refund_claims (server_id, identity_id, id) WHERE status = 'pending';

  -- Migration 067 is rerunnable. Install the constraints on databases where an
  -- earlier unreleased revision already created the table.
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'financial_refund_claims_status_time_check'
                     AND conrelid = 'financial_refund_claims'::regclass) THEN
      ALTER TABLE financial_refund_claims
        ADD CONSTRAINT financial_refund_claims_status_time_check CHECK (
          (status = 'pending' AND claimed_at IS NULL)
          OR (status = 'claimed' AND claimed_at IS NOT NULL)
        );
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'financial_refund_claims_membership_fk'
                     AND conrelid = 'financial_refund_claims'::regclass) THEN
      ALTER TABLE financial_refund_claims
        ADD CONSTRAINT financial_refund_claims_membership_fk
        FOREIGN KEY (server_id, identity_id)
        REFERENCES server_player_memberships (server_id, identity_id);
    END IF;
  END;
  $$;

  -- These six remaining monetary columns were already NUMERIC(12,2), so widening
  -- is exact. Audit and fail closed if a legacy installation somehow contains
  -- non-cent values instead of silently rounding them.
  DO $$
  DECLARE target RECORD; fractional_count BIGINT;
  BEGIN
    FOR target IN SELECT * FROM (VALUES
      ('shop_items', 'price'),
      ('shop_orders', 'total_price'),
      ('shop_order_items', 'unit_price'),
      ('casino_game_history', 'wager'),
      ('casino_game_history', 'payout'),
      ('casino_game_history', 'net')
    ) AS monetary_columns(table_name, column_name)
    LOOP
      EXECUTE format(
        'SELECT COUNT(*) FROM %I WHERE %I IS NOT NULL AND %I::numeric <> ROUND(%I::numeric, 2)',
        target.table_name, target.column_name, target.column_name, target.column_name
      ) INTO fractional_count;
      EXECUTE format(
        'INSERT INTO economy_precision_reconciliation
           (table_name, column_name, fractional_row_count, before_sum, after_sum, rounding_delta)
         SELECT %L, %L,
                COUNT(*) FILTER (WHERE %I IS NOT NULL AND %I::numeric <> ROUND(%I::numeric, 2)),
                SUM(%I::numeric), SUM(%I::numeric), 0
         FROM %I
         ON CONFLICT (table_name, column_name) DO NOTHING',
        target.table_name, target.column_name,
        target.column_name, target.column_name, target.column_name,
        target.column_name, target.column_name, target.table_name
      );
      IF fractional_count > 0 THEN
        RAISE EXCEPTION 'Migration 067 refuses non-cent monetary values in %.%',
          target.table_name, target.column_name;
      END IF;
    END LOOP;
  END;
  $$;

  ALTER TABLE shop_items
    ALTER COLUMN price TYPE NUMERIC(20, 2);
  ALTER TABLE shop_orders
    ALTER COLUMN total_price TYPE NUMERIC(20, 2);
  ALTER TABLE shop_order_items
    ALTER COLUMN unit_price TYPE NUMERIC(20, 2);
  -- PostgreSQL will not alter either input type while the stored generated
  -- column depends on it. net is entirely derived, so recreate it around the
  -- exact widening rather than copying or rounding any authoritative value.
  ALTER TABLE casino_game_history
    DROP COLUMN net;
  ALTER TABLE casino_game_history
    ALTER COLUMN wager TYPE NUMERIC(20, 2),
    ALTER COLUMN payout TYPE NUMERIC(20, 2);
  ALTER TABLE casino_game_history
    ADD COLUMN net NUMERIC(20, 2)
      GENERATED ALWAYS AS (payout - wager) STORED;

  DO $$
  BEGIN
    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (table_name, column_name) IN (
          ('shop_items', 'price'), ('shop_orders', 'total_price'),
          ('shop_order_items', 'unit_price'), ('casino_game_history', 'wager'),
          ('casino_game_history', 'payout'), ('casino_game_history', 'net')
        )
        AND (data_type <> 'numeric' OR numeric_precision <> 20 OR numeric_scale <> 2)
    ) THEN
      RAISE EXCEPTION 'Migration 067 monetary type assertion failed';
    END IF;
  END;
  $$;

  CREATE OR REPLACE FUNCTION protect_membership_deactivation_with_active_financial_escrow()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM bounties b
      WHERE b.server_id = OLD.server_id
        AND b.status = 'active'
        AND (b.target_identity_id = OLD.identity_id OR b.poster_identity_id = OLD.identity_id)
    ) OR EXISTS (
      SELECT 1 FROM casino_sessions c
      WHERE c.server_id = OLD.server_id
        AND c.identity_id = OLD.identity_id
        AND c.status = 'active'
        AND c.reserved_wager > 0
    ) THEN
      RAISE EXCEPTION 'Cannot deactivate membership with active financial escrow';
    END IF;
    RETURN NEW;
  END;
  $$;

  DROP TRIGGER IF EXISTS protect_membership_deactivation_financial_escrow
    ON server_player_memberships;
  CREATE TRIGGER protect_membership_deactivation_financial_escrow
    BEFORE UPDATE OF status ON server_player_memberships
    FOR EACH ROW
    WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status <> 'active')
    EXECUTE FUNCTION protect_membership_deactivation_with_active_financial_escrow();

  CREATE OR REPLACE FUNCTION protect_wallet_with_active_financial_escrow()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM bounties b
      WHERE b.server_id = OLD.server_id
        AND b.poster_identity_id = OLD.identity_id
        AND b.status = 'active'
    ) OR EXISTS (
      SELECT 1 FROM casino_sessions c
      WHERE c.server_id = OLD.server_id
        AND c.identity_id = OLD.identity_id
        AND c.status = 'active'
        AND c.reserved_wager > 0
    ) THEN
      RAISE EXCEPTION 'Cannot delete wallet with active financial escrow';
    END IF;
    RETURN OLD;
  END;
  $$;

  DROP TRIGGER IF EXISTS protect_wallet_active_financial_escrow ON player_wallets;
  CREATE TRIGGER protect_wallet_active_financial_escrow
    BEFORE DELETE ON player_wallets
    FOR EACH ROW EXECUTE FUNCTION protect_wallet_with_active_financial_escrow();

  CREATE OR REPLACE FUNCTION protect_active_bounty_update()
  RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE old_row JSONB := to_jsonb(OLD); new_row JSONB := to_jsonb(NEW);
  BEGIN
    IF OLD.status = 'active' THEN
      -- Cancellation request: escrow stays active and only the cutoff/reason may change.
      IF NEW.status = 'active'
         AND OLD.cancellation_requested_at IS NULL
         AND NEW.cancellation_requested_at IS NOT NULL
         AND (new_row - ARRAY['cancellation_requested_at', 'cancel_reason'])
             = (old_row - ARRAY['cancellation_requested_at', 'cancel_reason']) THEN
        RETURN NEW;
      END IF;
      -- Claim: bind the terminal row to one claimant and one authoritative kill.
      IF NEW.status = 'claimed'
         AND NEW.settled_at IS NOT NULL
         AND NEW.claimed_by_identity_id IS NOT NULL
         AND NEW.claim_kill_event_id IS NOT NULL
         AND (new_row - ARRAY['status', 'settled_at', 'claimed_by_identity_id', 'claim_kill_event_id'])
             = (old_row - ARRAY['status', 'settled_at', 'claimed_by_identity_id', 'claim_kill_event_id']) THEN
        RETURN NEW;
      END IF;
      -- Expiry/cancellation: release escrow without changing value, owner, or scope.
      IF NEW.status IN ('cancelled', 'expired')
         AND NEW.settled_at IS NOT NULL
         AND (new_row - ARRAY['status', 'settled_at', 'cancel_reason'])
             = (old_row - ARRAY['status', 'settled_at', 'cancel_reason']) THEN
        RETURN NEW;
      END IF;
    END IF;
    RAISE EXCEPTION 'Cannot mutate bounty escrow outside an allowed lifecycle transition';
  END;
  $$;

  DROP TRIGGER IF EXISTS protect_bounty_escrow_update ON bounties;
  CREATE TRIGGER protect_bounty_escrow_update
    BEFORE UPDATE ON bounties
    FOR EACH ROW EXECUTE FUNCTION protect_active_bounty_update();

  CREATE OR REPLACE FUNCTION protect_active_casino_update()
  RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE old_row JSONB := to_jsonb(OLD); new_row JSONB := to_jsonb(NEW);
  BEGIN
    IF OLD.status = 'active' AND NEW.version = OLD.version + 1 THEN
      -- In-progress state may advance and reserved wager may only increase.
      IF NEW.status = 'active'
         AND NEW.reserved_wager >= OLD.reserved_wager
         AND (new_row - ARRAY['state', 'reserved_wager', 'version', 'updated_at'])
             = (old_row - ARRAY['state', 'reserved_wager', 'version', 'updated_at']) THEN
        RETURN NEW;
      END IF;
      -- Settlement may consume one final additional stake while becoming terminal.
      IF NEW.status = 'settled'
         AND NEW.settled_at IS NOT NULL
         AND NEW.reserved_wager >= OLD.reserved_wager
         AND (new_row - ARRAY['status', 'state', 'reserved_wager', 'version', 'settled_at', 'updated_at'])
             = (old_row - ARRAY['status', 'state', 'reserved_wager', 'version', 'settled_at', 'updated_at']) THEN
        RETURN NEW;
      END IF;
      -- Expiry is a status/version progression only; value and ownership stay fixed.
      IF NEW.status = 'expired'
         AND (new_row - ARRAY['status', 'version', 'updated_at'])
             = (old_row - ARRAY['status', 'version', 'updated_at']) THEN
        RETURN NEW;
      END IF;
    END IF;
    RAISE EXCEPTION 'Cannot mutate casino escrow outside an allowed lifecycle transition';
  END;
  $$;

  DROP TRIGGER IF EXISTS protect_casino_escrow_update ON casino_sessions;
  CREATE TRIGGER protect_casino_escrow_update
    BEFORE UPDATE ON casino_sessions
    FOR EACH ROW EXECUTE FUNCTION protect_active_casino_update();

  CREATE OR REPLACE FUNCTION server_has_financial_history(p_server_id BIGINT)
  RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
    SELECT EXISTS (SELECT 1 FROM economy_transactions WHERE server_id = p_server_id)
      OR EXISTS (SELECT 1 FROM economy_supply_log WHERE server_id = p_server_id)
      OR EXISTS (SELECT 1 FROM player_wallets WHERE server_id = p_server_id)
      OR EXISTS (SELECT 1 FROM player_bank_accounts WHERE server_id = p_server_id)
      OR EXISTS (SELECT 1 FROM bounties WHERE server_id = p_server_id)
      OR EXISTS (SELECT 1 FROM bounty_claims WHERE server_id = p_server_id)
      OR EXISTS (SELECT 1 FROM casino_sessions WHERE server_id = p_server_id)
      OR EXISTS (SELECT 1 FROM casino_game_history WHERE server_id = p_server_id)
      OR EXISTS (SELECT 1 FROM financial_refund_claims WHERE server_id = p_server_id)
      OR EXISTS (SELECT 1 FROM shop_orders WHERE server_id = p_server_id)
      OR EXISTS (SELECT 1 FROM shop_order_items soi JOIN shop_orders so ON so.id = soi.order_id
                 WHERE so.server_id = p_server_id);
  $$;

  CREATE OR REPLACE FUNCTION identity_has_financial_history(p_identity_id BIGINT, p_server_id BIGINT)
  RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
    SELECT EXISTS (SELECT 1 FROM economy_transactions
                   WHERE identity_id = p_identity_id AND (p_server_id IS NULL OR server_id = p_server_id))
      OR EXISTS (SELECT 1 FROM economy_supply_log
                 WHERE identity_id = p_identity_id AND (p_server_id IS NULL OR server_id = p_server_id))
      OR EXISTS (SELECT 1 FROM player_wallets
                 WHERE identity_id = p_identity_id AND (p_server_id IS NULL OR server_id = p_server_id))
      OR EXISTS (SELECT 1 FROM player_bank_accounts
                 WHERE identity_id = p_identity_id AND (p_server_id IS NULL OR server_id = p_server_id))
      OR EXISTS (SELECT 1 FROM bounties WHERE (p_server_id IS NULL OR server_id = p_server_id)
                 AND (target_identity_id = p_identity_id OR poster_identity_id = p_identity_id
                      OR claimed_by_identity_id = p_identity_id))
      OR EXISTS (SELECT 1 FROM bounty_claims WHERE (p_server_id IS NULL OR server_id = p_server_id)
                 AND (claimant_identity_id = p_identity_id OR victim_identity_id = p_identity_id))
      OR EXISTS (SELECT 1 FROM casino_sessions
                 WHERE identity_id = p_identity_id AND (p_server_id IS NULL OR server_id = p_server_id))
      OR EXISTS (SELECT 1 FROM casino_game_history
                 WHERE identity_id = p_identity_id AND (p_server_id IS NULL OR server_id = p_server_id))
      OR EXISTS (SELECT 1 FROM financial_refund_claims
                 WHERE identity_id = p_identity_id AND (p_server_id IS NULL OR server_id = p_server_id))
      OR EXISTS (SELECT 1 FROM shop_orders
                 WHERE identity_id = p_identity_id AND (p_server_id IS NULL OR server_id = p_server_id));
  $$;

  CREATE OR REPLACE FUNCTION protect_terminal_financial_history_update()
  RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE old_row JSONB := to_jsonb(OLD); new_row JSONB := to_jsonb(NEW);
  BEGIN
    IF TG_TABLE_NAME = 'shop_orders' THEN
      -- Cart totals may be recalculated, but ownership, scope and status are fixed.
      IF OLD.status = 'cart' AND NEW.status = 'cart'
         AND (new_row - 'total_price') = (old_row - 'total_price') THEN
        RETURN NEW;
      END IF;
      -- Checkout atomically freezes the paid total and checkout timestamp.
      IF OLD.status = 'cart' AND NEW.status = 'completed'
         AND NEW.checked_out_at IS NOT NULL
         AND (new_row - ARRAY['status', 'total_price', 'checked_out_at'])
             = (old_row - ARRAY['status', 'total_price', 'checked_out_at']) THEN
        RETURN NEW;
      END IF;
      IF OLD.status = 'completed' AND NEW.status = 'expired'
         AND (new_row - 'status') = (old_row - 'status') THEN
        RETURN NEW;
      END IF;
      IF OLD.status IN ('completed', 'expired')
         AND NEW.status = 'refunded'
         AND (new_row - 'status') = (old_row - 'status') THEN
        RETURN NEW;
      END IF;
    END IF;
    IF TG_TABLE_NAME = 'shop_order_items'
       AND old_row->>'order_id' = new_row->>'order_id' THEN
      IF EXISTS (SELECT 1 FROM shop_orders
                 WHERE id = (old_row->>'order_id')::BIGINT AND status = 'cart') THEN
        -- Player cart edits are limited to quantity and placement.
        IF (new_row - ARRAY['quantity', 'pos_x', 'pos_y', 'pos_z', 'ypr_x', 'ypr_y', 'ypr_z'])
             = (old_row - ARRAY['quantity', 'pos_x', 'pos_y', 'pos_z', 'ypr_x', 'ypr_y', 'ypr_z']) THEN
          RETURN NEW;
        END IF;
        -- Checkout may assign the collision-free provider event identity.
        IF (new_row - 'event_name_snapshot') = (old_row - 'event_name_snapshot')
           AND NEW.event_name_snapshot IS NOT NULL THEN
          RETURN NEW;
        END IF;
        -- Checkout may write only provider/rental lifecycle state.
        IF (new_row - ARRAY['file_entry_id', 'restarts_remaining', 'is_active'])
             = (old_row - ARRAY['file_entry_id', 'restarts_remaining', 'is_active']) THEN
          RETURN NEW;
        END IF;
      END IF;
      IF EXISTS (SELECT 1 FROM shop_orders
                 WHERE id = (old_row->>'order_id')::BIGINT AND status = 'completed')
         AND NEW.restarts_remaining = OLD.restarts_remaining - 1
         AND (new_row - 'restarts_remaining') = (old_row - 'restarts_remaining') THEN
        RETURN NEW;
      END IF;
      IF EXISTS (SELECT 1 FROM shop_orders
                 WHERE id = (old_row->>'order_id')::BIGINT
                   AND status IN ('completed', 'expired'))
         AND OLD.is_active = TRUE AND NEW.is_active = FALSE
         AND (new_row - 'is_active') = (old_row - 'is_active') THEN
        RETURN NEW;
      END IF;
    END IF;
    IF TG_TABLE_NAME = 'financial_refund_claims'
       AND old_row->>'status' = 'pending' AND new_row->>'status' = 'claimed'
       AND (new_row - 'status' - 'claimed_at') = (old_row - 'status' - 'claimed_at')
       AND new_row->>'claimed_at' IS NOT NULL THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Cannot update terminal financial history in %', TG_TABLE_NAME;
  END;
  $$;

  CREATE OR REPLACE FUNCTION protect_terminal_financial_history_delete()
  RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE old_row JSONB := to_jsonb(OLD);
  BEGIN
    IF TG_TABLE_NAME = 'shop_order_items' AND EXISTS (
      SELECT 1 FROM shop_orders
      WHERE id = (old_row->>'order_id')::BIGINT AND status = 'cart'
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Cannot delete terminal financial history from %', TG_TABLE_NAME;
    RETURN OLD;
  END;
  $$;

  CREATE OR REPLACE FUNCTION protect_terminal_financial_history_truncate()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION 'Cannot truncate terminal financial history from %', TG_TABLE_NAME;
    RETURN NULL;
  END;
  $$;

  DO $$
  DECLARE target_table TEXT;
  BEGIN
    FOREACH target_table IN ARRAY ARRAY[
      'economy_transactions', 'economy_supply_log', 'bounty_claims',
      'casino_game_history', 'shop_orders', 'shop_order_items',
      'economy_precision_reconciliation',
      'economy_supply_precision_reconciliation', 'financial_refund_claims'
    ] LOOP
      EXECUTE format('DROP TRIGGER IF EXISTS retain_%s_update ON %I', target_table, target_table);
      EXECUTE format(
        'CREATE TRIGGER retain_%s_update BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION protect_terminal_financial_history_update()',
        target_table, target_table);
    END LOOP;
  END;
  $$;

  DROP TRIGGER IF EXISTS retain_economy_transactions_delete ON economy_transactions;
  CREATE TRIGGER retain_economy_transactions_delete BEFORE DELETE ON economy_transactions
    FOR EACH ROW EXECUTE FUNCTION protect_terminal_financial_history_delete();
  DROP TRIGGER IF EXISTS retain_economy_transactions_truncate ON economy_transactions;
  CREATE TRIGGER retain_economy_transactions_truncate BEFORE TRUNCATE ON economy_transactions
    FOR EACH STATEMENT EXECUTE FUNCTION protect_terminal_financial_history_truncate();

  DROP TRIGGER IF EXISTS retain_economy_supply_log_delete ON economy_supply_log;
  CREATE TRIGGER retain_economy_supply_log_delete BEFORE DELETE ON economy_supply_log
    FOR EACH ROW EXECUTE FUNCTION protect_terminal_financial_history_delete();
  DROP TRIGGER IF EXISTS retain_economy_supply_log_truncate ON economy_supply_log;
  CREATE TRIGGER retain_economy_supply_log_truncate BEFORE TRUNCATE ON economy_supply_log
    FOR EACH STATEMENT EXECUTE FUNCTION protect_terminal_financial_history_truncate();

  DROP TRIGGER IF EXISTS retain_bounty_claims_delete ON bounty_claims;
  CREATE TRIGGER retain_bounty_claims_delete BEFORE DELETE ON bounty_claims
    FOR EACH ROW EXECUTE FUNCTION protect_terminal_financial_history_delete();
  DROP TRIGGER IF EXISTS retain_bounty_claims_truncate ON bounty_claims;
  CREATE TRIGGER retain_bounty_claims_truncate BEFORE TRUNCATE ON bounty_claims
    FOR EACH STATEMENT EXECUTE FUNCTION protect_terminal_financial_history_truncate();

  DROP TRIGGER IF EXISTS retain_casino_game_history_delete ON casino_game_history;
  CREATE TRIGGER retain_casino_game_history_delete BEFORE DELETE ON casino_game_history
    FOR EACH ROW EXECUTE FUNCTION protect_terminal_financial_history_delete();
  DROP TRIGGER IF EXISTS retain_casino_game_history_truncate ON casino_game_history;
  CREATE TRIGGER retain_casino_game_history_truncate BEFORE TRUNCATE ON casino_game_history
    FOR EACH STATEMENT EXECUTE FUNCTION protect_terminal_financial_history_truncate();

  DROP TRIGGER IF EXISTS retain_shop_order_items_delete ON shop_order_items;
  CREATE TRIGGER retain_shop_order_items_delete BEFORE DELETE ON shop_order_items
    FOR EACH ROW EXECUTE FUNCTION protect_terminal_financial_history_delete();
  DROP TRIGGER IF EXISTS retain_shop_order_items_truncate ON shop_order_items;
  CREATE TRIGGER retain_shop_order_items_truncate BEFORE TRUNCATE ON shop_order_items
    FOR EACH STATEMENT EXECUTE FUNCTION protect_terminal_financial_history_truncate();

  DROP TRIGGER IF EXISTS retain_economy_precision_reconciliation_delete ON economy_precision_reconciliation;
  CREATE TRIGGER retain_economy_precision_reconciliation_delete BEFORE DELETE ON economy_precision_reconciliation
    FOR EACH ROW EXECUTE FUNCTION protect_terminal_financial_history_delete();
  DROP TRIGGER IF EXISTS retain_economy_precision_reconciliation_truncate ON economy_precision_reconciliation;
  CREATE TRIGGER retain_economy_precision_reconciliation_truncate BEFORE TRUNCATE ON economy_precision_reconciliation
    FOR EACH STATEMENT EXECUTE FUNCTION protect_terminal_financial_history_truncate();

  DROP TRIGGER IF EXISTS retain_economy_supply_precision_reconciliation_delete ON economy_supply_precision_reconciliation;
  CREATE TRIGGER retain_economy_supply_precision_reconciliation_delete BEFORE DELETE ON economy_supply_precision_reconciliation
    FOR EACH ROW EXECUTE FUNCTION protect_terminal_financial_history_delete();
  DROP TRIGGER IF EXISTS retain_economy_supply_precision_reconciliation_truncate ON economy_supply_precision_reconciliation;
  CREATE TRIGGER retain_economy_supply_precision_reconciliation_truncate BEFORE TRUNCATE ON economy_supply_precision_reconciliation
    FOR EACH STATEMENT EXECUTE FUNCTION protect_terminal_financial_history_truncate();

  DROP TRIGGER IF EXISTS retain_financial_refund_claims_delete ON financial_refund_claims;
  CREATE TRIGGER retain_financial_refund_claims_delete BEFORE DELETE ON financial_refund_claims
    FOR EACH ROW EXECUTE FUNCTION protect_terminal_financial_history_delete();
  DROP TRIGGER IF EXISTS retain_financial_refund_claims_truncate ON financial_refund_claims;
  CREATE TRIGGER retain_financial_refund_claims_truncate BEFORE TRUNCATE ON financial_refund_claims
    FOR EACH STATEMENT EXECUTE FUNCTION protect_terminal_financial_history_truncate();

  CREATE OR REPLACE FUNCTION protect_parent_with_financial_history()
  RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE old_row JSONB := to_jsonb(OLD);
  BEGIN
    IF TG_TABLE_NAME = 'servers' AND server_has_financial_history((old_row->>'id')::BIGINT) THEN
      RAISE EXCEPTION 'Cannot delete server; financial history must be retained';
    ELSIF TG_TABLE_NAME = 'guilds' AND EXISTS (
      SELECT 1 FROM servers s WHERE s.guild_id = (old_row->>'id')::BIGINT AND server_has_financial_history(s.id)
    ) THEN
      RAISE EXCEPTION 'Cannot delete guild; financial history must be retained';
    ELSIF TG_TABLE_NAME = 'users' AND (
      EXISTS (SELECT 1 FROM server_player_memberships m WHERE m.user_id = (old_row->>'id')::BIGINT
              AND identity_has_financial_history(m.identity_id, m.server_id))
      OR EXISTS (SELECT 1 FROM casino_sessions WHERE user_id = (old_row->>'id')::BIGINT)
      OR EXISTS (SELECT 1 FROM bounties WHERE created_by_user_id = (old_row->>'id')::BIGINT)
    ) THEN
      RAISE EXCEPTION 'Cannot delete user; financial history must be retained';
    ELSIF TG_TABLE_NAME = 'player_identities'
      AND identity_has_financial_history((old_row->>'id')::BIGINT, NULL) THEN
      RAISE EXCEPTION 'Cannot delete identity; financial history must be retained';
    ELSIF TG_TABLE_NAME = 'server_player_memberships'
      AND identity_has_financial_history(
        (old_row->>'identity_id')::BIGINT, (old_row->>'server_id')::BIGINT) THEN
      RAISE EXCEPTION 'Cannot delete membership; financial history must be retained';
    ELSIF TG_TABLE_NAME IN ('player_wallets', 'player_bank_accounts')
      AND identity_has_financial_history(
        (old_row->>'identity_id')::BIGINT, (old_row->>'server_id')::BIGINT) THEN
      RAISE EXCEPTION 'Cannot delete account; financial history must be retained';
    ELSIF TG_TABLE_NAME = 'kill_events' AND (
      EXISTS (SELECT 1 FROM bounties WHERE claim_kill_event_id = (old_row->>'id')::BIGINT
              AND server_id = (old_row->>'server_id')::BIGINT)
      OR EXISTS (SELECT 1 FROM bounty_claims WHERE kill_event_id = (old_row->>'id')::BIGINT
                 AND server_id = (old_row->>'server_id')::BIGINT)
    ) THEN
      RAISE EXCEPTION 'Cannot delete kill event; financial history must be retained';
    ELSIF TG_TABLE_NAME IN ('bounties', 'casino_sessions', 'shop_orders') THEN
      RAISE EXCEPTION 'Cannot delete financial record; financial history must be retained';
    END IF;
    RETURN OLD;
  END;
  $$;

  DROP TRIGGER IF EXISTS retain_server_financial_history ON servers;
  CREATE TRIGGER retain_server_financial_history BEFORE DELETE ON servers
    FOR EACH ROW EXECUTE FUNCTION protect_parent_with_financial_history();
  DROP TRIGGER IF EXISTS retain_guild_financial_history ON guilds;
  CREATE TRIGGER retain_guild_financial_history BEFORE DELETE ON guilds
    FOR EACH ROW EXECUTE FUNCTION protect_parent_with_financial_history();
  DROP TRIGGER IF EXISTS retain_user_financial_history ON users;
  CREATE TRIGGER retain_user_financial_history BEFORE DELETE ON users
    FOR EACH ROW EXECUTE FUNCTION protect_parent_with_financial_history();
  DROP TRIGGER IF EXISTS retain_identity_financial_history ON player_identities;
  CREATE TRIGGER retain_identity_financial_history BEFORE DELETE ON player_identities
    FOR EACH ROW EXECUTE FUNCTION protect_parent_with_financial_history();
  DROP TRIGGER IF EXISTS retain_membership_financial_history ON server_player_memberships;
  CREATE TRIGGER retain_membership_financial_history BEFORE DELETE ON server_player_memberships
    FOR EACH ROW EXECUTE FUNCTION protect_parent_with_financial_history();
  DROP TRIGGER IF EXISTS retain_wallet_financial_history ON player_wallets;
  CREATE TRIGGER retain_wallet_financial_history BEFORE DELETE ON player_wallets
    FOR EACH ROW EXECUTE FUNCTION protect_parent_with_financial_history();
  DROP TRIGGER IF EXISTS retain_bank_financial_history ON player_bank_accounts;
  CREATE TRIGGER retain_bank_financial_history BEFORE DELETE ON player_bank_accounts
    FOR EACH ROW EXECUTE FUNCTION protect_parent_with_financial_history();
  DROP TRIGGER IF EXISTS retain_kill_financial_history ON kill_events;
  CREATE TRIGGER retain_kill_financial_history BEFORE DELETE ON kill_events
    FOR EACH ROW EXECUTE FUNCTION protect_parent_with_financial_history();
  DROP TRIGGER IF EXISTS retain_bounty_financial_history ON bounties;
  CREATE TRIGGER retain_bounty_financial_history BEFORE DELETE ON bounties
    FOR EACH ROW EXECUTE FUNCTION protect_parent_with_financial_history();
  DROP TRIGGER IF EXISTS retain_casino_financial_history ON casino_sessions;
  CREATE TRIGGER retain_casino_financial_history BEFORE DELETE ON casino_sessions
    FOR EACH ROW EXECUTE FUNCTION protect_parent_with_financial_history();
  DROP TRIGGER IF EXISTS retain_shop_order_financial_history ON shop_orders;
  CREATE TRIGGER retain_shop_order_financial_history BEFORE DELETE ON shop_orders
    FOR EACH ROW EXECUTE FUNCTION protect_parent_with_financial_history();

  DO $$
  DECLARE target_table TEXT;
  BEGIN
    FOREACH target_table IN ARRAY ARRAY[
      'servers', 'guilds', 'users', 'player_identities', 'server_player_memberships',
      'player_wallets', 'player_bank_accounts', 'kill_events', 'bounties',
      'casino_sessions', 'shop_orders', 'guild_economy_config', 'shop_items'
    ] LOOP
      EXECUTE format('DROP TRIGGER IF EXISTS retain_%s_truncate ON %I', target_table, target_table);
      EXECUTE format(
        'CREATE TRIGGER retain_%s_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION protect_terminal_financial_history_truncate()',
        target_table, target_table);
    END LOOP;
  END;
  $$;
`;

async function up(pool) {
  await pool.query(EXACT_TREE_FAIL_CLOSED_SQL);
}

async function down() {
  throw new Error('Migration 067 is irreversible; restore a verified database backup instead');
}

module.exports = { up, down, EXACT_TREE_FAIL_CLOSED_SQL };
