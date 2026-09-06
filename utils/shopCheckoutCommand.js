'use strict';

const { fingerprintFinancialRequest } = require('./financialIdempotency');

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function commandError(message) {
  const error = new TypeError(message);
  error.status = 400;
  return error;
}

function positiveInteger(value, field) {
  const text = String(value ?? '');
  if (!/^[1-9]\d*$/.test(text)) {
    throw commandError(`${field} must be a positive integer`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    throw commandError(`${field} must be a safe positive integer`);
  }
  return parsed;
}

function parseShopCheckoutCommand(body = {}) {
  const cartId = positiveInteger(body.cartId, 'cartId');
  const cartFingerprint = typeof body.cartFingerprint === 'string'
    ? body.cartFingerprint.toLowerCase()
    : '';
  if (!SHA256_PATTERN.test(cartFingerprint)) {
    throw commandError('cartFingerprint must be a SHA-256 digest');
  }
  return { cartId, cartFingerprint };
}

function normalizeFingerprintValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(normalizeFingerprintValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key, normalizeFingerprintValue(item),
    ]));
  }
  return value;
}

function buildShopCartFingerprint(cart, items) {
  const cartId = positiveInteger(cart?.id, 'cart.id');
  if (!Array.isArray(items)) throw new TypeError('Cart items must be an array');
  const orderedItems = items
    .map(item => ({ ...item, id: positiveInteger(item?.id, 'cart item id') }))
    .sort((left, right) => left.id - right.id)
    .map(normalizeFingerprintValue);
  return fingerprintFinancialRequest({
    version: 1,
    cart: {
      id: cartId,
      identityId: positiveInteger(cart?.identity_id, 'cart.identity_id'),
      serverId: positiveInteger(cart?.server_id, 'cart.server_id'),
      totalPrice: String(cart?.total_price ?? ''),
    },
    items: orderedItems,
  });
}

module.exports = {
  buildShopCartFingerprint,
  parseShopCheckoutCommand,
};
