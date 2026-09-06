'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const source = p => fs.readFileSync(path.join(root, p), 'utf8');

async function testSinkUnderflow() {
  const manager = require('../utils/moneySupplyManager');
  const writes = [];
  const db = {
    get: async () => ({ current_money_supply: '1.00', fixed_supply_enabled: true, max_money_supply: '10.00', guild_id: 2 }),
    run: async sql => { writes.push(sql); return { lastID: 1 }; },
  };
  await assert.rejects(() => manager.removeFromSupplyInTransaction(db, 7, 1.01, 'test'), /underflow/i);
  assert.deepStrictEqual(writes, []);
}

function testReadRoutesAreNonCreating() {
  const economy = source('routes/economy.js');
  const shop = source('routes/shop.js');
  const playerGet = economy.slice(economy.indexOf("router.get('/player/:identityId'"), economy.indexOf("router.get('/player/:identityId/transactions'"));
  const stats = economy.slice(economy.indexOf('async function playerStats'), economy.indexOf("router.get('/player/:identityId/rank'"));
  const balance = shop.slice(shop.indexOf("router.get('/balance/:identityId/:serverId'"), shop.indexOf('\n});', shop.indexOf("router.get('/balance/:identityId/:serverId'")) + 4);
  for (const body of [playerGet, stats, balance]) {
    assert.doesNotMatch(body, /getOrCreate(?:Wallet|BankAccount)/);
    assert.match(body, /SELECT[\s\S]*(?:player_wallets|starting_cash)/);
  }
}

function testCrapsImmediateSettlementBound() {
  const casino = source('routes/casino.js');
  const start = casino.indexOf("operation: 'casino_craps_come_out'");
  const body = casino.slice(start, casino.indexOf('sendIdempotentCasinoResponse', start));
  assert(start >= 0, 'craps come-out idempotency boundary missing');
  assert.match(body, /actorUserId:\s*req\.user\.id/);
}

function testMigrationCapInvariant() {
  const migration = source('db/migrations/066_bounties.js');
  assert.match(migration, /current_money_supply\s*>\s*(?:config\.)?max_money_supply/);
}

function testConfigCasAndAssetTransition() {
  const economy = source('routes/economy.js');
  const adminService = source('services/economyAdminService.js');
  const body = economy.slice(economy.indexOf("router.post('/admin/:serverId/config'"), economy.indexOf("router.get('/admin/:serverId/stats'"));
  assert.match(body, /expectedVersion/);
  assert.match(body + adminService, /config_version|version\s*=\s*version\s*\+\s*1/);
  assert.match(body, /getAuthoritativeSupplyCents/);
  const manager = source('utils/moneySupplyManager.js');
  assert.match(manager, /casino_sessions/);
  assert.match(manager, /bounties/);
  assert.match(manager, /financial_refund_claims[\s\S]*status = 'pending'/,
    'the centralized authoritative aggregate must retain pending claims');
  assert.match(body, /max_money_supply/);
}

function testPlaytimeUsesRationalCents() {
  const parser = source('routes/logParser.js');
  const body = parser.slice(parser.indexOf('// Award once in the same transaction'), parser.indexOf('} catch (economyError)', parser.indexOf('// Award once in the same transaction')));
  assert.doesNotMatch(body, /playtime_reward_per_hour\s*\*\s*durationHours/);
  assert.match(body, /playtimeRewardCents/);
}

function testPlaytimeRoundingExamples() {
  const { playtimeRewardCents } = require('../utils/money');
  assert.strictEqual(playtimeRewardCents('10.00', 3600), 1000);
  assert.strictEqual(playtimeRewardCents('10.00', 1), 0);
  assert.strictEqual(playtimeRewardCents('18.00', 1), 1);
  assert.strictEqual(playtimeRewardCents('7.25', 3599), 725);
}

async function testSupplyRecalculationIsExactAndCapped() {
  const manager = require('../utils/moneySupplyManager');
  const writes = [];
  const makeDb = (total, config = {
    fixed_supply_enabled: false, max_money_supply: null, current_money_supply: '0.00'
  }) => ({
    transaction: async fn => fn(makeDb(total, config)),
    get: async sql => /FROM guild_economy_config/.test(sql) ? config : { total },
    run: async (sql, params) => { writes.push({ sql, params }); return { changes: 1 }; },
  });
  writes.length = 0;
  const hugeTotal = await manager.recalculateSupply(makeDb('90071992547409.93'), 7);
  assert.strictEqual(hugeTotal, '90071992547409.93');
  assert.strictEqual(writes[0].params[0], '90071992547409.93',
    'NUMERIC(20,2) aggregate beyond Number range must remain exact text');

  writes.length = 0;
  const total = await manager.recalculateSupply(makeDb('90071992547409.91'), 7);
  assert.strictEqual(total, 90071992547409.9);
  assert.strictEqual(writes[0].params[0], '90071992547409.91',
    'safe boundary must be written as canonical decimal text');

  writes.length = 0;
  await assert.rejects(() => manager.recalculateSupply(makeDb('10.01', {
    fixed_supply_enabled: true, max_money_supply: '10.00', current_money_supply: '0.00'
  }), 7), /maximum money supply/i);
  assert.strictEqual(writes.length, 0);
}

async function testWipePreservesFinancialHistory() {
  const wipeService = require('../services/wipeService');
  const writes = [];
  const db = {
    transaction: async fn => fn(db),
    get: async sql => {
      if (/SELECT s\.id[\s\S]*FROM servers/.test(sql)) return { id: 7 };
      return null;
    },
    run: async sql => { writes.push(sql); return { changes: 1 }; },
  };
  await wipeService.wipePlayer(db, { serverId: 7, identityId: 9, requestedByUserId: 3 });
  const destructive = writes.filter(sql => /^DELETE/i.test(sql.trim())).join('\n');
  for (const table of ['economy_transactions', 'economy_supply_log', 'player_wallets',
    'player_bank_accounts', 'casino_sessions', 'casino_game_history', 'bounties',
    'bounty_claims', 'shop_orders', 'shop_order_items', 'kill_events']) {
    assert.doesNotMatch(destructive, new RegExp(`DELETE FROM ${table}`, 'i'),
      `owner stats/history wipe must preserve ${table}`);
  }
}

function testEscrowDestructionProtectionSource() {
  const migration = source('db/migrations/066_bounties.js');
  for (const token of ['protect_active_bounty_delete', 'protect_active_casino_delete',
    'protect_active_bounty_truncate', 'protect_active_casino_truncate',
    'protect_server_deactivation_financial_escrow', 'protect_membership_active_financial_escrow',
    'protect_identity_active_financial_escrow', 'protect_guild_active_financial_escrow',
    'protect_user_active_financial_escrow']) assert.match(migration, new RegExp(token));
  const wipe = source('services/wipeService.js');
  assert.match(wipe, /active bounty escrow/i);
  assert.match(wipe, /active casino escrow/i);
}

(async () => {
  await testSinkUnderflow();
  testReadRoutesAreNonCreating();
  testCrapsImmediateSettlementBound();
  testMigrationCapInvariant();
  testConfigCasAndAssetTransition();
  testPlaytimeUsesRationalCents();
  testPlaytimeRoundingExamples();
  await testSupplyRecalculationIsExactAndCapped();
  await testWipePreservesFinancialHistory();
  testEscrowDestructionProtectionSource();
  console.log('Fail-closed remediation regressions passed');
})().catch(error => { console.error(error); process.exit(1); });
