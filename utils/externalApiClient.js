'use strict';

const axios = require('axios');
const { currentRequestSignal } = require('./requestAbort');

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_RETRY_DELAY_MS = 30000;
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function headerValue(headers, name) {
  if (!headers) return null;
  const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : null;
}

function classifyError(error) {
  const status = Number(error?.response?.status) || null;
  const headers = error?.response?.headers || {};
  const responseMessage = String(error?.response?.data?.message || error?.response?.data || '').toLowerCase();
  const cancelled = error?.code === 'ERR_CANCELED' || error?.name === 'CanceledError' || error?.name === 'AbortError';
  const timedOut = ['ECONNABORTED', 'ETIMEDOUT'].includes(error?.code);
  const remaining = headerValue(headers, 'x-ratelimit-remaining');
  const rateLimited = status === 429 || (status === 403 && (
    String(remaining) === '0'
    || headerValue(headers, 'retry-after') !== null
    || responseMessage.includes('secondary rate limit')
    || responseMessage.includes('abuse detection')
  ));
  if (cancelled) return 'cancelled';
  if (timedOut) return 'timeout';
  if (rateLimited) return 'rate_limited';
  if (status === 401 || status === 403) return 'authentication';
  if (status === 404) return 'not_found';
  if (status && status >= 500) return 'upstream';
  if (status && status >= 400) return 'client';
  return 'network';
}

function retryDelayMs(error, attempt, now = Date.now()) {
  const headers = error?.response?.headers || {};
  const retryAfter = headerValue(headers, 'retry-after');
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) return Math.max(0, dateMs - now);
  }
  const reset = Number(headerValue(headers, 'x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - now);
  if (Number(error?.response?.status) === 403 && classifyError(error) === 'rate_limited') return 60000;
  return 250 * (2 ** attempt);
}

class ExternalApiError extends Error {
  constructor(service, operation, category, status, retryAfterMs = null) {
    const labels = {
      timeout: 'request timed out',
      rate_limited: 'rate limit exceeded',
      authentication: 'authentication failed',
      not_found: 'resource was not found',
      upstream: 'service is temporarily unavailable',
      client: 'request was rejected',
      network: 'network request failed',
      invalid_response: 'returned an invalid response',
      cancelled: 'request was cancelled',
    };
    super(`${service} ${labels[category] || 'request failed'}`);
    this.name = 'ExternalApiError';
    this.service = service;
    this.operation = operation;
    this.category = category;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.code = `${String(service).toUpperCase()}_${String(category).toUpperCase()}`.replace(/[^A-Z0-9_]/g, '_');
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      service: this.service,
      operation: this.operation,
      category: this.category,
      status: this.status,
      retryAfterMs: this.retryAfterMs,
      code: this.code,
    };
  }
}

function safeUrl(baseURL, path) {
  const base = new URL(baseURL);
  const target = new URL(path, base);
  if (target.origin !== base.origin) throw new Error('External API request origin is not allowed');
  return target.toString();
}

function cancellationError() {
  const error = new Error('Request cancelled');
  error.name = 'CanceledError';
  error.code = 'ERR_CANCELED';
  return error;
}

async function waitForRetry(delay, signal, sleep) {
  if (!signal) return sleep(delay);
  if (signal.aborted) throw cancellationError();
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(cancellationError());
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([sleep(delay), cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

function createExternalApiClient(options = {}) {
  const serviceName = options.serviceName || 'External API';
  const baseURL = options.baseURL;
  if (!baseURL) throw new Error(`${serviceName} base URL is required`);
  let parsedBase;
  try {
    parsedBase = new URL(baseURL);
  } catch (_) {
    throw new Error(`${serviceName} base URL must be a valid HTTP(S) URL`);
  }
  if (!['https:', 'http:'].includes(parsedBase.protocol)) {
    throw new Error(`${serviceName} base URL must be a valid HTTP(S) URL`);
  }
  const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1']);
  if (parsedBase.protocol !== 'https:' && !loopbackHosts.has(parsedBase.hostname)) {
    throw new Error(`${serviceName} base URL must use HTTPS unless it targets local loopback`);
  }
  if (options.timeoutMs !== undefined && (!Number.isFinite(Number(options.timeoutMs)) || Number(options.timeoutMs) <= 0)) {
    throw new Error(`${serviceName} timeout must be a positive number`);
  }
  if (options.maxRetries !== undefined && (!Number.isInteger(options.maxRetries) || options.maxRetries < 0)) {
    throw new Error(`${serviceName} retries must be a non-negative integer`);
  }
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxRetries = Math.max(0, Number.isInteger(options.maxRetries) ? options.maxRetries : DEFAULT_MAX_RETRIES);
  const maxRetryDelayMs = positiveInteger(options.maxRetryDelayMs, DEFAULT_MAX_RETRY_DELAY_MS);
  const transport = options.transport || (config => axios.request(config));
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const logger = options.logger || console;
  const now = options.now || Date.now;
  const defaultHeaders = { ...(options.defaultHeaders || {}) };

  async function request(config = {}) {
    const signal = config.signal || currentRequestSignal();
    const method = String(config.method || 'GET').toUpperCase();
    const operation = config.operation || `${method} ${config.path || ''}`;
    const url = safeUrl(baseURL, config.path || '/');
    const startedAt = now();
    let attempt = 0;

    while (true) {
      try {
        if (signal?.aborted) throw cancellationError();
        return await transport({
          method,
          url,
          params: config.params,
          data: config.data,
          headers: { ...defaultHeaders, ...(config.headers || {}) },
          timeout: positiveInteger(config.timeout, timeoutMs),
          signal,
          responseType: config.responseType,
          validateStatus: config.validateStatus,
          maxRedirects: config.maxRedirects,
          proxy: config.proxy,
          lookup: config.lookup,
        });
      } catch (error) {
        const category = classifyError(error);
        const status = Number(error?.response?.status) || null;
        const requestedDelay = retryDelayMs(error, attempt, now());
        const delay = Math.min(maxRetryDelayMs, requestedDelay);
        const retryable = IDEMPOTENT_METHODS.has(method)
          && ['timeout', 'rate_limited', 'upstream', 'network'].includes(category)
          && requestedDelay <= maxRetryDelayMs
          && attempt < maxRetries;
        if (retryable) {
          attempt += 1;
          try {
            await waitForRetry(delay, signal, sleep);
            continue;
          } catch (waitError) {
            error = waitError;
          }
        }

        const finalCategory = classifyError(error);
        const finalStatus = Number(error?.response?.status) || null;
        const controlled = new ExternalApiError(
          serviceName,
          operation,
          finalCategory,
          finalStatus,
          finalCategory === 'rate_limited' ? retryDelayMs(error, attempt, now()) : null
        );
        if (logger && typeof logger.warn === 'function') {
          logger.warn('[external-api]', {
            service: serviceName,
            operation,
            status: finalStatus,
            durationMs: Math.max(0, now() - startedAt),
            errorCategory: finalCategory,
            attempts: attempt + 1,
          });
        }
        throw controlled;
      }
    }
  }

  return { request };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  ExternalApiError,
  classifyError,
  createExternalApiClient,
  retryDelayMs,
};
