'use strict';

const crypto = require('crypto');

const TERMINAL_STATUSES = new Set(['completed', 'compensated', 'recovery_pending']);
const DIRECTORY_EXISTS_SNAPSHOT = 'provider-directory-exists:v1';

function providerRecoveryError(operationId) {
  const error = new Error(`Provider recovery is pending for operation ${operationId}`);
  error.code = 'PROVIDER_RECOVERY_PENDING';
  error.status = 409;
  return error;
}

async function assertNoUnresolvedProviderMutation(db, serverId, allowedOperationId = null) {
  const numericAllowedOperationId = allowedOperationId === null
    ? null
    : Number(allowedOperationId);
  if (numericAllowedOperationId !== null &&
      (!Number.isSafeInteger(numericAllowedOperationId) || numericAllowedOperationId <= 0)) {
    throw new Error('Invalid allowed provider operation ID');
  }
  const params = [Number(serverId)];
  const operationExclusion = numericAllowedOperationId === null
    ? ''
    : ' AND id <> ?';
  if (numericAllowedOperationId !== null) params.push(numericAllowedOperationId);
  const unresolved = await db.get(
    `SELECT id, status FROM provider_mutations
     WHERE server_id = ? AND status IN ('prepared', 'recovery_pending')${operationExclusion}
     ORDER BY created_at LIMIT 1`,
    params
  );
  if (!unresolved) return;
  throw providerRecoveryError(unresolved.id);
}

async function persistPreparedProviderMutation(db, {
  serverId,
  providerServiceId,
  workflow,
  action,
  contextType = null,
  contextId = null,
  plan,
  snapshots,
  triggeredBy,
}) {
  if (providerServiceId === null || providerServiceId === undefined || !String(providerServiceId).trim()) {
    throw new Error('Provider service identity is required');
  }
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new Error('Provider mutation plan is required');
  }
  if (!(snapshots instanceof Map) || snapshots.size === 0) {
    throw new Error('Provider mutation snapshots are required');
  }
  const operation = await db.get(
    `INSERT INTO provider_mutations
       (server_id, provider_service_id, workflow, action, context_type, context_id,
        plan_json, status, triggered_by)
     VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, 'prepared', ?)
     RETURNING id`,
    [serverId, String(providerServiceId), workflow, action, contextType,
      contextId === null ? null : String(contextId), JSON.stringify(plan), triggeredBy]
  );
  if (!operation) throw new Error('Failed to create provider recovery record');
  for (const [filePath, originalContent] of snapshots) {
    await db.run(
      `INSERT INTO provider_mutation_files
         (mutation_id, file_path, original_exists, original_content)
       VALUES (?, ?, ?, ?)`,
      [operation.id, filePath, originalContent !== null && originalContent !== undefined,
        originalContent ?? null]
    );
  }
  return operation.id;
}

async function prepareProviderMutation(db, details) {
  if (typeof db.independentTransaction !== 'function') {
    throw new Error('Durable provider preparation requires an independent transaction');
  }
  return db.independentTransaction(transactionDb =>
    persistPreparedProviderMutation(transactionDb, details));
}

async function updatePreparedProviderMutation(db, operationId, status, errorSummary = null) {
  if (!TERMINAL_STATUSES.has(status)) throw new Error('Invalid provider recovery terminal status');
  const result = await db.run(
    `UPDATE provider_mutations
     SET status = ?, error_summary = ?,
         finished_at = CASE WHEN ? = 'recovery_pending' THEN NULL ELSE NOW() END
     WHERE id = ? AND status = 'prepared'`,
    [status, errorSummary, status, operationId]
  );
  if (result.changes === 1) return status;
  const existing = await db.get('SELECT status FROM provider_mutations WHERE id = ?', [operationId]);
  if (existing && TERMINAL_STATUSES.has(existing.status)) return existing.status;
  throw new Error('Provider recovery status conflict');
}

async function updateProviderMutationIndependently(db, operationId, status, errorSummary = null) {
  if (typeof db.independentTransaction !== 'function') {
    throw new Error('Durable provider finalization requires an independent transaction');
  }
  return db.independentTransaction(transactionDb =>
    updatePreparedProviderMutation(transactionDb, operationId, status, errorSummary));
}

async function compensateProviderMutation(db, operationId, journal, operationError) {
  try {
    await journal.rollback();
    await updateProviderMutationIndependently(
      db, operationId, 'compensated', operationError?.message || String(operationError)
    );
  } catch (rollbackError) {
    const message = `${operationError?.message || operationError}; rollback compensation failed: ${rollbackError.message}`;
    await updateProviderMutationIndependently(db, operationId, 'recovery_pending', message);
    const error = providerRecoveryError(operationId);
    error.message = message;
    error.cause = operationError;
    throw error;
  }
}

function registerProviderMutationRollback(db, {
  operationId,
  journal,
  committedStatus = 'completed',
}) {
  if (typeof db.onTransactionRollback !== 'function') {
    throw new Error('Provider mutation requires transaction rollback hooks');
  }
  let rollbackStatus = 'compensated';
  let rollbackSummary = 'Local transaction rolled back';
  db.onTransactionRollback(
    async () => {
      try {
        await journal.rollback();
      } catch (rollbackError) {
        rollbackStatus = 'recovery_pending';
        rollbackSummary = `Local transaction rollback compensation failed: ${rollbackError.message}`;
        throw rollbackError;
      }
    },
    {
      committed: async query => {
        const result = await query('SELECT status FROM provider_mutations WHERE id = $1', [operationId]);
        return result.rows?.[0]?.status === committedStatus;
      },
      deferred: () => updateProviderMutationIndependently(
        db,
        operationId,
        'recovery_pending',
        'Commit outcome is unknown; remote compensation was deferred'
      ),
      afterRollback: () => updateProviderMutationIndependently(
        db, operationId, rollbackStatus, rollbackSummary
      ),
    }
  );
}

function providerStateFingerprint(content, isDirectory = false) {
  if (isDirectory) return content ? 'directory:exists' : 'directory:absent';
  if (content === null || content === undefined) return 'file:absent';
  return 'sha256:' + crypto.createHash('sha256').update(String(content)).digest('hex');
}

function providerRecoveryConflict(operationId, currentHashes) {
  const error = new Error(
    `Provider state changed since operation ${operationId}; confirm the exact observed state before restoring`
  );
  error.code = 'PROVIDER_RECOVERY_CONFLICT';
  error.status = 409;
  error.currentHashes = currentHashes;
  return error;
}

async function reconcileProviderMutationTransaction(db, {
  serverId,
  operationId,
  reconciledBy,
  acquireLock,
  resolveProviderContext,
  fileService,
  fileServiceResolver = null,
  directoryService = null,
  expectedCurrentHashes = null,
}, reconciliationState) {
  const numericServerId = Number(serverId);
  const numericOperationId = Number(operationId);
  if (!Number.isSafeInteger(numericServerId) || numericServerId <= 0 ||
      !Number.isSafeInteger(numericOperationId) || numericOperationId <= 0) {
    throw new Error('Invalid provider recovery operation');
  }
  if (typeof reconciledBy !== 'string' || !reconciledBy.trim()) {
    throw new Error('Provider recovery reconciler is required');
  }
  if (typeof acquireLock !== 'function' || typeof resolveProviderContext !== 'function' ||
      (!fileService && typeof fileServiceResolver !== 'function')) {
    throw new Error('Provider recovery dependencies are incomplete');
  }

  return db.transaction(async transactionDb => {
    await acquireLock(transactionDb, numericServerId, numericOperationId);
    const context = await resolveProviderContext(transactionDb, numericServerId);
    if (!context?.platformServerId || !context?.token) {
      throw new Error('Authorized provider recovery context is unavailable');
    }
    const operation = await transactionDb.get(
      `SELECT id, server_id, provider_service_id, workflow, status, plan_json
       FROM provider_mutations
       WHERE id = ? AND server_id = ? AND status IN ('prepared', 'recovery_pending')
       FOR UPDATE`,
      [numericOperationId, numericServerId]
    );
    if (!operation) throw new Error('Unresolved provider recovery operation not found');
    if (String(operation.provider_service_id) !== String(context.platformServerId)) {
      throw new Error('Provider recovery service identity does not match the current server registration');
    }
    const effectiveFileService = typeof fileServiceResolver === 'function'
      ? await fileServiceResolver({ operation, context })
      : fileService;
    if (!effectiveFileService) {
      throw new Error('Provider recovery file service is unavailable for this workflow');
    }
    const rows = await transactionDb.query(
      `SELECT file_path, original_exists, original_content
       FROM provider_mutation_files
       WHERE mutation_id = ?`,
      [numericOperationId]
    );
    const plan = typeof operation.plan_json === 'string'
      ? JSON.parse(operation.plan_json)
      : operation.plan_json;
    const plannedPaths = plan?.filePaths;
    if (!Array.isArray(plannedPaths) || plannedPaths.length === 0 ||
        new Set(plannedPaths).size !== plannedPaths.length) {
      throw new Error('Provider recovery plan is invalid');
    }
    if (plannedPaths.some(filePath => !filePath.endsWith('/')) &&
        typeof effectiveFileService.downloadFileFromServer !== 'function') {
      throw new Error('Provider recovery file service is unavailable for this workflow');
    }
    const snapshots = new Map(rows.map(row => [row.file_path, row]));
    if (snapshots.size !== plannedPaths.length ||
        plannedPaths.some(filePath => !snapshots.has(filePath))) {
      throw new Error('Provider recovery snapshots do not match the durable plan');
    }

    const currentStates = new Map();
    const currentHashes = {};
    for (const filePath of plannedPaths) {
      const snapshot = snapshots.get(filePath);
      const original = snapshot.original_exists ? snapshot.original_content : null;
      const isDirectory = filePath.endsWith('/');
      if (isDirectory && !directoryService) {
        throw new Error('Provider directory recovery is unavailable');
      }
      const current = isDirectory
        ? await directoryService.folderExists(context.platformServerId, filePath, context.token)
        : await effectiveFileService.downloadFileFromServer(context.platformServerId, filePath, context.token);
      currentStates.set(filePath, current);
      const differs = isDirectory ? current !== snapshot.original_exists : current !== original;
      if (differs) currentHashes[filePath] = providerStateFingerprint(current, isDirectory);
    }
    const changedPaths = Object.keys(currentHashes);
    if (changedPaths.length > 0) {
      const expected = expectedCurrentHashes && typeof expectedCurrentHashes === 'object'
        && !Array.isArray(expectedCurrentHashes) ? expectedCurrentHashes : null;
      const confirmed = expected
        && Object.keys(expected).length === changedPaths.length
        && changedPaths.every(filePath => expected[filePath] === currentHashes[filePath]);
      if (!confirmed) throw providerRecoveryConflict(numericOperationId, currentHashes);
    }

    reconciliationState.providerRestoreStarted = true;
    for (const filePath of plannedPaths.slice().reverse()) {
      const snapshot = snapshots.get(filePath);
      const original = snapshot.original_exists ? snapshot.original_content : null;
      if (filePath.endsWith('/')) {
        if (snapshot.original_exists && original !== DIRECTORY_EXISTS_SNAPSHOT) {
          throw new Error('Provider directory snapshot is invalid');
        }
        const exists = await directoryService.folderExists(
          context.platformServerId, filePath, context.token
        );
        if (providerStateFingerprint(exists, true) !== providerStateFingerprint(currentStates.get(filePath), true)) {
          throw new Error('Provider state changed during recovery confirmation for ' + filePath);
        }
        if (snapshot.original_exists && !exists) {
          await directoryService.createFolderOnServer(
            context.platformServerId, filePath.replace(/\/$/, ''), context.token
          );
        } else if (!snapshot.original_exists && exists) {
          await directoryService.deleteFolderFromServer(
            context.platformServerId, filePath, context.token
          );
        }
        const restored = await directoryService.folderExists(
          context.platformServerId, filePath, context.token
        );
        if (restored !== snapshot.original_exists) {
          throw new Error('Provider directory recovery verification failed');
        }
        continue;
      }

      const current = await effectiveFileService.downloadFileFromServer(
        context.platformServerId, filePath, context.token
      );
      if (providerStateFingerprint(current) !== providerStateFingerprint(currentStates.get(filePath))) {
        throw new Error('Provider state changed during recovery confirmation for ' + filePath);
      }
      if (current !== original) {
        if (snapshot.original_exists) {
          const lastSlash = filePath.lastIndexOf('/');
          await effectiveFileService.uploadFileToServer(
            context.platformServerId,
            filePath.slice(0, lastSlash),
            filePath.slice(lastSlash + 1),
            original,
            context.token
          );
        } else {
          await effectiveFileService.deleteFileFromServer(
            context.platformServerId, filePath, context.token
          );
        }
      }
      const restored = await effectiveFileService.downloadFileFromServer(
        context.platformServerId, filePath, context.token
      );
      if (restored !== original) throw new Error('Provider recovery verification failed for ' + filePath);
    }

    for (const filePath of plannedPaths) {
      const snapshot = snapshots.get(filePath);
      if (filePath.endsWith('/')) {
        const restored = await directoryService.folderExists(
          context.platformServerId, filePath, context.token
        );
        if (restored !== snapshot.original_exists) {
          throw new Error('Final provider recovery verification failed for ' + filePath);
        }
        continue;
      }
      const restored = await effectiveFileService.downloadFileFromServer(
        context.platformServerId, filePath, context.token
      );
      const original = snapshot.original_exists ? snapshot.original_content : null;
      if (restored !== original) {
        throw new Error('Final provider recovery verification failed for ' + filePath);
      }
    }

    const result = await transactionDb.run(
      `UPDATE provider_mutations
       SET status = 'compensated', error_summary = 'Authorized reconciliation restored original provider state',
           reconciled_by = ?, reconciled_at = NOW(), finished_at = NOW()
       WHERE id = ? AND server_id = ? AND status IN ('prepared', 'recovery_pending')`,
      [reconciledBy.trim(), numericOperationId, numericServerId]
    );
    if (result.changes !== 1) throw new Error('Provider recovery status conflict');
    return { operationId: String(operation.id), status: 'compensated' };
  });
}

async function reconcileProviderMutation(db, details) {
  const reconciliationState = { providerRestoreStarted: false };
  try {
    return await reconcileProviderMutationTransaction(db, details, reconciliationState);
  } catch (error) {
    if (reconciliationState.providerRestoreStarted) {
      try {
        if (typeof db.independentTransaction !== 'function') {
          throw new Error('Durable provider reconciliation failure requires an independent transaction');
        }
        await db.independentTransaction(async transactionDb => {
          const result = await transactionDb.run(
            `UPDATE provider_mutations
             SET status = ?, error_summary = ?, finished_at = NULL
             WHERE id = ? AND server_id = ? AND status IN ('prepared', 'recovery_pending')`,
            ['recovery_pending', error.message, Number(details.operationId), Number(details.serverId)]
          );
          if (result.changes !== 1) {
            throw new Error('Provider reconciliation failure status conflict');
          }
        });
      } catch (persistenceError) {
        error.recoveryPersistenceError = persistenceError;
      }
    }
    throw error;
  }
}

module.exports = {
  DIRECTORY_EXISTS_SNAPSHOT,
  assertNoUnresolvedProviderMutation,
  compensateProviderMutation,
  persistPreparedProviderMutation,
  prepareProviderMutation,
  providerRecoveryError,
  reconcileProviderMutation,
  registerProviderMutationRollback,
  updatePreparedProviderMutation,
  updateProviderMutationIndependently,
};
