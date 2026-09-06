/*
 * Migration 062 — Reviewed spawn exclusion zones
 */

async function up(pool) {
  console.log('🧭 Migration 062: Add reviewed spawn exclusion zones');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS spawn_exclusion_zones (
      id                 BIGSERIAL PRIMARY KEY,
      server_id          INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      source_key         TEXT NOT NULL,
      source_type        TEXT NOT NULL,
      label              TEXT NOT NULL,
      center_x           NUMERIC(12, 4) NOT NULL,
      center_z           NUMERIC(12, 4) NOT NULL,
      radius_m           NUMERIC(8, 2) NOT NULL DEFAULT 200,
      status             TEXT NOT NULL DEFAULT 'pending',
      evidence_count     INTEGER NOT NULL DEFAULT 1,
      evidence_event_ids BIGINT[] NOT NULL DEFAULT '{}',
      first_evidence_at  TIMESTAMPTZ,
      last_evidence_at   TIMESTAMPTZ,
      reviewed_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at        TIMESTAMPTZ,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(server_id, source_key),
      CHECK (source_type IN ('territory_flag', 'manual')),
      CHECK (status IN ('pending', 'confirmed', 'dismissed')),
      CHECK (radius_m BETWEEN 50 AND 1000),
      CHECK (evidence_count >= 0)
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_spawn_exclusion_zones_server_status
      ON spawn_exclusion_zones(server_id, status)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_territory_events_flag_candidates
      ON territory_events(server_id, timestamp DESC, id DESC)
      WHERE event_type = 'raised' AND structure_type = 'TerritoryFlag'
        AND pos_x IS NOT NULL AND pos_z IS NOT NULL
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_spawn_exclusion_zones_review_queue
      ON spawn_exclusion_zones(
        server_id,
        (CASE status WHEN 'pending' THEN 0 WHEN 'confirmed' THEN 1 ELSE 2 END),
        last_evidence_at DESC NULLS LAST,
        id
      )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_spawn_exclusion_zones_flag_matching
      ON spawn_exclusion_zones(
        server_id,
        last_evidence_at DESC NULLS LAST,
        id DESC
      )
      WHERE source_type = 'territory_flag'
  `);

  console.log('✅ Migration 062 complete');
}

module.exports = { up };
