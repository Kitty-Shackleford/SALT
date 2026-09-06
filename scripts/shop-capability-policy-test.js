'use strict';

const assert = require('assert');
const { normalizeShopCapabilityConfig } = require('../utils/shopCapabilityPolicy');

assert.deepStrictEqual(normalizeShopCapabilityConfig({
  capability: 'teleport', destinationId: 7,
}), { capability: 'teleport', destinationId: 7 });
assert.throws(() => normalizeShopCapabilityConfig({
  capability: 'teleport', destinationId: '../7',
}), /destinationId/);
assert.throws(() => normalizeShopCapabilityConfig({
  capability: 'teleport', destinationId: 7, forced: true,
}), /unsupported/i);
assert.strictEqual(normalizeShopCapabilityConfig({
  capability: 'radar', radarRevealMode: 'exact',
}).capability, 'radar');

console.log('✅ Shop capability policy tests passed');
