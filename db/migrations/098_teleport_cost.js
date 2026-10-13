/**
 * Migration 098: per-teleport cost (A1.4)
 *
 * Phase A optional feature: a fixed in-game wallet cost for player-sourced
 * teleports.
 *
 *   guild_economy_config.teleport_cost_enabled — config flag, DEFAULT FALSE
 *   guild_economy_config.teleport_cost         — cost in in-game currency,
 *                                                DEFAULT 0 (disabled)
 *
 *   teleport_wallet_charges — per-request charge ledger. The UNIQUE
 *   (teleport_request_id) makes a charge insert idempotent across retrying
 *   callers (ON CONFLICT DO NOTHING + verify), and the status state machine
 *   (pending -> refunded) makes refunds idempotent. The processor sweeps
 *   'pending' rows whose teleport request no longer exists (orphan) or whose
 *   request transitioned to final_status='failed' (refundable), so a crash
 *   between charge and failure-handling cannot strand money.
 *
 * teleport_requests.refunded_at (existing, shop-sourced refunds) is reused as
 * the request-level refund marker for BOTH refund sources.
 */
'use strict';

async function up(pool) {
  console.log('🔄 Migration 098: Add per-teleport cost config + wallet charge ledger');
  await pool.query(`
    ALTER TABLE guild_economy_config
      ADD COLUMN IF NOT EXISTS teleport_cost_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS teleport_cost NUMERIC(20,2) NOT NULL DEFAULT 0
        CHECK (teleport_cost >= 0);
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS teleport_wallet_charges (
      id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      teleport_request_id BIGINT NOT NULL UNIQUE REFERENCES teleport_requests(id) ON DELETE CASCADE,
      server_id           INTEGER NOT NULL,
      identity_id         INTEGER NOT NULL,
      amount              NUMERIC(20,2) NOT NULL CHECK (amount > 0),
      status              TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'refunded')),
      charged_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      refunded_at         TIMESTAMPTZ
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS teleport_wallet_charges_status_idx
      ON teleport_wallet_charges (status, id);
  `);
}

module.exports = { up };
