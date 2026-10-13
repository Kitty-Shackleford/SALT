/**
 * Migration 095: extend teleport_destinations.destination_type with 'coords'
 *
 * Phase A — coordinate destinations. Moderators can define a destination from
 * raw map coordinates (pos_x/pos_y/pos_z + map_name) rather than a named spot.
 * The column already exists (migration 071); this migration only widens the
 * CHECK constraint.
 */
'use strict';

async function up(pool) {
  console.log('🔄 Migration 095: Allow coordinate teleport destinations');
  await pool.query(`
    ALTER TABLE teleport_destinations
      DROP CONSTRAINT IF EXISTS teleport_destinations_destination_type_check
  `);
  await pool.query(`
    ALTER TABLE teleport_destinations
      ADD CONSTRAINT teleport_destinations_destination_type_check
      CHECK (destination_type IN ('named', 'spawn', 'pra', 'punishment', 'coords'))
  `);
  console.log('✅ Migration 095: coordinate destination type allowed');
}

async function down(pool) {
  // Any 'coords' rows must be removed before the constraint is narrowed again.
  await pool.query(`DELETE FROM teleport_destinations WHERE destination_type = 'coords'`);
  await pool.query(`
    ALTER TABLE teleport_destinations
      DROP CONSTRAINT IF EXISTS teleport_destinations_destination_type_check
  `);
  await pool.query(`
    ALTER TABLE teleport_destinations
      ADD CONSTRAINT teleport_destinations_destination_type_check
      CHECK (destination_type IN ('named', 'spawn', 'pra', 'punishment'))
  `);
}

module.exports = { up, down };
