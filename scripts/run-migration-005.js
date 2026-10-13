#!/usr/bin/env node

/**
 * Run Migration 005 - Add Analytics Tables
 *
 * This script adds the damage_events and territory_events tables
 * to an existing database.
 *
 * Usage:
 *   node scripts/run-migration-005.js
 *
 * Environment Variables:
 *   POSTGRES_HOST     - PostgreSQL host
 *   POSTGRES_PORT     - PostgreSQL port
 *   POSTGRES_DB       - PostgreSQL database name
 *   POSTGRES_USER     - PostgreSQL username
 *   POSTGRES_PASSWORD - PostgreSQL password
 */

const { initializeDatabase, closeDatabase } = require('../db/abstraction');
const { migrate } = require('../db/migrations/005_add_analytics_tables');

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Migration 005: Add Analytics Tables                        ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  let db = null;

  try {
    db = await initializeDatabase();
    const result = await migrate(db);

    if (result.success) {
      if (result.skipped) {
        console.log('✅ No migration needed - tables already exist.\n');
      } else {
        console.log('✨ Migration completed successfully!\n');
      }
    } else {
      console.error('❌ Migration failed:', result.error);
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ Error running migration:', error);
    process.exit(1);
  } finally {
    if (db) {
      await closeDatabase();
    }
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
