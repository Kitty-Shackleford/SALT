'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/shop.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'public/js/shop.js'), 'utf8');

function sectionBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert(startIndex >= 0 && endIndex > startIndex, `Missing section between ${start} and ${end}`);
  return source.slice(startIndex, endIndex);
}

function testMapPickerActionsRemainVisibleOnNarrowScreens() {
  const mapPicker = sectionBetween(html, '<div id="map-picker-modal"', '<script src="/js/api.js"');
  const mapIndex = mapPicker.indexOf('<div id="shop-map"></div>');
  const actionsIndex = mapPicker.indexOf('id="map-picker-actions"');

  assert(actionsIndex > mapIndex, 'map picker actions must be in a footer after the flexible map, not in the overflowing top toolbar');
  assert(mapPicker.includes('id="map-picker-actions"'));
  assert(mapPicker.includes('class="flex gap-3'));
  assert(mapPicker.includes('id="mp-confirm-btn"'));
  assert(mapPicker.includes('id="mp-cancel-btn"'));
  assert(mapPicker.includes('Back to Shop'));
}

function testMapPickerActionsStillApplyOrCancelSelection() {
  assert(js.includes("document.getElementById('mp-confirm-btn').addEventListener('click', confirmMapLocation)"));
  assert(js.includes("document.getElementById('mp-cancel-btn').addEventListener('click', closeMapPicker)"));
  assert(js.includes("document.getElementById('atc-pos-x').value = shopPickedCoords.x"));
  assert(js.includes("document.getElementById('atc-pos-z').value = shopPickedCoords.z"));
  assert(js.includes('closeMapPicker();'));
}

testMapPickerActionsRemainVisibleOnNarrowScreens();
testMapPickerActionsStillApplyOrCancelSelection();
console.log('Shop map picker regression tests passed');
