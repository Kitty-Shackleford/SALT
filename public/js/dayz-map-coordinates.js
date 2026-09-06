/*
 * Canonical DayZ world-to-map definitions and transformations.
 *
 * WorldPosition uses semantic axes:
 *   east      = DayZ world X
 *   north     = DayZ world Z
 *   elevation = DayZ world Y
 *
 * ADM logs serialize those values as <east, north, elevation>; use the ADM
 * adapter before rendering instead of interpreting legacy pos_* names as
 * semantic DayZ axis names.
 */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.DayzMapCoordinates = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  function definition(name, worldSize, options = {}) {
    const gridSize = options.gridSize || 32;
    const physicalTileSize = options.physicalTileSize || 512;
    const tileAdvancement = options.tileAdvancement || 480;
    const imageSize = options.imageSize || (gridSize - 1) * tileAdvancement + physicalTileSize;
    return Object.freeze({
      id: name,
      name: options.name || name,
      worldMinEast: 0,
      worldMaxEast: worldSize,
      worldMinNorth: 0,
      worldMaxNorth: worldSize,
      worldWidth: worldSize,
      worldHeight: worldSize,
      imageWidth: imageSize,
      imageHeight: imageSize,
      gridSize,
      physicalTileSize,
      tileAdvancement,
      tileOverlap: physicalTileSize - tileAdvancement,
      verifiedGeometry: options.verifiedGeometry !== false,

      // Compatibility aliases for existing Leaflet consumers.
      size: imageSize,
      gameSize: worldSize,
      physicalSize: physicalTileSize,
      advancement: tileAdvancement,
      tileSize: tileAdvancement,
      overlap: physicalTileSize - tileAdvancement,
    });
  }

  const MAP_DEFINITIONS = Object.freeze({
    chernarusplus: definition('chernarusplus', 15360, { name: 'Chernarus+' }),
    enoch: definition('enoch', 12800, { name: 'Livonia' }),
    sakhal: definition('sakhal', 15360, { name: 'Sakhal' }),

    // These definitions preserve existing behavior until matching raster assets
    // and authoritative terrain bounds are available for calibration.
    namalsk: definition('namalsk', 12800, {
      name: 'Namalsk',
      imageSize: 15424,
      tileAdvancement: 482,
      verifiedGeometry: false,
    }),
    takistanplus: definition('takistanplus', 12800, {
      name: 'Takistan+',
      imageSize: 12800,
      tileAdvancement: 400,
      verifiedGeometry: false,
    }),
  });

  function finiteNumber(value, fieldName) {
    if (value === null || value === undefined || value === '') {
      throw new TypeError(`${fieldName} must be a finite number`);
    }
    const number = Number(value);
    if (!Number.isFinite(number)) throw new TypeError(`${fieldName} must be a finite number`);
    return number;
  }


  function getMapDefinition(mapName, fallbackMapName = 'chernarusplus') {
    return MAP_DEFINITIONS[mapName] || MAP_DEFINITIONS[fallbackMapName] || MAP_DEFINITIONS.chernarusplus;
  }

  function worldToLeaflet(position, mapName) {
    const map = getMapDefinition(mapName);
    const east = finiteNumber(position.east, 'east');
    const north = finiteNumber(position.north, 'north');
    return [
      (north - map.worldMinNorth) * map.imageHeight / map.worldHeight,
      (east - map.worldMinEast) * map.imageWidth / map.worldWidth,
    ];
  }

  function leafletToWorld(position, mapName) {
    const map = getMapDefinition(mapName);
    const lat = finiteNumber(position.lat, 'lat');
    const lng = finiteNumber(position.lng, 'lng');
    return {
      east: map.worldMinEast + lng * map.worldWidth / map.imageWidth,
      north: map.worldMinNorth + lat * map.worldHeight / map.imageHeight,
    };
  }


  function tileBounds(x, y, mapName) {
    const map = getMapDefinition(mapName);
    const tileX = finiteNumber(x, 'tile x');
    const tileY = finiteNumber(y, 'tile y');
    return [
      [tileY * map.tileAdvancement, tileX * map.tileAdvancement],
      [tileY * map.tileAdvancement + map.physicalTileSize,
        tileX * map.tileAdvancement + map.physicalTileSize],
    ];
  }

  function tileFileCoordinates(x, y, mapName) {
    const map = getMapDefinition(mapName);
    const tileX = finiteNumber(x, 'tile x');
    const tileY = finiteNumber(y, 'tile y');
    if (!Number.isInteger(tileX) || !Number.isInteger(tileY) ||
        tileX < 0 || tileY < 0 || tileX >= map.gridSize || tileY >= map.gridSize) return null;
    return { x: tileX, y: (map.gridSize - 1) - tileY };
  }

  return Object.freeze({
    MAP_DEFINITIONS,
    getMapDefinition,
    worldToLeaflet,
    leafletToWorld,

    tileBounds,
    tileFileCoordinates,
  });
}));
