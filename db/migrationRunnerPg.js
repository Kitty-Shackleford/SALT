/**
 * PostgreSQL Migration Runner
 *
 * This runner:
 *   - Manages the schema_migrations tracking table using pg Pool.query()
 *   - Marks schema-v2 baseline migrations as complete without rerunning them.
 *   - Runs new PostgreSQL-compatible migrations (018+) whose up(pool) function
 *     returns a Promise:
 *       018_event_driven_core.js
 *       019_snake_case_columns.js
 *       020_adm_log_tables.js
 *       021_rename_timestamp_columns.js
 */

const path = require('path');
const fs = require('fs');

// These migrations are represented by createSchemaV2() on fresh installations.
const SCHEMA_BASELINE_MIGRATIONS = new Set([
  '004_complete_redesign.js',
  '005_add_analytics_tables.js',
  '007_migrate_user_tokens.js',
  '011_add_player_achievements.js',
  '012_add_kill_events_victimtype_bodypart.js',
  '013_add_economy_system.js',
  '014_add_fixed_supply.js',
  '015_add_missing_economy_columns.js',
  '016_add_discord_feeds.js',
  '017_add_auto_ban_tables.js',
]);

const MIGRATION_LOCK_ID = 2147483003;
const MIGRATION_LOCK_TIMEOUT = process.env.MIGRATION_LOCK_TIMEOUT || '30s';
const MIGRATION_STATEMENT_TIMEOUT = process.env.MIGRATION_STATEMENT_TIMEOUT || '10min';

function validateMigrationExport(file, migration) {
  if (!migration || typeof migration.up !== 'function') {
    throw new Error(`Migration ${file} must export an up() function`);
  }
}

async function withMigrationLock(pool, callback) {
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query("SELECT set_config('lock_timeout', $1, false)", [MIGRATION_LOCK_TIMEOUT]);
    await client.query("SELECT set_config('statement_timeout', $1, false)", [MIGRATION_STATEMENT_TIMEOUT]);
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    locked = true;
    return await callback(client);
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    await client.query('RESET lock_timeout');
    await client.query('RESET statement_timeout');
    client.release();
  }
}

function createTransactionalMigrationDb(client) {
  const query = async (sql, params) => {
    const control = typeof sql === 'string' ? sql.trim().toUpperCase() : '';
    if (control === 'BEGIN' || control === 'COMMIT' || control === 'ROLLBACK') {
      return { rows: [], rowCount: 0 };
    }
    return client.query(sql, params);
  };
  const leasedClient = { query, release() {} };
  return { query, async connect() { return leasedClient; } };
}

async function runMigrationOnClient(client, migration, file) {
  try {
    await client.query('BEGIN');
    await migration.up(createTransactionalMigrationDb(client));
    await client.query(
      'INSERT INTO schema_migrations (migration_name) VALUES ($1) ON CONFLICT DO NOTHING',
      [file]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function runMigrationInTransaction(pool, migration, file) {
  const client = await pool.connect();
  try {
    await runMigrationOnClient(client, migration, file);
  } finally {
    client.release();
  }
}

/**
 * Run pending migrations for a PostgreSQL installation.
 * @param {import('pg').Pool} pool - pg connection pool
 */
async function runMigrationsOnClient(pool) {
  // Ensure the migration tracking table exists.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      migration_name TEXT UNIQUE NOT NULL,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const migrationsDir = path.join(__dirname, 'migrations');

  if (!fs.existsSync(migrationsDir)) {
    console.log('✅ No migrations directory found');
    return;
  }

  const migrationFiles = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.js'))
    .sort();

  if (migrationFiles.length === 0) {
    console.log('✅ No migration files found');
    return;
  }

  // Fetch already-executed migrations.
  const { rows } = await pool.query('SELECT migration_name FROM schema_migrations');
  const executed = new Set(rows.map(r => r.migration_name));

  const pending = migrationFiles.filter(f => !executed.has(f));

  if (pending.length === 0) {
    console.log('✅ All migrations up to date');
    return;
  }

  console.log(`📦 Running ${pending.length} pending migration(s)...`);

  for (const file of pending) {
    if (SCHEMA_BASELINE_MIGRATIONS.has(file)) {
      console.log(`  ⏭️  Marking ${file} complete (included in schema baseline)`);
      await pool.query(
        'INSERT INTO schema_migrations (migration_name) VALUES ($1) ON CONFLICT DO NOTHING',
        [file]
      );
      continue;
    }

    const migrationPath = path.join(migrationsDir, file);
    console.log(`  → Running migration: ${file}`);

    const migration = require(migrationPath);
    validateMigrationExport(file, migration);

    await runMigrationOnClient(pool, migration, file);
    console.log(`  ✅ Completed: ${file}`);
  }

  console.log('✅ Migration check complete\n');
}

async function runMigrationsPg(pool) {
  return withMigrationLock(pool, client => runMigrationsOnClient(client));
}

module.exports = {
  runMigrationsPg,
  runMigrationInTransaction,
  validateMigrationExport,
  withMigrationLock,
};
