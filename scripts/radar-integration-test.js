'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const migrationPath = path.join(root, 'db/migrations/070_radar_capabilities.js');
assert.ok(fs.existsSync(migrationPath), 'radar capability migration is missing');
const migration = fs.existsSync(migrationPath) ? fs.readFileSync(migrationPath, 'utf8') : '';
for (const contract of [
  'capability_config',
  'capability_config_snapshot',
  'radar_activations',
  'radar_synthetic_events',
  'order_item_id',
  'source_type',
]) {
  assert.match(migration, new RegExp(contract), `migration must define ${contract}`);
}
assert.match(migration,
  /DROP CONSTRAINT IF EXISTS shop_items_spawn_method_check[\s\S]*CHECK \(spawn_method IN \([^)]*'capability'/,
  'radar migration must allow capability products through the shop spawn-method constraint');

assert.match(migration,
  /FOREIGN KEY \(membership_id, server_id, guild_id, user_id, identity_id, source_link_id\)[\s\S]*REFERENCES server_player_memberships/,
  'activation provenance must bind membership, server, guild, user, identity, and source link together');
assert.match(migration,
  /FOREIGN KEY \(order_item_id, order_id\)[\s\S]*REFERENCES shop_order_items/,
  'activation provenance must bind its immutable line item to the same order');
assert.match(migration,
  /FOREIGN KEY \(activation_id, server_id, guild_id, purchaser_identity_id\)[\s\S]*REFERENCES radar_activations/,
  'synthetic audit records must inherit exact activation provenance');

const shop = source('routes/shop.js');
assert.match(shop, /normalizeRadarCapabilityConfig/,
  'shop administration must validate radar capability products');
assert.match(shop, /capability_config_snapshot/,
  'cart creation must snapshot capability configuration');

const checkout = source('services/shopFileService.js');
assert.match(checkout, /activateRadarCapabilities/,
  'checkout must activate purchased radar capabilities');
assert.match(checkout, /spawn_method !== 'capability'/,
  'capability products must not be provisioned into mission files');
assert.match(checkout, /spawn_method\s*=\s*'capability'[\s\S]*SET status = 'expired', revoked_at = clock_timestamp\(\)/,
  'rental cleanup must expire capability provenance with a trusted audit timestamp and no Nitrado file writes');
assert.match(checkout, /SET status = 'refunded'[\s\S]*order_item_id IN/,
  'refunds must retain terminal capability provenance');

const radarServicePath = path.join(root, 'services/radarService.js');
assert.ok(fs.existsSync(radarServicePath), 'radar runtime service is missing');
const radarService = fs.existsSync(radarServicePath) ? require(radarServicePath) : {};
assert.strictEqual(typeof radarService.getPlayerRadarResponse, 'function');
assert.strictEqual(typeof radarService.getTrustedRadarAudit, 'function');
assert.strictEqual(typeof radarService.generateSyntheticEvents, 'function');
const radarSource = source('services/radarService.js');
assert.match(radarSource, /JOIN server_player_memberships jammer_membership[\s\S]*jammer_membership\.status = 'active'/,
  'jammer effects must require current exact-server owner authority');
assert.match(radarSource, /JOIN factions f ON f\.id = fm\.faction_id[\s\S]*f\.guild_id = s\.guild_id/,
  'jammer audiences must resolve factions inside the exact server guild');
assert.match(radarSource,
  /const eventBucket = [^;]+;[\s\S]*generateSyntheticEvents\([\s\S]*bucket: eventBucket[\s\S]*persistSyntheticEvents\(db, jammer, events, eventBucket\)/,
  'activation-persistent deception must generate and persist under one stable activation bucket');

const synthetic = radarService.generateSyntheticEvents({
  activationId: 11,
  displayName: 'Purchaser',
  config: {
    capability: 'jammer',
    jammerScope: 'area',
    jammerEffect: 'deceive',
    jammerTargets: 'everyone',
    radiusMeters: 100,
    deceptionActions: ['emote', 'ping'],
    deceptionPersistence: 'transient',
  },
  center: { east: 1000, north: 2000 },
  bucket: '2026-08-31T12:00:00.000Z',
});
assert.deepStrictEqual(synthetic.map(event => event.action), ['emote', 'ping']);
assert.ok(synthetic.every(event => event.displayName === 'Purchaser'));
assert.ok(synthetic.every(event => event.source === undefined),
  'player-facing synthetic events must not reveal trusted provenance');
const repeated = radarService.generateSyntheticEvents({
  activationId: 11,
  displayName: 'Purchaser',
  config: {
    capability: 'jammer', jammerScope: 'area', jammerEffect: 'deceive',
    jammerTargets: 'everyone', radiusMeters: 100,
    deceptionActions: ['emote', 'ping'], deceptionPersistence: 'transient',
  },
  center: { east: 1000, north: 2000 },
  bucket: '2026-08-31T12:00:00.000Z',
});
assert.deepStrictEqual(repeated, synthetic, 'synthetic jammer output must be deterministic per bucket');

const radarRoute = source('routes/radar.js');
assert.match(radarRoute, /router\.post\('\/player\/:serverId\/:identityId', ensurePlayerServerAccess/,
  'stateful player radar scans must use exact-player authorization and a CSRF-protected mutation method');
assert.match(radarRoute, /getPlayerRadarResponse/);
assert.match(radarRoute, /router\.get\('\/admin\/:serverId', ensureServerAccess/,
  'trusted radar audit endpoint must require exact-server management authority');
assert.match(radarRoute, /getTrustedRadarAudit/);

const registration = source('src/app/registerRoutes.js');
assert.match(registration, /app\.use\('\/api\/radar'/,
  'radar routes must be registered');

const mapClient = source('public/js/player-map-standalone.js');
assert.match(mapClient, /fetchWithCsrf\('\/api\/radar\/player\/'[\s\S]*method: 'POST'/,
  'player map must perform stateful exact-server radar scans through CSRF protection');
assert.match(mapClient, /function plotRadarData\(radarData, mapName\) \{\s*if \(!layers\.radar \|\| !layers\.radarHeat\) return;/,
  'radar rendering must tolerate test and partial-map contexts without initialized layers');
assert.match(mapClient, /layers\.radar/,
  'player map must render radar output in a dedicated layer');
assert.match(source('public/player-map.html'), /leaflet-heat\.js[\s\S]*id="radar-status"[\s\S]*id="radar-presence-list"/,
  'player map must provide a visible radar status, presence list, and heat rendering support');
assert.match(mapClient, /const radarPromise = loadRadarData\([\s\S]*await Promise\.all\(\[mapDataPromise, radarPromise\]\)/,
  'radar loading must start in parallel with the heavier player map request');
assert.match(mapClient, /L\.heatLayer\([\s\S]*layers\.radarHeat/,
  'position-bearing radar returns must render an obvious heat overlay');
assert.match(mapClient, /radar-presence-list[\s\S]*entry\.presence/,
  'presence-only radar results must remain visibly represented');

const shopAdmin = source('public/js/shop-admin.js');
const shopAdminHtml = source('public/dashboard/shop-admin.html');
assert.match(shopAdmin, /capability_config/,
  'shop administration must submit capability configuration');
assert.match(shopAdminHtml, /item-capability-panel/,
  'shop administration must expose capability configuration controls');
assert.match(shopAdmin, /\/api\/radar\/admin\//,
  'dashboard administrators must be able to consume trusted jammer provenance');
assert.match(shopAdminHtml, /radar-audit-tbody/,
  'dashboard must render trusted radar and jammer audit records');

const botAuditPath = path.join(root, 'bot', 'commands', 'radar-audit.js');
assert.ok(fs.existsSync(botAuditPath), 'bot trusted radar audit consumer is missing');
const botAudit = fs.existsSync(botAuditPath) ? fs.readFileSync(botAuditPath, 'utf8') : '';
assert.match(botAudit, /radar_synthetic_events/,
  'bot radar audit must consume synthetic jammer provenance directly');
assert.match(botAudit, /source_type/,
  'bot radar audit must identify jammer provenance');
assert.match(source('bot/utils/commandAuthorization.js'), /'radar-audit': 'server_manage'/,
  'bot radar audit must require exact-server management authority');

async function testFullMapRadarDoesNotWaitForViewerPosition() {
  const targetQueries = [];
  const db = {
    async get(sql) {
      if (sql.includes('FROM server_player_memberships spm')) {
        return { membership_id: 41, guild_id: 7, source_link_id: 51 };
      }
      if (sql.includes('FROM player_position_snapshots')) return undefined;
      throw new Error(`Unexpected get query: ${sql}`);
    },
    async query(sql) {
      if (sql.includes('FROM radar_activations ra') && sql.includes('ra.user_id = ?')) {
        return [{
          id: 61,
          effective_config: JSON.stringify({
            capability: 'radar',
            radarRevealMode: 'presence',
            radiusMeters: null,
          }),
        }];
      }
      if (sql.includes('FROM radar_activations ra')) return [];
      if (sql.includes('FROM player_position_snapshots')) {
        targetQueries.push(sql);
        return [{
          identity_id: 99,
          pos_x: 5000,
          pos_y: 6000,
          timestamp: '2026-09-05T12:00:00.000Z',
          player_name: 'Observed Player',
        }];
      }
      if (sql.includes('FROM faction_members fm')) return [];
      throw new Error(`Unexpected query: ${sql}`);
    },
    async run() {
      throw new Error('Full-map radar read must not write synthetic events without jammers');
    },
  };

  const result = await radarService.getPlayerRadarResponse(db, {
    userId: 12,
    identityId: 88,
    serverId: 34,
    now: '2026-09-05T12:05:00.000Z',
  });

  assert.strictEqual(result.enabled, true);
  assert.strictEqual(result.stale, false,
    'full-map radar must become usable immediately without waiting for a viewer position snapshot');
  assert.deepStrictEqual(result.targets.map(target => target.identityId), [99],
    'radar must reveal fresh observed players even when they do not have active dashboard memberships');
  assert.strictEqual(result.targets[0].presence, true);
  assert.strictEqual(result.targets[0].observedAt, '2026-09-05T12:00:00.000Z',
    'presence-only contacts must retain freshness evidence for a truthful visible status');
  assert.strictEqual(targetQueries.length, 1,
    'full-map radar must query fresh position observations directly');
  assert.doesNotMatch(targetQueries[0], /FROM server_player_memberships spm/,
    'radar targets must not be restricted to dashboard-linked members');
}

async function testRadiusRadarStillRequiresViewerPosition() {
  const db = {
    async get(sql) {
      if (sql.includes('FROM server_player_memberships spm')) {
        return { membership_id: 41, guild_id: 7, source_link_id: 51 };
      }
      if (sql.includes('FROM player_position_snapshots')) return undefined;
      throw new Error(`Unexpected get query: ${sql}`);
    },
    async query(sql) {
      if (sql.includes('FROM radar_activations ra')) {
        return [{
          id: 61,
          effective_config: JSON.stringify({
            capability: 'radar',
            radarRevealMode: 'exact',
            radiusMeters: 1000,
          }),
        }];
      }
      throw new Error(`Radius radar must stop before target queries: ${sql}`);
    },
  };

  const result = await radarService.getPlayerRadarResponse(db, {
    userId: 12,
    identityId: 88,
    serverId: 34,
    now: '2026-09-05T12:05:00.000Z',
  });
  assert.deepStrictEqual(result, { enabled: true, stale: true, targets: [], activity: [] },
    'radius-limited radar must fail closed when the viewer location is stale');
}

(async () => {
  await testFullMapRadarDoesNotWaitForViewerPosition();
  await testRadiusRadarStillRequiresViewerPosition();
  console.log('radar integration tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
