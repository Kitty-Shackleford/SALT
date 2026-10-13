'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const catalogPath = path.join(root, 'public', 'js', 'map-layer-catalog.js');
assert.ok(fs.existsSync(catalogPath), 'shared map-layer catalog is missing');

const catalog = require(catalogPath);
const chernarus = catalog.getSettlementLayers('chernarusplus');
assert.strictEqual(chernarus.labels.length, 77, 'Chernarus must expose all capital/city/village labels');
assert.strictEqual(catalog.SETTLEMENT_SOURCE.authority, 'CfgWorlds.ChernarusPlus.Names');
assert.strictEqual(chernarus.extents.length, 77, 'every settlement label needs an approximate display extent');
assert.deepStrictEqual(
  chernarus.labels.filter(item => item.kind === 'capital').map(item => item.id),
  ['Settlement_Chernogorsk', 'Settlement_Novodmitrovsk']
);
const cherno = chernarus.labels.find(item => item.id === 'Settlement_Chernogorsk');
assert.deepStrictEqual(cherno.names, { en: 'Chernogorsk', cy: 'Черногорск' });
assert.deepStrictEqual(cherno.position, { east: 6778.6191, north: 2321.7739 });
assert.strictEqual(chernarus.extents.find(item => item.id === cherno.id).radiusMeters, 300);
assert(chernarus.extents.every(item => item.accuracy === 'approximate'));
assert(chernarus.extents.every(item => item.geometry === 'display-radius'));
assert.strictEqual(catalog.getSettlementLayers('enoch').labels.length, 0,
  'Chernarus-first layers must not be projected onto other terrains');

const territory = require(path.join(root, 'services', 'factionTerritoryService.js'));
assert.strictEqual(territory.FLAG_POLE_RADIUS_METERS, 60);
assert.deepStrictEqual(
  territory.validateTerritorySubmission({ mapName: 'CHERNARUSPLUS', poleEast: 1.25, poleNorth: 15360 }),
  { mapName: 'chernarusplus', poleEast: 1.25, poleNorth: 15360 }
);
for (const invalid of [
  { mapName: 'enoch', poleEast: 10, poleNorth: 10 },
  { mapName: 'chernarusplus', poleEast: -1, poleNorth: 10 },
  { mapName: 'chernarusplus', poleEast: 10, poleNorth: 15361 },
  { mapName: 'chernarusplus', poleEast: '10', poleNorth: 10 },
  { mapName: 'chernarusplus', poleEast: 10, poleNorth: 10, radiusMeters: 200 },
]) assert.throws(() => territory.validateTerritorySubmission(invalid), TypeError);
assert.strictEqual(territory.nextTerritoryStatus('pending', 'approved'), 'approved');
assert.strictEqual(territory.nextTerritoryStatus('pending', 'rejected'), 'rejected');
assert.strictEqual(territory.nextTerritoryStatus('approved', 'revoked'), 'revoked');
assert.throws(() => territory.nextTerritoryStatus('rejected', 'approved'), /transition/i);

const policy = require(path.join(root, 'utils', 'playerMapPolicy.js'));
assert(policy.PLAYER_MAP_FEATURES.includes('factionTerritories'));
assert(!policy.parsePlayerMapSettings(null).enabledFeatures.includes('factionTerritories'),
  'new privacy-sensitive territory visibility must default off for legacy policies');
assert(policy.parsePlayerMapSettings({ enabledFeatures: ['factionTerritories'] })
  .enabledFeatures.includes('factionTerritories'));

const migrationPath = path.join(root, 'db', 'migrations', '091_faction_territories.js');
assert.ok(fs.existsSync(migrationPath), 'faction territory migration is missing');
const migration = fs.readFileSync(migrationPath, 'utf8');
for (const contract of [
  'CREATE TABLE IF NOT EXISTS faction_territories',
  'FOREIGN KEY (server_id, guild_id)',
  'FOREIGN KEY (faction_id, guild_id)',
  "CHECK (radius_m = 60)",
  "status IN ('pending', 'approved', 'rejected', 'revoked')",
  "WHERE status IN ('pending', 'approved')",
  'submitted_by_server_membership_id',
  'submitted_by_faction_membership_id',
  'server_membership_territory_provenance_uq',
  'faction_membership_territory_provenance_uq',
]) assert(migration.includes(contract), `migration is missing: ${contract}`);

const factionsRoute = fs.readFileSync(path.join(root, 'routes', 'factions.js'), 'utf8');
assert.match(factionsRoute, /router\.post\('\/:guildId\/:factionId\/territories'/);
assert.match(factionsRoute, /membership\.rank !== 'leader'/);
const factionMapHandler = factionsRoute.slice(
  factionsRoute.indexOf("router.get('/:guildId/:factionId/map'"),
  factionsRoute.indexOf("router.post('/:guildId/:factionId/territories'")
);
assert.match(factionMapHandler, /db\.transaction/);
assert.match(factionMapHandler, /lockCallerTerritoryAuthority/);
assert.match(factionMapHandler, /getFactionMembershipForUpdate/);
const territorySubmissionHandler = factionsRoute.slice(
  factionsRoute.indexOf("router.post('/:guildId/:factionId/territories'"),
  factionsRoute.indexOf("router.get('/:guildId/:factionId/map-data'")
);
assert(territorySubmissionHandler.indexOf('lockUserRoleMutations(tx, [userId])') >= 0,
  'territory submission must acquire the user mutation lock');
assert(territorySubmissionHandler.indexOf('lockUserRoleMutations(tx, [userId])') <
  territorySubmissionHandler.indexOf('lockActiveServer(tx'),
  'territory submission must acquire the user mutation lock before row locks');
assert.match(factionsRoute, /factionTerritories/);
assert.match(factionsRoute, /status = 'approved'/);

const staffRoutePath = path.join(root, 'routes', 'factionTerritories.js');
assert.ok(fs.existsSync(staffRoutePath), 'staff territory review route is missing');
const staffRoute = fs.readFileSync(staffRoutePath, 'utf8');
assert.match(staffRoute, /SERVER_MODERATE/);
assert.match(staffRoute, /authorizeServerMutation/);
assert.match(staffRoute, /lockUserRoleMutations/);
const staffListHandler = staffRoute.slice(
  staffRoute.indexOf("router.get('/:serverId'"),
  staffRoute.indexOf("router.patch('/:serverId/:territoryId'")
);
assert.match(staffListHandler, /\.transaction\(/,
  'staff territory reads must revalidate authority inside a transaction');
assert.match(staffListHandler, /lockUserRoleMutations/);
assert.match(staffListHandler, /authorizeServerMutation/);
assert.match(staffRoute, /expectedVersion/);
const territoryServiceSource = fs.readFileSync(path.join(root, 'services', 'factionTerritoryService.js'), 'utf8');
assert.match(territoryServiceSource, /security_audit_events/);

const registration = fs.readFileSync(path.join(root, 'src', 'app', 'registerRoutes.js'), 'utf8');
assert.match(registration, /app\.use\('\/api\/faction-territories'/);

const staffClient = fs.readFileSync(path.join(root, 'public', 'js', 'map.js'), 'utf8');
const playerClient = fs.readFileSync(path.join(root, 'public', 'js', 'player-map-standalone.js'), 'utf8');
for (const source of [staffClient, playerClient]) {
  assert.match(source, /settlementLabels/);
  assert.match(source, /settlementExtents/);
  assert.match(source, /factionTerritories/);
  assert.match(source, /radiusMeters/);
}
assert.match(playerClient, /submit.*Territory/i);
assert.match(playerClient, /currentFactionRank === 'leader'/);
assert.match(playerClient, /catch \(error\) \{[\s\S]*?context\.serverId === String\(currentServerId\)[\s\S]*?if \(!stillCurrent\) return;[\s\S]*?alert\(error\.message\)/,
  'stale territory submission failures must not surface after a context switch');
assert.doesNotMatch(staffClient, /DayZMapCoordinates/);
assert.match(staffClient, /catch \(error\) \{\s*if \(generation !== contextGeneration\) return;\s*alert\(error\.message\)/,
  'stale territory review failures must not surface after a context switch');
const clearContextSource = staffClient.slice(
  staffClient.indexOf('function clearSelectedContext()'),
  staffClient.indexOf('// Event listeners')
);
assert.match(clearContextSource, /geographyLayers/);
assert.match(clearContextSource, /currentTiles\.forEach\(tile => tile\.remove\(\)\)/);
assert.match(clearContextSource, /currentTiles = \[\]/);
assert.match(staffClient, /review.*Territory/i);

const staffHtml = fs.readFileSync(path.join(root, 'public', 'map.html'), 'utf8');
const playerHtml = fs.readFileSync(path.join(root, 'public', 'player-map.html'), 'utf8');
for (const html of [staffHtml, playerHtml]) {
  assert.match(html, /not official boundaries/i);
}

console.log('map governance tests passed');
