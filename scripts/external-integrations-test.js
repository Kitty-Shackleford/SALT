'use strict';

const assert = require('assert');

async function testExternalClientReliability() {
  const { createExternalApiClient, ExternalApiError, classifyError, retryDelayMs } = require('../utils/externalApiClient');
  const { runWithRequestSignal } = require('../utils/requestAbort');

  assert.throws(
    () => createExternalApiClient({ serviceName: 'Broken', baseURL: 'not-a-url' }),
    /base URL/i,
  );
  assert.throws(
    () => createExternalApiClient({ serviceName: 'Broken', baseURL: 'https://example.test', timeoutMs: 0 }),
    /timeout/i,
  );
  assert.throws(
    () => createExternalApiClient({ serviceName: 'Broken', baseURL: 'https://example.test', maxRetries: -1 }),
    /retries/i,
  );
  assert.equal(classifyError({ response: { status: 403, headers: { 'retry-after': '60' } } }), 'rate_limited');
  const secondaryLimit = { response: { status: 403, headers: {}, data: { message: 'You have exceeded a secondary rate limit.' } } };
  assert.equal(classifyError(secondaryLimit), 'rate_limited');
  assert.equal(retryDelayMs(secondaryLimit, 0), 60000, 'secondary GitHub limits require at least a one-minute delay');
  assert.equal(classifyError({ code: 'ERR_CANCELED', name: 'CanceledError' }), 'cancelled');
  const delays = [];
  let attempts = 0;
  const client = createExternalApiClient({
    serviceName: 'Test',
    baseURL: 'https://api.example.test',
    logger: { warn() {} },
    timeoutMs: 2500,
    maxRetries: 2,
    sleep: async ms => delays.push(ms),
    transport: async config => {
      attempts += 1;
      assert.equal(config.timeout, 2500);
      assert.equal(config.url, 'https://api.example.test/resource');
      if (attempts === 1) {
        const error = new Error('busy');
        error.response = { status: 429, headers: { 'retry-after': '2' }, data: { token: 'must-not-leak' } };
        error.config = config;
        throw error;
      }
      return { status: 200, data: { ok: true }, headers: {} };
    },
  });

  const response = await client.request({ method: 'GET', path: '/resource', operation: 'read' });
  assert.equal(response.data.ok, true);
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [2000]);

  let writes = 0;
  const writeClient = createExternalApiClient({
    serviceName: 'Test',
    baseURL: 'https://api.example.test',
    logger: { warn() {} },
    maxRetries: 3,
    transport: async config => {
      writes += 1;
      const error = new Error('upstream body contains a secret');
      error.response = { status: 503, headers: {}, data: { authorization: 'secret' } };
      error.config = config;
      throw error;
    },
  });
  await assert.rejects(
    () => writeClient.request({ method: 'POST', path: '/mutation', data: {}, operation: 'write' }),
    error => error instanceof ExternalApiError
      && error.category === 'upstream'
      && error.status === 503
      && !JSON.stringify(error).includes('secret')
  );
  assert.equal(writes, 1, 'non-idempotent writes must not be retried');

  let longRateLimitAttempts = 0;
  const longRateLimitClient = createExternalApiClient({
    serviceName: 'Test', baseURL: 'https://api.example.test', maxRetries: 2,
    maxRetryDelayMs: 30000, logger: { warn() {} }, sleep: async () => {},
    transport: async () => {
      longRateLimitAttempts += 1;
      const error = new Error('rate limited');
      error.response = { status: 429, headers: { 'retry-after': '120' } };
      throw error;
    },
  });
  await assert.rejects(
    () => longRateLimitClient.request({ method: 'GET', path: '/rate-limited', operation: 'read' }),
    error => error.category === 'rate_limited' && error.retryAfterMs === 120000,
  );
  assert.equal(longRateLimitAttempts, 1, 'client must not retry before a provider Retry-After beyond its delay ceiling');

  const requestAbort = new AbortController();
  let inheritedSignal;
  const contextClient = createExternalApiClient({
    serviceName: 'Test', baseURL: 'https://api.example.test', logger: { warn() {} },
    transport: async config => {
      inheritedSignal = config.signal;
      return { status: 200, data: { ok: true }, headers: {} };
    },
  });
  await runWithRequestSignal(requestAbort.signal, () => contextClient.request({ method: 'GET', path: '/context-signal' }));
  assert.equal(inheritedSignal, requestAbort.signal, 'provider requests must inherit the active HTTP request cancellation signal');

  const retryAbort = new AbortController();
  let releaseRetrySleep;
  let retrySleepStarted;
  const retrySleepReady = new Promise(resolve => { retrySleepStarted = resolve; });
  let cancelledRetryAttempts = 0;
  const cancellableClient = createExternalApiClient({
    serviceName: 'Test', baseURL: 'https://api.example.test', maxRetries: 1,
    logger: { warn() {} },
    sleep: () => {
      retrySleepStarted();
      return new Promise(resolve => { releaseRetrySleep = resolve; });
    },
    transport: async () => {
      cancelledRetryAttempts += 1;
      if (cancelledRetryAttempts === 1) {
        const error = new Error('temporarily unavailable');
        error.response = { status: 503, headers: {} };
        throw error;
      }
      return { status: 200, data: { ok: true }, headers: {} };
    },
  });
  const cancelledRetry = cancellableClient.request({
    method: 'GET', path: '/cancel-retry', operation: 'cancel retry', signal: retryAbort.signal,
  });
  await retrySleepReady;
  retryAbort.abort();
  releaseRetrySleep();
  await assert.rejects(
    () => cancelledRetry,
    error => error instanceof ExternalApiError && error.category === 'cancelled',
  );
  assert.equal(cancelledRetryAttempts, 1, 'caller cancellation must prevent a retry attempt');

  for (const [code, expectedCategory] of [['ETIMEDOUT', 'timeout'], ['ECONNRESET', 'network']]) {
    let failureAttempts = 0;
    const failingClient = createExternalApiClient({
      serviceName: 'Test', baseURL: 'https://api.example.test', maxRetries: 1,
      logger: { warn() {} }, sleep: async () => {},
      transport: async () => {
        failureAttempts += 1;
        const error = new Error('transport failed');
        error.code = code;
        throw error;
      },
    });
    await assert.rejects(
      () => failingClient.request({ method: 'GET', path: '/failure', operation: 'failure' }),
      error => error.category === expectedCategory,
    );
    assert.equal(failureAttempts, 2, `${expectedCategory} read did not use the bounded retry policy`);
  }
}

async function testExternalErrorResponseMapping() {
  const { sendExternalApiError } = require('../utils/externalApiResponse');
  const response = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  sendExternalApiError(response, {
    service: 'GitHub', category: 'rate_limited', retryAfterMs: 2000, code: 'GITHUB_RATE_LIMITED',
  });
  assert.equal(response.statusCode, 429);
  assert.deepEqual(response.body, {
    success: false,
    error: 'GitHub rate limit exceeded',
    code: 'GITHUB_RATE_LIMITED',
    service: 'GitHub',
    category: 'rate_limited',
    retryAfterSeconds: 2,
  });
  response.statusCode = null;
  response.body = null;
  sendExternalApiError(response, { service: 'GitHub', category: 'conflict', code: 'GITHUB_CONFLICT' });
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.category, 'conflict');
  assert.equal(response.body.code, 'GITHUB_CONFLICT');
}

async function testLegacyNitradoTransportReliability() {
  const { createNitradoHttpClient, nitradoFetch, getNitradoFileEntries, getNitradoTransferToken, getNitradoTextBody, resolveMissionBasePath, resolveMissionUploadTarget } = require('../utils/nitradoHttp');
  assert.deepEqual(getNitradoFileEntries({ data: { status: 'success', data: { entries: [] } } }), []);
  assert.throws(() => getNitradoFileEntries({ data: { data: {} } }), error => error.category === 'invalid_response');
  assert.throws(() => getNitradoFileEntries({ data: { data: { entries: [{}] } } }), error => error.category === 'invalid_response');
  assert.deepEqual(getNitradoTransferToken({ data: { status: 'success', data: { token: { url: 'https://files.example/upload', token: 'opaque' } } } }, { requireToken: true }), { url: 'https://files.example/upload', token: 'opaque' });
  assert.throws(() => getNitradoTransferToken({ data: { data: { token: { url: 'https://files.example/download' } } } }), error => error.category === 'invalid_response');
  assert.throws(() => getNitradoTransferToken({ data: { data: { token: { url: 'javascript:alert(1)' } } } }), error => error.category === 'invalid_response');
  assert.throws(() => getNitradoTransferToken({ data: { data: { token: { url: 'https://files.example/upload' } } } }, { requireToken: true }), error => error.category === 'invalid_response');
  assert.throws(() => getNitradoTransferToken({ data: { status: 'error', data: { token: { url: 'https://files.example/upload' } } } }), error => error.category === 'invalid_response');
  assert.equal(getNitradoTextBody({ data: '<types />' }), '<types />');
  assert.throws(() => getNitradoTextBody({ data: {} }), error => error.category === 'invalid_response');
  assert.equal(resolveMissionBasePath({ game: 'dayzxb', game_specific: { path: '/games/ni1_1/noftp/dayzxb/' } }), '/games/ni1_1/ftproot/dayzxb_missions');
  assert.equal(resolveMissionBasePath({ game: 'dayzps', game_specific: { path: '/games/ni1_1/noftp/dayzps/' } }), '/games/ni1_1/ftproot/dayzps_missions');
  assert.equal(resolveMissionBasePath({ game: 'dayzswitch', game_specific: { path: '/games/ni1_1/noftp/dayzswitch/' } }), '/games/ni1_1/ftproot/dayzswitch_missions');
  assert.equal(resolveMissionBasePath({ game: 'dayzstandalone', game_specific: { path: '/games/ni1_1/ftproot/dayzstandalone/' } }), '/games/ni1_1/ftproot/dayzstandalone/mpmissions');
  assert.equal(resolveMissionBasePath({ game: 'dayz', game_specific: { path: '/games/ni1_1/noftp/dayz/' } }), '/games/ni1_1/noftp/dayz/mpmissions');
  assert.throws(
    () => resolveMissionBasePath({ game: 'dayz', game_specific: { path: '/games/ni1/../../tenant-b' } }),
    error => error.category === 'invalid_response',
    'provider mission metadata must be canonical and traversal-free',
  );
  assert.deepEqual(
    resolveMissionUploadTarget('/noftp/dayz/mpmissions', 'dayzOffline.chernarusplus', 'dayzOffline.chernarusplus/db/types.xml'),
    { directory: '/noftp/dayz/mpmissions/dayzOffline.chernarusplus/db', fileName: 'types.xml' },
    'nested mission uploads must send the containing directory separately from the basename',
  );
  const delays = [];
  let reads = 0;
  const client = createNitradoHttpClient(2500, {
    apiBaseUrl: 'https://nitrado-proxy.example.test',
    maxRetries: 1,
    sleep: async ms => delays.push(ms),
  });
  const adapter = async config => {
    reads += 1;
    assert(config.url.startsWith('https://nitrado-proxy.example.test/'));
    if (reads === 1) {
      const error = new Error('busy');
      error.config = config;
      error.response = { status: 503, headers: {}, data: {} };
      throw error;
    }
    return { data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config };
  };
  const result = await client.get('https://api.nitrado.net/services', { adapter });
  assert.equal(result.data.ok, true);
  assert.equal(reads, 2);
  assert.deepEqual(delays, [250]);

  let writes = 0;
  await assert.rejects(
    () => client.post('https://api.nitrado.net/services/1/restart', {}, {
      adapter: async config => {
        writes += 1;
        const error = new Error('busy');
        error.config = config;
        error.response = { status: 503, headers: {}, data: {} };
        throw error;
      },
    }),
    error => error.code === 'NITRADO_REQUEST_FAILED',
  );
  assert.equal(writes, 1, 'legacy Nitrado mutations must not be retried');

  const rateLimitedClient = createNitradoHttpClient(2500, {
    maxRetries: 0,
    apiBaseUrl: 'https://nitrado-proxy.example.test',
  });
  await assert.rejects(
    () => rateLimitedClient.get('https://api.nitrado.net/services', {
      adapter: async config => {
        const error = new Error('limited');
        error.config = config;
        error.response = { status: 429, headers: { 'retry-after': '120' }, data: { message: 'sensitive upstream detail' } };
        throw error;
      },
    }),
    error => error.code === 'NITRADO_RATE_LIMITED' && error.category === 'rate_limited' && error.retryAfterMs === 120000,
  );

  const fetchAbort = new AbortController();
  fetchAbort.abort();
  await assert.rejects(
    () => nitradoFetch('https://api.nitrado.net/services', { signal: fetchAbort.signal }, async () => {
      throw new DOMException('aborted', 'AbortError');
    }),
    error => error.code === 'NITRADO_CANCELLED' && error.category === 'cancelled',
  );

  const retryAbort = new AbortController();
  let markSleepStarted;
  const sleepStarted = new Promise(resolve => { markSleepStarted = resolve; });
  const abortableClient = createNitradoHttpClient(2500, {
    maxRetries: 1,
    sleep: async () => {
      markSleepStarted();
      return new Promise(() => {});
    },
  });
  const pendingRequest = abortableClient.get('https://api.nitrado.net/services', {
    signal: retryAbort.signal,
    adapter: async config => {
      const error = new Error('busy');
      error.config = config;
      error.response = { status: 503, headers: {}, data: {} };
      throw error;
    },
  });
  await sleepStarted;
  retryAbort.abort();
  await Promise.race([
    assert.rejects(pendingRequest, error => error.code === 'NITRADO_CANCELLED'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Nitrado retry wait ignored cancellation')), 100)),
  ]);

  let fetchReads = 0;
  const fetchResult = await nitradoFetch(
    'https://api.nitrado.net/services',
    { method: 'GET' },
    async url => {
      fetchReads += 1;
      assert(url.startsWith('https://nitrado-proxy.example.test/'));
      return fetchReads === 1
        ? { ok: false, status: 503, headers: { get() { return null; } } }
        : { ok: true, status: 200, headers: { get() { return null; } } };
    },
    2500,
    { apiBaseUrl: 'https://nitrado-proxy.example.test', maxRetries: 1, sleep: async () => {} },
  );
  assert.equal(fetchResult.ok, true);
  assert.equal(fetchReads, 2);
  assert.throws(
    () => createNitradoHttpClient(2500, { apiBaseUrl: 'http://attacker.example' }),
    /HTTPS unless it targets local loopback/,
    'Nitrado API overrides must not carry bearer tokens over plaintext HTTP',
  );
}

async function testNitradoMissingFileClassification() {
  const axios = require('../utils/nitradoHttp');
  const missionFileService = require('../services/missionFileService');
  const originalGet = axios.get;
  const filePath = '/games/ni1_1/ftproot/dayzxb_missions/mission/custom/shop_events.xml';
  const missingError = new Error('Nitrado request failed (500)');
  missingError.response = { status: 500 };

  try {
    axios.get = async (url, config) => {
      if (url.endsWith('/file_server/download')) throw missingError;
      assert(url.endsWith('/file_server/list'));
      assert.equal(config.params.dir, '/games/ni1_1/ftproot/dayzxb_missions/mission/custom');
      return { data: { status: 'success', data: { entries: [] } } };
    };
    assert.equal(
      await missionFileService.downloadFileFromServer(1, filePath, 'test-token'),
      null,
      'Nitrado 500 for a confirmed absent file must allow first-time file creation'
    );

    axios.get = async url => {
      if (url.endsWith('/file_server/download')) throw missingError;
      return { data: { status: 'success', data: { entries: [{
        name: 'shop_events.xml', type: 'file', size: 10, path: filePath,
      }] } } };
    };
    await assert.rejects(
      () => missionFileService.downloadFileFromServer(1, filePath, 'test-token'),
      error => error === missingError,
      'Nitrado 500 for a listed file must remain a provider failure'
    );
  } finally {
    axios.get = originalGet;
  }
}

function testContainedMissionPaths() {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const {
    ensureContainedDirectorySync,
    readContainedFileSync,
    resolveContainedPath,
    resolveWritableContainedPath,
    writeContainedFileAtomicSync,
    writeContainedFileSync,
  } = require('../utils/safePath');
  const { assertMissionPathComponent, getNitradoFileEntries } = require('../utils/nitradoHttp');
  const root = '/srv/dayz/server_10';
  assert.equal(resolveContainedPath(root, 'mission/types.xml'), '/srv/dayz/server_10/mission/types.xml');
  assert.throws(() => resolveContainedPath(root, '../../../../../etc/passwd'), /outside/i);
  assert.throws(() => resolveContainedPath(root, '/etc/passwd'), /outside/i);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-containment-'));
  const writableRoot = path.join(tempRoot, 'root');
  const outsideRoot = path.join(tempRoot, 'outside');
  fs.mkdirSync(writableRoot);
  fs.mkdirSync(outsideRoot);
  fs.symlinkSync(outsideRoot, path.join(writableRoot, 'link'));
  assert.throws(
    () => resolveWritableContainedPath(writableRoot, 'link/escaped.xml'),
    /outside/i,
    'writable mission paths must reject symlinked parents outside the server root',
  );
  const outsideFile = path.join(outsideRoot, 'outside.txt');
  fs.writeFileSync(outsideFile, 'unchanged');
  fs.symlinkSync(outsideFile, path.join(writableRoot, 'destination.txt'));
  assert.throws(
    () => writeContainedFileSync(writableRoot, 'destination.txt', 'overwritten'),
    /symbolic link|outside|invalid/i,
    'contained writes must not follow an existing destination symlink',
  );
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'unchanged');

  const atomicPath = path.join(writableRoot, 'atomic.txt');
  fs.writeFileSync(atomicPath, 'previous');
  const originalWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = (...args) => {
    if (typeof args[0] === 'number') throw new Error('simulated disk write failure');
    return originalWriteFileSync(...args);
  };
  try {
    assert.throws(
      () => writeContainedFileAtomicSync(writableRoot, 'atomic.txt', 'replacement'),
      /simulated disk write failure/,
    );
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }
  assert.equal(fs.readFileSync(atomicPath, 'utf8'), 'previous', 'failed atomic replacement must preserve the prior file');
  assert.equal(fs.readdirSync(writableRoot).some(name => name.endsWith('.tmp')), false, 'failed atomic writes must clean up temporary files');
  writeContainedFileAtomicSync(writableRoot, 'atomic.txt', 'replacement');
  assert.equal(fs.readFileSync(atomicPath, 'utf8'), 'replacement');

  const directoryRoot = path.join(tempRoot, 'directory-root');
  fs.mkdirSync(directoryRoot);
  fs.symlinkSync(outsideRoot, path.join(directoryRoot, 'link'));
  assert.throws(
    () => ensureContainedDirectorySync(directoryRoot, 'link/provider-dir'),
    /symbolic link|outside|invalid/i,
    'contained directory creation must not follow a pre-existing parent symlink',
  );
  assert.equal(fs.existsSync(path.join(outsideRoot, 'provider-dir')), false);
  const symlinkRoot = path.join(tempRoot, 'symlink-root');
  fs.symlinkSync(outsideRoot, symlinkRoot);
  assert.throws(
    () => ensureContainedDirectorySync(symlinkRoot, 'provider-dir'),
    /symbolic link|outside|invalid/i,
    'the authorized root itself must not be a symbolic link',
  );
  assert.equal(fs.existsSync(path.join(outsideRoot, 'provider-dir')), false);
  const safeReadPath = path.join(writableRoot, 'safe-read.txt');
  fs.writeFileSync(safeReadPath, 'safe');
  assert.equal(readContainedFileSync(writableRoot, 'safe-read.txt', 'utf8'), 'safe');
  fs.unlinkSync(safeReadPath);
  fs.symlinkSync(outsideFile, safeReadPath);
  assert.throws(
    () => readContainedFileSync(writableRoot, 'safe-read.txt', 'utf8'),
    /symbolic link|outside|invalid/i,
    'contained reads must not follow a replacement destination symlink',
  );
  for (const unsafeMission of ['.', '..', 'folder/name', 'folder\\name', 'bad\0name', '']) {
    assert.throws(
      () => assertMissionPathComponent(unsafeMission),
      error => error.category === 'invalid_response',
      `active mission names must be canonical path components: ${JSON.stringify(unsafeMission)}`,
    );
  }
  assert.equal(assertMissionPathComponent('dayzOffline.chernarusplus'), 'dayzOffline.chernarusplus');
  assert.throws(
    () => require('../utils/nitradoHttp').resolveMissionUploadTarget(
      '/noftp/dayz/mpmissions',
      '../escape',
      'dayzOffline.chernarusplus/db/types.xml',
    ),
    error => error.category === 'invalid_response',
    'provider mission metadata must be validated even when the requested upload path is nested',
  );
  fs.rmSync(tempRoot, { recursive: true, force: true });
  const missionRoute = fs.readFileSync(require.resolve('../routes/missionFiles'), 'utf8');
  assert(missionRoute.includes('resolveWritableContainedPath(serverRoot, fileName)'), 'Mission file writes do not reject symlinked parents outside the server root');
  assert(missionRoute.includes('resolveExistingContainedPath(backupDir, backupPath)'), 'Mission backup restore does not constrain backup paths');
  assert.throws(
    () => getNitradoFileEntries({ data: { status: 'success', data: { entries: [{ type: 'file', name: '../../outside.txt', path: '/ftproot/outside.txt' }] } } }),
    error => error.category === 'invalid_response',
    'Nitrado file entry names must not escape the local download root',
  );
  for (const unsafePath of ['/safe/../secret.txt', '//evil/path', '/safe/../../etc/passwd']) {
    assert.throws(
      () => getNitradoFileEntries({ data: { status: 'success', data: { entries: [{ type: 'file', name: 'safe.txt', path: unsafePath, size: 1 }] } } }),
      error => error.category === 'invalid_response',
      `Nitrado file entry path must be canonical: ${unsafePath}`,
    );
  }
  assert.throws(
    () => getNitradoFileEntries({ data: { status: 'success', data: { entries: [{ type: 'file', name: 'safe.txt', path: '/safe/safe.txt' }] } } }),
    error => error.category === 'invalid_response',
    'Nitrado file entries must include the documented numeric size',
  );
  assert.throws(
    () => getNitradoFileEntries({ data: { status: 'error', data: { entries: [] } } }),
    error => error.category === 'invalid_response',
    'explicit Nitrado file-list failures must fail closed',
  );
}

function testLegacyNitradoFileContracts() {
  const fs = require('fs');
  const economySource = fs.readFileSync(require.resolve('../services/economyOverrideService'), 'utf8');
  const rotationSource = fs.readFileSync(require.resolve('../services/rotationService'), 'utf8');
  const logSyncSource = fs.readFileSync(require.resolve('../services/logSyncService'), 'utf8');
  const botStatusSource = fs.readFileSync(require.resolve('../bot/services/serverStatusService'), 'utf8');
  const missionSource = fs.readFileSync(require.resolve('../services/missionFileService'), 'utf8');
  const nitradoFileSource = fs.readFileSync(require.resolve('../services/nitradoFileService'), 'utf8');
  const missionRouteSource = fs.readFileSync(require.resolve('../routes/missionFiles'), 'utf8');
  assert(economySource.includes("{ path: path.dirname(folderPath), name: path.basename(folderPath) }"), 'Economy mkdir must send documented path and name fields');
  assert(economySource.includes("formData.append('path', path.dirname(filePath))") && economySource.includes("formData.append('file', path.basename(filePath))"), 'Economy upload token request must send documented path and file fields');
  assert(economySource.includes('await axios.post(uploadUrl, content') && economySource.includes("'token': uploadToken"), 'Economy transfer upload must POST raw content with the signed token');
  assert(economySource.includes("assertNitradoSuccess(response, 'Nitrado returned an invalid create-directory response')"), 'Economy mkdir must reject malformed successful responses');
  assert(rotationSource.includes('data: { path: filePath }'), 'Rotation deletion must send the documented path field');
  assert(rotationSource.includes("assertNitradoSuccess(response, 'Nitrado returned an invalid delete response')"), 'Rotation deletion must reject malformed successful responses');
  assert(logSyncSource.includes('getNitradoBinaryBody(fileRes)'), 'Log sync must validate direct transfer bodies before writing');
  assert(botStatusSource.includes('getNitradoTransferToken(tokenRes)') && botStatusSource.includes('getNitradoTextBody(fileRes)'), 'Bot file downloads must validate transfer envelopes and text bodies');
  assert.match(botStatusSource, /resolveMissionBasePath\s*}\s*=\s*require\(['"]\.\.\/\.\.\/utils\/nitradoHttp['"]\)/,
    'Bot status mission paths must use the shared strict resolver');
  assert.doesNotMatch(botStatusSource, /function\s+resolveMissionBasePath\s*\(/,
    'Bot status must not retain a permissive local mission resolver');
  assert(missionSource.includes('uploadFileToServer(serverId, path.dirname(filePath), path.basename(filePath), content, nitradoToken)'), 'Mission writes must pass upload directory, filename, content, and token in the declared order');
  assert(nitradoFileSource.includes('writeContainedFileSync(authorizedLocalRoot'), 'Recursive Nitrado downloads must use no-follow contained writes');
  assert(nitradoFileSource.includes('ensureContainedDirectorySync(authorizedLocalRoot'), 'Recursive Nitrado downloads must create directories through the authorized root descriptor');
  assert(logSyncSource.includes('writeContainedFileAtomicSync(DOWNLOAD_ROOT'), 'Log downloads must use atomic no-follow contained writes');
  assert(logSyncSource.includes('ensureContainedDirectorySync(DOWNLOAD_ROOT'), 'Log sync directories must be created through the authorized root descriptor');
  assert.match(missionRouteSource, /writeContainedFileAtomicSync\(\s*serverRoot/,
    'Mission writes must use atomic no-follow contained writes');
  assert(missionRouteSource.includes('readContainedFileSync(backupDir'), 'Mission backup restores must use no-follow contained reads');
  assert.match(missionRouteSource, /writeContainedFileSync\(\s*backupRoot/,
    'Mission backup writes must use no-follow contained writes');
  assert(missionSource.includes('assertMissionPathComponent(mission)'), 'Mission service must validate provider-derived active mission names');
  assert(economySource.includes('assertMissionPathComponent(mission)'), 'Economy service must validate provider-derived active mission names');
  assert(rotationSource.includes('assertMissionPathComponent(mission)'), 'Rotation service must validate provider-derived active mission names');
}

async function testNitradoServiceModelsAndOperations() {
  const calls = [];
  const { createNitradoService } = require('../services/nitradoService');
  const service = createNitradoService({
    request: async config => {
      calls.push(config);
      if (config.path === '/services') {
        return { data: { status: 'success', data: { services: [{ id: 10, status: 'active', type: 'gameserver', details: { name: 'Saltskrew', game: 'DayZ', folder_short: 'dayzxb', address: '1.2.3.4:2302' } }] } }, headers: {} };
      }
      if (config.path === '/user') {
        return { data: { status: 'success', data: { user: { id: 77, username: 'kitty' } } }, headers: {} };
      }
      if (config.path === '/services/10/gameservers') {
        return { data: { status: 'success', data: { gameserver: { service_id: 10, status: 'started', slots: 60, label: 'SALT', game_human: 'DayZ', last_status_change: 123, query: { player_current: 4, player_max: 60, map: 'dayzOffline.chernarusplus', version: '1.2.3' }, settings: { config: { enableWhitelist: '1' } } } } }, headers: {} };
      }
      if (config.path === '/services/10/gameservers/games/players') {
        return { data: { status: 'success', data: { players: [{ id: 'abc', name: 'Player', online: 'false' }] } }, headers: {} };
      }
      if (config.path === '/services/10/gameservers/restart') {
        return { data: { status: 'success', message: 'restart initiated' }, headers: {} };
      }
      if (config.path === '/services/10/gameservers/app_server/command') return { data: { status: 'success', message: 'Command sent' }, headers: {} };
      if (config.path === '/services/10/gameservers/boost/history') return { data: { status: 'success', data: { boosts: [], boosts_count: 0, boosts_per_page: 20, current_page: 1, page_count: 1 } }, headers: {} };
      if (config.path === '/services/10/gameservers/boost' && config.method === 'GET') return { data: { status: 'success', boosting: { enabled: true, code: 'abc', message: '', welcome_message: '' } }, headers: {} };
      if (config.path === '/services/10/gameservers/boost' && config.method === 'PUT') return { data: { status: 'success', boosting: { enabled: true, code: 'abc', message: '', welcome_message: '' } }, headers: {} };
      if (config.path === '/services/10/gameservers/backups') return { data: { status: 'success', data: { backups: { gameserver: {}, database: {} } } }, headers: {} };
      if (config.path === '/services/10/gameservers/backups/gameserver') return { data: { status: 'success', message: 'Restore initiated' }, headers: {} };
      if (config.path === '/services/10/gameservers/backups/database') return { data: { status: 'success' }, headers: {} };
      if (config.path === '/support/channels') return { data: { status: 'success', data: { support_channels: { chat: { status: 'enabled' } } } }, headers: {} };
      throw new Error(`unexpected ${config.path}`);
    },
  });

  const servers = await service.listGameServers('token');
  assert.deepEqual(servers, [{ id: '10', name: 'Saltskrew', status: 'active', type: 'gameserver', game: 'DayZ', gameFolder: 'dayzxb', platform: 'xbox', address: '1.2.3.4:2302' }]);
  assert.deepEqual(await service.getAuthenticatedUser('token'), { id: '77', username: 'kitty' });

  const status = await service.getServerStatus('token', 10);
  assert.deepEqual(status, {
    id: '10', status: 'started', name: 'SALT', game: 'DayZ', map: 'Chernarus', version: '1.2.3',
    playerCurrent: 4, playerMax: 60, lastStatusChange: 123, whitelist: true, crosshair: true, thirdPerson: true,
  });

  const players = await service.listPlayers('token', 10);
  assert.deepEqual(players, [{ id: 'abc', name: 'Player', online: false }]);

  const action = await service.controlServer('token', 10, 'restart');
  assert.equal(action.message, 'restart initiated');
  assert.equal(calls.at(-1).method, 'POST');
  await assert.rejects(() => service.controlServer('token', 10, 'destroy'), /Unsupported Nitrado server action/);
  assert.equal((await service.command('token', 10, 'status')).message, 'Command sent');
  assert(calls.some(call => call.path === '/services/10/gameservers/app_server/command'), 'Nitrado console command must use the documented app_server endpoint');
  assert.equal((await service.getBoostHistory('token', 10, 1)).status, 'success');
  assert.equal((await service.getBoostSettings('token', 10)).status, 'success');
  assert.equal((await service.updateBoostSettings('token', 10, { enabled: true })).status, 'success');
  assert.equal(calls.find(call => call.path === '/services/10/gameservers/boost' && call.method === 'PUT').data.enable, 0, 'Nitrado boost enable semantics must follow the provider contract');
  assert.deepEqual(await service.listBackups('token', 10), { gameserver: {}, database: {} });
  assert.equal((await service.restoreGameserverBackup('token', 10, 'mission', 'timestamp')).message, 'Restore initiated');
  assert.equal((await service.restoreDatabaseBackup('token', 10, 'database', 'timestamp')).message, 'Database restore initiated');
  assert.deepEqual((await service.getSupportChannels()).data.support_channels, { chat: { status: 'enabled' } });
  assert(calls.filter(call => call.path !== '/support/channels').every(call => call.headers.Authorization === 'Bearer token'));
  assert(!calls.find(call => call.path === '/support/channels').headers?.Authorization, 'public support request must not receive a tenant token');

  const malformed = createNitradoService({ request: async () => ({ data: { data: {} }, headers: {} }), cacheTtlMs: 1 });
  await assert.rejects(
    () => malformed.listServices('token'),
    error => error.category === 'invalid_response' && !error.message.includes('token'),
  );
  for (const invoke of [
    () => malformed.listPlayers('token', 10),
    () => malformed.updateSetting('token', 10, 'general', 'name', 'test'),
    () => malformed.controlServer('token', 10, 'restart'),
    () => malformed.command('token', 10, 'status'),
    () => malformed.createTask('token', 10, { minute: '0', hour: '4', action_method: 'restart' }),
    () => malformed.updateTask('token', 10, 3, { minute: '0', hour: '4', action_method: 'restart' }),
    () => malformed.deleteTask('token', 10, 3),
    () => malformed.getNotifications('token', 10),
    () => malformed.getStats('token', 10),
    () => malformed.getLogs('token', 10),
    () => malformed.availableTasks('token', 10),
    () => malformed.listTasks('token', 10),
    () => malformed.getBoostHistory('token', 10),
    () => malformed.getBoostSettings('token', 10),
    () => malformed.updateBoostSettings('token', 10, { enabled: true }),
    () => malformed.listBackups('token', 10),
    () => malformed.restoreGameserverBackup('token', 10, 'mission', 'timestamp'),
    () => malformed.restoreDatabaseBackup('token', 10, 'database', 'timestamp'),
    () => malformed.getSupportChannels(),
  ]) {
    await assert.rejects(invoke, error => error.category === 'invalid_response');
  }

  const malformedNitradoResources = [
    ['services', service => service.listServices('token'), { data: { services: [{}] } }],
    ['DayZ services', service => service.listGameServers('token'), { data: { services: [{ details: { game: 'DayZ' } }] } }],
    ['gameserver', service => service.getRawGameserver('token', 10), { data: { gameserver: {} } }],
    ['service details', service => service.getServiceDetails('token', 10), { data: { service: {} } }],
    ['players', service => service.listPlayers('token', 10), { data: { players: [{}] } }],
    ['settings', service => service.getSettings('token', 10), { data: { settings: [] } }],
    ['notifications', service => service.getNotifications('token', 10), { data: { notifications: [{}] } }],
    ['logs', service => service.getLogs('token', 10), { data: { logs: [{}] } }],
    ['available tasks', service => service.availableTasks('token', 10), { data: { tasks: [{}] } }],
    ['tasks', service => service.listTasks('token', 10), { data: { tasks: [{}] } }],
  ];
  for (const [label, invoke, payload] of malformedNitradoResources) {
    const malformedResource = createNitradoService({ request: async () => ({ data: payload, headers: {} }) });
    await assert.rejects(
      () => invoke(malformedResource),
      error => error.category === 'invalid_response',
      `malformed Nitrado ${label} must fail closed`,
    );
  }

  for (const [label, invoke, payload] of [
    ['mismatched gameserver', service => service.getRawGameserver('token', 10), { data: { gameserver: { service_id: 999 } } }],
    ['mismatched service', service => service.getServiceDetails('token', 10), { data: { service: { id: 999 } } }],
    ['mismatched notification', service => service.getNotifications('token', 10), { data: { notifications: [{ id: 1, service_id: 999, message: 'wrong service' }] } }],
  ]) {
    const mismatchedResource = createNitradoService({ request: async () => ({ data: payload, headers: {} }) });
    await assert.rejects(
      () => invoke(mismatchedResource),
      error => error.category === 'invalid_response',
      `${label} must fail closed`,
    );
  }

  const explicitMutationFailure = createNitradoService({
    request: async () => ({ data: { status: 'error', message: 'restore failed' }, headers: {} }),
  });
  await assert.rejects(
    () => explicitMutationFailure.restoreGameserverBackup('token', 10, 'mission', 'timestamp'),
    error => error.category === 'invalid_response',
    'explicit Nitrado mutation failure must not be accepted as success',
  );
  const statuslessMutation = createNitradoService({
    request: async () => ({ data: { message: 'looks successful' }, headers: {} }),
  });
  await assert.rejects(
    () => statuslessMutation.controlServer('token', 10, 'restart'),
    error => error.category === 'invalid_response',
    'Nitrado mutations must require an explicit successful outer status',
  );
  for (const [label, invoke, payload] of [
    ['boost history fields', service => service.getBoostHistory('token', 10), { status: 'success', data: {} }],
    ['boost settings fields', service => service.getBoostSettings('token', 10), { status: 'success', boosting: {} }],
    ['backup collections', service => service.listBackups('token', 10), { data: { backups: { gameserver: { mission: [{}] }, database: {} } } }],
  ]) {
    const shallowSuccess = createNitradoService({ request: async () => ({ data: payload, headers: {} }) });
    await assert.rejects(() => invoke(shallowSuccess), error => error.category === 'invalid_response', `malformed ${label} must fail closed`);
  }
  const documentedBackups = createNitradoService({ request: async () => ({ data: { status: 'success', data: { backups: {
    gameserver: { dayz: [{ backup_type: 'master', backup_timestamp: 1, backup_number: 2, backup_size: 3 }] },
    database: { mysql: [{ backup_file: 'db.sql.gz', backup_timestamp: 1, backup_size: 3 }] },
  } } }, headers: {} }) });
  assert.equal((await documentedBackups.listBackups('token', 10)).database.mysql[0].backup_file, 'db.sql.gz');

  for (const invoke of [
    service => service.listServices('token'),
    service => service.listBackups('token', 10),
  ]) {
    const explicitReadFailure = createNitradoService({ request: async () => ({ data: {
      status: 'error',
      data: { services: [], backups: { gameserver: {}, database: {} } },
    }, headers: {} }) });
    await assert.rejects(
      () => invoke(explicitReadFailure),
      error => error.category === 'invalid_response',
      'explicit Nitrado read failures must fail closed',
    );
  }

  const malformedSupport = createNitradoService({ request: async () => ({ data: {
    status: 'success',
    data: { support_channels: { '<img src=x onerror=alert(1)>': { status: 'enabled' }, phone: {
      status: 'enabled', contacts: [{ contact: '+1', slots: [{ languages: 'en', duration: 'bad', timezone: '<img>' }] }],
    } } },
  }, headers: {} }) });
  await assert.rejects(
    () => malformedSupport.getSupportChannels(),
    error => error.category === 'invalid_response',
    'malformed support channel fields must fail closed',
  );
  const supportWithoutCron = createNitradoService({ request: async () => ({ data: {
    status: 'success',
    data: { support_channels: { phone: {
      status: 'enabled', contacts: [{ contact: '+1', slots: [{ languages: ['en'], duration: 60, timezone: 'UTC' }] }],
    } } },
  }, headers: {} }) });
  await assert.rejects(
    () => supportWithoutCron.getSupportChannels(),
    error => error.category === 'invalid_response',
    'support slots must include the documented cronFrom field',
  );

  let boundedCacheCalls = 0;
  const boundedCache = createNitradoService({
    cacheMaxEntries: 2,
    request: async () => {
      boundedCacheCalls += 1;
      return { data: { status: 'success', data: { services: [] } }, headers: {} };
    },
  });
  await boundedCache.listServices('token-a');
  await boundedCache.listServices('token-b');
  await boundedCache.listServices('token-c');
  await boundedCache.listServices('token-a');
  assert.equal(boundedCacheCalls, 4, 'Nitrado cache must evict old credential-scoped entries');
}

async function testGitHubServicePaginationAndModels() {
  const calls = [];
  const crypto = require('crypto');
  const gitBlobSha = content => {
    const bytes = Buffer.from(content);
    return crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  };
  const { createGitHubService } = require('../services/githubService');
  const { ExternalApiError } = require('../utils/externalApiClient');
  const service = createGitHubService({
    request: async config => {
      calls.push(config);
      if (config.path === '/user') return { data: { login: 'kitty', id: 7, avatar_url: 'https://example/avatar' }, headers: {} };
      if (config.path === '/user/repos' && config.params.page === 1) {
        return { data: [{ id: 1, full_name: 'kitty/dayz', name: 'dayz', private: true, default_branch: 'main', owner: { login: 'kitty' }, html_url: 'https://github.com/kitty/dayz', updated_at: '2026-01-01' }], headers: { link: '<https://api.github.com/user/repos?page=2>; rel="next"' } };
      }
      if (config.path === '/user/repos' && config.params.page === 2) {
        return { data: [{ id: 2, full_name: 'kitty/tools', name: 'tools', private: false, default_branch: 'trunk', owner: { login: 'kitty' }, html_url: 'https://github.com/kitty/tools', updated_at: '2026-01-02' }], headers: {} };
      }
      if (config.path === '/repos/kitty/dayz/commits') {
        return { data: [{ sha: 'abc', html_url: 'https://github/commit/abc', commit: { message: 'ship', author: { name: 'Kitty', date: '2026-01-03' } }, author: { login: 'kitty' } }], headers: {} };
      }
      if (config.path === '/repos/kitty/dayz/releases') {
        return { data: [{ id: 9, tag_name: 'v1', name: 'One', draft: false, prerelease: false, html_url: 'https://github/release/v1', published_at: '2026-01-04' }], headers: {} };
      }
      if (config.path === '/repos/kitty/dayz/actions/workflows') {
        return { data: { workflows: [{ id: 3, name: 'CI', path: '.github/workflows/ci.yml', state: 'active', html_url: 'https://github/actions' }] }, headers: {} };
      }
      if (config.path === '/repos/kitty/dayz/actions/workflows/3/runs') {
        return { data: { workflow_runs: [{ id: 4, name: 'CI', status: 'completed', conclusion: 'success', event: 'push', head_branch: 'main', head_sha: 'abc', html_url: 'https://github/run/4', created_at: '2026-01-05', updated_at: '2026-01-05' }] }, headers: {} };
      }
      if (config.path === '/repos/kitty/dayz/git/ref/heads/feature%2Fbase') {
        return { data: { ref: 'refs/heads/feature/base', object: { sha: 'base-sha' } }, headers: {} };
      }
      if (config.path === '/repos/kitty/dayz/git/refs') return { data: { ref: 'refs/heads/ai-edit/1', object: { sha: 'base-sha' } }, headers: {} };
      throw new Error(`unexpected ${config.path}`);
    },
  });

  assert.deepEqual(await service.getAuthenticatedUser('token'), { login: 'kitty', id: 7, avatarUrl: 'https://example/avatar' });
  const repos = await service.listRepos('token', { allPages: true });
  assert.equal(repos.length, 2);
  assert.deepEqual(repos[0], { id: 1, fullName: 'kitty/dayz', name: 'dayz', owner: 'kitty', defaultBranch: 'main', private: true, url: 'https://github.com/kitty/dayz', updatedAt: '2026-01-01' });
  assert.equal((await service.listCommits('token', 'kitty', 'dayz'))[0].sha, 'abc');
  assert.equal((await service.listReleases('token', 'kitty', 'dayz'))[0].tagName, 'v1');
  assert.equal((await service.listWorkflows('token', 'kitty', 'dayz'))[0].name, 'CI');
  assert.equal((await service.listWorkflowRuns('token', 'kitty', 'dayz', 3))[0].conclusion, 'success');
  assert.equal(await service.createBranch('token', 'kitty', 'dayz', 'feature/base', 'ai-edit/1'), 'base-sha');
  assert(calls.every(call => call.headers.Authorization === 'Bearer token'));

  const malformed = createGitHubService({ request: async () => ({ data: {}, headers: {} }) });
  await assert.rejects(
    () => malformed.listRepos('token', { allPages: true }),
    error => error.category === 'invalid_response' && error.operation.includes('/user/repos'),
  );
  await assert.rejects(
    () => malformed.getRepository('token', 'owner', 'repo'),
    error => error.category === 'invalid_response' && error.operation === 'get repository',
  );
  await assert.rejects(
    () => malformed.commitFile('token', 'owner', 'repo', 'main', 'types.xml', '<types/>', 'update'),
    error => error.category === 'invalid_response' && error.operation === 'commit repository file',
  );
  const mismatchedRepository = createGitHubService({ request: async () => ({
    data: { id: 1, full_name: 'evil/other', name: 'other', owner: { login: 'evil' } }, headers: {},
  }) });
  await assert.rejects(
    () => mismatchedRepository.getRepository('token', 'owner', 'repo'),
    error => error.category === 'invalid_response' && error.operation === 'get repository',
  );
  const wrongBlob = createGitHubService({ request: async () => ({
    data: { commit: { sha: 'commit-sha' }, content: { sha: 'definitely-wrong', path: 'types.xml' } }, headers: {},
  }) });
  await assert.rejects(
    () => wrongBlob.commitFile('token', 'owner', 'repo', 'main', 'types.xml', '<types/>', 'update'),
    error => error.category === 'invalid_response' && error.operation === 'commit repository file',
  );
  await assert.rejects(
    () => malformed.createPR('token', 'owner', 'repo', 'main', 'feature', 'title', 'body'),
    error => error.category === 'invalid_response' && error.operation === 'create pull request',
  );
  const mismatchedBranch = createGitHubService({ request: async config => {
    if (config.method === 'GET') return { data: { ref: 'refs/heads/main', object: { sha: 'base-sha' } }, headers: {} };
    return { data: { ref: 'refs/heads/wrong', object: { sha: 'wrong-sha' } }, headers: {} };
  } });
  await assert.rejects(
    () => mismatchedBranch.createBranch('token', 'owner', 'repo', 'main', 'ai-edit/1'),
    error => error.category === 'invalid_response' && error.operation === 'create branch',
  );
  const malformedLists = createGitHubService({ request: async config => {
    if (config.path.endsWith('/actions/workflows')) return { data: { workflows: [{}] }, headers: {} };
    if (config.path.includes('/actions/workflows/') && config.path.endsWith('/runs')) return { data: { workflow_runs: [{}] }, headers: {} };
    return { data: [{}], headers: {} };
  } });
  for (const invoke of [
    () => malformedLists.listRepos('token'),
    () => malformedLists.listBranches('token', 'owner', 'repo'),
    () => malformedLists.listCommits('token', 'owner', 'repo'),
    () => malformedLists.listReleases('token', 'owner', 'repo'),
    () => malformedLists.listWorkflows('token', 'owner', 'repo'),
    () => malformedLists.listWorkflowRuns('token', 'owner', 'repo', 1),
  ]) {
    await assert.rejects(invoke, error => error.category === 'invalid_response');
  }

  let branchExists = false;
  let deterministicBranchSha = null;
  let storedContent = null;
  let pullRequest = null;
  const writes = [];
  const resumable = createGitHubService({ request: async config => {
    if (config.path.endsWith('/git/ref/heads/main')) return { data: { ref: 'refs/heads/main', object: { sha: 'base-sha' } }, headers: {} };
    if (config.path.endsWith('/git/ref/heads/ai-edit%2Fsuggestion-42')) {
      if (!branchExists) throw new ExternalApiError('GitHub', 'get branch reference', 'not_found', 404);
      return { data: { ref: 'refs/heads/ai-edit/suggestion-42', object: { sha: deterministicBranchSha } }, headers: {} };
    }
    if (config.path.endsWith('/git/refs')) {
      branchExists = true;
      deterministicBranchSha = 'base-sha';
      writes.push('branch');
      return { data: { ref: 'refs/heads/ai-edit/suggestion-42', object: { sha: 'base-sha' } }, headers: {} };
    }
    if (config.path.includes('/contents/types.xml') && config.method === 'GET') {
      if (storedContent === null) throw new ExternalApiError('GitHub', 'get repository file', 'not_found', 404);
      return { data: { sha: gitBlobSha(storedContent), path: 'types.xml', encoding: 'base64', content: Buffer.from(storedContent).toString('base64') }, headers: {} };
    }
    if (config.path.includes('/contents/types.xml') && config.method === 'PUT') {
      storedContent = Buffer.from(config.data.content, 'base64').toString('utf8');
      deterministicBranchSha = 'commit-sha';
      writes.push('commit');
      return { data: { commit: { sha: 'commit-sha' }, content: { sha: '767e23846c46af911fe9990f6144963e83164970', path: 'types.xml' } }, headers: {} };
    }
    if (config.path.includes('/compare/base-sha...commit-sha')) {
      return { data: {
        status: 'ahead', ahead_by: 1, behind_by: 0, total_commits: 1,
        base_commit: { sha: 'base-sha' }, merge_base_commit: { sha: 'base-sha' },
        commits: [{ sha: deterministicBranchSha }], files: [{ filename: 'types.xml', status: 'modified' }],
      }, headers: {} };
    }
    if (config.path.endsWith('/pulls') && config.method === 'GET') return { data: pullRequest ? [pullRequest] : [], headers: {} };
    if (config.path.endsWith('/pulls') && config.method === 'POST') {
      pullRequest = {
        number: 9,
        state: 'open',
        html_url: 'https://github.com/kitty/dayz/pull/9',
        head: { ref: 'ai-edit/suggestion-42', repo: { full_name: 'kitty/dayz' } },
        base: { ref: 'main', repo: { full_name: 'kitty/dayz' } },
      };
      writes.push('pr');
      return { data: pullRequest, headers: {} };
    }
    throw new Error(`unexpected resumable request ${config.method} ${config.path}`);
  } });
  const prOptions = { branchName: 'ai-edit/suggestion-42' };
  const firstPr = await resumable.commitAndCreatePR('token', 'kitty', 'dayz', 'main', 'types.xml', '<types/>', 'update', 'title', 'body', prOptions);
  const secondPr = await resumable.commitAndCreatePR('token', 'kitty', 'dayz', 'main', 'types.xml', '<types/>', 'update', 'title', 'body', prOptions);
  assert.equal(firstPr.prUrl, 'https://github.com/kitty/dayz/pull/9');
  assert.equal(secondPr.prUrl, firstPr.prUrl);
  assert.deepEqual(writes, ['branch', 'commit', 'pr'], 'retry must resume the deterministic GitHub operation without duplicate writes');

  let staleWrites = 0;
  const staleBase = createGitHubService({ request: async config => {
    if (config.path.endsWith('/git/ref/heads/main')) {
      return { data: { ref: 'refs/heads/main', object: { sha: 'base-sha' } }, headers: {} };
    }
    if (config.method === 'GET' && config.path.includes('/git/ref/heads/')) {
      throw new ExternalApiError('GitHub', 'get branch reference', 'not_found', 404);
    }
    if (config.method === 'GET' && config.path.includes('/contents/types.xml')) {
      const content = '<changed/>';
      return { data: { sha: gitBlobSha(content), path: 'types.xml', encoding: 'base64', content: Buffer.from(content).toString('base64') }, headers: {} };
    }
    staleWrites += 1;
    throw new Error(`unexpected stale write ${config.method} ${config.path}`);
  } });
  await assert.rejects(
    () => staleBase.commitAndCreatePR('token', 'owner', 'repo', 'main', 'types.xml', '<new/>', 'update', 'title', 'body', {
      branchName: 'ai-edit/suggestion-43', expectedOriginalContent: '<old/>',
    }),
    error => error.category === 'conflict',
    'GitHub finalization must reject a stale base file before mutation',
  );
  assert.equal(staleWrites, 0, 'stale GitHub suggestions must not create branches, commits, or pull requests');

  let existingBranchWrites = 0;
  let existingBranchBaseReads = 0;
  const staleExistingBranch = createGitHubService({ request: async config => {
    if (config.path.endsWith('/git/ref/heads/main')) {
      return { data: { ref: 'refs/heads/main', object: { sha: 'base-sha' } }, headers: {} };
    }
    if (config.path.endsWith('/git/ref/heads/ai-edit%2Fsuggestion-44')) {
      return { data: { ref: 'refs/heads/ai-edit/suggestion-44', object: { sha: 'branch-sha' } }, headers: {} };
    }
    if (config.method === 'GET' && config.path.includes('/contents/types.xml')) {
      const isBase = config.params?.ref === 'base-sha';
      if (isBase) existingBranchBaseReads += 1;
      const content = isBase ? '<changed/>' : '<new/>';
      return { data: { sha: gitBlobSha(content), path: 'types.xml', encoding: 'base64', content: Buffer.from(content).toString('base64') }, headers: {} };
    }
    existingBranchWrites += 1;
    throw new Error(`unexpected existing-branch write ${config.method} ${config.path}`);
  } });
  await assert.rejects(
    () => staleExistingBranch.commitAndCreatePR('token', 'owner', 'repo', 'main', 'types.xml', '<new/>', 'update', 'title', 'body', {
      branchName: 'ai-edit/suggestion-44', expectedOriginalContent: '<old/>',
    }),
    error => error.category === 'conflict',
    'GitHub retries must verify base freshness before reconciling an existing deterministic branch',
  );
  assert.equal(existingBranchBaseReads, 1);
  assert.equal(existingBranchWrites, 0);

  let foreignBranchWrites = 0;
  const foreignDeterministicBranch = createGitHubService({ request: async config => {
    if (config.path.endsWith('/git/ref/heads/main')) {
      return { data: { ref: 'refs/heads/main', object: { sha: 'base-sha' } }, headers: {} };
    }
    if (config.path.endsWith('/git/ref/heads/ai-edit%2Fsuggestion-45')) {
      return { data: { ref: 'refs/heads/ai-edit/suggestion-45', object: { sha: 'foreign-sha' } }, headers: {} };
    }
    if (config.path.includes('/contents/types.xml')) {
      const content = config.params?.ref === 'base-sha' ? '<old/>' : '<new/>';
      return { data: { sha: gitBlobSha(content), path: 'types.xml', encoding: 'base64', content: Buffer.from(content).toString('base64') }, headers: {} };
    }
    if (config.path.includes('/compare/')) {
      return { data: {
        status: 'ahead', ahead_by: 2, behind_by: 0, total_commits: 2,
        base_commit: { sha: 'base-sha' }, merge_base_commit: { sha: 'base-sha' },
        commits: [{ sha: 'foreign-1' }, { sha: 'foreign-sha' }],
        files: [{ filename: 'types.xml', status: 'modified' }, { filename: 'unrelated.txt', status: 'added' }],
      }, headers: {} };
    }
    foreignBranchWrites += 1;
    throw new Error(`unexpected foreign-branch mutation ${config.method} ${config.path}`);
  } });
  await assert.rejects(
    () => foreignDeterministicBranch.commitAndCreatePR('token', 'owner', 'repo', 'main', 'types.xml', '<new/>', 'update', 'title', 'body', {
      branchName: 'ai-edit/suggestion-45', expectedOriginalContent: '<old/>',
    }),
    error => error.category === 'conflict',
    'deterministic recovery must reject pre-existing branches with unrelated history or files',
  );
  assert.equal(foreignBranchWrites, 0);

  const malformedPrSearch = createGitHubService({ request: async config => {
    if (config.path.endsWith('/git/ref/heads/main')) return { data: { ref: 'refs/heads/main', object: { sha: 'base-sha' } }, headers: {} };
    if (config.path.endsWith('/git/ref/heads/ai-edit%2F1')) return { data: { ref: 'refs/heads/ai-edit/1', object: { sha: 'branch-sha' } }, headers: {} };
    if (config.path.includes('/compare/')) return { data: {
      status: 'ahead', ahead_by: 1, behind_by: 0, total_commits: 1,
      base_commit: { sha: 'base-sha' }, merge_base_commit: { sha: 'base-sha' },
      commits: [{ sha: 'branch-sha' }], files: [{ filename: 'types.xml', status: 'modified' }],
    }, headers: {} };
    if (config.path.includes('/contents/')) return { data: { sha: gitBlobSha('<types/>'), path: 'types.xml', encoding: 'base64', content: Buffer.from('<types/>').toString('base64') }, headers: {} };
    if (config.path.endsWith('/pulls') && config.method === 'GET') return { data: [{ number: 1, html_url: 'https://github.com/owner/repo/pull/1' }], headers: {} };
    throw new Error(`unexpected malformed PR request ${config.method} ${config.path}`);
  } });
  await assert.rejects(
    () => malformedPrSearch.commitAndCreatePR('token', 'owner', 'repo', 'main', 'types.xml', '<types/>', 'update', 'title', 'body', { branchName: 'ai-edit/1' }),
    error => error.category === 'invalid_response' && error.operation === 'find pull request',
  );

  let createdAfterClosed = 0;
  let searchedState = null;
  const closedPrRecovery = createGitHubService({ request: async config => {
    if (config.path.endsWith('/git/ref/heads/main')) return { data: { ref: 'refs/heads/main', object: { sha: 'base-sha' } }, headers: {} };
    if (config.path.endsWith('/git/ref/heads/ai-edit%2Fclosed')) return { data: { ref: 'refs/heads/ai-edit/closed', object: { sha: 'branch-sha' } }, headers: {} };
    if (config.path.includes('/compare/')) return { data: {
      status: 'ahead', ahead_by: 1, behind_by: 0, total_commits: 1,
      base_commit: { sha: 'base-sha' }, merge_base_commit: { sha: 'base-sha' },
      commits: [{ sha: 'branch-sha' }], files: [{ filename: 'types.xml', status: 'modified' }],
    }, headers: {} };
    if (config.path.includes('/contents/')) return { data: { sha: gitBlobSha('<types/>'), path: 'types.xml', encoding: 'base64', content: Buffer.from('<types/>').toString('base64') }, headers: {} };
    if (config.path.endsWith('/pulls') && config.method === 'GET') {
      searchedState = config.params.state;
      return { data: [], headers: {} };
    }
    if (config.path.endsWith('/pulls') && config.method === 'POST') {
      createdAfterClosed += 1;
      return { data: { number: 2, state: 'open', html_url: 'https://github.com/owner/repo/pull/2', head: { ref: 'ai-edit/closed', repo: { full_name: 'owner/repo' } }, base: { ref: 'main', repo: { full_name: 'owner/repo' } } }, headers: {} };
    }
    throw new Error(`unexpected closed PR recovery request ${config.method} ${config.path}`);
  } });
  await closedPrRecovery.commitAndCreatePR('token', 'owner', 'repo', 'main', 'types.xml', '<types/>', 'update', 'title', 'body', { branchName: 'ai-edit/closed' });
  assert.equal(searchedState, 'open', 'deterministic recovery must search only open pull requests');
  assert.equal(createdAfterClosed, 1, 'deterministic recovery must create a new PR when no open PR exists');

  for (const [label, invoke, responder] of [
    ['mismatched repository file blob SHA', service => service.getRepoFile('token', 'owner', 'repo', 'main', 'types.xml'),
      async () => ({ data: { sha: '0000000000000000000000000000000000000000', path: 'types.xml', encoding: 'base64', content: Buffer.from('<types/>').toString('base64') }, headers: {} })],
    ['noncanonical base64', service => service.getRepoFile('token', 'owner', 'repo', 'main', 'types.xml'),
      async () => ({ data: { sha: 'file-sha', path: 'types.xml', encoding: 'base64', content: '%%%garbage%%%' }, headers: {} })],
    ['mismatched base ref', service => service.createBranch('token', 'owner', 'repo', 'main', 'ai-edit/1'),
      async config => config.method === 'GET'
        ? ({ data: { ref: 'refs/heads/other', object: { sha: 'base-sha' } }, headers: {} })
        : ({ data: { ref: 'refs/heads/ai-edit/1', object: { sha: 'base-sha' } }, headers: {} })],
    ['mismatched branch ref', service => service.commitAndCreatePR('token', 'owner', 'repo', 'main', 'types.xml', '<types/>', 'update', 'title', 'body', { branchName: 'ai-edit/1' }),
      async config => {
        if (config.path.includes('/git/ref/heads/')) return { data: { ref: 'refs/heads/other', object: { sha: 'branch-sha' } }, headers: {} };
        throw new Error('unexpected request after mismatched branch ref');
      }],
    ['mismatched committed file', service => service.commitFile('token', 'owner', 'repo', 'main', 'types.xml', '<types/>', 'update'),
      async () => ({ data: { commit: { sha: 'commit-sha' }, content: { sha: 'file-sha', path: 'other.xml' } }, headers: {} })],
    ['cross-repository pull request', service => service.createPR('token', 'owner', 'repo', 'main', 'feature', 'title', 'body'),
      async () => ({ data: { number: 7, html_url: 'https://github.com/evil/other/pull/7', head: { ref: 'feature', repo: { full_name: 'evil/other' } }, base: { ref: 'main', repo: { full_name: 'evil/other' } } }, headers: {} })],
    ['closed created pull request', service => service.createPR('token', 'owner', 'repo', 'main', 'feature', 'title', 'body'),
      async () => ({ data: { number: 8, state: 'closed', html_url: 'https://github.com/owner/repo/pull/8', head: { ref: 'feature', repo: { full_name: 'owner/repo' } }, base: { ref: 'main', repo: { full_name: 'owner/repo' } } }, headers: {} })],
  ]) {
    const strictService = createGitHubService({ request: responder });
    await assert.rejects(
      () => invoke(strictService),
      error => error.category === 'invalid_response',
      `${label} must fail closed`,
    );
  }

  let boundedCacheCalls = 0;
  const boundedCache = createGitHubService({
    cacheMaxEntries: 2,
    request: async () => {
      boundedCacheCalls += 1;
      return { data: [], headers: {} };
    },
  });
  await boundedCache.listRepos('token-a');
  await boundedCache.listRepos('token-b');
  await boundedCache.listRepos('token-c');
  await boundedCache.listRepos('token-a');
  assert.equal(boundedCacheCalls, 4, 'GitHub cache must evict old credential-scoped entries');
}

async function testOpenAiCompatibleProvider() {
  const { ExternalApiError } = require('../utils/externalApiClient');
  const aiService = require('../services/aiService');
  let captured;
  const reply = await aiService.callAiApi(
    [{ role: 'user', content: 'hello' }],
    0.2,
    {
      baseURL: 'https://ai.example.test/v1/',
      apiKey: 'test-provider-key',
      model: 'test-model',
      logger: { warn() {} },
      transport: async config => {
        captured = config;
        return { status: 200, data: { choices: [{ finish_reason: 'stop', message: { content: 'world' } }] }, headers: {} };
      },
    }
  );
  assert.equal(reply, 'world');
  assert.equal(captured.url, 'https://ai.example.test/v1/chat/completions');
  assert.equal(captured.headers.Authorization, 'Bearer test-provider-key');
  assert.equal(captured.data.model, 'test-model');
  assert(captured.data.max_tokens > 4096, 'AI output bound cannot return the accepted complete-file size');
  assert.throws(
    () => require('../utils/externalApiClient').createExternalApiClient({ serviceName: 'AI', baseURL: 'http://provider.example/v1/' }),
    /HTTPS/i,
    'credential-bearing provider clients must reject plaintext base URLs',
  );

  assert.throws(
    () => aiService.assertCompleteFileContent('x'.repeat(40001)),
    error => error.code === 'AI_FILE_TOO_LARGE',
    'oversized files must not be truncated into destructive replacement suggestions',
  );
  assert.throws(() => aiService.assertValidReplacement('types.xml', '<types>'), /valid XML/i);
  assert.throws(() => aiService.assertValidReplacement('config.json', '{"broken":'), /valid JSON/i);
  assert.equal(aiService.assertValidReplacement('types.xml', '<types/>'), '<types/>');

  await assert.rejects(
    () => aiService.callAiApi([{ role: 'user', content: 'hello' }], 0.2, {
      baseURL: 'https://ai.example.test/v1/', apiKey: 'test-...ey', model: 'test-model',
      logger: { warn() {} }, transport: async () => ({ status: 200, data: { choices: [] }, headers: {} }),
    }),
    error => error instanceof ExternalApiError && error.category === 'invalid_response',
  );
  await assert.rejects(
    () => aiService.callAiApi([{ role: 'user', content: 'hello' }], 0.2, {
      baseURL: 'https://ai.example.test/v1/', apiKey: 'test-...ey', model: 'test-model',
      logger: { warn() {} }, transport: async () => ({ status: 200, data: { choices: [{ finish_reason: 'length', message: { content: 'partial' } }] }, headers: {} }),
    }),
    error => error instanceof ExternalApiError && error.category === 'invalid_response',
  );
}

async function testRouteIntegrationBoundaries() {
  const fs = require('fs');
  const nitradoRoutes = ['nitrado.js', 'serverControl.js', 'serverStats.js', 'activityLog.js', 'tasks.js', 'nitradoSettings.js'];
  for (const file of nitradoRoutes) {
    const source = fs.readFileSync(require.resolve(`../routes/${file}`), 'utf8');
    assert(source.includes("require('../services/nitradoService')"), `${file} bypasses NitradoService`);
  }
  const consoleSource = fs.readFileSync(require.resolve('../routes/console'), 'utf8');
  assert(consoleSource.includes('PROVIDER_MUTATION_DISABLED'), 'console commands must remain fail closed');
  assert(!consoleSource.includes("require('../services/nitradoService')"), 'disabled console route retains an unnecessary provider dependency');
  for (const file of ['boost.js', 'backups.js', 'supportHub.js']) {
    const source = fs.readFileSync(require.resolve(`../routes/${file}`), 'utf8');
    assert(source.includes("require('../services/nitradoService')"), `${file} bypasses NitradoService`);
    assert(!source.includes("require('../utils/nitradoHttp')"), `${file} retains a duplicate Nitrado transport`);
  }
  const nitradoSource = fs.readFileSync(require.resolve('../routes/nitrado'), 'utf8');
  assert(!nitradoSource.includes("'/servers/:serverId/status'"), 'Unused duplicate Nitrado status endpoint remains exposed');
  assert(!nitradoSource.includes("'/servers/:serverId/players'"), 'Unused Nitrado players endpoint remains exposed');
  const aiSource = fs.readFileSync(require.resolve('../routes/ai'), 'utf8');
  for (const path of ['/repository', '/commits', '/releases', '/workflows']) {
    assert(aiSource.includes(path), `GitHub operational route missing: ${path}`);
  }
  assert(aiSource.includes("router.param('platformServerId'"), 'GitHub server routes are not exact-server authorized');
  assert(aiSource.includes("listRepos(conn.token, { allPages: true })"), 'Repository selector does not traverse bounded pagination');
  assert(!aiSource.includes("workflows/:workflowId/dispatch"), 'Unused workflow dispatch mutation remains exposed');
  const connectBlock = aiSource.slice(aiSource.indexOf("router.post('/github/connect-pat'"), aiSource.indexOf("router.patch('/github/settings'"));
  assert(connectBlock.includes("verificationError.category === 'authentication'") && connectBlock.includes('sendExternalApiError'), 'GitHub credential verification does not distinguish authentication from provider outages');
  assert(connectBlock.includes('DELETE FROM github_repo_links'), 'Replacing GitHub credentials does not invalidate repository links established under the old credential');
  const aiPage = fs.readFileSync(require.resolve('../public/dashboard/ai-assistant.html'), 'utf8');
  const aiPageScript = fs.readFileSync(require.resolve('../public/js/ai-assistant.js'), 'utf8');
  const aiServiceSource = fs.readFileSync(require.resolve('../services/aiService'), 'utf8');
  const githubActionsIntegrationSource = fs.readFileSync(require.resolve('../services/githubActionsIntegrationService'), 'utf8');
  const integrationDocs = fs.readFileSync(require.resolve('../docs/EXTERNAL_INTEGRATIONS.md'), 'utf8');
  assert(!aiServiceSource.includes('models.inference.ai.azure.com'), 'Retired GitHub Models inference endpoint remains in production');
  assert(!aiPage.includes('models:read') && !integrationDocs.includes('Models read access'), 'Retired GitHub Models scopes remain advertised');
  assert(aiPage.includes('githubOpsStatus'), 'GitHub operational status UI is missing');
  assert(aiPageScript.includes('/github/integration'), 'GitHub operational UI is not connected to the canonical integration route');
  assert(githubActionsIntegrationSource.includes('listWorkflows') && githubActionsIntegrationSource.includes('listWorkflowRuns'), 'GitHub workflow-run status is not connected to integration discovery');
  assert(aiSource.includes('suggestionId') && aiPageScript.includes('editedSuggestionId'), 'AI chat edits are not persisted before apply');
  assert(!aiPageScript.includes('id: null'), 'AI chat still attempts to apply a nonexistent suggestion');
  assert(aiPageScript.includes('/api/mission-files/${encodeURIComponent(currentServerId)}'), 'AI mission-file requests must use the platform server ID');
  assert(!aiPageScript.includes('/api/mission-files/${encodeURIComponent(currentInternalServerId)}'), 'AI mission-file requests incorrectly use the internal server ID');
  assert(aiSource.includes("err.service === 'GitHub'"), 'GitHub PR failures bypass the normalized provider error response');
  assert(aiSource.includes("!['pending', 'accepted', 'applying'].includes(suggestion.status)"), 'Rejected AI suggestions can still be finalized through the API');
  assert(aiSource.includes("SET status = 'applying'"), 'Suggestion finalization lacks a durable atomic claim');
  assert(aiSource.includes("status IN ('pending', 'accepted')"), 'Suggestion finalization claim is not state-conditional');
  assert(aiSource.includes('application_claimed_at') && aiSource.includes("status = 'applying' AND application_claimed_at <"), 'Suggestion finalization lacks stale-claim recovery');
  assert(aiSource.includes('application_claim_id') && aiSource.includes('application_claim_id = $'), 'Suggestion finalization completion is not bound to its claim owner');
  assert(aiSource.includes('ais.user_id = $3') && aiSource.includes("g.status = 'approved'") && aiSource.includes("gr.role IN ('owner', 'admin')") && !aiSource.includes('u.is_admin = 1'), 'Suggestion claim is not atomically bound to current tenant owner/admin authorization');
  assert(aiSource.includes("WHERE ais.id = $2 AND status = 'applying'"), 'Suggestion completion can overwrite an unexpected state');
  assert(aiSource.includes('JOIN guild_roles gr ON gr.guild_id = g.id AND gr.user_id = $4'), 'Suggestion completion does not recheck current tenant owner/admin authorization');
  assert(aiSource.includes('ai-edit/suggestion-'), 'Suggestion finalization lacks a deterministic GitHub branch');
  assert(aiSource.includes('Suggestion state changed'), 'Suggestion state updates can overwrite an active finalization claim');
  assert(aiSource.includes('MAX_CHAT_MESSAGES') && aiSource.includes('MAX_CHAT_HISTORY_CHARS') && aiSource.includes('boundChatHistory('), 'AI chat history is not bounded before provider requests and persistence');
  assert(aiSource.includes('assertCompleteFileContent(fileContent)'), 'AI chat can persist a truncated file as a complete replacement');
  assert(aiSource.includes("typeof fileContent !== 'string'"), 'AI chat does not require fresh complete file content on every request');
  assert(!aiSource.includes('fileContent.slice(0, 30000)'), 'AI chat truncates complete file context before replacement generation');
  assert(aiSource.includes('buildCurrentFileContext') && aiSource.includes('providerHistory'), 'AI chat does not bind every request to current complete file state');
  assert(aiSource.includes("err.service !== 'GitHub'"), 'Ambiguous GitHub mutation outcomes release the deterministic finalization lease');
  assert(aiSource.includes("err.category === 'conflict'"), 'Deterministic pre-mutation GitHub conflicts leave the finalization lease stuck');
  assert(aiSource.includes('expectedOriginalContent: suggestion.original_content'), 'GitHub finalization does not reject stale base-file content');
  const patchSuggestionBlock = aiSource.slice(aiSource.indexOf("router.patch('/suggestions/:suggestionId'"), aiSource.indexOf("router.post('/suggestions/:suggestionId/apply'"));
  assert(patchSuggestionBlock.includes('UPDATE ai_suggestions ais') && patchSuggestionBlock.includes("g.status = 'approved'") && patchSuggestionBlock.includes("gr.role IN ('owner', 'admin')"), 'Suggestion status mutation is not atomically bound to current authorization');
  assert(!aiPageScript.includes('.slice(0, 5000)'), 'AI review UI hides part of replacement content before finalization');
  for (const htmlPath of ['../public/dashboard/rotation.html', '../public/admin/reports.html']) {
    const html = fs.readFileSync(require.resolve(htmlPath), 'utf8');
    assert(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), `${htmlPath} contains a CSP-blocked inline script`);
    assert(!/\son(?:click|change|submit)=/i.test(html), `${htmlPath} contains CSP-blocked inline handlers`);
  }
  const supportHubSource = fs.readFileSync(require.resolve('../public/js/supportHub.js'), 'utf8');
  assert(supportHubSource.includes('escHtml(label)') && supportHubSource.includes('escHtml(langs)') && supportHubSource.includes('escHtml(slot.timezone)'), 'Support UI renders provider fields without HTML escaping');
  const finalizationMigration = fs.readFileSync(require.resolve('../db/migrations/049_ai_suggestion_finalization_lease'), 'utf8');
  assert(finalizationMigration.includes('application_claimed_at') && finalizationMigration.includes('application_previous_status') && finalizationMigration.includes('application_claim_id'), 'Suggestion finalization lease migration is missing');

  const schedulerSource = fs.readFileSync(require.resolve('../scheduler'), 'utf8');
  assert(schedulerSource.includes('buildScheduledLogSyncPlan(settings)') &&
    schedulerSource.includes('getDecryptedToken(db, row.id, serverIds)') &&
    !schedulerSource.includes('listGameServers(token)'),
  'Scheduler must sync only configured exact servers without provider-wide discovery');
  const registerRoutesSource = fs.readFileSync(require.resolve('../src/app/registerRoutes'), 'utf8');
  assert(registerRoutesSource.includes("require('../../services/nitradoService')") && registerRoutesSource.includes('getRawGameserver(token, serverId)'), 'Active-mission metadata lookup bypasses NitradoService');
  const ownerDashboardSource = fs.readFileSync(require.resolve('../routes/ownerDashboard'), 'utf8');
  assert(!ownerDashboardSource.includes('ni6156327_1'), 'Owner list routes contain a deployment-specific Nitrado file path');
  assert(ownerDashboardSource.includes('getRawGameserver(') && ownerDashboardSource.includes('resolveGameDataPath('), 'Owner list routes do not derive validated file paths from the selected Nitrado gameserver');
  const boostManagerSource = fs.readFileSync(require.resolve('../public/js/boostManager'), 'utf8');
  assert(!boostManagerSource.includes('onclick='), 'Boost pagination violates the script-src-attr CSP');
  assert(boostManagerSource.includes('data-page'), 'Boost pagination lacks CSP-safe delegated actions');
  assert(boostManagerSource.includes("fetch('/api/csrf-token')") && boostManagerSource.includes("'X-CSRF-Token': csrfToken"), 'Boost mutations are not wired to CSRF protection');
  for (const file of ['backupManager.js', 'taskManager.js', 'serverControlPanel.js', 'activityLog.js']) {
    const source = fs.readFileSync(require.resolve(`../public/js/${file}`), 'utf8');
    assert(!source.includes('onclick='), `${file} violates the script-src-attr CSP`);
  }
  for (const file of ['backupManager.js', 'taskManager.js', 'serverControlPanel.js']) {
    const source = fs.readFileSync(require.resolve(`../public/js/${file}`), 'utf8');
    assert(source.includes("fetch('/api/csrf-token')"), `${file} does not obtain a CSRF token`);
  }
  for (const modulePath of [
    '../bot/utils/nitrado', '../services/missionFileService', '../services/economyOverrideService',
    '../services/rotationService', '../services/logSyncService', '../services/nitradoFileService', '../routes/ownerDashboard',
  ]) {
    const source = fs.readFileSync(require.resolve(modulePath), 'utf8');
    assert(source.includes('getNitradoTransferToken'), `${modulePath} does not validate Nitrado transfer responses`);
    assert(!/\.data(?:\?\.)?\.data(?:\?\.)?\.token/.test(source), `${modulePath} directly dereferences a Nitrado transfer token`);
  }
  const integrationDocsLimits = fs.readFileSync(require.resolve('../docs/EXTERNAL_INTEGRATIONS.md'), 'utf8');
  for (const limit of ['24', '12,000', '100,000', '40,000', '16,384', '32,768']) {
    assert(integrationDocsLimits.includes(limit), `AI integration documentation omits enforced limit ${limit}`);
  }
  const botStatusSource = fs.readFileSync(require.resolve('../bot/services/serverStatusService'), 'utf8');
  assert(botStatusSource.includes("require('../../services/nitradoService')"), 'Bot metadata lookup bypasses the shared Nitrado service');
  assert(!botStatusSource.includes('fetchNitradoUserId'), 'Bot identity backfill bypasses NitradoService');
  assert(botStatusSource.includes('getAuthenticatedUser('), 'Bot identity backfill does not use NitradoService');
  assert(botStatusSource.includes('getRawGameserver(token, platformServerId)') && botStatusSource.includes('listTasks(token, platformServerId)'), 'Bot status metadata operations duplicate provider requests');
  const metadataCallers = [
    ['../bot/commands/register-token', 'listGameServers(token)'],
    ['../bot/utils/nitrado', 'getRawGameserver(token, platformServerId)'],
    ['../routes/logParser', 'getRawGameserver(token, nitradoServerId)'],
    ['../routes/missionFiles', 'getRawGameserver(token, serverId)'],
    ['../services/rotationService', 'getRawGameserver(token, platformServerId)'],
    ['../services/missionFileService', 'getRawGameserver(nitradoToken, serverId)'],
    ['../services/economyOverrideService', 'getRawGameserver(nitradoToken, serverId)'],
  ];
  for (const [modulePath, expectedCall] of metadataCallers) {
    const source = fs.readFileSync(require.resolve(modulePath), 'utf8');
    assert(source.includes('nitradoService') && source.includes(expectedCall), `${modulePath} metadata bypasses NitradoService`);
  }
}

async function testSuggestionFinalizationLease() {
  const router = require('../routes/ai');
  const routeLayer = router.stack.find(layer => layer.route?.path === '/suggestions/:suggestionId/apply');
  const handler = routeLayer?.route?.stack?.at(-1)?.handle;
  assert.equal(typeof handler, 'function', 'suggestion finalization handler is unavailable');

  function response() {
    return {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
  }

  function statefulDb(initial = {}, hooks = {}) {
    const state = {
      id: 42, userId: 7, serverId: 9, status: 'pending', claimId: null,
      previousStatus: null, claimedAt: null, authorized: true, ...initial,
    };
    return {
      state,
      async get(sql) {
        if (sql.includes('FROM ai_suggestions ais')) {
          const snapshot = state.authorized ? {
            id: state.id, user_id: state.userId, server_id: state.serverId, status: state.status,
            filename: 'types.xml', suggested_content: state.suggestedContent || '<types/>', diff_summary: 'test', explanation: 'test',
          } : null;
          if (hooks.afterAuthorizationRead) await hooks.afterAuthorizationRead(state);
          return snapshot;
        }
        if (sql.includes('FROM github_connections')) {
          if (hooks.onConnectionRead) await hooks.onConnectionRead(state);
          return null;
        }
        throw new Error(`unexpected lease get: ${sql}`);
      },
      async query(sql, params) {
        if (sql.includes("SET status = 'applying'")) {
          assert(sql.includes('ais.user_id = $3') && sql.includes("g.status = 'approved'") && sql.includes('u.is_admin = 1'));
          assert(sql.includes('original_content') && sql.includes('suggested_content') && sql.includes('filename'), 'lease acquisition must return the persisted original and replacement being claimed');
          const stale = state.status === 'applying' && (!state.claimedAt || state.claimedAt < Date.now() - 10 * 60 * 1000);
          if (!state.authorized || state.id !== params[0] || state.userId !== params[2] || (!['pending', 'accepted'].includes(state.status) && !stale)) return [];
          state.previousStatus = ['pending', 'accepted'].includes(state.status) ? state.status : (state.previousStatus || 'accepted');
          state.status = 'applying';
          state.claimId = params[1];
          state.claimedAt = Date.now();
          return [{
            id: state.id,
            server_id: state.serverId,
            filename: 'types.xml',
            original_content: state.originalContent || '<types/>',
            suggested_content: state.suggestedContent || '<types/>',
            diff_summary: 'test',
            explanation: 'test',
          }];
        }
        if (sql.includes("SET status = 'applied'")) {
          if (state.status !== 'applying' || state.claimId !== params[2]) return [];
          state.status = 'applied';
          state.claimId = null;
          state.claimedAt = null;
          state.previousStatus = null;
          return [{ id: state.id }];
        }
        if (sql.includes('SET status = COALESCE(application_previous_status')) {
          if (state.status === 'applying' && state.claimId === params[1]) {
            state.status = state.previousStatus || 'accepted';
            state.claimId = null;
            state.claimedAt = null;
            state.previousStatus = null;
          }
          return [];
        }
        throw new Error(`unexpected lease query: ${sql}`);
      },
    };
  }

  async function invoke(db) {
    const res = response();
    await handler({ app: { locals: { db } }, user: { id: 7 }, params: { suggestionId: '42' }, body: {} }, res);
    return res;
  }

  let releaseFirst;
  let firstPaused;
  const firstPause = new Promise(resolve => { firstPaused = resolve; });
  const concurrentDb = statefulDb({}, {
    async onConnectionRead() {
      if (!releaseFirst) {
        firstPaused();
        await new Promise(resolve => { releaseFirst = resolve; });
      }
    },
  });
  const firstRequest = invoke(concurrentDb);
  await firstPause;
  const secondResponse = await invoke(concurrentDb);
  assert.equal(secondResponse.statusCode, 409, 'concurrent finalization must not acquire the active lease');
  releaseFirst();
  const firstResponse = await firstRequest;
  assert.equal(firstResponse.statusCode, 200);
  assert.equal(concurrentDb.state.status, 'applied');

  const staleDb = statefulDb({ status: 'applying', claimId: 'dead-worker', previousStatus: 'accepted', claimedAt: Date.now() - 11 * 60 * 1000 });
  assert.equal((await invoke(staleDb)).statusCode, 200, 'stale finalization lease must be recoverable');
  assert.equal(staleDb.state.status, 'applied');

  const revokedDb = statefulDb({}, { afterAuthorizationRead(state) { state.authorized = false; } });
  assert.equal((await invoke(revokedDb)).statusCode, 409, 'authorization revoked before the claim must fail closed');
  assert.equal(revokedDb.state.status, 'pending');

  const lostClaimDb = statefulDb({}, { onConnectionRead(state) { state.claimId = 'new-owner'; } });
  const originalConsoleError = console.error;
  let lostClaimResponse;
  try {
    console.error = () => {};
    lostClaimResponse = await invoke(lostClaimDb);
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(lostClaimResponse.statusCode, 500, 'a worker that loses its claim must not finalize');
  assert.equal(lostClaimDb.state.claimId, 'new-owner', 'lost worker must not release a newer worker claim');

  const malformedLegacyDb = statefulDb({ suggestedContent: '<types>' });
  const originalMalformedConsoleError = console.error;
  let malformedLegacyResponse;
  try {
    console.error = () => {};
    malformedLegacyResponse = await invoke(malformedLegacyDb);
  } finally {
    console.error = originalMalformedConsoleError;
  }
  assert.equal(malformedLegacyResponse.statusCode, 500, 'persisted malformed replacements must fail closed during finalization');
  assert.equal(malformedLegacyDb.state.status, 'pending', 'invalid persisted replacements must release the finalization lease');

  const changedBeforeClaimDb = statefulDb({}, {
    afterAuthorizationRead(state) { state.suggestedContent = '<types>'; },
  });
  let changedBeforeClaimResponse;
  try {
    console.error = () => {};
    changedBeforeClaimResponse = await invoke(changedBeforeClaimDb);
  } finally {
    console.error = originalMalformedConsoleError;
  }
  assert.equal(changedBeforeClaimResponse.statusCode, 500, 'finalization must validate the persisted replacement returned by the acquired lease');
  assert.equal(changedBeforeClaimDb.state.status, 'pending', 'a replacement changed before lease acquisition must fail closed and release the lease');
}

(async () => {
  await testExternalClientReliability();
  await testExternalErrorResponseMapping();
  await testLegacyNitradoTransportReliability();
  await testNitradoMissingFileClassification();
  testContainedMissionPaths();
  testLegacyNitradoFileContracts();
  await testNitradoServiceModelsAndOperations();
  await testGitHubServicePaginationAndModels();
  await testOpenAiCompatibleProvider();
  await testRouteIntegrationBoundaries();
  await testSuggestionFinalizationLease();
  console.log('✅ External integration tests passed');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
