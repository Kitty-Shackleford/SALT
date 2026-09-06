'use strict';

/**
 * Adds explicit global dashboard roles, cached component health, and a
 * non-destructive reconciliation queue for ambiguous legacy guild ownership.
 */
async function up(pool) {
  console.log('🔄 Migration 055: Admin RBAC and server health');
  await pool.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS platform_role TEXT;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'users_platform_role_check'
      ) THEN
        ALTER TABLE users ADD CONSTRAINT users_platform_role_check
          CHECK (platform_role IS NULL OR platform_role IN ('dashboard_owner', 'dashboard_admin'));
      END IF;
    END $$;

    CREATE INDEX IF NOT EXISTS users_platform_role_idx
      ON users(platform_role) WHERE platform_role IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS users_one_dashboard_owner_idx
      ON users(platform_role) WHERE platform_role = 'dashboard_owner';

    CREATE OR REPLACE FUNCTION enforce_single_guild_owner()
    RETURNS TRIGGER AS $$
    BEGIN
      IF NEW.role = 'owner' THEN
        PERFORM pg_advisory_xact_lock(2147483000, NEW.guild_id);
        IF EXISTS (
          SELECT 1 FROM guild_roles existing
           WHERE existing.guild_id = NEW.guild_id
             AND existing.role = 'owner'
             AND existing.id <> COALESCE(NEW.id, -1)
        ) THEN
          RAISE EXCEPTION 'Guild % already has an owner', NEW.guild_id
            USING ERRCODE = '23505';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS guild_roles_single_owner_guard ON guild_roles;
    CREATE TRIGGER guild_roles_single_owner_guard
      BEFORE INSERT OR UPDATE OF role, guild_id ON guild_roles
      FOR EACH ROW EXECUTE FUNCTION enforce_single_guild_owner();

    CREATE TABLE IF NOT EXISTS server_health_status (
      server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
      component TEXT NOT NULL CHECK (component IN ('nitrado', 'discord', 'game_server')),
      state TEXT NOT NULL CHECK (state IN ('healthy', 'degraded', 'offline', 'unknown')),
      detail TEXT NOT NULL,
      checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_healthy_at TIMESTAMPTZ,
      error_code TEXT,
      error_message TEXT,
      PRIMARY KEY (server_id, component),
      FOREIGN KEY (server_id, guild_id) REFERENCES servers(id, guild_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS server_health_status_scope_idx
      ON server_health_status(guild_id, server_id, checked_at DESC);

    CREATE TABLE IF NOT EXISTS server_health_refresh_requests (
      server_id INTEGER PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
      requested_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS guild_ownership_reconciliation (
      guild_id INTEGER PRIMARY KEY REFERENCES guilds(id) ON DELETE CASCADE,
      issue_code TEXT NOT NULL CHECK (issue_code IN (
        'missing_owner', 'multiple_owners', 'owner_not_in_discord',
        'owner_missing_discord_permission', 'bot_not_installed',
        'servers_without_admin', 'invalid_role_scope'
      )),
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'ignored')),
      detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ,
      resolved_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
    );

    INSERT INTO guild_ownership_reconciliation (guild_id, issue_code, details)
    SELECT g.id,
           CASE WHEN COUNT(gr.id) = 0 THEN 'missing_owner' ELSE 'multiple_owners' END,
           jsonb_build_object('ownerCount', COUNT(gr.id))
      FROM guilds g
      LEFT JOIN guild_roles gr ON gr.guild_id = g.id AND gr.role = 'owner'
     GROUP BY g.id
    HAVING COUNT(gr.id) <> 1
    ON CONFLICT (guild_id) DO UPDATE SET
      issue_code = EXCLUDED.issue_code,
      details = EXCLUDED.details,
      status = 'open',
      detected_at = NOW(),
      resolved_at = NULL,
      resolved_by_user_id = NULL;
  `);
  console.log('✅ Migration 055 complete');
}

async function down(pool) {
  await pool.query(`
    DROP TRIGGER IF EXISTS guild_roles_single_owner_guard ON guild_roles;
    DROP FUNCTION IF EXISTS enforce_single_guild_owner();
    DROP TABLE IF EXISTS guild_ownership_reconciliation;
    DROP TABLE IF EXISTS server_health_refresh_requests;
    DROP TABLE IF EXISTS server_health_status;
    DROP INDEX IF EXISTS users_platform_role_idx;
    DROP INDEX IF EXISTS users_one_dashboard_owner_idx;
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_platform_role_check;
    ALTER TABLE users DROP COLUMN IF EXISTS platform_role;
  `);
}

module.exports = { up, down };
