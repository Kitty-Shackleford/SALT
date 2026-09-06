'use strict';

const { DEFAULT_OBJECT_SPAWNER_POLICY } = require('./config');
const {
  definitionIdentity,
  managedEntryId,
  normalizeMissionRelativeJsonPath,
} = require('./definition');

function objectArray(root, operation) {
  const objects = Array.isArray(root) ? root : root?.Objects;
  if (!Array.isArray(objects)) {
    throw new TypeError(`Object Spawner document must contain an Objects array during ${operation}`);
  }
  return objects;
}

function withObjects(root, objects) {
  return Array.isArray(root) ? objects : { ...root, Objects: objects };
}

function parseObjectSpawnerDocument(value, operation) {
  if (value === null || value === undefined) return { Objects: [] };
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new TypeError(`Object Spawner document must be valid JSON during ${operation}: ${error.message}`);
  }
}

function validateExistingDefinitions(objects, policy, operation = 'append') {
  if (objects.length > policy.maxDefinitionsPerFile) {
    throw new RangeError(`Object Spawner file limit is ${policy.maxDefinitionsPerFile} definitions`);
  }
  const identities = new Set();
  const managedIds = new Set();
  for (const definition of objects) {
    const identity = definitionIdentity(definition, policy);
    if (identities.has(identity)) throw new Error('Duplicate Object Spawner definition');
    identities.add(identity);
    const entryId = managedEntryId(definition);
    if (!entryId) continue;
    if (managedIds.has(entryId)) {
      throw new Error(operation === 'cleanup'
        ? 'Duplicate provider shop entry during custom JSON cleanup'
        : 'Duplicate managed Object Spawner entry');
    }
    managedIds.add(entryId);
  }
  return { identities, managedIds };
}

function appendSpawnDefinitions(root, definitions, policy = DEFAULT_OBJECT_SPAWNER_POLICY) {
  root = parseObjectSpawnerDocument(root, 'append');
  const objects = objectArray(root, 'append');
  if (!Array.isArray(definitions) || definitions.length === 0) {
    throw new TypeError('Object Spawner definitions must be a non-empty array');
  }
  if (definitions.length > policy.maxDefinitionsPerCheckout) {
    throw new RangeError(`Object Spawner checkout limit is ${policy.maxDefinitionsPerCheckout} definitions`);
  }
  if (objects.length + definitions.length > policy.maxDefinitionsPerFile) {
    throw new RangeError(`Object Spawner file limit is ${policy.maxDefinitionsPerFile} definitions`);
  }
  const { identities, managedIds } = validateExistingDefinitions(objects, policy);
  for (const definition of definitions) {
    const identity = definitionIdentity(definition, policy);
    if (identities.has(identity)) throw new Error('Duplicate Object Spawner definition');
    const entryId = managedEntryId(definition);
    if (entryId && managedIds.has(entryId)) {
      throw new Error('Duplicate managed Object Spawner entry');
    }
    identities.add(identity);
    if (entryId) managedIds.add(entryId);
  }
  return withObjects(root, objects.concat(definitions));
}

function removeManagedSpawnDefinitions(root, entryIds, policy = DEFAULT_OBJECT_SPAWNER_POLICY) {
  const objects = objectArray(root, 'cleanup');
  if (!(entryIds instanceof Set) || entryIds.size === 0) {
    throw new TypeError('Object Spawner cleanup entry IDs are required');
  }
  validateExistingDefinitions(objects, policy, 'cleanup');
  const counts = new Map();
  const remaining = objects.filter(definition => {
    const entryId = managedEntryId(definition);
    if (!entryIds.has(entryId)) return true;
    const count = (counts.get(entryId) || 0) + 1;
    if (count > 1) throw new Error('Duplicate provider shop entry during custom JSON cleanup');
    counts.set(entryId, count);
    return false;
  });
  if (counts.size !== entryIds.size) {
    throw new Error('Object Spawner cleanup did not match every tracked entry');
  }
  return withObjects(root, remaining);
}

function registerObjectSpawnerFile(gameplay, filePath) {
  if (!gameplay || typeof gameplay !== 'object' || Array.isArray(gameplay) ||
      !gameplay.WorldsData || typeof gameplay.WorldsData !== 'object' ||
      Array.isArray(gameplay.WorldsData) || !Array.isArray(gameplay.WorldsData.objectSpawnersArr)) {
    throw new TypeError('cfgGameplay.json must contain WorldsData.objectSpawnersArr');
  }
  const registeredPath = './' + normalizeMissionRelativeJsonPath(filePath);
  const existing = gameplay.WorldsData.objectSpawnersArr.map(value =>
    './' + normalizeMissionRelativeJsonPath(value)
  );
  if (existing.includes(registeredPath)) return gameplay;
  return {
    ...gameplay,
    WorldsData: {
      ...gameplay.WorldsData,
      objectSpawnersArr: existing.concat(registeredPath),
    },
  };
}

module.exports = {
  appendSpawnDefinitions,
  registerObjectSpawnerFile,
  removeManagedSpawnDefinitions,
};
