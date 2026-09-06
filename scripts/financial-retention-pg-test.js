'use strict';

const assert = require('assert');
const { Client } = require('pg');
const { EXACT_TREE_FAIL_CLOSED_SQL } = require('../db/migrations/067_exact_tree_fail_closed');
const {
  FINANCIAL_REPLAY_RETENTION_SQL,
} = require('../db/migrations/080_financial_replay_evidence_retention');
const {
  OBJECT_SPAWNER_PRODUCTS_SQL,
} = require('../db/migrations/081_shop_object_spawner_products');

const tables = [
  'economy_transactions',
  'economy_supply_log',
  'bounty_claims',
  'casino_game_history',
  'shop_order_items',
  'economy_precision_reconciliation',
  'economy_supply_precision_reconciliation',
  'financial_refund_claims',
  'economy_daily_assessments',
  'financial_idempotency_records',
];

async function expectRetentionConflict(client, sql) {
  await client.query('SAVEPOINT retention_attempt');
  try {
    await client.query(sql);
    assert.fail(`Expected retention conflict for: ${sql}`);
  } catch (error) {
    assert.strictEqual(error.code, 'P0001', `unexpected PostgreSQL error for ${sql}: ${error.message}`);
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT retention_attempt');
  }
}

async function main() {
  const connectionString = process.env.FINANCIAL_RETENTION_PG_TEST_DATABASE;
  if (!connectionString) {
    console.log('financial retention PostgreSQL rehearsal skipped (FINANCIAL_RETENTION_PG_TEST_DATABASE unset)');
    return;
  }
  const databaseName = new URL(connectionString).pathname.slice(1);
  if (!/(?:-|_)test$/i.test(databaseName)) {
    throw new Error('FINANCIAL_RETENTION_PG_TEST_DATABASE must name a dedicated database ending in -test or _test');
  }

  const client = new Client({ connectionString });
  const schema = `retention_rehearsal_${process.pid}`;
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema}, public`);
    for (const table of tables) {
      if ([
        'shop_order_items',
        'financial_refund_claims',
        'economy_daily_assessments',
        'financial_idempotency_records',
      ].includes(table)) continue;
      await client.query(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, note TEXT)`);
    }
    await client.query(`CREATE TABLE economy_daily_assessments (
      id INTEGER PRIMARY KEY, server_id INTEGER NOT NULL DEFAULT 1,
      identity_id INTEGER NOT NULL DEFAULT 1, assessment_type TEXT NOT NULL DEFAULT 'bank_fee',
      business_date DATE NOT NULL DEFAULT CURRENT_DATE, amount NUMERIC(20,2) NOT NULL DEFAULT 0,
      details JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      note TEXT)`);
    await client.query(`CREATE TABLE financial_idempotency_records (
      id INTEGER PRIMARY KEY, server_id INTEGER NOT NULL DEFAULT 1,
      identity_id INTEGER NOT NULL DEFAULT 1, actor_user_id INTEGER NOT NULL DEFAULT 1,
      operation TEXT NOT NULL DEFAULT 'economy_deposit', idempotency_key TEXT NOT NULL DEFAULT 'request-1',
      request_fingerprint TEXT NOT NULL DEFAULT '${'a'.repeat(64)}', response_status SMALLINT,
      response_body JSONB, completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), note TEXT)`);
    await client.query(`CREATE TABLE shop_orders (
      id INTEGER PRIMARY KEY, identity_id INTEGER NOT NULL DEFAULT 1, server_id INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL, total_price NUMERIC(20,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), checked_out_at TIMESTAMPTZ, note TEXT)`);
    await client.query(`CREATE TABLE shop_order_items (
      id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES shop_orders(id),
      shop_item_id INTEGER NOT NULL DEFAULT 1, quantity INTEGER NOT NULL DEFAULT 1,
      unit_price NUMERIC(20,2) NOT NULL DEFAULT 10, pos_x NUMERIC DEFAULT 0,
      pos_y NUMERIC DEFAULT 0, pos_z NUMERIC DEFAULT 0, ypr_x NUMERIC DEFAULT 0,
      ypr_y NUMERIC DEFAULT 0, ypr_z NUMERIC DEFAULT 0, spawn_method TEXT DEFAULT 'event',
      custom_json_file_snapshot TEXT,
      file_entry_id TEXT, restarts_remaining INTEGER, is_active BOOLEAN NOT NULL DEFAULT TRUE,
      event_name_snapshot TEXT, item_name_snapshot TEXT DEFAULT 'kept', note TEXT)`);
    await client.query("CREATE TABLE financial_refund_claims (id INTEGER PRIMARY KEY, status TEXT NOT NULL, claimed_at TIMESTAMPTZ, note TEXT)");
    const parentTables = [
      'servers', 'guilds', 'users', 'player_identities', 'server_player_memberships',
      'player_wallets', 'player_bank_accounts', 'kill_events', 'bounties', 'casino_sessions',
      'guild_economy_config', 'shop_items',
    ];
    for (const table of parentTables.filter(table => !['bounties', 'casino_sessions', 'shop_items'].includes(table))) {
      await client.query(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, note TEXT)`);
    }
    await client.query(`CREATE TABLE shop_items (
      id INTEGER PRIMARY KEY, spawn_method TEXT, custom_json_file TEXT, note TEXT)`);
    await client.query(`CREATE TABLE bounties (
      id INTEGER PRIMARY KEY, server_id INTEGER NOT NULL, target_identity_id INTEGER NOT NULL,
      poster_identity_id INTEGER NOT NULL, amount NUMERIC(20,2) NOT NULL,
      status TEXT NOT NULL, cancellation_requested_at TIMESTAMPTZ, cancel_reason TEXT,
      settled_at TIMESTAMPTZ, claimed_by_identity_id INTEGER, claim_kill_event_id INTEGER, note TEXT)`);
    await client.query(`CREATE TABLE casino_sessions (
      id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, user_id INTEGER NOT NULL,
      identity_id INTEGER NOT NULL, server_id INTEGER NOT NULL, guild_id INTEGER NOT NULL,
      game_type TEXT NOT NULL, state JSONB NOT NULL DEFAULT '{}'::jsonb,
      version INTEGER NOT NULL DEFAULT 0, reserved_wager NUMERIC(20,2) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active', expires_at TIMESTAMPTZ NOT NULL,
      settled_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), note TEXT)`);

    const escrowStart = EXACT_TREE_FAIL_CLOSED_SQL.indexOf(
      'CREATE OR REPLACE FUNCTION protect_active_bounty_update()'
    );
    const escrowEnd = EXACT_TREE_FAIL_CLOSED_SQL.indexOf(
      'CREATE OR REPLACE FUNCTION server_has_financial_history('
    );
    assert(escrowStart >= 0 && escrowEnd > escrowStart, 'active escrow update DDL block missing');
    await client.query(EXACT_TREE_FAIL_CLOSED_SQL.slice(escrowStart, escrowEnd));

    const start = EXACT_TREE_FAIL_CLOSED_SQL.indexOf(
      'CREATE OR REPLACE FUNCTION protect_terminal_financial_history_update()'
    );
    const end = EXACT_TREE_FAIL_CLOSED_SQL.indexOf(
      'CREATE OR REPLACE FUNCTION protect_parent_with_financial_history()'
    );
    assert(start >= 0 && end > start, 'terminal retention DDL block missing from migration 067');
    await client.query(EXACT_TREE_FAIL_CLOSED_SQL.slice(start, end));
    await client.query(FINANCIAL_REPLAY_RETENTION_SQL);
    await client.query(FINANCIAL_REPLAY_RETENTION_SQL);
    const parentTruncateStart = EXACT_TREE_FAIL_CLOSED_SQL.lastIndexOf('DO $$\n  DECLARE target_table TEXT;');
    assert(parentTruncateStart > end, 'parent TRUNCATE retention DDL block missing from migration 067');
    await client.query(EXACT_TREE_FAIL_CLOSED_SQL.slice(parentTruncateStart));

    for (const table of tables) {
      if (table === 'shop_order_items') {
        await client.query("INSERT INTO shop_orders (id, status, note) VALUES (1, 'completed', 'kept')");
        await client.query("INSERT INTO shop_order_items (id, order_id, note) VALUES (1, 1, 'kept')");
      } else if (table === 'financial_refund_claims') {
        await client.query("INSERT INTO financial_refund_claims (id, status, note) VALUES (1, 'pending', 'kept')");
      } else {
        await client.query(`INSERT INTO ${table} (id, note) VALUES (1, 'kept')`);
      }
      await expectRetentionConflict(client, `UPDATE ${table} SET note = 'rewritten' WHERE id = 1`);
      const row = await client.query(`SELECT note FROM ${table} WHERE id = 1`);
      assert.strictEqual(row.rows[0].note, 'kept', `${table} row must survive denied UPDATE unchanged`);
      await expectRetentionConflict(client, `DELETE FROM ${table} WHERE id = 1`);
      await expectRetentionConflict(client, `TRUNCATE TABLE ${table}`);
      const retained = await client.query(`SELECT COUNT(*)::int AS count FROM ${table}`);
      assert.strictEqual(retained.rows[0].count, 1, `${table} row must survive denied deletion paths`);
    }
    await client.query(FINANCIAL_REPLAY_RETENTION_SQL);
    const pendingAssessment = await client.query(
      'SELECT completed_at IS NULL AS pending FROM economy_daily_assessments WHERE id = 1'
    );
    assert.strictEqual(pendingAssessment.rows[0].pending, true,
      'migration rerun must not mark an in-flight daily assessment complete');
    await client.query(`UPDATE economy_daily_assessments
      SET amount = 10.25, details = '{"accountType":"bank"}', completed_at = clock_timestamp()
      WHERE id = 1`);
    const completedAssessment = await client.query(
      'SELECT amount::text AS amount, details, completed_at IS NOT NULL AS completed FROM economy_daily_assessments WHERE id = 1'
    );
    assert.deepStrictEqual(completedAssessment.rows[0], {
      amount: '10.25', details: { accountType: 'bank' }, completed: true,
    }, 'daily assessment claim must support exactly one legitimate completion');
    await expectRetentionConflict(client,
      'UPDATE economy_daily_assessments SET amount = 10.26 WHERE id = 1');
    await client.query(`UPDATE financial_idempotency_records
      SET response_status = 200, response_body = '{"ok":true}', completed_at = clock_timestamp()
      WHERE id = 1`);
    await expectRetentionConflict(client,
      `UPDATE financial_idempotency_records SET response_status = 201 WHERE id = 1`);
    await expectRetentionConflict(client, "UPDATE shop_orders SET note = 'rewritten' WHERE id = 1");
    await client.query("UPDATE shop_orders SET status = 'refunded' WHERE id = 1");
    await client.query("UPDATE financial_refund_claims SET status = 'claimed', claimed_at = clock_timestamp() WHERE id = 1");
    await client.query("INSERT INTO shop_orders (id, status, note) VALUES (2, 'cart', 'mutable cart')");
    await client.query("INSERT INTO shop_order_items (id, order_id, note) VALUES (2, 2, 'mutable cart')");
    await client.query('UPDATE shop_order_items SET quantity = 2 WHERE id = 2');
    await client.query('DELETE FROM shop_order_items WHERE id = 2');
    const cartLine = await client.query('SELECT id FROM shop_order_items WHERE id = 2');
    assert.strictEqual(cartLine.rowCount, 0, 'mutable cart line deletion must remain operational');

    await client.query("INSERT INTO shop_items (id, spawn_method, custom_json_file, note) VALUES (4, 'custom_json', NULL, 'legacy catalog')");
    await client.query("INSERT INTO shop_orders (id, status, note) VALUES (4, 'completed', 'legacy completed'), (5, 'cart', 'legacy cart')");
    await client.query(`INSERT INTO shop_order_items
      (id, order_id, shop_item_id, spawn_method, custom_json_file_snapshot, note)
      VALUES (4, 4, 4, 'custom_json', NULL, 'legacy completed line'),
             (5, 5, 4, 'custom_json', NULL, 'legacy cart line')`);
    await client.query(OBJECT_SPAWNER_PRODUCTS_SQL);
    await client.query(OBJECT_SPAWNER_PRODUCTS_SQL);
    const migratedObjectSpawnerRows = await client.query(`
      SELECT id, object_spawner_config_snapshot->>'file' AS file
      FROM shop_order_items WHERE id IN (4, 5) ORDER BY id`);
    assert.deepStrictEqual(migratedObjectSpawnerRows.rows, [
      { id: 4, file: 'custom/shop.json' },
      { id: 5, file: 'custom/shop.json' },
    ], 'migration 081 must backfill cart and retained legacy lines and remain rerunnable');
    await expectRetentionConflict(client,
      "UPDATE shop_order_items SET object_spawner_config_snapshot = '{}'::jsonb WHERE id = 4");
    await expectRetentionConflict(client,
      "UPDATE shop_order_items SET object_spawner_config_snapshot = '{}'::jsonb WHERE id = 5");

    await client.query("INSERT INTO bounties (id, server_id, target_identity_id, poster_identity_id, amount, status) VALUES (1, 1, 2, 3, 10, 'active')");
    await expectRetentionConflict(client, 'UPDATE bounties SET amount = 9 WHERE id = 1');
    await expectRetentionConflict(client, 'UPDATE bounties SET server_id = 2 WHERE id = 1');
    await expectRetentionConflict(client, "UPDATE bounties SET status = 'expired' WHERE id = 1");
    await client.query("UPDATE bounties SET cancellation_requested_at = clock_timestamp(), cancel_reason = 'requested' WHERE id = 1");
    await client.query("INSERT INTO bounties (id, server_id, target_identity_id, poster_identity_id, amount, status) VALUES (2, 1, 2, 3, 10, 'active')");
    await client.query("UPDATE bounties SET status = 'claimed', settled_at = clock_timestamp(), claimed_by_identity_id = 4, claim_kill_event_id = 5 WHERE id = 2");
    await expectRetentionConflict(client, "UPDATE bounties SET cancel_reason = 'rewrite' WHERE id = 2");

    const expires = new Date(Date.now() + 60000).toISOString();
    await client.query(`INSERT INTO casino_sessions
      (id, session_id, user_id, identity_id, server_id, guild_id, game_type, reserved_wager, expires_at)
      VALUES (1, 'session-1', 1, 2, 3, 4, 'holdem', 10, $1)`, [expires]);
    await client.query("UPDATE casino_sessions SET state = '{\"step\":1}', version = 1, updated_at = clock_timestamp() WHERE id = 1");
    await client.query("UPDATE casino_sessions SET reserved_wager = 12, version = 2, updated_at = clock_timestamp() WHERE id = 1");
    await expectRetentionConflict(client, 'UPDATE casino_sessions SET reserved_wager = 11, version = 3 WHERE id = 1');
    await expectRetentionConflict(client, 'UPDATE casino_sessions SET identity_id = 9, version = 3 WHERE id = 1');
    await client.query("UPDATE casino_sessions SET status = 'settled', settled_at = clock_timestamp(), version = 3, updated_at = clock_timestamp() WHERE id = 1");
    await expectRetentionConflict(client, "UPDATE casino_sessions SET state = '{}' WHERE id = 1");

    await client.query("INSERT INTO shop_orders (id, status, note) VALUES (3, 'cart', 'cart')");
    await client.query("INSERT INTO shop_order_items (id, order_id, note) VALUES (3, 3, 'line')");
    await client.query('UPDATE shop_orders SET total_price = 10 WHERE id = 3');
    await client.query('UPDATE shop_order_items SET quantity = 2 WHERE id = 3');
    await expectRetentionConflict(client, "UPDATE shop_orders SET note = 'forged' WHERE id = 3");
    await expectRetentionConflict(client, "UPDATE shop_orders SET status = 'refunded' WHERE id = 3");
    await expectRetentionConflict(client, 'UPDATE shop_order_items SET order_id = 1 WHERE id = 3');
    await expectRetentionConflict(client, 'UPDATE shop_order_items SET unit_price = 1 WHERE id = 3');
    await expectRetentionConflict(client, "UPDATE shop_order_items SET item_name_snapshot = 'forged' WHERE id = 3");
    await client.query('UPDATE shop_order_items SET restarts_remaining = 1 WHERE id = 3');
    await client.query("UPDATE shop_orders SET status = 'completed', total_price = 20, checked_out_at = clock_timestamp() WHERE id = 3");
    await client.query('UPDATE shop_order_items SET restarts_remaining = 0 WHERE id = 3');
    await client.query('UPDATE shop_order_items SET is_active = FALSE WHERE id = 3');
    await client.query("UPDATE shop_orders SET status = 'expired' WHERE id = 3");
    await client.query("UPDATE shop_orders SET status = 'refunded' WHERE id = 3");
    for (const table of [...parentTables, 'shop_orders']) {
      if (table === 'bounties') {
        await client.query("INSERT INTO bounties (id, server_id, target_identity_id, poster_identity_id, amount, status, note) VALUES (99, 1, 2, 3, 10, 'active', 'kept')");
      } else if (table === 'casino_sessions') {
        await client.query(`INSERT INTO casino_sessions
          (id, session_id, user_id, identity_id, server_id, guild_id, game_type, expires_at, note)
          VALUES (99, 'session-99', 1, 2, 3, 4, 'holdem', $1, 'kept')`, [expires]);
      } else {
        await client.query(`INSERT INTO ${table} (id, note${table === 'shop_orders' ? ', status' : ''}) VALUES (99, 'kept'${table === 'shop_orders' ? ", 'cart'" : ''})`);
      }
      await expectRetentionConflict(client, `TRUNCATE TABLE ${table} CASCADE`);
      const retained = await client.query(`SELECT note FROM ${table} WHERE id = 99`);
      assert.strictEqual(retained.rows[0].note, 'kept', `${table} must survive rejected cascading TRUNCATE`);
    }
    await client.query('ROLLBACK');
    console.log('financial retention PostgreSQL rehearsal passed');
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
