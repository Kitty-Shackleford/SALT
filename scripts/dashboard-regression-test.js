#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

function testCasinoStatsUsesGamertagHistory() {
  const source = read('routes/casino.js');
  const adminStats = source.slice(source.indexOf("router.get('/admin-stats'"));

  assert(!adminStats.includes('pi.gamertag'), 'casino admin stats still reads nonexistent player_identities.gamertag');
  assert(adminStats.includes('player_gamertags'), 'casino admin stats does not resolve names through player_gamertags');
  assert.strictEqual(
    (adminStats.match(/pgt\.server_id = stats\.latest_server_id/g) || []).length,
    2,
    'casino leaderboards must resolve one display name after aggregating each identity across servers'
  );
  assert.strictEqual(
    (adminStats.match(/pgt\.server_id = cgh\.server_id/g) || []).length,
    1,
    'recent casino activity must resolve each gamertag on the server where the game was played'
  );
  assert.strictEqual(
    (adminStats.match(/GROUP BY cgh\.identity_id/g) || []).length,
    2,
    'casino leaderboards must aggregate each identity only once across the guild'
  );
}

function testAdminReportsUsesDiscordReportSchema() {
  const source = read('routes/admin.js');
  const reportsRoutes = source.slice(source.indexOf("router.get('/reports'"));

  assert(!reportsRoutes.includes('r.reporter_user_id'), 'admin reports still reads nonexistent reporter_user_id');
  assert(!reportsRoutes.includes('r.reported_identity_id'), 'admin reports still reads nonexistent reported_identity_id');
  assert(!reportsRoutes.includes('resolved_by = ?'), 'admin reports still writes nonexistent resolved_by');
  assert(reportsRoutes.includes('r.reporter_discord_name'), 'admin reports does not use reporter_discord_name');
  assert(reportsRoutes.includes('resolved_by_discord_id'), 'admin reports does not use resolution Discord fields');
}

function testSupportHubUsesRegisteredServersEndpoint() {
  const source = read('public/js/supportHub.js');

  assert(source.includes("fetch('/api/nitrado/registered-servers')"), 'Support Hub does not use the current registered-servers endpoint');
  assert(source.includes('s.server_name'), 'Support Hub does not map the registered server name');
}

function testAuditApiMapsIdentifiersForFrontend() {
  const source = read('routes/admin.js');
  const auditRoute = source.slice(source.indexOf("router.get('/audit'"), source.indexOf("router.get('/guilds/pending'"));

  assert(auditRoute.includes('userId: row.discord_id'), 'audit API does not expose the Discord userId consumed by the avatar URL');
  assert(auditRoute.includes('targetType: row.target_type'), 'audit API does not expose targetType consumed by the frontend');
  assert(auditRoute.includes('targetId: row.target_id'), 'audit API does not expose targetId consumed by the frontend');
}

function testStaticAssetsResolve() {
  const missionEditor = read('public/mission-editor.html');
  const onboarding = read('public/onboarding.html');
  const splash = read('public/splash.html');
  const routeSource = read('src/app/registerRoutes.js');

  assert(!missionEditor.includes('href="/styles.css"'), 'Mission Editor still requests missing /styles.css');
  for (const page of [onboarding, splash]) {
    assert(page.includes('href="/css/tailwind.css"'), 'public setup page does not load the compiled stylesheet');
    assert(!page.includes('href="/css/styles.css"'), 'public setup page requests missing /css/styles.css');
  }
  assert(fs.existsSync(path.join(root, 'public/favicon.svg')), 'favicon asset is missing');
  assert(routeSource.includes("app.get('/favicon.ico'"), '/favicon.ico compatibility route is missing');
}

function testDynamicFrontendValuesAreSafelyRendered() {
  const dashboard = read('public/js/dashboard.js');
  const lootFinder = read('public/js/loot-finder.js');
  const payload = '<img src=x onerror="alert(1)">' + "'&";
  const expected = '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&#39;&amp;';

  for (const source of [dashboard, lootFinder]) {
    const escapeStart = source.indexOf('function escapeHtml');
    const safeTextStart = source.indexOf('function safeText');
    const helperStart = safeTextStart !== -1 && safeTextStart < escapeStart ? safeTextStart : escapeStart;
    const helperEnd = source.indexOf('\n}', escapeStart) + 2;
    const context = { payload };
    vm.runInNewContext(`${source.slice(helperStart, helperEnd)}\nresult = escapeHtml(payload);`, context);
    assert.strictEqual(context.result, expected, 'frontend HTML escaping must neutralize markup and quoted attributes');
  }

  const chartStart = dashboard.indexOf('function renderAnalyticsBarChart');
  const chartSource = dashboard.slice(chartStart);
  const chartElement = { style: {}, innerHTML: '' };
  const chartContext = {
    document: { getElementById: () => chartElement },
    chartPayload: '2026-01-01" onmouseover="globalThis.pwned=1'
  };
  vm.runInNewContext(
    `${dashboard.slice(dashboard.indexOf('function escapeHtml'), dashboard.indexOf('\n}', dashboard.indexOf('function escapeHtml')) + 2)}\n${chartSource}\nrenderAnalyticsBarChart('chart', [{ label: chartPayload, value: 1 }], d => d.label, d => d.value, '#000', '10px');`,
    chartContext
  );
  assert(
    chartElement.innerHTML.includes('title="2026-01-01&quot; onmouseover=&quot;globalThis.pwned=1: 1"'),
    'dashboard chart labels must be escaped before entering title attributes'
  );
  assert(
    dashboard.includes('${escapeHtml(labelFn(d))}: ${escapeHtml(val)}'),
    'dashboard chart labels and values must use the audited escaping boundary'
  );

  assert(
    dashboard.includes('${escapeHtml(activity.description)}'),
    'dashboard activity descriptions must be escaped before entering innerHTML'
  );
  for (const unsafeInterpolation of [
    '${errorMsg}',
    '${data.platform}',
    "${syncData.error || 'Sync failed'}",
    '${data.currentPath}',
    "${data.error || 'Failed to browse'}",
    '${job.status}',
    '${d.name}',
    '${f.name}'
  ]) {
    assert(
      !dashboard.includes(unsafeInterpolation),
      `dashboard still inserts an unescaped API value into HTML: ${unsafeInterpolation}`
    );
  }
  for (const escapedInterpolation of [
    '${escapeHtml(errorMsg)}',
    '${escapeHtml(data.platform)}',
    "${escapeHtml(syncData.error || 'Sync failed')}",
    '${escapeHtml(data.currentPath)}',
    "${escapeHtml(data.error || 'Failed to browse')}",
    '${escapeHtml(job.status)}',
    '${escapeHtml(d.name)}',
    '${escapeHtml(f.name)}'
  ]) {
    assert(
      dashboard.includes(escapedInterpolation),
      `dashboard API values must be escaped before entering HTML: ${escapedInterpolation}`
    );
  }
  for (const escapedInterpolation of [
    '${escapeHtml(item.name)}',
    '${escapeHtml(v)}',
    '${escapeHtml(cats)}',
    '${escapeHtml(categoryText)}',
    '${escapeHtml(usageText)}',
    '${escapeHtml(tagText)}',
    '${escapeHtml(c.item)}',
    '${escapeHtml(evt.item)}',
    "${escapeHtml(evt.timestamp, '')}"
  ]) {
    assert(
      lootFinder.includes(escapedInterpolation),
      `loot API values must be escaped before entering HTML: ${escapedInterpolation}`
    );
  }
  assert(lootFinder.includes('const TIER_BADGE_CLASSES = {'), 'loot tier classes must come from a fixed allowlist');
  assert(
    lootFinder.includes('Object.hasOwn(TIER_BADGE_CLASSES, tierKey)'),
    'loot tier allowlist lookup must reject inherited object properties'
  );
  assert(
    !lootFinder.includes('tier-badge-${escapeHtml(v)}'),
    'escaped text is not sufficient validation for a dynamic CSS class token'
  );
  for (const unsafeInterpolation of [
    '${safeText(item.name)}',
    '${safeText(c.item)}',
    '${safeText(evt.item)}',
    "${safeText(evt.timestamp, '')}",
    '${categoryText}',
    '${usageText}',
    '${tagText}',
    '${cats}'
  ]) {
    assert(
      !lootFinder.includes(unsafeInterpolation),
      `loot finder still inserts an unescaped API value into HTML: ${unsafeInterpolation}`
    );
  }
}

function testDashboardUsesCanonicalMissionEditorRoute() {
  const dashboard = read('public/js/dashboard.js');

  assert(!dashboard.includes('/mission-editor.html?server='), 'dashboard navigates to a blocked direct HTML path');
  assert(dashboard.includes('/mission-editor?server='), 'dashboard must use the authenticated canonical Mission Editor route');
}

function testDashboardOnboardingUsesDiscordCommandOnly() {
  const page = read('public/dashboard.html');
  const client = read('public/js/dashboard.js');

  for (const obsoleteUi of [
    'id="botInviteLink"',
    'id="saveTokenBtn"',
    'id="guild-selection-section"',
    'id="server-registration-section"'
  ]) {
    assert(!page.includes(obsoleteUi), `dashboard still renders obsolete web onboarding control ${obsoleteUi}`);
  }
  for (const obsoleteClientCode of [
    'function saveToken()',
    'function loadUserGuilds()',
    'function onGuildSelected()',
    'function displayAvailableServers()',
    'function registerServer('
  ]) {
    assert(!client.includes(obsoleteClientCode), `dashboard still ships obsolete web onboarding code ${obsoleteClientCode}`);
  }
}

function testShopItemsAlwaysPersistRentalRestartCount() {
  const source = read('routes/shop.js');

  assert(!source.includes('rental_restarts || null'), 'shop item writes still pass null to the NOT NULL rental_restarts column');
  assert.strictEqual(
    (source.match(/normalizeRentalRestarts\(rental_restarts\)/g) || []).length,
    2,
    'shop item create and update must normalize rental_restarts to a positive integer'
  );
}

function testShopUsesCurrentEconomyTransactionSchema() {
  const source = read('services/shopFileService.js');

  assert(!source.includes('(identity_id, type, amount'), 'shop writes the removed economy_transactions.type column');
  assert.strictEqual(
    (source.match(/\(identity_id, server_id, transaction_type, amount/g) || []).length,
    3,
    'shop purchase and refund transactions must use exact-server economy transactions'
  );
}

function testShopRestartUsesAdapterCompatiblePlaceholders() {
  const source = read('services/shopRestartService.js');

  assert(!source.includes('`?${i + 1}`'), 'shop restart builds numbered question-mark placeholders that convert to invalid PostgreSQL parameters');
  assert(source.includes("expiredIds.map(() => '?').join(', ')"), 'shop restart must let the PostgreSQL adapter number plain question-mark placeholders');
}

function testShopRentalCleanupOffsetsExclusionParameters() {
  const source = read('services/shopFileService.js');

  assert(!source.includes('AND soi.id NOT IN (${placeholders})'), 'shop rental cleanup reuses ID-only PostgreSQL placeholders after server and event parameters');
  assert(source.includes("orderItemIds.map(() => '?').join(', ')"), 'shop rental cleanup must use adapter-numbered exclusion placeholders');
  assert(source.includes('WHERE so.server_id = ?'), 'shop rental cleanup mixes explicit PostgreSQL parameters with adapter-numbered placeholders');
  assert(source.includes('AND CASE WHEN soi.snapshot_schema_version = 1 THEN soi.event_name_snapshot ELSE si.event_name END = ?'),
    'shop rental cleanup must use the immutable event-name snapshot and let the adapter number the parameter');
}

function testShopCheckoutRollsBackWhenServerFileUpdateFails() {
  const route = read('routes/shop.js');
  const service = read('services/shopFileService.js');

  assert(route.includes('shopFileService.processCheckout(\n        transactionDb, cart.id, req.user.id, { timer }\n      )'), 'shop checkout does not bind currency, current actor, timing, and order writes to one database transaction');
  assert(!service.includes("console.error('❌ Shop file update failed:', fileErr.message);\n        // Don't roll back currency"), 'shop checkout swallows server-file failures after charging the player');
  assert(service.includes("throw new Error('Shop file update failed: ' + fileErr.message)"), 'shop checkout must fail so its database transaction can roll back');
}

function testShopCheckoutFailsClosedWithoutProvisioningContext() {
  const service = read('services/shopFileService.js');
  const tokenCheck = service.indexOf("throw new Error('No authorized Nitrado token found for shop server')");
  const missionCheck = service.indexOf("throw new Error('Could not determine the active mission for shop server')");
  const walletDebit = service.indexOf('// Deduct currency');

  assert(tokenCheck !== -1, 'shop checkout still succeeds without an authorized Nitrado token');
  assert(missionCheck !== -1, 'shop checkout still succeeds without an active mission directory');
  assert(tokenCheck < walletDebit && missionCheck < walletDebit, 'shop provisioning must be validated before currency is deducted');
}

function testShopCompensatesPartialExternalWrites() {
  const service = read('services/shopFileService.js');
  const missionService = read('services/missionFileService.js');
  const recoveryService = read('services/providerMutationRecoveryService.js');

  assert(service.includes('createFileMutationJournal'), 'shop file mutations have no rollback journal');
  assert(service.includes('await fileJournal.rollback()'), 'checkout does not compensate successful file writes after a later failure');
  assert(missionService.includes('async deleteFileFromServer('), 'rollback cannot remove files created during a failed checkout');
  assert(missionService.includes("data: new URLSearchParams({ path: filePath }).toString()"), 'Nitrado file deletion does not send a form-encoded request body');
  assert(missionService.includes("'Content-Type': 'application/x-www-form-urlencoded'"), 'Nitrado file deletion lacks the form content type');
  assert(recoveryService.includes('committed: async query =>'), 'shop compensation cannot resolve an ambiguous COMMIT outcome');
  assert(recoveryService.includes("status === committedStatus"), 'checkout compensation does not verify the durable completed operation state');
  assert(recoveryService.includes('afterRollback:'), 'provider recovery state can be lost when the local transaction rolls back');
}

function testShopQuantitySemanticsAreUnambiguous() {
  const route = read('routes/shop.js');
  const service = read('services/shopFileService.js');

  assert(route.includes('Permanent shop items require quantity 1'), 'permanent purchases still permit untracked multi-entry provisioning');
  assert(route.includes("Rental duration exceeds this item's configured maximum"), 'rental duration is not bounded by the catalogue maximum');
  assert(service.includes("const provisionQuantity = item.item_type === 'event_rental' ? 1 : qty"), 'rental duration is still interpreted as object quantity');
  assert(service.includes('[fileEntryId, qty, item.id]'), 'rental checkout does not persist the purchased restart duration');
  assert(!service.includes('[fileEntryId, item.rental_restarts || 1, item.id]'), 'rental checkout grants the catalogue maximum instead of purchased duration');
}

function testCheckoutLocksAndRevalidatesCatalogItems() {
  const service = read('services/shopFileService.js');
  const checkout = service.slice(service.indexOf('async function processCheckout'), service.indexOf('// Rental expiry'));

  assert(checkout.includes('si.is_active AS catalog_is_active'), 'checkout does not load active state from every locked catalog row');
  assert(checkout.includes('COUNT(*)::int AS cart_line_count'), 'checkout does not verify that every cart line has a locked catalog row');
  assert(checkout.includes('items.length !== cartLineCount.cart_line_count'), 'checkout can omit a cart line from fulfillment and charging');
  assert(checkout.includes('FOR UPDATE OF si'), 'checkout does not serialize against concurrent catalog edits');
  assert(checkout.includes('!item.catalog_is_active'), 'checkout does not reject a disabled locked catalog item');
  assert(checkout.includes('Permanent shop items require quantity 1'), 'checkout does not revalidate permanent quantity semantics');
  assert(checkout.includes("Rental duration exceeds this item's configured maximum"), 'checkout does not revalidate the current rental maximum');
  assert(checkout.indexOf('FOR UPDATE OF si') < checkout.indexOf('// Check wallet balance'), 'catalog validation happens after wallet locking/debit preparation');
}

function testShopSerializesRemoteMutationsPerServer() {
  const service = read('services/shopFileService.js');
  const restartService = read('services/shopRestartService.js');
  const checkout = service.slice(service.indexOf('async function processCheckout'), service.indexOf('// Rental expiry'));
  const refund = service.slice(service.indexOf('async function processRefund'), service.indexOf('module.exports'));

  assert(service.includes('acquireTransactionAdvisoryLock'), 'shop remote mutations are not serialized with a transaction-owned session lock');
  assert(service.includes('await acquireShopServerLock(db, order.server_id)'), 'checkout does not acquire the shop server lock');
  assert(service.includes('await acquireShopServerLock(db, serverId)'), 'rental cleanup does not acquire the shop server lock');
  assert(restartService.includes('await shopFileService.acquireShopServerLock(transactionDb, serverId)'), 'restart processing does not acquire the shop server lock');
  assert(checkout.indexOf('await acquireShopServerLock') < checkout.indexOf('FOR UPDATE'), 'checkout locks rows before the shared server lock');
  assert(refund.indexOf('await acquireShopServerLock') < refund.indexOf('FOR UPDATE'), 'refund locks rows before the shared server lock');
}

function testShopRefundIsAtomicAndClaimedOnce() {
  const route = read('routes/shop.js');
  const service = read('services/shopFileService.js');

  assert(route.includes('return shopFileService.processRefund(transactionDb, orderId, order.server_id, {'), 'refund database writes are not transactional, exact-server bound, and decision-aware');
  assert(service.includes("server_id = $2 AND status IN ('completed', 'expired') FOR UPDATE"), 'refund does not lock and exclusively claim the eligible exact-server order');
  assert(!service.includes('Refund file removal failed (continuing)'), 'refund credits currency after server-file cleanup fails');
}

function testShopCheckoutLocksOrderAndBalances() {
  const service = read('services/shopFileService.js');

  assert(service.includes('status = $3 FOR UPDATE'), 'checkout does not exclusively claim the open cart');
  assert(service.includes('SELECT cash_on_hand FROM player_wallets WHERE identity_id = $1 AND server_id = $2 FOR UPDATE'), 'checkout does not lock the exact-server wallet balance');
  assert(service.includes('SELECT balance FROM player_bank_accounts WHERE identity_id = $1 AND server_id = $2 FOR UPDATE'), 'checkout does not lock the exact-server bank balance');
}

function testCartMutationsLockTheOpenOrder() {
  const route = read('routes/shop.js');

  assert(route.includes('async function addCartItem(db, body)'), 'cart add is not encapsulated in a transaction-safe operation');
  assert(route.includes('async function updateCartItem(db, cartItemId, body)'), 'cart update is not encapsulated in a transaction-safe operation');
  assert(route.includes('async function deleteCartItem(db, cartItemId)'), 'cart delete is not encapsulated in a transaction-safe operation');
  assert(route.includes("status = 'cart' FOR UPDATE"), 'cart mutation does not lock and revalidate the open order');
  assert(route.includes('db.transaction(async transactionDb => {'), 'cart mutations are not transactional');
  assert(route.includes('return addCartItem(transactionDb, {'), 'cart add is not transactional');
  assert(route.includes('identityId,\n        serverId,'), 'cart add does not replace client identifiers with canonical authorization context');
  assert(route.includes('return updateCartItem(transactionDb, cartItemId, req.body)'), 'cart update is not transactional');
  assert(route.includes('return deleteCartItem(transactionDb, cartItemId)'), 'cart delete is not transactional');
  assert(route.includes('assertIdentityOwnerForMutation('), 'cart mutation authorization is not transaction-bound');
  const identityAuthority = route.slice(
    route.indexOf('async function assertIdentityOwnerForMutation'),
    route.indexOf('async function addCartItem')
  );
  const tenantLock = identityAuthority.indexOf('lockActiveServerTenant');
  const ownershipLock = identityAuthority.indexOf('FOR UPDATE OF la');
  const membershipLock = identityAuthority.indexOf('FOR UPDATE OF spm');
  assert(tenantLock >= 0 && ownershipLock > tenantLock && membershipLock > ownershipLock,
    'cart mutation must lock tenant, ownership proof, then exact membership');

  const checkout = read('services/shopFileService.js');
  const checkoutAuthority = checkout.slice(
    checkout.indexOf('async function assertCheckoutAuthority'),
    checkout.indexOf('/**\n * Process a player')
  );
  const checkoutFinancialLock = checkoutAuthority.indexOf('lockTrustedFinancialIdentity');
  assert(checkoutFinancialLock >= 0 && !checkoutAuthority.includes('FOR UPDATE OF g, s'),
    'checkout must delegate the advisory-parent-proof-membership hierarchy to the centralized financial lock');
}

function testPlayerLinkMutationsUseSharedParentFirstLockOrder() {
  const website = read('routes/accountLinking.js');
  const botLink = read('bot/commands/link.js');
  const botUnlink = read('bot/commands/unlink.js');
  const roleManagement = read('routes/roleManagement.js');
  const access = read('routes/access.js');

  assert(website.includes("const { lockUserRoleMutations } = require('../utils/roleMutationLocks');"),
    'website link mutations must share the user-deletion advisory lock');
  assert.equal((website.match(/await lockUserRoleMutations\(transactionDb, \[req\.user\.id\]\);/g) || []).length, 4,
    'every website link/unlink transaction must lock the user before tenant and identity rows');
  assert(website.indexOf('await lockUserRoleMutations(transactionDb, [req.user.id]);') <
    website.indexOf('await lockActiveLinkTenant(transactionDb, account.server_id, account.guild_id);'),
  'website link mutation must acquire the user advisory lock before its tenant parent');
  assert.equal((website.match(/await lockActiveLinkTenant\(transactionDb, account\.server_id, account\.guild_id\);/g) || []).length, 4,
    'every website link/unlink transaction must lock its exact tenant parent first');
  assert(botLink.includes("const { lockPgUserRoleMutations } = require('../../utils/roleMutationLocks');"),
    'bot link must share the user-deletion advisory lock');
  assert(botLink.indexOf('await lockPgUserRoleMutations(client, [userId]);') <
    botLink.indexOf('await lockActiveLinkTenant(client, account.server_id, account.guild_id);'),
  'bot link must acquire the user advisory lock before its tenant parent');
  assert(botLink.includes('await lockActiveLinkTenant(client, account.server_id, account.guild_id);'),
    'bot link must lock its exact tenant parent before ownership proof');
  assert(botUnlink.includes("const { lockPgUserRoleMutations } = require('../../utils/roleMutationLocks');"),
    'bot unlink must share the user-deletion advisory lock');
  assert(botUnlink.indexOf('await lockPgUserRoleMutations(client, [user.id]);') <
    botUnlink.indexOf('await lockActiveLinkTenant(client, serverId, interaction.guild.id);'),
  'bot unlink must acquire the user advisory lock before its tenant parent');
  assert(botUnlink.includes('await lockActiveLinkTenant(client, serverId, interaction.guild.id);'),
    'bot unlink must lock its exact tenant parent before membership mutation');
  assert(roleManagement.includes("FROM linked_accounts la") && roleManagement.includes('FOR UPDATE OF la'),
    'player role grants must lock ownership proof before membership upsert');

  const accessGrant = access.slice(
    access.indexOf("router.post('/servers/:serverId/roles'"),
    access.indexOf("router.delete('/servers/:serverId/roles/:assignmentId'")
  );
  const accessRevoke = access.slice(
    access.indexOf("router.delete('/servers/:serverId/roles/:assignmentId'"),
    access.indexOf('module.exports = router')
  );
  for (const [name, mutation] of [['grant', accessGrant], ['revoke', accessRevoke]]) {
    const userLock = mutation.indexOf('await lockUserRoleMutations(');
    const tenantLock = mutation.indexOf('await lockActiveServerTenant(');
    const authorityLock = mutation.indexOf('await hasLockedServerManageAuthority(');
    assert(userLock >= 0 && tenantLock > userLock && authorityLock > tenantLock,
      `access server-role ${name} must lock users, tenant parent, then actor authority`);
  }
  assert(accessGrant.indexOf('FOR UPDATE OF u, gr') >
    accessGrant.indexOf('await hasLockedServerManageAuthority('),
  'access server-role grant must revalidate and lock target guild eligibility after actor authority');
  assert(accessRevoke.indexOf('FOR UPDATE') >
    accessRevoke.indexOf('await hasLockedServerManageAuthority('),
  'access server-role revocation must lock and reread the exact assignment after actor authority');
}

function testRestartEventIsClaimedExactlyOnce() {
  const restartService = read('services/shopRestartService.js');
  const route = read('routes/shop.js');

  assert(/ON CONFLICT \(bios_session_id\) DO NOTHING\s+RETURNING id/.test(restartService), 'restart processing does not atomically claim a BIOS session');
  assert(restartService.includes('if (!inserted) return'), 'restart processing continues after losing the BIOS-session claim');
  assert(restartService.includes('FOR UPDATE SKIP LOCKED'), 'owner restart marker selection is not exclusive');
  assert(restartService.includes('WHERE id = ?'), 'owner restart consumption updates more than the selected marker');
  assert(restartService.includes('AND NOT EXISTS'), 'duplicate pending owner-restart markers can be created');
  assert(route.includes('await shopRestartService.recordOwnerRestart(transactionDb, serverId);'), 'owner restart markers are not serialized transactionally');
  assert(route.includes('assertServerOwnerForMutation('), 'owner restart authorization is not transaction-bound');
}

function testShopExpiryFailsClosedWhenCleanupFails() {
  const fileService = read('services/shopFileService.js');
  const restartService = read('services/shopRestartService.js');

  assert(!restartService.includes('Failed to remove expired rental file entries for server'), 'restart expiry swallows failed server-file cleanup');
  assert(!fileService.includes("console.error('❌ Failed to remove cfgEffectArea entries:'"), 'cfgEffectArea cleanup failures are swallowed');
  assert(!fileService.includes("console.error('❌ Failed to remove custom JSON entries:'"), 'custom JSON cleanup failures are swallowed');
  assert(!fileService.includes("console.error('❌ Failed to remove event spawn entries:'"), 'event cleanup failures are swallowed');
}

function testShopSupportsExplicitEffectAreaProvisioning() {
  const adminPage = read('public/dashboard/shop-admin.html');
  const adminClient = read('public/js/shop-admin.js');
  const routes = read('routes/shop.js');

  assert(adminPage.includes('<option value="cfgEffectArea">cfgEffectArea (compatibility placement)</option>'),
    'shop admin cannot select cfgEffectArea provisioning');
  assert(adminPage.includes('cfgEffectArea accepts ordinary DayZ and mod class names'),
    'shop admin does not explain cfgEffectArea compatibility behavior');
  assert(adminPage.includes('can crash or prevent the server from starting'),
    'shop admin does not warn about incompatible cfgEffectArea classes');
  assert(!adminPage.includes('<option value="coords">'), 'shop admin exposes unimplemented coordinates-only spawning');
  assert(!adminPage.includes('<option value="preset">'), 'shop admin exposes unimplemented preset-only spawning');
  assert(adminClient.includes("value = 'event'"), 'shop admin does not default new items to event provisioning');
  assert(adminPage.includes('id="ec-position"'), 'shop admin cannot configure the CE event position mode');
  assert(adminPage.includes('id="ec-active"'), 'shop admin cannot configure CE event activation');
  assert(adminPage.includes('id="ec-children-json"'), 'shop admin cannot compose multiple CE event children');
  assert(adminPage.includes('id="ec-event-group-json"'), 'shop admin cannot configure event-group child offsets');
  assert(adminPage.includes('spawnsecondary') && adminPage.includes("event's &lt;secondary&gt;"), 'shop admin does not explain event-group secondary event invocation');
  assert(/id="ec-effect-components-json"[^>]*disabled/.test(adminPage), 'shop admin still accepts unsafe companion cfgEffectArea entries');
  assert(adminPage.includes('cfgEffectArea entries are disabled'), 'shop admin does not explain why companion EffectArea provisioning is disabled');
  assert(adminPage.includes('<option value="custom_json">Object Spawner</option>'), 'shop admin does not expose first-class Object Spawner products');
  assert(adminPage.includes('id="object-spawner-config"') && adminPage.includes('id="object-spawner-scale"'), 'shop admin omits Object Spawner configuration controls');
  assert(adminPage.includes('id="ec-object-components-json"') && adminPage.includes('Object Spawner components are temporarily disabled'), 'CE event composition must not imply companion Object Spawner lifecycle support');
  assert(adminPage.includes('cfgenvironment.xml') && adminPage.includes('territory'), 'shop admin omits environment and territory scope guidance');
  assert(adminPage.includes('must begin with a DayZ CE spawner type'), 'shop admin omits the CE event-name prefix requirement');
  assert(!adminPage.includes('<option value="Animal">'), 'shop admin advertises animal events without territory provisioning');
  assert(adminClient.includes('children:') && adminClient.includes('ec-children-json'), 'shop admin does not serialize composed CE event children');
  assert(routes.includes('validateProvisioningItem'), 'shop admin routes persist unprovisionable catalog configurations');
  assert(routes.includes('const purchasableItems = items.filter(isCatalogItemPurchasable);'), 'player catalog exposes unsupported legacy provisioning methods');
  assert(routes.includes('if (!item.is_active && !isCatalogItemPurchasable(item))'), 'single-item toggle can reactivate unsupported legacy provisioning');
  assert(routes.includes("if (action === 'activate' && items.some(item => !isCatalogItemPurchasable(item)))"), 'bulk action can reactivate unsupported legacy provisioning');
  const addCartStart = routes.indexOf('async function addCartItem');
  const addCartEnd = routes.indexOf('/**', addCartStart);
  const addCartSource = routes.slice(addCartStart, addCartEnd);
  const cartGuardIndex = addCartSource.indexOf('isCatalogItemPurchasable(shopItem)');
  const cartInsertIndex = addCartSource.indexOf("INSERT INTO shop_order_items");
  assert(cartGuardIndex >= 0 && cartInsertIndex >= 0 && cartGuardIndex < cartInsertIndex,
    'cart creation snapshots unsupported provisioning before rejecting it');
}

function testShopDeletionArchivesCatalogEntriesWithoutBreakingOrderHistory() {
  const migration = read('db/migrations/063_archive_shop_items.js');
  const routes = read('routes/shop.js');
  const adminClient = read('public/js/shop-admin.js');
  const deleteStart = routes.indexOf("router.delete('/admin/items/:itemId'");
  const deleteEnd = routes.indexOf("router.get('/admin/items/:itemId/presets'", deleteStart);
  const deleteRoute = routes.slice(deleteStart, deleteEnd);

  assert(migration.includes('ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ'), 'shop items have no distinct archival state');
  assert(routes.includes('WHERE si.server_id = ? AND si.deleted_at IS NULL'), 'shop admin list still returns deleted catalog entries');
  assert(deleteRoute.includes('SET is_active = false, deleted_at = CURRENT_TIMESTAMP'), 'shop deletion still behaves like deactivation');
  assert(!deleteRoute.includes('DELETE FROM shop_items'), 'shop deletion destroys order-history references');
  assert(deleteRoute.includes('server_id = ? AND deleted_at IS NULL'), 'shop deletion is not bound to the authorized exact server');
  assert(adminClient.includes('Order history will be preserved.'), 'shop delete confirmation does not explain archival semantics');
}

function testShopAllowsRepeatCompletedOrders() {
  const migration = read('db/migrations/048_fix_shop_order_uniqueness.js');

  assert(migration.includes('DROP CONSTRAINT IF EXISTS shop_orders_identity_id_server_id_status_key'), 'shop order migration does not remove the all-status uniqueness constraint');
  assert(migration.includes("WHERE status = 'cart'"), 'shop order migration does not preserve one active cart per player and server');
  assert(migration.includes('Migration 048 is irreversible'), 'shop order migration exposes an unsafe down migration after repeat orders exist');
}

function testRestartXmlUsesFtpFallback() {
  const source = read('bot/services/serverStatusService.js');

  assert(source.includes('downloadNitradoFileViaFtp'), 'restart XML download has no FTP fallback');
  assert(source.includes('toNitradoFtpPath(filePath)'), 'FTP fallback does not convert the Nitrado API path');
  assert.strictEqual(
    (source.match(/downloadNitradoFile\(token, platformServerId, [^,]+, ftpCreds\)/g) || []).length,
    2,
    'cfgeconomycore.xml and messages.xml downloads must receive FTP credentials'
  );
}

function testAdminDashboardDisplaysBotHeartbeat() {
  const migration = read('db/migrations/046_add_bot_health.js');
  const ready = read('bot/events/ready.js');
  const adminRoute = read('routes/admin.js');
  const adminClient = read('public/js/admin-index.js');
  const routeRegistration = read('src/app/registerRoutes.js');
  const botHealthService = read('bot/services/botHealthService.js');

  assert(migration.includes('CREATE TABLE IF NOT EXISTS bot_health'), 'bot health migration is missing');
  assert(ready.includes('startBotHealthHeartbeat(client)'), 'bot does not start its health heartbeat');
  assert(adminRoute.includes('FROM bot_health'), 'admin health API does not read the bot heartbeat');
  assert(adminRoute.includes('bot: checks.bot'), 'admin health API does not return bot health');
  assert(adminClient.includes('checks.bot'), 'admin dashboard does not render bot health');
  assert.match(routeRegistration,
    /app\.get\('\/readyz'[\s\S]*minimumBotStartedAt[\s\S]*SELECT[\s\S]*FROM bot_health[\s\S]*last_heartbeat/,
    'public readiness must fail closed on database access and require a fresh bot heartbeat');
  assert.match(ready, /await startBotHealthHeartbeat\(client\)[\s\S]*Bot initialization complete/,
    'bot initialization must await its first durable heartbeat before declaring readiness');
  assert.match(botHealthService,
    /async function startBotHealthHeartbeat[\s\S]*await writeBotHeartbeat\(client, startedAt\)/,
    'bot health startup must fail closed if its first heartbeat cannot be persisted');
}

function testPostgresCleanupKeepsSafetyRails() {
  const gitignore = read('.gitignore');
  const setup = read('scripts/setup-debian.sh');
  const installer = read('scripts/install-wizard.js');
  const compose = read('docker-compose.yml');
  const parserCoverage = read('tools/check_parser_coverage.sh');
  const botDb = read('bot/db.js');
  const smoke = read('scripts/db-smoke-test.js');
  const economy = read('routes/economy.js');
  const migrationGuide = read('docs/MIGRATION.md');
  const envExample = read('.env.example');
  const schema = read('db/schema.js');
  const legacyMigration = read('db/migrations/004_complete_redesign.js');

  assert(gitignore.includes('db/*.sqlite'), 'legacy SQLite data files are no longer ignored');
  assert(
    setup.indexOf('node scripts/db-smoke-test.js') < setup.indexOf('node scripts/set-admin.js'),
    'Debian setup does not initialize the schema before creating an admin'
  );
  assert(!migrationGuide.includes('node scripts/run-migration-004.js'), 'docs still recommend the unsafe legacy migration');
  assert(
    schema.indexOf('checkForOldSchema(db)') < schema.indexOf('db.getSchemaVersion()'),
    'schema initialization writes schema-version metadata before checking for legacy tables'
  );
  assert(!legacyMigration.includes('db.getSchemaVersion()'), 'legacy migration writes schema-version metadata before refusing to run');
  assert(!envExample.includes('POSTGRES_PASSWORD=dayz-dashboard'), 'example environment uses a predictable database password');
  assert(!installer.includes("POSTGRES_PASSWORD [dayz-dashboard]"), 'install wizard advertises a predictable database password');
  assert(
    !/cfg\.POSTGRES_PASSWORD\s*=.*\|\|\s*['"]dayz-dashboard['"]/.test(installer),
    'install wizard writes a predictable database password'
  );
  assert(!compose.includes('POSTGRES_PASSWORD:-dayz-dashboard'), 'Docker Compose uses a predictable database password fallback');
  assert(!parserCoverage.includes('POSTGRES_PASSWORD:-dayz-dashboard'), 'parser coverage tool uses a predictable database password fallback');
  assert(!parserCoverage.includes('bash -lc "PGPASSWORD=${PGPASS}'), 'parser coverage tool interpolates the database password into a shell command');
  assert(!botDb.includes("POSTGRES_PASSWORD || 'dayz-dashboard'"), 'bot database uses a predictable password fallback');
  assert(!smoke.includes("POSTGRES_PASSWORD || 'dayz-dashboard'"), 'database smoke test uses a predictable password fallback');
  assert(!botDb.includes('{ rejectUnauthorized: false }'), 'bot disables PostgreSQL certificate verification by default');
  assert(!read('db/abstraction/postgres.js').includes('{ rejectUnauthorized: false }'), 'backend disables PostgreSQL certificate verification by default');
  assert(!economy.includes('detail: error.message'), 'economy API exposes raw database errors');
}

function testPostgresCreateRoutesReturnInsertedRows() {
  const shop = read('routes/shop.js');
  const factions = read('routes/factions.js');

  assert(!shop.includes('last_insert_rowid()'), 'shop preset creation still uses SQLite row IDs');
  assert(!factions.includes('last_insert_rowid()'), 'faction marker creation still uses SQLite row IDs');
  assert(shop.includes('RETURNING *'), 'shop preset insert does not return its PostgreSQL row');
  assert(factions.includes('RETURNING *'), 'faction marker insert does not return its PostgreSQL row');
}

function testSelfHostedRuntimeModesAndPublicUrls() {
  const compose = read('docker-compose.yml');
  const localCompose = read('docker-compose.local.yml');
  const botService = compose.slice(compose.indexOf('\n  bot:'), compose.indexOf('\n  tui:'));
  const tuiService = compose.slice(compose.indexOf('\n  tui:'), compose.indexOf('\nvolumes:'));
  const botDockerfile = read('Dockerfile.bot');
  const botEntry = read('bot/index.js');
  const envExample = read('.env.example');
  const localEnvExample = read('.env.local.example');
  const packageJson = JSON.parse(read('package.json'));
  const botPackageJson = JSON.parse(read('bot/package.json'));
  const sharedShopFileService = read('services/shopFileService.js');
  const linkCommand = read('bot/commands/link.js');
  const registerCommand = read('bot/commands/register-token.js');
  const dashboardClient = read('public/js/dashboard.js');
  const instanceConfigClient = read('public/js/instance-config.js');
  const landingPage = read('public/index.html');
  const nginx = read('nginx.conf');
  const pm2Config = read('ecosystem.config.js');

  assert(compose.includes('\n  db-init:'), 'compose does not provide a one-shot database initializer');
  assert(botService.includes('db-init:'), 'bot does not wait for database initialization');
  assert(!botService.includes('backend:'), 'bot-only mode still depends on the website backend');
  assert(tuiService.includes('profiles:'), 'admin TUI is part of the default Compose service set');
  assert(tuiService.includes('- tools'), 'admin TUI does not use the opt-in tools Compose profile');
  assert(tuiService.includes('db-init:'), 'admin TUI does not wait for database initialization');
  const testSegments = packageJson.scripts.test.split('&&').map(segment => segment.trim());
  assert(!testSegments.includes('node'), 'canonical test command contains a bare node no-op');
  assert(botDockerfile.includes('COPY db/ ../db/'), 'bot image cannot verify or initialize its database schema');
  assert(botDockerfile.includes('COPY services/ ../services/'), 'bot image omits shared services required by bot commands');
  assert(
    !sharedShopFileService.includes("require('fast-xml-parser')") || botPackageJson.dependencies?.['fast-xml-parser'],
    'bot production dependencies omit fast-xml-parser required by copied shared services'
  );
  assert(botEntry.includes('await initializeDatabase()'), 'bot startup does not verify or initialize its database schema');
  assert(envExample.includes('DEPLOYMENT_MODE=full'), 'example environment does not document the deployment mode');
  assert(envExample.includes('DASHBOARD_URL=https://dashboard.example.com'), 'dashboard URL is not configurable');
  assert(envExample.includes('PLAYER_PORTAL_URL=https://player.example.com'), 'player portal URL is not configurable');
  assert(!linkCommand.includes('saltskrew.xyz'), 'link command contains a deployment-specific domain');
  assert(!registerCommand.includes('saltskrew.xyz'), 'register command contains a deployment-specific domain');
  assert(!dashboardClient.includes('player.saltskrew.xyz'), 'dashboard contains a deployment-specific player URL');
  assert(instanceConfigClient.includes("fetch('/api/public-config')"), 'frontend does not load public instance configuration');
  assert(landingPage.includes('/js/instance-config.js'), 'landing page does not apply configurable instance branding');
  assert(!nginx.toLowerCase().includes('saltskrew'), 'nginx example contains deployment-specific hostnames or certificate names');
  assert(pm2Config.includes('DEPLOYMENT_MODE'), 'PM2 configuration cannot select bot-only mode');
  assert(localCompose.includes('127.0.0.1:${LOCAL_DASHBOARD_PORT:-3000}:3000'), 'local dashboard is not bound to loopback');
  assert(localCompose.includes('local-postgres-data'), 'local mode does not isolate its database volume');
  assert(localCompose.includes('DEPLOYMENT_MODE: local'), 'local compose does not select local application behavior');
  assert(localEnvExample.includes('DASHBOARD_URL=http://localhost:3000'), 'local OAuth origin is not documented');
  assert.strictEqual(packageJson.scripts['local:setup'], 'node scripts/local-setup.js');
  assert(packageJson.scripts['local:up'].includes('-p dayz-dashboard-local'), 'local runtime does not use an isolated Compose project');

  const {
    getPublicConfig,
    isPlayerPortalBaseUrl,
    isPlayerPortalHost,
    selectRequestBaseUrl
  } = require('../utils/publicConfig');
  const config = getPublicConfig({
    DEPLOYMENT_MODE: 'full',
    APP_NAME: 'Example Community',
    DASHBOARD_URL: 'https://dashboard.example.com/',
    PLAYER_PORTAL_URL: 'https://player.example.com/'
  });
  assert.strictEqual(config.dashboardUrl, 'https://dashboard.example.com');
  assert.strictEqual(config.playerPortalUrl, 'https://player.example.com');
  assert.strictEqual(selectRequestBaseUrl('player.example.com', config), 'https://player.example.com');
  assert.strictEqual(selectRequestBaseUrl('attacker.example', config), 'https://dashboard.example.com');
  assert.strictEqual(isPlayerPortalHost('player.example.com', config), true);
  assert.strictEqual(isPlayerPortalBaseUrl('https://player.example.com', config), true);

  const sameOriginConfig = getPublicConfig({
    DEPLOYMENT_MODE: 'full',
    DASHBOARD_URL: 'https://dashboard.example.com'
  });
  assert.strictEqual(isPlayerPortalHost('dashboard.example.com', sameOriginConfig), false, 'same-origin deployment hides the admin dashboard');
  assert.strictEqual(isPlayerPortalBaseUrl('https://dashboard.example.com', sameOriginConfig), false, 'same-origin OAuth incorrectly redirects admins to the player portal');

  const localConfig = getPublicConfig({
    NODE_ENV: 'development',
    DEPLOYMENT_MODE: 'local',
    DASHBOARD_URL: 'http://localhost:3000',
    PLAYER_PORTAL_URL: 'http://localhost:3000'
  });
  assert.strictEqual(localConfig.websiteEnabled, true);
  assert.strictEqual(localConfig.deploymentMode, 'local');
  assert.throws(
    () => getPublicConfig({ DEPLOYMENT_MODE: 'local', DASHBOARD_URL: 'https://dashboard.example.com' }),
    /must use HTTP on localhost/,
    'local mode accepts a non-local public origin'
  );
  assert.throws(
    () => getPublicConfig({
      NODE_ENV: 'production',
      DEPLOYMENT_MODE: 'full',
      DASHBOARD_URL: 'https://dashboard.example.com/subpath'
    }),
    /origin without a path/,
    'dashboard URL incorrectly accepts a path even though routes are mounted at the origin root'
  );
}

function testEconomyStatsRejectsStaleServerResponses() {
  const source = read('public/js/admin/economy-settings.js');
  const stats = source.slice(source.indexOf('async function loadStats'),
    source.indexOf('// ── Populate form fields'));
  assert.match(stats, /const requestedServerId = serverId/,
    'stats request must bind an immutable internal server ID');
  assert.match(stats, /const requestId = \+\+statsRequestGeneration/,
    'stats requests need a monotonic per-family request ID');
  assert.match(stats, /configurationGeneration[\s\S]*currentServerId[\s\S]*statsRequestGeneration/,
    'stats currentness must bind configuration generation, selected server, and request ID');
  assert.match(stats, /if \(!isCurrent\(\)\) return;[\s\S]*catch[\s\S]*if \(!isCurrent\(\)\) return;[\s\S]*finally[\s\S]*if \(isCurrent\(\)\)/,
    'stale success, error, and finally continuations must all be suppressed');
}

function testEconomyConflictRequiresSuccessfulReloadBeforeControlsEnable() {
  const source = read('public/js/admin/economy-settings.js');
  const save = source.slice(source.indexOf('async function saveConfiguration'),
    source.indexOf('// ── Reset form'));
  assert.match(save, /res\.status === 409[\s\S]*loadedServerId = null[\s\S]*loadConfiguration/,
    'CAS conflict must invalidate the loaded version and attempt a reload');
  assert.match(save, /reloadSucceeded[\s\S]*saveBtn\.disabled = !reloadSucceeded/,
    'save controls must remain disabled until conflict reload succeeds');
}

function testProductionReleaseGuardrails() {
  const ci = read('.github/workflows/ci.yml');
  const compose = read('docker-compose.yml');
  const dockerfile = read('Dockerfile');
  const botDockerfile = read('Dockerfile.bot');
  const envValidator = read('utils/envValidator.js');
  const middleware = read('src/app/registerMiddleware.js');
  const postgresAdapter = read('db/abstraction/postgres.js');
  const botDatabase = read('bot/db.js');
  const setup = read('scripts/setup-debian.sh');
  const packageJson = JSON.parse(read('package.json'));

  assert.match(ci, /node-version:\s*22\b/, 'CI must use the supported production Node major');
  assert.doesNotMatch(ci, /npm audit[^\n]*\|\| true/, 'CI must not discard dependency-audit failures');
  assert.match(ci, /npm run security:audit/, 'CI must execute the repository secret scanner');
  assert.match(ci, /node --check scripts\/release-ready-checks\.js/, 'CI must syntax-check the public release-check entry point');
  assert.doesNotMatch(compose, /["']?5432:5432["']?/, 'production Compose must not publish PostgreSQL');
  assert.match(dockerfile, /^FROM node:22/m);
  assert(
    dockerfile.indexOf('COPY . .') < dockerfile.indexOf('RUN npm run build:css'),
    'backend image must generate CSS after the final broad source copy'
  );
  assert.match(botDockerfile, /^FROM node:22/m);
  assert.strictEqual(packageJson.engines?.node, '>=22 <23');
  assert.match(middleware, /new DiscordStrategy\(\{[\s\S]*state:\s*true/,
    'Discord OAuth must bind callbacks to a session-backed state value');
  for (const [name, source] of [['backend', postgresAdapter], ['bot', botDatabase]]) {
    for (const timeout of ['connectionTimeoutMillis', 'query_timeout', 'statement_timeout', 'idle_in_transaction_session_timeout']) {
      assert.match(source, new RegExp(`${timeout}:\\s*[1-9]\\d*`), `${name} database pool must set finite ${timeout}`);
    }
    const idleTimeout = Number(source.match(/idle_in_transaction_session_timeout:\s*(\d+)/)?.[1]);
    assert(idleTimeout >= 900000,
      `${name} idle transaction timeout must allow bounded multi-file provider compensation workflows`);
  }
  assert.match(envValidator, /NODE_ENV === 'production'[\s\S]*SESSION_SECURE_COOKIE !== 'true'/,
    'production validation must reject insecure session cookies');
  assert.match(envValidator, /NODE_ENV === 'production'[\s\S]*RATE_LIMIT_ENABLED !== 'true'/,
    'production validation must reject disabled rate limiting');
  assert.match(setup, /SESSION_SECURE_COOKIE=true/,
    'production setup must not generate insecure-cookie configuration');
}

function testDevcontainerResolvesWithoutUntrackedEnvironment() {
  const config = JSON.parse(read('.devcontainer/devcontainer.json'));
  assert.strictEqual(config.dockerComposeFile, 'docker-compose.yml',
    'devcontainer uses the production Compose file that requires an untracked .env');
  assert.strictEqual(config.service, 'workspace');
  assert.strictEqual(config.workspaceFolder, '/workspace');

  const compose = read('.devcontainer/docker-compose.yml');
  assert(compose.includes('\n  workspace:'), 'devcontainer Compose file has no workspace service');
  assert(!compose.includes('env_file:'), 'devcontainer Compose file requires an untracked environment file');
  assert(!compose.includes('POSTGRES_PASSWORD'), 'devcontainer Compose file embeds or requires a database password');
}

function testDocReviewFailsClosedOnInvalidRefsAndAcceptsRepositoryPatterns() {
  const invalidResult = spawnSync(process.execPath, ['scripts/doc-review.js'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      DOC_REVIEW_BASE_SHA: 'missing-base-ref-for-regression',
      DOC_REVIEW_HEAD_SHA: 'missing-head-ref-for-regression'
    }
  });
  assert.notStrictEqual(invalidResult.status, 0, 'documentation review silently passes when Git refs cannot be resolved');
  assert(!`${invalidResult.stdout || ''}${invalidResult.stderr || ''}`.includes('No changed files detected.'),
    'documentation review reports invalid refs as an empty diff');

  const workflow = read('.github/workflows/doc-review.yml');
  assert(workflow.includes('github.event.pull_request.base.sha'), 'documentation workflow does not pass the immutable base SHA');
  assert(workflow.includes('github.event.pull_request.head.sha'), 'documentation workflow does not pass the immutable head SHA');

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'salt-doc-review-'));
  const git = args => spawnSync('git', args, { cwd: fixtureRoot, encoding: 'utf8' });
  try {
    fs.mkdirSync(path.join(fixtureRoot, 'scripts'));
    fs.writeFileSync(path.join(fixtureRoot, 'README.md'), '# Baseline\n');
    assert.strictEqual(git(['init', '-q']).status, 0);
    assert.strictEqual(git(['config', 'user.email', 'test@example.invalid']).status, 0);
    assert.strictEqual(git(['config', 'user.name', 'Regression Test']).status, 0);
    assert.strictEqual(git(['add', '.']).status, 0);
    assert.strictEqual(git(['commit', '-qm', 'baseline']).status, 0);
    const baseSha = git(['rev-parse', 'HEAD']).stdout.trim();

    fs.copyFileSync(path.join(root, 'scripts', 'doc-review.js'), path.join(fixtureRoot, 'scripts', 'doc-review.js'));
    fs.writeFileSync(path.join(fixtureRoot, '.env.example'), [
      'DISCORD_CLIENT_ID=your_discord_client_id',
      'DISCORD_CLIENT_SECRET=your_discord_client_secret',
      'SESSION_SECRET=your_random_secret_here',
      'ENCRYPTION_KEY=your_encryption_key_here',
      ''
    ].join('\n'));
    fs.writeFileSync(path.join(fixtureRoot, 'scripts', 'tool.js'),
      "const { execFileSync } = require('child_process');\nconst env = process.env;\nmodule.exports = { execFileSync, env };\n");
    assert.strictEqual(git(['add', '.']).status, 0);
    assert.strictEqual(git(['commit', '-qm', 'candidate']).status, 0);
    const headSha = git(['rev-parse', 'HEAD']).stdout.trim();
    const positiveResult = spawnSync(process.execPath, ['scripts/doc-review.js'], {
      cwd: fixtureRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_ACTIONS: 'true',
        DOC_REVIEW_BASE_SHA: baseSha,
        DOC_REVIEW_HEAD_SHA: headSha
      }
    });
    assert.strictEqual(positiveResult.status, 0,
      `documentation review rejects legitimate repository patterns:\n${positiveResult.stdout}${positiveResult.stderr}`);

    fs.writeFileSync(path.join(fixtureRoot, '.env'), 'PRIVATE_VALUE=fixture-only\n');
    assert.strictEqual(git(['add', '.env']).status, 0);
    assert.strictEqual(git(['commit', '-qm', 'unsafe environment file']).status, 0);
    const unsafeSha = git(['rev-parse', 'HEAD']).stdout.trim();
    const unsafeResult = spawnSync(process.execPath, ['scripts/doc-review.js'], {
      cwd: fixtureRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_ACTIONS: 'true',
        DOC_REVIEW_BASE_SHA: headSha,
        DOC_REVIEW_HEAD_SHA: unsafeSha
      }
    });
    assert.notStrictEqual(unsafeResult.status, 0, 'documentation review accepts a committed private environment file');
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function testPublicFixturesUseSyntheticIdentifiers() {
  const numericDomainFixtures = new Map([
    ['scripts/exact-money-test.js', new Set(['99999999999999999999'])],
    ['scripts/casino-atomic-settlement-test.js', new Set(['9223372036854775808'])],
    ['scripts/teleport-shop-checkout-test.js', new Set(['999999999999999999'])]
  ]);
  const fixtureFiles = fs.readdirSync(path.join(root, 'scripts'))
    .filter(file => file.endsWith('-test.js') && file !== 'dashboard-regression-test.js')
    .map(file => `scripts/${file}`);
  const fixtureIdentifierPattern = /(?<!\d)\d{17,20}(?!\d)/g;
  assert.deepStrictEqual(
    [...'const leakedFixture = 123456789012345678n;'.matchAll(fixtureIdentifierPattern)].map(match => match[0]),
    ['123456789012345678'],
    'fixture identifier scanner misses JavaScript BigInt literals'
  );
  let identifierCount = 0;

  for (const file of fixtureFiles) {
    const snowflakeLikeValues = [...read(file).matchAll(fixtureIdentifierPattern)].map(match => match[0]);
    for (const value of snowflakeLikeValues) {
      if (numericDomainFixtures.get(file)?.has(value)) continue;
      identifierCount++;
      assert(/^9000000000000000\d{2}$/.test(value),
        `${file} includes a fixture identifier outside the reserved synthetic range`);
    }
  }

  assert(identifierCount > 0, 'public Discord fixtures contain no identifiers to validate');
  assert(read('scripts/admin-rbac-route-test.js').includes('Synthetic Test Guild'),
    'public fixture does not use a synthetic community name');
}

function testCredentialFallbacksAreNotShipped() {
  const envValidator = read('utils/envValidator.js');
  const casino = read('routes/casino.js');
  const provisionerPath = path.join(root, 'scripts', 'provision_hermes.sh');
  const securityAudit = read('scripts/security-audit.js');
  const packageJson = JSON.parse(read('package.json'));

  assert(!envValidator.includes("process.env.POSTGRES_PASSWORD = 'dayz-dashboard'"), 'environment validator ships a predictable database password');
  assert(!casino.includes('dev-fallback'), 'casino signing uses a hardcoded fallback secret');
  assert(!fs.existsSync(provisionerPath), 'public repository includes privileged host provisioning');
  assert(securityAudit.includes("'--others'"), 'secret audit skips untracked, non-ignored source files before commit');
  assert.strictEqual(packageJson.scripts['security:audit'], 'node scripts/security-audit.js', 'repository has no repeatable tracked-secret audit');

  const fixturePath = path.join(root, 'security-audit-regression.env');
  const fixtureSecret = 'scanner-regression-secret-49271';
  try {
    fs.writeFileSync(fixturePath, `POSTGRES_PASSWORD=${fixtureSecret}\n`);
    const result = spawnSync(process.execPath, ['scripts/security-audit.js'], {
      cwd: root,
      encoding: 'utf8'
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    assert.notStrictEqual(result.status, 0, 'secret audit misses unquoted environment credentials');
    assert(!output.includes(fixtureSecret), 'secret audit leaks a detected credential value');
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
}

testCasinoStatsUsesGamertagHistory();
testAdminReportsUsesDiscordReportSchema();
testSupportHubUsesRegisteredServersEndpoint();
testAuditApiMapsIdentifiersForFrontend();
testStaticAssetsResolve();
testDynamicFrontendValuesAreSafelyRendered();
testDashboardUsesCanonicalMissionEditorRoute();
testDashboardOnboardingUsesDiscordCommandOnly();
testShopItemsAlwaysPersistRentalRestartCount();
testShopUsesCurrentEconomyTransactionSchema();
testShopRestartUsesAdapterCompatiblePlaceholders();
testShopRentalCleanupOffsetsExclusionParameters();
testShopCheckoutRollsBackWhenServerFileUpdateFails();
testShopCheckoutFailsClosedWithoutProvisioningContext();
testShopCompensatesPartialExternalWrites();
testShopQuantitySemanticsAreUnambiguous();
testCheckoutLocksAndRevalidatesCatalogItems();
testShopSerializesRemoteMutationsPerServer();
testShopRefundIsAtomicAndClaimedOnce();
testShopCheckoutLocksOrderAndBalances();
testCartMutationsLockTheOpenOrder();
testPlayerLinkMutationsUseSharedParentFirstLockOrder();
testRestartEventIsClaimedExactlyOnce();
testShopExpiryFailsClosedWhenCleanupFails();
testShopSupportsExplicitEffectAreaProvisioning();
testShopDeletionArchivesCatalogEntriesWithoutBreakingOrderHistory();
testShopAllowsRepeatCompletedOrders();
testRestartXmlUsesFtpFallback();
testAdminDashboardDisplaysBotHeartbeat();
testPostgresCleanupKeepsSafetyRails();
testPostgresCreateRoutesReturnInsertedRows();
testSelfHostedRuntimeModesAndPublicUrls();
testEconomyStatsRejectsStaleServerResponses();
testEconomyConflictRequiresSuccessfulReloadBeforeControlsEnable();
testProductionReleaseGuardrails();
testDevcontainerResolvesWithoutUntrackedEnvironment();
testDocReviewFailsClosedOnInvalidRefsAndAcceptsRepositoryPatterns();
testPublicFixturesUseSyntheticIdentifiers();
testCredentialFallbacksAreNotShipped();
console.log('✅ Dashboard regression tests passed');
