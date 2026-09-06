'use strict';

const FOREIGN_KEYS = [
  ['guilds', 'guilds_approved_by_fkey', 'approved_by'],
  ['guilds', 'guilds_disabled_by_fkey', 'disabled_by'],
  ['guild_roles', 'guild_roles_assigned_by_fkey', 'assigned_by'],
  ['audit_log', 'audit_log_user_id_fkey', 'user_id'],
  ['alt_ban_exemptions', 'alt_ban_exemptions_exempted_by_fkey', 'exempted_by'],
];

function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

async function findUserForeignKeys(pool, table, column) {
  const result = await pool.query(
    `SELECT DISTINCT constraint_row.conname
       FROM pg_constraint constraint_row
       JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
       JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
       JOIN pg_attribute column_row
         ON column_row.attrelid = table_row.oid
        AND column_row.attnum = ANY(constraint_row.conkey)
      WHERE namespace_row.nspname = 'public'
        AND table_row.relname = $1
        AND column_row.attname = $2
        AND constraint_row.contype = 'f'
        AND constraint_row.confrelid = 'users'::regclass
        AND constraint_row.conkey = ARRAY[column_row.attnum]::smallint[]`,
    [table, column]
  );
  return result.rows.map(row => row.conname);
}

async function replaceForeignKeys(pool, deleteAction) {
  for (const [table, canonicalConstraint, column] of FOREIGN_KEYS) {
    const constraints = await findUserForeignKeys(pool, table, column);
    for (const constraint of constraints) {
      await pool.query(
        `ALTER TABLE ${quoteIdentifier(table)} DROP CONSTRAINT ${quoteIdentifier(constraint)}`
      );
    }
    await pool.query(`
      ALTER TABLE ${quoteIdentifier(table)}
        ADD CONSTRAINT ${quoteIdentifier(canonicalConstraint)}
        FOREIGN KEY (${quoteIdentifier(column)}) REFERENCES users(id) ${deleteAction}
    `);
  }
}

/** Preserve historical actor references without route-level cleanup locks. */
async function up(pool) {
  console.log('🔄 Migration 056: Preserve user-removal history references');
  await replaceForeignKeys(pool, 'ON DELETE SET NULL');
  console.log('✅ Migration 056 complete');
}

async function down(pool) {
  await replaceForeignKeys(pool, 'ON DELETE NO ACTION');
}

module.exports = { up, down };
