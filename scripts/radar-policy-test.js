'use strict';

const assert = require('assert');
const {
  normalizeRadarCapabilityConfig,
  RADAR_REVEAL_MODES,
  JAMMER_SCOPES,
  JAMMER_EFFECTS,
  JAMMER_TARGETS,
  DECEPTION_ACTIONS,
} = require('../utils/radarPolicy');

const normalized = normalizeRadarCapabilityConfig({
  capability: 'jammer',
  jammerScope: 'area',
  jammerEffect: 'both',
  jammerTargets: 'enemies',
  radiusMeters: 750,
  deceptionActions: ['ping', 'build', 'ping'],
  deceptionPersistence: 'activation',
});
assert.deepStrictEqual(normalized, {
  capability: 'jammer',
  radarRevealMode: null,
  jammerScope: 'area',
  jammerEffect: 'both',
  jammerTargets: 'enemies',
  radiusMeters: 750,
  deceptionActions: ['build', 'ping'],
  deceptionPersistence: 'activation',
});

assert.deepStrictEqual(RADAR_REVEAL_MODES, ['exact', 'approximate', 'presence']);
assert.deepStrictEqual(JAMMER_SCOPES, ['full_map', 'player', 'area']);
assert.deepStrictEqual(JAMMER_EFFECTS, ['suppress', 'deceive', 'both']);
assert.deepStrictEqual(JAMMER_TARGETS, ['enemies', 'everyone_except_owner', 'everyone', 'allies']);
assert.deepStrictEqual(DECEPTION_ACTIONS, ['emote', 'placement', 'build', 'takedown', 'ping', 'location']);

assert.throws(() => normalizeRadarCapabilityConfig({
  capability: 'jammer',
  jammerScope: 'area',
  jammerEffect: 'deceive',
  jammerTargets: 'enemies',
  radiusMeters: 0,
  deceptionActions: ['ping'],
}), /radiusMeters/);

assert.throws(() => normalizeRadarCapabilityConfig({
  capability: 'jammer',
  jammerScope: 'full_map',
  jammerEffect: 'deceive',
  jammerTargets: 'enemies',
  deceptionActions: ['kill'],
}), /deceptionActions/);

assert.throws(() => normalizeRadarCapabilityConfig({
  capability: 'radar',
  radarRevealMode: 'exact',
  jammerTargets: 'enemies',
}), /jammerTargets/);

assert.throws(() => normalizeRadarCapabilityConfig({
  capability: 'radar',
  radarRevealMode: 'exact',
  deceptionPersistence: 'activation',
}), /deceptionPersistence/);

assert.throws(() => normalizeRadarCapabilityConfig({
  capability: 'jammer',
  jammerScope: 'full_map',
  jammerEffect: 'suppress',
  jammerTargets: 'enemies',
  deceptionPersistence: 'activation',
}), /deceptionPersistence/);

assert.throws(() => normalizeRadarCapabilityConfig({
  capability: 'jammer',
  jammerScope: 'full_map',
  jammerEffect: 'suppress',
  jammerTargets: 'enemies',
  deceptionActions: 'ping',
}), /deceptionActions must be an array/);

assert.throws(() => normalizeRadarCapabilityConfig({
  capability: 'radar',
  radarRevealMode: 'exact',
  unknownField: true,
}), /unknownField is not supported/);

const radar = normalizeRadarCapabilityConfig({
  capability: 'radar',
  radarRevealMode: 'approximate',
  radiusMeters: 1200,
});
assert.strictEqual(radar.radarRevealMode, 'approximate');
assert.strictEqual(radar.radiusMeters, 1200);
assert.deepStrictEqual(
  normalizeRadarCapabilityConfig(radar),
  radar,
  'canonical radar configuration must remain valid when checkout normalizes its stored snapshot'
);

console.log('radar policy tests passed');
