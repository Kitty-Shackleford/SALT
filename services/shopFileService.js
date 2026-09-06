/*
 * DayZ Dashboard - Shop File Service
 * Copyright (C) 2026
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License.
 *
 * Handles updating DayZ server files when players purchase shop items.
 *
 * Provider-backed checkout supports CE events, Object Spawner definitions, and
 * cfgEffectArea placement. cfgEffectArea also accepts ordinary DayZ class names for
 * compatibility, although classes that do not inherit EffectArea may crash startup.
 *
 * All file operations use the Nitrado API via missionFileService helpers.
 * Files are updated immediately on checkout; items spawn on next server restart.
 */

const crypto = require('crypto');
const xml2js = require('xml2js');
const { XMLParser, XMLBuilder, XMLValidator } = require('fast-xml-parser');
const missionFileService = require('./missionFileService');
const spawnExclusionService = require('./spawnExclusionService');
const { runWithoutRequestSignal } = require('../utils/requestAbort');
const moneySupplyManager = require('../utils/moneySupplyManager');
const { parseCents, parseCentsBigInt, checkedAddCents, centsToAmount, centsToDecimal } = require('../utils/money');
const { isOwnedShopEntryId } = require('../utils/shopEntryId');
const { lockTrustedFinancialIdentity } = require('../utils/linkTrust');
const { activateRadarCapabilities } = require('./radarService');
const { normalizeShopCapabilityConfig } = require('../utils/shopCapabilityPolicy');
const { lockPlayerTeleportEligibility, requestPlayerTeleport } = require('./teleportService');
const { insertOrVerifyPendingRefundClaim } = require('../utils/refundClaimManager');
const {
  calculateProratedRentalRefund,
  validateRefundDecision,
} = require('./shopRentalRefundService');
const {
  MAX_SNAPSHOT_FILES,
  captureProviderSnapshots,
} = require('./shopCheckout/providerSnapshots');
const { createStagedProviderFiles } = require('./shopCheckout/stagedProviderFiles');
const {
  DEFAULT_OBJECT_SPAWNER_POLICY,
  appendSpawnDefinitions,
  buildManagedSpawnDefinition,
  normalizeMissionRelativeJsonPath: normalizeObjectSpawnerPath,
  normalizeObjectName,
  normalizeObjectSpawnerConfig,
  registerObjectSpawnerFile,
  removeManagedSpawnDefinitions,
} = require('./objectSpawner');
const {
  assertNoUnresolvedProviderMutation,
  compensateProviderMutation,
  prepareProviderMutation,
  registerProviderMutationRollback,
  updatePreparedProviderMutation,
} = require('./providerMutationRecoveryService');

const LEGACY_OBJECT_SPAWNER_FILE = 'custom/shop.json';

// ---------------------------------------------------------------------------
// Token helpers (mirrors pattern from routes/missionFiles.js)
// ---------------------------------------------------------------------------

function decrypt(encryptedText) {
  if (!encryptedText) return null;
  try {
    const ENCRYPTION_KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
    const [ivHex, encrypted] = encryptedText.split(':');
    if (!ivHex || !encrypted) return null;
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('Decryption failed:', err.message);
    return null;
  }
}

/**
 * Retrieve and decrypt the Nitrado token for a server (by internal DB server id).
 * @param {object} db - DB abstraction
 * @param {number} serverId - internal servers.id
 * @returns {Promise<{token: string, platformServerId: string}|null>}
 */
async function getTokenForServer(db, serverId) {
  const row = await db.get(`
    SELECT gt.token_hash, s.platform_server_id
    FROM servers s
    JOIN guilds g ON s.guild_id = g.id
    JOIN guild_tokens gt ON g.id = gt.guild_id
    WHERE s.id = $1
      AND s.status = 'active'
      AND g.status = 'approved'
      AND gt.token_type = 'nitrado'
      AND gt.nitrado_user_id IS NOT NULL
    LIMIT 1
    FOR NO KEY UPDATE OF s, g, gt
  `, [serverId]);

  if (!row || !row.token_hash) return null;
  return {
    token: decrypt(row.token_hash),
    platformServerId: row.platform_server_id,
  };
}

/** Journal remote mutations so failed multi-file operations can be restored. */
function createFileMutationJournal(
  platformServerId,
  nitradoToken,
  baseFileService = missionFileService,
  durableSnapshots = null
) {
  const originals = new Map();
  const expected = durableSnapshots instanceof Map ? new Map(durableSnapshots) : new Map();
  const hasDurablePlan = durableSnapshots instanceof Map;
  const attemptedContents = new Map();
  const attemptedPaths = [];
  const pendingPaths = new Set();
  let rolledBack = false;

  return {
    async downloadFileFromServer(serverId, filePath, token) {
      const raw = await baseFileService.downloadFileFromServer(serverId, filePath, token);
      if (expected.has(filePath) && expected.get(filePath) !== raw) {
        throw new Error('Concurrent provider edit detected for ' + filePath);
      }
      expected.set(filePath, raw);
      return raw;
    },
    async uploadFileToServer(serverId, dirPath, fileName, content, token) {
      const filePath = dirPath.replace(/\/$/, '') + '/' + fileName;
      if (hasDurablePlan && !durableSnapshots.has(filePath)) {
        throw new Error('Provider write was not included in the durable provider plan: ' + filePath);
      }
      const current = await baseFileService.downloadFileFromServer(serverId, filePath, token);
      if (expected.has(filePath) && expected.get(filePath) !== current) {
        throw new Error('Concurrent provider edit detected for ' + filePath);
      }
      if (!originals.has(filePath)) {
        originals.set(filePath, current);
        attemptedPaths.push(filePath);
        pendingPaths.add(filePath);
      }
      if (!attemptedContents.has(filePath)) attemptedContents.set(filePath, new Set());
      attemptedContents.get(filePath).add(content);
      await baseFileService.uploadFileToServer(serverId, dirPath, fileName, content, token);
      const verified = await baseFileService.downloadFileFromServer(serverId, filePath, token);
      if (verified !== content) throw new Error('Verification failed for ' + filePath);
      expected.set(filePath, content);
    },
    async deleteFileFromServer(serverId, filePath, token) {
      if (hasDurablePlan && !durableSnapshots.has(filePath)) {
        throw new Error('Provider write was not included in the durable provider plan: ' + filePath);
      }
      const current = await baseFileService.downloadFileFromServer(serverId, filePath, token);
      if (expected.has(filePath) && expected.get(filePath) !== current) {
        throw new Error('Concurrent provider edit detected for ' + filePath);
      }
      if (!originals.has(filePath)) {
        originals.set(filePath, current);
        attemptedPaths.push(filePath);
        pendingPaths.add(filePath);
      }
      if (!attemptedContents.has(filePath)) attemptedContents.set(filePath, new Set());
      attemptedContents.get(filePath).add(current);
      await baseFileService.deleteFileFromServer(serverId, filePath, token);
      const verified = await baseFileService.downloadFileFromServer(serverId, filePath, token);
      if (verified !== null && verified !== undefined) {
        throw new Error('Deletion verification failed for ' + filePath);
      }
      expected.set(filePath, verified);
    },
    async rollback() {
      return runWithoutRequestSignal(async () => {
        if (rolledBack) return;
        const failures = [];
        for (const filePath of attemptedPaths.slice().reverse()) {
          if (!pendingPaths.has(filePath)) continue;
          try {
            const original = originals.get(filePath);
            const current = await baseFileService.downloadFileFromServer(
              platformServerId,
              filePath,
              nitradoToken
            );
            if (current === original) {
              expected.set(filePath, original);
              pendingPaths.delete(filePath);
              continue;
            }
            const knownJournalContent = current === expected.get(filePath) ||
              attemptedContents.get(filePath)?.has(current);
            if (!knownJournalContent) {
              throw new Error('Concurrent provider edit detected during rollback');
            }
            if (original === null || original === undefined) {
              await baseFileService.deleteFileFromServer(platformServerId, filePath, nitradoToken);
            } else {
              const lastSlash = filePath.lastIndexOf('/');
              await baseFileService.uploadFileToServer(
                platformServerId,
                filePath.slice(0, lastSlash),
                filePath.slice(lastSlash + 1),
                original,
                nitradoToken
              );
            }
            const restored = await baseFileService.downloadFileFromServer(
              platformServerId,
              filePath,
              nitradoToken
            );
            if (restored !== original) {
              throw new Error('Rollback verification failed');
            }
            expected.set(filePath, original);
            pendingPaths.delete(filePath);
          } catch (error) {
            failures.push(filePath + ': ' + error.message);
          }
        }
        if (failures.length > 0) {
          throw new Error('Failed to restore shop server files: ' + failures.join('; '));
        }
        rolledBack = true;
      });
    },
  };
}

/** Serialize every remote shop-file mutation for one internal server. */
async function acquireShopServerLock(db, serverId) {
  const numericServerId = Number(serverId);
  if (!Number.isSafeInteger(numericServerId) || numericServerId <= 0) {
    throw new Error('Invalid shop server ID');
  }
  try {
    await db.acquireTransactionAdvisoryLock(0x53484f50, numericServerId);
  } catch (error) {
    if (error?.code !== '55P03') throw error;
    const busy = new Error('Another shop order is already being processed for this server. Try again shortly.');
    busy.code = 'SHOP_BUSY';
    busy.cause = error;
    throw busy;
  }
}

async function acquireProviderMutationLock(db, serverId, {
  allowedOperationId = null,
  allowedRotationOperationId = null,
} = {}) {
  await acquireShopServerLock(db, serverId);
  await assertNoUnresolvedProviderMutation(
    db, serverId, allowedOperationId ?? allowedRotationOperationId
  );
}

// ---------------------------------------------------------------------------
// Stable identifiers for provider-backed shop entries
// ---------------------------------------------------------------------------

const SHOP_ENTRY_PREFIX = 'DAYZ_DASHBOARD_SHOP_';

/**
 * Generate a unique DayZ Dashboard marker for a shop order item.
 * Older persisted markers remain readable through isOwnedShopEntryId().
 * @param {number|string} orderItemId
 * @returns {string}
 */
function generateAreaName(orderItemId) {
  const hash = crypto
    .createHash('md5')
    .update('shop_order_item_' + orderItemId + '_' + Date.now())
    .digest('hex');
  return SHOP_ENTRY_PREFIX + hash;
}

function finitePlacementNumber(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(field + ' must be a valid finite number');
  return number;
}

/** Build a cfgEffectArea entry. DayZ Pos order is always [X, Y, Z]. */
function buildEffectAreaEntry(placement) {
  return {
    AreaName: placement.entryId,
    _shopEntryId: placement.entryId,
    Type: placement.itemClass,
    Data: {
      Pos: [
        finitePlacementNumber(placement.posX, 'posX'),
        finitePlacementNumber(placement.posY, 'posY'),
        finitePlacementNumber(placement.posZ, 'posZ'),
      ],
      Radius: 1,
    },
  };
}

/** Build one official cfgGameplay Object Spawner definition in [X, Y, Z] order. */
function buildObjectSpawnerEntry(placement) {
  return buildManagedSpawnDefinition({
    name: placement.itemClass,
    pos: [placement.posX, placement.posY, placement.posZ],
    ypr: [placement.yaw || 0, placement.pitch || 0, placement.roll || 0],
    ...(placement.objectSpawnerConfig || {}),
  }, placement.entryId);
}

/** Map UI X/Y/Z to cfgeventspawns attributes (x, z, heading a, optional y). */
function buildEventSpawnPosition(placement) {
  const position = {
    x: finitePlacementNumber(placement.posX, 'posX'),
    z: finitePlacementNumber(placement.posZ, 'posZ'),
    a: finitePlacementNumber(placement.yaw || 0, 'yaw'),
  };
  const elevation = finitePlacementNumber(placement.posY ?? 0, 'posY');
  if (elevation !== 0) position.y = elevation;
  return position;
}

// ---------------------------------------------------------------------------
// cfgEffectArea.json legacy readback and cleanup
// ---------------------------------------------------------------------------

/**
 * Resolve the effect-area file path for this mission.
 * This deployment uses cfgEffectArea.json only.
 */
async function resolveEffectAreaFilePath(platformServerId, nitradoToken, missionDir, fileService = missionFileService) {
  const jsonPath = missionDir + '/cfgEffectArea.json';
  const jsonRaw = await fileService.downloadFileFromServer(platformServerId, jsonPath, nitradoToken);
  return { filePath: jsonPath, raw: jsonRaw };
}

/**
 * Download cfgEffectArea.json from the server, add new entries, and upload back.
 *
 * Supports both formats seen in the wild:
 *   1) Root array:
 *      [{ "AreaName": "...", "Type": "...", "Data": { ... } }, ...]
 *   2) Wrapped object:
 *      { "Areas": [...], "SafePositions": [...] }
 *
 * @param {string} platformServerId - Nitrado service ID
 * @param {string} nitradoToken
 * @param {string} missionDir - e.g. /mpmissions/dayz.chernarusplus
 * @param {Array}  newEntries - array of effect-area objects to append
 */
async function appendEffectAreaEntries(platformServerId, nitradoToken, missionDir, newEntries, fileService = missionFileService) {
  const { filePath, raw } = await resolveEffectAreaFilePath(platformServerId, nitradoToken, missionDir, fileService);
  console.log('🛍️  Updating cfgEffectArea at', filePath);

  // Refuse to create a partial mission-root override. When this file is absent,
  // DayZ falls back to the packaged world configuration; creating a shop-only
  // file would silently disable every packaged effect area and safe position.
  if (raw === null || raw === undefined) {
    throw new Error('cfgEffectArea.json not found; provision the complete mission baseline before shop updates');
  }

  let root;
  try {
    root = JSON.parse(raw);
  } catch (e) {
    throw new Error('Cannot update malformed cfgEffectArea.json: ' + e.message);
  }

  // Preserve existing wrapper object shape when present.
  if (Array.isArray(root)) {
    root = root.concat(newEntries);
  } else if (root && typeof root === 'object' && Array.isArray(root.Areas)) {
    root.Areas = root.Areas.concat(newEntries);
  } else {
    throw new Error('Unsupported cfgEffectArea.json structure');
  }
  const content = JSON.stringify(root, null, 2);

  // uploadFileToServer takes (platformServerId, dirPath, fileName, content, token)
  const lastSlash = filePath.lastIndexOf('/');
  const dir = filePath.slice(0, lastSlash);
  const fileName = filePath.slice(lastSlash + 1);
  await fileService.uploadFileToServer(platformServerId, dir, fileName, content, nitradoToken);
  console.log('   ✅ cfgEffectArea updated (' + newEntries.length + ' new entries)');
}

// ---------------------------------------------------------------------------
// Custom JSON object-array file
// ---------------------------------------------------------------------------

/**
 * Download a custom JSON spawn file, append new object entries, and upload back.
 *
 * Standard object-spawner format:
 *   { "Objects": [{ "name": "...", "pos": [...], "ypr": [...], "scale": 1, "enableCEPersistency": 0 }] }
 * Legacy root arrays are preserved for compatibility.
 *
 * @param {string} platformServerId
 * @param {string} nitradoToken
 * @param {string} filePath - full path on server, e.g. /mpmissions/.../custom/shop.json
 * @param {Array}  newEntries
 */
async function appendCustomJsonEntries(platformServerId, nitradoToken, filePath, newEntries, fileService = missionFileService) {
  console.log('🛍️  Updating custom JSON file at', filePath);

  const raw = await fileService.downloadFileFromServer(platformServerId, filePath, nitradoToken);
  let content;
  try {
    content = JSON.stringify(appendSpawnDefinitions(raw, newEntries), null, 2);
  } catch (error) {
    throw new Error('Cannot update custom Object Spawner file: ' + error.message);
  }

  const lastSlash = filePath.lastIndexOf('/');
  const dir = filePath.slice(0, lastSlash);
  const fileName = filePath.slice(lastSlash + 1);
  await fileService.uploadFileToServer(platformServerId, dir, fileName, content, nitradoToken);
  console.log('   ✅ Custom JSON file updated (' + newEntries.length + ' new entries)');
}

function removeObjectSpawnerEntries(root, entryIds) {
  return removeManagedSpawnDefinitions(root, entryIds);
}

function removeEffectAreaEntries(root, entryIds) {
  const areas = Array.isArray(root) ? root : root?.Areas;
  if (!Array.isArray(areas)) {
    throw new Error('Unsupported cfgEffectArea.json structure during rental cleanup');
  }
  const matchCounts = new Map();
  const keep = entry => {
    const areaName = entry?.AreaName;
    const marker = entry?._shopEntryId;
    if (areaName != null && marker != null && areaName !== marker) {
      throw new Error('Provider shop entry identifiers disagree');
    }
    const matchedEntryIds = new Set([areaName, marker].filter(id => entryIds.has(id)));
    for (const entryId of matchedEntryIds) {
      const count = (matchCounts.get(entryId) || 0) + 1;
      if (count > 1) throw new Error('Duplicate provider shop entry during cfgEffectArea cleanup');
      matchCounts.set(entryId, count);
    }
    return matchedEntryIds.size === 0;
  };
  const remaining = areas.filter(keep);
  if (matchCounts.size !== entryIds.size) {
    throw new Error('cfgEffectArea cleanup did not match every tracked entry');
  }
  if (Array.isArray(root)) return remaining;
  return { ...root, Areas: remaining };
}

function normalizeMissionRelativeJsonPath(filePath) {
  return './' + normalizeObjectSpawnerPath(filePath);
}

function parseCustomJsonCleanupMetadata(fileEntryId, currentCatalogPath) {
  let metadata = null;
  try {
    metadata = JSON.parse(fileEntryId);
  } catch (_error) {
    // Legacy orders stored only the entry marker and must use the catalog path.
  }
  if (metadata !== null) {
    if (!metadata || metadata.method !== 'custom_json' ||
        !isOwnedShopEntryId(metadata.entryId) ||
        typeof metadata.file !== 'string') {
      throw new Error('Invalid custom JSON cleanup metadata');
    }
    return {
      entryId: metadata.entryId,
      relativePath: normalizeMissionRelativeJsonPath(metadata.file).slice(2),
    };
  }
  if (!isOwnedShopEntryId(fileEntryId)) {
    throw new Error('Invalid legacy custom JSON cleanup metadata');
  }
  return {
    entryId: fileEntryId,
    relativePath: normalizeMissionRelativeJsonPath(currentCatalogPath || 'custom/shop.json').slice(2),
  };
}

function validateProvisioningItem(item) {
  const supportedMethods = new Set(['cfgEffectArea', 'event', 'custom_json']);
  if (!supportedMethods.has(item?.spawn_method)) {
    throw new Error('Unsupported shop spawn method: ' + String(item?.spawn_method || 'missing'));
  }
  const identifierPattern = /^[A-Za-z0-9_]+$/;
  if (item.spawn_method === 'custom_json') {
    normalizeObjectName(item.item_class);
    const objectSpawnerConfig = normalizeObjectSpawnerConfig(item.object_spawner_config || {});
    normalizeObjectSpawnerConfig({
      ...objectSpawnerConfig,
      file: item.custom_json_file || objectSpawnerConfig.file || DEFAULT_OBJECT_SPAWNER_POLICY.defaultFile,
    });
  } else if (typeof item.item_class !== 'string' || !identifierPattern.test(item.item_class)) {
    throw new Error('Shop item class is required for provisioning');
  }
  if (item.spawn_method === 'event' &&
      (typeof item.event_name !== 'string' || !identifierPattern.test(item.event_name.trim()))) {
    throw new Error('Shop event name is required for event provisioning');
  }
  if (item.spawn_method === 'event') {
    if (!/^(?:Vehicle|Static|Loot|Infected|Ambient|Item|Trajectory)[A-Za-z0-9_]*$/.test(item.event_name || '')) {
      throw new Error('Event name must begin with a supported DayZ CE spawner type');
    }
    const cfg = resolveEventConfig(item.event_config);
    if (cfg.secondary && /^Animal/i.test(cfg.secondary)) {
      throw new Error('Animal secondary events require territory provisioning and are not supported yet');
    }
    const numericFields = [
      cfg.nominal, cfg.min, cfg.max, cfg.lifetime, cfg.restock,
      cfg.saferadius, cfg.distanceradius, cfg.cleanupradius, cfg.placement_clearance,
    ];
    const flags = [cfg.flags.deletable, cfg.flags.init_random, cfg.flags.remove_damaged];
    if (numericFields.some(value => !Number.isSafeInteger(Number(value)) || Number(value) < 0) ||
        flags.some(value => ![0, 1].includes(Number(value))) ||
        !SHOP_EVENT_POSITIONS.has(cfg.position) || !SHOP_EVENT_LIMITS.has(cfg.limit) ||
        ![0, 1].includes(Number(cfg.active)) ||
        (cfg.secondary && !identifierPattern.test(cfg.secondary))) {
      throw new Error('Invalid shop event configuration');
    }
    const children = cfg.children?.length ? cfg.children : [{ type: item.item_class, ...cfg.child }];
    if (children.some(child => /^Animal(?:_|$)/i.test(String(child?.type || '')))) {
      throw new Error('Animal shop events require territory provisioning and are not supported yet');
    }
    if (children.length > 100 || children.some(child =>
      !child || !identifierPattern.test(String(child.type || '')) ||
      ['min', 'max', 'lootmin', 'lootmax'].some(field =>
        !Number.isSafeInteger(Number(child[field] ?? (field.startsWith('loot') ? 0 : 1))) ||
        Number(child[field] ?? (field.startsWith('loot') ? 0 : 1)) < 0
      )
    )) {
      throw new Error('Invalid shop event children');
    }
    if (cfg.eventGroupChildren?.some(child =>
      /^(?:Animal(?:_|$)|Zmb|Infected|NPC)/i.test(String(child?.type || ''))
    )) {
      throw new Error('Event groups cannot directly contain AI, and animal secondary events are not supported yet');
    }
    if (cfg.eventGroupChildren?.some(child => child?.spawnsecondary === true) && !cfg.secondary) {
      throw new Error('Event-group spawnsecondary requires the parent event secondary reference');
    }
    if (cfg.eventGroupChildren && (cfg.eventGroupChildren.length < 1 || cfg.eventGroupChildren.length > 100 ||
        cfg.eventGroupChildren.some(child =>
          !child || !identifierPattern.test(String(child.type || '')) ||
          ['x', 'y', 'z', 'a'].some(field => !Number.isFinite(Number(child[field] ?? 0))) ||
          ['deloot', 'lootmin', 'lootmax'].some(field => child[field] !== undefined &&
            (!Number.isSafeInteger(Number(child[field])) || Number(child[field]) < 0)) ||
          (child.spawnsecondary !== undefined && typeof child.spawnsecondary !== 'boolean')
        ))) {
      throw new Error('Invalid shop event group children');
    }
    if (cfg.effectAreaComponents?.length) {
      throw new Error('Companion cfgEffectArea entries are disabled because their Type must inherit DayZ EffectArea');
    }
    if (cfg.objectSpawnerComponents?.length) {
      throw new Error('Object Spawner components are disabled until registration cleanup is reversible');
    }
    if (cfg.objectSpawnerComponents && (cfg.objectSpawnerComponents.length > 100 || cfg.objectSpawnerComponents.some(component => {
      try { normalizeMissionRelativeJsonPath(component?.file || 'custom/shop.json'); } catch (_error) { return true; }
      return !component || !identifierPattern.test(String(component.name || '')) ||
        !Array.isArray(component.offset) || component.offset.length !== 3 ||
        component.offset.some(value => !Number.isFinite(Number(value))) ||
        !Array.isArray(component.ypr || [0, 0, 0]) || (component.ypr || []).length !== 3 ||
        (component.ypr || [0, 0, 0]).some(value => !Number.isFinite(Number(value))) ||
        !Number.isFinite(Number(component.scale ?? 1)) || Number(component.scale ?? 1) <= 0 ||
        ![0, 1].includes(Number(component.enableCEPersistency ?? 0));
    }))) {
      throw new Error('Invalid companion Object Spawner entries');
    }
  }
}

async function ensureObjectSpawnerRegistered(platformServerId, nitradoToken, missionDir, objectFilePath, fileService = missionFileService) {
  const registeredPath = normalizeMissionRelativeJsonPath(objectFilePath);
  let filePath = missionDir + '/cfggameplay.json';
  let raw = await fileService.downloadFileFromServer(platformServerId, filePath, nitradoToken);
  if (raw === null || raw === undefined) {
    filePath = missionDir + '/cfgGameplay.json';
    raw = await fileService.downloadFileFromServer(platformServerId, filePath, nitradoToken);
  }
  if (raw === null || raw === undefined) throw new Error('cfggameplay.json not found');

  let root;
  try {
    root = JSON.parse(raw);
  } catch (error) {
    throw new Error('Cannot update malformed cfggameplay.json: ' + error.message);
  }
  if (!root || typeof root !== 'object' || Array.isArray(root) ||
      !root.WorldsData || typeof root.WorldsData !== 'object' || Array.isArray(root.WorldsData) ||
      !Array.isArray(root.WorldsData.objectSpawnersArr)) {
    throw new Error('Unsupported cfggameplay.json WorldsData.objectSpawnersArr structure');
  }
  const updatedRoot = registerObjectSpawnerFile(root, registeredPath);
  if (updatedRoot === root) return;
  root = updatedRoot;
  const lastSlash = filePath.lastIndexOf('/');
  await fileService.uploadFileToServer(
    platformServerId,
    filePath.slice(0, lastSlash),
    filePath.slice(lastSlash + 1),
    JSON.stringify(root, null, 2),
    nitradoToken
  );
}

// ---------------------------------------------------------------------------
// custom/shop_events.xml + cfgeventspawns.xml (XML, event-based spawns)
// ---------------------------------------------------------------------------

// XML parser used for structured cfgeconomycore registration inspection.
const rtParser  = new xml2js.Parser({ explicitArray: true, attrkey: '$' });
const orderedXmlOptions = {
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  commentPropName: '#comment',
  trimValues: false,
  suppressEmptyNode: true,
};
const orderedParser = new XMLParser(orderedXmlOptions);
const orderedBuilder = new XMLBuilder(orderedXmlOptions);

function orderedNodeName(node) {
  return Object.keys(node || {}).find(key => key !== ':@');
}

function orderedAttributes(node) {
  const attributes = {};
  for (const [key, value] of Object.entries(node?.[':@'] || {})) {
    attributes[key.replace(/^@_/, '')] = String(value);
  }
  return attributes;
}

function assertExactAttributes(node, required, optional, label) {
  const attributes = orderedAttributes(node);
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(attributes).some(name => !allowed.has(name)) || required.some(name => !Object.prototype.hasOwnProperty.call(attributes, name))) {
    throw new Error(`Unsupported ${label} attributes`);
  }
  return attributes;
}

function assertEmptyElement(node, elementName, label) {
  const children = node[elementName] || [];
  for (const child of children) {
    const name = orderedNodeName(child);
    if (name === '#text' && String(child['#text'] || '').trim() === '') continue;
    if (name === '#comment') continue;
    throw new Error(`Unsupported nested ${label} structure`);
  }
}

function isFiniteNumberText(value) {
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value));
}

function isNonNegativeIntegerText(value) {
  return typeof value === 'string' && /^\d+$/.test(value.trim()) &&
    Number.isSafeInteger(Number(value)) && Number(value) >= 0;
}

function parseOrderedXml(raw, rootName, label) {
  if (typeof raw !== 'string' || raw.trim() === '') throw new Error(`${label} is empty`);
  const validation = XMLValidator.validate(raw);
  if (validation !== true) throw new Error(`Cannot update malformed ${label}: ${validation.err.msg}`);
  const document = orderedParser.parse(raw);
  const roots = document.filter(node => orderedNodeName(node) === rootName);
  const unsupported = document.some(node => {
    const name = orderedNodeName(node);
    return name && !['?xml', '#text', '#comment', rootName].includes(name);
  });
  if (roots.length !== 1 || unsupported) throw new Error(`Unsupported ${label} root structure`);
  return { document, root: roots[0], children: roots[0][rootName] || [] };
}

function buildValidatedOrderedXml(document, rootName, label, validator) {
  const content = orderedBuilder.build(document);
  const validation = XMLValidator.validate(content);
  if (validation !== true) throw new Error(`Generated invalid ${label}: ${validation.err.msg}`);
  const verified = parseOrderedXml(content, rootName, label);
  validator(verified.children);
  return content;
}

function validateEventPositionChildren(children) {
  const names = new Set();
  for (const node of children) {
    const name = orderedNodeName(node);
    if (name === '#text') {
      if (String(node['#text'] || '').trim() !== '') throw new Error('Unsupported text in cfgeventspawns.xml');
      continue;
    }
    if (name === '#comment') continue;
    if (name !== 'event') throw new Error('Unsupported cfgeventspawns.xml child element');
    const eventAttributes = assertExactAttributes(node, ['name'], [], 'event');
    if (!eventAttributes.name.trim() || names.has(eventAttributes.name)) throw new Error('Invalid or duplicate event name');
    names.add(eventAttributes.name);
    for (const child of node.event || []) {
      const childName = orderedNodeName(child);
      if (childName === '#text') {
        if (String(child['#text'] || '').trim() !== '') throw new Error('Unsupported event text');
        continue;
      }
      if (childName === '#comment') continue;
      if (childName === 'zone') {
        const attrs = assertExactAttributes(child, ['smin', 'smax', 'dmin', 'dmax', 'r'], [], 'zone');
        if (Object.values(attrs).some(value => !isFiniteNumberText(value))) throw new Error('Invalid zone coordinate');
        assertEmptyElement(child, 'zone', 'zone');
      } else if (childName === 'pos') {
        const attrs = assertExactAttributes(child, ['x', 'z'], ['a', 'y', 'group'], 'position');
        for (const key of ['x', 'z', 'a', 'y']) {
          if (attrs[key] !== undefined && !isFiniteNumberText(attrs[key])) throw new Error('Invalid event position coordinate');
        }
        assertEmptyElement(child, 'pos', 'position');
      } else {
        throw new Error('Unsupported nested event position structure');
      }
    }
  }
}

const SHOP_EVENT_SCALARS = new Set([
  'nominal', 'min', 'max', 'lifetime', 'restock', 'saferadius', 'distanceradius',
  'cleanupradius', 'position', 'limit', 'active', 'secondary',
]);
const NUMERIC_SHOP_EVENT_SCALARS = new Set([
  'nominal', 'min', 'max', 'lifetime', 'restock', 'saferadius', 'distanceradius', 'cleanupradius',
]);
const SHOP_EVENT_POSITIONS = new Set(['fixed', 'player', 'uniform']);
const SHOP_EVENT_LIMITS = new Set(['child', 'custom', 'mixed', 'parent']);

function validateShopEventChildren(children) {
  const eventNames = new Set();
  for (const node of children) {
    const name = orderedNodeName(node);
    if (name === '#text') {
      if (String(node['#text'] || '').trim() !== '') throw new Error('Unsupported text in shop_events.xml');
      continue;
    }
    if (name === '#comment') continue;
    if (name !== 'event') throw new Error('Unsupported shop_events.xml child element');
    const eventAttributes = assertExactAttributes(node, ['name'], [], 'shop event');
    if (!eventAttributes.name.trim() || eventNames.has(eventAttributes.name)) throw new Error('Invalid or duplicate shop event name');
    eventNames.add(eventAttributes.name);
    const counts = new Map();
    for (const child of node.event || []) {
      const childName = orderedNodeName(child);
      if (childName === '#text') {
        if (String(child['#text'] || '').trim() !== '') throw new Error('Unsupported shop event text');
        continue;
      }
      if (childName === '#comment') continue;
      counts.set(childName, (counts.get(childName) || 0) + 1);
      if (SHOP_EVENT_SCALARS.has(childName)) {
        assertExactAttributes(child, [], [], childName);
        const nested = child[childName] || [];
        if (nested.some(item => orderedNodeName(item) !== '#text') || nested.length !== 1 || String(nested[0]['#text'] ?? '').trim() === '') {
          throw new Error(`Unsupported ${childName} structure`);
        }
        const value = String(nested[0]['#text']).trim();
        if (NUMERIC_SHOP_EVENT_SCALARS.has(childName) && !isNonNegativeIntegerText(value)) {
          throw new Error(`Invalid ${childName} value`);
        }
        if (childName === 'position' && !SHOP_EVENT_POSITIONS.has(value)) throw new Error('Invalid position value');
        if (childName === 'limit' && !SHOP_EVENT_LIMITS.has(value)) throw new Error('Invalid limit value');
        if (childName === 'active' && !['0', '1'].includes(value)) throw new Error('Invalid active value');
      } else if (childName === 'flags') {
        const attrs = assertExactAttributes(child, ['deletable', 'init_random', 'remove_damaged'], [], 'flags');
        if (Object.values(attrs).some(value => !['0', '1'].includes(value.trim()))) throw new Error('Invalid flags value');
        assertEmptyElement(child, 'flags', 'flags');
      } else if (childName === 'children') {
        assertExactAttributes(child, [], [], 'children');
        const childEntries = (child.children || []).filter(item => !['#text', '#comment'].includes(orderedNodeName(item)));
        if (childEntries.some(item => orderedNodeName(item) !== 'child')) throw new Error('Unsupported children structure');
        for (const childEntry of childEntries) {
          const attrs = assertExactAttributes(childEntry, ['lootmax', 'lootmin', 'max', 'min', 'type'], [], 'child');
          if (['lootmax', 'lootmin', 'max', 'min'].some(key => !isNonNegativeIntegerText(attrs[key])) || !attrs.type.trim()) {
            throw new Error('Invalid child value');
          }
          assertEmptyElement(childEntry, 'child', 'child');
        }
      } else {
        throw new Error('Unsupported nested shop event structure');
      }
    }
    const required = ['nominal', 'min', 'max', 'lifetime', 'restock', 'saferadius', 'distanceradius', 'cleanupradius', 'flags', 'position', 'limit', 'active', 'children'];
    if (required.some(field => counts.get(field) !== 1) || Array.from(counts.values()).some(count => count > 1)) {
      throw new Error('Missing or repeated shop event element');
    }
  }
}

function textElement(name, value) {
  return { [name]: [{ '#text': String(value) }] };
}

function canonicalOrderedNode(node) {
  const name = orderedNodeName(node);
  const attributes = Object.fromEntries(
    Object.entries(orderedAttributes(node))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, String(value)])
  );
  if (name === '#text') return { name, text: String(node['#text'] ?? '').trim() };
  return {
    name,
    attributes,
    children: (node[name] || [])
      .filter(child => orderedNodeName(child) !== '#comment')
      .map(canonicalOrderedNode)
      .filter(child => child.name !== '#text' || child.text !== ''),
  };
}

function findShopOwnershipCommentIndex(children, nodeIndex, expectedFragment) {
  for (let index = nodeIndex - 1; index >= 0; index -= 1) {
    const name = orderedNodeName(children[index]);
    if (name === '#text' && String(children[index]['#text'] || '').trim() === '') continue;
    if (name !== '#comment') return -1;
    const text = String(children[index]['#comment']?.[0]?.['#text'] || '');
    return text.includes(expectedFragment) ? index : -1;
  }
  return -1;
}

/** Merge owner-supplied event_config fields over sensible defaults. */
function resolveEventConfig(raw) {
  const cfg = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {});
  return {
    nominal:        cfg.nominal        ?? 99,
    min:            cfg.min            ?? 0,
    max:            cfg.max            ?? 0,
    lifetime:       cfg.lifetime       ?? 0,
    restock:        cfg.restock        ?? 0,
    saferadius:     cfg.saferadius     ?? 0,
    distanceradius: cfg.distanceradius ?? 0,
    cleanupradius:      cfg.cleanupradius      ?? 0,
    placement_clearance: cfg.placement_clearance ?? 0,
    secondary:      cfg.secondary      || null,
    position:       cfg.position       || 'fixed',
    limit:          cfg.limit          || 'child',
    active:         cfg.active         ?? 1,
    flags: {
      deletable:      (cfg.flags?.deletable      ?? 1),
      init_random:    (cfg.flags?.init_random    ?? 0),
      remove_damaged: (cfg.flags?.remove_damaged ?? 0),
    },
    // <child> element attributes — controls how many objects/loot spawn per position
    child: {
      max:     cfg.child?.max     ?? 1,
      min:     cfg.child?.min     ?? 1,
      lootmax: cfg.child?.lootmax ?? 0,
      lootmin: cfg.child?.lootmin ?? 0,
    },
    children: Array.isArray(cfg.children) ? cfg.children : null,
    eventGroupChildren: Array.isArray(cfg.eventGroupChildren) ? cfg.eventGroupChildren : null,
    effectAreaComponents: Array.isArray(cfg.effectAreaComponents) ? cfg.effectAreaComponents : null,
    objectSpawnerComponents: Array.isArray(cfg.objectSpawnerComponents) ? cfg.objectSpawnerComponents : null,
  };
}


/**
 * Ensure custom/shop_events.xml is registered as the LAST <ce> entry in
 * cfgeconomycore.xml.  Uses string insertion to preserve XML comments.
 *
 * Shop writes CE event definitions to custom/shop_events.xml and this helper
 * ensures CE actually loads that file.
 */
async function ensureCfgEconomyCoreShopEntry(platformServerId, nitradoToken, missionDir, fileService = missionFileService) {
  const filePath = missionDir + '/cfgeconomycore.xml';
  console.log('🛍️  Checking cfgeconomycore.xml for shop_events registration');

  const raw = await fileService.downloadFileFromServer(platformServerId, filePath, nitradoToken);
  if (raw === null || raw === undefined) throw new Error('cfgeconomycore.xml not found');
  let parsedCore;
  try {
    parsedCore = await rtParser.parseStringPromise(raw);
  } catch (e) {
    throw new Error('Cannot update malformed cfgeconomycore.xml: ' + e.message);
  }
  if (parsedCore.economycore === '') parsedCore.economycore = {};
  if (!parsedCore.economycore || typeof parsedCore.economycore !== 'object') {
    throw new Error('Unsupported cfgeconomycore.xml structure');
  }

  const ceEntries = Array.isArray(parsedCore.economycore.ce)
    ? parsedCore.economycore.ce
    : (parsedCore.economycore.ce ? [parsedCore.economycore.ce] : []);
  const registrations = ceEntries.flatMap(ce => {
    if (!ce || typeof ce !== 'object' || ce.$?.folder !== 'custom') return [];
    const files = Array.isArray(ce.file) ? ce.file : (ce.file ? [ce.file] : []);
    return files.filter(file =>
      file && typeof file === 'object' &&
      file.$?.name === 'shop_events.xml' && file.$?.type === 'events'
    );
  });
  if (registrations.length > 1) {
    throw new Error('Duplicate shop_events.xml registrations in cfgeconomycore.xml');
  }
  if (registrations.length === 1) {
    console.log('   ℹ️  shop_events.xml already registered');
    return;
  }

  const entry = '\n    <ce folder="custom"><file name="shop_events.xml" type="events"/></ce>';
  const updated = raw.replace(/<\/economycore\s*>/, entry + '\n</economycore>');
  if (updated === raw) throw new Error('Invalid cfgeconomycore.xml: </economycore> tag not found');
  try {
    const verified = await rtParser.parseStringPromise(updated);
    const verifiedEntries = Array.isArray(verified.economycore?.ce)
      ? verified.economycore.ce
      : (verified.economycore?.ce ? [verified.economycore.ce] : []);
    const verifiedCount = verifiedEntries.flatMap(ce => {
      if (ce?.$?.folder !== 'custom') return [];
      const files = Array.isArray(ce.file) ? ce.file : (ce.file ? [ce.file] : []);
      return files.filter(file => file?.$?.name === 'shop_events.xml' && file?.$?.type === 'events');
    }).length;
    if (verifiedCount !== 1) throw new Error('registration count is not one');
  } catch (e) {
    throw new Error('Generated invalid cfgeconomycore.xml: ' + e.message);
  }

  const lastSlash = filePath.lastIndexOf('/');
  await fileService.uploadFileToServer(
    platformServerId, filePath.slice(0, lastSlash), filePath.slice(lastSlash + 1),
    updated, nitradoToken
  );
  console.log('   ✅ Registered shop_events.xml in cfgeconomycore.xml');
}

/**
 * Ensure an event entry exists in custom/shop_events.xml, creating the file
 * from scratch if needed.  All CE parameters are taken from the item's
 * event_config so the owner controls every field from the dashboard.
 *
 * @param {object} meta - { itemName, itemClass, shopItemId } — written as an
 *                        XML comment above the <event> element for manual editors
 */
async function ensureShopEventDefinition(platformServerId, nitradoToken, missionDir, eventName, itemClass, rawConfig, meta = {}, fileService = missionFileService) {
  const cfg      = resolveEventConfig(rawConfig);
  const filePath = missionDir + '/custom/shop_events.xml';
  console.log('🛍️  Ensuring event definition for "' + eventName + '"');

  const raw = await fileService.downloadFileFromServer(platformServerId, filePath, nitradoToken);
  let parsed;
  if (raw !== null && raw !== undefined) {
    parsed = parseOrderedXml(raw, 'events', 'shop_events.xml');
    validateShopEventChildren(parsed.children);
  } else {
    const root = { events: [] };
    parsed = { document: [root], root, children: root.events };
  }

  const configuredChildren = cfg.children?.length
    ? cfg.children
    : (cfg.eventGroupChildren?.length ? [] : [{ type: itemClass, ...cfg.child }]);
  const childNodes = configuredChildren.map(child => ({ child: [], ':@': {
    '@_lootmax': String(child.lootmax ?? 0), '@_lootmin': String(child.lootmin ?? 0),
    '@_max': String(child.max ?? 1), '@_min': String(child.min ?? 1), '@_type': String(child.type || ''),
  } }));
  const eventChildren = [
    textElement('nominal', cfg.nominal), textElement('min', cfg.min), textElement('max', cfg.max),
    textElement('lifetime', cfg.lifetime), textElement('restock', cfg.restock),
    textElement('saferadius', cfg.saferadius), textElement('distanceradius', cfg.distanceradius),
    textElement('cleanupradius', cfg.cleanupradius),
    ...(cfg.secondary ? [textElement('secondary', cfg.secondary)] : []),
    { flags: [], ':@': {
      '@_deletable': String(cfg.flags.deletable),
      '@_init_random': String(cfg.flags.init_random),
      '@_remove_damaged': String(cfg.flags.remove_damaged),
    } },
    textElement('position', cfg.position), textElement('limit', cfg.limit), textElement('active', cfg.active),
    { children: childNodes },
  ];
  const eventNode = {
    event: eventChildren,
    ':@': { '@_name': eventName },
  };

  const existingEventIndex = parsed.children.findIndex(node =>
    orderedNodeName(node) === 'event' && orderedAttributes(node).name === eventName
  );
  if (existingEventIndex >= 0) {
    const existingEvent = parsed.children[existingEventIndex];
    if (JSON.stringify(canonicalOrderedNode(existingEvent)) !== JSON.stringify(canonicalOrderedNode(eventNode))) {
      throw new Error('Existing shop event definition conflicts with the current catalog configuration');
    }
    if (findShopOwnershipCommentIndex(parsed.children, existingEventIndex, 'DayZ Shop') < 0) {
      throw new Error('Existing event definition is not owned by the shop');
    }
    console.log('   ℹ️  Event "' + eventName + '" already in shop_events.xml');
    return;
  }

  const commentParts = ['DayZ Shop'];
  if (meta.itemName)  commentParts.push(`"${meta.itemName}"`);
  if (meta.itemClass) commentParts.push(`class: ${meta.itemClass}`);
  if (meta.shopItemId) commentParts.push(`shop item #${meta.shopItemId}`);
  const comment = commentParts.join(' | ').replace(/--/g, '—');
  parsed.children.push({ '#comment': [{ '#text': ` ${comment} ` }] }, eventNode);
  const content = buildValidatedOrderedXml(parsed.document, 'events', 'shop_events.xml', validateShopEventChildren);

  const lastSlash = filePath.lastIndexOf('/');
  await fileService.uploadFileToServer(
    platformServerId, filePath.slice(0, lastSlash), filePath.slice(lastSlash + 1),
    content, nitradoToken
  );
  console.log('   ✅ Added event "' + eventName + '" to shop_events.xml');
}

/**
 * Remove a named event from custom/shop_events.xml once no active rentals
 * reference it on this server.
 */
async function removeShopEventDefinition(platformServerId, nitradoToken, missionDir, eventName, fileService = missionFileService) {
  const filePath = missionDir + '/custom/shop_events.xml';
  console.log('🛍️  Removing event "' + eventName + '" from shop_events.xml');

  const raw = await fileService.downloadFileFromServer(platformServerId, filePath, nitradoToken);
  if (raw === null || raw === undefined) throw new Error('shop_events.xml not found during cleanup');

  const parsed = parseOrderedXml(raw, 'events', 'shop_events.xml');
  validateShopEventChildren(parsed.children);
  const eventIndex = parsed.children.findIndex(node =>
    orderedNodeName(node) === 'event' && orderedAttributes(node).name === eventName
  );
  if (eventIndex < 0) throw new Error('Shop event definition not found during cleanup');
  const commentIndex = findShopOwnershipCommentIndex(parsed.children, eventIndex, 'DayZ Shop');
  if (commentIndex < 0) throw new Error('Existing event definition is not owned by the shop');
  parsed.children.splice(eventIndex, 1);
  parsed.children.splice(commentIndex, 1);

  const content = buildValidatedOrderedXml(parsed.document, 'events', 'shop_events.xml', validateShopEventChildren);
  const lastSlash = filePath.lastIndexOf('/');
  await fileService.uploadFileToServer(
    platformServerId, filePath.slice(0, lastSlash), filePath.slice(lastSlash + 1),
    content, nitradoToken
  );
  console.log('   ✅ Removed event "' + eventName + '" from shop_events.xml');
}

/**
 * Add a spawn position to cfgeventspawns.xml and return a JSON file_entry_id
 * used to locate and remove it later.
 *
 * Coordinate mapping (DB column → cfgeventspawns attribute):
 *   pos_x → x  (east)
 *   pos_y → y  (elevation)
 *   pos_z → z  (north)
 *   ypr_x → a  (heading)
 */
async function addEventSpawnPosition(platformServerId, nitradoToken, missionDir, eventName, x, z, a, y, fileService = missionFileService, options = {}) {
  const filePath = missionDir + '/cfgeventspawns.xml';
  console.log('🛍️  Adding spawn position for "' + eventName + '" at x=' + x + ' z=' + z);

  const raw = await fileService.downloadFileFromServer(platformServerId, filePath, nitradoToken);
  let parsed;
  if (raw !== null && raw !== undefined) {
    parsed = parseOrderedXml(raw, 'eventposdef', 'cfgeventspawns.xml');
    validateEventPositionChildren(parsed.children);
  } else {
    const root = { eventposdef: [] };
    parsed = { document: [root], root, children: root.eventposdef };
  }
  if (![x, z, a].every(value => Number.isFinite(Number(value))) ||
      (y !== undefined && y !== null && y !== '' && !Number.isFinite(Number(y)))) {
    throw new Error('Invalid event spawn coordinates');
  }

  let target = parsed.children.find(node =>
    orderedNodeName(node) === 'event' && orderedAttributes(node).name === eventName
  );
  if (!target) {
    target = {
      event: [{ zone: [], ':@': { '@_smin': '0', '@_smax': '0', '@_dmin': '0', '@_dmax': '0', '@_r': '0' } }],
      ':@': { '@_name': eventName },
    };
    parsed.children.push(target);
  }
  const positionAttributes = {
    '@_x': String(x), '@_z': String(z), '@_a': String(a),
  };
  const elevation = Number(y);
  if (y !== undefined && y !== null && y !== '' && elevation !== 0) {
    positionAttributes['@_y'] = String(elevation);
  }
  if (options.group) {
    if (!/^[A-Za-z0-9_]+$/.test(options.group)) throw new Error('Invalid event group name');
    positionAttributes['@_group'] = options.group;
  }
  target.event.push({ pos: [], ':@': positionAttributes });

  const content = buildValidatedOrderedXml(
    parsed.document, 'eventposdef', 'cfgeventspawns.xml', validateEventPositionChildren
  );

  const lastSlash = filePath.lastIndexOf('/');
  await fileService.uploadFileToServer(
    platformServerId, filePath.slice(0, lastSlash), filePath.slice(lastSlash + 1),
    content, nitradoToken
  );

  const entryId = JSON.stringify({
    event: eventName, x, z, a,
    ...(positionAttributes['@_y'] !== undefined ? { y: elevation } : {}),
    ...(options.group ? { group: options.group } : {}),
  });
  console.log('   ✅ Spawn position added:', entryId);
  return entryId;
}

function validateEventGroupChildren(children) {
  for (const node of children) {
    const name = orderedNodeName(node);
    if (name === '#text') {
      if (String(node['#text'] || '').trim() !== '') throw new Error('Unsupported text in cfgeventgroups.xml');
      continue;
    }
    if (name === '#comment') continue;
    if (name === 'event') {
      validateEventPositionChildren([node]);
      continue;
    }
    if (name !== 'group') throw new Error('Unsupported cfgeventgroups.xml child element');
    const groupAttrs = assertExactAttributes(node, ['name'], [], 'event group');
    if (!/^[A-Za-z0-9_]+$/.test(groupAttrs.name)) throw new Error('Invalid event group name');
    const groupChildren = (node.group || []).filter(child => !['#text', '#comment'].includes(orderedNodeName(child)));
    if (!groupChildren.length || groupChildren.some(child => orderedNodeName(child) !== 'child')) throw new Error('Invalid event group children');
    for (const child of groupChildren) {
      const attrs = assertExactAttributes(
        child, ['type', 'x', 'z', 'a'], ['y', 'deloot', 'lootmax', 'lootmin', 'spawnsecondary'], 'event group child'
      );
      if (!/^[A-Za-z0-9_]+$/.test(attrs.type) ||
          ['x', 'z', 'a'].some(field => !isFiniteNumberText(attrs[field])) ||
          (attrs.y !== undefined && !isFiniteNumberText(attrs.y)) ||
          ['deloot', 'lootmax', 'lootmin'].some(field => attrs[field] !== undefined && !isNonNegativeIntegerText(attrs[field])) ||
          (attrs.spawnsecondary !== undefined && !['true', 'false'].includes(attrs.spawnsecondary))) {
        throw new Error('Invalid event group child value');
      }
      assertEmptyElement(child, 'child', 'event group child');
    }
  }
}

function collectEventNames(raw, label) {
  const parsed = parseOrderedXml(raw, 'events', label);
  const names = new Set();
  for (const node of parsed.children) {
    if (orderedNodeName(node) !== 'event') continue;
    const name = orderedAttributes(node).name;
    if (name) names.add(name);
  }
  return names;
}

function collectSecondaryEventNames(raw, label) {
  const parsed = parseOrderedXml(raw, 'events', label);
  const names = new Set();
  for (const node of parsed.children) {
    if (orderedNodeName(node) !== 'event') continue;
    for (const child of node.event || []) {
      if (orderedNodeName(child) !== 'secondary') continue;
      const textNode = (child.secondary || []).find(entry => orderedNodeName(entry) === '#text');
      const name = String(textNode?.['#text'] || '').trim();
      if (name) names.add(name);
    }
  }
  return names;
}

async function assertPurchaseEventNamesAvailable(
  platformServerId,
  nitradoToken,
  missionDir,
  items,
  fileService = missionFileService,
  options = {}
) {
  const purchaseNames = new Set(
    (items || [])
      .filter(item => item.spawn_method === 'event' && item.item_type === 'event_rental')
      .map(item => String(item.event_name || ''))
  );
  if (purchaseNames.size === 0) return;

  const eventFiles = new Set(['db/events.xml', 'custom/shop_events.xml']);
  const coreRaw = await fileService.downloadFileFromServer(
    platformServerId, missionDir + '/cfgeconomycore.xml', nitradoToken
  );
  if (coreRaw === null || coreRaw === undefined) throw new Error('cfgeconomycore.xml not found');
  let parsedCore;
  try {
    parsedCore = await rtParser.parseStringPromise(coreRaw);
  } catch (error) {
    throw new Error('Cannot inspect malformed cfgeconomycore.xml: ' + error.message);
  }
  const ceEntries = Array.isArray(parsedCore.economycore?.ce)
    ? parsedCore.economycore.ce
    : (parsedCore.economycore?.ce ? [parsedCore.economycore.ce] : []);
  for (const ce of ceEntries) {
    const folder = String(ce?.$?.folder || '');
    const files = Array.isArray(ce?.file) ? ce.file : (ce?.file ? [ce.file] : []);
    for (const file of files) {
      if (file?.$?.type !== 'events') continue;
      const name = String(file?.$?.name || '');
      if (!/^[A-Za-z0-9_.-]+$/.test(folder) || folder === '.' || folder === '..' ||
          !/^[A-Za-z0-9_.-]+\.xml$/.test(name) || name.startsWith('.')) {
        throw new Error('Invalid registered event file path in cfgeconomycore.xml');
      }
      eventFiles.add(folder + '/' + name);
    }
  }

  const eventPaths = [...eventFiles].map(relativePath => missionDir + '/' + relativePath);
  const eventContents = new Map();
  for (let start = 0; start < eventPaths.length; start += MAX_SNAPSHOT_FILES) {
    const batch = await captureProviderSnapshots({
      platformServerId,
      token: nitradoToken,
      filePaths: eventPaths.slice(start, start + MAX_SNAPSHOT_FILES),
      fileService,
    });
    for (const entry of batch) eventContents.set(...entry);
  }

  for (const relativePath of eventFiles) {
    const raw = eventContents.get(missionDir + '/' + relativePath);
    if (raw === null || raw === undefined) {
      // A missing registered file contains no event names to collide with this
      // purchase. Keep inspecting every file that does exist; transport and
      // provider failures still throw from downloadFileFromServer.
      continue;
    }
    const existingNames = collectEventNames(raw, relativePath);
    const collision = [...purchaseNames].find(name => existingNames.has(name));
    if (collision) {
      if (relativePath === 'custom/shop_events.xml' && options.allowShopPurchaseNames === true) {
        continue;
      }
      throw new Error('Purchase event name conflicts with an existing mission event: ' + collision);
    }
  }
}

async function assertSpawnsecondaryReferencesExist(
  platformServerId,
  nitradoToken,
  missionDir,
  children,
  fileService = missionFileService,
  additionalEventNames = []
) {
  const references = new Set(
    (children || []).filter(child => child?.spawnsecondary === true).map(child => String(child.type || ''))
  );
  if (references.size === 0) return;

  const standardRaw = await fileService.downloadFileFromServer(
    platformServerId, missionDir + '/db/events.xml', nitradoToken
  );
  if (standardRaw === null || standardRaw === undefined) throw new Error('db/events.xml not found');
  const known = collectEventNames(standardRaw, 'db/events.xml');
  const compatible = collectSecondaryEventNames(standardRaw, 'db/events.xml');
  const customRaw = await fileService.downloadFileFromServer(
    platformServerId, missionDir + '/custom/shop_events.xml', nitradoToken
  );
  if (customRaw !== null && customRaw !== undefined) {
    for (const name of collectEventNames(customRaw, 'shop_events.xml')) known.add(name);
    for (const name of collectSecondaryEventNames(customRaw, 'shop_events.xml')) compatible.add(name);
  }
  for (const name of additionalEventNames) known.add(String(name));

  const missing = [...references].filter(name => !known.has(name));
  if (missing.length) {
    throw new Error('spawnsecondary event reference(s) missing from events.xml: ' + missing.join(', '));
  }
  const incompatible = [...references].filter(name => !compatible.has(name));
  if (incompatible.length) {
    throw new Error('spawnsecondary event reference(s) are not secondary-compatible: ' + incompatible.join(', '));
  }
}

async function ensureShopEventGroupDefinition(platformServerId, nitradoToken, missionDir, groupName, children, fileService = missionFileService) {
  if (!/^[A-Za-z0-9_]+$/.test(groupName) || !Array.isArray(children) || !children.length || children.length > 100) {
    throw new Error('Invalid shop event group configuration');
  }
  const filePath = missionDir + '/cfgeventgroups.xml';
  const raw = await fileService.downloadFileFromServer(platformServerId, filePath, nitradoToken);
  if (raw === null || raw === undefined) throw new Error('cfgeventgroups.xml not found');
  const parsed = parseOrderedXml(raw, 'eventgroupdef', 'cfgeventgroups.xml');
  validateEventGroupChildren(parsed.children);
  const matches = parsed.children.filter(node =>
    orderedNodeName(node) === 'group' && orderedAttributes(node).name === groupName
  );
  if (matches.length > 1) throw new Error('Duplicate shop event group definition');

  const groupChildren = children.map(child => {
    const attrs = {
      '@_type': String(child.type || ''), '@_x': String(child.x ?? 0), '@_y': String(child.y ?? 0),
      '@_z': String(child.z ?? 0), '@_a': String(child.a ?? 0),
    };
    for (const field of ['deloot', 'lootmax', 'lootmin']) {
      if (child[field] !== undefined) attrs['@_' + field] = String(child[field]);
    }
    if (child.spawnsecondary !== undefined) attrs['@_spawnsecondary'] = String(child.spawnsecondary);
    return { child: [], ':@': attrs };
  });
  const groupNode = { group: groupChildren, ':@': { '@_name': groupName } };
  if (matches.length === 1) {
    if (JSON.stringify(canonicalOrderedNode(matches[0])) !== JSON.stringify(canonicalOrderedNode(groupNode))) {
      throw new Error('Existing shop event group conflicts with the current catalog configuration');
    }
    const matchIndex = parsed.children.indexOf(matches[0]);
    if (findShopOwnershipCommentIndex(parsed.children, matchIndex, 'DayZ Shop event group ' + groupName) < 0) {
      throw new Error('Existing event group is not owned by the shop');
    }
    return;
  }
  parsed.children.push(
    { '#comment': [{ '#text': ' DayZ Shop event group ' + groupName + ' ' }] },
    groupNode
  );
  const content = buildValidatedOrderedXml(parsed.document, 'eventgroupdef', 'cfgeventgroups.xml', validateEventGroupChildren);
  const lastSlash = filePath.lastIndexOf('/');
  await fileService.uploadFileToServer(
    platformServerId, filePath.slice(0, lastSlash), filePath.slice(lastSlash + 1), content, nitradoToken
  );
}

async function removeShopEventGroupDefinition(platformServerId, nitradoToken, missionDir, groupName, fileService = missionFileService) {
  const filePath = missionDir + '/cfgeventgroups.xml';
  const raw = await fileService.downloadFileFromServer(platformServerId, filePath, nitradoToken);
  if (raw === null || raw === undefined) throw new Error('cfgeventgroups.xml not found during cleanup');
  const parsed = parseOrderedXml(raw, 'eventgroupdef', 'cfgeventgroups.xml');
  validateEventGroupChildren(parsed.children);
  const index = parsed.children.findIndex(node =>
    orderedNodeName(node) === 'group' && orderedAttributes(node).name === groupName
  );
  if (index < 0) throw new Error('Shop event group not found during cleanup');
  const commentIndex = findShopOwnershipCommentIndex(parsed.children, index, 'DayZ Shop event group ' + groupName);
  if (commentIndex < 0) throw new Error('Existing event group is not owned by the shop');
  parsed.children.splice(index, 1);
  parsed.children.splice(commentIndex, 1);
  const content = buildValidatedOrderedXml(parsed.document, 'eventgroupdef', 'cfgeventgroups.xml', validateEventGroupChildren);
  const lastSlash = filePath.lastIndexOf('/');
  await fileService.uploadFileToServer(
    platformServerId, filePath.slice(0, lastSlash), filePath.slice(lastSlash + 1), content, nitradoToken
  );
}

/**
 * Remove spawn positions from cfgeventspawns.xml by matching the JSON
 * file_entry_id values written at checkout.  Event blocks left empty are
 * also removed.
 */
function parseEventRentalEntryIds(fileEntryIds) {
  const entries = fileEntryIds.map(id => {
    try {
      return JSON.parse(id);
    } catch (e) {
      throw new Error('Invalid event rental file entry ID: ' + e.message);
    }
  });
  if (entries.some(entry =>
    !entry || typeof entry.event !== 'string' || !entry.event.trim() ||
    ![entry.x, entry.z, entry.a].every(value =>
      value !== null && value !== undefined && String(value).trim() !== '' && Number.isFinite(Number(value))
    ) || (entry.y !== undefined && !Number.isFinite(Number(entry.y)))
  )) {
    throw new Error('Invalid event rental file entry metadata');
  }
  return entries;
}

async function removeEventSpawnPositions(platformServerId, nitradoToken, missionDir, fileEntryIds, fileService = missionFileService) {
  if (!fileEntryIds || fileEntryIds.length === 0) return;

  const toRemove = parseEventRentalEntryIds(fileEntryIds);

  const filePath = missionDir + '/cfgeventspawns.xml';
  console.log('🛍️  Removing ' + fileEntryIds.length + ' event spawn position(s)');

  const raw = await fileService.downloadFileFromServer(platformServerId, filePath, nitradoToken);
  if (raw === null || raw === undefined) throw new Error('cfgeventspawns.xml not found during cleanup');

  const parsed = parseOrderedXml(raw, 'eventposdef', 'cfgeventspawns.xml');
  validateEventPositionChildren(parsed.children);
  const emptiedTargetEvents = new Set();
  let removedPositions = 0;
  for (const block of parsed.children.filter(node => orderedNodeName(node) === 'event')) {
    const blockName = orderedAttributes(block).name;
    const relevant  = toRemove.filter(r => r.event === blockName);
    if (!relevant.length) continue;
    const originalChildren = block.event || [];
    block.event = originalChildren.filter(node => {
      if (orderedNodeName(node) !== 'pos') return true;
      const attrs = orderedAttributes(node);
      const px = Number(attrs.x), pz = Number(attrs.z);
      const pa = Number(attrs.a || 0), py = Number(attrs.y || 0);
      const remove = relevant.some(r =>
        Math.abs(Number(r.x) - px) < 0.01 && Math.abs(Number(r.z) - pz) < 0.01 &&
        Math.abs(Number(r.a) - pa) < 0.01 && Math.abs(Number(r.y || 0) - py) < 0.01
      );
      if (remove) removedPositions += 1;
      return !remove;
    });
    if (block.event.length < originalChildren.length &&
        !block.event.some(child => orderedNodeName(child) === 'pos')) {
      emptiedTargetEvents.add(blockName);
    }
  }

  if (removedPositions !== toRemove.length) {
    throw new Error('Event spawn cleanup did not match every tracked position');
  }

  // Drop only targeted event blocks whose final position was actually removed.
  // Pre-existing zone-only blocks are unrelated configuration and must survive.
  parsed.root.eventposdef = parsed.children.filter(node => {
    if (orderedNodeName(node) !== 'event') return true;
    return !emptiedTargetEvents.has(orderedAttributes(node).name);
  });
  const content = buildValidatedOrderedXml(
    parsed.document, 'eventposdef', 'cfgeventspawns.xml', validateEventPositionChildren
  );

  const lastSlash = filePath.lastIndexOf('/');
  await fileService.uploadFileToServer(
    platformServerId, filePath.slice(0, lastSlash), filePath.slice(lastSlash + 1),
    content, nitradoToken
  );
  console.log('   ✅ Event spawn positions removed from cfgeventspawns.xml');
}

// ---------------------------------------------------------------------------
// Checkout orchestration
// ---------------------------------------------------------------------------

function normalizeEventObjectSpawnerComponent(component) {
  return normalizeObjectSpawnerConfig({
    file: component?.file || LEGACY_OBJECT_SPAWNER_FILE,
    scale: component?.scale,
    enableCEPersistency: component?.enableCEPersistency,
    customString: component?.customString,
  });
}

function assertObjectSpawnerCheckoutLimit(items) {
  let definitions = 0;
  for (const item of items || []) {
    if (item.spawn_method === 'custom_json') {
      definitions += item.item_type === 'event_rental' ? 1 : Number(item.quantity || 1);
    } else if (item.spawn_method === 'event') {
      definitions += (resolveEventConfig(item.event_config).objectSpawnerComponents || []).length;
    }
    if (definitions > DEFAULT_OBJECT_SPAWNER_POLICY.maxDefinitionsPerCheckout) {
      throw new RangeError(
        `Object Spawner checkout limit is ${DEFAULT_OBJECT_SPAWNER_POLICY.maxDefinitionsPerCheckout} definitions`
      );
    }
  }
  return definitions;
}

function collectShopCheckoutFilePaths(missionDir, items) {
  const paths = new Set();
  let needsGameplayRegistration = false;
  let needsEffectAreas = false;
  let needsEvents = false;
  let needsEventGroups = false;

  for (const item of items || []) {
    if (item.spawn_method === 'cfgEffectArea') needsEffectAreas = true;
    if (item.spawn_method === 'custom_json') {
      const config = normalizeObjectSpawnerConfig(item.object_spawner_config || {
        file: item.custom_json_file || LEGACY_OBJECT_SPAWNER_FILE,
      });
      const relativePath = normalizeMissionRelativeJsonPath(
        item.custom_json_file || config.file
      ).slice(2);
      paths.add(`${missionDir}/${relativePath}`);
      needsGameplayRegistration = true;
    }
    if (item.spawn_method !== 'event') continue;
    needsEvents = true;
    const config = resolveEventConfig(item.event_config);
    if (config.effectAreaComponents?.length) needsEffectAreas = true;
    if (config.eventGroupChildren?.length) needsEventGroups = true;
    for (const component of config.objectSpawnerComponents || []) {
      const relativePath = normalizeMissionRelativeJsonPath(
        normalizeEventObjectSpawnerComponent(component).file
      ).slice(2);
      paths.add(`${missionDir}/${relativePath}`);
      needsGameplayRegistration = true;
    }
  }

  if (needsEffectAreas) paths.add(`${missionDir}/cfgEffectArea.json`);
  if (needsGameplayRegistration) {
    paths.add(`${missionDir}/cfggameplay.json`);
    paths.add(`${missionDir}/cfgGameplay.json`);
  }
  if (needsEvents) {
    paths.add(`${missionDir}/cfgeconomycore.xml`);
    paths.add(`${missionDir}/custom/shop_events.xml`);
    paths.add(`${missionDir}/cfgeventspawns.xml`);
  }
  if (needsEventGroups) paths.add(`${missionDir}/cfgeventgroups.xml`);
  return [...paths];
}

function collectShopCleanupFilePaths(missionDir, {
  effectAreaIds,
  customJsonFiles,
  eventEntryIds,
  eventsToCheck,
  eventGroupsByEvent,
}) {
  const paths = new Set(Object.keys(customJsonFiles || {}));
  if (effectAreaIds?.size) paths.add(`${missionDir}/cfgEffectArea.json`);
  if (eventEntryIds?.length) paths.add(`${missionDir}/cfgeventspawns.xml`);
  if (eventsToCheck?.size) paths.add(`${missionDir}/custom/shop_events.xml`);
  if (eventGroupsByEvent?.size) paths.add(`${missionDir}/cfgeventgroups.xml`);
  return [...paths];
}

async function prepareShopProviderMutation(db, {
  serverId,
  action,
  contextType,
  contextId,
  triggeredBy,
  missionDir,
  platformServerId,
  token,
  filePaths,
  plan,
}) {
  const snapshots = await captureProviderSnapshots({
    platformServerId,
    token,
    filePaths,
    fileService: missionFileService,
  });
  const operationId = await prepareProviderMutation(db, {
    serverId,
    providerServiceId: platformServerId,
    workflow: 'shop',
    action,
    contextType,
    contextId,
    plan: { ...plan, missionDir, filePaths },
    snapshots,
    triggeredBy,
  });
  return { operationId, snapshots };
}

function checkoutAuthorizationError() {
  const error = new Error('Checkout requires an active linked player identity');
  error.code = 'SHOP_AUTHORIZATION_REVOKED';
  return error;
}

async function assertCheckoutAuthority(db, order, actorUserId) {
  if (actorUserId === null || actorUserId === undefined || actorUserId === '') {
    throw checkoutAuthorizationError();
  }
  const authority = await lockTrustedFinancialIdentity(db, {
    userId: actorUserId,
    identityId: order.identity_id,
    serverId: order.server_id,
  });
  if (!authority) throw checkoutAuthorizationError();
}

/**
 * Give every CE rental order line its own deterministic event identity.
 * Catalogue event names describe a product, while a nominal-one rental event
 * must describe exactly one purchased placement.
 *
 * @param {object} db
 * @param {object[]} items
 */
async function assignPurchaseEventNames(db, items) {
  for (const item of items) {
    if (item.spawn_method !== 'event' || item.item_type !== 'event_rental') continue;
    const match = /^(Vehicle|Static|Loot|Infected|Ambient|Item|Trajectory)/.exec(item.event_name || '');
    if (!match) {
      throw new Error('Event name must begin with a supported DayZ CE spawner type');
    }
    const orderItemId = Number(item.id);
    if (!Number.isSafeInteger(orderItemId) || orderItemId < 1) {
      throw new Error('Invalid shop order item ID');
    }
    const purchaseEventName = match[1] + 'Rental' + orderItemId;
    await db.query(
      'UPDATE shop_order_items SET event_name_snapshot = $1 WHERE id = $2',
      [purchaseEventName, orderItemId]
    );
    item.event_name = purchaseEventName;
  }
}

/**
 * Process a player's cart checkout:
 *   1. Load cart items with shop_item details
 *   2. Verify player can afford total (wallet first, then bank)
 *   3. Deduct currency from wallet, then bank for remainder
 *   4. Update server files for each spawn method
 *   5. Mark order as completed
 *
 * @param {object} db         - DB abstraction
 * @param {number} orderId    - shop_orders.id with status='cart'
 * @returns {Promise<{success: boolean, error?: string, totalCharged?: number}>}
 */
function sumLineItemCents(items) {
  return items.reduce((sum, item) => {
    const quantity = Number(item.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      throw new Error('Shop quantity must be a positive integer');
    }
    return sum + parseCents(item.unit_price, 'Shop unit price') * quantity;
  }, 0);
}

function exactShopRefundAmount(value) {
  return centsToAmount(parseCents(value, 'Shop refund'));
}

async function assertEventRentalPlacementsAvailable(db, serverId, items) {
  const candidates = (items || []).filter(item =>
    item.spawn_method === 'event' && item.item_type === 'event_rental'
  );
  if (candidates.length === 0) return;

  const installed = await db.query(
    `SELECT soi.id, soi.pos_x, soi.pos_z,
            CASE WHEN soi.snapshot_schema_version = 1
              THEN soi.event_config_snapshot ELSE si.event_config END AS event_config
     FROM shop_order_items soi
     JOIN shop_orders so ON so.id = soi.order_id
     JOIN shop_items si ON si.id = soi.shop_item_id
     WHERE so.server_id = $1
       AND so.status = 'completed'
       AND soi.is_active = TRUE
       AND soi.spawn_method = 'event'
       AND CASE WHEN soi.snapshot_schema_version = 1
         THEN soi.item_type_snapshot ELSE si.item_type END = 'event_rental'`,
    [serverId]
  );

  const placement = item => {
    const config = resolveEventConfig(item.event_config);
    const x = Number(item.pos_x);
    const z = Number(item.pos_z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      throw new Error('Invalid event rental placement coordinates');
    }
    return {
      id: Number(item.id),
      x,
      z,
      clearance: Number(config.placement_clearance),
    };
  };
  const candidatePlacements = candidates.map(placement);
  const occupiedPlacements = installed.map(placement);
  const accepted = [];

  for (const candidate of candidatePlacements) {
    const conflict = [...occupiedPlacements, ...accepted].find(existing => {
      const distance = Math.hypot(candidate.x - existing.x, candidate.z - existing.z);
      const requiredDistance = candidate.clearance + existing.clearance;
      return distance < requiredDistance || (requiredDistance === 0 && distance === 0);
    });
    if (conflict) {
      const error = new Error('Event rental placement is too close to another active rental');
      error.code = 'SHOP_PLACEMENT_CONFLICT';
      error.status = 409;
      throw error;
    }
    accepted.push(candidate);
  }
}

async function processCheckout(db, orderId, actorUserId, options = {}) {
  const timer = options.timer;
  // Resolve the server first, then take the shared server lock before any row
  // locks so checkout/refund/restart operations use one consistent lock order.
  let order = await db.get(
    'SELECT * FROM shop_orders WHERE id = $1 AND status = $2',
    [orderId, 'cart']
  );
  if (!order) return { success: false, error: 'Cart not found' };

  await acquireShopServerLock(db, order.server_id);
  await assertCheckoutAuthority(db, order, actorUserId);
  order = await db.get(
    'SELECT * FROM shop_orders WHERE id = $1 AND server_id = $2 AND status = $3 FOR UPDATE',
    [orderId, order.server_id, 'cart']
  );
  if (!order) return { success: false, error: 'Cart is no longer available' };

  const cartLineCount = await db.get(
    'SELECT COUNT(*)::int AS cart_line_count FROM shop_order_items WHERE order_id = $1',
    [orderId]
  );

  const items = await db.query(`
    SELECT soi.*,
           CASE WHEN soi.snapshot_schema_version = 1 THEN soi.item_class_snapshot ELSE si.item_class END AS item_class,
           CASE WHEN soi.snapshot_schema_version = 1 THEN soi.item_type_snapshot ELSE si.item_type END AS item_type,
           CASE WHEN soi.snapshot_schema_version = 1 THEN soi.rental_restarts_snapshot ELSE si.rental_restarts END AS rental_restarts,
           CASE WHEN soi.snapshot_schema_version = 1 THEN soi.custom_json_file_snapshot ELSE si.custom_json_file END AS custom_json_file,
           CASE WHEN soi.snapshot_schema_version = 1 THEN soi.object_spawner_config_snapshot ELSE si.object_spawner_config END AS object_spawner_config,
           CASE WHEN soi.snapshot_schema_version = 1 THEN soi.event_name_snapshot ELSE si.event_name END AS event_name,
           CASE WHEN soi.snapshot_schema_version = 1 THEN soi.event_config_snapshot ELSE si.event_config END AS event_config,
           CASE WHEN soi.snapshot_schema_version = 1 THEN soi.capability_config_snapshot ELSE si.capability_config END AS capability_config,
           CASE WHEN soi.snapshot_schema_version = 1 THEN soi.item_name_snapshot ELSE si.name END AS item_name,
           si.server_id AS catalog_server_id, si.is_active AS catalog_is_active
    FROM shop_order_items soi
    JOIN shop_items si ON soi.shop_item_id = si.id
    WHERE soi.order_id = $1
    ORDER BY si.id, soi.id
    FOR UPDATE OF si
  `, [orderId]);

  if (!items.length) return { success: false, error: 'Cart is empty' };
  if (items.length !== cartLineCount.cart_line_count) {
    return { success: false, error: 'Cart contains an unavailable catalog item' };
  }

  for (const item of items) {
    if (item.spawn_method === 'capability') {
      item.capability_config = normalizeShopCapabilityConfig(item.capability_config);
    } else {
      if (item.capability_config != null) {
        return { success: false, error: 'Cart capability configuration does not match its spawn method' };
      }
      validateProvisioningItem(item);
    }
    if (Number(item.catalog_server_id) !== Number(order.server_id)) {
      return { success: false, error: 'Cart contains items from another server' };
    }
    if (!item.catalog_is_active) {
      return { success: false, error: 'Cart contains an inactive catalog item' };
    }
    const quantity = Number(item.quantity);
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      return { success: false, error: 'Quantity must be a positive integer' };
    }
    if (item.item_type === 'event_rental') {
      const maximum = Number(item.rental_restarts);
      if (!Number.isSafeInteger(maximum) || maximum < 1 || quantity > maximum) {
        return { success: false, error: "Rental duration exceeds this item's configured maximum" };
      }
    } else if (quantity !== 1) {
      return { success: false, error: 'Permanent shop items require quantity 1' };
    }
  }
  assertObjectSpawnerCheckoutLimit(items);

  const fileItems = items.filter(item => item.spawn_method !== 'capability');
  if (fileItems.length > 0) {
    await assertNoUnresolvedProviderMutation(db, order.server_id);
  }
  const teleportItems = items.filter(item => item.capability_config?.capability === 'teleport');
  const radarItems = items.filter(item => item.spawn_method === 'capability' &&
    item.capability_config?.capability !== 'teleport');
  if (teleportItems.length > 1) {
    return { success: false, error: 'Only one teleport may be purchased at a time' };
  }
  if (teleportItems.length === 1 && items.length !== 1) {
    return { success: false, error: 'Teleport purchases must be checked out separately' };
  }
  for (const item of teleportItems) {
    await lockPlayerTeleportEligibility(db, {
      serverId: order.server_id,
      identityId: order.identity_id,
      actorUserId,
      destinationId: item.capability_config.destinationId,
      source: 'shop',
    });
  }
  await spawnExclusionService.assertEventPlacementsAllowed(db, order.server_id, fileItems);
  await assertEventRentalPlacementsAvailable(db, order.server_id, fileItems);

  // Calculate total in integer cents, then lock the supply/config parent before accounts.
  const totalCents = sumLineItemCents(items);
  const total = centsToAmount(totalCents);
  const economyConfig = await moneySupplyManager.lockSupplyForUpdate(db, order.server_id);

  // Check wallet balance
  const wallet = await db.get(
    'SELECT cash_on_hand FROM player_wallets WHERE identity_id = $1 AND server_id = $2 FOR UPDATE',
    [order.identity_id, order.server_id]
  );
  const walletBalCents = wallet ? parseCents(wallet.cash_on_hand, 'Wallet balance') : 0;

  let walletDeductCents = 0;
  let bankDeductCents = 0;

  if (walletBalCents >= totalCents) {
    walletDeductCents = totalCents;
  } else {
    walletDeductCents = walletBalCents;
    bankDeductCents = totalCents - walletBalCents;

    const bank = await db.get(
      'SELECT balance FROM player_bank_accounts WHERE identity_id = $1 AND server_id = $2 FOR UPDATE',
      [order.identity_id, order.server_id]
    );
    const bankBalCents = bank ? parseCents(bank.balance, 'Bank balance') : 0;
    if (bankBalCents < bankDeductCents) {
      return { success: false, error: 'Insufficient funds (need ' + total.toFixed(2) + ', have ' + centsToAmount(walletBalCents + bankBalCents).toFixed(2) + ')' };
    }
  }
  const walletDeduct = centsToAmount(walletDeductCents);
  const bankDeduct = centsToAmount(bankDeductCents);
  timer?.checkpoint('database');

  // Validate provisioning before changing balances. A checkout without an
  // authorized token or active mission cannot deliver what the player bought.
  let token = null;
  let platformServerId = null;
  let missionDir = null;
  let providerMutationId = null;
  let fileJournal = { rollback: async () => {} };
  let stagedProviderFiles = null;
  let provisionFileService = fileJournal;
  if (fileItems.length > 0) {
    const tokenInfo = await getTokenForServer(db, order.server_id);
    if (!tokenInfo || !tokenInfo.token) {
      throw new Error('No authorized Nitrado token found for shop server');
    }
    ({ token, platformServerId } = tokenInfo);
    const missionData = await missionFileService.getActiveMission(platformServerId, token);
    if (!missionData || !missionData.mission) {
      throw new Error('Could not determine the active mission for shop server');
    }
    missionDir = missionData.missionPath;
    const prepared = await prepareShopProviderMutation(db, {
      serverId: order.server_id,
      action: 'checkout',
      contextType: 'shop_order',
      contextId: orderId,
      triggeredBy: `user:${actorUserId}`,
      missionDir,
      platformServerId,
      token,
      filePaths: collectShopCheckoutFilePaths(missionDir, fileItems),
      plan: {
        orderId,
        orderItemIds: fileItems.map(item => item.id),
        spawnMethods: [...new Set(fileItems.map(item => item.spawn_method))],
      },
    });
    providerMutationId = prepared.operationId;
    fileJournal = createFileMutationJournal(
      platformServerId, token, missionFileService, prepared.snapshots
    );
    stagedProviderFiles = createStagedProviderFiles(prepared.snapshots);
    provisionFileService = stagedProviderFiles.fileService;
  }
  // Capture every collision source in the same compare-before-write journal
  // used for provisioning, then verify those snapshots again after writes.
  if (providerMutationId !== null) {
    registerProviderMutationRollback(db, {
      operationId: providerMutationId,
      journal: fileJournal,
    });
  }
  if (fileItems.length > 0) {
    await assignPurchaseEventNames(db, fileItems);
    await assertPurchaseEventNamesAvailable(
      platformServerId, token, missionDir, fileItems, fileJournal
    );
  }
  const eventItems = fileItems.filter(item => item.spawn_method === 'event');
  const secondaryReferences = eventItems.flatMap(item => {
    const cfg = resolveEventConfig(item.event_config);
    return cfg.secondary ? [{ type: cfg.secondary, spawnsecondary: true }] : [];
  });
  await assertSpawnsecondaryReferencesExist(
    platformServerId,
    token,
    missionDir,
    secondaryReferences,
    missionFileService,
    eventItems.map(item => item.event_name)
  );
  timer?.checkpoint('provider_preflight');

  // Deduct currency
  if (walletDeduct > 0) {
    await db.query(
      'UPDATE player_wallets SET cash_on_hand = cash_on_hand - $1, last_updated = NOW() WHERE identity_id = $2 AND server_id = $3',
      [centsToDecimal(walletDeductCents), order.identity_id, order.server_id]
    );
    const walletTransaction = await db.get(
      `INSERT INTO economy_transactions (identity_id, server_id, transaction_type, amount, balance_after, account_type, source, shop_order_id, timestamp)
       VALUES ($1, $2, 'debit', $3, (SELECT cash_on_hand FROM player_wallets WHERE identity_id = $1 AND server_id = $2), 'wallet', 'shop_purchase', $4, NOW())
       RETURNING id`,
      [order.identity_id, order.server_id, centsToDecimal(-walletDeductCents), order.id]
    );
    await db.query(
      `INSERT INTO shop_order_payment_allocations
         (order_id, server_id, identity_id, account_type, amount, economy_transaction_id)
       VALUES ($1, $2, $3, 'wallet', $4, $5)`,
      [order.id, order.server_id, order.identity_id, centsToDecimal(walletDeductCents), walletTransaction.id]
    );
  }

  if (bankDeduct > 0) {
    await db.query(
      'UPDATE player_bank_accounts SET balance = balance - $1, last_transaction = NOW() WHERE identity_id = $2 AND server_id = $3',
      [centsToDecimal(bankDeductCents), order.identity_id, order.server_id]
    );
    const bankTransaction = await db.get(
      `INSERT INTO economy_transactions (identity_id, server_id, transaction_type, amount, balance_after, account_type, source, shop_order_id, timestamp)
       VALUES ($1, $2, 'debit', $3, (SELECT balance FROM player_bank_accounts WHERE identity_id = $1 AND server_id = $2), 'bank', 'shop_purchase', $4, NOW())
       RETURNING id`,
      [order.identity_id, order.server_id, centsToDecimal(-bankDeductCents), order.id]
    );
    await db.query(
      `INSERT INTO shop_order_payment_allocations
         (order_id, server_id, identity_id, account_type, amount, economy_transaction_id)
       VALUES ($1, $2, $3, 'bank', $4, $5)`,
      [order.id, order.server_id, order.identity_id, centsToDecimal(bankDeductCents), bankTransaction.id]
    );
  }

  if (totalCents > 0 && economyConfig.fixed_supply_enabled) {
    await moneySupplyManager.removeFromSupplyInTransaction(
      db, order.server_id, total, 'shop_purchase', order.identity_id, { orderId }
    );
  }

  // Group items by spawn method
      const byMethod = { cfgEffectArea: [], custom_json: {}, event: {} };

      for (const item of items) {
        const qty = Math.max(1, parseInt(item.quantity, 10) || 1);
        const provisionQuantity = item.item_type === 'event_rental' ? 1 : qty;

        if (item.spawn_method === 'cfgEffectArea') {
          const fileEntryId = generateAreaName(item.id);
          if (item.item_type === 'event_rental') {
            await db.query(
              'UPDATE shop_order_items SET file_entry_id = $1, restarts_remaining = $2 WHERE id = $3',
              [fileEntryId, qty, item.id]
            );
          } else {
            await db.query('UPDATE shop_order_items SET file_entry_id = $1 WHERE id = $2', [fileEntryId, item.id]);
          }
          // Spawn one entry per unit purchased; each gets its own unique AreaName
          for (let q = 0; q < provisionQuantity; q++) {
            const entryId = q === 0 ? fileEntryId : generateAreaName(item.id + '_q' + q);
            byMethod.cfgEffectArea.push(buildEffectAreaEntry({
              entryId,
              itemClass: item.item_class,
              posX: item.pos_x,
              posY: item.pos_y,
              posZ: item.pos_z,
            }));
          }
        } else if (item.spawn_method === 'custom_json') {
          const fileEntryId = generateAreaName(item.id);
          const objectSpawnerConfig = normalizeObjectSpawnerConfig(item.object_spawner_config || {
            file: item.custom_json_file || LEGACY_OBJECT_SPAWNER_FILE,
          });
          const relativePath = normalizeMissionRelativeJsonPath(
            item.custom_json_file || objectSpawnerConfig.file
          ).slice(2);
          const cleanupMetadata = JSON.stringify({ method: 'custom_json', entryId: fileEntryId, file: relativePath });
          if (item.item_type === 'event_rental') {
            await db.query(
              'UPDATE shop_order_items SET file_entry_id = $1, restarts_remaining = $2 WHERE id = $3',
              [cleanupMetadata, qty, item.id]
            );
          } else {
            await db.query('UPDATE shop_order_items SET file_entry_id = $1 WHERE id = $2', [cleanupMetadata, item.id]);
          }
          const filePath = missionDir + '/' + relativePath;
          if (!byMethod.custom_json[filePath]) byMethod.custom_json[filePath] = [];
          for (let q = 0; q < provisionQuantity; q++) {
            const entryId = q === 0 ? fileEntryId : generateAreaName(item.id + '_q' + q);
            byMethod.custom_json[filePath].push(buildObjectSpawnerEntry({
              entryId,
              itemClass: item.item_class,
              posX: item.pos_x,
              posY: item.pos_y,
              posZ: item.pos_z,
              yaw: item.ypr_x,
              pitch: item.ypr_y,
              roll: item.ypr_z,
              objectSpawnerConfig,
            }));
          }
        } else if (item.spawn_method === 'event' && item.event_name) {
          const resolvedConfig = resolveEventConfig(item.event_config);
          const companions = [];
          for (const component of resolvedConfig.effectAreaComponents || []) {
            const entryId = generateAreaName(item.id + '_effect_' + companions.length);
            const offset = component.offset.map(Number);
            const entry = buildEffectAreaEntry({
              entryId, itemClass: component.type,
              posX: Number(item.pos_x) + offset[0], posY: Number(item.pos_y) + offset[1], posZ: Number(item.pos_z) + offset[2],
            });
            entry.Data.Radius = Number(component.radius ?? 1);
            byMethod.cfgEffectArea.push(entry);
            companions.push({ method: 'cfgEffectArea', entryId });
          }
          for (const component of resolvedConfig.objectSpawnerComponents || []) {
            const entryId = generateAreaName(item.id + '_object_' + companions.length);
            const componentConfig = normalizeEventObjectSpawnerComponent(component);
            const relativePath = normalizeMissionRelativeJsonPath(componentConfig.file).slice(2);
            const filePath = missionDir + '/' + relativePath;
            if (!byMethod.custom_json[filePath]) byMethod.custom_json[filePath] = [];
            const offset = component.offset.map(Number);
            const ypr = component.ypr || [0, 0, 0];
            const entry = buildObjectSpawnerEntry({
              entryId, itemClass: component.name,
              posX: Number(item.pos_x) + offset[0], posY: Number(item.pos_y) + offset[1], posZ: Number(item.pos_z) + offset[2],
              yaw: ypr[0], pitch: ypr[1], roll: ypr[2],
              objectSpawnerConfig: componentConfig,
            });
            byMethod.custom_json[filePath].push(entry);
            companions.push({ method: 'custom_json', entryId, file: relativePath });
          }
          // file_entry_id is a JSON coord key written after addEventSpawnPosition succeeds
          if (!byMethod.event[item.event_name]) {
            byMethod.event[item.event_name] = {
              itemClass:  item.item_class,
              itemName:   item.item_name,
              shopItemId: item.shop_item_id,
              config:     item.event_config,
              positions:  [],
            };
          }
          byMethod.event[item.event_name].positions.push({
            orderItemId:    item.id,
            itemType:       item.item_type,
            rentalRestarts: qty,
            companions,
            ...buildEventSpawnPosition({
              posX: item.pos_x,
              posY: item.pos_y,
              posZ: item.pos_z,
              yaw: item.ypr_x,
            }),
          });
        }
      }
      timer?.checkpoint('spawn_generation');

      try {
        if (byMethod.cfgEffectArea.length > 0) {
          await appendEffectAreaEntries(platformServerId, token, missionDir, byMethod.cfgEffectArea, provisionFileService);
        }
        for (const [filePath, entries] of Object.entries(byMethod.custom_json)) {
          await ensureObjectSpawnerRegistered(
            platformServerId, token, missionDir, filePath.slice(missionDir.length + 1), provisionFileService
          );
          await appendCustomJsonEntries(platformServerId, token, filePath, entries, provisionFileService);
        }
        if (Object.keys(byMethod.event).length > 0) {
          // Register shop_events.xml in cfgeconomycore.xml once per checkout
          await ensureCfgEconomyCoreShopEntry(platformServerId, token, missionDir, provisionFileService);
          for (const [eventName, eventData] of Object.entries(byMethod.event)) {
            const resolvedConfig = resolveEventConfig(eventData.config);
            const groupName = resolvedConfig.eventGroupChildren?.length ? eventName + '_Group' : null;
            if (groupName) {
              await ensureShopEventGroupDefinition(
                platformServerId, token, missionDir, groupName, resolvedConfig.eventGroupChildren, provisionFileService
              );
            }
            await ensureShopEventDefinition(
              platformServerId, token, missionDir, eventName,
              eventData.itemClass, eventData.config,
              { itemName: eventData.itemName, itemClass: eventData.itemClass, shopItemId: eventData.shopItemId },
              provisionFileService
            );
            for (const pos of eventData.positions) {
              // Stage the position and store the returned JSON key as file_entry_id.
              const eventEntryId = await addEventSpawnPosition(
                platformServerId, token, missionDir, eventName,
                pos.x, pos.z, pos.a, pos.y, provisionFileService, groupName ? { group: groupName } : {}
              );
              const entryId = JSON.stringify({ ...JSON.parse(eventEntryId), companions: pos.companions });
              if (pos.itemType === 'event_rental') {
                await db.query(
                  'UPDATE shop_order_items SET file_entry_id = $1, restarts_remaining = $2, is_active = TRUE WHERE id = $3',
                  [entryId, pos.rentalRestarts || 1, pos.orderItemId]
                );
              } else {
                await db.query(
                  'UPDATE shop_order_items SET file_entry_id = $1, is_active = TRUE WHERE id = $2',
                  [entryId, pos.orderItemId]
                );
              }
            }
          }
        }

        if (stagedProviderFiles) {
          await stagedProviderFiles.flush(fileJournal, platformServerId, token);
        }

        if (fileItems.length > 0) {
          await assertPurchaseEventNamesAvailable(
            platformServerId, token, missionDir, fileItems, fileJournal, { allowShopPurchaseNames: true }
          );
        }
        timer?.checkpoint('provider_mutation');

        await activateRadarCapabilities(db, order, radarItems, actorUserId);
        for (const item of teleportItems) {
          await requestPlayerTeleport(db, {
            serverId: order.server_id,
            identityId: order.identity_id,
            actorUserId,
            destinationId: item.capability_config.destinationId,
            source: 'shop',
            reason: `Shop order ${order.id}`,
            orderItemId: item.id,
          });
          await db.query(
            'UPDATE shop_order_items SET is_active = TRUE WHERE id = $1 AND order_id = $2',
            [item.id, order.id]
          );
        }

        // Keep the order update inside the journal scope so a database error
        // restores the external files before the transaction aborts.
        await db.query(
          `UPDATE shop_emote_capture_requests
           SET status = 'cancelled', rejection_reason = 'checkout_completed',
               cancelled_at = clock_timestamp()
           WHERE order_id = $1 AND status = 'pending'`,
          [orderId]
        );
        await db.query(
          'UPDATE shop_orders SET status = $1, total_price = $2, checked_out_at = NOW() WHERE id = $3',
          ['completed', total, orderId]
        );
        if (providerMutationId !== null) {
          await updatePreparedProviderMutation(db, providerMutationId, 'completed', null);
        }
        timer?.checkpoint('order_finalization');
      } catch (fileErr) {
        console.error('❌ Shop file update failed:', fileErr.message);
        if (providerMutationId !== null) {
          await compensateProviderMutation(db, providerMutationId, fileJournal, fileErr);
        } else {
          await fileJournal.rollback();
        }
        throw new Error('Shop file update failed: ' + fileErr.message);
      }

  console.log('✅ Shop checkout complete for order', orderId, '— total', total.toFixed(2));
  return { success: true, totalCharged: total };
}

// ---------------------------------------------------------------------------
// Rental expiry — remove file entries for expired order items
// ---------------------------------------------------------------------------

async function cancelRefundableTeleportRequests(db, serverId, orderItemIds) {
  if (!orderItemIds?.length) return;
  const placeholders = orderItemIds.map((_, index) => '$' + (index + 2)).join(', ');
  const requests = await db.query(
    `SELECT tr.id, tr.guild_id, tr.server_id, tr.identity_id, tr.requested_by_user_id,
            tr.order_item_id, tr.status
     FROM teleport_requests tr
     WHERE tr.server_id = $1 AND tr.order_item_id IN (${placeholders})
     FOR UPDATE OF tr`,
    [serverId, ...orderItemIds]
  );
  const irreversible = requests.find(request =>
    ['provisioning', 'armed', 'cleanup_pending', 'cleanup_processing', 'cleanup_restart_pending', 'completed'].includes(request.status)
  );
  if (irreversible) {
    const error = new Error('Teleport refund is unavailable after provisioning begins');
    error.code = 'TELEPORT_REFUND_UNAVAILABLE';
    error.status = 409;
    throw error;
  }
  for (const request of requests.filter(row => row.status === 'waiting_disconnect')) {
    await db.query(
      `UPDATE teleport_requests
       SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1 AND server_id = $2 AND status = 'waiting_disconnect'`,
      [request.id, serverId]
    );
    await db.query(
      `INSERT INTO teleport_events
         (request_id, guild_id, server_id, identity_id, actor_user_id, event_type, metadata)
       VALUES ($1, $2, $3, $4, $5, 'cancelled', $6)`,
      [request.id, request.guild_id, request.server_id, request.identity_id,
        request.requested_by_user_id || null, JSON.stringify({ reason: 'shop_refund' })]
    );
  }
}

/**
 * Remove DayZ server file entries for a list of expired shop_order_item IDs.
 *
 * Handles three spawn methods:
 *   cfgEffectArea — filter out entries whose AreaName matches file_entry_id
 *   custom_json   — filter out entries whose _shopEntryId matches file_entry_id
 *   event         — remove the event.xml entry only when no other active rental
 *                   on this server references the same event_name
 *
 * @param {object} db - DB abstraction
 * @param {number} serverId
 * @param {number[]} orderItemIds - shop_order_items.id values to remove
 */
async function lockExactRentalItems(db, serverId, orderItemIds) {
  const normalizedIds = orderItemIds.map(Number);
  if (normalizedIds.some(id => !Number.isSafeInteger(id) || id <= 0) ||
      new Set(normalizedIds).size !== normalizedIds.length) {
    throw new Error('Rental cleanup item IDs must be unique positive integers');
  }
  const placeholders = normalizedIds.map(() => '?').join(', ');
  const locked = await db.query(
    `SELECT soi.id
     FROM shop_order_items soi
     JOIN shop_orders so ON soi.order_id = so.id
     WHERE soi.id IN (${placeholders}) AND so.server_id = ?
     FOR UPDATE OF soi`,
    [...normalizedIds, Number(serverId)]
  );
  if (locked.length !== normalizedIds.length) {
    throw new Error('Rental cleanup items do not all belong to the exact server');
  }
  return normalizedIds;
}

async function removeExpiredRentals(db, serverId, orderItemIds) {
  if (!orderItemIds || orderItemIds.length === 0) return;

  await acquireShopServerLock(db, serverId);
  orderItemIds = await lockExactRentalItems(db, serverId, orderItemIds);
  await cancelRefundableTeleportRequests(db, serverId, orderItemIds);

  const capabilityPlaceholders = orderItemIds.map((_, index) => '$' + (index + 1)).join(', ');
  const capabilityItems = await db.query(
    `SELECT id FROM shop_order_items
     WHERE id IN (${capabilityPlaceholders}) AND spawn_method = 'capability'`,
    orderItemIds
  );
  if (capabilityItems.length > 0) {
    const capabilityIds = capabilityItems.map(item => item.id);
    const activationPlaceholders = capabilityIds.map((_, index) => '$' + (index + 1)).join(', ');
    await db.query(
      `UPDATE radar_activations
       SET status = 'expired', revoked_at = clock_timestamp()
       WHERE order_item_id IN (${activationPlaceholders}) AND status = 'active'`,
      capabilityIds
    );
    const capabilityIdSet = new Set(capabilityIds.map(Number));
    orderItemIds = orderItemIds.filter(id => !capabilityIdSet.has(Number(id)));
    if (orderItemIds.length === 0) return;
  }
  await assertNoUnresolvedProviderMutation(db, serverId);

  // Load and validate all cleanup metadata before accessing provider credentials or files.
  const placeholders = orderItemIds.map((_, i) => '$' + (i + 1)).join(', ');
  const exclusionPlaceholders = orderItemIds.map(() => '?').join(', ');
  const expired = await db.query(
    `SELECT soi.id, soi.file_entry_id, soi.spawn_method,
            CASE WHEN soi.snapshot_schema_version = 1 THEN soi.custom_json_file_snapshot ELSE si.custom_json_file END AS custom_json_file,
            CASE WHEN soi.snapshot_schema_version = 1 THEN soi.event_name_snapshot ELSE si.event_name END AS event_name
     FROM shop_order_items soi
     JOIN shop_items si ON soi.shop_item_id = si.id
     WHERE soi.id IN (${placeholders})`,
    orderItemIds
  );

  // Group by spawn method using mission-relative paths only during preflight.
  const effectAreaIds = new Set();
  const customJsonRelativeFiles = {}; // relative path → Set of _shopEntryIds
  const eventsToCheck   = new Set();
  const eventGroupsByEvent = new Map();
  const eventEntryIds   = []; // file_entry_id JSON strings for event spawn positions
  const cleanupTargetOwners = new Map();
  const registerCleanupTarget = (method, relativePath, entryId, orderItemId) => {
    const key = JSON.stringify([method, relativePath || null, entryId]);
    if (cleanupTargetOwners.has(key)) {
      throw new Error('Duplicate shop cleanup metadata across selected order items');
    }
    cleanupTargetOwners.set(key, orderItemId);
  };

  for (const item of expired) {
    if (item.spawn_method === 'event') {
      if (!item.file_entry_id) throw new Error('Event rental is missing its file entry metadata');
      if (!item.event_name) throw new Error('Event rental is missing its event name');
      const [entry] = parseEventRentalEntryIds([item.file_entry_id]);
      if (entry.event !== item.event_name) throw new Error('Event rental metadata does not match its event name');
      registerCleanupTarget(
        'event',
        entry.event,
        JSON.stringify([Number(entry.x), Number(entry.z), Number(entry.a), Number(entry.y || 0)]),
        item.id
      );
      if (entry.group) {
        if (!/^[A-Za-z0-9_]+$/.test(entry.group) || entry.group !== item.event_name + '_Group') {
          throw new Error('Event rental metadata has an invalid event group');
        }
        eventGroupsByEvent.set(item.event_name, entry.group);
      }
      if (entry.companions !== undefined && !Array.isArray(entry.companions)) {
        throw new Error('Event rental companion metadata is invalid');
      }
      for (const companion of entry.companions || []) {
        if (!companion || !isOwnedShopEntryId(companion.entryId)) {
          throw new Error('Event rental companion metadata is invalid');
        }
        if (companion.method === 'cfgEffectArea') {
          registerCleanupTarget('cfgEffectArea', null, companion.entryId, item.id);
          effectAreaIds.add(companion.entryId);
        } else if (companion.method === 'custom_json') {
          const relativePath = normalizeMissionRelativeJsonPath(companion.file).slice(2);
          registerCleanupTarget('custom_json', relativePath, companion.entryId, item.id);
          if (!customJsonRelativeFiles[relativePath]) customJsonRelativeFiles[relativePath] = new Set();
          customJsonRelativeFiles[relativePath].add(companion.entryId);
        } else {
          throw new Error('Event rental companion metadata has an unsupported method');
        }
      }
      eventsToCheck.add(item.event_name);
      eventEntryIds.push(item.file_entry_id);
      continue;
    }
    if (item.spawn_method === 'cfgEffectArea') {
      if (!isOwnedShopEntryId(item.file_entry_id)) {
        throw new Error('Invalid cfgEffectArea cleanup metadata');
      }
      registerCleanupTarget('cfgEffectArea', null, item.file_entry_id, item.id);
      effectAreaIds.add(item.file_entry_id);
    } else if (item.spawn_method === 'custom_json') {
      const metadata = parseCustomJsonCleanupMetadata(item.file_entry_id, item.custom_json_file);
      registerCleanupTarget('custom_json', metadata.relativePath, metadata.entryId, item.id);
      if (!customJsonRelativeFiles[metadata.relativePath]) {
        customJsonRelativeFiles[metadata.relativePath] = new Set();
      }
      customJsonRelativeFiles[metadata.relativePath].add(metadata.entryId);
    } else if (!item.file_entry_id) {
      continue;
    }
  }

  const tokenInfo = await getTokenForServer(db, serverId);
  if (!tokenInfo || !tokenInfo.token) {
    throw new Error('No authorized Nitrado token found for shop server');
  }

  const { token, platformServerId } = tokenInfo;
  const missionData = await missionFileService.getActiveMission(platformServerId, token);
  if (!missionData || !missionData.mission) {
    throw new Error('Could not determine the active mission for shop server');
  }
  const missionDir = missionData.missionPath;
  const customJsonFiles = Object.fromEntries(
    Object.entries(customJsonRelativeFiles).map(([relativePath, entryIds]) => [
      missionDir + '/' + relativePath,
      entryIds,
    ])
  );

  const cleanupFilePaths = collectShopCleanupFilePaths(missionDir, {
    effectAreaIds,
    customJsonFiles,
    eventEntryIds,
    eventsToCheck,
    eventGroupsByEvent,
  });
  let providerMutationId = null;
  let fileService = createFileMutationJournal(platformServerId, token);
  if (cleanupFilePaths.length > 0) {
    const prepared = await prepareShopProviderMutation(db, {
      serverId,
      action: 'cleanup',
      contextType: 'shop_order_items',
      contextId: orderItemIds.join(','),
      triggeredBy: 'system:shop_cleanup',
      missionDir,
      platformServerId,
      token,
      filePaths: cleanupFilePaths,
      plan: { orderItemIds: orderItemIds.map(Number) },
    });
    providerMutationId = prepared.operationId;
    fileService = createFileMutationJournal(
      platformServerId, token, missionFileService, prepared.snapshots
    );
    registerProviderMutationRollback(db, {
      operationId: providerMutationId,
      journal: fileService,
    });
  }

  try {
    // Remove from cfgEffectArea.json
    if (effectAreaIds.size > 0) {
      const { filePath, raw } = await resolveEffectAreaFilePath(platformServerId, token, missionDir, fileService);
      if (raw === null || raw === undefined) throw new Error('cfgEffectArea.json not found during cleanup');
      let root = JSON.parse(raw);
      root = removeEffectAreaEntries(root, effectAreaIds);
      const lastSlash = filePath.lastIndexOf('/');
      await fileService.uploadFileToServer(
        platformServerId, filePath.slice(0, lastSlash), filePath.slice(lastSlash + 1),
        JSON.stringify(root, null, 2), token
      );
      console.log('✅ Removed ' + effectAreaIds.size + ' expired cfgEffectArea entries');
    }

    // Remove from custom JSON files
    for (const [filePath, entryIds] of Object.entries(customJsonFiles)) {
      const raw = await fileService.downloadFileFromServer(platformServerId, filePath, token);
      if (raw === null || raw === undefined) throw new Error('Object Spawner file not found during cleanup: ' + filePath);
      const root = JSON.parse(raw);
      const entries = removeObjectSpawnerEntries(root, entryIds);
      const lastSlash = filePath.lastIndexOf('/');
      await fileService.uploadFileToServer(
        platformServerId, filePath.slice(0, lastSlash), filePath.slice(lastSlash + 1),
        JSON.stringify(entries, null, 2), token
      );
      console.log('✅ Removed ' + entryIds.size + ' expired custom JSON entries from', filePath);
    }

    // Remove event spawn positions, then definitions with no active rentals.
    if (eventEntryIds.length > 0 || eventsToCheck.size > 0) {
      if (eventEntryIds.length > 0) {
        await removeEventSpawnPositions(platformServerId, token, missionDir, eventEntryIds, fileService);
      }
      for (const eventName of eventsToCheck) {
        // Keep the event definition if any OTHER active rental still references it on this server
        const stillActive = await db.get(
          `SELECT 1 FROM shop_order_items soi
           JOIN shop_orders so ON soi.order_id = so.id
           JOIN shop_items si ON soi.shop_item_id = si.id
           WHERE so.server_id = ?
             AND so.status = 'completed'
             AND soi.is_active = TRUE
             AND CASE WHEN soi.snapshot_schema_version = 1 THEN soi.event_name_snapshot ELSE si.event_name END = ?
             AND soi.id NOT IN (${exclusionPlaceholders})
           LIMIT 1`,
          [serverId, eventName, ...orderItemIds]
        );
        if (stillActive) {
          console.log('ℹ️  Event "' + eventName + '" still active on other rentals — keeping definition');
          continue;
        }
        await removeShopEventDefinition(platformServerId, token, missionDir, eventName, fileService);
        const groupName = eventGroupsByEvent.get(eventName);
        if (groupName) {
          await removeShopEventGroupDefinition(platformServerId, token, missionDir, groupName, fileService);
        }
      }
    }
    if (providerMutationId !== null) {
      await updatePreparedProviderMutation(db, providerMutationId, 'completed', null);
    }
  } catch (error) {
    if (providerMutationId !== null) {
      await compensateProviderMutation(db, providerMutationId, fileService, error);
    } else {
      await fileService.rollback();
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Refund
// ---------------------------------------------------------------------------

function assertRefundAmountText(value) {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    const error = new Error('Approved refund must be decimal text');
    error.status = 400;
    throw error;
  }
}

/**
 * Refund a completed order:
 *   1. Remove any server file entries written at checkout
 *   2. Credit the player's wallet
 *   3. Record the refund transaction
 *   4. Mark the order as 'refunded'
 *
 * @param {object} db - DB abstraction
 * @param {number} orderId - shop_orders.id with status 'completed'
 * @returns {Promise<{success: boolean, error?: string, refunded?: number}>}
 */
async function processRefund(db, orderId, expectedServerId, decision) {
  assertRefundAmountText(decision?.approvedAmount);
  let order = await db.get(
    "SELECT * FROM shop_orders WHERE id = $1 AND server_id = $2 AND status IN ('completed', 'expired')",
    [orderId, expectedServerId]
  );
  if (!order) return { success: false, error: 'Order not found or already refunded' };

  await acquireShopServerLock(db, order.server_id);
  const economyConfig = await moneySupplyManager.lockSupplyForUpdate(db, order.server_id);
  order = await db.get(
    "SELECT * FROM shop_orders WHERE id = $1 AND server_id = $2 AND status IN ('completed', 'expired') FOR UPDATE",
    [orderId, order.server_id]
  );
  if (!order) return { success: false, error: 'Order not found or already refunded' };
  const refundableItems = await db.query(
    `SELECT soi.id, soi.quantity, soi.unit_price, soi.restarts_remaining, soi.is_active,
            CASE WHEN soi.snapshot_schema_version = 1
              THEN soi.item_type_snapshot ELSE si.item_type END AS item_type
     FROM shop_order_items soi
     JOIN shop_items si ON si.id = soi.shop_item_id
     WHERE soi.order_id = $1
     ORDER BY soi.id
     FOR UPDATE OF soi`,
    [orderId]
  );
  const paymentAllocations = await db.query(
    `SELECT account_type, amount
     FROM shop_order_payment_allocations
     WHERE order_id = $1
     ORDER BY id`,
    [orderId]
  );
  const consumptionEvidence = await db.query(
    `SELECT order_item_id, previous_restarts_remaining, resulting_restarts_remaining
     FROM shop_rental_consumption_events
     WHERE order_id = $1
     ORDER BY order_item_id, id`,
    [orderId]
  );
  const consumptionByItem = new Map();
  for (const event of consumptionEvidence) {
    const key = String(event.order_item_id);
    if (!consumptionByItem.has(key)) consumptionByItem.set(key, []);
    consumptionByItem.get(key).push(event);
  }
  let paidCents = 0n;
  let calculatedRefundCents = 0n;
  let consumptionEvidenceComplete = true;
  const rentalPolicyLines = [];
  for (const item of refundableItems) {
    const linePaidCents = parseCentsBigInt(item.unit_price, 'Shop line price') * BigInt(Number(item.quantity));
    paidCents += linePaidCents;
    if (item.item_type === 'event_rental') {
      const rental = calculateProratedRentalRefund({
        unitPrice: item.unit_price,
        quantity: Number(item.quantity),
        purchasedRestarts: Number(item.quantity),
        remainingRestarts: Number(item.restarts_remaining || 0),
      });
      calculatedRefundCents += rental.maximumRefundCents;
      const lineEvents = consumptionByItem.get(String(item.id)) || [];
      let expectedPrevious = Number(item.quantity);
      let lineEvidenceComplete = lineEvents.length === rental.consumedRestarts;
      for (const event of lineEvents) {
        const previous = Number(event.previous_restarts_remaining);
        const resulting = Number(event.resulting_restarts_remaining);
        if (previous !== expectedPrevious || resulting !== previous - 1) {
          lineEvidenceComplete = false;
        }
        expectedPrevious = resulting;
      }
      if (expectedPrevious !== Number(item.restarts_remaining || 0)) lineEvidenceComplete = false;
      consumptionEvidenceComplete = consumptionEvidenceComplete && lineEvidenceComplete;
      rentalPolicyLines.push({
        orderItemId: item.id,
        purchasedRestarts: Number(item.quantity),
        consumedRestarts: rental.consumedRestarts,
        remainingRestarts: Number(item.restarts_remaining || 0),
        paidAmount: centsToDecimal(rental.paidCents),
        calculatedRefund: centsToDecimal(rental.maximumRefundCents),
      });
    } else if (item.is_active) {
      calculatedRefundCents += linePaidCents;
    }
  }
  if (paidCents !== parseCentsBigInt(order.total_price, 'Shop order total')) {
    throw new Error('Order payment evidence does not match the persisted total');
  }
  let allocatedCents = 0n;
  let paymentEvidenceComplete = paymentAllocations.length > 0;
  try {
    for (const allocation of paymentAllocations) {
      allocatedCents += parseCentsBigInt(allocation.amount, 'Shop payment allocation');
    }
  } catch {
    paymentEvidenceComplete = false;
  }
  paymentEvidenceComplete = paymentEvidenceComplete && allocatedCents === paidCents;
  const evidenceComplete = paymentEvidenceComplete && consumptionEvidenceComplete;
  if (!decision || decision.approvedByUserId === undefined) {
    const error = new Error('A documented refund decision is required');
    error.status = 400;
    throw error;
  }
  let requestedRefundCents = calculatedRefundCents;
  if (decision.approvedAmount !== undefined && decision.approvedAmount !== null) {
    try {
      requestedRefundCents = parseCentsBigInt(decision.approvedAmount, 'Approved refund');
    } catch (error) {
      if (!error.status) error.status = 400;
      throw error;
    }
  }
  const validatedDecision = validateRefundDecision({
    calculatedRefundCents,
    requestedRefundCents,
    paidCents,
    reasonCode: decision.reasonCode,
    adminNote: decision.adminNote,
    override: decision.override === true,
    requiresEvidenceOverride: !evidenceComplete,
  });
  const refundCents = requestedRefundCents;
  const refundAmount = centsToDecimal(refundCents);
  await db.query(
    `INSERT INTO player_wallets (identity_id, server_id, cash_on_hand, last_updated)
     VALUES ($1, $2, '0.00', NOW()) ON CONFLICT (identity_id, server_id) DO NOTHING`,
    [order.identity_id, order.server_id]
  );
  const wallet = await db.get(
    `SELECT cash_on_hand FROM player_wallets
     WHERE identity_id = $1 AND server_id = $2 FOR UPDATE`,
    [order.identity_id, order.server_id]
  );
  let refundBalanceCents = null;
  let refundDeferred = false;
  const walletBalanceCents = parseCentsBigInt(wallet.cash_on_hand, 'Wallet balance');
  try {
    refundBalanceCents = checkedAddCents(walletBalanceCents, refundCents, 'Shop refund wallet');
  } catch (error) {
    if (error.status !== 409) throw error;
    refundDeferred = true;
  }

  const orderItems = await db.query(
    'SELECT id FROM shop_order_items WHERE order_id = $1 AND is_active = TRUE',
    [orderId]
  );
  const activeItemIds = orderItems.map(r => r.id);

  // Cleanup must succeed before currency is credited. The route transaction
  // leaves the order eligible for retry if external cleanup fails.
  if (activeItemIds.length > 0) {
    await removeExpiredRentals(db, order.server_id, activeItemIds);
  }

  let refundClaimId = null;
  let refundTransactionId = null;
  if (refundDeferred) {
    const clock = await db.get('SELECT clock_timestamp() AS observed_at');
    const createdAt = new Date(clock?.observed_at);
    if (!Number.isFinite(createdAt.getTime())) throw new Error('Database clock is unavailable');
    refundClaimId = await insertOrVerifyPendingRefundClaim(db, {
      serverId: order.server_id,
      identityId: order.identity_id,
      amountCents: refundCents,
      sourceType: 'shop_order_refund',
      sourceKey: order.id,
      reason: 'destination_wallet_capacity_exceeded',
      createdAt: createdAt.toISOString(),
    });
  } else {
    // Credit wallet after provider cleanup succeeds.
    await db.query(
      `UPDATE player_wallets SET cash_on_hand = $3, last_updated = NOW()
       WHERE identity_id = $1 AND server_id = $2`,
      [order.identity_id, order.server_id, centsToDecimal(refundBalanceCents)]
    );

    // Record refund transaction only when value reached the wallet.
    const refundTransaction = await db.get(
      `INSERT INTO economy_transactions (identity_id, server_id, transaction_type, amount, balance_after, account_type, source, shop_order_id, timestamp)
       VALUES ($1, $2, 'credit', $3,
         (SELECT cash_on_hand FROM player_wallets WHERE identity_id = $1 AND server_id = $2),
         'wallet', 'shop_refund', $4, NOW())
       RETURNING id`,
      [order.identity_id, order.server_id, centsToDecimal(refundCents), order.id]
    );
    refundTransactionId = refundTransaction.id;
  }
  if (refundCents > 0n && economyConfig.fixed_supply_enabled) {
    const supply = await moneySupplyManager.addToSupplyInTransaction(
      db, order.server_id, refundAmount, 'shop_refund', order.identity_id, { orderId }
    );
    if (!supply) throw new Error('Money supply cap exceeded during shop refund');
  }

  const policySnapshot = {
    version: 1,
    method: 'unused_scheduled_restarts',
    permanentItems: 'full_if_active',
    evidenceComplete,
    paymentEvidenceComplete,
    consumptionEvidenceComplete,
    rentalLines: rentalPolicyLines,
  };
  await db.query(
    `INSERT INTO shop_refund_decisions
       (order_id, server_id, identity_id, approved_by_user_id, reason_code, admin_note,
        calculated_amount, approved_amount, paid_amount, override_applied,
        policy_snapshot, payment_status, economy_transaction_id, refund_claim_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14)`,
    [
      order.id, order.server_id, order.identity_id, decision.approvedByUserId,
      decision.reasonCode, validatedDecision.adminNote,
      centsToDecimal(calculatedRefundCents), centsToDecimal(refundCents), centsToDecimal(paidCents),
      validatedDecision.overrideApplied, JSON.stringify(policySnapshot),
      refundDeferred ? 'deferred' : 'credited', refundTransactionId, refundClaimId,
    ]
  );

  // Mark capability provenance refunded before deactivating the order lines.
  if (activeItemIds.length > 0) {
    const placeholders = activeItemIds.map((_, i) => '$' + (i + 1)).join(', ');
    await db.run(
      `UPDATE radar_activations
       SET status = 'refunded', revoked_at = clock_timestamp()
       WHERE order_item_id IN (${placeholders}) AND status IN ('active', 'expired')`,
      activeItemIds
    );
  }

  // Mark all active line items as inactive
  if (activeItemIds.length > 0) {
    const placeholders = activeItemIds.map((_, i) => '$' + (i + 1)).join(', ');
    await db.run(
      `UPDATE shop_order_items SET is_active = FALSE WHERE id IN (${placeholders})`,
      activeItemIds
    );
  }

  // Mark order refunded
  await db.run(
    "UPDATE shop_orders SET status = 'refunded' WHERE id = $1",
    [orderId]
  );

  console.log(
    refundDeferred ? '✅ Refund claim created for order' : '✅ Refund processed for order',
    orderId,
    '— returned',
    refundAmount
  );
  return {
    success: true,
    refunded: refundAmount,
    ...(refundDeferred ? { deferred: true, claimId: refundClaimId } : {}),
  };
}

module.exports = {
  acquireShopServerLock,
  acquireProviderMutationLock,
  assertNoUnresolvedProviderMutation,
  assertObjectSpawnerCheckoutLimit,
  normalizeEventObjectSpawnerComponent,
  collectShopCheckoutFilePaths,
  collectShopCleanupFilePaths,
  createFileMutationJournal,
  assertCheckoutAuthority,
  assertSpawnsecondaryReferencesExist,
  generateAreaName,
  buildEffectAreaEntry,
  buildObjectSpawnerEntry,
  buildEventSpawnPosition,
  removeObjectSpawnerEntries,
  removeEffectAreaEntries,
  parseCustomJsonCleanupMetadata,
  validateProvisioningItem,
  ensureObjectSpawnerRegistered,
  appendEffectAreaEntries,
  appendCustomJsonEntries,
  resolveEventConfig,
  ensureCfgEconomyCoreShopEntry,
  ensureShopEventDefinition,
  ensureShopEventGroupDefinition,
  removeShopEventGroupDefinition,
  removeShopEventDefinition,
  addEventSpawnPosition,
  removeEventSpawnPositions,
  assignPurchaseEventNames,
  assertPurchaseEventNamesAvailable,
  assertEventRentalPlacementsAvailable,
  sumLineItemCents,
  exactShopRefundAmount,
  assertRefundAmountText,
  cancelRefundableTeleportRequests,
  lockExactRentalItems,
  processCheckout,
  removeExpiredRentals,
  processRefund,
};
