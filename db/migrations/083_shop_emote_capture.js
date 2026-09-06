'use strict';

const SHOP_EMOTE_CAPTURE_SQL = `
  ALTER TABLE shop_items
    ADD COLUMN IF NOT EXISTS emote_capture_config JSONB;

  ALTER TABLE shop_order_items
    ADD COLUMN IF NOT EXISTS emote_capture_config_snapshot JSONB;

  CREATE TABLE IF NOT EXISTS shop_emote_capture_requests (
    id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    identity_id INTEGER NOT NULL REFERENCES player_identities(id) ON DELETE CASCADE,
    membership_id BIGINT REFERENCES server_player_memberships(id) ON DELETE SET NULL,
    order_id INTEGER NOT NULL REFERENCES shop_orders(id) ON DELETE CASCADE,
    order_item_id INTEGER NOT NULL REFERENCES shop_order_items(id) ON DELETE CASCADE,
    requested_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expected_emote_type TEXT NOT NULL,
    expected_item_name TEXT,
    event_high_water_id BIGINT NOT NULL CHECK (event_high_water_id >= 0),
    requested_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    expires_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'applied', 'cancelled', 'rejected')),
    emote_event_id INTEGER UNIQUE REFERENCES player_emote_events(id) ON DELETE CASCADE,
    event_timestamp TIMESTAMPTZ,
    raw_pos_x NUMERIC,
    raw_pos_y NUMERIC,
    raw_pos_z NUMERIC,
    applied_pos_x NUMERIC,
    applied_pos_y NUMERIC,
    applied_pos_z NUMERIC,
    previous_pos_x NUMERIC,
    previous_pos_y NUMERIC,
    previous_pos_z NUMERIC,
    source_file TEXT,
    source_line INTEGER,
    rejection_reason TEXT,
    applied_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    CHECK (expires_at > requested_at),
    CHECK (
      (status = 'applied' AND emote_event_id IS NOT NULL AND applied_at IS NOT NULL)
      OR (status <> 'applied' AND emote_event_id IS NULL AND applied_at IS NULL)
    )
  );

  CREATE UNIQUE INDEX IF NOT EXISTS shop_emote_capture_one_pending_identity
    ON shop_emote_capture_requests(server_id, identity_id)
    WHERE status = 'pending';

  CREATE UNIQUE INDEX IF NOT EXISTS shop_emote_capture_one_pending_line
    ON shop_emote_capture_requests(order_item_id)
    WHERE status = 'pending';

  CREATE INDEX IF NOT EXISTS shop_emote_capture_status_lookup
    ON shop_emote_capture_requests(server_id, identity_id, status, requested_at DESC);
`;

async function up(pool) {
  await pool.query(SHOP_EMOTE_CAPTURE_SQL);
}

async function down(pool) {
  await pool.query(`
    DROP TABLE IF EXISTS shop_emote_capture_requests;
    ALTER TABLE shop_order_items DROP COLUMN IF EXISTS emote_capture_config_snapshot;
    ALTER TABLE shop_items DROP COLUMN IF EXISTS emote_capture_config;
  `);
}

module.exports = { up, down, SHOP_EMOTE_CAPTURE_SQL };
