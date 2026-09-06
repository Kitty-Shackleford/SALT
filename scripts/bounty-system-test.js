'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

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

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function handlerFor(router, routePath, method) {
  const layer = router.stack.find(entry => entry.route?.path === routePath && entry.route.methods[method]);
  assert(layer, `${method.toUpperCase()} ${routePath} route must exist`);
  return layer.route.stack.at(-1).handle;
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

(async () => {
  console.log('\nBounty system tests');

  await test('migration 066 creates exact-server bounty contracts, claims, and settings', async () => {
    const migration = require('../db/migrations/066_bounties');
    const statements = [];
    await migration.up({ async query(sql) { statements.push(sql); return { rows: [] }; } });
    const sql = statements.join('\n');

    for (const table of ['bounty_settings', 'bounties', 'bounty_claims', 'server_online_cache_snapshots']) {
      assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, 'i'));
    }
    assert.match(sql, /require_target_online\s+BOOLEAN\s+NOT NULL\s+DEFAULT\s+TRUE/i);
    assert.match(sql, /online_freshness_minutes\s+INTEGER\s+NOT NULL\s+DEFAULT\s+30/i);
    assert.match(sql, /ALTER TABLE player_wallets[\s\S]*cash_on_hand TYPE NUMERIC\(20, 2\)/i,
      'wallet balances must use an exact fixed-scale domain before bounty escrow is enabled');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS economy_precision_reconciliation/i,
      'legacy precision changes must leave a durable per-column reconciliation audit');
    assert.match(sql, /fractional_row_count[\s\S]*before_sum[\s\S]*after_sum[\s\S]*rounding_delta/i,
      'precision audit must record affected rows and old/new aggregate values');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS economy_supply_precision_reconciliation/i,
      'fixed-supply servers require a separately auditable invariant reconciliation');
    assert.match(sql, /fixed_supply_enabled[\s\S]*RAISE EXCEPTION[\s\S]*cannot reconcile fixed supply/i,
      'migration must fail closed when a fixed-supply invariant cannot be reconciled');
    assert.doesNotMatch(sql, /assets\.after_total\s*<>\s*ROUND\(config\.current_money_supply/i,
      'a conserved fractional supply must reconcile to the sum of rounded assets');
    assert.match(sql, /assets\.after_total\s+AS recorded_supply_after_rounding/i,
      'fixed-supply reconciliation must audit the final recorded exact-cent supply');
    assert.match(sql, /ON CONFLICT \(table_name, column_name\) DO NOTHING/i,
      'reruns must retain the original legacy reconciliation evidence');
    assert.match(sql, /UPDATE guild_economy_config[\s\S]*current_money_supply[\s\S]*ROUND/i,
      'successful fixed-supply conversion must reset recorded supply from exact-cent assets');
    assert.match(sql, /post-conversion exact-cent assertion failed/i,
      'migration must verify authoritative balances and supply after conversion');
    for (const column of [
      'starting_cash', 'starting_bank', 'total_money_supply', 'kill_reward',
      'playtime_reward_per_hour', 'achievement_bonus_multiplier', 'territory_reward_per_hour',
      'death_penalty_amount', 'death_penalty_max_loss', 'transfer_fee_percentage',
      'transfer_offline_fee_percentage', 'transfer_min_amount', 'transfer_max_amount',
      'max_bank_balance', 'bank_deposit_fee_percentage', 'bank_withdraw_fee_percentage',
      'bank_daily_fee_amount', 'inactivity_tax_percentage', 'max_money_supply',
      'current_money_supply', 'casino_min_bet', 'casino_max_bet',
      'kill_loot_amount',
    ]) {
      assert.match(sql, new RegExp(`ALTER COLUMN ${column} TYPE NUMERIC\\(20, 2\\)`, 'i'),
        `guild_economy_config.${column} must use the shared fixed-scale contract`);
    }
    assert.match(sql, /ALTER TABLE player_bank_accounts[\s\S]*balance TYPE NUMERIC\(20, 2\)/i);
    assert.match(sql, /ALTER TABLE economy_transactions[\s\S]*amount TYPE NUMERIC\(20, 2\)[\s\S]*balance_after TYPE NUMERIC\(20, 2\)/i);
    assert.match(sql, /minimum_amount NUMERIC\(20, 2\)/i);
    assert.match(sql, /maximum_amount NUMERIC\(20, 2\)/i);
    assert.match(sql, /amount NUMERIC\(20, 2\) NOT NULL CHECK \(amount > 0\)/i);
    assert.match(sql, /source_observed_at\s+TIMESTAMPTZ\s+NOT NULL/i);
    assert.match(sql, /DELETE FROM server_online_cache[\s\S]+NOT EXISTS[\s\S]+player_server_activity/i);
    assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS uq_player_server_activity_server_identity/i);
    assert.match(sql, /FOREIGN KEY \(server_id, identity_id\)[\s\S]+REFERENCES player_server_activity \(server_id, identity_id\)/i);
    assert.match(sql, /conrelid\s*=\s*'server_online_cache'::regclass/i);
    assert.match(sql, /confrelid\s*=\s*'player_server_activity'::regclass/i);
    assert.match(sql, /confdeltype\s*=\s*'c'/i);
    assert.match(sql, /conkey[\s\S]+server_id[\s\S]+identity_id/i);
    assert.match(sql, /bounties[\s\S]*server_id\s+INTEGER\s+NOT NULL[\s\S]*REFERENCES\s+servers\s*\(id\)/i);
    assert.match(sql, /FOREIGN KEY\s*\(server_id,\s*target_identity_id\)[\s\S]*REFERENCES\s+server_player_memberships\s*\(server_id,\s*identity_id\)/i);
    assert.match(sql, /funding_type[\s\S]*CHECK\s*\(funding_type\s*=\s*'player_wallet'\)/i);
    assert.match(sql, /status[\s\S]*CHECK\s*\(status\s+IN\s*\('active',\s*'claimed',\s*'cancelled',\s*'expired'\)\)/i);
    assert.match(sql, /UNIQUE\s*\(bounty_id\)/i);
    assert.match(sql, /UNIQUE\s*\(bounty_id,\s*kill_event_id\)/i);
    assert.match(sql, /WHERE\s+status\s*=\s*'active'/i);
    assert.match(sql, /server_id\s*,\s*target_identity_id\s*,\s*expires_at/i);
    assert.match(sql, /FOREIGN KEY\s*\(server_id,\s*target_identity_id\)[\s\S]*server_player_memberships\s*\(server_id,\s*identity_id\)/i);
    assert.match(sql, /FOREIGN KEY\s*\(server_id,\s*poster_identity_id\)[\s\S]*server_player_memberships\s*\(server_id,\s*identity_id\)/i);
    assert.match(sql, /FOREIGN KEY\s*\(kill_event_id,\s*server_id\)[\s\S]*kill_events\s*\(id,\s*server_id\)/i);
    assert.match(sql, /UNIQUE\s*\(server_id,\s*poster_identity_id,\s*idempotency_key\)/i,
      'creation retries must be scoped to the exact poster, not only the server');
    assert.match(sql, /FOREIGN KEY\s*\(server_id,\s*claimed_by_identity_id\)[\s\S]*server_player_memberships\s*\(server_id,\s*identity_id\)/i);
    assert.match(sql, /FOREIGN KEY\s*\(claim_kill_event_id,\s*server_id\)[\s\S]*kill_events\s*\(id,\s*server_id\)/i);
    assert.match(sql, /REFERENCES\s+server_player_memberships\s*\(server_id,\s*identity_id\)\s+ON DELETE CASCADE/i);
    assert.match(sql, /created_by_user_id\s+INTEGER\s+REFERENCES\s+users\s*\(id\)\s+ON DELETE SET NULL/i,
      'the authenticated internal actor must be auditable');
    assert.doesNotMatch(sql, /same_faction_excluded|pair_cooldown_minutes/i,
      'deferred anti-farming settings must not advertise unenforced policy');
    assert.doesNotMatch(sql,
      /admin_posting_enabled|automatic_enabled|automatic_streak_threshold|automatic_increment|automatic_target_cap|funding_type\s+IN\s*\([^)]*system/i,
      'Phase A must not advertise deferred admin, automatic, or system-funded behavior');
  });

  await test('migration 066 rerun conserves active bounty escrow without breaking first install', async () => {
    const migration = source('db/migrations/066_bounties.js');
    const bountyTableAt = migration.search(/CREATE TABLE IF NOT EXISTS bounties/i);
    const reconciliationAt = migration.search(/INSERT INTO economy_supply_precision_reconciliation/i);
    assert(bountyTableAt >= 0 && bountyTableAt < reconciliationAt,
      'first install must create the optional bounty relation before supply reconciliation reads it');

    const activeBountyAggregates = migration.match(
      /SELECT SUM\((?:ROUND\()?amount(?:::\w+)?(?:, 2\))?\) FROM bounties[\s\S]{0,140}?server_id = config\.server_id[\s\S]{0,80}?status = 'active'/gi
    ) || [];
    assert(activeBountyAggregates.length >= 4,
      'audit, fail-closed preflight, supply rewrite, and postcondition must all include active bounty escrow');

    const fixture = { wallet: 100, bank: 40, casinoEscrow: 10, activeBountyEscrow: 25 };
    const conserved = fixture.wallet + fixture.bank + fixture.casinoEscrow
      + (activeBountyAggregates.length >= 4 ? fixture.activeBountyEscrow : 0);
    assert.strictEqual(conserved, 175,
      'rerunning after a bounty reservation must not erase the reserved 25 from authoritative supply');
    assert.match(migration, /assets\.after_total\s*-\s*assets\.before_total\s+AS rounding_delta/i,
      'the reconciliation rounding_delta must describe asset rounding, not an unrelated supply adjustment');
  });

  await test('migration 066 database-enforces active escrow deletion protection', async () => {
    const migration = source('db/migrations/066_bounties.js');
    assert.match(migration, /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+protect_active_bounty/i);
    assert.match(migration, /OLD\.status\s*=\s*'active'/i);
    assert.match(migration, /BEFORE\s+DELETE\s+ON\s+bounties/i);
    assert.match(migration, /BEFORE\s+TRUNCATE\s+ON\s+bounties/i,
      'full reset TRUNCATE CASCADE must not erase active escrow');
    assert.match(migration, /BEFORE\s+DELETE\s+ON\s+(?:servers|player_identities)/i,
      'active escrow must be protected when a parent is deleted');
    assert.match(migration, /BEFORE\s+UPDATE\s+OF\s+status\s+ON\s+servers[\s\S]*NEW\.status\s*<>\s*'active'/i,
      'active escrow must be protected when its server is disabled');
  });

  await test('fresh databases apply bounty schema after membership prerequisites', async () => {
    const schema = source('db/schema-v2.js');
    assert.doesNotMatch(schema, /BOUNTY_SCHEMA_SQL/,
      'base schema runs before migration 050 creates server_player_memberships');
    assert('066_bounties.js'.localeCompare('050_multi_tenant_rbac.js') > 0,
      'migration ordering must create exact-server memberships before bounties');
    assert.match(source('db/migrationRunnerPg.js'), /\.sort\(\)/,
      'fresh migration execution must preserve numeric prerequisite order');
  });

  await test('player bounty rejects coerced or fractional monetary input before database access', async () => {
    const { createPlayerBountyInTransaction } = require('../services/bountyService');
    for (const amount of ['100', true, [], 1.001, NaN, Infinity, 0]) {
      let touched = false;
      const db = new Proxy({}, { get() { touched = true; throw new Error('database touched'); } });
      await assert.rejects(
        () => createPlayerBountyInTransaction(db, { serverId: 1, identityId: 2 }, {
          targetIdentityId: 3, amount, idempotencyKey: 'test-key',
        }),
        /valid monetary amount/i
      );
      assert.strictEqual(touched, false, `database was touched for ${String(amount)}`);
    }
  });

  await test('bounty identifiers reject coercive non-canonical values before database access', async () => {
    const { createPlayerBountyInTransaction, cancelBountyInTransaction } = require('../services/bountyService');
    for (const targetIdentityId of [true, 1.5, '1e3', '01', ' 1']) {
      let touched = false;
      const db = new Proxy({}, { get() { touched = true; throw new Error('database touched'); } });
      await assert.rejects(
        () => createPlayerBountyInTransaction(db, { serverId: 1, guildId: 4, identityId: 2, userId: 3 }, {
          targetIdentityId, amount: 100, idempotencyKey: 'test-key',
        }),
        /Target identity is required/i
      );
      assert.strictEqual(touched, false);
    }
    let touched = false;
    const db = new Proxy({}, { get() { touched = true; throw new Error('database touched'); } });
    await assert.rejects(
      () => cancelBountyInTransaction(db, { serverId: 1, guildId: 4, identityId: 2, userId: 3 }, '1e3'),
      /Bounty is required/i
    );
    assert.strictEqual(touched, false);
  });

  await test('player bounty fails closed when the linked player account is revoked in-transaction', async () => {
    const { createPlayerBountyInTransaction } = require('../services/bountyService');
    let writes = 0;
    const db = {
      async get(sql) {
        if (/pg_advisory_xact_lock/i.test(sql)) return { locked: true };
        if (/FROM guilds[\s\S]*FOR UPDATE/i.test(sql)) return { id: 3 };
        if (/FROM servers[\s\S]*FOR UPDATE/i.test(sql)) return { id: 7, guild_id: 3 };
        if (/FROM linked_accounts[\s\S]*FOR UPDATE/i.test(sql)) return null;
        throw new Error(`Unexpected query after revoked ownership: ${sql}`);
      },
      async run() {
        writes += 1;
        throw new Error('revoked ownership must not write');
      },
    };

    await assert.rejects(
      () => createPlayerBountyInTransaction(
        db,
        { serverId: 7, guildId: 3, identityId: 20, userId: 5 },
        { targetIdentityId: 30, amount: 25, reason: 'Bandit', idempotencyKey: 'revoked-link' }
      ),
      /Player identity link was revoked/i
    );
    assert.strictEqual(writes, 0);
  });

  await test('player bounty accepts self-asserted ownership but still requires active membership', async () => {
    const { createPlayerBountyInTransaction } = require('../services/bountyService');
    const calls = [];
    const db = {
      async get(sql) {
        calls.push(sql);
        if (/pg_advisory_xact_lock/i.test(sql)) return { locked: true };
        if (/FROM guilds[\s\S]*FOR UPDATE/i.test(sql)) return { id: 3 };
        if (/FROM servers[\s\S]*FOR UPDATE/i.test(sql)) return { id: 7, guild_id: 3 };
        if (/FROM linked_accounts[\s\S]*FOR UPDATE/i.test(sql)) {
          return { id: 55, verification_method: 'self_asserted' };
        }
        if (/FROM server_player_memberships[\s\S]*FOR UPDATE/i.test(sql)) return null;
        throw new Error(`Unexpected query after linked ownership: ${sql}`);
      },
      async run() { throw new Error('inactive membership must not write'); },
    };

    await assert.rejects(
      () => createPlayerBountyInTransaction(
        db,
        { serverId: 7, guildId: 3, identityId: 20, userId: 5 },
        { targetIdentityId: 30, amount: 25, reason: 'Bandit', idempotencyKey: 'self-asserted-link' }
      ),
      /Player identity is not active on this server/i
    );
    assert(calls.some(sql => /server_player_memberships/i.test(sql)),
      'linked ownership must proceed to exact-server active membership validation');
    assert.match(source('services/bountyService.js'), /require\(['"]\.\.\/utils\/linkTrust['"]\)/,
      'bounty authorization must consume the canonical link-trust helper');
  });

  await test('player bounty mutation serializes with account deletion before resource locks', async () => {
    const { createPlayerBountyInTransaction } = require('../services/bountyService');
    const calls = [];
    const db = {
      async get(sql, params) {
        calls.push({ sql, params });
        if (/pg_advisory_xact_lock/i.test(sql)) return { locked: true };
        if (/FROM guilds[\s\S]*FOR UPDATE/i.test(sql)) return { id: 3 };
        if (/FROM servers[\s\S]*FOR UPDATE/i.test(sql)) return { id: 7, guild_id: 3 };
        if (/FROM linked_accounts[\s\S]*FOR UPDATE/i.test(sql)) return null;
        throw new Error(`Unexpected query: ${sql}`);
      },
    };

    await assert.rejects(
      () => createPlayerBountyInTransaction(
        db,
        { serverId: 7, guildId: 3, identityId: 20, userId: 5 },
        { targetIdentityId: 30, amount: 25, idempotencyKey: 'lock-order' }
      ),
      /link was revoked/i
    );
    assert.match(calls[0].sql, /pg_advisory_xact_lock/i,
      'the repository-wide user lock must be acquired before server and proof locks');
    assert.deepStrictEqual(calls[0].params, [2147483001, 5]);
    const deletion = source('routes/roleManagement.js');
    assert.match(deletion, /lockUserRoleMutations\(transactionDb, \[req\.user\.id, targetUserId\]\)/,
      'account deletion must contend on the same repository-wide lock helper');
  });

  await test('player cancellation becomes pending without refund until authoritative parsing covers its cutoff', async () => {
    const { cancelBountyInTransaction } = require('../services/bountyService');
    const calls = [];
    const db = {
      async get(sql, params) {
        calls.push({ method: 'get', sql, params });
        if (/FROM guilds/i.test(sql)) return { id: 3 };
        if (/FROM servers/i.test(sql)) return { id: 7, guild_id: 3 };
        if (/FROM guild_economy_config/i.test(sql)) return { server_id: 7, starting_cash: 0 };
        if (/FROM linked_accounts/i.test(sql)) return { id: 55, verification_method: 'emote_challenge' };
        if (/FROM server_player_memberships/i.test(sql)) return { identity_id: 20 };
        if (/clock_timestamp\(\) AS observed_at/i.test(sql)) return { observed_at: '2026-08-30T12:00:00.000Z' };
        if (/FROM bounties/i.test(sql)) return {
          id: 91, server_id: 7, poster_identity_id: 20, funding_type: 'player_wallet',
          amount: 25.5, status: 'active', unexpired: true,
        };
        return null;
      },
      async run(sql, params) {
        calls.push({ method: 'run', sql, params });
        return { changes: 1 };
      },
    };

    const result = await cancelBountyInTransaction(
      db, { serverId: 7, guildId: 3, identityId: 20, userId: 5 }, 91, 'Changed my mind'
    );
    assert.deepStrictEqual(result, { bountyId: 91, status: 'pending_cancellation', refundedAmount: 0 });
    assert.match(calls[0].sql, /pg_advisory_xact_lock/i,
      'cancellation must serialize with user deletion before exact-server locks');
    assert.deepStrictEqual(calls[0].params, [2147483001, 5]);
    const sql = calls.map(call => call.sql).join('\n');
    assert.match(sql, /FROM servers[\s\S]*status = 'active'[\s\S]*FOR UPDATE/i);
    assert.match(sql, /server_player_memberships[\s\S]*server_id = \?[\s\S]*identity_id = \?[\s\S]*status = 'active'[\s\S]*FOR UPDATE/i);
    const actorMembership = calls.find(call => /FROM server_player_memberships/i.test(call.sql));
    assert.match(actorMembership.sql, /user_id = \?/i,
      'operation-time cancellation authorization must bind membership to the authenticated user');
    assert.deepStrictEqual(actorMembership.params, [7, 20, 5, 55]);
    assert(calls.some(call => /FROM guilds[\s\S]*status = 'approved'[\s\S]*FOR UPDATE/i.test(call.sql)),
      'cancellation must lock and revalidate the approved guild');
    assert(calls.some(call => /FROM linked_accounts[\s\S]*verification_method IN[\s\S]*FOR UPDATE/i.test(call.sql)),
      'cancellation must lock and revalidate linked player account');
    assert.match(sql, /FROM bounties[\s\S]*server_id = \?[\s\S]*poster_identity_id = \?[\s\S]*funding_type = 'player_wallet'[\s\S]*FOR UPDATE/i);
    assert.match(sql, /UPDATE bounties[\s\S]*cancellation_requested_at[\s\S]*WHERE id = \? AND server_id = \? AND status = 'active'/i);
    const cancellationWrite = calls.find(call => /UPDATE bounties SET cancellation_requested_at/i.test(call.sql));
    assert.strictEqual(cancellationWrite.params[0], '2026-08-30T12:00:00.000Z',
      'cancellation cutoff must come from PostgreSQL clock_timestamp');
    assert(!calls.some(call => /UPDATE player_wallets/i.test(call.sql)),
      'requesting cancellation must leave escrow untouched until the parse watermark covers the cutoff');
    assert(!calls.some(call => /INSERT INTO economy_transactions/i.test(call.sql)),
      'pending cancellation must not write a refund ledger entry');
    assert(calls.every(call => !/bount|wallet|membership|servers/i.test(call.sql)
      || (call.params && call.params.includes(7))), 'cancellation query omitted exact internal server');
  });

  await test('a kill parsed after cancellation request still claims by authoritative kill timestamp', async () => {
    const { claimBountiesForKillInTransaction } = require('../services/bountyService');
    const calls = [];
    const db = {
      async get(sql, params) {
        calls.push({ method: 'get', sql, params });
        if (/clock_timestamp\(\) AS observed_at/i.test(sql)) return { observed_at: '2026-08-30T12:00:00.000Z' };
        if (/FROM servers/i.test(sql)) return { id: 7 };
        if (/FROM kill_events/i.test(sql)) return {
          id: 77, server_id: 7, killer_identity_id: 10, victim_identity_id: 20,
          timestamp: '2026-08-30T11:59:00.000Z',
        };
        if (/FROM server_player_memberships/i.test(sql)) return { identity_id: params[1] };
        if (/FROM bounties/i.test(sql)) return { id: 90 };
        if (/FROM guild_economy_config/i.test(sql)) return { server_id: 7, starting_cash: 0 };
        if (/FROM player_wallets/i.test(sql)) return { cash_on_hand: 100 };
        if (/UPDATE player_wallets/i.test(sql)) return { cash_on_hand: 125.5 };
        return null;
      },
      async query(sql, params) {
        calls.push({ method: 'query', sql, params });
        if (/SELECT b\.guild_id, b\.target_faction_id, b\.creator_faction_id/i.test(sql)) return [];
        if (/FROM bounties/i.test(sql)) return [{
          id: 90, server_id: 7, target_identity_id: 20, poster_identity_id: 30,
          funding_type: 'player_wallet', amount: 25.5,
          cancellation_requested_at: '2026-08-30T12:00:00.000Z',
        }];
        return [];
      },
      async run(sql, params) { calls.push({ method: 'run', sql, params }); return { changes: 1 }; },
    };

    const result = await claimBountiesForKillInTransaction(db, { killEventId: 77, serverId: 7 });
    assert.deepStrictEqual(result.claimedBountyIds, [90]);
    const bountyReads = calls.filter(call => /FROM bounties/i.test(call.sql));
    assert(bountyReads.every(call => /cancellation_requested_at IS NULL[\s\S]*cancellation_requested_at >= \?/i.test(call.sql)),
      'candidate discovery and locked settlement must admit kills at or before a pending cancellation cutoff');
    assert(calls.some(call => /UPDATE bounties SET status = \?, claimed_at = \?/i.test(call.sql)
      && call.params[0] === 'settled'
      && /cancellation_requested_at IS NULL[\s\S]*cancellation_requested_at >= \?/i.test(call.sql)),
      'conditional exactly-once settlement must retain pending-cutoff eligibility');
  });

  await test('expiry refunds player escrow in a bounded deterministic exact-server batch', async () => {
    const { expireBounties } = require('../services/bountyService');
    const calls = [];
    const db = {
      async get(sql, params) {
        calls.push({ method: 'get', sql, params });
        if (/clock_timestamp\(\) AS observed_at/i.test(sql)) return { observed_at: '2026-08-30T12:00:00.000Z' };
        if (/FROM servers/i.test(sql)) return { id: 7 };
        if (/FROM guild_economy_config/i.test(sql)) return { server_id: 7, starting_cash: 0 };
        if (/UPDATE player_wallets/i.test(sql)) {
          return { cash_on_hand: params[2] === 20 ? 125.5 : 60 };
        }
        if (/FROM player_wallets/i.test(sql)) return { cash_on_hand: params[0] === 20 ? 100 : 50 };
        return null;
      },
      async query(sql, params) {
        calls.push({ method: 'query', sql, params });
        if (/FROM bounties/i.test(sql)) return [
          { id: 91, server_id: 7, poster_identity_id: 25, funding_type: 'player_wallet', amount: 10 },
          { id: 90, server_id: 7, poster_identity_id: 20, funding_type: 'player_wallet', amount: 25.5 },
        ];
        return [];
      },
      async run(sql, params) {
        calls.push({ method: 'run', sql, params });
        return { changes: 1 };
      },
    };

    const result = await expireBounties(db, 7, new Date('2026-08-30T12:00:00.000Z'));
    assert.deepStrictEqual(result, {
      expiredCount: 2, refundedAmount: 35.5, walletCreditedAmount: 35.5,
      deferredClaimAmount: 0, bountyIds: [90, 91], walletCreditedBountyIds: [90, 91],
      deferredBountyIds: [], deferredClaimIds: [],
    });
    const batch = calls.find(call => call.method === 'query' && /FROM bounties/i.test(call.sql));
    assert.match(batch.sql, /JOIN servers s ON s\.id = b\.server_id/i);
    assert.match(batch.sql, /s\.log_parse_watermark_at >= LEAST/i,
      'expiration-first must leave escrow pending until a successful authoritative parse covers expiry');
    assert.match(batch.sql, /ORDER BY b\.id[\s\S]*FOR UPDATE OF b SKIP LOCKED[\s\S]*LIMIT \?/i);
    assert.deepStrictEqual(batch.params, [7, '2026-08-30T12:00:00.000Z', 100]);
    const walletLocks = calls.filter(call => call.method === 'get'
      && /FROM player_wallets[\s\S]*FOR UPDATE/i.test(call.sql));
    assert.deepStrictEqual(walletLocks.map(call => call.params[0]), [20, 25], 'wallets must lock by identity ID');
    assert(calls.filter(call => /UPDATE bounties/i.test(call.sql)).every(call =>
      /WHERE id = \? AND server_id = \? AND status = 'active'[\s\S]*expires_at <= \? OR cancellation_requested_at IS NOT NULL/i.test(call.sql)
      && call.params.includes(7)), 'expiry status changes must be conditional and exact-server scoped');
    assert.strictEqual(calls.filter(call => /INSERT INTO economy_transactions/i.test(call.sql)
      && call.params?.includes('bounty_refund')).length, 2);
  });

  await test('one full refund wallet creates a durable claim without blocking the expiry batch', async () => {
    const { expireBounties } = require('../services/bountyService');
    const calls = [];
    const db = {
      async get(sql, params) {
        calls.push({ method: 'get', sql, params });
        if (/clock_timestamp\(\) AS observed_at/i.test(sql)) return { observed_at: '2026-08-30T12:00:00.000Z' };
        if (/FROM servers/i.test(sql)) return { id: 7 };
        if (/FROM guild_economy_config/i.test(sql)) return { server_id: 7 };
        if (/FROM player_wallets/i.test(sql)) return {
          cash_on_hand: params[0] === 20 ? '90071992547409.91' : '50.00'
        };
        if (/UPDATE player_wallets/i.test(sql)) return { cash_on_hand: '60.00' };
        if (/INSERT INTO financial_refund_claims/i.test(sql)) return {
          id: 200, server_id: 7, identity_id: 20, amount: '25.50',
          source_type: 'bounty', source_key: '90', reason: 'expired', status: 'pending',
        };
        return null;
      },
      async query(sql, params) {
        calls.push({ method: 'query', sql, params });
        if (/FROM bounties/i.test(sql)) return [
          { id: 90, server_id: 7, poster_identity_id: 20, amount: '25.50' },
          { id: 91, server_id: 7, poster_identity_id: 25, amount: '10.00' },
        ];
        return [];
      },
      async run(sql, params) { calls.push({ method: 'run', sql, params }); return { changes: 1 }; },
    };
    const result = await expireBounties(db, 7, new Date('2026-08-30T12:00:00.000Z'));
    assert.strictEqual(result.refundedAmount, 10,
      'refundedAmount must report only money actually credited to a wallet');
    assert.strictEqual(result.walletCreditedAmount, 10);
    assert.strictEqual(result.deferredClaimAmount, 25.5);
    assert.deepStrictEqual(result.walletCreditedBountyIds, [91]);
    assert.deepStrictEqual(result.deferredBountyIds, [90]);
    assert.deepStrictEqual(result.deferredClaimIds, [200]);
    assert.deepStrictEqual(result.bountyIds, [90, 91]);
    assert(calls.some(call => /INSERT INTO financial_refund_claims/i.test(call.sql)
      && call.params.includes('90') && call.params.includes('25.50')),
    'the blocked refund must become a durable exact-cent claim');
    assert(calls.some(call => /UPDATE player_wallets/i.test(call.sql) && call.params.includes(25)),
      'an unrelated refund in the same batch must still settle');
  });

  await test('a pre-expiry kill parsed after expiration-first processing still claims by authoritative timestamp', async () => {
    const { claimBountiesForKillInTransaction, expireBounties } = require('../services/bountyService');
    const calls = [];
    const db = {
      async get(sql, params) {
        calls.push({ method: 'get', sql, params });
        if (/clock_timestamp\(\) AS observed_at/i.test(sql)) return { observed_at: '2026-08-30T12:00:00.000Z' };
        if (/FROM servers/i.test(sql)) return { id: 7 };
        if (/FROM guild_economy_config/i.test(sql)) return { server_id: 7, starting_cash: 0 };
        if (/FROM kill_events/i.test(sql)) return {
          id: 77, server_id: 7, killer_identity_id: 10, victim_identity_id: 20,
          timestamp: '2026-08-30T11:00:00.000Z',
        };
        if (/FROM bounties/i.test(sql)) return { id: 90 };
        if (/FROM server_player_memberships/i.test(sql)) return { identity_id: params[1] };
        if (/UPDATE player_wallets/i.test(sql)) return { cash_on_hand: 135.5 };
        if (/FROM player_wallets/i.test(sql)) return { cash_on_hand: params[0] === 10 ? 100 : 50 };
        return null;
      },
      async query(sql, params) {
        calls.push({ method: 'query', sql, params });
        if (/JOIN servers s ON s\.id = b\.server_id/i.test(sql)) return [];
        if (/SELECT b\.guild_id, b\.target_faction_id, b\.creator_faction_id/i.test(sql)) return [];
        if (/FROM bounties/i.test(sql)) return [
          { id: 91, server_id: 7, target_identity_id: 20, poster_identity_id: 10, funding_type: 'player_wallet', amount: 10 },
          { id: 90, server_id: 7, target_identity_id: 20, poster_identity_id: 30, funding_type: 'player_wallet', amount: 25.5 },
        ];
        return [];
      },
      async run(sql, params) {
        calls.push({ method: 'run', sql, params });
        return { changes: 1, lastID: 200 };
      },
    };

    const pendingExpiry = await expireBounties(db, 7, new Date('2026-08-30T12:05:00.000Z'));
    assert.deepStrictEqual(pendingExpiry, {
      expiredCount: 0, refundedAmount: 0, walletCreditedAmount: 0,
      deferredClaimAmount: 0, bountyIds: [], walletCreditedBountyIds: [],
      deferredBountyIds: [], deferredClaimIds: [],
    },
      'expiration-first processing must leave escrow active without a covering parse watermark');
    assert(!calls.some(call => /UPDATE player_wallets|INSERT INTO economy_transactions/i.test(call.sql)),
      'pending expiry must not refund or write a settlement ledger');
    calls.length = 0;

    const result = await claimBountiesForKillInTransaction(db, { killEventId: 77, serverId: 7 });
    assert.deepStrictEqual(result, {
      killEventId: 77, claimedAmount: 25.5, claimedBountyIds: [90],
      publicFeedAwardAmount: 25.5, publicFeedDeferredAwardAmount: 0,
      refundedAmount: 10, refundedBountyIds: [91], walletCreditedAmount: 35.5,
      deferredClaimAmount: 0, deferredClaimIds: [], deferredBountyIds: [],
      deferredAwardAmount: 0, deferredRefundAmount: 0,
      settledBountyIds: [90, 91], factionProgress: [],
    });
    const killLock = calls.find(call => call.method === 'get' && /FROM kill_events/i.test(call.sql));
    assert.match(killLock.sql, /WHERE id = \? AND server_id = \?[\s\S]*FOR UPDATE/i);
    assert.deepStrictEqual(killLock.params, [77, 7]);
    const membershipLocks = calls.filter(call => call.method === 'get' && /FROM server_player_memberships/i.test(call.sql));
    assert.deepStrictEqual(membershipLocks.map(call => call.params[1]), [10, 20]);
    const bountyLock = calls.find(call => call.method === 'query'
      && /FROM bounties/i.test(call.sql) && /FOR UPDATE OF b/i.test(call.sql));
    assert.match(bountyLock.sql, /server_id = \?[\s\S]*funding_type = 'player_wallet'[\s\S]*target_identity_id = \?[\s\S]*status = 'active'[\s\S]*created_at <= \?[\s\S]*expires_at > \?[\s\S]*ORDER BY b\.id[\s\S]*FOR UPDATE/i);
    assert.deepStrictEqual(bountyLock.params, [7, 20, 20,
      '2026-08-30T11:00:00.000Z', '2026-08-30T11:00:00.000Z', '2026-08-30T11:00:00.000Z']);
    const walletLocks = calls.filter(call => call.method === 'get'
      && /FROM player_wallets[\s\S]*FOR UPDATE/i.test(call.sql));
    assert.deepStrictEqual(walletLocks.map(call => call.params[0]), [10]);
    assert(calls.some(call => /UPDATE bounties SET status = \?, claimed_at = \?/i.test(call.sql)
      && call.params[0] === 'settled'
      && /WHERE id = \? AND server_id = \? AND status = 'active'/i.test(call.sql)
      && call.params.includes(77) && call.params.includes(7)));
    assert(calls.some(call => /UPDATE bounties SET status = 'cancelled'/i.test(call.sql)
      && call.params.includes('poster_killed_target') && call.params.includes(7)));
    assert(calls.some(call => /INSERT INTO bounty_claims/i.test(call.sql)
      && call.params.includes(77) && call.params.includes(7)));
    assert.strictEqual(calls.filter(call => /INSERT INTO economy_transactions/i.test(call.sql)
      && call.params?.includes('bounty_claim')).length, 1);
    assert.strictEqual(calls.filter(call => /INSERT INTO economy_transactions/i.test(call.sql)
      && call.params?.includes('bounty_refund')).length, 1);
  });

  await test('kills without eligible bounties lock memberships before discovery and do not poison ingestion', async () => {
    const { claimBountiesForKillInTransaction } = require('../services/bountyService');
    const calls = [];
    const db = {
      async get(sql, params) {
        calls.push({ method: 'get', sql, params });
        if (/clock_timestamp\(\) AS observed_at/i.test(sql)) return { observed_at: '2026-08-30T12:00:00.000Z' };
        if (/FROM servers/i.test(sql)) return { id: 7 };
        if (/FROM guild_economy_config/i.test(sql)) return { server_id: 7, starting_cash: 0 };
        if (/FROM kill_events/i.test(sql)) return {
          id: 77, server_id: 7, killer_identity_id: 10, victim_identity_id: 20,
          timestamp: '2026-08-30T11:00:00.000Z',
        };
        if (/FROM server_player_memberships/i.test(sql)) return { identity_id: params[1] };
        if (/FROM bounties/i.test(sql)) return null;
        throw new Error('wallet must not be required without a bounty');
      },
      async query(sql, params) {
        calls.push({ method: 'query', sql, params });
        if (/FROM bounties/i.test(sql)) return [];
        throw new Error('unexpected query');
      },
    };
    const result = await claimBountiesForKillInTransaction(db, { killEventId: 77, serverId: 7 });
    assert.deepStrictEqual(result, {
      killEventId: 77, claimedAmount: 0, claimedBountyIds: [], refundedAmount: 0,
      publicFeedAwardAmount: 0, publicFeedDeferredAwardAmount: 0,
      refundedBountyIds: [], walletCreditedAmount: 0, deferredClaimAmount: 0,
      deferredClaimIds: [], deferredBountyIds: [], settledBountyIds: [],
      deferredAwardAmount: 0, deferredRefundAmount: 0, factionProgress: [],
    });
    const memberships = calls.filter(call => /server_player_memberships/i.test(call.sql));
    assert.deepStrictEqual(memberships.map(call => call.params[1]), [10, 20]);
    assert(memberships.every(call => /FOR UPDATE/i.test(call.sql)));
    assert(!calls.some(call => /player_wallets/i.test(call.sql)));
  });

  await test('player bounty reserves funds under exact-server locks and writes its audit ledger', async () => {
    const { createPlayerBountyInTransaction } = require('../services/bountyService');
    const calls = [];
    const db = {
      async get(sql, params) {
        calls.push({ method: 'get', sql, params });
        if (/FROM guilds/i.test(sql)) return { id: 3 };
        if (/FROM servers/i.test(sql)) return { id: 7, guild_id: 3 };
        if (/FROM guild_economy_config/i.test(sql)) return { server_id: 7, starting_cash: 0 };
        if (/FROM linked_accounts/i.test(sql)) return { id: 55, verification_method: 'emote_challenge' };
        if (/FROM bounty_settings/i.test(sql)) return {
          enabled: true, economy_enabled: true, player_posting_enabled: true, minimum_amount: 10,
          maximum_amount: 500, default_expiry_hours: 168, maximum_expiry_hours: 720,
          require_target_online: false,
        };
        if (/FROM server_player_memberships/i.test(sql)) return { identity_id: params[1] };
        if (/FROM player_wallets/i.test(sql)) return { cash_on_hand: 250 };
        if (/clock_timestamp\(\) AS observed_at/i.test(sql)) return { observed_at: '2026-08-30T10:00:00.000Z' };
        if (/UPDATE player_wallets/i.test(sql)) return { cash_on_hand: 224.5 };
        if (/FROM bounties/i.test(sql)) return null;
        return null;
      },
      async run(sql, params) {
        calls.push({ method: 'run', sql, params });
        if (/INSERT INTO bounties/i.test(sql)) return { lastID: 91 };
        return { lastID: 92 };
      },
    };
    const result = await createPlayerBountyInTransaction(
      db,
      { serverId: 7, guildId: 3, identityId: 20, userId: 5 },
      { targetIdentityId: 30, amount: 25.5, reason: 'Bandit', idempotencyKey: 'request-1' }
    );
    assert.strictEqual(result.id, 91);
    assert.strictEqual(result.amount, 25.5);
    const sql = calls.map(call => call.sql).join('\n');
    assert.match(sql, /FROM servers[\s\S]*FOR UPDATE/i);
    assert.match(sql, /server_player_memberships[\s\S]*status = 'active'[\s\S]*FOR UPDATE/i);
    const membershipLocks = calls.filter(call => /FROM server_player_memberships/i.test(call.sql));
    const posterLock = membershipLocks.find(call => call.params.includes(20));
    assert.match(posterLock.sql, /user_id = \?/i,
      'operation-time creation authorization must bind the poster to the authenticated user');
    assert.deepStrictEqual(posterLock.params, [7, 20, 5, 55]);
    assert(calls.some(call => /FROM guilds[\s\S]*status = 'approved'[\s\S]*FOR UPDATE/i.test(call.sql)),
      'creation must lock and revalidate the approved guild');
    assert(calls.some(call => /FROM linked_accounts[\s\S]*verification_method IN[\s\S]*FOR UPDATE/i.test(call.sql)),
      'creation must lock and revalidate linked player account');
    assert.match(sql, /player_wallets[\s\S]*server_id = \?[\s\S]*FOR UPDATE/i);
    assert.match(sql, /UPDATE player_wallets[\s\S]*server_id = \?/i);
    assert.match(sql, /INSERT INTO economy_transactions[\s\S]*bounty_escrow/i);
    const escrowLedger = calls.find(call => /INSERT INTO economy_transactions/i.test(call.sql));
    assert.deepStrictEqual(escrowLedger.params.slice(2, 4), ['-25.50', '224.50'],
      'bounty escrow ledger and balance_after must use canonical exact-cent values');
    const walletDebit = calls.find(call => /UPDATE player_wallets/i.test(call.sql));
    assert.strictEqual(walletDebit.params[0], '25.50',
      'bounty wallet mutation must bind an exact-cent decimal');
    assert.match(sql, /INSERT INTO bounties/i);
    const bountyInsert = calls.find(call => /INSERT INTO bounties/i.test(call.sql));
    assert.match(bountyInsert.sql, /created_by_user_id/i);
    assert(bountyInsert.params.includes(5), 'the authenticated internal user must be persisted');
    assert(calls.every(call => !call.params || call.params.includes(7) || !/bount|wallet|membership|servers/i.test(call.sql)),
      'a bounty persistence query omitted the exact internal server');
  });

  await test('player bounty requires a fresh exact-server online target by default', async () => {
    const { createPlayerBountyInTransaction } = require('../services/bountyService');
    const calls = [];
    const db = {
      async get(sql, params) {
        calls.push({ method: 'get', sql, params });
        if (/FROM guilds/i.test(sql)) return { id: 3 };
        if (/FROM servers/i.test(sql)) return { id: 7, guild_id: 3 };
        if (/FROM guild_economy_config/i.test(sql)) return { server_id: 7, starting_cash: 0 };
        if (/FROM linked_accounts/i.test(sql)) return { id: 55, verification_method: 'emote_challenge' };
        if (/FROM server_player_memberships/i.test(sql)) return { identity_id: params[1] };
        if (/FROM bounty_settings/i.test(sql)) return {
          enabled: true, economy_enabled: true, player_posting_enabled: true,
          minimum_amount: 10, maximum_amount: 500, default_expiry_hours: 168,
          maximum_expiry_hours: 720, require_target_online: true, online_freshness_minutes: 30,
        };
        if (/FROM bounties/i.test(sql)) return null;
        if (/FROM server_online_cache_snapshots/i.test(sql)) return { fresh: true, plausible: true };
        if (/FROM server_online_cache/i.test(sql)) return null;
        if (/FROM player_wallets/i.test(sql)) throw new Error('wallet must not be touched');
        return null;
      },
      async run(sql, params) { calls.push({ method: 'run', sql, params }); return { changes: 1 }; },
    };
    await assert.rejects(
      () => createPlayerBountyInTransaction(
        db,
        { serverId: 7, guildId: 3, identityId: 20, userId: 5 },
        { targetIdentityId: 30, amount: 25, idempotencyKey: 'online-required' }
      ),
      /freshly online on this server/i
    );
    const markerLock = calls.findIndex(call => /server_online_cache_snapshots/i.test(call.sql));
    const cacheLock = calls.findIndex(call => /FROM server_online_cache/i.test(call.sql)
      && !/snapshots/i.test(call.sql));
    assert(markerLock >= 0 && cacheLock > markerLock,
      'online admission must lock the snapshot marker before the exact identity row');
    assert(!calls.some(call => /player_wallets|economy_transactions|INSERT INTO bounties/i.test(call.sql)),
      'missing online evidence must perform no financial writes');
  });

  await test('admin online-target toggle revalidates exact-server authority under locks', async () => {
    const { updateBountySettingsInTransaction } = require('../services/bountyService');
    const calls = [];
    const db = {
      async get(sql, params) {
        calls.push({ method: 'get', sql, params });
        if (/FROM guilds/i.test(sql)) return { id: 3 };
        if (/FROM servers/i.test(sql)) return { id: 7, guild_id: 3 };
        if (/FROM guild_roles/i.test(sql)) return { role: 'admin' };
        if (/FROM server_role_assignments/i.test(sql)) return null;
        if (/UPDATE bounty_settings/i.test(sql)) {
          return { server_id: 7, require_target_online: false, online_freshness_minutes: 30, version: 2 };
        }
        return null;
      },
      async run(sql, params) { calls.push({ method: 'run', sql, params }); return { changes: 1 }; },
    };
    const result = await updateBountySettingsInTransaction(
      db, { serverId: 7, guildId: 3, userId: 5 }, { requireTargetOnline: false, expectedVersion: 1 }
    );
    assert.strictEqual(result.requireTargetOnline, false);
    const serverLock = calls.findIndex(call => /FROM servers[\s\S]*FOR UPDATE/i.test(call.sql));
    const guildRoleLock = calls.findIndex(call => /FROM guild_roles[\s\S]*FOR UPDATE/i.test(call.sql));
    const update = calls.findIndex(call => /UPDATE bounty_settings/i.test(call.sql));
    assert(serverLock >= 0 && guildRoleLock > serverLock && update > guildRoleLock,
      'policy mutation must lock server then revocable operator authority before update');
    assert(calls.some(call => /FROM guilds[\s\S]*status = 'approved'[\s\S]*FOR UPDATE/i.test(call.sql)),
      'policy mutation must lock and revalidate guild approval');
    await assert.rejects(
      () => updateBountySettingsInTransaction(
        db, { serverId: 7, guildId: 3, userId: 5 }, { requireTargetOnline: 'false', expectedVersion: 1 }
      ),
      /boolean/i
    );
    assert.match(calls.find(call => /UPDATE bounty_settings/i.test(call.sql)).sql,
      /WHERE server_id = \? AND version = \?/i,
      'policy updates must compare-and-swap the version loaded by the admin');
    const staleDb = {
      ...db,
      async get(sql, params) {
        if (/UPDATE bounty_settings/i.test(sql)) return null;
        return db.get(sql, params);
      },
    };
    await assert.rejects(
      () => updateBountySettingsInTransaction(
        staleDb, { serverId: 7, guildId: 3, userId: 5 }, { requireTargetOnline: false, expectedVersion: 1 }
      ),
      /changed.*reload/i
    );
  });

  await test('admin bounty settings fail closed when guild approval is revoked in-transaction', async () => {
    const { updateBountySettingsInTransaction } = require('../services/bountyService');
    let writes = 0;
    const db = {
      async get(sql) {
        if (/pg_advisory_xact_lock/i.test(sql)) return {};
        if (/FROM guilds[\s\S]*FOR UPDATE/i.test(sql)) return null;
        throw new Error(`Unexpected query after revoked guild approval: ${sql}`);
      },
      async run() {
        writes += 1;
        throw new Error('revoked guild approval must not write');
      },
    };

    await assert.rejects(
      () => updateBountySettingsInTransaction(
        db,
        { serverId: 7, guildId: 3, userId: 5 },
        { requireTargetOnline: false, expectedVersion: 1 }
      ),
      /Guild approval is unavailable/i
    );
    assert.strictEqual(writes, 0);
  });

  await test('large deferred shop refunds settle exactly with BIGINT claim provenance', async () => {
    const { claimFinancialRefundsInTransaction } = require('../services/bountyService');
    const calls = [];
    const claimId = '9007199254740993';
    const amount = '90071992547409.93';
    const db = {
      async get(sql, params) {
        calls.push({ method: 'get', sql, params });
        if (/pg_advisory_xact_lock/i.test(sql)) return {};
        if (/FROM guilds/i.test(sql)) return { id: 3 };
        if (/FROM servers/i.test(sql)) return { id: 7, guild_id: 3 };
        if (/FROM linked_accounts/i.test(sql)) return { id: 55, verification_method: 'emote_challenge' };
        if (/FROM server_player_memberships/i.test(sql)) return { identity_id: 20 };
        if (/FROM guild_economy_config/i.test(sql)) {
          return { server_id: 7, starting_cash: '0.00', fixed_supply_enabled: false };
        }
        if (/FROM player_wallets/i.test(sql)) return { id: 99, cash_on_hand: '0.00' };
        if (/clock_timestamp\(\) AS observed_at/i.test(sql)) {
          return { observed_at: '2026-09-06T16:00:00.000Z' };
        }
        throw new Error(`Unexpected large refund get: ${sql}`);
      },
      async query(sql, params) {
        calls.push({ method: 'query', sql, params });
        if (/FROM financial_refund_claims/i.test(sql)) {
          return [{
            id: claimId,
            amount,
            source_type: 'shop_order_refund',
            source_key: '70',
          }];
        }
        throw new Error(`Unexpected large refund query: ${sql}`);
      },
      async run(sql, params) {
        calls.push({ method: 'run', sql, params });
        return { changes: 1 };
      },
    };

    const result = await claimFinancialRefundsInTransaction(db, {
      serverId: 7, guildId: 3, identityId: 20, userId: 5,
    });
    assert.deepStrictEqual(result, { claimedAmount: amount, claimIds: [claimId] },
      'large exact claims and BIGINT IDs must survive the settlement response unchanged');
    const walletWrite = calls.find(call => /UPDATE player_wallets/i.test(call.sql));
    assert.strictEqual(walletWrite.params[0], amount);
    const ledgerWrite = calls.find(call => /INSERT INTO economy_transactions/i.test(call.sql));
    assert.match(ledgerWrite.sql, /refund_claim_id/i,
      'the wallet-credit ledger must carry the exact refund claim identity');
    assert(ledgerWrite.params.includes(claimId));
    assert(ledgerWrite.params.includes(amount));
  });

  await test('money-supply recalculation preserves active bounty escrow', async () => {
    const { recalculateSupply } = require('../utils/moneySupplyManager');
    let recalculatedSupply = null;
    const calls = [];
    const db = {
      async transaction(callback) { return callback(this); },
      async get(sql, params) {
        calls.push({ sql, params });
        if (/FROM servers/i.test(sql)) return { id: 7, guild_id: 3 };
        if (/guild_economy_config/i.test(sql)) return { server_id: 7 };
        if (/SUM\(cash_on_hand\)/i.test(sql)) {
          const includesBountyEscrow = /FROM bounties[\s\S]*status IN \('active', 'suspended'\)/i.test(sql);
          return { total: includesBountyEscrow ? 190 : 165 };
        }
        return null;
      },
      async run(sql, params) {
        calls.push({ sql, params });
        if (/UPDATE guild_economy_config/i.test(sql)) recalculatedSupply = params[0];
        return { changes: 1 };
      },
    };

    const total = await recalculateSupply(db, 7);
    assert.strictEqual(total, 190,
      'wallet, bank, casino escrow, and active bounty escrow must all remain in supply');
    assert.strictEqual(recalculatedSupply, '190.00');
    const aggregate = calls.find(call => /SUM\(cash_on_hand\)/i.test(call.sql));
    assert.match(aggregate.sql, /FROM bounties[\s\S]*server_id = \?[\s\S]*status IN \('active', 'suspended'\)/i);
    assert.match(aggregate.sql, /FROM financial_refund_claims[\s\S]*server_id = \?[\s\S]*status = 'pending'/i,
      'durable deferred refunds remain part of authoritative supply');
    assert.deepStrictEqual(aggregate.params, [7, 7, 7, 7, 7],
      'every liquid or escrowed balance must use the exact internal server');
  });

  await test('supply audit writer rejects fractional cents before database arithmetic', async () => {
    const { addToSupplyInTransaction } = require('../utils/moneySupplyManager');
    let touched = false;
    const db = new Proxy({}, { get() { touched = true; throw new Error('database touched'); } });
    await assert.rejects(
      () => addToSupplyInTransaction(db, 7, 0.001, 'invalid_fraction'),
      /at most two decimals/i
    );
    assert.strictEqual(touched, false);
  });

  await test('idempotent creation is poster-scoped and returns one stable response contract', async () => {
    const { createPlayerBountyInTransaction } = require('../services/bountyService');
    const calls = [];
    const db = {
      async get(sql, params) {
        calls.push({ method: 'get', sql, params });
        if (/pg_advisory_xact_lock/i.test(sql)) return { locked: true };
        if (/FROM guilds/i.test(sql)) return { id: 3 };
        if (/FROM servers/i.test(sql)) return { id: 7, guild_id: 3 };
        if (/FROM guild_economy_config/i.test(sql)) return { server_id: 7, starting_cash: 0 };
        if (/FROM linked_accounts/i.test(sql)) return { id: 55, verification_method: 'emote_challenge' };
        if (/FROM server_player_memberships/i.test(sql)) return { identity_id: params[1] };
        if (/FROM bounty_settings/i.test(sql)) return {
          enabled: true, economy_enabled: true, player_posting_enabled: true, minimum_amount: 10,
          maximum_amount: 500, default_expiry_hours: 168, maximum_expiry_hours: 720,
        };
        if (/FROM bounties/i.test(sql)) return {
          id: 91, server_id: 7, target_identity_id: 30, poster_identity_id: 20,
          funding_type: 'player_wallet', amount: 25.5, reason: 'Bandit', status: 'active',
          idempotency_fingerprint: '{"targetIdentityId":30,"amount":25.5,"reason":"Bandit","expiryHours":168}',
          created_at: '2026-08-30T10:00:00.000Z', expires_at: '2026-09-06T10:00:00.000Z',
        };
        throw new Error('idempotent retry must not touch the wallet');
      },
      async run(sql, params) {
        calls.push({ method: 'run', sql, params });
        return { changes: 1 };
      },
    };

    const result = await createPlayerBountyInTransaction(
      db,
      { serverId: 7, guildId: 3, identityId: 20, userId: 5 },
      { targetIdentityId: 30, amount: 25.5, reason: 'Bandit', idempotencyKey: 'request-1' }
    );
    assert.deepStrictEqual(result, {
      id: 91, serverId: 7,
      targetType: 'player', targetIdentityId: 30, targetFactionId: null,
      targetFactionName: null, targetFactionTag: null,
      creatorType: 'player', creatorFactionId: null,
      creatorFactionName: null, creatorFactionTag: null,
      posterIdentityId: 20, fundingType: 'player_wallet', amount: 25.5,
      reason: 'Bandit', status: 'active', objectiveType: null,
      requiredKills: null, eligibleMemberCount: null, progressKills: 0,
      createdAt: '2026-08-30T10:00:00.000Z', expiresAt: '2026-09-06T10:00:00.000Z',
    });
    const retryLookup = calls.find(call => /FROM bounties/i.test(call.sql));
    assert.match(retryLookup.sql, /server_id = \?[\s\S]*poster_identity_id = \?[\s\S]*idempotency_key = \?/i);
    assert.deepStrictEqual(retryLookup.params, [7, 20, 'request-1']);
    assert(!calls.some(call => /player_wallets|economy_transactions/i.test(call.sql)));
  });

  await test('idempotent creation rejects a key replay with different request semantics', async () => {
    const { createPlayerBountyInTransaction } = require('../services/bountyService');
    const db = {
      async get(sql, params) {
        if (/pg_advisory_xact_lock/i.test(sql)) return { locked: true };
        if (/FROM guilds/i.test(sql)) return { id: 3 };
        if (/FROM servers/i.test(sql)) return { id: 7, guild_id: 3 };
        if (/FROM guild_economy_config/i.test(sql)) return { server_id: 7, starting_cash: 0 };
        if (/FROM linked_accounts/i.test(sql)) return { id: 55, verification_method: 'emote_challenge' };
        if (/FROM server_player_memberships/i.test(sql)) return { identity_id: params[1] };
        if (/FROM bounty_settings/i.test(sql)) return {
          enabled: true, economy_enabled: true, player_posting_enabled: true, minimum_amount: 10,
          maximum_amount: 500, default_expiry_hours: 168, maximum_expiry_hours: 720,
        };
        if (/FROM bounties/i.test(sql)) return {
          id: 91, server_id: 7, target_identity_id: 99, poster_identity_id: 20,
          funding_type: 'player_wallet', amount: 25.5, reason: 'Different', status: 'active',
          idempotency_fingerprint: 'different', created_at: new Date(), expires_at: new Date(),
        };
        throw new Error('wallet must not be touched');
      },
      async run() { return { changes: 1 }; },
    };
    await assert.rejects(
      () => createPlayerBountyInTransaction(
        db,
        { serverId: 7, guildId: 3, identityId: 20, userId: 5 },
        { targetIdentityId: 30, amount: 25.5, reason: 'Bandit', idempotencyKey: 'request-1' }
      ),
      /Idempotency key conflicts/i
    );
  });

  await test('bounty HTTP routes use canonical player server context and transactional mutations', async () => {
    const routes = source('routes/bounties.js');
    const registration = source('src/app/registerRoutes.js');
    assert.match(registration, /app\.use\(['"]\/api\/bounties['"],[^;]*bountyRoutes\)/s);
    assert.match(routes, /router\.get\(['"]\/:serverId['"],\s*ensurePlayerServerAccess/);
    assert.match(routes, /router\.post\(['"]\/:serverId['"],\s*ensurePlayerServerAccess,\s*strictLimiter/);
    assert.match(routes, /req\.playerServerAccess/);
    assert.match(routes, /userId:\s*req\.user\.id/,
      'transaction context must include the authenticated internal user ID');
    assert.match(routes, /db\.transaction/);
    assert.match(routes, /parseIdempotencyKey\(req\)/,
      'bounty creation must enforce the shared actionable idempotency-key contract');
    assert.match(routes, /router\.post\(['"]\/:serverId\/:bountyId\/cancel['"],\s*ensurePlayerServerAccess,\s*strictLimiter/);
    assert.match(routes, /cancelBountyInTransaction/);
    assert.match(routes, /cancellation_requested_at/,
      'list response must expose the pending-cancellation cutoff');
    assert.match(routes, /pending_cancellation/,
      'refresh must serialize an active row with a cancellation request as pending');
    assert.match(routes, /refunds\/claim[\s\S]*claimFinancialRefundsInTransaction/,
      'durable overflow refunds must expose a transactional claim path');
    assert.match(routes, /router\.put\(['"]\/admin\/:serverId\/settings['"],\s*requireServerManage,\s*strictLimiter/,
      'only exact-server managers may weaken the default online-target policy');
    assert.match(routes, /updateBountySettingsInTransaction/);
    assert.doesNotMatch(routes, /req\.body\.(?:posterIdentityId|serverId|guildId)/,
      'client-controlled identity or tenant fields must not select the funding context');
  });

  await test('bounty creation preserves shared idempotency parser validation status', async () => {
    delete require.cache[require.resolve('../routes/bounties')];
    const handler = handlerFor(require('../routes/bounties'), '/:serverId', 'post');
    let transactions = 0;
    const req = {
      app: { locals: { db: { async transaction() { transactions++; } } } },
      user: { id: 5 },
      playerServerAccess: { serverId: 7, guildId: 3, identityId: 20 },
      body: { targetType: 'faction' },
      get(name) {
        return name.toLowerCase() === 'idempotency-key' ? 'x'.repeat(129) : undefined;
      },
    };
    const res = responseRecorder();
    await handler(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(res.body, { error: 'Idempotency-Key must be 128 characters or fewer' });
    assert.strictEqual(transactions, 0, 'invalid keys must fail before transactional writes');
    delete require.cache[require.resolve('../routes/bounties')];
  });

  await test('economy settings exposes the exact-server online-target admin toggle', async () => {
    const html = source('public/dashboard/economy-settings.html');
    const client = source('public/js/admin/economy-settings.js');
    assert.match(html, /id="bountyRequireTargetOnline"/);
    assert.match(client, /\/api\/bounties\/admin\/\$\{(?:guildId|currentServerId)\}\/settings/);
    assert.match(client, /requireTargetOnline:\s*getCheckbox\('bountyRequireTargetOnline'\)/);
    assert.match(client, /method:\s*'POST'/);
    assert.match(client, /expectedVersion:\s*bountySettingsVersion/);
    const saveBlock = client.slice(client.indexOf('async function saveConfiguration'), client.indexOf('// ── Reset form'));
    assert.match(saveBlock, /bountySettings[\s\S]*expectedVersion:\s*bountySettingsVersion/,
      'economy and bounty settings must be submitted as one atomic server request');
    assert.doesNotMatch(saveBlock, /fetchWithCsrf\(`\/api\/bounties\/admin/,
      'the combined form must not commit bounty settings in a second request');
    assert.match(saveBlock,
      /if \(generation !== configurationGeneration \|\| serverId !== currentServerId\) return;[\s\S]*bountySettingsVersion\s*=/,
      'a stale save response must be rejected before installing its bounty settings version');
    assert.match(client, /configurationGeneration/,
      'server changes must invalidate stale asynchronous configuration loads');
    assert.match(client, /loadedServerId[\s\S]+currentServerId/,
      'saving must require a successfully loaded exact-server configuration');
  });

  await test('combined economy save maps every rendered editable economy control', async () => {
    const client = source('public/js/admin/economy-settings.js');
    const saveBlock = client.slice(client.indexOf('async function saveConfiguration'), client.indexOf('// ── Reset form'));
    for (const field of [
      'enabled', 'currency_name', 'currency_symbol', 'starting_cash', 'starting_bank',
      'monetary_system', 'total_money_supply', 'kill_rewards_enabled', 'kill_reward',
      'playtime_rewards_enabled', 'playtime_reward_per_hour', 'achievement_rewards_enabled',
      'achievement_bonus_multiplier',
      'death_penalty_enabled', 'death_penalty_type', 'death_penalty_amount',
      'death_penalty_max_loss', 'death_drops_money_on_ground', 'transfer_enabled',
      'transfer_fee_percentage', 'transfer_require_both_online',
      'transfer_offline_fee_percentage', 'transfer_min_amount', 'transfer_max_amount',
      'bank_enabled', 'max_bank_balance', 'bank_deposit_fee_percentage',
      'bank_withdraw_fee_percentage', 'bank_daily_fee_enabled', 'bank_daily_fee_type',
      'bank_daily_fee_amount', 'inactivity_tax_enabled', 'inactivity_threshold_days',
      'inactivity_tax_percentage', 'fixed_supply_enabled', 'max_money_supply',
    ]) {
      assert.match(saveBlock, new RegExp(`${field}\\s*:`), `combined payload omitted ${field}`);
    }
  });

  await test('combined economy transaction rolls back when bounty settings fail', async () => {
    const service = require('../services/bountyService');
    const original = service.updateBountySettingsInTransaction;
    const committed = [];
    service.updateBountySettingsInTransaction = async transactionDb => {
      await transactionDb.run('UPDATE bounty_settings SET require_target_online = false');
      throw new Error('Bounty settings changed; reload before saving');
    };
    const db = {
      async transaction(callback) {
        const staged = [];
        const transactionDb = {
          async run(sql) { staged.push(sql); return { changes: 1 }; },
          async get() { return { id: 1 }; },
        };
        const result = await callback(transactionDb);
        committed.push(...staged);
        return result;
      },
    };
    try {
      delete require.cache[require.resolve('../routes/economy')];
      const router = require('../routes/economy');
      const handler = handlerFor(router, '/admin/:serverId/config', 'post');
      const req = {
        app: { locals: { db } }, user: { id: 5 },
        authorization: { server: { id: 7 }, guild: { id: 3 } },
        body: {
          economy: { enabled: true, starting_cash: 100 },
          bountySettings: { requireTargetOnline: false, expectedVersion: 1 },
        },
      };
      const res = responseRecorder();
      await handler(req, res);
      assert.strictEqual(res.statusCode, 409);
      assert.deepStrictEqual(committed, [], 'no economy or bounty write may commit after either half fails');
    } finally {
      service.updateBountySettingsInTransaction = original;
      delete require.cache[require.resolve('../routes/economy')];
    }
  });

  await test('fixed-supply cap decisions include pending claims and commit exact authority', async () => {
    const bountyService = require('../services/bountyService');
    const moneySupplyManager = require('../utils/moneySupplyManager');
    const originalLock = bountyService.lockBountyAdminAuthority;
    const originalAggregate = moneySupplyManager.getAuthoritativeSupplyCents;
    bountyService.lockBountyAdminAuthority = async () => {};
    moneySupplyManager.getAuthoritativeSupplyCents = async () => 11001;
    const committed = [];
    const db = {
      async transaction(callback) {
        const staged = [];
        const transactionDb = {
          async get() {
            return { version: 1, fixed_supply_enabled: false,
              max_money_supply: null, current_money_supply: '100.00' };
          },
          async run(sql, params) { staged.push({ sql, params }); return { changes: 1 }; },
        };
        const result = await callback(transactionDb);
        committed.push(...staged);
        return result;
      },
    };
    try {
      delete require.cache[require.resolve('../routes/economy')];
      const handler = handlerFor(require('../routes/economy'), '/admin/:serverId/config', 'post');
      const request = max => ({
        app: { locals: { db } }, user: { id: 5 },
        authorization: { server: { id: 7 }, guild: { id: 3 } },
        body: { economy: { fixed_supply_enabled: true, max_money_supply: max }, expectedVersion: 1 },
      });
      let res = responseRecorder();
      await handler(request(110), res);
      assert.strictEqual(res.statusCode, 409);
      assert.deepStrictEqual(committed, [],
        'a cap below wallets plus pending claims must commit zero writes');

      res = responseRecorder();
      await handler(request(120), res);
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(committed.length, 1);
      assert(committed[0].params.includes('110.01'),
        'enabling fixed supply must install exact authoritative supply including pending claims');
    } finally {
      bountyService.lockBountyAdminAuthority = originalLock;
      moneySupplyManager.getAuthoritativeSupplyCents = originalAggregate;
      delete require.cache[require.resolve('../routes/economy')];
    }
  });

  await test('economy config rejects invalid typed or fractional values before its transaction', async () => {
    delete require.cache[require.resolve('../routes/economy')];
    const router = require('../routes/economy');
    const handler = handlerFor(router, '/admin/:serverId/config', 'post');
    for (const economy of [
      { enabled: 'true' },
      { monetary_system: 'unbacked' },
      { starting_cash: 1.001 },
      { transfer_fee_percentage: 101 },
    ]) {
      let transactions = 0;
      const req = {
        app: { locals: { db: { async transaction() { transactions++; } } } },
        user: { id: 5 }, authorization: { server: { id: 7 }, guild: { id: 3 } },
        body: { economy },
      };
      const res = responseRecorder();
      await handler(req, res);
      assert.strictEqual(res.statusCode, 400, JSON.stringify(economy));
      assert.strictEqual(transactions, 0, 'invalid settings must fail before transactional writes');
    }
    delete require.cache[require.resolve('../routes/economy')];
  });

  await test('financial lifecycle conflicts map to HTTP 409 without partial writes', async () => {
    const cases = [];

    delete require.cache[require.resolve('../routes/admin')];
    const adminRouter = require('../routes/admin');
    let writes = 0;
    const adminDb = {
      type: 'postgres',
      async transaction(callback) { return callback(); },
      async get(sql) {
        if (/FROM player_identities/.test(sql)) return { id: 9, platform: 'xbox', platform_user_id: 'p9' };
        if (/FROM bounties/.test(sql)) return { id: 1 };
        return null;
      },
      async run() { writes++; return { changes: 1 }; },
    };
    let req = { app: { locals: { db: adminDb } }, body: { identityId: 9 }, user: { id: 1 } };
    let res = responseRecorder();
    await handlerFor(adminRouter, '/db-reset/player-stats', 'post')(req, res);
    cases.push(['player reset', res.statusCode]);
    assert.strictEqual(writes, 0, 'reset conflict must not partially delete data');

    delete require.cache[require.resolve('../routes/economy')];
    const economyRouter = require('../routes/economy');
    const economyDb = {
      async transaction() {
        const error = new Error('Maximum money supply is below authoritative assets');
        error.status = 409;
        throw error;
      },
    };
    req = {
      app: { locals: { db: economyDb } }, user: { id: 1 },
      authorization: { server: { id: 7 }, guild: { id: 3 } },
      body: { economy: { enabled: true }, expectedVersion: 1 },
    };
    res = responseRecorder();
    await handlerFor(economyRouter, '/admin/:serverId/config', 'post')(req, res);
    cases.push(['economy cap', res.statusCode]);

    const bountyService = require('../services/bountyService');
    const originalCancel = bountyService.cancelBountyInTransaction;
    bountyService.cancelBountyInTransaction = async () => {
      const error = new Error('Destination account capacity exceeded'); error.status = 409; throw error;
    };
    try {
      delete require.cache[require.resolve('../routes/bounties')];
      const bountyRouter = require('../routes/bounties');
      req = {
        app: { locals: { db: { transaction: callback => callback() } } },
        playerServerAccess: { serverId: 7, guildId: 3, identityId: 9 },
        user: { id: 1 }, params: { bountyId: '4' }, body: {},
      };
      res = responseRecorder();
      await handlerFor(bountyRouter, '/:serverId/:bountyId/cancel', 'post')(req, res);
      cases.push(['bounty cancellation', res.statusCode]);
    } finally {
      bountyService.cancelBountyInTransaction = originalCancel;
      delete require.cache[require.resolve('../routes/bounties')];
    }

    const shopService = require('../services/shopFileService');
    const originalRefund = shopService.processRefund;
    shopService.processRefund = async () => {
      const error = new Error('Destination wallet capacity exceeded'); error.status = 409; throw error;
    };
    try {
      delete require.cache[require.resolve('../routes/shop')];
      const shopRouter = require('../routes/shop');
      const shopDb = {
        async get() { return { id: 4, server_id: 7 }; },
        async acquireTransactionAdvisoryLock() {},
        async transaction(callback) { return callback(this); },
      };
      req = { app: { locals: { db: shopDb } }, params: { orderId: '4' }, user: { id: 1 } };
      res = responseRecorder();
      await handlerFor(shopRouter, '/admin/orders/:orderId/refund', 'post')(req, res);
      cases.push(['shop refund', res.statusCode]);
    } finally {
      shopService.processRefund = originalRefund;
      delete require.cache[require.resolve('../routes/shop')];
    }

    assert.deepStrictEqual(cases, [
      ['player reset', 409], ['economy cap', 409],
      ['bounty cancellation', 409], ['shop refund', 409],
    ]);
  });

  await test('operation-time membership revocation returns HTTP 403', async () => {
    const service = require('../services/bountyService');
    const original = service.createPlayerBountyInTransaction;
    service.createPlayerBountyInTransaction = async () => {
      throw new Error('Player identity is not active on this server');
    };
    try {
      delete require.cache[require.resolve('../routes/bounties')];
      const router = require('../routes/bounties');
      const handler = handlerFor(router, '/:serverId', 'post');
      const req = {
        app: { locals: { db: { transaction: callback => callback() } } },
        playerServerAccess: { serverId: 7, identityId: 20 },
        user: { id: 5 }, body: { targetIdentityId: 30, amount: 25 },
        get() { return 'request-1'; },
      };
      const res = responseRecorder();
      await handler(req, res);
      assert.strictEqual(res.statusCode, 403);
    } finally {
      service.createPlayerBountyInTransaction = original;
      delete require.cache[require.resolve('../routes/bounties')];
    }
  });

  await test('offline-target admission denial returns HTTP 409', async () => {
    const service = require('../services/bountyService');
    const original = service.createPlayerBountyInTransaction;
    service.createPlayerBountyInTransaction = async () => {
      throw new Error('Target player must be freshly online on this server');
    };
    try {
      delete require.cache[require.resolve('../routes/bounties')];
      const router = require('../routes/bounties');
      const handler = handlerFor(router, '/:serverId', 'post');
      const req = {
        app: { locals: { db: { transaction: callback => callback() } } },
        playerServerAccess: { serverId: 7, identityId: 20 },
        user: { id: 5 }, body: { targetIdentityId: 30, amount: 25 },
        get() { return 'request-2'; },
      };
      const res = responseRecorder();
      await handler(req, res);
      assert.strictEqual(res.statusCode, 409);
    } finally {
      service.createPlayerBountyInTransaction = original;
      delete require.cache[require.resolve('../routes/bounties')];
    }
  });

  await test('authoritative new kill IDs drive bounty settlement and enrich the existing kill feed', async () => {
    const parser = source('routes/logParser.js');
    assert.match(parser, /INSERT INTO kill_events[\s\S]*RETURNING id/i);
    assert.match(parser, /claimBountiesForKillInTransaction\(db,\s*\{[\s\S]*killEventId[\s\S]*serverId:\s*dbServerId[\s\S]*killerIdentityId[\s\S]*victimIdentityId/i);
    assert.match(parser, /bountyAwardAmount:\s*bountyAwardAmount/i);
    assert.match(parser, /bountyRefundAmount:\s*bountyRefundAmount/i);
    assert.match(parser, /bountyDeferredAwardAmount:\s*bountyDeferredAwardAmount/i);
    assert.match(parser, /bountyDeferredRefundAmount:\s*bountyDeferredRefundAmount/i);
    const insertAt = parser.indexOf('INSERT INTO kill_events');
    const claimAt = parser.indexOf('claimBountiesForKillInTransaction', insertAt);
    const economyAt = parser.indexOf('economyHelper.getEconomyConfigForIdentity', insertAt);
    const feedAt = parser.indexOf("'kill_feed', 'player_kill'");
    assert(insertAt >= 0 && claimAt > insertAt && economyAt > claimAt && feedAt > economyAt,
      'bounty locks and settlement must happen after persistence but before economy wallet locks and feed output');
  });

  await test('online cache publishes source-derived observation time atomically', async () => {
    const parser = source('routes/logParser.js');
    assert.match(parser, /sourceObservedAt|source_observed_at/,
      'online authority must use an ADM source observation timestamp');
    assert.match(parser, /db\.transaction[\s\S]*server_online_cache_snapshots[\s\S]*FOR UPDATE[\s\S]*DELETE FROM server_online_cache[\s\S]*INSERT INTO server_online_cache[\s\S]*UPDATE server_online_cache_snapshots/i,
      'cache rows and marker must publish in one marker-first transaction');
    assert.match(parser, /source_observed_at[\s\S]*clock_timestamp\(\)/i,
      'cache publication must reject stale or implausibly future source evidence');
    const producer = parser.slice(parser.indexOf('async function updateOnlineCache'),
      parser.indexOf('function parseLogTimestamp'));
    assert.ok(producer.indexOf('FROM servers') < producer.indexOf('server_online_cache_snapshots'),
      'cache producer must lock the canonical server before its snapshot marker');
    assert.doesNotMatch(producer, /syntheticIdentityIdFromPlatformUserId/,
      'authorization cache must contain canonical identity keys only');
  });

  await test('kill processing acquires the canonical server lock before economy wallet locks', async () => {
    const parser = source('routes/logParser.js');
    assert.match(parser,
      /async function processKillEconomyTransaction\(db,\s*serverId,\s*callback\)[\s\S]*SELECT id FROM servers[\s\S]*FOR UPDATE[\s\S]*callback\(\)/i,
      'the kill transaction must establish server-before-wallet lock order');
    assert.match(parser, /processKillEconomyTransaction\(db,\s*dbServerId,\s*async \(\) =>/,
      'kill ingestion must pass the canonical internal server ID to the lock wrapper');
  });

  await test('kill embeds distinguish wallet-credited and deferred bounty awards', async () => {
    const { buildKillEmbedPayload } = require('../utils/feedMessageFormatter');
    const worker = source('workers/feedProcessor.js');
    assert.match(worker, /bountyAwardAmount/);
    assert.match(worker, /bountyRefundAmount/);
    assert.match(worker, /bountyDeferredAwardAmount/);
    assert.match(worker, /bountyDeferredRefundAmount/);
    const payload = buildKillEmbedPayload(
      { killer: 'Killer', victim: 'Victim', timestamp: '2026-08-31T00:00:00.000Z' },
      {}, {},
      { currencySymbol: '$', killerBalance: 100, killRewardAmount: 0, lootAmount: 0,
        bountyAwardAmount: 25, bountyDeferredAwardAmount: 10 },
      {}, 'Server'
    );
    const economy = payload.embeds[0].fields.find(field => /Economy/.test(field.name)).value;
    assert.match(economy, /\+\$25\.00 bounty reward/,
      'only committed wallet credit is rendered as a positive reward');
    assert.match(economy, /\$10\.00 bounty award deferred as claim/,
      'deferred value must be described as a claim rather than completed payment');
    assert.doesNotMatch(economy, /\+\$10/,
      'deferred claims must never render as wallet credits');
  });

  await test('scheduler expires bounty escrow through bounded exact-server transactions', async () => {
    const scheduler = source('scheduler.js');
    assert.match(scheduler, /expireBounties/);
    assert.match(scheduler, /SELECT id FROM servers[\s\S]*status = 'active'/i);
    assert.match(scheduler, /db\.transaction[\s\S]*expireBounties\(db,\s*server\.id/i);
    assert.match(scheduler, /wallet credited[\s\S]*deferred claims/i,
      'scheduler must report immediate credits separately from deferred obligations');
    assert.doesNotMatch(scheduler, /Refunded \$\{result\.expiredCount\}/,
      'scheduler must not describe every settled contract as a completed refund');
    assert.match(scheduler, /bountyExpirationRunning/,
      'scheduler must suppress overlapping expiration callbacks');
    assert.match(scheduler, /for \(const server[\s\S]*try[\s\S]*expireBounties[\s\S]*catch/i,
      'one broken server must not skip expiration for later servers');
  });

  await test('database reset paths preserve active bounty escrow atomically', async () => {
    const admin = source('routes/admin.js');
    assert.doesNotMatch(admin, /parseInt\(req\.body\.identityId/,
      'destructive identity targeting must reject partially numeric identifiers');
    assert.match(admin, /db\.transaction[\s\S]*FROM bounties[\s\S]*status = 'active'[\s\S]*FOR UPDATE[\s\S]*getIdentityReferenceColumns/s,
      'player reset must lock and reject active bounty escrow before deleting dependent rows');
  });

  await test('server disable rejects active bounty escrow before changing lifecycle state', async () => {
    const nitrado = source('routes/nitrado.js');
    const handler = nitrado.slice(nitrado.indexOf("router.put('/account-servers/:serviceId'"),
      nitrado.indexOf("router.put('/server-settings/"));
    assert.match(handler,
      /FROM bounties[\s\S]*status = 'active'[\s\S]*FOR UPDATE[\s\S]*UPDATE servers/i,
      'server disable must lock and reject active escrow before setting the server inactive');
  });

  await test('owner wipe paths reject active bounty escrow before deleting history', async () => {
    const { wipePlayer, wipeServer } = require('../services/wipeService');
    for (const scope of ['player', 'server']) {
      const calls = [];
      const db = {
        async transaction(callback) { return callback(); },
        async get(sql, params) {
          calls.push({ method: 'get', sql, params });
          if (/FROM servers s/i.test(sql)) return { id: 7 };
          if (/FROM bounties/i.test(sql)) return { id: 91 };
          throw new Error('unexpected lookup');
        },
        async run(sql, params) { calls.push({ method: 'run', sql, params }); return { changes: 1 }; },
      };
      const operation = scope === 'player'
        ? wipePlayer(db, { serverId: 7, identityId: 20, requestedByUserId: 5 })
        : wipeServer(db, { serverId: 7, requestedByUserId: 5 });
      await assert.rejects(operation, /active bounty escrow/i);
      assert(!calls.some(call => call.method === 'run'), 'wipe deleted history before escrow preflight');
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
