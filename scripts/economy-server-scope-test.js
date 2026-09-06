'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error.message}`);
  }
}

function source(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function recordingDb(overrides = {}) {
  const calls = [];
  const db = {
    calls,
    async get(sql, params) {
      calls.push({ method: 'get', sql, params });
      if (overrides.get) return overrides.get(sql, params, calls);
      return null;
    },
    async run(sql, params) {
      calls.push({ method: 'run', sql, params });
      if (overrides.run) return overrides.run(sql, params, calls);
      return { lastID: 1 };
    },
    async query(sql, params) {
      calls.push({ method: 'query', sql, params });
      if (overrides.query) return overrides.query(sql, params, calls);
      return [];
    },
    async transaction(fn) { return fn(db); },
  };
  return db;
}

(async () => {
  console.log('\nExact-server economy tests');

  await test('wallet identity is the (identity_id, server_id) pair', async () => {
    const { getOrCreateWallet } = require('../utils/economy');
    let inserted = false;
    const db = recordingDb({
      get(sql) {
        if (sql.includes('FROM servers')) return { id: 11, guild_id: 3 };
        if (sql.includes('guild_economy_config')) return { starting_cash: 25 };
        if (inserted && sql.includes('player_wallets')) return { id: 1, identity_id: 7, server_id: 11, cash_on_hand: 25 };
        return null;
      },
      run(sql) { if (sql.includes('INSERT INTO player_wallets')) inserted = true; return { lastID: 1 }; },
    });
    const wallet = await getOrCreateWallet(db, 7, 11);
    assert.strictEqual(wallet.server_id, 11);
    for (const call of db.calls.filter(call => /player_wallets/i.test(call.sql))) {
      assert.match(call.sql, /server_id/i);
      assert(call.params.includes(11), `wallet query omitted exact server parameter: ${call.sql}`);
    }
    const configCall = db.calls.find(call => /guild_economy_config/i.test(call.sql));
    assert.match(configCall.sql, /server_id/i);
    assert.deepStrictEqual(configCall.params, [11]);
  });

  await test('bank identity is the (identity_id, server_id) pair', async () => {
    const { getOrCreateBankAccount } = require('../utils/economy');
    let inserted = false;
    const db = recordingDb({
      get(sql) {
        if (sql.includes('FROM servers')) return { id: 12, guild_id: 3 };
        if (sql.includes('guild_economy_config')) return { starting_bank: 40 };
        if (inserted && sql.includes('player_bank_accounts')) return { id: 1, identity_id: 7, server_id: 12, balance: 40 };
        return null;
      },
      run(sql) { if (sql.includes('INSERT INTO player_bank_accounts')) inserted = true; return { lastID: 1 }; },
    });
    const account = await getOrCreateBankAccount(db, 7, 12);
    assert.strictEqual(account.server_id, 12);
    for (const call of db.calls.filter(call => /player_bank_accounts/i.test(call.sql))) {
      assert.match(call.sql, /server_id/i);
      assert(call.params.includes(12), `bank query omitted exact server parameter: ${call.sql}`);
    }
  });

  await test('money supply is selected, updated, and logged by exact server', async () => {
    const manager = require('../utils/moneySupplyManager');
    const db = recordingDb({
      get() { return { fixed_supply_enabled: true, max_money_supply: 100, current_money_supply: 10 }; },
    });
    assert.strictEqual(await manager.canAddToSupply(db, 21, 5), true);
    await manager.addToSupply(db, 21, 5, 'test', 7);
    for (const call of db.calls) {
      if (/guild_economy_config|economy_supply_log/i.test(call.sql)) {
        assert.match(call.sql, /server_id/i, `supply SQL is not server scoped: ${call.sql}`);
        assert(call.params.includes(21), `supply SQL omitted server parameter: ${call.sql}`);
      }
    }
  });

  await test('migration 052 rejects every unsafe legacy monetary data class before DDL', async () => {
    const migration = require('../db/migrations/052_server_scoped_economy');
    const sql = [];
    await migration.up({ async query(statement) { sql.push(statement); return { rows: [] }; } });
    const all = sql.join('\n');
    for (const table of ['player_wallets', 'player_bank_accounts', 'economy_transactions', 'economy_supply_log']) {
      assert.match(all, new RegExp(`EXISTS\\s*\\(\\s*SELECT\\s+1\\s+FROM\\s+${table}`, 'i'), `missing fail-closed guard for ${table}`);
    }
    assert.match(all, /current_money_supply[^;]*<>\s*0/i);
    const guardAt = all.search(/EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+player_wallets/i);
    const alterAt = all.search(/ALTER\s+TABLE\s+player_wallets/i);
    assert(guardAt >= 0 && alterAt > guardAt, 'migration mutates schema before the fail-closed guard');
    assert.match(all, /identity_id\s*,\s*server_id/i);
    assert.match(all, /server_id[^;]*NOT NULL/i);
    assert.match(all, /ALTER TABLE economy_supply_log[\s\S]*ADD COLUMN IF NOT EXISTS server_id/i);
  });

  await test('migration 052 supports an existing production database without economy_supply_log', async () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'db', 'migrations', '052_server_scoped_economy.js'),
      'utf8'
    );
    assert.match(source, /to_regclass\('public\.economy_supply_log'\)/i,
      'preflight must probe for the optional legacy supply table without resolving a missing relation');
    assert.match(source, /CREATE TABLE IF NOT EXISTS economy_supply_log/i,
      'migration must create the canonical supply log before altering it');
    const preflightAt = source.indexOf('DO $$');
    const createAt = source.search(/CREATE TABLE IF NOT EXISTS economy_supply_log/i);
    assert(preflightAt >= 0 && createAt > preflightAt,
      'the optional table must be created only after the fail-closed preflight');
  });

  await test('migration 052 is explicitly irreversible with recovery guidance', async () => {
    const migration = require('../db/migrations/052_server_scoped_economy');
    await assert.rejects(() => migration.down(), /irreversible.*backup|backup.*irreversible/i);
  });

  await test('economy production SQL never accesses a balance or ledger without server_id', async () => {
    const files = [
      'utils/economy.js', 'utils/economyHelper.js', 'utils/moneySupplyManager.js',
      'routes/economy.js', 'routes/casino.js', 'routes/shop.js', 'services/shopFileService.js',
    ];
    const statementPattern = /(?:`[^`]*(?:SELECT|INSERT|UPDATE|DELETE)[^`]*(?:player_wallets|player_bank_accounts|economy_transactions|economy_supply_log|guild_economy_config)[^`]*`|'[^'\n]*(?:SELECT|INSERT|UPDATE|DELETE)[^'\n]*(?:player_wallets|player_bank_accounts|economy_transactions|economy_supply_log|guild_economy_config)[^'\n]*')/gi;
    for (const file of files) {
      for (const match of source(file).match(statementPattern) || []) {
        assert.match(match, /server_id/i, `${file} contains unscoped economy SQL: ${match.slice(0, 180)}`);
      }
    }
  });

  await test('player and casino HTTP APIs require an explicit serverId', async () => {
    const economy = source('routes/economy.js');
    const casino = source('routes/casino.js');
    assert.match(economy, /req\.playerServerAccess/);
    assert.doesNotMatch(economy, /LIMIT 1[\s\S]{0,80}player_server_activity/i);
    assert.match(casino, /serverId/);
    assert.doesNotMatch(casino, /ORDER BY pg\.id DESC\s+LIMIT 1/i);
    assert.doesNotMatch(casino, /FROM linked_accounts la/,
      'casino must rely on the canonical exact-server guard, not global link rows');
    assert.doesNotMatch(casino, /const identity = isAdmin/,
      'global dashboard admin must not bypass exact-server authorization');
  });

  await test('money movement uses the authorized identity instead of a client-supplied sender', async () => {
    const economy = source('routes/economy.js');
    assert.doesNotMatch(economy, /const identityId = req\.body\.identityId/);
    assert.doesNotMatch(economy, /const from = Number\(req\.body\.fromIdentityId\)/);
    assert.doesNotMatch(economy, /if \(user\.is_admin\) return true/);
    assert.match(economy, /identityId\s*}\s*=\s*context\(req\)/);
  });

  await test('identity and server route params are authorized after Express populates them', async () => {
    const economy = source('routes/economy.js');
    assert.match(economy, /router\.param\(['"]identityId['"],\s*ensurePlayerServerAccess\)/);
    assert.match(economy, /router\.get\(['"]\/:serverId\/leaderboard['"],\s*ensurePlayerServerAccess/,
      'player server authorization must run on the matched route after params are populated');
    assert.match(economy, /router\.get\(['"]\/admin\/:serverId\/config['"],\s*requireServerManage/,
      'management authorization must run on the matched route after params are populated');
    assert.doesNotMatch(economy, /router\.use\(ensureAuthenticated,\s*ensurePlayerServerAccess\)/,
      'router-wide guard runs before route params are populated');
  });

  await test('every exact-server admin economy endpoint enforces operator authorization', async () => {
    const economy = source('routes/economy.js');
    assert.match(economy, /requireServerCapability\(CAPABILITIES\.SERVER_MANAGE\)/);
    for (const suffix of ['config', 'stats', 'supply-stats', 'supply-log', 'recalculate-supply', 'analytics', 'export']) {
      const route = new RegExp(`router\\.(?:get|post)\\(['"]\\/admin\\/:serverId\\/${suffix}['"][^;]+`, 's');
      const match = economy.match(route);
      assert(match, `missing admin route ${suffix}`);
      assert.match(match[0], /requireServerManage/, `${suffix} lacks canonical server.manage authorization`);
    }
    assert.doesNotMatch(economy, /req\.serverRole/,
      'economy authorization must not depend on a legacy role field that canonical middleware does not set');
  });

  await test('money movement locks balances and enforces configured bank and transfer policy', async () => {
    const economy = source('routes/economy.js');
    assert.match(economy, /FOR UPDATE/);
    for (const setting of [
      'bank_enabled', 'max_bank_balance', 'bank_deposit_fee_percentage',
      'bank_withdraw_fee_percentage', 'transfer_enabled', 'transfer_min_amount',
      'transfer_max_amount', 'transfer_fee_percentage', 'transfer_require_both_online',
      'transfer_offline_fee_percentage',
    ]) assert(economy.includes(setting), `money movement ignores ${setting}`);
    assert.match(economy, /server_online_cache_snapshots/i,
      'transfer online policy must require a provider-evidence freshness snapshot');
    assert.match(economy, /source_observed_at\s*>=\s*clock_timestamp\(\)\s*-\s*INTERVAL\s*'120 minutes'/i,
      'transfer online policy must reject stale provider evidence');
    assert.match(economy, /source_observed_at\s*<=\s*clock_timestamp\(\)\s*\+\s*INTERVAL\s*'5 minutes'/i,
      'transfer online policy must reject implausibly future provider evidence');
    assert.match(economy, /FROM server_online_cache_snapshots[\s\S]*FOR SHARE/i,
      'transfer must lock its provider-evidence freshness snapshot');
    assert.match(economy, /FROM server_online_cache cache[\s\S]*FOR SHARE OF cache/i,
      'transfer must lock exact online-cache rows until commit');
    const snapshotLockAt = economy.indexOf('FROM server_online_cache_snapshots');
    const onlineLockAt = economy.indexOf('FROM server_online_cache cache');
    const walletLockAt = economy.indexOf('SELECT * FROM player_wallets WHERE server_id = ? AND identity_id IN (?, ?)');
    assert(snapshotLockAt >= 0 && onlineLockAt > snapshotLockAt && walletLockAt > onlineLockAt,
      'transfer must lock snapshot, cache, then wallets in the canonical financial order');
  });

  await test('supply logs provide the required guild id and exact server id', async () => {
    const manager = source('utils/moneySupplyManager.js');
    assert.match(manager, /INSERT INTO economy_supply_log\s*\([^)]*guild_id[^)]*server_id/is);
    assert.match(manager, /SELECT id, guild_id FROM servers WHERE id = \? FOR NO KEY UPDATE/i,
      'supply mutations must serialize on the exact server without blocking provider-ledger foreign keys');
    assert.match(manager,
      /INSERT INTO economy_supply_log[\s\S]*\[row\.guild_id, serverId,/i,
      'supply log must use the guild derived from the locked exact server');
  });

  await test('migration 052 replaces nullable legacy server foreign keys with CASCADE constraints', async () => {
    const migration = source('db/migrations/052_server_scoped_economy.js');
    for (const table of ['economy_transactions', 'economy_supply_log']) {
      assert.match(migration, new RegExp(`ALTER TABLE ${table}[\\s\\S]*FOREIGN KEY \\(server_id\\) REFERENCES servers\\(id\\) ON DELETE CASCADE`, 'i'));
    }
  });

  await test('all economy clients send internal server ids rather than guild ids', async () => {
    const leaderboard = source('public/js/components/leaderboardTable.js');
    assert.match(leaderboard, /load\(serverId, options\)/);
    assert.match(leaderboard, /encodeURIComponent\(serverId\)/);
    for (const file of [
      'public/js/admin/economy-settings.js',
      'public/js/admin/economy-analytics.js',
      'public/js/admin/supply-monitor.js',
    ]) {
      const client = source(file);
      assert.match(client, /\/api\/guilds\/\$\{[^}]+\}\/servers/,
        `${file} does not resolve exact servers`);
      assert.match(client, /opt\.value = server\.id/,
        `${file} does not place the internal server id in the selector`);
    }
  });

  await test('economy transaction API serializes PostgreSQL rows for browser clients', async () => {
    const { serializeTransaction, transactionPagination } = require('../utils/economyTransactions');
    const serialized = serializeTransaction({
      id: 9,
      identity_id: 7,
      server_id: 11,
      transaction_type: 'shop_purchase',
      amount: '-10.50',
      balance_after: '42.25',
      account_type: 'wallet',
      source_identity_id: 3,
      source: 'shop_purchase',
      description: 'Order 17',
      timestamp: '2026-08-30T12:00:00.000Z',
    });
    assert.deepStrictEqual(serialized, {
      id: 9,
      identityId: 7,
      serverId: 11,
      transactionType: 'shop_purchase',
      amount: -10.5,
      balanceAfter: 42.25,
      accountType: 'wallet',
      sourceIdentityId: 3,
      source: 'shop_purchase',
      description: 'Order 17',
      timestamp: '2026-08-30T12:00:00.000Z',
    });
    assert.deepStrictEqual(transactionPagination(41, 20, 20), {
      total: 41,
      limit: 20,
      offset: 20,
      hasMore: true,
    });
    assert.strictEqual(transactionPagination(40, 20, 20).hasMore, false);
    assert.strictEqual(serializeTransaction({
      id: 10,
      identity_id: 7,
      server_id: 11,
      transaction_type: 'debit',
      amount: '10.50',
      balance_after: '31.75',
    }).amount, -10.5, 'legacy positive debit rows must serialize as money leaving the account');
  });

  await test('changing membership invalidates an in-flight transaction response immediately', async () => {
    let resolveTransactions;
    const container = { innerHTML: 'old membership rows' };
    const context = {
      window: {},
      document: {
        getElementById(id) {
          return id === 'transactionList' ? container : null;
        },
        createElement() { return {}; },
      },
      fetch: () => new Promise(resolve => { resolveTransactions = resolve; }),
      console,
      Date,
      Blob,
      URL: { createObjectURL() {}, revokeObjectURL() {} },
      setTimeout,
      clearTimeout,
    };
    vm.runInNewContext(source('public/js/components/transactionList.js'), context);

    const staleLoad = context.window.TransactionList.load(1, { serverId: 10, currencySymbol: '$' });
    context.window.TransactionList.beginContextChange();
    assert.match(container.innerHTML, /animate-spin/,
      'changing membership should replace old rows with a loading state immediately');

    resolveTransactions({
      async json() {
        return {
          success: true,
          transactions: [{ id: 99, transactionType: 'earn', amount: 5, description: 'STALE_A' }],
        };
      },
    });
    await staleLoad;
    assert.doesNotMatch(container.innerHTML, /STALE_A/,
      'a transaction response from the previous membership rendered after selection changed');
  });

  await test('transaction load errors render a scoped failure state', async () => {
    const container = { innerHTML: '' };
    const context = {
      window: {},
      document: {
        getElementById(id) {
          return id === 'transactionList' ? container : null;
        },
        createElement() { return {}; },
      },
      fetch: async () => { throw new Error('network unavailable'); },
      console: { error() {} },
      Date,
      Blob,
      URL: { createObjectURL() {}, revokeObjectURL() {} },
    };
    vm.runInNewContext(source('public/js/components/transactionList.js'), context);

    await context.window.TransactionList.load(2, { serverId: 20, currencySymbol: '$' });
    assert.match(container.innerHTML, /Failed to load transactions/);
  });

  await test('transaction rendering escapes tenant currency and unknown transaction labels', async () => {
    const container = { innerHTML: '' };
    const modalBody = { innerHTML: '' };
    const modal = { classList: { remove() {} } };
    const context = {
      window: {},
      document: {
        getElementById(id) {
          if (id === 'transactionList') return container;
          if (id === 'txDetailBody') return modalBody;
          if (id === 'txDetailModal') return modal;
          return null;
        },
        createElement() { return {}; },
      },
      fetch: async () => ({
        async json() {
          return {
            success: true,
            transactions: [{
              id: 1,
              transactionType: '<svg/onload=globalThis.pwned=1>',
              amount: 1,
              balanceAfter: 2,
              timestamp: '2026-08-30T12:00:00.000Z',
            }],
            pagination: { total: 1, limit: 200, offset: 0, hasMore: false },
          };
        },
      }),
      console,
      Date,
      Blob,
      URL: { createObjectURL() {}, revokeObjectURL() {} },
    };
    vm.runInNewContext(source('public/js/components/transactionList.js'), context);

    await context.window.TransactionList.load(2, {
      serverId: 20,
      currencySymbol: '<img src=x onerror=globalThis.pwned=2>',
    });
    context.window.TransactionList.showDetail(1);

    for (const html of [container.innerHTML, modalBody.innerHTML]) {
      assert.doesNotMatch(html, /<img|<svg/i, 'transaction-controlled markup reached an innerHTML sink');
      assert.match(html, /&lt;img|&lt;svg/i, 'transaction-controlled markup was not escaped as text');
    }
  });

  await test('transaction history loads every server page before client-side pagination', async () => {
    const container = { innerHTML: '' };
    const pagination = { innerHTML: '' };
    const requestedUrls = [];
    const makeTransactions = (start, count) => Array.from({ length: count }, (_, index) => ({
      id: start + index,
      transactionType: 'earn',
      amount: 1,
      description: `Transaction ${start + index}`,
      timestamp: '2026-08-30T12:00:00.000Z',
    }));
    const context = {
      window: {},
      document: {
        getElementById(id) {
          if (id === 'transactionList') return container;
          if (id === 'tl-pagination') return pagination;
          return null;
        },
        createElement() { return {}; },
      },
      async fetch(url) {
        requestedUrls.push(url);
        const secondPage = url.includes('offset=200');
        return {
          async json() {
            return {
              success: true,
              transactions: secondPage ? makeTransactions(201, 1) : makeTransactions(1, 200),
              pagination: { total: 201, limit: 200, offset: secondPage ? 200 : 0, hasMore: !secondPage },
            };
          },
        };
      },
      console,
      Date,
      Blob,
      URL: { createObjectURL() {}, revokeObjectURL() {} },
    };
    vm.runInNewContext(source('public/js/components/transactionList.js'), context);

    await context.window.TransactionList.load(2, { serverId: 20, currencySymbol: '$' });
    assert.strictEqual(requestedUrls.length, 2);
    assert.match(requestedUrls[1], /offset=200/);
    assert.match(pagination.innerHTML, /Page 1 of 11/,
      'client-side pagination did not include transactions after the first API page');
  });

  await test('transaction history lets multi-server users choose an exact membership', async () => {
    const init = source('public/js/economy-transactions-init.js');
    assert.doesNotMatch(init, /data\.accounts\[0\]/,
      'transaction history silently selects the first linked server');
    assert.match(init, /economyMembershipSelect/);
    assert.match(init, /account\.server_name/);
    assert.match(init, /account\.platform/);
    assert.match(init, /selectionVersion/);
    assert.match(source('public/js/components/transactionList.js'), /requestVersion/);
    for (const page of ['public/economy-transactions.html', 'public/dashboard/economy-transactions.html']) {
      assert.match(source(page), /id="economyMembershipSelect"/,
        `${page} is missing the exact-server membership selector`);
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
