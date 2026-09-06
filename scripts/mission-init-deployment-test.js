'use strict';

const assert = require('assert');
const crypto = require('crypto');
const {
  createMissionInitDeploymentService,
  loadDeploymentSnapshotFromDatabase,
} = require('../services/missionInitDeploymentService');
const { createMissionInitFileService } = require('../services/missionInitFileService');

const SOURCE = `void main()\n{\n}\n\nclass CustomMission: MissionServer\n{\n    override void StartingEquipSetup(PlayerBase player, bool clothesChosen)\n    {\n        EntityAI itemEnt;\n        itemEnt = player.GetInventory().CreateInInventory("BandageDressing");\n    }\n};\n\nMission CreateCustomMission(string path)\n{\n    return new CustomMission();\n}\n`;
const FILE_PATH = '/ftproot/dayz/mpmissions/dayzOffline.chernarusplus/init.c';

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function configuration() {
  return {
    version: 1,
    mapName: 'chernarusplus',
    unknownPlayerPolicy: 'vanilla',
    inventoryPolicy: 'replace',
    teams: [{
      id: 'alpha',
      members: [{ identityKind: 'dayz_protected', identityId: 'Protected_AAAAAAAA' }],
      spawn: { east: 5000, elevation: 100, north: 6000 },
      loadout: [{ className: 'BandageDressing', quantity: 1 }],
    }],
  };
}

function createDb() {
  return {
    async transaction(callback) {
      const rollbackHooks = [];
      const transactionDb = {
        onTransactionRollback(callback) {
          rollbackHooks.push(callback);
        },
      };
      try {
        return await callback(transactionDb);
      } catch (error) {
        for (const rollback of rollbackHooks.slice().reverse()) await rollback();
        throw error;
      }
    },
  };
}

function createHarness({ failUpdate = false } = {}) {
  const events = [];
  const files = new Map([[FILE_PATH, SOURCE]]);
  const fileService = {
    async downloadFileFromServer(serverId, filePath, token) {
      events.push(`download:${serverId}:${filePath}:${token === 'secret'}`);
      return files.get(filePath) ?? null;
    },
    async uploadFileToServer(serverId, directory, fileName, content, token) {
      events.push(`upload:${serverId}:${directory}/${fileName}:${token === 'secret'}`);
      files.set(`${directory}/${fileName}`, content);
    },
    async deleteFileFromServer() {
      throw new Error('unexpected delete');
    },
  };
  const service = createMissionInitDeploymentService({
    fileService,
    acquireLock: async () => events.push('lock'),
    prepareMutation: async (_db, details) => {
      events.push(`prepare:${details.workflow}:${details.providerServiceId}:${details.action}`);
      assert.deepStrictEqual(details.plan.filePaths, [FILE_PATH]);
      return 42;
    },
    loadDeploymentSnapshot: async (_db, operationId, serverId) => {
      events.push(`load:${operationId}:${serverId}`);
      return {
        id: operationId,
        providerServiceId: '90000002',
        filePath: FILE_PATH,
        originalContent: SOURCE,
        expectedCandidateHash: files.has(FILE_PATH) ? hash(files.get(FILE_PATH)) : null,
      };
    },
    registerRollback(transactionDb, { journal }) {
      transactionDb.onTransactionRollback(() => journal.rollback());
    },
    updateMutation: async (_db, operationId, status) => {
      events.push(`update:${operationId}:${status}`);
      if (failUpdate) throw new Error('injected completion failure');
    },
  });
  return { events, files, fileService, service, db: createDb() };
}

async function testDeploysOnlyTheRecomputedReviewedCandidateUnderLock() {
  const harness = createHarness();
  const preview = harness.service.preview({
    source: SOURCE,
    approvedSourceHash: hash(SOURCE),
    configuration: configuration(),
    allowedItemClasses: new Set(['BandageDressing']),
  });
  const result = await harness.service.deploy({
    db: harness.db,
    internalServerId: 7,
    actor: { id: 9 },
    approvedSourceHash: hash(SOURCE),
    expectedCandidateHash: preview.candidateHash,
    configuration: configuration(),
    allowedItemClasses: new Set(['BandageDressing']),
    resolveProviderContext: async () => {
      harness.events.push('resolve');
      return { platformServerId: '90000002', token: 'secret', filePath: FILE_PATH };
    },
  });

  assert.deepStrictEqual(result, {
    mode: 'inserted',
    sourceHash: hash(SOURCE),
    candidateHash: preview.candidateHash,
    configurationHash: preview.configurationHash,
    providerUploaded: true,
    operationId: 42,
  });
  assert.strictEqual(harness.files.get(FILE_PATH), preview.source);
  assert.deepStrictEqual(harness.events.slice(0, 4), [
    'lock',
    'resolve',
    `download:90000002:${FILE_PATH}:true`,
    'prepare:mission_init:90000002:deploy',
  ]);
  assert(harness.events.includes('update:42:completed'));
}

async function testRestoresExactOriginalThroughANewDurableOperation() {
  const harness = createHarness();
  const preview = harness.service.preview({
    source: SOURCE,
    approvedSourceHash: hash(SOURCE),
    configuration: configuration(),
    allowedItemClasses: new Set(['BandageDressing']),
  });
  harness.files.set(FILE_PATH, preview.source);

  const result = await harness.service.restore({
    db: harness.db,
    internalServerId: 7,
    actor: { id: 9 },
    deploymentOperationId: 41,
    expectedCurrentHash: preview.candidateHash,
    resolveProviderContext: async () => ({
      platformServerId: '90000002', token: 'secret', filePath: FILE_PATH,
    }),
  });

  assert.strictEqual(harness.files.get(FILE_PATH), SOURCE);
  assert.deepStrictEqual(result, {
    sourceHash: preview.candidateHash,
    restoredHash: hash(SOURCE),
    providerUploaded: true,
    operationId: 42,
    restoredFromOperationId: 41,
  });
  assert(harness.events.includes('load:41:7'));
  assert(harness.events.includes('prepare:mission_init:90000002:restore'));
}

async function testRollbackRestoresExactOriginalAfterPostUploadFailure() {
  const harness = createHarness({ failUpdate: true });
  const preview = harness.service.preview({
    source: SOURCE,
    approvedSourceHash: hash(SOURCE),
    configuration: configuration(),
    allowedItemClasses: new Set(['BandageDressing']),
  });

  await assert.rejects(
    harness.service.deploy({
      db: harness.db,
      internalServerId: 7,
      actor: { id: 9 },
      approvedSourceHash: hash(SOURCE),
      expectedCandidateHash: preview.candidateHash,
      configuration: configuration(),
      allowedItemClasses: new Set(['BandageDressing']),
      resolveProviderContext: async () => ({
        platformServerId: '90000002', token: 'secret', filePath: FILE_PATH,
      }),
    }),
    /injected completion failure/
  );
  assert.strictEqual(harness.files.get(FILE_PATH), SOURCE);
  assert.strictEqual(harness.events.filter(event => event.startsWith('upload:')).length, 2);
}

async function testSourceDriftStopsBeforeDurablePreparationOrUpload() {
  const harness = createHarness();
  const preview = harness.service.preview({
    source: SOURCE,
    approvedSourceHash: hash(SOURCE),
    configuration: configuration(),
    allowedItemClasses: new Set(['BandageDressing']),
  });
  harness.files.set(FILE_PATH, `${SOURCE}// external change\n`);

  await assert.rejects(
    harness.service.deploy({
      db: harness.db,
      internalServerId: 7,
      actor: { id: 9 },
      approvedSourceHash: hash(SOURCE),
      expectedCandidateHash: preview.candidateHash,
      configuration: configuration(),
      allowedItemClasses: new Set(['BandageDressing']),
      resolveProviderContext: async () => ({
        platformServerId: '90000002', token: 'secret', filePath: FILE_PATH,
      }),
    }),
    /changed after approval/
  );
  assert.strictEqual(harness.events.some(event => event.startsWith('prepare:')), false);
  assert.strictEqual(harness.events.some(event => event.startsWith('upload:')), false);
}

async function testRejectsPrivateSignedUploadUrlBeforeSendingContent() {
  let requests = 0;
  const http = {
    async post() {
      requests += 1;
      return {
        data: {
          status: 'success',
          data: { token: { url: 'https://127.0.0.1/upload', token: 'upload-token' } },
        },
      };
    },
  };
  const service = createMissionInitFileService({ http });

  await assert.rejects(
    service.uploadFileToServer('90000002', '/ftproot/dayz/mpmissions/test', 'init.c', SOURCE, 'secret'),
    /invalid.*transfer|public/i
  );
  assert.strictEqual(requests, 1);
}

async function testRejectsTraversalBeforeProviderRequests() {
  let requests = 0;
  const service = createMissionInitFileService({
    http: {
      async get() {
        requests += 1;
        throw new Error('provider must not be called');
      },
      async post() {
        requests += 1;
        throw new Error('provider must not be called');
      },
    },
  });

  await assert.rejects(
    service.downloadFileFromServer('90000002', '/ftproot/dayz/../init.c', 'secret'),
    /path/i
  );
  assert.strictEqual(requests, 0);
}

function testRejectsInvalidTransferLimits() {
  for (const value of [0, false, '', -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => createMissionInitFileService({ maxBytes: value }),
      /positive safe integers/i
    );
    assert.throws(
      () => createMissionInitFileService({ metadataBytes: value }),
      /positive safe integers/i
    );
  }
}

async function testRejectsDeploymentWithAmbiguousDurableSnapshots() {
  const row = {
    id: 41,
    provider_service_id: '90000002',
    plan_json: {
      filePaths: [FILE_PATH],
      expectedCandidateHash: 'a'.repeat(64),
    },
    file_path: FILE_PATH,
    original_exists: true,
    original_content: SOURCE,
  };
  await assert.rejects(
    loadDeploymentSnapshotFromDatabase({
      async query() { return [row, { ...row, file_path: `${FILE_PATH}.duplicate` }]; },
    }, 41, 7),
    /snapshot/i
  );
}

async function main() {
  await testDeploysOnlyTheRecomputedReviewedCandidateUnderLock();
  await testRestoresExactOriginalThroughANewDurableOperation();
  await testRollbackRestoresExactOriginalAfterPostUploadFailure();
  await testSourceDriftStopsBeforeDurablePreparationOrUpload();
  await testRejectsPrivateSignedUploadUrlBeforeSendingContent();
  await testRejectsTraversalBeforeProviderRequests();
  testRejectsInvalidTransferLimits();
  await testRejectsDeploymentWithAmbiguousDurableSnapshots();
  console.log('mission init deployment tests passed');
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
