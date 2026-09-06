const { randomUUID } = require('crypto');

const DEFAULT_LEASE_SECONDS = 120;

/**
 * Queue kill events for Discord feed posting
 */

/**
 * Add a kill event to the queue
 */
async function queueKillEvent(db, guildId, serverId, feedType, eventType, eventData) {
  try {
    const feedConfig = await db.get(
      `SELECT id FROM discord_feeds
       WHERE guild_id = ? AND server_id = ? AND feed_type = ? AND enabled = 1`,
      [guildId, serverId, feedType]
    );

    if (!feedConfig) {
      console.log(`⏭️ [${eventType}] No enabled ${feedType} for guild ${guildId}; event not queued`);
      return false;
    }

    const eventDataJson = JSON.stringify(eventData);
    await db.run(
      `INSERT INTO feed_events (guild_id, server_id, feed_type, event_type, event_data, processed)
       VALUES (?, ?, ?, ?, ?, 0)`,
      [guildId, serverId, feedType, eventType, eventDataJson]
    );

    console.log(`✅ Queued ${eventType} event for guild ${guildId}`);
    return true;
  } catch (error) {
    console.error(`❌ Error queueing kill event:`, error.message);
    throw error;
  }
}

/**
 * Get pending events for a guild
 */
async function getPendingEvents(db, guildId, serverId, limit = 100, feedTypes = null) {
  if (Array.isArray(feedTypes) && feedTypes.length === 0) return [];

  const selectedFeedTypes = Array.isArray(feedTypes)
    ? [...new Set(feedTypes.map(type => String(type)))]
    : null;
  const feedTypeClause = selectedFeedTypes
    ? ` AND feed_type IN (${selectedFeedTypes.map(() => '?').join(', ')})`
    : '';

  return db.query(
    `SELECT * FROM feed_events
     WHERE guild_id = ? AND server_id = ? AND processed = 0${feedTypeClause}
     ORDER BY created_at ASC
     LIMIT ?`,
    [guildId, serverId, ...(selectedFeedTypes || []), limit]
  );
}

async function claimPendingEvents(
  db,
  guildId,
  serverId,
  limit = 100,
  feedTypes = null,
  leaseSeconds = DEFAULT_LEASE_SECONDS
) {
  if (Array.isArray(feedTypes) && feedTypes.length === 0) return [];
  const selectedFeedTypes = Array.isArray(feedTypes)
    ? [...new Set(feedTypes.map(type => String(type)))]
    : null;
  const feedTypeClause = selectedFeedTypes
    ? ` AND feed_type IN (${selectedFeedTypes.map(() => '?').join(', ')})`
    : '';
  const claimToken = randomUUID();

  return db.query(
    `WITH candidates AS (
       SELECT * FROM feed_events
       WHERE guild_id = ? AND server_id = ?${feedTypeClause}
         AND (
           (processed = 0 AND next_attempt_at <= CURRENT_TIMESTAMP)
           OR (processed = 3 AND lease_expires_at <= CURRENT_TIMESTAMP)
         )
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT ?
     )
     UPDATE feed_events AS event
     SET processed = 3,
         claim_token = ?,
         claimed_at = CURRENT_TIMESTAMP,
         lease_expires_at = CURRENT_TIMESTAMP + (? * INTERVAL '1 second')
     FROM candidates
     WHERE event.id = candidates.id
     RETURNING event.*`,
    [
      guildId,
      serverId,
      ...(selectedFeedTypes || []),
      Math.max(1, Math.min(Number(limit) || 100, 100)),
      claimToken,
      Math.max(30, Math.min(Number(leaseSeconds) || DEFAULT_LEASE_SECONDS, 600)),
    ]
  );
}

async function suppressDisabledFeedEvents(db, guildId, serverId, enabledFeedTypes) {
  const selectedFeedTypes = [...new Set((enabledFeedTypes || []).map(type => String(type)))];
  const enabledClause = selectedFeedTypes.length
    ? ` AND feed_type NOT IN (${selectedFeedTypes.map(() => '?').join(', ')})`
    : '';
  await db.run(
    `UPDATE feed_events
     SET processed = 2, processed_at = CURRENT_TIMESTAMP,
         last_error = 'feed disabled', claim_token = NULL,
         claimed_at = NULL, lease_expires_at = NULL
     WHERE guild_id = ? AND server_id = ?
       AND (
         processed = 0
         OR (processed = 3 AND lease_expires_at <= CURRENT_TIMESTAMP)
       )${enabledClause}`,
    [guildId, serverId, ...selectedFeedTypes]
  );
}

/**
 * Mark event as processed
 */
async function markEventProcessed(db, eventId, success = true, claimToken = null) {
  const claimClause = claimToken ? ' AND claim_token = ?' : '';
  await db.run(
    `UPDATE feed_events
     SET processed = ?, processed_at = CURRENT_TIMESTAMP,
         claim_token = NULL, claimed_at = NULL, lease_expires_at = NULL
     WHERE id = ?${claimClause}`,
    [success ? 1 : 2, eventId, ...(claimToken ? [claimToken] : [])]
  );
}

async function markEventFailed(db, eventId, claimToken, error, maxAttempts = 5) {
  const safeError = String(error?.message || error || 'Discord delivery failed').slice(0, 500);
  await db.run(
    `UPDATE feed_events
     SET attempt_count = attempt_count + 1,
         processed = CASE WHEN attempt_count + 1 >= ? THEN 2 ELSE 0 END,
         processed_at = CASE WHEN attempt_count + 1 >= ? THEN CURRENT_TIMESTAMP ELSE NULL END,
         next_attempt_at = CURRENT_TIMESTAMP
           + (LEAST(300, 5 * POWER(2, attempt_count)) * INTERVAL '1 second'),
         last_error = ?, claim_token = NULL, claimed_at = NULL, lease_expires_at = NULL
     WHERE id = ? AND processed = 3 AND claim_token = ?`,
    [maxAttempts, maxAttempts, safeError, eventId, claimToken]
  );
}

/**
 * Clean up old processed events (older than 7 days)
 */
async function cleanupOldEvents(db) {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  await db.run(
    `DELETE FROM feed_events WHERE processed > 0 AND processed_at < ?`,
    [cutoff]
  );
  console.log('🧹 Cleaned up old feed events');
}

module.exports = {
  queueKillEvent,
  getPendingEvents,
  claimPendingEvents,
  suppressDisabledFeedEvents,
  markEventProcessed,
  markEventFailed,
  cleanupOldEvents
};
