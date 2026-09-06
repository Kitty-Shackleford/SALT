/**
 * Migration 049: Make AI suggestion finalization claims recoverable.
 */
async function up(pool) {
  console.log('🔄 Migration 049: Add AI suggestion finalization lease');

  await pool.query(`
    ALTER TABLE ai_suggestions
      ADD COLUMN IF NOT EXISTS application_claimed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS application_claim_id UUID,
      ADD COLUMN IF NOT EXISTS application_previous_status TEXT;
  `);

  console.log('✅ Migration 049 complete');
}

async function down(pool) {
  await pool.query(`
    ALTER TABLE ai_suggestions
      DROP COLUMN IF EXISTS application_previous_status,
      DROP COLUMN IF EXISTS application_claim_id,
      DROP COLUMN IF EXISTS application_claimed_at;
  `);
}

module.exports = { up, down };
