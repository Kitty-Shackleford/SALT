/**
 * Migration 018: Event-Driven Core Tables (PostgreSQL)
 *
 * Creates the foundational tables for the event-driven architecture:
 *   - events          – append-only event log with strict monotonic seq
 *   - plugin_data     – plugin extensibility store
 *   - audit_logs      – actor-level audit trail
 *   - projection_checkpoints – projection processing bookmarks
 *
 * The seq column on events is a bigserial that guarantees strict monotonic
 * ordering for projection consumers.  A separate uuid column serves as the
 * stable external reference (for APIs, webhooks, etc.).
 *
 * server_id / player_id on events intentionally reference the legacy
 * integer-PK servers / player_identities tables that are created by
 * schema-v2.js.  These will be migrated to UUID FKs in a future phase once
 * the UUID-PK editions of those tables are backfilled.
 *
 * NOTE: This migration is PostgreSQL-only and receives the pg Pool object.
 */

/**
 * @param {import('pg').Pool} pool
 */
async function up(pool) {
  console.log('🔄 Migration 018: Event-driven core tables');

  // Enable pgcrypto for gen_random_uuid() — idempotent.
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

  // ------------------------------------------------------------------
  // events
  // ------------------------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      seq         BIGSERIAL PRIMARY KEY,
      uuid        UUID NOT NULL DEFAULT gen_random_uuid(),
      server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      player_id   INTEGER REFERENCES player_identities(id) ON DELETE SET NULL,
      event_type  TEXT NOT NULL,
      timestamp   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      payload     JSONB NOT NULL DEFAULT '{}',
      deleted_at  TIMESTAMPTZ,
      CONSTRAINT events_uuid_unique UNIQUE (uuid)
    )
  `);

  // Required indexes on events.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_server_timestamp
    ON events(server_id, timestamp DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_player
    ON events(player_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_event_type
    ON events(event_type)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_events_seq
    ON events(seq)`);

  console.log('  ✓ events');

  // ------------------------------------------------------------------
  // plugin_data  – generic per-plugin, per-entity key-value store
  // ------------------------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS plugin_data (
      id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      plugin_name          TEXT NOT NULL,
      related_entity_type  TEXT NOT NULL,
      related_entity_id    UUID NOT NULL,
      data                 JSONB NOT NULL DEFAULT '{}',
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_plugin_data_plugin
    ON plugin_data(plugin_name)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_plugin_data_entity
    ON plugin_data(related_entity_type, related_entity_id)`);

  console.log('  ✓ plugin_data');

  // ------------------------------------------------------------------
  // audit_logs  – actor-level action history
  // (distinct from the legacy audit_log table created by schema-v2.js)
  // ------------------------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_discord_id TEXT,
      action           TEXT NOT NULL,
      entity_type      TEXT,
      entity_id        UUID,
      payload          JSONB NOT NULL DEFAULT '{}',
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_actor
    ON audit_logs(actor_discord_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_entity
    ON audit_logs(entity_type, entity_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_created
    ON audit_logs(created_at DESC)`);

  console.log('  ✓ audit_logs');

  // ------------------------------------------------------------------
  // projection_checkpoints  – last processed seq for each projection
  // ------------------------------------------------------------------
  await pool.query(`
    CREATE TABLE IF NOT EXISTS projection_checkpoints (
      projection_name  TEXT PRIMARY KEY,
      last_seq         BIGINT NOT NULL DEFAULT 0,
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  console.log('  ✓ projection_checkpoints');
  console.log('  ✅ Migration 018 complete');
}

module.exports = { up };
