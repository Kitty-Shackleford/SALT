const moneySupplyManager = require('./moneySupplyManager');
const { parseCents, centsToAmount, centsToDecimal } = require('./money');

/**
 * Exact-server wallet/bank primitives. serverId must come from an authorized,
 * canonical server context; callers must never substitute a guild or client-only
 * identifier.
 */
function hasActiveTransaction(db) {
  return Boolean(db.transactionStorage?.getStore()?.client || db.isInTransaction?.());
}

async function atomically(db, callback) {
  return hasActiveTransaction(db) || typeof db.transaction !== 'function'
    ? callback(db)
    : db.transaction(callback);
}

async function createInitialAccount(db, {
  identityId, serverId, table, balanceColumn, startingColumn, accountType
}) {
  return atomically(db, async transactionDb => {
    const config = await moneySupplyManager.lockSupplyForUpdate(transactionDb, serverId);
    const existing = await transactionDb.get(
      `SELECT * FROM ${table} WHERE identity_id = ? AND server_id = ?`,
      [identityId, serverId]
    );
    if (existing) return existing;

    const startingBalanceCents = parseCents(config?.[startingColumn] || 0, `Starting ${accountType}`);
    const startingBalance = centsToAmount(startingBalanceCents);
    if (startingBalance > 0) {
      const supply = await moneySupplyManager.addToSupplyInTransaction(
        transactionDb, serverId, startingBalance, `initial_${accountType}`, identityId,
        { accountType }
      );
      if (!supply) {
        const error = new Error('Money supply cap exceeded');
        error.status = 409;
        throw error;
      }
    }

    const inserted = await transactionDb.run(
      `INSERT INTO ${table} (identity_id, server_id, ${balanceColumn})
       VALUES (?, ?, ?) ON CONFLICT (identity_id, server_id) DO NOTHING RETURNING id`,
      [identityId, serverId, centsToDecimal(startingBalanceCents)]
    );
    const created = await transactionDb.get(
      `SELECT * FROM ${table} WHERE identity_id = ? AND server_id = ?`,
      [identityId, serverId]
    );
    if (!created) throw new Error(`Failed to create exact-server ${accountType}`);

    if (startingBalance > 0 && (inserted?.changes === 1 || inserted?.lastID)) {
      await transactionDb.run(
        `INSERT INTO economy_transactions
         (identity_id, server_id, transaction_type, amount, balance_after, account_type, source, description)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [identityId, serverId, 'earn', centsToDecimal(startingBalanceCents),
          centsToDecimal(startingBalanceCents), accountType,
          'system', `Initial ${accountType} balance`]
      );
    }
    return created;
  });
}

async function getOrCreateWallet(db, identityId, serverId) {
  return createInitialAccount(db, {
    identityId, serverId, table: 'player_wallets', balanceColumn: 'cash_on_hand',
    startingColumn: 'starting_cash', accountType: 'wallet'
  });
}

async function getOrCreateBankAccount(db, identityId, serverId) {
  return createInitialAccount(db, {
    identityId, serverId, table: 'player_bank_accounts', balanceColumn: 'balance',
    startingColumn: 'starting_bank', accountType: 'bank'
  });
}

module.exports = { getOrCreateWallet, getOrCreateBankAccount };
