/*
 * Migration 042 — Kill reward modes
 *
 * Adds two columns to guild_economy_config so server owners can choose
 * how kill rewards are paid out:
 *
 *   kill_reward_mode:
 *     'bank'  — server bank pays the killer a fixed reward (existing behaviour)
 *     'loot'  — killer takes a configurable amount from the victim's wallet
 *     'both'  — both effects apply
 *
 *   kill_loot_amount:
 *     Amount taken from the victim's wallet when mode is 'loot' or 'both'.
 *     Capped at the victim's current balance (they can't go negative).
 */

async function up(pool) {
  console.log('🔄 Migration 042: Add kill reward mode columns to guild_economy_config');

  await pool.query(`ALTER TABLE guild_economy_config
    ADD COLUMN IF NOT EXISTS kill_reward_mode TEXT NOT NULL DEFAULT 'bank'`);

  await pool.query(`ALTER TABLE guild_economy_config
    ADD COLUMN IF NOT EXISTS kill_loot_amount REAL NOT NULL DEFAULT 100`);

  // Controls which account(s) are raided when loot mode is active:
  //   'wallet' — cash on hand only (default)
  //   'bank'   — bank balance only
  //   'both'   — wallet first, then bank for the remainder
  await pool.query(`ALTER TABLE guild_economy_config
    ADD COLUMN IF NOT EXISTS kill_loot_source TEXT NOT NULL DEFAULT 'wallet'`);

  console.log('✅ Migration 042 complete');
}

module.exports = { up };
