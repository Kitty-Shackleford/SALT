'use strict';

const STATUS_BY_CATEGORY = {
  rate_limited: 429,
  not_found: 404,
  client: 400,
  authentication: 424,
  timeout: 504,
  upstream: 503,
  network: 503,
  invalid_response: 502,
  cancelled: 499,
  conflict: 409,
};

const MESSAGE_BY_CATEGORY = {
  rate_limited: 'rate limit exceeded',
  not_found: 'resource was not found',
  client: 'request was rejected',
  authentication: 'authentication failed',
  timeout: 'request timed out',
  upstream: 'service is temporarily unavailable',
  network: 'service is unreachable',
  invalid_response: 'returned an invalid response',
  cancelled: 'request was cancelled',
  conflict: 'resource changed before the operation completed',
};

function sendExternalApiError(res, error, fallbackService = 'External service') {
  const category = error?.category;
  const service = error?.service || fallbackService;
  if (!category || !STATUS_BY_CATEGORY[category]) {
    return res.status(500).json({
      success: false,
      error: `${fallbackService} request failed`,
      code: 'EXTERNAL_API_ERROR',
      service: fallbackService,
      category: 'unknown',
    });
  }

  const retryAfterSeconds = Number.isFinite(error.retryAfterMs)
    ? Math.max(0, Math.ceil(error.retryAfterMs / 1000))
    : undefined;
  if (retryAfterSeconds !== undefined && typeof res.set === 'function') {
    res.set('Retry-After', String(retryAfterSeconds));
  }
  return res.status(STATUS_BY_CATEGORY[category]).json({
    success: false,
    error: `${service} ${MESSAGE_BY_CATEGORY[category]}`,
    code: error.code || `${String(service).toUpperCase()}_${category.toUpperCase()}`.replace(/[^A-Z0-9_]/g, '_'),
    service,
    category,
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  });
}

module.exports = { sendExternalApiError };
