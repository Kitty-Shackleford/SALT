'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function main() {
  const migration = require('../db/migrations/076_rotation_provider_recovery');
  const fileSwapMigration = require('../db/migrations/078_rotation_file_swap_absence');
  assert.match(migration.PROVIDER_RECOVERY_SQL, /provider_mutations/);
  assert.match(fileSwapMigration.ROTATION_FILE_SWAP_ABSENCE_SQL,
    /ADD COLUMN IF NOT EXISTS original_exists BOOLEAN/,
    'file_swap lifecycle backups must distinguish absent files from empty files');
  assert.match(fileSwapMigration.ROTATION_FILE_SWAP_ABSENCE_SQL, /ALTER COLUMN content DROP NOT NULL/,
    'an absent original file must be representable without fabricated content');
  const rotationSource = fs.readFileSync(path.join(__dirname, '..', 'services/rotationService.js'), 'utf8');
  assert.match(rotationSource,
    /INSERT INTO rotation_file_backups[\s\S]*ON CONFLICT \(snippet_id, server_id\) DO UPDATE[\s\S]*backed_up_at = CURRENT_TIMESTAMP/,
    'each file_swap activation must refresh its backup from the immediately preceding provider state');
  assert.match(rotationSource,
    /async function deactivateFileSwap[\s\S]*DELETE FROM rotation_file_backups WHERE snippet_id = \? AND server_id = \?/,
    'verified file_swap deactivation must consume its lifecycle backup');
  assert.match(migration.PROVIDER_RECOVERY_SQL, /provider_mutation_files/);
  assert.match(migration.PROVIDER_RECOVERY_SQL, /plan_json JSONB NOT NULL/,
    'the intended provider mutation plan must be durable before writes');
  assert.match(migration.PROVIDER_RECOVERY_SQL,
    /\(original_exists AND original_content IS NOT NULL\)[\s\S]+\(NOT original_exists AND original_content IS NULL\)/,
    'the schema must preserve exact content for every provider file that originally existed');
  for (const status of ['recovery_pending', 'compensated', 'completed']) {
    assert(migration.PROVIDER_RECOVERY_SQL.includes(`'${status}'`),
      `rotation provider operations need durable ${status} state`);
  }
  assert.match(
    fs.readFileSync(path.join(__dirname, '..', 'services/rotationService.js'), 'utf8'),
    /finished_at = CASE WHEN \? = 'recovery_pending' THEN NULL ELSE NOW\(\) END/,
    'rotation recovery_pending operations must remain unfinished under the schema constraint'
  );

  const rotation = require('../services/rotationService');
  assert.strictEqual(typeof rotation._test?.persistPreparedMutation, 'function');
  assert.strictEqual(typeof rotation._test?.executeRecoverableMutation, 'function');
  assert.strictEqual(typeof rotation._test?.collectPresetFilePaths, 'function');
  assert.strictEqual(typeof rotation._test?.resolvePreparedFileSwapSnippets, 'function');
  assert.strictEqual(typeof rotation._test?.assertPresetLifecycleState, 'function');
  assert.throws(
    () => rotation._test.assertPresetLifecycleState({ active: true }, 'activate'),
    error => error.code === 'ROTATION_PRESET_ALREADY_ACTIVE' && error.status === 409,
    'repeated activation must fail before refreshing file_swap lifecycle backups'
  );
  assert.throws(
    () => rotation._test.assertPresetLifecycleState({ active: false }, 'deactivate'),
    error => error.code === 'ROTATION_PRESET_ALREADY_INACTIVE' && error.status === 409,
    'repeated deactivation must fail before preparing provider writes'
  );
  const shop = require('../services/shopFileService');
  assert.strictEqual(typeof shop.acquireProviderMutationLock, 'function');
  const providerLockCalls = [];
  await assert.rejects(
    shop.acquireProviderMutationLock({
      acquireTransactionAdvisoryLock: async (...args) => providerLockCalls.push(args),
      get: async () => ({ id: '71', status: 'recovery_pending' }),
    }, 7),
    error => error.code === 'PROVIDER_RECOVERY_PENDING' && error.status === 409,
    'all shared provider writers must be fenced by unresolved recovery state'
  );
  assert.deepStrictEqual(providerLockCalls, [[0x53484f50, 7]]);
  const allowedLockQueries = [];
  await shop.acquireProviderMutationLock({
    acquireTransactionAdvisoryLock: async () => {},
    get: async (sql, params) => {
      allowedLockQueries.push({ sql, params });
      return null;
    },
  }, 7, { allowedRotationOperationId: '72' });
  assert.deepStrictEqual(allowedLockQueries[0].params, [7, 72]);
  await assert.rejects(
    shop.acquireProviderMutationLock({
      acquireTransactionAdvisoryLock: async () => {},
      get: async () => ({ id: '73', status: 'prepared' }),
    }, 7, { allowedOperationId: '72' }),
    error => error.code === 'PROVIDER_RECOVERY_PENDING' && /73/.test(error.message),
    'reconciliation must remain fenced when another unresolved operation exists'
  );

  assert.deepStrictEqual(
    rotation._test.collectPresetFilePaths('/mission', [{
      id: 9,
      pattern: 'file_swap',
      target_path: '/mission/edited.xml',
      backup_file_path: '/mission/original.xml',
    }], 'deactivate'),
    ['/mission/original.xml'],
    'deactivation must snapshot the exact backup path it will overwrite'
  );
  await assert.rejects(
    rotation._test.resolvePreparedFileSwapSnippets({
      get: async () => null,
    }, [{ id: 9, pattern: 'file_swap', target_path: '/mission/edited.xml' }], 7, 'deactivate'),
    /No backup found/,
    'missing file_swap backups must fail preparation before a preset can be marked inactive'
  );
  const absentBackup = await rotation._test.resolvePreparedFileSwapSnippets({
    get: async () => ({
      file_path: '/mission/edited.xml',
      content: null,
      original_exists: false,
    }),
  }, [{ id: 9, pattern: 'file_swap', target_path: '/mission/edited.xml' }], 7, 'deactivate');
  assert.strictEqual(absentBackup[0].backup_original_exists, false,
    'deactivation must retain the durable fact that the original target was absent');

  const writes = [];
  const db = {
    async get(sql, params) {
      writes.push({ sql, params });
      if (/INSERT INTO provider_mutations/.test(sql)) return { id: '41' };
      throw new Error('Unexpected get: ' + sql);
    },
    async run(sql, params) {
      writes.push({ sql, params });
      return { changes: 1 };
    },
  };
  const operationId = await rotation._test.persistPreparedMutation(db, {
    serverId: 7,
    providerServiceId: 'provider-7',
    presetId: 11,
    action: 'activate',
    triggeredBy: '13',
    plan: { action: 'activate', snippets: [{ id: 11 }] },
    snapshots: new Map([
      ['/mission/a.xml', '<a>original</a>'],
      ['/mission/new.json', null],
    ]),
  });
  assert.strictEqual(operationId, '41');
  const operationWrite = writes.find(write => /INSERT INTO provider_mutations/.test(write.sql));
  assert.deepStrictEqual(JSON.parse(operationWrite.params[5]).filePaths, [
    '/mission/a.xml',
    '/mission/new.json',
  ], 'rotation recovery plans must durably enumerate every snapshotted provider path');
  const snapshotWrites = writes.filter(write => /INSERT INTO provider_mutation_files/.test(write.sql));
  assert.strictEqual(snapshotWrites.length, 2);
  assert(snapshotWrites.some(write => write.params.includes('/mission/a.xml')
    && write.params.includes('<a>original</a>') && write.params.includes(true)));
  assert(snapshotWrites.some(write => write.params.includes('/mission/new.json')
    && write.params.includes(null) && write.params.includes(false)));

  const compensatedWrites = [];
  await assert.rejects(
    rotation._test.executeRecoverableMutation({
      db: { run: async (sql, params) => { compensatedWrites.push({ sql, params }); return { changes: 1 }; } },
      operationId: '51',
      journal: { rollback: async () => {} },
      mutate: async () => { throw new Error('second upload failed'); },
    }),
    /second upload failed/,
    'a compensated provider failure must abort the outer transaction so local backup changes roll back'
  );
  assert.strictEqual(compensatedWrites.length, 0,
    'terminal compensation status must be recorded independently after the outer rollback');

  const recoveryWrites = [];
  await assert.rejects(
    rotation._test.executeRecoverableMutation({
      db: { run: async (sql, params) => { recoveryWrites.push({ sql, params }); return { changes: 1 }; } },
      operationId: '61',
      journal: { rollback: async () => { throw new Error('restore verification failed'); } },
      mutate: async () => { throw new Error('third upload failed'); },
    }),
    /third upload failed/,
    'a provider failure must propagate so the transaction rollback hook can compensate exactly once'
  );
  assert.strictEqual(recoveryWrites.length, 0,
    'recovery-pending status must be recorded independently after the outer rollback');

  const source = fs.readFileSync(path.join(__dirname, '..', 'services/rotationService.js'), 'utf8');
  assert.match(source,
    /runPreparedRotationMutation[\s\S]+acquireProviderMutationLock\(transactionDb, serverId\)[\s\S]+prepared = await prepare\(transactionDb\)/,
    'rotation must hold the shared provider fence while it snapshots and durably prepares the mutation');
  assert.match(source, /persistPreparedMutation[\s\S]+runPreparedRotationMutation/,
    'snapshots must be durable before provider writes execute');
  assert.match(source, /prepareCeSetupMutation[\s\S]+runPreparedRotationMutation/,
    'CE setup must participate in durable provider recovery');
  const missionEditorSource = fs.readFileSync(
    path.join(__dirname, '..', 'services/missionEditorSaveService.js'), 'utf8'
  );
  const shopSource = fs.readFileSync(path.join(__dirname, '..', 'services/shopFileService.js'), 'utf8');
  assert.match(missionEditorSource, /acquireProviderMutationLock\(transactionDb, internalServerId\)/,
    'Mission Editor must honor unresolved provider recovery before writing');
  assert.match(shopSource, /fileItems\.length > 0[\s\S]+assertNoUnresolvedProviderMutation/,
    'shop checkout provider writes must honor unresolved recovery');
  assert.match(shopSource, /removeExpiredRentals[\s\S]+assertNoUnresolvedProviderMutation/,
    'shop cleanup provider writes must honor unresolved recovery');
  assert.match(source, /createFileMutationJournal\([\s\S]*rawRotationFileService,\s*prepared\.snapshots\s*\)/,
    'rotation journals must enforce the committed durable paths and exact originals');
  const deactivationStart = source.indexOf('async function deactivatePresetLocked');
  const deactivationEnd = source.indexOf('async function runCeSetupLocked');
  const deactivation = source.slice(deactivationStart, deactivationEnd);
  assert(deactivation.indexOf('if (!success) throw new Error')
    < deactivation.indexOf('SET active = FALSE'),
  'deactivation must fail before marking a partially reverted preset inactive');
  const routeSource = fs.readFileSync(path.join(__dirname, '..', 'routes/rotation.js'), 'utf8');
  const schedulerSource = fs.readFileSync(path.join(__dirname, '..', 'scheduler.js'), 'utf8');
  const browserSource = fs.readFileSync(path.join(__dirname, '..', 'public/js/rotation.js'), 'utf8');
  assert.match(routeSource, /rs\.server_id = rp\.server_id/,
    'preset snippet attachment and execution must bind snippets to the exact server');
  assert.match(routeSource,
    /async function assertRotationMutationAuthority[\s\S]*FOR NO KEY UPDATE OF s, g[\s\S]*FROM guild_roles[\s\S]*FOR UPDATE/,
    'manual rotation writes must lock and revalidate exact-server owner authority');
  assert.match(source,
    /runPreparedRotationMutation[\s\S]*acquireProviderMutationLock\(transactionDb, serverId\)[\s\S]*if \(authorize\) await authorize\(transactionDb\)[\s\S]*prepared = await prepare/,
    'manual authority must be revalidated after the provider fence and before snapshots or writes');
  assert.match(routeSource,
    /async function assertRotationDefinitionMutable[\s\S]*acquireProviderMutationLock[\s\S]*assertRotationMutationAuthority[\s\S]*rotation_presets[\s\S]*active = TRUE[\s\S]*ROTATION_DEFINITION_ACTIVE/,
    'active preset definitions must lock and revalidate owner authority before rejecting deployed-state edits');
  assert.match(routeSource,
    /router\.put\('\/snippets[\s\S]*assertRotationDefinitionMutable[\s\S]*UPDATE rotation_snippets/,
    'snippet updates must fail closed while attached to an active preset');
  assert.match(routeSource,
    /router\.delete\('\/snippets[\s\S]*assertRotationDefinitionMutable[\s\S]*DELETE FROM rotation_snippets/,
    'snippet deletion must fail closed while attached to an active preset');
  assert.match(routeSource,
    /router\.put\('\/presets[\s\S]*db\.transaction[\s\S]*assertRotationDefinitionMutable[\s\S]*UPDATE rotation_presets/,
    'active preset metadata and schedules must be immutable under the provider fence');
  assert.match(routeSource,
    /router\.delete\('\/presets[\s\S]*assertRotationDefinitionMutable[\s\S]*DELETE FROM rotation_presets/,
    'active presets must be deactivated before deletion');
  assert.match(source,
    /async function getServerCredentials[\s\S]*s\.status = 'active'[\s\S]*g\.status = 'approved'[\s\S]*FOR NO KEY UPDATE OF s, g, gt/,
    'rotation credential resolution must lock active server, approved guild, and exact token authority');
  assert.match(schedulerSource,
    /FROM rotation_presets rp[\s\S]*JOIN servers s[\s\S]*s\.status = 'active'[\s\S]*JOIN guilds g[\s\S]*g\.status = 'approved'/,
    'scheduled rotations must ignore presets for inactive servers or deauthorized guilds');
  assert.match(schedulerSource,
    /activatePreset\(\s*db,\s*preset\.id,\s*preset\.server_id,\s*'scheduler',[\s\S]*assertScheduledRotationAuthority/,
    'scheduled activation must revalidate exact provider authority under the mutation fence');
  assert.match(schedulerSource,
    /deactivatePreset\(\s*db,\s*preset\.id,\s*preset\.server_id,\s*'scheduler',[\s\S]*assertScheduledRotationAuthority/,
    'scheduled deactivation must revalidate exact provider authority under the mutation fence');
  assert.match(routeSource, /\/setup\/:serverId[\s\S]+recoveryPending/,
    'CE setup must surface recovery-pending as an HTTP conflict');
  assert.match(browserSource, /runSetupBtn[\s\S]+await loadHistory\(\)/,
    'failed CE setup must immediately refresh visible recovery state');
  assert.match(routeSource, /status IN \('prepared', 'recovery_pending'\)/,
    'the operator API must expose unresolved provider recovery');
  assert.match(browserSource, /Provider recovery required/,
    'the rotation UI must visibly block operators on unresolved provider recovery');

  console.log('rotation provider recovery tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
