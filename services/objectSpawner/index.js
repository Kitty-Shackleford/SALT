'use strict';

const { DEFAULT_OBJECT_SPAWNER_POLICY, SUPPORTED_P3D_ROOTS } = require('./config');
const {
  buildManagedSpawnDefinition,
  managedEntryId,
  normalizeMissionRelativeJsonPath,
  normalizeObjectName,
  normalizeObjectSpawnerConfig,
} = require('./definition');
const {
  appendSpawnDefinitions,
  registerObjectSpawnerFile,
  removeManagedSpawnDefinitions,
} = require('./document');

module.exports = {
  DEFAULT_OBJECT_SPAWNER_POLICY,
  SUPPORTED_P3D_ROOTS,
  appendSpawnDefinitions,
  buildManagedSpawnDefinition,
  managedEntryId,
  normalizeMissionRelativeJsonPath,
  normalizeObjectName,
  normalizeObjectSpawnerConfig,
  registerObjectSpawnerFile,
  removeManagedSpawnDefinitions,
};
