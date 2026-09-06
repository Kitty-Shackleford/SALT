'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');

function testMembershipDeactivationProtection() {
  const migration = source('db/migrations/067_exact_tree_fail_closed.js');
  assert.match(migration,
    /BEFORE UPDATE OF status ON server_player_memberships[\s\S]*OLD\.status IS DISTINCT FROM NEW\.status[\s\S]*NEW\.status <> 'active'/i);
  assert.match(migration, /bounties[\s\S]*status = 'active'/i);
  assert.match(migration, /casino_sessions[\s\S]*status = 'active'[\s\S]*reserved_wager > 0/i);
}

function testParentEscrowTriggerPreservesPermittedUpdates() {
  const migration = source('db/migrations/066_bounties.js');
  for (const functionName of [
    'protect_parent_with_active_bounty',
    'protect_parent_with_active_financial_escrow',
  ]) {
    const start = migration.indexOf(`FUNCTION ${functionName}()`);
    const end = migration.indexOf('$$;', start);
    const body = migration.slice(start, end);
    assert.match(body, /TG_OP\s*=\s*'UPDATE'[\s\S]*RETURN NEW/i,
      `${functionName} must return NEW for a permitted BEFORE UPDATE`);
    assert.match(body, /RETURN OLD/i,
      `${functionName} must preserve DELETE trigger semantics`);

    const permittedUpdate = { old: { status: 'active' }, new: { status: 'disabled' } };
    const returned = /TG_OP\s*=\s*'UPDATE'[\s\S]*RETURN NEW/i.test(body)
      ? permittedUpdate.new : permittedUpdate.old;
    assert.strictEqual(returned, permittedUpdate.new,
      'mock BEFORE UPDATE execution must propagate the requested NEW row');
  }
}

function testLifecycleEscrowConflictsMapTo409() {
  const admin = source('routes/admin.js');
  const disable = admin.slice(admin.indexOf("router.post('/guilds/:guildId/disable'"),
    admin.indexOf("router.post('/guilds/:guildId/enable'"));
  assert.match(disable, /db\.transaction[\s\S]*FROM bounties[\s\S]*FOR UPDATE[\s\S]*FROM casino_sessions[\s\S]*FOR UPDATE/i,
    'guild disable must preflight both escrow families under transaction locks');
  assert.match(disable, /isEscrowProtectionConflict\(err\)[\s\S]*status\(409\)[\s\S]*financial escrow/i,
    'guild disable must map escrow trigger conflicts to a safe 409');

  const nitrado = source('routes/nitrado.js');
  const selection = nitrado.slice(nitrado.indexOf("router.put('/account-servers/:serviceId'"),
    nitrado.indexOf("router.get('/account-servers/:serviceId/naming'"));
  assert.match(selection, /FROM bounties[\s\S]*FOR UPDATE[\s\S]*FROM casino_sessions[\s\S]*FOR UPDATE/i,
    'server disable must preflight bounty and casino escrow');
  assert.match(selection, /error\.code === 'P0001'[\s\S]*status\(409\)[\s\S]*financial escrow/i,
    'server disable must safely map database escrow conflicts to 409');
}

function testUniformMonetaryDomain() {
  const migration = source('db/migrations/067_exact_tree_fail_closed.js');
  const columns = [
    ['shop_items', 'price'],
    ['shop_orders', 'total_price'],
    ['shop_order_items', 'unit_price'],
    ['casino_game_history', 'wager'],
    ['casino_game_history', 'payout'],
    ['casino_game_history', 'net'],
  ];
  for (const [table, column] of columns) {
    if (table === 'casino_game_history' && column === 'net') continue;
    assert.match(migration,
      new RegExp(`ALTER TABLE ${table}[\\s\\S]*ALTER COLUMN ${column} TYPE NUMERIC\\(20, 2\\)`, 'i'),
      `${table}.${column} must be NUMERIC(20,2)`);
  }
  assert.match(migration,
    /ALTER TABLE casino_game_history[\s\S]*DROP COLUMN net[\s\S]*ALTER COLUMN wager TYPE NUMERIC\(20, 2\)[\s\S]*ALTER COLUMN payout TYPE NUMERIC\(20, 2\)[\s\S]*ADD COLUMN net NUMERIC\(20, 2\)[\s\S]*GENERATED ALWAYS AS \(payout - wager\) STORED/i,
    'casino generated net must be recreated around widening its dependencies');
  assert.match(migration, /information_schema\.columns[\s\S]*numeric_precision[\s\S]*numeric_scale/i,
    'migration must assert the resulting catalog types');
  assert.match(migration, /economy_precision_reconciliation[\s\S]*rounding_delta[\s\S]*SUM\(%I::numeric\)[\s\S]*SUM\(%I::numeric\)/i,
    'widening audit must durably record exact pre/post sums even though no rounding is permitted');
  assert.doesNotMatch(migration,
    /ALTER COLUMN (?:price|total_price|unit_price|wager|payout|net) TYPE NUMERIC\(20, 2\) USING ROUND/i,
    'already-cent-exact NUMERIC(12,2) history must be widened without destructive rounding');
}

function testTerminalFinancialHistoryRetention() {
  const migration = source('db/migrations/067_exact_tree_fail_closed.js');
  for (const table of ['servers', 'guilds', 'users', 'player_identities',
    'server_player_memberships', 'player_wallets', 'player_bank_accounts', 'kill_events',
    'bounties', 'casino_sessions', 'shop_orders']) {
    assert.match(migration, new RegExp(`BEFORE DELETE ON ${table}[\\s\\S]*protect_parent_with_financial_history`, 'i'),
      `${table} deletion must be blocked when retained financial history exists`);
  }
  for (const family of ['economy_transactions', 'economy_supply_log', 'bounty_claims',
    'casino_game_history', 'shop_order_items']) {
    assert.match(migration, new RegExp(family), `${family} must participate in retention checks`);
  }
  const terminalAuditTables = [
    'economy_transactions', 'economy_supply_log', 'bounty_claims',
    'casino_game_history', 'shop_order_items', 'economy_precision_reconciliation',
    'economy_supply_precision_reconciliation', 'financial_refund_claims',
  ];
  assert.match(migration, /FUNCTION protect_terminal_financial_history_delete\(\)[\s\S]*TG_TABLE_NAME = 'shop_order_items'[\s\S]*shop_orders[\s\S]*status = 'cart'[\s\S]*RETURN OLD[\s\S]*RAISE EXCEPTION/i,
    'mutable cart line deletion must remain operational while terminal order lines are retained');
  assert.match(migration, /FUNCTION protect_terminal_financial_history_delete\(\)[\s\S]*RAISE EXCEPTION[\s\S]*RETURN OLD/i);
  assert.match(migration, /FUNCTION protect_terminal_financial_history_truncate\(\)[\s\S]*RAISE EXCEPTION[\s\S]*RETURN NULL/i,
    'statement-level TRUNCATE trigger function must preserve PostgreSQL RETURN NULL semantics');
  for (const table of terminalAuditTables) {
    assert.match(migration, new RegExp(`['"]${table}['"][\\s\\S]*protect_terminal_financial_history_update`, 'i'),
      `${table} must reject direct UPDATE`);
    assert.match(migration, new RegExp(`BEFORE DELETE ON ${table}[\\s\\S]{0,160}FOR EACH ROW[\\s\\S]{0,100}protect_terminal_financial_history_delete`, 'i'),
      `${table} must reject direct DELETE`);
    assert.match(migration, new RegExp(`BEFORE TRUNCATE ON ${table}[\\s\\S]{0,160}FOR EACH STATEMENT[\\s\\S]{0,100}protect_terminal_financial_history_truncate`, 'i'),
      `${table} must reject direct TRUNCATE`);
  }
  assert.match(migration, /TG_TABLE_NAME = 'shop_orders'[\s\S]*OLD\.status = 'cart'[\s\S]*OLD\.status IN \('completed', 'expired'\)/i,
    'terminal shop orders must be immutable except narrow lifecycle transitions');
  for (const table of ['servers', 'guilds', 'users', 'player_identities',
    'server_player_memberships', 'player_wallets', 'player_bank_accounts', 'kill_events',
    'bounties', 'casino_sessions', 'shop_orders']) {
    assert.match(migration, new RegExp(`['"]${table}['"][\\s\\S]*protect_terminal_financial_history_truncate`, 'i'),
      `${table} must reject TRUNCATE before cascades can destroy value or retained evidence`);
  }
  const admin = source('routes/admin.js');
  assert.match(admin, /isEscrowProtectionConflict[\s\S]*financial history/i,
    'admin deletion conflicts must map retained financial history to explicit 409');
}

function testLockHierarchySource() {
  const bounty = source('services/bountyService.js');
  const claim = bounty.slice(bounty.indexOf('async function claimBountiesForKillInTransaction'),
    bounty.indexOf('async function createPlayerBountyInTransaction'));
  assert.match(claim,
    /lockActiveMembership[\s\S]*lockEconomyConfig[\s\S]*FROM bounties[\s\S]*FOR UPDATE/i,
    'claim must lock membership before config before bounty targets');
  assert(claim.indexOf('lockActiveMembership') < claim.indexOf('const candidate'),
    'kill settlement must establish actor/member locks before bounty discovery can skip config ordering');
  const cancel = bounty.slice(bounty.indexOf('async function cancelBountyInTransaction'),
    bounty.indexOf('async function expireBounties'));
  assert.match(cancel, /lockPlayerAuthority[\s\S]*lockEconomyConfig[\s\S]*FROM bounties/i);
  const expire = bounty.slice(bounty.indexOf('async function expireBounties'),
    bounty.indexOf('async function claimBountiesForKillInTransaction'));
  assert.match(expire, /lockActiveServer[\s\S]*lockEconomyConfig[\s\S]*FROM bounties/i);
  const parser = source('routes/logParser.js');
  const transaction = parser.slice(parser.indexOf('async function processKillEconomyTransaction'),
    parser.indexOf('/**\n * Save kill events'));
  assert.doesNotMatch(transaction, /lockSupplyForUpdate/,
    'kill transaction wrapper must not lock config before claim membership prerequisites');
}

function testMissingClaimantWalletIsCreated() {
  const bounty = source('services/bountyService.js');
  const claim = bounty.slice(bounty.indexOf('async function claimBountiesForKillInTransaction'),
    bounty.indexOf('async function createPlayerBountyInTransaction'));
  assert.match(claim,
    /lockEconomyConfig\(db, serverId\)[\s\S]*FROM bounties[\s\S]*FOR UPDATE[\s\S]*getOrCreateWallet\(db, killerIdentityId, serverId\)/i,
    'eligible claimant wallet must be created after config and locked bounty aggregates');
  assert.doesNotMatch(claim, /Claimant wallet is unavailable/,
    'a missing eligible claimant wallet must not poison kill ingestion');
}

function testExpiryRecreatesWalletAndDeletionIsProtected() {
  const bounty = source('services/bountyService.js');
  const expire = bounty.slice(bounty.indexOf('async function expireBounties'),
    bounty.indexOf('async function claimBountiesForKillInTransaction'));
  assert.match(expire, /getOrCreateWallet\(db, identityId, serverId\)[\s\S]*FROM player_wallets[\s\S]*FOR UPDATE/i);
  assert.doesNotMatch(expire, /Player wallet is unavailable/);
  const migration = source('db/migrations/067_exact_tree_fail_closed.js');
  assert.match(migration, /BEFORE DELETE ON player_wallets/i);
  assert.match(migration, /poster_identity_id = OLD\.identity_id[\s\S]*b\.status = 'active'/i);
  assert.match(migration, /c\.identity_id = OLD\.identity_id[\s\S]*c\.status = 'active'[\s\S]*reserved_wager > 0/i);
}

function testResetsPreserveFinancialState() {
  const admin = source('routes/admin.js');
  const financial = [
    'guild_economy_config', 'economy_precision_reconciliation',
    'economy_supply_precision_reconciliation', 'economy_supply_log',
    'player_wallets', 'player_bank_accounts', 'economy_transactions',
    'economy_daily_assessments', 'financial_idempotency_records',
    'financial_refund_claims',
    'casino_sessions', 'casino_game_history', 'bounties', 'bounty_claims',
    'bounty_settings', 'shop_items', 'shop_orders', 'shop_order_items',
  ];
  const playerSet = admin.slice(admin.indexOf('const PLAYER_RESET_PRESERVE_TABLES'),
    admin.indexOf('function quoteIdent'));
  const fullSet = admin.slice(admin.indexOf('const FULL_RESET_PRESERVE_TABLES'),
    admin.indexOf('const PLAYER_RESET_PRESERVE_TABLES'));
  for (const table of financial) {
    assert.match(playerSet, new RegExp(`['"]${table}['"]`), `player stats reset must preserve ${table}`);
    assert.match(fullSet, new RegExp(`['"]${table}['"]`), `full reset must preserve ${table}`);
  }
  for (const dependency of ['server_player_memberships', 'kill_events']) {
    assert.match(fullSet, new RegExp(`['"]${dependency}['"]`),
      `full reset must preserve ${dependency} so CASCADE cannot erase finance history`);
    assert.match(playerSet, new RegExp(`['"]${dependency}['"]`),
      `player stats reset must preserve ${dependency} so CASCADE cannot erase finance history`);
  }
  for (const providerHistory of ['provider_mutations', 'provider_mutation_files']) {
    assert.match(fullSet, new RegExp(`['"]${providerHistory}['"]`),
      `full reset must preserve durable provider recovery table ${providerHistory}`);
  }
}

function testEscrowConflictsMapTo409() {
  const admin = source('routes/admin.js');
  assert.match(admin, /function isEscrowProtectionConflict[\s\S]*active (?:financial|bounty|casino) escrow/i);
  const destructive = [
    admin.slice(admin.indexOf("router.delete('/guilds/:guildId'"), admin.indexOf('/**\n * GET /api/admin/stats')),
    admin.slice(admin.indexOf("router.delete('/servers/:serverId'"), admin.indexOf('/**\n * GET /api/admin/users')),
    admin.slice(admin.indexOf("router.post('/db-reset/player-stats'"), admin.indexOf('/**\n * POST /api/admin/db-reset/full')),
    admin.slice(admin.indexOf("router.post('/db-reset/full'"), admin.indexOf('// ──')),
  ];
  for (const body of destructive) {
    assert.match(body, /isEscrowProtectionConflict\(err\)[\s\S]*res\.status\(409\)/i);
  }
}

function testActiveEscrowUpdatesAreColumnConstrained() {
  const migration = source('db/migrations/067_exact_tree_fail_closed.js');
  assert.match(migration,
    /FUNCTION protect_active_bounty_update\(\)[\s\S]*OLD\.status = 'active'[\s\S]*cancellation_requested_at[\s\S]*NEW\.status = 'claimed'[\s\S]*NEW\.status IN \('cancelled', 'expired'\)[\s\S]*RAISE EXCEPTION/i,
    'active bounty updates must enumerate cancellation and terminal settlement shapes');
  assert.match(migration, /BEFORE UPDATE ON bounties[\s\S]*protect_active_bounty_update/i);
  assert.match(migration,
    /FUNCTION protect_active_casino_update\(\)[\s\S]*OLD\.status = 'active'[\s\S]*NEW\.version = OLD\.version \+ 1[\s\S]*NEW\.status = 'settled'[\s\S]*NEW\.status = 'expired'[\s\S]*RAISE EXCEPTION/i,
    'active casino updates must enumerate state, reservation, and terminal shapes');
  assert.match(migration, /BEFORE UPDATE ON casino_sessions[\s\S]*protect_active_casino_update/i);
}

function testShopUpdatesAreLifecycleConstrained() {
  const migration = source('db/migrations/067_exact_tree_fail_closed.js');
  const body = migration.slice(
    migration.indexOf('FUNCTION protect_terminal_financial_history_update()'),
    migration.indexOf('FUNCTION protect_terminal_financial_history_delete()')
  );
  assert.doesNotMatch(body, /OLD\.status = 'cart'\s+THEN\s+RETURN NEW/i,
    'cart orders must not permit arbitrary rewrites');
  assert.match(body, /OLD\.status = 'cart'[\s\S]*NEW\.status = 'completed'[\s\S]*checked_out_at/i);
  assert.match(body, /OLD\.status = 'completed'[\s\S]*NEW\.status = 'expired'/i);
  assert.match(body, /OLD\.status IN \('completed', 'expired'\)[\s\S]*NEW\.status = 'refunded'/i);
  assert.match(body, /TG_TABLE_NAME = 'shop_order_items'[\s\S]*old_row->>'order_id'[\s\S]*new_row->>'order_id'/i,
    'cart items must not be reparented');
  assert.match(body, /restarts_remaining[\s\S]*is_active/i,
    'terminal rental lifecycle updates must remain operational');
}

function testRefundClaimSchemaIntegrity() {
  const migration = source('db/migrations/067_exact_tree_fail_closed.js');
  assert.match(migration,
    /CHECK \([\s\S]*\(status = 'pending' AND claimed_at IS NULL\)[\s\S]*\(status = 'claimed' AND claimed_at IS NOT NULL\)[\s\S]*\)/i,
    'refund claim status and claimed_at must agree');
  assert.match(migration,
    /FOREIGN KEY \(server_id, identity_id\)[\s\S]*server_player_memberships \(server_id, identity_id\)/i,
    'refund claims must reference exact-server membership');
}

function testMissionEditorUsesSharedMutationLock() {
  const route = source('routes/missionFiles.js');
  const service = source('services/missionEditorSaveService.js');
  const saveRoute = route.slice(
    route.indexOf("router.put('/mission-files/:serverId/:fileName(*)'"),
    route.indexOf("router.get('/mission-files/:serverId/:fileName(*)'")
  );
  assert.match(service, /acquireProviderMutationLock\(transactionDb, internalServerId\)/,
    'mission editor must use the shared fenced exact-server mission mutation lock');
  assert.match(service,
    /createFileMutationJournal[\s\S]*downloadFileFromServer[\s\S]*uploadFileToServer/,
    'provider mission-file uploads must snapshot and verify under the shared lock');
  assert.match(saveRoute, /saveMissionFileVerified\([\s\S]*serverDbId/,
    'the mission save route must delegate through the verified mutation service');
}

function testNonCompensatableProviderMutationsFailClosed() {
  const consoleRoute = source('routes/console.js');
  assert.match(consoleRoute, /PROVIDER_MUTATION_DISABLED/);
  assert.doesNotMatch(consoleRoute, /nitradoService\.command\(/,
    'web console commands must remain disabled until governed as durable non-compensatable intents');

  const controlRoute = source('routes/serverControl.js');
  const controlMutation = controlRoute.slice(controlRoute.indexOf("router.post('/:serverId/:action'"));
  assert.match(controlMutation, /status\(503\)[\s\S]*PROVIDER_MUTATION_DISABLED/);
  assert.doesNotMatch(controlMutation, /nitradoService\.controlServer\(/,
    'web lifecycle controls must not bypass the canonical provider mutation policy');

  const botControl = source('bot/commands/server-control.js');
  assert.match(botControl, /PROVIDER_MUTATION_DISABLED/);
  assert.doesNotMatch(botControl, /await controlServer\(/,
    'bot lifecycle controls must not bypass the canonical provider mutation policy');

  const botNitrado = source('bot/utils/nitrado.js');
  assert.doesNotMatch(botNitrado, /async function controlServer\(/,
    'bot utilities must not retain an alternate lifecycle mutation entry point');
  assert.doesNotMatch(botNitrado, /\bcontrolServer,\s*\n/,
    'bot utilities must not export disabled lifecycle mutation support');

  const backupRoute = source('routes/backups.js');
  const backupMutations = backupRoute.slice(backupRoute.indexOf("router.post('/:serverId/gameserver'"));
  assert.match(backupMutations, /PROVIDER_MUTATION_DISABLED/,
    'destructive provider backup restores must fail closed');
  assert.doesNotMatch(backupMutations,
    /nitradoService\.(?:restoreGameserverBackup|restoreDatabaseBackup)\(/,
    'backup restore routes must not retain non-compensatable provider writes');

  const boostRoute = source('routes/boost.js');
  const boostMutation = boostRoute.slice(boostRoute.indexOf("router.put('/:serverId/settings'"));
  assert.match(boostMutation, /PROVIDER_MUTATION_DISABLED/,
    'boost setting writes must fail closed until they join durable provider recovery');
  assert.doesNotMatch(boostMutation, /nitradoService\.updateBoostSettings\(/,
    'boost setting routes must not bypass the canonical provider mutation policy');
}

const selected = process.argv[2] || 'all';
if (selected === 'membership' || selected === 'all') testMembershipDeactivationProtection();
if (selected === 'parent-update' || selected === 'all') testParentEscrowTriggerPreservesPermittedUpdates();
if (selected === 'lifecycle-conflicts' || selected === 'all') testLifecycleEscrowConflictsMapTo409();
if (selected === 'money' || selected === 'all') testUniformMonetaryDomain();
if (selected === 'retention' || selected === 'all') testTerminalFinancialHistoryRetention();
if (selected === 'locks' || selected === 'all') testLockHierarchySource();
if (selected === 'claim-wallet' || selected === 'all') testMissingClaimantWalletIsCreated();
if (selected === 'expiry-wallet' || selected === 'all') testExpiryRecreatesWalletAndDeletionIsProtected();
if (selected === 'resets' || selected === 'all') testResetsPreserveFinancialState();
if (selected === 'conflicts' || selected === 'all') testEscrowConflictsMapTo409();
if (selected === 'escrow-updates' || selected === 'all') testActiveEscrowUpdatesAreColumnConstrained();
if (selected === 'shop-updates' || selected === 'all') testShopUpdatesAreLifecycleConstrained();
if (selected === 'claim-schema' || selected === 'all') testRefundClaimSchemaIntegrity();
if (selected === 'mission-lock' || selected === 'all') testMissionEditorUsesSharedMutationLock();
if (selected === 'noncompensatable-provider' || selected === 'all') testNonCompensatableProviderMutationsFailClosed();
console.log(`Exact-tree blocker regression passed: ${selected}`);
