'use strict';

const { CHALLENGE_EMOTES } = require('./playerLinkChallengeService');

const EMOTE_CAPTURE_TTL_MINUTES = 30;
const EMOTE_CAPTURE_EMOTES = Object.freeze([...CHALLENGE_EMOTES]);
const EMOTE_CAPTURE_EMOTE_SET = new Set(EMOTE_CAPTURE_EMOTES);
const HELD_ITEM_PATTERN = /^[A-Za-z0-9_]{1,80}$/;

function normalizeEmoteCaptureConfig(value) {
  if (value == null) {
    return { enabled: false, emoteType: null, heldItem: null };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Emote capture configuration must be an object');
  }
  const allowedFields = new Set(['enabled', 'emoteType', 'heldItem']);
  const unsupportedField = Object.keys(value).find(field => !allowedFields.has(field));
  if (unsupportedField) {
    throw new TypeError(`Emote capture contains unsupported field: ${unsupportedField}`);
  }
  if (value.enabled === false) {
    if (value.emoteType != null || value.heldItem != null) {
      throw new TypeError('Disabled configuration cannot include an emote or held item');
    }
    return { enabled: false, emoteType: null, heldItem: null };
  }
  if (value.enabled !== true || !EMOTE_CAPTURE_EMOTE_SET.has(value.emoteType)) {
    throw new TypeError('Emote capture requires a supported emote');
  }
  const heldItem = value.heldItem == null || value.heldItem === ''
    ? null
    : String(value.heldItem).trim();
  if (heldItem !== null && !HELD_ITEM_PATTERN.test(heldItem)) {
    throw new TypeError('Emote capture held item must be a valid DayZ class name');
  }
  return { enabled: true, emoteType: value.emoteType, heldItem };
}

function emoteEventToShopCoordinates(event) {
  const coordinates = {
    pos_x: Number(event.pos_x),
    pos_y: Number(event.pos_z),
    pos_z: Number(event.pos_y),
  };
  if (Object.values(coordinates).some(value => !Number.isFinite(value))) {
    throw new TypeError('Emote event coordinates must be finite numbers');
  }
  return coordinates;
}

function captureError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function lockActiveCaptureServer(db, serverId) {
  const scope = await db.get('SELECT guild_id FROM servers WHERE id = ?', [serverId]);
  if (!scope) return null;
  const guild = await db.get(
    "SELECT id FROM guilds WHERE id = ? AND status = 'approved' FOR UPDATE",
    [scope.guild_id]
  );
  if (!guild) return null;
  return db.get(
    "SELECT id FROM servers WHERE id = ? AND guild_id = ? AND status = 'active' FOR NO KEY UPDATE",
    [serverId, scope.guild_id]
  );
}

async function armEmoteCaptureInTransaction(db, {
  userId, identityId, serverId, orderItemId,
}) {
  const server = await lockActiveCaptureServer(db, serverId);
  if (!server) throw captureError('Server is unavailable', 404);

  const proof = await db.get(
    `SELECT id FROM linked_accounts
     WHERE user_id = ? AND identity_id = ?
       AND verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')
     FOR UPDATE`,
    [userId, identityId]
  );
  if (!proof) throw captureError('Emote capture requires an active linked player identity', 403);
  const membership = await db.get(
    `SELECT id FROM server_player_memberships
     WHERE source_link_id = ? AND user_id = ? AND identity_id = ?
       AND server_id = ? AND status = 'active'
     FOR UPDATE`,
    [proof.id, userId, identityId, server.id]
  );
  if (!membership) throw captureError('Emote capture requires active access to this server', 403);

  const cartItem = await db.get(
    `SELECT soi.id, soi.order_id, so.identity_id, so.server_id,
            soi.emote_capture_config_snapshot AS emote_capture_config
     FROM shop_order_items soi
     JOIN shop_orders so ON so.id = soi.order_id
     WHERE soi.id = ? AND so.identity_id = ? AND so.server_id = ? AND so.status = 'cart'
     FOR UPDATE OF so, soi`,
    [orderItemId, identityId, server.id]
  );
  if (!cartItem) throw captureError('Cart item is no longer editable', 409);
  const config = normalizeEmoteCaptureConfig(cartItem.emote_capture_config);
  if (!config.enabled) throw captureError('Emote location capture is not enabled for this item', 409);

  const highWater = await db.get(
    'SELECT COALESCE(MAX(id), 0) AS high_water_id FROM player_emote_events WHERE server_id = ?',
    [server.id]
  );
  await db.run(
    `UPDATE shop_emote_capture_requests
     SET status = 'cancelled', rejection_reason = 'replaced', cancelled_at = clock_timestamp()
     WHERE server_id = ? AND identity_id = ? AND status = 'pending'`,
    [server.id, identityId]
  );
  const rows = await db.query(
    `INSERT INTO shop_emote_capture_requests (
       server_id, identity_id, membership_id, order_id, order_item_id, requested_by_user_id,
       expected_emote_type, expected_item_name, event_high_water_id,
       requested_at, expires_at, status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, clock_timestamp(),
               clock_timestamp() + (? * INTERVAL '1 minute'), 'pending')
     RETURNING id, status, expected_emote_type, expected_item_name, requested_at, expires_at`,
    [
      server.id, identityId, membership.id, cartItem.order_id, cartItem.id, userId,
      config.emoteType, config.heldItem, Number(highWater?.high_water_id) || 0,
      EMOTE_CAPTURE_TTL_MINUTES,
    ]
  );
  return rows[0];
}

async function armEmoteCapture(db, args) {
  return db.transaction(transactionDb => armEmoteCaptureInTransaction(transactionDb, args));
}

async function cancelEmoteCaptureInTransaction(db, {
  userId, identityId, serverId, orderItemId,
}) {
  const server = await lockActiveCaptureServer(db, serverId);
  if (!server) throw captureError('Server is unavailable', 404);

  const proof = await db.get(
    `SELECT id FROM linked_accounts
     WHERE user_id = ? AND identity_id = ?
       AND verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')
     FOR UPDATE`,
    [userId, identityId]
  );
  if (!proof) throw captureError('Emote capture requires an active linked player identity', 403);
  const membership = await db.get(
    `SELECT id FROM server_player_memberships
     WHERE source_link_id = ? AND user_id = ? AND identity_id = ?
       AND server_id = ? AND status = 'active'
     FOR UPDATE`,
    [proof.id, userId, identityId, server.id]
  );
  if (!membership) throw captureError('Emote capture requires active access to this server', 403);

  const cartItem = await db.get(
    `SELECT soi.id, soi.order_id
     FROM shop_order_items soi
     JOIN shop_orders so ON so.id = soi.order_id
     WHERE soi.id = ? AND so.identity_id = ? AND so.server_id = ? AND so.status = 'cart'
     FOR UPDATE OF so, soi`,
    [orderItemId, identityId, server.id]
  );
  if (!cartItem) throw captureError('Cart item is no longer editable', 409);

  const result = await db.run(
    `UPDATE shop_emote_capture_requests
     SET status = 'cancelled', rejection_reason = 'cancelled_by_user',
         cancelled_at = clock_timestamp()
     WHERE server_id = ? AND identity_id = ? AND order_item_id = ? AND status = 'pending'`,
    [server.id, identityId, cartItem.id]
  );
  return { status: 'cancelled', changed: Number(result?.changes) || 0 };
}

async function cancelEmoteCapture(db, args) {
  return db.transaction(transactionDb => cancelEmoteCaptureInTransaction(transactionDb, args));
}

async function applyEmoteEventToCaptureInTransaction(db, eventId) {
  const eventReference = await db.get(
    'SELECT server_id FROM player_emote_events WHERE id = ?',
    [eventId]
  );
  if (!eventReference) return { status: 'ignored', reason: 'event_not_found' };

  const server = await lockActiveCaptureServer(db, eventReference.server_id);
  if (!server) return { status: 'ignored', reason: 'server_unavailable' };

  const event = await db.get(
    `SELECT id, server_id, identity_id, emote_type, item_name,
            pos_x, pos_y, pos_z, timestamp, source_file, source_line
     FROM player_emote_events
     WHERE id = ? AND server_id = ?
     FOR UPDATE`,
    [eventId, server.id]
  );
  if (!event) return { status: 'ignored', reason: 'event_scope_changed' };

  const candidate = await db.get(
    `SELECT * FROM shop_emote_capture_requests
     WHERE server_id = ? AND identity_id = ? AND status = 'pending'
       AND expires_at > clock_timestamp()
     ORDER BY requested_at DESC, id DESC
     LIMIT 1`,
    [event.server_id, event.identity_id]
  );
  if (!candidate) return { status: 'ignored', reason: 'no_pending_capture' };

  const candidateMatches = Number(event.id) > Number(candidate.event_high_water_id)
    && event.emote_type === candidate.expected_emote_type
    && (!candidate.expected_item_name
      || String(event.item_name || '').toLowerCase() === String(candidate.expected_item_name).toLowerCase());
  if (!candidateMatches) return { status: 'ignored', reason: 'event_does_not_match' };

  const proof = await db.get(
    `SELECT id FROM linked_accounts
     WHERE user_id = ? AND identity_id = ?
       AND verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')
     FOR UPDATE`,
    [candidate.requested_by_user_id, candidate.identity_id]
  );
  if (!proof) return { status: 'ignored', reason: 'authorization_revoked' };
  const membership = await db.get(
    `SELECT id FROM server_player_memberships
     WHERE source_link_id = ? AND user_id = ? AND identity_id = ?
       AND server_id = ? AND status = 'active'
     FOR UPDATE`,
    [proof.id, candidate.requested_by_user_id, candidate.identity_id, candidate.server_id]
  );
  if (!membership) return { status: 'ignored', reason: 'authorization_revoked' };

  const cartItem = await db.get(
    `SELECT soi.id, soi.order_id, soi.pos_x, soi.pos_y, soi.pos_z,
            so.identity_id, so.server_id
     FROM shop_order_items soi
     JOIN shop_orders so ON so.id = soi.order_id
     WHERE soi.id = ? AND soi.order_id = ?
       AND so.identity_id = ? AND so.server_id = ? AND so.status = 'cart'
     FOR UPDATE OF so, soi`,
    [candidate.order_item_id, candidate.order_id, candidate.identity_id, candidate.server_id]
  );
  if (!cartItem) return { status: 'ignored', reason: 'cart_not_editable' };

  const request = await db.get(
    `SELECT * FROM shop_emote_capture_requests
     WHERE id = ? AND server_id = ? AND identity_id = ? AND order_item_id = ? AND status = 'pending'
       AND expires_at > clock_timestamp()
     FOR UPDATE`,
    [candidate.id, candidate.server_id, candidate.identity_id, candidate.order_item_id]
  );
  if (!request) return { status: 'ignored', reason: 'capture_no_longer_pending' };
  const matches = Number(event.id) > Number(request.event_high_water_id)
    && event.emote_type === request.expected_emote_type
    && (!request.expected_item_name
      || String(event.item_name || '').toLowerCase() === String(request.expected_item_name).toLowerCase());
  if (!matches) return { status: 'ignored', reason: 'capture_changed' };

  const coordinates = emoteEventToShopCoordinates(event);
  await db.run(
    `UPDATE shop_order_items
     SET pos_x = ?, pos_y = ?, pos_z = ?
     WHERE id = ? AND order_id = ?`,
    [coordinates.pos_x, coordinates.pos_y, coordinates.pos_z, cartItem.id, cartItem.order_id]
  );
  await db.run(
    `UPDATE shop_emote_capture_requests
     SET status = 'applied', emote_event_id = ?, event_timestamp = ?,
         raw_pos_x = ?, raw_pos_y = ?, raw_pos_z = ?,
         applied_pos_x = ?, applied_pos_y = ?, applied_pos_z = ?,
         previous_pos_x = ?, previous_pos_y = ?, previous_pos_z = ?,
         source_file = ?, source_line = ?, applied_at = clock_timestamp()
     WHERE id = ? AND status = 'pending' AND emote_event_id IS NULL`,
    [
      event.id, event.timestamp,
      event.pos_x, event.pos_y, event.pos_z,
      coordinates.pos_x, coordinates.pos_y, coordinates.pos_z,
      cartItem.pos_x, cartItem.pos_y, cartItem.pos_z,
      event.source_file, event.source_line, request.id,
    ]
  );
  return { status: 'applied', requestId: request.id, coordinates };
}

async function applyEmoteEventToCapture(db, eventId) {
  return db.transaction(transactionDb =>
    applyEmoteEventToCaptureInTransaction(transactionDb, eventId));
}

module.exports = {
  EMOTE_CAPTURE_TTL_MINUTES,
  EMOTE_CAPTURE_EMOTES,
  normalizeEmoteCaptureConfig,
  emoteEventToShopCoordinates,
  lockActiveCaptureServer,
  armEmoteCaptureInTransaction,
  armEmoteCapture,
  cancelEmoteCaptureInTransaction,
  cancelEmoteCapture,
  applyEmoteEventToCaptureInTransaction,
  applyEmoteEventToCapture,
};
