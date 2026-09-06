'use strict';

const RADAR_REVEAL_MODES = Object.freeze(['exact', 'approximate', 'presence']);
const JAMMER_SCOPES = Object.freeze(['full_map', 'player', 'area']);
const JAMMER_EFFECTS = Object.freeze(['suppress', 'deceive', 'both']);
const JAMMER_TARGETS = Object.freeze(['enemies', 'everyone_except_owner', 'everyone', 'allies']);
const DECEPTION_ACTIONS = Object.freeze(['emote', 'placement', 'build', 'takedown', 'ping', 'location']);
const DECEPTION_PERSISTENCE = Object.freeze(['transient', 'activation', 'audit']);
const CAPABILITY_CONFIG_FIELDS = Object.freeze([
  'capability',
  'radarRevealMode',
  'jammerScope',
  'jammerEffect',
  'jammerTargets',
  'radiusMeters',
  'deceptionActions',
  'deceptionPersistence',
]);

function rejectUnknownFields(input) {
  for (const field of Object.keys(input)) {
    if (!CAPABILITY_CONFIG_FIELDS.includes(field)) {
      throw new Error(`${field} is not supported`);
    }
  }
}

function requireEnum(value, allowed, field) {
  if (!allowed.includes(value)) throw new Error(`${field} is invalid`);
  return value;
}

function normalizeRadius(value, required) {
  if (value === null || value === undefined || value === '') {
    if (required) throw new Error('radiusMeters is required');
    return null;
  }
  const radius = Number(value);
  if (!Number.isFinite(radius) || radius <= 0 || radius > 25000) {
    throw new Error('radiusMeters must be between 1 and 25000');
  }
  return radius;
}

function normalizeRadarCapabilityConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || !['radar', 'jammer'].includes(input.capability)) {
    throw new Error('capability must be radar or jammer');
  }
  rejectUnknownFields(input);

  if (input.capability === 'radar') {
    for (const jammerField of [
      'jammerScope', 'jammerEffect', 'jammerTargets', 'deceptionPersistence'
    ]) {
      if (input[jammerField] !== undefined && input[jammerField] !== null) {
        throw new Error(`${jammerField} is not valid for radar products`);
      }
    }
    if (input.deceptionActions !== undefined && input.deceptionActions !== null &&
        (!Array.isArray(input.deceptionActions) || input.deceptionActions.length > 0)) {
      throw new Error('deceptionActions is not valid for radar products');
    }
    return {
      capability: 'radar',
      radarRevealMode: requireEnum(input.radarRevealMode, RADAR_REVEAL_MODES, 'radarRevealMode'),
      jammerScope: null,
      jammerEffect: null,
      jammerTargets: null,
      radiusMeters: normalizeRadius(input.radiusMeters, false),
      deceptionActions: [],
      deceptionPersistence: null,
    };
  }

  if (input.radarRevealMode !== undefined && input.radarRevealMode !== null) {
    throw new Error('radarRevealMode is not valid for jammer products');
  }
  const jammerScope = requireEnum(input.jammerScope, JAMMER_SCOPES, 'jammerScope');
  const jammerEffect = requireEnum(input.jammerEffect, JAMMER_EFFECTS, 'jammerEffect');
  if (input.deceptionActions !== undefined && !Array.isArray(input.deceptionActions)) {
    throw new Error('deceptionActions must be an array');
  }
  const requestedActions = input.deceptionActions || [];
  if (requestedActions.some(action => !DECEPTION_ACTIONS.includes(action))) {
    throw new Error('deceptionActions contains an unsupported or violent action');
  }
  const deceptionActions = DECEPTION_ACTIONS.filter(action => requestedActions.includes(action));
  if (jammerEffect !== 'suppress' && deceptionActions.length === 0) {
    throw new Error('deceptionActions is required for deceptive jammers');
  }
  if (jammerEffect === 'suppress' && deceptionActions.length > 0) {
    throw new Error('deceptionActions is not valid for suppress-only jammers');
  }
  if (jammerEffect === 'suppress'
      && input.deceptionPersistence !== undefined
      && input.deceptionPersistence !== null) {
    throw new Error('deceptionPersistence is not valid for suppress-only jammers');
  }

  return {
    capability: 'jammer',
    radarRevealMode: null,
    jammerScope,
    jammerEffect,
    jammerTargets: requireEnum(input.jammerTargets, JAMMER_TARGETS, 'jammerTargets'),
    radiusMeters: normalizeRadius(input.radiusMeters, jammerScope !== 'full_map'),
    deceptionActions,
    deceptionPersistence: jammerEffect === 'suppress'
      ? null
      : requireEnum(input.deceptionPersistence || 'transient', DECEPTION_PERSISTENCE, 'deceptionPersistence'),
  };
}

module.exports = {
  RADAR_REVEAL_MODES,
  JAMMER_SCOPES,
  JAMMER_EFFECTS,
  JAMMER_TARGETS,
  DECEPTION_ACTIONS,
  DECEPTION_PERSISTENCE,
  normalizeRadarCapabilityConfig,
};
