'use strict';

const assert = require('assert');

async function main() {
  const { saveMissionFileVerified } = require('../services/missionEditorSaveService');
  const fs = require('fs');
  const path = require('path');
  const saveSource = fs.readFileSync(
    path.join(__dirname, '..', 'services/missionEditorSaveService.js'), 'utf8'
  );
  assert.match(saveSource,
    /prepareProviderMutation[\s\S]*workflow: 'mission_editor'[\s\S]*prepared\.snapshots/,
    'Mission Editor must durably commit its exact provider snapshot before upload');
  assert.match(saveSource,
    /registerProviderMutationRollback[\s\S]*updatePreparedProviderMutation/,
    'Mission Editor must expose process-crash recovery until local completion commits');
  const missionFileService = require('../services/missionFileService');

  const ownerLock = await missionFileService.acquireLock('lock-test-server', 'types.xml', 'user:1');
  const deniedLock = await missionFileService.acquireLock('lock-test-server', 'types.xml', 'user:2');
  assert.strictEqual(ownerLock.success, true);
  assert.strictEqual(deniedLock.success, false);
  assert.strictEqual(Object.hasOwn(deniedLock, 'lockId'), false,
    'lock denial must not disclose the owner capability token');
  assert.strictEqual(Object.hasOwn(missionFileService.checkLock('lock-test-server', 'types.xml'), 'lockId'), false,
    'lock status must not disclose the owner capability token');
  assert.strictEqual(
    missionFileService.ownsLock('lock-test-server', 'types.xml', ownerLock.lockId),
    true
  );
  await missionFileService.releaseLock('lock-test-server', 'types.xml', ownerLock.lockId);

  function harness(initial = '<types old="1"/>', options = {}) {
    let providerContent = initial;
    let localContent = initial;
    const rollbackHooks = [];
    const calls = [];
    const db = {
      async transaction(callback) {
        try {
          const result = await callback(this);
          if (options.commitFailure) throw new Error('commit failed');
          return result;
        } catch (error) {
          for (const rollback of rollbackHooks.slice().reverse()) await rollback();
          throw error;
        }
      },
      async independentTransaction(callback) {
        return callback(this);
      },
      async run(sql, params) {
        calls.push(['run', sql, params]);
        if (/INSERT INTO provider_mutations/.test(sql)) return { lastID: 501, changes: 1 };
        return { changes: 1 };
      },
      async acquireTransactionAdvisoryLock(namespace, serverId) {
        calls.push(['lock', namespace, serverId]);
      },
      async get(sql, params) {
        calls.push(['get', sql, params]);
        if (/INSERT INTO provider_mutations/.test(sql)) return { id: 501 };
        if (/provider_mutations/.test(sql)) return null;
        throw new Error('Unexpected get: ' + sql);
      },
      onTransactionRollback(callback) { rollbackHooks.push(callback); },
    };
    const fileService = {
      async downloadFileFromServer() {
        calls.push(['download', providerContent]);
        if (options.readbackMismatch && calls.filter(call => call[0] === 'download').length === 3) {
          return '<corrupt/>';
        }
        return providerContent;
      },
      async uploadFileToServer(_serverId, _dir, _name, content) {
        calls.push(['upload', content]);
        providerContent = content;
      },
      async deleteFileFromServer() { providerContent = null; },
    };
    return {
      db,
      fileService,
      calls,
      get providerContent() { return providerContent; },
      get localContent() { return localContent; },
      localWriter(content) {
        calls.push(['local', content]);
        if (options.localWriteFailure) throw new Error('local write failed');
        const originalLocalContent = localContent;
        localContent = content;
        return () => {
          calls.push(['local-rollback', originalLocalContent]);
          localContent = originalLocalContent;
        };
      },
    };
  }

  const expected = '<types old="1"/>';
  const replacement = '<types new="1"/>';
  const crypto = require('crypto');
  const expectedHash = crypto.createHash('sha256').update(expected).digest('hex');
  const success = harness(expected);
  const result = await saveMissionFileVerified({
    db: success.db,
    internalServerId: 7,
    platformServerId: 'service-7',
    token: 'test-token',
    remoteDirectory: '/mission',
    remoteFileName: 'types.xml',
    expectedHash,
    content: replacement,
    fileService: success.fileService,
    triggeredBy: 'user:1',
    localWriter: content => success.localWriter(content),
  });
  assert.deepStrictEqual(result, {
    hash: crypto.createHash('sha256').update(replacement).digest('hex'),
    providerUploaded: true,
    localSaved: true,
    previousContent: expected,
  });
  assert.strictEqual(success.providerContent, replacement);
  assert.strictEqual(success.localContent, replacement);
  assert(success.calls.findIndex(call => call[0] === 'lock') < success.calls.findIndex(call => call[0] === 'download'));
  assert(success.calls.findIndex(call => call[0] === 'upload') < success.calls.findIndex(call => call[0] === 'local'));

  const stale = harness('<external edit="1"/>');
  await assert.rejects(() => saveMissionFileVerified({
    db: stale.db,
    internalServerId: 7,
    platformServerId: 'service-7',
    token: 'test-token',
    remoteDirectory: '/mission',
    remoteFileName: 'types.xml',
    expectedHash,
    content: replacement,
    fileService: stale.fileService,
    triggeredBy: 'user:1',
    localWriter: content => stale.localWriter(content),
  }), error => error.status === 409 && /changed on the provider/.test(error.message));
  assert.strictEqual(stale.providerContent, '<external edit="1"/>');
  assert.strictEqual(stale.localContent, '<external edit="1"/>');

  const mismatch = harness(expected, { readbackMismatch: true });
  await assert.rejects(() => saveMissionFileVerified({
    db: mismatch.db,
    internalServerId: 7,
    platformServerId: 'service-7',
    token: 'test-token',
    remoteDirectory: '/mission',
    remoteFileName: 'types.xml',
    expectedHash,
    content: replacement,
    fileService: mismatch.fileService,
    triggeredBy: 'user:1',
    localWriter: content => mismatch.localWriter(content),
  }), /Verification failed/);
  assert.strictEqual(mismatch.providerContent, expected, 'failed verification must restore provider snapshot');
  assert.strictEqual(mismatch.localContent, expected, 'failed verification must not change the local copy');

  const localFailure = harness(expected, { localWriteFailure: true });
  await assert.rejects(() => saveMissionFileVerified({
    db: localFailure.db,
    internalServerId: 7,
    platformServerId: 'service-7',
    token: 'test-token',
    remoteDirectory: '/mission',
    remoteFileName: 'types.xml',
    expectedHash,
    content: replacement,
    fileService: localFailure.fileService,
    triggeredBy: 'user:1',
    localWriter: content => localFailure.localWriter(content),
  }), /local write failed/);
  assert.strictEqual(localFailure.providerContent, expected, 'local failure must restore provider snapshot');

  const commitFailure = harness(expected, { commitFailure: true });
  await assert.rejects(() => saveMissionFileVerified({
    db: commitFailure.db,
    internalServerId: 7,
    platformServerId: 'service-7',
    token: 'test-token',
    remoteDirectory: '/mission',
    remoteFileName: 'types.xml',
    expectedHash,
    content: replacement,
    fileService: commitFailure.fileService,
    triggeredBy: 'user:1',
    localWriter: content => commitFailure.localWriter(content),
  }), /commit failed/);
  assert.strictEqual(commitFailure.providerContent, expected,
    'aborted commit must restore the provider snapshot');
  assert.strictEqual(commitFailure.localContent, expected,
    'aborted commit must restore the exact local mirror preimage');
  assert(commitFailure.calls.some(call => call[0] === 'local-rollback'),
    'local mirror rollback must be registered before transaction completion');

  console.log('mission editor verified provider-save tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
