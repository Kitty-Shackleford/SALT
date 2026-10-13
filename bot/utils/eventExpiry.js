'use strict';

/**
 * eventExpiry.js
 *
 * A lightweight 60-second interval that closes expired sign-up events and
 * queues teleports for their still-joined sign-ups. Started from bot/index.js
 * after the bot is ready, next to the server health monitor.
 *
 * Designed to be testable without booting the bot:
 *   - start()/stop() manage the interval;
 *   - the interval is unref()'d so it never keeps the event loop alive;
 *   - processExpiredEvents() is the pure unit of work and is exported so tests
 *     can drive it directly with an injected db.
 */

const dbAdapter = require('./dashboardDbAdapter');
const { closeEventAndQueueTeleports } = require('../../services/teleportEventService');

const INTERVAL_MS = 60 * 1000;

let timer = null;

/**
 * Find and close every event that has expired. Returns a summary so the
 * caller (or tests) can assert on what happened.
 */
async function processExpiredEvents(db) {
  const db_ = db || dbAdapter;
  const expired = await db_.query(
    `SELECT id, guild_id, server_id, event_name, created_by_user_id, status
     FROM event_teleport_signups
     WHERE status = 'active' AND expires_at <= NOW()
     ORDER BY id`
  );
  const results = [];
  for (const event of expired) {
    const actorUserId = event.created_by_user_id != null ? Number(event.created_by_user_id) : null;
    // The actor is the user who created the event; if none is recorded (a bot
    // process) we fall back to a synthetic actor id so the queue path still has
    // an identity. We only ever process rows we created, so this is safe.
    const result = await db_.transaction(async transactionDb => {
      try {
        return await closeEventAndQueueTeleports(transactionDb, {
          serverId: event.server_id,
          guildId: event.guild_id,
          eventId: event.id,
          actorUserId: actorUserId || 1,
          finalStatus: 'expired',
        });
      } catch (error) {
        // If the server went inactive mid-close, still mark the event expired
        // so we don't retry forever. The queue failure is reported to the log.
        await transactionDb.query(
          `UPDATE event_teleport_signups
           SET status = 'expired'
           WHERE id = ? AND status = 'active'`,
          [event.id]
        ).catch(() => {});
        return {
          event: { id: event.id }, queued: 0, failed: 0, identities: [],
          error: error.code || error.message,
        };
      }
    });
    results.push({ id: event.id, ...result });
  }
  return { expired: expired.length, results };
}

function start(options = {}) {
  if (timer) return;
  const tick = async () => {
    try {
      const summary = await processExpiredEvents(options.db || undefined);
      if (summary && summary.expired > 0) {
        console.log(`⏰ Event expiry monitor: closed ${summary.expired} expired event(s)`);
      }
    } catch (error) {
      console.error('Event expiry monitor tick failed:', error && error.message || error);
    }
  };
  timer = setInterval(tick, options.intervalMs || INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`⏰ Teleport event expiry monitor started (interval: ${(options.intervalMs || INTERVAL_MS) / 1000}s)`);
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function isRunning() {
  return timer !== null;
}

function startEventExpiryMonitor(options = {}) {
  return start(options);
}

function stopEventExpiryMonitor() {
  return stop();
}

module.exports = {
  INTERVAL_MS,
  start,
  stop,
  startEventExpiryMonitor,
  stopEventExpiryMonitor,
  isRunning,
  processExpiredEvents,
};
