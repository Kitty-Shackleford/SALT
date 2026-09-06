const { getOrCreateWallet } = require('./economy');
const moneySupplyManager = require('./moneySupplyManager');
const { parseCents, checkedAddCents, centsToAmount, centsToDecimal, percentageOfCents } = require('./money');

const ACHIEVEMENT_VALUES = {
  kill: 50, streak: 100, accuracy: 75, builder: 150,
  survival: 200, combat: 75, support: 100, social: 50,
};

function requireServerId(serverId) {
  const value = Number(serverId);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Canonical server context is required');
  return value;
}

function requireBusinessDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('Daily economy business date must use YYYY-MM-DD');
  }
  return value;
}

async function claimDailyAssessment(db, serverId, identityId, assessmentType, businessDate) {
  return db.get(
    `INSERT INTO economy_daily_assessments
     (server_id, identity_id, assessment_type, business_date)
     VALUES (?, ?, ?, ?::date)
     ON CONFLICT (server_id, identity_id, assessment_type, business_date) DO NOTHING
     RETURNING id`,
    [requireServerId(serverId), identityId, assessmentType, requireBusinessDate(businessDate)]
  );
}

async function completeDailyAssessment(db, id, amount, details) {
  await db.run(
    `UPDATE economy_daily_assessments
     SET amount = ?, details = ?::jsonb, completed_at = clock_timestamp()
     WHERE id = ? AND completed_at IS NULL`,
    [centsToDecimal(parseCents(amount, 'Daily assessment amount')), JSON.stringify(details || {}), id]
  );
}

const economyHelper = {
  async getEconomyConfigForIdentity(db, identityId, serverId) {
    serverId = requireServerId(serverId);
    return db.get(
      `SELECT gec.*, s.guild_id FROM guild_economy_config gec
       JOIN servers s ON s.id = gec.server_id
       JOIN server_player_memberships spm ON spm.server_id = s.id AND spm.identity_id = ?
       WHERE gec.server_id = ? AND spm.status = 'active'`,
      [identityId, serverId]
    );
  },

  async getOrCreateWallet(db, identityId, serverId) {
    return getOrCreateWallet(db, identityId, requireServerId(serverId));
  },

  async isEconomyEnabled(db, serverId) {
    const row = await db.get(
      'SELECT enabled FROM guild_economy_config WHERE server_id = ?', [requireServerId(serverId)]
    );
    return row?.enabled === true || row?.enabled === 1;
  },

  async awardMoneyInTransaction(db, identityId, amount, source, description, serverId, metadata = null) {
    serverId = requireServerId(serverId);
    const amountCents = parseCents(amount, 'Award amount');
    await moneySupplyManager.lockSupplyForUpdate(db, serverId);
    const config = await this.getEconomyConfigForIdentity(db, identityId, serverId);
    if (!config?.enabled) return null;
    await getOrCreateWallet(db, identityId, serverId);
    const wallet = await db.get(
      'SELECT * FROM player_wallets WHERE identity_id = ? AND server_id = ? FOR UPDATE',
      [identityId, serverId]
    );
    const newBalanceCents = checkedAddCents(
      parseCents(wallet.cash_on_hand, 'Wallet balance'), amountCents, 'Wallet balance');
    const newBalance = centsToAmount(newBalanceCents);
    const timestamp = new Date().toISOString();
    await db.run(
      `UPDATE player_wallets SET cash_on_hand = ?, last_updated = ?
       WHERE identity_id = ? AND server_id = ?`,
      [centsToDecimal(newBalanceCents), timestamp, identityId, serverId]
    );
    const tx = await db.run(
      `INSERT INTO economy_transactions
       (identity_id, server_id, transaction_type, amount, balance_after, account_type, source, description, metadata, timestamp)
       VALUES (?, ?, 'earn', ?, ?, 'wallet', ?, ?, ?, ?) RETURNING id`,
      [identityId, serverId, centsToDecimal(amountCents), centsToDecimal(newBalanceCents), source, description,
        metadata ? JSON.stringify(metadata) : null, timestamp]
    );
    if (config.fixed_supply_enabled) {
      const supply = await moneySupplyManager.addToSupplyInTransaction(
        db, serverId, centsToAmount(amountCents), source, identityId, metadata
      );
      if (!supply) throw new Error('Money supply cap exceeded');
    }
    return { transactionId: tx.lastID, identityId, serverId, amount: centsToAmount(amountCents), newBalance, source, timestamp };
  },

  async awardMoney(db, identityId, amount, source, description, serverId, metadata = null) {
    return db.transaction(() => this.awardMoneyInTransaction(
      db, identityId, amount, source, description, serverId, metadata
    ));
  },

  async creditTransferInTransaction(db, identityId, amount, source, description, serverId, metadata = null) {
    serverId = requireServerId(serverId);
    const amountCents = parseCents(amount, 'Transfer credit');
    await getOrCreateWallet(db, identityId, serverId);
    const wallet = await db.get(
      'SELECT cash_on_hand FROM player_wallets WHERE identity_id = ? AND server_id = ? FOR UPDATE',
      [identityId, serverId]
    );
    if (!wallet) throw new Error('Player wallet is unavailable');
    const newBalanceCents = checkedAddCents(
      parseCents(wallet.cash_on_hand, 'Wallet balance'), amountCents, 'Wallet balance');
    const timestamp = new Date().toISOString();
    await db.run(
      'UPDATE player_wallets SET cash_on_hand = ?, last_updated = ? WHERE identity_id = ? AND server_id = ?',
      [centsToDecimal(newBalanceCents), timestamp, identityId, serverId]
    );
    const tx = await db.run(
      `INSERT INTO economy_transactions
       (identity_id, server_id, transaction_type, amount, balance_after, account_type, source, description, metadata, timestamp)
       VALUES (?, ?, 'transfer_in', ?, ?, 'wallet', ?, ?, ?, ?) RETURNING id`,
      [identityId, serverId, centsToDecimal(amountCents), centsToDecimal(newBalanceCents), source,
        description, metadata ? JSON.stringify(metadata) : null, timestamp]
    );
    return { transactionId: tx.lastID, amount: centsToAmount(amountCents),
      newBalance: centsToAmount(newBalanceCents), serverId, identityId };
  },

  async deductMoneyInTransaction(db, identityId, amount, source, description, serverId, metadata = null) {
    serverId = requireServerId(serverId);
    const requestedCents = parseCents(amount, 'Deduction amount');
    await moneySupplyManager.lockSupplyForUpdate(db, serverId);
    const wallet = await db.get(
      'SELECT * FROM player_wallets WHERE identity_id = ? AND server_id = ? FOR UPDATE',
      [identityId, serverId]
    );
    if (!wallet) return null;
    const balanceCents = parseCents(wallet.cash_on_hand, 'Wallet balance');
    const actualCents = Math.min(requestedCents, balanceCents);
    if (!(actualCents > 0)) return null;
    const newBalanceCents = balanceCents - actualCents;
    const actualAmount = centsToAmount(actualCents);
    const newBalance = centsToAmount(newBalanceCents);
    const timestamp = new Date().toISOString();
    await db.run(
      `UPDATE player_wallets SET cash_on_hand = ?, last_updated = ?
       WHERE identity_id = ? AND server_id = ?`,
      [centsToDecimal(newBalanceCents), timestamp, identityId, serverId]
    );
    const tx = await db.run(
      `INSERT INTO economy_transactions
       (identity_id, server_id, transaction_type, amount, balance_after, account_type, source, description, metadata, timestamp)
       VALUES (?, ?, 'penalty', ?, ?, 'wallet', ?, ?, ?, ?) RETURNING id`,
      [identityId, serverId, centsToDecimal(-actualCents), centsToDecimal(newBalanceCents), source, description,
        metadata ? JSON.stringify(metadata) : null, timestamp]
    );
    return { transactionId: tx.lastID, identityId, serverId, amount: actualAmount, newBalance, source, timestamp };
  },

  async deductMoney(db, identityId, amount, source, description, serverId, metadata = null) {
    return db.transaction(() => this.deductMoneyInTransaction(
      db, identityId, amount, source, description, serverId, metadata
    ));
  },

  async lootFromVictimInTransaction(db, identityId, amount, source, killerName, serverId) {
    serverId = requireServerId(serverId);
    let remaining = parseCents(amount, 'Loot amount');
    let total = 0;
    await moneySupplyManager.lockSupplyForUpdate(db, serverId);
    const accounts = source === 'both' ? ['wallet', 'bank'] : [source];
    for (const accountType of accounts) {
      if (remaining <= 0) break;
      const wallet = accountType === 'wallet';
      const table = wallet ? 'player_wallets' : 'player_bank_accounts';
      const column = wallet ? 'cash_on_hand' : 'balance';
      const row = await db.get(
        `SELECT ${column} FROM ${table} WHERE identity_id = ? AND server_id = ? FOR UPDATE`,
        [identityId, serverId]
      );
      const rowCents = row ? parseCents(row[column], `${accountType} balance`) : 0;
      const take = Math.min(remaining, rowCents);
      if (take <= 0) continue;
      const balance = rowCents - take;
      await db.run(
        `UPDATE ${table} SET ${column} = ? WHERE identity_id = ? AND server_id = ?`,
        [centsToDecimal(balance), identityId, serverId]
      );
      await db.run(
        `INSERT INTO economy_transactions
         (identity_id, server_id, transaction_type, amount, balance_after, account_type, source, description)
         VALUES (?, ?, 'penalty', ?, ?, ?, 'kill_loot', ?)`,
        [identityId, serverId, centsToDecimal(-take), centsToDecimal(balance), accountType,
          `Looted by ${killerName}`]
      );
      remaining -= take;
      total += take;
    }
    return centsToAmount(total);
  },

  async lootFromVictim(db, identityId, amount, source, killerName, serverId) {
    return db.transaction(() => this.lootFromVictimInTransaction(
      db, identityId, amount, source, killerName, serverId
    ));
  },

  async processDeathPenaltyInTransaction(db, identityId, serverId) {
    serverId = requireServerId(serverId);
    await moneySupplyManager.lockSupplyForUpdate(db, serverId);
    const config = await this.getEconomyConfigForIdentity(db, identityId, serverId);
    if (!config?.enabled || !config.death_penalty_enabled) return null;
    const wallet = await db.get(
      'SELECT cash_on_hand FROM player_wallets WHERE identity_id = ? AND server_id = ? FOR UPDATE',
      [identityId, serverId]
    );
    const balanceCents = wallet ? parseCents(wallet.cash_on_hand, 'Wallet balance') : 0;
    let penaltyCents = config.death_penalty_type === 'percentage'
      ? percentageOfCents(balanceCents, config.death_penalty_amount)
      : parseCents(config.death_penalty_amount, 'Death penalty');
    if (config.death_penalty_max_loss) {
      penaltyCents = Math.min(
        penaltyCents, parseCents(config.death_penalty_max_loss, 'Maximum death penalty'));
    }
    penaltyCents = Math.min(penaltyCents, balanceCents);
    if (penaltyCents <= 0) return null;
    const result = await this.deductMoneyInTransaction(
      db, identityId, centsToAmount(penaltyCents), 'death_penalty', 'Death penalty', serverId
    );
    if (result && config.fixed_supply_enabled) {
      await moneySupplyManager.removeFromSupplyInTransaction(
        db, serverId, result.amount, 'death_penalty', identityId
      );
    }
    return result;
  },

  async processDeathPenalty(db, identityId, serverId) {
    return db.transaction(() => this.processDeathPenaltyInTransaction(db, identityId, serverId));
  },

  async getPlayerLastSeen(db, identityId, serverId) {
    const row = await db.get(
      'SELECT last_seen FROM player_server_activity WHERE identity_id = ? AND server_id = ?',
      [identityId, requireServerId(serverId)]
    );
    return row?.last_seen ? new Date(row.last_seen) : null;
  },

  async processDailyBankFees(db, businessDate) {
    businessDate = requireBusinessDate(businessDate);
    const configs = await db.query(
      `SELECT * FROM guild_economy_config
       WHERE server_id IS NOT NULL AND enabled = TRUE AND bank_enabled = TRUE
         AND bank_daily_fee_enabled = TRUE AND bank_daily_fee_amount > 0`
    );
    const stats = { guildsProcessed: 0, serversProcessed: 0, accountsProcessed: 0, accountsSkipped: 0, totalFeesCollected: 0, errors: 0 };
    for (const config of configs || []) {
      stats.serversProcessed++;
      const accounts = await db.query(
        'SELECT identity_id FROM player_bank_accounts WHERE server_id = ?', [config.server_id]
      );
      for (const account of accounts || []) {
        try {
          const fee = await db.transaction(async () => {
            const lockedConfig = await moneySupplyManager.lockSupplyForUpdate(db, config.server_id);
            if (!lockedConfig.enabled || !lockedConfig.bank_enabled ||
                !lockedConfig.bank_daily_fee_enabled ||
                parseCents(lockedConfig.bank_daily_fee_amount, 'Daily bank fee') <= 0) {
              return { skipped: true, amount: 0 };
            }
            const locked = await db.get(
              'SELECT balance FROM player_bank_accounts WHERE identity_id = ? AND server_id = ? FOR UPDATE',
              [account.identity_id, config.server_id]
            );
            if (!locked) return { skipped: true, amount: 0 };
            const assessment = await claimDailyAssessment(
              db, config.server_id, account.identity_id, 'bank_fee', businessDate
            );
            if (!assessment) return { skipped: true, amount: 0 };
            const currentCents = parseCents(locked.balance, 'Bank balance');
            const actualCents = Math.min(currentCents, lockedConfig.bank_daily_fee_type === 'percentage'
              ? percentageOfCents(currentCents, lockedConfig.bank_daily_fee_amount)
              : parseCents(lockedConfig.bank_daily_fee_amount, 'Daily bank fee'));
            if (actualCents <= 0) {
              await completeDailyAssessment(db, assessment.id, 0, {
                accountType: 'bank', balanceAfter: centsToDecimal(currentCents),
              });
              return { skipped: false, amount: 0 };
            }
            const balanceCents = currentCents - actualCents;
            const actual = centsToAmount(actualCents);
            await db.run(
              'UPDATE player_bank_accounts SET balance = ? WHERE identity_id = ? AND server_id = ?',
              [centsToDecimal(balanceCents), account.identity_id, config.server_id]
            );
            await db.run(
              `INSERT INTO economy_transactions
               (identity_id, server_id, transaction_type, amount, balance_after, account_type, source)
               VALUES (?, ?, 'spend', ?, ?, 'bank', 'bank_fee')`,
              [account.identity_id, config.server_id, centsToDecimal(-actualCents), centsToDecimal(balanceCents)]
            );
            if (lockedConfig.fixed_supply_enabled) {
              await moneySupplyManager.removeFromSupplyInTransaction(
                db, config.server_id, actual, 'bank_fee', account.identity_id
              );
            }
            await completeDailyAssessment(db, assessment.id, actual, {
              accountType: 'bank',
              balanceAfter: centsToDecimal(balanceCents),
            });
            return { skipped: false, amount: actual };
          });
          if (fee.skipped) {
            stats.accountsSkipped++;
          } else if (fee.amount > 0) {
            stats.accountsProcessed++;
            stats.totalFeesCollected += fee.amount;
          }
        } catch (error) { stats.errors++; }
      }
    }
    return stats;
  },

  async processInactivityTax(db, businessDate) {
    businessDate = requireBusinessDate(businessDate);
    const configs = await db.query(
      `SELECT * FROM guild_economy_config
       WHERE server_id IS NOT NULL AND enabled = TRUE AND inactivity_tax_enabled = TRUE
         AND inactivity_tax_percentage > 0`
    );
    const stats = { guildsProcessed: 0, serversProcessed: 0, playersProcessed: 0, playersSkipped: 0, totalTaxCollected: 0, errors: 0 };
    for (const config of configs || []) {
      stats.serversProcessed++;
      const players = await db.query(
        'SELECT identity_id FROM player_server_activity WHERE server_id = ?',
        [config.server_id]
      );
      for (const player of players || []) {
        try {
          const collected = await db.transaction(async () => {
            const lockedConfig = await moneySupplyManager.lockSupplyForUpdate(db, config.server_id);
            if (!lockedConfig.enabled || !lockedConfig.inactivity_tax_enabled ||
                parseCents(lockedConfig.inactivity_tax_percentage, 'Inactivity tax percentage') <= 0) {
              return { skipped: true, amount: 0 };
            }
            const thresholdDays = Number(lockedConfig.inactivity_threshold_days);
            if (!Number.isFinite(thresholdDays) || thresholdDays < 0) {
              return { skipped: true, amount: 0 };
            }
            const activity = await db.get(
              `SELECT (last_seen <= clock_timestamp() - (? * INTERVAL '1 day')) AS eligible
               FROM player_server_activity
               WHERE identity_id = ? AND server_id = ?
               FOR UPDATE`,
              [thresholdDays, player.identity_id, config.server_id]
            );
            if (!activity?.eligible) return { skipped: true, amount: 0 };
            const wallet = await db.get(
              'SELECT cash_on_hand FROM player_wallets WHERE identity_id = ? AND server_id = ? FOR UPDATE',
              [player.identity_id, config.server_id]
            );
            const bank = await db.get(
              'SELECT balance FROM player_bank_accounts WHERE identity_id = ? AND server_id = ? FOR UPDATE',
              [player.identity_id, config.server_id]
            );
            const assessment = await claimDailyAssessment(
              db, config.server_id, player.identity_id, 'inactivity_tax', businessDate
            );
            if (!assessment) return { skipped: true, amount: 0 };
            const walletBalance = wallet ? parseCents(wallet.cash_on_hand, 'Wallet balance') : 0;
            const bankBalance = bank ? parseCents(bank.balance, 'Bank balance') : 0;
            let remaining = percentageOfCents(
              walletBalance + bankBalance, lockedConfig.inactivity_tax_percentage);
            let actual = 0;
            for (const [accountType, balance, table, column] of [
              ['wallet', walletBalance, 'player_wallets', 'cash_on_hand'],
              ['bank', bankBalance, 'player_bank_accounts', 'balance'],
            ]) {
              const amount = Math.min(remaining, balance);
              if (amount <= 0) continue;
              const balanceAfter = balance - amount;
              await db.run(
                `UPDATE ${table} SET ${column} = ? WHERE identity_id = ? AND server_id = ?`,
                [centsToDecimal(balanceAfter), player.identity_id, config.server_id]
              );
              await db.run(
                `INSERT INTO economy_transactions
                 (identity_id, server_id, transaction_type, amount, balance_after, account_type, source, description)
                 VALUES (?, ?, 'penalty', ?, ?, ?, 'inactivity_tax', 'Inactivity tax')`,
                [player.identity_id, config.server_id, centsToDecimal(-amount),
                  centsToDecimal(balanceAfter), accountType]
              );
              remaining -= amount;
              actual += amount;
            }
            if (actual > 0 && lockedConfig.fixed_supply_enabled) {
              await moneySupplyManager.removeFromSupplyInTransaction(
                db, config.server_id, centsToAmount(actual), 'inactivity_tax', player.identity_id
              );
            }
            const amount = centsToAmount(actual);
            await completeDailyAssessment(db, assessment.id, amount, { totalAmount: centsToDecimal(actual) });
            return { skipped: false, amount };
          });
          if (collected.skipped) {
            stats.playersSkipped++;
          } else if (collected.amount > 0) {
            stats.playersProcessed++;
            stats.totalTaxCollected += collected.amount;
          }
        } catch (error) { stats.errors++; }
      }
    }
    return stats;
  },
};

module.exports = economyHelper;
module.exports.ACHIEVEMENT_VALUES = ACHIEVEMENT_VALUES;
