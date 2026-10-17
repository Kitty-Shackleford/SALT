/* global document */
/*
 * Mission Validator page. Client-side only.
 * Accepts a mission .zip (via locally vendored JSZip) or a set of loose
 * files / a folder. Every text file is validated locally; nothing is
 * uploaded.
 */
(function () {
  'use strict';
  var core = globalThis.DayZToolkitCore;
  var dom = globalThis.DayZToolkitDom;
  if (!core || !dom) return;

  var app = document.getElementById('app');
  dom.mountChrome(app, 'Mission Validator (ZIP)',
    'Drop a mission .zip — or a folder of loose mission files. The archive is unzipped in memory, ' +
    'every XML / JSON / init.c file is validated with DayZ structure rules, the mission layout is ' +
    'checked (mission.sqm, init.c, db/messages.xml, …), and spawn coordinates are tested against ' +
    'the map bounds when the mission name identifies a map.');

  var results = document.createElement('div');
  results.className = 'tk-results';

  var MAX_ENTRIES = 500;

  function relLower(entryPath) {
    // Normalize backslashes from zip archives, strip leading ./
    return entryPath.split('/').filter(Boolean).join('/').toLowerCase();
  }

  function kindFor(name) {
    var lower = name.toLowerCase();
    if (lower === 'init.c') return 'initc';
    if (lower.endsWith('.c')) return 'initc';
    if (lower.endsWith('.xml')) return 'xml';
    if (lower.endsWith('.json')) return 'json';
    return 'skip';
  }

  function detectMapId(paths) {
    // Prefer mission.sqm's basename: 'dayzOffline.chernarusplus.sqm' or 'ChernarusPlus.sqm'
    for (var i = 0; i < paths.length; i++) {
      var p = paths[i];
      if (p === 'mission.sqm') {
        var folder = p.substring(0, p.lastIndexOf('/'));
        var id = core.mapIdFromMissionName(folder);
        if (id) return id;
      }
    }
    // Fallback: any path segment shaped like a mission name.
    for (var j = 0; j < paths.length; j++) {
      var segments = paths[j].split('/');
      for (var k = 0; k < segments.length; k++) {
        var guess = core.mapIdFromMissionName(segments[k]);
        if (guess) return guess;
      }
    }
    return null;
  }

  function runScan(items) {
    // items: [{ name: relativePath, text }]
    results.textContent = '';
    var start = Date.now();

    var lowerNames = {};
    items.forEach(function (item) { lowerNames[relLower(item.name)] = true; });
    var mapId = detectMapId(Object.keys(lowerNames));

    // 1) Mission structure
    var structure = core.missionStructureReport(lowerNames);
    if (items.length > 0) {
      var structCard = dom.el('section', 'tk-card tk-' + structure.summary.status);
      var head = dom.el('div', 'tk-card-head');
      head.appendChild(dom.el('span', 'tk-status tk-status-' + structure.summary.status, 'MISSION LAYOUT'));
      head.appendChild(dom.el('h3', 'tk-card-title', items.length + ' files' + (mapId ? ' — map: ' + mapId : '')));
      structCard.appendChild(head);
      var list = dom.el('ul', 'tk-findings');
      ['errors', 'warnings', 'info'].forEach(function (kind) {
        (structure[kind] || []).forEach(function (f) {
          var li = dom.el('li', 'tk-finding tk-finding-' + f.severity);
          li.appendChild(dom.el('strong', 'tk-sev', f.severity.toUpperCase()));
          li.appendChild(dom.el('span', 'tk-msg', ' ' + f.message + ' [' + f.code + ']'));
          list.appendChild(li);
        });
      });
      if (!list.childElementCount) list.appendChild(dom.el('li', 'tk-finding', 'Layout looks complete.'));
      structCard.appendChild(list);
      results.appendChild(structCard);
    }

    // 2) Per-file validation
    var fileReports = [];
    items.forEach(function (item) {
      var kind = kindFor(item.name);
      if (kind === 'skip') return;
      var report;
      if (kind === 'xml') report = core.validateXml(item.name, item.text, dom.makeXmlParser());
      else if (kind === 'json') report = core.validateJson(item.name, item.text);
      else report = core.validateInitC(item.name, item.text);
      fileReports.push(report);
    });

    // 3) Event conflict pass on event files, with the detected map bounds.
    if (mapId) {
      items.forEach(function (item) {
        var kind = kindFor(item.name);
        if (kind !== 'xml') return;
        var base = item.name.split('/').pop().toLowerCase();
        if (base !== 'cfgeventspawns.xml' && base !== 'cfgeventgroups.xml' && base !== 'events.xml') return;
        var parsed;
        try {
          parsed = dom.makeXmlParser()(item.text);
        } catch (err) {
          return;
        }
        if (!parsed.ok) return;
        var ev = core.analyzeEvents(item.name, parsed.model, mapId);
        if (ev.errors.length || ev.warnings.length || ev.info.length) fileReports.push(ev);
      });
    }

    // Sort: invalid first, then good, then excellent; findings by name.
    var rank = { invalid: 0, good: 1, excellent: 2 };
    fileReports.sort(function (a, b) {
      var r = rank[a.summary.status] - rank[b.summary.status];
      return r !== 0 ? r : a.fileName.localeCompare(b.fileName);
    });

    var totalErrors = 0;
    var totalWarnings = 0;
    fileReports.forEach(function (report) {
      totalErrors += report.summary.errorCount;
      totalWarnings += report.summary.warningCount;
      dom.renderReport(results, report);
    });

    var summary = dom.el('p', 'tk-summary-line',
      'Scanned ' + fileReports.length + ' text file(s) in ' + (Date.now() - start) + ' ms — ' +
      totalErrors + ' error(s), ' + totalWarnings + ' warning(s). All processing stayed in this tab.');
    results.appendChild(summary);
  }

  async function handleZip(file) {
    if (typeof globalThis.JSZip === 'undefined') {
      results.appendChild(dom.el('p', 'tk-err', 'JSZip failed to load — reload the page.'));
      return;
    }
    var buffer = await dom.readAsArrayBuffer(file);
    var zip;
    try {
      zip = await globalThis.JSZip.loadAsync(buffer);
    } catch (err) {
      results.appendChild(dom.el('p', 'tk-err', 'Could not open zip: ' + err.message));
      return;
    }
    var items = [];
    var totalBytes = 0;
    var aborted = null;
    zip.forEach(function (relPath, entry) {
      if (entry.dir) return;
      if (items.length >= MAX_ENTRIES) { aborted = 'Too many entries (' + MAX_ENTRIES + ' cap)'; return; }
      // Only inspect text-ish DayZ mission files; skip binaries (p3d, paa, sqm internals).
      var lower = relPath.toLowerCase();
      if (!lower.endsWith('.xml') && !lower.endsWith('.json') && lower !== 'init.c' && !lower.endsWith('.c') &&
          !lower.endsWith('mission.sqm') && lower.indexOf('mission.sqm') === -1) {
        // Still record non-text names for the structure check.
        return;
      }
      totalBytes += entry._data ? (entry._data.uncompressedSize || 0) : 0;
      if (totalBytes > core.MAX_SCAN_BYTES) aborted = 'Text content exceeds the ' + (core.MAX_SCAN_BYTES / 1048576) + ' MiB scan budget';
    });
    if (aborted) {
      results.appendChild(dom.el('p', 'tk-err', aborted));
      return;
    }
    // Re-walk to read (forEach is synchronous iteration; load lazily here).
    var pending = [];
    zip.forEach(function (relPath, entry) {
      if (entry.dir) return;
      var lower = relPath.toLowerCase();
      if (items.length >= MAX_ENTRIES) return;
      if (lower === 'mission.sqm' || lower.endsWith('.sqm') ||
          lower.endsWith('.xml') || lower.endsWith('.json') || lower === 'init.c' || lower.endsWith('.c')) {
        pending.push({ name: relLower(relPath), entry: entry });
      }
    });
    for (var i = 0; i < pending.length; i++) {
      var p = pending[i];
      if (p.name.endsWith('.sqm')) {
        items.push({ name: p.name, text: '' }); // structure marker only; .sqm is not text-validated
        continue;
      }
      try {
        var text = await p.entry.async('string');
        if (text.length > core.MAX_FILE_BYTES) {
          results.appendChild(dom.el('p', 'tk-err', p.name + ' exceeds the per-file limit — skipped'));
          continue;
        }
        items.push({ name: p.name, text: text });
      } catch (err) {
        results.appendChild(dom.el('p', 'tk-err', 'Failed to read ' + p.name + ': ' + err.message));
      }
    }
    if (items.length === 0) {
      results.appendChild(dom.el('p', 'tk-err', 'No inspectable mission files found in the archive.'));
      return;
    }
    runScan(items);
  }

  function handleLoose(items) {
    // Loose files / folder: use the file's webkitRelativePath when present.
    var named = items.map(function (item) {
      var name = item.name;
      return { name: name, text: item.text };
    });
    runScan(named);
  }

  dom.mountSourceBox(app, {
    multiple: true,
    accept: '.zip,.xml,.json,.c',
    allowPaste: false,
    onFiles: function (items) {
      var zipItem = null;
      var loose = [];
      items.forEach(function (item) {
        if (item.name.toLowerCase().endsWith('.zip')) zipItem = item;
        else loose.push(item);
      });
      if (zipItem) handleZip(zipItem);
      else if (loose.length) handleLoose(loose);
    }
  });
  app.appendChild(results);
})();
