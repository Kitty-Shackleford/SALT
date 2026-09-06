/*
 * Migration 061 — Server-scoped possible-alt review decisions
 */

async function up(pool) {
  console.log('⚡ Migration 061: Add possible-alt review decisions');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS alt_account_reviews (
      id               BIGSERIAL PRIMARY KEY,
      server_id        INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      identity_id_low  INTEGER NOT NULL REFERENCES player_identities(id) ON DELETE CASCADE,
      identity_id_high INTEGER NOT NULL REFERENCES player_identities(id) ON DELETE CASCADE,
      status           TEXT NOT NULL DEFAULT 'pending',
      notes            TEXT NOT NULL DEFAULT '',
      reviewed_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at      TIMESTAMPTZ,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(server_id, identity_id_low, identity_id_high),
      CHECK (identity_id_low < identity_id_high),
      CHECK (status IN ('pending', 'confirmed', 'dismissed'))
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_alt_account_reviews_server_status
      ON alt_account_reviews(server_id, status)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_player_sessions_server_login_times_identity
      ON player_sessions(server_id, login_at, logout_at, identity_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_player_sessions_server_identity_times
      ON player_sessions(server_id, identity_id, login_at, logout_at)
  `);
  await pool.query(`CREATE EXTENSION IF NOT EXISTS btree_gist`);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_player_sessions_completed_time_range
      ON player_sessions USING GIST (
        server_id,
        identity_id,
        tstzrange(login_at, logout_at, '[)')
      )
      WHERE logout_at IS NOT NULL
  `);

  // Device evidence is no longer emitted by current console logs. Fail closed:
  // deployments upgrading from the old detector must not retain an active
  // automatic-enforcement setting.
  await pool.query(`UPDATE server_settings SET auto_ban_alts = 0 WHERE auto_ban_alts <> 0`);

  console.log('✅ Migration 061 complete');
}

module.exports = { up };
