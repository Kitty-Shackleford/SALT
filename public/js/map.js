let map = null;
let markers = {};
let allEventData = [];
let eventTypeFilters = {};
let currentTiles = [];
let currentServer = null;
let currentMapName = null;
let activeMapName = null;
let coordinateGridLayer = null;

let radiusSearchMode = false;
let radiusCircle = null;
let radiusMarker = null;
let lastEventHealth = null;
let eventHealthRequestId = 0;
let mapDiscoveryRequestId = 0;
let mapDataRequestId = 0;
let contextGeneration = 0;
let lootHeatmapRequestId = 0;
const genericHeatmapRequestIds = {};

// Auto-refresh state
let autoRefreshEnabled = true;
let autoRefreshInterval = null;
let refreshCountdown = null;
let refreshSeconds = 30;

// Heatmap state
let heatLayer = null;
let heatmapEnabled = false;
let heatmapFilter = 'all';

// Additional heat layers: kills, deaths, movement
let killHeatLayer = null;
let killHeatmapEnabled = false;
let deathHeatLayer = null;
let deathHeatmapEnabled = false;
let movementHeatLayer = null;
let movementHeatmapEnabled = false;

// Stats tracking
let previousStats = {
  spawns: 0,
  events: 0,
  players: 0
};

// Canonical measured map geometry and world transforms.
const mapConfigs = DayzMapCoordinates.MAP_DEFINITIONS;

function gameToLeaflet(east, north, mapName) {
  return DayzMapCoordinates.worldToLeaflet({ east, north }, mapName);
}

// Helper function for event colors - DYNAMIC with localStorage
function getEventColor(eventName) {
  const savedColors = JSON.parse(localStorage.getItem('eventColors') || '{}');

  if (savedColors[eventName]) {
    return savedColors[eventName];
  }

  let hash = 0;
  for (let i = 0; i < eventName.length; i++) {
    hash = eventName.charCodeAt(i) + ((hash << 5) - hash);
  }

  const hue = Math.abs(hash % 360);
  const saturation = 65 + (Math.abs(hash) % 20);
  const lightness = 50 + (Math.abs(hash >> 8) % 15);

  return 'hsl(' + hue + ', ' + saturation + '%, ' + lightness + '%)';
}

function saveEventColor(eventName, color) {
  const savedColors = JSON.parse(localStorage.getItem('eventColors') || '{}');
  savedColors[eventName] = color;
  localStorage.setItem('eventColors', JSON.stringify(savedColors));
}

function resetEventColor(eventName) {
  const savedColors = JSON.parse(localStorage.getItem('eventColors') || '{}');
  delete savedColors[eventName];
  localStorage.setItem('eventColors', JSON.stringify(savedColors));
}

function rgbToHex(color) {
  if (color.startsWith('#')) {
    return color;
  }

  if (color.startsWith('hsl')) {
    const temp = document.createElement('div');
    temp.style.color = color;
    document.body.appendChild(temp);
    const rgb = window.getComputedStyle(temp).color;
    document.body.removeChild(temp);
    color = rgb;
  }

  const rgb = color.match(/\d+/g);
  if (rgb) {
    const r = parseInt(rgb[0]).toString(16).padStart(2, '0');
    const g = parseInt(rgb[1]).toString(16).padStart(2, '0');
    const b = parseInt(rgb[2]).toString(16).padStart(2, '0');
    return '#' + r + g + b;
  }

  return '#8b5cf6';
}

function updateEventColors(eventName, newColor) {
  allEventData.forEach(function(event) {
    if (event.name === eventName) {
      event.color = newColor;
      event.marker.setStyle({
        fillColor: newColor
      });
    }
  });

  const dot = document.getElementById('dot_' + eventName);
  if (dot) {
    dot.style.background = newColor;
  }

  searchEvents();
}

function resetAllColors() {
  localStorage.removeItem('eventColors');

  const uniqueEvents = [...new Set(allEventData.map(e => e.name))];

  uniqueEvents.forEach(function(eventName) {
    const autoColor = getEventColor(eventName);

    allEventData.forEach(function(event) {
      if (event.name === eventName) {
        event.color = autoColor;
        event.marker.setStyle({
          fillColor: autoColor
        });
      }
    });

    const dot = document.getElementById('dot_' + eventName);
    if (dot) {
      dot.style.background = autoColor;
    }

    const colorPickers = document.querySelectorAll('input[type="color"]');
    colorPickers.forEach(function(picker) {
      if (picker.getAttribute('data-event') === eventName) {
        picker.value = rgbToHex(autoColor);
      }
    });
  });

  console.log('✓ All colors reset to auto-generated');
}

// Initialize map
function initMap(mapName = 'enoch') {
  if (map) {
    currentTiles.forEach(tile => tile.remove());
    currentTiles = [];
  } else {
    const mapConfig = mapConfigs[mapName] || mapConfigs['enoch'];
    const size = mapConfig.size;

    map = L.map('map', {
      crs: L.CRS.Simple,
      minZoom: -2,
      maxZoom: 3,
      center: [size / 2, size / 2],
      zoom: -1,
      zoomControl: true,
      attributionControl: false
    });

    const bounds = L.latLngBounds([[0, 0], [size, size]]);
    map.setMaxBounds(bounds.pad(0.5));
    map.fitBounds(bounds);
    map.on('click', onMapClick);
  }

  addCoordinateGrid(mapName);

  const mapConfig = mapConfigs[mapName] || mapConfigs['enoch'];
  const gridSize = mapConfig.gridSize;
  const physicalTileSize = mapConfig.physicalSize || 512;
  const advancement = mapConfig.advancement || mapConfig.tileSize;

  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      const flippedY = (gridSize - 1) - y;
      const tileBounds = L.latLngBounds([
        [y * advancement, x * advancement],
        [y * advancement + physicalTileSize, x * advancement + physicalTileSize]
      ]);
      const tileUrl = '/maps/' + mapName + '/tiles/' + x + '/' + flippedY + '.png';
      const overlay = L.imageOverlay(tileUrl, tileBounds, {
        opacity: 1,
        interactive: false,
        errorOverlayUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
      }).addTo(map);
      currentTiles.push(overlay);
    }
  }
}

function addCoordinateGrid(mapName) {
  const cfg = mapConfigs[mapName] || mapConfigs.enoch;
  const worldSpacing = 1000;
  if (coordinateGridLayer) map.removeLayer(coordinateGridLayer);
  coordinateGridLayer = L.layerGroup().addTo(map);

  for (let east = 0; east <= cfg.worldWidth; east += worldSpacing) {
    L.polyline([
      gameToLeaflet(east, 0, mapName),
      gameToLeaflet(east, cfg.worldHeight, mapName),
    ], {
      color: 'rgba(255, 255, 255, 0.2)',
      weight: 1,
      interactive: false
    }).addTo(coordinateGridLayer);

    if (east % 2000 === 0 && east > 0 && east < cfg.worldWidth) {
      L.marker(gameToLeaflet(east, 100, mapName), {
        icon: L.divIcon({
          className: 'grid-label',
          html: '<span style="color: white; font-size: 11px; text-shadow: 1px 1px 3px black; background: rgba(0,0,0,0.6); padding: 2px 5px; border-radius: 3px;">' + east + 'm</span>',
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
      color: 'rgba(255, 255, 255, 0.2)',
      weight: 1,
      interactive: false
    }).addTo(coordinateGridLayer);
  }
}

async function loadServers() {
  try {
    console.log('🔍 [MAP] Loading servers...');

    // Step 1: Get user's guilds
    const guildsRes = await fetch('/api/user/guilds');
    console.log('📡 [MAP] Guilds response status:', guildsRes.status);

    const guildsData = await guildsRes.json();
    console.log('📦 [MAP] Guilds data:', guildsData);

    if (!guildsData.success || !guildsData.guilds || guildsData.guilds.length === 0) {
      console.warn('⚠️ [MAP] No guilds available');
      return;
    }

    // Step 2: Get servers for each guild
    const allServers = [];

    for (const guild of guildsData.guilds) {
      console.log('🔍 [MAP] Fetching servers for guild:', guild.name, guild.id);

      const serversRes = await fetch(`/api/guilds/${guild.id}/servers`);
      console.log('📡 [MAP] Servers response status:', serversRes.status);

      const serversData = await serversRes.json();
      console.log('📦 [MAP] Servers data for', guild.name, ':', serversData);

      if (serversData.success && serversData.servers) {
        serversData.servers.forEach(server => {
          server.guildId = guild.id;
          server.guildName = guild.name;
        });
        allServers.push(...serversData.servers);
      }
    }

    console.log('✅ [MAP] Total servers loaded:', allServers.length);

    const data = { servers: allServers, success: true };

    const select = document.getElementById('server-select');
    select.innerHTML = '<option value="">Select Server...</option>';

    if (data.servers && data.servers.length > 0) {
      data.servers.forEach(function(server) {
        const option = document.createElement('option');
        option.value = server.nitrado_server_id;
        option.dataset.guildId = String(server.guildId);
        option.textContent = (server.server_name) + ' (' + server.nitrado_server_id + ')';
        select.appendChild(option);
      });
    }
  } catch (err) {
    console.error('Failed to load servers:', err);
  }
}

function selectedServerContext(serverId) {
  const select = document.getElementById('server-select');
  const option = select.options[select.selectedIndex];
  if (!option || String(option.value) !== String(serverId) || String(currentServer) !== String(serverId)) return null;
  return option.dataset.guildId ? { guildId: option.dataset.guildId } : null;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function getActiveMission(serverId, guildId, discoveryRequestId = mapDiscoveryRequestId) {
  try {
    const res = await fetch('/api/server-active-mission/' + serverId + '?guildId=' + encodeURIComponent(guildId));
    const data = await res.json();
    if (discoveryRequestId !== mapDiscoveryRequestId || !selectedServerContext(serverId)) return null;

    if (data.success && data.mapName) {
      activeMapName = data.mapName;

      document.getElementById('active-badge').style.display = 'inline-block';
      document.getElementById('active-badge').textContent = 'Active: ' + (mapConfigs[data.mapName] ? mapConfigs[data.mapName].name : data.mapName);
      document.getElementById('active-badge').className = 'badge badge-green';

      document.getElementById('players-badge').style.display = 'inline-block';
      document.getElementById('players-badge').textContent = data.playerCount + '/' + data.maxPlayers + ' Players';

      // Update player stat
      const currentPlayers = data.playerCount;
      document.getElementById('stat-players').textContent = currentPlayers + '/' + data.maxPlayers;
      updateStatTrend('players', currentPlayers, previousStats.players);
      previousStats.players = currentPlayers;

      console.log('✓ Active mission:', data.mission, '→', data.mapName);
      return data.mapName;
    }

    return null;
  } catch (err) {
    console.error('Failed to get active mission:', err);
    return null;
  }
}

async function loadMapsForServer(serverId) {
  const requestId = ++mapDiscoveryRequestId;
  const serverContext = selectedServerContext(serverId);
  if (!serverContext) return;
  try {
    document.getElementById('map-select').innerHTML = '<option value="">Loading...</option>';

    const activeMission = await getActiveMission(serverId, serverContext.guildId, requestId);
    if (requestId !== mapDiscoveryRequestId || !selectedServerContext(serverId)) return;

    const res = await fetch('/api/server-maps/' + serverId + '?guildId=' + encodeURIComponent(serverContext.guildId));
    const data = await res.json();
    if (requestId !== mapDiscoveryRequestId || !selectedServerContext(serverId)) return;

    const select = document.getElementById('map-select');
    select.innerHTML = '<option value="">Select Map...</option>';

    if (data.success && data.maps && data.maps.length > 0) {
      data.maps.forEach(function(mapName) {
        const config = mapConfigs[mapName];
        const option = document.createElement('option');
        option.value = mapName;

        if (mapName === activeMission) {
          option.textContent = (config ? config.name : mapName) + ' ⭐ ACTIVE';
          option.selected = true;
        } else {
          option.textContent = config ? config.name : mapName;
        }

        select.appendChild(option);
      });

      if (activeMission) {
        loadMapData(serverId, activeMission);
        loadEnabledHeatmaps();
      }
    } else {
      select.innerHTML = '<option value="">No maps found - Sync server first</option>';
    }

  } catch (err) {
    if (requestId !== mapDiscoveryRequestId || !selectedServerContext(serverId)) return;
    console.error('Failed to load maps:', err);
    document.getElementById('map-select').innerHTML = '<option value="">Error loading maps</option>';
  }
}

function eventHealthPriority(event) {
  const priorities = { error: 0, degraded: 1, attempted: 2, warning: 3, spawned: 4, positioned: 5, observed: 6 };
  const namePriority = /train|locked|container/i.test(event.name) ? -2 : 0;
  return namePriority + (priorities[event.status] ?? 7);
}

function renderEventHealth() {
  const results = document.getElementById('event-health-results');
  const summary = document.getElementById('event-health-summary');
  const limit = document.getElementById('event-health-limit');
  results.replaceChildren();
  if (!lastEventHealth || !lastEventHealth.success) return;

  const search = document.getElementById('event-health-search').value.trim().toLowerCase();
  const allEvents = lastEventHealth.events || [];
  const events = allEvents.filter(event => !search || event.name.toLowerCase().includes(search))
    .sort((a, b) => eventHealthPriority(a) - eventHealthPriority(b) || a.name.localeCompare(b.name))
    .slice(0, search ? 50 : 18);
  const counts = allEvents.reduce((result, event) => {
    result[event.status] = (result[event.status] || 0) + 1;
    return result;
  }, {});
  const source = lastEventHealth.sourceFile || 'no RPT retained';
  summary.textContent = `${allEvents.length} with spawn-position/runtime evidence · ${counts.spawned || 0} spawned · ` +
    `${(counts.error || 0) + (counts.degraded || 0)} need attention · source: ${source}`;
  limit.textContent = [
    lastEventHealth.presenceLimitation,
    lastEventHealth.runtimeEvidenceLimitation,
    lastEventHealth.configurationError,
  ].filter(Boolean).join(' ');

  const colors = {
    spawned: '#10b981', degraded: '#f97316', error: '#ef4444', attempted: '#eab308',
    warning: '#f59e0b', positioned: '#6b7280', observed: '#3b82f6',
  };
  for (const event of events) {
    const card = document.createElement('article');
    card.style.cssText = 'border:1px solid #4b5563;border-left:4px solid ' +
      (colors[event.status] || '#6b7280') + ';border-radius:6px;padding:10px;background:#1f2937;';
    const heading = document.createElement('div');
    heading.style.cssText = 'display:flex;justify-content:space-between;gap:8px;font-weight:600;';
    const name = document.createElement('span');
    name.textContent = event.name;
    const status = document.createElement('span');
    status.textContent = event.status;
    status.style.color = colors[event.status] || '#9ca3af';
    heading.append(name, status);

    const evidence = document.createElement('div');
    evidence.className = 'text-xs text-gray-400 mt-1';
    evidence.textContent = `${event.positions || 0} candidate positions · ${event.attempts || 0} attempts · ` +
      `${event.successfulInstances || 0} spawned instances · ${event.refusals || 0} refusals · ` +
      `${event.failures || 0} failures · ` +
      `${event.cleanupObservations || 0} cleanup signals`;
    card.append(heading, evidence);

    const latest = event.lastFailure || event.lastSuccess || event.lastAttempt;
    if (latest) {
      const detail = document.createElement('div');
      detail.className = 'text-xs text-gray-500 mt-1';
      const when = latest.observedAt ? new Date(latest.observedAt).toLocaleString() : latest.clock;
      detail.textContent = `Latest evidence: ${when || 'unknown time'}`;
      card.appendChild(detail);
    }
    if (event.diagnostics && event.diagnostics.length) {
      const diagnostic = document.createElement('div');
      diagnostic.className = 'text-xs mt-1';
      diagnostic.style.color = '#fbbf24';
      diagnostic.textContent = event.diagnostics[event.diagnostics.length - 1].message;
      card.appendChild(diagnostic);
    }
    results.appendChild(card);
  }
  if (!events.length) {
    const empty = document.createElement('p');
    empty.className = 'text-sm text-gray-400';
    empty.textContent = 'No matching event evidence.';
    results.appendChild(empty);
  }
}

async function loadEventHealth(serverId, mapName, guildId) {
  const requestId = ++eventHealthRequestId;
  const summary = document.getElementById('event-health-summary');
  if (!guildId || !selectedServerContext(serverId)) {
    summary.textContent = 'Select an exact server to check retained event evidence.';
    return;
  }
  summary.textContent = 'Checking retained RPT event evidence…';
  try {
    const response = await fetch('/api/event-health?serverId=' + encodeURIComponent(serverId) +
      '&map=' + encodeURIComponent(mapName) + '&guildId=' + encodeURIComponent(guildId));
    const result = await response.json();
    if (requestId !== eventHealthRequestId) return;
    lastEventHealth = result;
    if (!response.ok || !lastEventHealth.success) {
      summary.textContent = lastEventHealth.error || 'Event health is unavailable.';
      document.getElementById('event-health-results').replaceChildren();
      return;
    }
    renderEventHealth();
  } catch (error) {
    if (requestId !== eventHealthRequestId) return;
    console.error('Failed to load event health:', error);
    summary.textContent = 'Event health is unavailable.';
    document.getElementById('event-health-results').replaceChildren();
  }
}

async function loadMapData(serverId, mapName, isAutoRefresh = false) {
  const serverContext = selectedServerContext(serverId);
  if (!serverContext) return;
  const requestId = ++mapDataRequestId;
  const requestContextGeneration = contextGeneration;
  if (!isAutoRefresh) {
    document.getElementById('loading').style.display = 'flex';
    document.getElementById('loading-status').textContent = 'Loading map tiles...';
  }

  currentMapName = mapName;

  if (!isAutoRefresh) {
    initMap(mapName);
    loadEventHealth(serverId, mapName, serverContext.guildId);
  } else {
    loadEventHealth(serverId, mapName, serverContext.guildId);
  }

  try {
    if (!isAutoRefresh) {
      document.getElementById('loading-status').textContent = 'Loading event spawn locations...';
    }

    // Clear existing markers
    Object.values(markers).forEach(function(marker) {
      marker.remove();
    });
    markers = {};
    allEventData = [];

    // Load event spawns
    const eventSpawnsRes = await fetch('/api/event-spawns/' + serverId + '/' + mapName +
      '?guildId=' + encodeURIComponent(serverContext.guildId));
    const eventSpawnsData = await eventSpawnsRes.json();
    if (requestId !== mapDataRequestId || requestContextGeneration !== contextGeneration || !selectedServerContext(serverId)) return;

    if (eventSpawnsData.success && eventSpawnsData.events) {
      let markerCount = 0;

      const mapConfig = mapConfigs[mapName] || mapConfigs['enoch'];
      const scale = mapConfig.imageWidth / mapConfig.worldWidth;

      console.log('🗺️  Map: ' + mapName + ', Game size: ' + mapConfig.worldWidth + ', Scale: ' + scale.toFixed(3));

      const eventTypes = {};

      eventSpawnsData.events.forEach(function(event) {
        const eventName = event.name;
        const color = getEventColor(eventName);

        if (!eventTypes[eventName]) {
          eventTypes[eventName] = {
            count: 0,
            color: color
          };
        }

        event.positions.forEach(function(pos, i) {
          const latlng = gameToLeaflet(pos.x, pos.z, mapName);
          const tileX = latlng[1];
          const tileZ = latlng[0];

          const markerRadius = 8;
          const markerWeight = 2;

          const marker = L.circleMarker([tileZ, tileX], {
            radius: markerRadius,
            fillColor: color,
            color: '#fff',
            weight: markerWeight,
            opacity: 1,
            fillOpacity: 0.9
          })
            .addTo(map)
            .bindPopup('<div class="text-gray-900"><strong style="font-size: 14px;">' + escapeHtml(eventName) + '</strong><br>Game XML: ' + pos.x.toFixed(2) + ', ' + pos.z.toFixed(2) + '<br>Tile: ' + tileX.toFixed(2) + ', ' + tileZ.toFixed(2) + '<br>Angle: ' + (pos.a || 0).toFixed(2) + '°</div>');

          marker.on('click', function(e) {
            if (!radiusSearchMode) {
              map.setView([tileZ, tileX], 1);
            }
          });

          const markerId = 'event_' + eventName + '_' + i;
          markers[markerId] = marker;

          allEventData.push({
            id: markerId,
            name: eventName,
            marker: marker,
            tileX: tileX,
            tileZ: tileZ,
            gameX: pos.x,
            gameZ: pos.z,
            color: color
          });

          markerCount++;
          eventTypes[eventName].count++;
        });
      });

      console.log('✓ Loaded ' + markerCount + ' event spawn locations');

      if (!isAutoRefresh) {
        initializeEventTypeFilters(eventTypes);
      } else {
        // Just update the counts in existing filters
        Object.entries(eventTypes).forEach(function([eventName, data]) {
          const checkbox = document.getElementById('filter_' + eventName);
          if (checkbox) {
            const label = checkbox.nextElementSibling;
            if (label) {
              const textNode = label.childNodes[label.childNodes.length - 1];
              if (textNode) {
                textNode.textContent = eventName + ' (' + data.count + ')';
              }
            }
          }
        });
      }

      updateFilterStats();

      // Update stats with trends
      updateStatTrend('spawns', markerCount, previousStats.spawns);
      updateStatTrend('events', eventSpawnsData.events.length, previousStats.events);

      previousStats.spawns = markerCount;
      previousStats.events = eventSpawnsData.events.length;

      document.getElementById('stat-spawns').textContent = markerCount;
      document.getElementById('stat-events').textContent = eventSpawnsData.events.length;

      // Update last refresh time
      const now = new Date();
      document.getElementById('last-update-time').textContent = now.toLocaleTimeString();
    } else {
      document.getElementById('stat-spawns').textContent = '0';
      document.getElementById('stat-events').textContent = '0';
    }

    const mapConfig = mapConfigs[mapName] || mapConfigs.enoch;
    document.getElementById('stat-size').textContent = mapConfig.gameSize + 'm';

    const isActive = mapName === activeMapName ? ' (ACTIVE)' : '';
    document.getElementById('server-info').textContent = mapConfig.name + isActive + ' - High Resolution Satellite View';

    if (!isAutoRefresh) {
      document.getElementById('loading').style.display = 'none';
    }

  } catch (err) {
    if (requestId !== mapDataRequestId || requestContextGeneration !== contextGeneration || !selectedServerContext(serverId)) return;
    console.error('Failed to load map data:', err);
    if (!isAutoRefresh) {
      document.getElementById('loading').style.display = 'none';
    }

    const mapConfig = mapConfigs[mapName] || mapConfigs['enoch'];
    document.getElementById('server-info').textContent = mapConfig.name + ' - Satellite View';
  }
}

function updateStatTrend(statName, currentValue, previousValue) {
  const trendElement = document.getElementById('stat-' + statName + '-trend');
  if (!trendElement) return;

  const diff = currentValue - previousValue;

  if (diff > 0) {
    trendElement.className = 'stat-trend up';
    trendElement.innerHTML = '▲ +' + diff + ' from last update';
  } else if (diff < 0) {
    trendElement.className = 'stat-trend down';
    trendElement.innerHTML = '▼ ' + diff + ' from last update';
  } else {
    trendElement.className = 'stat-trend neutral';
    trendElement.innerHTML = '— No change';
  }
}

function initializeEventTypeFilters(eventTypes) {
  const container = document.getElementById('event-type-filters');
  container.innerHTML = '';

  eventTypeFilters = {};

  const sorted = Object.entries(eventTypes).sort((a, b) => b[1].count - a[1].count);

  const buttonContainer = document.createElement('div');
  buttonContainer.style.marginBottom = '8px';
  buttonContainer.style.display = 'flex';
  buttonContainer.style.gap = '4px';
  buttonContainer.style.flexWrap = 'wrap';

  const selectAllBtn = document.createElement('button');
  selectAllBtn.textContent = '✓ All';
  selectAllBtn.className = 'btn-small btn-success';
  selectAllBtn.onclick = selectAllEventTypes;

  const deselectAllBtn = document.createElement('button');
  deselectAllBtn.textContent = '✕ None';
  deselectAllBtn.className = 'btn-small btn-danger';
  deselectAllBtn.onclick = deselectAllEventTypes;

  const resetColorsBtn = document.createElement('button');
  resetColorsBtn.textContent = '🎨 Reset Colors';
  resetColorsBtn.className = 'btn-small';
  resetColorsBtn.style.background = '#f59e0b';
  resetColorsBtn.style.color = 'white';
  resetColorsBtn.title = 'Reset all colors to auto-generated';
  resetColorsBtn.onclick = resetAllColors;

  buttonContainer.appendChild(selectAllBtn);
  buttonContainer.appendChild(deselectAllBtn);
  buttonContainer.appendChild(resetColorsBtn);
  container.appendChild(buttonContainer);

  sorted.forEach(function([eventName, data]) {
    eventTypeFilters[eventName] = true;

    const div = document.createElement('div');
    div.className = 'filter-checkbox';
    div.style.display = 'flex';
    div.style.alignItems = 'center';
    div.style.gap = '6px';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = 'filter_' + eventName;
    checkbox.checked = true;
    checkbox.onchange = function() {
      eventTypeFilters[eventName] = checkbox.checked;
      applyFilters();
    };

    const label = document.createElement('label');
    label.htmlFor = 'filter_' + eventName;
    label.style.flex = '1';
    label.style.cursor = 'pointer';
    label.style.display = 'flex';
    label.style.alignItems = 'center';
    label.style.gap = '6px';

    const colorDot = document.createElement('span');
    colorDot.className = 'color-dot';
    colorDot.style.background = data.color;
    colorDot.id = 'dot_' + eventName;

    label.appendChild(colorDot);
    label.appendChild(document.createTextNode(eventName + ' (' + data.count + ')'));

    const colorPicker = document.createElement('input');
    colorPicker.type = 'color';
    colorPicker.value = rgbToHex(data.color);
    colorPicker.setAttribute('data-event', eventName);
    colorPicker.style.width = '30px';
    colorPicker.style.height = '24px';
    colorPicker.style.border = 'none';
    colorPicker.style.cursor = 'pointer';
    colorPicker.style.borderRadius = '4px';
    colorPicker.title = 'Change color';
    colorPicker.onchange = function() {
      saveEventColor(eventName, colorPicker.value);
      updateEventColors(eventName, colorPicker.value);
    };

    const resetBtn = document.createElement('button');
    resetBtn.textContent = '↺';
    resetBtn.title = 'Reset to auto color';
    resetBtn.className = 'btn-small';
    resetBtn.style.padding = '2px 6px';
    resetBtn.style.fontSize = '14px';
    resetBtn.style.background = '#4b5563';
    resetBtn.style.color = 'white';
    resetBtn.style.minWidth = '24px';
    resetBtn.onclick = function() {
      resetEventColor(eventName);
      const autoColor = getEventColor(eventName);
      colorPicker.value = rgbToHex(autoColor);
      updateEventColors(eventName, autoColor);
    };

    div.appendChild(checkbox);
    div.appendChild(label);
    div.appendChild(colorPicker);
    div.appendChild(resetBtn);
    container.appendChild(div);
  });
}

function applyFilters() {
  let visibleCount = 0;
  let hiddenCount = 0;

  allEventData.forEach(function(event) {
    const shouldShow = eventTypeFilters[event.name];

    if (shouldShow) {
      if (!map.hasLayer(event.marker)) {
        event.marker.addTo(map);
      }
      visibleCount++;
    } else {
      if (map.hasLayer(event.marker)) {
        map.removeLayer(event.marker);
      }
      hiddenCount++;
    }
  });

  updateFilterStats();
}

function updateFilterStats() {
  const total = allEventData.length;
  const visible = allEventData.filter(e => eventTypeFilters[e.name]).length;
  const hidden = total - visible;

  document.getElementById('filter-stat-total').textContent = total;
  document.getElementById('filter-stat-visible').textContent = visible;
  document.getElementById('filter-stat-hidden').textContent = hidden;
}

function selectAllEventTypes() {
  Object.keys(eventTypeFilters).forEach(function(key) {
    eventTypeFilters[key] = true;
    const checkbox = document.getElementById('filter_' + key);
    if (checkbox) checkbox.checked = true;
  });
  applyFilters();
}

function deselectAllEventTypes() {
  Object.keys(eventTypeFilters).forEach(function(key) {
    eventTypeFilters[key] = false;
    const checkbox = document.getElementById('filter_' + key);
    if (checkbox) checkbox.checked = false;
  });
  applyFilters();
}

function searchEvents() {
  const query = document.getElementById('search-input').value.toLowerCase();
  const resultsContainer = document.getElementById('search-results');

  if (query.length < 2) {
    resultsContainer.innerHTML = '';
    return;
  }

  const matches = allEventData.filter(function(event) {
    return event.name.toLowerCase().includes(query);
  });

  if (matches.length === 0) {
    resultsContainer.innerHTML = '<div style="padding: 8px; color: #9ca3af;">No results found</div>';
    return;
  }

  resultsContainer.innerHTML = '';

  matches.slice(0, 10).forEach(function(event) {
    const div = document.createElement('div');
    div.className = 'search-result-item';
    div.onclick = function() {
      map.setView([event.tileZ, event.tileX], 1);
      event.marker.openPopup();
    };

    const colorDot = document.createElement('span');
    colorDot.className = 'color-dot';
    colorDot.style.background = event.color;

    const text = document.createElement('span');
    text.textContent = event.name;

    const coords = document.createElement('span');
    coords.style.fontSize = '11px';
    coords.style.color = '#9ca3af';
    coords.textContent = '(' + event.gameX.toFixed(0) + ', ' + event.gameZ.toFixed(0) + ')';

    div.appendChild(colorDot);
    div.appendChild(text);
    div.appendChild(coords);
    resultsContainer.appendChild(div);
  });

  if (matches.length > 10) {
    const more = document.createElement('div');
    more.style.padding = '8px';
    more.style.color = '#9ca3af';
    more.style.fontSize = '11px';
    more.textContent = '+ ' + (matches.length - 10) + ' more results...';
    resultsContainer.appendChild(more);
  }
}

function startRadiusSearch() {
  radiusSearchMode = true;
  document.getElementById('radius-btn').style.display = 'none';
  document.getElementById('cancel-radius-btn').style.display = 'inline-block';
  document.getElementById('radius-results').textContent = '📍 Click anywhere on the map...';
  map.getContainer().classList.add('radius-mode');
}

function cancelRadiusSearch() {
  radiusSearchMode = false;
  document.getElementById('radius-btn').style.display = 'inline-block';
  document.getElementById('cancel-radius-btn').style.display = 'none';
  document.getElementById('radius-results').textContent = '';
  map.getContainer().classList.remove('radius-mode');

  if (radiusCircle) {
    map.removeLayer(radiusCircle);
    radiusCircle = null;
  }
  if (radiusMarker) {
    map.removeLayer(radiusMarker);
    radiusMarker = null;
  }
}

function onMapClick(e) {
  if (!radiusSearchMode) return;

  const clickTileX = e.latlng.lng;
  const clickTileZ = e.latlng.lat;

  const radius = parseInt(document.getElementById('radius-input').value) || 500;

  const mapConfig = mapConfigs[currentMapName] || mapConfigs['enoch'];
  const scale = mapConfig.size / mapConfig.gameSize;
  const radiusTile = radius * scale;

  if (radiusCircle) map.removeLayer(radiusCircle);
  if (radiusMarker) map.removeLayer(radiusMarker);

  radiusCircle = L.circle([clickTileZ, clickTileX], {
    radius: radiusTile,
    fillColor: '#3b82f6',
    fillOpacity: 0.1,
    color: '#3b82f6',
    weight: 2
  }).addTo(map);

  radiusMarker = L.circleMarker([clickTileZ, clickTileX], {
    radius: 8,
    fillColor: '#3b82f6',
    color: '#fff',
    weight: 2,
    fillOpacity: 1
  }).addTo(map);

  const eventsInRadius = allEventData.filter(function(event) {
    const dx = event.tileX - clickTileX;
    const dz = event.tileZ - clickTileZ;
    const distance = Math.sqrt(dx * dx + dz * dz);
    return distance <= radiusTile;
  });

  const grouped = {};
  eventsInRadius.forEach(function(event) {
    if (!grouped[event.name]) {
      grouped[event.name] = 0;
    }
    grouped[event.name]++;
  });

  let resultText = '✅ Found ' + eventsInRadius.length + ' events:<br>';
  Object.entries(grouped).forEach(function([name, count]) {
    resultText += '<span style="color: ' + getEventColor(name) + ';">●</span> ' + escapeHtml(name) + ' (' + count + ')<br>';
  });

  document.getElementById('radius-results').innerHTML = resultText;

  radiusSearchMode = false;
  document.getElementById('radius-btn').style.display = 'inline-block';
  document.getElementById('cancel-radius-btn').style.display = 'none';
  map.getContainer().classList.remove('radius-mode');
}

function toggleFilterPanel() {
  const panel = document.getElementById('filter-panel');
  const isMinimized = panel.classList.contains('minimized');

  if (isMinimized) {
    panel.classList.remove('minimized');
    panel.classList.add('maximized');
    localStorage.setItem('filterPanelState', 'maximized');
  } else {
    panel.classList.add('minimized');
    panel.classList.remove('maximized');
    localStorage.setItem('filterPanelState', 'minimized');
  }
}

function toggleAutoRefresh() {
  autoRefreshEnabled = document.getElementById('auto-refresh-toggle').checked;

  if (autoRefreshEnabled) {
    startAutoRefresh();
    document.getElementById('auto-refresh-badge').style.display = 'inline-flex';
  } else {
    stopAutoRefresh();
    document.getElementById('auto-refresh-badge').style.display = 'none';
  }

  localStorage.setItem('autoRefreshEnabled', autoRefreshEnabled);
}

function startAutoRefresh() {
  stopAutoRefresh();

  refreshSeconds = 30;
  updateRefreshTimer();

  refreshCountdown = setInterval(function() {
    refreshSeconds--;
    updateRefreshTimer();

    if (refreshSeconds <= 0) {
      if (currentServer && currentMapName) {
        console.log('🔄 Auto-refreshing map data...');
        const serverContext = selectedServerContext(currentServer);
        if (serverContext) {
          loadMapData(currentServer, currentMapName, true);
          getActiveMission(currentServer, serverContext.guildId);
        }
      }
      refreshSeconds = 30;
    }
  }, 1000);
}

function stopAutoRefresh() {
  if (refreshCountdown) {
    clearInterval(refreshCountdown);
    refreshCountdown = null;
  }
}

function updateRefreshTimer() {
  document.getElementById('refresh-timer').textContent = 'Auto-refresh in ' + refreshSeconds + 's';
}

function manualRefresh() {
  if (currentServer) {
    loadMapsForServer(currentServer);
    refreshSeconds = 30;
    updateRefreshTimer();
  }
}

function loadEnabledHeatmaps() {
  loadHeatmap();
  loadKillHeatmap();
  loadDeathHeatmap();
  loadMovementHeatmap();
}

function clearSelectedContext() {
  Object.values(markers).forEach(marker => marker.remove());
  markers = {};
  allEventData = [];
  lastEventHealth = null;
  document.getElementById('event-health-summary').textContent = 'Select a server and map to inspect event evidence.';
  document.getElementById('event-health-results').replaceChildren();
  document.getElementById('event-health-limit').textContent = '';
  for (const layer of [heatLayer, killHeatLayer, deathHeatLayer, movementHeatLayer]) {
    if (layer && map) map.removeLayer(layer);
  }
  heatLayer = null;
  killHeatLayer = null;
  deathHeatLayer = null;
  movementHeatLayer = null;
}

// Event listeners
document.getElementById('server-select').addEventListener('change', function(e) {
  contextGeneration++;
  mapDiscoveryRequestId++;
  mapDataRequestId++;
  eventHealthRequestId++;
  currentServer = e.target.value;
  clearSelectedContext();
  if (currentServer) {
    loadMapsForServer(currentServer);
    if (autoRefreshEnabled) {
      startAutoRefresh();
    }
  }
});

document.getElementById('map-select').addEventListener('change', function(e) {
  const mapName = e.target.value;
  if (mapName && currentServer) {
    contextGeneration++;
    mapDataRequestId++;
    eventHealthRequestId++;
    clearSelectedContext();
    loadMapData(currentServer, mapName);
    loadEnabledHeatmaps();
  }
});

// Initialize
currentMapName = 'enoch';
initMap('enoch');
loadServers();

document.getElementById('event-health-search').addEventListener('input', renderEventHealth);
document.getElementById('event-health-refresh').addEventListener('click', function() {
  const context = selectedServerContext(currentServer);
  if (currentServer && currentMapName && context) loadEventHealth(currentServer, currentMapName, context.guildId);
});

document.getElementById('server-info').textContent = 'Livonia - High Resolution Satellite View';
document.getElementById('stat-size').textContent = '12800m';

// Restore filter panel state
const savedPanelState = localStorage.getItem('filterPanelState') || 'maximized';
const panel = document.getElementById('filter-panel');
if (savedPanelState === 'minimized') {
  panel.classList.add('minimized');
  panel.classList.remove('maximized');
}

// Restore auto-refresh state
const savedAutoRefresh = localStorage.getItem('autoRefreshEnabled');
if (savedAutoRefresh !== null) {
  autoRefreshEnabled = savedAutoRefresh === 'true';
  document.getElementById('auto-refresh-toggle').checked = autoRefreshEnabled;
  if (autoRefreshEnabled) {
    document.getElementById('auto-refresh-badge').style.display = 'inline-flex';
  }
}

// Set up event listeners
document.getElementById('refresh-btn').addEventListener('click', manualRefresh);
document.getElementById('filter-header').addEventListener('click', toggleFilterPanel);
document.getElementById('search-input').addEventListener('keyup', searchEvents);
document.getElementById('radius-btn').addEventListener('click', startRadiusSearch);
document.getElementById('cancel-radius-btn').addEventListener('click', cancelRadiusSearch);
document.getElementById('auto-refresh-toggle').addEventListener('change', toggleAutoRefresh);

// ─── Loot Despawn Heatmap ───────────────────────────────────────────────────

/**
 * Fetch grid-aggregated despawn data and render the heat layer.
 * Converts DayZ game coordinates to Leaflet tile coordinates using the
 * same scale formula as the rest of the map: tileCoord = gameCoord * (size / gameSize).
 */
async function loadHeatmap() {
  if (!heatmapEnabled || !currentServer) return;

  const requestId = ++lootHeatmapRequestId;
  const serverId = currentServer;
  const mapName = currentMapName;
  const requestContextGeneration = contextGeneration;

  const days     = document.getElementById('heatmap-days').value;
  const gridSize = document.getElementById('heatmap-grid').value;
  const statusEl = document.getElementById('heatmap-status');
  statusEl.textContent = '⏳ Loading…';

  try {
    const params = new URLSearchParams({
      serverId,
      days,
      gridSize,
      filter: heatmapFilter,
    });
    const res  = await fetch('/api/loot/heatmap?' + params);
    const data = await res.json();
    if (requestId !== lootHeatmapRequestId || requestContextGeneration !== contextGeneration ||
        serverId !== currentServer || mapName !== currentMapName) return;

    if (!data.ok) {
      statusEl.textContent = '❌ ' + data.error;
      return;
    }

    const maxCnt = data.points.reduce((m, p) => Math.max(m, p[2]), 1);

    // Convert [gameX, gameZ, count] → [leafletLat, leafletLng, intensity]
    const leafletPoints = data.points.map(function([gx, gz, cnt]) {
      const latlng = gameToLeaflet(gx, gz, mapName);
      return [latlng[0], latlng[1], cnt / maxCnt];
    });

    if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }

    if (leafletPoints.length > 0) {
      heatLayer = L.heatLayer(leafletPoints, {
        radius:     25,
        blur:       20,
        maxZoom:    6,
        minOpacity: 0.3,
        gradient:   { 0.0: 'blue', 0.4: 'cyan', 0.65: 'lime', 0.8: 'yellow', 1.0: 'red' },
      }).addTo(map);
    }

    statusEl.textContent = '✅ ' + data.total.toLocaleString() + ' events (' + data.points.length + ' cells)';
    renderHeatmapTopItems(data.topItems);
  } catch (err) {
    if (requestId !== lootHeatmapRequestId || requestContextGeneration !== contextGeneration) return;
    document.getElementById('heatmap-status').textContent = '❌ Failed to load heatmap';
    console.error('Heatmap load error:', err);
  }
}

/** Render the top-10 most despawned item classes in the filter panel. */
function renderHeatmapTopItems(items) {
  const el = document.getElementById('heatmap-top-items');
  if (!items || items.length === 0) { el.innerHTML = ''; return; }

  const max = items[0].cnt;
  el.innerHTML = '<div style="font-size:11px; font-weight:600; color:#9ca3af; margin-bottom:6px; text-transform:uppercase; letter-spacing:0.5px;">Top Despawned</div>' +
    items.slice(0, 10).map(function(it) {
      const pct = Math.round((it.cnt / max) * 100);
      return '<div style="margin-bottom:5px;">' +
        '<div style="display:flex; justify-content:space-between; font-size:10px; color:#d1d5db; margin-bottom:2px;">' +
          '<span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:130px;">' + escapeHtml(it.item_class) + '</span>' +
          '<span style="color:#9ca3af; flex-shrink:0; margin-left:4px;">' + it.cnt + '</span>' +
        '</div>' +
        '<div style="height:3px; background:#374151; border-radius:2px;">' +
          '<div style="width:' + pct + '%; height:3px; background:#ef4444; border-radius:2px;"></div>' +
        '</div>' +
      '</div>';
    }).join('');
}

/** Toggle the heatmap on/off; reload when turned on. */
function toggleHeatmap() {
  heatmapEnabled = document.getElementById('heatmap-toggle').checked;
  document.getElementById('heatmap-controls').style.display = heatmapEnabled ? 'block' : 'none';

  if (!heatmapEnabled) {
    lootHeatmapRequestId++;
    if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }
    document.getElementById('heatmap-status').textContent = '';
    document.getElementById('heatmap-top-items').innerHTML = '';
  } else {
    loadHeatmap();
  }
}

// Heatmap event listeners
document.getElementById('heatmap-toggle').addEventListener('change', toggleHeatmap);
document.getElementById('heatmap-days').addEventListener('change', loadHeatmap);
document.getElementById('heatmap-grid').addEventListener('change', loadHeatmap);
document.querySelectorAll('.heatmap-filter-btn').forEach(function(btn) {
  btn.addEventListener('click', function() {
    document.querySelectorAll('.heatmap-filter-btn').forEach(function(b) { b.classList.remove('active'); });
    this.classList.add('active');
    heatmapFilter = this.dataset.filter;
    loadHeatmap();
  });
});

// ─── Kill / Death / Movement Heatmaps ───────────────────────────────────────

/**
 * Generic helper: fetch a heatmap endpoint, convert game coords to Leaflet
 * coords, and render an L.heatLayer with the given gradient.
 *
 * @param {string}            endpoint       - API path (e.g. '/api/map/kill-heatmap')
 * @param {Object}            gradient       - Leaflet.heat gradient object
 * @param {L.HeatLayer|null}  existingLayer  - current layer to remove first
 * @param {string}            statusElId     - DOM id for status text
 * @returns {Promise<L.HeatLayer|null>}
 */
async function loadGenericHeatmap(endpoint, gradient, existingLayer, statusElId) {
  if (!currentServer) return null;

  const requestId = (genericHeatmapRequestIds[statusElId] || 0) + 1;
  genericHeatmapRequestIds[statusElId] = requestId;
  const serverId = currentServer;
  const mapName = currentMapName;
  const requestContextGeneration = contextGeneration;

  const days     = document.getElementById('heatmap-days').value;
  const gridSize = document.getElementById('heatmap-grid').value;
  const statusEl = document.getElementById(statusElId);
  if (statusEl) statusEl.textContent = '⏳ Loading…';

  try {
    const params = new URLSearchParams({ serverId, days, gridSize });
    const res  = await fetch(endpoint + '?' + params);
    const data = await res.json();
    if (requestId !== genericHeatmapRequestIds[statusElId] || requestContextGeneration !== contextGeneration ||
        serverId !== currentServer || mapName !== currentMapName) return undefined;

    if (!data.ok) {
      if (statusEl) statusEl.textContent = '❌ ' + data.error;
      return null;
    }

    const maxCnt = data.points.reduce((m, p) => Math.max(m, p[2]), 1);

    // Convert [gameX, gameZ, count] → [leafletLat, leafletLng, intensity]
    const leafletPoints = data.points.map(function([gx, gz, cnt]) {
      const latlng = gameToLeaflet(gx, gz, mapName);
      return [latlng[0], latlng[1], cnt / maxCnt];
    });

    if (existingLayer) map.removeLayer(existingLayer);

    let newLayer = null;
    if (leafletPoints.length > 0) {
      newLayer = L.heatLayer(leafletPoints, {
        radius:     25,
        blur:       20,
        maxZoom:    6,
        minOpacity: 0.3,
        gradient,
      }).addTo(map);
    }

    if (statusEl) {
      statusEl.textContent = '✅ ' + data.total.toLocaleString() + ' events (' + data.points.length + ' cells)';
    }
    return newLayer;
  } catch (err) {
    if (requestId !== genericHeatmapRequestIds[statusElId] || requestContextGeneration !== contextGeneration) return undefined;
    if (statusEl) statusEl.textContent = '❌ Failed to load';
    console.error('Heatmap load error (' + endpoint + '):', err);
    return null;
  }
}

/** Fetch and render the kill-locations heatmap (red-hot gradient). */
async function loadKillHeatmap() {
  if (!killHeatmapEnabled) return;
  const layer = await loadGenericHeatmap(
    '/api/map/kill-heatmap',
    { 0: 'blue', 0.5: 'yellow', 1: 'red' },
    killHeatLayer,
    'kill-heatmap-status'
  );
  if (layer !== undefined) killHeatLayer = layer;
}

/** Fetch and render the death-locations heatmap (purple gradient). */
async function loadDeathHeatmap() {
  if (!deathHeatmapEnabled) return;
  const layer = await loadGenericHeatmap(
    '/api/map/death-heatmap',
    { 0: 'navy', 0.5: 'purple', 1: 'magenta' },
    deathHeatLayer,
    'death-heatmap-status'
  );
  if (layer !== undefined) deathHeatLayer = layer;
}

/** Fetch and render the player-movement heatmap (green gradient). */
async function loadMovementHeatmap() {
  if (!movementHeatmapEnabled) return;
  const layer = await loadGenericHeatmap(
    '/api/map/movement-heatmap',
    { 0: 'darkgreen', 0.5: 'lime', 1: 'white' },
    movementHeatLayer,
    'movement-heatmap-status'
  );
  if (layer !== undefined) movementHeatLayer = layer;
}

// Toggle: kill heatmap
document.getElementById('kill-heatmap-toggle').addEventListener('change', function() {
  killHeatmapEnabled = this.checked;
  if (!killHeatmapEnabled) {
    genericHeatmapRequestIds['kill-heatmap-status'] = (genericHeatmapRequestIds['kill-heatmap-status'] || 0) + 1;
    if (killHeatLayer) { map.removeLayer(killHeatLayer); killHeatLayer = null; }
    const el = document.getElementById('kill-heatmap-status');
    if (el) el.textContent = '';
  } else {
    loadKillHeatmap();
  }
});

// Toggle: death heatmap
document.getElementById('death-heatmap-toggle').addEventListener('change', function() {
  deathHeatmapEnabled = this.checked;
  if (!deathHeatmapEnabled) {
    genericHeatmapRequestIds['death-heatmap-status'] = (genericHeatmapRequestIds['death-heatmap-status'] || 0) + 1;
    if (deathHeatLayer) { map.removeLayer(deathHeatLayer); deathHeatLayer = null; }
    const el = document.getElementById('death-heatmap-status');
    if (el) el.textContent = '';
  } else {
    loadDeathHeatmap();
  }
});

// Toggle: movement heatmap
document.getElementById('movement-heatmap-toggle').addEventListener('change', function() {
  movementHeatmapEnabled = this.checked;
  if (!movementHeatmapEnabled) {
    genericHeatmapRequestIds['movement-heatmap-status'] = (genericHeatmapRequestIds['movement-heatmap-status'] || 0) + 1;
    if (movementHeatLayer) { map.removeLayer(movementHeatLayer); movementHeatLayer = null; }
    const el = document.getElementById('movement-heatmap-status');
    if (el) el.textContent = '';
  } else {
    loadMovementHeatmap();
  }
});

// Reload all three when the shared days/grid selectors change
(function attachHeatmapReloaders() {
  const daysEl = document.getElementById('heatmap-days');
  const gridEl = document.getElementById('heatmap-grid');
  function reloadAll() {
    loadKillHeatmap();
    loadDeathHeatmap();
    loadMovementHeatmap();
  }
  if (daysEl) daysEl.addEventListener('change', reloadAll);
  if (gridEl) gridEl.addEventListener('change', reloadAll);
}());
