'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function finalHandler(router, routePath, method) {
  const layer = router.stack.find(entry => entry.route?.path === routePath && entry.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${routePath} must exist`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function compact(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

async function loadFactionRouter() {
  const discordPath = require.resolve('../utils/discordAPI');
  const routePath = require.resolve('../routes/factions');
  const originalDiscord = require.cache[discordPath];
  const originalRoute = require.cache[routePath];

  require.cache[discordPath] = {
    id: discordPath,
    filename: discordPath,
    loaded: true,
    exports: { verifyGuildMembership: async () => true },
  };
  delete require.cache[routePath];

  return {
    router: require('../routes/factions'),
    restore() {
      if (originalDiscord) require.cache[discordPath] = originalDiscord;
      else delete require.cache[discordPath];
      if (originalRoute) require.cache[routePath] = originalRoute;
      else delete require.cache[routePath];
    },
  };
}

async function testFactionMutationsRejectFactionFromAnotherGuild() {
  const { router, restore } = await loadFactionRouter();
  const cases = [
    { method: 'post', path: '/:guildId/:factionId/leave', body: {} },
    { method: 'put', path: '/:guildId/:factionId/members/:identityId', body: { rank: 'member' } },
    { method: 'delete', path: '/:guildId/:factionId/members/:identityId', body: {} },
    { method: 'put', path: '/:guildId/:factionId/markers/:markerId', body: { serverId: 11, title: 'Updated' } },
    { method: 'delete', path: '/:guildId/:factionId/markers/:markerId', body: {} },
  ];

  try {
    for (const testCase of cases) {
      let mutated = false;
      let sawScopedFactionLookup = false;
      const db = {
        async get(sql, params) {
          const query = compact(sql);
          if (query === 'SELECT id FROM guilds WHERE discord_guild_id = ?') {
            assert.deepStrictEqual(params, ['guild-a']);
            return { id: 1 };
          }
          if (query.includes('FROM factions') && query.includes('id = ?') && query.includes('guild_id = ?')) {
            assert.deepStrictEqual(params, ['20', 1]);
            sawScopedFactionLookup = true;
            return null;
          }
          return { id: 99, rank: 'leader', created_by_identity_id: 99 };
        },
        async run() { mutated = true; },
      };
      const req = {
        user: { id: 9, access_token: 'fixture-token' },
        params: { guildId: 'guild-a', factionId: '20', identityId: '88', markerId: '77' },
        body: testCase.body,
        query: { serverId: '11' },
        app: { locals: { db } },
      };
      const res = responseRecorder();
      await finalHandler(router, testCase.path, testCase.method)(req, res);

      assert.strictEqual(res.statusCode, 404, `${testCase.method.toUpperCase()} ${testCase.path} must hide a cross-guild faction`);
      assert.strictEqual(res.body?.error, 'Faction not found');
      assert.strictEqual(sawScopedFactionLookup, true, `${testCase.method.toUpperCase()} ${testCase.path} must bind factionId to guildId`);
      assert.strictEqual(mutated, false, `${testCase.method.toUpperCase()} ${testCase.path} must not mutate a cross-guild faction`);
    }
  } finally {
    restore();
  }
}

async function testFactionUiEscapesUntrustedValues() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'factions.js'), 'utf8');
  const context = vm.createContext({
    window: {},
    URL,
    document: { getElementById: () => null },
    console,
    fetch: async () => ({ json: async () => ({}) }),
    alert() {},
    confirm: () => false,
  });
  vm.runInContext(source, context);

  const curatedFlagUrl = vm.runInContext('DAYZ_FLAGS[0].url', context);
  assert.strictEqual(
    vm.runInContext('safeFactionFlagUrl(DAYZ_FLAGS[0].url)', context),
    curatedFlagUrl,
    'curated cache-busted DayZ flag URLs must remain renderable'
  );

  const payload = JSON.stringify([{
    id: 20,
    name: '<img src=x onerror=alert(1)>',
    tag: '<svg/onload=alert(1)>',
    description: '<script>alert(1)</script>',
    emblem: '<iframe src=javascript:alert(1)>',
    flag_url: 'https://static.wikia.nocookie.net/dayz_gamepedia/images/x.png" onerror=alert(1)',
    is_open: true,
    member_count: 1,
  }]);
  const html = vm.runInContext(`renderFactionList(${payload}, null)`, context);

  assert.doesNotMatch(html, /<script|<iframe|<svg|"\s+onerror=/i, 'faction cards must not emit attacker-controlled markup');
  assert.match(html, /&lt;img/, 'faction names must be HTML-escaped');

  const faction = JSON.stringify({
    id: 20,
    name: '<img src=x onerror=alert(1)>',
    tag: '<svg/onload=alert(1)>',
    description: '<script>alert(1)</script>',
    emblem: '<iframe src=javascript:alert(1)>',
    flag_url: 'https://static.wikia.nocookie.net/dayz_gamepedia/images/x.png" onerror=alert(1)',
    is_open: true,
  });
  const members = JSON.stringify([{
    identity_id: 88,
    rank: '<img src=x onerror=alert(1)>',
    player_name: '<svg/onload=alert(1)>',
  }]);
  const detailHtml = vm.runInContext(`renderFactionDetail(${faction}, ${members}, 'leader')`, context);
  assert.doesNotMatch(detailHtml, /<script|<iframe|<svg|"\s+onerror=/i,
    'faction detail and member rows must not emit attacker-controlled markup');
  const formHtml = vm.runInContext(`renderFactionForm(${faction})`, context);
  assert.doesNotMatch(formHtml, /<script|<iframe|<svg|"\s+onerror=/i,
    'faction edit form values must be attribute-escaped');

  context.fetch = async () => ({
    json: async () => ({
      success: true,
      invites: [{
        id: 7,
        faction_emblem: '<img src=x onerror=alert(1)>',
        faction_name: '<script>alert(1)</script>',
        faction_tag: '<svg/onload=alert(1)>',
        inviter_name: '<iframe src=javascript:alert(1)>',
      }],
    }),
  });
  const inviteHtml = await vm.runInContext("_guildId = 'guild-a'; fetchInvitesBanner()", context);
  assert.doesNotMatch(inviteHtml, /<script|<iframe|<svg|"\s+onerror=/i,
    'pending invite values must not emit attacker-controlled markup');
  assert.match(inviteHtml, /&lt;script/, 'pending invite names must be HTML-escaped');

  const mapSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'player-map-standalone.js'), 'utf8');
  assert.match(mapSource, /escapeMapHtml\(m\.player_name\)/,
    'faction teammate names must be escaped before entering Leaflet popup HTML');
}

async function testFactionMembershipInvariantMigration() {
  const migrationPath = path.join(__dirname, '..', 'db', 'migrations', '064_faction_membership_tenant_integrity.js');
  assert.ok(fs.existsSync(migrationPath), 'faction membership tenant-integrity migration must exist');

  const statements = [];
  const migration = require(migrationPath);
  assert.strictEqual(typeof migration.up, 'function', 'migration must export the up(pool) entry point used by migrationRunnerPg');
  await migration.up({
    async query(sql) { statements.push(sql); },
  });

  const sql = statements.join('\n');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS guild_id/i, 'membership rows must carry their guild');
  assert.match(sql, /UPDATE faction_members[\s\S]*FROM factions/i, 'existing membership rows must be backfilled');
  assert.match(sql, /UNIQUE\s*\(guild_id, identity_id\)/i,
    'the database must enforce one faction membership per identity and guild');
  assert.match(sql, /FOREIGN KEY\s*\(faction_id, guild_id\)/i,
    'membership faction and guild identifiers must be relationally bound');
  assert.match(sql, /conrelid\s*=\s*'factions'::regclass/i,
    'factions constraint checks must be bound to the factions relation');
  assert.match(sql, /conrelid\s*=\s*'faction_members'::regclass/i,
    'membership constraint checks must be bound to the faction_members relation');
}

async function testFactionListScopesCallerMembershipToGuild() {
  const { router, restore } = await loadFactionRouter();
  const handler = finalHandler(router, '/:guildId', 'get');
  let membershipQuerySeen = false;
  const db = {
    async all() { return []; },
    async get(sql, params) {
      const query = compact(sql);
      if (query === 'SELECT id FROM guilds WHERE discord_guild_id = ?') return { id: 1 };
      if (query.includes('FROM server_player_memberships')) return { id: 88 };
      if (query.includes('SELECT faction_id FROM faction_members')) {
        membershipQuerySeen = true;
        assert.match(query, /guild_id = \?/, 'caller membership lookup must include guild_id');
        assert.deepStrictEqual(params, [88, 1]);
        return null;
      }
      throw new Error(`Unexpected query: ${query}`);
    },
  };

  try {
    const req = {
      user: { id: 9, access_token: 'fixture-token' },
      params: { guildId: 'guild-a' },
      app: { locals: { db } },
    };
    const res = responseRecorder();
    await handler(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(membershipQuerySeen, true);
    assert.strictEqual(res.body.callerFactionId, null);
  } finally {
    restore();
  }
}

async function testInviteAcceptanceLocksAndRevalidatesInviteInsideTransaction() {
  const { router, restore } = await loadFactionRouter();
  const handler = finalHandler(router, '/invites/:inviteId/accept', 'post');
  let transactionUsed = false;
  let factionLocked = false;
  let inviteLocked = false;
  let expirationRechecked = false;
  let membershipInserted = false;
  let inviteDeleted = false;

  const tx = {
    async get(sql, params) {
      const query = compact(sql);
      if (/FOR UPDATE OF f$/i.test(query)) {
        assert.deepStrictEqual(params, ['7']);
        factionLocked = true;
        return { id: 20, guild_id: 1 };
      }
      if (query.includes('clock_timestamp()')) {
        assert.strictEqual(inviteLocked, true, 'expiry recheck must follow the invite lock');
        expirationRechecked = true;
        assert.deepStrictEqual(params, ['7']);
        return { unexpired: true };
      }
      if (query.includes('FROM faction_invites')) {
        assert.strictEqual(factionLocked, true, 'invite lock must follow the common faction lock');
        inviteLocked = /FOR UPDATE OF fi/i.test(query);
        assert.deepStrictEqual(params, ['7', 20, 1]);
        return { id: 7, faction_id: 20, internal_guild_id: 1, invitee_identity_id: 88 };
      }
      if (query.includes('FROM server_player_memberships')) return { id: 88 };
      if (query.includes('FROM faction_members')) return null;
      throw new Error(`Unexpected transaction query: ${query}`);
    },
    async run(sql, params) {
      const query = compact(sql);
      if (query.startsWith('INSERT INTO faction_members')) {
        membershipInserted = true;
        assert.deepStrictEqual(params, [20, 1, 88, 'member']);
        return { changes: 1 };
      }
      if (query.startsWith('DELETE FROM faction_invites')) {
        inviteDeleted = true;
        assert.deepStrictEqual(params, ['7']);
        return { changes: 1 };
      }
      throw new Error(`Unexpected transaction mutation: ${query}`);
    },
  };
  const db = {
    async get() { throw new Error('invite authorization must not be read outside the transaction'); },
    async transaction(callback) {
      transactionUsed = true;
      return callback(tx);
    },
  };

  try {
    const req = {
      user: { id: 9, access_token: 'fixture-token' },
      params: { inviteId: '7' },
      app: { locals: { db } },
    };
    const res = responseRecorder();
    await handler(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(transactionUsed, true);
    assert.strictEqual(inviteLocked, true, 'acceptance must lock the invite before authorization');
    assert.strictEqual(expirationRechecked, true, 'acceptance must recheck expiry against the live database clock after locking');
    assert.strictEqual(membershipInserted, true);
    assert.strictEqual(inviteDeleted, true);
  } finally {
    restore();
  }
}

async function testInviteAcceptanceDeniesExpiredAndRevokedInvitesWithoutWrites() {
  const { router, restore } = await loadFactionRouter();
  const handler = finalHandler(router, '/invites/:inviteId/accept', 'post');
  const scenarios = [
    { name: 'expired', parent: { id: 20, guild_id: 1 }, invite: { id: 7, faction_id: 20, internal_guild_id: 1, invitee_identity_id: 88 }, expiry: { unexpired: false } },
    { name: 'revoked', parent: null, invite: null, expiry: null },
  ];

  try {
    for (const scenario of scenarios) {
      let wrote = false;
      let inviteLocked = false;
      const tx = {
        async get(sql) {
          const query = compact(sql);
          if (/FOR UPDATE OF f$/i.test(query)) return scenario.parent;
          if (query.includes('clock_timestamp()')) {
            assert.strictEqual(inviteLocked, true);
            return scenario.expiry;
          }
          if (query.includes('FROM faction_invites')) {
            inviteLocked = true;
            return scenario.invite;
          }
          throw new Error(`${scenario.name}: denial path read too far: ${query}`);
        },
        async run() {
          wrote = true;
          throw new Error(`${scenario.name}: denial path must not write`);
        },
      };
      const db = {
        async get() { throw new Error(`${scenario.name}: invite read escaped transaction`); },
        async transaction(callback) { return callback(tx); },
      };
      const req = {
        user: { id: 9, access_token: 'fixture-token' },
        params: { inviteId: '7' },
        app: { locals: { db } },
      };
      const res = responseRecorder();
      await handler(req, res);
      assert.strictEqual(res.statusCode, 404, `${scenario.name} invite must be denied`);
      assert.strictEqual(res.body?.error, 'Invite not found or expired');
      assert.strictEqual(wrote, false, `${scenario.name} invite must not create membership or delete rows`);
    }
  } finally {
    restore();
  }
}

async function testInviteCancellationLocksFactionBeforeAuthorizationAndDelete() {
  const { router, restore } = await loadFactionRouter();
  const handler = finalHandler(router, '/invites/:inviteId', 'delete');
  let factionLocked = false;
  let inviteLocked = false;
  let authorizationLocked = false;
  let inviteDeleted = false;
  const tx = {
    async get(sql, params) {
      const query = compact(sql);
      if (/FOR UPDATE OF f$/i.test(query)) {
        assert.deepStrictEqual(params, ['7']);
        factionLocked = true;
        return { id: 20, guild_id: 1 };
      }
      if (query.includes('FROM faction_invites')) {
        assert.strictEqual(factionLocked, true);
        assert.match(query, /FOR UPDATE OF fi/i);
        assert.deepStrictEqual(params, ['7', 20, 1]);
        inviteLocked = true;
        return { id: 7, faction_id: 20, internal_guild_id: 1, invitee_identity_id: 88 };
      }
      if (query.includes('FROM server_player_memberships')) return { id: 9 };
      if (query.includes('FROM faction_members')) {
        assert.strictEqual(inviteLocked, true);
        assert.match(query, /FOR UPDATE/i);
        authorizationLocked = true;
        return { faction_id: 20, identity_id: 9, rank: 'leader' };
      }
      throw new Error(`Unexpected transaction query: ${query}`);
    },
    async run(sql, params) {
      assert.strictEqual(authorizationLocked, true);
      assert.match(compact(sql), /^DELETE FROM faction_invites/);
      assert.deepStrictEqual(params, ['7', 20]);
      inviteDeleted = true;
      return { changes: 1 };
    },
  };
  const db = {
    async get() { throw new Error('invite cancellation authorization escaped transaction'); },
    async transaction(callback) { return callback(tx); },
  };

  try {
    const req = {
      user: { id: 9, access_token: 'fixture-token' },
      params: { inviteId: '7' },
      app: { locals: { db } },
    };
    const res = responseRecorder();
    await handler(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(factionLocked, true);
    assert.strictEqual(inviteLocked, true);
    assert.strictEqual(authorizationLocked, true);
    assert.strictEqual(inviteDeleted, true);
  } finally {
    restore();
  }
}

async function testPrivilegedMutationsLockAuthorizationInsideTransaction() {
  const { router, restore } = await loadFactionRouter();
  const cases = [
    { method: 'put', path: '/:guildId/:factionId', body: { description: 'Updated' }, marker: false },
    { method: 'delete', path: '/:guildId/:factionId', body: {}, marker: false },
    { method: 'put', path: '/:guildId/:factionId/members/:identityId', body: { rank: 'member' }, marker: false },
    { method: 'delete', path: '/:guildId/:factionId/members/:identityId', body: {}, marker: false },
    { method: 'put', path: '/:guildId/:factionId/markers/:markerId', body: { serverId: 11, title: 'Updated' }, marker: true },
    { method: 'delete', path: '/:guildId/:factionId/markers/:markerId', body: {}, marker: true },
  ];

  try {
    for (const testCase of cases) {
      let transactionUsed = false;
      let authorizationLocked = false;
      let factionLocked = false;
      let markerLocked = false;
      let mutated = false;
      const tx = {
        async get(sql, params) {
          const query = compact(sql);
          if (query.includes('FROM servers s') && query.includes('FOR UPDATE OF s')) {
            return { id: 11, guild_id: 1 };
          }
          if (query.includes('FROM server_features')) {
            return { config: JSON.stringify({ enabledFeatures: ['factionMarkers'] }) };
          }
          if (query.includes('FROM factions')) {
            if (/FOR UPDATE/i.test(query)) {
              assert.match(query, /guild_id = \?/i, 'transaction faction lock must retain guild binding');
              factionLocked = true;
              return { id: 20, guild_id: 1 };
            }
            assert.strictEqual(factionLocked, true, 'faction readback must follow the locked mutation path');
            return { id: 20, guild_id: 1 };
          }
          if (query.includes('FROM server_player_memberships')) return { id: 9 };
          if (query.includes('FROM faction_markers')) {
            if (/FOR UPDATE/i.test(query)) {
              markerLocked = true;
              return { id: 77, faction_id: 20, created_by_identity_id: 88 };
            }
            assert.strictEqual(markerLocked, true, 'marker readback must follow the locked mutation path');
            return { id: 77, faction_id: 20, created_by_identity_id: 88 };
          }
          if (query.includes('FROM faction_members')) {
            assert.strictEqual(factionLocked, true, 'membership locks must follow the common faction lock');
            assert.match(query, /FOR UPDATE/i, 'authorization membership must be row-locked');
            if (params[1] === 9) {
              authorizationLocked = true;
              return { faction_id: 20, identity_id: 9, rank: 'leader' };
            }
            return { faction_id: 20, identity_id: 88, rank: 'member' };
          }
          if (query.startsWith('SELECT * FROM faction_markers WHERE id = ?')) {
            return { id: 77, faction_id: 20, created_by_identity_id: 88 };
          }
          throw new Error(`Unexpected transaction query: ${query}`);
        },
        async run() {
          mutated = true;
          return { changes: 1 };
        },
      };
      const db = {
        async get(sql) {
          const query = compact(sql);
          if (query === 'SELECT id FROM guilds WHERE discord_guild_id = ?') return { id: 1 };
          if (query === 'SELECT * FROM factions WHERE id = ? AND guild_id = ?') return { id: 20, guild_id: 1 };
          throw new Error(`Authorization read escaped transaction: ${query}`);
        },
        async transaction(callback) {
          transactionUsed = true;
          return callback(tx);
        },
      };
      const req = {
        user: { id: 9, access_token: 'fixture-token' },
        params: { guildId: 'guild-a', factionId: '20', identityId: '88', markerId: '77' },
        body: testCase.body,
        query: { serverId: '11' },
        app: { locals: { db } },
      };
      const res = responseRecorder();
      await finalHandler(router, testCase.path, testCase.method)(req, res);
      assert.strictEqual(res.statusCode, 200, `${testCase.method.toUpperCase()} ${testCase.path} should succeed`);
      assert.strictEqual(transactionUsed, true, `${testCase.method.toUpperCase()} ${testCase.path} must use a transaction`);
      assert.strictEqual(authorizationLocked, true, `${testCase.method.toUpperCase()} ${testCase.path} must lock caller authorization`);
      assert.strictEqual(mutated, true);
    }
  } finally {
    restore();
  }
}

async function testOpenJoinLocksFactionAndRechecksStateInsideTransaction() {
  const { router, restore } = await loadFactionRouter();
  const handler = finalHandler(router, '/:guildId/:factionId/join', 'post');
  let factionLocked = false;
  let membershipInserted = false;
  const tx = {
    async get(sql) {
      const query = compact(sql);
      if (query.includes('FROM factions')) {
        assert.match(query, /guild_id = \?/i);
        assert.match(query, /FOR UPDATE/i);
        factionLocked = true;
        return { id: 20, guild_id: 1, is_open: 1 };
      }
      if (query.includes('FROM server_player_memberships')) return { id: 9 };
      if (query.includes('FROM faction_members')) {
        assert.strictEqual(factionLocked, true);
        return null;
      }
      throw new Error(`Unexpected transaction query: ${query}`);
    },
    async run(sql, params) {
      assert.strictEqual(factionLocked, true);
      assert.match(compact(sql), /^INSERT INTO faction_members/);
      assert.deepStrictEqual(params, [20, 1, 9, 'member']);
      membershipInserted = true;
      return { changes: 1 };
    },
  };
  const db = {
    async get(sql) {
      const query = compact(sql);
      if (query === 'SELECT id FROM guilds WHERE discord_guild_id = ?') return { id: 1 };
      if (query === 'SELECT * FROM factions WHERE id = ? AND guild_id = ?') {
        return { id: 20, guild_id: 1, is_open: 1 };
      }
      throw new Error(`Join authorization read escaped transaction: ${query}`);
    },
    async transaction(callback) { return callback(tx); },
  };

  try {
    const req = {
      user: { id: 9, access_token: 'fixture-token' },
      params: { guildId: 'guild-a', factionId: '20' },
      app: { locals: { db } },
    };
    const res = responseRecorder();
    await handler(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(factionLocked, true);
    assert.strictEqual(membershipInserted, true);
  } finally {
    restore();
  }
}

async function testMembershipAuthorizedWritesRevalidateInsideTransaction() {
  const { router, restore } = await loadFactionRouter();
  const cases = [
    { method: 'post', path: '/:guildId/:factionId/leave', body: {}, rank: 'member', isOpen: true },
    {
      method: 'post',
      path: '/:guildId/:factionId/invites',
      body: { identityId: 88 },
      rank: 'leader',
      isOpen: false,
    },
    {
      method: 'post',
      path: '/:guildId/:factionId/markers',
      body: { serverId: 11, mapName: 'chernarusplus', posX: 1, posY: 2 },
      rank: 'member',
    },
  ];

  try {
    for (const testCase of cases) {
      let factionLocked = false;
      let authorizationLocked = false;
      let mutated = false;
      const tx = {
        async get(sql, params) {
          const query = compact(sql);
          if (query.includes('FROM servers s') && query.includes('FOR UPDATE OF s')) {
            return { id: 11, guild_id: 1 };
          }
          if (query.includes('FROM server_features')) {
            return { config: JSON.stringify({ enabledFeatures: ['factionMarkers'] }) };
          }
          if (query.includes('FROM factions')) {
            assert.match(query, /guild_id = \?/i);
            assert.match(query, /FOR UPDATE/i);
            factionLocked = true;
            return { id: 20, guild_id: 1, is_open: testCase.isOpen ? 1 : 0 };
          }
          if (query.includes('FROM server_player_memberships')) return { id: 9 };
          if (query.includes('FROM faction_members')) {
            if (query.includes('JOIN factions f')) {
              assert.strictEqual(factionLocked, true);
              return null;
            }
            assert.strictEqual(factionLocked, true);
            assert.match(query, /FOR UPDATE/i);
            authorizationLocked = true;
            return { faction_id: 20, identity_id: 9, rank: testCase.rank };
          }
          if (query.includes('FROM player_identities')) return { id: 88 };
          if (query.startsWith('INSERT INTO faction_markers')) {
            assert.strictEqual(authorizationLocked, true);
            mutated = true;
            return { id: 77, faction_id: 20 };
          }
          throw new Error(`Unexpected transaction query: ${query} ${JSON.stringify(params)}`);
        },
        async run() {
          assert.strictEqual(authorizationLocked, true);
          mutated = true;
          return { changes: 1 };
        },
      };
      const db = {
        async get(sql) {
          const query = compact(sql);
          if (query === 'SELECT id FROM guilds WHERE discord_guild_id = ?') return { id: 1 };
          if (query === 'SELECT * FROM factions WHERE id = ? AND guild_id = ?' ||
              query === 'SELECT id FROM factions WHERE id = ? AND guild_id = ?') {
            return { id: 20, guild_id: 1, is_open: testCase.isOpen ? 1 : 0 };
          }
          throw new Error(`Authorization read escaped transaction: ${query}`);
        },
        async transaction(callback) { return callback(tx); },
      };
      const req = {
        user: { id: 9, access_token: 'fixture-token' },
        params: { guildId: 'guild-a', factionId: '20' },
        body: testCase.body,
        query: { serverId: '11' },
        app: { locals: { db } },
      };
      const res = responseRecorder();
      await finalHandler(router, testCase.path, testCase.method)(req, res);
      assert.ok([200, 201].includes(res.statusCode), `${testCase.method.toUpperCase()} ${testCase.path} should succeed`);
      assert.strictEqual(factionLocked, true);
      assert.strictEqual(authorizationLocked, true);
      assert.strictEqual(mutated, true);
    }
  } finally {
    restore();
  }
}

async function testInviteSendRejectsOpenFactionWithoutWriting() {
  const { router, restore } = await loadFactionRouter();
  const handler = finalHandler(router, '/:guildId/:factionId/invites', 'post');
  let inviteInserted = false;
  const tx = {
    async get(sql) {
      const query = compact(sql);
      if (query.includes('FROM factions')) {
        assert.match(query, /FOR UPDATE/i);
        return { id: 20, guild_id: 1, is_open: 1 };
      }
      if (query.includes('FROM server_player_memberships')) return { id: 9 };
      if (query.includes('FROM faction_members')) {
        if (query.includes('JOIN factions f')) return null;
        return { faction_id: 20, identity_id: 9, rank: 'leader' };
      }
      if (query.includes('FROM player_identities')) return { id: 88 };
      throw new Error(`Unexpected transaction query: ${query}`);
    },
    async run(sql) {
      if (compact(sql).startsWith('INSERT INTO faction_invites')) inviteInserted = true;
      return { changes: 1 };
    },
  };
  const db = {
    async get(sql) {
      const query = compact(sql);
      if (query === 'SELECT id FROM guilds WHERE discord_guild_id = ?') return { id: 1 };
      if (query === 'SELECT * FROM factions WHERE id = ? AND guild_id = ?') {
        return { id: 20, guild_id: 1, is_open: 1 };
      }
      throw new Error(`Unexpected query outside transaction: ${query}`);
    },
    async transaction(callback) { return callback(tx); },
  };

  try {
    const res = responseRecorder();
    await handler({
      user: { id: 9, access_token: 'fixture-token' },
      params: { guildId: 'guild-a', factionId: '20' },
      body: { identityId: 88 },
      app: { locals: { db } },
    }, res);
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body?.error, 'Open factions do not use invitations');
    assert.strictEqual(inviteInserted, false, 'open-faction denial must not insert an invite');
  } finally {
    restore();
  }
}

async function testFactionCreationLocksAuthorizationInsideTransaction() {
  const { router, restore } = await loadFactionRouter();
  const handler = finalHandler(router, '/:guildId', 'post');
  let authorizationLocked = false;
  let factionInserted = false;
  let membershipInserted = false;
  const tx = {
    async get(sql) {
      const query = compact(sql);
      if (query.includes('FROM server_player_memberships')) {
        assert.match(query, /FOR UPDATE OF spm/i);
        authorizationLocked = true;
        return { id: 88 };
      }
      if (query.includes('FROM faction_members')) {
        assert.strictEqual(authorizationLocked, true);
        return null;
      }
      if (query.startsWith('SELECT * FROM factions WHERE guild_id = ?')) {
        assert.strictEqual(factionInserted, true);
        return { id: 20, guild_id: 1 };
      }
      throw new Error(`Unexpected transaction query: ${query}`);
    },
    async run(sql) {
      const query = compact(sql);
      assert.strictEqual(authorizationLocked, true, 'writes must follow the authorization lock');
      if (query.startsWith('INSERT INTO factions')) factionInserted = true;
      if (query.startsWith('INSERT INTO faction_members')) membershipInserted = true;
      return { changes: 1 };
    },
  };
  const db = {
    async get(sql) {
      const query = compact(sql);
      if (query === 'SELECT id FROM guilds WHERE discord_guild_id = ?') return { id: 1 };
      throw new Error(`Authorization read escaped transaction: ${query}`);
    },
    async transaction(callback) { return callback(tx); },
  };
  const originalError = console.error;
  console.error = () => {};

  try {
    const res = responseRecorder();
    await handler({
      user: { id: 9, access_token: 'fixture-token' },
      params: { guildId: 'guild-a' },
      body: { name: 'Faction', tag: 'FACT' },
      app: { locals: { db } },
    }, res);
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(authorizationLocked, true);
    assert.strictEqual(factionInserted, true);
    assert.strictEqual(membershipInserted, true);
  } finally {
    console.error = originalError;
    restore();
  }
}

async function testFactionCreationClassifiesConcurrentMembershipConflict() {
  const { router, restore } = await loadFactionRouter();
  const handler = finalHandler(router, '/:guildId', 'post');
  const tx = {
    async run(sql) {
      const query = compact(sql);
      if (query.startsWith('INSERT INTO factions')) return { changes: 1 };
      if (query.startsWith('INSERT INTO faction_members')) {
        const error = new Error('duplicate key value violates unique constraint');
        error.code = '23505';
        error.constraint = 'faction_members_guild_identity_unique';
        throw error;
      }
      throw new Error(`Unexpected transaction mutation: ${query}`);
    },
    async get(sql) {
      const query = compact(sql);
      if (query.includes('FROM server_player_memberships')) {
        assert.match(query, /FOR UPDATE OF spm/i);
        return { id: 88 };
      }
      if (query.includes('FROM faction_members')) return null;
      if (query.startsWith('SELECT * FROM factions WHERE guild_id = ?')) {
        return { id: 20, guild_id: 1 };
      }
      throw new Error(`Unexpected transaction query: ${query}`);
    },
  };
  const db = {
    async get(sql) {
      const query = compact(sql);
      if (query === 'SELECT id FROM guilds WHERE discord_guild_id = ?') return { id: 1 };
      throw new Error(`Unexpected query outside transaction: ${query}`);
    },
    async transaction(callback) { return callback(tx); },
  };

  try {
    const req = {
      user: { id: 9, access_token: 'fixture-token' },
      params: { guildId: 'guild-a' },
      body: { name: 'Faction', tag: 'FACT' },
      app: { locals: { db } },
    };
    const res = responseRecorder();
    await handler(req, res);
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body?.error, 'You are already in a faction in this guild');
  } finally {
    restore();
  }
}

async function testFactionCreationPropagatesMembershipFailureFromTransaction() {
  const { router, restore } = await loadFactionRouter();
  const handler = finalHandler(router, '/:guildId', 'post');
  let factionInsertAttempted = false;
  let membershipInsertAttempted = false;
  let rolledBack = false;
  const tx = {
    async run(sql) {
      const query = compact(sql);
      if (query.startsWith('INSERT INTO factions')) {
        factionInsertAttempted = true;
        return { changes: 1 };
      }
      if (query.startsWith('INSERT INTO faction_members')) {
        membershipInsertAttempted = true;
        throw new Error('membership insert failed');
      }
      throw new Error(`Unexpected transaction mutation: ${query}`);
    },
    async get(sql) {
      const query = compact(sql);
      if (query.includes('FROM server_player_memberships')) {
        assert.match(query, /FOR UPDATE OF spm/i);
        return { id: 88 };
      }
      if (query.includes('FROM faction_members')) return null;
      if (query.startsWith('SELECT * FROM factions WHERE guild_id = ?')) return { id: 20, guild_id: 1 };
      throw new Error(`Unexpected transaction query: ${query}`);
    },
  };
  const db = {
    async get(sql) {
      const query = compact(sql);
      if (query === 'SELECT id FROM guilds WHERE discord_guild_id = ?') return { id: 1 };
      throw new Error(`Unexpected query outside transaction: ${query}`);
    },
    async transaction(callback) {
      try {
        return await callback(tx);
      } catch (error) {
        rolledBack = true;
        throw error;
      }
    },
  };
  const originalError = console.error;
  console.error = () => {};

  try {
    const req = {
      user: { id: 9, access_token: 'fixture-token' },
      params: { guildId: 'guild-a' },
      body: {
        name: 'Faction',
        tag: 'FACT',
        flag_url: 'https://static.wikia.nocookie.net/dayz_gamepedia/images/e/ee/Flag_alti_co.png/revision/latest?cb=20200820222622',
      },
      app: { locals: { db } },
    };
    const res = responseRecorder();
    await handler(req, res);
    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(factionInsertAttempted, true);
    assert.strictEqual(membershipInsertAttempted, true);
    assert.strictEqual(rolledBack, true, 'membership failure must abort the faction creation transaction');
  } finally {
    console.error = originalError;
    restore();
  }
}

async function testFactionWritesUseScopedTransactionsAndTenantColumns() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'factions.js'), 'utf8');
  assert.doesNotMatch(source, /db\.run\(['"](?:BEGIN|COMMIT|ROLLBACK)/,
    'multi-write faction workflows must not use pooled standalone transaction statements');
  const transactionCalls = source.match(/db\.transaction\s*\(/g) || [];
  assert.ok(transactionCalls.length >= 2,
    'faction creation and invite acceptance must each use a scoped database transaction');

  const transactionalIdentityReads = source.match(/getCallerIdentity(?:ForServer)?\(\s*tx,[\s\S]*?\)/g) || [];
  assert.ok(transactionalIdentityReads.length >= 12,
    'all mutation families must keep caller authorization inside their transaction');
  for (const identityRead of transactionalIdentityReads) {
    assert.match(identityRead, /,\s*true\s*\)$/,
      'transactional caller authorization must lock its active membership evidence');
  }

  const inserts = source.match(/INSERT INTO faction_members[\s\S]*?VALUES\s*\([\s\S]*?\)/g) || [];
  assert.ok(inserts.length >= 3, 'all faction membership creation paths must remain covered');
  for (const insert of inserts) {
    assert.match(insert, /faction_members\s*\([^)]*guild_id/i,
      'every faction membership insert must persist the tenant guild identifier');
  }
}

async function testFactionFlagUrlValidationRejectsAttributeInjection() {
  const { router, restore } = await loadFactionRouter();
  const handler = finalHandler(router, '/:guildId', 'post');
  const unsafeUrls = [
    'https://static.wikia.nocookie.net/dayz_gamepedia/images/x.png" onerror=alert(1)',
    'https://static.wikia.nocookie.net/dayz_gamepedia/images/x.png?redirect=javascript:alert(1)',
    'https://static.wikia.nocookie.net/dayz_gamepedia/images/x.png#javascript:alert(1)',
  ];
  try {
    for (const flagUrl of unsafeUrls) {
      const res = responseRecorder();
      await handler({
        params: { guildId: 'guild-a' },
        body: {
          name: 'Safe name',
          tag: 'SAFE',
          flag_url: flagUrl,
        },
        user: { id: 'user-1', access_token: 'token' },
        app: { locals: { db: { get: async () => { throw new Error('database should not be reached'); } } } },
      }, res);
      assert.strictEqual(res.statusCode, 400, `unsafe flag URL must be rejected: ${flagUrl}`);
    }
  } finally {
    restore();
  }
}

async function run() {
  await testFactionMutationsRejectFactionFromAnotherGuild();
  await testFactionUiEscapesUntrustedValues();
  await testFactionMembershipInvariantMigration();
  await testFactionListScopesCallerMembershipToGuild();
  await testInviteAcceptanceLocksAndRevalidatesInviteInsideTransaction();
  await testInviteAcceptanceDeniesExpiredAndRevokedInvitesWithoutWrites();
  await testInviteCancellationLocksFactionBeforeAuthorizationAndDelete();
  await testPrivilegedMutationsLockAuthorizationInsideTransaction();
  await testOpenJoinLocksFactionAndRechecksStateInsideTransaction();
  await testMembershipAuthorizedWritesRevalidateInsideTransaction();
  await testInviteSendRejectsOpenFactionWithoutWriting();
  await testFactionCreationLocksAuthorizationInsideTransaction();
  await testFactionCreationClassifiesConcurrentMembershipConflict();
  await testFactionCreationPropagatesMembershipFailureFromTransaction();
  await testFactionWritesUseScopedTransactionsAndTenantColumns();
  await testFactionFlagUrlValidationRejectsAttributeInjection();
}

run()
  .then(() => console.log('Faction security tests passed'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
