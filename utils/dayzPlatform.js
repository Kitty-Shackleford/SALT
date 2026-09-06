'use strict';

const path = require('path');

const PLATFORM_DEFINITIONS = Object.freeze({
  xbox: Object.freeze({
    label: 'Xbox',
    games: Object.freeze(['dayzxb']),
    missionDirectory: 'dayzxb_missions',
    dataDirectory: 'dayzxb',
    dataDirectories: Object.freeze(['dayzxb']),
  }),
  playstation: Object.freeze({
    label: 'PlayStation',
    games: Object.freeze(['dayzps']),
    missionDirectory: 'dayzps_missions',
    dataDirectory: 'dayzps',
    dataDirectories: Object.freeze(['dayzps']),
  }),
  switch2: Object.freeze({
    label: 'Switch 2',
    games: Object.freeze(['dayzswitch']),
    missionDirectory: 'dayzswitch_missions',
    dataDirectory: 'dayzswitch',
    dataDirectories: Object.freeze(['dayzswitch']),
  }),
  pc: Object.freeze({
    label: 'PC',
    games: Object.freeze(['dayzstandalone', 'dayz']),
    missionDirectory: 'mpmissions',
    dataDirectory: 'dayzstandalone',
    dataDirectories: Object.freeze(['dayzstandalone', 'dayz']),
  }),
});

const MISSION_SUBDIRS = Object.freeze(
  Object.values(PLATFORM_DEFINITIONS).map(definition => definition.missionDirectory)
);

function invalidPathMetadata() {
  const error = new Error('Nitrado returned invalid game path metadata');
  error.name = 'NitradoResponseError';
  error.code = 'NITRADO_INVALID_RESPONSE';
  error.category = 'invalid_response';
  error.status = 502;
  return error;
}

function serviceText(service) {
  const details = service?.details || {};
  return [
    service?.game,
    service?.game_human,
    service?.type_human,
    details.game,
    details.folder_short,
    details.portlist_short,
  ].filter(value => typeof value === 'string').join(' ').toLowerCase();
}

function detectDayzPlatform(service) {
  const text = serviceText(service);
  if (text.includes('dayzswitch') || text.includes('switch 2')) return 'switch2';
  if (text.includes('dayzxb') || text.includes('xbox')) return 'xbox';
  if (text.includes('dayzps') || text.includes('playstation') || text.includes('dayz (ps')) return 'playstation';
  if (text.includes('dayzstandalone') || text.includes('mpmissions') || /(^|\s)dayz(\s|$|\()/.test(text)) return 'pc';
  return 'unknown';
}

function platformLabel(platform) {
  return PLATFORM_DEFINITIONS[platform]?.label || 'Unknown';
}

function isConsolePlatform(platform) {
  return platform === 'xbox' || platform === 'playstation' || platform === 'switch2';
}

function getPlatformDefinition(platform) {
  return PLATFORM_DEFINITIONS[platform] || null;
}

function platformFromGame(game) {
  const normalized = String(game || '').toLowerCase();
  return Object.entries(PLATFORM_DEFINITIONS)
    .find(([, definition]) => definition.games.includes(normalized))?.[0] || 'unknown';
}

function validateAbsoluteProviderPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') ||
      value.includes('\\') || value.includes('\0')) {
    throw invalidPathMetadata();
  }
  const trimmed = value.replace(/\/+$/, '');
  if (!trimmed || path.posix.normalize(trimmed) !== trimmed ||
      !/^\/games\/[^/]+\/(?:noftp|ftproot)(?:\/|$)/.test(trimmed)) {
    throw invalidPathMetadata();
  }
  return trimmed;
}

function resolveGameDataPath(gameserver) {
  const game = String(gameserver?.game || '').toLowerCase();
  const platform = platformFromGame(game);
  const definition = getPlatformDefinition(platform);
  const gamePath = validateAbsoluteProviderPath(gameserver?.game_specific?.path);
  if (!definition) throw invalidPathMetadata();

  if (game === 'dayzstandalone') {
    if (!gamePath.endsWith('/ftproot/dayzstandalone')) throw invalidPathMetadata();
  } else if (game === 'dayz') {
    if (!gamePath.endsWith('/noftp/dayz') && !gamePath.endsWith('/ftproot/dayz')) throw invalidPathMetadata();
  } else {
    const expectedSuffix = `/noftp/${definition.dataDirectory}`;
    if (!gamePath.endsWith(expectedSuffix)) throw invalidPathMetadata();
  }
  return gamePath;
}

function resolveMissionBasePath(gameserver) {
  const game = String(gameserver?.game || '').toLowerCase();
  const platform = platformFromGame(game);
  const definition = getPlatformDefinition(platform);
  const gamePath = resolveGameDataPath(gameserver);
  if (platform === 'pc') return `${gamePath}/mpmissions`;
  const expectedSuffix = `/noftp/${definition.dataDirectory}`;
  return `${gamePath.slice(0, -expectedSuffix.length)}/ftproot/${definition.missionDirectory}`;
}

function canonicalDataEntryPath(providerPath, definition) {
  for (const directory of definition.dataDirectories) {
    const suffix = `/ftproot/${directory}`;
    if (providerPath.endsWith(suffix)) {
      return `${providerPath.slice(0, -suffix.length)}/noftp/${directory}`;
    }
  }
  return providerPath;
}

function inspectNitradoRootEntries(entries, gameserver) {
  if (!Array.isArray(entries)) throw invalidPathMetadata();
  const expectedDataPath = resolveGameDataPath(gameserver);
  const expectedMissionPath = resolveMissionBasePath(gameserver);
  const expectedPlatform = platformFromGame(gameserver?.game);
  const namespaceMatch = expectedDataPath.match(/^(\/games\/[^/]+)\/(?:noftp|ftproot)(?:\/|$)/);
  if (!namespaceMatch || expectedPlatform === 'unknown') throw invalidPathMetadata();
  const expectedNamespace = namespaceMatch[1];
  const recognized = [];
  for (const entry of entries) {
    if (!entry || entry.type !== 'dir') continue;
    for (const [platform, definition] of Object.entries(PLATFORM_DEFINITIONS)) {
      if (entry.name === definition.missionDirectory || definition.dataDirectories.includes(entry.name)) {
        const providerPath = validateAbsoluteProviderPath(entry.path);
        if (path.posix.basename(providerPath) !== entry.name) throw invalidPathMetadata();
        if (!providerPath.startsWith(`${expectedNamespace}/`)) throw invalidPathMetadata();
        if (definition.dataDirectories.includes(entry.name) &&
            canonicalDataEntryPath(providerPath, definition) !== canonicalDataEntryPath(expectedDataPath, definition)) {
          throw invalidPathMetadata();
        }
        if (entry.name === definition.missionDirectory && providerPath !== expectedMissionPath) {
          throw invalidPathMetadata();
        }
        recognized.push({ platform, definition, entry });
      }
    }
  }
  const platforms = [...new Set(recognized.map(item => item.platform))];
  if (platforms.length !== 1) {
    return { platform: 'unknown', missionsPath: null, configPath: null, pathsToSync: [] };
  }

  const platform = platforms[0];
  if (platform !== expectedPlatform) throw invalidPathMetadata();
  const definition = PLATFORM_DEFINITIONS[platform];
  const missionEntry = recognized.find(item => item.entry.name === definition.missionDirectory)?.entry;
  const dataEntry = recognized.find(item => definition.dataDirectories.includes(item.entry.name))?.entry;
  const missionPath = missionEntry
    ? validateAbsoluteProviderPath(missionEntry.path)
    : (platform === 'pc' && dataEntry
      ? `${validateAbsoluteProviderPath(dataEntry.path)}/mpmissions`
      : null);
  const configPath = dataEntry ? `${validateAbsoluteProviderPath(dataEntry.path)}/config` : null;
  const pathsToSync = [];
  for (const item of recognized) {
    const providerPath = validateAbsoluteProviderPath(item.entry.path);
    if (!pathsToSync.includes(providerPath)) pathsToSync.push(providerPath);
  }
  return { platform, missionsPath: missionPath, configPath, pathsToSync };
}

function platformDataDirectory(platform, game) {
  const definition = getPlatformDefinition(platform);
  const normalizedGame = String(game || '').toLowerCase();
  if (definition?.dataDirectories.includes(normalizedGame)) return normalizedGame;
  return definition?.dataDirectory || null;
}

function isProviderPathWithinRoots(candidate, roots) {
  if (!Array.isArray(roots) || roots.length === 0) return false;
  try {
    const providerPath = validateAbsoluteProviderPath(candidate);
    return roots.some(root => {
      const authorizedRoot = validateAbsoluteProviderPath(root);
      return providerPath === authorizedRoot || providerPath.startsWith(`${authorizedRoot}/`);
    });
  } catch (_) {
    return false;
  }
}

module.exports = {
  PLATFORM_DEFINITIONS,
  MISSION_SUBDIRS,
  detectDayzPlatform,
  isConsolePlatform,
  platformLabel,
  platformFromGame,
  platformDataDirectory,
  isProviderPathWithinRoots,
  getPlatformDefinition,
  resolveMissionBasePath,
  resolveGameDataPath,
  inspectNitradoRootEntries,
};
