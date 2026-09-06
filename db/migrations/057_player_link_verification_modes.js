'use strict';

function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

async function replaceVerificationConstraint(pool, methods) {
  const result = await pool.query(`
    SELECT constraint_row.conname
      FROM pg_constraint constraint_row
      JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
      JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
     WHERE namespace_row.nspname = 'public'
       AND table_row.relname = 'server_player_memberships'
       AND constraint_row.contype = 'c'
       AND pg_get_constraintdef(constraint_row.oid) LIKE '%verification_method%'
  `);
  for (const row of result.rows) {
    await pool.query(
      `ALTER TABLE server_player_memberships DROP CONSTRAINT ${quoteIdentifier(row.conname)}`
    );
  }
  const literals = methods.map(method => `'${method}'`).join(', ');
  await pool.query(`
    ALTER TABLE server_player_memberships
      ADD CONSTRAINT server_player_memberships_verification_method_check
      CHECK (verification_method IN (${literals}))
  `);
}

async function up(pool) {
  console.log('🔄 Migration 057: Add player-link verification modes');
  await replaceVerificationConstraint(pool, [
    'emote_challenge',
    'admin_approved',
    'self_asserted',
    'existing_verified_link',
  ]);
  console.log('✅ Migration 057 complete');
}

async function down(pool) {
  const weakRows = await pool.query(
    "SELECT 1 FROM server_player_memberships WHERE verification_method = 'self_asserted' LIMIT 1"
  );
  if (weakRows.rows.length) {
    throw new Error('Cannot remove open-link provenance while self_asserted memberships exist');
  }
  await replaceVerificationConstraint(pool, [
    'emote_challenge',
    'admin_approved',
    'existing_verified_link',
  ]);
}

module.exports = { up, down };
