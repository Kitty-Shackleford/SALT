'use strict';

/**
 * teleportEventService.js
 *
 * Sign-up event teleports (Phase A, 'tp-event'). A moderator creates an event
 * (destination + duration + cap) and Discord users join by button. When the
 * event is closed (moderated early or by expiry), every still-joined
 * sign-up is queued for teleport via the existing requestModeratorTeleport
 * path.
 *
 * Service functions are agnostic to the transport: they receive the
 * dashboardDbAdapter (`transaction(callback)`, `get`, `query`) and operate
 * inside the caller's transaction when one is already active.
 */

const { FINANCIAL_LINK_METHODS } = require('../utils/linkTrust');
const {
  lockModeratorAuthorization,
  lockDestination,
  requestModeratorTeleport,
  teleportError,
} = require('./teleportService');

const EVENT_STATUSES = new Set(['active', 'closed', 'expired']);

function positiveId(value, label) {
  const valid = typeof value === 'number'
    ? Number.isSafeInteger(value) && value > 0
    : typeof value === 'string' && /^[1-9]\d*$/.test(String(value).trim());
  if (!valid) throw new Error(`${label} is required`);
  const id = Number(value);
  if (!Number.isSafeInteger(id)) throw new Error(`${label} is required`);
  return id;
}

function canonicalGuildIdFromDiscord(db, discordGuildId) {
  if (typeof discordGuildId !== 'string' || !discordGuildId) {
    return Promise.resolve(null);
  }
  return db.get('SELECT id FROM guilds WHERE discord_guild_id = ? LIMIT 1',
    [String(discordGuildId)]).then(row => row ? row.id : null);
}

function actorUserIdFromDiscord(db, discordUserId) {
  if (typeof discordUserId !== 'string' || !discordUserId) {
    return Promise.resolve(null);
  }
  return db.get('SELECT id FROM users WHERE discord_id = ?',
    [String(discordUserId)]).then(row => row ? row.id : null);
}

/**
 * Resolve a Discord user's identity on the given server via their active
 * linked-account chain (matches the trust model used by shop/radar/bounty
 * flows: only verified links count, and the membership must be active).
 */
async function resolvePlayerIdentityForUser(db, { serverId, discordUserId }) {
  const methods = [...FINANCIAL_LINK_METHODS];
  const row = await db.get(
    `SELECT spm.identity_id
     FROM server_player_memberships spm
     JOIN linked_accounts la
       ON la.id = spm.source_link_id
      AND la.identity_id = spm.identity_id
      AND la.user_id = spm.user_id
     JOIN users u ON u.id = spm.user_id
     WHERE spm.server_id = ?
       AND u.discord_id = ?
       AND spm.status = 'active'
       AND la.verification_method IN (${methods.map(() => '?').join(', ')})
     ORDER BY spm.id
     LIMIT 1`,
    [serverId, String(discordUserId), ...methods]
  );
  return row ? row.identity_id : null;
}

/**
 * Create a sign-up event row.
 * @returns {object} the inserted event row
 */
async function createSignUpEvent(db, input) {
  const guildId = positiveId(input.guildId, 'Guild ID');
  const serverId = positiveId(input.serverId, 'Server ID');
  const destinationId = positiveId(input.destinationId, 'Destination ID');
  const durationMinutes = positiveId(input.durationMinutes, 'Event duration minutes');
  const cap = input.cap == null ? 25 : positiveId(input.cap, 'Event cap');
  if (cap < 1 || cap > 500) throw new Error('Event cap must be between 1 and 500');
  const eventName = typeof input.eventName === 'string' ? input.eventName.trim() : '';
  if (!eventName || eventName.length > 100) throw new Error('Event name must be 1–100 characters');
  if (typeof input.channelId !== 'string' || !input.channelId) {
    throw new Error('Channel ID is required');
  }
  const actorUserId = input.actorUserId == null ? null : positiveId(input.actorUserId, 'Actor user ID');

  const scope = await lockModeratorAuthorization(db, { serverId, actorUserId });
  if (Number(scope.guildId) !== Number(guildId)) {
    throw teleportError('TELEPORT_UNAUTHORIZED', 'Server does not belong to this guild', 403);
  }
  await lockDestination(db, { serverId, guildId, destinationId, allowPrivate: true });

  const expiresAt = new Date(Date.now() + durationMinutes * 60 * 1000);
  const rows = await db.query(
    `INSERT INTO event_teleport_signups
       (guild_id, server_id, event_name, destination_id, channel_id,
        status, cap, created_by_user_id, expires_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
     RETURNING *`,
    [guildId, serverId, eventName, destinationId, input.channelId, cap, actorUserId, expiresAt]
  );
  return rows[0];
}

async function fetchEventForUpdate(db, { serverId, eventId, guildId }) {
  const params = eventId
    ? `WHERE id = ? AND server_id = ? AND guild_id = ?`
    : `WHERE server_id = ? AND guild_id = ?`;
  const row = await db.get(
    `SELECT * FROM event_teleport_signups ${params} ORDER BY id DESC LIMIT 1 FOR UPDATE`,
    eventId ? [eventId, serverId, guildId] : [serverId, guildId]
  );
  return row || null;
}

async function listActiveEvents(db, { serverId, guildId }) {
  return db.query(
    `SELECT * FROM event_teleport_signups
     WHERE server_id = ? AND guild_id = ? AND status = 'active'
     ORDER BY id`,
    [serverId, guildId]
  );
}

/**
 * Join an identity to an event. Enforces the cap and deduplicates.
 * @returns {{ event, signup, full: boolean }}
 */
async function signUpForEvent(db, input) {
  const eventId = positiveId(input.eventId, 'Event ID');
  const identityId = positiveId(input.identityId, 'Player identity ID');
  const event = await db.get(
    `SELECT * FROM event_teleport_signups
     WHERE id = ? AND server_id = ? AND guild_id = ?
     FOR UPDATE`,
    [eventId, input.serverId, input.guildId]
  );
  if (!event) throw teleportError('EVENT_UNAVAILABLE', 'Teleport event is unavailable', 404);
  if (event.status !== 'active') {
    const error = teleportError('EVENT_CLOSED', `This event is ${event.status}.`, 409);
    error.publicMessage = `The ${event.event_name} event is ${event.status} — no new sign-ups.`;
    throw error;
  }
  if (event.expires_at instanceof Date ? event.expires_at.getTime() < Date.now()
      : new Date(event.expires_at).getTime() < Date.now()) {
    const error = teleportError('EVENT_EXPIRED', 'This event has expired.', 409);
    error.publicMessage = 'This event has expired.';
    throw error;
  }
  const existing = await db.get(
    `SELECT id, status FROM event_signups
     WHERE event_id = ? AND identity_id = ? FOR UPDATE`,
    [eventId, identityId]
  );
  if (existing) {
    if (existing.status === 'joined') {
      const error = teleportError('ALREADY_JOINED', 'You are already signed up.', 409);
      error.publicMessage = 'You are already signed up for this event.';
      throw error;
    }
    // Re-join after leaving.
    const updated = await db.query(
      `UPDATE event_signups
       SET status = 'joined', joined_at = NOW()
       WHERE event_id = ? AND identity_id = ?
       RETURNING *`,
      [eventId, identityId]
    );
    return { event, signup: updated[0], full: false };
  }
  const joinedCount = await db.get(
    `SELECT COUNT(*)::int AS c FROM event_signups
     WHERE event_id = ? AND status = 'joined'`,
    [eventId]
  );
  if (joinedCount.c >= event.cap) {
    const error = teleportError('EVENT_FULL', 'Event full', 409);
    error.publicMessage = `The ${event.event_name} event is full (${event.cap} players).`;
    throw error;
  }
  const rows = await db.query(
    `INSERT INTO event_signups (event_id, identity_id, status)
     VALUES (?, ?, 'joined')
     ON CONFLICT (event_id, identity_id) DO UPDATE
       SET status = 'joined', joined_at = NOW()
     RETURNING *`,
    [eventId, identityId]
  );
  return { event, signup: rows[0], full: false };
}

async function leaveEvent(db, input) {
  const eventId = positiveId(input.eventId, 'Event ID');
  const identityId = positiveId(input.identityId, 'Player identity ID');
  const event = await db.get(
    `SELECT * FROM event_teleport_signups WHERE id = ? AND server_id = ? FOR UPDATE`,
    [eventId, input.serverId]
  );
  if (!event) throw teleportError('EVENT_UNAVAILABLE', 'Teleport event is unavailable', 404);
  const rows = await db.query(
    `UPDATE event_signups
     SET status = 'left'
     WHERE event_id = ? AND identity_id = ? AND status = 'joined'
     RETURNING *`,
    [eventId, identityId]
  );
  if (!rows[0]) {
    const error = teleportError('NOT_JOINED', 'You are not signed up for this event.', 409);
    error.publicMessage = 'You are not signed up for this event.';
    throw error;
  }
  return { event, signup: rows[0] };
}

/**
 * Close an event and queue teleports for every still-joined identity.
 * Used by /tp-event close and by the expiry monitor.
 * @returns {{ event, queued: number, failed: number, identities: object[] }}
 */
async function closeEventAndQueueTeleports(db, input) {
  const serverId = positiveId(input.serverId, 'Server ID');
  const guildId = positiveId(input.guildId, 'Guild ID');
  const actorUserId = positiveId(input.actorUserId, 'Actor user ID');
  const event = await fetchEventForUpdate(db, {
    serverId,
    guildId,
    eventId: input.eventId || null,
  });
  if (!event) throw teleportError('EVENT_UNAVAILABLE', 'Teleport event is unavailable', 404);
  if (event.status !== 'active') {
    const error = teleportError('EVENT_CLOSED', `This event is ${event.status}.`, 409);
    error.publicMessage = `The ${event.event_name} event is already ${event.status}.`;
    throw error;
  }
  const updated = await db.query(
    `UPDATE event_teleport_signups
     SET status = ?
     WHERE id = ? AND server_id = ? AND guild_id = ? AND status = 'active'
     RETURNING *`,
    [input.finalStatus || 'closed', event.id, serverId, guildId]
  );
  const closedEvent = updated[0];
  if (!closedEvent) {
    // Concurrent close — treat as already closed, no-op.
    return { event, queued: 0, failed: 0, identities: [] };
  }
  const joined = await db.query(
    `SELECT identity_id FROM event_signups
     WHERE event_id = ? AND status = 'joined'
     ORDER BY identity_id`,
    [event.id]
  );
  const queued = [];
  const failed = [];
  for (const row of joined) {
    try {
      const request = await requestModeratorTeleport(db, {
        serverId,
        identityId: row.identity_id,
        destinationId: Number(event.destination_id),
        actorUserId,
        source: 'admin',
        reason: `sign-up event: ${event.event_name}`,
      });
      queued.push({ identityId: row.identity_id, requestId: request.id });
    } catch (error) {
      // PRA-restricted players, players without an active membership, and
      // players with an in-flight request are skipped — the event still
      // closes and the summary reports the failures.
      failed.push({ identityId: row.identity_id, reason: error.code || error.message });
    }
  }
  return { event: closedEvent, queued, failed, identities: joined.map(r => r.identity_id) };
}

module.exports = {
  EVENT_STATUSES,
  canonicalGuildIdFromDiscord,
  actorUserIdFromDiscord,
  resolvePlayerIdentityForUser,
  createSignUpEvent,
  fetchEventForUpdate,
  listActiveEvents,
  signUpForEvent,
  leaveEvent,
  closeEventAndQueueTeleports,
};
