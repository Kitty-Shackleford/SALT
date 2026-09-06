/*
 * player-map.js
 * Interactive Leaflet map for the player portal.
 * Shows a player's territory events, deaths, movement trail and last position.
 *
 * Usage:
 *   PlayerMap.init('player-map', 'chernarusplus');
 *   PlayerMap.loadData(identityId, serverId);
 *
 * Adding a new layer in the future:
 *   const myGroup = L.layerGroup().addTo(PlayerMap._map);
 *   PlayerMap._layerControl.addOverlay(myGroup, 'My New Layer');
 */

const PlayerMap = (function () {

  // --- Canonical measured map geometry and world transforms ---
  const MAP_CONFIGS = DayzMapCoordinates.MAP_DEFINITIONS;

  // Internal state
  let _map = null;
  let _mapName = 'chernarusplus';
  let _currentTiles = [];
  let _layerControl = null;

  // Layer groups — one per data type, toggled via Leaflet control
  const _layers = {
    structures: null,   // territory events: built, placed
    deaths:     null,   // player death locations
    trail:      null,   // movement polyline
    lastPos:    null    // last known position
  };

  // Stats counts for the UI summary bar
  const _counts = { structures: 0, deaths: 0, trail: 0 };

  // --- Coordinate conversion ---
  // DayZ game coords: X = east, Z = north. Leaflet uses [lat, lng] = [north, east].
  function _gameToLeaflet(posX, posNorth) {
    return DayzMapCoordinates.worldToLeaflet({ east: posX, north: posNorth }, _mapName);
  }

  // --- Tile loading ---
  function _loadTiles(mapName, config) {
    // Remove existing tiles
    _currentTiles.forEach(t => _map.removeLayer(t));
    _currentTiles = [];

    const gridSize     = config.gridSize    || 32;
    const tileSize     = config.tileSize    || 480;
    const advancement  = config.advancement || tileSize;
    const physicalSize = config.physicalSize || 512;

    // Tile URL format matches /maps/{mapName}/tiles/{x}/{flippedY}.png (same as admin map)
    for (let y = 0; y < gridSize; y++) {
      for (let x = 0; x < gridSize; x++) {
        const flippedY = (gridSize - 1) - y;
        const bounds = L.latLngBounds([
          [y * advancement,                x * advancement],
          [y * advancement + physicalSize, x * advancement + physicalSize]
        ]);
        const url  = '/maps/' + mapName + '/tiles/' + x + '/' + flippedY + '.png';
        const tile = L.imageOverlay(url, bounds, {
          opacity: 1,
          interactive: false,
          errorOverlayUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
        });
        tile.addTo(_map);
        _currentTiles.push(tile);
      }
    }
  }

  // --- Initialise Leaflet map ---
  function init(containerId, mapName) {
    if (_map) {
      _map.remove();
      _map = null;
    }

    _mapName = mapName || 'chernarusplus';
    const config = MAP_CONFIGS[_mapName] || MAP_CONFIGS.chernarusplus;
    const size   = config.size;

    _map = L.map(containerId, {
      crs: L.CRS.Simple,
      minZoom: -3,
      maxZoom:  3,
      zoomSnap: 0.25,
      attributionControl: false
    });

    const bounds = L.latLngBounds([[0, 0], [size, size]]);
    _map.fitBounds(bounds);
    _map.setMaxBounds(bounds.pad(0.1));

    _loadTiles(_mapName, config);

    // Create layer groups (empty until data loads)
    _layers.structures = L.layerGroup().addTo(_map);
    _layers.deaths     = L.layerGroup().addTo(_map);
    _layers.trail      = L.layerGroup().addTo(_map);
    _layers.lastPos    = L.layerGroup().addTo(_map);

    // Layer control — future layers can be added via addOverlay()
    _layerControl = L.control.layers(null, {
      '🏗️ Structures': _layers.structures,
      '💀 Deaths':     _layers.deaths,
      '🔵 Trail':      _layers.trail,
      '📍 Last Position': _layers.lastPos
    }, { collapsed: false, position: 'topright' }).addTo(_map);

    // Coordinate display on hover
    const coordDisplay = L.control({ position: 'bottomleft' });
    coordDisplay.onAdd = function () {
      const div = L.DomUtil.create('div', 'leaflet-bar');
      div.style.cssText = 'background:rgba(0,0,0,0.7);color:#fff;padding:4px 8px;font-size:12px;font-family:monospace;';
      div.id = 'pm-coords';
      div.textContent = 'Hover for coordinates';
      return div;
    };
    coordDisplay.addTo(_map);

    _map.on('mousemove', function (e) {
      const world = DayzMapCoordinates.leafletToWorld(e.latlng, _mapName);
      const gameX = world.east.toFixed(0);
      const gameZ = world.north.toFixed(0);
      const el = document.getElementById('pm-coords');
      if (el) el.textContent = 'X: ' + gameX + '  Z: ' + gameZ;
    });
  }

  // --- Switch the base map ---
  function setMapName(mapName) {
    if (!MAP_CONFIGS[mapName]) return;
    _mapName = mapName;
    const config = MAP_CONFIGS[_mapName];
    _loadTiles(_mapName, config);

    // Re-fit bounds for the new map size
    const size = config.size;
    _map.fitBounds([[0, 0], [size, size]]);
  }

  // --- Plot territory/structure markers ---
  function _plotStructures(territory) {
    _layers.structures.clearLayers();
    _counts.structures = 0;

    territory.forEach(function (ev) {
      if (!ev.position) return;

      const latlng = _gameToLeaflet(ev.position.east, ev.position.north);

      // Colour by event type
      const colorMap = { built: '#3b82f6', placed: '#10b981', mounted: '#eab308', folded: '#6b7280' };
      const color = colorMap[ev.eventType] || '#9ca3af';

      const label  = ev.structurePart || ev.structureType || ev.eventType;
      const marker = L.circleMarker(latlng, {
        radius: 7,
        fillColor: color,
        color: '#fff',
        weight: 1.5,
        opacity: 1,
        fillOpacity: 0.85
      });

      const ts = ev.timestamp ? new Date(ev.timestamp).toLocaleString() : 'unknown time';
      marker.bindPopup(
        '<div style="font-size:13px;min-width:160px;">' +
        '<strong>' + (ev.structureType || 'Structure') + '</strong><br>' +
        'Action: ' + ev.eventType + '<br>' +
        (ev.structurePart ? 'Part: ' + ev.structurePart + '<br>' : '') +
        (ev.toolUsed ? 'Tool: ' + ev.toolUsed + '<br>' : '') +
        'When: ' + ts + '<br>' +
        'Pos: ' + ev.position.east.toFixed(0) + ', ' + ev.position.north.toFixed(0) +
        '</div>'
      );

      _layers.structures.addLayer(marker);
      _counts.structures++;
    });
  }

  // --- Plot death markers ---
  function _plotDeaths(deaths) {
    _layers.deaths.clearLayers();
    _counts.deaths = 0;

    deaths.forEach(function (d) {
      if (!d.position) return;

      const latlng = _gameToLeaflet(d.position.east, d.position.north);
      const marker = L.circleMarker(latlng, {
        radius: 8,
        fillColor: '#ef4444',
        color: '#fff',
        weight: 1.5,
        opacity: 1,
        fillOpacity: 0.9
      });

      const ts = d.timestamp ? new Date(d.timestamp).toLocaleString() : 'unknown time';
      marker.bindPopup(
        '<div style="font-size:13px;">' +
        '<strong>☠️ Death</strong><br>' +
        'Cause: ' + (d.deathType || 'unknown') + '<br>' +
        'When: ' + ts + '<br>' +
        'Pos: ' + d.position.east.toFixed(0) + ', ' + d.position.north.toFixed(0) +
        '</div>'
      );

      _layers.deaths.addLayer(marker);
      _counts.deaths++;
    });
  }

  // --- Plot movement trail ---
  function _plotTrail(trail) {
    _layers.trail.clearLayers();
    _counts.trail = trail.length;

    if (trail.length < 2) return;

    const latlngs = trail
      .filter(p => p.position)
      .map(p => _gameToLeaflet(p.position.east, p.position.north));
    if (latlngs.length < 2) return;

    const polyline = L.polyline(latlngs, {
      color: '#60a5fa',
      weight: 2,
      opacity: 0.6,
      smoothFactor: 1
    });
    _layers.trail.addLayer(polyline);

    // Start and end dots
    const startDot = L.circleMarker(latlngs[0], {
      radius: 5, fillColor: '#a3e635', color: '#fff', weight: 1, fillOpacity: 1
    }).bindTooltip('Trail start');
    const endDot = L.circleMarker(latlngs[latlngs.length - 1], {
      radius: 5, fillColor: '#f97316', color: '#fff', weight: 1, fillOpacity: 1
    }).bindTooltip('Trail end');

    _layers.trail.addLayer(startDot);
    _layers.trail.addLayer(endDot);
  }

  // --- Plot last known position ---
  function _plotLastPosition(lastPos) {
    _layers.lastPos.clearLayers();
    if (!lastPos || !lastPos.position) return;

    const latlng = _gameToLeaflet(lastPos.position.east, lastPos.position.north);

    // Outer ring for visibility
    const ring = L.circleMarker(latlng, {
      radius: 14,
      fillColor: 'transparent',
      color: '#3b82f6',
      weight: 2,
      opacity: 0.6,
      dashArray: '4 4'
    });

    const dot = L.circleMarker(latlng, {
      radius: 7,
      fillColor: '#3b82f6',
      color: '#fff',
      weight: 2,
      opacity: 1,
      fillOpacity: 1
    }).bindPopup(
      '<div style="font-size:13px;">' +
      '<strong>📍 Last Known Position</strong><br>' +
      (lastPos.serverName ? 'Server: ' + lastPos.serverName + '<br>' : '') +
      'X: ' + lastPos.position.east.toFixed(0) + '  Z: ' + lastPos.position.north.toFixed(0) +
      '</div>'
    );

    _layers.lastPos.addLayer(ring);
    _layers.lastPos.addLayer(dot);

    // Pan to last position on first load
    _map.setView(latlng, _map.getZoom());
  }

  // --- Update stats bar in the HTML ---
  function _updateStats() {
    const el = document.getElementById('pm-stats');
    if (!el) return;
    el.innerHTML =
      '<span>🏗️ ' + _counts.structures + ' structures</span>' +
      '<span>💀 ' + _counts.deaths + ' deaths</span>' +
      '<span>🔵 ' + _counts.trail + ' trail points</span>';
  }

  // --- Load data from API and plot all layers ---
  async function loadData(identityId, serverId) {
    const statusEl = document.getElementById('pm-status');
    if (statusEl) statusEl.textContent = 'Loading map data…';

    try {
      const params = serverId ? '?serverId=' + encodeURIComponent(serverId) : '';
      const res  = await fetch('/api/player/map-data/' + identityId + params);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();

      _plotStructures(data.territory || []);
      _plotDeaths(data.deaths || []);
      _plotTrail(data.trail || []);
      _plotLastPosition(data.lastPosition);
      _updateStats();

      if (statusEl) statusEl.textContent = '';

      // If we have a last position and no trail, still centre the map there
      if (!data.trail?.length && data.lastPosition?.position) {
        _map.setView(_gameToLeaflet(
          data.lastPosition.position.east,
          data.lastPosition.position.north
        ), -1);
      }

    } catch (err) {
      console.error('PlayerMap: failed to load data', err);
      if (statusEl) statusEl.textContent = '⚠️ Failed to load map data';
    }
  }

  // --- Public API ---
  return {
    init,
    loadData,
    setMapName,
    getMapConfigs: function () { return MAP_CONFIGS; },
    // Expose internals so callers can add custom layers
    get _map()          { return _map; },
    get _layerControl() { return _layerControl; },
    get _layers()       { return _layers; }
  };

})();
