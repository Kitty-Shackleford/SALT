'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const coordinates = require('../public/js/dayz-map-coordinates');
const { admTupleToWorld, worldVectorToWorld } = require('../utils/dayzCoordinates');

function approx(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`);
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function testMeasuredVanillaMapDefinitions() {
  for (const mapName of ['chernarusplus', 'enoch', 'sakhal']) {
    const definition = coordinates.getMapDefinition(mapName);
    assert.strictEqual(definition.gridSize, 32);
    assert.strictEqual(definition.physicalTileSize, 512);
    assert.strictEqual(definition.tileAdvancement, 480);
    assert.strictEqual(definition.tileOverlap, 32);
    assert.strictEqual(definition.imageWidth, 15392);
    assert.strictEqual(definition.imageHeight, 15392);
  }
  assert.strictEqual(coordinates.getMapDefinition('chernarusplus').worldWidth, 15360);
  assert.strictEqual(coordinates.getMapDefinition('enoch').worldWidth, 12800);
  assert.strictEqual(coordinates.getMapDefinition('sakhal').worldWidth, 15360);
  assert.strictEqual(coordinates.getMapDefinition('namalsk').size, 15424,
    'unverified maps must preserve their existing renderer extent');
  assert.strictEqual(coordinates.getMapDefinition('takistanplus').size, 12800,
    'unverified maps must preserve their existing renderer extent');
}

function testWorldLeafletTransformAndInverse() {
  const leaflet = coordinates.worldToLeaflet({ east: 4485.4, north: 9763.8 }, 'chernarusplus');
  approx(leaflet[0], 9763.8 * 15392 / 15360);
  approx(leaflet[1], 4485.4 * 15392 / 15360);
  approx(15392 - leaflet[0], (1 - 9763.8 / 15360) * 15392,
    1e-9, 'top-origin raster Y must be the image height minus Leaflet northing');

  const world = coordinates.leafletToWorld({ lat: leaflet[0], lng: leaflet[1] }, 'chernarusplus');
  approx(world.east, 4485.4);
  approx(world.north, 9763.8);
}

function testSourceAdaptersKeepAdmAndWorldVectorsDistinct() {
  assert.deepStrictEqual(
    admTupleToWorld({ posX: 4485.4, posY: 9763.8, posZ: 339.3 }),
    { east: 4485.4, north: 9763.8, elevation: 339.3 }
  );
  assert.deepStrictEqual(
    worldVectorToWorld({ x: 4485.4, y: 339.3, z: 9763.8 }),
    { east: 4485.4, north: 9763.8, elevation: 339.3 }
  );
  assert.throws(
    () => admTupleToWorld({ posX: 1, posZ: 2 }),
    /ADM posY must be a finite number/
  );
  assert.throws(
    () => coordinates.worldToLeaflet({ east: null, north: 1 }, 'chernarusplus'),
    /east must be a finite number/
  );
}

function testTileBoundsUseMeasuredAdvancementAndPhysicalSize() {
  assert.deepStrictEqual(
    coordinates.tileBounds(31, 31, 'chernarusplus'),
    [[14880, 14880], [15392, 15392]]
  );
  assert.deepStrictEqual(coordinates.tileFileCoordinates(0, 0, 'chernarusplus'), { x: 0, y: 31 });
  assert.deepStrictEqual(coordinates.tileFileCoordinates(31, 31, 'chernarusplus'), { x: 31, y: 0 });
}

function testEveryMapPageLoadsTheCentralCoordinateModuleFirst() {
  const pages = [
    ['public/map.html', '/js/map.js'],
    ['public/player-map.html', '/js/player-map-standalone.js'],
    ['public/loot-finder.html', '/js/loot-finder.js'],
    ['public/shop.html', '/js/shop.js'],
  ];
  for (const [pagePath, consumer] of pages) {
    const html = read(pagePath);
    const moduleIndex = html.indexOf('/js/dayz-map-coordinates.js');
    const consumerIndex = html.indexOf(consumer);
    assert.ok(moduleIndex >= 0 && moduleIndex < consumerIndex,
      `${pagePath} must load dayz-map-coordinates.js before ${consumer}`);
  }
}

async function testShopMapDiscoveryUsesTheAuthorizedInternalServer() {
  const shopSource = read('public/js/shop.js');
  assert.match(shopSource,
    /const serverId = currentServerId;[\s\S]{0,500}fetch\(`\/api\/shop\/maps\/\$\{serverId\}`\)/,
    'shop map discovery must use the captured exact internal server authorized by the shop router');
  assert.doesNotMatch(shopSource, /fetch\(`\/api\/server-maps\/\$\{currentServerId\}`\)/,
    'shop must not send an internal server ID to the owner-only provider-ID endpoint');
  assert.match(shopSource,
    /function switchShopMap\(mapName\)[\s\S]{0,900}loadShopMapTiles\(shopCurrentMapName\)[\s\S]{0,300}shopLeafletMap\.setView/,
    'shop terrain changes must replace the visible tiles and world extent');
  assert.match(shopSource,
    /const firstMap = json\.maps\[0\];[\s\S]{0,250}switchShopMap\(firstMap\)/,
    'opening the picker for a different server must switch existing map tiles');

  const shopRouter = require('../routes/shop');
  assert.ok(shopRouter.params.serverId?.length,
    'shop map discovery must retain the shop router exact-server authorization');
  const layer = shopRouter.stack.find(entry =>
    entry.route?.path === '/maps/:serverId' && entry.route.methods.get);
  assert.ok(layer, 'GET /shop/maps/:serverId route must exist');

  let query;
  const req = {
    playerServerAccess: { serverId: 42, guildId: 7 },
    app: { locals: { db: { get: async (sql, params) => {
      query = { sql, params };
      return null;
    } } } },
  };
  const result = {};
  const res = {
    status(code) { result.status = code; return this; },
    json(body) { result.body = body; return this; },
  };
  await layer.route.stack.at(-1).handle(req, res);
  assert.strictEqual(result.status, 404);
  assert.match(query.sql, /WHERE s\.id = \?/,
    'shop map discovery must resolve provider/log context from the authorized internal server');
  assert.deepStrictEqual(query.params, [42, 7]);
}

function testAdmBackedQueriesUseStoredNorthSlotAndTimestamp() {
  const heatmap = read('routes/mapHeatmap.js');
  assert.match(heatmap, /SPLIT_PART\(victim_position, ',', 2\)/);
  assert.doesNotMatch(heatmap, /SPLIT_PART\(victim_position, ',', 3\)[^\n]*AS cz/);
  assert.match(heatmap, /FLOOR\(pos_y \/ \$3\)[\s\S]*FROM player_death_events/);
  assert.match(heatmap, /FLOOR\(pos_y \/ \$3\)[\s\S]*FROM player_position_snapshots/);
  assert.match(heatmap,
    /FROM player_death_events[\s\S]*?WHERE server_id = \$1[\s\S]*?pos_x IS NOT NULL[\s\S]*?pos_y IS NOT NULL[\s\S]*?GROUP BY 1, 2/,
    'death heatmap must exclude incomplete ADM east/north pairs');
  assert.match(heatmap,
    /FROM player_position_snapshots[\s\S]*?WHERE server_id = \$1[\s\S]*?pos_x IS NOT NULL[\s\S]*?pos_y IS NOT NULL[\s\S]*?GROUP BY 1, 2/,
    'movement heatmap must exclude incomplete ADM east/north pairs');
  assert.match(heatmap, /AND timestamp >= NOW\(\)/);
  assert.doesNotMatch(heatmap, /recorded_at/);
  assert.doesNotMatch(heatmap, /ROUND\(/,
    'grid cells must use FLOOR so points remain inside the cell represented by its center');
  assert.match(heatmap, /FLOOR\(/);
}

function testRenderersUseTheCentralTransformWithoutLegacyVanillaGeometry() {
  for (const relativePath of [
    'public/js/map.js',
    'public/js/player-map-standalone.js',
    'public/js/player-map.js',
    'public/js/loot-finder.js',
    'public/js/shop.js',
  ]) {
    const source = read(relativePath);
    assert.match(source, /DayzMapCoordinates\.MAP_DEFINITIONS/,
      `${relativePath} must consume the central map definitions`);
    assert.match(source, /DayzMapCoordinates\.worldToLeaflet/,
      `${relativePath} must consume the central world-to-Leaflet transform`);
    assert.doesNotMatch(source, /size:\s*15424|tileSize:\s*482|advancement:\s*482/,
      `${relativePath} must not retain the disproven 15,424/482 geometry`);
  }

  const tileLayer = read('public/js/dayz-map-tiles.js');
  assert.match(tileLayer, /\|\| 480/,
    'the optional tile layer must default to the measured 480-pixel advancement');
  assert.doesNotMatch(tileLayer, /\|\| 482/);

  const legacyPlayerMap = read('public/js/player-map.js');
  for (const sourceName of ['ev', 'd', 'p', 'lastPos']) {
    assert.match(legacyPlayerMap, new RegExp(`${sourceName}\\.position\\.east`),
      `legacy player-map ${sourceName} path must consume the semantic API position`);
  }
  assert.doesNotMatch(legacyPlayerMap, /_gameToLeaflet\([^)]*\.posX,\s*[^)]*\.posY/,
    'legacy player-map must not reinterpret raw ADM tuple fields in the renderer');

  for (const relativePath of ['public/js/map.js', 'public/js/player-map-standalone.js']) {
    const source = read(relativePath);
    assert.match(source, /function addCoordinateGrid\(mapName\)/,
      `${relativePath} coordinate grid must be defined in world-space`);
    assert.match(source, /worldWidth/);
    assert.match(source, /worldHeight/);
    assert.doesNotMatch(source, /addCoordinateGrid\(size\)/,
      `${relativePath} must not label raster pixels as world metres`);
  }

  const standalonePlayerMap = read('public/js/player-map-standalone.js');
  assert.match(standalonePlayerMap, /let coordinateGridLayer = null;/,
    'standalone player map must retain the active coordinate-grid layer');
  assert.match(standalonePlayerMap,
    /if \(coordinateGridLayer\) map\.removeLayer\(coordinateGridLayer\);[\s\S]*coordinateGridLayer = L\.layerGroup\(\)\.addTo\(map\);/,
    'standalone player map must replace the previous coordinate grid');
  assert.match(standalonePlayerMap,
    /function switchMap\(mapName\)[\s\S]{0,200}addCoordinateGrid\(mapName\);/,
    'switching terrain must rebuild the coordinate grid with the new world scale');
  assert.match(standalonePlayerMap,
    /function switchMap\(mapName\)[\s\S]{0,500}layers\.factionMembers\.clearLayers\(\)[\s\S]{0,200}layers\.factionMarkers\.clearLayers\(\)[\s\S]{0,300}loadFactionMapData\(mapName\)/,
    'switching terrain must invalidate and reload faction overlays for the new map');
  assert.match(standalonePlayerMap,
    /setInterval\(function\(\) \{\s*loadFactionMapData\(currentMapName\);/,
    'faction polling must use the current terrain instead of capturing the bootstrap map');
  assert.match(standalonePlayerMap,
    /const requestId = \+\+factionMapRequestId;[\s\S]{0,500}requestId !== factionMapRequestId \|\| mapName !== currentMapName/,
    'stale faction requests must not repaint overlays after a map switch');
  assert.match(standalonePlayerMap,
    /function switchMap\(mapName\)[\s\S]{0,150}exitPlacementMode\(\)/,
    'switching terrain must cancel faction marker placement before coordinates can be saved');
  assert.match(standalonePlayerMap,
    /function switchMap\(mapName\)[\s\S]{0,300}clearPlayerMapLayers\(\)[\s\S]{0,500}loadPlayerData\(currentIdentityId\)/,
    'switching terrain must synchronously clear player overlays before replacement data loads');
  assert.match(standalonePlayerMap,
    /const playerLayerKeys = \[[\s\S]{0,180}'radarHeat'[\s\S]{0,50}\];[\s\S]{0,300}layers\[key\]\.clearLayers\(\)/,
    'terrain context clearing must cover every player-owned spatial layer, including radar heat');
  assert.match(standalonePlayerMap,
    /let playerDataRequestId = 0;[\s\S]*const requestId = \+\+playerDataRequestId;[\s\S]{0,700}requestId !== playerDataRequestId[\s\S]{0,200}mapName !== currentMapName/,
    'player map requests must reject stale responses after terrain changes and same-context reloads');
  assert.match(standalonePlayerMap,
    /if \(playerDataRequestInFlight\)[\s\S]{0,500}pendingPlayerDataLoad = \{ identityId, options, mapName, serverId \};[\s\S]*finally \{[\s\S]{0,500}loadPlayerData\(pending\.identityId, pending\.options\)/,
    'an in-flight request must queue the latest replacement load for a new terrain');

  const lootFinder = read('public/js/loot-finder.js');
  assert.match(lootFinder, /let lootContextGeneration = 0;/,
    'loot finder must track terrain/server context across asynchronous work');
  assert.match(lootFinder,
    /function resetMapForMapName\(mapName\)[\s\S]{0,200}invalidateLootContext\(\)/,
    'switching loot-finder terrain must invalidate pending work before repainting');
  assert.match(lootFinder,
    /await loadItemDetail\(mapName, item\.name[\s\S]{0,300}generation !== lootContextGeneration[\s\S]{0,150}mapName !== currentMapName/,
    'stale item details must not repaint spawn markers on a different terrain');
  assert.match(lootFinder,
    /await searchItems\(mapName,[\s\S]{0,300}generation !== lootContextGeneration[\s\S]{0,150}mapName !== currentMapName/,
    'stale searches must not repopulate results after a terrain switch');
  assert.match(lootFinder,
    /await loadCategories\(mapName, generation\);\s*if \(generation !== lootContextGeneration \|\| mapName !== currentMapName\) return;/,
    'terrain changes must guard the category-load boundary before starting a search');
  assert.match(lootFinder,
    /function clearLootContextUi\(\)[\s\S]{0,600}clearElement\(dom\.itemList\)[\s\S]{0,300}renderEmptyItemDetail\(\)[\s\S]{0,400}populateSelect\(dom\.filterCategory, \[\], 'All categories'\)/,
    'server and terrain changes must immediately clear item, detail, marker, and filter state');
  assert.match(lootFinder,
    /function clearLiveContextUi\(\)[\s\S]{0,500}renderLiveEconomyHealth\(null\)[\s\S]{0,200}renderLiveCandidates\(\[\]\)[\s\S]{0,200}renderLiveSpawnFeed\(\[\]\)/,
    'server and terrain changes must immediately clear context-derived live data');
  assert.match(lootFinder,
    /function clearLiveContextUi\(\)[\s\S]{0,500}dom\.liveLastUpdated\.textContent = ''/,
    'context clearing must remove the previous server timestamp immediately');
  assert.match(lootFinder,
    /function handleServerSelectorChange\(\)[\s\S]{0,250}clearLootContextUi\(\)[\s\S]{0,100}clearLiveContextUi\(\)/,
    'server selection must clear previous-server finder and live data before discovery awaits');
  assert.match(lootFinder,
    /function handleMapSelectorChange\(\)[\s\S]{0,250}clearLootContextUi\(\)[\s\S]{0,100}clearLiveContextUi\(\)/,
    'terrain selection must clear previous-terrain finder and live data before category loading');
  assert.match(lootFinder,
    /function handleServerSelectorChange\(\)[\s\S]*?triggerSearch\(\);\s*if \(isAdmin && !dom\.panelLive\.classList\.contains\('hidden'\)\) \{\s*refreshLivePanel\(\)/,
    'server selection must refresh an open live panel after the new context loads');
  assert.match(lootFinder,
    /let searchRequestId = 0;[\s\S]*let liveRequestId = 0;/,
    'same-context search and live requests must have independent ordering identities');
  assert.match(lootFinder,
    /const requestId = \+\+searchRequestId;[\s\S]{0,700}requestId !== searchRequestId/,
    'older same-context searches must not overwrite newer results');
  assert.match(lootFinder,
    /const requestId = \+\+liveRequestId;[\s\S]{0,700}requestId !== liveRequestId/,
    'older same-context live requests must not overwrite newer results');
  assert.match(lootFinder,
    /\/api\/loot\/live\?serverId=\$\{encodeURIComponent\(serverId\)\}&map=/,
    'live loot requests must carry the selected exact server context');

  const lootRoutes = read('routes/lootFinder.js');
  assert.match(lootRoutes,
    /router\.get\('\/live'[\s\S]{0,300}requireServer\(req, res\)[\s\S]{0,300}getLiveSpawns\(mapName, server\.guildDiscordId, server\.serverId\)/,
    'live loot route must authorize and resolve the selected server');

  const liveLootService = read('services/lootLiveService.js');
  assert.match(liveLootService,
    /function getLogDir\(guildDiscordId, serverId\)[\s\S]{0,300}getGuildDownloadPath\(guildDiscordId, serverId\)[\s\S]{0,150}'config'/,
    'live loot files must resolve from the exact server download directory');
  assert.match(liveLootService,
    /const cacheKey = `\$\{guildDiscordId\}:\$\{serverId\}:\$\{mapName\}`/,
    'live loot cache entries must be isolated by guild, server, and terrain');
}

function testCalibrationAuditMeasuresTheRuntimeConfiguration() {
  const output = childProcess.execFileSync(process.execPath, [
    path.join(root, 'scripts/coordinate-calibration-audit.js'),
  ], { encoding: 'utf8' });
  const results = output.trim().split('\n').map(line => JSON.parse(line));
  const sakhal = results.find(result => result.map === 'sakhal');

  assert.ok(sakhal, 'calibration audit must include Sakhal');
  assert.ok(sakhal.currentConfiguredPixelError.max < 0.02,
    'currentConfiguredPixelError must measure the repaired runtime map definition');
  assert.ok(sakhal.previousConfiguredPixelError.mean > 2000,
    'audit must label the obsolete Sakhal world-size error as previous configuration');
}

function testAdmApiBoundariesExposeSemanticWorldPositions() {
  const playerPortal = read('routes/playerPortal.js');
  const factions = read('routes/factions.js');
  assert.match(playerPortal, /admTupleToWorld/);
  assert.match(playerPortal, /position:\s*admTupleToWorld/);
  assert.match(factions, /admTupleToWorld/);
  assert.match(factions, /position:\s*member\.pos_x[\s\S]{0,100}admTupleToWorld/);

  const playerMap = read('public/js/player-map-standalone.js');
  assert.match(playerMap, /gameToLeaflet\(ev\.position\.east, ev\.position\.north, mapName\)/);
  assert.match(playerMap, /gameToLeaflet\(lp\.position\.east, lp\.position\.north, mapName\)/);
  assert.match(playerMap, /gameToLeaflet\(m\.position\.east, m\.position\.north, mapName\)/);

  const locationCommand = read('bot/commands/location.js');
  assert.match(locationCommand, /require\('\.\.\/\.\.\/utils\/dayzCoordinates'\)/);
  assert.match(locationCommand,
    /FROM player_position_snapshots[\s\S]*ps\.pos_x IS NOT NULL[\s\S]*ps\.pos_y IS NOT NULL/,
    'Discord location lookup must reject snapshots without ADM east/north slots');
  assert.match(locationCommand, /res\.rows\[0\]\.pos_x != null && res\.rows\[0\]\.pos_y != null/,
    'Discord health fallback must reject rows without ADM east/north slots');
  assert.match(locationCommand, /const worldPosition\s*=\s*admTupleToWorld\(location\)/);
  assert.match(locationCommand,
    /worldPosition\.elevation == null\s*\?\s*'Unknown'\s*:\s*`\$\{Math\.round\(worldPosition\.elevation\)\}m`/,
    'Discord location output must not invent a zero elevation when ADM elevation is absent');
  assert.match(locationCommand,
    /Z: \$\{Math\.round\(worldPosition\.north\)\}.*Elev: \$\{elevation\}/,
    'Discord location output must not present ADM elevation as northing');
}

async function testPlayerMapQueuesLatestContextAcrossRapidTerrainSwitches() {
  const source = read('public/js/player-map-standalone.js');
  const sourceWithoutBootstrap = source.slice(0, source.indexOf('// Bootstrap —'));
  const elements = new Map();
  const fetches = [];

  function deferred() {
    let resolve;
    const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
    return { promise, resolve };
  }

  const context = {
    console,
    DayzMapCoordinates: {
      MAP_DEFINITIONS: { chernarusplus: { name: 'Chernarus' }, enoch: { name: 'Livonia' } },
      worldToLeaflet() { return [0, 0]; },
      leafletToWorld() { return { east: 0, north: 0 }; },
    },
    window: {},
    document: {
      addEventListener() {},
      getElementById(id) {
        if (!elements.has(id)) {
          elements.set(id, {
            style: {},
            classList: { add() {}, remove() {}, contains() { return false; } },
            textContent: '',
            value: '',
          });
        }
        return elements.get(id);
      },
    },
    fetch(url) {
      const response = deferred();
      fetches.push({ url, response });
      return response.promise;
    },
    async fetchWithCsrf() {
      return { ok: false, json: async () => ({ success: false }) };
    },
    setInterval() {},
    clearInterval() {},
    confirm() { return false; },
    alert() {},
  };
  vm.createContext(context);
  vm.runInContext(sourceWithoutBootstrap, context);
  vm.runInContext(`
    currentMapName = 'chernarusplus';
    currentServerId = 'server-1';
    currentIdentityId = 'identity-1';
    this.plottedResponses = [];
    plotData = function(data) { plottedResponses.push(data.marker); };
  `, context);

  const firstLoad = vm.runInContext("loadPlayerData('identity-1')", context);
  vm.runInContext("currentMapName = 'enoch'; loadPlayerData('identity-1');", context);
  vm.runInContext("currentMapName = 'chernarusplus'; loadPlayerData('identity-1');", context);
  assert.strictEqual(fetches.length, 1, 'terrain changes must not overlap the active player request');

  fetches[0].response.resolve({ json: async () => ({ success: true, marker: 'stale-a' }) });
  await firstLoad;
  assert.strictEqual(fetches.length, 2,
    'A→B→A during an invalidated A request must fetch a fresh latest-context A response');
  assert.deepStrictEqual(Array.from(context.plottedResponses), [],
    'the invalidated first A response must not render');

  fetches[1].response.resolve({ json: async () => ({ success: true, marker: 'fresh-a' }) });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepStrictEqual(Array.from(context.plottedResponses), ['fresh-a']);
  assert.strictEqual(elements.get('loading').style.display, 'none',
    'the latest replacement request must clear the loading overlay');
}

async function main() {
  testMeasuredVanillaMapDefinitions();
  testWorldLeafletTransformAndInverse();
  testSourceAdaptersKeepAdmAndWorldVectorsDistinct();
  testTileBoundsUseMeasuredAdvancementAndPhysicalSize();
  testEveryMapPageLoadsTheCentralCoordinateModuleFirst();
  await testShopMapDiscoveryUsesTheAuthorizedInternalServer();
  testAdmBackedQueriesUseStoredNorthSlotAndTimestamp();
  testRenderersUseTheCentralTransformWithoutLegacyVanillaGeometry();
  testCalibrationAuditMeasuresTheRuntimeConfiguration();
  testAdmApiBoundariesExposeSemanticWorldPositions();
  await testPlayerMapQueuesLatestContextAcrossRapidTerrainSwitches();
  console.log('Map coordinate regression tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
