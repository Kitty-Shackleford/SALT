'use strict';

const PLAYER_MAP_FEATURES = Object.freeze([
  'structures',
  'deaths',
  'trail',
  'purchases',
  'lastPosition',
  'factionMembers',
  'factionMarkers',
]);

const FEATURE_FIELDS = Object.freeze({
  structures: 'territory',
  deaths: 'deaths',
  trail: 'trail',
  purchases: 'purchases',
  lastPosition: 'lastPosition',
});

function parsePlayerMapSettings(value) {
  if (value === undefined || value === null) {
    return { enabledFeatures: [...PLAYER_MAP_FEATURES] };
  }

  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch (_) {
      parsed = null;
    }
  }

  const requested = Array.isArray(parsed?.enabledFeatures)
    ? parsed.enabledFeatures
    : [];
  const enabled = new Set(requested.filter(feature => PLAYER_MAP_FEATURES.includes(feature)));

  return {
    enabledFeatures: PLAYER_MAP_FEATURES.filter(feature => enabled.has(feature)),
  };
}

function isPlayerMapFeatureEnabled(settings, feature) {
  return parsePlayerMapSettings(settings).enabledFeatures.includes(feature);
}

function projectPlayerHealthPayload(health, settings) {
  if (isPlayerMapFeatureEnabled(settings, 'lastPosition')) return health;
  const {
    last_position: _lastPosition,
    pos_x: _posX,
    pos_y: _posY,
    pos_z: _posZ,
    lastPosition: _camelLastPosition,
    posX: _camelPosX,
    posY: _camelPosY,
    posZ: _camelPosZ,
    ...projected
  } = health;
  return projected;
}

function projectPlayerMapPayload(payload, settings) {
  const normalized = parsePlayerMapSettings(settings);
  const projected = {
    success: payload.success !== false,
    playerName: payload.playerName,
    enabledFeatures: normalized.enabledFeatures,
  };

  for (const [feature, field] of Object.entries(FEATURE_FIELDS)) {
    if (normalized.enabledFeatures.includes(feature)) {
      projected[field] = payload[field];
    }
  }

  return projected;
}

module.exports = {
  PLAYER_MAP_FEATURES,
  parsePlayerMapSettings,
  isPlayerMapFeatureEnabled,
  projectPlayerHealthPayload,
  projectPlayerMapPayload,
};
