/* global document */
/*
 * Event Conflict Check page. Client-side only.
 * Cross-checks cfgeventspawns.xml / cfgeventgroups.xml / events.xml:
 * shadowed names, invalid coordinates, out-of-bounds positions,
 * and lootmin/lootmax inversions.
 */
(function () {
  'use strict';
  var core = globalThis.DayZToolkitCore;
  var dom = globalThis.DayZToolkitDom;
  if (!core || !dom) return;

  var app = document.getElementById('app');
  dom.mountChrome(app, 'Event Conflict Check',
    'Drop cfgeventspawns.xml and/or cfgeventgroups.xml (and events.xml where used). The engine keys ' +
    'events and groups by name — a duplicate silently shadows the first definition. Positions are ' +
    'validated numerically and, when the map is known, checked against real map bounds ' +
    '(Chernarus+ / Sakhal 15 360 m, Livonia / Namalsk / Takistan+ 12 800 m).');

  // Map selection: auto from file names, or explicit.
  var mapSelect = document.createElement('select');
  mapSelect.className = 'tk-select';
  var autoOpt = document.createElement('option');
  autoOpt.value = 'auto';
  autoOpt.textContent = 'Auto (from file name)';
  mapSelect.appendChild(autoOpt);
  Object.keys(core.MAP_BOUNDS).forEach(function (mapId) {
    var opt = document.createElement('option');
    opt.value = mapId;
    opt.textContent = mapId + ' (' + core.MAP_BOUNDS[mapId] + ' m)';
    mapSelect.appendChild(opt);
  });
  var noneOpt = document.createElement('option');
  noneOpt.value = 'none';
  noneOpt.textContent = 'Skip bounds check';
  mapSelect.appendChild(noneOpt);

  var controls = document.createElement('div');
  controls.className = 'tk-split-row';
  controls.appendChild(dom.el('label', '', 'Map:'));
  controls.appendChild(mapSelect);
  app.appendChild(controls);

  var results = document.createElement('div');
  results.className = 'tk-results';

  function detectMapId(fileName) {
    var segments = fileName.split(/[\\/]/);
    for (var i = 0; i < segments.length; i++) {
      var id = core.mapIdFromMissionName(segments[i]);
      if (id) return id;
    }
    return null;
  }

  var EVENT_BASENAMES = { 'cfgeventspawns.xml': 1, 'cfgeventgroups.xml': 1, 'events.xml': 1 };

  function runOn(items) {
    results.textContent = '';
    var eventItems = items.filter(function (item) {
      return EVENT_BASENAMES[item.name.split('/').pop().toLowerCase()];
    });
    var otherItems = items.filter(function (item) {
      return !EVENT_BASENAMES[item.name.split('/').pop().toLowerCase()];
    });
    otherItems.forEach(function (item) {
      dom.renderSummaryLine(results, item.name + ': not an event definition file (needs cfgeventspawns.xml, cfgeventgroups.xml or events.xml) — skipped.');
    });
    if (!eventItems.length) {
      dom.renderSummaryLine(results, 'No event files detected.');
      return;
    }
    results.appendChild(dom.el('p', 'tk-results-title', eventItems.length + ' event file(s) — all checks ran locally'));

    eventItems.forEach(function (item) {
      var base = item.name.split('/').pop().toLowerCase();
      var mapId;
      if (mapSelect.value === 'auto') mapId = detectMapId(item.name);
      else if (mapSelect.value === 'none') mapId = null;
      else mapId = mapSelect.value;

      // 1) Structural validation (root, required attrs, unique names, class names, coords)
      var structural = core.validateXml(item.name, item.text, dom.makeXmlParser(), base);
      dom.renderReport(results, structural);

      // 2) Conflict pass (needs the parsed model)
      var parsed;
      try { parsed = dom.makeXmlParser()(item.text); } catch (err) { return; }
      if (!parsed.ok) return;
      var conflicts = core.analyzeEvents(item.name, parsed.model, mapId);
      if (conflicts.errors.length || conflicts.warnings.length || conflicts.info.length) {
        var copy = structural; // keep card titles distinct
        conflicts.fileName = base + ' — conflict pass' + (mapId ? ' [' + mapId + ' bounds]' : ' [no bounds]');
        dom.renderReport(results, conflicts);
        void copy;
      } else if (mapId) {
        dom.renderSummaryLine(results, base + ': no conflicts, all positions inside ' + mapId + ' bounds.');
      }
    });
  }

  dom.mountSourceBox(app, {
    multiple: true,
    accept: '.xml,.txt',
    allowPaste: true,
    onFiles: function (items) {
      // Pasted content is always validated as the event file matching the paste;
      // give it a neutral name so auto-map detection skips it.
      var renamed = items.map(function (item) {
        if (item.name === 'pasted-document.xml') {
          return { name: 'pasted-event.xml', text: item.text };
        }
        return item;
      });
      runOn(renamed);
    }
  });
  app.appendChild(results);
})();
