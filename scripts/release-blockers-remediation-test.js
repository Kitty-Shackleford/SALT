'use strict';

const assert = require('assert');

async function testRecalculationRevalidatesRevokedAuthorityBeforeWrites() {
  const { recalculateSupplyForAdmin } = require('../services/economyAdminService');
  const writes = [];
  const reads = [];
  const db = {
    async transaction(callback) { return callback(this); },
    async get(sql, params) {
      reads.push({ sql, params });
      if (/pg_advisory_xact_lock/.test(sql)) return {};
      if (/FROM guilds/.test(sql)) return { id: 3 };
      if (/FROM servers/.test(sql)) return { id: 7, guild_id: 3 };
      if (/FROM guild_roles/.test(sql)) return null;
      if (/FROM server_role_assignments/.test(sql)) return null;
      throw new Error(`unexpected read: ${sql}`);
    },
    async run(sql, params) { writes.push({ sql, params }); return { changes: 1 }; },
  };

  await assert.rejects(
    () => recalculateSupplyForAdmin(db, { serverId: 7, guildId: 3, userId: 5 }),
    /Server management permission is required/
  );
  assert.strictEqual(writes.length, 0, 'stale-authority denial must perform zero protected writes');
  assert.deepStrictEqual(reads[0].params, [2147483001, 5], 'actor authority lock must be first');
  assert.match(reads[1].sql, /FROM guilds[\s\S]*FOR UPDATE/i);
  assert.match(reads[2].sql, /FROM servers[\s\S]*FOR UPDATE/i);
  assert.match(reads[3].sql, /FROM guild_roles[\s\S]*FOR UPDATE/i);
  assert.match(reads[4].sql, /FROM server_role_assignments[\s\S]*FOR UPDATE/i);
}

async function testFinancialLocksUseGlobalOrder() {
  const manager = require('../utils/moneySupplyManager');
  const supplyReads = [];
  const supplyDb = {
    async get(sql) {
      supplyReads.push(sql);
      if (/FROM servers/.test(sql)) return { id: 7, guild_id: 3 };
      if (/FROM guild_economy_config/.test(sql)) return {
        server_id: 7, guild_id: 3, fixed_supply_enabled: false,
        current_money_supply: '10.00', max_money_supply: null,
      };
      throw new Error(`unexpected supply read: ${sql}`);
    },
  };
  await manager.lockSupplyForUpdate(supplyDb, 7);
  assert.match(supplyReads[0], /FROM servers[\s\S]*FOR NO KEY UPDATE/i,
    'server supply lock must serialize financial work without blocking durable provider-operation FK inserts');
  assert.match(supplyReads[1], /FROM guild_economy_config[\s\S]*FOR UPDATE/i,
    'economy config must lock after server');

  const { lockTrustedFinancialIdentity } = require('../utils/linkTrust');
  const identityReads = [];
  const identityDb = {
    async get(sql) {
      identityReads.push(sql);
      if (/pg_advisory_xact_lock/.test(sql)) return {};
      if (/SELECT guild_id FROM servers/.test(sql)) return { guild_id: 3 };
      if (/FROM guilds/.test(sql)) return { id: 3 };
      if (/FROM servers/.test(sql)) return { id: 7 };
      if (/FROM guild_economy_config/.test(sql)) return { server_id: 7 };
      if (/FROM server_player_memberships/.test(sql) && !/FOR UPDATE/.test(sql)) {
        return { id: 11, source_link_id: 13 };
      }
      if (/FROM linked_accounts/.test(sql)) return { id: 13 };
      if (/FROM server_player_memberships/.test(sql)) return { id: 11 };
      throw new Error(`unexpected identity read: ${sql}`);
    },
  };
  assert.ok(await lockTrustedFinancialIdentity(identityDb, {
    userId: 5, identityId: 2, serverId: 7,
  }));
  const advisoryIndex = identityReads.findIndex(sql => /pg_advisory_xact_lock/.test(sql));
  const serverIndex = identityReads.findIndex(sql => /FROM servers[\s\S]*FOR NO KEY UPDATE/i.test(sql));
  const configIndex = identityReads.findIndex(sql => /FROM guild_economy_config[\s\S]*FOR UPDATE/i.test(sql));
  const membershipIndex = identityReads.findIndex(sql => /FROM server_player_memberships/.test(sql));
  assert.ok(advisoryIndex >= 0 && advisoryIndex < serverIndex,
    'actor advisory lock must precede server');
  assert.ok(serverIndex < configIndex, 'server must precede economy config');
  assert.ok(configIndex < membershipIndex, 'economy config must precede membership');
}

async function testRecalculationEndpointAndUiShareCurrentMoneySupplyContract() {
  const economyRouter = require('../routes/economy');
  const route = economyRouter.stack.find(layer =>
    layer.route?.path === '/admin/:serverId/recalculate-supply' && layer.route.methods.post
  );
  assert.ok(route, 'recalculation endpoint must exist');
  const handler = route.route.stack[route.route.stack.length - 1].handle;
  const db = {
    async transaction(callback) { return callback(this); },
    async get(sql) {
      if (/pg_advisory_xact_lock/.test(sql)) return {};
      if (/FROM guilds/.test(sql)) return { id: 3 };
      if (/FROM servers/.test(sql)) return { id: 7, guild_id: 3 };
      if (/FROM guild_roles/.test(sql)) return { role: 'owner' };
      if (/FROM server_role_assignments/.test(sql)) return null;
      if (/FROM guild_economy_config/.test(sql)) return {
        server_id: 7, fixed_supply_enabled: false,
        current_money_supply: '0.00', max_money_supply: null,
      };
      if (/AS total/.test(sql)) return { total: '123.45' };
      throw new Error(`unexpected read: ${sql}`);
    },
    async run() { return { changes: 1 }; },
  };
  let payload;
  await handler({
    app: { locals: { db } }, user: { id: 5 },
    authorization: { server: { id: 7 }, guild: { id: 3 } },
  }, { json(value) { payload = value; return value; } });
  assert.deepStrictEqual(payload, { success: true, currentMoneySupply: 123.45 });

  const fs = require('fs');
  const path = require('path');
  const ui = fs.readFileSync(path.join(__dirname, '../public/js/admin/economy-settings.js'), 'utf8');
  const recalculationStart = ui.lastIndexOf("document.getElementById('recalculateSupplyBtn')");
  const recalculationUi = ui.slice(recalculationStart, ui.indexOf('\n  });', recalculationStart) + 6);
  assert.match(recalculationUi, /data\.currentMoneySupply/);
  assert.doesNotMatch(recalculationUi, /data\.total\b/);
}

async function testProspectiveConfigIsReadOnlyAndFirstSaveUsesCas() {
  const {
    getEditableEconomyConfig,
    saveEconomyConfigInTransaction,
  } = require('../services/economyAdminService');
  const writes = [];
  const readDb = {
    async get() { return null; },
    async run(sql, params) { writes.push({ sql, params }); return { changes: 1 }; },
  };
  const prospective = await getEditableEconomyConfig(readDb, 7);
  assert.strictEqual(prospective.version, 1);
  assert.strictEqual(prospective.currencyName, 'Dollar');
  assert.strictEqual(prospective.startingCash, 1000);
  assert.strictEqual(writes.length, 0, 'GET/default config lookup must remain read-only');

  let stored = null;
  const saveDb = {
    async get(sql) {
      if (/guild_economy_config/.test(sql)) return stored;
      throw new Error(`unexpected read: ${sql}`);
    },
    async run(sql, params) {
      writes.push({ sql, params });
      if (/INSERT INTO guild_economy_config/.test(sql)) {
        if (stored) return { changes: 0 };
        stored = { server_id: 7, guild_id: 3, version: 2, current_money_supply: '0.00', enabled: true };
        return { changes: 1 };
      }
      throw new Error(`unexpected write: ${sql}`);
    },
  };
  const first = await saveEconomyConfigInTransaction(
    saveDb, { serverId: 7, guildId: 3 }, { enabled: true }, ['enabled'], 1
  );
  assert.strictEqual(first.version, 2);
  await assert.rejects(
    () => saveEconomyConfigInTransaction(
      saveDb, { serverId: 7, guildId: 3 }, { enabled: false }, ['enabled'], 1
    ),
    /changed; reload/i,
    'a concurrent first-save loser must receive a version conflict'
  );
  assert.strictEqual(writes.filter(write => /INSERT INTO guild_economy_config/.test(write.sql)).length, 1,
    'the stale contender must not issue another protected write after observing version 2');
}

async function testBankFeeVisibleOptionsRoundTripCanonicalEnum() {
  const fs = require('fs');
  const path = require('path');
  const { ECONOMY_ENUM_FIELDS, serializeEditableEconomyConfig } = require('../services/economyAdminService');
  const html = fs.readFileSync(path.join(__dirname, '../public/dashboard/economy-settings.html'), 'utf8');
  const select = html.match(/<select[^>]+id="bankDailyFeeType"[\s\S]*?<\/select>/i)?.[0];
  assert.ok(select, 'bank fee type select must remain visible');
  const values = [...select.matchAll(/<option\s+value="([^"]+)"/g)].map(match => match[1]);
  assert.deepStrictEqual(values, ['percentage', 'fixed']);
  for (const value of values) assert.ok(ECONOMY_ENUM_FIELDS.bank_daily_fee_type.has(value));
  assert.strictEqual(
    serializeEditableEconomyConfig({ version: 4, bank_daily_fee_type: 'flat' }).bankDailyFeeType,
    'fixed',
    'legacy persisted flat synonym must render as the canonical fixed option'
  );
}

async function testUnsupportedTerritoryRewardsRemainDisabled() {
  const fs = require('fs');
  const path = require('path');
  const { serializeEditableEconomyConfig } = require('../services/economyAdminService');
  const config = serializeEditableEconomyConfig({
    version: 4,
    territory_rewards_enabled: true,
    territory_reward_per_hour: '25.00',
  });
  assert.strictEqual(config.territoryRewardsEnabled, false,
    'legacy persisted territory settings must not be presented as operational');
  assert.strictEqual(config.territoryRewardsSupported, false);
  assert.strictEqual(config.territoryRewardPerHour, 5,
    'legacy persisted reward amounts must not be presented as active configuration');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(config, 'territory_rewards_enabled'), false,
    'raw persisted territory enablement must not leak into the API response');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(config, 'territory_reward_per_hour'), false,
    'raw persisted territory reward amounts must not leak into the API response');

  const economyRouter = require('../routes/economy');
  const route = economyRouter.stack.find(layer =>
    layer.route?.path === '/admin/:serverId/config' && layer.route.methods.post
  );
  const handler = route.route.stack[route.route.stack.length - 1].handle;
  let transactionCalled = false;
  const req = {
    app: { locals: { db: { async transaction() { transactionCalled = true; } } } },
    user: { id: 5 },
    authorization: { server: { id: 7 }, guild: { id: 3 } },
    body: { expectedVersion: 4, economy: { territory_rewards_enabled: true } },
  };
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await handler(req, res);
  assert.strictEqual(res.statusCode, 400);
  assert.match(res.body.error, /territory rewards are unavailable/i);
  assert.strictEqual(transactionCalled, false,
    'unsupported territory settings must not reach persistence');

  const playerRoute = economyRouter.stack.find(layer =>
    layer.route?.path === '/player/:identityId' && layer.route.methods.get
  );
  const playerHandler = playerRoute.route.stack[playerRoute.route.stack.length - 1].handle;
  const playerRows = [
    { id: 2, gamertag: 'Survivor' },
    {
      enabled: true,
      bank_enabled: false,
      currency_name: 'Credits',
      currency_symbol: '$',
      territory_rewards_enabled: true,
      territory_reward_per_hour: '25.00',
      version: 4,
    },
    { identity_id: 2, server_id: 7, cash_on_hand: '10.00' },
  ];
  const playerReq = {
    app: { locals: { db: { async get() { return playerRows.shift(); } } } },
    params: { identityId: '2' },
    playerServerAccess: { serverId: 7, guildId: 3 },
  };
  const playerRes = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await playerHandler(playerReq, playerRes);
  assert.strictEqual(playerRes.statusCode, 200);
  assert.strictEqual(playerRes.body.config.territoryRewardsEnabled, false,
    'player economy reads must force legacy territory enablement off');
  assert.strictEqual(playerRes.body.config.territoryRewardsSupported, false);
  assert.strictEqual(playerRes.body.config.territoryRewardPerHour, 5,
    'player economy reads must not expose a persisted territory reward amount');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(playerRes.body.config, 'territory_rewards_enabled'), false,
    'player economy reads must suppress raw territory enablement');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(playerRes.body.config, 'territory_reward_per_hour'), false,
    'player economy reads must suppress raw territory reward amounts');

  const client = fs.readFileSync(path.join(__dirname, '../public/js/admin/economy-settings.js'), 'utf8');
  for (const page of ['economy-settings.html', 'economy.html']) {
    const html = fs.readFileSync(path.join(__dirname, '../public/dashboard', page), 'utf8');
    assert.match(html, /Territory Rewards[\s\S]*Currently unavailable[\s\S]*id="territoryRewardPerHour"[^>]*disabled[\s\S]*id="territoryRewardsEnabled"[^>]*disabled/i,
      `${page} must present territory rewards as unavailable and non-editable`);
  }
  const saveBlock = client.slice(client.indexOf('async function saveConfiguration'), client.indexOf('// ── Reset form'));
  assert.doesNotMatch(saveBlock, /territory_rewards_enabled\s*:/);
  assert.doesNotMatch(saveBlock, /territory_reward_per_hour\s*:/);
}

async function testExactMonetaryReportingBoundaries() {
  const manager = require('../utils/moneySupplyManager');
  const { serializeTransaction } = require('../utils/economyTransactions');
  const db = {
    async get() {
      return {
        fixed_supply_enabled: true,
        current_money_supply: '90071992547409.93',
        max_money_supply: '180143985094819.86',
      };
    },
    async query() {
      return [
        { change_type: 'faucet', source: 'huge', total: '90071992547409.93' },
        { change_type: 'faucet', source: 'small', total: '0.02' },
        { change_type: 'sink', source: 'fee', total: '0.01' },
      ];
    },
  };
  const stats = await manager.getSupplyStats(db, 7, 7);
  assert.strictEqual(stats.currentSupply, '90071992547409.93');
  assert.strictEqual(stats.maxSupply, '180143985094819.86');
  assert.strictEqual(stats.utilizationPercent, 50);
  assert.strictEqual(stats.faucets.bySource.huge, '90071992547409.93');
  assert.strictEqual(stats.faucets.bySource.small, 0.02);
  assert.strictEqual(stats.faucets.total7d, '90071992547409.95');
  assert.strictEqual(stats.sinks.total7d, 0.01);
  assert.strictEqual(stats.netChange7d, '90071992547409.94');

  const transaction = serializeTransaction({
    id: 1, identity_id: 2, server_id: 7, transaction_type: 'debit',
    amount: '90071992547409.93', balance_after: '90071992547409.94',
    account_type: 'wallet', source_identity_id: null,
  });
  assert.strictEqual(transaction.amount, '-90071992547409.93');
  assert.strictEqual(transaction.balanceAfter, '90071992547409.94');
}

async function testTouchedApiSerializersPreserveLargeMoney() {
  const fs = require('fs');
  const path = require('path');
  const { serializeBounty } = require('../services/bountyService');
  assert.strictEqual(serializeBounty({
    id: 1, server_id: 7, target_identity_id: 2, poster_identity_id: 3,
    funding_type: 'player_wallet', amount: '90071992547409.93', status: 'active',
  }).amount, '90071992547409.93');

  const source = relative => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
  assert.doesNotMatch(source('routes/economy.js'), /cashOnHand:\s*Number\(wallet\.cash_on_hand\)/);
  assert.doesNotMatch(source('routes/economy.js'), /balance:\s*Number\(bank\.balance\)/);
  assert.doesNotMatch(source('routes/shop.js'), /wallet:\s*Number\(wallet\?\.cash_on_hand/);
  assert.doesNotMatch(source('routes/casino.js'), /balance:\s*Number\(wallet\?\.cash_on_hand/);

  const { fetchWalletBalance } = require('../workers/feedProcessor');
  const feedBalance = await fetchWalletBalance({
    async get() { return { cash_on_hand: '90071992547409.93' }; },
  }, 2, 7);
  assert.strictEqual(feedBalance, '90071992547409.93',
    'the feed worker must not round an exact NUMERIC wallet balance');
}

function testTruthfulExactBountyFeedFormatting() {
  const { buildKillEmbedPayload } = require('../utils/feedMessageFormatter');
  const payload = buildKillEmbedPayload(
    { killer: 'K', victim: 'V' }, {}, {}, {
      currencySymbol: '$', killerBalance: '90071992547409.94',
      bountyAwardAmount: '12.34', bountyRefundAmount: '5.67',
      bountyDeferredAwardAmount: '8.90',
      bountyDeferredRefundAmount: '90071992547409.93',
    }, {}, 'Server'
  );
  const economy = payload.embeds[0].fields.find(field => /Economy$/.test(field.name)).value;
  assert.match(economy, /\+\$12\.34 bounty reward/);
  assert.match(economy, /\+\$5\.67 bounty refund/);
  assert.match(economy, /\$8\.90 bounty award deferred as claim/);
  assert.match(economy, /\$90071992547409\.93 bounty refund deferred as claim/);
  assert.match(economy, /Balance: \$90071992547409\.94/);
}

function testBountySettlementFieldsRemainDistinctAcrossPipeline() {
  const fs = require('fs');
  const path = require('path');
  const source = relative => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
  for (const field of [
    'bountyAwardAmount', 'bountyRefundAmount',
    'bountyDeferredAwardAmount', 'bountyDeferredRefundAmount',
  ]) {
    assert.match(source('routes/logParser.js'), new RegExp(field));
    assert.match(source('workers/feedProcessor.js'), new RegExp(field));
    assert.match(source('utils/feedMessageFormatter.js'), new RegExp(field));
  }
  const bounty = source('services/bountyService.js');
  assert.match(bounty, /deferredAwardAmount/);
  assert.match(bounty, /deferredRefundAmount/);
}

function testResetsPreserveRefundClaims() {
  const fs = require('fs');
  const path = require('path');
  const admin = fs.readFileSync(path.join(__dirname, '../routes/admin.js'), 'utf8');
  const full = admin.slice(admin.indexOf('const FULL_RESET_PRESERVE_TABLES'),
    admin.indexOf('const PLAYER_RESET_PRESERVE_TABLES'));
  const player = admin.slice(admin.indexOf('const PLAYER_RESET_PRESERVE_TABLES'),
    admin.indexOf('function quoteIdent'));
  assert.match(full, /'financial_refund_claims'/);
  assert.match(player, /'financial_refund_claims'/);
}

async function testNonFixedStaleSupplyDoesNotBlockFinancialSinks() {
  const manager = require('../utils/moneySupplyManager');
  for (const scenario of [
    { source: 'transfer_fee', current: '0.00', amount: '1.25' },
    { source: 'deposit_fee', current: '0.25', amount: '0.50' },
    { source: 'casino', current: '0.00', amount: '10.00' },
  ]) {
    const writes = [];
    const db = {
      async get(sql) {
        if (/FROM servers/.test(sql)) return { id: 7, guild_id: 3 };
        assert.match(sql, /guild_economy_config/);
        return {
          guild_id: 3, fixed_supply_enabled: false,
          current_money_supply: scenario.current, max_money_supply: null,
        };
      },
      async run(sql, params) {
        writes.push({ sql, params });
        return { changes: 1, lastID: 9 };
      },
    };
    const result = await manager.removeFromSupplyInTransaction(
      db, 7, scenario.amount, scenario.source, 2
    );
    assert.strictEqual(result.supplyAfter, 0,
      `${scenario.source} must retain legacy non-fixed zero-floor semantics`);
    assert.strictEqual(writes.length, 2, `${scenario.source} must update and audit supply`);
    assert.strictEqual(writes[0].params[0], '0.00');
    assert.strictEqual(writes[1].params[3], scenario.source);
  }
}

async function testFixedSupplyUnderflowStillFailsClosed() {
  const manager = require('../utils/moneySupplyManager');
  const writes = [];
  const db = {
    async get(sql) {
      if (/FROM servers/.test(sql)) return { id: 7, guild_id: 3 };
      return {
        guild_id: 3, fixed_supply_enabled: true,
        current_money_supply: '0.25', max_money_supply: '100.00',
      };
    },
    async run(sql, params) { writes.push({ sql, params }); return { changes: 1 }; },
  };
  await assert.rejects(
    () => manager.removeFromSupplyInTransaction(db, 7, '0.50', 'transfer_fee', 2),
    error => error.status === 409 && /underflow/i.test(error.message)
  );
  assert.deepStrictEqual(writes, [], 'fixed-supply underflow must perform no writes');
}

async function testRequestDrivenCasinoExpiryUsesPostgresClockAfterLocks() {
  const { expireCasinoSession } = require('../routes/casino')._test;
  const writes = [];
  const reads = [];
  const db = {
    async transaction(callback) { return callback(this); },
    async get(sql) {
      reads.push(sql);
      if (/FROM servers/.test(sql)) return { id: 7, guild_id: 3 };
      if (/FROM guild_economy_config/.test(sql)) return {
        server_id: 7, fixed_supply_enabled: false, current_money_supply: '0.00',
      };
      if (/SELECT \* FROM casino_sessions/.test(sql)) return {
        session_id: 'a'.repeat(64), user_id: 5, identity_id: 2,
        server_id: 7, guild_id: 3, game_type: 'holdem', status: 'active',
        expires_at: '2099-01-01T00:00:00.000Z', reserved_wager: '0.00', state: '{}',
      };
      if (/expires_at <= clock_timestamp\(\)/i.test(sql)) return { is_expired: false };
      throw new Error(`unexpected read: ${sql}`);
    },
    async run(sql, params) { writes.push({ sql, params }); return { changes: 1 }; },
  };
  const originalNow = Date.now;
  Date.now = () => Date.parse('2100-01-01T00:00:00.000Z');
  try {
    const expired = await expireCasinoSession(db, {
      sessionId: 'a'.repeat(64), userId: 5, identityId: 2,
      serverId: 7, guildId: 3, gameType: 'holdem',
    });
    assert.strictEqual(expired, false, 'application clock skew must not expire a live DB session');
  } finally {
    Date.now = originalNow;
  }
  assert.ok(reads.findIndex(sql => /SELECT \* FROM casino_sessions/.test(sql)) <
    reads.findIndex(sql => /expires_at <= clock_timestamp\(\)/i.test(sql)),
  'live database expiry must be evaluated after the session row lock');
  assert.strictEqual(writes.length, 0);
}

async function main() {
  await testRecalculationRevalidatesRevokedAuthorityBeforeWrites();
  await testFinancialLocksUseGlobalOrder();
  await testRecalculationEndpointAndUiShareCurrentMoneySupplyContract();
  await testProspectiveConfigIsReadOnlyAndFirstSaveUsesCas();
  await testBankFeeVisibleOptionsRoundTripCanonicalEnum();
  await testUnsupportedTerritoryRewardsRemainDisabled();
  await testExactMonetaryReportingBoundaries();
  await testTouchedApiSerializersPreserveLargeMoney();
  testTruthfulExactBountyFeedFormatting();
  testBountySettlementFieldsRemainDistinctAcrossPipeline();
  testResetsPreserveRefundClaims();
  await testNonFixedStaleSupplyDoesNotBlockFinancialSinks();
  await testFixedSupplyUnderflowStillFailsClosed();
  await testRequestDrivenCasinoExpiryUsesPostgresClockAfterLocks();
  console.log('Release blocker remediation regressions passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
