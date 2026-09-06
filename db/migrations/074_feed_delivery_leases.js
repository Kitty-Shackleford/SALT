'use strict';

const FEED_DELIVERY_LEASES_SQL = `
  ALTER TABLE feed_events
    ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS claim_token TEXT,
    ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_error TEXT;

  CREATE INDEX IF NOT EXISTS feed_events_delivery_idx
    ON feed_events (processed, next_attempt_at, created_at);

  CREATE INDEX IF NOT EXISTS feed_events_expired_lease_idx
    ON feed_events (lease_expires_at)
    WHERE processed = 3;
`;

async function up(pool) {
  await pool.query(FEED_DELIVERY_LEASES_SQL);
}

async function down(pool) {
  await pool.query(`
    DROP INDEX IF EXISTS feed_events_expired_lease_idx;
    DROP INDEX IF EXISTS feed_events_delivery_idx;
    ALTER TABLE feed_events
      DROP COLUMN IF EXISTS last_error,
      DROP COLUMN IF EXISTS lease_expires_at,
      DROP COLUMN IF EXISTS claimed_at,
      DROP COLUMN IF EXISTS claim_token,
      DROP COLUMN IF EXISTS next_attempt_at,
      DROP COLUMN IF EXISTS attempt_count;
  `);
}

module.exports = { up, down, FEED_DELIVERY_LEASES_SQL };
