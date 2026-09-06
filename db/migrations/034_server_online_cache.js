/**
 * Migration 034: Add server_online_cache table
 *
 * Stores the set of players detected as currently online at the end of the
 * most recent ADM log scan for each server. This is wiped and rewritten on
 * every scan so it always reflects the latest known online state — unlike
 * player_sessions (logout_at IS NULL) which accumulates stale rows over time.
 */
async function up(pool) {
  console.log('📡 Migration 034: Add server_online_cache table');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS server_online_cache (
      server_id   INTEGER NOT NULL,
      identity_id INTEGER NOT NULL,
      gamertag    TEXT,
      login_at    TIMESTAMPTZ,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (server_id, identity_id)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_online_cache_server ON server_online_cache(server_id)
  `);

  console.log('  ✓ server_online_cache');
}

module.exports = { up };
