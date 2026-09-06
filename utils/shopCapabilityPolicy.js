'use strict';

const { normalizeRadarCapabilityConfig } = require('./radarPolicy');

function normalizeTeleportCapabilityConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Teleport capability configuration is required');
  }
  const allowed = new Set(['capability', 'destinationId']);
  const unsupported = Object.keys(input).filter(key => !allowed.has(key));
  if (unsupported.length) throw new Error(`Unsupported teleport capability fields: ${unsupported.join(', ')}`);
  const destinationId = input.destinationId;
  const valid = typeof destinationId === 'number'
    ? Number.isSafeInteger(destinationId) && destinationId > 0
    : typeof destinationId === 'string' && /^[1-9]\d*$/.test(destinationId) &&
      Number.isSafeInteger(Number(destinationId));
  if (!valid) throw new Error('Teleport capability destinationId must be a positive integer');
  return { capability: 'teleport', destinationId: Number(destinationId) };
}

function normalizeShopCapabilityConfig(input) {
  if (input?.capability === 'teleport') return normalizeTeleportCapabilityConfig(input);
  return normalizeRadarCapabilityConfig(input);
}

module.exports = { normalizeShopCapabilityConfig, normalizeTeleportCapabilityConfig };
