'use strict';

const { acquireProviderMutationLock, createFileMutationJournal } = require('./shopFileService');
const {
  prepareProviderMutation,
  registerProviderMutationRollback,
  updatePreparedProviderMutation,
} = require('./providerMutationRecoveryService');
const {
  hashContent,
  previewMissionInitDeployment,
} = require('./missionInitCompositionService');
const {
  createMissionInitFileService,
  splitProviderFilePath,
} = require('./missionInitFileService');

function assertHash(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`A valid ${label} is required`);
  }
}

async function loadDeploymentSnapshotFromDatabase(db, operationId, serverId) {
  const rows = await db.query(
    `SELECT pm.id, pm.provider_service_id, pm.plan_json,
            pmf.file_path, pmf.original_exists, pmf.original_content
     FROM provider_mutations pm
     JOIN provider_mutation_files pmf ON pmf.mutation_id = pm.id
     WHERE pm.id = ? AND pm.server_id = ?
       AND pm.workflow = 'mission_init' AND pm.action = 'deploy'
       AND pm.status = 'completed'`,
    [operationId, serverId]
  );
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error('Completed mission init deployment snapshot was not found or is ambiguous');
  }
  const row = rows[0];
  if (!row.original_exists || typeof row.original_content !== 'string') {
    throw new Error('Completed mission init deployment snapshot was not found');
  }
  const plan = typeof row.plan_json === 'string' ? JSON.parse(row.plan_json) : row.plan_json;
  if (!plan || !Array.isArray(plan.filePaths) || plan.filePaths.length !== 1 ||
      plan.filePaths[0] !== row.file_path ||
      typeof plan.expectedCandidateHash !== 'string' || !/^[a-f0-9]{64}$/.test(plan.expectedCandidateHash)) {
    throw new Error('Mission init deployment snapshot is invalid');
  }
  return {
    id: row.id,
    providerServiceId: String(row.provider_service_id),
    filePath: row.file_path,
    originalContent: row.original_content,
    expectedCandidateHash: plan.expectedCandidateHash,
  };
}

function createMissionInitDeploymentService(options = {}) {
  const fileService = options.fileService || createMissionInitFileService();
  const acquireLock = options.acquireLock || acquireProviderMutationLock;
  const prepareMutation = options.prepareMutation || prepareProviderMutation;
  const registerRollback = options.registerRollback || registerProviderMutationRollback;
  const updateMutation = options.updateMutation || updatePreparedProviderMutation;
  const createJournal = options.createJournal || createFileMutationJournal;
  const loadDeploymentSnapshot = options.loadDeploymentSnapshot || loadDeploymentSnapshotFromDatabase;

  function preview(input) {
    return previewMissionInitDeployment(input);
  }

  async function deploy({
    db,
    internalServerId,
    actor,
    approvedSourceHash,
    expectedCandidateHash,
    configuration,
    allowedItemClasses,
    resolveProviderContext,
  }) {
    const numericServerId = Number(internalServerId);
    if (!Number.isSafeInteger(numericServerId) || numericServerId <= 0) {
      throw new TypeError('A valid internal server ID is required');
    }
    if (!actor?.id) throw new TypeError('Mission init deployment actor is required');
    if (!db || typeof db.transaction !== 'function') {
      throw new TypeError('Mission init deployment database is required');
    }
    if (typeof resolveProviderContext !== 'function') {
      throw new TypeError('Mission init operation-time provider context resolver is required');
    }
    assertHash(approvedSourceHash, 'approved mission init source hash');
    assertHash(expectedCandidateHash, 'expected mission init candidate hash');

    return db.transaction(async transactionDb => {
      await acquireLock(transactionDb, numericServerId);
      const context = await resolveProviderContext(transactionDb, {
        actor,
        internalServerId: numericServerId,
      });
      if (!context?.platformServerId || typeof context.token !== 'string' || !context.token) {
        throw new Error('Authorized mission init provider context is unavailable');
      }
      const { directory, fileName } = splitProviderFilePath(context.filePath);
      const currentSource = await fileService.downloadFileFromServer(
        context.platformServerId,
        context.filePath,
        context.token
      );
      if (typeof currentSource !== 'string') {
        const error = new Error('Mission init source was not found on the provider');
        error.status = 404;
        throw error;
      }
      if (hashContent(currentSource) !== approvedSourceHash) {
        const error = new Error('Mission init source changed after approval');
        error.status = 409;
        throw error;
      }

      const candidate = previewMissionInitDeployment({
        source: currentSource,
        approvedSourceHash,
        configuration,
        allowedItemClasses,
      });
      if (candidate.candidateHash !== expectedCandidateHash) {
        const error = new Error('Mission init candidate does not match the approved preview');
        error.status = 409;
        throw error;
      }

      const snapshots = new Map([[context.filePath, currentSource]]);
      const operationId = await prepareMutation(db, {
        serverId: numericServerId,
        providerServiceId: context.platformServerId,
        workflow: 'mission_init',
        action: 'deploy',
        contextType: 'mission_init_file',
        contextId: context.filePath,
        plan: {
          filePaths: [context.filePath],
          expectedSourceHash: approvedSourceHash,
          expectedCandidateHash,
          configurationHash: candidate.configurationHash,
        },
        snapshots,
        triggeredBy: `user:${actor.id}`,
      });
      const journal = createJournal(
        context.platformServerId,
        context.token,
        fileService,
        snapshots
      );
      registerRollback(transactionDb, { operationId, journal });
      await journal.uploadFileToServer(
        context.platformServerId,
        directory,
        fileName,
        candidate.source,
        context.token
      );
      await updateMutation(transactionDb, operationId, 'completed');

      return {
        mode: candidate.mode,
        sourceHash: candidate.sourceHash,
        candidateHash: candidate.candidateHash,
        configurationHash: candidate.configurationHash,
        providerUploaded: true,
        operationId,
      };
    });
  }

  async function restore({
    db,
    internalServerId,
    actor,
    deploymentOperationId,
    expectedCurrentHash,
    resolveProviderContext,
  }) {
    const numericServerId = Number(internalServerId);
    const numericDeploymentOperationId = Number(deploymentOperationId);
    if (!Number.isSafeInteger(numericServerId) || numericServerId <= 0 ||
        !Number.isSafeInteger(numericDeploymentOperationId) || numericDeploymentOperationId <= 0) {
      throw new TypeError('Valid mission init restore identifiers are required');
    }
    if (!actor?.id) throw new TypeError('Mission init restore actor is required');
    if (!db || typeof db.transaction !== 'function' || typeof resolveProviderContext !== 'function') {
      throw new TypeError('Mission init restore dependencies are required');
    }
    assertHash(expectedCurrentHash, 'expected current mission init hash');

    return db.transaction(async transactionDb => {
      await acquireLock(transactionDb, numericServerId);
      const context = await resolveProviderContext(transactionDb, {
        actor,
        internalServerId: numericServerId,
      });
      if (!context?.platformServerId || typeof context.token !== 'string' || !context.token) {
        throw new Error('Authorized mission init provider context is unavailable');
      }
      const deployment = await loadDeploymentSnapshot(
        transactionDb,
        numericDeploymentOperationId,
        numericServerId
      );
      if (deployment.providerServiceId !== String(context.platformServerId) ||
          deployment.filePath !== context.filePath ||
          deployment.expectedCandidateHash !== expectedCurrentHash) {
        throw new Error('Mission init restore snapshot does not match the authorized deployment');
      }
      const { directory, fileName } = splitProviderFilePath(context.filePath);
      const currentSource = await fileService.downloadFileFromServer(
        context.platformServerId,
        context.filePath,
        context.token
      );
      if (typeof currentSource !== 'string' || hashContent(currentSource) !== expectedCurrentHash) {
        const error = new Error('Mission init source changed after restore approval');
        error.status = 409;
        throw error;
      }

      const restoredHash = hashContent(deployment.originalContent);
      const snapshots = new Map([[context.filePath, currentSource]]);
      const operationId = await prepareMutation(db, {
        serverId: numericServerId,
        providerServiceId: context.platformServerId,
        workflow: 'mission_init',
        action: 'restore',
        contextType: 'mission_init_file',
        contextId: context.filePath,
        plan: {
          filePaths: [context.filePath],
          restoredFromOperationId: numericDeploymentOperationId,
          expectedCurrentHash,
          restoredHash,
        },
        snapshots,
        triggeredBy: `user:${actor.id}`,
      });
      const journal = createJournal(
        context.platformServerId,
        context.token,
        fileService,
        snapshots
      );
      registerRollback(transactionDb, { operationId, journal });
      await journal.uploadFileToServer(
        context.platformServerId,
        directory,
        fileName,
        deployment.originalContent,
        context.token
      );
      await updateMutation(transactionDb, operationId, 'completed');

      return {
        sourceHash: expectedCurrentHash,
        restoredHash,
        providerUploaded: true,
        operationId,
        restoredFromOperationId: numericDeploymentOperationId,
      };
    });
  }

  return { deploy, preview, restore };
}

module.exports = {
  createMissionInitDeploymentService,
  loadDeploymentSnapshotFromDatabase,
  splitProviderFilePath,
};
