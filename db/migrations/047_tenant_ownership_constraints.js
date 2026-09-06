/**
 * Migration 047: Enforce tenant ownership boundaries.
 *
 * A stable Nitrado user ID belongs to one Discord guild, a Nitrado service
 * belongs to one guild, and a game identity can be claimed by one user only.
 */
async function up(pool) {
  console.log('🔄 Migration 047: Enforce tenant ownership boundaries');

  await pool.query(`
    ALTER TABLE guild_tokens
      ADD COLUMN IF NOT EXISTS nitrado_user_id TEXT;
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT nitrado_user_id
        FROM guild_tokens
        WHERE nitrado_user_id IS NOT NULL
        GROUP BY nitrado_user_id
        HAVING COUNT(DISTINCT guild_id) > 1
      ) THEN
        RAISE EXCEPTION 'Cannot enforce Nitrado ownership: an account is assigned to multiple guilds';
      END IF;
      IF EXISTS (
        SELECT identity_id
        FROM linked_accounts
        GROUP BY identity_id
        HAVING COUNT(DISTINCT user_id) > 1
      ) THEN
        RAISE EXCEPTION 'Cannot enforce player ownership: an identity is assigned to multiple users';
      END IF;
      IF EXISTS (
        SELECT platform_server_id
        FROM servers
        GROUP BY platform_server_id
        HAVING COUNT(*) > 1
      ) THEN
        RAISE EXCEPTION 'Cannot enforce server ownership: a service is assigned to multiple guilds';
      END IF;
    END $$;
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS guild_tokens_nitrado_user_owner_uq
      ON guild_tokens (nitrado_user_id)
      WHERE nitrado_user_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS linked_accounts_identity_owner_uq
      ON linked_accounts (identity_id);
    CREATE UNIQUE INDEX IF NOT EXISTS servers_platform_server_owner_uq
      ON servers (platform_server_id);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS player_link_challenges (
      id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      identity_id INTEGER NOT NULL REFERENCES player_identities(id) ON DELETE CASCADE,
      guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
      server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      sequence JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'verified', 'expired', 'cancelled')),
      expires_at TIMESTAMPTZ NOT NULL,
      verified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS player_link_challenges_identity_pending_uq
      ON player_link_challenges (identity_id)
      WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS player_link_challenges_user_status_idx
      ON player_link_challenges (user_id, status);
  `);

  console.log('✅ Migration 047 complete');
}

async function down(pool) {
  await pool.query('DROP TABLE IF EXISTS player_link_challenges;');
  await pool.query('DROP INDEX IF EXISTS servers_platform_server_owner_uq;');
  await pool.query('DROP INDEX IF EXISTS linked_accounts_identity_owner_uq;');
  await pool.query('DROP INDEX IF EXISTS guild_tokens_nitrado_user_owner_uq;');
  await pool.query('ALTER TABLE guild_tokens DROP COLUMN IF EXISTS nitrado_user_id;');
}

module.exports = { up, down };
