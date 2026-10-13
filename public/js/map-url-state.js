/* Map page control state <-> URL params (card 6/9 — shareable map state).
 *
 * Pure module: no DOM, no network. map.js restores the page from these params
 * on load and writes them back (history.replaceState) on every control change,
 * so a bookmarked/shared URL reproduces the exact panel state.
 *
 * Params (all optional; omitted = default):
 *   server   nitrado server id (value of the server select)
 *   map      map key (value of the map select)
 *   layers   comma list of ENABLED layer keys. Omitted = the defaults below
 *            (operations overlay + settlement labels on; radii + heatmaps off).
 *   filters  comma list of HIDDEN event type names (default: none hidden)
 *   radius   radius-search meters (default 500)
 *   refresh  "0" disables auto-refresh (default: on)
 *   open     comma list of OPEN panel sections. Omitted = all sections open.
 *   panel    "0" collapses the whole control panel (default: open)
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MapUrlState = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var SECTION_KEYS = ['server', 'layers', 'filters', 'radius', 'data', 'health'];

  // Layer key -> checkbox control id in map.html (map.js owns the listeners).
  var LAYER_CONTROLS = {
    'roster': 'operations-player-toggle',
    'combat': 'operations-event-toggle',
    'purchases': 'operations-purchase-toggle',
    'build': 'operations-territory-toggle',
    'zones': 'operations-zone-toggle',
    'factions': 'operations-faction-toggle',
    'faction-territory': 'operations-faction-territory-toggle',
    'settlements': 'settlement-label-toggle',
    'settlement-radii': 'settlement-extent-toggle',
    'loot': 'heatmap-toggle',
    'kill': 'kill-heatmap-toggle',
    'death': 'death-heatmap-toggle',
    'movement': 'movement-heatmap-toggle',
  };

  var DEFAULT_ENABLED_LAYERS = [
    'roster', 'combat', 'purchases', 'build', 'zones', 'factions',
    'faction-territory', 'settlements',
  ];
  var DEFAULT_RADIUS = 500;

  function parseList(value) {
    if (!value) return null;
    return value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  }

  /**
   * Parse a URL search string (or URLSearchParams) into map state.
   * Unknown layer/section keys are dropped; malformed numbers fall back to
   * defaults. Returns:
   * { server, map, layers:Set, hiddenFilters:[], radius:Number,
   *   autoRefresh:Boolean, openSections:Set, panelOpen:Boolean }
   */
  function parse(search) {
    var p = search instanceof URLSearchParams
      ? search
      : new URLSearchParams(typeof search === 'string' ? search.replace(/^\?/, '') : '');

    var server = p.get('server') || '';
    var map = p.get('map') || '';

    var layers = parseList(p.get('layers'));
    var layerSet = new Set(layers !== null
      ? layers.filter(function (k) { return LAYER_CONTROLS[k]; })
      : DEFAULT_ENABLED_LAYERS);

    var hiddenFilters = (parseList(p.get('filters')) || []).slice();
    var radiusRaw = parseInt(p.get('radius') || '', 10);
    var radius = Number.isFinite(radiusRaw) && radiusRaw > 0 ? radiusRaw : DEFAULT_RADIUS;
    var autoRefresh = p.get('refresh') !== '0';

    var open = parseList(p.get('open'));
    var openSections = new Set(open !== null
      ? open.filter(function (k) { return SECTION_KEYS.indexOf(k) !== -1; })
      : SECTION_KEYS);

    var panelOpen = p.get('panel') !== '0';

    return {
      server: server,
      map: map,
      layers: layerSet,
      hiddenFilters: hiddenFilters,
      radius: radius,
      autoRefresh: autoRefresh,
      openSections: openSections,
      panelOpen: panelOpen,
    };
  }

  /**
   * Serialize map state back to a query string (without leading '?').
   * Defaults are omitted to keep shared URLs short.
   */
  function buildSearch(state) {
    var q = new URLSearchParams();

    if (state.server) q.set('server', state.server);
    if (state.map) q.set('map', state.map);

    var layerKeys = Object.keys(LAYER_CONTROLS);
    var enabled = state.layers instanceof Set
      ? layerKeys.filter(function (k) { return state.layers.has(k); })
      : [];
    var isDefault = enabled.length === DEFAULT_ENABLED_LAYERS.length
      && enabled.every(function (k) { return DEFAULT_ENABLED_LAYERS.indexOf(k) !== -1; });
    if (!isDefault) q.set('layers', enabled.join(','));

    var hidden = (state.hiddenFilters || []).filter(Boolean);
    if (hidden.length) q.set('filters', hidden.join(','));

    if (state.radius && state.radius !== DEFAULT_RADIUS) q.set('radius', String(state.radius));
    if (state.autoRefresh === false) q.set('refresh', '0');

    var open = state.openSections instanceof Set
      ? SECTION_KEYS.filter(function (k) { return state.openSections.has(k); })
      : SECTION_KEYS.slice();
    if (open.length < SECTION_KEYS.length) q.set('open', open.join(','));
    if (state.panelOpen === false) q.set('panel', '0');

    return q.toString();
  }

  return {
    SECTION_KEYS: SECTION_KEYS,
    LAYER_CONTROLS: LAYER_CONTROLS,
    DEFAULT_ENABLED_LAYERS: DEFAULT_ENABLED_LAYERS,
    DEFAULT_RADIUS: DEFAULT_RADIUS,
    parse: parse,
    buildSearch: buildSearch,
  };
});
