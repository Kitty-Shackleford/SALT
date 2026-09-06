'use strict';

const assert = require('assert');
const economyHelper = require('../utils/economyHelper');
const {
  isFinancialLinkMethod,
  lockTrustedFinancialIdentity,
} = require('../utils/linkTrust');

async function testAward() {
  const calls = [];
  const runs = [];
  const db = {
    transactionStorage: { getStore: () => ({ client: {} }) },
    async get(sql) {
      calls.push(sql);
      if (/SELECT id, guild_id FROM servers/.test(sql)) return { id: 7, guild_id: 1 };
      if (/SELECT \* FROM guild_economy_config/.test(sql)) {
        return { server_id: 7, enabled: true, fixed_supply_enabled: false };
      }
      if (/SELECT server_id, fixed_supply_enabled/.test(sql)) return { server_id: 7 };
      if (/SELECT gec\.\*/.test(sql)) return { enabled: true, fixed_supply_enabled: false };
      if (/SELECT \* FROM player_wallets/.test(sql)) return { cash_on_hand: '0.20' };
      if (/SELECT guild_id, starting_cash/.test(sql)) return { starting_cash: '0.00' };
      throw new Error(`Unexpected get: ${sql}`);
    },
    async run(sql, params) {
      runs.push({ sql, params });
      return { changes: 1, lastID: 4 };
    },
  };
  const result = await economyHelper.awardMoneyInTransaction(
    db, 2, 0.1, 'test_reward', 'test', 7);
  assert.strictEqual(result.newBalance, 0.3);
  assert.ok(calls.findIndex(sql => /guild_economy_config[\s\S]*FOR UPDATE/.test(sql)) <
    calls.findIndex(sql => /player_wallets[\s\S]*FOR UPDATE/.test(sql)),
  'reward must lock config/supply parent before wallet');
  assert.strictEqual(runs.find(call => /UPDATE player_wallets/.test(call.sql)).params[0], '0.30');
  const ledger = runs.find(call => /INSERT INTO economy_transactions/.test(call.sql));
  assert.strictEqual(ledger.params[2], '0.10');
  assert.strictEqual(ledger.params[3], '0.30', 'ledger balance_after must equal exact wallet write');
}

async function testDestinationCapacityBoundary() {
  const { checkedAddCents } = require('../utils/money');
  assert.strictEqual(checkedAddCents(Number.MAX_SAFE_INTEGER - 1, 1), Number.MAX_SAFE_INTEGER);
  assert.throws(() => checkedAddCents(Number.MAX_SAFE_INTEGER, 1), /capacity/i);

  const writes = [];
  const db = {
    async get(sql) {
      if (/SELECT id, guild_id FROM servers/.test(sql)) return { id: 7, guild_id: 1 };
      if (/SELECT \* FROM guild_economy_config/.test(sql)) {
        return { server_id: 7, enabled: true, fixed_supply_enabled: false };
      }
      if (/SELECT server_id, fixed_supply_enabled/.test(sql)) return { server_id: 7 };
      if (/SELECT gec\.\*/.test(sql)) return { enabled: true, fixed_supply_enabled: false };
      if (/SELECT \* FROM player_wallets/.test(sql)) return { cash_on_hand: '90071992547409.91' };
      if (/SELECT guild_id, starting_cash/.test(sql)) return { starting_cash: '0.00' };
      throw new Error(`Unexpected get: ${sql}`);
    },
    async run(sql) { writes.push(sql); return { changes: 1 }; },
  };
  await assert.rejects(() => economyHelper.awardMoneyInTransaction(
    db, 2, 0.01, 'test_reward', 'test', 7), /capacity/i);
  assert.deepStrictEqual(writes, [], 'overflowing destination credit must reject before writes');
}

function testCreditWriterInventoryUsesCommonCapacityCheck() {
  const fs = require('fs');
  const path = require('path');
  for (const file of ['utils/economyHelper.js', 'routes/economy.js', 'routes/casino.js',
    'services/bountyService.js', 'services/shopFileService.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.match(source, /checkedAddCents/, `${file} must use the common destination capacity check`);
    assert.doesNotMatch(source, /cash_on_hand\s*=\s*(?:cash_on_hand|player_wallets\.cash_on_hand)\s*\+/,
      `${file} must not bypass exact pre-write capacity checks with SQL arithmetic`);
  }
}

async function testDailyPercentageFee() {
  const calls = [];
  const runs = [];
  const config = {
    server_id: 7, enabled: true, bank_enabled: true, bank_daily_fee_enabled: true,
    bank_daily_fee_type: 'percentage', bank_daily_fee_amount: '2.50',
    fixed_supply_enabled: false,
  };
  let claimed = false;
  const db = {
    async query(sql) {
      if (/FROM guild_economy_config/.test(sql)) return [config];
      if (/FROM player_bank_accounts/.test(sql)) return [{ identity_id: 2 }];
      return [];
    },
    async transaction(callback) { return callback(); },
    async get(sql) {
      calls.push(sql);
      if (/INSERT INTO economy_daily_assessments/.test(sql)) {
        if (claimed) return null;
        claimed = true;
        return { id: 1 };
      }
      if (/SELECT id, guild_id FROM servers/.test(sql)) return { id: 7, guild_id: 1 };
      if (/SELECT \* FROM guild_economy_config/.test(sql)) return config;
      if (/SELECT server_id, fixed_supply_enabled/.test(sql)) return { server_id: 7 };
      if (/SELECT balance FROM player_bank_accounts/.test(sql)) return { balance: '10.10' };
      throw new Error(`Unexpected get: ${sql}`);
    },
    async run(sql, params) { runs.push({ sql, params }); return { changes: 1 }; },
  };
  const first = await economyHelper.processDailyBankFees(db, '2026-09-02');
  const replay = await economyHelper.processDailyBankFees(db, '2026-09-02');
  assert.strictEqual(first.totalFeesCollected, 0.25);
  assert.strictEqual(replay.totalFeesCollected, 0);
  assert.strictEqual(replay.accountsSkipped, 1);
  assert.strictEqual(runs.filter(call => /UPDATE player_bank_accounts/.test(call.sql)).length, 1,
    'same-day replay must not charge the account twice');
  assert.ok(calls.findIndex(sql => /guild_economy_config[\s\S]*FOR UPDATE/.test(sql)) <
    calls.findIndex(sql => /player_bank_accounts[\s\S]*FOR UPDATE/.test(sql)),
  'daily fee must lock config/supply parent before bank');
  assert.strictEqual(runs.find(call => /UPDATE player_bank_accounts/.test(call.sql)).params[0], '9.85');
  const ledger = runs.find(call => /INSERT INTO economy_transactions/.test(call.sql));
  assert.deepStrictEqual(ledger.params.slice(2), ['-0.25', '9.85']);
}

async function testDailyInactivityTaxReplayIsSkipped() {
  let claimed = false;
  const runs = [];
  const config = {
    server_id: 7,
    enabled: true,
    inactivity_tax_enabled: true,
    inactivity_threshold_days: 30,
    inactivity_tax_percentage: '10.00',
    fixed_supply_enabled: false,
  };
  const db = {
    async query(sql) {
      if (/FROM guild_economy_config/.test(sql)) return [config];
      if (/FROM player_server_activity/.test(sql)) {
        return [{ identity_id: 2, last_seen: '2020-01-01T00:00:00.000Z' }];
      }
      return [];
    },
    async transaction(callback) { return callback(); },
    async get(sql) {
      if (/INSERT INTO economy_daily_assessments/.test(sql)) {
        if (claimed) return null;
        claimed = true;
        return { id: 2 };
      }
      if (/SELECT id, guild_id FROM servers/.test(sql)) return { id: 7, guild_id: 1 };
      if (/SELECT \* FROM guild_economy_config/.test(sql)) return config;
      if (/FROM player_server_activity/.test(sql)) return { eligible: true };
      if (/SELECT cash_on_hand FROM player_wallets/.test(sql)) return { cash_on_hand: '10.00' };
      if (/SELECT balance FROM player_bank_accounts/.test(sql)) return { balance: '0.00' };
      throw new Error(`Unexpected get: ${sql}`);
    },
    async run(sql, params) { runs.push({ sql, params }); return { changes: 1 }; },
  };

  const first = await economyHelper.processInactivityTax(db, '2026-09-02');
  const replay = await economyHelper.processInactivityTax(db, '2026-09-02');
  assert.strictEqual(first.totalTaxCollected, 1);
  assert.strictEqual(replay.totalTaxCollected, 0);
  assert.strictEqual(replay.playersSkipped, 1);
  assert.strictEqual(runs.filter(call => /UPDATE player_wallets/.test(call.sql)).length, 1,
    'same-day replay must not tax the player twice');
}

async function testZeroBalanceDailyFeeConsumesAssessment() {
  const config = {
    server_id: 7, enabled: true, bank_enabled: true, bank_daily_fee_enabled: true,
    bank_daily_fee_type: 'fixed', bank_daily_fee_amount: '1.00', fixed_supply_enabled: false,
  };
  const writes = [];
  const db = {
    async query(sql) {
      if (/FROM guild_economy_config/.test(sql)) return [config];
      if (/FROM player_bank_accounts/.test(sql)) {
        assert.doesNotMatch(sql, /balance\s*>\s*0/i,
          'daily fee discovery must include zero-balance accounts');
        return [{ identity_id: 2 }];
      }
      return [];
    },
    async transaction(callback) { return callback(); },
    async get(sql) {
      if (/SELECT id, guild_id FROM servers/.test(sql)) return { id: 7, guild_id: 1 };
      if (/SELECT \* FROM guild_economy_config/.test(sql)) return config;
      if (/SELECT balance FROM player_bank_accounts/.test(sql)) return { balance: '0.00' };
      if (/INSERT INTO economy_daily_assessments/.test(sql)) return { id: 9 };
      throw new Error(`Unexpected get: ${sql}`);
    },
    async run(sql, params) { writes.push({ sql, params }); return { changes: 1 }; },
  };

  await economyHelper.processDailyBankFees(db, '2026-09-02');
  const completion = writes.find(call => /UPDATE economy_daily_assessments/.test(call.sql));
  assert.ok(completion, 'a valid zero-balance assessment must be completed for the business date');
  assert.strictEqual(completion.params[0], '0.00');
  assert.strictEqual(writes.some(call => /UPDATE player_bank_accounts/.test(call.sql)), false);
}

async function testInactivityTaxLocksCurrentActivity() {
  const config = {
    server_id: 7, enabled: true, inactivity_tax_enabled: true,
    inactivity_threshold_days: 30, inactivity_tax_percentage: '10.00', fixed_supply_enabled: false,
  };
  let claims = 0;
  const writes = [];
  const db = {
    async query(sql) {
      if (/FROM guild_economy_config/.test(sql)) return [config];
      if (/FROM player_server_activity/.test(sql)) {
        return [{ identity_id: 2, last_seen: '2020-01-01T00:00:00.000Z' }];
      }
      return [];
    },
    async transaction(callback) { return callback(); },
    async get(sql) {
      if (/SELECT id, guild_id FROM servers/.test(sql)) return { id: 7, guild_id: 1 };
      if (/SELECT \* FROM guild_economy_config/.test(sql)) return config;
      if (/FROM player_server_activity/.test(sql)) {
        assert.match(sql, /clock_timestamp\(\)/i,
          'eligibility must use the database clock after acquiring the activity lock');
        assert.match(sql, /FOR UPDATE/i, 'current exact-server activity must be locked');
        return { eligible: false };
      }
      if (/INSERT INTO economy_daily_assessments/.test(sql)) {
        claims++;
        return { id: 10 };
      }
      if (/SELECT cash_on_hand FROM player_wallets/.test(sql)) return { cash_on_hand: '10.00' };
      if (/SELECT balance FROM player_bank_accounts/.test(sql)) return { balance: '10.00' };
      throw new Error(`Unexpected get: ${sql}`);
    },
    async run(sql) { writes.push(sql); return { changes: 1 }; },
  };

  const result = await economyHelper.processInactivityTax(db, '2026-09-02');
  assert.strictEqual(result.totalTaxCollected, 0);
  assert.strictEqual(claims, 0, 'recent activity under lock must deny the tax before claiming');
  assert.deepStrictEqual(writes, [], 'recent activity under lock must deny all monetary writes');
}

async function testDailyAssessmentsRevalidateLockedPolicy() {
  for (const assessment of ['bank_fee', 'inactivity_tax']) {
    let claims = 0;
    const writes = [];
    const discoveredConfig = assessment === 'bank_fee'
      ? {
        server_id: 7, enabled: true, bank_enabled: true,
        bank_daily_fee_enabled: true, bank_daily_fee_type: 'fixed',
        bank_daily_fee_amount: '1.00', fixed_supply_enabled: false,
      }
      : {
        server_id: 7, enabled: true, inactivity_tax_enabled: true,
        inactivity_threshold_days: 1, inactivity_tax_percentage: '10.00',
        fixed_supply_enabled: false,
      };
    const db = {
      async query(sql) {
        if (/FROM guild_economy_config/.test(sql)) return [discoveredConfig];
        if (/FROM player_bank_accounts/.test(sql)) return [{ identity_id: 2 }];
        if (/FROM player_server_activity/.test(sql)) {
          return [{ identity_id: 2, last_seen: '2020-01-01T00:00:00.000Z' }];
        }
        return [];
      },
      async transaction(callback) { return callback(); },
      async get(sql) {
        if (/SELECT id, guild_id FROM servers/.test(sql)) return { id: 7, guild_id: 1 };
        if (/SELECT \* FROM guild_economy_config/.test(sql)) {
          return { ...discoveredConfig, enabled: false };
        }
        if (/INSERT INTO economy_daily_assessments/.test(sql)) {
          claims++;
          return { id: 1 };
        }
        if (/SELECT balance FROM player_bank_accounts/.test(sql)) return { balance: '10.00' };
        if (/SELECT cash_on_hand FROM player_wallets/.test(sql)) return { cash_on_hand: '10.00' };
        throw new Error(`Unexpected get: ${sql}`);
      },
      async run(sql) { writes.push(sql); return { changes: 1 }; },
    };

    const result = assessment === 'bank_fee'
      ? await economyHelper.processDailyBankFees(db, '2026-09-02')
      : await economyHelper.processInactivityTax(db, '2026-09-02');
    assert.strictEqual(
      assessment === 'bank_fee' ? result.totalFeesCollected : result.totalTaxCollected,
      0,
      `${assessment} must not use policy revoked before the account transaction`
    );
    assert.strictEqual(claims, 0, `${assessment} must not consume a daily claim under revoked policy`);
    assert.deepStrictEqual(writes, [], `${assessment} must not mutate money under revoked policy`);
  }
}

async function testFinancialTrustPolicy() {
  assert.strictEqual(isFinancialLinkMethod('self_asserted'), true,
    'active self-asserted links must authorize exact-resource financial actions');
  assert.strictEqual(isFinancialLinkMethod('manual'), false,
    'legacy unscoped link methods must not authorize financial actions');
  const calls = [];
  const db = {
    async get(sql, params) {
      calls.push({ sql, params });
      if (calls.length === 1) return {};
      if (calls.length === 2) return { guild_id: 4 };
      if (calls.length === 3) return { id: 4 };
      if (calls.length === 4) return { id: 3 };
      if (calls.length === 5) return { server_id: 3 };
      if (calls.length === 6) return { id: 12, source_link_id: 9 };
      if (calls.length === 7) return { id: 9 };
      if (calls.length === 8) return { id: 12 };
      throw new Error('unexpected financial authorization query');
    },
  };
  assert.deepStrictEqual(await lockTrustedFinancialIdentity(
    db, { userId: 1, identityId: 2, serverId: 3 }), { id: 12 });
  assert.strictEqual(calls.length, 8);
  assert.match(calls[0].sql, /pg_advisory_xact_lock/i);
  assert.match(calls[3].sql, /FROM servers[\s\S]*FOR NO KEY UPDATE/i,
    'financial authorization must not block an independent provider-ledger FK insert');
  assert.match(calls[4].sql, /guild_economy_config[\s\S]*FOR UPDATE/i,
    'financial authorization must lock economy config before membership discovery');
  assert.match(calls[5].sql, /server_player_memberships[\s\S]*server_id = \?[\s\S]*user_id = \?[\s\S]*identity_id = \?/i,
    'discovery must bind the exact user, identity, and server');
  assert.doesNotMatch(calls[5].sql, /FOR UPDATE/i, 'discovery must not invert proof-first locking');
  assert.match(calls[6].sql, /linked_accounts[\s\S]*id = \?[\s\S]*user_id = \?[\s\S]*identity_id = \?[\s\S]*FOR UPDATE/i);
  assert.ok(calls[6].params.includes('self_asserted'),
    'financial operation-time trust must accept active linked accounts');
  assert.match(calls[7].sql, /server_player_memberships[\s\S]*source_link_id = \?[\s\S]*status = 'active'[\s\S]*FOR UPDATE/i);
}

async function testFinancialTrustRevocationDeniesBeforeMembershipOrWrites() {
  const calls = [];
  let writes = 0;
  const db = {
    async get(sql, params) {
      calls.push({ sql, params });
      if (calls.length === 1) return {};
      if (calls.length === 2) return { guild_id: 4 };
      if (calls.length === 3) return { id: 4 };
      if (calls.length === 4) return { id: 3 };
      if (calls.length === 5) return { server_id: 3 };
      if (calls.length === 6) return { id: 12, source_link_id: 9 };
      if (calls.length === 7) return null;
      throw new Error('membership lock must not run after proof revocation');
    },
    async run() { writes++; throw new Error('revoked authority must not write'); },
  };
  assert.strictEqual(await lockTrustedFinancialIdentity(
    db, { userId: 1, identityId: 2, serverId: 3 }), null);
  assert.strictEqual(calls.length, 7, 'proof revocation must deny before membership locking');
  assert.strictEqual(writes, 0, 'proof revocation must perform zero writes');
}

(async () => {
  await testAward();
  await testDestinationCapacityBoundary();
  testCreditWriterInventoryUsesCommonCapacityCheck();
  await testDailyPercentageFee();
  await testDailyInactivityTaxReplayIsSkipped();
  await testZeroBalanceDailyFeeConsumesAssessment();
  await testInactivityTaxLocksCurrentActivity();
  await testDailyAssessmentsRevalidateLockedPolicy();
  await testFinancialTrustPolicy();
  await testFinancialTrustRevocationDeniesBeforeMembershipOrWrites();
  console.log('financial exact writer tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
