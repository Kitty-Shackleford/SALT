/*
 * bot/services/lootService.js
 *
 * Lightweight bot-local types.xml parser for the /economy command.
 *
 * Parses DayZ Central Economy types.xml files from the guild's synced
 * downloads directory.  Results are cached in-memory per guild+server+map
 * and invalidated when the source file changes on disk.
 *
 * This is a self-contained bot module — it intentionally does not import
 * from the main app's services/ directory so that xml2js resolves cleanly
 * from bot/node_modules/.
 */

/* eslint-disable require-atomic-updates */
const path    = require('path');
const fs      = require('fs');
const xml2js  = require('xml2js');
const { MISSION_SUBDIRS } = require('../../utils/dayzPlatform');

// Folder suffix for each supported map — mirrors lootParserService constants.
const MAP_FOLDER_SUFFIX = {
  chernarusplus: 'dayzOffline.chernarusplus',
  enoch:         'dayzOffline.enoch',
  sakhal:        'dayzOffline.sakhal',
};

const SUPPORTED_MAPS = Object.keys(MAP_FOLDER_SUFFIX);

// downloads/ is volume-mounted at /app/downloads in the bot container.
const DOWNLOADS_DIR = path.join(__dirname, '..', '..', 'downloads');

const xmlParser = new xml2js.Parser({ explicitArray: true, mergeAttrs: false });

// In-memory cache: key = "guildId:serverId:mapName"
const cache = {};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mtime(filePath) {
  try { return fs.statSync(filePath).mtimeMs; } catch { return 0; }
}

async function parseXmlFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return await xmlParser.parseStringPromise(content);
  } catch {
    return null;
  }
}

/**
 * Find the mission folder for a given guild+server+map combination.
 * Checks the server root and each known platform missions subdirectory.
 */
function resolveMapDir(guildDiscordId, serverId, mapName) {
  const suffix     = MAP_FOLDER_SUFFIX[mapName];
  if (!suffix) return null;

  const serverRoot = path.join(DOWNLOADS_DIR, String(guildDiscordId), `server_${serverId}`);
  const roots      = [serverRoot, ...MISSION_SUBDIRS.map(d => path.join(serverRoot, d))];

  for (const root of roots) {
    const candidate = path.join(root, suffix);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Parse a types.xml file into a flat item map keyed by class name.
 */
function parseTypesFile(parsed) {
  if (!parsed?.types?.type) return {};
  const items = {};
  for (const t of parsed.types.type) {
    const name = t.$.name;
    if (!name) continue;
    items[name] = {
      name,
      nominal:  parseInt(t.nominal?.[0],  10) || 0,
      min:      parseInt(t.min?.[0],       10) || 0,
      lifetime: parseInt(t.lifetime?.[0],  10) || 0,
      restock:  parseInt(t.restock?.[0],   10) || 0,
      quantmin: parseInt(t.quantmin?.[0],  10) ?? -1,
      quantmax: parseInt(t.quantmax?.[0],  10) ?? -1,
      cost:     parseInt(t.cost?.[0],      10) || 100,
      flags:    t.flags?.[0]?.$ ?? {},
      category: (t.category || []).map(c => c.$.name).filter(Boolean),
      usages:   (t.usage    || []).map(u => u.$.name).filter(Boolean),
      values:   (t.value    || []).map(v => v.$.name).filter(Boolean),
      tags:     (t.tag      || []).map(tg => tg.$.name).filter(Boolean),
    };
  }
  return items;
}

/**
 * Load, merge, and cache loot data for a guild+server+map.
 * Custom types.xml entries override base entries by class name.
 */
async function buildLootData(mapName, guildDiscordId, serverId) {
  const cacheKey = `${guildDiscordId}:${serverId}:${mapName}`;
  const mapDir   = resolveMapDir(guildDiscordId, serverId, mapName);

  if (!mapDir) {
    throw new Error(
      `Map folder not found for "${mapName}". Make sure the server files have been synced.`
    );
  }

  const basePath   = path.join(mapDir, 'db', 'types.xml');
  const customPath = path.join(mapDir, 'custom', 'types.xml');
  const baseMtime  = mtime(basePath);
  const customMtime= mtime(customPath);

  const cached = cache[cacheKey];
  if (cached && cached.baseMtime === baseMtime && cached.customMtime === customMtime) {
    return cached.items;
  }

  const baseParsed = await parseXmlFile(basePath);
  if (!baseParsed) {
    throw new Error(`types.xml not found at expected path: ${basePath}`);
  }

  let items = parseTypesFile(baseParsed);

  // Merge custom overrides if present.
  if (fs.existsSync(customPath)) {
    const customParsed = await parseXmlFile(customPath);
    if (customParsed) {
      const customItems = parseTypesFile(customParsed);
      items = { ...items, ...customItems };
    }
  }

  cache[cacheKey] = { baseMtime, customMtime, items };
  return items;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Search items by keyword / category / usage / value tier.
 * Returns up to `limit` results sorted by relevance.
 *
 * @param {string} mapName
 * @param {{ q?, category?, usage?, value? }} filters
 * @param {number} limit
 * @param {string} guildDiscordId
 * @param {string|number} serverId
 * @returns {Promise<Array>}
 */
async function searchItems(mapName, filters = {}, limit = 100, guildDiscordId, serverId) {
  const items   = await buildLootData(mapName, guildDiscordId, serverId);
  const { q = '', category = '', usage = '', value = '' } = filters;
  const query   = q.toLowerCase().trim();
  const results = [];

  for (const item of Object.values(items)) {
    if (query    && !item.name.toLowerCase().includes(query)) continue;
    if (category && !item.category.includes(category))        continue;
    if (usage    && !item.usages.includes(usage))             continue;
    if (value    && !item.values.includes(value))             continue;
    results.push(item);
    if (results.length >= limit) break;
  }

  results.sort((a, b) => {
    const aExact = a.name.toLowerCase() === query;
    const bExact = b.name.toLowerCase() === query;
    if (aExact !== bExact) return aExact ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return results;
}

/**
 * Get a single item by exact class name.
 *
 * @param {string} mapName
 * @param {string} itemName
 * @param {string} guildDiscordId
 * @param {string|number} serverId
 * @returns {Promise<object|null>}
 */
async function getItem(mapName, itemName, guildDiscordId, serverId) {
  const items = await buildLootData(mapName, guildDiscordId, serverId);
  return items[itemName] ?? null;
}

/**
 * Auto-detect the first map folder present for this guild+server.
 * Returns a SUPPORTED_MAPS key or 'chernarusplus' as a safe default.
 *
 * @param {string} guildDiscordId
 * @param {string|number} serverId
 * @returns {string}
 */
function detectMap(guildDiscordId, serverId) {
  for (const [mapKey] of Object.entries(MAP_FOLDER_SUFFIX)) {
    if (resolveMapDir(guildDiscordId, serverId, mapKey)) return mapKey;
  }
  return 'chernarusplus';
}

module.exports = { searchItems, getItem, detectMap, SUPPORTED_MAPS };
