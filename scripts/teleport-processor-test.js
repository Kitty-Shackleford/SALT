'use strict';

const assert = require('assert');
const {
  claimTeleportRequest,
  assertDestinationMap,
  acquireMissionMutationLock,
  markTeleportArrivals,
  processExpiredTeleports,
  processTeleportCleanups,
  processTeleportRestarts,
  processWaitingTeleports,
  refreshRestartEvidence,
} = require('../services/teleportProcessorService');

(async () => {
  assert.doesNotThrow(() => assertDestinationMap('ChernarusPlus', 'chernarusplus'));
  assert.throws(
    () => assertDestinationMap('chernarusplus', 'enoch'),
    error => error.code === 'TELEPORT_MAP_CHANGED'
  );

  await assert.rejects(
    acquireMissionMutationLock({
      acquireTransactionAdvisoryLock: async () => {},
      get: async sql => /provider_mutations/.test(sql)
        ? { id: '501', status: 'recovery_pending' }
        : null,
    }, 1),
    error => error.code === 'PROVIDER_RECOVERY_PENDING'
  );

  const calls = [];
  const db = {
    async get(sql) {
      if (/FROM provider_mutations/.test(sql)) return null;
      calls.push(sql);
      if (/FROM servers/.test(sql)) return { id: 1, guild_id: 2 };
      if (/FROM teleport_requests tr/.test(sql)) return {
        id: 9, server_id: 1, guild_id: 2, identity_id: 5, destination_id: 7,
        requested_at: '2026-08-31T12:00:00Z', expires_at: '2026-09-01T12:00:00Z',
        status: 'waiting_disconnect',
        respect_pra: true, restriction_id: null, pos_x: 300, pos_y: 10, pos_z: 400,
      };
      if (/player_pra_restrictions/.test(sql)) return null;
      if (/player_disconnect_positions/.test(sql)) {
        return { pos_x: 100, pos_y: 20, pos_z: 200, observed_at: '2026-08-31T13:00:00Z' };
      }
      throw new Error(`Unexpected get: ${sql}`);
    },
    async query(sql, params) {
      calls.push(sql);
      if (/UPDATE teleport_requests/.test(sql)) return [{ id: 9, status: 'provisioning' }];
      if (/INSERT INTO teleport_events/.test(sql)) return [];
      throw new Error(`Unexpected query: ${sql} ${params}`);
    },
  };
  const claim = await claimTeleportRequest(db, 9, 1);
  assert.deepStrictEqual(claim.sourcePosition, [100, 200, 20]);
  assert.deepStrictEqual(claim.destinationPosition, [300, 10, 400]);
  assert.strictEqual(claim.request.status, 'provisioning');
  assert(calls.some(sql => /FROM servers/.test(sql) && /FOR UPDATE/.test(sql)));
  assert(calls.some(sql => /UPDATE teleport_requests/.test(sql)));
  const claimQuery = calls.find(sql => /FROM teleport_requests tr/.test(sql));
  const claimUpdate = calls.find(sql => /UPDATE teleport_requests/.test(sql));
  assert.match(claimQuery, /tr\.expires_at > clock_timestamp\(\)/,
    'expired waiting requests must not be claimed for provider provisioning');
  assert.match(claimUpdate, /expires_at > clock_timestamp\(\)/,
    'an expired request must not transition to provisioning');
  assert.match(claimQuery, /tr\.updated_at < clock_timestamp\(\) - INTERVAL '10 minutes'/);
  assert.match(claimUpdate, /updated_at < clock_timestamp\(\) - INTERVAL '10 minutes'/);

  const arrivalCalls = [];
  const arrivals = await markTeleportArrivals({
    async query(sql, params) {
      arrivalCalls.push({ sql, params });
      if (/SELECT tr\.id/.test(sql)) {
        return [{ id: 9, guild_id: 2, server_id: 1, identity_id: 5,
          requested_by_user_id: 6, observed_at: '2026-08-31T14:00:00Z' }];
      }
      if (/UPDATE teleport_requests/.test(sql)) return [{ id: 9, status: 'cleanup_pending' }];
      if (/INSERT INTO teleport_events/.test(sql)) return [];
      throw new Error(`Unexpected arrival query: ${sql}`);
    },
  }, 1);
  assert.deepStrictEqual(arrivals, [{ id: 9, status: 'cleanup_pending' }]);
  const candidateQuery = arrivalCalls.find(call => /SELECT tr\.id/.test(call.sql));
  assert.match(candidateQuery.sql, /ps\.server_id = tr\.server_id/);
  assert.match(candidateQuery.sql, /ps\.identity_id = tr\.identity_id/);
  assert.match(candidateQuery.sql, /srl\.detected_at >= tr\.arm_configured_at/);
  assert.match(candidateQuery.sql, /ps\.timestamp >= arm_restart\.detected_at/);
  assert.match(candidateQuery.sql, /ps\.timestamp <= tr\.expires_at/,
    'arrival evidence after expiry must not complete a timed-out teleport');
  assert.match(candidateQuery.sql, /power\(ps\.pos_x - td\.pos_x, 2\)/);
  assert.match(candidateQuery.sql, /power\(ps\.pos_z - td\.pos_y, 2\)/);
  assert.match(candidateQuery.sql, /power\(ps\.pos_y - td\.pos_z, 2\)/);
  assert.match(candidateQuery.sql, /25/);

  const refreshSteps = [];
  await refreshRestartEvidence({}, 1, {
    captureDatabaseClock: async () => {
      refreshSteps.push('fetch-start');
      return '2026-08-31T15:00:00.000Z';
    },
    resolveServerControlContext: async () => ({ platformServerId: '101', token: 'token' }),
    performExactServerLogSync: async () => {
      refreshSteps.push('download');
      return { restartEvidence: { 101: { serverLogPath: null, latestRptPath: '/logs/latest.RPT' } } };
    },
    processDownloadedRestartEvidence: async (_db, serverContext, evidence) => {
      assert.deepStrictEqual(serverContext, { serverId: 1, platformServerId: '101' });
      assert.strictEqual(evidence.latestRptPath, '/logs/latest.RPT');
      refreshSteps.push('restart-log');
    },
    scanExactServerLogs: async (_db, platformServerId, token, internalServerId) => {
      assert.deepStrictEqual([platformServerId, token, internalServerId], ['101', 'token', 1]);
      refreshSteps.push('adm-logs');
      return { onlineCachePublished: true, filesScanned: { admCount: 1, rptCount: 0 } };
    },
    markServerLogParseSuccessful: async (_db, internalServerId, fetchStartedAt) => {
      assert.deepStrictEqual([internalServerId, fetchStartedAt], [1, '2026-08-31T15:00:00.000Z']);
      refreshSteps.push('watermark');
    },
  });
  assert.deepStrictEqual(
    refreshSteps,
    ['fetch-start', 'download', 'restart-log', 'adm-logs', 'watermark'],
    'expiry coverage must use the database fetch-start time and publish only after exact-server parsing'
  );

  let staleWatermarkWritten = false;
  await assert.rejects(
    refreshRestartEvidence({}, 1, {
      captureDatabaseClock: async () => '2026-08-31T15:00:00.000Z',
      resolveServerControlContext: async () => ({ platformServerId: '101', token: 'token' }),
      performExactServerLogSync: async () => ({
        restartEvidence: { 101: { serverLogPath: null, latestRptPath: '/logs/latest.RPT' } },
      }),
      processDownloadedRestartEvidence: async () => {},
      scanExactServerLogs: async () => ({
        onlineCachePublished: false,
        filesScanned: { admCount: 1, rptCount: 0 },
      }),
      markServerLogParseSuccessful: async () => { staleWatermarkWritten = true; },
    }),
    /Fresh ADM evidence is unavailable/,
    'stale ADM evidence must keep teleport lifecycle refresh fail closed'
  );
  assert.strictEqual(staleWatermarkWritten, false,
    'stale ADM evidence must not advance teleport lifecycle coverage');

  const testProviderRecovery = {
    async assertTeleportProviderContext() {},
    async resolveServerControlContext() {
      return { platformServerId: '123', token: 'secret' };
    },
    async prepareTeleportProviderMutation(_db, context, requestId, _action, dependencies) {
      const fileService = dependencies.fileService || {
        async downloadFileFromServer() { return null; },
      };
      const snapshots = new Map();
      for (const filePath of [
        `${context.missionDir}/pra/dayz-dashboard-teleport-${requestId}.json`,
        `${context.missionDir}/cfggameplay.json`,
        `${context.missionDir}/cfgGameplay.json`,
      ]) {
        snapshots.set(filePath, await fileService.downloadFileFromServer(
          context.platformServerId, filePath, context.token
        ));
      }
      return { operationId: `test-${requestId}`, snapshots };
    },
    async updatePreparedProviderMutation() {},
  };

  const cleanupCalls = [];
  const cleanupDb = {
    async transaction(callback) { return callback(this); },
    onTransactionRollback() {},
    async acquireTransactionAdvisoryLock(namespace, serverId) {
      cleanupCalls.push(`lock:${namespace}:${serverId}`);
    },
    async get(sql) {
      if (/FROM provider_mutations/.test(sql)) return null;
      cleanupCalls.push(sql);
      if (/FROM servers/.test(sql)) return { id: 1, guild_id: 2 };
      throw new Error(`Unexpected cleanup get: ${sql}`);
    },
    async query(sql) {
      cleanupCalls.push(sql);
      if (/SELECT tr\.id, tr\.status FROM teleport_requests tr/.test(sql)) {
        return [{ id: 9, status: 'cleanup_pending' }];
      }
      if (/SET status = 'cleanup_processing'/.test(sql)) {
        return [{ id: 9, guild_id: 2, server_id: 1, identity_id: 5,
          requested_by_user_id: 6, status: 'cleanup_processing',
          mission_dir: '/original-mission' }];
      }
      if (/SET status = 'cleanup_restart_pending'/.test(sql)) {
        return [{ id: 9, guild_id: 2, server_id: 1, identity_id: 5,
          requested_by_user_id: 6, status: 'cleanup_restart_pending' }];
      }
      if (/CLEANUP_RESTART_FAILED/.test(sql)) return [];
      if (/SET status = 'completed'/.test(sql)) return [{ id: 9, status: 'completed' }];
      if (/INSERT INTO teleport_events/.test(sql)) return [];
      throw new Error(`Unexpected cleanup query: ${sql}`);
    },
  };
  let cleaned = 0;
  let restarted = 0;
  const cleanupOutcomes = await processTeleportCleanups(cleanupDb, 1, {
    ...testProviderRecovery,
    resolveProvisioningContext: async () => ({
      platformServerId: '123', token: 'secret', missionDir: '/mission', mapName: 'chernarusplus',
    }),
    cleanupPraTeleport: async input => {
      cleaned += 1;
      assert.strictEqual(input.requestId, 9);
      assert.strictEqual(input.missionDir, '/original-mission');
    },
    controlServer: async () => { restarted += 1; },
  });
  assert.deepStrictEqual(cleanupOutcomes, [{
    id: 9, status: 'cleanup_restart_pending', restartRequested: true,
  }]);
  assert.strictEqual(cleaned, 1);
  assert.strictEqual(restarted, 1);
  assert(cleanupCalls.some(call => typeof call === 'string' && call.startsWith('lock:')));
  assert(cleanupCalls.some(sql => typeof sql === 'string' && /cleanup_requested_at < clock_timestamp\(\) - INTERVAL '10 minutes'/.test(sql)));

  let cleanupState = 'cleanup_pending';
  const cleanupFailureDb = {
    async transaction(callback) {
      const before = cleanupState;
      try {
        return await callback(this);
      } catch (error) {
        cleanupState = before;
        throw error;
      }
    },
    onTransactionRollback() {},
    async acquireTransactionAdvisoryLock() {},
    async get(sql) {
      if (/FROM provider_mutations/.test(sql)) return null;
      if (/FROM servers/.test(sql)) return { id: 1, guild_id: 2 };
      throw new Error(`Unexpected cleanup-failure get: ${sql}`);
    },
    async query(sql) {
      if (/SELECT tr\.id, tr\.status FROM teleport_requests tr/.test(sql)) {
        return cleanupState === 'cleanup_pending' ? [{ id: 29, status: cleanupState }] : [];
      }
      if (/SET status = 'cleanup_processing'/.test(sql)) {
        cleanupState = 'cleanup_processing';
        return [{ id: 29, guild_id: 2, server_id: 1, identity_id: 5,
          requested_by_user_id: 6, status: cleanupState, mission_dir: '/mission' }];
      }
      if (/SET status = 'cleanup_restart_pending'/.test(sql)) {
        cleanupState = 'cleanup_restart_pending';
        return [{ id: 29, guild_id: 2, server_id: 1, identity_id: 5,
          requested_by_user_id: 6, status: cleanupState, mission_dir: '/mission' }];
      }
      if (/CLEANUP_RESTART_FAILED/.test(sql)) return [];
      if (/INSERT INTO teleport_events/.test(sql)) return [];
      throw new Error(`Unexpected cleanup-failure query: ${sql}`);
    },
  };
  let cleanupMutations = 0;
  let cleanupRestarts = 0;
  const cleanupFailure = await processTeleportCleanups(cleanupFailureDb, 1, {
    ...testProviderRecovery,
    resolveProvisioningContext: async () => ({
      platformServerId: '123', token: 'secret', missionDir: '/mission', mapName: 'chernarusplus',
    }),
    cleanupPraTeleport: async () => { cleanupMutations += 1; },
    controlServer: async () => {
      cleanupRestarts += 1;
      throw new Error('cleanup restart response lost');
    },
  });
  assert.strictEqual(cleanupState, 'cleanup_restart_pending');
  assert.strictEqual(cleanupMutations, 1);
  assert.strictEqual(cleanupRestarts, 1);
  assert.deepStrictEqual(cleanupFailure, [{
    id: 29, status: 'cleanup_restart_pending', restartRequested: false,
  }]);
  await processTeleportCleanups(cleanupFailureDb, 1, {
    cleanupPraTeleport: async () => { cleanupMutations += 1; },
    controlServer: async () => { cleanupRestarts += 1; },
  });
  assert.strictEqual(cleanupMutations, 1);
  assert.strictEqual(cleanupRestarts, 1);

  let providerState = 'waiting_disconnect';
  let provisioningTransactionDepth = 0;
  const provisioningDb = {
    async transaction(callback) {
      const before = providerState;
      provisioningTransactionDepth += 1;
      try {
        return await callback(this);
      } catch (error) {
        providerState = before;
        throw error;
      } finally {
        provisioningTransactionDepth -= 1;
      }
    },
    onTransactionRollback() {},
    async acquireTransactionAdvisoryLock() {},
    async get(sql) {
      if (/FROM provider_mutations/.test(sql)) return null;
      if (/FROM servers/.test(sql)) return { id: 1, guild_id: 2 };
      if (/FROM teleport_requests tr/.test(sql)) {
        return {
          id: 19, server_id: 1, guild_id: 2, identity_id: 5, destination_id: 7,
          requested_at: '2026-08-31T12:00:00Z', status: providerState,
          respect_pra: true, restriction_id: null, pos_x: 300, pos_y: 10, pos_z: 400,
          source_pos_x: 100, source_pos_y: 20, source_pos_z: 200,
          source_observed_at: '2026-08-31T13:00:00Z', map_name: 'chernarusplus',
        };
      }
      if (/player_pra_restrictions/.test(sql)) return null;
      throw new Error(`Unexpected provisioning get: ${sql}`);
    },
    async query(sql) {
      if (/SELECT (?:tr\.)?id FROM teleport_requests/.test(sql)) {
        return providerState === 'waiting_disconnect' ? [{ id: 19 }] : [];
      }
      if (/SET status = 'provisioning'/.test(sql)) {
        providerState = 'provisioning';
        return [{ id: 19, status: providerState }];
      }
      if (/SET mission_dir = \?, mission_map_name = \?, pra_file_path = \?/.test(sql)) {
        return [{ id: 19, status: providerState, mission_dir: '/mission',
          mission_map_name: 'chernarusplus', pra_file_path: 'pra/dayz-dashboard-teleport-19.json' }];
      }
      if (/SET status = 'armed'/.test(sql)) {
        providerState = 'armed';
        return [{ id: 19, status: providerState }];
      }
      if (/failure_code = 'RESTART_REQUEST_FAILED'/.test(sql)) return [];
      if (/INSERT INTO teleport_events/.test(sql)) return [];
    },
  };
  let provisioned = 0;
  let restartAttempts = 0;
  const providerFailure = await processWaitingTeleports(provisioningDb, 1, {
    ...testProviderRecovery,
    resolveProvisioningContext: async () => {
      assert(provisioningTransactionDepth > 0,
        'provider-derived mission context must be resolved while holding the provider mutation transaction');
      return {
        platformServerId: '123', token: 'secret', missionDir: '/mission', mapName: 'chernarusplus',
      };
    },
    provisionPraTeleport: async () => {
      provisioned += 1;
      return { praFilePath: 'pra/dashboard_teleport_19.json' };
    },
    controlServer: async () => {
      restartAttempts += 1;
      throw new Error('restart response lost');
    },
  });
  assert.strictEqual(providerState, 'armed');
  assert.strictEqual(provisioned, 1);
  assert.strictEqual(restartAttempts, 1);
  assert.deepStrictEqual(providerFailure, [{ id: 19, status: 'armed', restartRequested: false }]);
  await processWaitingTeleports(provisioningDb, 1, {
    provisionPraTeleport: async () => { provisioned += 1; },
    controlServer: async () => { restartAttempts += 1; },
  });
  assert.strictEqual(provisioned, 1);
  assert.strictEqual(restartAttempts, 1);

  // A database failure after verified provider writes must restore the remote
  // files and leave the durable request claim non-refundable/retryable.
  let commitFailureState = 'waiting_disconnect';
  let failArmedWrite = true;
  let rollbackHooks = [];
  const originalGameplay = JSON.stringify({
    version: 123, WorldsData: { playerRestrictedAreaFiles: ['pra/official.json'] },
  });
  const providerFiles = new Map([['/mission/cfggameplay.json', originalGameplay]]);
  const baseFileService = {
    async downloadFileFromServer(_server, filePath) {
      return providerFiles.has(filePath) ? providerFiles.get(filePath) : null;
    },
    async uploadFileToServer(_server, dir, name, content) {
      providerFiles.set(`${dir}/${name}`, content);
    },
    async deleteFileFromServer(_server, filePath) { providerFiles.delete(filePath); },
  };
  const commitFailureDb = {
    async transaction(callback) {
      const before = commitFailureState;
      rollbackHooks = [];
      try {
        return await callback(this);
      } catch (error) {
        commitFailureState = before;
        for (const hook of rollbackHooks.slice().reverse()) await hook();
        throw error;
      }
    },
    onTransactionRollback(callback) { rollbackHooks.push(callback); },
    async acquireTransactionAdvisoryLock() {},
    async get(sql) {
      if (/FROM provider_mutations/.test(sql)) return null;
      if (/FROM servers/.test(sql)) return { id: 1, guild_id: 2 };
      if (/FROM teleport_requests tr/.test(sql)) return {
        id: 39, server_id: 1, guild_id: 2, identity_id: 5, destination_id: 7,
        status: commitFailureState, respect_pra: true, pos_x: 300, pos_y: 10, pos_z: 400,
        source_pos_x: 100, source_pos_y: 20, source_pos_z: 200,
        source_observed_at: '2026-08-31T13:00:00Z', map_name: 'chernarusplus',
      };
      if (/player_pra_restrictions/.test(sql)) return null;
      throw new Error(`Unexpected commit-failure get: ${sql}`);
    },
    async query(sql) {
      if (/SELECT (?:tr\.)?id FROM teleport_requests/.test(sql)) {
        return commitFailureState === 'waiting_disconnect' ? [{ id: 39 }] : [];
      }
      if (/SET status = 'provisioning'/.test(sql)) {
        commitFailureState = 'provisioning';
        return [{ id: 39, status: commitFailureState }];
      }
      if (/SET mission_dir = \?, mission_map_name = \?, pra_file_path = \?/.test(sql)) {
        return [{ id: 39, status: commitFailureState, mission_dir: '/mission',
          mission_map_name: 'chernarusplus', pra_file_path: 'pra/dayz-dashboard-teleport-39.json' }];
      }
      if (/SET status = 'armed'/.test(sql)) {
        if (failArmedWrite) {
          failArmedWrite = false;
          throw new Error('database write failed after provider mutation');
        }
        commitFailureState = 'armed';
        return [{ id: 39, status: commitFailureState }];
      }
      if (/INSERT INTO teleport_events/.test(sql)) return [];
      throw new Error(`Unexpected commit-failure query: ${sql}`);
    },
  };
  const commitFailure = await processWaitingTeleports(commitFailureDb, 1, {
    ...testProviderRecovery,
    resolveProvisioningContext: async () => ({
      platformServerId: '123', token: 'secret', missionDir: '/mission', mapName: 'chernarusplus',
    }),
    fileService: baseFileService,
    controlServer: async () => { throw new Error('restart must not run'); },
  });
  assert.strictEqual(commitFailureState, 'provisioning');
  assert.deepStrictEqual(commitFailure, [{
    id: 39, status: 'retry', error: 'database write failed after provider mutation',
  }]);
  assert.strictEqual(providerFiles.get('/mission/cfggameplay.json'), originalGameplay);
  assert.strictEqual(providerFiles.has('/mission/pra/dayz-dashboard-teleport-39.json'), false);

  let cleanupCommitState = 'cleanup_pending';
  let cleanupHooks = [];
  const cleanupPraPath = '/mission/pra/dayz-dashboard-teleport-49.json';
  const cleanupGameplay = JSON.stringify({
    version: 123,
    WorldsData: {
      playerRestrictedAreaFiles: ['pra/official.json', 'pra/dayz-dashboard-teleport-49.json'],
    },
  });
  const cleanupProviderFiles = new Map([
    ['/mission/cfggameplay.json', cleanupGameplay],
    [cleanupPraPath, '{"areas":[]}'],
  ]);
  const cleanupBaseFileService = {
    async downloadFileFromServer(_server, filePath) {
      return cleanupProviderFiles.has(filePath) ? cleanupProviderFiles.get(filePath) : null;
    },
    async uploadFileToServer(_server, dir, name, content) {
      cleanupProviderFiles.set(`${dir}/${name}`, content);
    },
    async deleteFileFromServer(_server, filePath) { cleanupProviderFiles.delete(filePath); },
  };
  const cleanupCommitDb = {
    async transaction(callback) {
      const before = cleanupCommitState;
      cleanupHooks = [];
      try {
        return await callback(this);
      } catch (error) {
        cleanupCommitState = before;
        for (const hook of cleanupHooks.slice().reverse()) await hook();
        throw error;
      }
    },
    onTransactionRollback(callback) { cleanupHooks.push(callback); },
    async acquireTransactionAdvisoryLock() {},
    async get(sql) {
      if (/FROM provider_mutations/.test(sql)) return null;
      if (/FROM servers/.test(sql)) return { id: 1, guild_id: 2 };
      throw new Error(`Unexpected cleanup-commit get: ${sql}`);
    },
    async query(sql) {
      if (/SELECT tr\.id, tr\.status FROM teleport_requests tr/.test(sql)) {
        return cleanupCommitState === 'cleanup_pending'
          ? [{ id: 49, status: cleanupCommitState }]
          : [];
      }
      if (/SET status = 'cleanup_processing'/.test(sql)) {
        cleanupCommitState = 'cleanup_processing';
        return [{ id: 49, guild_id: 2, server_id: 1, identity_id: 5,
          requested_by_user_id: 6, status: cleanupCommitState, mission_dir: '/mission' }];
      }
      if (/SET status = 'cleanup_restart_pending'/.test(sql)) {
        throw new Error('database cleanup write failed after provider mutation');
      }
      if (/INSERT INTO teleport_events/.test(sql)) return [];
      throw new Error(`Unexpected cleanup-commit query: ${sql}`);
    },
  };
  const cleanupCommitFailure = await processTeleportCleanups(cleanupCommitDb, 1, {
    ...testProviderRecovery,
    resolveProvisioningContext: async () => ({
      platformServerId: '123', token: 'secret', missionDir: '/mission', mapName: 'chernarusplus',
    }),
    fileService: cleanupBaseFileService,
    controlServer: async () => { throw new Error('restart must not run'); },
  });
  assert.strictEqual(cleanupCommitState, 'cleanup_processing');
  assert.deepStrictEqual(cleanupCommitFailure, [{
    id: 49, status: 'retry', error: 'database cleanup write failed after provider mutation',
  }]);
  assert.strictEqual(cleanupProviderFiles.get('/mission/cfggameplay.json'), cleanupGameplay);
  assert.strictEqual(cleanupProviderFiles.get(cleanupPraPath), '{"areas":[]}');

  let restartDispatches = 0;
  let restartTransactionDepth = 0;
  const restartRetryCalls = [];
  const restartRetryDb = {
    async transaction(callback) {
      restartTransactionDepth += 1;
      try {
        return await callback(this);
      } finally {
        restartTransactionDepth -= 1;
      }
    },
    async acquireTransactionAdvisoryLock() {},
    async get(sql) {
      if (/FROM provider_mutations/.test(sql)) return null;
      restartRetryCalls.push(sql);
      if (/FROM servers/.test(sql)) return { id: 1 };
      if (/SELECT tr\.\* FROM teleport_requests/.test(sql)) {
        return /restart_attempt_count > 0/.test(sql)
          && /log_parse_watermark_at >= tr\.restart_requested_at/.test(sql)
          && /cleanup_restart_attempt_count > 0/.test(sql)
          && /log_parse_watermark_at >= tr\.cleanup_restart_requested_at/.test(sql)
          ? { id: 60, server_id: 1, guild_id: 2, identity_id: 5,
            requested_by_user_id: 6, status: 'armed' }
          : null;
      }
      throw new Error(`Unexpected restart retry get: ${sql}`);
    },
    async query(sql) {
      restartRetryCalls.push(sql);
      if (/SELECT (?:tr\.)?id FROM teleport_requests/.test(sql)) return [{ id: 60 }];
      if (/restart_attempt_count = restart_attempt_count \+ 1/.test(sql)) {
        return [{ id: 60, server_id: 1, guild_id: 2, identity_id: 5,
          requested_by_user_id: 6, status: 'armed' }];
      }
      if (/UPDATE teleport_requests/.test(sql) || /INSERT INTO teleport_events/.test(sql)) return [];
      throw new Error(`Unexpected restart retry query: ${sql}`);
    },
  };
  const restartRetry = await processTeleportRestarts(restartRetryDb, 1, {
    resolveServerControlContext: async () => {
      assert(restartTransactionDepth > 0,
        'restart provider context must be resolved while holding the provider mutation transaction');
      return { platformServerId: '123', token: 'secret' };
    },
    assertTeleportProviderContext: async () => {
      assert(restartTransactionDepth > 0,
        'restart provider context must be revalidated while holding the provider mutation transaction');
    },
    controlServer: async () => {
      assert(restartTransactionDepth > 0,
        'restart dispatch must occur while holding the provider mutation transaction');
      restartDispatches += 1;
    },
  });
  assert.deepStrictEqual(restartRetry, [{ id: 60, status: 'armed', restartRequested: true }],
    'a failed or interrupted dispatch must retry only after authoritative negative restart coverage');
  assert.strictEqual(restartDispatches, 1);
  const restartCandidateQuery = restartRetryCalls.find(sql => /SELECT (?:tr\.)?id FROM teleport_requests/.test(sql));
  const restartClaimQuery = restartRetryCalls.find(sql => /SELECT tr\.\* FROM teleport_requests/.test(sql));
  assert.match(restartCandidateQuery, /restart_attempt_count > 0/);
  assert.match(restartCandidateQuery, /cleanup_restart_attempt_count > 0/);
  assert.match(restartCandidateQuery, /log_parse_watermark_at >= tr\.restart_requested_at/);
  assert.match(restartCandidateQuery, /log_parse_watermark_at >= tr\.cleanup_restart_requested_at/);
  assert.match(restartClaimQuery, /restart_attempt_count > 0/);
  assert.match(restartClaimQuery, /cleanup_restart_attempt_count > 0/);
  assert.match(restartClaimQuery, /log_parse_watermark_at >= tr\.restart_requested_at/);
  assert.match(restartClaimQuery, /log_parse_watermark_at >= tr\.cleanup_restart_requested_at/);
  assert(restartRetryCalls.some(sql => /detected_at >= tr\.arm_configured_at/.test(sql)));

  let refundedOrder = null;
  const expiryDb = {
    calls: [],
    async transaction(callback) { return callback(this); },
    async acquireTransactionAdvisoryLock() {},
    async get(sql) {
      if (/FROM provider_mutations/.test(sql)) return null;
      this.calls.push({ sql });
      if (/SELECT tr\.\*, soi\.order_id/.test(sql)) {
        return { id: 61, server_id: 1, guild_id: 2, identity_id: 5,
          requested_by_user_id: 6, status: 'waiting_disconnect', order_id: 10 };
      }
      throw new Error(`Unexpected expiry get: ${sql}`);
    },
    async query(sql) {
      this.calls.push({ sql });
      if (/SELECT (?:tr\.)?id FROM teleport_requests/.test(sql)) return [{ id: 61 }];
      if (/SET refunded_at = clock_timestamp\(\)/.test(sql)) {
        return [{ id: 61, status: 'cancelled', refunded_at: '2026-08-31T15:00:00Z' }];
      }
      throw new Error(`Unexpected expiry query: ${sql}`);
    },
  };
  const expired = await processExpiredTeleports(expiryDb, 1, {
    processRefund: async (_db, orderId, serverId) => {
      refundedOrder = [orderId, serverId];
      return { success: true };
    },
  });
  assert.deepStrictEqual(expired, [{ id: 61, status: 'cancelled', refunded: true }]);
  assert.deepStrictEqual(refundedOrder, [10, 1]);
  const expiryCandidateSql = expiryDb.calls?.find(call => /SELECT (?:tr\.)?id FROM teleport_requests/.test(call.sql))?.sql;
  const expiryClaimSql = expiryDb.calls?.find(call => /SELECT tr\.\*, soi\.order_id/.test(call.sql))?.sql;
  assert.match(expiryCandidateSql || '', /JOIN servers s ON s\.id = tr\.server_id[\s\S]*s\.log_parse_watermark_at >= tr\.expires_at/,
    'expiry candidates require authoritative fetch-start coverage through request expiry');
  assert.match(expiryClaimSql || '', /JOIN servers s ON s\.id = tr\.server_id[\s\S]*s\.log_parse_watermark_at >= tr\.expires_at/,
    'locked expiry recheck requires authoritative fetch-start coverage through request expiry');

  let terminalRefunds = 0;
  const terminalRefundCandidateParams = [];
  const terminalRefundDb = {
    async transaction(callback) { return callback(this); },
    async acquireTransactionAdvisoryLock() {},
    async get(sql) {
      if (/FROM provider_mutations/.test(sql)) return null;
      if (/SELECT tr\.\*, soi\.order_id/.test(sql)) {
        return { id: 62, server_id: 1, guild_id: 2, identity_id: 5,
          requested_by_user_id: 6, status: 'failed', order_id: 11, refunded_at: null };
      }
      throw new Error(`Unexpected terminal-refund get: ${sql}`);
    },
    async query(sql, params) {
      if (/SELECT (?:tr\.)?id FROM teleport_requests/.test(sql)) {
        terminalRefundCandidateParams.push(params);
        return [{ id: 62 }];
      }
      if (/SET refunded_at = clock_timestamp\(\)/.test(sql)) {
        return [{ id: 62, status: 'failed', refunded_at: '2026-08-31T15:00:00Z' }];
      }
      throw new Error(`Unexpected terminal-refund query: ${sql}`);
    },
  };
  const terminalRefund = await processExpiredTeleports(terminalRefundDb, 1, {
    allowLifecycleExpiry: false,
    processRefund: async (_db, orderId, serverId) => {
      terminalRefunds += 1;
      assert.deepStrictEqual([orderId, serverId], [11, 1]);
      return { success: true };
    },
  });
  assert.strictEqual(terminalRefunds, 1);
  assert.deepStrictEqual(terminalRefundCandidateParams, [[1, false]],
    'failed refund replay must run while lifecycle expiry is evidence-gated');
  assert.deepStrictEqual(terminalRefund, [{ id: 62, status: 'failed', refunded: true }]);

  let provisioningRefunds = 0;
  const provisioningExpiryDb = {
    async transaction(callback) { return callback(this); },
    async acquireTransactionAdvisoryLock() {},
    async get(sql) {
      if (/FROM provider_mutations/.test(sql)) return null;
      if (/SELECT tr\.\*, soi\.order_id/.test(sql)) {
        return { id: 63, server_id: 1, guild_id: 2, identity_id: 5,
          requested_by_user_id: 6, status: 'provisioning', order_id: 12,
          mission_dir: '/original-mission' };
      }
      throw new Error(`Unexpected provisioning-expiry get: ${sql}`);
    },
    async query(sql) {
      if (/SELECT (?:tr\.)?id FROM teleport_requests/.test(sql)) return [{ id: 63 }];
      if (/SET status = 'cleanup_pending'/.test(sql)) {
        return [{ id: 63, status: 'cleanup_pending' }];
      }
      throw new Error(`Unexpected provisioning-expiry query: ${sql}`);
    },
  };
  const provisioningExpiry = await processExpiredTeleports(provisioningExpiryDb, 1, {
    processRefund: async () => { provisioningRefunds += 1; return { success: true }; },
  });
  assert.strictEqual(provisioningRefunds, 0);
  assert.deepStrictEqual(provisioningExpiry, [{ id: 63, status: 'cleanup_pending' }]);

  console.log('✅ Teleport processor tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
