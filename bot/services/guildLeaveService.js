'use strict';

/**
 * Guild-leave outbox consumer.
 *
 * When an admin removes a guild from the dashboard, the backend enqueues one
 * pending row in discord_guild_leave_jobs (migration 109) inside the same
 * transaction that deactivates the guild. This service — running in the bot
 * container, which owns the Discord client — polls due jobs, claims them
 * with a lock, and makes the bot leave the Discord guild.
 *
 * Idempotency: a guild that is already gone (deleted, or the bot is not a
 * member) completes the job with a note instead of erroring.
 * Transient failures back off exponentially (capped at an hour) and keep the
 * last error on the row.
 */

const pool = require('../db');

const POLL_INTERVAL_MS = 30 * 1000;
const MAX_BACKOFF_SECONDS = 3600;
const STALE_LOCK_SECONDS = 300;

async function claimGuildLeaveJob(db) {
  const result = await db.query(
    `UPDATE discord_guild_leave_jobs
       SET status = 'processing', locked_at = NOW(), updated_at = NOW()
     WHERE id = (
       SELECT id FROM discord_guild_leave_jobs
        WHERE (status = 'pending' AND next_attempt_at <= NOW())
           OR (status = 'processing' AND locked_at < NOW() - ${STALE_LOCK_SECONDS} * INTERVAL '1 second')
        ORDER BY next_attempt_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     RETURNING *`,
    []
  );
  return result.rows[0] || null;
}

async function markGuildLeaveCompleted(db, job, note = null) {
  // NOTE: bot/db.js is a raw pg Pool — $n placeholders only, never `?`.
  await db.query(
    `UPDATE discord_guild_leave_jobs
        SET status = 'completed', completed_at = NOW(), locked_at = NULL,
            last_error = $1, updated_at = NOW()
      WHERE id = $2`,
    [note, job.id]
  );
}

async function markGuildLeaveRetry(db, job, error) {
  const message = String((error && error.message) || error).slice(0, 2000);
  // NOTE: bot/db.js is a raw pg Pool — $n placeholders only, never `?`.
  await db.query(
    `UPDATE discord_guild_leave_jobs
        SET status = 'pending', attempts = attempts + 1,
            next_attempt_at = NOW() + LEAST(${MAX_BACKOFF_SECONDS}, POWER(2, attempts + 1)) * INTERVAL '1 second',
            last_error = $1, locked_at = NULL, updated_at = NOW()
      WHERE id = $2`,
    [message, job.id]
  );
}

/**
 * Discord REST 10006 (Unknown Guild) / HTTP 404 on guild fetch means the
 * guild was deleted or the bot is not a member — the leave goal is already
 * satisfied.
 */
function isGuildGoneError(error) {
  if (!error) return false;
  return error.code === 10006
    || error.httpstatus === 404
    || error.httpStatus === 404
    || error.status === 404;
}

async function processGuildLeaveJob(client, db, job) {
  let guild;
  try {
    guild = await client.guilds.fetch(String(job.discord_guild_id));
  } catch (error) {
    if (isGuildGoneError(error)) {
      await markGuildLeaveCompleted(db, job, 'guild not found (deleted or bot not a member)');
      console.log(`✅ [GUILD-LEAVE] guild ${job.discord_guild_id} already gone; job ${job.id} completed`);
      return { id: job.id, status: 'completed', note: 'guild-gone' };
    }
    throw error;
  }

  // A guild whose owner is the bot cannot be left via API (Discord 40034);
  // the retry backoff keeps the job visible until that is resolved.
  await guild.leave();

  await markGuildLeaveCompleted(db, job);
  console.log(`✅ [GUILD-LEAVE] bot left guild ${job.discord_guild_id} (job ${job.id}, attempts ${job.attempts})`);
  return { id: job.id, status: 'completed' };
}

async function runGuildLeavePass(client, db, limit = 25) {
  const results = [];
  for (let index = 0; index < limit; index++) {
    const job = await claimGuildLeaveJob(db);
    if (!job) break;
    try {
      results.push(await processGuildLeaveJob(client, db, job));
    } catch (error) {
      await markGuildLeaveRetry(db, job, error);
      console.error(`❌ [GUILD-LEAVE] job ${job.id} for guild ${job.discord_guild_id} failed: ${(error && error.message) || error}; backing off (attempts will be ${job.attempts + 1})`);
      results.push({ id: job.id, status: 'pending', error: (error && error.message) || String(error) });
    }
  }
  return results;
}

/**
 * Start the periodic guild-leave loop. Runs an immediate pass, then every
 * intervalMs; failures are logged and swallowed so the loop survives.
 * Returns the (unref'd) timer.
 */
function startGuildLeaveLoop(client, db = pool, intervalMs = POLL_INTERVAL_MS) {
  const run = () => runGuildLeavePass(client, db).catch(error => {
    console.error('❌ [GUILD-LEAVE] pass failed:', (error && error.message) || error);
  });
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return timer;
}

module.exports = {
  claimGuildLeaveJob,
  processGuildLeaveJob,
  runGuildLeavePass,
  startGuildLeaveLoop,
  isGuildGoneError,
  POLL_INTERVAL_MS,
  STALE_LOCK_SECONDS,
};
