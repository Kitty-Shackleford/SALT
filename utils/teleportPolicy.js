'use strict';

const { MAP_DEFINITIONS } = require('../public/js/dayz-map-coordinates');

const DEFAULT_TRIGGER_SIZE = Object.freeze([1.25, 2.5, 1.25]);
const MAP_NAME_PATTERN = /^[a-z0-9_-]+$/;
const DESTINATION_TYPES = new Set(['named', 'spawn', 'pra', 'punishment']);

function finitePosition(value, label) {
  if (!Array.isArray(value) || value.length !== 3 ||
      value.some(coordinate => typeof coordinate !== 'number' || !Number.isFinite(coordinate))) {
    throw new Error(`${label} position must contain three finite coordinates`);
  }
  return value.map(Number);
}

function normalizeTriggerSize(value = DEFAULT_TRIGGER_SIZE) {
  const size = finitePosition(value, 'PRA trigger size');
  if (size.some(dimension => dimension <= 0 || dimension > 10)) {
    throw new Error('PRA trigger size dimensions must be greater than 0 and no more than 10 meters');
  }
  return size;
}

function assertDestinationBounds(mapName, position) {
  const map = MAP_DEFINITIONS[mapName];
  if (!map?.verifiedGeometry) {
    throw new Error('Teleport destination map bounds are unavailable');
  }
  const [east, , north] = position;
  if (east < map.worldMinEast || east > map.worldMaxEast ||
      north < map.worldMinNorth || north > map.worldMaxNorth) {
    throw new Error('Teleport destination position is outside the map bounds');
  }
}

function normalizeDestination(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Teleport destination is required');
  }
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!name || name.length > 100) throw new Error('Teleport destination name is required');
  const mapName = typeof value.mapName === 'string' ? value.mapName.trim().toLowerCase() : '';
  if (!MAP_NAME_PATTERN.test(mapName)) throw new Error('Teleport destination map is invalid');
  const destinationType = value.destinationType === undefined ? 'named' : value.destinationType;
  if (typeof destinationType !== 'string' || !DESTINATION_TYPES.has(destinationType)) {
    throw new Error('Teleport destination type is invalid');
  }
  const isPrivate = value.isPrivate === undefined ? false : value.isPrivate;
  if (typeof isPrivate !== 'boolean') throw new Error('Teleport destination privacy is invalid');
  const position = finitePosition(value.position, 'Teleport destination');
  assertDestinationBounds(mapName, position);
  return {
    name,
    mapName,
    position,
    destinationType,
    isPrivate,
  };
}

function positiveRequestId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1 || String(value).trim() !== String(id)) {
    throw new Error('Teleport request ID must be a positive integer');
  }
  return id;
}

function praFilePath(requestId) {
  return `pra/dayz-dashboard-teleport-${positiveRequestId(requestId)}.json`;
}

function buildPraFile({ requestId, sourcePosition, destinationPosition, triggerSize }) {
  const id = positiveRequestId(requestId);
  return {
    areaName: `DayZDashboardTeleport${id}`,
    PRABoxes: [[
      normalizeTriggerSize(triggerSize),
      [0, 0, 0],
      finitePosition(sourcePosition, 'Teleport source'),
    ]],
    safePositions3D: [finitePosition(destinationPosition, 'Teleport destination')],
  };
}

function parseDisconnectPosition(line, logDate) {
  if (typeof line !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(logDate || '')) return null;
  const match = line.match(/^(\d{2}:\d{2}:\d{2}) \| Player "([^"]+)"\s*\(id=([A-Za-z0-9_-]+={0,2})\s+pos=<(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)>\)\s*has been disconnected$/);
  if (!match) return null;
  const timestamp = new Date(`${logDate}T${match[1]}Z`);
  if (Number.isNaN(timestamp.getTime())) return null;
  return {
    timestamp: timestamp.toISOString(),
    playerGamertag: match[2],
    platformUserId: match[3],
    position: [Number(match[4]), Number(match[5]), Number(match[6])],
  };
}

function registerPraPath(gameplay, filePath) {
  if (!gameplay || typeof gameplay !== 'object' || Array.isArray(gameplay) ||
      !gameplay.WorldsData || typeof gameplay.WorldsData !== 'object' ||
      Array.isArray(gameplay.WorldsData)) {
    throw new Error('cfggameplay.json WorldsData is unavailable');
  }
  if (typeof filePath !== 'string' || !/^pra\/[A-Za-z0-9._-]+\.json$/.test(filePath)) {
    throw new Error('PRA file path is invalid');
  }
  const existing = gameplay.WorldsData.playerRestrictedAreaFiles;
  if (existing !== undefined && (!Array.isArray(existing) ||
      existing.some(value => typeof value !== 'string'))) {
    throw new Error('cfggameplay.json playerRestrictedAreaFiles is invalid');
  }
  const copy = JSON.parse(JSON.stringify(gameplay));
  const paths = copy.WorldsData.playerRestrictedAreaFiles || [];
  if (!paths.includes(filePath)) paths.push(filePath);
  copy.WorldsData.playerRestrictedAreaFiles = paths;
  return copy;
}

function unregisterPraPath(gameplay, filePath) {
  const copy = registerPraPath(gameplay, filePath);
  copy.WorldsData.playerRestrictedAreaFiles =
    copy.WorldsData.playerRestrictedAreaFiles.filter(existing => existing !== filePath);
  return copy;
}

module.exports = {
  DEFAULT_TRIGGER_SIZE,
  normalizeDestination,
  normalizeTriggerSize,
  buildPraFile,
  praFilePath,
  parseDisconnectPosition,
  registerPraPath,
  unregisterPraPath,
};
