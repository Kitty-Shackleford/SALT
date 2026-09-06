const { initializeDatabase: initDB } = require('./abstraction');
const { createSchemaV2, SCHEMA_VERSION } = require('./schema-v2');
const { migrate: runMigration004 } = require('./migrations/004_complete_redesign');
const { runMigrationsPg } = require('./migrationRunnerPg');

function classifySchemaState(currentVersion, hasOldTables) {
  if (hasOldTables) return 'legacy';
  if (currentVersion === 0) return 'fresh';
  if (currentVersion === SCHEMA_VERSION) return 'current';
  return 'unsupported';
}

/**
 * Initialize database with automatic migration support
 * - Detects schema version
 * - Refuses unsafe automatic conversion when a legacy v1 schema is detected
 * - Creates new schema if fresh install
 * @returns {Promise<Object>} Database adapter instance
 */
async function initializeDatabase() {
  console.log('📦 Initializing database...');

  try {
    // Initialize database connection using abstraction layer
    const db = await initDB();

    // Detect legacy tables before reading schema-version metadata. The version
    // read creates its tracking table on fresh databases, so this order keeps
    // legacy refusal non-mutating.
    const hasOldTables = await checkForOldSchema(db);
    if (hasOldTables) {
      // Legacy conversion is detected here but deliberately fails closed.
      console.log('\n⛔ OLD SCHEMA DETECTED (v1)');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      await runMigration004(db);
    }

    const currentVersion = await db.getSchemaVersion();
    console.log(`   Current schema version: ${currentVersion}`);
    console.log(`   Target schema version: ${SCHEMA_VERSION}`);
    const schemaState = classifySchemaState(currentVersion, hasOldTables);

    if (schemaState === 'fresh') {
      // Fresh install - create v2 schema
      console.log('✨ Fresh installation detected - creating Schema V2...\n');
      try {
        await createSchemaV2(db);
      } catch (schemaError) {
        console.error('❌ Schema V2 creation failed:', schemaError.message);
        console.error('\n💡 If this is a fresh development database, reset it with:');
        console.error('   docker compose down -v && docker compose up --build\n');
        throw schemaError;
      }
      console.log('✅ Database initialized with Schema V2!\n');
    } else if (schemaState === 'current') {
      console.log('✅ Database schema is up to date (v2)\n');
    } else {
      throw new Error(
        `Unsupported schema version ${currentVersion}; expected ${SCHEMA_VERSION}. `
        + 'Back up the database and use a separately validated upgrade process.'
      );
    }

    // Run pending PostgreSQL migrations.
    const nativeDb = db.getNativeConnection ? db.getNativeConnection() : db;
    await runMigrationsPg(nativeDb);

    // Return the adapter so all callers use the unified abstraction interface
    return db;

  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    throw error;
  }
}

/**
 * Check if old schema (v1) tables exist
 * @param {Object} db - Database adapter
 * @returns {Promise<boolean>} True if old tables exist
 */
async function checkForOldSchema(db) {
  try {
    // Check for tables that exist in v1 but not v2 or have different structure
    const oldTableChecks = [
      'discord_guilds',  // Renamed to 'guilds' in v2
      'game_accounts'    // Split into players/identities/gamertags in v2
    ];

    for (const tableName of oldTableChecks) {
      const exists = await db.tableExists(tableName);
      if (exists) {
        return true;
      }
    }

    return false;
  } catch (error) {
    console.error('Error checking for old schema:', error);
    throw error;
  }
}

module.exports = { initializeDatabase, checkForOldSchema, classifySchemaState };
