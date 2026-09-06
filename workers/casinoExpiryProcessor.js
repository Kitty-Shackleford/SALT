'use strict';

const moneySupplyManager = require('../utils/moneySupplyManager');

const DEFAULT_BATCH_SIZE = 50;

function normalizeBatchSize(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_BATCH_SIZE;
  return Math.min(parsed, 500);
}

async function findExpiredServer(db) {
  const rows = await db.query(
    `SELECT DISTINCT server_id
     FROM casino_sessions
     WHERE status = 'active' AND expires_at <= CURRENT_TIMESTAMP
     ORDER BY server_id
     LIMIT 1`
  );
  return rows?.[0]?.server_id ?? null;
}

async function processExpiredCasinoSessions(db, options = {}) {
  const batchSize = normalizeBatchSize(options.batchSize);
  let processed = 0;

  while (processed < batchSize) {
    const serverId = await findExpiredServer(db);
    if (serverId == null) break;

    const count = await db.transaction(async transactionDb => {
      const config = await moneySupplyManager.lockSupplyForUpdate(transactionDb, serverId);
      if (!config) throw new Error(`Economy config not found for casino server ${serverId}`);

      const sessions = await transactionDb.query(
        `SELECT session_id, server_id, guild_id, identity_id, game_type, reserved_wager
         FROM casino_sessions
         WHERE server_id = ? AND status = 'active' AND expires_at <= CURRENT_TIMESTAMP
         ORDER BY expires_at, session_id
         FOR UPDATE SKIP LOCKED
         LIMIT ?`,
        [serverId, batchSize - processed]
      );

      for (const session of sessions || []) {
        const reserved = session.reserved_wager;
        if (reserved != null && reserved !== 0 && !/^0(?:\.0+)?$/.test(String(reserved))) {
          const supply = await moneySupplyManager.removeFromSupplyInTransaction(
            transactionDb,
            session.server_id,
            reserved,
            'casino_expiry',
            session.identity_id,
            { gameType: session.game_type, sessionId: session.session_id }
          );
          if (!supply) throw new Error(`Failed to sink escrow for casino session ${session.session_id}`);
        }
        const result = await transactionDb.run(
          `UPDATE casino_sessions
           SET status = 'expired', version = version + 1, updated_at = CURRENT_TIMESTAMP
           WHERE session_id = ? AND status = 'active'`,
          [session.session_id]
        );
        if (result.changes !== 1) {
          throw new Error(`Casino session expiry conflict: ${session.session_id}`);
        }
      }
      return sessions?.length || 0;
    });

    processed += count;
    if (count === 0) break;
  }

  return { processed };
}

function startCasinoExpiryWorker(db, options = {}) {
  const startupDelayMs = options.startupDelayMs ?? 5000;
  const intervalMs = options.intervalMs ?? 60000;
  const batchSize = normalizeBatchSize(options.batchSize);
  const setTimeoutFn = options.setTimeoutFn || setTimeout;
  const setIntervalFn = options.setIntervalFn || setInterval;
  const clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
  const clearIntervalFn = options.clearIntervalFn || clearInterval;
  const logger = options.logger || console;
  let running = false;
  let stopped = false;

  async function run() {
    if (running || stopped) return { processed: 0, skipped: running };
    running = true;
    try {
      const result = await processExpiredCasinoSessions(db, { batchSize });
      if (result.processed > 0) {
        logger.info(`[Casino Expiry] Processed ${result.processed} expired session(s)`);
      }
      return result;
    } catch (error) {
      logger.error('[Casino Expiry] Processing failed:', error);
      return { processed: 0, error };
    } finally {
      running = false;
    }
  }

  const startupTimer = setTimeoutFn(run, startupDelayMs);
  const intervalTimer = setIntervalFn(run, intervalMs);
  startupTimer?.unref?.();
  intervalTimer?.unref?.();

  return {
    run,
    stop() {
      stopped = true;
      clearTimeoutFn(startupTimer);
      clearIntervalFn(intervalTimer);
    }
  };
}

module.exports = { processExpiredCasinoSessions, startCasinoExpiryWorker };
