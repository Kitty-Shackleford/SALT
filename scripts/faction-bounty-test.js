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
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error.message}`);
  }
}

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

(async () => {
  console.log('\nFaction bounty tests');

  await test('migration 082 adds exact-server faction targets and immutable member snapshots', async () => {
    const migration = require('../db/migrations/082_faction_bounties');
    const statements = [];
    await migration.up({ async query(sql) { statements.push(sql); return { rows: [] }; } });
    const sql = statements.join('\n');

    assert.match(sql, /ADD COLUMN IF NOT EXISTS guild_id INTEGER/i);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS target_type TEXT/i);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS target_faction_id INTEGER/i);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS target_faction_id_snapshot INTEGER/i);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS creator_type TEXT/i);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS creator_faction_id INTEGER/i);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS creator_faction_id_snapshot INTEGER/i);
    assert.match(sql, /FOREIGN KEY \(server_id, guild_id\)[\s\S]*REFERENCES servers \(id, guild_id\)/i);
    assert.match(sql, /FOREIGN KEY \(target_faction_id, guild_id\)[\s\S]*REFERENCES factions \(id, guild_id\)/i);
    assert.match(sql, /target_type = 'player'[\s\S]*target_identity_id IS NOT NULL[\s\S]*target_faction_id IS NULL/i);
    assert.match(sql, /target_type = 'faction'[\s\S]*target_identity_id IS NULL[\s\S]*target_faction_id IS NOT NULL/i);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS bounty_faction_members/i);
    assert.match(sql, /member_role TEXT NOT NULL CHECK \(member_role IN \('target', 'sponsor'\)\)/i);
    assert.match(sql, /UNIQUE \(bounty_id, member_role, identity_id\)/i);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS bounty_objective_events/i);
    assert.match(sql, /UNIQUE \(bounty_id, kill_event_id\)/i);
    assert.match(sql, /UNIQUE \(bounty_id, victim_identity_id\)/i,
      'the same captured member must not be farmed repeatedly for objective progress');
    assert.match(sql, /UPDATE bounties[\s\S]*settled_at = NULL[\s\S]*status = 'claimed'/i,
      'legacy deferred awards must clear settled_at before the claimed-to-settled trigger is installed');
    assert.match(sql, /CREATE OR REPLACE FUNCTION validate_bounty_objective_event/i);
    assert.match(sql, /kill_row\.killer_identity_id[\s\S]*NEW\.claimant_identity_id/i);
    assert.match(sql, /member_role = 'target'/i);
    assert.match(sql, /CREATE TRIGGER protect_faction_bounty_claimant_membership_trigger[\s\S]*BEFORE INSERT OR UPDATE OF faction_id, guild_id, identity_id ON faction_members/i);
    assert.match(sql, /PERFORM b\.id[\s\S]*ORDER BY b\.id[\s\S]*FOR UPDATE/i,
      'membership changes must serialize against active faction bounty claimant assignment');
    assert.match(sql, /Cannot join a faction excluded by an active bounty objective/i);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS bounty_events/i);
    assert.match(sql, /faction_kills_required INTEGER NOT NULL DEFAULT 3/i);
    assert.match(sql, /protect_faction_with_active_bounty/i,
      'disband must fail closed while the faction is part of active escrow');
  });

  await test('faction bounty identifiers reject coercive values before database access', async () => {
    const { createFactionBountyInTransaction } = require('../services/bountyService');
    for (const targetFactionId of [true, 1.5, '1e3', '01', ' 1']) {
      let touched = false;
      const db = new Proxy({}, { get() { touched = true; throw new Error('database touched'); } });
      await assert.rejects(
        () => createFactionBountyInTransaction(
          db,
          { serverId: 1, guildId: 2, identityId: 3, userId: 4 },
          { targetFactionId, amount: 100, idempotencyKey: 'faction-request' }
        ),
        /Target faction is required/i
      );
      assert.strictEqual(touched, false);
    }
    let contradictoryTouched = false;
    const contradictoryDb = new Proxy({}, {
      get() { contradictoryTouched = true; throw new Error('database touched'); },
    });
    await assert.rejects(
      () => createFactionBountyInTransaction(
        contradictoryDb,
        { serverId: 1, guildId: 2, identityId: 3, userId: 4 },
        { targetFactionId: 5, targetIdentityId: 6, amount: 100, idempotencyKey: 'faction-request' }
      ),
      /exactly one bounty target/i
    );
    assert.strictEqual(contradictoryTouched, false);
  });

  await test('faction bounty creation is personally funded and snapshots target and sponsor rosters', async () => {
    const service = source('services/bountyService.js');
    assert.match(service, /async function createFactionBountyInTransaction/i);
    assert.match(service, /rank IN \('leader', 'officer'\)/i);
    assert.match(service, /target_faction_id/i);
    assert.match(service, /creator_faction_id/i);
    assert.match(service, /INSERT INTO bounty_faction_members/i);
    assert.match(service, /member_role/i);
    assert.match(service, /UPDATE player_wallets SET cash_on_hand = cash_on_hand -/i);
    assert.match(service, /targetType:\s*'faction'/i);
  });

  await test('authoritative kills advance one-hunter faction objectives without client claims', async () => {
    const service = source('services/bountyService.js');
    const routes = source('routes/bounties.js');
    assert.match(service, /bounty_objective_events/i);
    assert.match(service, /bounty_faction_members/i);
    assert.match(service, /COUNT\(DISTINCT[\s\S]*victim_identity_id/i);
    assert.match(service, /required_kills/i);
    assert.match(service, /creator_faction_id/i,
      'sponsor-faction members must be excluded from claiming');
    const claim = service.slice(service.indexOf('async function claimBountiesForKillInTransaction'),
      service.indexOf('async function claimFinancialRefundsInTransaction'));
    const factionLockIndex = claim.indexOf('await lockFaction(');
    const membershipLockIndex = claim.indexOf('await lockActiveMembership(');
    assert(factionLockIndex >= 0 && factionLockIndex < membershipLockIndex,
      'kill settlement must lock referenced factions before player memberships');
    assert.match(claim, /FROM faction_members[\s\S]*FOR UPDATE/i,
      'claim eligibility must reject current target- and sponsor-faction membership under lock');
    assert.match(claim, /FROM alt_account_reviews[\s\S]*FOR UPDATE/i);
    assert.match(claim, /identity_id_low\s*=\s*LEAST\(\?::int,\s*\?::int\)[\s\S]*identity_id_high\s*=\s*GREATEST\(\?::int,\s*\?::int\)/i,
      'PostgreSQL must infer canonical integer types for the alt-review pair lookup');
    const ownerRoutes = source('routes/ownerDashboard.js');
    const reviewRoute = ownerRoutes.slice(ownerRoutes.indexOf("router.post('/servers/:id/alts/review'"));
    assert.match(reviewRoute, /db\.transaction\(async tx/);
    assert.match(reviewRoute, /FROM servers s[\s\S]*FOR UPDATE OF s[\s\S]*INSERT INTO alt_account_reviews/i,
      'alt-review writes must share the canonical server fence with kill settlement');
    assert.doesNotMatch(routes, /:bountyId\/claim/i,
      'the public API must not expose a client-driven bounty claim route');
  });

  await test('authoritative faction objective settles once after the configured unique-member count', async () => {
    const { claimBountiesForKillInTransaction } = require('../services/bountyService');
    const calls = [];
    const db = {
      async get(sql, params) {
        calls.push({ method: 'get', sql, params });
        if (/FROM servers/i.test(sql)) return { id: 7, guild_id: 3 };
        if (/FROM factions/i.test(sql)) return { id: params[0], guild_id: params[1], name: 'Faction', tag: 'F' };
        if (/FROM kill_events/i.test(sql)) return {
          id: 77, server_id: 7, killer_identity_id: 10, victim_identity_id: 20,
          timestamp: '2026-09-05T12:00:00.000Z',
        };
        if (/FROM server_player_memberships/i.test(sql)) return { identity_id: params[1] };
        if (/FROM guild_economy_config/i.test(sql)) return { server_id: 7 };
        if (/SELECT b\.id FROM bounties/i.test(sql)) return { id: 90 };
        if (/FROM alt_account_reviews/i.test(sql)) return null;
        if (/SELECT member_role FROM bounty_faction_members/i.test(sql)) return null;
        if (/INSERT INTO bounty_objective_events/i.test(sql)) return { id: 500 };
        if (/COUNT\(DISTINCT victim_identity_id\)/i.test(sql)) return { progress_kills: 2 };
        if (/clock_timestamp\(\) AS observed_at/i.test(sql)) return { observed_at: '2026-09-05T12:01:00.000Z' };
        if (/FROM player_wallets/i.test(sql)) return { cash_on_hand: '100.00' };
        if (/UPDATE player_wallets/i.test(sql)) return { cash_on_hand: '150.00' };
        return null;
      },
      async query(sql, params) {
        calls.push({ method: 'query', sql, params });
        if (/FROM bounties/i.test(sql)) return [{
          id: 90, server_id: 7, guild_id: 3, target_type: 'faction', target_faction_id: 8,
          creator_faction_id: 9, objective_claimant_identity_id: null,
          required_kills: 2, poster_identity_id: 30, funding_type: 'player_wallet', amount: '50.00',
        }];
        return [];
      },
      async run(sql, params) { calls.push({ method: 'run', sql, params }); return { changes: 1, lastID: 900 }; },
    };

    const result = await claimBountiesForKillInTransaction(db, { killEventId: 77, serverId: 7 });
    assert.deepStrictEqual(result.factionProgress, [{ bountyId: 90, progressKills: 2, requiredKills: 2 }]);
    assert.strictEqual(result.claimedAmount, 50);
    assert.deepStrictEqual(result.claimedBountyIds, [90]);
    assert.deepStrictEqual(result.settledBountyIds, [90]);
    assert(calls.some(call => /UPDATE bounties SET objective_claimant_identity_id/i.test(call.sql)
      && call.params[0] === 10));
    assert(calls.some(call => /UPDATE bounties SET status = \?/i.test(call.sql)
      && call.params[0] === 'settled'));
    assert.strictEqual(calls.filter(call => /INSERT INTO bounty_claims/i.test(call.sql)).length, 1);
  });

  await test('database resets retain faction bounty snapshots, progress, audit evidence, and membership state', async () => {
    const admin = source('routes/admin.js');
    for (const table of ['bounty_faction_members', 'bounty_objective_events', 'bounty_events']) {
      const matches = admin.match(new RegExp(`['"]${table}['"]`, 'g')) || [];
      assert.strictEqual(matches.length, 2, `${table} must be retained by full and player resets`);
    }
    const fullReset = admin.slice(admin.indexOf('const FULL_RESET_PRESERVE_TABLES'),
      admin.indexOf('const PLAYER_RESET_PRESERVE_TABLES'));
    const playerReset = admin.slice(admin.indexOf('const PLAYER_RESET_PRESERVE_TABLES'),
      admin.indexOf('function quoteIdent'));
    for (const preserveList of [fullReset, playerReset]) {
      assert.match(preserveList, /'factions'/);
      assert.match(preserveList, /'faction_members'/);
    }
  });

  await test('new faction bounty creation locks factions before player membership authority', async () => {
    const service = source('services/bountyService.js');
    const create = service.slice(service.indexOf('async function createFactionBountyInTransaction'),
      service.indexOf('\nmodule.exports'));
    const newCommandLocks = create.slice(create.indexOf('const lockedFactions'));
    assert(newCommandLocks.indexOf('await lockFaction(') >= 0);
    assert(newCommandLocks.indexOf('await lockFaction(') < newCommandLocks.indexOf('await lockPlayerAuthority('),
      'new faction bounty commands must follow faction-before-membership lock order');
  });

  await test('bounty browser retains unknown-outcome idempotency commands across context switches', async () => {
    const browser = source('public/js/bounties.js');
    assert.match(browser, /bountyPendingCommands\s*=\s*new Map\(\)/);
    assert.match(browser, /sessionStorage\.getItem/);
    assert.match(browser, /sessionStorage\.setItem/);
    const reset = browser.slice(browser.indexOf('function resetBountiesContext'),
      browser.indexOf('function initBounties'));
    assert.doesNotMatch(reset, /bountyPendingCommands\.(?:clear|delete)/,
      'switching servers must not discard a resumable unknown financial outcome');
  });

  await test('bounty financial client is cache-busted and stale requests receive refresh guidance', async () => {
    const html = source('public/player-portal.html');
    const appRoutes = source('src/app/registerRoutes.js');
    const bountyRoutes = source('routes/bounties.js');
    assert.match(html, /\/js\/bounties\.js\?v=faction-bounty-idempotency-v1/,
      'the bounty financial client must use a cache-busting asset URL');
    assert.match(appRoutes,
      /app\.get\('\/player'[\s\S]*?Cache-Control', 'no-store'[\s\S]*?renderWithCsrf\(pub\('player-portal\.html'/,
      'the authenticated player document must not be reused across bounty contract deployments');
    assert.match(appRoutes,
      /app\.get\('\/player-portal'[\s\S]*?Cache-Control', 'no-store'[\s\S]*?renderWithCsrf\(pub\('player-portal\.html'/,
      'the player-portal alias must not reuse a stale financial client');
    assert.match(bountyRoutes, /parseIdempotencyKey\(req\)/,
      'missing bounty idempotency keys must use the actionable shared parser');
  });

  await test('public bounty surfaces do not reveal sponsor, roster, or correlatable progress', async () => {
    const routes = source('routes/bounties.js');
    const browser = source('public/js/bounties.js');
    const logParser = source('routes/logParser.js');
    const worker = source('workers/feedProcessor.js');
    const formatter = source('utils/feedMessageFormatter.js');
    assert.match(routes, /if \(bounty\.creatorType === 'faction'\)[\s\S]*delete bounty\.posterIdentityId[\s\S]*delete bounty\.posterGamertag/i);
    assert.match(routes, /if \(bounty\.targetType === 'faction'\)[\s\S]*delete bounty\.progressKills/i,
      'public faction bounties must not expose progress that can be correlated with named kills');
    assert.doesNotMatch(browser, /bounty\.progressKills/,
      'the public board must not render faction progress beside the named kill feed');
    assert.doesNotMatch(logParser, /factionBountyProgress/);
    assert.doesNotMatch(worker, /factionBountyProgress/);
    assert.doesNotMatch(formatter, /factionBountyProgress/);
    assert.match(logParser, /publicFeedAwardAmount/);
    assert.match(logParser, /publicFeedDeferredAwardAmount/);
  });

  await test('faction retry lookup precedes mutable faction policy and roster checks', async () => {
    const service = source('services/bountyService.js');
    const create = service.slice(service.indexOf('async function createFactionBountyInTransaction'),
      service.indexOf('\nmodule.exports'));
    assert.match(create, /existing = await db\.get[\s\S]*if \(existing\)[\s\S]*return serializeBounty[\s\S]*SELECT faction_id FROM faction_members/i);
    const fingerprint = create.slice(create.indexOf('const fingerprint ='), create.indexOf('const existing ='));
    assert.doesNotMatch(fingerprint, /creatorFactionId|requiredKills|effectiveExpiresAt/);
  });

  await test('bounty browser suppresses stale same-context board and search responses', async () => {
    const browser = source('public/js/bounties.js');
    assert.match(browser, /bountyBoardRequestId/);
    assert.match(browser, /bountyPlayerSearchRequestId/);
  });

  await test('bounty API exposes typed targets and public roster counts without member identities', async () => {
    const routes = source('routes/bounties.js');
    assert.match(routes, /targetType/i);
    assert.match(routes, /targetFactionId/i);
    assert.match(routes, /eligible_member_count/i);
    assert.match(routes, /f\.id <> \?/i,
      'the sponsor faction must not be returned as a valid target option');
    assert.doesNotMatch(routes, /JOIN bounty_faction_members\s+\w+\s+JOIN player_gamertags/i,
      'public bounty reads must not expose the captured roster');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
