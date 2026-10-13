'use strict';

/**
 * Shared test bootstrap: seed a deterministic test-only ENCRYPTION_KEY when one
 * is not already provided by the environment, so `npm test` is hermetic and
 * does not depend on a developer's or CI's ambient environment.
 *
 * utils/encryption.js throws at require-time if ENCRYPTION_KEY is unset or is
 * not exactly 64 hex characters, so it must be present before any module that
 * transitively requires it is loaded. Tests call require('../lib/test-env')
 * (or ./lib/test-env) as their FIRST import, before anything else.
 *
 * A real key provided via the environment always wins — this only fills the
 * gap when the variable is missing or malformed, and only in a test context.
 * It never reads or writes the ambient environment for any other variable.
 */

const crypto = require('crypto');

function hasUsableEncryptionKey(env) {
  const value = env.ENCRYPTION_KEY;
  if (typeof value !== 'string') return false;
  return /^[0-9a-fA-F]{64}$/.test(value);
}

function ensureTestEncryptionKey(env = process.env) {
  if (hasUsableEncryptionKey(env)) return false;
  env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  return true;
}

module.exports = { ensureTestEncryptionKey, hasUsableEncryptionKey };
