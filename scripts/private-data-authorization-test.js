'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const compact = value => String(value).replace(/\s+/g, ' ');

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function finalHandler(router, routePath, method = 'get') {
  const layer = router.stack.find(entry => entry.route?.path === routePath && entry.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${routePath} must exist`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function testPlayerPortalParamAuthorizationAndConflicts() {
  const router = require('../routes/playerPortal');
  assert.ok(router.params.identity_id?.length, 'identity_id must be authorized after route matching');
  assert.ok(router.params.identityId?.length, 'identityId must be authorized after route matching');
  assert.ok(!router.stack.some(layer => !layer.route && layer.handle.name === 'requirePlayerServerMembership'),
    'router-wide membership cannot run before path params are populated');

  const identityGuard = router.params.identity_id[0];
  let dataRan = false;
  const req = {
    user: { id: 9 },
    params: { identity_id: '88' },
    query: { serverId: '22' },
    app: { locals: { db: {
      async get(sql, params) {
        const normalized = compact(sql);
        assert.ok(normalized.includes('spm.user_id = ? AND spm.server_id = ?'));
        assert.ok(normalized.includes('spm.identity_id = ?'));
        assert.ok(normalized.includes("s.status = 'active'"));
        assert.ok(normalized.includes("g.status = 'approved'"));
        assert.ok(normalized.includes('spm.source_link_id = la.id'));
        assert.deepStrictEqual(params, [9, 22, 88]);
        return null;
      },
      query: async () => { dataRan = true; return []; },
    } } },
  };
  const res = responseRecorder();
  let nextCalled = false;
  await identityGuard(req, res, () => { nextCalled = true; }, '88', 'identity_id');
  assert.strictEqual(res.statusCode, 403, 'same-server identity substitution must deny');
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(dataRan, false);

  const conflictReq = {
    user: { id: 9 },
    params: { identity_id: '77', server_id: '23' },
    query: { serverId: '22' },
    app: { locals: { db: { get: async () => { throw new Error('conflict must deny before DB'); } } } },
  };
  const conflictRes = responseRecorder();
  await identityGuard(conflictReq, conflictRes, () => {}, '77', 'identity_id');
  assert.strictEqual(conflictRes.statusCode, 400, 'query/path server mismatch must deny');
}

async function testPlayerSearchIsActiveExactServerScopedAndMinimal() {
  const source = fs.readFileSync(path.join(root, 'routes/playerPortal.js'), 'utf8');
  const start = source.indexOf("router.get('/search'");
  const end = source.indexOf('// Every endpoint below', start);
  const route = source.slice(start, end);
  const sql = compact(route);
  assert.ok(sql.includes("g.status = 'approved'"));
  assert.ok(sql.includes("s.status = 'active'"));
  assert.ok(sql.includes('s.id = ?'));
  assert.ok(sql.includes('s.guild_id = g.id'));
  assert.ok(sql.includes('spm.source_link_id = la.id'));
  assert.ok(sql.includes("spm.status = 'active'"));
  assert.doesNotMatch(route, /platform_user_id|linked_username|linkedUsername/,
    'search must not expose platform IDs or linked usernames');

  const discordPath = require.resolve('../utils/discordAPI');
  const portalPath = require.resolve('../routes/playerPortal');
  const originalDiscordModule = require.cache[discordPath];
  const originalPortalModule = require.cache[portalPath];
  require.cache[discordPath] = {
    id: discordPath,
    filename: discordPath,
    loaded: true,
    exports: {
      getUserGuilds: async () => [],
      verifyGuildMembership: async () => true,
    },
  };
  delete require.cache[portalPath];
  const searchRouter = require('../routes/playerPortal');
  const handler = finalHandler(searchRouter, '/search');

  let candidateQueryRan = false;
  const deniedReq = {
    user: { id: 9, access_token: ['discord', 'fixture'].join('-') },
    query: { guildId: 'guild-a', serverId: '22', gamertag: 'needle' },
    app: { locals: { db: {
      async get(sql, params) {
        assert.ok(compact(sql).includes("g.status = 'approved'"));
        assert.ok(compact(sql).includes("s.status = 'active'"));
        assert.deepStrictEqual(params, ['guild-a', 22]);
        return null;
      },
      async query() { candidateQueryRan = true; return []; },
    } } },
  };
  const denied = responseRecorder();
  await handler(deniedReq, denied);
  assert.strictEqual(denied.statusCode, 200);
  assert.deepStrictEqual(denied.body.accounts, []);
  assert.strictEqual(candidateQueryRan, false, 'unapproved/inactive tenant candidates must not be queried');

  const activeReq = {
    ...deniedReq,
    app: { locals: { db: {
      async get() { return { id: 4 }; },
      async query(query, params) {
        const normalized = compact(query);
        assert.ok(normalized.includes('WHERE s.guild_id = ? AND s.id = ?'));
        assert.ok(normalized.includes('spm.source_link_id = la.id'));
        assert.deepStrictEqual(params, [4, 22, '%needle%']);
        return [{
          id: 77,
          platform: 'xbox',
          platform_user_id: 'secret-platform-id',
          gamertag: 'Needle',
          server_id: 22,
          server_name: 'Server A',
          linked_username: 'secret-user',
          conflict_user_id: 10,
        }];
      },
    } } },
  };
  const active = responseRecorder();
  await handler(activeReq, active);
  assert.strictEqual(active.statusCode, 200);
  assert.deepStrictEqual(active.body.accounts[0], {
    id: 77,
    gamertag: 'Needle',
    platform: 'xbox',
    lastSeen: undefined,
    serverId: 22,
    serverIds: ['22'],
    serverName: 'Server A',
    serverNames: ['Server A'],
    isAlreadyLinked: false,
    linkedToOther: true,
  });

  if (originalDiscordModule) require.cache[discordPath] = originalDiscordModule;
  else delete require.cache[discordPath];
  if (originalPortalModule) require.cache[portalPath] = originalPortalModule;
  else delete require.cache[portalPath];
}

async function testAccountDiscoveryAndLinkUseActiveExactServerWithoutPrivateDisclosure() {
  const discordPath = require.resolve('../utils/discordAPI');
  const routePath = require.resolve('../routes/accountLinking');
  const originalDiscord = require.cache[discordPath];
  const originalRoute = require.cache[routePath];
  require.cache[discordPath] = {
    id: discordPath, filename: discordPath, loaded: true,
    exports: { verifyGuildMembership: async () => true },
  };
  delete require.cache[routePath];
  const router = require('../routes/accountLinking');
  const available = finalHandler(router, '/available-accounts');

  const missingServer = responseRecorder();
  await available({
    user: { id: 9, access_token: 'token' }, query: { guildId: 'guild-a' },
    app: { locals: { db: { query: async () => { throw new Error('must not discover'); } } } },
  }, missingServer);
  assert.strictEqual(missingServer.statusCode, 400, 'account discovery requires an exact server');

  let discoverySql;
  const active = responseRecorder();
  await available({
    user: { id: 9, access_token: 'token' },
    query: { guildId: 'guild-a', serverId: '22', search: 'needle' },
    app: { locals: { db: { async query(sql, params) {
      discoverySql = compact(sql);
      assert.deepStrictEqual(params, ['guild-a', '22', '%needle%']);
      return [{ id: 77, platform: 'xbox', gamertag: 'Needle', platform_user_id: 'secret', linkedToUsername: 'secret-user', last_seen: 'secret-time', server_names: 'Secret Server', conflicting_membership_id: 5 }];
    } } } },
  }, active);
  assert.ok(discoverySql.includes("g.status = 'approved'"));
  assert.ok(discoverySql.includes("s.status = 'active'"));
  assert.ok(discoverySql.includes('s.id = ?'));
  assert.ok(discoverySql.includes('spm.source_link_id = la.id'));
  assert.ok(discoverySql.includes("la.verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')"));
  assert.deepStrictEqual(active.body.accounts, [{ id: 77, platform: 'xbox', gamertag: 'Needle', available: false }],
    'discovery must return only challenge-safe fields');

  const link = finalHandler(router, '/link', 'post');
  let mutated = false;
  const inactive = responseRecorder();
  await link({
    user: { id: 9, discord_id: 'discord-9', access_token: 'token' },
    body: { gameAccountId: 77, guildId: 'guild-a', serverId: 22 },
    app: { locals: { db: {
      async get(sql) {
        const normalized = compact(sql);
        assert.ok(normalized.includes("s.status = 'active'"));
        assert.ok(normalized.includes("g.status = 'approved'"));
        assert.ok(normalized.includes('LEFT JOIN linked_accounts la ON la.identity_id = pi.id'));
        return null;
      },
      async run() { mutated = true; }, async query() { mutated = true; },
      async transaction() { mutated = true; },
    } } },
  }, inactive);
  assert.strictEqual(inactive.statusCode, 404, 'inactive exact server cannot reactivate a membership');
  assert.strictEqual(mutated, false);

  if (originalDiscord) require.cache[discordPath] = originalDiscord;
  else delete require.cache[discordPath];
  if (originalRoute) require.cache[routePath] = originalRoute;
  else delete require.cache[routePath];
}

async function testTrustedWebsiteOwnershipCanAddASecondExactServerMembership() {
  const discordPath = require.resolve('../utils/discordAPI');
  const reconcilerPath = require.resolve('../utils/linkRoleReconciler');
  const routePath = require.resolve('../routes/accountLinking');
  const originalDiscord = require.cache[discordPath];
  const originalReconciler = require.cache[reconcilerPath];
  const originalRoute = require.cache[routePath];
  require.cache[discordPath] = {
    id: discordPath, filename: discordPath, loaded: true,
    exports: { verifyGuildMembership: async () => true },
  };
  require.cache[reconcilerPath] = {
    id: reconcilerPath, filename: reconcilerPath, loaded: true,
    exports: {
      enqueueRoleReconciliationJob: async () => ({ id: 1 }),
      runRoleReconciliationJob: async () => {},
    },
  };
  delete require.cache[routePath];

  try {
    const router = require('../routes/accountLinking');
    const link = finalHandler(router, '/link', 'post');
    let membershipWrite = null;
    let lockedProofRead = false;
    let userLocked = false;
    let tenantLocked = false;
    let settingsRead = false;
    const res = responseRecorder();
    await link({
      user: { id: 9, discord_id: 'discord-9', access_token: 'token' },
      body: { gameAccountId: 77, guildId: 'guild-a', serverId: 22 },
      app: { locals: { db: {
        async get(sql, params) {
          const normalized = compact(sql);
          if (normalized.includes('server_features')) {
            settingsRead = true;
            return null;
          }
          assert.ok(normalized.includes('LEFT JOIN linked_accounts la ON la.identity_id = pi.id'),
            'trusted global ownership must be resolved directly, not through a pre-existing target-server membership');
          assert.deepStrictEqual(params, [77, 'guild-a', 22]);
          return {
            id: 77,
            server_id: 22,
            server_name: 'Server Two',
            guild_id: 4,
            discord_guild_id: 'guild-a',
            linkedId: 101,
            linkedUserId: 9,
            linkedVerificationMethod: 'emote_challenge',
            membershipStatus: null,
            membershipUserId: null,
          };
        },
        async transaction(callback) {
          await callback({
            async get(sql, params) {
              const normalized = compact(sql);
              if (normalized.includes('pg_advisory_xact_lock')) {
                assert.deepStrictEqual(params, [2147483001, 9]);
                userLocked = true;
                return {};
              }
              if (normalized.includes('FROM guilds g') && normalized.includes('FOR UPDATE OF g, s')) {
                assert.strictEqual(userLocked, true,
                  'exact tenant parent must be locked only after the user-deletion advisory lock');
                assert.deepStrictEqual(params, [22, 4]);
                tenantLocked = true;
                return { id: 22, guild_id: 4 };
              }
              assert.strictEqual(tenantLocked, true,
                'trusted ownership must be locked only after the exact tenant parent');
              assert.ok(normalized.includes('FROM linked_accounts'));
              assert.ok(normalized.includes('FOR UPDATE'));
              assert.deepStrictEqual(params, [77]);
              lockedProofRead = true;
              return { id: 101, user_id: 9, verification_method: 'emote_challenge' };
            },
            async run(sql, params) {
              membershipWrite = { sql: compact(sql), params };
              return { changes: 1 };
            },
          });
        },
      } } },
    }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(settingsRead, false,
      'trusted ownership must not depend on the new-claim verification policy');
    assert.strictEqual(lockedProofRead, true, 'trusted ownership must be locked and revalidated in the membership transaction');
    assert.ok(membershipWrite.sql.includes('INSERT INTO server_player_memberships'));
    assert.deepStrictEqual(membershipWrite.params, [22, 4, 77, 9, 101, 9]);
  } finally {
    if (originalDiscord) require.cache[discordPath] = originalDiscord;
    else delete require.cache[discordPath];
    if (originalReconciler) require.cache[reconcilerPath] = originalReconciler;
    else delete require.cache[reconcilerPath];
    if (originalRoute) require.cache[routePath] = originalRoute;
    else delete require.cache[routePath];
  }
}

async function testLinkConflictAndOwnerViewsDoNotLeakGlobalOwnership() {
  const botLink = fs.readFileSync(path.join(root, 'bot/commands/link.js'), 'utf8');
  assert.doesNotMatch(botLink, /linked_username|linked_discord_id/,
    'player-facing link conflicts must not select another owner\'s private identity');
  assert.doesNotMatch(botLink, /already linked to \*\*/,
    'player-facing link conflicts must be generic');

  const owner = fs.readFileSync(path.join(root, 'routes/ownerDashboard.js'), 'utf8');
  const detailArea = owner.slice(owner.indexOf("router.get('/servers/:id'"), owner.indexOf('/**\n * GET /api/owner/servers/:id/players'));
  assert.match(detailArea, /server_player_memberships spm/);
  assert.match(detailArea, /spm\.source_link_id = la\.id/);
  assert.match(detailArea, /spm\.status = 'active'/);
  assert.match(detailArea, /la\.verification_method IN \('emote_challenge', 'admin_approved', 'self_asserted'\)/);
  assert.match(detailArea, /s\.status = 'active'/);
  assert.match(detailArea, /g\.status = 'approved'/);

  const playerArea = owner.slice(owner.indexOf('const baseJoins = `'), owner.indexOf('/**\n * GET /api/owner/dashboard/stats'));
  assert.match(playerArea, /pg\.server_id = psa\.server_id/,
    'owner player gamertags must be bound to the requested exact server');
  assert.match(playerArea, /server_player_memberships spm/);
  assert.match(playerArea, /spm\.server_id = psa\.server_id/);
  assert.match(playerArea, /spm\.source_link_id = la\.id/);
  assert.match(playerArea, /spm\.status = 'active'/);
  assert.match(playerArea, /la\.verification_method IN \('emote_challenge', 'admin_approved', 'self_asserted'\)/);
  assert.ok((playerArea.match(/s\.status = 'active'/g) || []).length >= 2,
    'owner player list and stats must recheck active server state');
  assert.ok((playerArea.match(/g\.status = 'approved'/g) || []).length >= 2,
    'owner player list and stats must recheck approved guild state');

  const dashboardArea = owner.slice(owner.indexOf("router.get('/dashboard/stats'"), owner.indexOf('/**\n * DELETE /api/owner/servers/:id'));
  assert.ok((dashboardArea.match(/server_player_memberships spm/g) || []).length >= 2,
    'owner stats and recent-link activity must both derive associations from exact-server memberships');
  assert.ok((dashboardArea.match(/spm\.source_link_id = la\.id/g) || []).length >= 2);
  assert.ok((dashboardArea.match(/spm\.status = 'active'/g) || []).length >= 2);
  assert.ok((dashboardArea.match(/la\.verification_method IN \('emote_challenge', 'admin_approved', 'self_asserted'\)/g) || []).length >= 2);
  assert.ok((dashboardArea.match(/s\.status = 'active'/g) || []).length >= 2);
  assert.ok((dashboardArea.match(/g\.status = 'approved'/g) || []).length >= 2);

  assert.doesNotMatch(owner, /async function runAutoBanForServer/,
    'device-based automatic enforcement must remain removed');
  const candidateService = fs.readFileSync(path.join(root, 'services/altAccountCandidateService.js'), 'utf8');
  assert.match(candidateService, /spm\.server_id = \?/,
    'linked ownership evidence must be bound to the exact server');
  assert.match(candidateService, /ending\.server_id = \?/,
    'behavioral session evidence must be bound to the exact server');
  assert.match(candidateService, /candidate\.server_id = ending\.server_id/,
    'rapid-switch range lookup must remain on the same exact server');
  assert.match(candidateService, /aar\.server_id = \?/,
    'review decisions must be bound to the exact server');
  assert.doesNotMatch(candidateService, /enforcementEligible/,
    'candidate evidence must not imply automatic enforcement eligibility');

  const altsArea = owner.slice(owner.indexOf("router.get('/servers/:id/alts'"), owner.indexOf("router.post('/servers/:id/players/:identityId/wipe'"));
  assert.match(altsArea, /loadAltCandidates\(req\.app\.locals\.db, req\.params\.id\)/);
  assert.match(altsArea, /router\.post\('\/servers\/:id\/alts\/review', ensureServerOwner/);
  assert.match(altsArea, /low_psa\.server_id = s\.id/);
  assert.match(altsArea, /high_psa\.server_id = s\.id/);
  assert.match(altsArea, /gr\.role = 'owner'/);

  const totalServersQuery = dashboardArea.slice(dashboardArea.indexOf('SELECT COUNT(DISTINCT s.id)'), dashboardArea.indexOf('SELECT COUNT(DISTINCT la.user_id)'));
  assert.match(totalServersQuery, /s\.status = 'active'/);
  assert.match(totalServersQuery, /g\.status = 'approved'/);
  const recentServersQuery = dashboardArea.slice(dashboardArea.indexOf("'server_registered' as type"), dashboardArea.indexOf("'player_linked' as type"));
  assert.match(recentServersQuery, /s\.status = 'active'/);
  assert.match(recentServersQuery, /g\.status = 'approved'/);

  const tokenArea = owner.slice(owner.indexOf('async function getTokenForServer'), owner.indexOf('async function readNitradoList'));
  assert.match(tokenArea, /s\.status = 'active'/,
    'Nitrado credentials must not be returned after exact-server revocation');

  const settingsArea = owner.slice(owner.indexOf("router.get('/servers/:id/settings'"), owner.indexOf("router.get('/servers/:id/alts'"));
  assert.ok((settingsArea.match(/s\.status = 'active'/g) || []).length >= 4,
    'every settings and exemption operation must recheck active server state');
  assert.ok((settingsArea.match(/g\.status = 'approved'/g) || []).length >= 4,
    'every settings and exemption operation must recheck approved guild state');

  const deleteArea = owner.slice(owner.indexOf("router.delete('/servers/:id'"), owner.indexOf("router.get('/servers/:id/list/:listType'"));
  assert.match(deleteArea, /s\.status = 'active'/);
  assert.match(deleteArea, /g\.status = 'approved'/);
  assert.match(deleteArea, /gr\.user_id = \?/,
    'server deletion must recheck exact owner authority in the mutation statement');

  const wipeArea = owner.slice(owner.indexOf("router.post('/servers/:id/players/:identityId/wipe'"));
  assert.match(wipeArea, /requestedByUserId/);
  const wipeService = fs.readFileSync(path.join(root, 'services/wipeService.js'), 'utf8');
  assert.match(wipeService, /s\.status = 'active'/,
    'wipe authorization helper must revalidate active state inside the transaction');
  assert.match(wipeService, /g\.status = 'approved'/);
  assert.match(wipeService, /gr\.role = 'owner'/,
    'wipe authorization helper must revalidate owner authority inside the transaction');
  assert.ok((wipeService.match(/assertActiveOwnerServer\(db/g) || []).length >= 2,
    'both player and server wipes must call the transaction-scoped authorization helper');
  assert.doesNotMatch(wipeService, /\(\? IS NULL OR EXISTS/,
    'optional wipe identity predicates must not use an untyped PostgreSQL null parameter');

  const listRemovalArea = owner.slice(owner.indexOf("router.post('/servers/:id/list/:listType/remove'"), owner.indexOf("router.post('/servers/:id/list/:listType/clear'"));
  const listAuthorityArea = owner.slice(
    owner.indexOf('async function assertProviderListMutationAuthority'),
    owner.indexOf("router.get('/servers/:id/list/:listType'")
  );
  assert.match(listRemovalArea, /beforeMutation:[\s\S]*assertProviderListMutationAuthority/,
    'blacklist exemption persistence must revalidate authority before the provider mutation');
  assert.match(listAuthorityArea, /await db\.get/,
    'provider-list authority must be rechecked through the transaction adapter');
  assert.match(listAuthorityArea, /s\.status = 'active'/);
  assert.match(listAuthorityArea, /g\.status = 'approved'/);
  assert.match(listAuthorityArea, /FOR NO KEY UPDATE OF s, g/,
    'the transaction must prevent concurrent server or guild revocation without blocking durable preparation');
  assert.match(listAuthorityArea, /FROM guild_roles[\s\S]*FOR UPDATE/,
    'the transaction must lock the actor role against concurrent revocation');
  assert.doesNotMatch(listRemovalArea, /\.catch\(exemptErr/,
    'blacklist exemption persistence must not be detached from request completion');
  const providerListMutationService = fs.readFileSync(
    path.join(root, 'services/providerListMutationService.js'), 'utf8'
  );
  assert.match(listRemovalArea, /mutateProviderList\(\{/,
    'remote blacklist mutation and exemption persistence need one durable transaction boundary');
  assert.match(listRemovalArea, /localWriter:[\s\S]*alt_ban_exemptions/,
    'blacklist exemption persistence must share the durable provider transaction');
  assert.match(providerListMutationService, /registerProviderMutationRollback/,
    'a failed exemption transaction must restore the committed prior remote blacklist');
  assert.ok(providerListMutationService.indexOf('acquireProviderMutationLock') <
    providerListMutationService.indexOf('downloadFileFromServer'),
  'blacklist removal must acquire the shared provider lock before reading the remote snapshot');
  const listMutationArea = owner.slice(owner.indexOf("router.post('/servers/:id/list/:listType/add'"), owner.indexOf("router.post('/servers/:id/settings/auto-ban-alts'"));
  assert.strictEqual((listMutationArea.match(/mutateProviderList\(\{/g) || []).length, 3,
    'list add, remove, and clear must share the exact-server durable provider lifecycle');
  assert.doesNotMatch(listMutationArea, /catch \(_\) \{ \/\* file may not exist yet \*\/ \}/,
    'list writers must not convert non-404 remote read failures into destructive empty snapshots');

  const autoBanToggleArea = owner.slice(owner.indexOf("router.post('/servers/:id/settings/auto-ban-alts'"), owner.indexOf("router.get('/servers/:id/alt-ban-exemptions'"));
  assert.match(autoBanToggleArea, /guild_roles gr/);
  assert.match(autoBanToggleArea, /gr\.user_id = \?/);
  assert.match(autoBanToggleArea, /gr\.role = 'owner'/);
  const exemptionMutationArea = owner.slice(owner.indexOf("router.post('/servers/:id/alt-ban-exemptions'"), owner.indexOf("router.get('/servers/:id/alts'"));
  assert.ok((exemptionMutationArea.match(/guild_roles gr/g) || []).length >= 2,
    'manual exemption insert and delete must both recheck current owner role');
  assert.ok((exemptionMutationArea.match(/gr\.user_id = \?/g) || []).length >= 2);
  assert.ok((exemptionMutationArea.match(/gr\.role = 'owner'/g) || []).length >= 2);
  assert.match(wipeService, /FOR UPDATE OF s, g, gr/,
    'wipe authorization must hold server, guild, and owner-role rows through destructive work');
}

async function testOwnerDataQueriesFailClosedAfterTenantRevocation() {
  const router = require('../routes/ownerDashboard');
  const detail = finalHandler(router, '/servers/:id');
  const detailRes = responseRecorder();
  await detail({
    params: { id: '22' }, isOwner: true,
    app: { locals: { db: { async get(sql, params) {
      const normalized = compact(sql);
      assert.deepStrictEqual(params, ['22']);
      assert.ok(normalized.includes("s.status = 'active'"));
      assert.ok(normalized.includes("g.status = 'approved'"));
      return null;
    } } } },
  }, detailRes);
  assert.strictEqual(detailRes.statusCode, 404,
    'server detail must fail closed if the tenant is revoked after middleware authorization');

  const players = finalHandler(router, '/servers/:id/players');
  const playerRes = responseRecorder();
  let checkedQueries = 0;
  const checkTenantState = sql => {
    const normalized = compact(sql);
    assert.ok(normalized.includes("s.status = 'active'"));
    assert.ok(normalized.includes("g.status = 'approved'"));
    if (normalized.includes('player_gamertags pg')) {
      assert.ok(normalized.includes('pg.server_id = psa.server_id'));
    }
    checkedQueries += 1;
  };
  await players({
    params: { id: '22' }, query: {}, isOwner: true,
    app: { locals: { db: {
      async query(sql) { checkTenantState(sql); return []; },
      async get(sql) {
        checkTenantState(sql);
        return sql.includes('COUNT(DISTINCT pi.id) AS total')
          ? { total: 0, alts: 0, linked: 0 }
          : { total: 0 };
      },
    } } },
  }, playerRes);
  assert.strictEqual(playerRes.statusCode, 200);
  assert.strictEqual(checkedQueries, 3);
}

async function testLeaderboardDiscordAssociationNeedsTrustedExactServerProvenance() {
  const router = require('../routes/playerPortal');
  const handler = finalHandler(router, '/leaderboard/:guild_id');
  let sql;
  const res = responseRecorder();
  await handler({
    user: { id: 9 }, params: { guild_id: 'guild-a' }, query: {}, playerServer: { id: 22 },
    app: { locals: { db: { async query(query, params) {
      sql = compact(query);
      assert.deepStrictEqual(params, [22, 22, 22, 22, 22, 22, 50]);
      return [];
    } } } },
  }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.ok(sql.includes('server_player_memberships spm'));
  assert.ok(sql.includes('spm.server_id = s.id'));
  assert.ok(sql.includes("spm.status = 'active'"));
  assert.ok(sql.includes('spm.source_link_id = la.id'));
  assert.ok(sql.includes("la.verification_method IN ('emote_challenge', 'admin_approved', 'self_asserted')"));
}

async function testFactionPositionsShopAndAiStayOnActiveExactServerCapabilities() {
  const factions = fs.readFileSync(path.join(root, 'routes/factions.js'), 'utf8');
  const mapStart = factions.indexOf("router.get('/:guildId/:factionId/map'");
  const mapRoute = factions.slice(mapStart, factions.indexOf('\n});', mapStart) + 4);
  assert.match(mapRoute, /player_position_snapshots[\s\S]*server_id\s*=\s*\?/);
  assert.match(mapRoute, /servers[\s\S]*status\s*=\s*'active'/);
  assert.match(mapRoute, /guilds[\s\S]*status\s*=\s*'approved'/);

  const shop = fs.readFileSync(path.join(root, 'routes/shop.js'), 'utf8');
  assert.match(shop, /authorizeServer/);
  assert.match(shop, /CAPABILITIES\.SERVER_MANAGE/);
  assert.doesNotMatch(shop, /async function verifyServerOwner[\s\S]{0,500}FROM guild_roles/,
    'shop admin authorization must use the canonical exact-server capability');

  const ai = fs.readFileSync(path.join(root, 'routes/ai.js'), 'utf8');
  assert.match(ai, /authorizePlatformServer/);
  assert.match(ai, /authorizeServer/);
  assert.match(ai, /CAPABILITIES\.SERVER_MANAGE/);
  assert.match(ai, /getAuthorizedSuggestion[\s\S]{0,1200}s\.status = 'active'/);
  const suggestionArea = ai.slice(ai.indexOf('// ─── Suggestions CRUD'));
  assert.ok((suggestionArea.match(/s\.status = 'active'/g) || []).length >= 3,
    'suggestion mutation, claim, and completion must each recheck active server state');
}

async function testAiServerCapabilityFailsClosedOnAuthorizationErrors() {
  const router = require('../routes/ai');
  const guard = router.params.platformServerId[0];
  const res = responseRecorder();
  let nextCalled = false;
  await guard({
    user: { id: 9 }, params: { platformServerId: 'service-22' }, body: {},
    app: { locals: { db: { async get() { throw new Error('authorization database unavailable'); } } } },
  }, res, () => { nextCalled = true; }, 'service-22', 'platformServerId');
  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(nextCalled, false);
}

async function testHeatmapUsesCentralExactServerCapabilities() {
  const router = require('../routes/mapHeatmap');
  const handler = finalHandler(router, '/kill-heatmap');
  let privateQueryRan = false;
  const legacyModeratorReq = {
    user: { id: 7 }, query: { serverId: 'service-41' },
    app: { locals: { db: {
      async get(sql, params) {
        const normalized = compact(sql);
        assert.ok(normalized.includes('server_role_assignments'));
        assert.ok(normalized.includes('sra.server_id = s.id'));
        assert.ok(normalized.includes('sra.guild_id = s.guild_id'));
        assert.ok(normalized.includes("s.status = 'active'"));
        assert.deepStrictEqual(params, [7, 7, 7, 'service-41']);
        return {
          server_id: 41, guild_id: 4, platform_server_id: 'service-41',
          server_status: 'active', guild_status: 'approved', discord_guild_id: 'guild-a',
          guild_role: 'moderator', server_role: null, server_role_status: null,
        };
      },
      async query() { privateQueryRan = true; return []; },
    } } },
  };
  const denied = responseRecorder();
  await handler(legacyModeratorReq, denied);
  assert.strictEqual(denied.statusCode, 404);
  assert.strictEqual(privateQueryRan, false, 'legacy guild moderator must not read private heatmaps');

  const assignedReq = {
    ...legacyModeratorReq,
    app: { locals: { db: {
      async get() {
        return {
          server_id: 41, guild_id: 4, platform_server_id: 'service-41',
          server_status: 'active', guild_status: 'approved', discord_guild_id: 'guild-a',
          server_role: 'moderator', server_role_status: 'active',
        };
      },
      async query(sql, params) {
        privateQueryRan = true;
        assert.ok(sql.includes('WHERE server_id = $1'));
        assert.strictEqual(params[0], 41);
        return [];
      },
    } } },
  };
  const allowed = responseRecorder();
  await handler(assignedReq, allowed);
  assert.strictEqual(allowed.statusCode, 200);
  assert.strictEqual(allowed.body.ok, true);
}

async function testMissionFilesDenyInactiveBeforePathsTokensAndOperations() {
  const router = require('../routes/missionFiles');
  const routes = [
    ['get', '/mission-files/active-locks', { query: { serverId: 'service-41' }, params: {}, body: {} }],
    ['get', '/mission-files/list/:serverId?', { query: {}, params: { serverId: 'service-41' }, body: {} }],
    ['post', '/mission-files/release-all-locks', { query: {}, params: {}, body: { serverId: 'service-41' } }],
    ['post', '/mission-files/:serverId/:fileName(*)/check-conflict', { query: {}, params: { serverId: 'service-41', fileName: 'types.xml' }, body: { expectedHash: 'x' } }],
    ['get', '/mission-files/:serverId/:fileName(*)/backups', { query: {}, params: { serverId: 'service-41', fileName: 'types.xml' }, body: {} }],
    ['post', '/mission-files/:serverId/:fileName(*)/restore', { query: {}, params: { serverId: 'service-41', fileName: 'types.xml' }, body: { backupPath: 'types.xml.1.backup' } }],
    ['get', '/mission-files/:serverId/:fileName(*)/lock-status', { query: {}, params: { serverId: 'service-41', fileName: 'types.xml' }, body: {} }],
    ['post', '/mission-files/:serverId/:fileName(*)/lock', { query: {}, params: { serverId: 'service-41', fileName: 'types.xml' }, body: {} }],
    ['post', '/mission-files/:serverId/:fileName(*)/unlock', { query: {}, params: { serverId: 'service-41', fileName: 'types.xml' }, body: {} }],
    ['put', '/mission-files/:serverId/:fileName(*)', { query: {}, params: { serverId: 'service-41', fileName: 'types.xml' }, body: { lockId: 'lock', content: '<types/>', uploadToNitrado: true } }],
    ['get', '/mission-files/:serverId/:fileName(*)', { query: {}, params: { serverId: 'service-41', fileName: 'types.xml' }, body: {} }],
  ];

  for (const [method, routePath, requestParts] of routes) {
    let nonAuthorizationDbCall = false;
    const req = {
      ...requestParts,
      user: { id: 7, username: 'tester' },
      app: { locals: { db: {
        async get(sql) {
          const normalized = compact(sql);
          if (!normalized.includes("s.status = 'active'") || !normalized.includes('server_role_assignments')) {
            nonAuthorizationDbCall = true;
          }
          return null;
        },
        async all() { nonAuthorizationDbCall = true; return []; },
        async query() { nonAuthorizationDbCall = true; return []; },
      } } },
    };
    const res = responseRecorder();
    await finalHandler(router, routePath, method)(req, res);
    assert.strictEqual(res.statusCode, 404, `${method.toUpperCase()} ${routePath} must deny inactive server`);
    assert.strictEqual(nonAuthorizationDbCall, false, `${routePath} touched private state after denial`);
  }
}

async function testPlayerGuardsUseExactRoleEvidence() {
  const { ensurePlayerGuildAccess, ensurePlayerServerAccess } = require('../middleware/serverAccess');
  let guildSql = '';
  const guildReq = {
    isAuthenticated: () => true,
    user: { id: 7 }, params: { guildId: 'guild-a' }, query: {}, body: {},
    app: { locals: { db: { async get(sql) { guildSql = compact(sql); return null; } } } },
  };
  const guildRes = responseRecorder();
  await ensurePlayerGuildAccess(guildReq, guildRes, () => {});
  assert.strictEqual(guildRes.statusCode, 403);
  assert.ok(guildSql.includes("gr.role IN ('owner', 'admin')"));
  assert.ok(guildSql.includes('server_role_assignments'));
  assert.ok(guildSql.includes('sra.server_id = s.id'));
  assert.ok(guildSql.includes('sra.guild_id = g.id'));
  assert.ok(guildSql.includes("sra.status = 'active'"));

  const baseReq = {
    isAuthenticated: () => true,
    user: { id: 7 }, params: { serverId: '41' }, query: {}, body: {},
  };
  let nextCalled = false;
  const legacyRes = responseRecorder();
  await ensurePlayerServerAccess({
    ...baseReq,
    app: { locals: { db: { async get() {
      return {
        server_id: 41, guild_id: 4, platform_server_id: 'service-41', server_status: 'active',
        guild_status: 'approved', discord_guild_id: 'guild-a', guild_role: 'moderator',
      };
    } } } },
  }, legacyRes, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, false);
  assert.strictEqual(legacyRes.statusCode, 403, 'legacy guild moderator must deny');

  const assignedReq = {
    ...baseReq,
    app: { locals: { db: { async get() {
      return {
        server_id: 41, guild_id: 4, platform_server_id: 'service-41', server_status: 'active',
        guild_status: 'approved', discord_guild_id: 'guild-a', server_role: 'moderator',
        server_role_status: 'active',
      };
    } } } },
  };
  const assignedRes = responseRecorder();
  nextCalled = false;
  await ensurePlayerServerAccess(assignedReq, assignedRes, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true, 'valid active exact-server assignee must pass server view guard');
  assert.strictEqual(assignedReq.playerServerAccess.serverId, 41);
}

async function main() {
  await testPlayerPortalParamAuthorizationAndConflicts();
  await testPlayerSearchIsActiveExactServerScopedAndMinimal();
  await testAccountDiscoveryAndLinkUseActiveExactServerWithoutPrivateDisclosure();
  await testTrustedWebsiteOwnershipCanAddASecondExactServerMembership();
  await testLinkConflictAndOwnerViewsDoNotLeakGlobalOwnership();
  await testOwnerDataQueriesFailClosedAfterTenantRevocation();
  await testLeaderboardDiscordAssociationNeedsTrustedExactServerProvenance();
  await testFactionPositionsShopAndAiStayOnActiveExactServerCapabilities();
  await testAiServerCapabilityFailsClosedOnAuthorizationErrors();
  await testHeatmapUsesCentralExactServerCapabilities();
  await testMissionFilesDenyInactiveBeforePathsTokensAndOperations();
  await testPlayerGuardsUseExactRoleEvidence();
  console.log('✅ Private data authorization tests passed');
}

main().catch(error => {
  console.error(`❌ ${error.stack || error.message}`);
  process.exit(1);
});
