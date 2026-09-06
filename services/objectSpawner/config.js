'use strict';

const DEFAULT_OBJECT_SPAWNER_POLICY = Object.freeze({
  defaultFile: 'custom/dayz_dashboard_shop_objects.json',
  defaultScale: 1,
  defaultEnableCEPersistency: false,
  maxScale: 100,
  maxCustomStringLength: 1024,
  maxDefinitionsPerCheckout: 100,
  maxDefinitionsPerFile: 2000,
  snapshotConcurrency: 3,
});

const SUPPORTED_P3D_ROOTS = Object.freeze([
  'DZ/plants/',
  'DZ/plants_bliss/',
  'DZ/plants_sakhal/',
  'DZ/rocks/',
  'DZ/rocks_bliss/',
  'DZ/rocks_sakhal/',
]);

module.exports = { DEFAULT_OBJECT_SPAWNER_POLICY, SUPPORTED_P3D_ROOTS };
