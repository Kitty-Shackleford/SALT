/*
 * DayZ Dashboard — Loot Finder Frontend
 * Copyright (C) 2026
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License.
 *
 * Wires up the loot-finder.html UI to the backend loot API.
 * Features: item search, filter dropdowns, Leaflet spawn map, live loot feed (admin).
 */

// ─── Constants ────────────────────────────────────────────────────────────────

// Canonical measured map geometry and world transforms.
const MAP_CONFIGS = DayzMapCoordinates.MAP_DEFINITIONS;

// Tier badge colors, matching the CSS tier-badge-* classes in the HTML
const TIER_COLORS = {
  Tier1: '#10b981',
  Tier2: '#3b82f6',
  Tier3: '#f97316',
  Tier4: '#ef4444',
};
const TIER_BADGE_CLASSES = {
  Tier1: 'tier-badge-Tier1',
  Tier2: 'tier-badge-Tier2',
  Tier3: 'tier-badge-Tier3',
  Tier4: 'tier-badge-Tier4',
};
const DEFAULT_MARKER_COLOR   = '#a855f7';
// Dynamic event items (deloot=1) get a distinct amber marker so they're
// visually distinguishable from static building loot on the map.
const DYNAMIC_EVENT_COLOR = '#f59e0b';

const SEARCH_DEBOUNCE_MS = 300;

// ─── Module State ─────────────────────────────────────────────────────────────

let currentUser = null;
let isAdmin = false;
let currentMapName = 'chernarusplus';
let currentServerId = null; // Nitrado platform server ID

// Leaflet map state — map is initialized once and reused
let lootMap = null;
let mapTileLayerGroup = null;   // layer group holding background tile overlays
let mapMarkerLayerGroup = null; // layer group holding spawn point markers

// Search state
let searchDebounceId = null;
let currentSearchAbortController = null;
let currentDetailAbortController = null;
let selectedItemName = null;
let lootContextGeneration = 0;
let searchRequestId = 0;
let liveRequestId = 0;

// Cached DOM references — populated by cacheDomElements()
const dom = {};

function invalidateLootContext() {
  lootContextGeneration++;
  clearTimeout(searchDebounceId);
  searchDebounceId = null;
  if (currentSearchAbortController) currentSearchAbortController.abort();
  if (currentDetailAbortController) currentDetailAbortController.abort();
  currentSearchAbortController = null;
  currentDetailAbortController = null;
  return lootContextGeneration;
}

// ─── Utility Helpers ─────────────────────────────────────────────────────────

/**
 * Safely convert any value to a display string.
 * Allows 0 and false to render — only skips null/undefined.
 */
function safeText(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function escapeHtml(value, fallback = '') {
  return safeText(value, fallback).replace(/[&<>'"]/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[character]);
}

function getTierBadgeClass(value) {
  const tierKey = safeText(value);
  return Object.hasOwn(TIER_BADGE_CLASSES, tierKey)
    ? TIER_BADGE_CLASSES[tierKey]
    : 'bg-gray-700 text-gray-300';
}

/**
 * Safely extract a number. Returns fallback for NaN or non-numbers.
 * Ensures values like nominal=0 or healthPct=0 are rendered correctly.
 */
function safeNumber(value, fallback = 0) {
  if (typeof value === 'number' && !Number.isNaN(value)) return value;
  const n = Number(value);
  return Number.isNaN(n) ? fallback : n;
}

/**
 * Remove all child nodes from a DOM element.
 */
function clearElement(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/**
 * Convert lifetime/restock seconds to a readable string.
 * Negative values (-1) display as "N/A"; 0 displays as "0s".
 */
function formatSeconds(s) {
  const n = safeNumber(s, -1);
  if (n < 0) return 'N/A';
  if (n === 0) return '0s';
  if (n < 60) return `${n}s`;
  if (n < 3600) return `${Math.floor(n / 60)}m`;
  return `${Math.floor(n / 3600)}h ${Math.floor((n % 3600) / 60)}m`;
}

/**
 * Format an ISO 8601 timestamp to a local time string.
 */
function formatIsoTime(iso) {
  if (!iso) return 'Unknown';
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return 'Unknown';
  }
}

// ─── DOM Caching ──────────────────────────────────────────────────────────────

/**
 * Query all DOM elements once and store them in the dom object.
 * Returns false if any critical element is missing.
 */
function cacheDomElements() {
  const ids = [
    'serverSelector', 'mapSelector', 'username',
    'tab-finder', 'tab-live', 'panel-finder', 'panel-live',
    'searchInput', 'filterCategory', 'filterUsage', 'filterValue',
    'clearFilters', 'resultCount', 'itemList', 'itemDetail',
    'loot-map', 'btnFitMarkers', 'mapLegend',
    'liveRptFile', 'liveLastUpdated', 'btnRefreshLive',
    'liveHealthPct', 'liveHealthBar', 'liveTotalInMap', 'liveTotalNominal',
    'candidateTable', 'candidateCount', 'spawnFeed', 'spawnEventCount',
  ];

  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) {
      console.error(`[loot-finder] Missing required element: #${id}`);
      if (['loot-map', 'itemList', 'itemDetail'].includes(id)) return false;
    }
    // Store using camelCase key derived from the id (e.g. 'loot-map' → 'lootMap')
    const key = id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    dom[key] = el;
  }

  return true;
}

// ─── Status / Error Helpers ───────────────────────────────────────────────────

function showFinderStatus(msg) {
  if (dom.resultCount) dom.resultCount.textContent = safeText(msg);
}

function showFinderError(msg) {
  if (dom.resultCount) dom.resultCount.textContent = '⚠ ' + safeText(msg);
}

function showLiveStatus(msg) {
  if (dom.liveLastUpdated) dom.liveLastUpdated.textContent = safeText(msg);
}

function showLiveError(msg) {
  if (dom.liveLastUpdated) dom.liveLastUpdated.textContent = '⚠ ' + safeText(msg);
}

// ─── API Wrappers ─────────────────────────────────────────────────────────────

/**
 * Generic fetch helper. Checks HTTP status and parses JSON.
 * Throws a descriptive Error on failure.
 */
async function fetchJson(url, options = {}) {
  const res = await fetch(url, { credentials: 'same-origin', ...options });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}`);
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(`Invalid JSON response from ${url}`);
  }
  return body;
}

/**
 * Load the current user. Redirects to / on auth failure.
 * Sets isAdmin strictly: only true when user.isAdmin === true.
 */
async function loadCurrentUser() {
  let data;
  try {
    data = await fetchJson('/api/user');
  } catch {
    window.location.href = '/';
    return;
  }

  if (!data || !data.username) {
    window.location.href = '/';
    return;
  }

  currentUser = data;
  isAdmin = (data.isAdmin === true);

  if (dom.username) dom.username.textContent = safeText(data.username);

  // Reveal admin-only elements (e.g. the Live Feed tab)
  if (isAdmin) {
    document.querySelectorAll('[data-admin-only]').forEach(el => {
      el.classList.remove('hidden');
    });
  }
}

/**
 * Load filter dropdown options for a map on the selected server.
 * Gracefully handles empty arrays and API errors.
 */
async function loadCategories(mapName, generation) {
  if (!currentServerId) return;
  let data;
  try {
    data = await fetchJson(`/api/loot/categories?serverId=${encodeURIComponent(currentServerId)}&map=${encodeURIComponent(mapName)}`);
  } catch (err) {
    if (generation !== lootContextGeneration || mapName !== currentMapName) return;
    showFinderError(`Failed to load filters: ${err.message}`);
    return;
  }

  if (generation !== lootContextGeneration || mapName !== currentMapName) return;

  if (!data || data.ok === false) {
    showFinderError(`Failed to load filters: ${safeText(data && data.error, 'Unknown error')}`);
    return;
  }

  populateSelect(dom.filterCategory, data.categories || [], 'All categories');
  populateSelect(dom.filterUsage,    data.usages      || [], 'All zones');
  populateSelect(dom.filterValue,    data.values      || [], 'All tiers');
}

/**
 * Populate a <select> with an array of string values.
 * Always prepends an "All" option.
 */
function populateSelect(selectEl, items, allLabel) {
  if (!selectEl) return;
  clearElement(selectEl);
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = allLabel;
  selectEl.appendChild(defaultOpt);

  for (const item of items) {
    const opt = document.createElement('option');
    opt.value = item;
    opt.textContent = item;
    selectEl.appendChild(opt);
  }
}

/**
 * Search items with current filters. Uses AbortController to cancel stale requests.
 * Returns { count, items } or throws (AbortError is rethrown for caller to ignore).
 */
async function searchItems(mapName, q, category, usage, value) {
  // Cancel any in-flight search
  if (currentSearchAbortController) {
    currentSearchAbortController.abort();
  }
  currentSearchAbortController = new AbortController();

  const params = new URLSearchParams({ map: mapName, limit: '150' });
  if (currentServerId) params.set('serverId', currentServerId);
  if (q)        params.set('q', q);
  if (category) params.set('category', category);
  if (usage)    params.set('usage', usage);
  if (value)    params.set('value', value);

  const data = await fetchJson(`/api/loot/search?${params}`, {
    signal: currentSearchAbortController.signal,
  });

  if (data.ok === false) {
    throw new Error(safeText(data.error, 'Search failed'));
  }

  return {
    count: safeNumber(data.count, 0),
    items: Array.isArray(data.items) ? data.items : [],
  };
}

/**
 * Load full detail for a single item by name.
 */
async function loadItemDetail(mapName, itemName, signal) {
  const params = new URLSearchParams({ map: mapName });
  if (currentServerId) params.set('serverId', currentServerId);
  const data = await fetchJson(
    `/api/loot/item/${encodeURIComponent(itemName)}?${params}`,
    { signal }
  );

  if (data.ok === false) {
    throw new Error(safeText(data.error, 'Item not found'));
  }

  if (!data.item) {
    throw new Error('Invalid item response from server');
  }

  return data.item;
}

/**
 * Load live loot data (admin only).
 * Normalizes missing/null fields to safe defaults.
 */
async function loadLiveData(mapName, serverId) {
  const data = await fetchJson(`/api/loot/live?serverId=${encodeURIComponent(serverId)}&map=${encodeURIComponent(mapName)}`);

  if (data.ok === false) {
    throw new Error(safeText(data.error, 'Failed to load live data'));
  }

  return {
    candidates:    Array.isArray(data.candidates)  ? data.candidates  : [],
    recentAdds:    Array.isArray(data.recentAdds)  ? data.recentAdds  : [],
    economyHealth: data.economyHealth || null,
    lastUpdated:   data.lastUpdated   || null,
    rptFile:       data.rptFile       || null,
    error:         data.error         || null,
  };
}

// ─── Map Functions ────────────────────────────────────────────────────────────

/**
 * Convert DayZ game coords (meters) to a Leaflet [lat, lng] point.
 * In L.CRS.Simple: lat = z-axis (north), lng = x-axis (east).
 */
function gameToLeaflet(gameX, gameZ, mapName) {
  return DayzMapCoordinates.worldToLeaflet({ east: gameX, north: gameZ }, mapName);
}

/**
 * Create the Leaflet map instance once. Subsequent calls are no-ops.
 * Initializes two layer groups: one for tiles, one for markers.
 */
function initMapIfNeeded() {
  if (lootMap) return;

  const cfg = MAP_CONFIGS[currentMapName] || MAP_CONFIGS.chernarusplus;

  lootMap = L.map('loot-map', {
    crs: L.CRS.Simple,
    minZoom: -3,
    maxZoom: 3,
    center: [cfg.size / 2, cfg.size / 2],
    zoom: -1,
    attributionControl: false,
    zoomControl: true,
  });

  mapTileLayerGroup   = L.layerGroup().addTo(lootMap);
  mapMarkerLayerGroup = L.layerGroup().addTo(lootMap);

  populateMapTiles(currentMapName);
}

/**
 * Load all tile image overlays for the given map into the tile layer group.
 * Clears existing tiles first to prevent ghost tiles on map switch.
 */
function populateMapTiles(mapName) {
  if (!lootMap || !mapTileLayerGroup) return;

  mapTileLayerGroup.clearLayers();

  const cfg = MAP_CONFIGS[mapName] || MAP_CONFIGS.chernarusplus;
  const { gridSize, tileSize: advancement, physicalSize } = cfg;

  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const flippedRow = (gridSize - 1) - row;
      const bounds = [
        [row * advancement, col * advancement],
        [row * advancement + physicalSize, col * advancement + physicalSize],
      ];
      const url = `/maps/${mapName}/tiles/${col}/${flippedRow}.png`;
      L.imageOverlay(url, bounds, { opacity: 1, interactive: false }).addTo(mapTileLayerGroup);
    }
  }
}

/**
 * Switch the map to a new map name: replace tiles, clear markers, recenter.
 */
function resetMapForMapName(mapName) {
  invalidateLootContext();
  currentMapName = mapName;
  initMapIfNeeded();
  populateMapTiles(mapName);

  if (mapMarkerLayerGroup) mapMarkerLayerGroup.clearLayers();
  if (dom.mapLegend) dom.mapLegend.style.display = 'none';

  const cfg = MAP_CONFIGS[mapName] || MAP_CONFIGS.chernarusplus;
  if (lootMap) lootMap.setView([cfg.size / 2, cfg.size / 2], -1);
}

/**
 * Plot spawn points for the selected item as circle markers on the map.
 * Clears previous markers first. Hides legend if no spawn points.
 */
function renderSpawnMarkersForItem(item) {
  if (!lootMap || !mapMarkerLayerGroup) return;

  mapMarkerLayerGroup.clearLayers();

  if (!item || !Array.isArray(item.spawnPoints) || item.spawnPoints.length === 0) {
    if (dom.mapLegend) dom.mapLegend.style.display = 'none';
    return;
  }

  // Dynamic event items get a distinct amber color; static loot uses tier color.
  const tierColor = item.isDynamicEvent
    ? DYNAMIC_EVENT_COLOR
    : (item.values && item.values[0])
      ? (TIER_COLORS[item.values[0]] || DEFAULT_MARKER_COLOR)
      : DEFAULT_MARKER_COLOR;

  const popupLabel = item.isDynamicEvent ? 'Dynamic Event Loot' : 'Static Loot';

  for (const sp of item.spawnPoints) {
    const latlng = gameToLeaflet(sp.x, sp.z, currentMapName);
    L.circleMarker(latlng, {
      radius: 5,
      color: tierColor,
      fillColor: tierColor,
      fillOpacity: 0.7,
      weight: 1,
    })
    .bindPopup(`<b>${escapeHtml(item.name)}</b><br><i>${popupLabel}</i><br>x: ${safeNumber(sp.x, 0)}, z: ${safeNumber(sp.z, 0)}`)
    .addTo(mapMarkerLayerGroup);
  }

  if (dom.mapLegend) dom.mapLegend.style.display = '';
}

/**
 * Fit the map view to all current spawn markers.
 */
function fitMapToMarkers() {
  if (!lootMap || !mapMarkerLayerGroup) return;
  if (mapMarkerLayerGroup.getLayers().length === 0) {
    showFinderStatus('No spawn markers to fit.');
    return;
  }
  try {
    const bounds = mapMarkerLayerGroup.getBounds();
    if (bounds.isValid()) lootMap.fitBounds(bounds, { padding: [20, 20] });
  } catch (err) {
    console.error('[loot-finder] fitMapToMarkers error:', err);
  }
}

// ─── Item Finder UI ───────────────────────────────────────────────────────────

/**
 * Render item search results as clickable cards in #itemList.
 * Uses safeNumber for all numeric fields so 0 renders correctly.
 */
function renderItemList(items) {
  clearElement(dom.itemList);

  if (!Array.isArray(items) || items.length === 0) {
    const msg = document.createElement('div');
    msg.className = 'px-4 py-6 text-center text-sm text-gray-500';
    msg.textContent = 'No items match your search and filters.';
    dom.itemList.appendChild(msg);
    showFinderStatus('0 items found');
    if (mapMarkerLayerGroup) mapMarkerLayerGroup.clearLayers();
    if (dom.mapLegend) dom.mapLegend.style.display = 'none';
    return;
  }

  showFinderStatus(`${items.length} item${items.length !== 1 ? 's' : ''} found`);

  for (const item of items) {
    const card = document.createElement('div');
    card.className = 'item-card px-4 py-3 border-b border-gray-700';
    if (item.name === selectedItemName) card.classList.add('selected');

    // Tier badges
    const tierBadges = (item.values || []).map(v => {
      const tierClass = getTierBadgeClass(v);
      return `<span class="${tierClass} text-xs px-1.5 py-0.5 rounded font-semibold mr-1">${escapeHtml(v)}</span>`;
    }).join('');

    // Category text
    const cats = (item.category || []).join(', ') || '—';

    card.innerHTML = `
      <div class="flex items-start justify-between gap-2">
        <span class="font-medium text-sm text-white truncate">${escapeHtml(item.name)}</span>
        <span class="text-xs text-gray-400 whitespace-nowrap">×${safeNumber(item.nominal, 0)}</span>
      </div>
      <div class="mt-1 flex flex-wrap items-center gap-1">
        ${tierBadges}
        <span class="text-xs text-gray-500">${escapeHtml(cats)}</span>
      </div>`;

    card.addEventListener('click', () => onItemCardClicked(item, card));
    dom.itemList.appendChild(card);
  }
}

/**
 * Handle click on an item card: select it, fetch full detail, render map markers.
 */
async function onItemCardClicked(item, cardEl) {
  if (!item || !item.name) return;

  // Update selection visual state
  dom.itemList.querySelectorAll('.item-card.selected').forEach(el => el.classList.remove('selected'));
  cardEl.classList.add('selected');
  selectedItemName = item.name;

  // Optimistic: show basic info from search result immediately
  renderItemDetailBasic(item);

  // Fetch full detail (includes all spawn points)
  const mapName = currentMapName;
  const generation = lootContextGeneration;
  if (currentDetailAbortController) currentDetailAbortController.abort();
  const detailAbortController = new AbortController();
  currentDetailAbortController = detailAbortController;
  try {
    const fullItem = await loadItemDetail(mapName, item.name, detailAbortController.signal);
    if (generation !== lootContextGeneration || mapName !== currentMapName ||
        selectedItemName !== item.name) return;
    renderItemDetailFull(fullItem);
    renderSpawnMarkersForItem(fullItem);
    if (fullItem.spawnPoints && fullItem.spawnPoints.length > 0) {
      fitMapToMarkers();
    }
  } catch (err) {
    if (err.name === 'AbortError' || generation !== lootContextGeneration ||
        mapName !== currentMapName || selectedItemName !== item.name) return;
    // Keep the basic detail visible; just show the error below it
    const errEl = document.createElement('div');
    errEl.className = 'mt-3 text-xs text-red-400';
    errEl.textContent = '⚠ ' + safeText(err.message, 'Failed to load full item detail');
    dom.itemDetail.appendChild(errEl);
  }
}

/**
 * Render a placeholder detail panel with the subset of data from search results.
 */
function renderItemDetailBasic(item) {
  dom.itemDetail.innerHTML = `
    <div class="text-gray-400 text-xs mb-3">Loading full details…</div>
    <h2 class="font-bold text-lg text-white mb-2">${escapeHtml(item.name)}</h2>
    <div class="grid grid-cols-2 gap-2 text-sm text-gray-300">
      <div><span class="text-gray-500">Nominal</span><div class="font-semibold">${safeNumber(item.nominal, 0)}</div></div>
      <div><span class="text-gray-500">Min</span><div class="font-semibold">${safeNumber(item.min, 0)}</div></div>
      <div><span class="text-gray-500">Spawns</span><div class="font-semibold">${safeNumber(item.spawnCount, 0)}</div></div>
    </div>`;
}

/**
 * Render the full item detail panel including all stats from the /item/:name endpoint.
 */
function renderItemDetailFull(item) {
  const quantMin = safeNumber(item.quantmin, -1);
  const quantMax = safeNumber(item.quantmax, -1);
  const quantDisplay = (quantMin === -1 && quantMax === -1)
    ? 'Unlimited'
    : `${quantMin === -1 ? '∞' : quantMin} – ${quantMax === -1 ? '∞' : quantMax}`;

  const tierBadges = (item.values || []).map(v => {
    const tierClass = getTierBadgeClass(v);
    return `<span class="${tierClass} text-xs px-1.5 py-0.5 rounded font-semibold mr-1">${escapeHtml(v)}</span>`;
  }).join('') || '<span class="text-gray-500 text-xs">No tier</span>';

  const usageText = (item.usages || []).join(', ') || '—';
  const categoryText = (item.category || []).join(', ') || '—';
  const tagText = (item.tags || []).join(', ') || '—';

  dom.itemDetail.innerHTML = `
    <h2 class="font-bold text-lg text-white mb-1">${escapeHtml(item.name)}</h2>
    <div class="flex flex-wrap gap-1 mb-3">${tierBadges}</div>

    <div class="space-y-3 text-sm">
      <div class="grid grid-cols-2 gap-2 text-gray-300">
        <div><div class="text-gray-500 text-xs uppercase tracking-wide">Nominal</div><div class="font-semibold">${safeNumber(item.nominal, 0)}</div></div>
        <div><div class="text-gray-500 text-xs uppercase tracking-wide">Min</div><div class="font-semibold">${safeNumber(item.min, 0)}</div></div>
        <div><div class="text-gray-500 text-xs uppercase tracking-wide">Lifetime</div><div class="font-semibold">${formatSeconds(item.lifetime)}</div></div>
        <div><div class="text-gray-500 text-xs uppercase tracking-wide">Restock</div><div class="font-semibold">${formatSeconds(item.restock)}</div></div>
        <div><div class="text-gray-500 text-xs uppercase tracking-wide">Quantity</div><div class="font-semibold">${quantDisplay}</div></div>
        <div><div class="text-gray-500 text-xs uppercase tracking-wide">Spawn pts</div><div class="font-semibold">${safeNumber(item.spawnCount, 0)}</div></div>
      </div>

      <div>
        <div class="text-gray-500 text-xs uppercase tracking-wide mb-0.5">Category</div>
        <div class="text-gray-300">${escapeHtml(categoryText)}</div>
      </div>
      <div>
        <div class="text-gray-500 text-xs uppercase tracking-wide mb-0.5">Usage Zones</div>
        <div class="text-gray-300">${escapeHtml(usageText)}</div>
      </div>
      ${tagText !== '—' ? `<div>
        <div class="text-gray-500 text-xs uppercase tracking-wide mb-0.5">Tags</div>
        <div class="text-gray-300">${escapeHtml(tagText)}</div>
      </div>` : ''}
    </div>`;
}

/**
 * Reset item detail panel to the default empty state.
 */
function renderEmptyItemDetail() {
  dom.itemDetail.innerHTML = `
    <div class="text-center text-gray-600 mt-20">
      <div class="text-4xl mb-3">🎒</div>
      <p class="text-sm">Select an item to view details and spawn locations on the map</p>
    </div>`;
}

/**
 * Clear all finder UI derived from the selected server and terrain.
 * Called synchronously before discovery/category requests can yield.
 */
function clearLootContextUi() {
  selectedItemName = null;
  clearElement(dom.itemList);
  renderEmptyItemDetail();
  if (mapMarkerLayerGroup) mapMarkerLayerGroup.clearLayers();
  if (dom.mapLegend) dom.mapLegend.style.display = 'none';
  populateSelect(dom.filterCategory, [], 'All categories');
  populateSelect(dom.filterUsage, [], 'All zones');
  populateSelect(dom.filterValue, [], 'All tiers');
  showFinderStatus('Loading…');
}

// ─── Search Handler ───────────────────────────────────────────────────────────

/**
 * Triggered on any filter change or search input event.
 * Debounces 300ms before firing the search request.
 */
function handleSearchInputChange() {
  clearTimeout(searchDebounceId);
  searchDebounceId = setTimeout(triggerSearch, SEARCH_DEBOUNCE_MS);
}

/**
 * Run a search with current filter values and render the results.
 * On server error (5xx), shows a user-friendly message with a retry hint.
 */
async function triggerSearch() {
  const q        = (dom.searchInput     && dom.searchInput.value.trim())     || '';
  const category = (dom.filterCategory  && dom.filterCategory.value)         || '';
  const usage    = (dom.filterUsage     && dom.filterUsage.value)            || '';
  const value    = (dom.filterValue     && dom.filterValue.value)            || '';

  showFinderStatus('Searching…');
  const mapName = currentMapName;
  const generation = lootContextGeneration;
  const requestId = ++searchRequestId;

  try {
    const { items } = await searchItems(mapName, q, category, usage, value);
    if (requestId !== searchRequestId || generation !== lootContextGeneration ||
        mapName !== currentMapName) return;
    renderItemList(items);
  } catch (err) {
    if (err.name === 'AbortError' || requestId !== searchRequestId ||
        generation !== lootContextGeneration ||
        mapName !== currentMapName) return;

    // Server errors (5xx) — loot data may still be loading on cold start
    if (err.message && err.message.includes('500')) {
      showFinderError('Loot data is loading on the server — please wait a moment and try again.');
    } else {
      showFinderError(err.message || 'Search failed');
    }
  }
}

/**
 * Clear all search inputs and filters, then re-trigger a search.
 */
function handleClearFiltersClick() {
  if (dom.searchInput)    dom.searchInput.value    = '';
  if (dom.filterCategory) dom.filterCategory.value = '';
  if (dom.filterUsage)    dom.filterUsage.value    = '';
  if (dom.filterValue)    dom.filterValue.value    = '';

  selectedItemName = null;
  renderEmptyItemDetail();
  if (mapMarkerLayerGroup) mapMarkerLayerGroup.clearLayers();
  if (dom.mapLegend) dom.mapLegend.style.display = 'none';

  handleSearchInputChange();
}

// ─── Live Feed UI ─────────────────────────────────────────────────────────────

/**
 * Render the economy health bar and summary numbers.
 * Handles null economyHealth gracefully (RPT file not found).
 */
function renderLiveEconomyHealth(economyHealth) {
  if (!economyHealth) {
    if (dom.liveHealthPct)    dom.liveHealthPct.textContent   = 'No data';
    if (dom.liveHealthBar)    dom.liveHealthBar.style.width    = '0%';
    if (dom.liveTotalInMap)   dom.liveTotalInMap.textContent   = '—';
    if (dom.liveTotalNominal) dom.liveTotalNominal.textContent = '—';
    return;
  }

  const pct = Math.min(100, Math.max(0, safeNumber(economyHealth.healthPct, 0)));

  if (dom.liveHealthPct) dom.liveHealthPct.textContent = `${pct}%`;
  if (dom.liveHealthBar) {
    dom.liveHealthBar.style.width = `${pct}%`;
    // Color the bar based on health level
    dom.liveHealthBar.className = dom.liveHealthBar.className
      .replace(/\bbg-\w+-\d+\b/, '');
    if (pct >= 70) {
      dom.liveHealthBar.style.background = '#10b981'; // green
    } else if (pct >= 40) {
      dom.liveHealthBar.style.background = '#f59e0b'; // yellow
    } else {
      dom.liveHealthBar.style.background = '#ef4444'; // red
    }
  }
  if (dom.liveTotalInMap)   dom.liveTotalInMap.textContent   = safeText(economyHealth.totalInMap,  '0');
  if (dom.liveTotalNominal) dom.liveTotalNominal.textContent = safeText(economyHealth.nominal, '0');
}

/**
 * Render the "items below nominal" table.
 * All numeric cells use safeNumber so 0 counts display correctly.
 */
function renderLiveCandidates(candidates) {
  clearElement(dom.candidateTable);

  if (!Array.isArray(candidates) || candidates.length === 0) {
    if (dom.candidateCount) dom.candidateCount.textContent = '0 items below nominal';
    const row = dom.candidateTable.insertRow();
    const cell = row.insertCell();
    cell.colSpan = 5;
    cell.className = 'px-4 py-4 text-center text-gray-500 text-sm';
    cell.textContent = 'No items below nominal.';
    return;
  }

  if (dom.candidateCount) {
    dom.candidateCount.textContent = `${candidates.length} item${candidates.length !== 1 ? 's' : ''} below nominal`;
  }

  for (const c of candidates) {
    const row = dom.candidateTable.insertRow();
    row.className = 'hover:bg-gray-700';

    const healthPct = safeNumber(c.healthPct, 0);
    const healthColor = healthPct >= 70 ? '#10b981' : healthPct >= 40 ? '#f59e0b' : '#ef4444';

    row.innerHTML = `
      <td class="px-4 py-2 text-sm font-mono text-gray-200">${escapeHtml(c.item)}</td>
      <td class="px-4 py-2 text-sm text-right text-gray-300">${safeNumber(c.current, 0)}</td>
      <td class="px-4 py-2 text-sm text-right text-gray-300">${safeNumber(c.nominal, 0)}</td>
      <td class="px-4 py-2 text-sm text-right text-red-400">${safeNumber(c.missing, 0)}</td>
      <td class="px-4 py-2 text-sm text-right font-semibold" style="color:${healthColor}">${healthPct}%</td>`;
  }
}

/**
 * Render the recent spawn events feed.
 */
function renderLiveSpawnFeed(recentAdds) {
  clearElement(dom.spawnFeed);

  if (!Array.isArray(recentAdds) || recentAdds.length === 0) {
    if (dom.spawnEventCount) dom.spawnEventCount.textContent = '0 recent events';
    const msg = document.createElement('div');
    msg.className = 'p-4 text-gray-500 text-center text-sm';
    msg.textContent = 'No recent spawn events found in log.';
    dom.spawnFeed.appendChild(msg);
    return;
  }

  if (dom.spawnEventCount) {
    dom.spawnEventCount.textContent = `${recentAdds.length} event${recentAdds.length !== 1 ? 's' : ''}`;
  }

  // Show most recent events at the top
  for (const evt of [...recentAdds].reverse()) {
    const el = document.createElement('div');
    el.className = 'px-4 py-1.5 border-b border-gray-700 flex justify-between items-center';
    el.innerHTML = `
      <span class="text-gray-300 font-mono text-xs">${escapeHtml(evt.item)}</span>
      <span class="text-gray-500 text-xs">${safeNumber(evt.x, 0)}, ${safeNumber(evt.z, 0)}</span>
      <span class="text-gray-600 text-xs">${escapeHtml(evt.timestamp, '')}</span>`;
    dom.spawnFeed.appendChild(el);
  }
}

/** Clear live-panel values belonging to the previous server or terrain. */
function clearLiveContextUi() {
  if (dom.liveRptFile) dom.liveRptFile.textContent = '';
  if (dom.liveLastUpdated) dom.liveLastUpdated.textContent = '';
  renderLiveEconomyHealth(null);
  renderLiveCandidates([]);
  renderLiveSpawnFeed([]);
  showLiveStatus('Waiting for current server data…');
}

/**
 * Fetch and render live loot data. Guards against non-admin access.
 */
async function refreshLivePanel() {
  if (!isAdmin || !currentServerId) return;

  showLiveStatus('Loading live loot data…');
  if (dom.liveRptFile) dom.liveRptFile.textContent = '';
  const mapName = currentMapName;
  const serverId = currentServerId;
  const generation = lootContextGeneration;
  const requestId = ++liveRequestId;

  try {
    const data = await loadLiveData(mapName, serverId);
    if (requestId !== liveRequestId || generation !== lootContextGeneration ||
        mapName !== currentMapName || serverId !== currentServerId) return;

    if (dom.liveRptFile) dom.liveRptFile.textContent = safeText(data.rptFile, 'No RPT file');
    if (dom.liveLastUpdated) {
      dom.liveLastUpdated.textContent = `Last updated: ${formatIsoTime(data.lastUpdated)}`;
    }

    renderLiveEconomyHealth(data.economyHealth);
    renderLiveCandidates(data.candidates);
    renderLiveSpawnFeed(data.recentAdds);

    // Show a warning if the API returned a partial error (e.g. no RPT found) but still responded
    if (data.error) {
      showLiveError(data.error);
    }
  } catch (err) {
    if (requestId !== liveRequestId || generation !== lootContextGeneration ||
        mapName !== currentMapName || serverId !== currentServerId) return;
    renderLiveEconomyHealth(null);
    renderLiveCandidates([]);
    renderLiveSpawnFeed([]);
    showLiveError(err.message || 'Failed to load live data');
  }
}

// ─── Tab Switching ────────────────────────────────────────────────────────────

function switchToFinderTab() {
  dom.tabFinder.classList.add('active');
  dom.tabLive.classList.remove('active');
  dom.panelFinder.classList.remove('hidden');
  dom.panelFinder.style.display = 'flex';
  dom.panelLive.classList.add('hidden');
}

function switchToLiveTab() {
  if (!isAdmin) return; // defense: live tab should be hidden for non-admins anyway

  dom.tabLive.classList.add('active');
  dom.tabFinder.classList.remove('active');
  dom.panelLive.classList.remove('hidden');
  dom.panelFinder.classList.add('hidden');
  dom.panelFinder.style.display = '';

  refreshLivePanel();
}

// ─── Map Selector ─────────────────────────────────────────────────────────────

/**
 * Handle map selection change: reset map tiles, reload filters, clear state.
 */
async function handleMapSelectorChange() {
  const mapName = dom.mapSelector.value || 'chernarusplus';

  resetMapForMapName(mapName);
  const generation = lootContextGeneration;
  clearLootContextUi();
  clearLiveContextUi();
  showFinderStatus('Loading filters…');

  await loadCategories(mapName, generation);
  if (generation !== lootContextGeneration || mapName !== currentMapName) return;

  // Re-populate the item list for the new map
  triggerSearch();

  // If the live tab is active, refresh it for the new map
  if (isAdmin && !dom.panelLive.classList.contains('hidden')) {
    refreshLivePanel();
  }
}

// ─── Server & Map Loading ─────────────────────────────────────────────────────

/**
 * Fetch all servers the user has access to from the guild registry.
 * Groups them by guild so the <select> has <optgroup> sections.
 * Auto-selects the first server if only one is available.
 */
async function loadServers() {
  if (!dom.serverSelector) return;

  let data;
  try {
    data = await fetchJson('/api/nitrado/registered-servers');
  } catch (err) {
    dom.serverSelector.innerHTML = '<option value="">Failed to load servers</option>';
    showFinderError('Could not load servers: ' + err.message);
    return;
  }

  const servers = (data && Array.isArray(data.servers)) ? data.servers : [];

  clearElement(dom.serverSelector);

  if (servers.length === 0) {
    dom.serverSelector.innerHTML = '<option value="">No servers available</option>';
    return;
  }

  // Group servers by guild
  const guilds = new Map();
  for (const s of servers) {
    const guildKey = s.guild_id;
    if (!guilds.has(guildKey)) {
      guilds.set(guildKey, { name: safeText(s.guild_name, 'Unknown Guild'), servers: [] });
    }
    guilds.get(guildKey).servers.push(s);
  }

  // Build <optgroup> per guild, <option> per server
  for (const [, guild] of guilds) {
    const group = document.createElement('optgroup');
    group.label = guild.name;
    for (const s of guild.servers) {
      const opt = document.createElement('option');
      // Use Nitrado platform_server_id as the serverId for API calls
      opt.value = safeText(s.nitrado_server_id);
      opt.textContent = safeText(s.server_name);
      group.appendChild(opt);
    }
    dom.serverSelector.appendChild(group);
  }

  // Auto-select first server
  const firstServerId = servers[0].nitrado_server_id;
  dom.serverSelector.value = firstServerId;
  await handleServerSelectorChange();
}

/**
 * Handle server selection change: load available maps for that server,
 * then reset state and trigger a fresh search.
 */
async function handleServerSelectorChange() {
  const serverId = dom.serverSelector.value;
  if (!serverId) return;

  const serverGeneration = invalidateLootContext();
  currentServerId = serverId;
  clearLootContextUi();
  clearLiveContextUi();

  // Disable map selector while loading
  if (dom.mapSelector) {
    dom.mapSelector.disabled = true;
    dom.mapSelector.innerHTML = '<option value="">Loading maps…</option>';
  }

  // Load maps available in that server's downloaded mission files
  let availableMaps = [];
  try {
    const data = await fetchJson(`/api/server-maps/${encodeURIComponent(serverId)}`);
    availableMaps = (data && Array.isArray(data.maps)) ? data.maps : [];
  } catch (err) {
    console.warn('[loot-finder] Could not load server maps:', err.message);
  }
  if (serverGeneration !== lootContextGeneration || serverId !== currentServerId) return;

  // Populate map selector — fall back to all known maps if none detected
  const mapOptions = availableMaps.length > 0 ? availableMaps : Object.keys(MAP_CONFIGS);
  const MAP_LABELS = {
    chernarusplus: 'Chernarus+',
    enoch:         'Livonia',
    sakhal:        'Sakhal',
    namalsk:       'Namalsk',
    takistanplus:  'Takistan+',
  };

  clearElement(dom.mapSelector);
  for (const m of mapOptions) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = MAP_LABELS[m] || m;
    dom.mapSelector.appendChild(opt);
  }
  dom.mapSelector.disabled = false;

  // Apply new map
  currentMapName = dom.mapSelector.value || mapOptions[0] || 'chernarusplus';
  resetMapForMapName(currentMapName);
  const generation = lootContextGeneration;

  await loadCategories(currentMapName, generation);
  if (generation !== lootContextGeneration) return;
  triggerSearch();
  if (isAdmin && !dom.panelLive.classList.contains('hidden')) {
    refreshLivePanel();
  }
}

// ─── Event Wiring ─────────────────────────────────────────────────────────────

function attachEventListeners() {
  dom.serverSelector.addEventListener('change', handleServerSelectorChange);
  dom.searchInput.addEventListener('input', handleSearchInputChange);
  dom.filterCategory.addEventListener('change', handleSearchInputChange);
  dom.filterUsage.addEventListener('change', handleSearchInputChange);
  dom.filterValue.addEventListener('change', handleSearchInputChange);
  dom.clearFilters.addEventListener('click', handleClearFiltersClick);
  dom.btnFitMarkers.addEventListener('click', fitMapToMarkers);
  dom.mapSelector.addEventListener('change', handleMapSelectorChange);
  dom.tabFinder.addEventListener('click', switchToFinderTab);
  dom.tabLive.addEventListener('click', switchToLiveTab);
  dom.btnRefreshLive.addEventListener('click', refreshLivePanel);
}

// ─── Initialization ───────────────────────────────────────────────────────────

/**
 * Main entry point. Called on DOMContentLoaded.
 * Steps run in order; auth failure aborts remaining steps.
 */
async function initLootFinder() {
  // 1. Cache all DOM elements; bail if critical ones are missing
  if (!cacheDomElements()) {
    console.error('[loot-finder] Critical DOM elements missing — aborting initialization.');
    return;
  }

  // 2. Wire up all event listeners
  attachEventListeners();

  // 3. Initialize the Leaflet map (tiles load after a server is selected)
  initMapIfNeeded();

  // 4. Authenticate; redirect to / if not logged in
  await loadCurrentUser();
  if (!currentUser) return;

  // 5. Ensure the Item Finder tab is the default active tab
  switchToFinderTab();

  // 6. Load server list — this triggers map loading and initial search
  showFinderStatus('Select a server to start searching…');
  await loadServers();
}

document.addEventListener('DOMContentLoaded', initLootFinder);
