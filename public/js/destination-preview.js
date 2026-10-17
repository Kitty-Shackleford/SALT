'use strict';

/*
 * B1.3 — map destination preview helper.
 *
 * Computes which raster tile (from public/maps/<map>/tiles/<x>/<y>.png) a
 * world coordinate falls on, and where inside that tile to place a marker
 * dot. This powers mini-map previews for teleport/event destinations that
 * reuse the existing map tile assets — no separate preview rendering path.
 *
 * All map geometry (world extent, tile grid, advancement, physical tile
 * size, image size) and the north/south tile-file flip come from the
 * canonical registry (public/js/dayz-map-coordinates.js), the same source
 * the full map renderers consume. The only map-local decision is WHICH maps
 * ship raster tiles at all (TILE_MAP_IDS below) — that is a per-map asset
 * policy, not geometry, so it cannot drift from the registry. Keeping the
 * geometry in the registry guarantees a preview dot lines up with the full
 * map even when a map's tile grid changes (e.g. nasdara's 43->46 bleed grid).
 *
 * It is a pure function (no DOM) and UMD so it runs in the browser and under
 * Node tests. In the browser dayz-map-coordinates.js is loaded first on
 * every map page and exposes window.DayzMapCoordinates; under Node the same
 * UMD module is required directly.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.DayzDestinationPreview = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Maps that actually ship raster tiles under public/maps/<id>/tiles/.
  // This is the asset-availability policy, deliberately separate from the
  // registry's geometry: namalsk/takistanplus have registry definitions but
  // no shipped tiles, so previews must reject them (tileForWorld -> null).
  const TILE_MAP_IDS = ['chernarusplus', 'enoch', 'sakhal', 'nasdara'];

  // Resolve the canonical DayZ map registry. Prefer the browser global
  // (dayz-map-coordinates.js loads before this script on every map page);
  // fall back to requiring the same UMD module for Node tests.
  function resolveRegistry() {
    if (typeof globalThis !== 'undefined' && globalThis.DayzMapCoordinates) {
      return globalThis.DayzMapCoordinates;
    }
    if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
      try {
        return require('./dayz-map-coordinates');
      } catch (err) {
        return null;
      }
    }
    return null;
  }

  // Resolved once (cached). By the time any preview is requested the registry
  // is present in both environments, so a null only surfaces a genuine load
  // failure rather than silently falling back to a stale local table.
  let registry = null;
  let registryResolved = false;
  function getRegistry() {
    if (registryResolved) return registry;
    registryResolved = true;
    registry = resolveRegistry();
    return registry;
  }

  // Registry definition for a tile-shipping map, or null when the map is not
  // eligible (no shipped tiles / not in the registry).
  function definitionFor(mapName) {
    const reg = getRegistry();
    if (!reg) return null;
    if (TILE_MAP_IDS.indexOf(mapName) === -1) return null;
    const def = reg.getMapDefinition(mapName);
    return def && def.id === mapName ? def : null;
  }

  // Display-name lookup for tile-shipping maps, derived from the registry.
  // map.js reads DayzDestinationPreview.MAPS[mapName].name for its status
  // line; a plain-name fallback keeps that safe even if the registry is not
  // yet available at module-evaluation time.
  const MAPS = {};
  for (const id of TILE_MAP_IDS) {
    const reg = getRegistry();
    const def = reg ? reg.getMapDefinition(id) : null;
    MAPS[id] = { name: def ? def.name : id };
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function mapAvailable(mapName) {
    return definitionFor(mapName) !== null;
  }

  /**
   * World coordinate -> tile file + in-tile marker offset.
   *
   * @param {string} mapName
   * @param {{east:number, north:number}} world  east = world X, north = world Z
   * @returns {{tileX:number, tileY:number, fileY:number, px:number, py:number,
   *            physicalSize:number, tileUrl:string} | null}  null when the map
   *            has no tiles or the coordinate is not finite.
   */
  function tileForWorld(mapName, world) {
    const def = definitionFor(mapName);
    if (!def) return null;
    const east = Number(world && world.east);
    const north = Number(world && world.north);
    if (!Number.isFinite(east) || !Number.isFinite(north)) return null;

    const grid = def.gridSize;
    const adv = def.tileAdvancement;
    const phys = def.physicalTileSize;
    // imageWidth === imageHeight for every registry definition (square).
    const imageW = def.imageWidth;
    const imageH = def.imageHeight;

    // Leaflet image-space pixels (world min is 0 for these maps); clamp keeps
    // an out-of-bounds destination on the edge tile instead of wrapping.
    const lng = clamp(east, 0, def.worldWidth) * imageW / def.worldWidth;
    const lat = clamp(north, 0, def.worldHeight) * imageH / def.worldHeight;

    const tileX = clamp(Math.floor(lng / adv), 0, grid - 1);
    const tileY = clamp(Math.floor(lat / adv), 0, grid - 1);
    // Canonical north/south file flip — the registry is the single source of
    // truth for the flip, matching every full-map renderer.
    const file = getRegistry().tileFileCoordinates(tileX, tileY, mapName);
    if (!file) return null;
    const fileY = file.y;

    return {
      tileX,
      tileY,
      fileY,
      px: lng - tileX * adv,   // marker x within the tile image
      py: lat - tileY * adv,   // marker y within the tile image
      physicalSize: phys,
      tileUrl: `/maps/${mapName}/tiles/${tileX}/${fileY}.png`,
    };
  }

  /**
   * Build a self-contained mini-map preview (tile image + marker dot) as an
   * HTML string. Callers drop the string into a container sized to
   * `sizePx`. No external CSS dependency beyond inline styles, so it works in
   * bot/embed surfaces too.
   */
  function previewHtml({ mapName, east, north, name, sizePx = 220 }) {
    const tile = tileForWorld(mapName, { east, north });
    if (!tile) return '';
    const phys = tile.physicalSize || 512;
    const label = String(name || mapName).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const size = Number(sizePx) || 220;
    return `<div data-destination-preview style="position:relative;width:${size}px;height:${size}px;overflow:hidden;border-radius:var(--dzc-radius-md,8px);border:1px solid var(--dzc-border,#233042)">` +
      `<img src="${tile.tileUrl}" alt="" style="width:${phys}px;height:${phys}px;max-width:none;display:block;transform:translate(${-tile.px}px,${-tile.py}px)">` +
      `<span aria-label="Destination ${label}" style="position:absolute;left:0;top:0;width:10px;height:10px;margin:-5px 0 0 -5px;border-radius:50%;background:var(--dzc-stat,#34e07a);box-shadow:0 0 0 2px rgba(0,0,0,0.6)"></span>` +
      (label ? `<div style="position:absolute;left:6px;bottom:6px;font-size:12px;color:var(--dzc-text,#e6eef8);background:rgba(0,0,0,0.55);padding:2px 6px;border-radius:var(--dzc-radius-sm,4px)">${label}</div>` : '') +
      `</div>`;
  }

  return Object.freeze({
    MAPS,
    TILE_MAP_IDS,
    mapAvailable,
    tileForWorld,
    previewHtml,
  });
}));
