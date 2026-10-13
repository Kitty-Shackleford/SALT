'use strict';

/*
 * B1.3 — map destination preview helper.
 *
 * Computes which raster tile (from public/maps/<map>/tiles/<x>/<y>.png) a
 * world coordinate falls on, and where inside that tile to place a marker
 * dot. This powers mini-map previews for teleport/event destinations that
 * reuse the existing map tile assets — no separate preview rendering path.
 *
 * The math mirrors public/js/dayz-map-coordinates.js (worldToLeaflet) and
 * public/js/dayz-map-tiles.js (tile bounds / file-y flip), so a preview dot
 * lines up with the full map. It is a pure function (no DOM) and UMD so it
 * runs in the browser and under Node tests.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.DayzDestinationPreview = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Maps that actually ship raster tiles under public/maps/.
  // worldSize = DayZ world extent (east/north) for each map.
  const MAPS = {
    chernarusplus: { name: 'Chernarus+', worldSize: 15360 },
    enoch: { name: 'Livonia', worldSize: 12800 },
    sakhal: { name: 'Sakhal', worldSize: 15360 },
  };
  const GRID_SIZE = 32;
  const TILE_ADVANCEMENT = 480;
  const PHYSICAL_TILE = 512;

  function imageSizeFor(worldSize) {
    // Same formula as DayzMapCoordinates.definition().
    return (GRID_SIZE - 1) * TILE_ADVANCEMENT + PHYSICAL_TILE;
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function mapAvailable(mapName) {
    return Object.prototype.hasOwnProperty.call(MAPS, mapName);
  }

  /**
   * World coordinate -> tile file + in-tile marker offset.
   *
   * @param {string} mapName
   * @param {{east:number, north:number}} world  east = world X, north = world Z
   * @returns {{tileX:number, tileY:number, fileY:number, px:number, py:number,
   *            tileUrl:string} | null}  null when the map has no tiles or the
   *            coordinate is not finite.
   */
  function tileForWorld(mapName, world) {
    const map = MAPS[mapName];
    if (!map) return null;
    const east = Number(world && world.east);
    const north = Number(world && world.north);
    if (!Number.isFinite(east) || !Number.isFinite(north)) return null;

    const image = imageSizeFor(map.worldSize);
    // Leaflet image-space pixels (world min is 0 for these maps).
    const lng = clamp(east, 0, map.worldSize) * image / map.worldSize;
    const lat = clamp(north, 0, map.worldSize) * image / map.worldSize;

    const tileX = clamp(Math.floor(lng / TILE_ADVANCEMENT), 0, GRID_SIZE - 1);
    const tileY = clamp(Math.floor(lat / TILE_ADVANCEMENT), 0, GRID_SIZE - 1);
    const fileY = (GRID_SIZE - 1) - tileY; // flipped, per dayz-map-tiles.js

    return {
      tileX,
      tileY,
      fileY,
      px: lng - tileX * TILE_ADVANCEMENT,   // marker x within the tile image
      py: lat - tileY * TILE_ADVANCEMENT,   // marker y within the tile image
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
    const label = String(name || mapName).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const size = Number(sizePx) || 220;
    return `<div data-destination-preview style="position:relative;width:${size}px;height:${size}px;overflow:hidden;border-radius:var(--dzc-radius-md,8px);border:1px solid var(--dzc-border,#233042)">` +
      `<img src="${tile.tileUrl}" alt="" style="width:${PHYSICAL_TILE}px;height:${PHYSICAL_TILE}px;max-width:none;display:block;transform:translate(${-tile.px}px,${-tile.py}px)">` +
      `<span aria-label="Destination ${label}" style="position:absolute;left:0;top:0;width:10px;height:10px;margin:-5px 0 0 -5px;border-radius:50%;background:var(--dzc-stat,#34e07a);box-shadow:0 0 0 2px rgba(0,0,0,0.6)"></span>` +
      (label ? `<div style="position:absolute;left:6px;bottom:6px;font-size:12px;color:var(--dzc-text,#e6eef8);background:rgba(0,0,0,0.55);padding:2px 6px;border-radius:var(--dzc-radius-sm,4px)">${label}</div>` : '') +
      `</div>`;
  }

  return Object.freeze({
    MAPS,
    GRID_SIZE,
    TILE_ADVANCEMENT,
    PHYSICAL_TILE,
    mapAvailable,
    tileForWorld,
    previewHtml,
  });
}));
