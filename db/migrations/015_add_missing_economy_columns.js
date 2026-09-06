/**
 * Migration 015: Add Missing Economy Config Columns
 *
 * Adds columns that may be missing from guild_economy_config on databases
 * that were created before these fields were defined.
 */

const ALLOWED_COLUMN_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const ALLOWED_TYPES = ['REAL', 'INTEGER', 'TEXT', 'BOOLEAN'];

function up(db, callback) {
  console.log('🔄 Migration 015: Add missing economy config columns');

  const columnsToAdd = [
    { name: 'supplyWarningThreshold', type: 'REAL', default: '90.0' },
    { name: 'preventNewEarningsAtCap', type: 'INTEGER', default: '0' },
    { name: 'deathPenaltyAffects', type: 'TEXT', default: "'wallet'" }
  ];

  // Validate column definitions against allowlists before building SQL
  for (const col of columnsToAdd) {
    if (!ALLOWED_COLUMN_PATTERN.test(col.name)) {
      return callback(new Error(`Invalid column name: ${col.name}`));
    }
    if (!ALLOWED_TYPES.includes(col.type)) {
      return callback(new Error(`Invalid column type: ${col.type}`));
    }
  }

  db.serialize(() => {
    let pending = columnsToAdd.length;

    if (pending === 0) {
      console.log('   ✅ No new economy config columns to add');
      return callback(null);
    }

    let failed = false;

    for (const col of columnsToAdd) {
      db.run(
        `ALTER TABLE guild_economy_config ADD COLUMN ${col.name} ${col.type} DEFAULT ${col.default}`,
        (err) => {
          if (failed) return;
          if (err && !err.message.includes('duplicate column')) {
            failed = true;
            return callback(err);
          }
          pending -= 1;
          if (pending === 0) {
            console.log('   ✅ Added missing economy config columns');
            callback(null);
          }
        }
      );
    }
  });
}

module.exports = { up };
