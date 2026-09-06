(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DayzMapTiles = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  const EMPTY_TILE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

  function tileFileCoordinates(coords, gridSize) {
    const x = Number(coords && coords.x);
    const y = Number(coords && coords.y) + Number(gridSize);
    if (!Number.isInteger(x) || !Number.isInteger(y) ||
        x < 0 || x >= gridSize || y < 0 || y >= gridSize) return null;
    return { x, y };
  }

  function create(L, mapName, config) {
    if (!L || !L.GridLayer) throw new Error('Leaflet GridLayer is required');
    const gridSize = Number(config.gridSize) || 32;
    const advancement = Number(config.advancement || config.tileSize) || 480;
    const physicalSize = Number(config.physicalSize) || advancement;
    const safeMapName = /^[a-z0-9]+$/i.test(String(mapName)) ? String(mapName) : 'chernarusplus';

    const Layer = L.GridLayer.extend({
      createTile(coords, done) {
        const container = document.createElement('div');
        container.style.width = advancement + 'px';
        container.style.height = advancement + 'px';
        container.style.overflow = 'visible';
        container.style.pointerEvents = 'none';

        const file = tileFileCoordinates(coords, gridSize);
        if (!file) {
          done(null, container);
          return container;
        }

        const image = document.createElement('img');
        image.alt = '';
        image.src = `/maps/${safeMapName}/tiles/${file.x}/${file.y}.png`;
        image.style.width = physicalSize + 'px';
        image.style.height = physicalSize + 'px';
        image.style.maxWidth = 'none';
        image.style.display = 'block';
        image.onload = () => done(null, container);
        image.onerror = () => {
          image.onload = null;
          image.onerror = null;
          image.src = EMPTY_TILE;
          done(null, container);
        };
        container.appendChild(image);
        return container;
      },
    });

    return new Layer({
      tileSize: advancement,
      minNativeZoom: 0,
      maxNativeZoom: 0,
      minZoom: -2,
      maxZoom: 4,
      noWrap: true,
      keepBuffer: 2,
      updateWhenIdle: true,
      bounds: [[0, 0], [Number(config.size), Number(config.size)]],
    });
  }

  return { create, tileFileCoordinates };
}));
