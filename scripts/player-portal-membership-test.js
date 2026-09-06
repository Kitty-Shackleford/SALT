'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const portalPath = path.join(__dirname, '..', 'routes', 'playerPortal.js');
const portalClientPath = path.join(__dirname, '..', 'public', 'js', 'player-portal.js');
const playerMapClientPath = path.join(__dirname, '..', 'public', 'js', 'player-map-standalone.js');
const privateRoutes = [
  '/stats',
  '/leaderboard/:guild_id',
  '/sessions/:identity_id',
  '/sessions/:identity_id/stats',
  '/health/:identity_id',
  '/damage/:identity_id',
  '/damage/:identity_id/weapons',
  '/damage/:identity_id/weapons/category',
  '/damage/:identity_id/top-threats',
  '/damage/:identity_id/weapon-types',
  '/damage/:identity_id/bodyparts',
  '/damage/:identity_id/bodyparts/:body_part',
  '/health/:identity_id/:server_id',
  '/territory/:identity_id',
  '/territory/:identity_id/stats',
  '/map-data/:identity_id',
  '/favorite-weapons/:identity_id',
  '/recent-kills/:identity_id',
  '/recent-deaths/:identity_id',
  '/location-heatmap/:identity_id',
  '/playtime-breakdown/:identity_id',
  '/achievements/:identity_id',
  '/achievement-progress/:identity_id',
  '/performance-timeline/:identity_id',
  '/death-stats/:identity_id',
  '/emotes/:identityId',
  '/session-analytics',
];

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function handlerFor(router, routePath) {
  const layer = router.stack.find(entry => entry.route && entry.route.path === routePath);
  assert.ok(layer, `route ${routePath} must exist`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function invoke(handler, req) {
  const res = responseRecorder();
  await handler(req, res, error => { if (error) throw error; });
  return res;
}

async function main() {
  const source = fs.readFileSync(portalPath, 'utf8');
  const clientSource = fs.readFileSync(portalClientPath, 'utf8');
  const mapClientSource = fs.readFileSync(playerMapClientPath, 'utf8');
  assert.ok(source.includes('server_player_memberships'), 'portal must use active exact-server memberships');
  assert.ok(source.includes("spm.status = 'active'"), 'portal membership evidence must be active');
  assert.ok(source.includes('spm.source_link_id = la.id'), 'membership must remain bound to its source link');
  assert.ok(source.includes('servers: serversByGuild.get(String(guild.guild_id)) || []'),
    'guild discovery must return only the authorized exact servers available for selection');

  assert.ok(clientSource.includes('let currentServerId = null;'),
    'the portal must retain an exact selected server');
  assert.ok(clientSource.includes('function playerApiUrl('),
    'private player requests need one canonical exact-server URL builder');
  assert.ok(clientSource.includes('data-server-id="${escAttr(server.id)}"'),
    'community choices must carry an authorized canonical server ID');
  assert.ok(clientSource.includes('selectGuild(guildId, guildName, serverId, serverName)'),
    'selecting a community must also select its exact server');
  assert.ok(clientSource.includes('data-guild-name="${escAttr(guild.guild_name)}"'),
    'guild names used in data attributes must be attribute-escaped');
  assert.ok(clientSource.includes('data-server-name="${escAttr(server.name)}"'),
    'server names used in data attributes must be attribute-escaped');
  assert.ok(clientSource.includes('escAttr(safeImageUrl(guild.icon_url))'),
    'guild icon attributes must use an allowlisted URL and attribute escaping');
  const helperSource = clientSource.slice(0, clientSource.indexOf('function playerApiUrl'));
  const helperContext = { URL };
  vm.runInNewContext(`${helperSource}
    this.attributeValue = escAttr('x" onclick="alert(1)<tag>');
    this.rejectedImageUrl = safeImageUrl('javascript:alert(1)');
    this.allowedImageUrl = safeImageUrl('https://cdn.discordapp.com/icons/example.png');`, helperContext);
  assert.strictEqual(helperContext.attributeValue, 'x&quot; onclick=&quot;alert(1)&lt;tag&gt;',
    'hostile guild/server names must not terminate an HTML attribute');
  assert.strictEqual(helperContext.rejectedImageUrl, '', 'non-HTTPS guild icon URLs must be rejected');
  assert.strictEqual(helperContext.allowedImageUrl, 'https://cdn.discordapp.com/icons/example.png',
    'HTTPS guild icon URLs must remain usable');
  assert.ok(!clientSource.includes('data-gamertag="${escHtml('),
    'stored gamertags in data attributes must not use text-only escaping');
  assert.ok(!clientSource.includes('data-platform="${escHtml('),
    'stored platforms in data attributes must not use text-only escaping');
  assert.ok(!/fetch\(`\/api\/player\/(?:stats|leaderboard|sessions|health|damage|territory|favorite-weapons|recent-kills|recent-deaths|playtime-breakdown|achievements|performance-timeline|death-stats|emotes)/.test(clientSource),
    'private player requests must not bypass exact-server URL construction');
  assert.ok(clientSource.includes("'&serverId=' + encodeURIComponent(currentServerId)"),
    'the player map link must preserve the exact selected server');
  assert.ok(mapClientSource.includes("params.get('serverId')"),
    'the standalone player map must read the exact server selection');
  assert.ok(mapClientSource.includes('const serverId = currentServerId;') &&
    mapClientSource.includes("'?serverId=' + encodeURIComponent(serverId)"),
  'the standalone player map API request must capture and enforce its exact server scope');

  assert.ok(source.includes("router.param('identity_id', requirePlayerServerMembership)"));
  assert.ok(source.includes("router.param('identityId', requirePlayerServerMembership)"));
  assert.ok(!source.includes('router.use(requirePlayerServerMembership)'),
    'router-wide guard would run before route params are populated');
  for (const routePath of privateRoutes) {
    const marker = `router.get('${routePath}'`;
    const start = source.indexOf(marker);
    assert.notStrictEqual(start, -1, `${routePath} must exist`);
    const hasIdentityParam = routePath.includes(':identity_id') || routePath.includes(':identityId');
    if (!hasIdentityParam) {
      const routeSource = source.slice(start, source.indexOf('async (req, res)', start));
      assert.ok(routeSource.includes('requirePlayerServerMembership'), `${routePath} needs a route-local guard`);
    }
  }

  const router = require(portalPath);
  const guardLayer = { handle: router.params.identity_id[0] };
  assert.ok(guardLayer.handle, 'identity param membership guard must be registered');
  const guilds = handlerFor(router, '/guilds');
  const stats = handlerFor(router, '/stats');
  const mapData = handlerFor(router, '/map-data/:identity_id');

  let guildQueryCount = 0;
  const guildResponse = await invoke(guilds, {
    user: { id: 9, access_token: null },
    app: { locals: { db: {
      query: async (sql, params) => {
        guildQueryCount += 1;
        assert.deepStrictEqual(params, [9]);
        if (guildQueryCount === 1) {
          return [{ guild_id: 'guild-a', guild_name: 'Guild A', server_count: 1, player_count: 1 }];
        }
        assert.ok(sql.includes('spm.user_id = ?') && sql.includes("spm.status = 'active'"));
        return [{ guild_id: 'guild-a', id: 22, name: 'Chernarus' }];
      },
    } } },
  });
  assert.strictEqual(guildResponse.statusCode, 200);
  assert.deepStrictEqual(guildResponse.body.guilds[0].servers, [{ id: 22, name: 'Chernarus' }],
    'guild discovery must return only exact servers authorized by active player membership');

  let dataQueryRan = false;
  const crossServerReq = {
    user: { id: 9 },
    query: { serverId: '22' },
    params: {},
    app: { locals: { db: {
      get: async (sql, params) => {
        assert.ok(sql.includes('server_player_memberships'));
        assert.ok(sql.includes("spm.status = 'active'"));
        assert.ok(sql.includes('spm.source_link_id = la.id'));
        assert.ok(sql.includes('la.verification_method IN'));
        assert.ok(sql.includes("s.status = 'active'"));
        assert.ok(sql.includes("g.status = 'approved'"));
        assert.deepStrictEqual(params, [9, 22]);
        return null;
      },
      query: async () => { dataQueryRan = true; return []; },
    } } },
  };
  const denied = await invoke(guardLayer.handle, crossServerReq);
  assert.strictEqual(denied.statusCode, 403, 'membership on another guild/server must not grant stats access');
  assert.strictEqual(dataQueryRan, false, 'private data query must not run after cross-server denial');

  const missingServer = await invoke(guardLayer.handle, {
    user: { id: 9 }, query: {}, params: {},
    app: { locals: { db: { get: async () => { throw new Error('database must not be queried'); } } } },
  });
  assert.strictEqual(missingServer.statusCode, 400, 'private stats require explicit exact server selection');

  let scopedSql;
  let scopedParams;
  let guardAdvanced = false;
  const allowedReq = {
    user: { id: 9 }, query: { serverId: '22' }, params: {},
    app: { locals: { db: {
      get: async () => ({ server_id: 22, guild_id: 3, identity_id: 77 }),
      query: async (sql, params) => { scopedSql = sql; scopedParams = params; return []; },
    } } },
  };
  await guardLayer.handle(allowedReq, responseRecorder(), () => { guardAdvanced = true; });
  assert.ok(guardAdvanced, 'active exact-server membership must advance to the data handler');
  const allowed = await invoke(stats, allowedReq);
  assert.strictEqual(allowed.statusCode, 200);
  assert.ok(scopedSql.includes('ke.server_id = ?') && scopedSql.includes('ps.server_id = ?'));
  assert.ok(scopedParams.every(value => value === 9 || value === 22), 'stats parameters must stay on the selected user/server');

  let mapAllCall = 0;
  const mapResponse = await invoke(mapData, {
    params: { identity_id: '77' },
    query: { serverId: '22' },
    playerServer: { id: 22, identityId: 77 },
    app: { locals: { db: {
      all: async (sql, params) => {
        mapAllCall += 1;
        if (mapAllCall === 2) {
          assert.ok(sql.includes('de.server_id = ?'),
            'death-map SQL must scope through its own de alias');
          assert.ok(!sql.includes('te.server_id = ?'),
            'death-map SQL must not reference the territory-event alias');
        }
        if (mapAllCall === 3) {
          assert.ok(sql.includes('so.identity_id = ?') && sql.includes('so.server_id = ?'),
            'purchase placements must remain bound to the linked identity and exact server');
          assert.deepStrictEqual(params, [77, 22]);
        }
        return [];
      },
      get: async () => null,
    } } },
  });
  assert.strictEqual(mapResponse.statusCode, 200, 'map data must execute with alias-correct exact-server SQL');
  assert.strictEqual(mapAllCall, 4,
    'map data must query territory, deaths, purchase placements, and position trail');

  console.log('✅ Player portal exact-server membership tests passed');
}

main().catch(error => {
  console.error(`❌ ${error.stack || error.message}`);
  process.exit(1);
});
