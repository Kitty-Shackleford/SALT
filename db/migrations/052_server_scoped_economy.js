/**
 * Migration 052: exact-server economy.
 *
 * Monetary rows created before this migration cannot be attributed to one
 * server without guessing.  The preflight therefore runs before every schema
 * mutation and aborts the transaction if any such row exists.  Operators must
 * export/settle those rows, take a backup, clear the legacy economy tables and
 * reset current_money_supply to zero before retrying.
 */
async function up(pool) {
  console.log('🔄 Migration 052: exact-server economy (fail-closed preflight)');

  await pool.query(`
    DO $$
    DECLARE
      supply_log_has_rows BOOLEAN := FALSE;
    BEGIN
      IF EXISTS (SELECT 1 FROM player_wallets) THEN
        RAISE EXCEPTION 'Migration 052 refused: legacy player_wallets cannot be assigned to a server safely. Back up/export and clear legacy economy data before retrying.';
      END IF;
      IF EXISTS (SELECT 1 FROM player_bank_accounts) THEN
        RAISE EXCEPTION 'Migration 052 refused: legacy player_bank_accounts cannot be assigned to a server safely. Back up/export and clear legacy economy data before retrying.';
      END IF;
      IF EXISTS (SELECT 1 FROM economy_transactions) THEN
        RAISE EXCEPTION 'Migration 052 refused: legacy economy_transactions cannot be assigned to a server safely. Back up/export and clear legacy economy data before retrying.';
      END IF;
      IF to_regclass('public.economy_supply_log') IS NOT NULL THEN
        EXECUTE 'SELECT EXISTS (SELECT 1 FROM economy_supply_log)'
          INTO supply_log_has_rows;
      END IF;
      IF supply_log_has_rows THEN
        RAISE EXCEPTION 'Migration 052 refused: legacy economy_supply_log cannot be assigned to a server safely. Back up/export and clear legacy economy data before retrying.';
      END IF;
      IF EXISTS (
        SELECT 1 FROM guild_economy_config
        WHERE COALESCE(current_money_supply, 0) <> 0
      ) THEN
        RAISE EXCEPTION 'Migration 052 refused: nonzero current_money_supply cannot be assigned to a server safely. Back up/export, reconcile, and reset it before retrying.';
      END IF;
      IF EXISTS (
        SELECT 1 FROM guild_economy_config gec
        WHERE (SELECT COUNT(*) FROM servers s WHERE s.guild_id = gec.guild_id) <> 1
      ) THEN
        RAISE EXCEPTION 'Migration 052 refused: legacy economy config requires exactly one server. Back up and remove or resolve ambiguous guild config before retrying.';
      END IF;
    END $$;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS economy_supply_log (
      id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
      change_type TEXT NOT NULL,
      source TEXT NOT NULL,
      amount REAL NOT NULL,
      supply_before REAL NOT NULL,
      supply_after REAL NOT NULL,
      identity_id INTEGER REFERENCES player_identities(id) ON DELETE SET NULL,
      server_id INTEGER REFERENCES servers(id) ON DELETE SET NULL,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      metadata TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_supply_log_guild ON economy_supply_log(guild_id);
    CREATE INDEX IF NOT EXISTS idx_supply_log_timestamp ON economy_supply_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_supply_log_type ON economy_supply_log(change_type);

    ALTER TABLE player_wallets
      ADD COLUMN IF NOT EXISTS server_id INTEGER REFERENCES servers(id) ON DELETE CASCADE;
    ALTER TABLE player_bank_accounts
      ADD COLUMN IF NOT EXISTS server_id INTEGER REFERENCES servers(id) ON DELETE CASCADE;
    ALTER TABLE economy_supply_log
      ADD COLUMN IF NOT EXISTS server_id INTEGER REFERENCES servers(id) ON DELETE CASCADE;
    ALTER TABLE guild_economy_config
      ADD COLUMN IF NOT EXISTS server_id INTEGER REFERENCES servers(id) ON DELETE CASCADE;

    UPDATE guild_economy_config gec
       SET server_id = s.id
      FROM servers s
     WHERE s.guild_id = gec.guild_id;

    ALTER TABLE player_wallets ALTER COLUMN server_id SET NOT NULL;
    ALTER TABLE player_bank_accounts ALTER COLUMN server_id SET NOT NULL;
    ALTER TABLE economy_transactions ALTER COLUMN server_id SET NOT NULL;
    ALTER TABLE economy_supply_log ALTER COLUMN server_id SET NOT NULL;
    ALTER TABLE guild_economy_config ALTER COLUMN server_id SET NOT NULL;
    ALTER TABLE economy_supply_log ALTER COLUMN guild_id DROP NOT NULL;

    ALTER TABLE economy_transactions
      DROP CONSTRAINT IF EXISTS economy_transactions_server_id_fkey;
    ALTER TABLE economy_transactions
      ADD CONSTRAINT economy_transactions_server_id_fkey
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE;
    ALTER TABLE economy_supply_log
      DROP CONSTRAINT IF EXISTS economy_supply_log_server_id_fkey;
    ALTER TABLE economy_supply_log
      ADD CONSTRAINT economy_supply_log_server_id_fkey
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE;

    ALTER TABLE player_wallets DROP CONSTRAINT IF EXISTS player_wallets_identity_id_key;
    ALTER TABLE player_bank_accounts DROP CONSTRAINT IF EXISTS player_bank_accounts_identity_id_key;
    ALTER TABLE guild_economy_config DROP CONSTRAINT IF EXISTS guild_economy_config_guild_id_key;

    ALTER TABLE player_wallets
      ADD CONSTRAINT player_wallets_identity_server_key UNIQUE (identity_id, server_id);
    ALTER TABLE player_bank_accounts
      ADD CONSTRAINT player_bank_accounts_identity_server_key UNIQUE (identity_id, server_id);
    ALTER TABLE guild_economy_config
      ADD CONSTRAINT guild_economy_config_server_key UNIQUE (server_id);

    CREATE INDEX IF NOT EXISTS economy_transactions_server_identity_timestamp_idx
      ON economy_transactions(server_id, identity_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS economy_supply_log_server_timestamp_idx
      ON economy_supply_log(server_id, timestamp DESC);
  `);

  console.log('✅ Migration 052 complete: economy is exact-server scoped');
}

async function down() {
  throw new Error(
    'Migration 052 is irreversible: exact-server balances cannot be collapsed safely. Restore a pre-052 backup for recovery.'
  );
}

module.exports = { up, down };
