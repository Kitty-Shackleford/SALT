/**
 * Migration 050: Explicit server-scoped RBAC, player membership, setup state,
 * and tenant-aware security audit events.
 *
 * This migration intentionally does not infer assignments from historical
 * activity or legacy guild-wide moderator roles.
 */
async function up(pool) {
  console.log('🔄 Migration 050: Add explicit multi-tenant RBAC');

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'servers_id_guild_id_uq'
      ) THEN
        ALTER TABLE servers
          ADD CONSTRAINT servers_id_guild_id_uq UNIQUE (id, guild_id);
      END IF;
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'linked_accounts_id_user_identity_uq'
      ) THEN
        ALTER TABLE linked_accounts
          ADD CONSTRAINT linked_accounts_id_user_identity_uq
          UNIQUE (id, user_id, identity_id);
      END IF;
    END $$;

    CREATE TABLE IF NOT EXISTS server_role_assignments (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      server_id INTEGER NOT NULL,
      guild_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'moderator')),
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'suspended', 'revoked')),
      assigned_by_user_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (server_id, user_id),
      FOREIGN KEY (server_id, guild_id)
        REFERENCES servers(id, guild_id) ON DELETE CASCADE,
      FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (assigned_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS server_role_assignments_user_idx
      ON server_role_assignments(user_id, status);
    CREATE INDEX IF NOT EXISTS server_role_assignments_guild_idx
      ON server_role_assignments(guild_id, server_id, status);

    CREATE TABLE IF NOT EXISTS server_player_memberships (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      server_id INTEGER NOT NULL,
      guild_id INTEGER NOT NULL,
      identity_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      source_link_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'suspended', 'revoked')),
      verification_method TEXT NOT NULL
        CHECK (verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted', 'existing_verified_link')),
      verified_by_user_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (server_id, identity_id),
      FOREIGN KEY (server_id, guild_id)
        REFERENCES servers(id, guild_id) ON DELETE CASCADE,
      FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
      FOREIGN KEY (identity_id) REFERENCES player_identities(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (source_link_id, user_id, identity_id)
        REFERENCES linked_accounts(id, user_id, identity_id) ON DELETE CASCADE,
      FOREIGN KEY (verified_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS server_player_memberships_identity_idx
      ON server_player_memberships(identity_id, status);
    CREATE INDEX IF NOT EXISTS server_player_memberships_user_idx
      ON server_player_memberships(user_id, server_id, status);
    CREATE INDEX IF NOT EXISTS server_player_memberships_guild_idx
      ON server_player_memberships(guild_id, server_id, status);

    CREATE TABLE IF NOT EXISTS security_audit_events (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      guild_id INTEGER,
      server_id INTEGER,
      actor_user_id INTEGER,
      action TEXT NOT NULL,
      result TEXT NOT NULL CHECK (result IN ('allowed', 'denied', 'failed')),
      target_type TEXT,
      target_id TEXT,
      request_id UUID,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE SET NULL,
      FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS security_audit_events_scope_idx
      ON security_audit_events(guild_id, server_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS security_audit_events_actor_idx
      ON security_audit_events(actor_user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS guild_setup_state (
      guild_id INTEGER PRIMARY KEY,
      current_step TEXT NOT NULL DEFAULT 'discord_connected',
      status TEXT NOT NULL DEFAULT 'in_progress'
        CHECK (status IN ('in_progress', 'blocked', 'completed')),
      completed_steps JSONB NOT NULL DEFAULT '[]'::jsonb,
      last_error TEXT,
      updated_by_user_id INTEGER,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY (guild_id) REFERENCES guilds(id) ON DELETE CASCADE,
      FOREIGN KEY (updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );
  `);

  console.log('✅ Migration 050 complete');
}

async function down(pool) {
  await pool.query(`
    DROP TABLE IF EXISTS guild_setup_state;
    DROP TABLE IF EXISTS security_audit_events;
    DROP TABLE IF EXISTS server_player_memberships;
    DROP TABLE IF EXISTS server_role_assignments;
    ALTER TABLE linked_accounts DROP CONSTRAINT IF EXISTS linked_accounts_id_user_identity_uq;
    ALTER TABLE servers DROP CONSTRAINT IF EXISTS servers_id_guild_id_uq;
  `);
}

module.exports = { up, down };
