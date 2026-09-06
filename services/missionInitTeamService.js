'use strict';

const crypto = require('crypto');
const { MAP_DEFINITIONS } = require('../public/js/dayz-map-coordinates');

const MAX_TEAMS = 32;
const MAX_MEMBERS_PER_TEAM = 256;
const MAX_LOADOUT_ENTRIES = 64;
const MAX_ITEM_QUANTITY = 20;
const MAX_ITEMS_PER_TEAM = 128;
const DEFAULT_MAX_GENERATED_SOURCE_BYTES = 256 * 1024;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertExactFields(value, allowedFields, label) {
  if (!isPlainObject(value)) throw new Error(`${label} configuration is invalid`);
  const unknown = Object.keys(value).filter(key => !allowedFields.includes(key));
  if (unknown.length > 0) throw new Error(`${label} contains an unsupported field: ${unknown[0]}`);
}

function normalizeTeamConfiguration(configuration, options = {}) {
  assertExactFields(
    configuration,
    ['version', 'mapName', 'unknownPlayerPolicy', 'inventoryPolicy', 'teams'],
    'Mission team configuration'
  );
  if (configuration.version !== 1) throw new Error('Mission team configuration version is unsupported');
  if (configuration.unknownPlayerPolicy !== 'vanilla') {
    throw new Error('Unknown-player policy must preserve the vanilla loadout');
  }
  if (configuration.inventoryPolicy !== 'replace') {
    throw new Error('Known-team inventory policy must be replace');
  }
  if (!Array.isArray(configuration.teams) || configuration.teams.length < 1 ||
      configuration.teams.length > MAX_TEAMS) {
    throw new Error(`Mission team configuration requires between 1 and ${MAX_TEAMS} teams`);
  }

  const map = MAP_DEFINITIONS[configuration.mapName];
  if (!map?.verifiedGeometry) {
    throw new Error('Team spawn configuration requires a verified map');
  }
  const allowedItemClasses = options.allowedItemClasses;
  if (!(allowedItemClasses instanceof Set)) {
    throw new Error('An item class allowlist is required');
  }
  const seenIdentityIds = new Set();
  const seenTeamIds = new Set();
  for (const team of configuration.teams) {
    assertExactFields(team, ['id', 'members', 'spawn', 'loadout'], 'Team');
    if (typeof team.id !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(team.id)) {
      throw new Error('Team ID is invalid');
    }
    if (seenTeamIds.has(team.id)) throw new Error(`Duplicate team ID: ${team.id}`);
    seenTeamIds.add(team.id);
    if (!Array.isArray(team.members) || team.members.length < 1 ||
        team.members.length > MAX_MEMBERS_PER_TEAM) {
      throw new Error(`Team members must contain between 1 and ${MAX_MEMBERS_PER_TEAM} entries`);
    }
    if (!Array.isArray(team.loadout) || team.loadout.length > MAX_LOADOUT_ENTRIES) {
      throw new Error(`Team loadout may contain no more than ${MAX_LOADOUT_ENTRIES} entries`);
    }
    assertExactFields(team.spawn, ['east', 'elevation', 'north'], 'Team spawn');
    const spawn = team.spawn;
    if (!spawn || ![spawn.east, spawn.elevation, spawn.north].every(Number.isFinite) ||
        spawn.east < map.worldMinEast || spawn.east > map.worldMaxEast ||
        spawn.north < map.worldMinNorth || spawn.north > map.worldMaxNorth) {
      throw new Error('Team spawn position is outside the verified map bounds');
    }
    if (spawn.elevation < -1000 || spawn.elevation > 10000) {
      throw new Error('Team spawn elevation must be between -1000 and 10000 meters');
    }
    for (const member of team.members) {
      assertExactFields(member, ['identityKind', 'identityId'], 'Team member');
      if (member.identityKind !== 'dayz_protected') {
        throw new Error('Team member must use a DayZ protected identity');
      }
      if (typeof member.identityId !== 'string' ||
          !/^[A-Za-z0-9_-]{8,128}={0,2}$/.test(member.identityId)) {
        throw new Error('Team member protected identity ID is invalid');
      }
      if (seenIdentityIds.has(member.identityId)) {
        throw new Error(`Duplicate protected identity ID: ${member.identityId}`);
      }
      seenIdentityIds.add(member.identityId);
    }
    let totalItems = 0;
    const seenItemClasses = new Set();
    for (const item of team.loadout) {
      assertExactFields(item, ['className', 'quantity'], 'Team loadout item');
      if (typeof item.className !== 'string' ||
          !/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(item.className)) {
        throw new Error('Item class name is invalid');
      }
      if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_ITEM_QUANTITY) {
        throw new Error(`Item quantity must be an integer between 1 and ${MAX_ITEM_QUANTITY}`);
      }
      if (seenItemClasses.has(item.className)) {
        throw new Error(`Duplicate item class in team loadout: ${item.className}`);
      }
      seenItemClasses.add(item.className);
      totalItems += item.quantity;
      if (totalItems > MAX_ITEMS_PER_TEAM) {
        throw new Error(`Team loadout quantity may not exceed ${MAX_ITEMS_PER_TEAM} items`);
      }
      if (!allowedItemClasses.has(item.className)) {
        throw new Error(`Item class is not in the allowlist: ${item.className}`);
      }
    }
  }
  const normalized = {
    version: configuration.version,
    mapName: configuration.mapName,
    unknownPlayerPolicy: configuration.unknownPlayerPolicy,
    inventoryPolicy: configuration.inventoryPolicy,
    teams: configuration.teams.map(team => ({
      id: team.id,
      members: team.members.map(member => ({
        identityKind: member.identityKind,
        identityId: member.identityId,
      })),
      spawn: {
        east: team.spawn.east,
        elevation: team.spawn.elevation,
        north: team.spawn.north,
      },
      loadout: team.loadout.map(item => ({
        className: item.className,
        quantity: item.quantity,
      })),
    })),
  };
  normalized.teams.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  for (const team of normalized.teams) {
    team.members.sort((left, right) =>
      left.identityId < right.identityId ? -1 : left.identityId > right.identityId ? 1 : 0);
  }
  return normalized;
}

function formatEnforceNumber(value) {
  if (!Number.isFinite(value)) throw new Error('Enforce vector component must be finite');
  return Object.is(value, -0) ? '0' : String(value);
}

function generateTeamInitFragment(configuration, options = {}) {
  const normalized = normalizeTeamConfiguration(configuration, options);
  const serializedConfiguration = JSON.stringify(normalized);
  const configurationHash = crypto.createHash('sha256').update(serializedConfiguration).digest('hex');
  const lines = [
    `// DAYZ_DASHBOARD_TEAM_CONFIG_BEGIN ${configurationHash}`,
    'if (!player)',
    '    return;',
    '',
    'PlayerIdentity dayzDashboardIdentity = player.GetIdentity();',
    'if (dayzDashboardIdentity)',
    '{',
    'string dayzDashboardIdentityId = dayzDashboardIdentity.GetId();',
  ];

  let itemIndex = 0;
  normalized.teams.forEach((team, teamIndex) => {
    const identityConditions = team.members.map(member =>
      `dayzDashboardIdentityId == "${member.identityId}"`);
    lines.push(
      '',
      `${teamIndex === 0 ? 'if' : 'else if'} (` + identityConditions.join(' ||\n        ') + ')',
      '{',
      `    // Managed team: ${team.id}`,
      `    player.SetPosition(Vector(${formatEnforceNumber(team.spawn.east)}, ` +
        `${formatEnforceNumber(team.spawn.elevation)}, ${formatEnforceNumber(team.spawn.north)}));`,
      '    player.RemoveAllItems();'
    );
    for (const item of team.loadout) {
      for (let count = 0; count < item.quantity; count += 1) {
        lines.push(
          `    EntityAI dayzDashboardItem${itemIndex} = ` +
            `player.GetInventory().CreateInInventory("${item.className}");`,
          `    if (!dayzDashboardItem${itemIndex})`,
          '    {',
          `        Print("[dayz-dashboard-team] item-create-failed class=${item.className}");`,
          '        return;',
          '    }'
        );
        itemIndex += 1;
      }
    }
    lines.push('    return;', '}');
  });

  lines.push('}', '', '// DAYZ_DASHBOARD_TEAM_CONFIG_END', '');
  const source = lines.join('\n');
  const maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_GENERATED_SOURCE_BYTES;
  if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes < 1) {
    throw new Error('Generated source limit must be a positive safe integer');
  }
  if (Buffer.byteLength(source, 'utf8') > maxSourceBytes) {
    throw new Error('Generated mission team source exceeds the configured source limit');
  }
  return {
    configurationHash,
    source,
  };
}

module.exports = {
  generateTeamInitFragment,
  normalizeTeamConfiguration,
};
