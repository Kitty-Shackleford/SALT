'use strict';

/**
 * Migration 021: Rename camelCase timestamp columns to snake_case.
 *
 * The original schema-v2.js used `createdAt`/`updatedAt` before the snake_case
 * conversion. On PostgreSQL, unquoted `createdAt` folds to `createdat`.
 * Migration 019 missed these timestamp renames. This migration catches them.
 *
 * Uses SAVEPOINT per rename so a 42703 (column not found) error on an already-
 * renamed column is silently skipped rather than aborting the whole transaction.
 */

const RENAMES = [
  // [table, oldColumn, newColumn]
  ['guilds',            'createdat',  'created_at'],
  ['guild_tokens',      'createdat',  'created_at'],
  ['guild_features',    'updatedat',  'updated_at'],
  ['servers',           'createdat',  'created_at'],
  ['server_features',   'updatedat',  'updated_at'],
  ['players',           'createdat',  'created_at'],
  ['players',           'updatedat',  'updated_at'],
  ['player_stats',      'updatedat',  'updated_at'],
  ['users',             'createdat',  'created_at'],
  ['linked_accounts',   'createdat',  'created_at'],
  ['jobs',              'createdat',  'created_at'],
];

const RENAMES_DOWN = RENAMES.map(([t, o, n]) => [t, n, o]);

async function safeRename(client, table, oldCol, newCol) {
  try {
    await client.query(`SAVEPOINT sp_ts_rename`);
    await client.query(`ALTER TABLE ${table} RENAME COLUMN ${oldCol} TO ${newCol}`);
    await client.query(`RELEASE SAVEPOINT sp_ts_rename`);
    console.log(`  ✓ Renamed ${table}.${oldCol} → ${newCol}`);
  } catch (err) {
    await client.query(`ROLLBACK TO SAVEPOINT sp_ts_rename`);
    if (err.code === '42703' || err.code === '42P01') {
      // Column or table doesn't exist — already renamed or table doesn't exist
    } else {
      throw err;
    }
  }
}

async function up(db) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const [table, oldCol, newCol] of RENAMES) {
      await safeRename(client, table, oldCol, newCol);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function down(db) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const [table, oldCol, newCol] of RENAMES_DOWN) {
      await safeRename(client, table, oldCol, newCol);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { up, down };
