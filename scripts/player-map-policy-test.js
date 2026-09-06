'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const policyPath = path.join(root, 'utils', 'playerMapPolicy.js');
assert.ok(fs.existsSync(policyPath), 'player-map policy module is missing');

const {
  PLAYER_MAP_FEATURES,
  parsePlayerMapSettings,
  projectPlayerMapPayload,
  projectPlayerHealthPayload,
} = require(policyPath);

const defaults = parsePlayerMapSettings(null);
assert.deepStrictEqual(defaults.enabledFeatures, [...PLAYER_MAP_FEATURES],
  'an absent legacy policy must preserve existing player-map features');
assert.deepStrictEqual(parsePlayerMapSettings('{malformed').enabledFeatures, [],
  'a present malformed policy must fail closed');
assert.deepStrictEqual(parsePlayerMapSettings({}).enabledFeatures, [],
  'a present policy without an allowlist must fail closed');

const restricted = parsePlayerMapSettings(JSON.stringify({
  enabledFeatures: ['lastPosition', 'deaths', 'unknown', 'lastPosition'],
}));
assert.deepStrictEqual(restricted.enabledFeatures, ['deaths', 'lastPosition'],
  'player-map settings must normalize to a known, deterministic allowlist');

const payload = projectPlayerMapPayload({
  playerName: 'Self',
  territory: [{ id: 1 }],
  deaths: [{ id: 2 }],
  trail: [{ id: 3 }],
  purchases: [{ id: 4 }],
  lastPosition: { id: 5 },
}, restricted);
assert.deepStrictEqual(payload.enabledFeatures, ['deaths', 'lastPosition']);
assert.deepStrictEqual(payload.deaths, [{ id: 2 }]);
assert.deepStrictEqual(payload.lastPosition, { id: 5 });
assert.strictEqual(payload.territory, undefined, 'disabled structures must not cross the API boundary');
assert.strictEqual(payload.trail, undefined, 'disabled trails must not cross the API boundary');
assert.strictEqual(payload.purchases, undefined, 'disabled purchases must not cross the API boundary');
const projectedHealth = projectPlayerHealthPayload({
  status: 'healthy', lastPosition: '1 2 3', posX: 1, posY: 2, posZ: 3,
}, { enabledFeatures: [] });
assert.deepStrictEqual(projectedHealth, { status: 'healthy' },
  'health projection must remove camel-case position fields before serialization');

const portalRoute = fs.readFileSync(path.join(root, 'routes', 'playerPortal.js'), 'utf8');
const mapRoute = portalRoute.slice(
  portalRoute.indexOf("router.get('/map-data/:identity_id'"),
  portalRoute.indexOf('\n});', portalRoute.indexOf("router.get('/map-data/:identity_id'")) + 4
);
assert.match(mapRoute, /loadPlayerMapSettings\(db, serverId\)/,
  'player map must load the exact-server player-map policy');
assert.match(mapRoute, /projectPlayerMapPayload/,
  'player map must project disabled fields away before serialization');
assert.match(portalRoute, /router\.get\('\/health\/:identity_id\/:server_id'[\s\S]*projectPlayerHealthPayload/,
  'server-specific health responses must not bypass last-position policy');
const healthRoute = portalRoute.slice(
  portalRoute.indexOf("router.get('/health/:identity_id'"),
  portalRoute.indexOf('\n});', portalRoute.indexOf("router.get('/health/:identity_id'")) + 4
);
assert.match(healthRoute, /loadPlayerMapSettings\(db, serverId\)/,
  'health responses must load the exact-server player-map policy');
assert.match(healthRoute, /projectPlayerHealthPayload/,
  'health responses must remove disabled position fields before serialization');
assert.match(portalRoute, /router\.get\('\/territory\/:identity_id'[\s\S]*isPlayerMapFeatureEnabled[\s\S]*structures/,
  'territory responses must not bypass structures policy');
assert.match(portalRoute, /router\.get\('\/territory\/:identity_id\/stats'[\s\S]*isPlayerMapFeatureEnabled[\s\S]*structures/,
  'territory statistics must not bypass structures policy');
assert.match(mapRoute, /WHERE so\.identity_id = \?[\s\S]*AND so\.server_id = \?/,
  'purchase placement data must remain exact-player and exact-server scoped');
assert.match(mapRoute,
  /ORDER BY ps\.timestamp DESC, ps\.id DESC[\s\S]*LIMIT 500[\s\S]*ORDER BY recent\.timestamp ASC, recent\.id ASC/,
  'movement trails must use the newest bounded snapshots and then draw them chronologically');

const factionRoute = fs.readFileSync(path.join(root, 'routes', 'factions.js'), 'utf8');
assert.match(factionRoute, /feature_name = 'player_map'/,
  'faction map must enforce the exact-server player-map policy server-side');
assert.match(factionRoute, /factionMembers'\)[\s\S]*\? await db\.all\([\s\S]*\) : \[\]/,
  'disabled teammate locations must be omitted at the server boundary');
assert.match(factionRoute, /factionMarkers'\)[\s\S]*\? await db\.all\([\s\S]*\) : \[\]/,
  'disabled faction markers must be omitted at the server boundary');

assert.match(factionRoute, /JOIN server_player_memberships spm[\s\S]*spm\.identity_id = fmem\.identity_id[\s\S]*spm\.server_id = \?[\s\S]*spm\.status = 'active'/,
  'teammate locations must be limited to active exact-server members');
assert.match(factionRoute, /INSERT INTO faction_markers[\s\S]*server_id/,
  'new faction markers must be bound to the exact server');
assert.match(factionRoute, /router\.post\('\/:guildId\/:factionId\/markers'[\s\S]*factionMarkers[\s\S]*isPlayerMapFeatureEnabled/,
  'marker creation must enforce the exact-server feature policy');
assert.match(factionRoute, /router\.put\('\/:guildId\/:factionId\/markers\/:markerId'[\s\S]*server_id/,
  'marker edits must remain bound to the marker server');

const markerMigrationPath = path.join(root, 'db', 'migrations', '069_faction_markers_server_scope.js');
assert.ok(fs.existsSync(markerMigrationPath), 'exact-server faction marker migration is missing');
const markerMigration = fs.existsSync(markerMigrationPath) ? fs.readFileSync(markerMigrationPath, 'utf8') : '';
assert.match(markerMigration, /ADD COLUMN IF NOT EXISTS server_id/,
  'faction markers need a canonical server key');

const settingsRoute = fs.readFileSync(path.join(root, 'routes', 'playerMapSettings.js'), 'utf8');
assert.match(settingsRoute, /requireServerCapability\(CAPABILITIES\.SERVER_MANAGE\)/,
  'only exact-server managers may change player-map settings');
assert.match(settingsRoute, /lockAndVerifyLinkSettingsManager/,
  'player-map mutations must revalidate manager authority in-transaction');
assert.match(settingsRoute, /player_map\.policy_changed/,
  'player-map policy mutations must be audited');

const registration = fs.readFileSync(path.join(root, 'src', 'app', 'registerRoutes.js'), 'utf8');
assert.match(registration, /app\.use\('\/api\/player-map-settings'/,
  'player-map settings route must be registered');

const settingsHtml = fs.readFileSync(path.join(root, 'public', 'dashboard', 'settings.html'), 'utf8');
const settingsClient = fs.readFileSync(path.join(root, 'public', 'js', 'nitrado-settings.js'), 'utf8');
assert.match(settingsHtml, /id="playerMapSettingsCard"/);
assert.match(settingsClient, /\/api\/player-map-settings\/\$\{internalServerId\}/);
assert.match(settingsClient, /settingsLoadGeneration/,
  'settings loads need a monotonic context generation');
assert.match(settingsClient, /loadServerNaming\(serverId, guildId, loadGeneration\)/,
  'naming loads must share the selected-server generation');
assert.match(settingsClient, /loadLinkVerification\(selectedOption\.dataset\.internalServerId, loadGeneration\)/,
  'link-policy loads must share the selected-server generation');
assert.match(settingsClient, /loadPlayerMapSettings\(selectedOption\.dataset\.internalServerId, loadGeneration\)/,
  'player-map policy loads must share the selected-server generation');

const playerMapHtml = fs.readFileSync(path.join(root, 'public', 'player-map.html'), 'utf8');
const playerMapClient = fs.readFileSync(path.join(root, 'public', 'js', 'player-map-standalone.js'), 'utf8');
assert.match(playerMapClient, /applyEnabledFeatures\(data\.enabledFeatures/,
  'player map controls must reflect the server-authoritative feature policy');
assert.match(playerMapHtml, /data-player-map-feature="purchases"/,
  'player-map feature controls must have stable policy keys');

const migrationPath = path.join(root, 'db', 'migrations', '068_player_position_lookup_index.js');
assert.ok(fs.existsSync(migrationPath), 'player-position lookup index migration is missing');
const migrationSource = fs.readFileSync(migrationPath, 'utf8');
assert.match(migrationSource,
  /ON player_position_snapshots \(server_id, identity_id, timestamp DESC, id DESC\)/,
  'latest-position queries need an exact-server, exact-identity ordered index');

console.log('player map policy tests passed');
