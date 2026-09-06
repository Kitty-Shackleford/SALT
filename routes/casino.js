/*
 * DayZ Dashboard — Casino Route
 * Copyright (C) 2026
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License.
 *
 * Handles all casino game API endpoints.
 * Each game endpoint:
 *   1. Verifies the player owns the identityId
 *   2. Checks casino is enabled for the guild
 *   3. Validates the wager is within configured limits
 *   4. Runs server-side game logic (RNG never touches the client)
 *   5. Atomically updates the player wallet and records history
 */

const express = require('express');
const router = express.Router();
const { ensureAuthenticated } = require('../middleware/auth');
const { ensureAdmin } = require('../middleware/auth');
const { getOrCreateWallet } = require('../utils/economy');
const moneySupplyManager = require('../utils/moneySupplyManager');
const { strictLimiter } = require('../middleware/rateLimiter');
const { ensurePlayerServerAccess } = require('../middleware/serverAccess');
const { parseCents, checkedAddCents, centsToAmount, centsToDecimal, multiplyCents, amountForResponse } = require('../utils/money');
const { lockTrustedFinancialIdentity } = require('../utils/linkTrust');
const { insertOrVerifyPendingRefundClaim } = require('../utils/refundClaimManager');
const {
  parseIdempotencyKey,
  fingerprintFinancialRequest,
  claimFinancialOperationInTransaction,
  completeFinancialOperationInTransaction,
} = require('../utils/financialIdempotency');

router.use(ensureAuthenticated, ensurePlayerServerAccess);
// Router middleware runs before route params are populated. Re-authorize named
// identity routes once :identityId exists so same-server identities cannot be
// substituted by the client.
router.param('identityId', (req, res, next) =>
  ensurePlayerServerAccess(req, res, next));
router.use('/play', (req, res, next) => {
  try {
    parseIdempotencyKey(req);
    next();
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the identity and server already authorized by ensurePlayerServerAccess.
 */
async function resolvePlayerContext(db, identityId, serverId) {
  const identity = await db.get(
    `SELECT pi.*, s.id AS server_id
     FROM player_identities pi
     JOIN player_gamertags pg
       ON pg.identity_id = pi.id AND pg.is_current_gamertag = 1
     JOIN servers s ON s.id = pg.server_id AND s.status = 'active'
     JOIN guilds g ON g.id = s.guild_id AND g.status = 'approved'
     WHERE pi.id = ? AND s.id = ?
     LIMIT 1`,
    [identityId, serverId]
  );
  if (!identity) {
    const err = new Error('Identity not found on the authorized server');
    err.status = 404;
    throw err;
  }

  const server = identity.server_id
    ? await db.get('SELECT * FROM servers WHERE id = ?', [identity.server_id])
    : null;
  if (!server) {
    const err = new Error('No active server found for this player');
    err.status = 404;
    throw err;
  }

  return { identity, server };
}

/**
 * Fetch the guild economy/casino config row, or null if not found.
 */
async function getCasinoConfig(db, serverId) {
  return db.get('SELECT * FROM guild_economy_config WHERE server_id = ?', [serverId]);
}

/**
 * Validate and parse a wager amount against the guild casino limits.
 * Returns { wager } on success or { error } on failure.
 */
function parseWager(raw, config) {
  let wagerCents;
  try {
    wagerCents = parseCents(raw, 'Wager');
  } catch (error) {
    return { error: error.message };
  }
  if (wagerCents <= 0) return { error: 'Wager must be a positive number' };
  const minBetCents = parseCents(config.casino_min_bet || 1, 'Minimum bet');
  const maxBetCents = parseCents(config.casino_max_bet || 10000, 'Maximum bet');
  if (wagerCents < minBetCents) return { error: `Minimum bet is ${centsToAmount(minBetCents)}` };
  if (wagerCents > maxBetCents) return { error: `Maximum bet is ${centsToAmount(maxBetCents)}` };
  return { wager: centsToAmount(wagerCents) };
}

function casinoPayout(wager, multiplier) {
  return centsToAmount(multiplyCents(parseCents(wager, 'Casino wager'), multiplier));
}

function casinoSum(...amounts) {
  return centsToAmount(amounts.reduce(
    (total, amount) => total + parseCents(amount, 'Casino amount'), 0));
}

function casinoNet(payout, wager) {
  return centsToAmount(
    parseCents(payout, 'Casino payout') - parseCents(wager, 'Casino wager'));
}

async function createCasinoSession(db, req, gameType, identityId, server, state, ttlMinutes = 5,
  initialStake = 0, { inTransaction = false } = {}) {
  const sessionId = crypto.randomBytes(32).toString('hex');
  const create = async transactionDb => {
    const stakeCents = parseCents(initialStake || 0, 'Casino stake');
    if (!await lockTrustedFinancialIdentity(transactionDb, {
      userId: req.user.id, identityId, serverId: server.id,
    })) throw new Error('Active linked player identity is required');
    await moneySupplyManager.lockSupplyForUpdate(transactionDb, server.id);
    if (stakeCents > 0) {
      await getOrCreateWallet(transactionDb, identityId, server.id);
      const wallet = await transactionDb.get(
        `SELECT cash_on_hand FROM player_wallets
         WHERE identity_id = ? AND server_id = ? FOR UPDATE`,
        [identityId, server.id]
      );
      const balanceCents = parseCents(wallet?.cash_on_hand || 0, 'Wallet balance');
      if (balanceCents < stakeCents) {
        const err = new Error('Insufficient funds'); err.status = 400; throw err;
      }
      const debited = await transactionDb.run(
        `UPDATE player_wallets SET cash_on_hand = ?, last_updated = CURRENT_TIMESTAMP
         WHERE identity_id = ? AND server_id = ?`,
        [centsToDecimal(balanceCents - stakeCents), identityId, server.id]
      );
      if (debited.changes !== 1) throw new Error('Wallet update conflict');
    }
    await transactionDb.run(
      `INSERT INTO casino_sessions
       (session_id, user_id, identity_id, server_id, guild_id, game_type, state,
        reserved_wager, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, CURRENT_TIMESTAMP + (? || ' minutes')::INTERVAL)`,
      [sessionId, req.user.id, identityId, server.id, server.guild_id, gameType,
        JSON.stringify(state), centsToDecimal(stakeCents), ttlMinutes]
    );
    return sessionId;
  };
  if (inTransaction) return create(db);
  return db.transaction(create);
}

function sessionBinding(req, gameType, identityId, server) {
  return {
    sessionId: req.body.sessionId,
    userId: req.user.id,
    identityId: parseInt(identityId),
    serverId: req.playerServerAccess.serverId,
    guildId: server.guild_id,
    gameType
  };
}

function parseSessionState(row) {
  return typeof row.state === 'string' ? JSON.parse(row.state) : row.state;
}

async function isCasinoSessionExpired(db, binding) {
  const row = await db.get(
    `SELECT expires_at <= clock_timestamp() AS is_expired FROM casino_sessions
     WHERE session_id = ? AND user_id = ? AND identity_id = ? AND server_id = ?
       AND guild_id = ? AND game_type = ? AND status = 'active'`,
    [binding.sessionId, binding.userId, binding.identityId, binding.serverId,
      binding.guildId, binding.gameType]
  );
  return row?.is_expired === true;
}

async function lockCasinoSession(db, binding, options = {}) {
  if (!binding.sessionId || !/^[a-f0-9]{64}$/.test(binding.sessionId)) {
    const err = new Error('A valid sessionId is required'); err.status = 400; throw err;
  }
  const row = await db.get(
    `SELECT * FROM casino_sessions
     WHERE session_id = ? AND user_id = ? AND identity_id = ? AND server_id = ?
       AND guild_id = ? AND game_type = ? FOR UPDATE`,
    [binding.sessionId, binding.userId, binding.identityId, binding.serverId,
      binding.guildId, binding.gameType]
  );
  if (!row) { const err = new Error('Casino session not found'); err.status = 404; throw err; }
  if (row.status !== 'active') { const err = new Error('Casino session has already been consumed'); err.status = 409; throw err; }
  if (!options.allowExpired && await isCasinoSessionExpired(db, binding)) {
    const err = new Error('Casino session has expired'); err.status = 410; throw err;
  }
  return { ...row, state: parseSessionState(row) };
}

async function readCasinoSession(db, binding, { inTransaction = false } = {}) {
  const read = async transactionDb => {
    if (await expireCasinoSession(transactionDb, binding, { inTransaction: true })) {
      const err = new Error('Casino session has expired'); err.status = 410; throw err;
    }
    return lockCasinoSession(transactionDb, binding);
  };
  if (inTransaction) return read(db);
  return db.transaction(read);
}

async function expireCasinoSession(db, binding, { inTransaction = false } = {}) {
  const expire = async transactionDb => {
    await moneySupplyManager.lockSupplyForUpdate(transactionDb, binding.serverId);
    const row = await lockCasinoSession(transactionDb, binding, { allowExpired: true });
    if (!await isCasinoSessionExpired(transactionDb, binding)) return false;
    const reservedCents = parseCents(row.reserved_wager || 0, 'Reserved wager');
    if (reservedCents > 0) {
      await moneySupplyManager.removeFromSupplyInTransaction(
        transactionDb, binding.serverId, centsToAmount(reservedCents), 'casino_expiry', binding.identityId,
        { gameType: binding.gameType, sessionId: binding.sessionId }
      );
    }
    const expired = await transactionDb.run(
      `UPDATE casino_sessions SET status = 'expired', version = version + 1,
       updated_at = CURRENT_TIMESTAMP
       WHERE session_id = ? AND status = 'active' AND expires_at <= clock_timestamp()`,
      [binding.sessionId]
    );
    if (expired.changes !== 1) {
      const err = new Error('Casino session expiry conflict'); err.status = 409; throw err;
    }
    return true;
  };
  if (inTransaction) return expire(db);
  return db.transaction(expire);
}

async function advanceCasinoSession(db, binding, expectedVersion, state, { inTransaction = false } = {}) {
  const advance = async transactionDb => {
    const row = await lockCasinoSession(transactionDb, binding);
    if (row.version !== expectedVersion) {
      const err = new Error('Casino session action has already been consumed'); err.status = 409; throw err;
    }
    const result = await transactionDb.run(
      `UPDATE casino_sessions SET state = ?::jsonb, version = version + 1,
       updated_at = CURRENT_TIMESTAMP
       WHERE session_id = ? AND version = ? AND status = 'active'`,
      [JSON.stringify(state), binding.sessionId, expectedVersion]
    );
    if (result.changes !== 1) { const err = new Error('Casino session action conflict'); err.status = 409; throw err; }
    return expectedVersion + 1;
  };
  if (inTransaction) return advance(db);
  return db.transaction(advance);
}

async function reserveAndAdvanceCasinoSession(
  db, binding, expectedVersion, additionalStake, state, { inTransaction = false } = {}
) {
  const reserveAndAdvance = async transactionDb => {
    if (!await lockTrustedFinancialIdentity(transactionDb, {
      userId: binding.userId, identityId: binding.identityId, serverId: binding.serverId,
    })) throw new Error('Active linked player identity is required');
    await moneySupplyManager.lockSupplyForUpdate(transactionDb, binding.serverId);
    const row = await lockCasinoSession(transactionDb, binding);
    if (row.version !== expectedVersion) {
      const err = new Error('Casino session action has already been consumed'); err.status = 409; throw err;
    }
    const stakeCents = parseCents(additionalStake, 'Additional casino stake');
    if (stakeCents <= 0) {
      const err = new Error('Additional casino stake must be positive'); err.status = 400; throw err;
    }
    const wallet = await transactionDb.get(
      `SELECT cash_on_hand FROM player_wallets
       WHERE identity_id = ? AND server_id = ? FOR UPDATE`,
      [binding.identityId, binding.serverId]
    );
    const balanceCents = parseCents(wallet?.cash_on_hand || 0, 'Wallet balance');
    if (balanceCents < stakeCents) {
      const err = new Error('Insufficient funds'); err.status = 400; throw err;
    }
    const walletUpdate = await transactionDb.run(
      `UPDATE player_wallets SET cash_on_hand = ?, last_updated = CURRENT_TIMESTAMP
       WHERE identity_id = ? AND server_id = ?`,
      [centsToDecimal(balanceCents - stakeCents), binding.identityId, binding.serverId]
    );
    if (walletUpdate.changes !== 1) throw new Error('Wallet update conflict');
    const sessionUpdate = await transactionDb.run(
      `UPDATE casino_sessions
       SET state = ?::jsonb, reserved_wager = reserved_wager + ?, version = version + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE session_id = ? AND version = ? AND status = 'active'`,
      [JSON.stringify(state), centsToDecimal(stakeCents), binding.sessionId, expectedVersion]
    );
    if (sessionUpdate.changes !== 1) {
      const err = new Error('Casino session action conflict'); err.status = 409; throw err;
    }
    return expectedVersion + 1;
  };
  if (inTransaction) return reserveAndAdvance(db);
  return db.transaction(reserveAndAdvance);
}

/**
 * Atomically settle a casino bet while holding the wallet row lock. When a
 * session binding is supplied, the same transaction locks and consumes that
 * session, making terminal settlement exactly-once.
 */
async function settleCasinoBetInTransaction(db, {
  identityId, serverId, guildId, gameType,
  wager, payout, result, resultData, currencySymbol,
  casinoSession = null, actorUserId = null
}) {
  const settlement = await (async transactionDb => {
    let lockedSession = null;
    if (casinoSession) {
      if (!await lockTrustedFinancialIdentity(transactionDb, {
        userId: casinoSession.binding.userId,
        identityId: casinoSession.binding.identityId,
        serverId: casinoSession.binding.serverId,
      })) throw new Error('Active linked player identity is required');
      await moneySupplyManager.lockSupplyForUpdate(transactionDb, serverId);
      lockedSession = await lockCasinoSession(transactionDb, casinoSession.binding);
      if (lockedSession.version !== casinoSession.version) {
        const err = new Error('Casino session action has already been consumed'); err.status = 409; throw err;
      }
    } else {
      if (!actorUserId || !await lockTrustedFinancialIdentity(transactionDb, {
        userId: actorUserId, identityId, serverId,
      })) {
        const err = new Error('Active linked player identity is required'); err.status = 403; throw err;
      }
      await moneySupplyManager.lockSupplyForUpdate(transactionDb, serverId);
    }
    await getOrCreateWallet(transactionDb, identityId, serverId);

    const wallet = await transactionDb.get(
      `SELECT cash_on_hand FROM player_wallets
       WHERE identity_id = ? AND server_id = ? FOR UPDATE`,
      [identityId, serverId]
    );
    const currentBalanceCents = parseCents(wallet?.cash_on_hand || 0, 'Wallet balance');
    const wagerCents = parseCents(wager, 'Casino wager');
    const payoutCents = parseCents(payout, 'Casino payout');
    const reservedWagerCents = casinoSession
      ? parseCents(lockedSession.reserved_wager || 0, 'Reserved wager')
      : 0;
    const additionalStakeCents = casinoSession ? wagerCents - reservedWagerCents : wagerCents;
    if (additionalStakeCents < 0) {
      const err = new Error('Casino settlement wager does not match escrow'); err.status = 409; throw err;
    }
    if (currentBalanceCents < additionalStakeCents) {
      const err = new Error('Insufficient funds'); err.status = 400; throw err;
    }

    const netCents = payoutCents - wagerCents;
    const spendBalanceCents = currentBalanceCents - additionalStakeCents;
    let newBalanceCents;
    try {
      newBalanceCents = checkedAddCents(spendBalanceCents, payoutCents, 'Casino payout wallet');
    } catch (error) {
      const terminal = casinoSession && casinoSession.terminal !== false;
      if (!terminal || payoutCents <= 0 || error.status !== 409) throw error;

      let refundBalanceCents = null;
      let refundDeferred = false;
      try {
        refundBalanceCents = checkedAddCents(
          currentBalanceCents, reservedWagerCents, 'Casino cancellation refund wallet');
      } catch (refundError) {
        if (refundError.status !== 409) throw refundError;
        refundDeferred = true;
      }
      const timestamp = new Date().toISOString();
      const cancellationReason = 'destination_wallet_capacity_exceeded';
      const cancellationData = {
        ...(resultData || {}), cancellationReason, originalResult: result,
        originalWager: centsToDecimal(wagerCents), originalPayout: centsToDecimal(payoutCents)
      };
      if (refundDeferred) {
        await insertOrVerifyPendingRefundClaim(transactionDb, {
          serverId,
          identityId,
          amountCents: reservedWagerCents,
          sourceType: 'casino_session',
          sourceKey: casinoSession.binding.sessionId,
          reason: cancellationReason,
          createdAt: timestamp,
        });
      } else {
        const walletUpdate = await transactionDb.run(
          `UPDATE player_wallets SET cash_on_hand = ?, last_updated = CURRENT_TIMESTAMP
           WHERE identity_id = ? AND server_id = ?`,
          [centsToDecimal(refundBalanceCents), identityId, serverId]
        );
        if (walletUpdate.changes !== 1) throw new Error('Wallet update conflict');
        if (reservedWagerCents > 0) {
          await transactionDb.run(
            `INSERT INTO economy_transactions
             (identity_id, transaction_type, amount, balance_after, account_type, source, description, server_id, timestamp)
             VALUES (?, 'earn', ?, ?, 'wallet', 'casino_cancellation', ?, ?, ?)`,
            [identityId, centsToDecimal(reservedWagerCents), centsToDecimal(refundBalanceCents),
              'Casino settlement cancelled; reserved escrow refunded', serverId, timestamp]
          );
        }
      }
      await transactionDb.run(
        `INSERT INTO casino_game_history
         (identity_id, server_id, guild_id, game_type, wager, payout, result, result_data, played_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [identityId, serverId, guildId, gameType, centsToDecimal(reservedWagerCents),
          centsToDecimal(reservedWagerCents), 'push', JSON.stringify(cancellationData), timestamp]
      );
      const consumed = await transactionDb.run(
        `UPDATE casino_sessions SET status = 'settled', state = ?::jsonb,
         version = version + 1, settled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE session_id = ? AND version = ? AND status = 'active'`,
        [JSON.stringify({ ...lockedSession.state, cancellationReason }),
          casinoSession.binding.sessionId, casinoSession.version]
      );
      if (consumed.changes !== 1) {
        const conflict = new Error('Casino session settlement conflict'); conflict.status = 409; throw conflict;
      }
      return {
        cancelled: true,
        balance: centsToAmount(refundDeferred ? currentBalanceCents : refundBalanceCents),
        reason: cancellationReason,
        refundDeferred,
      };
    }
    const net = centsToAmount(netCents);
    const newBalance = centsToAmount(newBalanceCents);
    const timestamp = new Date().toISOString();
    const sym = currencySymbol || '$';
    const walletUpdate = await transactionDb.run(
      `UPDATE player_wallets SET cash_on_hand = ?, last_updated = CURRENT_TIMESTAMP
       WHERE identity_id = ? AND server_id = ?`,
      [centsToDecimal(newBalanceCents), identityId, serverId]
    );
    if (walletUpdate.changes !== 1) throw new Error('Wallet update conflict');

    if (net > 0) {
      const supply = await moneySupplyManager.addToSupplyInTransaction(
        transactionDb, serverId, net, 'casino', identityId, { gameType, result }
      );
      if (!supply) { const err = new Error('Money supply cap exceeded'); err.status = 409; throw err; }
    } else if (net < 0) {
      await moneySupplyManager.removeFromSupplyInTransaction(
        transactionDb, serverId, -net, 'casino', identityId, { gameType, result }
      );
    }

    if (net !== 0) {
      await transactionDb.run(
        `INSERT INTO economy_transactions
         (identity_id, transaction_type, amount, balance_after, account_type, source, description, server_id, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [identityId, netCents < 0 ? 'spend' : 'earn', centsToDecimal(netCents),
          centsToDecimal(newBalanceCents), 'wallet', 'casino',
          net < 0 ? `Casino ${gameType} — lost ${sym}${wager.toFixed(2)}` : `Casino ${gameType} — won ${sym}${net.toFixed(2)}`,
          serverId, timestamp]
      );
    }
    await transactionDb.run(
      `INSERT INTO casino_game_history
       (identity_id, server_id, guild_id, game_type, wager, payout, result, result_data, played_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [identityId, serverId, guildId, gameType, centsToDecimal(wagerCents),
        centsToDecimal(payoutCents), result, JSON.stringify(resultData), timestamp]
    );

    if (casinoSession) {
      const terminal = casinoSession.terminal !== false;
      const consumed = await transactionDb.run(
        terminal
          ? `UPDATE casino_sessions SET status = 'settled',
             reserved_wager = reserved_wager + ?, version = version + 1,
             settled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE session_id = ? AND version = ? AND status = 'active'`
          : `UPDATE casino_sessions SET state = ?::jsonb, version = version + 1,
             updated_at = CURRENT_TIMESTAMP
             WHERE session_id = ? AND version = ? AND status = 'active'`,
        terminal
          ? [centsToDecimal(additionalStakeCents), casinoSession.binding.sessionId, casinoSession.version]
          : [JSON.stringify(casinoSession.state), casinoSession.binding.sessionId, casinoSession.version]
      );
      if (consumed.changes !== 1) { const err = new Error('Casino session settlement conflict'); err.status = 409; throw err; }
    }
    return newBalance;
  })(db);
  if (settlement?.cancelled) {
    const error = new Error(settlement.refundDeferred
      ? 'Casino win cancelled; reserved wager preserved as a claimable refund because destination wallet capacity was exceeded'
      : 'Casino win cancelled because destination wallet capacity was exceeded');
    error.status = 409;
    error.cancellation = settlement;
    throw error;
  }
  return settlement;
}

async function settleCasinoBet(db, input, { inTransaction = false } = {}) {
  if (inTransaction) {
    return settleCasinoBetInTransaction(db, input);
  }
  let cancellationError = null;
  const settlement = await db.transaction(async transactionDb => {
    try {
      return await settleCasinoBetInTransaction(transactionDb, input);
    } catch (error) {
      if (!error.cancellation) throw error;
      cancellationError = error;
      return error.cancellation;
    }
  });
  if (cancellationError) throw cancellationError;
  return settlement;
}

async function runIdempotentCasinoRequest(db, req, {
  serverId,
  identityId,
  operation,
  input,
}, execute) {
  const idempotencyKey = parseIdempotencyKey(req);
  const requestFingerprint = fingerprintFinancialRequest({ operation, ...input });
  return db.transaction(async transactionDb => {
    if (!await lockTrustedFinancialIdentity(transactionDb, {
      userId: req.user.id,
      identityId,
      serverId,
    })) {
      const error = new Error('Active linked player identity is required');
      error.status = 403;
      throw error;
    }
    const claim = await claimFinancialOperationInTransaction(transactionDb, {
      serverId,
      identityId,
      actorUserId: req.user.id,
      operation,
      idempotencyKey,
      requestFingerprint,
    });
    if (claim.replay) return claim;
    let execution;
    try {
      execution = await execute(transactionDb);
    } catch (error) {
      if (!error.cancellation) throw error;
      execution = {
        idempotentResponse: true,
        status: error.status || 409,
        body: { error: error.message },
      };
    }
    const response = execution?.idempotentResponse === true
      ? execution
      : { status: 200, body: execution };
    await completeFinancialOperationInTransaction(
      transactionDb, claim.id, response.status, response.body
    );
    return { replay: false, status: response.status, body: response.body };
  });
}

function createIdempotentResponseRecorder() {
  let status = 200;
  return {
    status(nextStatus) {
      status = nextStatus;
      return this;
    },
    json(body) {
      return { idempotentResponse: true, status, body };
    },
  };
}

function sendIdempotentCasinoResponse(res, result) {
  if (result.replay) res.set('Idempotency-Replayed', 'true');
  return res.status(result.status).json(result.body);
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/casino/status/:identityId
// Returns casino configuration and the player's current wallet balance.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/status/:identityId', ensureAuthenticated, async (req, res) => {
  const db = req.app.locals.db;
  const { identityId } = req.params;

  try {
    const { server } = await resolvePlayerContext(db, parseInt(identityId), req.playerServerAccess.serverId);
    const config = await getCasinoConfig(db, server.id);

    if (!config || !config.enabled) {
      return res.json({ success: true, enabled: false, casinoEnabled: false });
    }

    const wallet = await db.get(
      'SELECT cash_on_hand FROM player_wallets WHERE identity_id = ? AND server_id = ?',
      [identityId, server.id]
    );

    res.json({
      success: true,
      enabled: true,
      casinoEnabled: !!config.casino_enabled,
      balance: amountForResponse(wallet?.cash_on_hand ?? config.starting_cash ?? 0, 'Wallet balance'),
      minBet: parseFloat(config.casino_min_bet) || 1,
      maxBet: parseFloat(config.casino_max_bet) || 10000,
      currency: { symbol: config.currency_symbol, name: config.currency_name }
    });

  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Casino status error:', err);
    res.status(500).json({ error: 'Failed to fetch casino status' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/casino/history/:identityId
// Returns the player's 20 most recent casino games.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/history/:identityId', ensureAuthenticated, async (req, res) => {
  const db = req.app.locals.db;
  const { identityId } = req.params;

  try {
    const { server } = await resolvePlayerContext(db, parseInt(identityId), req.playerServerAccess.serverId);
    const config = await getCasinoConfig(db, server.id);

    const rows = await db.all(
      `SELECT game_type, wager, payout, net, result, result_data, played_at
       FROM casino_game_history
       WHERE identity_id = ? AND server_id = ?
       ORDER BY played_at DESC
       LIMIT 20`,
      [identityId, server.id]
    );

    res.json({
      success: true,
      history: rows.map(r => ({
        gameType: r.game_type,
        wager: r.wager,
        payout: r.payout,
        net: r.net,
        result: r.result,
        resultData: r.result_data ? JSON.parse(r.result_data) : null,
        playedAt: r.played_at
      })),
      currency: { symbol: config?.currency_symbol, name: config?.currency_name }
    });

  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Casino history error:', err);
    res.status(500).json({ error: 'Failed to fetch casino history' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SLOTS — single-player
// ─────────────────────────────────────────────────────────────────────────────

// Symbol definitions with weighted probabilities and payout multipliers.
// payout3 = multiplier applied to the wager when three of this symbol appear.
const SLOT_SYMBOLS = [
  { name: 'cherry',  emoji: '🍒', weight: 35, payout3: 3   },
  { name: 'lemon',   emoji: '🍋', weight: 25, payout3: 5   },
  { name: 'bell',    emoji: '🔔', weight: 20, payout3: 10  },
  { name: 'diamond', emoji: '💎', weight: 15, payout3: 25  },
  { name: 'wild',    emoji: '⭐', weight: 5,  payout3: 100 },
];

const SLOT_TOTAL_WEIGHT = SLOT_SYMBOLS.reduce((sum, s) => sum + s.weight, 0);

/** Pick one symbol at random using weighted probability. */
function spinReel() {
  let rand = Math.random() * SLOT_TOTAL_WEIGHT;
  for (const sym of SLOT_SYMBOLS) {
    rand -= sym.weight;
    if (rand <= 0) return sym;
  }
  return SLOT_SYMBOLS[SLOT_SYMBOLS.length - 1];
}

/**
 * Determine the payout multiplier for a 3-reel result.
 *
 * Wild (⭐) substitutes for any symbol:
 *   3 wilds              → 100× jackpot
 *   2 wilds + 1 symbol   → symbol.payout3 × 2  (wild bonus)
 *   1 wild + 2 matching  → symbol.payout3       (completes the trio)
 *   1 wild + 2 different → no win
 *   3 matching (no wild) → symbol.payout3
 *   anything else        → 0 (loss)
 *
 * @param {Object[]} reels - Array of 3 symbol objects from SLOT_SYMBOLS
 * @returns {{ multiplier: number, description: string }}
 */
function calculateSlotsOutcome(reels) {
  const wilds    = reels.filter(s => s.name === 'wild');
  const nonWilds = reels.filter(s => s.name !== 'wild');
  const wildCount = wilds.length;

  if (wildCount === 3) {
    return { multiplier: 100, description: 'Triple Wild Jackpot! ⭐⭐⭐' };
  }

  if (wildCount === 2) {
    const sym  = nonWilds[0];
    const mult = sym.payout3 * 2;
    return { multiplier: mult, description: `Double Wild + ${sym.emoji} — ×${mult}` };
  }

  if (wildCount === 1) {
    if (nonWilds.length === 2 && nonWilds[0].name === nonWilds[1].name) {
      const sym = nonWilds[0];
      return { multiplier: sym.payout3, description: `Wild + ${sym.emoji}${sym.emoji} — ×${sym.payout3}` };
    }
    return { multiplier: 0, description: 'No match' };
  }

  // No wilds — all three must match
  if (nonWilds[0].name === nonWilds[1].name && nonWilds[1].name === nonWilds[2].name) {
    const sym = nonWilds[0];
    return { multiplier: sym.payout3, description: `Three ${sym.emoji} — ×${sym.payout3}` };
  }

  return { multiplier: 0, description: 'No match' };
}

/**
 * POST /api/casino/play/slots
 * Body: { identityId, wager }
 */
router.post('/play/slots', strictLimiter, ensureAuthenticated, async (req, res) => {
  const db = req.app.locals.db;
  const { identityId, wager: rawWager } = req.body;

  if (!identityId) return res.status(400).json({ error: 'identityId is required' });

  try {
    const { identity, server } = await resolvePlayerContext(
      db, parseInt(identityId), req.playerServerAccess.serverId
    );
    const config = await getCasinoConfig(db, server.id);

    if (!config || !config.enabled) {
      return res.status(403).json({ error: 'Economy is not enabled for this community' });
    }
    if (!config.casino_enabled) {
      return res.status(403).json({ error: 'Casino is not enabled for this community' });
    }

    const { wager, error: wagerErr } = parseWager(rawWager, config);
    if (wagerErr) return res.status(400).json({ error: wagerErr });

    const idempotentResult = await runIdempotentCasinoRequest(db, req, {
      serverId: identity.server_id,
      identityId: parseInt(identityId),
      operation: 'casino_slots',
      input: { wagerCents: parseCents(wager, 'Wager') },
    }, async transactionDb => {
      const reels = [spinReel(), spinReel(), spinReel()];
      const { multiplier, description } = calculateSlotsOutcome(reels);
      const payout = casinoPayout(wager, multiplier);
      const result = multiplier === 0 ? 'loss' : multiplier * wager === wager ? 'push' : 'win';

      const newBalance = await settleCasinoBet(transactionDb, {
        identityId:    parseInt(identityId),
        serverId:      identity.server_id,
        guildId:       server.guild_id,
        gameType:      'slots',
        wager,
        payout,
        result,
        resultData:    { reels: reels.map(s => s.name), multiplier, description },
        currencySymbol: config.currency_symbol,
        actorUserId: req.user.id,
      }, { inTransaction: true });

      return {
        success:      true,
        reels:        reels.map(s => s.emoji),
        reelNames:    reels.map(s => s.name),
        multiplier,
        wager,
        payout,
        net:          casinoNet(payout, wager),
        result,
        description,
        balanceAfter: newBalance,
        currency:     { symbol: config.currency_symbol, name: config.currency_name }
      };
    });
    return sendIdempotentCasinoResponse(res, idempotentResult);

  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Casino slots error:', err);
    res.status(500).json({ error: 'Failed to process slots game' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// BLACKJACK — single-player vs dealer
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');

// Build a fresh 6-deck shoe as an array of card objects.
// Cards are drawn by splicing random positions — simulates a shuffled shoe
// without needing to transmit the full shoe in handState.
const BJ_SUITS  = ['♠', '♥', '♦', '♣'];
const BJ_RANKS  = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];

/** Return the hard value of a rank (Ace = 11). */
function rankValue(rank) {
  if (rank === 'A') return 11;
  if (['K','Q','J'].includes(rank)) return 10;
  return parseInt(rank, 10);
}

/** Draw a single random card. */
function drawCard() {
  const suit = BJ_SUITS[Math.floor(Math.random() * BJ_SUITS.length)];
  const rank = BJ_RANKS[Math.floor(Math.random() * BJ_RANKS.length)];
  return { suit, rank, value: rankValue(rank) };
}

/**
 * Sum a hand, reducing Ace values from 11 → 1 to avoid busting where possible.
 * Returns the best achievable total ≤ 21.
 */
function handTotal(cards) {
  let total = cards.reduce((s, c) => s + c.value, 0);
  let aces  = cards.filter(c => c.rank === 'A').length;
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return total;
}

/** True when a 2-card hand totals 21. */
function isBlackjack(cards) {
  return cards.length === 2 && handTotal(cards) === 21;
}

/**
 * Run the dealer's forced draw sequence:
 *   Dealer hits on any total < 17, or on soft 17 (17 with an ace counted as 11).
 */
function runDealer(dealerCards) {
  const cards = [...dealerCards];
  let keepDrawing = true;
  while (keepDrawing) {
    const total = handTotal(cards);
    if (total > 17) { keepDrawing = false; break; }
    if (total === 17) {
      // Stand on hard 17; hit on soft 17 (an ace still counting as 11)
      const rawSum   = cards.reduce((s, c) => s + c.value, 0);
      const isSoft17 = rawSum !== total; // soft if we reduced an ace
      if (!isSoft17) { keepDrawing = false; break; }
    }
    cards.push(drawCard());
  }
  return cards;
}


function totalBlackjackWager(state, handWager) {
  return casinoSum(handWager, state.insuranceBet || 0);
}

/**
 * Determine the final game outcome string and payout multiplier.
 *   win (non-BJ)  → 2× wager returned (net +1×)
 *   blackjack     → 2.5× wager returned (net +1.5×)
 *   push          → 1× wager returned (net 0)
 *   loss          → 0 returned (net -1×)
 */
function resolveBlackjack(playerCards, dealerCards) {
  const playerTotal  = handTotal(playerCards);
  const dealerTotal  = handTotal(dealerCards);
  const playerBJ     = isBlackjack(playerCards);
  const dealerBJ     = isBlackjack(dealerCards);

  if (playerTotal > 21)                      return { result: 'loss',      multiplier: 0 };
  if (playerBJ && dealerBJ)                  return { result: 'push',      multiplier: 1 };
  if (playerBJ)                              return { result: 'blackjack', multiplier: 2.5 };
  if (dealerBJ)                              return { result: 'loss',      multiplier: 0 };
  if (dealerTotal > 21)                      return { result: 'win',       multiplier: 2 };
  if (playerTotal > dealerTotal)             return { result: 'win',       multiplier: 2 };
  if (playerTotal === dealerTotal)           return { result: 'push',      multiplier: 1 };
  return                                            { result: 'loss',      multiplier: 0 };
}

/**
 * POST /api/casino/play/blackjack
 *
 * Body for action 'deal':
 *   { identityId, wager, action: 'deal' }
 *
 * Body for actions 'hit' | 'stand' | 'double' | 'split' | 'insurance' | 'no-insurance':
 *   { identityId, action, handState, [insuranceBet] }
 *   handState is the signed object returned by the previous response.
 *
 * Hand state extended fields (beyond base identityId/serverId/guildId/wager/dealerCards):
 *   playerCards      — current (or active split) hand cards
 *   doubled          — whether current hand was doubled
 *   playerHasBJ      — true when player was dealt a natural 21 (insurance flow)
 *   insuranceBet     — amount bet on insurance (0 = none)
 *   insuranceSettled — true once insurance has been resolved
 *   splitHands       — null, or [{cards, wager, doubled, result}] when split
 *   currentHandIndex — index into splitHands for the active hand
 */

/* eslint-disable no-constant-condition, no-unused-vars */
/* ── Internal helpers ────────────────────────────────────────────────────── */

/**
 * Build the response payload for an active (non-complete) hand.
 * When a split is in progress, includes both hands + current index.
 */
function activeResponse(state, extra = {}) {
  const { splitHands, currentHandIndex } = state;
  const isSplit = Array.isArray(splitHands);

  const currentCards = isSplit
    ? splitHands[currentHandIndex].cards
    : state.playerCards;

  return {
    success:       true,
    status:        'active',
    playerCards:   currentCards,
    dealerCards:   [state.dealerCards[0]],          // only face-up shown
    playerTotal:   handTotal(currentCards),
    dealerVisible: handTotal([state.dealerCards[0]]),
    splitHands:    isSplit ? splitHands : null,
    currentHandIndex: isSplit ? currentHandIndex : null,
    ...extra
  };
}

/**
 * Settle all split hands against the given final dealer cards.
 * Returns an array of settlement results (one per split hand).
 */
async function settleAllSplitHands(db, state, finalDealerCards, sym, context, {
  inTransaction = false,
} = {}) {
  const results = state.splitHands.map(hand => {
    const { result, multiplier } = resolveSplitHand(hand.cards, finalDealerCards);
    const effectiveWager = hand.doubled ? hand.wager * 2 : hand.wager;
    const payout = casinoPayout(effectiveWager, multiplier);
    return {
      result,
      wager: effectiveWager,
      payout,
      net: casinoNet(payout, effectiveWager),
      playerTotal: handTotal(hand.cards),
      cards: hand.cards,
      doubled: hand.doubled
    };
  });
  const handWager = results.reduce((sum, item) => sum + item.wager, 0);
  const wager = totalBlackjackWager(state, handWager);
  const payout = results.reduce((sum, item) => sum + item.payout, 0);
  const newBalance = await settleCasinoBet(db, {
    identityId: context.identityId,
    serverId: context.server.id,
    guildId: context.server.guild_id,
    gameType: 'blackjack', wager, payout,
    result: results.every(item => item.result === 'loss') ? 'loss' : 'split',
    resultData: { hands: results, dealerCards: finalDealerCards, split: true },
    currencySymbol: sym,
    casinoSession: { binding: context.binding, version: context.version }
  }, { inTransaction });
  return results.map(item => ({ ...item, balanceAfter: newBalance }));
}

/**
 * Outcome for a split hand — blackjack not possible (21 is treated as 21).
 */
function resolveSplitHand(playerCards, dealerCards) {
  const playerTotal = handTotal(playerCards);
  const dealerTotal = handTotal(dealerCards);
  if (playerTotal > 21)              return { result: 'loss', multiplier: 0 };
  if (dealerTotal > 21)              return { result: 'win',  multiplier: 2 };
  if (playerTotal > dealerTotal)     return { result: 'win',  multiplier: 2 };
  if (playerTotal === dealerTotal)   return { result: 'push', multiplier: 1 };
  return                                    { result: 'loss', multiplier: 0 };
}

/* ── Route handler ───────────────────────────────────────────────────────── */

router.post('/play/blackjack', strictLimiter, ensureAuthenticated, async (req, res) => {
  const db = req.app.locals.db;
  const { identityId, action, wager: rawWager, insuranceBet: rawInsuranceBet } = req.body;

  const VALID_ACTIONS = ['deal','hit','stand','double','split','insurance','no-insurance'];
  if (!identityId) return res.status(400).json({ error: 'identityId is required' });
  if (!VALID_ACTIONS.includes(action)) {
    return res.status(400).json({ error: `action must be one of: ${VALID_ACTIONS.join(', ')}` });
  }

  try {
    const { identity, server } = await resolvePlayerContext(
      db, parseInt(identityId), req.playerServerAccess.serverId
    );
    const config = await getCasinoConfig(db, server.id);

    if (!config || !config.enabled) {
      return res.status(403).json({ error: 'Economy is not enabled for this community' });
    }
    if (!config.casino_enabled) {
      return res.status(403).json({ error: 'Casino is not enabled for this community' });
    }

    const sym = config.currency_symbol || '$';

    // ── DEAL ─────────────────────────────────────────────────────────────────
    if (action === 'deal') {
      const { wager, error: wagerErr } = parseWager(rawWager, config);
      if (wagerErr) return res.status(400).json({ error: wagerErr });

      const idempotentResult = await runIdempotentCasinoRequest(db, req, {
        serverId: identity.server_id,
        identityId: parseInt(identityId),
        operation: 'casino_blackjack_deal',
        input: { wagerCents: parseCents(wager, 'Wager') },
      }, async transactionDb => {
        const wallet = await getOrCreateWallet(transactionDb, identityId, server.id);
        if ((parseFloat(wallet.cash_on_hand) || 0) < wager) {
          const error = new Error('Insufficient funds');
          error.status = 400;
          throw error;
        }

        const playerCards = [drawCard(), drawCard()];
        const dealerCards = [drawCard(), drawCard()];
        const dealerShowsAce = dealerCards[0].rank === 'A';
        const playerHasBJ = isBlackjack(playerCards);
        const canSplit = playerCards[0].rank === playerCards[1].rank;

        if (playerHasBJ && !dealerShowsAce) {
          const { result, multiplier } = resolveBlackjack(playerCards, dealerCards);
          const payout = casinoPayout(wager, multiplier);
          const newBalance = await settleCasinoBet(transactionDb, {
            identityId: parseInt(identityId), serverId: identity.server_id,
            guildId: server.guild_id, gameType: 'blackjack',
            wager, payout, result,
            resultData: { playerCards, dealerCards, playerTotal: 21, dealerTotal: handTotal(dealerCards) },
            currencySymbol: sym,
            actorUserId: req.user.id,
          }, { inTransaction: true });
          return {
            success: true, status: 'complete',
            playerCards, dealerCards,
            playerTotal: 21, dealerTotal: handTotal(dealerCards),
            result, net: casinoNet(payout, wager),
            balanceAfter: newBalance,
            message: '🃏 Blackjack! 3:2 payout!',
            currency: { symbol: sym, name: config.currency_name }
          };
        }

        const state = {
          wager,
          playerCards,
          dealerCards,
          doubled: false,
          playerHasBJ,
          insuranceBet: 0,
          insuranceSettled: !dealerShowsAce,
          splitHands: null,
          currentHandIndex: 0
        };
        const sessionId = await createCasinoSession(
          transactionDb, req, 'blackjack', parseInt(identityId), server, state, 15, wager,
          { inTransaction: true }
        );
        return {
          success: true,
          status: 'active',
          playerCards,
          dealerCards: [dealerCards[0]],
          playerTotal: handTotal(playerCards),
          dealerVisible: handTotal([dealerCards[0]]),
          canDouble: !playerHasBJ,
          canSplit,
          insuranceAvailable: dealerShowsAce,
          sessionId,
          currency: { symbol: sym, name: config.currency_name }
        };
      });
      return sendIdempotentCasinoResponse(res, idempotentResult);
    }

    const continuationOperations = {
      insurance: 'casino_blackjack_insurance',
      'no-insurance': 'casino_blackjack_no_insurance',
      split: 'casino_blackjack_split',
      hit: 'casino_blackjack_hit',
      stand: 'casino_blackjack_stand',
      double: 'casino_blackjack_double',
    };
    const idempotentResult = await runIdempotentCasinoRequest(db, req, {
      serverId: identity.server_id,
      identityId: parseInt(identityId),
      operation: continuationOperations[action],
      input: { action, sessionId: req.body.sessionId, insuranceBet: rawInsuranceBet ?? null },
    }, async transactionDb => {
      const db = transactionDb;
      const res = createIdempotentResponseRecorder();
      const settleCasinoBet = (_db, input) => settleCasinoBetInTransaction(transactionDb, input);

    // ── HIT / STAND / DOUBLE ─────────────────────────────────────────────────
    const binding = sessionBinding(req, 'blackjack', identityId, server);
    const casinoSessionRow = await readCasinoSession(db, binding, { inTransaction: true });
    const state = casinoSessionRow.state;
    const saveState = async nextState => {
      await advanceCasinoSession(
        db, binding, casinoSessionRow.version, nextState, { inTransaction: true }
      );
      return binding.sessionId;
    };

    // Guard: insurance must be resolved before any other action
    if (!state.insuranceSettled && action !== 'insurance' && action !== 'no-insurance') {
      return res.status(400).json({ error: 'Insurance decision required before continuing' });
    }

    // ── INSURANCE / NO-INSURANCE ─────────────────────────────────────────────
    if (action === 'insurance' || action === 'no-insurance') {
      if (state.insuranceSettled) {
        return res.status(400).json({ error: 'Insurance has already been settled' });
      }

      const { playerCards, dealerCards, wager, playerHasBJ } = state;
      const dealerHasBJ   = isBlackjack(dealerCards);
      const insuranceBet  = casinoPayout(wager, 0.5);

      if (action === 'insurance') {
        // Verify player can afford the insurance bet
        const wallet = await getOrCreateWallet(db, identityId, server.id);
        if ((parseFloat(wallet.cash_on_hand) || 0) < insuranceBet) {
          return res.status(400).json({ error: 'Insufficient funds for insurance bet' });
        }

        if (dealerHasBJ) {
          const mainResult = playerHasBJ ? 'push' : 'loss';
          const mainPayout = playerHasBJ ? wager : 0;
          const insurancePayout = casinoPayout(insuranceBet, 3);
          const totalWager = casinoSum(wager, insuranceBet);
          const totalPayout = casinoSum(mainPayout, insurancePayout);
          const finalBalance = await settleCasinoBet(db, {
            identityId: parseInt(identityId), serverId: server.id, guildId: server.guild_id,
            gameType: 'blackjack', wager: totalWager, payout: totalPayout, result: mainResult,
            resultData: { playerCards, dealerCards, insurance: true, dealerBJ: true,
              insuranceBet, insurancePayout, mainWager: wager, mainPayout },
            currencySymbol: sym,
            casinoSession: { binding, version: casinoSessionRow.version }
          });
          const label = playerHasBJ ? 'Push on main hand' : 'Main hand lost';
          return res.json({
            success: true, status: 'complete',
            playerCards, dealerCards,
            playerTotal: handTotal(playerCards), dealerTotal: 21,
            result: mainResult,
            net: casinoNet(totalPayout, totalWager),
            balanceAfter: finalBalance,
            message: `🛡️ Insurance wins! ${label}.`,
            currency: { symbol: sym, name: config.currency_name }
          });
        }

        if (playerHasBJ) {
          const bjPayout = casinoPayout(wager, 2.5);
          const totalWager = casinoSum(wager, insuranceBet);
          const finalBalance = await settleCasinoBet(db, {
            identityId: parseInt(identityId), serverId: server.id, guildId: server.guild_id,
            gameType: 'blackjack', wager: totalWager, payout: bjPayout, result: 'blackjack',
            resultData: { playerCards, dealerCards, insurance: true, dealerBJ: false,
              insuranceBet, mainWager: wager, mainPayout: bjPayout },
            currencySymbol: sym,
            casinoSession: { binding, version: casinoSessionRow.version }
          });
          return res.json({
            success: true, status: 'complete',
            playerCards, dealerCards,
            playerTotal: 21, dealerTotal: handTotal(dealerCards),
            result: 'blackjack',
            net: casinoNet(bjPayout, totalWager),
            balanceAfter: finalBalance,
            message: `🃏 Blackjack! Insurance lost (−${sym}${insuranceBet.toFixed(2)}).`,
            currency: { symbol: sym, name: config.currency_name }
          });
        }

        const nextState = { ...state, insuranceBet, insuranceSettled: true };
        await reserveAndAdvanceCasinoSession(
          db, binding, casinoSessionRow.version, insuranceBet, nextState,
          { inTransaction: true }
        );
        const sessionId = binding.sessionId;
        return res.json({
          success: true, status: 'active',
          playerCards, dealerCards: [dealerCards[0]],
          playerTotal: handTotal(playerCards), dealerVisible: handTotal([dealerCards[0]]),
          canDouble: true, canSplit: playerCards[0].rank === playerCards[1].rank,
          insuranceLost: true,
          sessionId,
          currency: { symbol: sym, name: config.currency_name }
        });
      }

      // action === 'no-insurance'
      if (dealerHasBJ) {
        // Settle main hand immediately
        const mainResult     = playerHasBJ ? 'push' : 'loss';
        const mainMultiplier = playerHasBJ ? 1 : 0;
        const mainPayout     = casinoPayout(wager, mainMultiplier);
        const finalBalance   = await settleCasinoBet(db, {
          identityId: parseInt(identityId), serverId: server.id, guildId: server.guild_id,
          gameType: 'blackjack', wager, payout: mainPayout, result: mainResult,
          resultData: { playerCards, dealerCards, playerTotal: handTotal(playerCards), dealerTotal: 21 },
          currencySymbol: sym,
          casinoSession: { binding, version: casinoSessionRow.version }
        });
        const message = playerHasBJ ? '↩️ Push — both have Blackjack!' : '💸 Dealer Blackjack!';
        return res.json({
          success: true, status: 'complete',
          playerCards, dealerCards,
          playerTotal: handTotal(playerCards), dealerTotal: 21,
          result: mainResult,
          net: casinoNet(mainPayout, wager),
          balanceAfter: finalBalance,
          message, currency: { symbol: sym, name: config.currency_name }
        });
      }

      // Dealer does not have BJ
      if (playerHasBJ) {
        // Player wins with Blackjack 3:2
        const bjPayout     = casinoPayout(wager, 2.5);
        const finalBalance = await settleCasinoBet(db, {
          identityId: parseInt(identityId), serverId: server.id, guildId: server.guild_id,
          gameType: 'blackjack', wager, payout: bjPayout, result: 'blackjack',
          resultData: { playerCards, dealerCards, playerTotal: 21, dealerTotal: handTotal(dealerCards) },
          currencySymbol: sym,
          casinoSession: { binding, version: casinoSessionRow.version }
        });
        return res.json({
          success: true, status: 'complete',
          playerCards, dealerCards,
          playerTotal: 21, dealerTotal: handTotal(dealerCards),
          result: 'blackjack',
          net: casinoNet(bjPayout, wager),
          balanceAfter: finalBalance,
          message: '🃏 Blackjack! 3:2 payout!',
          currency: { symbol: sym, name: config.currency_name }
        });
      }

      // Player does not have BJ, dealer does not have BJ → game continues
      const sessionId = await saveState({ ...state, insuranceSettled: true });
      return res.json({
        success: true, status: 'active',
        playerCards, dealerCards: [dealerCards[0]],
        playerTotal: handTotal(playerCards), dealerVisible: handTotal([dealerCards[0]]),
        canDouble: true, canSplit: playerCards[0].rank === playerCards[1].rank,
        sessionId,
        currency: { symbol: sym, name: config.currency_name }
      });
    }

    // ── SPLIT ────────────────────────────────────────────────────────────────
    if (action === 'split') {
      let { playerCards, dealerCards, wager } = state;

      if (state.splitHands !== null) {
        return res.status(400).json({ error: 'Re-splitting is not supported' });
      }
      if (playerCards.length !== 2 || playerCards[0].rank !== playerCards[1].rank) {
        return res.status(400).json({ error: 'Split requires two cards of the same rank' });
      }

      const splitAces = playerCards[0].rank === 'A';

      // Build two hands: each keeps its original card + draws one new card
      const splitHands = [
        { cards: [playerCards[0], drawCard()], wager, doubled: false, result: null },
        { cards: [playerCards[1], drawCard()], wager, doubled: false, result: null }
      ];

      // Split Aces rule: only one card per hand, then auto-stand both
      if (splitAces) {
        const finalDealerCards = runDealer(dealerCards);
        const dealerTotal      = handTotal(finalDealerCards);
        const splitResults     = await settleAllSplitHands(db, {
          ...state, splitHands
        }, finalDealerCards, sym, {
          identityId: parseInt(identityId), server, binding, version: casinoSessionRow.version
        }, { inTransaction: true });

        const totalNet      = splitResults.reduce((s, r) => s + r.net, 0) - (Number(state.insuranceBet) || 0);
        const lastBalance   = splitResults[splitResults.length - 1].balanceAfter;
        const resultLabels  = splitResults.map(r => r.result.charAt(0).toUpperCase() + r.result.slice(1));

        return res.json({
          success: true, status: 'complete', split: true,
          dealerCards: finalDealerCards, dealerTotal,
          splitResults: splitResults.map((r, i) => ({
            ...r, cards: splitHands[i].cards, playerTotal: handTotal(splitHands[i].cards)
          })),
          totalNet, balanceAfter: lastBalance,
          message: `Split Aces: ${resultLabels.join(' / ')}`,
          currency: { symbol: sym, name: config.currency_name }
        });
      }

      // Normal split — reserve the second hand before returning active state.
      const nextState = { ...state, splitHands, currentHandIndex: 0 };
      await reserveAndAdvanceCasinoSession(
        db, binding, casinoSessionRow.version, wager, nextState,
        { inTransaction: true }
      );
      const sessionId = binding.sessionId;
      return res.json({
        success:          true,
        status:           'active',
        playerCards:      splitHands[0].cards,
        dealerCards:      [dealerCards[0]],
        playerTotal:      handTotal(splitHands[0].cards),
        dealerVisible:    handTotal([dealerCards[0]]),
        splitHands:       splitHands.map(h => ({ cards: h.cards, total: handTotal(h.cards), result: h.result, wager: h.wager })),
        currentHandIndex: 0,
        canDouble:        false,
        canSplit:         false,
        sessionId,
        currency:         { symbol: sym, name: config.currency_name }
      });
    }

    // ── Shared state for HIT / STAND / DOUBLE ────────────────────────────────
    let { playerCards, dealerCards, wager, doubled } = state;
    const isSplit = Array.isArray(state.splitHands);

    // ── SPLIT-AWARE HIT ──────────────────────────────────────────────────────
    if (action === 'hit') {
      if (isSplit) {
        const idx        = state.currentHandIndex;
        const splitHands = state.splitHands.map(h => ({ ...h, cards: [...h.cards] }));
        splitHands[idx].cards = [...splitHands[idx].cards, drawCard()];
        const total      = handTotal(splitHands[idx].cards);

        if (total > 21) {
          // Current hand busts — mark it, advance to next hand
          splitHands[idx].result = 'loss';
          const nextIdx = idx + 1;

          if (nextIdx >= splitHands.length) {
            // All hands done — run dealer and settle
            const finalDealerCards = runDealer(dealerCards);
            const splitResults     = await settleAllSplitHands(db, { ...state, splitHands }, finalDealerCards, sym, {
          identityId: parseInt(identityId), server, binding, version: casinoSessionRow.version
        }, { inTransaction: true });
            const totalNet         = splitResults.reduce((s, r) => s + r.net, 0) - (Number(state.insuranceBet) || 0);
            const lastBalance      = splitResults[splitResults.length - 1].balanceAfter;
            const labels           = splitResults.map(r => r.result.charAt(0).toUpperCase() + r.result.slice(1));
            return res.json({
              success: true, status: 'complete', split: true,
              dealerCards: finalDealerCards, dealerTotal: handTotal(finalDealerCards),
              splitResults: splitResults.map((r, i) => ({
                ...r, cards: splitHands[i].cards, playerTotal: handTotal(splitHands[i].cards)
              })),
              totalNet, balanceAfter: lastBalance,
              message: `Split: ${labels.join(' / ')}`,
              currency: { symbol: sym, name: config.currency_name }
            });
          }

          // Move to next split hand
          const sessionId = await saveState({ ...state, splitHands, currentHandIndex: nextIdx });
          return res.json({
            success:          true,
            status:           'active',
            playerCards:      splitHands[nextIdx].cards,
            dealerCards:      [dealerCards[0]],
            playerTotal:      handTotal(splitHands[nextIdx].cards),
            dealerVisible:    handTotal([dealerCards[0]]),
            splitHands:       splitHands.map(h => ({ cards: h.cards, total: handTotal(h.cards), result: h.result, wager: h.wager })),
            currentHandIndex: nextIdx,
            canDouble:        false,
            canSplit:         false,
            bustMessage:      `Hand ${idx + 1} bust!`,
            sessionId,
            currency:         { symbol: sym, name: config.currency_name }
          });
        }

        // Still active on this split hand
        const sessionId = await saveState({ ...state, splitHands });
        return res.json({
          success:          true,
          status:           'active',
          playerCards:      splitHands[idx].cards,
          dealerCards:      [dealerCards[0]],
          playerTotal:      total,
          dealerVisible:    handTotal([dealerCards[0]]),
          splitHands:       splitHands.map(h => ({ cards: h.cards, total: handTotal(h.cards), result: h.result, wager: h.wager })),
          currentHandIndex: idx,
          canDouble:        false,
          canSplit:         false,
          sessionId,
          currency:         { symbol: sym, name: config.currency_name }
        });
      }

      // ── Normal (non-split) hit ───────────────────────────────────────────
      playerCards = [...playerCards, drawCard()];
      const total = handTotal(playerCards);

      if (total > 21) {
        // Player busts — settle immediately
        const newBalance = await settleCasinoBet(db, {
          identityId: parseInt(identityId), serverId: server.id,
          guildId: server.guild_id, gameType: 'blackjack',
          wager: totalBlackjackWager(state, doubled ? wager * 2 : wager), payout: 0, result: 'loss',
          resultData: { playerCards, dealerCards, playerTotal: total, dealerTotal: handTotal(dealerCards) },
          currencySymbol: sym,
          casinoSession: { binding, version: casinoSessionRow.version }
        });
        return res.json({
          success: true, status: 'complete',
          playerCards, dealerCards,
          playerTotal: total, dealerTotal: handTotal(dealerCards),
          result: 'loss', net: -totalBlackjackWager(state, doubled ? wager * 2 : wager),
          balanceAfter: newBalance,
          message: `💥 Bust! Total: ${total}`,
          currency: { symbol: sym, name: config.currency_name }
        });
      }

      // Still active — send updated state
      const sessionId = await saveState({ ...state, playerCards });
      return res.json({
        success:      true,
        status:       'active',
        playerCards,
        dealerCards:  [dealerCards[0]],
        playerTotal:  total,
        dealerVisible: handTotal([dealerCards[0]]),
        canDouble:    false, // can only double on first action
        sessionId,
        currency:     { symbol: sym, name: config.currency_name }
      });
    }

    // ── DOUBLE (not allowed on split hands) ──────────────────────────────────
    if (action === 'double') {
      if (isSplit) {
        return res.status(400).json({ error: 'Double down is not allowed after splitting' });
      }
      if (playerCards.length !== 2) {
        return res.status(400).json({ error: 'Double down only allowed on first two cards' });
      }
      playerCards  = [...playerCards, drawCard()];
      doubled      = true;
      // Fall through to stand logic below
    }

    // ── SPLIT-AWARE STAND (and post-double) ──────────────────────────────────
    if (isSplit && action === 'stand') {
      const idx        = state.currentHandIndex;
      const splitHands = state.splitHands.map(h => ({ ...h, cards: [...h.cards] }));
      splitHands[idx].result = 'stood'; // mark as complete (result resolved after dealer)
      const nextIdx    = idx + 1;

      if (nextIdx >= splitHands.length) {
        // All hands have been played — run dealer now
        const finalDealerCards = runDealer(dealerCards);
        const splitResults     = await settleAllSplitHands(db, { ...state, splitHands }, finalDealerCards, sym, {
          identityId: parseInt(identityId), server, binding, version: casinoSessionRow.version
        }, { inTransaction: true });
        const totalNet         = splitResults.reduce((s, r) => s + r.net, 0) - (Number(state.insuranceBet) || 0);
        const lastBalance      = splitResults[splitResults.length - 1].balanceAfter;
        const labels           = splitResults.map(r => r.result.charAt(0).toUpperCase() + r.result.slice(1));
        return res.json({
          success: true, status: 'complete', split: true,
          dealerCards: finalDealerCards, dealerTotal: handTotal(finalDealerCards),
          splitResults: splitResults.map((r, i) => ({
            ...r, cards: splitHands[i].cards, playerTotal: handTotal(splitHands[i].cards)
          })),
          totalNet, balanceAfter: lastBalance,
          message: `Split: ${labels.join(' / ')}`,
          currency: { symbol: sym, name: config.currency_name }
        });
      }

      // Advance to next split hand
      const sessionId = await saveState({ ...state, splitHands, currentHandIndex: nextIdx });
      return res.json({
        success:          true,
        status:           'active',
        playerCards:      splitHands[nextIdx].cards,
        dealerCards:      [dealerCards[0]],
        playerTotal:      handTotal(splitHands[nextIdx].cards),
        dealerVisible:    handTotal([dealerCards[0]]),
        splitHands:       splitHands.map(h => ({ cards: h.cards, total: handTotal(h.cards), result: h.result, wager: h.wager })),
        currentHandIndex: nextIdx,
        canDouble:        false,
        canSplit:         false,
        sessionId,
        currency:         { symbol: sym, name: config.currency_name }
      });
    }

    // ── STAND (non-split, and post-double) ───────────────────────────────────
    // Run dealer sequence then determine winner
    const finalDealerCards = runDealer(dealerCards);
    const playerTotal      = handTotal(playerCards);
    const dealerTotal      = handTotal(finalDealerCards);
    const { result, multiplier } = resolveBlackjack(playerCards, finalDealerCards);

    const handWager      = doubled ? wager * 2 : wager;
    const effectiveWager = totalBlackjackWager(state, handWager);
    const payout         = casinoPayout(handWager, multiplier);

    const newBalance = await settleCasinoBet(db, {
      identityId: parseInt(identityId), serverId: server.id,
      guildId: server.guild_id, gameType: 'blackjack',
      wager: effectiveWager, payout, result,
      resultData: { playerCards, dealerCards: finalDealerCards, playerTotal, dealerTotal, doubled },
      currencySymbol: sym,
      casinoSession: { binding, version: casinoSessionRow.version }
    });

    const messages = {
      win:  `🎉 You win! ${sym}${parseFloat(payout - effectiveWager).toFixed(2)}`,
      loss: `💸 Dealer wins. −${sym}${effectiveWager.toFixed(2)}`,
      push: `↩️ Push — wager returned`
    };

    return res.json({
      success:      true,
      status:       'complete',
      playerCards,
      dealerCards:  finalDealerCards,
      playerTotal,
      dealerTotal,
      result,
      net:          casinoNet(payout, effectiveWager),
      balanceAfter: newBalance,
      doubled,
      message:      messages[result] || '',
      currency:     { symbol: sym, name: config.currency_name }
    });
    });
    return sendIdempotentCasinoResponse(res, idempotentResult);

  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Casino blackjack error:', err);
    res.status(500).json({ error: 'Failed to process blackjack game' });
  }
});

// ── Horse Racing ──────────────────────────────────────────────────────────────

/**
 * Pool of funny horse names (puns + innuendos).
 * Six are drawn at random per race.
 */
const HR_HORSE_NAMES = [
  'Hairy Trotter',
  'Hoof Hearted',          // say it fast
  'Hung Like a Jockey',
  'Neigh Sayer',
  'Stable Genius',
  'Furlong Time No See',
  'Sir Loin of Beef',
  'Stud Finder',
  'Rear Admiral',
  'Filly McFillface',
  'Long and Hard to Beat',
  'Giddy Up Buttercup',
  'Mount Me Gently',
  'The Dark Neighs',
  'Canter Stop Me Now',
  'Big Package Express',
  'Two Fillies One Cup',
  'Wet Mane Morning',
  'My Little Phony',
  'Ride or Die',
  'Pasture Bedtime',
  'Unbridled Passion',
  'Jumpin Jack Ass',
  'Feeling Frisky',
  'Sir Cumference',
];

/**
 * Odds and weights per finishing tier (index = display order after shuffle).
 * Higher odds = higher payout but lower win probability.
 */
const HR_ODDS    = [2,  3,  5,  8,  12, 20];
const HR_WEIGHTS = [30, 20, 15, 12,  8,  5];


/**
 * Weighted random selection — returns index into the array.
 * @param {number[]} weights
 */
function weightedRandom(weights) {
  const total = weights.reduce((s, w) => s + w, 0);
  let r = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

/**
 * POST /api/casino/play/horse-racing
 *
 * action 'new-race':
 *   Body: { identityId, action: 'new-race' }
 *   Returns a freshly generated race (6 horses with names + odds) and a signed
 *   raceState the client must echo back when placing a bet.
 *
 * action 'place-bet':
 *   Body: { identityId, action: 'place-bet', wager, horseIndex, raceState }
 *   Verifies the signed race, runs the weighted-random race, settles the bet.
 */
router.post('/play/horse-racing', strictLimiter, ensureAuthenticated, async (req, res) => {
  const db = req.app.locals.db;
  const { identityId, action, wager: rawWager, horseIndex } = req.body;

  if (!identityId) return res.status(400).json({ error: 'identityId is required' });
  const HORSE_RACING_ACTIONS = ['new-race', 'place-bet'];
  if (!HORSE_RACING_ACTIONS.includes(action)) {
    return res.status(400).json({ error: `action must be one of: ${HORSE_RACING_ACTIONS.join(', ')}` });
  }

  try {
    const { identity, server } = await resolvePlayerContext(
      db, parseInt(identityId), req.playerServerAccess.serverId
    );
    const config = await getCasinoConfig(db, server.id);

    if (!config || !config.enabled)       return res.status(403).json({ error: 'Economy is not enabled for this community' });
    if (!config.casino_enabled)           return res.status(403).json({ error: 'Casino is not enabled for this community' });

    const sym = config.currency_symbol || '$';
    const horseRacingOperations = {
      'new-race': 'casino_horse_racing_new_race',
      'place-bet': 'casino_horse_racing_place_bet',
    };
    const idempotentResult = await runIdempotentCasinoRequest(db, req, {
      serverId: identity.server_id,
      identityId: parseInt(identityId),
      operation: horseRacingOperations[action],
      input: {
        action,
        sessionId: req.body.sessionId ?? null,
        wager: rawWager ?? null,
        horseIndex: horseIndex ?? null,
      },
    }, async transactionDb => {
      const db = transactionDb;
      const res = createIdempotentResponseRecorder();
      const settleCasinoBet = (_db, input) => settleCasinoBetInTransaction(transactionDb, input);

    // ── new-race ─────────────────────────────────────────────────────────────
    if (action === 'new-race') {
      // Shuffle the name pool and take 6 unique horses
      const shuffledNames = [...HR_HORSE_NAMES].sort(() => Math.random() - 0.5).slice(0, 6);

      // Assign internal "speed tier" randomly so display order ≠ odds order.
      // Each tier maps to HR_ODDS[tier] and HR_WEIGHTS[tier].
      const tiers = [0, 1, 2, 3, 4, 5].sort(() => Math.random() - 0.5);

      const horses = shuffledNames.map((name, i) => ({
        name,
        odds: HR_ODDS[tiers[i]],
        tier: tiers[i],          // stored in signed state, not sent to client
      }));

      const state = {
        horses: horses.map(h => ({ name: h.name, odds: h.odds, tier: h.tier })),
      };
      const sessionId = await createCasinoSession(
        db, req, 'horse_racing', parseInt(identityId), server, state, 15, 0,
        { inTransaction: true }
      );

      // Return horse names + odds to the client (no tiers exposed)
      return res.json({
        success:   true,
        horses:    horses.map(h => ({ name: h.name, odds: h.odds })),
        sessionId,
        currency:  { symbol: sym, name: config.currency_name },
      });
    }

    // ── place-bet ────────────────────────────────────────────────────────────
    if (action === 'place-bet') {
      const binding = sessionBinding(req, 'horse_racing', identityId, server);
      const casinoSessionRow = await readCasinoSession(db, binding, { inTransaction: true });
      const state = casinoSessionRow.state;

      const idx = parseInt(horseIndex);
      if (!Number.isInteger(idx) || idx < 0 || idx >= state.horses.length) {
        return res.status(400).json({ error: 'Invalid horse selection.' });
      }

      const { wager, error: wagerErr } = parseWager(rawWager, config);
      if (wagerErr) return res.status(400).json({ error: wagerErr });

      // Run the race: each horse's win weight is HR_WEIGHTS[horse.tier]
      const weights    = state.horses.map(h => HR_WEIGHTS[h.tier]);
      const winnerIdx  = weightedRandom(weights);
      const playerWon  = winnerIdx === idx;
      const playerHorse = state.horses[idx];

      // Payout: win → wager × odds + wager returned; loss → 0
      const payout = playerWon
        ? casinoPayout(wager, playerHorse.odds + 1)
        : 0;
      const result = playerWon ? 'win' : 'loss';
      const net    = casinoNet(payout, wager);

      const newBalance = await settleCasinoBet(db, {
        identityId:  parseInt(identityId),
        serverId:    server.id,
        guildId:     server.guild_id,
        gameType:    'horse_racing',
        wager,
        payout,
        result,
        resultData:  {
          horses:       state.horses.map(h => ({ name: h.name, odds: h.odds })),
          winnerIndex:  winnerIdx,
          winnerName:   state.horses[winnerIdx].name,
          playerHorse:  { name: playerHorse.name, odds: playerHorse.odds, index: idx },
        },
        currencySymbol: sym,
        casinoSession: { binding, version: casinoSessionRow.version },
      });

      return res.json({
        success:      true,
        horses:       state.horses.map(h => ({ name: h.name, odds: h.odds })),
        winnerIndex:  winnerIdx,
        winnerName:   state.horses[winnerIdx].name,
        playerHorse:  { name: playerHorse.name, odds: playerHorse.odds, index: idx },
        result,
        net,
        balanceAfter: newBalance,
        currency:     { symbol: sym, name: config.currency_name },
      });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
    });
    return sendIdempotentCasinoResponse(res, idempotentResult);

  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Casino horse-racing error:', err);
    res.status(500).json({ error: 'Failed to process horse racing game' });
  }
});

// ── Coursing ──────────────────────────────────────────────────────────────────

/**
 * Greyhound breed definitions.
 * Each breed has a stat profile (speed, stamina, agility) used in race simulation
 * and a baseOdds used as the starting point for dynamic odds computation.
 */
const COURSING_BREEDS = {
  Greyhound:       { speed: 9, stamina: 5, agility: 7, baseOdds: 2.5, emoji: '🐕' },
  Whippet:         { speed: 7, stamina: 6, agility: 9, baseOdds: 3.0, emoji: '🦮' },
  Borzoi:          { speed: 8, stamina: 6, agility: 6, baseOdds: 3.5, emoji: '🐕' },
  Saluki:          { speed: 6, stamina: 9, agility: 6, baseOdds: 4.0, emoji: '🐩' },
  'Irish Wolfhound': { speed: 7, stamina: 8, agility: 4, baseOdds: 4.5, emoji: '🐾' },
  'Afghan Hound':    { speed: 5, stamina: 7, agility: 5, baseOdds: 6.0, emoji: '🐕‍🦺' },
};

/** Dog name pools per breed — one is chosen at random on creation. */
const COURSING_DOG_NAMES = {
  Greyhound:       ['Rocket', 'Arrow', 'Flash', 'Bolt', 'Streak', 'Dart'],
  Whippet:         ['Zippy', 'Nimble', 'Breeze', 'Swift', 'Flicker', 'Gale'],
  Borzoi:          ['Czar', 'Rasputin', 'Ivan', 'Sasha', 'Natasha', 'Boris'],
  Saluki:          ['Sultan', 'Sahara', 'Mirage', 'Dune', 'Oasis', 'Sirocco'],
  'Irish Wolfhound': ['Finn', 'Sláine', 'Cú', 'Fergus', 'Brigid', 'Niall'],
  'Afghan Hound':    ['Kabul', 'Sheba', 'Noor', 'Reza', 'Zara', 'Amir'],
};

/** Compute level (1–10) from accumulated XP. */
function coursingLevel(xp) {
  return Math.min(Math.floor(xp / 100) + 1, 10);
}

/**
 * Compute the dynamic odds for a dog based on its breed and current level.
 * Higher-level dogs are better known, so odds compress toward the base.
 * Level 1 → odds * 1.5; Level 10 → odds * 0.85 (roughly).
 */
function coursingOdds(breed, level) {
  const profile = COURSING_BREEDS[breed];
  if (!profile) return 5.0;
  const multiplier = 1.6 - level * 0.075;
  return parseFloat((profile.baseOdds * multiplier).toFixed(2));
}

/**
 * Simulate a race.  Returns dogs sorted by finishing position (best first),
 * each decorated with finishPosition (1-based) and score.
 *
 * Score = breed stats weighted sum + level bonus + random variance
 */
function coursingRunRace(dogs) {
  const scored = dogs.map(dog => {
    const profile = COURSING_BREEDS[dog.breed] || { speed: 6, stamina: 6, agility: 6 };
    const level   = coursingLevel(dog.xp);
    const score   = profile.speed  * 10
                  + profile.stamina * 6
                  + profile.agility * 4
                  + level * 5
                  + (Math.random() * 40 - 20); // ± 20 variance
    return { ...dog, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.map((dog, i) => ({ ...dog, finishPosition: i + 1 }));
}

/**
 * Ensure the guild has one active dog per breed.
 * If any breed is missing (fresh guild or after retirement), insert a new dog.
 */
async function ensureGuildDogs(db, guildId) {
  const existing = await db.all(
    'SELECT breed FROM coursing_dogs WHERE guild_id = ? AND is_retired = false',
    [guildId]
  );
  const presentBreeds = new Set(existing.map(r => r.breed));

  for (const breed of Object.keys(COURSING_BREEDS)) {
    if (!presentBreeds.has(breed)) {
      const names  = COURSING_DOG_NAMES[breed] || ['Rex'];
      const name   = names[Math.floor(Math.random() * names.length)];
      await db.run(
        `INSERT INTO coursing_dogs (guild_id, name, breed) VALUES (?, ?, ?)`,
        [guildId, name, breed]
      );
    }
  }
}

/**
 * POST /api/casino/play/coursing
 *
 * action 'new-race':
 *   Body: { identityId, action: 'new-race' }
 *   Returns the guild's 6 dogs with current stats/odds and a signed raceState.
 *
 * action 'place-bet':
 *   Body: { identityId, action: 'place-bet', wager, dogId, raceState }
 *   Runs the race, settles the bet, updates dog XP and handles retirement.
 */
router.post('/play/coursing', strictLimiter, ensureAuthenticated, async (req, res) => {
  const db = req.app.locals.db;
  const { identityId, action, wager: rawWager, dogId } = req.body;

  if (!identityId) return res.status(400).json({ error: 'identityId is required' });
  const COURSING_ACTIONS = ['new-race', 'place-bet'];
  if (!COURSING_ACTIONS.includes(action)) {
    return res.status(400).json({ error: `action must be one of: ${COURSING_ACTIONS.join(', ')}` });
  }

  try {
    const { identity, server } = await resolvePlayerContext(
      db, parseInt(identityId), req.playerServerAccess.serverId
    );
    const config = await getCasinoConfig(db, server.id);

    if (!config || !config.enabled)  return res.status(403).json({ error: 'Economy is not enabled for this community' });
    if (!config.casino_enabled)      return res.status(403).json({ error: 'Casino is not enabled for this community' });

    const sym      = config.currency_symbol || '$';
    const guildId  = server.guild_id;
    const coursingOperations = {
      'new-race': 'casino_coursing_new_race',
      'place-bet': 'casino_coursing_place_bet',
    };
    const idempotentResult = await runIdempotentCasinoRequest(db, req, {
      serverId: identity.server_id,
      identityId: parseInt(identityId),
      operation: coursingOperations[action],
      input: {
        action,
        sessionId: req.body.sessionId ?? null,
        wager: rawWager ?? null,
        dogId: dogId ?? null,
      },
    }, async transactionDb => {
      const db = transactionDb;
      const res = createIdempotentResponseRecorder();
      const settleCasinoBet = (_db, input) => settleCasinoBetInTransaction(transactionDb, input);

    // ── new-race ─────────────────────────────────────────────────────────────
    if (action === 'new-race') {
      await ensureGuildDogs(db, guildId);

      const rows = await db.all(
        `SELECT id, name, breed, xp, wins, losses, races, generation
         FROM coursing_dogs
         WHERE guild_id = ? AND is_retired = false
         ORDER BY id`,
        [guildId]
      );

      const dogs = rows.map(dog => {
        const level = coursingLevel(dog.xp);
        const odds  = coursingOdds(dog.breed, level);
        return {
          id:         dog.id,
          name:       dog.name,
          breed:      dog.breed,
          emoji:      COURSING_BREEDS[dog.breed]?.emoji || '🐕',
          level,
          xp:         dog.xp,
          xpToNext:   level < 10 ? 100 - (dog.xp % 100) : 0,
          wins:       dog.wins,
          losses:     dog.losses,
          races:      dog.races,
          generation: dog.generation,
          odds,
        };
      });

      const state = { dogIds: dogs.map(d => d.id) };
      const sessionId = await createCasinoSession(
        db, req, 'coursing', parseInt(identityId), server, state, 15, 0,
        { inTransaction: true }
      );

      return res.json({
        success:   true,
        dogs,
        sessionId,
        currency:  { symbol: sym, name: config.currency_name },
      });
    }

    // ── place-bet ────────────────────────────────────────────────────────────
    if (action === 'place-bet') {
      const binding = sessionBinding(req, 'coursing', identityId, server);
      const casinoSessionRow = await readCasinoSession(db, binding, { inTransaction: true });
      const state = casinoSessionRow.state;

      const betDogId = parseInt(dogId);
      if (!state.dogIds.includes(betDogId)) {
        return res.status(400).json({ error: 'Invalid dog selection.' });
      }

      const { wager, error: wagerErr } = parseWager(rawWager, config);
      if (wagerErr) return res.status(400).json({ error: wagerErr });

      // Fetch fresh dog records for the race
      const rows = await db.all(
        `SELECT id, name, breed, xp, wins, losses, races, generation
         FROM coursing_dogs
         WHERE id IN (${state.dogIds.map(() => '?').join(',')})`,
        state.dogIds
      );

      const dogs   = rows;
      const results = coursingRunRace(dogs);

      const playerDog = results.find(d => d.id === betDogId);
      const playerWon = playerDog.finishPosition === 1;
      const dogOdds   = coursingOdds(playerDog.breed, coursingLevel(playerDog.xp));

      const payout = playerWon
        ? casinoPayout(wager, dogOdds + 1)
        : 0;
      const result = playerWon ? 'win' : 'loss';
      const net    = casinoNet(payout, wager);

      const newBalance = await settleCasinoBet(db, {
        identityId:  parseInt(identityId),
        serverId:    server.id,
        guildId,
        gameType:    'coursing',
        wager,
        payout,
        result,
        resultData:  {
          dogs:          results.map(d => ({ id: d.id, name: d.name, breed: d.breed, position: d.finishPosition })),
          selectedDogId: betDogId,
          selectedDog:   { name: playerDog.name, breed: playerDog.breed, odds: dogOdds, position: playerDog.finishPosition },
        },
        currencySymbol: sym,
        casinoSession: { binding, version: casinoSessionRow.version },
      });

      // Update XP, wins/losses, races for all dogs
      const retiredDogs = [];
      const dogUpdates  = [];

      for (const dog of results) {
        const xpGain    = dog.id === betDogId && playerWon ? 50 : 10;
        const newXp     = dog.xp + xpGain;
        const didWin    = dog.finishPosition === 1 ? 1 : 0;
        const willRetire = newXp >= 1000;

        await db.run(
          `UPDATE coursing_dogs
           SET xp = ?, wins = wins + ?, losses = losses + ?, races = races + 1,
               is_retired = ?
           WHERE id = ?`,
          [Math.min(newXp, 999), didWin, didWin ? 0 : 1, willRetire, dog.id]
        );

        dogUpdates.push({
          id:           dog.id,
          name:         dog.name,
          breed:        dog.breed,
          xpGained:     xpGain,
          newXp:        Math.min(newXp, 999),
          newLevel:     coursingLevel(Math.min(newXp, 999)),
          finishPosition: dog.finishPosition,
          retired:      willRetire,
        });

        if (willRetire) {
          retiredDogs.push({ name: dog.name, breed: dog.breed, races: dog.races + 1, generation: dog.generation });
        }
      }

      // Spawn replacement dogs for any that just retired
      for (const retired of retiredDogs) {
        const names = COURSING_DOG_NAMES[retired.breed] || ['Rex'];
        const name  = names[Math.floor(Math.random() * names.length)];
        await db.run(
          `INSERT INTO coursing_dogs (guild_id, name, breed, generation)
           VALUES (?, ?, ?, ?)`,
          [guildId, name, retired.breed, retired.generation + 1]
        );
      }

      return res.json({
        success:      true,
        results:      results.map(d => ({
          id:             d.id,
          name:           d.name,
          breed:          d.breed,
          emoji:          COURSING_BREEDS[d.breed]?.emoji || '🐕',
          finishPosition: d.finishPosition,
          odds:           coursingOdds(d.breed, coursingLevel(d.xp)),
        })),
        dogUpdates,
        retiredDogs,
        selectedDog:  { name: playerDog.name, breed: playerDog.breed, odds: dogOdds, position: playerDog.finishPosition },
        result,
        net,
        balanceAfter: newBalance,
        currency:     { symbol: sym, name: config.currency_name },
      });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
    });
    return sendIdempotentCasinoResponse(res, idempotentResult);

  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Casino coursing error:', err);
    res.status(500).json({ error: 'Failed to process coursing game' });
  }
});

// ─── Baccarat ─────────────────────────────────────────────────────────────────

const BACCARAT_RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
const BACCARAT_SUITS = ['S','H','D','C'];

/** Value of a single baccarat card (10/J/Q/K = 0, A = 1, others face value). */
function baccaratCardValue(rank) {
  if (['10','J','Q','K'].includes(rank)) return 0;
  if (rank === 'A') return 1;
  return parseInt(rank, 10);
}

/** Baccarat hand total = sum of card values mod 10. */
function baccaratTotal(cards) {
  return cards.reduce((sum, c) => sum + baccaratCardValue(c.rank), 0) % 10;
}

function baccaratCreateDeck(numDecks = 8) {
  const deck = [];
  for (let d = 0; d < numDecks; d++) {
    for (const suit of BACCARAT_SUITS) {
      for (const rank of BACCARAT_RANKS) {
        deck.push({ rank, suit });
      }
    }
  }
  return deck;
}

function baccaratShuffle(deck) {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

/**
 * Run a complete baccarat hand using Punto Banco fixed drawing rules.
 *
 * Player draws on 0–5; stands on 6–7.
 * Banker drawing depends on total and, if player drew a third card, its value.
 *
 * Returns { playerCards, bankerCards, playerTotal, bankerTotal, winner }.
 * winner: 'player' | 'banker' | 'tie'
 */
function playBaccaratHand() {
  const deck = baccaratShuffle(baccaratCreateDeck(8));
  let pos = 0;
  const draw = () => deck[pos++];

  const playerCards = [draw(), draw()];
  const bankerCards = [draw(), draw()];

  let playerThird = null;
  let bankerThird = null;

  const pTotal = baccaratTotal(playerCards);
  const bTotal = baccaratTotal(bankerCards);

  // Natural — no more draws
  if (pTotal >= 8 || bTotal >= 8) {
    const winner = pTotal > bTotal ? 'player' : bTotal > pTotal ? 'banker' : 'tie';
    return { playerCards, bankerCards, playerTotal: pTotal, bankerTotal: bTotal, winner, natural: true };
  }

  // Player drawing rule
  if (pTotal <= 5) {
    playerThird = draw();
    playerCards.push(playerThird);
  }

  // Banker drawing rule (depends on whether player drew)
  const pFinal = baccaratTotal(playerCards);
  const bFinal = baccaratTotal(bankerCards); // unchanged so far

  if (playerThird === null) {
    // Player stood — banker draws on 0-5
    if (bFinal <= 5) {
      bankerThird = draw();
      bankerCards.push(bankerThird);
    }
  } else {
    const ptv = baccaratCardValue(playerThird.rank);
    if (bFinal <= 2) {
      bankerThird = draw();
      bankerCards.push(bankerThird);
    } else if (bFinal === 3 && ptv !== 8) {
      bankerThird = draw();
      bankerCards.push(bankerThird);
    } else if (bFinal === 4 && [2,3,4,5,6,7].includes(ptv)) {
      bankerThird = draw();
      bankerCards.push(bankerThird);
    } else if (bFinal === 5 && [4,5,6,7].includes(ptv)) {
      bankerThird = draw();
      bankerCards.push(bankerThird);
    } else if (bFinal === 6 && [6,7].includes(ptv)) {
      bankerThird = draw();
      bankerCards.push(bankerThird);
    }
    // bFinal === 7: always stand
  }

  const finalPlayer = baccaratTotal(playerCards);
  const finalBanker = baccaratTotal(bankerCards);
  const winner = finalPlayer > finalBanker ? 'player'
               : finalBanker > finalPlayer ? 'banker'
               : 'tie';

  return {
    playerCards,
    bankerCards,
    playerTotal: finalPlayer,
    bankerTotal: finalBanker,
    winner,
    natural: false,
  };
}

/**
 * POST /api/casino/play/baccarat
 *
 * Punto Banco baccarat — entire hand resolves in a single request.
 * No player decisions are made after the bet; drawing is fully automatic.
 *
 * betType: 'player' | 'banker' | 'tie'
 *
 * Payouts:
 *   Player wins  → Player bet 1:1 · Banker/Tie bets lose
 *   Banker wins  → Banker bet 0.95:1 (5% commission) · Player/Tie bets lose
 *   Tie          → Tie bet 8:1 · Player/Banker bets push (returned)
 *
 * Body: { identityId, wager, betType }
 */
router.post('/play/baccarat', strictLimiter, ensureAuthenticated, async (req, res) => {
  const db = req.app.locals.db;
  const { identityId, wager: rawWager, betType } = req.body;

  if (!identityId) return res.status(400).json({ error: 'identityId is required' });

  const VALID_BET_TYPES = ['player', 'banker', 'tie'];
  if (!VALID_BET_TYPES.includes(betType)) {
    return res.status(400).json({ error: "betType must be 'player', 'banker', or 'tie'" });
  }

  try {
    const { identity, server } = await resolvePlayerContext(
      db, parseInt(identityId), req.playerServerAccess.serverId
    );
    const config = await getCasinoConfig(db, server.id);

    if (!config || !config.enabled)  return res.status(403).json({ error: 'Economy is not enabled for this community' });
    if (!config.casino_enabled)      return res.status(403).json({ error: 'Casino is not enabled for this community' });

    const { wager, error: wagerErr } = parseWager(rawWager, config);
    if (wagerErr) return res.status(400).json({ error: wagerErr });

    const sym = config.currency_symbol || '$';
    const idempotentResult = await runIdempotentCasinoRequest(db, req, {
      serverId: identity.server_id,
      identityId: parseInt(identityId),
      operation: 'casino_baccarat',
      input: { wagerCents: parseCents(wager, 'Wager'), betType },
    }, async transactionDb => {
      const hand = playBaccaratHand();
      const { playerCards, bankerCards, playerTotal, bankerTotal, winner, natural } = hand;

      let payout = 0;
      let result = 'loss';
      let message = '';

      if (winner === 'tie') {
        if (betType === 'tie') {
          payout = casinoPayout(wager, 9);
          result = 'win';
          message = `🎉 Tie! ${playerTotal}–${bankerTotal}. Tie bet pays 8:1!`;
        } else {
          payout = wager;
          result = 'push';
          message = `🤝 Tie! ${playerTotal}–${bankerTotal}. Bet returned.`;
        }
      } else if (winner === 'player') {
        if (betType === 'player') {
          payout = casinoPayout(wager, 2);
          result = 'win';
          message = `🎉 Player wins ${playerTotal}–${bankerTotal}!${natural ? ' Natural!' : ''}`;
        } else {
          result = 'loss';
          message = `💸 Player wins ${playerTotal}–${bankerTotal}.${natural ? ' Natural.' : ''}`;
        }
      } else if (betType === 'banker') {
        payout = casinoPayout(wager, 1.95);
        result = 'win';
        message = `🎉 Banker wins ${bankerTotal}–${playerTotal}!${natural ? ' Natural!' : ''} (5% commission applied)`;
      } else {
        result = 'loss';
        message = `💸 Banker wins ${bankerTotal}–${playerTotal}.${natural ? ' Natural.' : ''}`;
      }

      const newBalance = await settleCasinoBet(transactionDb, {
        identityId:     parseInt(identityId),
        serverId:       identity.server_id,
        guildId:        server.guild_id,
        gameType:       'baccarat',
        wager,
        payout,
        result,
        resultData:     { betType, winner, playerTotal, bankerTotal, natural, playerCards, bankerCards },
        currencySymbol: sym,
        actorUserId: req.user.id,
      }, { inTransaction: true });

      return {
        success:      true,
        winner,
        natural,
        betType,
        result,
        wins:         result === 'win',
        playerCards,
        bankerCards,
        playerTotal,
        bankerTotal,
        payout,
        net:          casinoNet(payout, wager),
        wager,
        balanceAfter: newBalance,
        message,
        currency:     { symbol: sym, name: config.currency_name },
      };
    });
    return sendIdempotentCasinoResponse(res, idempotentResult);

  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Casino baccarat error:', err);
    res.status(500).json({ error: 'Failed to process baccarat hand' });
  }
});

// ─── Craps ────────────────────────────────────────────────────────────────────

/**
 * Roll two six-sided dice. Returns { d1, d2, total }.
 */
function rollDice() {
  const d1 = Math.floor(Math.random() * 6) + 1;
  const d2 = Math.floor(Math.random() * 6) + 1;
  return { d1, d2, total: d1 + d2 };
}


/**
 * POST /api/casino/play/craps
 *
 * Standard Pass Line craps — two actions:
 *
 *   come_out   — place wager + choose betType ('pass' or 'dont_pass'), roll dice.
 *                7/11 → Pass wins; 2/3 → Don't Pass wins; 12 → Don't Pass push;
 *                4/5/6/8/9/10 → point established, return signed gameState.
 *
 *   point_roll — roll dice with signed gameState.
 *                Hit point → Pass wins; 7-out → Don't Pass wins; else continue.
 *
 * Body:
 *   come_out:   { identityId, action:'come_out', wager, betType:'pass'|'dont_pass' }
 *   point_roll: { identityId, action:'point_roll', gameState }
 *
 * Returns on intermediate roll: { status:'point', point, d1, d2, total, gameState }
 * Returns on completion:        { status:'complete', result, wins, payout, net, balanceAfter, … }
 */
router.post('/play/craps', strictLimiter, ensureAuthenticated, async (req, res) => {
  const db = req.app.locals.db;
  const { identityId, action, wager: rawWager, betType } = req.body;

  if (!identityId) return res.status(400).json({ error: 'identityId is required' });

  const VALID_ACTIONS = ['come_out', 'point_roll'];
  if (!VALID_ACTIONS.includes(action)) {
    return res.status(400).json({ error: `action must be one of: ${VALID_ACTIONS.join(', ')}` });
  }

  try {
    const { identity, server } = await resolvePlayerContext(
      db, parseInt(identityId), req.playerServerAccess.serverId
    );
    const config = await getCasinoConfig(db, server.id);

    if (!config || !config.enabled)  return res.status(403).json({ error: 'Economy is not enabled for this community' });
    if (!config.casino_enabled)      return res.status(403).json({ error: 'Casino is not enabled for this community' });

    const sym = config.currency_symbol || '$';

    // ── COME-OUT ROLL ──────────────────────────────────────────────────────────
    if (action === 'come_out') {
      const VALID_BET_TYPES = ['pass', 'dont_pass'];
      if (!VALID_BET_TYPES.includes(betType)) {
        return res.status(400).json({ error: "betType must be 'pass' or 'dont_pass'" });
      }

      const { wager, error: wagerErr } = parseWager(rawWager, config);
      if (wagerErr) return res.status(400).json({ error: wagerErr });

      const idempotentResult = await runIdempotentCasinoRequest(db, req, {
        serverId: identity.server_id,
        identityId: parseInt(identityId),
        operation: 'casino_craps_come_out',
        input: { wagerCents: parseCents(wager, 'Wager'), betType },
      }, async transactionDb => {
        const { d1, d2, total } = rollDice();
        let status = null;
        let result = null;
        let wins = false;
        let message = '';

        if (betType === 'pass') {
          if (total === 7 || total === 11) {
            status = 'complete'; result = 'win'; wins = true;
            message = `🎉 Natural ${total}! Pass Line wins!`;
          } else if (total === 2 || total === 3 || total === 12) {
            status = 'complete'; result = 'loss';
            message = `💸 Craps ${total}. Pass Line loses.`;
          } else {
            status = 'point';
            message = `Point is ${total} — roll again to hit it before a 7!`;
          }
        } else if (total === 7 || total === 11) {
          status = 'complete'; result = 'loss';
          message = `💸 Natural ${total}. Don't Pass loses.`;
        } else if (total === 2 || total === 3) {
          status = 'complete'; result = 'win'; wins = true;
          message = `🎉 Craps ${total}! Don't Pass wins!`;
        } else if (total === 12) {
          status = 'complete'; result = 'push';
          message = `🤝 Twelve — Don't Pass push. Bet returned.`;
        } else {
          status = 'point';
          message = `Point is ${total} — 7-out wins for Don't Pass!`;
        }

        if (status === 'complete') {
          const payout = result === 'win' ? casinoPayout(wager, 2)
            : result === 'push' ? wager : 0;
          const newBalance = await settleCasinoBet(transactionDb, {
            identityId: parseInt(identityId),
            serverId: identity.server_id,
            guildId: server.guild_id,
            gameType: 'craps',
            wager,
            payout,
            result,
            resultData: { phase: 'come_out', betType, d1, d2, total, message },
            currencySymbol: sym,
            actorUserId: req.user.id,
          }, { inTransaction: true });
          return {
            success: true,
            status: 'complete',
            phase: 'come_out',
            result,
            wins,
            d1, d2, total,
            payout: parseFloat(payout.toFixed(2)),
            net: casinoNet(payout, wager),
            wager,
            balanceAfter: newBalance,
            message,
            currency: { symbol: sym, name: config.currency_name },
          };
        }

        const state = { wager, betType, point: total };
        const sessionId = await createCasinoSession(
          transactionDb, req, 'craps', parseInt(identityId), server, state, 15, wager,
          { inTransaction: true }
        );
        return {
          success: true,
          status: 'point',
          phase: 'come_out',
          point: total,
          d1, d2, total,
          wager,
          sessionId,
          message,
          currency: { symbol: sym, name: config.currency_name },
        };
      });
      return sendIdempotentCasinoResponse(res, idempotentResult);
    }

    // ── POINT ROLL ─────────────────────────────────────────────────────────────
    if (action === 'point_roll') {
      const idempotentResult = await runIdempotentCasinoRequest(db, req, {
        serverId: identity.server_id,
        identityId: parseInt(identityId),
        operation: 'casino_craps_point_roll',
        input: { action, sessionId: req.body.sessionId },
      }, async transactionDb => {
        const db = transactionDb;
        const res = createIdempotentResponseRecorder();
        const settleCasinoBet = (_db, input) => settleCasinoBetInTransaction(transactionDb, input);
      const binding = sessionBinding(req, 'craps', identityId, server);
      const casinoSessionRow = await readCasinoSession(db, binding, { inTransaction: true });
      const state = casinoSessionRow.state;

      const { d1, d2, total } = rollDice();
      const { point, wager, betType } = state;

      let status  = 'rolling'; // continues
      let result  = null;
      let wins    = false;
      let message = '';

      if (total === point) {
        // Hit the point
        if (betType === 'pass') {
          status = 'complete'; result = 'win'; wins = true;
          message = `🎉 Point ${point} hit! Pass Line wins!`;
        } else {
          status = 'complete'; result = 'loss'; wins = false;
          message = `💸 Point ${point} hit. Don't Pass loses.`;
        }
      } else if (total === 7) {
        // Seven-out
        if (betType === 'pass') {
          status = 'complete'; result = 'loss'; wins = false;
          message = `💸 Seven out! Pass Line loses.`;
        } else {
          status = 'complete'; result = 'win'; wins = true;
          message = `🎉 Seven out! Don't Pass wins!`;
        }
      } else {
        // Neither point nor 7 — keep rolling
        message = `Rolled ${total} — neither ${point} nor 7. Roll again!`;
      }

      if (status === 'complete') {
        const payout     = result === 'win'  ? casinoPayout(wager, 2) : 0;
        const newBalance = await settleCasinoBet(db, {
          identityId:     parseInt(identityId),
          serverId:       server.id,
          guildId:        server.guild_id,
          gameType:       'craps',
          wager,
          payout,
          result,
          resultData:     { phase: 'point', betType, point, d1, d2, total, message },
          currencySymbol: sym,
          casinoSession:  { binding, version: casinoSessionRow.version },
        });

        return res.json({
          success:      true,
          status:       'complete',
          phase:        'point',
          result,
          wins,
          d1, d2, total,
          point,
          payout:       parseFloat(payout.toFixed(2)),
          net:          casinoNet(payout, wager),
          wager,
          balanceAfter: newBalance,
          message,
          currency:     { symbol: sym },
        });
      }

      await advanceCasinoSession(
        db, binding, casinoSessionRow.version, state, { inTransaction: true }
      );

      return res.json({
        success:   true,
        status:    'rolling',
        phase:     'point',
        point,
        d1, d2, total,
        wager,
        sessionId: binding.sessionId,
        message,
        currency:  { symbol: sym },
      });
      });
      return sendIdempotentCasinoResponse(res, idempotentResult);
    }

  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Casino craps error:', err);
    res.status(500).json({ error: 'Failed to process craps roll' });
  }
});

// ─── Texas Hold'em (Casino Hold'em — Player vs House) ────────────────────────

const HOLDEM_RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const HOLDEM_SUITS = ['S','H','D','C'];

// Rank values: 2=2 … A=14
function holdemRankValue(rank) {
  return HOLDEM_RANKS.indexOf(rank) + 2;
}

function holdemCreateDeck() {
  const deck = [];
  for (const suit of HOLDEM_SUITS) {
    for (const rank of HOLDEM_RANKS) {
      deck.push({ rank, suit });
    }
  }
  return deck;
}

function holdemShuffleDeck(deck) {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

/** All k-size combinations of an array. */
function combinations(arr, k) {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const [first, ...rest] = arr;
  return [
    ...combinations(rest, k - 1).map(c => [first, ...c]),
    ...combinations(rest, k),
  ];
}

/**
 * Evaluate a 5-card hand.
 * Returns { rank (0–8), name, tiebreakers }
 *   0 High Card · 1 Pair · 2 Two Pair · 3 Trips · 4 Straight
 *   5 Flush · 6 Full House · 7 Quads · 8 Straight Flush (incl. Royal)
 */
function evaluate5CardHand(cards) {
  const values  = cards.map(c => holdemRankValue(c.rank)).sort((a, b) => b - a);
  const suits   = cards.map(c => c.suit);
  const isFlush = suits.every(s => s === suits[0]);

  // Count frequency of each rank value
  const counts = {};
  for (const v of values) counts[v] = (counts[v] || 0) + 1;
  const groups = Object.entries(counts)
    .map(([v, n]) => ({ v: parseInt(v), n }))
    .sort((a, b) => b.n - a.n || b.v - a.v);

  function checkStraight(vals) {
    const uniq = [...new Set(vals)].sort((a, b) => b - a);
    if (uniq.length !== 5) return null;
    if (uniq[0] - uniq[4] === 4) return uniq[0];
    // Ace-low straight (A-2-3-4-5): treat high card as 5
    if (uniq[0] === 14 && uniq[1] === 5 && uniq[2] === 4 && uniq[3] === 3 && uniq[4] === 2) return 5;
    return null;
  }

  const straightHigh = checkStraight(values);

  if (isFlush && straightHigh !== null) {
    return { rank: 8, name: straightHigh === 14 ? 'Royal Flush' : 'Straight Flush', tiebreakers: [straightHigh] };
  }
  if (groups[0].n === 4) {
    return { rank: 7, name: 'Four of a Kind',  tiebreakers: [groups[0].v, groups[1].v] };
  }
  if (groups[0].n === 3 && groups[1].n === 2) {
    return { rank: 6, name: 'Full House',       tiebreakers: [groups[0].v, groups[1].v] };
  }
  if (isFlush) {
    return { rank: 5, name: 'Flush',            tiebreakers: values };
  }
  if (straightHigh !== null) {
    return { rank: 4, name: 'Straight',         tiebreakers: [straightHigh] };
  }
  if (groups[0].n === 3) {
    return { rank: 3, name: 'Three of a Kind',  tiebreakers: [groups[0].v, ...values.filter(v => v !== groups[0].v)] };
  }
  if (groups[0].n === 2 && groups[1].n === 2) {
    const hi = Math.max(groups[0].v, groups[1].v);
    const lo = Math.min(groups[0].v, groups[1].v);
    return { rank: 2, name: 'Two Pair',         tiebreakers: [hi, lo, groups[2].v] };
  }
  if (groups[0].n === 2) {
    return { rank: 1, name: 'One Pair',         tiebreakers: [groups[0].v, ...values.filter(v => v !== groups[0].v)] };
  }
  return { rank: 0, name: 'High Card',          tiebreakers: values };
}

/** Best 5-card hand from 7 (2 hole + 5 community). */
function holdemBestHand(cards) {
  return combinations(cards, 5)
    .map(c => evaluate5CardHand(c))
    .sort((a, b) => {
      if (a.rank !== b.rank) return b.rank - a.rank;
      for (let i = 0; i < Math.max(a.tiebreakers.length, b.tiebreakers.length); i++) {
        const diff = (b.tiebreakers[i] || 0) - (a.tiebreakers[i] || 0);
        if (diff !== 0) return diff;
      }
      return 0;
    })[0];
}

/**
 * Compare two evaluated hands.
 * Returns 1 if a wins, -1 if b wins, 0 for a push.
 */
function compareHoldemHands(a, b) {
  if (a.rank !== b.rank) return a.rank > b.rank ? 1 : -1;
  for (let i = 0; i < Math.max(a.tiebreakers.length, b.tiebreakers.length); i++) {
    const diff = (a.tiebreakers[i] || 0) - (b.tiebreakers[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Dealer qualifies if their best hand is a pair of 4s or better.
 * (Standard Casino Hold'em rule.)
 */
function holdemDealerQualifies(hand) {
  if (hand.rank > 1) return true;
  if (hand.rank === 1) return hand.tiebreakers[0] >= 4; // pair of 4s or higher
  return false;
}


/**
 * POST /api/casino/play/holdem
 *
 * Casino Hold'em: player vs house. Three actions:
 *   deal  — post Ante, receive 2 hole cards + 3 community (flop)
 *   call  — pay 2× Ante; turn & river dealt; best hand wins
 *   fold  — forfeit the Ante
 *
 * Payouts when dealer qualifies and player wins: Ante 1:1, Call 1:1.
 * When dealer doesn't qualify: Ante 1:1, Call is a push.
 * Push: all money returned. Loss: all money lost.
 *
 * Body: { identityId, action, wager (deal only), gameState (call/fold) }
 */
router.post('/play/holdem', strictLimiter, ensureAuthenticated, async (req, res) => {
  const db = req.app.locals.db;
  const { identityId, action, wager: rawWager } = req.body;

  if (!identityId) return res.status(400).json({ error: 'identityId is required' });

  const VALID_ACTIONS = ['deal', 'call', 'fold'];
  if (!VALID_ACTIONS.includes(action)) {
    return res.status(400).json({ error: `action must be one of: ${VALID_ACTIONS.join(', ')}` });
  }

  try {
    const { identity, server } = await resolvePlayerContext(
      db, parseInt(identityId), req.playerServerAccess.serverId
    );
    const config = await getCasinoConfig(db, server.id);

    if (!config || !config.enabled)  return res.status(403).json({ error: 'Economy is not enabled for this community' });
    if (!config.casino_enabled)      return res.status(403).json({ error: 'Casino is not enabled for this community' });

    const sym = config.currency_symbol || '$';

    // ── DEAL ──────────────────────────────────────────────────────────────────
    if (action === 'deal') {
      const { wager, error: wagerErr } = parseWager(rawWager, config);
      if (wagerErr) return res.status(400).json({ error: wagerErr });

      const idempotentResult = await runIdempotentCasinoRequest(db, req, {
        serverId: identity.server_id,
        identityId: parseInt(identityId),
        operation: 'casino_holdem_deal',
        input: { wagerCents: parseCents(wager, 'Wager') },
      }, async transactionDb => {
        const wallet = await getOrCreateWallet(transactionDb, parseInt(identityId), server.id);
        if ((parseFloat(wallet.cash_on_hand) || 0) < wager) {
          const error = new Error('Insufficient funds for ante');
          error.status = 400;
          throw error;
        }

        const deck = holdemShuffleDeck(holdemCreateDeck());
        const pHole = [deck.pop(), deck.pop()];
        const dHole = [deck.pop(), deck.pop()];
        const community = [deck.pop(), deck.pop(), deck.pop()];
        const state = {
          ante: wager,
          deck,
          playerHole: pHole,
          dealerHole: dHole,
          community,
        };
        const sessionId = await createCasinoSession(
          transactionDb, req, 'holdem', parseInt(identityId), server, state, 5, state.ante,
          { inTransaction: true }
        );
        return {
          success: true,
          status: 'active',
          playerHole: pHole,
          community,
          ante: wager,
          sessionId,
          currency: { symbol: sym, name: config.currency_name },
        };
      });
      return sendIdempotentCasinoResponse(res, idempotentResult);
    }

    const holdemContinuationOperations = {
      call: 'casino_holdem_call',
      fold: 'casino_holdem_fold',
    };
    const idempotentResult = await runIdempotentCasinoRequest(db, req, {
      serverId: identity.server_id,
      identityId: parseInt(identityId),
      operation: holdemContinuationOperations[action],
      input: { action, sessionId: req.body.sessionId },
    }, async transactionDb => {
      const db = transactionDb;
      const res = createIdempotentResponseRecorder();
      const settleCasinoBet = (_db, input) => settleCasinoBetInTransaction(transactionDb, input);

    // ── CALL / FOLD ────────────────────────────────────────────────────────────
    const binding = sessionBinding(req, 'holdem', identityId, server);
    const casinoSessionRow = await readCasinoSession(db, binding, { inTransaction: true });
    const state = casinoSessionRow.state;

    // ── FOLD ──────────────────────────────────────────────────────────────────
    if (action === 'fold') {
      const newBalance = await settleCasinoBet(db, {
        identityId:     parseInt(identityId),
        serverId:       server.id,
        guildId:        server.guild_id,
        gameType:       'holdem',
        wager:          state.ante,
        payout:         0,
        result:         'loss',
        resultData:     { action: 'fold', ante: state.ante, community: state.community },
        currencySymbol: sym,
        casinoSession: { binding, version: casinoSessionRow.version },
      });

      return res.json({
        success:      true,
        status:       'complete',
        outcome:      'fold',
        result:       'loss',
        wins:         false,
        payout:       0,
        net:          -state.ante,
        balanceAfter: newBalance,
        ante:         state.ante,
        playerHole:   state.playerHole,
        dealerHole:   state.dealerHole,
        community:    state.community,
        currency:     { symbol: sym },
      });
    }

    // ── CALL ──────────────────────────────────────────────────────────────────
    if (action === 'call') {
      const callBet   = casinoPayout(state.ante, 2);
      const totalRisk = casinoSum(state.ante, callBet);

      // Deal turn and river from the signed deck
      const deck      = [...state.deck];
      const turn      = deck.pop();
      const river     = deck.pop();
      const community = [...state.community, turn, river]; // 5 community cards

      const playerBest  = holdemBestHand([...state.playerHole, ...community]);
      const dealerBest  = holdemBestHand([...state.dealerHole, ...community]);
      const qualifies   = holdemDealerQualifies(dealerBest);
      const comparison  = compareHoldemHands(playerBest, dealerBest);

      let payout  = 0;
      let result  = 'loss';
      let outcome = 'dealer_wins';

      if (!qualifies) {
        // Dealer doesn't qualify: Ante 1:1, Call is a push
        payout  = casinoSum(casinoPayout(state.ante, 2), callBet);
        result  = 'win';
        outcome = 'no_qualify';
      } else if (comparison > 0) {
        // Player's hand beats dealer: Ante 1:1 + Call 1:1
        payout  = casinoPayout(totalRisk, 2);
        result  = 'win';
        outcome = 'player_wins';
      } else if (comparison === 0) {
        // Exact tie: all bets returned
        payout  = totalRisk;
        result  = 'push';
        outcome = 'push';
      }
      // else: dealer wins — payout stays 0, result stays 'loss'

      const net        = casinoNet(payout, totalRisk);
      const newBalance = await settleCasinoBet(db, {
        identityId:     parseInt(identityId),
        serverId:       server.id,
        guildId:        server.guild_id,
        gameType:       'holdem',
        wager:          totalRisk,
        payout,
        result,
        resultData: {
          outcome, qualifies,
          playerHand: playerBest.name,
          dealerHand: dealerBest.name,
          community,
          dealerHole: state.dealerHole,
          ante:       state.ante,
          callBet,
        },
        currencySymbol: sym,
        casinoSession: { binding, version: casinoSessionRow.version },
      });

      return res.json({
        success:      true,
        status:       'complete',
        outcome,
        qualifies,
        result,
        wins:         result !== 'loss',
        payout,
        net,
        totalRisk,
        ante:         state.ante,
        callBet,
        playerHole:   state.playerHole,
        dealerHole:   state.dealerHole,
        community,
        playerHand:   playerBest.name,
        dealerHand:   dealerBest.name,
        balanceAfter: newBalance,
        currency:     { symbol: sym, name: config.currency_name },
      });
    }
    });
    return sendIdempotentCasinoResponse(res, idempotentResult);

  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Casino holdem error:', err);
    res.status(500).json({ error: "Failed to process Texas Hold'em action" });
  }
});

// ─── Roulette ─────────────────────────────────────────────────────────────────

const ROULETTE_RED   = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
const ROULETTE_BLACK = new Set([2,4,6,8,10,11,13,15,17,20,22,24,26,28,29,31,33,35]);

// 38 slots: 0, 00, and 1-36
const ROULETTE_SLOTS = ['0', '00', ...Array.from({ length: 36 }, (_, i) => String(i + 1))];

function spinRoulette() {
  return ROULETTE_SLOTS[Math.floor(Math.random() * ROULETTE_SLOTS.length)];
}

function rouletteColor(slot) {
  if (slot === '0' || slot === '00') return 'green';
  return ROULETTE_RED.has(parseInt(slot, 10)) ? 'red' : 'black';
}

/**
 * Determine whether a roulette bet wins given the winning slot.
 * Returns { wins, multiplier } where total payout = wager * multiplier (0 on loss).
 *
 * Bet types:
 *   straight — single number (0, '00', or 1-36)   pays 35:1  → multiplier 36
 *   dozen    — 1st (1-12), 2nd (13-24), 3rd (25-36)  pays 2:1 → multiplier 3
 *   column   — col 1 (1,4,7…34), col 2 (2,5,8…35), col 3 (3,6,9…36) pays 2:1
 *   even/odd/red/black/low/high                        pays 1:1 → multiplier 2
 */
function evaluateRouletteBet(slot, betType, betValue) {
  // n = -1 represents '00'; 0 represents '0'; 1-36 are normal numbers
  const n = slot === '00' ? -1 : parseInt(slot, 10);

  switch (betType) {
    case 'straight':
      return { wins: slot === String(betValue), multiplier: 36 };

    case 'dozen': {
      if (n <= 0) return { wins: false, multiplier: 0 };
      const wins = Math.ceil(n / 12) === parseInt(betValue, 10);
      return { wins, multiplier: 3 };
    }

    case 'column': {
      // Column 1: 1,4,7…34  |  Column 2: 2,5,8…35  |  Column 3: 3,6,9…36
      if (n <= 0) return { wins: false, multiplier: 0 };
      const wins = ((n - 1) % 3) + 1 === parseInt(betValue, 10);
      return { wins, multiplier: 3 };
    }

    case 'even':  return { wins: n > 0 && n % 2 === 0,        multiplier: 2 };
    case 'odd':   return { wins: n > 0 && n % 2 === 1,        multiplier: 2 };
    case 'red':   return { wins: ROULETTE_RED.has(n),          multiplier: 2 };
    case 'black': return { wins: ROULETTE_BLACK.has(n),        multiplier: 2 };
    case 'low':   return { wins: n >= 1 && n <= 18,            multiplier: 2 };
    case 'high':  return { wins: n >= 19 && n <= 36,           multiplier: 2 };

    default:      return { wins: false, multiplier: 0 };
  }
}

/**
 * POST /api/casino/play/roulette
 *
 * Body: { identityId, wager, betType, betValue }
 *
 * betType: 'straight' | 'dozen' | 'column' | 'even' | 'odd' | 'red' | 'black' | 'low' | 'high'
 * betValue: required for 'straight' (slot string) and 'dozen'/'column' (1, 2, or 3).
 *
 * Returns: { success, winningSlot, color, result, wins, payout, net, wager, balanceAfter, currency }
 */
router.post('/play/roulette', strictLimiter, ensureAuthenticated, async (req, res) => {
  const db = req.app.locals.db;
  const { identityId, wager: rawWager, betType, betValue } = req.body;

  if (!identityId) return res.status(400).json({ error: 'identityId is required' });
  if (!betType)    return res.status(400).json({ error: 'betType is required' });

  const VALID_BET_TYPES = ['straight', 'dozen', 'column', 'even', 'odd', 'red', 'black', 'low', 'high'];
  if (!VALID_BET_TYPES.includes(betType)) {
    return res.status(400).json({ error: `Invalid betType: ${betType}` });
  }

  // Validate straight bet value is a real slot
  if (betType === 'straight') {
    if (!ROULETTE_SLOTS.includes(String(betValue))) {
      return res.status(400).json({ error: 'Invalid straight bet value' });
    }
  }

  // Dozen / column betValue must be 1, 2, or 3
  if (betType === 'dozen' || betType === 'column') {
    const v = parseInt(betValue, 10);
    if (v < 1 || v > 3) {
      return res.status(400).json({ error: `betValue for ${betType} must be 1, 2, or 3` });
    }
  }

  try {
    const { identity, server } = await resolvePlayerContext(
      db, parseInt(identityId), req.playerServerAccess.serverId
    );
    const config = await getCasinoConfig(db, server.id);

    if (!config || !config.enabled)  return res.status(403).json({ error: 'Economy is not enabled for this community' });
    if (!config.casino_enabled)      return res.status(403).json({ error: 'Casino is not enabled for this community' });

    const { wager, error: wagerErr } = parseWager(rawWager, config);
    if (wagerErr) return res.status(400).json({ error: wagerErr });

    const sym = config.currency_symbol || '$';
    const normalizedBetValue = betValue == null ? null : String(betValue);
    const idempotentResult = await runIdempotentCasinoRequest(db, req, {
      serverId: identity.server_id,
      identityId: parseInt(identityId),
      operation: 'casino_roulette',
      input: { wagerCents: parseCents(wager, 'Wager'), betType, betValue: normalizedBetValue },
    }, async transactionDb => {
      const winningSlot = spinRoulette();
      const { wins, multiplier } = evaluateRouletteBet(winningSlot, betType, betValue);
      const payout = wins ? casinoPayout(wager, multiplier) : 0;
      const result = wins ? 'win' : 'loss';
      const net = casinoNet(payout, wager);

      const newBalance = await settleCasinoBet(transactionDb, {
        identityId:     parseInt(identityId),
        serverId:       identity.server_id,
        guildId:        server.guild_id,
        gameType:       'roulette',
        wager,
        payout,
        result,
        resultData:     { winningSlot, color: rouletteColor(winningSlot), betType, betValue, multiplier },
        currencySymbol: sym,
        actorUserId: req.user.id,
      }, { inTransaction: true });

      return {
        success:      true,
        winningSlot,
        color:        rouletteColor(winningSlot),
        result,
        wins,
        payout,
        net,
        wager,
        balanceAfter: newBalance,
        currency:     { symbol: sym, name: config.currency_name },
      };
    });
    return sendIdempotentCasinoResponse(res, idempotentResult);

  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Casino roulette error:', err);
    res.status(500).json({ error: 'Failed to process roulette spin' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/casino/admin-stats
// Admin-only: aggregated casino statistics for a guild over a time window.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/casino/admin-stats?guildId=&days=30
 *
 * Returns summary totals, per-game-type breakdown, top winners/losers, and
 * a recent-activity feed. Requires admin privileges.
 */
router.get('/admin-stats', ensureAuthenticated, ensureAdmin, async (req, res) => {
  const db = req.app.locals.db;
  const { days = 30 } = req.query;
  const serverId = req.playerServerAccess.serverId;

  const window = Math.max(1, Math.min(365, parseInt(days, 10) || 30));

  try {
    const sinceClause = `played_at >= NOW() - ($2 || ' days')::INTERVAL`;
    const baseParams  = [serverId, window];

    // ── Overall summary ────────────────────────────────────────────────────
    const summaryRow = await db.get(
      `SELECT
         COUNT(*)::int                          AS total_games,
         COALESCE(SUM(wager), 0::numeric)          AS total_wagered,
         COALESCE(SUM(payout), 0::numeric)         AS total_payout,
         COALESCE(SUM(wager - payout), 0::numeric) AS house_profit
       FROM casino_game_history
       WHERE server_id = $1 AND ${sinceClause}`,
      baseParams
    );

    // ── Per-game-type breakdown ────────────────────────────────────────────
    const byGame = await db.query(
      `SELECT
         game_type,
         COUNT(*)::int                              AS games,
         COALESCE(SUM(wager), 0::numeric)            AS wagered,
         COALESCE(SUM(payout), 0::numeric)           AS payout,
         ROUND(
           100.0 * COUNT(*) FILTER (WHERE payout > wager) / NULLIF(COUNT(*), 0),
           1
         )::float                                   AS win_rate,
         COALESCE(SUM(wager - payout), 0::numeric)   AS house_profit
       FROM casino_game_history
       WHERE server_id = $1 AND ${sinceClause}
       GROUP BY game_type
       ORDER BY games DESC`,
      baseParams
    );

    // ── Top winners (highest net gain) ────────────────────────────────────
    const topWinners = await db.query(
      `SELECT
         COALESCE(pg.gamertag, pi.platform_username, 'Unknown') AS gamertag,
         stats.net,
         stats.games_played
       FROM (
         SELECT
           cgh.identity_id,
           SUM(cgh.payout - cgh.wager) AS net,
           COUNT(*)::int AS games_played,
           (ARRAY_AGG(cgh.server_id ORDER BY cgh.played_at DESC)
             FILTER (WHERE cgh.server_id IS NOT NULL))[1] AS latest_server_id
         FROM casino_game_history cgh
         WHERE cgh.server_id = $1 AND ${sinceClause}
         GROUP BY cgh.identity_id
       ) stats
       LEFT JOIN player_identities pi ON pi.id = stats.identity_id
       LEFT JOIN LATERAL (
         SELECT pgt.gamertag
         FROM player_gamertags pgt
         WHERE pgt.identity_id = stats.identity_id
           AND pgt.server_id = stats.latest_server_id
           AND pgt.is_current_gamertag = 1
         ORDER BY pgt.last_seen DESC NULLS LAST, pgt.id DESC
         LIMIT 1
       ) pg ON TRUE
       ORDER BY stats.net DESC
       LIMIT 10`,
      baseParams
    );

    // ── Top losers (highest net loss) ─────────────────────────────────────
    const topLosers = await db.query(
      `SELECT
         COALESCE(pg.gamertag, pi.platform_username, 'Unknown') AS gamertag,
         stats.net,
         stats.games_played
       FROM (
         SELECT
           cgh.identity_id,
           SUM(cgh.payout - cgh.wager) AS net,
           COUNT(*)::int AS games_played,
           (ARRAY_AGG(cgh.server_id ORDER BY cgh.played_at DESC)
             FILTER (WHERE cgh.server_id IS NOT NULL))[1] AS latest_server_id
         FROM casino_game_history cgh
         WHERE cgh.server_id = $1 AND ${sinceClause}
         GROUP BY cgh.identity_id
       ) stats
       LEFT JOIN player_identities pi ON pi.id = stats.identity_id
       LEFT JOIN LATERAL (
         SELECT pgt.gamertag
         FROM player_gamertags pgt
         WHERE pgt.identity_id = stats.identity_id
           AND pgt.server_id = stats.latest_server_id
           AND pgt.is_current_gamertag = 1
         ORDER BY pgt.last_seen DESC NULLS LAST, pgt.id DESC
         LIMIT 1
       ) pg ON TRUE
       ORDER BY stats.net ASC
       LIMIT 10`,
      baseParams
    );

    // ── Recent activity (last 20 games) ───────────────────────────────────
    const recent = await db.query(
      `SELECT
         COALESCE(pg.gamertag, pi.platform_username, 'Unknown') AS gamertag,
         cgh.game_type,
         cgh.wager,
         cgh.payout,
         (cgh.payout - cgh.wager)           AS net,
         cgh.result,
         cgh.played_at
       FROM casino_game_history cgh
       LEFT JOIN player_identities pi ON pi.id = cgh.identity_id
       LEFT JOIN LATERAL (
         SELECT pgt.gamertag
         FROM player_gamertags pgt
         WHERE pgt.identity_id = cgh.identity_id
           AND pgt.server_id = cgh.server_id
           AND pgt.is_current_gamertag = 1
         ORDER BY pgt.last_seen DESC NULLS LAST, pgt.id DESC
         LIMIT 1
       ) pg ON TRUE
       WHERE cgh.server_id = $1 AND ${sinceClause}
       ORDER BY cgh.played_at DESC
       LIMIT 20`,
      baseParams
    );

    res.json({
      ok: true,
      summary: {
        total_games:   summaryRow?.total_games   || 0,
        total_wagered: summaryRow?.total_wagered || 0,
        total_payout:  summaryRow?.total_payout  || 0,
        house_profit:  summaryRow?.house_profit  || 0,
      },
      byGame,
      topWinners,
      topLosers,
      recent,
    });
  } catch (err) {
    console.error('❌ /api/casino/admin-stats error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
module.exports._test = {
  settleCasinoBet,
  lockCasinoSession,
  advanceCasinoSession,
  reserveAndAdvanceCasinoSession,
  expireCasinoSession,
  totalBlackjackWager,
  parseWager,
  casinoPayout,
  casinoSum,
  casinoNet,
  createCasinoSession,
  runIdempotentCasinoRequest,
};
