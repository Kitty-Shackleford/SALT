'use strict';

function normalizeNitradoServiceId(value) {
  const normalized = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new TypeError('Invalid Nitrado service ID');
  }
  return normalized;
}

module.exports = { normalizeNitradoServiceId };
