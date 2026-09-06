'use strict';

const assert = require('assert');
const { getOrCreateWallet } = require('../utils/economy');
const moneySupplyManager = require('../utils/moneySupplyManager');
const casino = require('../routes/casino')._test;

async function main() {
  {
    const calls = [];
    const db = {
      async get(sql, params) {
        calls.push({ sql, params });
        return { total: '110.01' };
      },
    };
    const cents = await moneySupplyManager.getAuthoritativeSupplyCents(db, 11);
    assert.strictEqual(cents, 11001n);
    assert.match(calls[0].sql,
      /financial_refund_claims[\s\S]*server_id = \?[\s\S]*status = 'pending'/i,
      'pending deferred claims must remain in every authoritative cap calculation');
    assert.deepStrictEqual(calls[0].params, [11, 11, 11, 11, 11]);

    db.get = async () => ({ total: '90071992547409.92' });
    assert.strictEqual(
      await moneySupplyManager.getAuthoritativeSupplyCents(db, 11),
      9007199254740992n,
      'authoritative NUMERIC(20,2) supply must not cross a Number boundary'
    );
  }
  const calls = [];
  let created = false;
  const db = {
    async transaction(callback) {
      calls.push('BEGIN');
      const value = await callback(this);
      calls.push('COMMIT');
      return value;
    },
    async get(sql) {
      calls.push(sql);
      if (/FROM servers/.test(sql)) return { id: 11, guild_id: 3 };
      if (/guild_economy_config/.test(sql)) {
        return { guild_id: 3, starting_cash: 25, fixed_supply_enabled: true,
          max_money_supply: 100, current_money_supply: 50 };
      }
      if (/player_wallets/.test(sql)) {
        return created ? { id: 1, identity_id: 7, server_id: 11, cash_on_hand: 25 } : null;
      }
      return null;
    },
    async run(sql) {
      calls.push(sql);
      if (/INSERT INTO player_wallets/.test(sql)) created = true;
      return { changes: 1, lastID: 1 };
    }
  };

  const wallet = await getOrCreateWallet(db, 7, 11);
  assert.strictEqual(wallet.cash_on_hand, 25);
  assert.strictEqual(calls[0], 'BEGIN');
  assert.strictEqual(calls.at(-1), 'COMMIT');
  assert.ok(calls.some(sql => /guild_economy_config[\s\S]*FOR UPDATE/.test(sql)),
    'exact-server economy config must be locked');
  assert.ok(calls.some(sql => /UPDATE guild_economy_config SET current_money_supply/.test(sql)),
    'positive starting balance must update supply');
  assert.ok(calls.some(sql => /INSERT INTO economy_supply_log/.test(sql)),
    'positive starting balance must have supply audit log');

  let capInserted = false;
  const capDb = {
    async transaction(callback) { return callback(this); },
    async get(sql) {
      if (/FROM servers/.test(sql)) return { id: 11, guild_id: 3 };
      if (/guild_economy_config/.test(sql)) {
        return { guild_id: 3, starting_cash: 25, fixed_supply_enabled: true,
          max_money_supply: 60, current_money_supply: 50 };
      }
      return null;
    },
    async run(sql) {
      if (/INSERT INTO player_wallets/.test(sql)) capInserted = true;
      return { changes: 1, lastID: 1 };
    }
  };
  await assert.rejects(() => getOrCreateWallet(capDb, 8, 11), /supply cap exceeded/i);
  assert.strictEqual(capInserted, false, 'cap rejection must happen before account creation');

  let firstUseCreated = false;
  let firstUseSupply = 0;
  let firstUseTransactions = 0;
  let tail = Promise.resolve();
  const concurrentDb = {
    transaction(callback) {
      const run = tail.then(async () => {
        firstUseTransactions++;
        return callback(this);
      });
      tail = run.catch(() => {});
      return run;
    },
    async get(sql) {
      if (/FROM servers/.test(sql)) return { id: 11, guild_id: 3 };
      if (/guild_economy_config/.test(sql)) {
        return { guild_id: 3, starting_cash: 25, fixed_supply_enabled: true,
          max_money_supply: 100, current_money_supply: firstUseSupply };
      }
      if (/player_wallets/.test(sql)) {
        return firstUseCreated
          ? { id: 9, identity_id: 9, server_id: 11, cash_on_hand: 25 }
          : null;
      }
      return null;
    },
    async run(sql, params) {
      if (/UPDATE guild_economy_config/.test(sql)) firstUseSupply = params[0];
      if (/INSERT INTO player_wallets/.test(sql)) firstUseCreated = true;
      return { changes: 1, lastID: 1 };
    }
  };
  const accounts = await Promise.all([
    getOrCreateWallet(concurrentDb, 9, 11),
    getOrCreateWallet(concurrentDb, 9, 11)
  ]);
  assert.strictEqual(accounts.length, 2);
  assert.strictEqual(firstUseTransactions, 2);
  assert.strictEqual(Number(firstUseSupply), 25, 'concurrent first use must mint the starting balance once');

  const recalcCalls = [];
  let recalculatedSupply = null;
  const recalcDb = {
    async transaction(callback) {
      recalcCalls.push('BEGIN');
      const result = await callback(this);
      recalcCalls.push('COMMIT');
      return result;
    },
    async get(sql, params) {
      recalcCalls.push({ sql, params });
      if (/FROM servers/.test(sql)) return { id: 11, guild_id: 3 };
      if (/guild_economy_config/.test(sql)) return { server_id: 11 };
      if (/casino_sessions/.test(sql) && /status = 'active'/.test(sql)) return { total: 165 };
      if (/player_wallets/.test(sql)) return { total: 125 };
      return null;
    },
    async run(sql, params) {
      recalcCalls.push({ sql, params });
      if (/UPDATE guild_economy_config/.test(sql)) recalculatedSupply = params[0];
      return { changes: 1 };
    }
  };
  const total = await moneySupplyManager.recalculateSupply(recalcDb, 11);
  assert.strictEqual(total, 165, 'active exact-server casino escrow remains in money supply');
  assert.strictEqual(recalculatedSupply, '165.00');
  assert.strictEqual(recalcCalls[0], 'BEGIN', 'recalculation must use one transaction');
  assert.strictEqual(recalcCalls.at(-1), 'COMMIT');
  const sqlCalls = recalcCalls.filter(call => call && call.sql);
  const configLockIndex = sqlCalls.findIndex(call =>
    /guild_economy_config[\s\S]*FOR UPDATE/.test(call.sql));
  const aggregateIndex = sqlCalls.findIndex(call => /casino_sessions/.test(call.sql));
  assert.ok(configLockIndex >= 0 && configLockIndex < aggregateIndex,
    'recalculation must lock exact-server economy state before reading balances and escrow');
  const aggregate = sqlCalls[aggregateIndex];
  assert.match(aggregate.sql, /status = 'active'/);
  assert.deepStrictEqual(aggregate.params, [11, 11, 11, 11, 11],
    'wallets, banks, casino escrow, bounty escrow, and deferred refunds must all use the exact server');

  let concurrentWallet = 100;
  let concurrentEscrow = 0;
  let concurrentRecalculation = null;
  let economyTail = Promise.resolve();
  const concurrentEconomyDb = {
    transactionStorage: { getStore: () => ({ client: {} }) },
    transaction(callback) {
      const run = economyTail.then(() => callback(this));
      economyTail = run.catch(() => {});
      return run;
    },
    async get(sql) {
      if (/SELECT guild_id FROM servers/.test(sql)) return { guild_id: 3 };
      if (/FROM guilds/.test(sql)) return { id: 3 };
      if (/FROM servers/.test(sql)) return { id: 11, guild_id: 3 };
      if (/server_player_memberships/.test(sql)) return { id: 99, source_link_id: 88 };
      if (/linked_accounts/.test(sql)) return { id: 88 };
      if (/guild_economy_config/.test(sql)) {
        return { server_id: 11, guild_id: 3, starting_cash: 0,
          fixed_supply_enabled: true, max_money_supply: 500, current_money_supply: 100 };
      }
      if (/SELECT \* FROM player_wallets/.test(sql)) {
        return { id: 1, identity_id: 7, server_id: 11, cash_on_hand: concurrentWallet };
      }
      if (/SELECT cash_on_hand FROM player_wallets/.test(sql)) {
        return { cash_on_hand: concurrentWallet };
      }
      if (/casino_sessions/.test(sql) && /SUM\(reserved_wager\)/.test(sql)) {
        return { total: Number(concurrentWallet) + concurrentEscrow };
      }
      return null;
    },
    async run(sql, params) {
      if (/UPDATE player_wallets/.test(sql)) concurrentWallet = params[0];
      if (/INSERT INTO casino_sessions/.test(sql)) concurrentEscrow += Number(params[7]);
      if (/UPDATE guild_economy_config SET current_money_supply/.test(sql)) {
        concurrentRecalculation = params[0];
      }
      return { changes: 1, lastID: 1 };
    }
  };
  await Promise.all([
    casino.createCasinoSession(concurrentEconomyDb, { user: { id: 5 } }, 'craps', 7,
      { id: 11, guild_id: 3 }, { wager: 40 }, 5, 40),
    moneySupplyManager.recalculateSupply(concurrentEconomyDb, 11)
  ]);
  assert.strictEqual(Number(concurrentWallet), 60);
  assert.strictEqual(concurrentEscrow, 40);
  assert.strictEqual(concurrentRecalculation, '100.00',
    'concurrent escrow creation and recalculation must preserve the full supply');
  console.log('economy initial fixed-supply tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
