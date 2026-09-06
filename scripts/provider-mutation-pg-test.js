'use strict';

const assert = require('assert');
const { Client, Pool } = require('pg');
const PostgreSQLAdapter = require('../db/abstraction/postgres');
const { PROVIDER_RECOVERY_SQL } = require('../db/migrations/076_rotation_provider_recovery');
const { ROTATION_FILE_SWAP_ABSENCE_SQL } = require('../db/migrations/078_rotation_file_swap_absence');
const { PROVIDER_SERVICE_IDENTITY_SQL } = require('../db/migrations/079_provider_service_identity');
const {
  assertNoUnresolvedProviderMutation,
  prepareProviderMutation,
  updatePreparedProviderMutation,
} = require('../services/providerMutationRecoveryService');
const moneySupplyManager = require('../utils/moneySupplyManager');

async function main() {
  const connectionString = process.env.PROVIDER_MUTATION_PG_TEST_DATABASE;
  if (!connectionString) {
    console.log('provider mutation PostgreSQL rehearsal skipped (PROVIDER_MUTATION_PG_TEST_DATABASE unset)');
    return;
  }
  const databaseName = new URL(connectionString).pathname.slice(1);
  if (!/(?:-|_)test$/i.test(databaseName)) {
    throw new Error('PROVIDER_MUTATION_PG_TEST_DATABASE must name a dedicated database ending in -test or _test');
  }

  const setup = new Client({ connectionString });
  const schema = `provider_mutation_${process.pid}`;
  await setup.connect();
  let pool;
  try {
    await setup.query(`CREATE SCHEMA ${schema}`);
    await setup.query(`SET search_path TO ${schema}, public`);
    await setup.query(`
      CREATE TABLE servers (
        id INTEGER PRIMARY KEY,
        guild_id BIGINT NOT NULL,
        platform_server_id TEXT NOT NULL
      )
    `);
    await setup.query("INSERT INTO servers VALUES (7, 70, 'provider-7'), (8, 80, 'provider-8')");
    await setup.query(`CREATE TABLE guild_economy_config (
      server_id INTEGER PRIMARY KEY REFERENCES servers(id),
      fixed_supply_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      max_money_supply NUMERIC,
      current_money_supply NUMERIC NOT NULL DEFAULT 0
    )`);
    await setup.query('INSERT INTO guild_economy_config (server_id) VALUES (8)');
    await setup.query(`CREATE TABLE rotation_file_backups (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      snippet_id INTEGER NOT NULL,
      server_id INTEGER NOT NULL REFERENCES servers(id),
      file_path TEXT NOT NULL,
      content TEXT NOT NULL,
      backed_up_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (snippet_id, server_id)
    )`);
    await setup.query(PROVIDER_RECOVERY_SQL);
    await setup.query(ROTATION_FILE_SWAP_ABSENCE_SQL);

    pool = new Pool({
      connectionString,
      options: `-c search_path=${schema},public -c lock_timeout=500ms`,
    });
    const db = new PostgreSQLAdapter();
    db.pool = pool;
    await assertNoUnresolvedProviderMutation(db, 7);

    const checkoutPreparationId = await db.transaction(async transactionDb => {
      await moneySupplyManager.lockSupplyForUpdate(transactionDb, 8);
      const id = await prepareProviderMutation(db, {
        serverId: 8,
        providerServiceId: 'provider-8',
        workflow: 'shop',
        action: 'checkout',
        contextType: 'shop_order',
        contextId: '81',
        plan: { filePaths: ['/mission/shop.xml'] },
        snapshots: new Map([['/mission/shop.xml', '<old/>']]),
        triggeredBy: 'test:postgres',
      });
      await updatePreparedProviderMutation(transactionDb, id, 'completed');
      return id;
    });
    const checkoutPreparation = await setup.query(
      'SELECT status FROM provider_mutations WHERE id = $1',
      [checkoutPreparationId]
    );
    assert.strictEqual(checkoutPreparation.rows[0].status, 'completed',
      'the supply parent lock must permit an independent durable provider-operation FK insert');

    const operationId = await db.transaction(async transactionDb => {
      await transactionDb.acquireTransactionAdvisoryLock(0x53484f50, 7);
      await transactionDb.get('SELECT id FROM servers WHERE id = ? FOR NO KEY UPDATE', [7]);
      const id = await prepareProviderMutation(db, {
        serverId: 7,
        providerServiceId: 'provider-7',
        workflow: 'provider_list',
        action: 'add',
        contextType: 'blacklist',
        contextId: '/mission/ban.txt',
        plan: { filePaths: ['/mission/ban.txt'] },
        snapshots: new Map([['/mission/ban.txt', 'Alpha\n']]),
        triggeredBy: 'test:postgres',
      });
      await updatePreparedProviderMutation(transactionDb, id, 'recovery_pending', 'test failure');
      return id;
    });

    const unresolved = await setup.query(
      'SELECT status, finished_at FROM provider_mutations WHERE id = $1',
      [operationId]
    );
    assert.strictEqual(unresolved.rows[0].status, 'recovery_pending');
    assert.strictEqual(unresolved.rows[0].finished_at, null);
    await assert.rejects(
      assertNoUnresolvedProviderMutation(db, 7),
      error => error.code === 'PROVIDER_RECOVERY_PENDING'
    );
    await assertNoUnresolvedProviderMutation(db, 7, operationId);
    await assert.rejects(
      setup.query(
        "UPDATE provider_mutations SET finished_at = NOW() WHERE id = $1",
        [operationId]
      ),
      error => error.code === '23514'
    );

    await setup.query(
      `INSERT INTO rotation_file_backups
         (snippet_id, server_id, file_path, original_exists, content)
       VALUES (1, 7, '/mission/empty.xml', TRUE, ''),
              (2, 7, '/mission/absent.xml', FALSE, NULL)`
    );
    const backups = await setup.query(
      'SELECT original_exists, content FROM rotation_file_backups ORDER BY snippet_id'
    );
    assert.deepStrictEqual(backups.rows, [
      { original_exists: true, content: '' },
      { original_exists: false, content: null },
    ]);

    await pool.end();
    pool = null;
    await setup.query('DROP TABLE provider_mutation_files, provider_mutations');
    await setup.query(`CREATE TABLE provider_mutations (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      server_id INTEGER NOT NULL REFERENCES servers(id),
      status TEXT NOT NULL
    )`);
    await setup.query(
      "INSERT INTO provider_mutations (server_id, status) VALUES (7, 'recovery_pending')"
    );
    await assert.rejects(
      setup.query(PROVIDER_SERVICE_IDENTITY_SQL),
      error => /Cannot guess provider identity for unresolved recovery records/.test(error.message)
    );
    await setup.query("UPDATE provider_mutations SET status = 'completed'");
    await setup.query(PROVIDER_SERVICE_IDENTITY_SQL);
    const upgraded = await setup.query(
      'SELECT provider_service_id FROM provider_mutations'
    );
    assert.strictEqual(upgraded.rows[0].provider_service_id, 'provider-7');
    console.log('provider mutation PostgreSQL rehearsal passed');
  } finally {
    if (pool) await pool.end();
    await setup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await setup.end();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
