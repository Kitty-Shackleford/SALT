'use strict';

const assert = require('assert');
const { Client } = require('pg');
const { FINANCIAL_IDEMPOTENCY_SQL } = require('../db/migrations/075_financial_idempotency');
const {
  claimFinancialOperationInTransaction,
  completeFinancialOperationInTransaction,
} = require('../utils/financialIdempotency');

function adapter(client) {
  const convert = sql => {
    let index = 0;
    return sql.replace(/\?/g, () => `$${++index}`);
  };
  return {
    async get(sql, params = []) {
      const result = await client.query(convert(sql), params);
      return result.rows[0] || null;
    },
    async run(sql, params = []) {
      const result = await client.query(convert(sql), params);
      return { changes: result.rowCount };
    },
  };
}

function claimInput(overrides = {}) {
  return {
    serverId: 7,
    identityId: 11,
    actorUserId: 13,
    operation: 'economy_deposit',
    idempotencyKey: 'same-request',
    requestFingerprint: 'a'.repeat(64),
    ...overrides,
  };
}

async function main() {
  const connectionString = process.env.FINANCIAL_IDEMPOTENCY_PG_TEST_DATABASE;
  if (!connectionString) {
    console.log('financial idempotency PostgreSQL rehearsal skipped (FINANCIAL_IDEMPOTENCY_PG_TEST_DATABASE unset)');
    return;
  }
  const databaseName = new URL(connectionString).pathname.slice(1);
  if (!/(?:-|_)test$/i.test(databaseName)) {
    throw new Error('FINANCIAL_IDEMPOTENCY_PG_TEST_DATABASE must name a dedicated database ending in -test or _test');
  }

  const setup = new Client({ connectionString });
  const first = new Client({ connectionString });
  const second = new Client({ connectionString });
  const schema = `financial_idempotency_${process.pid}`;
  await Promise.all([setup.connect(), first.connect(), second.connect()]);
  try {
    await setup.query(`CREATE SCHEMA ${schema}`);
    await setup.query(`SET search_path TO ${schema}, public`);
    await setup.query('CREATE TABLE servers (id INTEGER PRIMARY KEY)');
    await setup.query('CREATE TABLE player_identities (id INTEGER PRIMARY KEY)');
    await setup.query('CREATE TABLE users (id INTEGER PRIMARY KEY)');
    await setup.query('INSERT INTO servers VALUES (7)');
    await setup.query('INSERT INTO player_identities VALUES (11)');
    await setup.query('INSERT INTO users VALUES (13)');
    await setup.query(FINANCIAL_IDEMPOTENCY_SQL);
    await Promise.all([
      first.query(`SET search_path TO ${schema}, public`),
      second.query(`SET search_path TO ${schema}, public`),
    ]);

    await first.query('BEGIN');
    const claimed = await claimFinancialOperationInTransaction(adapter(first), claimInput());
    assert(/^\d+$/.test(String(claimed.id)), 'PostgreSQL BIGINT claim id must be integer-like');
    assert.strictEqual(claimed.replay, false);

    await second.query('BEGIN');
    const concurrentReplay = claimFinancialOperationInTransaction(adapter(second), claimInput());
    await completeFinancialOperationInTransaction(adapter(first), claimed.id, 200, { ok: true, balance: 25 });
    await first.query('COMMIT');
    const replay = await concurrentReplay;
    assert.deepStrictEqual(replay, {
      id: claimed.id,
      replay: true,
      status: 200,
      body: { ok: true, balance: 25 },
    });
    await second.query('COMMIT');

    await second.query('BEGIN');
    await assert.rejects(
      () => claimFinancialOperationInTransaction(adapter(second), claimInput({
        operation: 'economy_withdraw',
        requestFingerprint: 'b'.repeat(64),
      })),
      error => error.status === 409 && /conflicts with another request/.test(error.message)
    );
    await second.query('ROLLBACK');

    await first.query('BEGIN');
    const rollbackClaim = await claimFinancialOperationInTransaction(adapter(first), claimInput({
      idempotencyKey: 'rolled-back-request',
    }));
    assert(/^\d+$/.test(String(rollbackClaim.id)),
      'PostgreSQL BIGINT rollback claim id must be integer-like');
    assert.strictEqual(rollbackClaim.replay, false);
    await first.query('ROLLBACK');

    await second.query('BEGIN');
    const retryAfterRollback = await claimFinancialOperationInTransaction(adapter(second), claimInput({
      idempotencyKey: 'rolled-back-request',
    }));
    assert(/^\d+$/.test(String(retryAfterRollback.id)),
      'PostgreSQL BIGINT retry claim id must be integer-like');
    assert.strictEqual(retryAfterRollback.replay, false);
    await second.query('ROLLBACK');

    const count = await setup.query('SELECT COUNT(*)::int AS count FROM financial_idempotency_records');
    assert.strictEqual(count.rows[0].count, 1, 'only the completed request should remain durable');
    console.log('financial idempotency PostgreSQL rehearsal passed');
  } finally {
    await Promise.allSettled([first.end(), second.end()]);
    await setup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await setup.end();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
