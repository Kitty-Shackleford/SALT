/*
 * player-map-standalone.js
 *
 * Standalone player map viewer — mirrors the admin map.js approach exactly.
 * Leaflet is initialised immediately at page load on a fully-rendered container,
 * then player data is fetched from /api/player/map-data/:identityId.
 *
 * URL params:
 *   ?identityId=<id>   — the player identity to display (required)
 *   ?serverId=<id>     — authorized internal server to display (required)
 *   ?mapName=<name>    — initial map (optional, defaults to chernarusplus)
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let map = null;
let currentTiles = [];
let currentMapName = null;
let currentIdentityId = null;
let currentServerId = null;
let playerDataRequestInFlight = false;
let playerDataRequestId = 0;
let activePlayerDataContext = null;
let pendingPlayerDataLoad = null;
let coordinateGridLayer = null;

// Faction state
let currentFactionId = null;
let currentFactionGuildId = null;
let factionPollInterval = null;
let factionMapRequestId = 0;
// Pending marker placement — stores clicked game coords until user confirms
let pendingMarkerCoords = null;

// Layer groups — one per data type, matches Leaflet overlay control pattern
const layers = {
  built:   null,
  placed:  null,
  mounted: null,
  deaths:  null,
  trail:   null,
  lastpos: null,
  purchases: null,
  factionMembers: null,
  factionMarkers: null,
  radar: null,
  radarHeat: null,
};
const playerLayerKeys = [
  'built', 'placed', 'mounted', 'deaths', 'trail', 'lastpos', 'purchases', 'radar', 'radarHeat'
];

function clearPlayerMapLayers() {
  playerLayerKeys.forEach(function(key) {
    if (layers[key]) layers[key].clearLayers();
  });
}

// ---------------------------------------------------------------------------
// Canonical measured map geometry and world transforms.
// ---------------------------------------------------------------------------
const mapConfigs = DayzMapCoordinates.MAP_DEFINITIONS;

// ---------------------------------------------------------------------------
// Semantic world position to Leaflet [north, east]. ADM tuple-slot decoding
// happens at the API boundary before positional data reaches this renderer.
// ---------------------------------------------------------------------------
function gameToLeaflet(posX, posNorth, mapName) {
  return DayzMapCoordinates.worldToLeaflet({ east: posX, north: posNorth }, mapName);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ---------------------------------------------------------------------------
// Tile loading — exact same pattern as map.js initMap()
// ---------------------------------------------------------------------------
function loadTiles(mapName) {
  currentTiles.forEach(function(tile) { tile.remove(); });
  currentTiles = [];

  const cfg = mapConfigs[mapName] || mapConfigs.chernarusplus;
  const gridSize = cfg.gridSize;
  const advancement = cfg.advancement || cfg.tileSize;
  const physicalSize = cfg.physicalSize || advancement;

  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      const flippedY = (gridSize - 1) - y;
      const bounds = L.latLngBounds([
        [y * advancement, x * advancement],
        [y * advancement + physicalSize, x * advancement + physicalSize]
      ]);
      const url = '/maps/' + mapName + '/tiles/' + x + '/' + flippedY + '.png';
      const tile = L.imageOverlay(url, bounds, {
        opacity: 1,
        interactive: false,
        errorOverlayUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
      }).addTo(map);
      currentTiles.push(tile);
    }
  }
}

// ---------------------------------------------------------------------------
// Coordinate grid — same as map.js addCoordinateGrid()
// ---------------------------------------------------------------------------
function addCoordinateGrid(mapName) {
  const cfg = mapConfigs[mapName] || mapConfigs.chernarusplus;
  const worldSpacing = 1000;
  if (coordinateGridLayer) map.removeLayer(coordinateGridLayer);
  coordinateGridLayer = L.layerGroup().addTo(map);

  for (let east = 0; east <= cfg.worldWidth; east += worldSpacing) {
    L.polyline([
      gameToLeaflet(east, 0, mapName),
      gameToLeaflet(east, cfg.worldHeight, mapName),
    ], {
      color: 'rgba(255,255,255,0.15)', weight: 1, interactive: false
    }).addTo(coordinateGridLayer);

    if (east % 2000 === 0 && east > 0 && east < cfg.worldWidth) {
      L.marker(gameToLeaflet(east, 100, mapName), {
        icon: L.divIcon({
          className: '',
          html: '<span style="color:white;font-size:11px;text-shadow:1px 1px 3px black;background:rgba(0,0,0,0.55);padding:2px 5px;border-radius:3px;">' + east + 'm</span>',
          iconSize: [50, 20]
        }),
        interactive: false
      }).addTo(coordinateGridLayer);
    }
  }

  for (let north = 0; north <= cfg.worldHeight; north += worldSpacing) {
    L.polyline([
      gameToLeaflet(0, north, mapName),
      gameToLeaflet(cfg.worldWidth, north, mapName),
    ], {
      color: 'rgba(255,255,255,0.15)', weight: 1, interactive: false
    }).addTo(coordinateGridLayer);
  }
}

// ---------------------------------------------------------------------------
// Initialise Leaflet — called once immediately at page load
// ---------------------------------------------------------------------------
function initMap(mapName) {
  const cfg = mapConfigs[mapName] || mapConfigs.chernarusplus;
  const size = cfg.size;

  map = L.map('map', {
    crs: L.CRS.Simple,
    minZoom: -2,
    maxZoom: 4,
    center: [size / 2, size / 2],
    zoom: -1,
    zoomControl: true,
    attributionControl: false,
  });

  const bounds = L.latLngBounds([[0, 0], [size, size]]);
  map.setMaxBounds(bounds.pad(0.5));
  map.fitBounds(bounds);

  // Coordinate display on mouse move
  map.on('mousemove', function(e) {
    const world = DayzMapCoordinates.leafletToWorld(e.latlng, currentMapName);
    const gameX = world.east.toFixed(1);
    const gameZ = world.north.toFixed(1);
    document.getElementById('coord-display').textContent = 'X: ' + gameX + '  Z: ' + gameZ;
  });

  // Create a layer group for each data type and add to map
  layers.built   = L.layerGroup().addTo(map);
  layers.placed  = L.layerGroup().addTo(map);
  layers.mounted = L.layerGroup().addTo(map);
  layers.deaths  = L.layerGroup().addTo(map);
  layers.trail   = L.layerGroup().addTo(map);
  layers.lastpos = L.layerGroup().addTo(map);
  layers.purchases = L.layerGroup().addTo(map);
  layers.factionMembers = L.layerGroup().addTo(map);
  layers.factionMarkers = L.layerGroup().addTo(map);
  layers.radar = L.layerGroup().addTo(map);
  layers.radarHeat = L.layerGroup().addTo(map);

  addCoordinateGrid(mapName);
  loadTiles(mapName);

  currentMapName = mapName;
}

// ---------------------------------------------------------------------------
// Switch map (change tiles + re-plot with new coordinate scale)
// ---------------------------------------------------------------------------
function switchMap(mapName) {
  if (!map) return;
  exitPlacementMode();
  currentMapName = mapName;
  loadTiles(mapName);
  addCoordinateGrid(mapName);
  clearPlayerMapLayers();

  layers.factionMembers.clearLayers();
  layers.factionMarkers.clearLayers();
  loadFactionMapData(mapName);

  // Re-plot any data if already loaded (reload will re-fetch + re-plot)
  if (currentIdentityId) {
    loadPlayerData(currentIdentityId);
  }
}

// ---------------------------------------------------------------------------
// Layer visibility toggles
// ---------------------------------------------------------------------------
function bindLayerToggles() {
  const toggleMap = {
    'layer-built':    'built',
    'layer-placed':   'placed',
    'layer-mounted':  'mounted',
    'layer-deaths':   'deaths',
    'layer-trail':    'trail',
    'layer-lastpos':  'lastpos',
    'layer-purchases': 'purchases',
    'layer-faction-members': 'factionMembers',
    'layer-faction-markers': 'factionMarkers',
    'layer-radar': 'radar',
    'layer-radar-heat': 'radarHeat',
  };

  Object.entries(toggleMap).forEach(function([checkboxId, layerKey]) {
    const cb = document.getElementById(checkboxId);
    if (!cb) return;
    cb.addEventListener('change', function() {
      if (this.checked) {
        map.addLayer(layers[layerKey]);
      } else {
        map.removeLayer(layers[layerKey]);
      }
    });
  });
}

function applyEnabledFeatures(enabledFeatures) {
  const enabled = new Set(Array.isArray(enabledFeatures) ? enabledFeatures : []);
  if (typeof document.querySelectorAll === 'function') {
    document.querySelectorAll('[data-player-map-feature]').forEach(function(element) {
      element.style.display = enabled.has(element.dataset.playerMapFeature) ? '' : 'none';
    });
  }

  const featureLayers = {
    structures: ['built', 'placed', 'mounted'],
    deaths: ['deaths'],
    trail: ['trail'],
    purchases: ['purchases'],
    lastPosition: ['lastpos'],
    factionMembers: ['factionMembers'],
    factionMarkers: ['factionMarkers'],
  };
  Object.entries(featureLayers).forEach(function([feature, layerKeys]) {
    if (enabled.has(feature)) return;
    layerKeys.forEach(function(layerKey) {
      if (layers[layerKey]) layers[layerKey].clearLayers();
    });
  });
}

// ---------------------------------------------------------------------------
// Plot player data onto the map
// ---------------------------------------------------------------------------
function plotData(data, centerOnPlayer = true) {
  // Refresh player-owned layers without erasing independently polled faction data.
  ['built', 'placed', 'mounted', 'deaths', 'trail', 'lastpos', 'purchases']
    .forEach(function(key) { layers[key].clearLayers(); });

  const mapName = currentMapName;

  // --- Territory / structure events ---
  let countBuilt = 0, countPlaced = 0, countMounted = 0;

  (data.territory || []).forEach(function(ev) {
    if (!ev.position) return;
    const latlng = gameToLeaflet(ev.position.east, ev.position.north, mapName);
    let color, layerKey;

    const type = (ev.eventType || '').toLowerCase();
    if (type === 'built') {
      color = '#3b82f6'; layerKey = 'built'; countBuilt++;
    } else if (type === 'placed') {
      color = '#10b981'; layerKey = 'placed'; countPlaced++;
    } else {
      color = '#eab308'; layerKey = 'mounted'; countMounted++;
    }

    const label = ev.structurePart || ev.structureType || type;

    L.circleMarker(latlng, {
      radius: 6,
      fillColor: color,
      color: '#fff',
      weight: 1,
      fillOpacity: 0.85,
    }).bindPopup(
      '<b>' + escapeHtml(label) + '</b><br>' +
      'Type: ' + escapeHtml(type) + '<br>' +
      'X: ' + ev.position.east.toFixed(1) + '  Z: ' + ev.position.north.toFixed(1) + '<br>' +
      '<small>' + escapeHtml(ev.timestamp || '') + '</small>'
    ).addTo(layers[layerKey]);
  });

  // --- Deaths ---
  const deaths = data.deaths || [];
  deaths.forEach(function(d) {
    if (!d.position) return;
    const latlng = gameToLeaflet(d.position.east, d.position.north, mapName);
    L.circleMarker(latlng, {
      radius: 7,
      fillColor: '#ef4444',
      color: '#fff',
      weight: 1.5,
      fillOpacity: 0.9,
    }).bindPopup(
      '<b>💀 Death</b><br>' +
      'Cause: ' + escapeHtml(d.deathType || 'Unknown') + '<br>' +
      'X: ' + d.position.east.toFixed(1) + '  Z: ' + d.position.north.toFixed(1) + '<br>' +
      '<small>' + escapeHtml(d.timestamp || '') + '</small>'
    ).addTo(layers.deaths);
  });

  // --- Recorded purchase placements (provider presence is not observable here) ---
  const purchases = (data.purchases || []).filter(function(purchase) {
    return Number.isFinite(purchase.posX) && Number.isFinite(purchase.posZ) &&
      (purchase.posX !== 0 || purchase.posZ !== 0);
  });
  purchases.forEach(function(purchase) {
    const latlng = gameToLeaflet(purchase.posX, purchase.posZ, mapName);
    const active = purchase.lifecycleState === 'recorded_active';
    L.circleMarker(latlng, {
      radius: 8,
      fillColor: active ? '#8b5cf6' : '#6b7280',
      color: '#fff',
      weight: 1.5,
      fillOpacity: active ? 0.9 : 0.55,
    }).bindPopup(
      '<b>🛒 ' + escapeHtml(purchase.itemName || purchase.itemClass || 'Purchased item') + '</b><br>' +
      'Recorded purchase — not live presence<br>' +
      'Lifecycle record: ' + escapeHtml(purchase.lifecycleState || 'unknown') + '<br>' +
      'X: ' + purchase.posX.toFixed(1) + '  Z: ' + purchase.posZ.toFixed(1) + '<br>' +
      '<small>' + escapeHtml(purchase.completedAt || '') + '</small>'
    ).addTo(layers.purchases);
  });

  // --- Movement trail (polyline + dots) ---
  const trail = data.trail || [];
  if (trail.length > 1) {
    const trailLatLngs = trail
      .filter(function(p) { return Boolean(p.position); })
      .map(function(p) { return gameToLeaflet(p.position.east, p.position.north, mapName); });

    L.polyline(trailLatLngs, {
      color: '#60a5fa',
      weight: 2,
      opacity: 0.5,
      interactive: false,
    }).addTo(layers.trail);

    // Subtle dot every 10th point so the trail isn't too dense
    trail.forEach(function(p, i) {
      if (i % 10 !== 0 || !p.position) return;
      L.circleMarker(gameToLeaflet(p.position.east, p.position.north, mapName), {
        radius: 3,
        fillColor: '#60a5fa',
        color: 'transparent',
        fillOpacity: 0.5,
        interactive: false,
      }).addTo(layers.trail);
    });
  }

  // --- Last known position ---
  if (data.lastPosition && data.lastPosition.position) {
    const lp = data.lastPosition;
    const latlng = gameToLeaflet(lp.position.east, lp.position.north, mapName);

    L.circleMarker(latlng, {
      radius: 12,
      fillColor: '#a78bfa',
      color: '#fff',
      weight: 2.5,
      fillOpacity: 0.95,
    }).bindPopup(
      '<b>📍 Last Known Position</b><br>' +
      'X: ' + lp.position.east.toFixed(1) + '  Z: ' + lp.position.north.toFixed(1) + '<br>' +
      '<small>' + escapeHtml(lp.timestamp || '') + '</small>'
    ).addTo(layers.lastpos);

    // Pan only for explicit loads; background refreshes preserve the user's view.
    if (centerOnPlayer) map.setView(latlng, 1);
  }

  // --- Update counts in panel ---
  document.getElementById('count-built').textContent   = countBuilt;
  document.getElementById('count-placed').textContent  = countPlaced;
  document.getElementById('count-mounted').textContent = countMounted;
  document.getElementById('count-deaths').textContent  = deaths.length;
  document.getElementById('count-trail').textContent   = trail.length;
  document.getElementById('count-purchases').textContent = purchases.length;

  // --- Update header badges ---
  const totalStructures = countBuilt + countPlaced + countMounted;
  const badgeS = document.getElementById('badge-structures');
  const badgeD = document.getElementById('badge-deaths');
  const badgeT = document.getElementById('badge-trail');
  const badgeP = document.getElementById('badge-purchases');

  badgeS.textContent = totalStructures + ' Structures';
  badgeS.style.display = totalStructures ? 'inline-block' : 'none';

  badgeD.textContent = deaths.length + ' Deaths';
  badgeD.style.display = deaths.length ? 'inline-block' : 'none';

  badgeT.textContent = trail.length + ' Trail pts';
  badgeT.style.display = trail.length ? 'inline-block' : 'none';

  badgeP.textContent = purchases.length + ' Purchases';
  badgeP.style.display = purchases.length ? 'inline-block' : 'none';
}

function plotRadarData(radarData, mapName) {
  if (!layers.radar || !layers.radarHeat) return;
  layers.radar.clearLayers();
  layers.radarHeat.clearLayers();
  const radarSection = document.getElementById('radar-layer-section');
  const count = document.getElementById('count-radar');
  const status = document.getElementById('radar-status');
  const presenceList = document.getElementById('radar-presence-list');
  if (presenceList) presenceList.replaceChildren();

  if (radarData?.error) {
    if (radarSection) radarSection.style.display = '';
    if (status) status.textContent = 'Radar refresh failed — retrying automatically.';
    if (count) count.textContent = '0';
    return;
  }
  if (!radarData?.enabled) {
    if (radarSection) radarSection.style.display = 'none';
    if (count) count.textContent = '0';
    return;
  }

  if (radarSection) radarSection.style.display = '';
  const entries = [
    ...(radarData.targets || []),
    ...(radarData.activity || []).map(event => ({
      displayName: event.displayName,
      position: event.position,
      observedAt: event.timestamp,
      action: event.action,
      presence: true,
    })),
  ];
  const positionedEntries = entries.filter(entry => entry.position);
  const presenceOnlyEntries = entries.filter(entry => entry.presence && !entry.position);
  const mode = String(radarData.revealMode || 'presence');

  if (status) {
    if (radarData.stale) {
      status.textContent = 'Radar active — waiting for a fresh player observation.';
    } else if (entries.length === 0) {
      status.textContent = `Radar active (${mode}) — no fresh contacts detected.`;
    } else {
      const observed = radarData.observedAt ? new Date(radarData.observedAt) : null;
      const freshness = observed && Number.isFinite(observed.getTime())
        ? ` • latest ${observed.toLocaleTimeString()}`
        : '';
      status.textContent = `Radar active (${mode}) — ${entries.length} contact${entries.length === 1 ? '' : 's'}${freshness}`;
    }
  }

  positionedEntries.forEach(function(entry) {
    const color = '#22d3ee';
    const latlng = gameToLeaflet(entry.position.east, entry.position.north, mapName);
    const description = `${escapeHtml(entry.displayName)}${entry.action ? ` — ${escapeHtml(entry.action)}` : ''}${entry.approximate ? ' (approximate)' : ''}`;
    L.circleMarker(latlng, {
      radius: 19,
      color: '#f43f5e',
      opacity: 0.8,
      fillOpacity: 0,
      weight: 3,
      interactive: false,
      className: 'radar-contact-pulse',
    }).addTo(layers.radar);
    L.circleMarker(latlng, {
      radius: entry.action ? 10 : 13,
      color: '#ffffff',
      fillColor: color,
      fillOpacity: 1,
      weight: 3,
      className: 'radar-contact-marker',
    }).bindPopup(`<strong>📡 ${description}</strong><br><small>Observed ${escapeHtml(entry.observedAt || '')}</small>`)
      .addTo(layers.radar);
  });

  if (positionedEntries.length > 0 && typeof L.heatLayer === 'function') {
    const heatPoints = positionedEntries.map(entry => {
      const latlng = gameToLeaflet(entry.position.east, entry.position.north, mapName);
      return [latlng[0], latlng[1], 1];
    });
    L.heatLayer(heatPoints, {
      radius: 32,
      blur: 24,
      minOpacity: 0.45,
      maxZoom: 4,
      gradient: { 0.2: '#22d3ee', 0.55: '#facc15', 1: '#f43f5e' },
    }).addTo(layers.radarHeat);
  }

  if (presenceList && presenceOnlyEntries.length > 0) {
    const heading = document.createElement('div');
    heading.textContent = 'Detected (location hidden):';
    heading.style.fontWeight = '600';
    presenceList.appendChild(heading);
    presenceOnlyEntries.forEach(function(entry) {
      const row = document.createElement('div');
      row.textContent = `• ${entry.displayName || 'Unknown player'}`;
      presenceList.appendChild(row);
    });
  }
  if (count) count.textContent = String(entries.length);
}

async function loadRadarData(identityId, serverId) {
  try {
    const response = await fetchWithCsrf('/api/radar/player/' + encodeURIComponent(serverId) +
      '/' + encodeURIComponent(identityId), { method: 'POST' });
    const payload = await response.json();
    if (!response.ok || !payload.success) return { error: true };
    return payload.data;
  } catch (error) {
    console.warn('Failed to load radar data:', error);
    return { error: true };
  }
}

// ---------------------------------------------------------------------------
// Fetch player data from API and plot
// ---------------------------------------------------------------------------
async function loadPlayerData(identityId, options = {}) {
  const mapName = currentMapName;
  const serverId = currentServerId;
  if (playerDataRequestInFlight) {
    if (activePlayerDataContext &&
        activePlayerDataContext.requestId === playerDataRequestId &&
        !pendingPlayerDataLoad &&
        activePlayerDataContext.identityId === identityId &&
        activePlayerDataContext.mapName === mapName &&
        activePlayerDataContext.serverId === serverId) return;

    ++playerDataRequestId;
    pendingPlayerDataLoad = { identityId, options, mapName, serverId };
    return;
  }

  const requestId = ++playerDataRequestId;
  playerDataRequestInFlight = true;
  activePlayerDataContext = { requestId, identityId, mapName, serverId };

  const silent = options.silent === true;
  if (!silent) {
    document.getElementById('loading').style.display = 'flex';
    document.getElementById('loading-status').textContent = 'Fetching player data…';
  }

  try {
    const radarPromise = loadRadarData(identityId, serverId);
    const mapDataPromise = fetch('/api/player/map-data/' + identityId +
      '?serverId=' + encodeURIComponent(serverId));
    const [res, radarData] = await Promise.all([mapDataPromise, radarPromise]);
    const data = await res.json();
    if (requestId !== playerDataRequestId || mapName !== currentMapName || serverId !== currentServerId) return;

    if (!data.success) {
      if (!silent) document.getElementById('map-info').textContent = 'Error: ' + (data.error || 'Failed to load data');
      return;
    }

    document.getElementById('map-info').textContent =
      (data.playerName || identityId) + ' — ' +
      (mapConfigs[currentMapName] ? mapConfigs[currentMapName].name : currentMapName);

    applyEnabledFeatures(data.enabledFeatures);
    plotData(data, options.centerOnPlayer !== false);
    plotRadarData(radarData, mapName);
  } catch (err) {
    if (requestId !== playerDataRequestId || mapName !== currentMapName || serverId !== currentServerId) return;
    console.error('Failed to load player map data:', err);
    if (!silent) document.getElementById('map-info').textContent = 'Failed to load data';
  } finally {
    playerDataRequestInFlight = false;
    activePlayerDataContext = null;

    const pending = pendingPlayerDataLoad;
    pendingPlayerDataLoad = null;
    if (pending && pending.mapName === currentMapName && pending.serverId === currentServerId) {
      loadPlayerData(pending.identityId, pending.options);
    } else if (requestId === playerDataRequestId) {
      document.getElementById('loading').style.display = 'none';
    }
  }
}

// ---------------------------------------------------------------------------
// Collapsible panel
// ---------------------------------------------------------------------------
function initPanel() {
  document.getElementById('panel-header').addEventListener('click', function() {
    const body = document.getElementById('panel-body');
    const icon = document.getElementById('panel-toggle-icon');
    const hidden = body.style.display === 'none';
    body.style.display = hidden ? 'block' : 'none';
    icon.textContent = hidden ? '▼' : '▲';
  });
}

// ---------------------------------------------------------------------------
// Faction layer functions
// ---------------------------------------------------------------------------

/**
 * Fetches faction map data (markers + member positions) and refreshes the
 * faction layers.  Called on initial load and by the 30-second poll.
 */
async function loadFactionMapData(mapName) {
  if (!currentFactionId || !currentFactionGuildId) return;
  const requestId = ++factionMapRequestId;

  try {
    const res = await fetch(
      `/api/factions/${currentFactionGuildId}/${currentFactionId}/map?mapName=${encodeURIComponent(mapName)}&serverId=${encodeURIComponent(currentServerId)}`
    );
    if (!res.ok) return;
    const data = await res.json();
    if (!data.success) return;
    if (requestId !== factionMapRequestId || mapName !== currentMapName) return;

    plotFactionMembers(data.members, data.callerIdentityId, mapName);
    plotFactionMarkers(data.markers, data.callerIdentityId, data.callerRank, mapName);
  } catch (err) {
    console.warn('Failed to load faction map data:', err);
  }
}

/**
 * Renders faction member last positions as circle markers.
 * The caller's own position is highlighted in purple; teammates are orange.
 */
function plotFactionMembers(members, callerIdentityId, mapName) {
  if (!layers.factionMembers) return;
  layers.factionMembers.clearLayers();

  let count = 0;
  members.forEach(function(m) {
    if (!m.position) return;

    const latlng = gameToLeaflet(m.position.east, m.position.north, mapName);
    const isSelf = m.identity_id === callerIdentityId;
    const color = isSelf ? '#a78bfa' : '#f97316';

    const lastSeen = m.last_updated
      ? new Date(m.last_updated).toLocaleString()
      : 'Unknown';

    L.circleMarker(latlng, {
      radius: isSelf ? 8 : 7,
      color: color,
      fillColor: color,
      fillOpacity: 0.85,
      weight: isSelf ? 2 : 1,
    })
      .bindPopup(
        `<strong>${escapeMapHtml(m.player_name)}</strong>${isSelf ? ' (you)' : ''}<br>` +
        `<span style="color:#9ca3af;font-size:11px;">Last seen: ${lastSeen}</span>`
      )
      .addTo(layers.factionMembers);

    count++;
  });

  const el = document.getElementById('count-faction-members');
  if (el) el.textContent = count;
}

/**
 * Renders faction markers as Leaflet divIcon emoji markers.
 * Popups include the note, creator name, and a delete button for authorised users.
 */
function plotFactionMarkers(markers, callerIdentityId, callerRank, mapName) {
  if (!layers.factionMarkers) return;
  layers.factionMarkers.clearLayers();

  const canManage = callerRank === 'leader' || callerRank === 'officer';

  markers.forEach(function(m) {
    const latlng = gameToLeaflet(m.pos_x, m.pos_y, mapName);
    const isOwner = m.created_by_identity_id === callerIdentityId;
    const canDelete = isOwner || canManage;

    const icon = L.divIcon({
      html: `<span style="font-size:22px;line-height:1;">${escapeMapHtml(m.icon)}</span>`,
      className: 'faction-marker-icon',
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });

    const deleteBtn = canDelete
      ? `<br><button data-delete-faction-marker="${Number(m.id)}"
           style="margin-top:6px;font-size:11px;background:#7f1d1d;border:none;color:#fff;padding:2px 8px;border-radius:4px;cursor:pointer;">
           🗑 Delete</button>`
      : '';

    const note = m.note
      ? `<p style="color:#d1d5db;font-size:11px;margin:4px 0 0;">${escapeMapHtml(m.note)}</p>`
      : '';

    L.marker(latlng, { icon })
      .bindPopup(
        `<strong>${escapeMapHtml(m.title)}</strong>${note}` +
        `<p style="color:#9ca3af;font-size:10px;margin:4px 0 0;">by ${escapeMapHtml(m.creator_name)}</p>` +
        deleteBtn
      )
      .addTo(layers.factionMarkers);
  });

  const el = document.getElementById('count-faction-markers');
  if (el) el.textContent = markers.length;
}

/**
 * Deletes a faction marker via the API and refreshes the markers layer.
 * Exposed on window for compatibility with existing map integrations.
 */
window.deleteFactionMarker = async function(markerId) {
  if (!confirm('Delete this marker?')) return;

  const headers = {};
  if (typeof window.getCsrfToken === 'function') {
    headers['X-CSRF-Token'] = window.getCsrfToken();
  }

  try {
    const res = await fetch(
      `/api/factions/${currentFactionGuildId}/${currentFactionId}/markers/${markerId}?serverId=${encodeURIComponent(currentServerId)}`,
      { method: 'DELETE', headers }
    );
    const data = await res.json();
    if (!data.success) { alert(data.error); return; }
    map.closePopup();
    loadFactionMapData(currentMapName);
  } catch {
    alert('Failed to delete marker.');
  }
};

document.addEventListener('click', event => {
  const button = event.target.closest('button[data-delete-faction-marker]');
  if (button) window.deleteFactionMarker(Number(button.dataset.deleteFactionMarker));
});

function escapeMapHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

/**
 * Starts the 30-second faction data polling interval.
 * Clears any previous interval first to prevent double-polling across map switches.
 */
function startFactionPoll() {
  if (factionPollInterval) clearInterval(factionPollInterval);
  factionPollInterval = setInterval(function() {
    loadFactionMapData(currentMapName);
  }, 30000);
}

/**
 * Entry point called from bootstrap when factionId + guildId URL params are present.
 */
function initFactionLayers(mapName) {
  loadFactionMapData(mapName);
  startFactionPoll();
  bindPlacementMode();
}

/**
 * Binds the "Place Marker" toggle button and related form interactions.
 */
function bindPlacementMode() {
  const placeBtn = document.getElementById('place-marker-btn');
  const formEl = document.getElementById('faction-marker-form');
  const inputsEl = document.getElementById('faction-marker-inputs');
  const dismissBtn = document.getElementById('marker-dismiss-btn');
  const saveBtn = document.getElementById('marker-save-btn');
  const cancelBtn = document.getElementById('marker-cancel-btn');

  if (!placeBtn || !formEl) return;

  placeBtn.addEventListener('click', function() {
    if (placeBtn.classList.contains('active')) {
      exitPlacementMode();
    } else {
      enterPlacementMode();
    }
  });

  if (dismissBtn) dismissBtn.addEventListener('click', exitPlacementMode);

  if (cancelBtn) {
    cancelBtn.addEventListener('click', function() {
      inputsEl.style.display = 'none';
      pendingMarkerCoords = null;
      formEl.querySelector('p').textContent = '📍 Click the map to place a marker';
    });
  }

  if (saveBtn) saveBtn.addEventListener('click', saveMarker);

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') exitPlacementMode();
  });
}

function enterPlacementMode() {
  const placeBtn = document.getElementById('place-marker-btn');
  const formEl = document.getElementById('faction-marker-form');
  if (!placeBtn || !formEl) return;

  placeBtn.classList.add('active');
  placeBtn.style.background = '#b45309';
  placeBtn.innerHTML = '✕ Cancel';
  formEl.style.display = 'block';
  map.getContainer().style.cursor = 'crosshair';
  map.on('click', onMapClickPlacement);
}

function exitPlacementMode() {
  const placeBtn = document.getElementById('place-marker-btn');
  const formEl = document.getElementById('faction-marker-form');
  const inputsEl = document.getElementById('faction-marker-inputs');

  if (placeBtn) {
    placeBtn.classList.remove('active');
    placeBtn.style.background = '';
    placeBtn.innerHTML = '📍 Place Marker';
  }
  if (formEl) formEl.style.display = 'none';
  if (inputsEl) inputsEl.style.display = 'none';

  pendingMarkerCoords = null;
  if (map) {
    map.getContainer().style.cursor = '';
    map.off('click', onMapClickPlacement);
  }
}

function onMapClickPlacement(e) {
  // Convert Leaflet lat/lng back to game coordinates
  const world = DayzMapCoordinates.leafletToWorld(e.latlng, currentMapName);
  const posX = world.east;
  const posY = world.north;

  pendingMarkerCoords = { posX, posY };

  const inputsEl = document.getElementById('faction-marker-inputs');
  const formEl = document.getElementById('faction-marker-form');
  if (inputsEl) inputsEl.style.display = 'block';
  if (formEl) {
    formEl.querySelector('p').textContent =
      `📍 Placing at X:${Math.round(posX)} Y:${Math.round(posY)}`;
  }
}

async function saveMarker() {
  if (!pendingMarkerCoords) return;

  const title = (document.getElementById('marker-title').value || 'Marker').trim();
  const note = document.getElementById('marker-note').value.trim() || null;
  const icon = document.getElementById('marker-icon').value.trim() || '📍';

  const headers = { 'Content-Type': 'application/json' };
  if (typeof window.getCsrfToken === 'function') {
    headers['X-CSRF-Token'] = window.getCsrfToken();
  }

  try {
    const res = await fetch(
      `/api/factions/${currentFactionGuildId}/${currentFactionId}/markers`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          serverId: currentServerId,
          mapName: currentMapName,
          posX: pendingMarkerCoords.posX,
          posY: pendingMarkerCoords.posY,
          title,
          note,
          icon,
        }),
      }
    );
    const data = await res.json();
    if (!data.success) { alert(data.error); return; }

    document.getElementById('marker-title').value = '';
    document.getElementById('marker-note').value = '';
    document.getElementById('marker-icon').value = '📍';
    exitPlacementMode();
    loadFactionMapData(currentMapName);
  } catch {
    alert('Failed to save marker.');
  }
}

// ---------------------------------------------------------------------------
// Bootstrap — runs immediately like map.js
// ---------------------------------------------------------------------------
(function init() {
  // Read URL params
  const params = new URLSearchParams(window.location.search);
  currentIdentityId = params.get('identityId');
  currentServerId = params.get('serverId');
  currentFactionId = params.get('factionId');
  currentFactionGuildId = params.get('guildId');
  const mapParam = params.get('mapName') || 'chernarusplus';

  // Kick off Leaflet right away — container is already visible in the DOM
  initMap(mapParam);

  // Bind UI
  bindLayerToggles();
  initPanel();

  document.getElementById('map-select').value = mapParam;

  document.getElementById('map-select').addEventListener('change', function() {
    switchMap(this.value);
  });

  document.getElementById('reload-btn').addEventListener('click', function() {
    if (currentIdentityId && currentServerId) loadPlayerData(currentIdentityId);
  });

  // Load data if identity provided
  if (currentIdentityId && currentServerId) {
    loadPlayerData(currentIdentityId);
    setInterval(function() {
      if (document.visibilityState === 'visible') {
        loadPlayerData(currentIdentityId, { silent: true, centerOnPlayer: false });
      }
    }, 30000);
  } else {
    document.getElementById('map-info').textContent = 'No player identity or server provided';
    document.getElementById('loading').style.display = 'none';
  }

  // Initialise faction layers if factionId was provided in URL
  if (currentFactionId && currentFactionGuildId) {
    document.getElementById('faction-layer-section').style.display = 'block';
    initFactionLayers(mapParam);
  }
})();
