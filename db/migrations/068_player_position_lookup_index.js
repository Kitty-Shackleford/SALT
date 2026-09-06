'use strict';

const PLAYER_POSITION_LOOKUP_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_player_position_snapshots_latest
    ON player_position_snapshots (server_id, identity_id, timestamp DESC, id DESC)
    WHERE pos_x IS NOT NULL AND pos_y IS NOT NULL;
`;

async function up(pool) {
  await pool.query(PLAYER_POSITION_LOOKUP_INDEX_SQL);
}

async function down(pool) {
  await pool.query('DROP INDEX IF EXISTS idx_player_position_snapshots_latest');
}

module.exports = { up, down, PLAYER_POSITION_LOOKUP_INDEX_SQL };
