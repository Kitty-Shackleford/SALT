/**
 * Migration 025: Fix territory_events UNIQUE constraint
 *
 * The old UNIQUE constraint included structure_type, which prevented
 * re-syncing logs when the normalisation logic changed (e.g. switching
 * from storing "storage" to storing the raw class name "Barrel_Green").
 *
 * Fix:
 *   1. Truncate territory_events (old rows have wrong normalised values).
 *   2. Drop the old constraint.
 *   3. Add a new constraint that excludes structure_type so that the
 *      stored type can be updated without duplicate-key conflicts.
 *
 * The table will be repopulated on the next log sync.
 */
async function up(pool) {
  console.log('🔄 Migration 025: Fix territory_events UNIQUE constraint');

  // Clear old rows that were normalised incorrectly
  await pool.query('TRUNCATE TABLE territory_events RESTART IDENTITY CASCADE');

  // Drop the old constraint (name matches schema-v2 CREATE TABLE)
  await pool.query(`
    ALTER TABLE territory_events
    DROP CONSTRAINT IF EXISTS territory_events_server_id_identity_id_event_type_structure_typ
  `);

  // Also drop by searching pg_constraint in case the name was truncated differently
  await pool.query(`
    DO $$
    DECLARE
      cname TEXT;
    BEGIN
      SELECT conname INTO cname
      FROM pg_constraint
      WHERE conrelid = 'territory_events'::regclass
        AND contype = 'u'
      LIMIT 1;
      IF cname IS NOT NULL THEN
        EXECUTE 'ALTER TABLE territory_events DROP CONSTRAINT IF EXISTS ' || quote_ident(cname);
      END IF;
    END $$;
  `);

  // Add new unique constraint that does not include structure_type
  await pool.query(`
    ALTER TABLE territory_events
    ADD CONSTRAINT territory_events_unique
    UNIQUE (server_id, identity_id, event_type, timestamp, pos_x, pos_y, pos_z)
  `);

  console.log('   ✅ Truncated territory_events and updated UNIQUE constraint');
}

module.exports = { up };
