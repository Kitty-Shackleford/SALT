'use strict';

const assert = require('assert');
const crypto = require('crypto');
const migration = require('../db/migrations/076_rotation_provider_recovery');
const providerIdentityMigration = require('../db/migrations/079_provider_service_identity');
const PostgreSQLAdapter = require('../db/abstraction/postgres');
const shop = require('../services/shopFileService');
const recovery = require('../services/providerMutationRecoveryService');
const fs = require('fs');
const path = require('path');
const { encryptToken } = require('../utils/encryption');

async function main() {
  const sql = migration.PROVIDER_RECOVERY_SQL || '';
  assert.match(sql, /CREATE TABLE IF NOT EXISTS provider_mutations/,
    'provider recovery must use an application-wide operation ledger');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS provider_mutation_files/);
  assert.match(sql, /workflow TEXT NOT NULL/);
  assert.match(sql, /reconciled_by TEXT/,
    'provider recovery must durably audit the authorized reconciler');
  assert.match(sql, /reconciled_at TIMESTAMPTZ/);
  assert.match(sql, /provider_service_id\s+TEXT\s+NOT NULL/,
    'provider operations must bind snapshots to the immutable provider service identity');
  assert.match(providerIdentityMigration.PROVIDER_SERVICE_IDENTITY_SQL,
    /status IN \('prepared', 'recovery_pending'\)[\s\S]*RAISE EXCEPTION/,
    'upgrade migration must refuse to guess provider identity for unresolved recovery records');
  assert.match(providerIdentityMigration.PROVIDER_SERVICE_IDENTITY_SQL,
    /status IN \('completed', 'compensated'\)/,
    'only terminal historical records may be backfilled from the current server registration');
  assert.match(sql, /WHERE status IN \('prepared', 'recovery_pending'\)/,
    'one unresolved provider operation must fence the exact server');
  assert.match(sql,
    /status IN \('prepared', 'recovery_pending'\) AND finished_at IS NULL/,
    'unresolved provider operations must remain unfinished under the database constraint');
  const recoverySource = fs.readFileSync(
    path.join(__dirname, '..', 'services/providerMutationRecoveryService.js'), 'utf8'
  );
  assert.match(
    recoverySource,
    /finished_at = CASE WHEN \? = 'recovery_pending' THEN NULL ELSE NOW\(\) END/,
    'provider finalization must preserve unfinished recovery_pending state'
  );
  assert.match(
    recoverySource,
    /String\(operation\.provider_service_id\)\s*!==\s*String\(context\.platformServerId\)/,
    'reconciliation must fail closed if the server registration points to another provider service'
  );

  let unresolvedQuery;
  await recovery.assertNoUnresolvedProviderMutation({
    async get(sqlText, params) {
      unresolvedQuery = { sqlText, params };
      return null;
    },
  }, 7);
  assert.deepStrictEqual(unresolvedQuery.params, [7],
    'a null allowed operation must not create an untyped PostgreSQL parameter');
  assert(!/id\s*<>\s*\?/.test(unresolvedQuery.sqlText),
    'a null allowed operation must omit the operation exclusion predicate');

  assert.strictEqual(typeof PostgreSQLAdapter.prototype.independentTransaction, 'function',
    'provider preparation needs a separately committed transaction');

  const adapter = Object.create(PostgreSQLAdapter.prototype);
  const queries = [];
  const client = {
    async query(sqlText) {
      queries.push(sqlText.trim());
      if (/pg_current_xact_id/.test(sqlText)) return { rows: [{ xid: '9' }] };
      return { rows: [] };
    },
    release() { queries.push('RELEASE'); },
  };
  adapter.pool = { async connect() { return client; } };
  adapter.transactionStorage = new (require('async_hooks').AsyncLocalStorage)();
  adapter.advisoryLockTimeoutMs = 1000;
  const independentResult = await adapter.transactionStorage.run(
    { client: { query: async () => { throw new Error('outer client used'); } } },
    () => adapter.independentTransaction(async transactionDb => {
      await transactionDb.query('SELECT 1');
      return 'committed';
    })
  );
  assert.strictEqual(independentResult, 'committed');
  assert(queries.includes('BEGIN') && queries.includes('COMMIT'),
    'independent provider preparation must commit on its own connection');

  const rollbackEvents = [];
  const rollbackAdapter = Object.create(PostgreSQLAdapter.prototype);
  rollbackAdapter.pool = {
    async connect() {
      return {
        async query(sqlText) {
          const normalized = sqlText.trim();
          rollbackEvents.push(normalized);
          if (/pg_current_xact_id/.test(normalized)) return { rows: [{ xid: '10' }] };
          return { rows: [] };
        },
        release() { rollbackEvents.push('RELEASE'); },
      };
    },
  };
  rollbackAdapter.transactionStorage = new (require('async_hooks').AsyncLocalStorage)();
  rollbackAdapter.advisoryLockTimeoutMs = 1000;
  await assert.rejects(
    rollbackAdapter.transaction(async transactionDb => {
      transactionDb.onTransactionRollback(
        async () => rollbackEvents.push('PROVIDER_ROLLBACK'),
        { afterRollback: async () => rollbackEvents.push('DURABLE_STATUS') }
      );
      throw new Error('local failure');
    }),
    /local failure/
  );
  assert(rollbackEvents.indexOf('PROVIDER_ROLLBACK') < rollbackEvents.indexOf('ROLLBACK'));
  assert(rollbackEvents.indexOf('DURABLE_STATUS') > rollbackEvents.indexOf('ROLLBACK'),
    'durable recovery finalization must not block on an unrolled-back local transaction');

  assert.strictEqual(typeof shop.collectShopCheckoutFilePaths, 'function');
  assert.strictEqual(typeof shop.lockExactRentalItems, 'function',
    'rental cleanup must expose its exact-server mutation-boundary check');
  const scopeReads = [];
  await assert.rejects(
    shop.lockExactRentalItems({
      async query(sqlText, params) {
        scopeReads.push({ sql: sqlText, params });
        return [{ id: 1 }];
      },
    }, 7, [1, 2]),
    /exact server/
  );
  assert.match(scopeReads[0].sql,
    /JOIN shop_orders so ON soi\.order_id = so\.id[\s\S]*so\.server_id = \?[\s\S]*FOR UPDATE OF soi/i,
    'cleanup item locks must bind every requested line to the supplied exact server');

  const checkoutPaths = shop.collectShopCheckoutFilePaths('/mission', [
    { spawn_method: 'cfgEffectArea' },
    { spawn_method: 'custom_json', custom_json_file: 'custom/shop.json' },
    { spawn_method: 'event', event_config: { eventGroupChildren: [{ type: 'Wolf', x: 0, z: 0, a: 0 }] } },
  ]);
  for (const expected of [
    '/mission/cfgEffectArea.json',
    '/mission/custom/shop.json',
    '/mission/cfggameplay.json',
    '/mission/cfgGameplay.json',
    '/mission/cfgeconomycore.xml',
    '/mission/custom/shop_events.xml',
    '/mission/cfgeventspawns.xml',
    '/mission/cfgeventgroups.xml',
  ]) assert(checkoutPaths.includes(expected), `missing checkout snapshot path ${expected}`);

  const files = new Map([['/mission/a.xml', '<old/>']]);
  const provider = {
    async downloadFileFromServer(_serverId, filePath) { return files.get(filePath) ?? null; },
    async uploadFileToServer(_serverId, dir, name, content) { files.set(`${dir}/${name}`, content); },
    async deleteFileFromServer(_serverId, filePath) { files.delete(filePath); },
  };
  const prepared = new Map([['/mission/a.xml', '<old/>']]);
  const journal = shop.createFileMutationJournal('provider-1', 'token', provider, prepared);
  await assert.rejects(
    journal.uploadFileToServer('provider-1', '/mission', 'unplanned.xml', '<new/>', 'token'),
    /not included in the durable provider plan/
  );
  await journal.uploadFileToServer('provider-1', '/mission', 'a.xml', '<new/>', 'token');
  await journal.rollback();
  assert.strictEqual(files.get('/mission/a.xml'), '<old/>');

  const durableWrites = [];
  const durableDb = {
    async independentTransaction(callback) { return callback(this); },
    async get(sqlText, params) {
      durableWrites.push({ sql: sqlText, params });
      if (/INSERT INTO provider_mutations/.test(sqlText)) return { id: '91' };
      if (/SELECT status FROM provider_mutations/.test(sqlText)) return { status: 'compensated' };
      throw new Error(`Unexpected durable get: ${sqlText}`);
    },
    async run(sqlText, params) {
      durableWrites.push({ sql: sqlText, params });
      return { changes: 1 };
    },
  };
  const preparedId = await recovery.prepareProviderMutation(durableDb, {
    serverId: 7,
    providerServiceId: 'provider-7',
    workflow: 'shop',
    action: 'checkout',
    contextType: 'shop_order',
    contextId: 44,
    plan: { filePaths: ['/mission/a.xml'] },
    snapshots: new Map([['/mission/a.xml', '<old/>']]),
    triggeredBy: 'user:3',
  });
  assert.strictEqual(preparedId, '91');
  assert(durableWrites.some(write => /INSERT INTO provider_mutation_files/.test(write.sql)
    && write.params.includes('<old/>')),
  'exact originals must commit with the provider plan');

  let rollbackCalled = false;
  await recovery.compensateProviderMutation(durableDb, preparedId, {
    async rollback() { rollbackCalled = true; },
  }, new Error('provider write failed'));
  assert(rollbackCalled);
  assert(durableWrites.some(write => /UPDATE provider_mutations/.test(write.sql)
    && write.params.includes('compensated')),
  'verified compensation must become durable before surfacing failure');

  assert.strictEqual(typeof recovery.reconcileProviderMutation, 'function');
  const recoveryFiles = new Map([
    ['/mission/a.xml', '<changed-a/>'],
    ['/mission/b.xml', '<changed-b/>'],
  ]);
  const recoveryEvents = [];
  const reconciliationDb = {
    async transaction(callback) { return callback(this); },
    async get(sqlText) {
      if (/FROM provider_mutations[\s\S]*FOR UPDATE/.test(sqlText)) {
        return {
          id: '92', server_id: 7, provider_service_id: 'provider-7',
          status: 'recovery_pending',
          plan_json: { filePaths: ['/mission/a.xml', '/mission/b.xml'] },
        };
      }
      throw new Error(`Unexpected reconciliation get: ${sqlText}`);
    },
    async query(sqlText) {
      if (/FROM provider_mutation_files/.test(sqlText)) {
        return [
          { file_path: '/mission/a.xml', original_exists: true, original_content: '<old-a/>' },
          { file_path: '/mission/b.xml', original_exists: false, original_content: null },
        ];
      }
      throw new Error(`Unexpected reconciliation query: ${sqlText}`);
    },
    async run(sqlText, params) {
      recoveryEvents.push({ type: 'status', sql: sqlText, params });
      return { changes: 1 };
    },
  };
  const reconciliationDetails = {
    serverId: 7,
    operationId: 92,
    reconciledBy: 'user:3',
    acquireLock: async () => recoveryEvents.push({ type: 'lock' }),
    resolveProviderContext: async () => ({ platformServerId: 'provider-7', token: 'token' }),
    fileService: {
      async downloadFileFromServer(_providerId, filePath) {
        return recoveryFiles.has(filePath) ? recoveryFiles.get(filePath) : null;
      },
      async uploadFileToServer(_providerId, dir, name, content) {
        const filePath = `${dir}/${name}`;
        recoveryEvents.push({ type: 'upload', filePath });
        recoveryFiles.set(filePath, content);
      },
      async deleteFileFromServer(_providerId, filePath) {
        recoveryEvents.push({ type: 'delete', filePath });
        recoveryFiles.delete(filePath);
      },
    },
  };
  let observedRecoveryHashes;
  await assert.rejects(
    recovery.reconcileProviderMutation(reconciliationDb, reconciliationDetails),
    error => {
      observedRecoveryHashes = error.currentHashes;
      return error.code === 'PROVIDER_RECOVERY_CONFLICT' && error.status === 409;
    },
    'reconciliation must not blindly overwrite provider state that differs from the durable original'
  );
  assert.strictEqual(recoveryEvents.some(event => event.type === 'upload' || event.type === 'delete'), false);
  const reconciliation = await recovery.reconcileProviderMutation(reconciliationDb, {
    ...reconciliationDetails,
    expectedCurrentHashes: observedRecoveryHashes,
  });
  assert.deepStrictEqual(reconciliation, { operationId: '92', status: 'compensated' });
  assert.strictEqual(recoveryFiles.get('/mission/a.xml'), '<old-a/>');
  assert.strictEqual(recoveryFiles.has('/mission/b.xml'), false);
  assert.deepStrictEqual(
    recoveryEvents.filter(event => event.type === 'upload' || event.type === 'delete')
      .map(event => event.filePath),
    ['/mission/b.xml', '/mission/a.xml'],
    'authorized reconciliation must restore and verify in reverse plan order'
  );
  const reconciliationStatus = recoveryEvents.find(event => event.type === 'status');
  assert(reconciliationStatus.params.includes('user:3'));

  recoveryFiles.set('/mission/a.xml', '<changed-a/>');
  recoveryFiles.set('/mission/b.xml', '<changed-b/>');
  const aggregateDriftDetails = {
    ...reconciliationDetails,
    fileService: {
      ...reconciliationDetails.fileService,
      async uploadFileToServer(_providerId, dir, name, content) {
        const filePath = `${dir}/${name}`;
        recoveryFiles.set(filePath, content);
        if (filePath === '/mission/a.xml') {
          recoveryFiles.set('/mission/b.xml', '<out-of-band/>');
        }
      },
    },
    expectedCurrentHashes: {
      '/mission/a.xml': 'sha256:' + crypto.createHash('sha256').update('<changed-a/>').digest('hex'),
      '/mission/b.xml': 'sha256:' + crypto.createHash('sha256').update('<changed-b/>').digest('hex'),
    },
  };
  await assert.rejects(
    recovery.reconcileProviderMutation(reconciliationDb, aggregateDriftDetails),
    /final provider recovery verification failed/i,
    'reconciliation must not become terminal if an already-restored path drifts before finalization'
  );

  const failedReconciliationWrites = [];
  const failedReconciliationDb = {
    async transaction(callback) {
      return callback({
        async get(sql) {
          if (/FROM provider_mutations/.test(sql)) {
            return { id: 94, server_id: 7, provider_service_id: 'provider-7', status: 'prepared',
              plan_json: { filePaths: ['/mission/a.xml'] } };
          }
          throw new Error(`Unexpected failed reconciliation get: ${sql}`);
        },
        async query() {
          return [{ file_path: '/mission/a.xml', original_exists: true, original_content: '<old/>' }];
        },
        async run() { throw new Error('status update must not be reached'); },
      });
    },
    async independentTransaction(callback) {
      return callback({
        async run(sql, params) {
          failedReconciliationWrites.push({ sql, params });
          return { changes: 1 };
        },
      });
    },
  };
  await assert.rejects(
    recovery.reconcileProviderMutation(failedReconciliationDb, {
      serverId: 7,
      operationId: 94,
      reconciledBy: 'user:3',
      acquireLock: async () => {},
      resolveProviderContext: async () => ({ platformServerId: 'provider-7', token: 'token' }),
      fileService: {
        async downloadFileFromServer() { return '<changed/>'; },
        async uploadFileToServer() {},
      },
      expectedCurrentHashes: {
        '/mission/a.xml': 'sha256:' + crypto.createHash('sha256').update('<changed/>').digest('hex'),
      },
    }),
    /verification failed/i
  );
  assert(failedReconciliationWrites.some(write =>
    write.params[0] === 'recovery_pending' && /verification failed/i.test(write.params[1])),
  'failed restoration must independently persist recovery_pending after transaction rollback');

  let recoveryDirectoryExists = true;
  const directoryEvents = [];
  const directoryDb = {
    async transaction(callback) { return callback(this); },
    async get(sql) {
      if (/FROM provider_mutations/.test(sql)) {
        return { id: 93, server_id: 7, provider_service_id: 'platform-7',
          status: 'recovery_pending', plan_json: { filePaths: ['/mission/custom/'] } };
      }
      throw new Error(`Unexpected directory recovery get: ${sql}`);
    },
    async query() {
      return [{ file_path: '/mission/custom/', original_exists: false, original_content: null }];
    },
    async run(sql, params) {
      directoryEvents.push({ sql, params });
      return { changes: 1 };
    },
  };
  await recovery.reconcileProviderMutation(directoryDb, {
    serverId: 7,
    operationId: 93,
    reconciledBy: 'user:3',
    acquireLock: async () => {},
    resolveProviderContext: async () => ({ platformServerId: 'platform-7', token: 'secret' }),
    fileService: {},
    expectedCurrentHashes: { '/mission/custom/': 'directory:exists' },
    directoryService: {
      async folderExists() { return recoveryDirectoryExists; },
      async deleteFolderFromServer(_server, directoryPath) {
        directoryEvents.push({ type: 'delete-directory', directoryPath });
        recoveryDirectoryExists = false;
      },
    },
  });
  assert(directoryEvents.some(event => event.type === 'delete-directory'
    && event.directoryPath === '/mission/custom/'));
  assert.strictEqual(recoveryDirectoryExists, false);

  const rotationRouteSource = fs.readFileSync(path.join(__dirname, '..', 'routes/rotation.js'), 'utf8');
  const rotationRouter = require('../routes/rotation');
  assert.strictEqual(typeof rotationRouter._test?.resolveProviderRecoveryContext, 'function',
    'provider recovery must expose its operation-time authorization helper for regression testing');
  const authorityEvents = [];
  const tokenHash = encryptToken('test-token');
  const authorizedContext = await rotationRouter._test.resolveProviderRecoveryContext({
    async get(sql, params) {
      authorityEvents.push({ sql, params });
      if (/FROM servers s/.test(sql)) {
        return { guild_id: 4, platform_server_id: 'provider-7', token_hash: tokenHash };
      }
      if (/FROM guild_roles/.test(sql)) return { role: 'owner' };
      throw new Error('Unexpected provider recovery authorization query');
    },
  }, 7, 3);
  assert.deepStrictEqual(authorizedContext, { platformServerId: 'provider-7', token: 'test-token' });
  assert.deepStrictEqual(authorityEvents.map(event => event.params), [[7], [4, 3]]);
  assert.match(authorityEvents[1].sql, /FOR UPDATE/,
    'provider recovery must lock and revalidate the revocable owner role');
  await assert.rejects(
    rotationRouter._test.resolveProviderRecoveryContext({
      async get(sql) {
        if (/FROM servers s/.test(sql)) {
          return { guild_id: 4, platform_server_id: 'provider-7', token_hash: tokenHash };
        }
        return null;
      },
    }, 7, 3),
    /owner authority was revoked/i
  );
  assert.match(rotationRouteSource,
    /router\.post\('\/recovery\/:serverId\/:operationId\/restore', requireAuth, ensureServerOwner/,
    'provider reconciliation must require exact-server owner authorization');
  assert.match(rotationRouteSource,
    /reconcileProviderMutation\([\s\S]*allowedOperationId: operationId/,
    'the authorized recovery route must restore only the selected exact-server operation');
  const rotationUiSource = fs.readFileSync(path.join(__dirname, '..', 'public/js/rotation.js'), 'utf8');
  assert.match(rotationUiSource,
    /data-provider-recovery-id[\s\S]*\/recovery\/\$\{serverId\}\/\$\{operationId\}\/restore/,
    'authorized operators need a visible action for durable provider reconciliation');

  const cleanupPaths = shop.collectShopCleanupFilePaths('/mission', {
    effectAreaIds: new Set(['a']),
    customJsonFiles: { '/mission/custom/rental.json': new Set(['b']) },
    eventEntryIds: ['{}'],
    eventsToCheck: new Set(['Rental']),
    eventGroupsByEvent: new Map([['Rental', 'Rental_Group']]),
  });
  for (const expected of [
    '/mission/cfgEffectArea.json',
    '/mission/custom/rental.json',
    '/mission/cfgeventspawns.xml',
    '/mission/custom/shop_events.xml',
    '/mission/cfgeventgroups.xml',
  ]) assert(cleanupPaths.includes(expected), `missing cleanup snapshot path ${expected}`);

  const shopSource = fs.readFileSync(path.join(__dirname, '..', 'services/shopFileService.js'), 'utf8');
  assert.match(shopSource,
    /async function getTokenForServer[\s\S]*s\.status = 'active'[\s\S]*g\.status = 'approved'[\s\S]*FOR NO KEY UPDATE OF s, g, gt/,
    'shop provider writes must lock active server, approved guild, and credential authority');
  assert(shopSource.indexOf('prepareShopProviderMutation(db, {') <
    shopSource.indexOf('await appendEffectAreaEntries('),
  'shop checkout must commit its durable plan before the first provider write');
  assert.match(shopSource, /action: 'cleanup'[\s\S]+registerProviderMutationRollback/,
    'shop cleanup must use the same durable recovery lifecycle');
  assert.match(shopSource, /updatePreparedProviderMutation\(db, providerMutationId, 'completed'/,
    'shop provider success must share the local transaction commit');

  const ownerSource = fs.readFileSync(path.join(__dirname, '..', 'routes/ownerDashboard.js'), 'utf8');
  const { mutateProviderList } = require('../services/providerListMutationService');
  const listMutationEvents = [];
  let providerListContent = 'Alpha\n';
  const listTransactionDb = {
    async acquireTransactionAdvisoryLock() { listMutationEvents.push('lock'); },
    async get(sql) {
      if (/FROM provider_mutations/.test(sql)) return null;
      throw new Error(`Unexpected list transaction get: ${sql}`);
    },
    async run(sql, params) {
      listMutationEvents.push(/UPDATE provider_mutations/.test(sql) ? 'complete' : 'run');
      return { changes: 1, params };
    },
    onTransactionRollback() {},
  };
  const listDb = {
    async transaction(callback) { return callback(listTransactionDb); },
    async independentTransaction(callback) {
      return callback({
        async get(sql) {
          if (/INSERT INTO provider_mutations/.test(sql)) {
            listMutationEvents.push('prepare');
            return { id: 501 };
          }
          throw new Error(`Unexpected list preparation get: ${sql}`);
        },
        async run() { return { changes: 1 }; },
      });
    },
  };
  const listResult = await mutateProviderList({
    db: listDb,
    internalServerId: 7,
    platformServerId: 'provider-7',
    token: 'token',
    dir: '/mission/',
    filename: 'ban.txt',
    listType: 'blacklist',
    action: 'add',
    triggeredBy: 'user:3',
    mutate: lines => ({ lines: [...lines, 'Bravo'], result: 'added' }),
    fileService: {
      async downloadFileFromServer() { listMutationEvents.push('download'); return providerListContent; },
      async uploadFileToServer(_server, _dir, _name, content) {
        listMutationEvents.push('upload');
        providerListContent = content;
      },
      async deleteFileFromServer() { providerListContent = null; },
    },
  });
  assert.deepStrictEqual(listResult, { changed: true, result: 'added' });
  assert.strictEqual(providerListContent, 'Alpha\nBravo\n');
  assert(listMutationEvents.indexOf('lock') < listMutationEvents.indexOf('download'));
  assert(listMutationEvents.indexOf('prepare') < listMutationEvents.indexOf('upload'));
  assert(listMutationEvents.indexOf('upload') < listMutationEvents.indexOf('complete'));
  const { assertProviderListVerified } = require('../utils/providerListVerification');
  assert.doesNotThrow(() => assertProviderListVerified(['Alpha', 'Bravo'], ['Alpha', 'Bravo']));
  assert.throws(
    () => assertProviderListVerified(['Alpha', 'Bravo'], ['Bravo', 'Alpha']),
    /verification failed/i,
    'provider list verification must preserve exact entry order and multiplicity'
  );
  assert.match(ownerSource,
    /async function writeNitradoList[\s\S]*await readNitradoList\([\s\S]*assertProviderListVerified/,
    'owner list uploads must be read back and compared before reporting success');
  const ownerDurableMutationCalls = ownerSource.match(/await mutateProviderList\(\{/g) || [];
  assert.strictEqual(ownerDurableMutationCalls.length, 3,
    'owner add, remove, and clear list mutations must use the durable provider lifecycle');
  const ownerMutationAuthorityCalls = ownerSource.match(/beforeMutation:\s*transactionDb\s*=>\s*assertProviderListMutationAuthority/g) || [];
  assert.strictEqual(ownerMutationAuthorityCalls.length, 3,
    'every owner list mutation must revalidate exact-server authority after acquiring the provider fence');
  assert.match(ownerSource,
    /async function assertProviderListMutationAuthority[\s\S]*FOR NO KEY UPDATE OF s, g[\s\S]*FROM guild_roles[\s\S]*FOR UPDATE/,
    'list mutation authority must lock active server scope and revocable role evidence');
  assert.match(ownerSource,
    /async function assertProviderListMutationAuthority[\s\S]*JOIN guild_tokens gt[\s\S]*FOR NO KEY UPDATE OF s, g, gt[\s\S]*decryptToken\(scope\.token_hash\) !== expectedToken[\s\S]*resolveListFile\(expectedToken, expectedPlatformServerId, listType\)/,
    'owner list writes must re-lock and compare the credential and provider-derived path under the provider fence');
  assert.doesNotMatch(ownerSource, /OWNER_LIST_LOCK_NAMESPACE/,
    'owner list mutations must not retain a disjoint advisory-lock namespace');
  assert.match(ownerSource, /PROVIDER_RECOVERY_PENDING[\s\S]*status\(409\)/,
    'owner list routes must expose unresolved provider recovery as a conflict');

  const botNitradoSource = fs.readFileSync(path.join(__dirname, '..', 'bot/utils/nitrado.js'), 'utf8');
  assert.match(botNitradoSource,
    /async function assertBotProviderMutationContext[\s\S]*JOIN guild_tokens gt[\s\S]*FOR NO KEY UPDATE OF s, g, gt[\s\S]*decryptToken\(authorized\.token_hash\) !== token/,
    'bot list writes must lock and revalidate the exact credential used for the provider mutation');
  assert.match(botNitradoSource,
    /async function writeNitradoList[\s\S]*await readNitradoList\([\s\S]*assertProviderListVerified/,
    'bot list uploads must be read back and compared before reporting success');
  assert.match(botNitradoSource,
    /const \{ mutateProviderList \} = require\('\.\.\/\.\.\/services\/providerListMutationService'\)/,
    'bot-side provider mutations must use the shared durable lock and unresolved-operation ledger');
  assert.doesNotMatch(botNitradoSource, /async function withProviderMutationLock/,
    'the obsolete lock-only provider mutation path must not remain available');
  assert.match(botNitradoSource,
    /async function assertBotProviderMutationContext[\s\S]*s\.status = 'active'[\s\S]*g\.status = 'approved'[\s\S]*s\.platform_server_id = \?[\s\S]*FOR NO KEY UPDATE OF s, g/,
    'bot list writes must revalidate exact active guild and provider identity under row locks');
  assert.match(botNitradoSource,
    /async function mutateNitradoList[\s\S]*mutateProviderList\(\{[\s\S]*triggeredBy,[\s\S]*beforeMutation:[\s\S]*assertBotProviderMutationContext/,
    'bot list writes must use durable provider plans, exact snapshots, and operation-time context validation');
  assert.match(botNitradoSource,
    /beforeMutation:[\s\S]*assertBotProviderMutationContext[\s\S]*await authorizeActor\(\)/,
    'bot list writes must revalidate the initiating Discord actor after acquiring the provider fence');
  for (const commandFile of ['ban.js', 'priority.js', 'whitelist.js']) {
    const commandSource = fs.readFileSync(path.join(__dirname, '..', 'bot/commands', commandFile), 'utf8');
    assert.match(commandSource, /mutateNitradoList\(\{/,
      `${commandFile} must use the durable provider list mutation lifecycle`);
    assert.match(commandSource,
      /authorizeActor:\s*async \(\) =>[\s\S]*members\.fetch\(\{ user: interaction\.user\.id, force: true \}\)[\s\S]*PermissionFlagsBits\.Administrator/,
      `${commandFile} must re-fetch current Discord administrator authority at mutation time`);
    assert.doesNotMatch(commandSource, /withProviderMutationLock\(creds\.serverId/,
      `${commandFile} must not bypass durable preparation with the legacy lock-only helper`);
  }

  assert.match(rotationRouteSource,
    /resolveProviderRecoveryContext[\s\S]*FOR NO KEY UPDATE OF s, g, gt/,
    'provider recovery must stabilize server, guild approval, and credential evidence under row locks');

  const missionRouteSource = fs.readFileSync(path.join(__dirname, '..', 'routes/missionFiles.js'), 'utf8');
  const authorizationSource = fs.readFileSync(
    path.join(__dirname, '..', 'services/authorizationService.js'), 'utf8'
  );
  assert.match(missionRouteSource,
    /resolveProviderContext[\s\S]*authorizePlatformServerMutation/,
    'mission editor writes must stabilize actor authority inside the provider transaction');
  assert.match(missionRouteSource,
    /async function getGuildTokenForServer[\s\S]*FOR NO KEY UPDATE OF s, g, gt/,
    'mission editor writes must stabilize active server, approved guild, and credential evidence');
  assert.match(authorizationSource,
    /stabilizeServerMutationAuthority[\s\S]*FOR NO KEY UPDATE OF s, g[\s\S]*FROM guild_roles[\s\S]*FOR NO KEY UPDATE[\s\S]*FROM server_role_assignments[\s\S]*FOR NO KEY UPDATE[\s\S]*authorizeServer\(/,
    'provider mutation authorization must lock and then re-read exact role evidence');
  const economyProviderSource = fs.readFileSync(
    path.join(__dirname, '..', 'services/economyOverrideService.js'), 'utf8'
  );
  assert.match(economyProviderSource,
    /async resolveMutationContext[\s\S]*FOR NO KEY UPDATE OF s, g, gt/,
    'economy override writes must stabilize server, guild, and credential evidence');
  assert.match(economyProviderSource,
    /executeMutation[\s\S]*authorizeServerMutation[\s\S]*CAPABILITIES\.NITRADO_MANAGE/,
    'economy override writes must reauthorize the human actor after acquiring the provider fence');
  assert.doesNotMatch(economyProviderSource,
    /typeof triggeredBy !== 'string'/,
    'an audit provenance string must not be accepted as economy override authority');

  const settingsRouteSource = fs.readFileSync(
    path.join(__dirname, '..', 'routes/nitradoSettings.js'), 'utf8'
  );
  assert.match(settingsRouteSource, /mutateProviderSettings\(\{/,
    'settings writes must use the durable provider setting lifecycle');
  assert.doesNotMatch(settingsRouteSource, /nitradoService\.updateSetting\(/,
    'settings routes must not retain direct per-setting provider writes');

  const nitradoRouteSource = fs.readFileSync(path.join(__dirname, '..', 'routes/nitrado.js'), 'utf8');
  const hostnameMutationSource = nitradoRouteSource.slice(
    nitradoRouteSource.indexOf("router.put('/account-servers/:serviceId/hostname'"),
    nitradoRouteSource.indexOf("router.get('/registered-servers'")
  );
  assert.match(hostnameMutationSource, /mutateProviderSettings\(\{/,
    'hostname writes must use the same durable provider setting lifecycle');
  assert.doesNotMatch(hostnameMutationSource, /nitradoService\.updateSetting\(/,
    'hostname writes must not bypass durable setting compensation');

  const settingMutation = require('../services/providerSettingMutationService');
  const settingState = { config: { disableCrosshair: '0' } };
  const settingCalls = [];
  const settingAdapter = settingMutation.createProviderSettingFileService({
    async getSettings() {
      settingCalls.push('read');
      return settingState;
    },
    async updateSetting(_token, _serviceId, category, key, value) {
      settingCalls.push('write');
      settingState[category][key] = value;
    },
  });
  const settingPath = settingMutation.settingResourcePath('config', 'disableCrosshair');
  const originalSetting = await settingAdapter.downloadFileFromServer('provider-7', settingPath, 'token');
  assert.strictEqual(originalSetting, JSON.stringify({ value: '0' }));
  await settingAdapter.uploadFileToServer(
    'provider-7',
    settingPath.slice(0, settingPath.lastIndexOf('/')),
    settingPath.slice(settingPath.lastIndexOf('/') + 1),
    JSON.stringify({ value: '1' }),
    'token'
  );
  assert.strictEqual(settingState.config.disableCrosshair, '1');
  assert.deepStrictEqual(settingCalls, ['read', 'write', 'read'],
    'setting writes must be followed by authoritative provider readback');
  await assert.rejects(
    settingAdapter.deleteFileFromServer('provider-7', settingPath, 'token'),
    /cannot restore an absent setting/i,
    'settings without an exact restorable preimage must fail closed');
  const settingServiceSource = fs.readFileSync(
    path.join(__dirname, '..', 'services/providerSettingMutationService.js'), 'utf8'
  );
  assert.match(settingServiceSource,
    /acquireProviderMutationLock[\s\S]*authorizeServerMutation[\s\S]*prepareProviderMutation[\s\S]*createFileMutationJournal[\s\S]*updatePreparedProviderMutation/,
    'settings must serialize, reauthorize, durably prepare, verify, and finalize under one lifecycle');
  assert.match(settingServiceSource,
    /plan:\s*\{\s*filePaths:\s*changedEntries\.map/,
    'setting recovery plans must contain only changed resources with exact snapshots');
  assert.match(settingServiceSource, /for \(const entry of changedEntries\)/,
    'setting writes must be limited to the snapshotted changed-resource plan');
  assert.match(settingServiceSource, /updated:\s*changedEntries\.length/,
    'setting mutation results must report the applied changed-resource count');
  assert.match(settingServiceSource,
    /changedEntries\.length > 5[\s\S]*PROVIDER_SETTING_BATCH_TOO_LARGE/,
    'setting mutations must enforce a compensation-time-bounded changed-object cap');
  assert.match(rotationRouteSource,
    /fileServiceResolver:[\s\S]*provider_settings[\s\S]*createProviderSettingFileService/,
    'generic provider recovery must select the setting adapter for durable setting operations');
  assert.match(rotationRouteSource,
    /fileServiceResolver:[\s\S]*mission_init[\s\S]*createMissionInitFileService/,
    'generic provider recovery must select the hardened mission init transfer adapter');

  const tasksRouteSource = fs.readFileSync(path.join(__dirname, '..', 'routes/tasks.js'), 'utf8');
  const taskMutationSource = tasksRouteSource.slice(tasksRouteSource.indexOf("router.post('/:serverId'"));
  assert.match(taskMutationSource, /PROVIDER_MUTATION_DISABLED/,
    'task writes must fail closed until Nitrado exposes stable compensatable task identity');
  assert.doesNotMatch(taskMutationSource,
    /nitradoService\.(?:createTask|updateTask|deleteTask)\(/,
    'task routes must not retain unsafe direct provider mutations');

  for (const [relativePath, label] of [
    ['routes/ownerDashboard.js', 'owner dashboard'],
    ['routes/admin.js', 'admin API'],
    ['scripts/tui-admin.js', 'admin TUI'],
  ]) {
    const deletionSource = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
    assert.doesNotMatch(deletionSource, /DELETE FROM servers\b/,
      `${label} must retain server tombstones required by durable provider recovery history`);
    assert.match(deletionSource, /UPDATE servers(?:\s+s)?[\s\S]*SET status = 'inactive'/,
      `${label} server removal must use the explicit inactive lifecycle`);
  }

  const adminLifecycleSource = fs.readFileSync(path.join(__dirname, '..', 'routes/admin.js'), 'utf8');
  assert.doesNotMatch(adminLifecycleSource, /DELETE FROM guilds\b/,
    'admin guild removal must retain guild and server tombstones required by provider recovery history');
  assert.match(adminLifecycleSource,
    /UPDATE guilds[\s\S]*SET status = 'disabled'[\s\S]*UPDATE servers[\s\S]*SET status = 'inactive'/,
    'admin guild removal must use explicit disabled/inactive lifecycle states');

  const economy = require('../services/economyOverrideService');
  assert.strictEqual(typeof economy.collectOverridePaths, 'function',
    'economy override mutations must expose their complete deterministic provider plan');
  const economyPaths = economy.collectOverridePaths('/mission');
  assert.deepStrictEqual(economyPaths, [
    '/mission/custom/',
    '/mission/custom/dashboard_types.xml',
    '/mission/custom/dashboard_events.xml',
    '/mission/custom/dashboard_spawnabletypes.xml',
    '/mission/custom/dashboard_cfgrandompresets.xml',
    '/mission/custom/bot_types.xml',
    '/mission/custom/bot_events.xml',
    '/mission/custom/bot_spawnabletypes.xml',
    '/mission/custom/bot_cfgrandompresets.xml',
    '/mission/cfgeconomycore.xml',
  ]);
  const economySource = fs.readFileSync(path.join(__dirname, '..', 'services/economyOverrideService.js'), 'utf8');
  assert.match(economySource,
    /acquireProviderMutationLock[\s\S]*prepareProviderMutation[\s\S]*prepared\.snapshots/,
    'economy overrides must share the exact-server fence and durable snapshot lifecycle');
  assert(economySource.indexOf('prepareProviderMutation(db,') <
    economySource.indexOf('await this.createFolderOnServer('),
  'economy initialization must commit its plan before creating provider resources');
  assert.match(economySource,
    /updatePreparedProviderMutation\(transactionDb, operationId, 'completed'/,
    'economy override completion must commit with its transaction');

  const teleport = require('../services/teleportProcessorService');
  assert.strictEqual(typeof teleport.collectTeleportMutationPaths, 'function');
  assert.deepStrictEqual(
    teleport.collectTeleportMutationPaths('/mission', 42),
    [
      '/mission/pra/dayz-dashboard-teleport-42.json',
      '/mission/cfggameplay.json',
      '/mission/cfgGameplay.json',
    ]
  );
  const teleportSource = fs.readFileSync(
    path.join(__dirname, '..', 'services/teleportProcessorService.js'), 'utf8'
  );
  assert.match(teleportSource,
    /prepareProviderMutation[\s\S]*workflow: 'teleport'[\s\S]*prepared\.snapshots/,
    'teleport multi-file writes must use durable exact-server provider recovery');
  assert.match(teleportSource,
    /async function assertTeleportProviderContext[\s\S]*g\.status = 'approved'[\s\S]*s\.status = 'active'[\s\S]*FOR NO KEY UPDATE OF s, g, gt/,
    'teleport provider writes must lock active server, approved guild, and credential evidence');
  assert.match(teleportSource,
    /async function assertTeleportProviderContext[\s\S]*row\.platform_server_id[\s\S]*context\.platformServerId[\s\S]*decryptToken\(row\.token_hash\) !== context\.token/,
    'teleport provider writes must revalidate the exact provider identity and credential');
  const teleportProviderAssertions = teleportSource.match(
    /dependencies\.assertTeleportProviderContext \|\| assertTeleportProviderContext/g
  ) || [];
  assert.strictEqual(teleportProviderAssertions.length, 3,
    'teleport provisioning, cleanup, and restart dispatch must revalidate provider context under the fence');
  assert.match(teleportSource,
    /finalizeProviderMutation\(tx, prepared\.operationId, 'completed'/,
    'teleport provider completion must commit with its local lifecycle transition');

  console.log('provider mutation recovery tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
