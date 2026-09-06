'use strict';

const { isDeepStrictEqual } = require('util');

function normalizeJson(value, fallback) {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (_error) {
      return value;
    }
  }
  return value ?? fallback;
}

function normalizeEventConfig(value) {
  return normalizeJson(value, {});
}

function rentalRestartsForComparison(item) {
  return String(item.item_type || 'item') === 'event_rental'
    ? Number(item.rental_restarts || 0)
    : 1;
}

function provisioningFieldsChanged(existing, next) {
  return String(existing.spawn_method || '') !== String(next.spawn_method || '') ||
    String(existing.item_class || '') !== String(next.item_class || '') ||
    String(existing.item_type || 'item') !== String(next.item_type || 'item') ||
    rentalRestartsForComparison(existing) !== rentalRestartsForComparison(next) ||
    String(existing.custom_json_file || '') !== String(next.custom_json_file || '') ||
    !isDeepStrictEqual(
      normalizeJson(existing.object_spawner_config, null),
      normalizeJson(next.object_spawner_config, null)
    ) ||
    !isDeepStrictEqual(
      normalizeEventConfig(existing.event_config),
      normalizeEventConfig(next.event_config)
    ) ||
    !isDeepStrictEqual(
      normalizeJson(existing.capability_config, null),
      normalizeJson(next.capability_config, null)
    );
}

module.exports = { normalizeEventConfig, provisioningFieldsChanged };
