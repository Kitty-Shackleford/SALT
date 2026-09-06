'use strict';

const { isOwnedShopEntryId } = require('../../utils/shopEntryId');
const { DEFAULT_OBJECT_SPAWNER_POLICY, SUPPORTED_P3D_ROOTS } = require('./config');

const CLASS_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MISSION_RELATIVE_PATH_PATTERN = /^[A-Za-z0-9._/-]+$/;
const OBJECT_SPAWNER_CONFIG_FIELDS = new Set([
  'file',
  'scale',
  'enableCEPersistency',
  'customString',
]);
const OBJECT_SPAWNER_DEFINITION_FIELDS = new Set([
  'name',
  'pos',
  'ypr',
  'scale',
  'enableCEPersistency',
  'customString',
  '_shopEntryId',
]);
const MANAGED_CUSTOM_STRING_KEY = 'dayzDashboardShopEntryId';
const NEW_MANAGED_ENTRY_ID_SAMPLE = 'DAYZ_DASHBOARD_SHOP_' + '0'.repeat(32);

function finiteVector(value, field) {
  if (!Array.isArray(value) || value.length !== 3 ||
      value.some(component => typeof component !== 'number' || !Number.isFinite(component))) {
    throw new TypeError(`${field} must contain exactly three finite numbers`);
  }
  return value.slice();
}

function normalizeObjectName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) throw new TypeError('Object Spawner name is required');
  if (CLASS_NAME_PATTERN.test(name)) return name;
  if (name.startsWith('/') || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..') ||
      !name.toLowerCase().endsWith('.p3d')) {
    throw new TypeError('Object Spawner P3D path is invalid');
  }
  if (!SUPPORTED_P3D_ROOTS.some(root => name.startsWith(root))) {
    throw new TypeError('Object Spawner P3D path is not supported by DayZ');
  }
  return name;
}

function normalizeMissionRelativeJsonPath(value, policy = DEFAULT_OBJECT_SPAWNER_POLICY) {
  const submitted = value === undefined ? policy.defaultFile : value;
  if (typeof submitted !== 'string') {
    throw new TypeError('Object Spawner file must be a string');
  }
  const trimmed = submitted.trim();
  const normalized = trimmed.replace(/^\.\//, '');
  const parts = normalized.split('/');
  if (trimmed !== submitted || !normalized.endsWith('.json') || normalized.startsWith('/') ||
      normalized.includes('\\') || !MISSION_RELATIVE_PATH_PATTERN.test(normalized) ||
      parts.some(part => !part || part === '.' || part === '..')) {
    throw new TypeError('Object Spawner file must be a safe mission-relative .json path');
  }
  return normalized;
}

function normalizeObjectSpawnerConfig(value = {}, policy = DEFAULT_OBJECT_SPAWNER_POLICY) {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (error) {
      throw new TypeError('Object Spawner configuration must be valid JSON: ' + error.message);
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Object Spawner configuration must be an object');
  }
  const unknownFields = Object.keys(value).filter(field => !OBJECT_SPAWNER_CONFIG_FIELDS.has(field));
  if (unknownFields.length) {
    throw new TypeError(`Object Spawner configuration contains unknown field: ${unknownFields[0]}`);
  }
  if (value.scale !== undefined && typeof value.scale !== 'number') {
    throw new TypeError('Object Spawner scale must be a number');
  }
  const scale = value.scale ?? policy.defaultScale;
  if (!Number.isFinite(scale) || scale <= 0 || scale > policy.maxScale) {
    throw new TypeError(`Object Spawner scale must be greater than zero and at most ${policy.maxScale}`);
  }
  const persistency = value.enableCEPersistency ?? policy.defaultEnableCEPersistency;
  if (typeof persistency !== 'boolean') {
    throw new TypeError('Object Spawner enableCEPersistency must be a boolean');
  }
  if (value.customString !== undefined && typeof value.customString !== 'string') {
    throw new TypeError('Object Spawner customString must be a string');
  }
  const customString = value.customString ?? '';
  if (customString.length > policy.maxCustomStringLength) {
    throw new TypeError(`Object Spawner customString must be ${policy.maxCustomStringLength} characters or fewer`);
  }
  encodeManagedCustomString(NEW_MANAGED_ENTRY_ID_SAMPLE, customString, policy);
  return {
    file: normalizeMissionRelativeJsonPath(value.file, policy),
    scale,
    enableCEPersistency: persistency,
    customString,
  };
}

function encodeManagedCustomString(entryId, customString, policy = DEFAULT_OBJECT_SPAWNER_POLICY) {
  if (!isOwnedShopEntryId(entryId)) throw new TypeError('Invalid managed Object Spawner entry ID');
  const payload = { [MANAGED_CUSTOM_STRING_KEY]: entryId };
  if (customString) payload.data = customString;
  const encoded = JSON.stringify(payload);
  if (encoded.length > policy.maxCustomStringLength) {
    throw new TypeError(`Managed Object Spawner customString exceeds ${policy.maxCustomStringLength} characters`);
  }
  return encoded;
}

function managedEntryId(definition) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) return null;
  let customMarkerPresent = false;
  let customMarkerValue;
  if (typeof definition.customString === 'string') {
    try {
      const payload = JSON.parse(definition.customString);
      if (payload && typeof payload === 'object' && !Array.isArray(payload) &&
          Object.prototype.hasOwnProperty.call(payload, MANAGED_CUSTOM_STRING_KEY)) {
        customMarkerPresent = true;
        customMarkerValue = payload[MANAGED_CUSTOM_STRING_KEY];
      }
    } catch (_error) {
      // Unmanaged custom user data is valid DayZ input.
    }
  }
  const legacyMarkerPresent = Object.prototype.hasOwnProperty.call(definition, '_shopEntryId');
  const legacyMarkerValue = definition._shopEntryId;
  if (customMarkerPresent && legacyMarkerPresent && customMarkerValue !== legacyMarkerValue) {
    throw new Error('Object Spawner managed entry identifiers disagree');
  }
  if (customMarkerPresent && !isOwnedShopEntryId(customMarkerValue)) {
    throw new Error('Invalid managed Object Spawner entry ID in customString');
  }
  if (legacyMarkerPresent && !isOwnedShopEntryId(legacyMarkerValue)) {
    throw new Error('Invalid managed Object Spawner entry ID in _shopEntryId');
  }
  const customEntryId = isOwnedShopEntryId(customMarkerValue) ? customMarkerValue : null;
  const legacyEntryId = isOwnedShopEntryId(legacyMarkerValue) ? legacyMarkerValue : null;
  return customEntryId || legacyEntryId;
}

function buildManagedSpawnDefinition(input, entryId, policy = DEFAULT_OBJECT_SPAWNER_POLICY) {
  const config = normalizeObjectSpawnerConfig({
    file: input?.file,
    scale: input?.scale,
    enableCEPersistency: input?.enableCEPersistency,
    customString: input?.customString,
  }, policy);
  return {
    name: normalizeObjectName(input?.name),
    pos: finiteVector(input?.pos, 'Object Spawner position'),
    ypr: finiteVector(input?.ypr ?? [0, 0, 0], 'Object Spawner rotation'),
    scale: config.scale,
    enableCEPersistency: config.enableCEPersistency,
    customString: encodeManagedCustomString(entryId, config.customString, policy),
  };
}

function definitionIdentity(definition, policy = DEFAULT_OBJECT_SPAWNER_POLICY) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new TypeError('Object Spawner definition must be an object');
  }
  const unknownFields = Object.keys(definition).filter(field => !OBJECT_SPAWNER_DEFINITION_FIELDS.has(field));
  if (unknownFields.length) {
    throw new TypeError(`Object Spawner definition contains unknown field: ${unknownFields[0]}`);
  }
  if (definition.scale !== undefined && typeof definition.scale !== 'number') {
    throw new TypeError('Object Spawner scale must be a number');
  }
  const scale = definition.scale ?? policy.defaultScale;
  if (!Number.isFinite(scale) || scale <= 0 || scale > policy.maxScale) {
    throw new TypeError(`Object Spawner scale must be greater than zero and at most ${policy.maxScale}`);
  }
  if (definition.enableCEPersistency !== undefined &&
      typeof definition.enableCEPersistency !== 'boolean' &&
      definition.enableCEPersistency !== 0 && definition.enableCEPersistency !== 1) {
    throw new TypeError('Object Spawner enableCEPersistency must be a boolean or 0/1');
  }
  if (definition.customString !== undefined && typeof definition.customString !== 'string') {
    throw new TypeError('Object Spawner customString must be a string');
  }
  if ((definition.customString || '').length > policy.maxCustomStringLength) {
    throw new TypeError(`Object Spawner customString must be ${policy.maxCustomStringLength} characters or fewer`);
  }
  return JSON.stringify([
    normalizeObjectName(definition.name),
    finiteVector(definition.pos, 'Object Spawner position'),
    finiteVector(definition.ypr ?? [0, 0, 0], 'Object Spawner rotation'),
    scale,
  ]);
}

module.exports = {
  buildManagedSpawnDefinition,
  definitionIdentity,
  managedEntryId,
  normalizeMissionRelativeJsonPath,
  normalizeObjectName,
  normalizeObjectSpawnerConfig,
};
