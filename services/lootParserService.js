/*
 * DayZ Dashboard — Loot Parser Service
 * Copyright (C) 2026
 *
 * Parses DayZ Central Economy mission files (types.xml, mapgroupproto.xml,
 * mapgrouppos.xml) for a given map and builds an in-memory loot index.
 * Results are cached per-map/server and invalidated when source files change.
 *
 * Supported maps: chernarusplus, enoch (Livonia), sakhal
 *
 * Mission files are read from the user's synced downloads directory:
 *   downloads/{discordId}/server_{serverId}/{platform_missions_dir}/dayzOffline.{map}/
 */

/* eslint-disable require-atomic-updates */
const path = require('path');
const fs = require('fs');
const xml2js = require('xml2js');
const { MISSION_SUBDIRS } = require('../utils/dayzPlatform');

// Folder suffix for each supported map
const MAP_FOLDER_SUFFIX = {
  chernarusplus: 'dayzOffline.chernarusplus',
  enoch:         'dayzOffline.enoch',
  sakhal:        'dayzOffline.sakhal',
};

const DOWNLOADS_DIR = path.join(__dirname, '..', 'downloads');

// In-memory cache keyed by "discordId:serverId:mapName"
const cache = {};

// ─── XML Helpers ────────────────────────────────────────────────────────────

const xmlParser = new xml2js.Parser({ explicitArray: true, mergeAttrs: false });

/**
 * Parse an XML file and return the JS object, or null if the file doesn't exist.
 */
async function parseXmlFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, 'utf8');
  try {
    return await xmlParser.parseStringPromise(content);
  } catch {
    return null;
  }
}

/**
 * Get the last-modified time of a file (ms), or 0 if not found.
 */
function mtime(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Find the local mission directory for a given server and map.
 * Checks the root download folder and each known platform missions subdirectory.
 * Returns the absolute path to dayzOffline.{mapName} or null if not found.
 */
function resolveMapDir(guildDiscordId, serverId, mapName) {
  const folderSuffix = MAP_FOLDER_SUFFIX[mapName];
  if (!folderSuffix) return null;

  const serverRoot = path.join(DOWNLOADS_DIR, String(guildDiscordId), `server_${serverId}`);
  const searchRoots = [serverRoot, ...MISSION_SUBDIRS.map(d => path.join(serverRoot, d))];

  for (const root of searchRoots) {
    const candidate = path.join(root, folderSuffix);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// ─── Types.xml Parsing ───────────────────────────────────────────────────────

/**
 * Parse a single types.xml file and return a map of itemName → item object.
 * Custom files may only define a subset of fields; missing fields stay undefined.
 */
async function parseTypesFile(filePath) {
  const parsed = await parseXmlFile(filePath);
  if (!parsed || !parsed.types || !parsed.types.type) return {};

  const items = {};
  for (const t of parsed.types.type) {
    const name = t.$.name;
    if (!name) continue;

    items[name] = {
      name,
      nominal:  parseInt(t.nominal?.[0], 10)  ?? 0,
      min:      parseInt(t.min?.[0], 10)       ?? 0,
      lifetime: parseInt(t.lifetime?.[0], 10)  ?? 0,
      restock:  parseInt(t.restock?.[0], 10)   ?? 0,
      quantmin: parseInt(t.quantmin?.[0], 10)  ?? -1,
      quantmax: parseInt(t.quantmax?.[0], 10)  ?? -1,
      cost:     parseInt(t.cost?.[0], 10)      ?? 100,
      // Flags (from <flags> element attributes)
      flags: t.flags?.[0]?.$ ?? {},
      // Category: array of names
      category: (t.category || []).map(c => c.$.name).filter(Boolean),
      // Usage zones: array of names (Military, Police, Farm, Town, etc.)
      usages: (t.usage || []).map(u => u.$.name).filter(Boolean),
      // Value tiers: array of names (Tier1, Tier2, Tier3, Tier4)
      values: (t.value || []).map(v => v.$.name).filter(Boolean),
      // Tags
      tags: (t.tag || []).map(tg => tg.$.name).filter(Boolean),
    };
  }
  return items;
}

/**
 * Merge base types with custom overrides.
 * Custom entries override base entries by item name.
 * If only some fields are present in the custom entry, we merge at the field level.
 */
function mergeTypes(base, custom) {
  const merged = { ...base };
  for (const [name, customItem] of Object.entries(custom)) {
    if (merged[name]) {
      // Merge: override only defined numeric fields; arrays always override if non-empty
      merged[name] = {
        ...merged[name],
        ...(customItem.nominal !== undefined ? { nominal: customItem.nominal } : {}),
        ...(customItem.min !== undefined ? { min: customItem.min } : {}),
        ...(customItem.lifetime !== undefined ? { lifetime: customItem.lifetime } : {}),
        ...(customItem.restock !== undefined ? { restock: customItem.restock } : {}),
        ...(customItem.category.length ? { category: customItem.category } : {}),
        ...(customItem.usages.length ? { usages: customItem.usages } : {}),
        ...(customItem.values.length ? { values: customItem.values } : {}),
        ...(customItem.tags.length ? { tags: customItem.tags } : {}),
        flags: { ...merged[name].flags, ...customItem.flags },
      };
    } else {
      merged[name] = customItem;
    }
  }
  return merged;
}

// ─── Mapgroupproto Parsing ───────────────────────────────────────────────────

/**
 * Parse mapgroupproto.xml and return a map of groupName → Set<usageName>.
 * A group may have multiple <usage> elements defining what loot zones it accepts.
 */
async function parseMapgroupproto(filePath) {
  const parsed = await parseXmlFile(filePath);
  if (!parsed?.prototype?.group) return {};

  const groups = {};
  for (const g of parsed.prototype.group) {
    const name = g.$.name;
    if (!name) continue;
    const usages = (g.usage || []).map(u => u.$.name).filter(Boolean);
    groups[name] = new Set(usages);
  }
  return groups;
}

// ─── Mapgrouppos Parsing ─────────────────────────────────────────────────────

/**
 * Parse mapgrouppos.xml and return a map of groupName → [{x, z}].
 * pos attribute format: "x y z" (x=east, y=elevation, z=north)
 * We drop elevation (y) since it's not needed for map display.
 */
async function parseMapgrouppos(filePath) {
  const parsed = await parseXmlFile(filePath);
  if (!parsed?.map?.group) return {};

  const positions = {};
  for (const g of parsed.map.group) {
    const name = g.$.name;
    const posStr = g.$.pos;
    if (!name || !posStr) continue;

    const parts = posStr.trim().split(/\s+/);
    if (parts.length < 3) continue;

    const x = parseFloat(parts[0]);
    const z = parseFloat(parts[2]);
    if (isNaN(x) || isNaN(z)) continue;

    if (!positions[name]) positions[name] = [];
    positions[name].push({ x: Math.round(x), z: Math.round(z) });
  }
  return positions;
}

// ─── Event Groups Parsing ─────────────────────────────────────────────────────

/**
 * Parse cfgeventgroups.xml and return a map of groupName → loot containers.
 * Only includes child objects with deloot > 0 (these accept dynamic event items).
 *
 * @returns {Object} { groupName: [{type, relX, relZ}] }
 */
async function parseEventGroupsFile(filePath) {
  const parsed = await parseXmlFile(filePath);
  if (!parsed?.eventgroupdef?.group) return {};

  const groups = {};
  for (const g of parsed.eventgroupdef.group) {
    const name = g.$.name;
    if (!name) continue;

    const containers = (g.child || [])
      .filter(c => parseInt(c.$.deloot, 10) > 0)
      .map(c => ({
        type: c.$.type,
        relX: parseFloat(c.$.x) || 0,
        relZ: parseFloat(c.$.z) || 0,
      }));

    if (containers.length > 0) groups[name] = containers;
  }
  return groups;
}

// ─── Event Spawns Parsing ─────────────────────────────────────────────────────

/**
 * Parse cfgeventspawns.xml and return all spawn positions keyed by event name.
 * Each position may reference a cfgeventgroups group via the "group" attribute,
 * or be a direct fixed spawn point for the event (no group attribute).
 *
 * @returns {Object} { eventName: [{x, z, groupName}] }
 */
async function parseEventSpawnsFile(filePath) {
  const parsed = await parseXmlFile(filePath);
  if (!parsed?.eventposdef?.event) return {};

  const spawns = {};
  for (const event of parsed.eventposdef.event) {
    const eventName = event.$.name;
    if (!eventName || !event.pos) continue;

    spawns[eventName] = [];
    for (const pos of event.pos) {
      const x = parseFloat(pos.$.x);
      const z = parseFloat(pos.$.z);
      if (isNaN(x) || isNaN(z)) continue;
      spawns[eventName].push({
        x:         Math.round(x),
        z:         Math.round(z),
        groupName: pos.$.group || null,
      });
    }
  }
  return spawns;
}

// ─── Events File Parsing ──────────────────────────────────────────────────────

/**
 * Parse db/events.xml and return a map of eventName → container child types.
 * Only includes children with lootmax > 0 (actual loot containers, not animals
 * or decorative objects).
 *
 * @returns {Object} { eventName: [containerType, ...] }
 */
async function parseEventsFile(filePath) {
  const parsed = await parseXmlFile(filePath);
  if (!parsed?.events?.event) return {};

  const events = {};
  for (const event of parsed.events.event) {
    const name = event.$.name;
    if (!name) continue;

    const containers = [];
    for (const childGroup of (event.children || [])) {
      for (const child of (childGroup.child || [])) {
        if (parseInt(child.$.lootmax, 10) > 0) {
          containers.push(child.$.type);
        }
      }
    }

    if (containers.length > 0) events[name] = containers;
  }
  return events;
}

// ─── Event Spawn Index ────────────────────────────────────────────────────────

/**
 * Build a reverse index of dynamic event spawn positions by usage zone.
 *
 * Two types of positions are handled:
 *   1. Positions with a "group" attribute → resolve loot containers via
 *      cfgeventgroups (children with deloot > 0). Absolute position is the
 *      group spawn position plus the child's relative offset.
 *   2. Positions without a "group" attribute → resolve loot containers via
 *      db/events.xml (children with lootmax > 0) at the fixed position.
 *
 * In both cases the container type's usage zones (from mapgroupproto) determine
 * which item usage zones map to that spawn position.
 *
 * @returns {Object} { usageName: [{x, z}] }
 */
function buildEventSpawnIndex(groupProtos, eventGroups, events, eventSpawns) {
  const index = {};

  function addPosition(usages, x, z) {
    for (const usage of usages) {
      if (!index[usage]) index[usage] = [];
      index[usage].push({ x, z });
    }
  }

  for (const [eventName, positions] of Object.entries(eventSpawns)) {
    for (const { x: spawnX, z: spawnZ, groupName } of positions) {
      if (groupName) {
        // ── Type 1: position links to a cfgeventgroups group ──
        // Containers are the group's children with deloot > 0.
        const containers = eventGroups[groupName];
        if (!containers) continue;

        for (const { type, relX, relZ } of containers) {
          const usages = groupProtos[type];
          if (!usages || usages.size === 0) continue;
          addPosition(usages, Math.round(spawnX + relX), Math.round(spawnZ + relZ));
        }
      } else {
        // ── Type 2: direct event position with no group ──
        // Containers come from db/events.xml children with lootmax > 0.
        const containerTypes = events[eventName];
        if (!containerTypes) continue;

        for (const type of containerTypes) {
          const usages = groupProtos[type];
          if (!usages || usages.size === 0) continue;
          addPosition(usages, spawnX, spawnZ);
        }
      }
    }
  }

  return index;
}

// ─── Building Index ───────────────────────────────────────────────────────────

/**
 * Build a reverse index: usageName → [{groupName, positions}]
 * Allows fast lookup of "which buildings accept Military loot?"
 */
function buildUsageIndex(groupProtos, groupPositions) {
  const index = {}; // usageName → array of { groupName, positions }

  for (const [groupName, usageSet] of Object.entries(groupProtos)) {
    const positions = groupPositions[groupName] || [];
    if (positions.length === 0) continue;

    for (const usage of usageSet) {
      if (!index[usage]) index[usage] = [];
      index[usage].push({ groupName, positions });
    }
  }
  return index;
}

// ─── Custom Types Files from cfgeconomycore ───────────────────────────────────

/**
 * Parse cfgeconomycore.xml to discover all custom types files loaded by the server.
 * Returns an array of absolute paths to custom types.xml files.
 */
async function discoverCustomTypesFiles(mapDir) {
  const corePath = path.join(mapDir, 'cfgeconomycore.xml');
  const parsed = await parseXmlFile(corePath);
  if (!parsed?.economycore?.ce) return [];

  const customFiles = [];
  for (const ce of parsed.economycore.ce) {
    const folder = ce.$.folder;
    if (!folder || !ce.file) continue;
    for (const file of ce.file) {
      if (file.$.type === 'types' && file.$.name) {
        const filePath = path.join(mapDir, folder, file.$.name);
        if (fs.existsSync(filePath)) customFiles.push(filePath);
      }
    }
  }
  return customFiles;
}

// ─── Main Cache Builder ───────────────────────────────────────────────────────

/**
 * Get relevant file paths for a map so we can track their mtimes for cache invalidation.
 */
function getTrackedFiles(mapDir) {
  return [
    path.join(mapDir, 'db', 'types.xml'),
    path.join(mapDir, 'custom', 'types.xml'),
    path.join(mapDir, 'mapgroupproto.xml'),
    path.join(mapDir, 'mapgrouppos.xml'),
    path.join(mapDir, 'cfgeconomycore.xml'),
    path.join(mapDir, 'cfgeventgroups.xml'),
    path.join(mapDir, 'cfgeventspawns.xml'),
    path.join(mapDir, 'db', 'events.xml'),
  ];
}

/**
 * Build and cache the loot index for a given map.
 * Re-parses files only if any tracked file has changed since last parse.
 *
 * @param {string} mapName   - e.g. "chernarusplus"
 * @param {string} guildDiscordId - Guild's discord_guild_id (shared download dir for all guild members)
 * @param {string} serverId  - Nitrado platform server ID
 */
async function buildLootData(mapName, guildDiscordId, serverId) {
  if (!MAP_FOLDER_SUFFIX[mapName]) throw new Error(`Unknown map: ${mapName}`);

  const mapDir = resolveMapDir(guildDiscordId, serverId, mapName);
  if (!mapDir) {
    throw new Error(
      `Mission files for "${mapName}" not found. ` +
      `Please sync your server files from the dashboard first.`
    );
  }

  const cacheKey = `${guildDiscordId}:${serverId}:${mapName}`;

  // Check mtimes for cache invalidation
  const tracked = getTrackedFiles(mapDir);
  const currentMtimes = tracked.map(f => mtime(f));
  const cached = cache[cacheKey];
  if (cached && JSON.stringify(cached.mtimes) === JSON.stringify(currentMtimes)) {
    return cached.data;
  }

  // ── 1. Parse types.xml (base + custom overrides) ──
  const baseTypesPath = path.join(mapDir, 'db', 'types.xml');
  const baseTypes = await parseTypesFile(baseTypesPath);

  // Discover additional custom types files from cfgeconomycore
  const customTypesPaths = await discoverCustomTypesFiles(mapDir);

  // Also always include the main custom/types.xml if it exists
  const defaultCustomPath = path.join(mapDir, 'custom', 'types.xml');
  if (!customTypesPaths.includes(defaultCustomPath) && fs.existsSync(defaultCustomPath)) {
    customTypesPaths.unshift(defaultCustomPath);
  }

  // Merge all custom files in order (each overrides the previous)
  let mergedTypes = baseTypes;
  for (const customPath of customTypesPaths) {
    const customTypes = await parseTypesFile(customPath);
    mergedTypes = mergeTypes(mergedTypes, customTypes);
  }

  // ── 2. Parse mapgroupproto.xml ──
  const protoPath = path.join(mapDir, 'mapgroupproto.xml');
  let groupProtos = await parseMapgroupproto(protoPath);

  // Also check for custom mapgroupproto
  const customProtoPath = path.join(mapDir, 'custom', 'mapgroupproto.xml');
  if (fs.existsSync(customProtoPath)) {
    const customProtos = await parseMapgroupproto(customProtoPath);
    groupProtos = { ...groupProtos, ...customProtos };
  }

  // ── 3. Parse mapgrouppos.xml ──
  const posPath = path.join(mapDir, 'mapgrouppos.xml');
  const groupPositions = await parseMapgrouppos(posPath);

  // ── 4. Build usage → buildings index ──
  const usageIndex = buildUsageIndex(groupProtos, groupPositions);

  // ── 5. Parse dynamic event files and build event spawn index ──
  // cfgeventgroups.xml defines static event group compositions (loot containers).
  // cfgeventspawns.xml defines where each event (or group) spawns on the map.
  // db/events.xml defines which container types a dynamic event spawns.
  const eventGroupsPath  = path.join(mapDir, 'cfgeventgroups.xml');
  const eventSpawnsPath  = path.join(mapDir, 'cfgeventspawns.xml');
  const eventsFilePath   = path.join(mapDir, 'db', 'events.xml');

  const [eventGroups, eventSpawns, eventsFile] = await Promise.all([
    parseEventGroupsFile(eventGroupsPath),
    parseEventSpawnsFile(eventSpawnsPath),
    parseEventsFile(eventsFilePath),
  ]);

  // Index: usageName → [{x, z}] for all dynamic event container positions.
  const eventSpawnIndex = buildEventSpawnIndex(groupProtos, eventGroups, eventsFile, eventSpawns);

  // ── 6. Attach spawn points to each item ──
  const itemsWithSpawns = {};
  for (const [name, item] of Object.entries(mergedTypes)) {
    // Skip items with nominal=0 and min=0 (disabled in CE)
    if (item.nominal === 0 && item.min === 0) continue;

    // Items flagged deloot=1 belong to the dynamic event loot pool and are
    // placed by event containers (not by the static building CE cycle).
    const isDynamicEvent = item.flags.deloot === '1';

    const spawnPoints = [];

    if (isDynamicEvent) {
      // Collect positions of dynamic event containers that match this item's
      // usage zones. Items with no usage zones are eligible for all event
      // container types (no zone restriction).
      const seenPositions = new Set();
      const searchUsages = item.usages.length > 0 ? item.usages : Object.keys(eventSpawnIndex);
      for (const usage of searchUsages) {
        for (const pos of (eventSpawnIndex[usage] || [])) {
          const key = `${pos.x},${pos.z}`;
          if (seenPositions.has(key)) continue;
          seenPositions.add(key);
          spawnPoints.push(pos);
        }
      }
    } else {
      // Collect static building positions from the usage index.
      // Items with no usage zones spawn in ALL buildings (no zone restriction).
      const seenGroups = new Set();
      const searchUsages = item.usages.length > 0 ? item.usages : Object.keys(usageIndex);
      for (const usage of searchUsages) {
        for (const { groupName, positions } of (usageIndex[usage] || [])) {
          if (seenGroups.has(groupName)) continue;
          seenGroups.add(groupName);
          for (const pos of positions) {
            spawnPoints.push(pos);
          }
        }
      }
    }

    itemsWithSpawns[name] = { ...item, spawnPoints, isDynamicEvent };
  }

  // ── 7. Collect unique categories, usages, values for filter dropdowns ──
  const categories = new Set();
  const usages = new Set();
  const values = new Set();

  for (const item of Object.values(itemsWithSpawns)) {
    item.category.forEach(c => categories.add(c));
    item.usages.forEach(u => usages.add(u));
    item.values.forEach(v => values.add(v));
  }

  const data = {
    items: itemsWithSpawns,
    categories: [...categories].sort(),
    usages: [...usages].sort(),
    values: [...values].sort(),
    mapName,
    parsedAt: Date.now(),
  };

  // Update cache
  cache[cacheKey] = { data, mtimes: currentMtimes };
  return data;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get the full loot data for a map (cached).
 */
async function getLootData(mapName, guildDiscordId, serverId) {
  return buildLootData(mapName, guildDiscordId, serverId);
}

/**
 * Search items by name, category, usage zone, or tier.
 * Returns a filtered array of items (with spawn points).
 *
 * @param {string} mapName   - Map identifier
 * @param {object} filters   - { q, category, usage, value }
 * @param {number} limit     - Maximum results to return
 * @param {string} guildDiscordId - Guild's discord_guild_id
 * @param {string} serverId  - Nitrado platform server ID
 */
async function searchItems(mapName, filters = {}, limit = 100, guildDiscordId, serverId) {
  const data = await buildLootData(mapName, guildDiscordId, serverId);
  const { q = '', category = '', usage = '', value = '' } = filters;
  const query = q.toLowerCase().trim();

  const results = [];
  for (const item of Object.values(data.items)) {
    if (query && !item.name.toLowerCase().includes(query)) continue;
    if (category && !item.category.includes(category)) continue;
    if (usage && !item.usages.includes(usage)) continue;
    if (value && !item.values.includes(value)) continue;
    results.push(item);
    if (results.length >= limit) break;
  }

  // Sort: exact name match first, then by name length, then alphabetically
  results.sort((a, b) => {
    const aExact = a.name.toLowerCase() === query;
    const bExact = b.name.toLowerCase() === query;
    if (aExact !== bExact) return aExact ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return results;
}

/**
 * Get a single item by exact name.
 */
async function getItem(mapName, itemName, guildDiscordId, serverId) {
  const data = await buildLootData(mapName, guildDiscordId, serverId);
  return data.items[itemName] || null;
}

/**
 * Get all filter categories for a map.
 */
async function getAllCategories(mapName, guildDiscordId, serverId) {
  const data = await buildLootData(mapName, guildDiscordId, serverId);
  return {
    categories: data.categories,
    usages: data.usages,
    values: data.values,
  };
}

/**
 * Invalidate the cache for a specific server+map, or all entries.
 */
function invalidateCache(guildDiscordId, serverId, mapName) {
  if (guildDiscordId && serverId && mapName) {
    delete cache[`${guildDiscordId}:${serverId}:${mapName}`];
  } else {
    Object.keys(cache).forEach(k => delete cache[k]);
  }
}

module.exports = {
  getLootData,
  searchItems,
  getItem,
  getAllCategories,
  invalidateCache,
  SUPPORTED_MAPS: Object.keys(MAP_FOLDER_SUFFIX),
};
