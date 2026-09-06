'use strict';

const missionFileService = require('./missionFileService');
const {
  acquireProviderMutationLock,
  createFileMutationJournal,
} = require('./shopFileService');
const {
  prepareProviderMutation,
  registerProviderMutationRollback,
  updatePreparedProviderMutation,
} = require('./providerMutationRecoveryService');

function parseListContent(content) {
  if (content === null || content === undefined || content === '') return [];
  return String(content).split('\n').map(line => line.trim()).filter(Boolean);
}

function serializeListContent(lines) {
  if (!Array.isArray(lines) || lines.some(line => typeof line !== 'string')) {
    throw new TypeError('Provider list mutation must return an array of strings');
  }
  return lines.join('\n') + (lines.length ? '\n' : '');
}

async function mutateProviderList({
  db,
  internalServerId,
  platformServerId,
  token,
  dir,
  filename,
  listType,
  action,
  triggeredBy,
  mutate,
  beforeMutation = null,
  localWriter = null,
  fileService = missionFileService,
}) {
  if (typeof mutate !== 'function') throw new TypeError('Provider list mutation callback is required');
  const filePath = `${String(dir).replace(/\/?$/, '/')}${filename}`;

  return db.transaction(async transactionDb => {
    await acquireProviderMutationLock(transactionDb, internalServerId);
    if (beforeMutation) await beforeMutation(transactionDb);
    const previousContent = await fileService.downloadFileFromServer(
      platformServerId,
      filePath,
      token
    );
    const mutation = await mutate(parseListContent(previousContent));
    const nextContent = serializeListContent(mutation.lines);
    if (nextContent === previousContent) {
      if (localWriter) await localWriter(transactionDb, mutation);
      return { changed: false, result: mutation.result };
    }

    const snapshots = new Map([[filePath, previousContent]]);
    const operationId = await prepareProviderMutation(db, {
      serverId: internalServerId,
      providerServiceId: platformServerId,
      workflow: 'provider_list',
      action,
      contextType: listType,
      contextId: filePath,
      plan: { filePaths: [filePath], listType },
      snapshots,
      triggeredBy,
    });
    const journal = createFileMutationJournal(platformServerId, token, fileService, snapshots);
    registerProviderMutationRollback(transactionDb, { operationId, journal });
    await journal.uploadFileToServer(platformServerId, dir, filename, nextContent, token);
    if (localWriter) await localWriter(transactionDb, mutation);
    await updatePreparedProviderMutation(transactionDb, operationId, 'completed');
    return { changed: true, result: mutation.result };
  });
}

module.exports = {
  mutateProviderList,
  parseListContent,
  serializeListContent,
};
