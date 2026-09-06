'use strict';

const EVENT_TABLES = [
  {
    table: 'damage_events',
    index: 'uq_damage_events_observation',
  },
  {
    table: 'territory_events',
    index: 'uq_territory_events_observation',
  },
  {
    table: 'player_emote_events',
    index: 'uq_player_emote_events_observation',
  },
];

async function up(pool) {
  console.log('🔄 Migration 058: Make parsed observability events idempotent');

  // Migration 025 used second-resolution event fields as an observation key.
  // Distinct actions can legitimately have identical field values, so only a
  // stable source-file/line address is safe for rescan idempotency.
  await pool.query(`
    ALTER TABLE territory_events
    DROP CONSTRAINT IF EXISTS territory_events_unique
  `);

  // schema-v2 created this unnamed semantic UNIQUE constraint. Discover it by
  // its ordered columns so this is independent of PostgreSQL's truncated name.
  await pool.query(`
    DO $$
    DECLARE legacy_constraint TEXT;
    BEGIN
      SELECT c.conname INTO legacy_constraint
        FROM pg_constraint c
       WHERE c.conrelid = 'damage_events'::regclass
         AND c.contype = 'u'
         AND pg_get_constraintdef(c.oid) LIKE
             'UNIQUE (server_id, victim_identity_id, attacker_identity_id, %timestamp%, weapon, body_part, damage)';
      IF legacy_constraint IS NOT NULL THEN
        EXECUTE format('ALTER TABLE damage_events DROP CONSTRAINT %I', legacy_constraint);
      END IF;
    END $$
  `);

  for (const definition of EVENT_TABLES) {
    await pool.query(`
      ALTER TABLE ${definition.table}
        ADD COLUMN IF NOT EXISTS source_file TEXT,
        ADD COLUMN IF NOT EXISTS source_line INTEGER
    `);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${definition.index}
          ON ${definition.table} (server_id, source_file, source_line)
       WHERE source_file IS NOT NULL AND source_line IS NOT NULL
    `);
  }

  console.log('✅ Migration 058 complete');
}

async function down(pool) {
  for (const definition of [...EVENT_TABLES].reverse()) {
    await pool.query(`DROP INDEX IF EXISTS ${definition.index}`);
  }
}

module.exports = { up, down };
