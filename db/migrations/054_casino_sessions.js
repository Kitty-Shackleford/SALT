'use strict';

/** Server-owned, single-use state for multi-step casino games. */
async function up(pool) {
  console.log('🔄 Migration 054: secure casino sessions');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS casino_sessions (
      session_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      identity_id INTEGER NOT NULL REFERENCES player_identities(id) ON DELETE CASCADE,
      server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
      game_type TEXT NOT NULL,
      state JSONB NOT NULL,
      version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
      reserved_wager NUMERIC NOT NULL DEFAULT 0 CHECK (reserved_wager >= 0),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'settled', 'expired')),
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      settled_at TIMESTAMPTZ
    );
    ALTER TABLE casino_sessions
      ADD COLUMN IF NOT EXISTS reserved_wager NUMERIC NOT NULL DEFAULT 0
      CHECK (reserved_wager >= 0);
    CREATE INDEX IF NOT EXISTS casino_sessions_binding_idx
      ON casino_sessions(user_id, identity_id, server_id, guild_id, status);
    CREATE INDEX IF NOT EXISTS casino_sessions_expiry_idx
      ON casino_sessions(expires_at) WHERE status = 'active';
  `);
  console.log('✅ Migration 054 complete: casino state is server-owned');
}

async function down(pool) {
  await pool.query('DROP TABLE IF EXISTS casino_sessions');
}

module.exports = { up, down };
