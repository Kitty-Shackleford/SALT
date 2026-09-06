/**
 * Migration 024: Allow null damage in damage_events
 *
 * FallDamageHealth log lines do not include a damage amount, so the damage
 * column must be nullable to store these events. Previously defined as NOT NULL.
 */
async function up(pool) {
  await pool.query(`ALTER TABLE damage_events ALTER COLUMN damage DROP NOT NULL`);
  console.log('✅ Migration 024: damage_events.damage is now nullable');
}

module.exports = { up };
