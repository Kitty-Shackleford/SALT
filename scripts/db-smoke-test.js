#!/usr/bin/env node
/**
 * db:smoke-test
 *
 * Initialises a fresh PostgreSQL database using the application's standard
 * schema initialisation path and verifies that the expected tables are
 * created without error.
 *
 * Usage:
 *   npm run db:smoke-test
 *
 * Environment variables (same as the main application):
 *   POSTGRES_HOST, POSTGRES_PORT, POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD
 *
 * Exit codes:
 *   0 – all tables verified successfully
 *   1 – connection or schema initialisation failed
 */

'use strict';

require('dotenv').config();

const { Pool } = require('pg');
const assert = require('assert').strict;
const { buildServerContext } = require('../services/aiService');

const EXPECTED_TABLES = [
  // schema-v2 legacy tables
  'users',
  'guilds',
  'guild_tokens',
  'guild_roles',
  'guild_features',
  'servers',
  'server_features',
  'players',
  'player_identities',
  'player_gamertags',
  'player_server_activity',
  'player_sessions',
  'player_stats',
  'player_health_status',
  'kill_events',
  'damage_events',
  'territory_events',
  'player_achievements',
  'player_wallets',
  'player_bank_accounts',
  'economy_transactions',
  'guild_economy_config',
  'linked_accounts',
  'sessions',
  'automation_settings',
  'sync_jobs',
  'downloads',
  'jobs',
  'file_downloads',
  'audit_log',
  'discord_feeds',
  'feed_templates',
  'feed_events',
  'server_settings',
  'alt_ban_exemptions',
  // event-driven core tables (migration 018)
  'events',
  'plugin_data',
  'audit_logs',
  'projection_checkpoints',
  'loot_despawn_events',
];

async function main() {
  console.log('🔍 DayZ Dashboard – Database smoke test\n');

  let initializeDatabase;
  try {
    ({ initializeDatabase } = require('../db/schema'));
  } catch (err) {
    console.error('❌ Failed to load db/schema.js:', err.message);
    process.exit(1);
  }

  let adapter;
  try {
    adapter = await initializeDatabase();
    console.log('✅ Database initialisation completed\n');
  } catch (err) {
    console.error('❌ Database initialisation failed:', err.message);
    process.exit(1);
  }

  // Obtain the native pg Pool from the adapter for table verification queries
  const pool = adapter.getNativeConnection
    ? adapter.getNativeConnection()
    : new Pool({
        host: process.env.POSTGRES_HOST || 'localhost',
        port: process.env.POSTGRES_PORT || 5432,
        database: process.env.POSTGRES_DB || 'dayz-dashboard',
        user: process.env.POSTGRES_USER || 'dayz-dashboard',
        password: process.env.POSTGRES_PASSWORD,
      });

  console.log('🔍 Verifying expected tables...\n');

  const { rows } = await pool.query(`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
  `);

  const present = new Set(rows.map(r => r.tablename));
  const missing = EXPECTED_TABLES.filter(t => !present.has(t));

  if (missing.length > 0) {
    console.error('❌ Missing tables:', missing.join(', '));
    await pool.end();
    process.exit(1);
  }

  console.log(`✅ All ${EXPECTED_TABLES.length} expected tables are present\n`);
  console.log('Tables found in database:');
  rows.forEach(r => console.log(`  • ${r.tablename}`));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const guild = await client.query(
      `INSERT INTO guilds (discord_guild_id, name, status)
       VALUES ($1, $2, 'approved') RETURNING id`,
      [`db-smoke-ai-${process.pid}`, 'DB smoke AI guild']
    );
    const server = await client.query(
      `INSERT INTO servers (guild_id, name, platform, platform_server_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [guild.rows[0].id, 'DB smoke AI server', 'pc', `db-smoke-ai-${process.pid}`]
    );
    const contextDb = {
      async get(sql, params = []) {
        const result = await client.query(sql, params);
        return result.rows[0] || null;
      },
      async query(sql, params = []) {
        const result = await client.query(sql, params);
        return result.rows;
      },
    };
    const context = await buildServerContext(contextDb, server.rows[0].id, 7);
    assert.match(context, /0 total kills/);
    assert.match(context, /0 despawn events/);
    assert.match(context, /Approximate unique active players: 0/);
    await client.query('ROLLBACK');
    console.log('✅ AI server context queries match the initialized PostgreSQL schema\n');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  await pool.end();
  console.log('\n✅ Smoke test passed');
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
