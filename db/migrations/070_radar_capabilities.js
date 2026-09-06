'use strict';

async function up(pool) {
  await pool.query(`
    ALTER TABLE shop_items
      ADD COLUMN IF NOT EXISTS capability_config JSONB;

    ALTER TABLE shop_items
      DROP CONSTRAINT IF EXISTS shop_items_spawn_method_check;
    ALTER TABLE shop_items
      ADD CONSTRAINT shop_items_spawn_method_check
      CHECK (spawn_method IN ('cfgEffectArea', 'custom_json', 'event', 'capability'));

    ALTER TABLE shop_order_items
      ADD COLUMN IF NOT EXISTS capability_config_snapshot JSONB;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'server_player_memberships_radar_provenance_uq'
          AND conrelid = 'server_player_memberships'::regclass
      ) THEN
        ALTER TABLE server_player_memberships
          ADD CONSTRAINT server_player_memberships_radar_provenance_uq
          UNIQUE (id, server_id, guild_id, user_id, identity_id, source_link_id);
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'shop_orders_radar_provenance_uq'
          AND conrelid = 'shop_orders'::regclass
      ) THEN
        ALTER TABLE shop_orders
          ADD CONSTRAINT shop_orders_radar_provenance_uq
          UNIQUE (id, server_id, identity_id);
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'shop_order_items_order_provenance_uq'
          AND conrelid = 'shop_order_items'::regclass
      ) THEN
        ALTER TABLE shop_order_items
          ADD CONSTRAINT shop_order_items_order_provenance_uq UNIQUE (id, order_id);
      END IF;
    END
    $$;

    CREATE TABLE IF NOT EXISTS radar_activations (
      id BIGSERIAL PRIMARY KEY,
      guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE RESTRICT,
      server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE RESTRICT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      identity_id INTEGER NOT NULL REFERENCES player_identities(id) ON DELETE RESTRICT,
      source_link_id INTEGER NOT NULL REFERENCES linked_accounts(id) ON DELETE RESTRICT,
      membership_id BIGINT NOT NULL REFERENCES server_player_memberships(id) ON DELETE RESTRICT,
      order_id INTEGER NOT NULL REFERENCES shop_orders(id) ON DELETE RESTRICT,
      order_item_id INTEGER NOT NULL UNIQUE REFERENCES shop_order_items(id) ON DELETE RESTRICT,
      capability_config JSONB NOT NULL,
      center_x DOUBLE PRECISION,
      center_y DOUBLE PRECISION,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'expired', 'revoked', 'refunded')),
      source_type TEXT NOT NULL DEFAULT 'shop'
        CHECK (source_type = 'shop'),
      activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (server_id, id),
      UNIQUE (id, server_id, guild_id, identity_id),
      FOREIGN KEY (server_id, guild_id)
        REFERENCES servers(id, guild_id) ON DELETE RESTRICT,
      FOREIGN KEY (membership_id, server_id, guild_id, user_id, identity_id, source_link_id)
        REFERENCES server_player_memberships(id, server_id, guild_id, user_id, identity_id, source_link_id)
        ON DELETE RESTRICT,
      FOREIGN KEY (order_id, server_id, identity_id)
        REFERENCES shop_orders(id, server_id, identity_id) ON DELETE RESTRICT,
      FOREIGN KEY (order_item_id, order_id)
        REFERENCES shop_order_items(id, order_id) ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_radar_activations_active_viewer
      ON radar_activations (server_id, identity_id, id)
      WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS idx_radar_activations_active_server
      ON radar_activations (server_id, id)
      WHERE status = 'active';

    CREATE TABLE IF NOT EXISTS radar_synthetic_events (
      id BIGSERIAL PRIMARY KEY,
      activation_id BIGINT NOT NULL REFERENCES radar_activations(id) ON DELETE RESTRICT,
      guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE RESTRICT,
      server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE RESTRICT,
      purchaser_identity_id INTEGER NOT NULL REFERENCES player_identities(id) ON DELETE RESTRICT,
      source_type TEXT NOT NULL DEFAULT 'jammer'
        CHECK (source_type = 'jammer'),
      action TEXT NOT NULL
        CHECK (action IN ('emote', 'placement', 'build', 'takedown', 'ping', 'location')),
      display_name TEXT NOT NULL,
      pos_x DOUBLE PRECISION NOT NULL,
      pos_y DOUBLE PRECISION NOT NULL,
      bucket_start TIMESTAMPTZ NOT NULL,
      seed_version SMALLINT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (activation_id, action, bucket_start, seed_version),
      FOREIGN KEY (activation_id, server_id, guild_id, purchaser_identity_id)
        REFERENCES radar_activations(id, server_id, guild_id, identity_id)
        ON DELETE RESTRICT
    );

    CREATE INDEX IF NOT EXISTS idx_radar_synthetic_events_server_bucket
      ON radar_synthetic_events (server_id, bucket_start DESC, id DESC);
  `);
}

async function down(pool) {
  await pool.query('DROP TABLE IF EXISTS radar_synthetic_events');
  await pool.query('DROP TABLE IF EXISTS radar_activations');
  await pool.query('ALTER TABLE shop_order_items DROP CONSTRAINT IF EXISTS shop_order_items_order_provenance_uq');
  await pool.query('ALTER TABLE shop_orders DROP CONSTRAINT IF EXISTS shop_orders_radar_provenance_uq');
  await pool.query('ALTER TABLE server_player_memberships DROP CONSTRAINT IF EXISTS server_player_memberships_radar_provenance_uq');
  await pool.query('ALTER TABLE shop_order_items DROP COLUMN IF EXISTS capability_config_snapshot');
  await pool.query('ALTER TABLE shop_items DROP COLUMN IF EXISTS capability_config');
  await pool.query(`
    ALTER TABLE shop_items DROP CONSTRAINT IF EXISTS shop_items_spawn_method_check;
    ALTER TABLE shop_items ADD CONSTRAINT shop_items_spawn_method_check
      CHECK (spawn_method IN ('cfgEffectArea', 'custom_json', 'event'))
  `);
}

module.exports = { up, down };
