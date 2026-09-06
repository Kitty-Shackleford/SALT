'use strict';

const { normalizeNitradoServiceId } = require('./nitradoIds');

const MAX_SERVER_NAME_LENGTH = 200;
const MAX_NITRADO_HOSTNAME_LENGTH = 80;
const INVISIBLE_NITRADO_HOSTNAME = '\u0001'.repeat(MAX_NITRADO_HOSTNAME_LENGTH);
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]/u;
const SAFE_NAME = /^[-\p{L}\p{M}\p{N}\p{Zs}\p{So}.,:;!?+#/()]+$/u;

function truncateCodePoints(value, maxLength) {
  return [...value].slice(0, maxLength).join('');
}

function normalizedPrintableName(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || UNPRINTABLE.test(trimmed) || !SAFE_NAME.test(trimmed)) return null;
  return trimmed;
}

function normalizeProviderServerName(value, serviceId) {
  const fallback = normalizeNitradoServiceId(serviceId);
  const printable = normalizedPrintableName(value);
  return printable ? truncateCodePoints(printable, MAX_SERVER_NAME_LENGTH) : fallback;
}

function normalizeCustomServerName(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new TypeError('Custom server name must be a string');
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (UNPRINTABLE.test(trimmed)) throw new TypeError('Custom server name must contain only printable characters');
  if (!SAFE_NAME.test(trimmed)) {
    throw new TypeError('Custom server name must contain only safe characters');
  }
  if ([...trimmed].length > MAX_SERVER_NAME_LENGTH) {
    throw new TypeError(`Custom server name must be ${MAX_SERVER_NAME_LENGTH} characters or fewer`);
  }
  return trimmed;
}

function resolveServerDisplayName(providerName, customName, serviceId) {
  const custom = normalizeCustomServerName(customName);
  return custom || normalizeProviderServerName(providerName, serviceId);
}

function normalizeNitradoHostname(value) {
  const hostname = normalizeCustomServerName(value);
  if (!hostname) throw new TypeError('Nitrado hostname is required');
  if ([...hostname].length > MAX_NITRADO_HOSTNAME_LENGTH) {
    throw new TypeError(`Nitrado hostname must be ${MAX_NITRADO_HOSTNAME_LENGTH} characters or fewer`);
  }
  return hostname;
}

function nitradoHostnameValue(mode, hostname) {
  if (mode === 'invisible') return INVISIBLE_NITRADO_HOSTNAME;
  if (mode === 'visible') return normalizeNitradoHostname(hostname);
  throw new TypeError('Nitrado hostname mode must be visible or invisible');
}

function classifyNitradoHostname(value) {
  if (value === INVISIBLE_NITRADO_HOSTNAME) return { mode: 'invisible', hostname: null };
  try {
    return { mode: 'visible', hostname: normalizeNitradoHostname(value) };
  } catch (_) {
    return { mode: 'unsupported', hostname: null };
  }
}

module.exports = {
  MAX_SERVER_NAME_LENGTH,
  MAX_NITRADO_HOSTNAME_LENGTH,
  INVISIBLE_NITRADO_HOSTNAME,
  normalizeProviderServerName,
  normalizeCustomServerName,
  resolveServerDisplayName,
  normalizeNitradoHostname,
  nitradoHostnameValue,
  classifyNitradoHostname,
};
