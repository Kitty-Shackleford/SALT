'use strict';

const crypto = require('crypto');
const { parseCents, centsToDecimal } = require('../utils/money');
const { isOwnedShopEntryId: isShopEntryId } = require('../utils/shopEntryId');

function positiveInteger(value, label) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new Error(label + ' must be a positive integer');
  }
  return normalized;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = canonicalize(value[key]);
    return result;
  }, {});
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseEffectAreas(content) {
  if (typeof content !== 'string' || content.length === 0) {
    throw new Error('cfgEffectArea provider content is required');
  }
  let root;
  try {
    root = JSON.parse(content);
  } catch (error) {
    throw new Error('cfgEffectArea provider content is malformed: ' + error.message);
  }
  const areas = Array.isArray(root) ? root : root?.Areas;
  if (!Array.isArray(areas)) {
    throw new Error('Unsupported cfgEffectArea provider structure');
  }
  return areas;
}

function indexShopAreas(areas) {
  const byEntryId = new Map();
  for (const area of areas) {
    const rawAreaName = area?.AreaName;
    const rawMarker = area?._shopEntryId;
    if (rawAreaName != null && rawMarker != null && rawAreaName !== rawMarker) {
      throw new Error('Provider shop entry identifiers disagree');
    }
    const areaName = isShopEntryId(rawAreaName) ? rawAreaName : null;
    const marker = isShopEntryId(rawMarker) ? rawMarker : null;
    const entryId = areaName || marker;
    if (!entryId) continue;
    if (byEntryId.has(entryId)) {
      throw new Error('Duplicate live provider entry: ' + entryId);
    }
    byEntryId.set(entryId, area);
  }
  return byEntryId;
}

function normalizeLine(line, serverId, providerAreas) {
  const orderItemId = positiveInteger(line?.id, 'Order item ID');
  const orderId = positiveInteger(line?.order_id, 'Order ID');
  const lineServerId = positiveInteger(line?.server_id, 'Order line server ID');
  if (lineServerId !== serverId) throw new Error('Recovery line does not belong to the exact server');
  if (line.order_status !== 'completed') throw new Error('Recovery requires a completed order');
  if (line.is_active !== true) throw new Error('Recovery requires an active order line');
  if (line.spawn_method !== 'cfgEffectArea') throw new Error('Recovery supports cfgEffectArea lines only');
  if (Number(line.snapshot_schema_version) !== 1 ||
      typeof line.item_class_snapshot !== 'string' || !line.item_class_snapshot.trim()) {
    throw new Error('Recovery requires an immutable provisioning snapshot');
  }
  const quantity = positiveInteger(line.quantity, 'Order line quantity');
  if (quantity !== 1) {
    throw new Error('Recovery requires quantity one unless every provider entry is independently tracked');
  }
  if (!isShopEntryId(line.file_entry_id)) {
    throw new Error('Recovery line has an invalid historical shop entry identifier');
  }
  const area = providerAreas.get(line.file_entry_id);
  if (!area) throw new Error('Recovery line has a missing provider entry');
  if (area.Type !== line.item_class_snapshot) {
    throw new Error('Provider entry type does not match the immutable item class snapshot');
  }
  const unitPriceCents = parseCents(line.unit_price, 'Recovery unit price');
  if (unitPriceCents <= 0) throw new Error('Recovery unit price must be positive');
  const lineAmount = BigInt(unitPriceCents) * BigInt(quantity);
  if (lineAmount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Recovery line amount exceeds the supported exact range');
  }
  return {
    orderItemId,
    orderId,
    identityId: positiveInteger(line.identity_id, 'Identity ID'),
    fileEntryId: line.file_entry_id,
    quantity,
    unitPriceCents,
    lineAmountCents: Number(lineAmount),
    itemClass: line.item_class_snapshot,
    liveEntryType: area.Type,
    orderLineCount: positiveInteger(line.order_line_count, 'Order line count'),
  };
}

function buildRecoveryManifest({ server, orderLines, effectAreaContent } = {}) {
  const serverId = positiveInteger(server?.id, 'Server ID');
  const providerServiceId = String(server?.platformServerId || '').trim();
  if (!/^[1-9]\d*$/.test(providerServiceId)) {
    throw new Error('Provider service ID must be a canonical numeric identifier');
  }
  if (!Array.isArray(orderLines) || orderLines.length === 0) {
    throw new Error('Recovery requires at least one candidate order line');
  }

  const providerFileHash = sha256(effectAreaContent);
  const providerAreas = indexShopAreas(parseEffectAreas(effectAreaContent));
  const seenLineIds = new Set();
  const seenEntryIds = new Set();
  const lines = orderLines.map(line => {
    const normalized = normalizeLine(line, serverId, providerAreas);
    if (seenLineIds.has(normalized.orderItemId)) throw new Error('Duplicate order item in recovery scope');
    if (seenEntryIds.has(normalized.fileEntryId)) throw new Error('Duplicate provider entry in recovery scope');
    seenLineIds.add(normalized.orderItemId);
    seenEntryIds.add(normalized.fileEntryId);
    return normalized;
  }).sort((a, b) => a.orderItemId - b.orderItemId);

  for (const entryId of providerAreas.keys()) {
    if (!seenEntryIds.has(entryId)) {
      throw new Error('Unmapped historical shop entry exists in cfgEffectArea');
    }
  }

  const selectedPerOrder = new Map();
  const expectedPerOrder = new Map();
  let affectedAmountCents = 0;
  for (const line of lines) {
    selectedPerOrder.set(line.orderId, (selectedPerOrder.get(line.orderId) || 0) + 1);
    const priorCount = expectedPerOrder.get(line.orderId);
    if (priorCount !== undefined && priorCount !== line.orderLineCount) {
      throw new Error('Order line count snapshot is inconsistent');
    }
    expectedPerOrder.set(line.orderId, line.orderLineCount);
    affectedAmountCents += line.lineAmountCents;
    if (!Number.isSafeInteger(affectedAmountCents)) {
      throw new Error('Recovery aggregate exceeds the supported exact range');
    }
  }

  const affectedOrderCount = selectedPerOrder.size;
  for (const [orderId, selectedCount] of selectedPerOrder) {
    if (selectedCount > expectedPerOrder.get(orderId)) {
      throw new Error('Selected recovery lines exceed order line count');
    }
  }
  const mixedOrderCount = [...selectedPerOrder.entries()].filter(
    ([orderId, selectedCount]) => selectedCount < expectedPerOrder.get(orderId)
  ).length;
  const manifest = {
    schemaVersion: 1,
    serverId,
    providerServiceId,
    providerFileHash,
    lines,
  };
  const manifestHash = sha256(canonicalJson(manifest));
  return {
    manifest,
    manifestHash,
    summary: {
      serverId,
      affectedLineCount: lines.length,
      affectedOrderCount,
      affectedIdentityCount: new Set(lines.map(line => line.identityId)).size,
      mixedOrderCount,
      affectedAmount: centsToDecimal(affectedAmountCents),
      providerFileHash,
      manifestHash,
    },
  };
}

module.exports = {
  buildRecoveryManifest,
};
