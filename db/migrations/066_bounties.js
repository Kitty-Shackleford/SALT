'use strict';

const BOUNTY_SCHEMA_SQL = `
  CREATE UNIQUE INDEX IF NOT EXISTS kill_events_id_server_uq
    ON kill_events (id, server_id);

  ALTER TABLE guild_economy_config
    ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);

  CREATE TABLE IF NOT EXISTS bounties (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    target_identity_id INTEGER NOT NULL,
    poster_identity_id INTEGER NOT NULL,
    created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    funding_type TEXT NOT NULL CHECK (funding_type = 'player_wallet'),
    amount NUMERIC(20, 2) NOT NULL CHECK (amount > 0),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'claimed', 'cancelled', 'expired')),
    reason TEXT,
    idempotency_key TEXT,
    idempotency_fingerprint TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    settled_at TIMESTAMPTZ,
    claimed_by_identity_id INTEGER,
    claim_kill_event_id INTEGER,
    cancel_reason TEXT,
    CHECK (target_identity_id <> COALESCE(poster_identity_id, -1)),
    UNIQUE (server_id, poster_identity_id, idempotency_key),
    UNIQUE (id, server_id),
    FOREIGN KEY (server_id, target_identity_id)
      REFERENCES server_player_memberships(server_id, identity_id) ON DELETE CASCADE,
    FOREIGN KEY (server_id, poster_identity_id)
      REFERENCES server_player_memberships(server_id, identity_id) ON DELETE CASCADE,
    FOREIGN KEY (server_id, claimed_by_identity_id)
      REFERENCES server_player_memberships(server_id, identity_id)
      ON DELETE SET NULL (claimed_by_identity_id),
    FOREIGN KEY (claim_kill_event_id, server_id)
      REFERENCES kill_events(id, server_id)
      ON DELETE SET NULL (claim_kill_event_id)
  );

  CREATE TABLE IF NOT EXISTS economy_precision_reconciliation (
    table_name TEXT NOT NULL,
    column_name TEXT NOT NULL,
    fractional_row_count BIGINT NOT NULL,
    before_sum NUMERIC,
    after_sum NUMERIC,
    rounding_delta NUMERIC NOT NULL,
    reconciled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (table_name, column_name)
  );

  CREATE TABLE IF NOT EXISTS economy_supply_precision_reconciliation (
    server_id INTEGER PRIMARY KEY REFERENCES servers(id) ON DELETE RESTRICT,
    assets_before NUMERIC NOT NULL,
    recorded_supply_before NUMERIC NOT NULL,
    assets_after_rounding NUMERIC NOT NULL,
    recorded_supply_after_rounding NUMERIC NOT NULL,
    rounding_delta NUMERIC NOT NULL,
    reconciled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  DO $$
  DECLARE
    target RECORD;
  BEGIN
    FOR target IN SELECT * FROM (VALUES
      ('player_wallets', 'cash_on_hand'),
      ('player_bank_accounts', 'balance'),
      ('economy_transactions', 'amount'),
      ('economy_transactions', 'balance_after'),
      ('economy_supply_log', 'amount'),
      ('economy_supply_log', 'supply_before'),
      ('economy_supply_log', 'supply_after'),
      ('guild_economy_config', 'starting_cash'),
      ('guild_economy_config', 'starting_bank'),
      ('guild_economy_config', 'total_money_supply'),
      ('guild_economy_config', 'kill_reward'),
      ('guild_economy_config', 'playtime_reward_per_hour'),
      ('guild_economy_config', 'achievement_bonus_multiplier'),
      ('guild_economy_config', 'territory_reward_per_hour'),
      ('guild_economy_config', 'death_penalty_amount'),
      ('guild_economy_config', 'death_penalty_max_loss'),
      ('guild_economy_config', 'transfer_fee_percentage'),
      ('guild_economy_config', 'transfer_offline_fee_percentage'),
      ('guild_economy_config', 'transfer_min_amount'),
      ('guild_economy_config', 'transfer_max_amount'),
      ('guild_economy_config', 'max_bank_balance'),
      ('guild_economy_config', 'bank_deposit_fee_percentage'),
      ('guild_economy_config', 'bank_withdraw_fee_percentage'),
      ('guild_economy_config', 'bank_daily_fee_amount'),
      ('guild_economy_config', 'inactivity_tax_percentage'),
      ('guild_economy_config', 'max_money_supply'),
      ('guild_economy_config', 'current_money_supply'),
      ('guild_economy_config', 'casino_min_bet'),
      ('guild_economy_config', 'casino_max_bet'),
      ('guild_economy_config', 'kill_loot_amount'),
      ('casino_sessions', 'reserved_wager')
    ) AS monetary_columns(table_name, column_name)
    LOOP
      EXECUTE format(
        'INSERT INTO economy_precision_reconciliation
           (table_name, column_name, fractional_row_count, before_sum, after_sum, rounding_delta)
         SELECT %L, %L,
                COUNT(*) FILTER (WHERE %I IS NOT NULL AND %I::numeric <> ROUND(%I::numeric, 2)),
                SUM(%I::numeric), SUM(ROUND(%I::numeric, 2)),
                COALESCE(SUM(ROUND(%I::numeric, 2)) - SUM(%I::numeric), 0)
         FROM %I
         ON CONFLICT (table_name, column_name) DO NOTHING',
        target.table_name, target.column_name,
        target.column_name, target.column_name, target.column_name,
        target.column_name, target.column_name, target.column_name, target.column_name,
        target.table_name
      );
    END LOOP;
  END;
  $$;

  INSERT INTO economy_supply_precision_reconciliation
    (server_id, assets_before, recorded_supply_before, assets_after_rounding,
     recorded_supply_after_rounding, rounding_delta)
  SELECT config.server_id,
         assets.before_total,
         config.current_money_supply::numeric,
         assets.after_total,
         assets.after_total AS recorded_supply_after_rounding,
         assets.after_total - assets.before_total AS rounding_delta
  FROM guild_economy_config config
  CROSS JOIN LATERAL (
    SELECT
      COALESCE((SELECT SUM(cash_on_hand::numeric) FROM player_wallets
                WHERE server_id = config.server_id), 0) +
      COALESCE((SELECT SUM(balance::numeric) FROM player_bank_accounts
                WHERE server_id = config.server_id), 0) +
      COALESCE((SELECT SUM(reserved_wager::numeric) FROM casino_sessions
                WHERE server_id = config.server_id AND status = 'active'), 0) +
      COALESCE((SELECT SUM(amount::numeric) FROM bounties
                WHERE server_id = config.server_id AND status = 'active'), 0) AS before_total,
      COALESCE((SELECT SUM(ROUND(cash_on_hand::numeric, 2)) FROM player_wallets
                WHERE server_id = config.server_id), 0) +
      COALESCE((SELECT SUM(ROUND(balance::numeric, 2)) FROM player_bank_accounts
                WHERE server_id = config.server_id), 0) +
      COALESCE((SELECT SUM(ROUND(reserved_wager::numeric, 2)) FROM casino_sessions
                WHERE server_id = config.server_id AND status = 'active'), 0) +
      COALESCE((SELECT SUM(ROUND(amount::numeric, 2)) FROM bounties
                WHERE server_id = config.server_id AND status = 'active'), 0) AS after_total
  ) assets
  WHERE config.fixed_supply_enabled = TRUE
  ON CONFLICT (server_id) DO NOTHING;

  DO $$
  DECLARE
    mismatch RECORD;
  BEGIN
    SELECT config.server_id, assets.before_total, config.current_money_supply::numeric AS recorded,
           assets.after_total, ROUND(config.current_money_supply::numeric, 2) AS recorded_after
    INTO mismatch
    FROM guild_economy_config config
    CROSS JOIN LATERAL (
      SELECT
        COALESCE((SELECT SUM(cash_on_hand::numeric) FROM player_wallets WHERE server_id = config.server_id), 0) +
        COALESCE((SELECT SUM(balance::numeric) FROM player_bank_accounts WHERE server_id = config.server_id), 0) +
        COALESCE((SELECT SUM(reserved_wager::numeric) FROM casino_sessions
                  WHERE server_id = config.server_id AND status = 'active'), 0) +
        COALESCE((SELECT SUM(amount::numeric) FROM bounties
                  WHERE server_id = config.server_id AND status = 'active'), 0) AS before_total,
        COALESCE((SELECT SUM(ROUND(cash_on_hand::numeric, 2)) FROM player_wallets WHERE server_id = config.server_id), 0) +
        COALESCE((SELECT SUM(ROUND(balance::numeric, 2)) FROM player_bank_accounts WHERE server_id = config.server_id), 0) +
        COALESCE((SELECT SUM(ROUND(reserved_wager::numeric, 2)) FROM casino_sessions
                  WHERE server_id = config.server_id AND status = 'active'), 0) +
        COALESCE((SELECT SUM(ROUND(amount::numeric, 2)) FROM bounties
                  WHERE server_id = config.server_id AND status = 'active'), 0) AS after_total
    ) assets
    WHERE config.fixed_supply_enabled = TRUE
      AND assets.before_total <> config.current_money_supply::numeric
    ORDER BY config.server_id
    LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'Migration 066 cannot reconcile fixed supply for server %: assets % / recorded %, rounded assets % / rounded recorded %',
        mismatch.server_id, mismatch.before_total, mismatch.recorded,
        mismatch.after_total, mismatch.recorded_after;
    END IF;
  END;
  $$;

  ALTER TABLE player_wallets
    ALTER COLUMN cash_on_hand TYPE NUMERIC(20, 2) USING ROUND(cash_on_hand::numeric, 2);
  ALTER TABLE player_bank_accounts
    ALTER COLUMN balance TYPE NUMERIC(20, 2) USING ROUND(balance::numeric, 2);
  ALTER TABLE economy_transactions
    ALTER COLUMN amount TYPE NUMERIC(20, 2) USING ROUND(amount::numeric, 2),
    ALTER COLUMN balance_after TYPE NUMERIC(20, 2) USING ROUND(balance_after::numeric, 2);
  ALTER TABLE economy_supply_log
    ALTER COLUMN amount TYPE NUMERIC(20, 2) USING ROUND(amount::numeric, 2),
    ALTER COLUMN supply_before TYPE NUMERIC(20, 2) USING ROUND(supply_before::numeric, 2),
    ALTER COLUMN supply_after TYPE NUMERIC(20, 2) USING ROUND(supply_after::numeric, 2);
  ALTER TABLE guild_economy_config
    ALTER COLUMN starting_cash TYPE NUMERIC(20, 2) USING ROUND(starting_cash::numeric, 2),
    ALTER COLUMN starting_bank TYPE NUMERIC(20, 2) USING ROUND(starting_bank::numeric, 2),
    ALTER COLUMN total_money_supply TYPE NUMERIC(20, 2) USING ROUND(total_money_supply::numeric, 2),
    ALTER COLUMN kill_reward TYPE NUMERIC(20, 2) USING ROUND(kill_reward::numeric, 2),
    ALTER COLUMN playtime_reward_per_hour TYPE NUMERIC(20, 2) USING ROUND(playtime_reward_per_hour::numeric, 2),
    ALTER COLUMN achievement_bonus_multiplier TYPE NUMERIC(20, 2) USING ROUND(achievement_bonus_multiplier::numeric, 2),
    ALTER COLUMN territory_reward_per_hour TYPE NUMERIC(20, 2) USING ROUND(territory_reward_per_hour::numeric, 2),
    ALTER COLUMN death_penalty_amount TYPE NUMERIC(20, 2) USING ROUND(death_penalty_amount::numeric, 2),
    ALTER COLUMN death_penalty_max_loss TYPE NUMERIC(20, 2) USING ROUND(death_penalty_max_loss::numeric, 2),
    ALTER COLUMN transfer_fee_percentage TYPE NUMERIC(20, 2) USING ROUND(transfer_fee_percentage::numeric, 2),
    ALTER COLUMN transfer_offline_fee_percentage TYPE NUMERIC(20, 2) USING ROUND(transfer_offline_fee_percentage::numeric, 2),
    ALTER COLUMN transfer_min_amount TYPE NUMERIC(20, 2) USING ROUND(transfer_min_amount::numeric, 2),
    ALTER COLUMN transfer_max_amount TYPE NUMERIC(20, 2) USING ROUND(transfer_max_amount::numeric, 2),
    ALTER COLUMN max_bank_balance TYPE NUMERIC(20, 2) USING ROUND(max_bank_balance::numeric, 2),
    ALTER COLUMN bank_deposit_fee_percentage TYPE NUMERIC(20, 2) USING ROUND(bank_deposit_fee_percentage::numeric, 2),
    ALTER COLUMN bank_withdraw_fee_percentage TYPE NUMERIC(20, 2) USING ROUND(bank_withdraw_fee_percentage::numeric, 2),
    ALTER COLUMN bank_daily_fee_amount TYPE NUMERIC(20, 2) USING ROUND(bank_daily_fee_amount::numeric, 2),
    ALTER COLUMN inactivity_tax_percentage TYPE NUMERIC(20, 2) USING ROUND(inactivity_tax_percentage::numeric, 2),
    ALTER COLUMN max_money_supply TYPE NUMERIC(20, 2) USING ROUND(max_money_supply::numeric, 2),
    ALTER COLUMN current_money_supply TYPE NUMERIC(20, 2) USING ROUND(current_money_supply::numeric, 2),
    ALTER COLUMN casino_min_bet TYPE NUMERIC(20, 2) USING ROUND(casino_min_bet::numeric, 2),
    ALTER COLUMN casino_max_bet TYPE NUMERIC(20, 2) USING ROUND(casino_max_bet::numeric, 2),
    ALTER COLUMN kill_loot_amount TYPE NUMERIC(20, 2) USING ROUND(kill_loot_amount::numeric, 2);
  ALTER TABLE casino_sessions
    ALTER COLUMN reserved_wager TYPE NUMERIC(20, 2) USING ROUND(reserved_wager::numeric, 2);

  UPDATE guild_economy_config config
  SET current_money_supply = ROUND(
    COALESCE((SELECT SUM(cash_on_hand) FROM player_wallets WHERE server_id = config.server_id), 0) +
    COALESCE((SELECT SUM(balance) FROM player_bank_accounts WHERE server_id = config.server_id), 0) +
    COALESCE((SELECT SUM(reserved_wager) FROM casino_sessions
              WHERE server_id = config.server_id AND status = 'active'), 0) +
    COALESCE((SELECT SUM(amount) FROM bounties
              WHERE server_id = config.server_id AND status = 'active'), 0), 2)
  WHERE config.fixed_supply_enabled = TRUE;

  DO $$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM player_wallets WHERE cash_on_hand * 100 <> TRUNC(cash_on_hand * 100)
      UNION ALL SELECT 1 FROM player_bank_accounts WHERE balance * 100 <> TRUNC(balance * 100)
      UNION ALL SELECT 1 FROM casino_sessions WHERE status = 'active'
        AND reserved_wager * 100 <> TRUNC(reserved_wager * 100)
      UNION ALL SELECT 1 FROM guild_economy_config WHERE fixed_supply_enabled = TRUE
        AND current_money_supply * 100 <> TRUNC(current_money_supply * 100)
    ) THEN
      RAISE EXCEPTION 'Migration 066 post-conversion exact-cent assertion failed';
    END IF;
    IF EXISTS (
      SELECT 1 FROM guild_economy_config config
      WHERE config.fixed_supply_enabled = TRUE
        AND (config.current_money_supply > config.max_money_supply
          OR config.current_money_supply <>
          COALESCE((SELECT SUM(cash_on_hand) FROM player_wallets WHERE server_id = config.server_id), 0) +
          COALESCE((SELECT SUM(balance) FROM player_bank_accounts WHERE server_id = config.server_id), 0) +
          COALESCE((SELECT SUM(reserved_wager) FROM casino_sessions
                    WHERE server_id = config.server_id AND status = 'active'), 0) +
          COALESCE((SELECT SUM(amount) FROM bounties
                    WHERE server_id = config.server_id AND status = 'active'), 0))
    ) THEN
      RAISE EXCEPTION 'Migration 066 post-conversion fixed-supply invariant failed';
    END IF;
  END;
  $$;

  CREATE TABLE IF NOT EXISTS bounty_settings (
    server_id INTEGER PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    player_posting_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    require_target_online BOOLEAN NOT NULL DEFAULT TRUE,
    online_freshness_minutes INTEGER NOT NULL DEFAULT 30
      CHECK (online_freshness_minutes BETWEEN 5 AND 120),
    minimum_amount NUMERIC(20, 2) NOT NULL DEFAULT 100 CHECK (minimum_amount > 0),
    maximum_amount NUMERIC(20, 2) NOT NULL DEFAULT 10000 CHECK (maximum_amount >= minimum_amount),
    default_expiry_hours INTEGER NOT NULL DEFAULT 168 CHECK (default_expiry_hours > 0),
    maximum_expiry_hours INTEGER NOT NULL DEFAULT 720 CHECK (maximum_expiry_hours >= default_expiry_hours),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS server_online_cache_snapshots (
    server_id INTEGER PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
    source_observed_at TIMESTAMPTZ NOT NULL,
    published_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  DELETE FROM server_online_cache cache
  WHERE NOT EXISTS (
    SELECT 1
    FROM player_server_activity activity
    WHERE activity.server_id = cache.server_id
      AND activity.identity_id = cache.identity_id
  );

  CREATE UNIQUE INDEX IF NOT EXISTS uq_player_server_activity_server_identity
    ON player_server_activity (server_id, identity_id);

  DO $$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'server_online_cache_activity_fk'
        AND conrelid = 'server_online_cache'::regclass
    ) AND NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'server_online_cache_activity_fk'
        AND conrelid = 'server_online_cache'::regclass
        AND contype = 'f'
        AND confrelid = 'player_server_activity'::regclass
        AND confdeltype = 'c'
        AND conkey = ARRAY[
          (SELECT attnum FROM pg_attribute
           WHERE attrelid = 'server_online_cache'::regclass AND attname = 'server_id'),
          (SELECT attnum FROM pg_attribute
           WHERE attrelid = 'server_online_cache'::regclass AND attname = 'identity_id')
        ]::smallint[]
        AND confkey = ARRAY[
          (SELECT attnum FROM pg_attribute
           WHERE attrelid = 'player_server_activity'::regclass AND attname = 'server_id'),
          (SELECT attnum FROM pg_attribute
           WHERE attrelid = 'player_server_activity'::regclass AND attname = 'identity_id')
        ]::smallint[]
    ) THEN
      RAISE EXCEPTION 'server_online_cache_activity_fk has an unexpected definition';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = 'server_online_cache'::regclass
        AND contype = 'f'
        AND confrelid = 'player_server_activity'::regclass
        AND confdeltype = 'c'
        AND conkey = ARRAY[
          (SELECT attnum FROM pg_attribute
           WHERE attrelid = 'server_online_cache'::regclass AND attname = 'server_id'),
          (SELECT attnum FROM pg_attribute
           WHERE attrelid = 'server_online_cache'::regclass AND attname = 'identity_id')
        ]::smallint[]
        AND confkey = ARRAY[
          (SELECT attnum FROM pg_attribute
           WHERE attrelid = 'player_server_activity'::regclass AND attname = 'server_id'),
          (SELECT attnum FROM pg_attribute
           WHERE attrelid = 'player_server_activity'::regclass AND attname = 'identity_id')
        ]::smallint[]
    ) THEN
      ALTER TABLE server_online_cache
        ADD CONSTRAINT server_online_cache_activity_fk
        FOREIGN KEY (server_id, identity_id)
        REFERENCES player_server_activity (server_id, identity_id)
        ON DELETE CASCADE;
    END IF;
  END;
  $$;

  CREATE TABLE IF NOT EXISTS bounty_claims (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    bounty_id INTEGER NOT NULL,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    kill_event_id INTEGER NOT NULL,
    claimant_identity_id INTEGER NOT NULL,
    victim_identity_id INTEGER NOT NULL,
    amount NUMERIC(20, 2) NOT NULL CHECK (amount > 0),
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (bounty_id),
    UNIQUE (bounty_id, kill_event_id),
    FOREIGN KEY (bounty_id, server_id) REFERENCES bounties(id, server_id) ON DELETE CASCADE,
    FOREIGN KEY (kill_event_id, server_id) REFERENCES kill_events(id, server_id) ON DELETE CASCADE,
    FOREIGN KEY (server_id, claimant_identity_id)
      REFERENCES server_player_memberships(server_id, identity_id) ON DELETE CASCADE,
    FOREIGN KEY (server_id, victim_identity_id)
      REFERENCES server_player_memberships(server_id, identity_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_bounties_active_target
    ON bounties (server_id, target_identity_id, expires_at)
    WHERE status = 'active';
  CREATE INDEX IF NOT EXISTS idx_bounties_poster_status
    ON bounties (server_id, poster_identity_id, status);
  CREATE INDEX IF NOT EXISTS idx_bounty_claims_kill
    ON bounty_claims (server_id, kill_event_id);

  CREATE OR REPLACE FUNCTION protect_active_bounty()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF OLD.status = 'active' THEN
      RAISE EXCEPTION 'Cannot delete active bounty escrow %', OLD.id;
    END IF;
    RETURN OLD;
  END;
  $$;

  DROP TRIGGER IF EXISTS protect_active_bounty_delete ON bounties;
  CREATE TRIGGER protect_active_bounty_delete
    BEFORE DELETE ON bounties
    FOR EACH ROW EXECUTE FUNCTION protect_active_bounty();

  CREATE OR REPLACE FUNCTION protect_active_bounty_truncate()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF EXISTS (SELECT 1 FROM bounties WHERE status = 'active') THEN
      RAISE EXCEPTION 'Cannot truncate active bounty escrow';
    END IF;
    RETURN NULL;
  END;
  $$;

  DROP TRIGGER IF EXISTS protect_active_bounty_truncate ON bounties;
  CREATE TRIGGER protect_active_bounty_truncate
    BEFORE TRUNCATE ON bounties
    FOR EACH STATEMENT EXECUTE FUNCTION protect_active_bounty_truncate();

  CREATE OR REPLACE FUNCTION protect_parent_with_active_bounty()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF TG_TABLE_NAME = 'servers' AND EXISTS (
      SELECT 1 FROM bounties WHERE server_id = OLD.id AND status = 'active'
    ) THEN
      RAISE EXCEPTION 'Cannot delete server with active bounty escrow';
    END IF;
    IF TG_TABLE_NAME = 'player_identities' AND EXISTS (
      SELECT 1 FROM bounties
      WHERE status = 'active'
        AND (target_identity_id = OLD.id OR poster_identity_id = OLD.id)
    ) THEN
      RAISE EXCEPTION 'Cannot delete identity with active bounty escrow';
    END IF;
    IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
    RETURN OLD;
  END;
  $$;

  DROP TRIGGER IF EXISTS protect_server_active_bounties ON servers;
  CREATE TRIGGER protect_server_active_bounties
    BEFORE DELETE ON servers
    FOR EACH ROW EXECUTE FUNCTION protect_parent_with_active_bounty();
  DROP TRIGGER IF EXISTS protect_server_deactivation_with_active_bounties ON servers;
  CREATE TRIGGER protect_server_deactivation_with_active_bounties
    BEFORE UPDATE OF status ON servers
    FOR EACH ROW
    WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status <> 'active')
    EXECUTE FUNCTION protect_parent_with_active_bounty();
  DROP TRIGGER IF EXISTS protect_identity_active_bounties ON player_identities;
  CREATE TRIGGER protect_identity_active_bounties
    BEFORE DELETE ON player_identities
    FOR EACH ROW EXECUTE FUNCTION protect_parent_with_active_bounty();

  CREATE OR REPLACE FUNCTION protect_active_casino_escrow()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF OLD.status = 'active' AND OLD.reserved_wager > 0 THEN
      RAISE EXCEPTION 'Cannot delete active casino escrow %', OLD.session_id;
    END IF;
    RETURN OLD;
  END;
  $$;
  DROP TRIGGER IF EXISTS protect_active_casino_delete ON casino_sessions;
  CREATE TRIGGER protect_active_casino_delete BEFORE DELETE ON casino_sessions
    FOR EACH ROW EXECUTE FUNCTION protect_active_casino_escrow();

  CREATE OR REPLACE FUNCTION protect_active_casino_truncate()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF EXISTS (SELECT 1 FROM casino_sessions WHERE status = 'active' AND reserved_wager > 0) THEN
      RAISE EXCEPTION 'Cannot truncate active casino escrow';
    END IF;
    RETURN NULL;
  END;
  $$;
  DROP TRIGGER IF EXISTS protect_active_casino_truncate ON casino_sessions;
  CREATE TRIGGER protect_active_casino_truncate BEFORE TRUNCATE ON casino_sessions
    FOR EACH STATEMENT EXECUTE FUNCTION protect_active_casino_truncate();

  CREATE OR REPLACE FUNCTION protect_parent_with_active_financial_escrow()
  RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE scoped_server INTEGER; scoped_identity INTEGER;
  BEGIN
    scoped_server := NULL;
    scoped_identity := NULL;
    IF TG_TABLE_NAME = 'servers' THEN scoped_server := OLD.id; END IF;
    IF TG_TABLE_NAME = 'server_player_memberships' THEN
      scoped_server := OLD.server_id;
      scoped_identity := OLD.identity_id;
    END IF;
    IF TG_TABLE_NAME = 'player_identities' THEN scoped_identity := OLD.id; END IF;
    IF TG_TABLE_NAME = 'guilds' AND EXISTS (
      SELECT 1 FROM servers s WHERE s.guild_id = OLD.id AND (
        EXISTS (SELECT 1 FROM bounties b WHERE b.server_id = s.id AND b.status = 'active') OR
        EXISTS (SELECT 1 FROM casino_sessions c WHERE c.server_id = s.id AND c.status = 'active' AND c.reserved_wager > 0)
      )
    ) THEN RAISE EXCEPTION 'Cannot delete guild with active financial escrow'; END IF;
    IF TG_TABLE_NAME = 'users' AND EXISTS (
      SELECT 1 FROM server_player_memberships m WHERE m.user_id = OLD.id AND (
        EXISTS (SELECT 1 FROM bounties b WHERE b.server_id = m.server_id AND b.status = 'active'
          AND (b.target_identity_id = m.identity_id OR b.poster_identity_id = m.identity_id)) OR
        EXISTS (SELECT 1 FROM casino_sessions c WHERE c.server_id = m.server_id AND c.identity_id = m.identity_id
          AND c.status = 'active' AND c.reserved_wager > 0)
      )
    ) THEN RAISE EXCEPTION 'Cannot delete user with active financial escrow'; END IF;
    IF scoped_server IS NOT NULL AND (
      EXISTS (SELECT 1 FROM bounties b WHERE b.server_id = scoped_server AND b.status = 'active'
        AND (scoped_identity IS NULL OR b.target_identity_id = scoped_identity OR b.poster_identity_id = scoped_identity)) OR
      EXISTS (SELECT 1 FROM casino_sessions c WHERE c.server_id = scoped_server AND c.status = 'active'
        AND c.reserved_wager > 0 AND (scoped_identity IS NULL OR c.identity_id = scoped_identity))
    ) THEN RAISE EXCEPTION 'Cannot destroy parent with active financial escrow'; END IF;
    IF TG_TABLE_NAME = 'player_identities' AND (
      EXISTS (SELECT 1 FROM bounties b WHERE b.status = 'active' AND (b.target_identity_id = OLD.id OR b.poster_identity_id = OLD.id)) OR
      EXISTS (SELECT 1 FROM casino_sessions c WHERE c.status = 'active' AND c.reserved_wager > 0 AND c.identity_id = OLD.id)
    ) THEN RAISE EXCEPTION 'Cannot delete identity with active financial escrow'; END IF;
    IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
    RETURN OLD;
  END;
  $$;
  DROP TRIGGER IF EXISTS protect_server_active_financial_escrow ON servers;
  CREATE TRIGGER protect_server_active_financial_escrow BEFORE DELETE ON servers
    FOR EACH ROW EXECUTE FUNCTION protect_parent_with_active_financial_escrow();
  DROP TRIGGER IF EXISTS protect_server_deactivation_financial_escrow ON servers;
  CREATE TRIGGER protect_server_deactivation_financial_escrow BEFORE UPDATE OF status ON servers
    FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status <> 'active')
    EXECUTE FUNCTION protect_parent_with_active_financial_escrow();
  DROP TRIGGER IF EXISTS protect_membership_active_financial_escrow ON server_player_memberships;
  CREATE TRIGGER protect_membership_active_financial_escrow BEFORE DELETE ON server_player_memberships
    FOR EACH ROW EXECUTE FUNCTION protect_parent_with_active_financial_escrow();
  DROP TRIGGER IF EXISTS protect_identity_active_financial_escrow ON player_identities;
  CREATE TRIGGER protect_identity_active_financial_escrow BEFORE DELETE ON player_identities
    FOR EACH ROW EXECUTE FUNCTION protect_parent_with_active_financial_escrow();
  DROP TRIGGER IF EXISTS protect_guild_active_financial_escrow ON guilds;
  CREATE TRIGGER protect_guild_active_financial_escrow BEFORE DELETE ON guilds
    FOR EACH ROW EXECUTE FUNCTION protect_parent_with_active_financial_escrow();
  DROP TRIGGER IF EXISTS protect_guild_deactivation_financial_escrow ON guilds;
  CREATE TRIGGER protect_guild_deactivation_financial_escrow BEFORE UPDATE OF status ON guilds
    FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status <> 'approved')
    EXECUTE FUNCTION protect_parent_with_active_financial_escrow();
  DROP TRIGGER IF EXISTS protect_user_active_financial_escrow ON users;
  CREATE TRIGGER protect_user_active_financial_escrow BEFORE DELETE ON users
    FOR EACH ROW EXECUTE FUNCTION protect_parent_with_active_financial_escrow();
`;

async function up(pool) {
  await pool.query(BOUNTY_SCHEMA_SQL);
}

async function down() {
  throw new Error('Migration 066 is irreversible; restore a verified database backup instead');
}

module.exports = { up, down, BOUNTY_SCHEMA_SQL };
