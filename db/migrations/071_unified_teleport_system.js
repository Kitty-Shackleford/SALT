'use strict';

async function up(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS teleport_destinations (
      id BIGSERIAL PRIMARY KEY,
      guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE RESTRICT,
      server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
      map_name TEXT NOT NULL CHECK (map_name ~ '^[a-z0-9_-]+$'),
      destination_type TEXT NOT NULL DEFAULT 'named'
        CHECK (destination_type IN ('named', 'spawn', 'pra', 'punishment')),
      pos_x DOUBLE PRECISION NOT NULL,
      pos_y DOUBLE PRECISION NOT NULL,
      pos_z DOUBLE PRECISION NOT NULL,
      is_private BOOLEAN NOT NULL DEFAULT FALSE,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (id, server_id, guild_id),
      FOREIGN KEY (server_id, guild_id)
        REFERENCES servers(id, guild_id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS teleport_destinations_server_name_uq
      ON teleport_destinations (server_id, lower(name));
    CREATE INDEX IF NOT EXISTS teleport_destinations_active_idx
      ON teleport_destinations (server_id, destination_type, name)
      WHERE is_active = TRUE;

    CREATE TABLE IF NOT EXISTS player_pra_restrictions (
      id BIGSERIAL PRIMARY KEY,
      guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE RESTRICT,
      server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      identity_id INTEGER NOT NULL REFERENCES player_identities(id) ON DELETE RESTRICT,
      destination_id BIGINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
      reason TEXT,
      imposed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      released_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      imposed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      released_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (id, server_id, guild_id, identity_id),
      FOREIGN KEY (server_id, guild_id)
        REFERENCES servers(id, guild_id) ON DELETE CASCADE,
      FOREIGN KEY (destination_id, server_id, guild_id)
        REFERENCES teleport_destinations(id, server_id, guild_id) ON DELETE RESTRICT
    );

    -- UNIQUE (server_id, identity_id) active restriction enforced by this partial index.
    CREATE UNIQUE INDEX IF NOT EXISTS player_pra_restrictions_one_active
      ON player_pra_restrictions (server_id, identity_id)
      WHERE status = 'active';

    CREATE TABLE IF NOT EXISTS player_disconnect_positions (
      id BIGSERIAL PRIMARY KEY,
      server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      identity_id INTEGER NOT NULL REFERENCES player_identities(id) ON DELETE RESTRICT,
      pos_x DOUBLE PRECISION NOT NULL,
      pos_y DOUBLE PRECISION NOT NULL,
      pos_z DOUBLE PRECISION NOT NULL,
      observed_at TIMESTAMPTZ NOT NULL,
      source_file TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (server_id, identity_id, observed_at, source_file)
    );

    CREATE INDEX IF NOT EXISTS player_disconnect_positions_latest_idx
      ON player_disconnect_positions (server_id, identity_id, observed_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS teleport_requests (
      id BIGSERIAL PRIMARY KEY,
      guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE RESTRICT,
      server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      identity_id INTEGER NOT NULL REFERENCES player_identities(id) ON DELETE RESTRICT,
      destination_id BIGINT NOT NULL,
      restriction_id BIGINT,
      requested_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      order_item_id INTEGER UNIQUE REFERENCES shop_order_items(id) ON DELETE RESTRICT,
      source TEXT NOT NULL
        CHECK (source IN ('shop', 'admin', 'console', 'automatic', 'punishment', 'pra_enforcement')),
      reason TEXT,
      forced BOOLEAN NOT NULL DEFAULT FALSE,
      respect_pra BOOLEAN NOT NULL DEFAULT TRUE,
      notify_player BOOLEAN NOT NULL DEFAULT TRUE,
      status TEXT NOT NULL DEFAULT 'waiting_disconnect'
        CHECK (status IN ('waiting_disconnect', 'provisioning', 'armed', 'cleanup_pending', 'cleanup_processing', 'cleanup_restart_pending', 'completed', 'failed', 'cancelled')),
      source_pos_x DOUBLE PRECISION,
      source_pos_y DOUBLE PRECISION,
      source_pos_z DOUBLE PRECISION,
      source_observed_at TIMESTAMPTZ,
      pra_file_path TEXT,
      mission_dir TEXT,
      mission_map_name TEXT CHECK (mission_map_name IS NULL OR mission_map_name ~ '^[a-z0-9_-]+$'),
      arm_configured_at TIMESTAMPTZ,
      restart_requested_at TIMESTAMPTZ,
      restart_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (restart_attempt_count >= 0),
      arrival_observed_at TIMESTAMPTZ,
      cleanup_requested_at TIMESTAMPTZ,
      cleanup_config_removed_at TIMESTAMPTZ,
      cleanup_restart_requested_at TIMESTAMPTZ,
      cleanup_restart_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_restart_attempt_count >= 0),
      final_status TEXT NOT NULL DEFAULT 'completed' CHECK (final_status IN ('completed', 'failed')),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() + INTERVAL '24 hours',
      completed_at TIMESTAMPTZ,
      failed_at TIMESTAMPTZ,
      refunded_at TIMESTAMPTZ,
      failure_code TEXT,
      failure_message TEXT,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (id, server_id, guild_id, identity_id),
      FOREIGN KEY (server_id, guild_id)
        REFERENCES servers(id, guild_id) ON DELETE CASCADE,
      FOREIGN KEY (destination_id, server_id, guild_id)
        REFERENCES teleport_destinations(id, server_id, guild_id) ON DELETE RESTRICT,
      FOREIGN KEY (restriction_id, server_id, guild_id, identity_id)
        REFERENCES player_pra_restrictions(id, server_id, guild_id, identity_id) ON DELETE RESTRICT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS teleport_requests_one_live_per_player
      ON teleport_requests (server_id, identity_id)
      WHERE status IN ('waiting_disconnect', 'provisioning', 'armed', 'cleanup_pending', 'cleanup_processing', 'cleanup_restart_pending');
    CREATE INDEX IF NOT EXISTS teleport_requests_processor_idx
      ON teleport_requests (status, server_id, requested_at, id)
      WHERE status IN ('waiting_disconnect', 'provisioning', 'armed', 'cleanup_pending', 'cleanup_processing', 'cleanup_restart_pending');
    CREATE INDEX IF NOT EXISTS teleport_requests_expiry_idx
      ON teleport_requests (server_id, expires_at, id)
      WHERE status IN ('waiting_disconnect', 'provisioning', 'armed');
    CREATE INDEX IF NOT EXISTS teleport_requests_refund_pending_idx
      ON teleport_requests (server_id, id)
      WHERE status = 'failed' AND order_item_id IS NOT NULL AND refunded_at IS NULL;
    CREATE INDEX IF NOT EXISTS teleport_requests_restart_retry_idx
      ON teleport_requests (server_id, status, restart_requested_at, cleanup_restart_requested_at, id)
      WHERE status IN ('armed', 'cleanup_restart_pending');

    CREATE TABLE IF NOT EXISTS teleport_events (
      id BIGSERIAL PRIMARY KEY,
      request_id BIGINT NOT NULL,
      guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE RESTRICT,
      server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      identity_id INTEGER NOT NULL REFERENCES player_identities(id) ON DELETE RESTRICT,
      actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      event_type TEXT NOT NULL
        CHECK (event_type IN ('requested', 'denied', 'source_bound', 'provisioned', 'restart_requested', 'restart_request_failed', 'arrival_observed', 'cleanup_config_removed', 'cleanup_restart_requested', 'cleanup_restart_failed', 'cleanup_completed', 'completed', 'failed', 'cancelled', 'restriction_imposed', 'restriction_released')),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY (request_id, server_id, guild_id, identity_id)
        REFERENCES teleport_requests(id, server_id, guild_id, identity_id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS teleport_events_request_idx
      ON teleport_events (request_id, created_at, id);
    CREATE INDEX IF NOT EXISTS teleport_events_scope_idx
      ON teleport_events (server_id, identity_id, created_at DESC, id DESC);

    CREATE OR REPLACE FUNCTION protect_server_active_teleports()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
      target_server_id INTEGER;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        target_server_id := OLD.id;
      ELSIF NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'active' THEN
        target_server_id := OLD.id;
      ELSE
        RETURN NEW;
      END IF;

      IF EXISTS (
        SELECT 1 FROM teleport_requests
        WHERE server_id = target_server_id
          AND status IN ('waiting_disconnect', 'provisioning', 'armed', 'cleanup_pending', 'cleanup_processing', 'cleanup_restart_pending')
      ) OR EXISTS (
        SELECT 1 FROM player_pra_restrictions
        WHERE server_id = target_server_id AND status = 'active'
      ) THEN
        RAISE EXCEPTION 'Cannot disable or delete server while active teleport state exists'
          USING ERRCODE = 'P0001';
      END IF;

      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END;
    $$;

    DROP TRIGGER IF EXISTS protect_server_active_teleports_trigger ON servers;
    CREATE TRIGGER protect_server_active_teleports_trigger
      BEFORE DELETE OR UPDATE OF status ON servers
      FOR EACH ROW EXECUTE FUNCTION protect_server_active_teleports();
  `);
}

async function down(pool) {
  await pool.query('DROP TRIGGER IF EXISTS protect_server_active_teleports_trigger ON servers');
  await pool.query('DROP FUNCTION IF EXISTS protect_server_active_teleports()');
  await pool.query('DROP TABLE IF EXISTS teleport_events');
  await pool.query('DROP TABLE IF EXISTS teleport_requests');
  await pool.query('DROP TABLE IF EXISTS player_disconnect_positions');
  await pool.query('DROP TABLE IF EXISTS player_pra_restrictions');
  await pool.query('DROP TABLE IF EXISTS teleport_destinations');
}

module.exports = { up, down };
