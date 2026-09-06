/**
 * Migration 031: Faction Map Markers
 *
 * Adds the `faction_markers` table which stores custom map markers placed
 * by faction members.  Each marker is:
 *   - scoped to a specific faction and in-game map (e.g. chernarusplus)
 *   - positioned using game-world coordinates (posX east, posY north)
 *   - annotated with a title, optional free-text note, and an emoji icon
 *
 * Marker visibility and CRUD permissions are enforced at the route layer:
 *   - any faction member may view and place markers
 *   - the creator, faction leaders, and officers may edit or delete markers
 */
async function up(pool) {
  console.log('🗺️  Migration 031: Faction map markers');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS faction_markers (
      id                      SERIAL PRIMARY KEY,
      faction_id              INTEGER     NOT NULL REFERENCES factions(id) ON DELETE CASCADE,
      created_by_identity_id  INTEGER     NOT NULL REFERENCES player_identities(id) ON DELETE CASCADE,
      map_name                TEXT        NOT NULL,
      pos_x                   REAL        NOT NULL,
      pos_y                   REAL        NOT NULL,
      title                   TEXT        NOT NULL DEFAULT 'Marker',
      note                    TEXT,
      icon                    TEXT        NOT NULL DEFAULT '📍',
      created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Primary query pattern: fetch all markers for a faction on a given map
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_faction_markers_faction_map
      ON faction_markers (faction_id, map_name)
  `);

  console.log('✅ Migration 031 complete');
}

async function down(pool) {
  await pool.query('DROP TABLE IF EXISTS faction_markers');
}

module.exports = { up, down };
