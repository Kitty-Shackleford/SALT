/**
 * Event Worker – projection-building worker skeleton.
 *
 * Polls the events table for new events since the last processed seq for a
 * named projection, then calls registered handler functions for each event.
 *
 * DISABLED BY DEFAULT.  Set the environment variable:
 *   EVENT_WORKER_ENABLED=true
 * to activate the worker when the server starts.
 *
 * Usage:
 *   const { startWorker, registerHandler } = require('./worker');
 *
 *   registerHandler('my-projection', 'player.killed', async (event) => {
 *     // update a derived table based on event.payload …
 *   });
 *
 *   startWorker(pool);   // call once during app boot
 */

const POLL_INTERVAL_MS = parseInt(process.env.EVENT_WORKER_POLL_MS || '2000', 10);
const BATCH_SIZE = parseInt(process.env.EVENT_WORKER_BATCH || '100', 10);

/** @type {Map<string, Map<string, Function[]>>} projectionName → eventType → handlers */
const handlers = new Map();

/**
 * Register a handler for a specific (projection, eventType) pair.
 *
 * @param {string}   projectionName - unique name for the projection
 * @param {string}   eventType      - matches events.event_type
 * @param {Function} handler        - async (event) => void
 */
function registerHandler(projectionName, eventType, handler) {
  if (!handlers.has(projectionName)) {
    handlers.set(projectionName, new Map());
  }
  const byType = handlers.get(projectionName);
  if (!byType.has(eventType)) {
    byType.set(eventType, []);
  }
  byType.get(eventType).push(handler);
}

/**
 * Fetch and upsert the last_seq checkpoint for a projection.
 *
 * @param {import('pg').Pool} pool
 * @param {string} projectionName
 * @returns {Promise<bigint>}
 */
async function getCheckpoint(pool, projectionName) {
  await pool.query(`
    INSERT INTO projection_checkpoints (projection_name, last_seq)
    VALUES ($1, 0)
    ON CONFLICT (projection_name) DO NOTHING
  `, [projectionName]);

  const { rows } = await pool.query(
    'SELECT last_seq FROM projection_checkpoints WHERE projection_name = $1',
    [projectionName]
  );
  return BigInt(rows[0].last_seq ?? 0);
}

/**
 * Persist the new checkpoint after successfully processing a batch.
 *
 * @param {import('pg').Pool} pool
 * @param {string} projectionName
 * @param {bigint} lastSeq
 */
async function saveCheckpoint(pool, projectionName, lastSeq) {
  await pool.query(`
    UPDATE projection_checkpoints
    SET last_seq = $1, updated_at = NOW()
    WHERE projection_name = $2
  `, [lastSeq.toString(), projectionName]);
}

/**
 * Process one polling tick for a single projection.
 *
 * @param {import('pg').Pool} pool
 * @param {string} projectionName
 * @param {Map<string, Function[]>} byType
 */
async function processTick(pool, projectionName, byType) {
  const fromSeq = await getCheckpoint(pool, projectionName);

  const { rows: events } = await pool.query(`
    SELECT seq, uuid, server_id, player_id, event_type, timestamp, payload
    FROM events
    WHERE seq > $1
      AND deleted_at IS NULL
    ORDER BY seq ASC
    LIMIT $2
  `, [fromSeq.toString(), BATCH_SIZE]);

  if (events.length === 0) return;

  let highSeq = fromSeq;
  for (const event of events) {
    const seq = BigInt(event.seq);
    const eventHandlers = byType.get(event.event_type) || [];
    for (const fn of eventHandlers) {
      try {
        await fn(event);
      } catch (err) {
        console.error(
          `[event-worker] handler error for projection="${projectionName}" event_type="${event.event_type}" seq=${seq}:`,
          err.message
        );
      }
    }
    if (seq > highSeq) highSeq = seq;
  }

  await saveCheckpoint(pool, projectionName, highSeq);
}

let _workerTimer = null;

/**
 * Start the event worker polling loop.
 *
 * Only activates when the environment variable EVENT_WORKER_ENABLED=true.
 * Safe to call multiple times – subsequent calls are no-ops.
 *
 * @param {import('pg').Pool} pool - pg connection pool
 */
function startWorker(pool) {
  if (process.env.EVENT_WORKER_ENABLED !== 'true') {
    return; // Disabled by default.
  }

  if (_workerTimer) {
    return; // Already running.
  }

  if (handlers.size === 0) {
    console.log('[event-worker] No handlers registered; worker not started.');
    return;
  }

  console.log(`[event-worker] Starting with ${handlers.size} projection(s), poll interval ${POLL_INTERVAL_MS}ms`);

  async function tick() {
    for (const [projectionName, byType] of handlers) {
      try {
        await processTick(pool, projectionName, byType);
      } catch (err) {
        console.error(`[event-worker] tick error for projection="${projectionName}":`, err.message);
      }
    }
    _workerTimer = setTimeout(tick, POLL_INTERVAL_MS);
  }

  _workerTimer = setTimeout(tick, POLL_INTERVAL_MS);
}

/**
 * Stop the worker polling loop (useful in tests).
 */
function stopWorker() {
  if (_workerTimer) {
    clearTimeout(_workerTimer);
    _workerTimer = null;
  }
}

module.exports = { startWorker, stopWorker, registerHandler };
