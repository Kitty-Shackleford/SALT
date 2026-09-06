/**
 * Migration 023: Add Missing Economy Config Columns
 *
 * Adds fixed-supply tracking columns to PostgreSQL installations that used
 * schema-v2 as their baseline.
 *
 * Uses ADD COLUMN IF NOT EXISTS so the migration is safe to rerun.
 */

async function up(pool) {
  console.log('🔄 Migration 023: Add missing economy config columns');

  const columns = [
    'ALTER TABLE guild_economy_config ADD COLUMN IF NOT EXISTS fixed_supply_enabled BOOLEAN DEFAULT false',
    'ALTER TABLE guild_economy_config ADD COLUMN IF NOT EXISTS max_money_supply REAL DEFAULT NULL',
    'ALTER TABLE guild_economy_config ADD COLUMN IF NOT EXISTS current_money_supply REAL DEFAULT 0',
    'ALTER TABLE guild_economy_config ADD COLUMN IF NOT EXISTS last_supply_update TIMESTAMPTZ DEFAULT NULL',
  ];

  for (const sql of columns) {
    await pool.query(sql);
  }

  console.log('   ✅ Added fixed_supply_enabled, max_money_supply, current_money_supply, last_supply_update');
}

module.exports = { up };
