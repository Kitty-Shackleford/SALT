/*
 * DayZ Dashboard - Shop Routes
 * Copyright (C) 2026
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License.
 */

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const shopFileService   = require('../services/shopFileService');
const shopRestartService = require('../services/shopRestartService');
const { attachShopFulfillmentStatuses } = require('../services/shopFulfillmentStatusService');
const { ensurePlayerServerAccess } = require('../middleware/serverAccess');
const { authorizeServer, CAPABILITIES } = require('../services/authorizationService');
const { normalizeCartCoordinates } = require('../utils/shopCoordinates');
const { provisioningFieldsChanged } = require('../utils/shopProvisioningVersion');
const { parseCents, centsToDecimal, amountForResponse } = require('../utils/money');
const { normalizeRadarCapabilityConfig } = require('../utils/radarPolicy');
const { normalizeTeleportCapabilityConfig } = require('../utils/shopCapabilityPolicy');
const { normalizeObjectSpawnerConfig } = require('../services/objectSpawner');
const { createCheckoutTimer } = require('../services/shopCheckout/telemetry');
const {
  normalizeEmoteCaptureConfig,
  armEmoteCapture,
  cancelEmoteCapture,
} = require('../services/shopEmoteCaptureService');
const {
  buildShopCartFingerprint,
  parseShopCheckoutCommand,
} = require('../utils/shopCheckoutCommand');
const {
  parseIdempotencyKey,
  fingerprintFinancialRequest,
  claimFinancialOperationInTransaction,
  completeFinancialOperationInTransaction,
} = require('../utils/financialIdempotency');

router.param('serverId', ensurePlayerServerAccess);

// Valid DayZ CE event name prefixes
const EVENT_PREFIXES = ['Ambient', 'Animal', 'Infected', 'Item', 'Static', 'Trajectory', 'Vehicle'];

const CART_CHECKOUT_ITEMS_SQL = `
  SELECT soi.*,
         CASE WHEN soi.snapshot_schema_version = 1 THEN soi.item_name_snapshot ELSE si.name END AS item_name,
         CASE WHEN soi.snapshot_schema_version = 1 THEN soi.image_url_snapshot ELSE si.image_url END AS image_url,
         CASE WHEN soi.snapshot_schema_version = 1 THEN soi.item_class_snapshot ELSE si.item_class END AS item_class,
         CASE WHEN soi.snapshot_schema_version = 1 THEN soi.item_type_snapshot ELSE si.item_type END AS item_type,
         CASE WHEN soi.snapshot_schema_version = 1 THEN soi.rental_restarts_snapshot ELSE si.rental_restarts END AS rental_restarts,
         CASE WHEN soi.snapshot_schema_version = 1 THEN soi.custom_json_file_snapshot ELSE si.custom_json_file END AS custom_json_file,
         CASE WHEN soi.snapshot_schema_version = 1 THEN soi.object_spawner_config_snapshot ELSE si.object_spawner_config END AS object_spawner_config,
         CASE WHEN soi.snapshot_schema_version = 1 THEN soi.event_name_snapshot ELSE si.event_name END AS event_name,
         CASE WHEN soi.snapshot_schema_version = 1 THEN soi.event_config_snapshot ELSE si.event_config END AS event_config,
         CASE WHEN soi.snapshot_schema_version = 1 THEN soi.capability_config_snapshot ELSE si.capability_config END AS capability_config,
         si.server_id AS catalog_server_id,
         si.is_active AS catalog_is_active
  FROM shop_order_items soi
  JOIN shop_items si ON si.id = soi.shop_item_id
  WHERE soi.order_id = ?
  ORDER BY soi.id`;

/**
 * Build a unique, valid DayZ CE event name.
 * Format: {Prefix}{SanitisedBaseName}{6-char-sha1-hash}
 *
 * The hash is derived from the shop item's own database ID (auto-increment PK),
 * which guarantees uniqueness — no two items can ever share the same hash.
 *
 * @param {string}       prefix     - One of the seven CE prefixes
 * @param {string}       baseName   - Human-readable hint (e.g. item class or label)
 * @param {string|number} shopItemId - shop_items.id (unique PK)
 * @returns {string}
 */
function generateEventName(prefix, baseName, shopItemId) {
  const safePrefix = EVENT_PREFIXES.includes(prefix) ? prefix : 'Static';
  const base = (baseName || 'Shop').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
  const hash  = crypto.createHash('sha1')
    .update(String(shopItemId))
    .digest('hex')
    .slice(0, 6);
  return safePrefix + base + hash;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize the value written to the NOT NULL rental_restarts column.
 * Non-rental items and invalid or missing input use the schema default of one.
 * @param {*} value
 * @returns {number}
 */
function normalizeRentalRestarts(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

function normalizeShopCapability(spawnMethod, capabilityConfig) {
  if (spawnMethod !== 'capability') {
    if (capabilityConfig != null) throw new Error('capability_config requires capability spawn method');
    return null;
  }
  return capabilityConfig?.capability === 'teleport'
    ? normalizeTeleportCapabilityConfig(capabilityConfig)
    : normalizeRadarCapabilityConfig(capabilityConfig);
}

function normalizeShopObjectSpawner(spawnMethod, customJsonFile, objectSpawnerConfig) {
  if (spawnMethod !== 'custom_json') {
    if (objectSpawnerConfig != null) {
      throw new Error('object_spawner_config requires the Object Spawner fulfillment method');
    }
    return null;
  }
  const config = normalizeObjectSpawnerConfig(objectSpawnerConfig || {});
  return normalizeObjectSpawnerConfig({
    ...config,
    file: customJsonFile || config.file,
  });
}

function normalizeShopPrice(value) {
  const cents = parseCents(value, 'Shop price');
  if (cents <= 0) throw new Error('Shop price must be positive');
  return centsToDecimal(cents);
}

async function assertTeleportDestinationExists(db, serverId, capability) {
  if (capability?.capability !== 'teleport') return;
  const destination = await db.get(
    `SELECT id FROM teleport_destinations
     WHERE id = ? AND server_id = ? AND is_active = TRUE
     FOR UPDATE`,
    [capability.destinationId, serverId]
  );
  if (!destination) throw new Error('Teleport destination is unavailable for this server');
}

function isCatalogItemPurchasable(item) {
  if (item?.spawn_method === 'capability') return true;
  try {
    shopFileService.validateProvisioningItem(item);
    return true;
  } catch (_error) {
    return false;
  }
}

function validatePurchaseQuantity(shopItem, value) {
  const quantity = Number(value);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return { error: 'Quantity must be a positive integer' };
  }
  if (shopItem.item_type === 'event_rental') {
    if (quantity > normalizeRentalRestarts(shopItem.rental_restarts)) {
      return { error: "Rental duration exceeds this item's configured maximum" };
    }
  } else if (quantity !== 1) {
    return { error: 'Permanent shop items require quantity 1' };
  }
  return { quantity };
}

/**
 * Verify the given user is an owner or admin of the guild that owns the server.
 * @param {object} db
 * @param {number|string} userId
 * @param {number|string} serverId
 * @returns {Promise<boolean>}
 */
async function verifyServerOwner(db, userId, serverId) {
  const context = await authorizeServer(
    db,
    { id: userId },
    serverId,
    CAPABILITIES.SERVER_MANAGE
  );
  return Boolean(context);
}

/**
 * Verify an active exact-server membership backed by a linked player account.
 * @param {object} db
 * @param {number|string} userId
 * @param {number|string} identityId
 * @returns {Promise<boolean>}
 */
async function verifyIdentityOwner(db, userId, identityId, serverId) {
  const row = await db.get(
    `SELECT spm.id
     FROM server_player_memberships spm
     JOIN linked_accounts la
       ON spm.source_link_id = la.id
      AND la.user_id = spm.user_id
      AND la.identity_id = spm.identity_id
      AND la.verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')
     JOIN servers s ON s.id = spm.server_id AND s.guild_id = spm.guild_id AND s.status = 'active'
     JOIN guilds g ON g.id = spm.guild_id AND g.status = 'approved'
     WHERE spm.user_id = ? AND spm.identity_id = ? AND spm.server_id = ?
       AND spm.status = 'active'`,
    [userId, identityId, serverId]
  );
  return !!row;
}

async function lockActiveServerTenant(db, serverId) {
  return db.get(
    `SELECT s.id
     FROM guilds g
     JOIN servers s ON s.guild_id = g.id
     WHERE s.id = ? AND s.status = 'active' AND g.status = 'approved'
     FOR UPDATE OF g, s`,
    [serverId]
  );
}

async function assertServerOwnerForMutation(db, userId, serverId) {
  if (!await lockActiveServerTenant(db, serverId)) return false;
  const guildRole = await db.get(
    `SELECT gr.id
     FROM guild_roles gr
     JOIN servers s ON s.guild_id = gr.guild_id
     WHERE gr.user_id = ? AND s.id = ?
       AND gr.role IN ('owner', 'admin')
     FOR UPDATE OF gr`,
    [userId, serverId]
  );
  if (guildRole) return true;

  const serverRole = await db.get(
    `SELECT sra.id
     FROM server_role_assignments sra
     WHERE sra.user_id = ? AND sra.server_id = ?
       AND sra.role = 'admin' AND sra.status = 'active'
     FOR UPDATE OF sra`,
    [userId, serverId]
  );
  return Boolean(serverRole);
}

async function assertIdentityOwnerForMutation(db, userId, identityId, serverId) {
  if (!await lockActiveServerTenant(db, serverId)) return false;
  const proof = await db.get(
    `SELECT la.id
     FROM linked_accounts la
     WHERE la.user_id = ? AND la.identity_id = ?
       AND la.verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')
     FOR UPDATE OF la`,
    [userId, identityId]
  );
  if (!proof) return false;
  const membership = await db.get(
    `SELECT spm.id
     FROM server_player_memberships spm
     WHERE spm.source_link_id = ? AND spm.user_id = ? AND spm.identity_id = ?
       AND spm.server_id = ? AND spm.status = 'active'
     FOR UPDATE OF spm`,
    [proof.id, userId, identityId, serverId]
  );
  return Boolean(membership);
}

async function addCartItem(db, body) {
  const {
    identityId, serverId, shopItemId, quantity,
  } = body;
  const shopItem = await db.get(
    'SELECT * FROM shop_items WHERE id = ? AND server_id = ? AND is_active = true AND deleted_at IS NULL',
    [shopItemId, serverId]
  );
  if (!shopItem) return { status: 404, error: 'Shop item not found or inactive' };
  if (!isCatalogItemPurchasable(shopItem)) {
    return { status: 409, error: 'Shop item uses an unsupported provisioning method' };
  }
  const quantityResult = validatePurchaseQuantity(shopItem, quantity);
  if (quantityResult.error) return { status: 400, error: quantityResult.error };
  const validatedQuantity = quantityResult.quantity;
  let coordinates;
  let emoteCaptureConfig;
  try {
    coordinates = normalizeCartCoordinates(body);
    emoteCaptureConfig = normalizeEmoteCaptureConfig(shopItem.emote_capture_config);
  } catch (error) {
    return { status: 400, error: error.message };
  }

  let cart = await db.get(
    `SELECT * FROM shop_orders
     WHERE identity_id = ? AND server_id = ? AND status = 'cart' FOR UPDATE`,
    [identityId, serverId]
  );
  if (!cart) {
    await db.run(
      `INSERT INTO shop_orders (identity_id, server_id, status, total_price)
       VALUES (?, ?, 'cart', 0)
       ON CONFLICT DO NOTHING`,
      [identityId, serverId]
    );
    cart = await db.get(
      `SELECT * FROM shop_orders
       WHERE identity_id = ? AND server_id = ? AND status = 'cart' FOR UPDATE`,
      [identityId, serverId]
    );
  }
  if (!cart) return { status: 409, error: 'Cart is no longer available' };

  await db.run(
    `INSERT INTO shop_order_items
       (order_id, shop_item_id, quantity, unit_price,
        pos_x, pos_y, pos_z, ypr_x, ypr_y, ypr_z,
        spawn_method, restarts_remaining, is_active,
        snapshot_schema_version, item_name_snapshot, image_url_snapshot,
        item_class_snapshot, item_type_snapshot, rental_restarts_snapshot,
        custom_json_file_snapshot, object_spawner_config_snapshot,
        event_name_snapshot, event_config_snapshot,
        capability_config_snapshot, emote_capture_config_snapshot,
        provisioning_version_snapshot)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, true, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      cart.id, shopItemId, validatedQuantity, shopItem.price,
      coordinates.pos_x, coordinates.pos_y, coordinates.pos_z,
      coordinates.ypr_x, coordinates.ypr_y, coordinates.ypr_z,
      shopItem.spawn_method,
      shopItem.item_type === 'event_rental' ? validatedQuantity : null,
      shopItem.name, shopItem.image_url || null,
      shopItem.item_class, shopItem.item_type || 'item', shopItem.rental_restarts,
      shopItem.custom_json_file || null, shopItem.object_spawner_config || null,
      shopItem.event_name || null,
      shopItem.event_config || {}, shopItem.capability_config || null,
      emoteCaptureConfig,
      Number(shopItem.provisioning_version) || 1,
    ]
  );
  await recalculateCartTotal(db, cart.id);
  const cartItem = await db.get(
    `SELECT * FROM shop_order_items
     WHERE order_id = ? AND shop_item_id = ?
     ORDER BY id DESC LIMIT 1`,
    [cart.id, shopItemId]
  );
  return { data: cartItem };
}

async function updateCartItem(db, cartItemId, body) {
  const { quantity } = body;
  const cartItem = await db.get(
    `SELECT soi.*, so.id AS order_id,
            CASE WHEN soi.snapshot_schema_version = 1 THEN soi.item_type_snapshot ELSE si.item_type END AS item_type,
            CASE WHEN soi.snapshot_schema_version = 1 THEN soi.rental_restarts_snapshot ELSE si.rental_restarts END AS rental_restarts
     FROM shop_order_items soi
     JOIN shop_orders so ON so.id = soi.order_id
     JOIN shop_items si ON si.id = soi.shop_item_id
     WHERE soi.id = ? AND so.status = 'cart'
     FOR UPDATE OF so`,
    [cartItemId]
  );
  if (!cartItem) return { status: 409, error: 'Cart item is no longer editable' };
  const quantityResult = validatePurchaseQuantity(cartItem, quantity);
  if (quantityResult.error) return { status: 400, error: quantityResult.error };
  let coordinates;
  try {
    coordinates = normalizeCartCoordinates(body, cartItem);
  } catch (error) {
    return { status: 400, error: error.message };
  }

  await db.run(
    `UPDATE shop_order_items SET
       quantity = ?, pos_x = ?, pos_y = ?, pos_z = ?,
       ypr_x = ?, ypr_y = ?, ypr_z = ?
     WHERE id = ? AND order_id = ?`,
    [
      quantityResult.quantity,
      coordinates.pos_x, coordinates.pos_y, coordinates.pos_z,
      coordinates.ypr_x, coordinates.ypr_y, coordinates.ypr_z,
      cartItemId, cartItem.order_id,
    ]
  );
  await recalculateCartTotal(db, cartItem.order_id);
  return { data: await db.get('SELECT * FROM shop_order_items WHERE id = ?', [cartItemId]) };
}

async function deleteCartItem(db, cartItemId) {
  const cartItem = await db.get(
    `SELECT soi.*, so.id AS order_id FROM shop_order_items soi
     JOIN shop_orders so ON so.id = soi.order_id
     WHERE soi.id = ? AND so.status = 'cart'
     FOR UPDATE OF so`,
    [cartItemId]
  );
  if (!cartItem) return { status: 409, error: 'Cart item is no longer removable' };

  await db.run('DELETE FROM shop_order_items WHERE id = ? AND order_id = ?', [cartItemId, cartItem.order_id]);
  await recalculateCartTotal(db, cartItem.order_id);
  return {};
}

// ---------------------------------------------------------------------------
// Owner / Admin Routes  (prefix: /admin)
// ---------------------------------------------------------------------------

/**
 * GET /admin/items/:serverId
 * List all shop items (including inactive) for a server. Requires owner/admin.
 */
router.get('/admin/items/:serverId', async (req, res) => {
  const db = req.app.locals.db;
  const { serverId } = req.params;

  try {
    const isOwner = await verifyServerOwner(db, req.user.id, serverId);
    if (!isOwner) return res.status(403).json({ error: 'Forbidden' });

    const items = await db.query(
      `SELECT si.*,
              COUNT(spl.id) AS preset_locations_count
       FROM shop_items si
       LEFT JOIN shop_preset_locations spl ON spl.shop_item_id = si.id
       WHERE si.server_id = ? AND si.deleted_at IS NULL
       GROUP BY si.id
       ORDER BY si.created_at DESC`,
      [serverId]
    );

    return res.json({ success: true, data: items });
  } catch (err) {
    console.error('GET /admin/items/:serverId', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /admin/items
 * Create a new shop item for a server. Requires owner/admin.
 */
router.post('/admin/items', async (req, res) => {
  const db = req.app.locals.db;
  const {
    serverId, name, item_class, description, price,
    item_type, rental_restarts, spawn_method,
    custom_json_file, object_spawner_config, event_name, event_config, image_url,
    capability_config, emote_capture_config,
  } = req.body;

  try {
    let canonicalPrice;
    let canonicalCapability;
    let canonicalObjectSpawner;
    let canonicalEmoteCapture;
    try {
      canonicalPrice = normalizeShopPrice(price);
      canonicalCapability = normalizeShopCapability(spawn_method, capability_config);
      canonicalEmoteCapture = normalizeEmoteCaptureConfig(emote_capture_config);
      canonicalObjectSpawner = normalizeShopObjectSpawner(
        spawn_method, custom_json_file, object_spawner_config
      );
      if (!canonicalCapability) {
        shopFileService.validateProvisioningItem({
          spawn_method,
          item_class,
          custom_json_file: canonicalObjectSpawner?.file || custom_json_file,
          object_spawner_config: canonicalObjectSpawner,
          event_name: spawn_method === 'event' ? (event_name || 'PendingShopEvent') : event_name,
          event_config,
        });
      }
    } catch (validationError) {
      return res.status(400).json({ error: validationError.message });
    }

    const outcome = await db.transaction(async transactionDb => {
      const authorized = await assertServerOwnerForMutation(
        transactionDb, req.user.id, serverId
      );
      if (!authorized) return { status: 403, error: 'Forbidden' };

      const server = await transactionDb.get('SELECT guild_id FROM servers WHERE id = $1', [serverId]);
      if (!server) return { status: 404, error: 'Server not found' };
      await assertTeleportDestinationExists(transactionDb, serverId, canonicalCapability);

      const result = await transactionDb.query(
        `INSERT INTO shop_items
           (guild_id, server_id, name, item_class, description, price,
            spawn_method, custom_json_file, object_spawner_config, event_config, image_url,
            is_active, item_type, rental_restarts, capability_config, emote_capture_config)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, TRUE, $12, $13, $14, $15)
         RETURNING *`,
        [
          server.guild_id, serverId, name, item_class, description, canonicalPrice,
          spawn_method, canonicalObjectSpawner?.file || custom_json_file || null,
          canonicalObjectSpawner,
          event_config || {}, image_url || null,
          item_type || 'item', normalizeRentalRestarts(rental_restarts), canonicalCapability,
          canonicalEmoteCapture,
        ]
      );

      const created = result[0];
      if (spawn_method === 'event') {
        const prefix = (event_config && event_config.prefix) || 'Static';
        const evtName = generateEventName(prefix, event_name, created.id);
        const patched = await transactionDb.query(
          'UPDATE shop_items SET event_name = $1 WHERE id = $2 RETURNING *',
          [evtName, created.id]
        );
        return { status: 201, data: patched[0] };
      }

      if (event_name) {
        const patched = await transactionDb.query(
          'UPDATE shop_items SET event_name = $1 WHERE id = $2 RETURNING *',
          [event_name, created.id]
        );
        return { status: 201, data: patched[0] };
      }

      return { status: 201, data: created };
    });

    if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });
    return res.status(outcome.status).json({ success: true, data: outcome.data });
  } catch (err) {
    console.error('POST /admin/items', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /admin/items/:itemId
 * Update an existing shop item. Requires owner/admin of the item's guild.
 */
router.put('/admin/items/:itemId', async (req, res) => {
  const db = req.app.locals.db;
  const { itemId } = req.params;
  const {
    name, item_class, description, price,
    item_type, rental_restarts, spawn_method,
    custom_json_file, object_spawner_config, event_name, event_config, image_url, is_active,
    capability_config, emote_capture_config,
    force_provisioning_version, expected_provisioning_version,
  } = req.body;

  try {
    let canonicalPrice;
    let canonicalCapability;
    let canonicalObjectSpawner;
    let canonicalEmoteCapture;
    try {
      canonicalPrice = normalizeShopPrice(price);
      canonicalCapability = normalizeShopCapability(spawn_method, capability_config);
      canonicalEmoteCapture = normalizeEmoteCaptureConfig(emote_capture_config);
      canonicalObjectSpawner = normalizeShopObjectSpawner(
        spawn_method, custom_json_file, object_spawner_config
      );
    } catch (validationError) {
      return res.status(400).json({ error: validationError.message });
    }
    const itemReference = await db.get(
      'SELECT server_id FROM shop_items WHERE id = $1 AND deleted_at IS NULL', [itemId]
    );
    if (!itemReference) return res.status(404).json({ error: 'Item not found' });
    const outcome = await db.transaction(async transactionDb => {
      const authorized = await assertServerOwnerForMutation(
        transactionDb, req.user.id, itemReference.server_id
      );
      if (!authorized) return { status: 403, error: 'Forbidden' };
      const item = await transactionDb.get(
        'SELECT * FROM shop_items WHERE id = $1 AND server_id = $2 AND deleted_at IS NULL FOR UPDATE',
        [itemId, itemReference.server_id]
      );
      if (!item) return { status: 404, error: 'Item not found' };
      await assertTeleportDestinationExists(
        transactionDb, itemReference.server_id, canonicalCapability
      );
      if ((Number(expected_provisioning_version) || 0) !== (Number(item.provisioning_version) || 1)) {
        return { status: 409, error: 'Shop item changed while it was being edited. Reload and try again.' };
      }

      const provisioningChanged = force_provisioning_version === true || provisioningFieldsChanged(item, {
        spawn_method,
        item_class,
        item_type,
        rental_restarts,
        custom_json_file: canonicalObjectSpawner?.file || custom_json_file,
        object_spawner_config: canonicalObjectSpawner,
        event_config,
        capability_config: canonicalCapability,
      });
      const nextProvisioningVersion = (Number(item.provisioning_version) || 1) + 1;

      let resolvedEventName = item.event_name || null;
      if (spawn_method === 'event' && (!resolvedEventName || provisioningChanged)) {
        resolvedEventName = generateEventName(
          (event_config && event_config.prefix) || 'Static',
          item_class || name || event_name,
          `${item.id}:v${nextProvisioningVersion}`
        );
      } else if (spawn_method !== 'event') {
        resolvedEventName = event_name || null;
      }

      try {
        if (!canonicalCapability) {
          shopFileService.validateProvisioningItem({
            spawn_method,
            item_class,
            custom_json_file: canonicalObjectSpawner?.file || custom_json_file,
            object_spawner_config: canonicalObjectSpawner,
            event_name: resolvedEventName,
            event_config,
          });
        }
      } catch (validationError) {
        return { status: 400, error: validationError.message };
      }

      const result = await transactionDb.query(
        `UPDATE shop_items SET
           name = $1, item_class = $2, description = $3, price = $4,
           item_type = $5, rental_restarts = $6, spawn_method = $7,
           custom_json_file = $8, object_spawner_config = $9,
           event_name = $10, event_config = $11,
           image_url = $12, provisioning_version = $13, is_active = $14,
           capability_config = $15, emote_capture_config = $16
         WHERE id = $17 AND provisioning_version = $18
         RETURNING *`,
        [
          name, item_class, description, canonicalPrice,
          item_type || 'item', normalizeRentalRestarts(rental_restarts), spawn_method,
          canonicalObjectSpawner?.file || custom_json_file || null,
          canonicalObjectSpawner,
          resolvedEventName,
          event_config || {}, image_url || null, nextProvisioningVersion,
          is_active !== undefined ? is_active : item.is_active,
          canonicalCapability,
          canonicalEmoteCapture,
          itemId,
          Number(item.provisioning_version) || 1,
        ]
      );
      if (!result[0]) {
        return { status: 409, error: 'Shop item changed while it was being edited. Reload and try again.' };
      }
      return { data: result[0] };
    });

    if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });
    return res.json({ success: true, data: outcome.data });
  } catch (err) {
    console.error('PUT /admin/items/:itemId', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /admin/items/:itemId
 * Archive a shop item so it leaves the catalog while order history remains intact.
 * Requires owner/admin.
 */
router.delete('/admin/items/:itemId', async (req, res) => {
  const db = req.app.locals.db;
  const { itemId } = req.params;

  try {
    const itemReference = await db.get(
      'SELECT server_id FROM shop_items WHERE id = ? AND deleted_at IS NULL', [itemId]
    );
    if (!itemReference) return res.status(404).json({ error: 'Item not found' });
    const outcome = await db.transaction(async transactionDb => {
      const authorized = await assertServerOwnerForMutation(
        transactionDb, req.user.id, itemReference.server_id
      );
      if (!authorized) return { status: 403, error: 'Forbidden' };
      const item = await transactionDb.get(
        'SELECT * FROM shop_items WHERE id = ? AND server_id = ? AND deleted_at IS NULL FOR UPDATE',
        [itemId, itemReference.server_id]
      );
      if (!item) return { status: 404, error: 'Item not found' };
      await transactionDb.run(
        `UPDATE shop_items
         SET is_active = false, deleted_at = CURRENT_TIMESTAMP,
             provisioning_version = provisioning_version + 1
         WHERE id = ? AND server_id = ? AND deleted_at IS NULL`,
        [itemId, item.server_id]
      );
      return { archived: true };
    });
    if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });
    return res.json({ success: true, archived: outcome.archived });
  } catch (err) {
    console.error('DELETE /admin/items/:itemId', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /admin/items/:itemId/presets
 * List all preset spawn locations for a shop item. Requires owner/admin.
 */
router.get('/admin/items/:itemId/presets', async (req, res) => {
  const db = req.app.locals.db;
  const { itemId } = req.params;

  try {
    const item = await db.get('SELECT * FROM shop_items WHERE id = ? AND deleted_at IS NULL', [itemId]);
    if (!item) return res.status(404).json({ error: 'Item not found' });

    const isOwner = await verifyServerOwner(db, req.user.id, item.server_id);
    if (!isOwner) return res.status(403).json({ error: 'Forbidden' });

    const presets = await db.query(
      'SELECT * FROM shop_preset_locations WHERE shop_item_id = ? ORDER BY id',
      [itemId]
    );

    return res.json({ success: true, data: presets });
  } catch (err) {
    console.error('GET /admin/items/:itemId/presets', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /admin/items/:itemId/presets
 * Add a preset spawn location to a shop item. Requires owner/admin.
 */
router.post('/admin/items/:itemId/presets', async (req, res) => {
  const db = req.app.locals.db;
  const { itemId } = req.params;
  const { label, pos_x, pos_y, pos_z, ypr_x, ypr_y, ypr_z } = req.body;

  try {
    const itemReference = await db.get(
      'SELECT server_id FROM shop_items WHERE id = ? AND deleted_at IS NULL', [itemId]
    );
    if (!itemReference) return res.status(404).json({ error: 'Item not found' });

    const outcome = await db.transaction(async transactionDb => {
      const authorized = await assertServerOwnerForMutation(
        transactionDb, req.user.id, itemReference.server_id
      );
      if (!authorized) return { status: 403, error: 'Forbidden' };

      const item = await transactionDb.get(
        'SELECT id FROM shop_items WHERE id = ? AND server_id = ? AND deleted_at IS NULL FOR UPDATE',
        [itemId, itemReference.server_id]
      );
      if (!item) return { status: 404, error: 'Item not found' };

      const created = await transactionDb.get(
        `INSERT INTO shop_preset_locations
           (shop_item_id, label, pos_x, pos_y, pos_z, ypr_x, ypr_y, ypr_z)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
        [itemId, label, pos_x, pos_y, pos_z, ypr_x, ypr_y, ypr_z]
      );
      return { status: 201, data: created };
    });

    if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });
    return res.status(201).json({ success: true, data: outcome.data });
  } catch (err) {
    console.error('POST /admin/items/:itemId/presets', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /admin/presets/:presetId
 * Delete a preset spawn location. Requires owner/admin of the item's guild.
 */
router.delete('/admin/presets/:presetId', async (req, res) => {
  const db = req.app.locals.db;
  const { presetId } = req.params;

  try {
    const presetReference = await db.get(
      `SELECT spl.id, si.server_id
       FROM shop_preset_locations spl
       JOIN shop_items si ON si.id = spl.shop_item_id
       WHERE spl.id = ? AND si.deleted_at IS NULL`,
      [presetId]
    );
    if (!presetReference) return res.status(404).json({ error: 'Preset not found' });

    const outcome = await db.transaction(async transactionDb => {
      const authorized = await assertServerOwnerForMutation(
        transactionDb, req.user.id, presetReference.server_id
      );
      if (!authorized) return { status: 403, error: 'Forbidden' };

      const preset = await transactionDb.get(
        `SELECT spl.id
         FROM shop_preset_locations spl
         JOIN shop_items si ON si.id = spl.shop_item_id
         WHERE spl.id = ? AND si.server_id = ? AND si.deleted_at IS NULL
         FOR UPDATE OF spl`,
        [presetId, presetReference.server_id]
      );
      if (!preset) return { status: 404, error: 'Preset not found' };

      await transactionDb.run('DELETE FROM shop_preset_locations WHERE id = ?', [presetId]);
      return { status: 200 };
    });

    if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });
    return res.json({ success: true });
  } catch (err) {
    console.error('DELETE /admin/presets/:presetId', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /admin/orders/:serverId
 * List all non-cart orders for a server. Requires owner/admin.
 */
router.get('/admin/orders/:serverId', async (req, res) => {
  const db = req.app.locals.db;
  const { serverId } = req.params;

  try {
    const isOwner = await verifyServerOwner(db, req.user.id, serverId);
    if (!isOwner) return res.status(403).json({ error: 'Forbidden' });

    const orders = await db.query(
      `SELECT so.*, pi.platform_username AS player_name, pi.id AS player_identity_id
       FROM shop_orders so
       JOIN player_identities pi ON pi.id = so.identity_id
       WHERE so.server_id = ? AND so.status != 'cart'
       ORDER BY so.created_at DESC`,
      [serverId]
    );

    return res.json({ success: true, data: orders });
  } catch (err) {
    console.error('GET /admin/orders/:serverId', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /admin/orders/:orderId/items
 * Get line items for a specific order. Requires owner/admin of the order's server.
 */
router.get('/admin/orders/:orderId/items', async (req, res) => {
  const db = req.app.locals.db;
  const { orderId } = req.params;

  try {
    const order = await db.get('SELECT * FROM shop_orders WHERE id = ?', [orderId]);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const isOwner = await verifyServerOwner(db, req.user.id, order.server_id);
    if (!isOwner) return res.status(403).json({ error: 'Forbidden' });

    const items = await db.query(
      `SELECT soi.*, CASE WHEN soi.snapshot_schema_version = 1 THEN soi.item_name_snapshot ELSE si.name END AS item_name,
              CASE WHEN soi.snapshot_schema_version = 1 THEN soi.image_url_snapshot ELSE si.image_url END AS image_url,
              CASE WHEN soi.snapshot_schema_version = 1 THEN soi.item_type_snapshot ELSE si.item_type END AS item_type,
              CASE WHEN soi.snapshot_schema_version = 1 THEN soi.item_class_snapshot ELSE si.item_class END AS item_class,
              CASE WHEN soi.snapshot_schema_version = 1 THEN soi.event_name_snapshot ELSE si.event_name END AS event_name
       FROM shop_order_items soi
       JOIN shop_items si ON si.id = soi.shop_item_id
       WHERE soi.order_id = ?
       ORDER BY soi.id`,
      [orderId]
    );

    const itemsWithFulfillment = await attachShopFulfillmentStatuses(
      db,
      order.server_id,
      items.map(item => ({ ...item, checked_out_at: order.checked_out_at }))
    );
    const payment_allocations = await db.query(
      `SELECT account_type, amount, economy_transaction_id, created_at
       FROM shop_order_payment_allocations
       WHERE order_id = ? ORDER BY id`,
      [orderId]
    );
    const consumption_events = await db.query(
      `SELECT srce.order_item_id, srce.previous_restarts_remaining,
              srce.resulting_restarts_remaining, srce.consumed_at,
              srl.id AS restart_log_id, srl.detected_at, srl.provider_started_at,
              srl.evidence_source_file
       FROM shop_rental_consumption_events srce
       JOIN server_restart_log srl ON srl.id = srce.restart_log_id
       WHERE srce.order_id = ? ORDER BY srce.consumed_at, srce.id`,
      [orderId]
    );
    const refund_decisions = await db.query(
      `SELECT srd.reason_code, srd.admin_note, srd.calculated_amount, srd.approved_amount,
              srd.paid_amount, srd.override_applied, srd.policy_snapshot,
              CASE WHEN srd.payment_status = 'deferred'
                THEN COALESCE(frc.status, 'pending') ELSE 'credited' END AS payment_status,
              CASE WHEN srd.payment_status = 'deferred' AND frc.status = 'claimed'
                THEN frc.claimed_at ELSE srd.decided_at END AS payment_status_at,
              srd.refund_claim_id, srd.decided_at
       FROM shop_refund_decisions srd
       LEFT JOIN financial_refund_claims frc ON frc.id = srd.refund_claim_id
       WHERE srd.order_id = ? ORDER BY srd.id`,
      [orderId]
    );
    const eventsByItem = new Map();
    for (const event of consumption_events) {
      if (!eventsByItem.has(event.order_item_id)) eventsByItem.set(event.order_item_id, []);
      eventsByItem.get(event.order_item_id).push(event);
    }
    const data = itemsWithFulfillment.map(item => ({
      ...item,
      purchased_restarts: item.item_type === 'event_rental' ? Number(item.quantity) : null,
      consumed_restarts: item.item_type === 'event_rental'
        ? Number(item.quantity) - Number(item.restarts_remaining || 0)
        : null,
      consumption_events: eventsByItem.get(item.id) || [],
      evidence_history_available: item.item_type !== 'event_rental' ||
        (eventsByItem.get(item.id) || []).length === Number(item.quantity) - Number(item.restarts_remaining || 0),
    }));
    return res.json({
      success: true,
      data,
      payment_allocations,
      consumption_events,
      refund_decisions,
    });
  } catch (err) {
    console.error('GET /admin/orders/:orderId/items', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /admin/orders/:orderId/refund
 * Refund a completed order. Requires owner/admin of the order's server.
 */
router.post('/admin/orders/:orderId/refund', async (req, res) => {
  const db = req.app.locals.db;
  const { orderId } = req.params;
  const {
    reason_code,
    admin_note = '',
    approved_amount,
    override = false,
  } = req.body || {};

  try {
    shopFileService.assertRefundAmountText(approved_amount);
    const order = await db.get('SELECT * FROM shop_orders WHERE id = ?', [orderId]);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const result = await db.transaction(async transactionDb => {
      await shopFileService.acquireShopServerLock(transactionDb, order.server_id);
      const authorized = await assertServerOwnerForMutation(
        transactionDb, req.user.id, order.server_id
      );
      if (!authorized) return { success: false, forbidden: true, error: 'Forbidden' };
      return shopFileService.processRefund(transactionDb, orderId, order.server_id, {
        approvedByUserId: req.user.id,
        reasonCode: reason_code,
        adminNote: admin_note,
        approvedAmount: approved_amount,
        override: override === true,
      });
    });
    if (result.forbidden) return res.status(403).json({ error: result.error });
    if (!result.success) return res.status(409).json({ error: result.error });
    return res.json({ success: true, data: result });
  } catch (err) {
    console.error('POST /admin/orders/:orderId/refund', err);
    if (err.status === 400) return res.status(400).json({ error: err.message });
    if (err.status === 409) return res.status(409).json({ error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /admin/server/:serverId/restart
 * Record an owner-triggered server restart. Requires owner/admin.
 */
router.post('/admin/server/:serverId/restart', async (req, res) => {
  const db = req.app.locals.db;
  const { serverId } = req.params;

  try {
    const outcome = await db.transaction(async transactionDb => {
      await shopFileService.acquireShopServerLock(transactionDb, serverId);
      const authorized = await assertServerOwnerForMutation(
        transactionDb, req.user.id, serverId
      );
      if (!authorized) return { status: 403, error: 'Forbidden' };
      await shopRestartService.recordOwnerRestart(transactionDb, serverId);
      return { status: 200 };
    });
    if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });

    return res.json({ success: true });
  } catch (err) {
    console.error('POST /admin/server/:serverId/restart', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /admin/rentals/:serverId
 * List active event_rental order items with restarts remaining. Requires owner/admin.
 */
router.get('/admin/rentals/:serverId', async (req, res) => {
  const db = req.app.locals.db;
  const { serverId } = req.params;

  try {
    const isOwner = await verifyServerOwner(db, req.user.id, serverId);
    if (!isOwner) return res.status(403).json({ error: 'Forbidden' });

    const rentals = await db.query(
      `SELECT soi.*, CASE WHEN soi.snapshot_schema_version = 1 THEN soi.item_name_snapshot ELSE si.name END AS item_name,
              CASE WHEN soi.snapshot_schema_version = 1 THEN soi.event_name_snapshot ELSE si.event_name END AS event_name,
              so.identity_id, so.total_price AS order_total, so.status AS order_status,
              so.created_at AS order_created_at, so.checked_out_at,
              pi.id AS player_identity_id, pi.platform_username AS player_name,
              soi.quantity AS purchased_restarts,
              (soi.quantity - soi.restarts_remaining) AS consumed_restarts,
              (soi.unit_price * soi.quantity) AS paid_amount,
              (soi.unit_price * soi.restarts_remaining) AS calculated_refund,
              (SELECT MAX(srce.consumed_at) FROM shop_rental_consumption_events srce
               WHERE srce.order_item_id = soi.id) AS last_consumed_at,
              (SELECT COUNT(*)::int FROM shop_rental_consumption_events srce
               WHERE srce.order_item_id = soi.id) AS documented_consumption_count,
              srd.payment_status AS refund_status, srd.approved_amount AS refunded_amount,
              srd.decided_at AS refunded_at
       FROM shop_order_items soi
       JOIN shop_items si ON si.id = soi.shop_item_id
       JOIN shop_orders so ON so.id = soi.order_id
       JOIN player_identities pi ON pi.id = so.identity_id
       LEFT JOIN shop_refund_decisions srd ON srd.order_id = so.id
       WHERE so.server_id = ?
         AND so.status = 'completed'
         AND CASE WHEN soi.snapshot_schema_version = 1 THEN soi.item_type_snapshot ELSE si.item_type END = 'event_rental'
         AND soi.is_active = true
         AND soi.restarts_remaining > 0
       ORDER BY soi.id`,
      [serverId]
    );

    const rentalsWithFulfillment = await attachShopFulfillmentStatuses(db, serverId, rentals);
    return res.json({ success: true, data: rentalsWithFulfillment });
  } catch (err) {
    console.error('GET /admin/rentals/:serverId', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /admin/stats/:serverId
 * Aggregated analytics for the shop dashboard. Requires owner/admin.
 * Returns: total_revenue, order counts by status, top-selling items.
 */
router.get('/admin/stats/:serverId', async (req, res) => {
  const db = req.app.locals.db;
  const { serverId } = req.params;

  try {
    const isOwner = await verifyServerOwner(db, req.user.id, serverId);
    if (!isOwner) return res.status(403).json({ error: 'Forbidden' });

    // Revenue and order counts (excluding open carts)
    const summary = await db.get(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'completed' THEN total_price ELSE 0 END), 0) AS total_revenue,
         COUNT(CASE WHEN status != 'cart' THEN 1 END) AS total_orders,
         COUNT(CASE WHEN status = 'completed' THEN 1 END) AS completed_orders,
         COUNT(CASE WHEN status = 'refunded' THEN 1 END) AS refunded_orders,
         COUNT(CASE WHEN status = 'expired' THEN 1 END) AS expired_orders
       FROM shop_orders
       WHERE server_id = ?`,
      [serverId]
    );

    // Top 5 selling items by quantity sold (completed orders only)
    const topItems = await db.query(
      `SELECT CASE WHEN soi.snapshot_schema_version = 1 THEN soi.item_name_snapshot ELSE si.name END AS name,
              CASE WHEN soi.snapshot_schema_version = 1 THEN soi.item_type_snapshot ELSE si.item_type END AS item_type,
              SUM(soi.quantity) AS total_sold,
              SUM(soi.quantity * soi.unit_price) AS total_revenue
       FROM shop_order_items soi
       JOIN shop_items si ON si.id = soi.shop_item_id
       JOIN shop_orders so ON so.id = soi.order_id
       WHERE so.server_id = ? AND so.status = 'completed'
       GROUP BY si.id, CASE WHEN soi.snapshot_schema_version = 1 THEN soi.item_name_snapshot ELSE si.name END, CASE WHEN soi.snapshot_schema_version = 1 THEN soi.item_type_snapshot ELSE si.item_type END
       ORDER BY total_sold DESC
       LIMIT 5`,
      [serverId]
    );

    // Active item count
    const itemStats = await db.get(
      `SELECT
         COUNT(*) AS total_items,
         COUNT(CASE WHEN is_active = true THEN 1 END) AS active_items
       FROM shop_items WHERE server_id = ?`,
      [serverId]
    );

    // Active rental count
    const rentalStats = await db.get(
      `SELECT COUNT(*) AS active_rentals
       FROM shop_order_items soi
       JOIN shop_items si ON si.id = soi.shop_item_id
       JOIN shop_orders so ON so.id = soi.order_id
       WHERE so.server_id = ? AND CASE WHEN soi.snapshot_schema_version = 1 THEN soi.item_type_snapshot ELSE si.item_type END = 'event_rental'
         AND soi.is_active = true AND soi.restarts_remaining > 0`,
      [serverId]
    );

    return res.json({
      success: true,
      data: { ...summary, ...itemStats, ...rentalStats, top_items: topItems },
    });
  } catch (err) {
    console.error('GET /admin/stats/:serverId', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /admin/items/:itemId/toggle
 * Toggle the is_active flag on a shop item. Requires owner/admin.
 */
router.patch('/admin/items/:itemId/toggle', async (req, res) => {
  const db = req.app.locals.db;
  const { itemId } = req.params;

  try {
    const itemReference = await db.get(
      'SELECT server_id FROM shop_items WHERE id = ? AND deleted_at IS NULL', [itemId]
    );
    if (!itemReference) return res.status(404).json({ error: 'Item not found' });
    const outcome = await db.transaction(async transactionDb => {
      const authorized = await assertServerOwnerForMutation(
        transactionDb, req.user.id, itemReference.server_id
      );
      if (!authorized) return { status: 403, error: 'Forbidden' };
      const item = await transactionDb.get(
        'SELECT * FROM shop_items WHERE id = ? AND server_id = ? AND deleted_at IS NULL FOR UPDATE',
        [itemId, itemReference.server_id]
      );
      if (!item) return { status: 404, error: 'Item not found' };
      if (!item.is_active && !isCatalogItemPurchasable(item)) {
        return { status: 409, error: 'Shop item uses an unsupported provisioning method' };
      }
      const updated = await transactionDb.get(
        `UPDATE shop_items
         SET is_active = NOT is_active, provisioning_version = provisioning_version + 1
         WHERE id = ? AND server_id = ? AND deleted_at IS NULL
         RETURNING *`,
        [itemId, item.server_id]
      );
      return { data: updated };
    });
    if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });
    return res.json({ success: true, data: outcome.data });
  } catch (err) {
    console.error('PATCH /admin/items/:itemId/toggle', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /admin/items/bulk-action
 * Bulk activate, deactivate, or delete shop items. Requires owner/admin.
 * Body: { action: 'activate' | 'deactivate' | 'delete', itemIds: number[] }
 */
router.post('/admin/items/bulk-action', async (req, res) => {
  const db = req.app.locals.db;
  const { action, itemIds } = req.body;

  if (!action || !Array.isArray(itemIds) || !itemIds.length) {
    return res.status(400).json({ error: 'action and itemIds are required' });
  }
  if (!['activate', 'deactivate', 'delete'].includes(action)) {
    return res.status(400).json({ error: 'Invalid action' });
  }

  const normalizedItemIds = [...new Set(itemIds.map(Number))];
  if (normalizedItemIds.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    return res.status(400).json({ error: 'Invalid item ID' });
  }

  try {
    const placeholders = normalizedItemIds.map(() => '?').join(', ');
    const itemReferences = await db.query(
      `SELECT id, server_id FROM shop_items
       WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
      normalizedItemIds
    );
    if (itemReferences.length !== normalizedItemIds.length) {
      return res.status(404).json({ error: 'One or more items were not found' });
    }

    const outcome = await db.transaction(async transactionDb => {
      const serverIds = [...new Set(itemReferences.map(item => Number(item.server_id)))].sort((a, b) => a - b);
      for (const serverId of serverIds) {
        const authorized = await assertServerOwnerForMutation(transactionDb, req.user.id, serverId);
        if (!authorized) return { status: 403, error: 'Forbidden' };
      }

      const items = await transactionDb.query(
        `SELECT * FROM shop_items
         WHERE id IN (${placeholders}) AND deleted_at IS NULL
         ORDER BY server_id, id FOR UPDATE`,
        normalizedItemIds
      );
      const expectedServers = new Map(itemReferences.map(item => [Number(item.id), Number(item.server_id)]));
      if (items.length !== normalizedItemIds.length || items.some(item =>
        expectedServers.get(Number(item.id)) !== Number(item.server_id)
      )) {
        return { status: 409, error: 'Shop items changed while the bulk action was being applied' };
      }

      if (action === 'activate' && items.some(item => !isCatalogItemPurchasable(item))) {
        return { status: 409, error: 'One or more shop items use an unsupported provisioning method' };
      }

      if (action === 'activate') {
        await transactionDb.run(
          `UPDATE shop_items SET is_active = true, provisioning_version = provisioning_version + 1
           WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
          normalizedItemIds
        );
      } else if (action === 'deactivate') {
        await transactionDb.run(
          `UPDATE shop_items SET is_active = false, provisioning_version = provisioning_version + 1
           WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
          normalizedItemIds
        );
      } else {
        await transactionDb.run(
          `UPDATE shop_items
           SET is_active = false, deleted_at = CURRENT_TIMESTAMP,
               provisioning_version = provisioning_version + 1
           WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
          normalizedItemIds
        );
      }
      return { affected: normalizedItemIds.length };
    });
    if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });
    return res.json({ success: true, affected: outcome.affected });
  } catch (err) {
    console.error('POST /admin/items/bulk-action', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Player Routes
// ---------------------------------------------------------------------------

/**
 * GET /maps/:serverId
 * Return terrains observed in recent RPT logs for the exact server available
 * to the current player. The general /api/server-maps route takes a provider
 * service ID and owner authority, while the shop selector carries an internal
 * server ID and is intentionally available to verified players.
 */
router.get('/maps/:serverId', async (req, res) => {
  const db = req.app.locals.db;
  const { serverId, guildId } = req.playerServerAccess;

  try {
    const server = await db.get(
      `SELECT s.platform_server_id, g.discord_guild_id
       FROM servers s
       JOIN guilds g ON g.id = s.guild_id
       WHERE s.id = ? AND s.guild_id = ?`,
      [serverId, guildId]
    );
    if (!server) return res.status(404).json({ error: 'Server not found' });

    const { listAvailableLogs } = require('../services/lootLiveService');
    const supportedMaps = new Set(['chernarusplus', 'enoch', 'sakhal', 'namalsk', 'takistanplus']);
    const maps = [...new Set(
      listAvailableLogs(server.discord_guild_id, server.platform_server_id)
        .map(entry => String(entry.map || '').toLowerCase())
        .filter(mapName => supportedMaps.has(mapName))
    )];
    return res.json({ success: true, maps });
  } catch (err) {
    console.error('GET /shop/maps/:serverId', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /items/:serverId
 * List all active shop items for a server, including preset locations.
 */
router.get('/items/:serverId', async (req, res) => {
  const db = req.app.locals.db;
  const { serverId } = req.params;

  try {
    const items = await db.query(
      `SELECT si.*,
              COUNT(spl.id) AS preset_locations_count
       FROM shop_items si
       LEFT JOIN shop_preset_locations spl ON spl.shop_item_id = si.id
       WHERE si.server_id = ? AND si.is_active = true AND si.deleted_at IS NULL
       GROUP BY si.id
       ORDER BY si.name`,
      [serverId]
    );

    const purchasableItems = items.filter(isCatalogItemPurchasable);
    const itemIds = purchasableItems.map(item => item.id);
    const presets = itemIds.length > 0
      ? await db.query(
        'SELECT * FROM shop_preset_locations WHERE shop_item_id = ANY($1::bigint[]) ORDER BY shop_item_id, id',
        [itemIds]
      )
      : [];
    const presetsByItem = new Map();
    for (const preset of presets) {
      const key = String(preset.shop_item_id);
      if (!presetsByItem.has(key)) presetsByItem.set(key, []);
      presetsByItem.get(key).push(preset);
    }
    for (const item of purchasableItems) {
      item.preset_locations = presetsByItem.get(String(item.id)) || [];
    }

    return res.json({ success: true, data: purchasableItems });
  } catch (err) {
    console.error('GET /items/:serverId', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /cart/:identityId/:serverId
 * Get the current cart (status = 'cart') for a player identity on a server.
 */
router.get('/cart/:identityId/:serverId', async (req, res) => {
  const db = req.app.locals.db;
  const { identityId, serverId } = req.params;

  try {
    const isOwner = await verifyIdentityOwner(db, req.user.id, identityId, serverId);
    if (!isOwner) return res.status(403).json({ error: 'Forbidden' });

    const cart = await db.get(
      `SELECT * FROM shop_orders
       WHERE identity_id = ? AND server_id = ? AND status = 'cart'
       LIMIT 1`,
      [identityId, serverId]
    );

    if (!cart) return res.json({ success: true, data: null });

    const items = await db.query(CART_CHECKOUT_ITEMS_SQL, [cart.id]);
    const checkoutFingerprint = buildShopCartFingerprint(cart, items);
    const captures = await db.query(
      `SELECT DISTINCT ON (order_item_id)
              id, order_item_id,
              CASE WHEN status = 'pending' AND expires_at <= clock_timestamp()
                   THEN 'expired' ELSE status END AS status,
              expected_emote_type, expected_item_name,
              requested_at, expires_at, applied_at,
              applied_pos_x, applied_pos_y, applied_pos_z
       FROM shop_emote_capture_requests
       WHERE order_id = ? AND server_id = ? AND identity_id = ?
       ORDER BY order_item_id, requested_at DESC, id DESC`,
      [cart.id, serverId, identityId]
    );
    const captureByItemId = new Map(captures.map(capture => [String(capture.order_item_id), capture]));
    for (const item of items) {
      item.emote_capture = captureByItemId.get(String(item.id)) || null;
    }

    return res.json({ success: true, data: { ...cart, items, checkoutFingerprint } });
  } catch (err) {
    console.error('GET /cart/:identityId/:serverId', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /cart/add
 * Add an item to the player's cart, creating the cart order if it doesn't exist.
 */
router.post('/cart/add', ensurePlayerServerAccess, async (req, res) => {
  const db = req.app.locals.db;
  const { identityId, serverId } = req.playerServerAccess;

  try {
    const result = await db.transaction(async transactionDb => {
      const authorized = await assertIdentityOwnerForMutation(
        transactionDb, req.user.id, identityId, serverId
      );
      if (!authorized) return { status: 403, error: 'Forbidden' };
      return addCartItem(transactionDb, {
        ...req.body,
        identityId,
        serverId,
      });
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    return res.status(201).json({ success: true, data: result.data });
  } catch (err) {
    console.error('POST /cart/add', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PUT /cart/item/:cartItemId
 * Update quantity or position of a cart line item.
 */
router.put('/cart/item/:cartItemId', async (req, res) => {
  const db = req.app.locals.db;
  const { cartItemId } = req.params;

  try {
    const cartItemReference = await db.get(
      `SELECT so.identity_id, so.server_id
       FROM shop_order_items soi
       JOIN shop_orders so ON so.id = soi.order_id
       WHERE soi.id = ? AND so.status = 'cart'`,
      [cartItemId]
    );
    if (!cartItemReference) return res.status(404).json({ error: 'Cart item not found' });
    const result = await db.transaction(async transactionDb => {
      const authorized = await assertIdentityOwnerForMutation(
        transactionDb, req.user.id, cartItemReference.identity_id, cartItemReference.server_id
      );
      if (!authorized) return { status: 403, error: 'Forbidden' };
      const cartItem = await transactionDb.get(
        `SELECT soi.id, so.identity_id, so.server_id
         FROM shop_order_items soi
         JOIN shop_orders so ON so.id = soi.order_id
         WHERE soi.id = ? AND so.status = 'cart'
           AND so.identity_id = ? AND so.server_id = ?
         FOR UPDATE OF soi, so`,
        [cartItemId, cartItemReference.identity_id, cartItemReference.server_id]
      );
      if (!cartItem) return { status: 409, error: 'Cart item is no longer editable' };
      return updateCartItem(transactionDb, cartItemId, req.body);
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    return res.json({ success: true, data: result.data });
  } catch (err) {
    console.error('PUT /cart/item/:cartItemId', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/** Arm one exact cart line to capture its next configured in-game emote location. */
router.post('/cart/item/:cartItemId/emote-capture', ensurePlayerServerAccess, async (req, res) => {
  const { serverId, identityId } = req.playerServerAccess;
  try {
    const capture = await armEmoteCapture(req.app.locals.db, {
      userId: req.user.id,
      identityId,
      serverId,
      orderItemId: req.params.cartItemId,
    });
    return res.status(201).json({ success: true, data: capture });
  } catch (error) {
    if ([400, 403, 404, 409].includes(error.status)) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('POST /cart/item/:cartItemId/emote-capture', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/** Cancel a pending capture for one exact editable cart line. */
router.delete('/cart/item/:cartItemId/emote-capture', ensurePlayerServerAccess, async (req, res) => {
  const { serverId, identityId } = req.playerServerAccess;
  const orderItemId = Number(req.params.cartItemId);
  if (!Number.isInteger(orderItemId) || orderItemId <= 0) {
    return res.status(400).json({ error: 'Invalid cart item' });
  }
  try {
    const capture = await cancelEmoteCapture(req.app.locals.db, {
      userId: req.user.id,
      identityId: Number(identityId),
      serverId: Number(serverId),
      orderItemId,
    });
    return res.json({ capture });
  } catch (error) {
    const status = Number(error.status) || 500;
    if (status >= 500) console.error('Error cancelling shop emote capture:', error);
    return res.status(status).json({ error: status >= 500 ? 'Failed to cancel emote capture' : error.message });
  }
});

/**
 * DELETE /cart/item/:cartItemId
 * Remove a line item from the player's cart.
 */
router.delete('/cart/item/:cartItemId', async (req, res) => {
  const db = req.app.locals.db;
  const { cartItemId } = req.params;

  try {
    const cartItemReference = await db.get(
      `SELECT so.identity_id, so.server_id
       FROM shop_order_items soi
       JOIN shop_orders so ON so.id = soi.order_id
       WHERE soi.id = ? AND so.status = 'cart'`,
      [cartItemId]
    );
    if (!cartItemReference) return res.status(404).json({ error: 'Cart item not found' });
    const result = await db.transaction(async transactionDb => {
      const authorized = await assertIdentityOwnerForMutation(
        transactionDb, req.user.id, cartItemReference.identity_id, cartItemReference.server_id
      );
      if (!authorized) return { status: 403, error: 'Forbidden' };
      const cartItem = await transactionDb.get(
        `SELECT soi.id, so.identity_id, so.server_id
         FROM shop_order_items soi
         JOIN shop_orders so ON so.id = soi.order_id
         WHERE soi.id = ? AND so.status = 'cart'
           AND so.identity_id = ? AND so.server_id = ?
         FOR UPDATE OF soi, so`,
        [cartItemId, cartItemReference.identity_id, cartItemReference.server_id]
      );
      if (!cartItem) return { status: 409, error: 'Cart item is no longer editable' };
      return deleteCartItem(transactionDb, cartItemId);
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    return res.json({ success: true });
  } catch (err) {
    console.error('DELETE /cart/item/:cartItemId', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /checkout
 * Check out the player's current cart and process it via shopFileService.
 */
router.post('/checkout', ensurePlayerServerAccess, async (req, res) => {
  const db = req.app.locals.db;
  const { identityId, serverId } = req.playerServerAccess;
  const timer = createCheckoutTimer();

  try {
    const idempotencyKey = parseIdempotencyKey(req);
    const checkoutCommand = parseShopCheckoutCommand(req.body);
    const requestFingerprint = fingerprintFinancialRequest({
      operation: 'shop_checkout',
      serverId: Number(serverId),
      identityId: Number(identityId),
      cartId: checkoutCommand.cartId,
      cartFingerprint: checkoutCommand.cartFingerprint,
    });
    const response = await db.transaction(async transactionDb => {
      await shopFileService.acquireShopServerLock(transactionDb, serverId);
      await shopFileService.assertCheckoutAuthority(transactionDb, {
        identity_id: identityId,
        server_id: serverId,
      }, req.user.id);

      const claim = await claimFinancialOperationInTransaction(transactionDb, {
        serverId,
        identityId,
        actorUserId: req.user.id,
        operation: 'shop_checkout',
        idempotencyKey,
        requestFingerprint,
      });
      if (claim.replay) return claim;

      const cart = await transactionDb.get(
        `SELECT * FROM shop_orders
         WHERE id = ? AND identity_id = ? AND server_id = ? AND status = 'cart'
         FOR UPDATE`,
        [checkoutCommand.cartId, identityId, serverId]
      );
      timer.checkpoint('validation');
      if (!cart) {
        const body = { error: 'Cart changed or is no longer available', checkoutState: 'failed' };
        await completeFinancialOperationInTransaction(transactionDb, claim.id, 409, body);
        return { status: 409, body };
      }
      const cartItems = await transactionDb.query(CART_CHECKOUT_ITEMS_SQL, [cart.id]);
      if (buildShopCartFingerprint(cart, cartItems) !== checkoutCommand.cartFingerprint) {
        const body = { error: 'Cart changed; review it before checking out again', checkoutState: 'failed' };
        await completeFinancialOperationInTransaction(transactionDb, claim.id, 409, body);
        return { status: 409, body };
      }

      const result = await shopFileService.processCheckout(
        transactionDb, cart.id, req.user.id, { timer }
      );
      if (!result.success) {
        const body = { error: result.error, checkoutState: 'failed' };
        await completeFinancialOperationInTransaction(transactionDb, claim.id, 409, body);
        return { status: 409, body };
      }

      const body = { success: true, checkoutState: 'success', data: result };
      await completeFinancialOperationInTransaction(transactionDb, claim.id, 200, body);
      return { status: 200, body };
    });

    if (response.replay) res.set('Idempotency-Replayed', 'true');
    timer.finish(response.body.checkoutState === 'success' ? 'success' : 'failed');
    return res.status(response.status).json(response.body);
  } catch (err) {
    if (err.code === 'SHOP_AUTHORIZATION_REVOKED') {
      timer.finish('failed');
      return res.status(403).json({ error: err.message, checkoutState: 'failed' });
    }
    if (err.code === 'SPAWN_EXCLUDED' || err.code === 'SHOP_PLACEMENT_CONFLICT') {
      timer.finish('failed');
      return res.status(409).json({ error: err.message, checkoutState: 'failed' });
    }
    if (err.code === 'SHOP_BUSY') {
      timer.finish('failed');
      return res.status(409).json({ error: err.message, checkoutState: 'processing' });
    }
    if (err.code === 'PROVIDER_RECOVERY_PENDING') {
      timer.finish('recovery');
      return res.status(409).json({ error: err.message, recoveryPending: true, checkoutState: 'recovery' });
    }
    if (err.status === 400 || err.status === 409) {
      timer.finish('failed');
      return res.status(err.status).json({ error: err.message, checkoutState: 'failed' });
    }
    timer.finish('unknown');
    console.error('POST /checkout', err);
    return res.status(503).json({ error: 'Internal server error', checkoutState: 'unknown' });
  }
});

/**
 * GET /orders/:identityId
 * Get completed, refunded, and expired order history for a player identity.
 */
router.get('/orders/:identityId', ensurePlayerServerAccess, async (req, res) => {
  const db = req.app.locals.db;
  const { identityId } = req.params;
  const { serverId } = req.playerServerAccess;

  try {
    const isOwner = await verifyIdentityOwner(db, req.user.id, identityId, serverId);
    if (!isOwner) return res.status(403).json({ error: 'Forbidden' });

    const orders = await db.query(
      `SELECT * FROM shop_orders
       WHERE identity_id = ? AND server_id = ? AND status IN ('completed', 'refunded', 'expired')
       ORDER BY checked_out_at DESC`,
      [identityId, serverId]
    );

    const orderIds = orders.map(order => order.id);
    const orderItems = orderIds.length > 0
      ? await db.query(
        `SELECT soi.*, CASE WHEN soi.snapshot_schema_version = 1 THEN soi.item_name_snapshot ELSE si.name END AS item_name,
                CASE WHEN soi.snapshot_schema_version = 1 THEN soi.image_url_snapshot ELSE si.image_url END AS image_url,
                CASE WHEN soi.snapshot_schema_version = 1 THEN soi.item_type_snapshot ELSE si.item_type END AS item_type,
                CASE WHEN soi.snapshot_schema_version = 1 THEN soi.rental_restarts_snapshot ELSE si.rental_restarts END AS rental_restarts,
                CASE WHEN soi.snapshot_schema_version = 1 THEN soi.event_name_snapshot ELSE si.event_name END AS event_name
         FROM shop_order_items soi
         JOIN shop_items si ON si.id = soi.shop_item_id
         WHERE soi.order_id = ANY($1::bigint[])
         ORDER BY soi.order_id, soi.id`,
        [orderIds]
      )
      : [];
    const paymentAllocations = orderIds.length > 0
      ? await db.query(
        `SELECT order_id, account_type, amount, created_at
         FROM shop_order_payment_allocations
         WHERE order_id = ANY($1::bigint[]) ORDER BY order_id, id`,
        [orderIds]
      )
      : [];
    const consumptionEvents = orderIds.length > 0
      ? await db.query(
        `SELECT srce.order_id, srce.order_item_id, srce.resulting_restarts_remaining,
                srce.consumed_at, srl.detected_at
         FROM shop_rental_consumption_events srce
         JOIN server_restart_log srl ON srl.id = srce.restart_log_id
         WHERE srce.order_id = ANY($1::bigint[]) ORDER BY srce.order_id, srce.consumed_at, srce.id`,
        [orderIds]
      )
      : [];
    const refundDecisions = orderIds.length > 0
      ? await db.query(
        `SELECT srd.order_id, srd.calculated_amount, srd.approved_amount,
                CASE WHEN srd.payment_status = 'deferred'
                  THEN COALESCE(frc.status, 'pending') ELSE 'credited' END AS payment_status,
                CASE WHEN srd.payment_status = 'deferred' AND frc.status = 'claimed'
                  THEN frc.claimed_at ELSE srd.decided_at END AS payment_status_at,
                srd.decided_at
         FROM shop_refund_decisions srd
         LEFT JOIN financial_refund_claims frc ON frc.id = srd.refund_claim_id
         WHERE srd.order_id = ANY($1::bigint[]) ORDER BY srd.order_id, srd.id`,
        [orderIds]
      )
      : [];
    const itemsByOrder = new Map();
    for (const item of orderItems) {
      const key = String(item.order_id);
      if (!itemsByOrder.has(key)) itemsByOrder.set(key, []);
      itemsByOrder.get(key).push(item);
    }
    const allocationsByOrder = new Map();
    const eventsByItem = new Map();
    const refundByOrder = new Map();
    for (const allocation of paymentAllocations) {
      const key = String(allocation.order_id);
      if (!allocationsByOrder.has(key)) allocationsByOrder.set(key, []);
      allocationsByOrder.get(key).push(allocation);
    }
    for (const event of consumptionEvents) {
      const key = String(event.order_item_id);
      if (!eventsByItem.has(key)) eventsByItem.set(key, []);
      eventsByItem.get(key).push(event);
    }
    for (const refund of refundDecisions) refundByOrder.set(String(refund.order_id), refund);
    for (const order of orders) {
      const key = String(order.id);
      order.items = itemsByOrder.get(key) || [];
      order.payment_allocations = allocationsByOrder.get(key) || [];
      const refund = refundByOrder.get(key) || null;
      order.refund_status = refund?.payment_status || null;
      order.refunded_amount = refund?.approved_amount || null;
      order.refunded_at = refund?.payment_status_at || null;
    }

    const allItems = orders.flatMap(order =>
      (order.items || []).map(item => ({ ...item, checked_out_at: order.checked_out_at }))
    );
    const itemsWithFulfillment = await attachShopFulfillmentStatuses(db, serverId, allItems);
    const fulfillmentByItemId = new Map(itemsWithFulfillment.map(item => [String(item.id), item.fulfillment]));
    for (const order of orders) {
      order.items = order.items.map(item => {
        const isRental = item.item_type === 'event_rental';
        const purchasedRestarts = isRental ? Number(item.quantity) : null;
        const remainingRestarts = isRental ? Number(item.restarts_remaining || 0) : null;
        const consumptionEventsForItem = eventsByItem.get(String(item.id)) || [];
        return {
          ...item,
          purchased_restarts: purchasedRestarts,
          consumed_restarts: isRental ? purchasedRestarts - remainingRestarts : null,
          evidence_history_available: !isRental ||
            consumptionEventsForItem.length === purchasedRestarts - remainingRestarts,
          consumption_events: consumptionEventsForItem,
          fulfillment: fulfillmentByItemId.get(String(item.id)),
        };
      });
    }

    return res.json({ success: true, data: orders });
  } catch (err) {
    console.error('GET /orders/:identityId', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * GET /servers
 * List all servers that have at least one active shop item.
 * Used to populate the server selector on the player shop page.
 */
router.get('/servers', async (req, res) => {
  const db = req.app.locals.db;
  try {
    const servers = await db.query(
      `SELECT DISTINCT s.id, s.name, g.name AS guild_name
       FROM shop_items si
       JOIN servers s ON s.id = si.server_id
       JOIN guilds g ON g.id = s.guild_id
       WHERE si.is_active = true AND s.status = 'active' AND g.status = 'approved'
         AND si.deleted_at IS NULL
         AND (
           EXISTS (
             SELECT 1 FROM server_role_assignments sra
             WHERE sra.server_id = s.id
               AND sra.guild_id = s.guild_id
               AND sra.user_id = ?
               AND sra.status = 'active'
           )
           OR EXISTS (
             SELECT 1
             FROM server_player_memberships spm
             JOIN linked_accounts la
               ON la.id = spm.source_link_id
              AND la.user_id = spm.user_id
              AND la.identity_id = spm.identity_id
              AND la.verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')
             WHERE spm.server_id = s.id
               AND spm.guild_id = s.guild_id
               AND spm.user_id = ?
               AND spm.status = 'active'
           )
         )
       ORDER BY g.name, s.name`,
      [req.user.id, req.user.id]
    );
    return res.json({ success: true, data: servers });
  } catch (err) {
    console.error('GET /shop/servers', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /balance/:identityId/:serverId
 * Return wallet and bank balance for the given identity on the server's guild.
 */
router.get('/balance/:identityId/:serverId', async (req, res) => {
  const db = req.app.locals.db;
  const { identityId, serverId } = req.params;
  try {
    const isOwner = await verifyIdentityOwner(db, req.user.id, identityId, serverId);
    if (!isOwner) return res.status(403).json({ error: 'Forbidden' });

    const balances = await db.get(
      `SELECT COALESCE(w.cash_on_hand, c.starting_cash, 0) AS wallet,
              COALESCE(b.balance, c.starting_bank, 0) AS bank
       FROM servers s
       LEFT JOIN guild_economy_config c ON c.server_id = s.id
       LEFT JOIN player_wallets w ON w.server_id = s.id AND w.identity_id = $1
       LEFT JOIN player_bank_accounts b ON b.server_id = s.id AND b.identity_id = $1
       WHERE s.id = $2`,
      [identityId, serverId]
    );
    if (!balances) return res.status(404).json({ error: 'Server not found' });

    return res.json({
      success: true,
      data: {
        wallet: amountForResponse(balances.wallet, 'Wallet balance'),
        bank: amountForResponse(balances.bank, 'Bank balance'),
      },
    });
  } catch (err) {
    console.error('GET /shop/balance', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /active-rentals/:identityId/:serverId
 * Return all currently active event rental line items for a player on a server.
 */
router.get('/active-rentals/:identityId/:serverId', async (req, res) => {
  const db = req.app.locals.db;
  const { identityId, serverId } = req.params;
  try {
    const isOwner = await verifyIdentityOwner(db, req.user.id, identityId, serverId);
    if (!isOwner) return res.status(403).json({ error: 'Forbidden' });

    const rentals = await db.query(
      `SELECT soi.*, CASE WHEN soi.snapshot_schema_version = 1 THEN soi.item_name_snapshot ELSE si.name END AS item_name,
              CASE WHEN soi.snapshot_schema_version = 1 THEN soi.image_url_snapshot ELSE si.image_url END AS image_url,
              CASE WHEN soi.snapshot_schema_version = 1 THEN soi.item_type_snapshot ELSE si.item_type END AS item_type,
              CASE WHEN soi.snapshot_schema_version = 1 THEN soi.rental_restarts_snapshot ELSE si.rental_restarts END AS rental_restarts,
              CASE WHEN soi.snapshot_schema_version = 1 THEN soi.event_name_snapshot ELSE si.event_name END AS event_name,
              so.id AS order_id, so.checked_out_at,
              soi.quantity AS purchased_restarts,
              (soi.quantity - soi.restarts_remaining) AS consumed_restarts,
              (soi.unit_price * soi.quantity) AS paid_amount,
              (soi.unit_price * soi.restarts_remaining) AS calculated_refund,
              (SELECT COUNT(*)::int FROM shop_rental_consumption_events srce
               WHERE srce.order_item_id = soi.id) AS documented_consumption_count,
              (SELECT MAX(srce.consumed_at) FROM shop_rental_consumption_events srce
               WHERE srce.order_item_id = soi.id) AS last_consumed_at
       FROM shop_order_items soi
       JOIN shop_orders so ON so.id = soi.order_id
       JOIN shop_items si ON si.id = soi.shop_item_id
       WHERE so.identity_id = ? AND so.server_id = ?
         AND so.status = 'completed'
         AND soi.is_active = true
         AND soi.restarts_remaining > 0
         AND CASE WHEN soi.snapshot_schema_version = 1 THEN soi.item_type_snapshot ELSE si.item_type END = 'event_rental'
       ORDER BY so.checked_out_at DESC`,
      [identityId, serverId]
    );
    const rentalsWithFulfillment = await attachShopFulfillmentStatuses(db, serverId, rentals);
    return res.json({ success: true, data: rentalsWithFulfillment });
  } catch (err) {
    console.error('GET /shop/active-rentals', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Recalculate and persist the total_price for a cart order based on its line items.
 * @param {object} db
 * @param {number|string} orderId
 */
async function recalculateCartTotal(db, orderId) {
  await db.run(
    `UPDATE shop_orders SET total_price = (
       SELECT COALESCE(SUM(unit_price * quantity), 0)
       FROM shop_order_items
       WHERE order_id = ?
     )
     WHERE id = ?`,
    [orderId, orderId]
  );
}

module.exports = router;
