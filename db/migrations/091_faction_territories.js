'use strict';

const FACTION_TERRITORIES_SQL = `
  CREATE UNIQUE INDEX IF NOT EXISTS server_membership_territory_provenance_uq
    ON server_player_memberships(id, server_id, guild_id, identity_id);
  CREATE UNIQUE INDEX IF NOT EXISTS faction_membership_territory_provenance_uq
    ON faction_members(id, faction_id, guild_id, identity_id);

  CREATE TABLE IF NOT EXISTS faction_territories (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    server_id INTEGER NOT NULL,
    guild_id INTEGER NOT NULL,
    faction_id INTEGER NOT NULL,
    map_name TEXT NOT NULL CHECK (map_name = 'chernarusplus'),
    pole_east NUMERIC(12,4) NOT NULL CHECK (pole_east >= 0 AND pole_east <= 15360),
    pole_north NUMERIC(12,4) NOT NULL CHECK (pole_north >= 0 AND pole_north <= 15360),
    radius_m NUMERIC(6,2) NOT NULL DEFAULT 60 CHECK (radius_m = 60),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'approved', 'rejected', 'revoked')),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    submitted_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    submitted_by_identity_id INTEGER REFERENCES player_identities(id) ON DELETE SET NULL,
    submitted_by_server_membership_id BIGINT,
    submitted_by_faction_membership_id INTEGER,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMPTZ,
    decision_note TEXT CHECK (decision_note IS NULL OR char_length(decision_note) <= 500),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (server_id, guild_id)
      REFERENCES servers(id, guild_id) ON DELETE CASCADE,
    FOREIGN KEY (faction_id, guild_id)
      REFERENCES factions(id, guild_id) ON DELETE CASCADE,
    FOREIGN KEY (submitted_by_server_membership_id, server_id, guild_id, submitted_by_identity_id)
      REFERENCES server_player_memberships(id, server_id, guild_id, identity_id)
      ON DELETE SET NULL (submitted_by_server_membership_id),
    FOREIGN KEY (submitted_by_faction_membership_id, faction_id, guild_id, submitted_by_identity_id)
      REFERENCES faction_members(id, faction_id, guild_id, identity_id)
      ON DELETE SET NULL (submitted_by_faction_membership_id)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS faction_territories_live_faction_server_uq
    ON faction_territories(server_id, faction_id)
    WHERE status IN ('pending', 'approved');

  CREATE INDEX IF NOT EXISTS faction_territories_staff_queue_idx
    ON faction_territories(server_id, status, submitted_at DESC, id DESC);

  CREATE INDEX IF NOT EXISTS faction_territories_player_map_idx
    ON faction_territories(server_id, faction_id, map_name, updated_at DESC, id DESC)
    WHERE status = 'approved';
`;

async function up(pool) {
  await pool.query(FACTION_TERRITORIES_SQL);
}

async function down(pool) {
  await pool.query('DROP TABLE IF EXISTS faction_territories');
}

module.exports = { up, down, FACTION_TERRITORIES_SQL };
