'use strict';

const crypto = require('crypto');
const {
  acquireProviderMutationLock,
  createFileMutationJournal,
} = require('./shopFileService');
const {
  prepareProviderMutation,
  registerProviderMutationRollback,
  updatePreparedProviderMutation,
} = require('./providerMutationRecoveryService');

function hashContent(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function saveMissionFileVerified({
  db,
  internalServerId,
  platformServerId,
  token,
  remoteDirectory,
  remoteFileName,
  resolveProviderContext,
  expectedHash,
  content,
  fileService,
  localWriter,
  triggeredBy,
}) {
  if (typeof content !== 'string') {
    const error = new TypeError('Mission file content must be a string');
    error.status = 400;
    throw error;
  }
  if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedHash)) {
    const error = new TypeError('A valid expectedHash is required');
    error.status = 400;
    throw error;
  }
  if (typeof triggeredBy !== 'string' || !triggeredBy.trim()) {
    const error = new TypeError('Mission file save actor is required');
    error.status = 400;
    throw error;
  }

  return db.transaction(async transactionDb => {
    await acquireProviderMutationLock(transactionDb, internalServerId);
    const providerContext = resolveProviderContext
      ? await resolveProviderContext(transactionDb)
      : { platformServerId, token, remoteDirectory, remoteFileName };
    const resolvedPlatformServerId = providerContext?.platformServerId;
    const resolvedToken = providerContext?.token;
    const resolvedDirectory = providerContext?.remoteDirectory;
    const resolvedFileName = providerContext?.remoteFileName;
    if (!resolvedToken) {
      const error = new Error('No Nitrado token configured for this server');
      error.status = 409;
      throw error;
    }
    const filePath = resolvedDirectory.replace(/\/$/, '') + '/' + resolvedFileName;
    const previousContent = await fileService.downloadFileFromServer(
      resolvedPlatformServerId,
      filePath,
      resolvedToken
    );
    if (previousContent === null || previousContent === undefined) {
      const error = new Error('Mission file was not found on the provider');
      error.status = 404;
      throw error;
    }
    if (hashContent(previousContent) !== expectedHash.toLowerCase()) {
      const error = new Error('Mission file changed on the provider; reload before saving');
      error.status = 409;
      throw error;
    }

    const snapshots = new Map([[filePath, previousContent]]);
    const prepared = {
      snapshots,
      operationId: await prepareProviderMutation(db, {
        serverId: internalServerId,
        providerServiceId: resolvedPlatformServerId,
        workflow: 'mission_editor',
        action: 'save',
        contextType: 'mission_file',
        contextId: filePath,
        plan: { filePaths: [filePath], expectedHash: expectedHash.toLowerCase() },
        snapshots,
        triggeredBy: triggeredBy.trim(),
      }),
    };
    const journal = createFileMutationJournal(
      resolvedPlatformServerId,
      resolvedToken,
      fileService,
      prepared.snapshots
    );
    registerProviderMutationRollback(transactionDb, {
      operationId: prepared.operationId,
      journal,
    });
    await journal.uploadFileToServer(
      resolvedPlatformServerId,
      resolvedDirectory,
      resolvedFileName,
      content,
      resolvedToken
    );
    const rollbackLocal = await localWriter(content, previousContent);
    if (typeof rollbackLocal !== 'function') {
      throw new Error('Mission file local writer must provide rollback');
    }
    transactionDb.onTransactionRollback(rollbackLocal);
    await updatePreparedProviderMutation(transactionDb, prepared.operationId, 'completed');

    return {
      hash: hashContent(content),
      providerUploaded: true,
      localSaved: true,
      previousContent,
    };
  });
}

module.exports = {
  hashContent,
  saveMissionFileVerified,
};
