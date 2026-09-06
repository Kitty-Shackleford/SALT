'use strict';

const axios = require('axios');
const path = require('path');
const { classifyError, retryDelayMs } = require('./externalApiClient');
const { currentRequestSignal } = require('./requestAbort');
const { resolveMissionBasePath } = require('./dayzPlatform');

const DEFAULT_NITRADO_HTTP_TIMEOUT_MS = 15000;
const DEFAULT_NITRADO_HTTP_MAX_RETRIES = 2;
const DEFAULT_NITRADO_MAX_RETRY_DELAY_MS = 30000;
const DEFAULT_NITRADO_API_URL = 'https://api.nitrado.net';
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function validateApiBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_) {
    throw new Error('Nitrado API base URL must be a valid HTTP(S) URL');
  }
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Nitrado API base URL must be a valid HTTP(S) URL');
  if (parsed.protocol !== 'https:' && !new Set(['localhost', '127.0.0.1', '::1']).has(parsed.hostname)) {
    throw new Error('Nitrado API base URL must use HTTPS unless it targets local loopback');
  }
  return parsed.toString();
}

function parseTimeout(value, fallback = DEFAULT_NITRADO_HTTP_TIMEOUT_MS) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function configuredTimeoutMs() {
  return parseTimeout(process.env.NITRADO_HTTP_TIMEOUT_MS);
}

function getNitradoFileEntries(response) {
  const entries = response?.data?.data?.entries;
  if (response?.data?.status !== 'success' || !Array.isArray(entries) || entries.some(entry =>
    !entry || typeof entry !== 'object' || !['file', 'dir'].includes(entry.type) ||
    typeof entry.name !== 'string' || !entry.name || entry.name === '.' || entry.name === '..' ||
    entry.name.includes('/') || entry.name.includes('\\') || entry.name.includes('\0') ||
    typeof entry.path !== 'string' || !entry.path.startsWith('/') || entry.path.includes('\0') ||
    path.posix.normalize(entry.path) !== entry.path || entry.path.startsWith('//') ||
    (entry.type === 'file' && (!Number.isFinite(Number(entry.size)) || Number(entry.size) < 0)))) {
    const error = new Error('Nitrado returned an invalid file list response');
    error.name = 'NitradoResponseError';
    error.code = 'NITRADO_INVALID_RESPONSE';
    error.category = 'invalid_response';
    error.status = 502;
    throw error;
  }
  return entries;
}

function getNitradoTextBody(response) {
  if (typeof response?.data !== 'string') {
    throw invalidNitradoResponse('Nitrado returned an invalid file body');
  }
  return response.data;
}

function getNitradoBinaryBody(response) {
  const body = response?.data;
  if (!Buffer.isBuffer(body) && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body)) {
    throw invalidNitradoResponse('Nitrado returned an invalid binary file body');
  }
  return body;
}

function assertMissionPathComponent(mission) {
  if (typeof mission !== 'string' || !mission || mission === '.' || mission === '..' ||
      mission.includes('/') || mission.includes('\\') || mission.includes('\0') ||
      path.posix.basename(mission) !== mission) {
    throw invalidNitradoResponse('Nitrado returned invalid mission metadata');
  }
  return mission;
}

function resolveMissionUploadTarget(missionBasePath, configuredMission, requestedFile) {
  const safeConfiguredMission = assertMissionPathComponent(configuredMission);
  if (typeof missionBasePath !== 'string' || !missionBasePath.startsWith('/') ||
      typeof requestedFile !== 'string' || !requestedFile || requestedFile.includes('\\') || requestedFile.includes('\0')) {
    throw invalidNitradoResponse('Invalid mission upload path');
  }
  const segments = requestedFile.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw invalidNitradoResponse('Invalid mission upload path');
  }
  let relativeFile = requestedFile;
  if (segments.length === 1) {
    relativeFile = path.posix.join(safeConfiguredMission, requestedFile);
  }
  const fullPath = path.posix.join(missionBasePath, relativeFile);
  const normalizedBase = path.posix.normalize(missionBasePath);
  if (!fullPath.startsWith(`${normalizedBase}/`)) throw invalidNitradoResponse('Invalid mission upload path');
  return { directory: path.posix.dirname(fullPath), fileName: path.posix.basename(fullPath) };
}

function invalidNitradoResponse(message) {
  const error = new Error(message);
  error.name = 'NitradoResponseError';
  error.code = 'NITRADO_INVALID_RESPONSE';
  error.category = 'invalid_response';
  error.status = 502;
  return error;
}

function assertNitradoSuccess(response, message = 'Nitrado returned an invalid response') {
  if (response?.data?.status !== 'success') throw invalidNitradoResponse(message);
  return response.data;
}

function getNitradoTransferToken(response, options = {}) {
  const transfer = response?.data?.data?.token;
  if (response?.data?.status !== 'success' ||
      (response?.data?.data?.status !== undefined && response.data.data.status !== 'success')) {
    throw invalidNitradoResponse('Nitrado returned an invalid file transfer response');
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(transfer?.url);
  } catch (_) {
    throw invalidNitradoResponse('Nitrado returned an invalid file transfer response');
  }
  if (parsedUrl.protocol !== 'https:' ||
      (options.requireToken && (typeof transfer?.token !== 'string' || !transfer.token))) {
    throw invalidNitradoResponse('Nitrado returned an invalid file transfer response');
  }
  return { url: parsedUrl.toString(), ...(transfer.token ? { token: transfer.token } : {}) };
}

function parseRetries(value, fallback = DEFAULT_NITRADO_HTTP_MAX_RETRIES) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function rewriteApiUrl(url, apiBaseUrl) {
  try {
    const target = new URL(url);
    if (target.origin !== DEFAULT_NITRADO_API_URL) return url;
    return new URL(`${target.pathname}${target.search}`, apiBaseUrl).toString();
  } catch (_) {
    return url;
  }
}

function controlledRequestError(error, timeoutMs) {
  const category = classifyError(error);
  const status = error?.response?.status;
  const messages = {
    cancelled: 'Nitrado request was cancelled',
    timeout: `Nitrado request timed out after ${timeoutMs}ms`,
    rate_limited: 'Nitrado rate limit exceeded',
  };
  const controlled = new Error(messages[category] || `Nitrado request failed${status ? ` (${status})` : ''}`);
  controlled.name = 'NitradoRequestError';
  controlled.code = {
    cancelled: 'NITRADO_CANCELLED',
    timeout: 'NITRADO_TIMEOUT',
    rate_limited: 'NITRADO_RATE_LIMITED',
  }[category] || 'NITRADO_REQUEST_FAILED';
  controlled.category = category;
  controlled.status = status || null;
  controlled.retryAfterMs = category === 'rate_limited' ? retryDelayMs(error, 0) : null;
  controlled.method = error?.config?.method ? String(error.config.method).toUpperCase() : null;
  if (error?.response) {
    controlled.response = {
      status: error.response.status,
      statusText: error.response.statusText,
      // A provider or intermediary may reflect request headers in an error
      // body. Keep status semantics without propagating credential-bearing data.
      data: { message: controlled.message },
    };
  }
  return controlled;
}

function cancelledError(config) {
  const error = new Error('Request cancelled');
  error.name = 'CanceledError';
  error.code = 'ERR_CANCELED';
  error.config = config;
  return error;
}

async function waitForRetry(delay, signal, sleep) {
  if (!signal) return sleep(delay);
  if (signal.aborted) throw cancelledError();
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(cancelledError());
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([sleep(delay), cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

function createNitradoHttpClient(timeoutMs = configuredTimeoutMs(), options = {}) {
  const timeout = parseTimeout(timeoutMs);
  const apiBaseUrl = validateApiBaseUrl(options.apiBaseUrl || process.env.NITRADO_API_BASE_URL || DEFAULT_NITRADO_API_URL);
  const maxRetries = parseRetries(options.maxRetries ?? process.env.NITRADO_HTTP_MAX_RETRIES ?? process.env.NITRADO_API_RETRIES);
  const maxRetryDelayMs = parseTimeout(
    options.maxRetryDelayMs ?? process.env.EXTERNAL_API_MAX_RETRY_DELAY_MS,
    DEFAULT_NITRADO_MAX_RETRY_DELAY_MS
  );
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const client = axios.create({ timeout });
  client.interceptors.request.use(config => ({
    ...config,
    url: rewriteApiUrl(config.url, apiBaseUrl),
    timeout: parseTimeout(config.timeout, timeout),
    signal: config.signal || currentRequestSignal(),
  }));
  client.interceptors.response.use(
    response => response,
    async error => {
      const config = error?.config || {};
      const method = String(config.method || 'GET').toUpperCase();
      const attempts = Number(config.__nitradoRetryCount || 0);
      const category = classifyError(error);
      const requestedDelay = retryDelayMs(error, attempts);
      if (IDEMPOTENT_METHODS.has(method)
          && ['timeout', 'rate_limited', 'upstream', 'network'].includes(category)
          && attempts < maxRetries
          && requestedDelay <= maxRetryDelayMs) {
        config.__nitradoRetryCount = attempts + 1;
        try {
          await waitForRetry(requestedDelay, config.signal, sleep);
        } catch (waitError) {
          waitError.config = config;
          return Promise.reject(controlledRequestError(waitError, config.timeout || timeout));
        }
        return client.request(config);
      }
      return Promise.reject(controlledRequestError(error, config.timeout || timeout));
    }
  );
  return client;
}

const nitradoHttp = createNitradoHttpClient();

async function nitradoFetch(url, options = {}, fetchImpl = globalThis.fetch, timeoutMs = configuredTimeoutMs(), reliability = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Fetch implementation is unavailable');
  const timeout = parseTimeout(options.timeout ?? timeoutMs);
  const apiBaseUrl = validateApiBaseUrl(reliability.apiBaseUrl || process.env.NITRADO_API_BASE_URL || DEFAULT_NITRADO_API_URL);
  const targetUrl = rewriteApiUrl(url, apiBaseUrl);
  const maxRetries = parseRetries(reliability.maxRetries ?? process.env.NITRADO_HTTP_MAX_RETRIES ?? process.env.NITRADO_API_RETRIES);
  const maxRetryDelayMs = parseTimeout(
    reliability.maxRetryDelayMs ?? process.env.EXTERNAL_API_MAX_RETRY_DELAY_MS,
    DEFAULT_NITRADO_MAX_RETRY_DELAY_MS
  );
  const sleep = reliability.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const method = String(options.method || 'GET').toUpperCase();
  const originalSignal = options.signal || currentRequestSignal();
  let attempt = 0;
  while (true) {
    const controller = new AbortController();
    let timedOut = false;
    const abortFromOriginal = () => controller.abort();
    if (originalSignal) {
      if (originalSignal.aborted) controller.abort();
      else originalSignal.addEventListener('abort', abortFromOriginal, { once: true });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeout);
    try {
      const requestOptions = { ...options, signal: controller.signal };
      delete requestOptions.timeout;
      const response = await fetchImpl(targetUrl, requestOptions);
      const headers = {};
      for (const name of ['retry-after', 'x-ratelimit-reset', 'x-ratelimit-remaining']) {
        const value = response?.headers?.get?.(name);
        if (value !== null && value !== undefined) headers[name] = value;
      }
      const errorLike = { response: { status: response.status, headers } };
      const category = classifyError(errorLike);
      const delay = retryDelayMs(errorLike, attempt);
      if (!response.ok && IDEMPOTENT_METHODS.has(method)
          && ['rate_limited', 'upstream'].includes(category)
          && attempt < maxRetries && delay <= maxRetryDelayMs) {
        attempt += 1;
        await waitForRetry(delay, originalSignal, sleep);
        continue;
      }
      return response;
    } catch (error) {
      let requestError = error;
      if (error?.name === 'AbortError') {
        if (timedOut) {
          requestError = new Error('Request timed out');
          requestError.code = 'ETIMEDOUT';
        } else {
          requestError = cancelledError();
        }
      }
      const category = classifyError(requestError);
      const delay = retryDelayMs(requestError, attempt);
      if (IDEMPOTENT_METHODS.has(method)
          && ['timeout', 'network'].includes(category)
          && attempt < maxRetries && delay <= maxRetryDelayMs
          && !originalSignal?.aborted) {
        attempt += 1;
        await waitForRetry(delay, originalSignal, sleep);
        continue;
      }
      throw controlledRequestError(requestError, timeout);
    } finally {
      clearTimeout(timer);
      if (originalSignal) originalSignal.removeEventListener('abort', abortFromOriginal);
    }
  }
}

module.exports = Object.assign(nitradoHttp, {
  DEFAULT_NITRADO_HTTP_TIMEOUT_MS,
  DEFAULT_NITRADO_HTTP_MAX_RETRIES,
  configuredTimeoutMs,
  createNitradoHttpClient,
  nitradoFetch,
  getNitradoFileEntries,
  getNitradoBinaryBody,
  getNitradoTextBody,
  getNitradoTransferToken,
  assertNitradoSuccess,
  assertMissionPathComponent,
  resolveMissionBasePath,
  resolveMissionUploadTarget,
});
