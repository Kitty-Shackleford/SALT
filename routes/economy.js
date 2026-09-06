'use strict';

const express = require('express');
const router = express.Router();
const { ensureAuthenticated, ensureAdmin } = require('../middleware/auth');
const {
  CAPABILITIES,
  ensurePlayerServerAccess,
  requireServerCapability,
} = require('../middleware/serverAccess');
const { getOrCreateWallet, getOrCreateBankAccount } = require('../utils/economy');
const { strictLimiter } = require('../middleware/rateLimiter');
const economyScheduler = require('../utils/economyScheduler');
const moneySupplyManager = require('../utils/moneySupplyManager');
const { serializeTransaction, transactionPagination } = require('../utils/economyTransactions');
const bountyService = require('../services/bountyService');
const {
  ECONOMY_ENUM_FIELDS,
  getEditableEconomyConfig,
  recalculateSupplyForAdmin,
  saveEconomyConfigInTransaction,
  suppressUnsupportedTerritoryRewardConfig,
} = require('../services/economyAdminService');
const { parseCents, parseCentsBigInt, checkedAddCents, centsToAmount, centsToDecimal, percentageOfCents, amountForResponse } = require('../utils/money');
const { lockTrustedFinancialIdentity } = require('../utils/linkTrust');
const {
  parseIdempotencyKey,
  fingerprintFinancialRequest,
  claimFinancialOperationInTransaction,
  completeFinancialOperationInTransaction,
} = require('../utils/financialIdempotency');

router.use(ensureAuthenticated);
router.param('identityId', ensurePlayerServerAccess);
const requireServerManage = requireServerCapability(CAPABILITIES.SERVER_MANAGE);

function context(req) {
  if (req.authorization?.server?.id) {
    return {
      serverId: req.authorization.server.id,
      guildId: req.authorization.guild.id,
    };
  }
  if (req.playerServerAccess?.serverId) return req.playerServerAccess;
  throw new Error('Canonical server context missing');
}

async function identityName(db, identityId, serverId) {
  return db.get(
    `SELECT pi.id, pg.gamertag FROM player_identities pi
     JOIN player_gamertags pg ON pg.identity_id = pi.id AND pg.server_id = ? AND pg.is_current_gamertag = 1
     WHERE pi.id = ?`, [serverId, identityId]
  );
}

router.get('/player/:identityId', async (req, res) => {
  try {
    const { serverId } = context(req);
    const identity = await identityName(req.app.locals.db, req.params.identityId, serverId);
    if (!identity) return res.status(404).json({ error: 'Identity not found on this server' });
    const config = await req.app.locals.db.get(
      'SELECT * FROM guild_economy_config WHERE server_id = ?', [serverId]
    );
    if (!config?.enabled) return res.json({ success: true, enabled: false });
    const wallet = await req.app.locals.db.get(
      'SELECT * FROM player_wallets WHERE identity_id = ? AND server_id = ?',
      [identity.id, serverId]
    ) || { identity_id: identity.id, server_id: serverId, cash_on_hand: config.starting_cash || 0, prospective: true };
    const bank = config.bank_enabled ? (await req.app.locals.db.get(
      'SELECT * FROM player_bank_accounts WHERE identity_id = ? AND server_id = ?',
      [identity.id, serverId]
    ) || { identity_id: identity.id, server_id: serverId, balance: config.starting_bank || 0, prospective: true }) : null;
    return res.json({
      success: true,
      enabled: true,
      serverId,
      identity,
      wallet: { ...wallet, cashOnHand: amountForResponse(wallet.cash_on_hand || 0, 'Wallet balance') },
      bank: bank ? { ...bank, balance: amountForResponse(bank.balance || 0, 'Bank balance') } : null,
      currency: { name: config.currency_name, symbol: config.currency_symbol },
      guildConfig: {
        bankEnabled: Boolean(config.bank_enabled),
        transferEnabled: Boolean(config.transfer_enabled),
      },
      config: suppressUnsupportedTerritoryRewardConfig(config),
    });
  } catch (error) { return res.status(500).json({ error: 'Failed to fetch economy status' }); }
});

router.get('/player/:identityId/transactions', async (req, res) => {
  try {
    const { serverId } = context(req);
    const requestedLimit = Number(req.query.limit);
    const requestedOffset = Number(req.query.offset);
    const limit = Number.isSafeInteger(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 200)
      : 50;
    const offset = Number.isSafeInteger(requestedOffset) && requestedOffset >= 0
      ? requestedOffset
      : 0;
    const params = [req.params.identityId, serverId];
    let filter = '';
    if (req.query.type) { filter = ' AND transaction_type = ?'; params.push(req.query.type); }
    const requestedSnapshotId = Number(req.query.snapshotId);
    const snapshotRow = Number.isSafeInteger(requestedSnapshotId) && requestedSnapshotId > 0
      ? { snapshot_id: requestedSnapshotId }
      : await req.app.locals.db.get(
        `SELECT MAX(id) AS snapshot_id FROM economy_transactions
         WHERE identity_id = ? AND server_id = ?${filter}`,
        params
      );
    const snapshotId = Number(snapshotRow?.snapshot_id) || 0;
    const snapshotParams = [...params, snapshotId];
    const rows = snapshotId > 0 ? await req.app.locals.db.query(
      `SELECT * FROM economy_transactions
       WHERE identity_id = ? AND server_id = ?${filter} AND id <= ?
       ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?`,
      [...snapshotParams, limit, offset]
    ) : [];
    const count = snapshotId > 0 ? await req.app.locals.db.get(
      `SELECT COUNT(*) AS total FROM economy_transactions
       WHERE identity_id = ? AND server_id = ?${filter} AND id <= ?`,
      snapshotParams
    ) : { total: 0 };
    const total = Number(count?.total) || 0;
    const pagination = transactionPagination(total, limit, offset);
    return res.json({
      success: true,
      transactions: rows.map(serializeTransaction),
      total,
      limit,
      offset,
      snapshotId,
      pagination,
    });
  } catch (error) { return res.status(500).json({ error: 'Failed to fetch transactions' }); }
});

function financialRequestError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function moveMoney(req, res, direction) {
  const db = req.app.locals.db;
  try {
    const { serverId, identityId } = context(req);
    if (!identityId) return res.status(403).json({ error: 'Player membership required' });
    const idempotencyKey = parseIdempotencyKey(req);
    let amountCents;
    try {
      amountCents = parseCents(req.body.amount, 'Amount');
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    if (amountCents <= 0) return res.status(400).json({ error: 'Amount must be positive' });
    const operation = `economy_${direction}`;
    const requestFingerprint = fingerprintFinancialRequest({ operation, amountCents });
    const result = await db.transaction(async () => {
      if (!await lockTrustedFinancialIdentity(db, { userId: req.user.id, identityId, serverId })) {
        throw financialRequestError('Active linked player identity is required', 403);
      }
      const config = await db.get(
        'SELECT * FROM guild_economy_config WHERE server_id = ? FOR UPDATE', [serverId]
      );
      if (!config?.enabled || !config.bank_enabled) {
        throw financialRequestError('Banking is disabled', 403);
      }
      const claim = await claimFinancialOperationInTransaction(db, {
        serverId,
        identityId,
        actorUserId: req.user.id,
        operation,
        idempotencyKey,
        requestFingerprint,
      });
      if (claim.replay) return claim;

      await getOrCreateWallet(db, identityId, serverId);
      await getOrCreateBankAccount(db, identityId, serverId);
      const wallet = await db.get(
        'SELECT * FROM player_wallets WHERE identity_id = ? AND server_id = ? FOR UPDATE',
        [identityId, serverId]
      );
      const bank = await db.get(
        'SELECT * FROM player_bank_accounts WHERE identity_id = ? AND server_id = ? FOR UPDATE',
        [identityId, serverId]
      );
      const walletBeforeCents = parseCents(wallet.cash_on_hand, 'Wallet balance');
      const bankBeforeCents = parseCents(bank.balance, 'Bank balance');
      if (direction === 'deposit' && walletBeforeCents < amountCents) {
        throw financialRequestError('Insufficient funds', 400);
      }
      if (direction === 'withdraw' && bankBeforeCents < amountCents) {
        throw financialRequestError('Insufficient funds', 400);
      }
      const feeRate = direction === 'deposit'
        ? config.bank_deposit_fee_percentage : config.bank_withdraw_fee_percentage;
      const feeCents = percentageOfCents(amountCents, feeRate || 0);
      const creditedCents = Math.max(0, amountCents - feeCents);
      const walletAfterCents = checkedAddCents(walletBeforeCents,
        direction === 'withdraw' ? creditedCents : -amountCents, 'Wallet balance');
      const bankAfterCents = checkedAddCents(bankBeforeCents,
        direction === 'deposit' ? creditedCents : -amountCents, 'Bank balance');
      if (direction === 'deposit' && config.max_bank_balance != null &&
          bankAfterCents > parseCents(config.max_bank_balance, 'Maximum bank balance')) {
        throw financialRequestError('Maximum bank balance exceeded', 400);
      }
      await db.run(
        'UPDATE player_wallets SET cash_on_hand = ?, last_updated = NOW() WHERE identity_id = ? AND server_id = ?',
        [centsToDecimal(walletAfterCents), identityId, serverId]
      );
      await db.run(
        'UPDATE player_bank_accounts SET balance = ?, last_transaction = NOW() WHERE identity_id = ? AND server_id = ?',
        [centsToDecimal(bankAfterCents), identityId, serverId]
      );
      await db.run(
        `INSERT INTO economy_transactions
         (identity_id, server_id, transaction_type, amount, balance_after, account_type, source)
         VALUES (?, ?, ?, ?, ?, 'wallet', ?), (?, ?, ?, ?, ?, 'bank', ?)`,
        [identityId, serverId, direction,
          centsToDecimal(direction === 'deposit' ? -amountCents : creditedCents),
          centsToDecimal(walletAfterCents), direction,
          identityId, serverId, direction,
          centsToDecimal(direction === 'deposit' ? creditedCents : -amountCents),
          centsToDecimal(bankAfterCents), direction]
      );
      if (feeCents > 0) {
        await moneySupplyManager.removeFromSupplyInTransaction(
          db, serverId, centsToAmount(feeCents), `${direction}_fee`, identityId
        );
      }
      const body = {
        success: true,
        walletBalance: centsToAmount(walletAfterCents),
        bankBalance: centsToAmount(bankAfterCents),
        fee: centsToAmount(feeCents),
      };
      await completeFinancialOperationInTransaction(db, claim.id, 200, body);
      return { replay: false, status: 200, body };
    });
    if (result.replay) res.set('Idempotency-Replayed', 'true');
    return res.status(result.status).json(result.body);
  } catch (error) {
    const status = [400, 403, 409].includes(error.status) ? error.status : 500;
    const message = status === 500
      ? `Failed to ${direction}`
      : error.status === 409 && !/Idempotent|Idempotency/.test(error.message)
        ? 'Destination account capacity exceeded'
        : error.message;
    return res.status(status).json({ error: message });
  }
}

router.post('/deposit', ensurePlayerServerAccess, strictLimiter, (req, res) => moveMoney(req, res, 'deposit'));
router.post('/withdraw', ensurePlayerServerAccess, strictLimiter, (req, res) => moveMoney(req, res, 'withdraw'));

router.post('/transfer', ensurePlayerServerAccess, strictLimiter, async (req, res) => {
  const db = req.app.locals.db;
  try {
    const { serverId, identityId } = context(req);
    const from = Number(identityId);
    const to = Number(req.body.toIdentityId);
    const idempotencyKey = parseIdempotencyKey(req);
    let amountCents;
    try {
      amountCents = parseCents(req.body.amount, 'Transfer amount');
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    if (!from || !to || from === to || amountCents <= 0) {
      return res.status(400).json({ error: 'Invalid transfer' });
    }
    const target = await identityName(db, to, serverId);
    if (!target) return res.status(404).json({ error: 'Recipient not found on this server' });
    const message = typeof req.body.message === 'string' ? req.body.message : null;
    const operation = 'economy_transfer';
    const requestFingerprint = fingerprintFinancialRequest({
      operation,
      amountCents,
      recipientIdentityId: to,
      message,
    });
    const result = await db.transaction(async () => {
      if (!await lockTrustedFinancialIdentity(db, {
        userId: req.user.id, identityId: from, serverId,
      })) throw financialRequestError('Active linked player identity is required', 403);
      const config = await db.get(
        'SELECT * FROM guild_economy_config WHERE server_id = ? FOR UPDATE', [serverId]
      );
      if (!config?.enabled || !config.transfer_enabled) {
        throw financialRequestError('Transfers are disabled', 403);
      }
      if (amountCents < parseCents(config.transfer_min_amount || 0, 'Minimum transfer') ||
          (config.transfer_max_amount != null &&
           amountCents > parseCents(config.transfer_max_amount, 'Maximum transfer'))) {
        throw financialRequestError('Transfer amount is outside configured limits', 400);
      }
      const claim = await claimFinancialOperationInTransaction(db, {
        serverId,
        identityId: from,
        actorUserId: req.user.id,
        operation,
        idempotencyKey,
        requestFingerprint,
      });
      if (claim.replay) return claim;

      const onlineSnapshot = await db.get(
        `SELECT source_observed_at >= clock_timestamp() - INTERVAL '120 minutes' AS fresh,
                source_observed_at <= clock_timestamp() + INTERVAL '5 minutes' AS plausible
           FROM server_online_cache_snapshots
          WHERE server_id = ?
          FOR SHARE`, [serverId]
      );
      let onlineRows = [];
      if (onlineSnapshot?.fresh && onlineSnapshot?.plausible) {
        onlineRows = await db.query(
          `SELECT cache.identity_id
             FROM server_online_cache cache
            WHERE cache.server_id = ?
              AND cache.identity_id IN (?, ?)
            FOR SHARE OF cache`, [serverId, from, to]
        );
      }
      const bothOnline = new Set(onlineRows.map(row => Number(row.identity_id))).size === 2;
      if (config.transfer_require_both_online && !bothOnline) {
        throw financialRequestError('Both players must be online', 400);
      }

      await getOrCreateWallet(db, from, serverId);
      await getOrCreateWallet(db, to, serverId);
      const wallets = await db.query(
        `SELECT * FROM player_wallets WHERE server_id = ? AND identity_id IN (?, ?)
         ORDER BY identity_id FOR UPDATE`, [serverId, from, to]
      );
      const sender = wallets.find(row => Number(row.identity_id) === from);
      const recipient = wallets.find(row => Number(row.identity_id) === to);
      const feeRateHundredths = parseCents(config.transfer_fee_percentage || 0, 'Transfer fee') +
        (bothOnline ? 0 : parseCents(config.transfer_offline_fee_percentage || 0, 'Offline transfer fee'));
      const feeCents = percentageOfCents(amountCents, centsToAmount(feeRateHundredths));
      const senderBeforeCents = parseCents(sender.cash_on_hand, 'Sender balance');
      const recipientBeforeCents = parseCents(recipient.cash_on_hand, 'Recipient balance');
      if (senderBeforeCents < amountCents + feeCents) {
        throw financialRequestError('Insufficient funds', 400);
      }
      const senderBalanceCents = senderBeforeCents - amountCents - feeCents;
      const recipientBalanceCents = checkedAddCents(
        recipientBeforeCents, amountCents, 'Recipient wallet balance');
      await db.run(
        'UPDATE player_wallets SET cash_on_hand = CASE WHEN identity_id = ? THEN ? ELSE ? END WHERE server_id = ? AND identity_id IN (?, ?)',
        [from, centsToDecimal(senderBalanceCents), centsToDecimal(recipientBalanceCents), serverId, from, to]
      );
      await db.run(
        `INSERT INTO economy_transactions
         (identity_id, server_id, transaction_type, amount, balance_after, account_type, source, source_identity_id, description)
         VALUES (?, ?, 'transfer_out', ?, ?, 'wallet', 'player_transfer', ?, ?),
                (?, ?, 'transfer_in', ?, ?, 'wallet', 'player_transfer', ?, ?)`,
        [from, serverId, centsToDecimal(-amountCents - feeCents), centsToDecimal(senderBalanceCents),
          to, message,
          to, serverId, centsToDecimal(amountCents), centsToDecimal(recipientBalanceCents),
          from, message]
      );
      if (feeCents > 0) {
        await moneySupplyManager.removeFromSupplyInTransaction(
          db, serverId, centsToAmount(feeCents), 'transfer_fee', from, { recipientIdentityId: to }
        );
      }
      const body = {
        success: true,
        transactionId: null,
        newBalance: centsToAmount(senderBalanceCents),
        fee: centsToAmount(feeCents),
      };
      await completeFinancialOperationInTransaction(db, claim.id, 200, body);
      return { replay: false, status: 200, body };
    });
    if (result.replay) res.set('Idempotency-Replayed', 'true');
    return res.status(result.status).json(result.body);
  } catch (error) {
    const status = [400, 403, 409].includes(error.status) ? error.status : 500;
    const message = status === 500
      ? 'Transfer failed'
      : error.status === 409 && !/Idempotent|Idempotency/.test(error.message)
        ? 'Recipient wallet capacity exceeded'
        : error.message;
    return res.status(status).json({ error: message });
  }
});

router.get('/search-players', ensurePlayerServerAccess, async (req, res) => {
  try {
    const { serverId } = context(req);
    const rows = await req.app.locals.db.query(
      `SELECT pi.id AS identity_id, pg.gamertag
       FROM player_gamertags pg JOIN player_identities pi ON pi.id = pg.identity_id
       WHERE pg.server_id = ? AND pg.is_current_gamertag = 1 AND LOWER(pg.gamertag) LIKE LOWER(?)
       ORDER BY pg.gamertag LIMIT 20`, [serverId, `%${req.query.query || ''}%`]
    );
    return res.json({ success: true, players: rows });
  } catch (error) { return res.status(500).json({ error: 'Search failed' }); }
});

router.get('/player/:identityId/transfers', async (req, res) => {
  try {
    const { serverId } = context(req);
    const rows = await req.app.locals.db.query(
      `SELECT * FROM economy_transactions
       WHERE identity_id = ? AND server_id = ? AND transaction_type IN ('transfer_in','transfer_out')
       ORDER BY timestamp DESC LIMIT 100`, [req.params.identityId, serverId]
    );
    return res.json({ success: true, transfers: rows, total: rows.length });
  } catch (error) { return res.status(500).json({ error: 'Failed to fetch transfers' }); }
});

async function wealth(db, serverId, limit = 100) {
  return db.query(
    `SELECT pi.id AS identity_id, pg.gamertag,
            COALESCE(pw.cash_on_hand,0) AS cash_on_hand, COALESCE(pb.balance,0) AS bank_balance,
            COALESCE(pw.cash_on_hand,0) + COALESCE(pb.balance,0) AS total_wealth
     FROM player_gamertags pg JOIN player_identities pi ON pi.id = pg.identity_id
     LEFT JOIN player_wallets pw ON pw.identity_id = pi.id AND pw.server_id = pg.server_id
     LEFT JOIN player_bank_accounts pb ON pb.identity_id = pi.id AND pb.server_id = pg.server_id
     WHERE pg.server_id = ? AND pg.is_current_gamertag = 1
     ORDER BY total_wealth DESC LIMIT ?`, [serverId, limit]
  );
}

router.get('/:serverId/leaderboard', ensurePlayerServerAccess, async (req, res) => {
  try {
    const { serverId } = context(req);
    const config = await req.app.locals.db.get(
      'SELECT currency_symbol FROM guild_economy_config WHERE server_id = ?', [serverId]
    );
    return res.json({ success: true, leaderboard: await wealth(req.app.locals.db, serverId), currencySymbol: config?.currency_symbol || '$' });
  } catch (error) { return res.status(500).json({ error: 'Leaderboard failed' }); }
});

async function playerStats(req, res) {
  try {
    const { serverId } = context(req);
    const identityId = req.params.identityId;
    const totals = await req.app.locals.db.get(
      `SELECT COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END),0) AS total_earned,
              COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END),0) AS total_spent
       FROM economy_transactions WHERE identity_id = ? AND server_id = ?`, [identityId, serverId]
    );
    const config = await req.app.locals.db.get(
      'SELECT starting_cash, starting_bank FROM guild_economy_config WHERE server_id = ?', [serverId]
    );
    const wallet = await req.app.locals.db.get(
      'SELECT cash_on_hand FROM player_wallets WHERE identity_id = ? AND server_id = ?', [identityId, serverId]
    );
    const bank = await req.app.locals.db.get(
      'SELECT balance FROM player_bank_accounts WHERE identity_id = ? AND server_id = ?', [identityId, serverId]
    );
    return res.json({ success: true, stats: { ...totals,
      wallet: wallet?.cash_on_hand ?? config?.starting_cash ?? 0,
      bank: bank?.balance ?? config?.starting_bank ?? 0 } });
  } catch (error) { return res.status(500).json({ error: 'Stats failed' }); }
}
router.get('/player/:identityId/stats', playerStats);
router.get('/player/:identityId/earnings-summary', playerStats);

router.get('/player/:identityId/rank', async (req, res) => {
  try {
    const { serverId } = context(req);
    const rows = await wealth(req.app.locals.db, serverId, 1000);
    const index = rows.findIndex(row => Number(row.identity_id) === Number(req.params.identityId));
    return res.json({ success: true, rank: index < 0 ? null : index + 1, totalPlayers: rows.length, topPlayers: rows.slice(0, 10) });
  } catch (error) { return res.status(500).json({ error: 'Rank failed' }); }
});

router.get('/admin/:serverId/config', requireServerManage, async (req, res) => {
  const { serverId } = context(req);
  const config = await getEditableEconomyConfig(req.app.locals.db, serverId);
  return res.json({ success: true, config });
});

router.post('/admin/:serverId/config', requireServerManage, strictLimiter, async (req, res) => {
  const db = req.app.locals.db;
  const { serverId, guildId } = context(req);

  const booleanFields = new Set([
    'enabled', 'kill_rewards_enabled', 'playtime_rewards_enabled', 'achievement_rewards_enabled',
    'death_penalty_enabled', 'death_drops_money_on_ground',
    'transfer_enabled', 'transfer_require_both_online', 'bank_enabled', 'bank_daily_fee_enabled',
    'inactivity_tax_enabled', 'fixed_supply_enabled', 'casino_enabled',
  ]);
  const textLimits = new Map([['currency_name', 32], ['currency_symbol', 8]]);
  const enumFields = new Map(Object.entries(ECONOMY_ENUM_FIELDS));
  const percentageFields = new Set([
    'transfer_fee_percentage', 'transfer_offline_fee_percentage',
    'bank_deposit_fee_percentage', 'bank_withdraw_fee_percentage', 'inactivity_tax_percentage',
  ]);
  const nullableNumberFields = new Set([
    'total_money_supply', 'death_penalty_max_loss', 'transfer_max_amount',
    'max_bank_balance', 'max_money_supply',
  ]);
  const numberFields = new Set([
    'starting_cash', 'starting_bank', 'total_money_supply', 'kill_reward',
    'playtime_reward_per_hour', 'achievement_bonus_multiplier',
    'death_penalty_amount', 'death_penalty_max_loss', 'transfer_fee_percentage',
    'transfer_offline_fee_percentage', 'transfer_min_amount', 'transfer_max_amount',
    'max_bank_balance', 'bank_deposit_fee_percentage', 'bank_withdraw_fee_percentage',
    'bank_daily_fee_amount', 'inactivity_tax_percentage', 'max_money_supply',
    'casino_min_bet', 'casino_max_bet',
  ]);
  const allowed = [...booleanFields, ...textLimits.keys(), ...enumFields.keys(),
    ...numberFields, 'inactivity_threshold_days'];
  const economyInput = req.body?.economy || req.body;
  if (Object.prototype.hasOwnProperty.call(economyInput, 'territory_rewards_enabled')
    || Object.prototype.hasOwnProperty.call(economyInput, 'territory_reward_per_hour')) {
    return res.status(400).json({
      error: 'Territory rewards are unavailable until territory ownership is supported',
    });
  }
  const expectedVersion = Number(req.body?.expectedVersion ?? economyInput?.expectedVersion
    ?? req.body?.bountySettings?.expectedVersion);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion <= 0) {
    return res.status(400).json({ error: 'Expected settings version is required' });
  }
  const entries = allowed.filter(key => Object.prototype.hasOwnProperty.call(economyInput, key));
  if (!entries.length) return res.status(400).json({ error: 'No supported settings' });

  for (const key of entries) {
    const value = economyInput[key];
    let valid = false;
    if (booleanFields.has(key)) valid = typeof value === 'boolean';
    else if (textLimits.has(key)) {
      valid = typeof value === 'string' && value.trim().length > 0
        && value.length <= textLimits.get(key);
    } else if (enumFields.has(key)) valid = enumFields.get(key).has(value);
    else if (key === 'inactivity_threshold_days') valid = Number.isSafeInteger(value) && value > 0;
    else if (numberFields.has(key) && value === null) valid = nullableNumberFields.has(key);
    else if (numberFields.has(key) && typeof value === 'number' && Number.isFinite(value)) {
      try {
        const cents = parseCents(value, `Economy setting ${key}`);
        valid = cents >= 0 && (!percentageFields.has(key) || cents <= 10000);
      } catch (_) {
        valid = false;
      }
    }
    if (!valid) return res.status(400).json({ error: `Invalid economy setting: ${key}` });
  }
  try {
    const result = await db.transaction(async transactionDb => {
      let bountySettings = null;
      if (req.body?.bountySettings) {
        bountySettings = await bountyService.updateBountySettingsInTransaction(
          transactionDb,
          { serverId, guildId, userId: req.user.id },
          req.body.bountySettings
        );
      } else {
        await bountyService.lockBountyAdminAuthority(
          transactionDb,
          { serverId, guildId, userId: req.user.id }
        );
      }
      const existing = await transactionDb.get(
        'SELECT * FROM guild_economy_config WHERE server_id = ? FOR UPDATE', [serverId]
      );
      if (existing && Number(existing.version) !== expectedVersion) {
        const error = new Error('Economy settings changed; reload before saving');
        error.status = 409;
        throw error;
      }
      const enablingFixed = economyInput.fixed_supply_enabled === true && !existing?.fixed_supply_enabled;
      const loweringCap = Object.prototype.hasOwnProperty.call(economyInput, 'max_money_supply')
        && economyInput.max_money_supply != null
        && (existing?.max_money_supply == null
          || parseCents(economyInput.max_money_supply, 'Maximum money supply')
            < parseCents(existing.max_money_supply, 'Existing maximum money supply'));
      let authoritativeCents = parseCentsBigInt(
        existing?.current_money_supply || 0, 'Current money supply');
      if (enablingFixed || loweringCap) {
        authoritativeCents = await moneySupplyManager.getAuthoritativeSupplyCents(
          transactionDb, serverId
        );
        const cap = economyInput.max_money_supply ?? existing?.max_money_supply;
        if (cap == null || authoritativeCents > parseCentsBigInt(cap, 'Maximum money supply')) {
          const error = new Error('Maximum money supply is below authoritative assets');
          error.status = 409;
          throw error;
        }
      }
      const saved = await saveEconomyConfigInTransaction(
        transactionDb,
        { serverId, guildId },
        economyInput,
        entries,
        expectedVersion,
        { existing, currentMoneySupply: authoritativeCents }
      );
      return { bountySettings, version: saved.version };
    });
    return res.json({ success: true, ...result });
  } catch (error) {
    const status = error.status === 409 ? 409
      : /boolean|settings version/i.test(error.message) ? 400
        : /changed.*reload/i.test(error.message) ? 409
          : /^(Guild approval is unavailable|Server is unavailable|Server management permission is required)$/.test(error.message)
            ? 403 : 500;
    return res.status(status).json({ error: status === 500 ? 'Failed to save configuration' : error.message });
  }
});

router.get('/admin/:serverId/stats', requireServerManage, async (req, res) => {
  const { serverId } = context(req);

  return res.json({ success: true, leaderboard: await wealth(req.app.locals.db, serverId) });
});
router.get('/admin/:serverId/supply-stats', requireServerManage, async (req, res) => res.json({ success: true, ...(await moneySupplyManager.getSupplyStats(req.app.locals.db, context(req).serverId, Number(req.query.days) || 7)) }));
router.get('/admin/:serverId/supply-log', requireServerManage, async (req, res) => {
  const rows = await req.app.locals.db.query(
    'SELECT * FROM economy_supply_log WHERE server_id = ? ORDER BY timestamp DESC LIMIT 200', [context(req).serverId]
  );
  return res.json({ success: true, log: rows });
});
router.post('/admin/:serverId/recalculate-supply', requireServerManage, strictLimiter, async (req, res) => {
  const { serverId, guildId } = context(req);
  const currentMoneySupply = await recalculateSupplyForAdmin(req.app.locals.db, {
    serverId, guildId, userId: req.user.id,
  });
  return res.json({ success: true, currentMoneySupply });
});
router.get('/admin/:serverId/analytics', requireServerManage, async (req, res) => res.json({ success: true, supply: await moneySupplyManager.getSupplyStats(req.app.locals.db, context(req).serverId, Number(req.query.days) || 30) }));
router.get('/admin/:serverId/export', requireServerManage, async (req, res) => {
  const rows = await req.app.locals.db.query(
    'SELECT * FROM economy_transactions WHERE server_id = ? ORDER BY timestamp DESC', [context(req).serverId]
  );
  res.type('text/csv').send(['id,identity_id,amount,type,timestamp', ...rows.map(r => [r.id,r.identity_id,r.amount,r.transaction_type,r.timestamp].join(','))].join('\n'));
});
router.post('/admin/trigger-daily-tasks', ensureAdmin, strictLimiter, async (req, res) => res.json({ success: true, ...(await economyScheduler.triggerDailyTasks(req.app.locals.db)) }));

module.exports = router;
