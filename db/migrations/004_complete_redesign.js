'use strict';

/**
 * Migration 004: legacy Schema V1 detection.
 *
 * The former automated redesign attempted to copy and rename an entire live
 * database without a transaction. Its PostgreSQL path could create incomplete
 * replacement tables and then cut over after copy errors. Until a separately
 * tested import tool exists, legacy databases must fail closed without writes.
 */

async function checkIfMigrationNeeded(db) {
  console.log('📋 Checking for a legacy Schema V1 database...');

  const hasOldGuilds = await db.tableExists('discord_guilds');
  const hasOldAccounts = await db.tableExists('game_accounts');

  return hasOldGuilds || hasOldAccounts;
}

async function migrate(db) {
  const needsMigration = await checkIfMigrationNeeded(db);
  if (!needsMigration) {
    console.log('✅ Legacy migration not required.');
    return { success: true, skipped: true };
  }

  const error = new Error(
    'Legacy Schema V1 detected. Automatic Migration 004 is disabled because '
    + 'the historical PostgreSQL conversion is not data-safe. Create a pg_dump '
    + 'backup and migrate through a separately validated import process.'
  );
  error.code = 'LEGACY_SCHEMA_MIGRATION_UNSUPPORTED';
  throw error;
}

module.exports = { migrate, checkIfMigrationNeeded };