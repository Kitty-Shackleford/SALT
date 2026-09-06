/**
 * eventWriter – DAL for appending events to the events table.
 *
 * Usage (PostgreSQL adapter or raw pg Pool):
 *
 *   const { appendEvent } = require('./eventWriter');
 *   const result = await appendEvent(pool, {
 *     serverId:  42,
 *     playerId:  7,        // optional – pass null for server-level events
 *     eventType: 'player.killed',
 *     timestamp: new Date(),
 *     payload:   { weapon: 'AK-74', distance: 123.4 }
 *   });
 *   // result → { seq: 1n, uuid: '…' }
 *
 * The `db` parameter accepts either:
 *   - A raw pg Pool / PoolClient (has .query())
 *   - The application's PostgreSQLAdapter (also has .query())
 */

/**
 * Append a single event to the events table.
 *
 * @param {Object} db  - pg Pool, PoolClient, or PostgreSQLAdapter instance
 * @param {Object} opts
 * @param {number}  opts.serverId   - FK → servers(id)
 * @param {number|null} [opts.playerId]  - FK → player_identities(id), nullable
 * @param {string}  opts.eventType  - dot-separated event name, e.g. "player.killed"
 * @param {Date|string} [opts.timestamp] - event wall-clock time (default: NOW())
 * @param {Object}  [opts.payload]  - arbitrary JSON payload (default: {})
 * @returns {Promise<{seq: BigInt, uuid: string}>}
 */
async function appendEvent(db, { serverId, playerId = null, eventType, timestamp, payload = {} }) {
  if (!serverId) throw new Error('appendEvent: serverId is required');
  if (!eventType) throw new Error('appendEvent: eventType is required');

  const ts = timestamp ? new Date(timestamp) : new Date();
  const payloadJson = typeof payload === 'string' ? payload : JSON.stringify(payload);

  const sql = `
    INSERT INTO events (server_id, player_id, event_type, timestamp, payload)
    VALUES ($1, $2, $3, $4, $5::jsonb)
    RETURNING seq, uuid
  `;
  const params = [serverId, playerId, eventType, ts, payloadJson];

  // Support both raw pg Pool/Client (.query returns {rows}) and the
  // PostgreSQLAdapter wrapper (.query returns rows array directly).
  let rows;
  const result = await db.query(sql, params);
  if (Array.isArray(result)) {
    rows = result;
  } else if (result && Array.isArray(result.rows)) {
    rows = result.rows;
  } else {
    throw new Error('appendEvent: unexpected result shape from db.query');
  }

  if (!rows || rows.length === 0) {
    throw new Error('appendEvent: INSERT returned no rows');
  }

  return { seq: BigInt(rows[0].seq), uuid: rows[0].uuid };
}

module.exports = { appendEvent };
