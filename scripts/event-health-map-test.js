'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  getEventSpawnLocations,
  getEventHealth,
  parseEventHealthText,
} = require('../services/eventHealthService');

function byName(result, name) {
  const event = result.events.find(candidate => candidate.name === name);
  assert(event, `missing event ${name}`);
  return event;
}

function testCorrelatesAttemptsChildrenFailuresAndCleanup() {
  const text = [
    ' 0:00:01.000 Initializing of spawners done.',
    ' 0:00:02.000 !!! [CE][DE][GROUPS] (TrainLocked_Group) :: [WARNING] :: Example diagnostic.',
    ' 0:00:03.000 [CE][DE] [StaticTrainlocked] Spawning: EventID:[47] CurrentID:[289777] at [2025.1,249.5,11378.4] a: 0.000',
    ' 0:00:03.010 \t(group) Spawned StaticObj_Train_Container EventID:[47] CurrentID:[289777] at [2025.1,249.5,11378.4] a:0.000',
    ' 0:00:04.000 <cleanup> Depleted:"StaticObj_Train_Container" at [2025,11378] damage=1.00 DE="StaticTrainlocked"',
    ' 0:00:05.000 [CE][DE] [StaticTrainlocked] Spawning: EventID:[47] CurrentID:[289778] at [3000.0,250.0,12000.0] a: 1.000',
    ' 0:00:05.010 \tspawn refused... too close to another one.',
    ' 0:00:05.020 !!! [CE][VehicleRespawner] (PRITrainlocked) :: Respawning: "StaticTrainlocked" - Failed to spawn the requested amount (0 < 1) within 3 attempts.',
    ' 0:00:06.000 Init sequence finished',
  ].join('\n');

  const result = parseEventHealthText(text, {
    fileName: 'DayZServer_X1_x64_2026-08-24_02-58-50.RPT',
    configuredEvents: [{ name: 'StaticTrainlocked', group: 'TrainLocked_Group', positions: 12 }],
  });
  const event = byName(result, 'StaticTrainlocked');

  assert.strictEqual(result.startupComplete, true);
  assert.strictEqual(event.configured, true);
  assert.strictEqual(event.positions, 12);
  assert.strictEqual(event.attempts, 2);
  assert.strictEqual(event.successfulInstances, 1);
  assert.strictEqual(event.spawnedChildren, 1);
  assert.strictEqual(event.refusals, 1);
  assert.strictEqual(event.lastRefusal.observedAt, '2026-08-24T02:58:55.010Z');
  assert.strictEqual(event.failures, 1);
  assert.strictEqual(event.cleanupObservations, 1);
  assert.strictEqual(event.diagnostics.length, 1);
  assert.strictEqual(event.status, 'degraded');
  assert.strictEqual(event.presence, 'unknown');
  assert.match(event.lastSuccess.observedAt, /^2026-08-24T02:58:53\.010Z$/);
}

function testUsesAuthoritativeSessionStartForRuntimeChronology() {
  const result = parseEventHealthText([
    '0:00:02 [CE][DE] [VehicleRental] Spawning: EventID:[1] CurrentID:[2] at [1.0,2.0,3.0] a: 0.000',
    '0:00:03 (child) Spawned Car EventID:[1] CurrentID:[2] at [1.0,2.0,3.0]',
  ].join('\n'), {
    fileName: 'DayZServer_X1_x64_2026-09-01_18-35-17.RPT',
    sessionStartedAtMs: Date.parse('2026-09-01T22:35:21.000Z'),
  });
  const event = byName(result, 'VehicleRental');
  assert.strictEqual(event.lastAttempt.observedAt, '2026-09-01T22:35:19.000Z');
  assert.strictEqual(event.lastSuccess.observedAt, '2026-09-01T22:35:20.000Z');
}

function testProviderClockResidualCannotMoveEvidencePastCheckout() {
  const result = parseEventHealthText([
    '0:00:02 [CE][DE] [VehicleRental] Spawning: EventID:[1] CurrentID:[2] at [1.0,2.0,3.0] a: 0.000',
    '0:00:03 (child) Spawned Car EventID:[1] CurrentID:[2] at [1.0,2.0,3.0]',
  ].join('\n'), {
    fileName: 'DayZServer_X1_x64_2026-09-01_18-35-17.RPT',
    sessionStartedAtMs: Date.parse('2026-09-01T22:44:17.000Z'),
  });
  assert.strictEqual(byName(result, 'VehicleRental').lastSuccess.observedAt,
    '2026-09-01T22:35:20.000Z',
    'accepted provider residual must not shift runtime evidence later than the timezone-normalized RPT clock');
}

function testDoesNotTreatAnAttemptAsASuccess() {
  const result = parseEventHealthText([
    ' 0:00:01 Initializing of spawners done.',
    ' 0:00:02 [CE][DE] [StaticTrainlocked] Spawning: EventID:[47] CurrentID:[1] at [1.0,2.0,3.0] a: 0.000',
    ' 0:00:02 \tspawn refused... too close to another one.',
    ' 0:00:03 Init sequence finished',
  ].join('\n'), {
    fileName: 'DayZServer_X1_x64_2026-08-24_02-58-50.RPT',
    configuredEvents: [{ name: 'StaticTrainlocked', group: null, positions: 12 }],
  });
  const event = byName(result, 'StaticTrainlocked');

  assert.strictEqual(event.successfulInstances, 0);
  assert.strictEqual(event.status, 'warning');
  assert.strictEqual(event.refusals, 1);
  assert.strictEqual(event.presence, 'unknown');
}

function testDoesNotAttributeUnrelatedRefusalToOldAttempt() {
  const result = parseEventHealthText([
    '0:00:01 [CE][DE] [StaticTrainlocked] Spawning: EventID:[47] CurrentID:[1] at [1.0,2.0,3.0] a: 0.000',
    '0:00:02 unrelated runtime line',
    '0:00:03 spawn refused... too close to another one.',
  ].join('\n'));
  const event = byName(result, 'StaticTrainlocked');
  assert.strictEqual(event.refusals, 0, 'an unrelated later refusal must not degrade the previous event');
  assert.strictEqual(event.status, 'attempted');
}

function testSpawnPositionsDoNotClaimCompleteConfiguration() {
  const result = parseEventHealthText('', {
    configuredEvents: [{ name: 'StaticTrainlocked', positions: 2 }],
  });
  const event = byName(result, 'StaticTrainlocked');
  assert.strictEqual(event.status, 'positioned');
  assert.strictEqual(event.configurationEvidence, 'spawn_positions_only');
}

function testBoundsExpandedRptEvidence() {
  const diagnostics = Array.from({ length: 20 }, (_, index) =>
    `0:00:${String(index).padStart(2, '0')} !!! [CE][DE] [StaticTrainlocked] WARNING diagnostic ${index}`
  );
  const result = parseEventHealthText(diagnostics.join('\n'));
  assert.ok(byName(result, 'StaticTrainlocked').diagnostics.length <= 8,
    'cached event results must retain only a bounded diagnostic window');

  const events = Array.from({ length: 513 }, (_, index) =>
    `0:00:01 [CE][DE] [Event${index}] Spawning: EventID:[${index + 1}] CurrentID:[1] at [1.0,2.0,3.0] a: 0.000`
  );
  assert.throws(() => parseEventHealthText(events.join('\n')), /event limit/i,
    'RPT-derived event cardinality must be bounded before caching');

  const longItemClass = 'X'.repeat(10000);
  const cleanup = parseEventHealthText(
    `0:00:01 <cleanup> Depleted:"${longItemClass}" at [1,2] damage=1.00 DE="StaticTrainlocked"`
  );
  assert.ok(byName(cleanup, 'StaticTrainlocked').lastCleanup.itemClass.length <= 512,
    'cleanup evidence strings must remain bounded before caching');
}

async function testLoadsExactServerMissionAndNewestRpt() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'event-health-'));
  try {
    const mission = path.join(root, 'dayzxb_missions', 'dayzOffline.enoch');
    const config = path.join(root, 'config');
    fs.mkdirSync(mission, { recursive: true });
    fs.mkdirSync(config, { recursive: true });
    fs.writeFileSync(path.join(mission, 'cfgeventspawns.xml'), [
      '<?xml version="1.0"?>',
      '<eventposdef>',
      '  <event name="StaticTrainlocked">',
      '    <pos x="1" z="2" a="3" group="TrainLocked_Group" />',
      '    <pos x="4" z="5" a="6" group="TrainLocked_Group_2" />',
      '  </event>',
      '</eventposdef>',
    ].join('\n'));
    fs.writeFileSync(path.join(config, 'DayZServer_X1_x64_2026-08-23_02-58-50.RPT'), 'older');
    fs.writeFileSync(path.join(config, 'DayZServer_X1_x64_2026-08-24_02-58-50.RPT'), [
      '0:00:01 Initializing of spawners done.',
      '0:00:02 [CE][DE] [StaticTrainlocked] Spawning: EventID:[47] CurrentID:[2] at [1.0,2.0,3.0] a: 0.000',
      '0:00:02 (group) Spawned TrainCar EventID:[47] CurrentID:[2] at [1.0,2.0,3.0] a:0.000',
      '0:00:03 Init sequence finished',
    ].join('\n'));

    const result = await getEventHealth(root, 'enoch', {
      missionSubdirs: ['dayzxb_missions'],
      sessionStartedAt: '2026-08-24T06:58:50.000Z',
    });
    const event = byName(result, 'StaticTrainlocked');
    assert.strictEqual(result.sourceFile, 'DayZServer_X1_x64_2026-08-24_02-58-50.RPT');
    assert.strictEqual(event.positions, 2);
    assert.strictEqual(event.group, 'TrainLocked_Group');
    assert.deepStrictEqual(event.groups, ['TrainLocked_Group', 'TrainLocked_Group_2']);
    assert.strictEqual(event.status, 'spawned');
    assert.strictEqual(result.chronologyVerified, true);
    assert.strictEqual(event.lastSuccess.observedAt, '2026-08-24T06:58:52.000Z');
    assert.strictEqual(result.presenceLimitation, 'DayZ logs do not prove that a spawned event is still present.');
    assert.match(result.runtimeEvidenceLimitation, /does not prove which mission\/map produced it/i);

    const retainedPreviousSession = await getEventHealth(root, 'enoch', {
      missionSubdirs: ['dayzxb_missions'],
      sessionStartedAt: '2026-08-24T06:58:50.000Z',
      expectedSourceFile: 'DayZServer_X1_x64_2026-08-24_01-00-00.RPT',
    });
    assert.strictEqual(retainedPreviousSession.chronologyVerified, false,
      'a retained RPT not named by the restart ledger must fail chronology closed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testRejectsAmbiguousMissionConfiguration() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'event-health-ambiguous-mission-'));
  try {
    for (const missionName of ['dayzOffline.enoch', 'custom.enoch']) {
      const mission = path.join(root, 'dayzxb_missions', missionName);
      fs.mkdirSync(mission, { recursive: true });
      fs.writeFileSync(path.join(mission, 'cfgeventspawns.xml'),
        `<eventposdef><event name="${missionName}"><pos x="1" z="2"/></event></eventposdef>`);
    }
    const result = await getEventHealth(root, 'enoch', { missionSubdirs: ['dayzxb_missions'] });
    assert.strictEqual(result.events.length, 0,
      'ambiguous mission directories must not select arbitrary configuration evidence');
    assert.match(result.configurationError, /Multiple mission configurations match map enoch/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testEventSpawnLocationsRejectAmbiguousMissionConfiguration() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'event-spawns-ambiguous-mission-'));
  try {
    for (const missionName of ['dayzOffline.enoch', 'custom.enoch']) {
      const mission = path.join(root, 'dayzxb_missions', missionName);
      fs.mkdirSync(mission, { recursive: true });
      fs.writeFileSync(path.join(mission, 'cfgeventspawns.xml'),
        `<eventposdef><event name="${missionName}"><pos x="1" z="2" a="3"/></event></eventposdef>`);
    }
    const result = getEventSpawnLocations(root, 'enoch', { missionSubdirs: ['dayzxb_missions'] });
    assert.deepStrictEqual(result.events, [], 'ambiguous missions must not return an arbitrary map overlay');
    assert.match(result.configurationError, /Multiple mission configurations match map enoch/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testBoundsMissionConfigurationInputAndExpansion() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'event-spawns-bounds-'));
  const mission = path.join(root, 'dayzxb_missions', 'dayzOffline.enoch');
  fs.mkdirSync(mission, { recursive: true });
  const filePath = path.join(mission, 'cfgeventspawns.xml');
  try {
    fs.writeFileSync(filePath, Buffer.alloc((8 * 1024 * 1024) + 1, 32));
    assert.throws(
      () => getEventSpawnLocations(root, 'enoch', { missionSubdirs: ['dayzxb_missions'] }),
      /Mission configuration exceeds/i,
      'mission XML bytes must be capped before parsing'
    );

    const events = Array.from({ length: 513 }, (_, index) =>
      `<event name="Event${index}"><pos x="1" z="2" a="3"/></event>`
    ).join('');
    fs.writeFileSync(filePath, `<eventposdef>${events}</eventposdef>`);
    assert.throws(
      () => getEventSpawnLocations(root, 'enoch', { missionSubdirs: ['dayzxb_missions'] }),
      /Mission configuration event limit/i,
      'mission event expansion must be bounded'
    );

    const positions = '<pos x="1" z="2" a="3" group="G"/>'.repeat(4097);
    fs.writeFileSync(filePath, `<eventposdef><event name="Event">${positions}</event></eventposdef>`);
    assert.throws(
      () => getEventSpawnLocations(root, 'enoch', { missionSubdirs: ['dayzxb_missions'] }),
      /Mission configuration position limit/i,
      'per-event position and group expansion must be bounded'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testRejectsSymlinkedMissionDirectory() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'event-health-symlink-'));
  const serverRoot = path.join(parent, 'server');
  const outsideMission = path.join(parent, 'outside-mission');
  fs.mkdirSync(path.join(serverRoot, 'dayzxb_missions'), { recursive: true });
  fs.mkdirSync(outsideMission, { recursive: true });
  fs.writeFileSync(path.join(outsideMission, 'cfgeventspawns.xml'),
    '<eventposdef><event name="OutsideEvent"><pos x="1" z="2"/></event></eventposdef>');
  fs.symlinkSync(outsideMission, path.join(serverRoot, 'dayzxb_missions', 'dayzOffline.enoch'));
  try {
    const result = await getEventHealth(serverRoot, 'enoch', {
      missionSubdirs: ['dayzxb_missions'],
    });
    assert.strictEqual(result.events.length, 0,
      'a mission directory symlink must not import another server or host path');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

async function testRejectsSymlinkedServerRoot() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'event-health-root-link-'));
  const outside = path.join(parent, 'outside');
  const linkedRoot = path.join(parent, 'server-link');
  fs.mkdirSync(path.join(outside, 'config'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'config', 'DayZServer_X1_x64_2026-08-24_02-58-50.RPT'),
    '0:00:01 Init sequence finished');
  fs.symlinkSync(outside, linkedRoot);
  try {
    await assert.rejects(
      getEventHealth(linkedRoot, 'enoch', { missionSubdirs: ['dayzxb_missions'] }),
      /Unsafe server download directory/
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

function testExactServerRouteContract() {
  const routePath = path.join(__dirname, '..', 'routes', 'eventHealth.js');
  const servicePath = path.join(__dirname, '..', 'services', 'eventHealthService.js');
  assert.ok(fs.existsSync(routePath), 'event health route module is missing');
  const source = fs.readFileSync(routePath, 'utf8');
  const serviceSource = fs.readFileSync(servicePath, 'utf8');
  const registration = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'registerRoutes.js'), 'utf8');
  assert.match(source, /ensurePlatformServerOwner/,
    'event health must require exact authorized provider-server access');
  assert.match(source, /req\.platformServerAccess\.discordGuildId/,
    'event health must derive the local guild directory from canonical authorization context');
  assert.match(source, /req\.platformServerAccess\.platformServerId/,
    'event health must derive the provider server ID from canonical authorization context');
  assert.match(source, /getGuildDownloadPath\(/,
    'event health must read the exact server download tree');
  assert.match(registration, /app\.use\('\/api\/event-health', ensureAuthenticated, eventHealthRoutes\)/,
    'event health route must be mounted behind authentication');
  assert.match(serviceSource, /new Worker\(/,
    'growing RPT parsing must run outside the main Node event loop');
  assert.match(serviceSource, /O_NOFOLLOW/,
    'mission XML must be opened without following a swapped symlink');
  assert.match(serviceSource, /fstatSync/,
    'mission XML identity must be verified on the opened descriptor');
  assert.match(serviceSource, /MAX_RPT_BYTES/,
    'RPT parsing must reject unbounded whole-file input');
  assert.match(serviceSource, /MAX_CACHE_ENTRIES/,
    'event-health cache growth must be bounded');
  assert.match(serviceSource, /MAX_CONCURRENT_WORKERS/,
    'concurrent full-RPT workers must be bounded');
  assert.match(serviceSource, /const cacheKey = `\$\{safeServerPath\}:\$\{signature\}`/,
    'in-flight deduplication must use the file/config signature rather than caller map names');
  const workerSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'eventHealthWorker.js'), 'utf8');
  assert.match(workerSource, /realpathSync\(`\/proc\/self\/fd\/\$\{fd\}`\)/,
    'the opened RPT descriptor must remain contained under the exact server root');
  assert.doesNotMatch(workerSource, /readFileSync\(fd/,
    'the worker must not read bytes appended after its verified size snapshot');
  assert.match(workerSource, /readSync\([\s\S]*expectedStat\.size/,
    'the worker must cap descriptor reads at the verified size snapshot');
  assert.doesNotMatch(serviceSource, /parseEventHealthText\(fs\.readFileSync\(rpt\.fullPath/,
    'event-health requests must not synchronously read and split the full active RPT');
}

function testMapsPreserveCoordinateStableTilesAndExposeEvidenceBackedData() {
  const tiles = require('../public/js/dayz-map-tiles.js');
  const tileSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'dayz-map-tiles.js'), 'utf8');
  assert.deepStrictEqual(tiles.tileFileCoordinates({ x: 0, y: -32, z: 0 }, 32), { x: 0, y: 0 });
  assert.deepStrictEqual(tiles.tileFileCoordinates({ x: 31, y: -1, z: 0 }, 32), { x: 31, y: 31 });
  assert.strictEqual(tiles.tileFileCoordinates({ x: 32, y: -1, z: 0 }, 32), null);
  assert.match(tileSource, /image\.onerror = null;[\s\S]*image\.src = EMPTY_TILE/,
    'a blocked fallback image must not recurse through the tile error handler');
  assert.match(tileSource, /image\.onload = null;[\s\S]*image\.src = EMPTY_TILE/,
    'a fallback tile must not invoke Leaflet completion twice');

  const adminClient = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'map.js'), 'utf8');
  const playerClient = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'player-map-standalone.js'), 'utf8');
  const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'map.html'), 'utf8');
  const playerHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'player-map.html'), 'utf8');
  const portalRoute = fs.readFileSync(path.join(__dirname, '..', 'routes', 'playerPortal.js'), 'utf8');
  const registration = fs.readFileSync(path.join(__dirname, '..', 'src', 'app', 'registerRoutes.js'), 'utf8');
  const mapRoute = portalRoute.slice(portalRoute.indexOf("router.get('/map-data/:identity_id'"),
    portalRoute.indexOf('\n});', portalRoute.indexOf("router.get('/map-data/:identity_id'")) + 4);

  for (const source of [adminClient, playerClient]) {
    assert.doesNotMatch(source, /DayzMapTiles\.create\(/,
      'maps must not stretch native tiles across negative overview zoom levels');
    assert.match(source, /for \(let y = 0; y < gridSize; y\+\+\)[\s\S]{0,700}L\.imageOverlay/,
      'maps must preserve the coordinate-stable native tile bounds until a real zoom pyramid exists');
    assert.match(source, /const flippedY = \(gridSize - 1\) - y;/,
      'map tile URLs must retain the DayZ north/south file flip');
    assert.match(source, /currentTiles\.forEach\([\s\S]{0,100}\.remove\(\)[\s\S]{0,30}\);\s*currentTiles = \[\];/,
      'map switches must remove every overlay from the previous map');
  }
  assert.match(adminClient, /const physicalTileSize = mapConfig\.physicalSize \|\| 512;/,
    'admin tiles without an explicit physical size must retain the known-good 512px overlap');
  assert.match(adminClient,
    /\[y \* advancement, x \* advancement\],[\s\S]{0,100}\[y \* advancement \+ physicalTileSize, x \* advancement \+ physicalTileSize\]/,
    'admin tile bounds must use advancement for origins and physical size for overlap');
  assert.match(playerClient,
    /\[y \* advancement, x \* advancement\],[\s\S]{0,100}\[y \* advancement \+ physicalSize, x \* advancement \+ physicalSize\]/,
    'player tile bounds must use advancement for origins and physical size for overlap');
  assert.match(adminClient, /DayzMapCoordinates\.worldToLeaflet\(\{ east, north \}, mapName\)/,
    'admin event coordinates must use the canonical world-to-map transform');
  assert.match(playerClient, /DayzMapCoordinates\.worldToLeaflet\(\{ east: posX, north: posNorth \}, mapName\)/,
    'player coordinates must use the canonical semantic east/north transform');
  for (const html of [adminHtml, playerHtml]) {
    assert.match(html, /dayz-map-coordinates\.js/,
      'map pages must load the canonical coordinate module before their renderer');
  }

  assert.match(adminClient, /fetch\('\/api\/event-health\?serverId=' /,
    'admin map must fetch the quick event-health endpoint');
  assert.match(adminClient, /option\.dataset\.guildId = String\(server\.guildId\)/,
    'admin server choices must retain the exact guild identifier');
  assert.match(adminClient, /[&]guildId=' \+ encodeURIComponent\(guildId\)/,
    'event health must send the selected exact guild with the provider server ID');
  assert.ok(adminClient.includes("server-active-mission/' + serverId + '?guildId=' + encodeURIComponent(guildId)"),
    'active mission discovery must send the exact selected guild');
  assert.ok(adminClient.includes("server-maps/' + serverId + '?guildId=' + encodeURIComponent(serverContext.guildId)"),
    'map discovery must send the exact selected guild');
  assert.match(adminClient, /event-spawns\/' \+ serverId \+ '\/' \+ mapName \+[\s\S]{0,120}encodeURIComponent\(serverContext\.guildId\)/,
    'event spawn loading must send the exact selected guild');
  assert.match(registration, /server-maps\/:serverId'[^\n]*ensurePlatformServerOwner/,
    'map discovery must use canonical exact-server authorization');
  assert.match(registration, /event-spawns\/:serverId\/:mapName'[^\n]*ensurePlatformServerOwner/,
    'event spawn loading must use canonical exact-server authorization');
  const eventSpawnRoute = registration.slice(
    registration.indexOf("app.get('/api/event-spawns/:serverId/:mapName'"),
    registration.indexOf("app.get('/api/detect-structure/:serverId'")
  );
  assert.match(eventSpawnRoute, /getEventSpawnLocations\(/,
    'event spawn loading must reuse ambiguity and descriptor-safe mission discovery');
  assert.doesNotMatch(eventSpawnRoute, /readFileSync|readdirSync|existsSync/,
    'event spawn loading must not bypass safe mission discovery with path-based reads');
  assert.match(registration, /getGuildToken\(db, req\.platformServerAccess\.discordGuildId\)/,
    'active mission must use the token from canonical authorized guild context');
  assert.match(adminClient, /eventHealthRequestId/,
    'stale event-health responses must not overwrite a newly selected server');
  assert.match(adminClient, /mapDiscoveryRequestId/,
    'stale map discovery must not load data for a previously selected server');
  assert.match(adminClient, /loadEventHealth\(serverId, mapName, guildId\)/,
    'event health must use the guild captured with the same server request context');
  assert.match(adminClient, /escapeHtml\(eventName\)/,
    'admin event-spawn popup names must escape provider/XML-derived markup');
  assert.match(adminClient, /escapeHtml\(name\)/,
    'radius-search event names must escape provider/XML-derived markup');
  assert.match(adminClient, /escapeHtml\(it\.item_class\)/,
    'loot item classes must escape log-derived markup');
  assert.match(adminClient, /contextGeneration/,
    'all map surfaces must reject responses from a previous server/map context');
  assert.match(adminClient, /lootHeatmapRequestId/,
    'overlapping loot heatmap requests must not overwrite newer results');
  assert.match(adminClient, /genericHeatmapRequestIds/,
    'parallel heatmap families must independently reject stale responses');
  const serverChangeHandler = adminClient.slice(
    adminClient.indexOf("document.getElementById('server-select').addEventListener"),
    adminClient.indexOf("document.getElementById('map-select').addEventListener")
  );
  assert.doesNotMatch(serverChangeHandler, /loadHeatmap\(\)|loadKillHeatmap\(\)|loadDeathHeatmap\(\)|loadMovementHeatmap\(\)/,
    'server switches must wait for selected-map discovery before loading scaled heatmaps');
  assert.match(adminClient, /if \(activeMission\)[\s\S]{0,120}loadEnabledHeatmaps\(\)/,
    'active-map discovery must load enabled heatmaps after establishing map context');
  assert.match(adminClient, /getActiveMission\(currentServer,\s*serverContext\.guildId\)/,
    'auto-refresh must retain the exact selected guild for active-mission discovery');
  assert.match(adminClient, /if \(!heatmapEnabled\) \{\s*lootHeatmapRequestId\+\+/,
    'disabling loot heatmap must invalidate its in-flight request');
  for (const statusId of ['kill-heatmap-status', 'death-heatmap-status', 'movement-heatmap-status']) {
    assert.ok(adminClient.includes(`genericHeatmapRequestIds['${statusId}'] =`),
      `disabling ${statusId} must invalidate its in-flight request`);
  }
  assert.match(adminClient, /catch \(error\)[\s\S]{0,250}event-health-results['"]\)\.replaceChildren\(\)/,
    'event-health failures must remove cards from the prior server context');
  assert.doesNotMatch(adminClient, /await loadEventHealth\(/,
    'event-health parsing must not delay initial lazy-map rendering');
  assert.match(adminHtml, /id="event-health-results"/,
    'admin map must show event health without opening marker popups');
  assert.doesNotMatch(`${adminClient}\n${adminHtml}`, /current-session/i,
    'newest retained RPT evidence must not be described as the current server session');
  assert.match(adminClient, /cleanup signals/,
    'event health must expose cleanup evidence without claiming the whole event disappeared');
  assert.match(adminClient, /runtimeEvidenceLimitation/,
    'event health must disclose that retained RPT evidence is not proven to match selected-map configuration');
  assert.match(adminClient, /refusals/,
    'event health must expose refused spawn attempts that require attention');
  assert.match(mapRoute, /FROM shop_order_items soi[\s\S]*JOIN shop_orders so[\s\S]*so\.identity_id = \?[\s\S]*so\.server_id = \?[\s\S]*so\.status = 'completed'/,
    'player purchase placements must be exact-identity, exact-server, completed orders');
  for (const column of ['soi.shop_item_id', 'soi.spawn_method', 'soi.ypr_x', 'so.checked_out_at']) {
    assert.ok(mapRoute.includes(column), `player purchase placements must query deployed column ${column}`);
  }
  assert.doesNotMatch(mapRoute, /spawn_method_snapshot|soi\.orientation|soi\.item_id|so\.completed_at/,
    'player purchase placements must not query nonexistent shop columns');
  assert.match(mapRoute, /purchases:/, 'player map response must include purchase placements');
  assert.match(playerClient, /layers\.purchases/, 'player map must render a distinct purchases layer');
  assert.match(playerHtml, /id="layer-purchases"/, 'player map must offer a purchases layer toggle');
  assert.match(playerHtml, /Decay health is unavailable from retained logs/,
    'player map must explain why it cannot claim flag, wall, or gate decay state');
  assert.match(playerClient, /Recorded purchase — not live presence/,
    'purchase markers must not claim that provider objects still exist');
  assert.match(playerClient, /'<b>' \+ escapeHtml\(label\)/,
    'structure popups must escape log-derived labels');
  assert.match(playerClient, /'Cause: ' \+ escapeHtml\(d\.deathType \|\| 'Unknown'\)/,
    'death popups must escape log-derived causes');
}

async function main() {
  testCorrelatesAttemptsChildrenFailuresAndCleanup();
  testUsesAuthoritativeSessionStartForRuntimeChronology();
  testProviderClockResidualCannotMoveEvidencePastCheckout();
  testDoesNotTreatAnAttemptAsASuccess();
  testDoesNotAttributeUnrelatedRefusalToOldAttempt();
  testSpawnPositionsDoNotClaimCompleteConfiguration();
  testBoundsExpandedRptEvidence();
  await testLoadsExactServerMissionAndNewestRpt();
  await testRejectsAmbiguousMissionConfiguration();
  await testEventSpawnLocationsRejectAmbiguousMissionConfiguration();
  testBoundsMissionConfigurationInputAndExpansion();
  await testRejectsSymlinkedMissionDirectory();
  await testRejectsSymlinkedServerRoot();
  testExactServerRouteContract();
  testMapsPreserveCoordinateStableTilesAndExposeEvidenceBackedData();
  console.log('✅ Event health parser tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
