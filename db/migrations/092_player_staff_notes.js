'use strict';

const PLAYER_STAFF_NOTES_SQL = `
  CREATE TABLE IF NOT EXISTS player_staff_notes (
    server_id INTEGER NOT NULL,
    identity_id INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT '' CHECK (char_length(note) <= 1000),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (server_id, identity_id),
    FOREIGN KEY (identity_id, server_id)
      REFERENCES player_server_activity(identity_id, server_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS player_staff_notes_updated_idx
    ON player_staff_notes(server_id, updated_at DESC, identity_id);
`;

async function up(pool) {
  await pool.query(PLAYER_STAFF_NOTES_SQL);
}

async function down(pool) {
  await pool.query('DROP TABLE IF EXISTS player_staff_notes');
}

module.exports = { up, down, PLAYER_STAFF_NOTES_SQL };
