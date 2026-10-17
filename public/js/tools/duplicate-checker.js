/* global document */
/*
 * Duplicate Classname Checker page. Client-side only.
 * Covers DZB's "Spawnable Duplicate Checker" / "SpawnObject Duplicate Checker"
 * surface: XML registry duplicates + JSON placement-object duplicates.
 */
(function () {
  'use strict';
  var core = globalThis.DayZToolkitCore;
  var dom = globalThis.DayZToolkitDom;
  if (!core || !dom) return;

  var app = document.getElementById('app');
  dom.mountChrome(app, 'Duplicate Classname Checker',
    'Drop the registry XMLs (types.xml, cfgspawnabletypes.xml, mapgroupproto.xml, cfgeventgroups.xml, …) ' +
    'and any object-placement JSON. Finds names the engine will treat as collisions — the #1 cause of ' +
    'silent loot/spawn loss after merging two mission packs. Repeated group placements in mapgrouppos.xml ' +
    'are expected and marked as such.');

  var results = document.createElement('div');
  results.className = 'tk-results';

  function renderTable(container, rows, columns) {
    var table = document.createElement('table');
    table.className = 'tk-table';
    var thead = document.createElement('tr');
    columns.forEach(function (col) { thead.appendChild(dom.el('th', '', col)); });
    table.appendChild(thead);
    rows.forEach(function (row) {
      var tr = document.createElement('tr');
      row.forEach(function (cell) {
        var td = document.createElement('td');
        if (typeof cell === 'object' && cell.mono) td.className = 'tk-mono';
        td.textContent = typeof cell === 'object' ? cell.text : cell;
        tr.appendChild(td);
      });
      table.appendChild(tr);
    });
    container.appendChild(table);
  }

  function extractJsonArrays(item) {
    // Return [{ label, entries }] for splittable arrays in this JSON file.
    var value;
    try { value = JSON.parse(item.text); } catch (err) { return { error: err.message }; }
    var out = [];
    if (Array.isArray(value)) {
      out.push({ label: 'top-level array', entries: value });
    } else if (value && typeof value === 'object') {
      Object.keys(value).forEach(function (key) {
        if (Array.isArray(value[key])) out.push({ label: key, entries: value[key] });
      });
    }
    return { arrays: out };
  }

  function runOn(items) {
    results.textContent = '';
    results.appendChild(dom.el('p', 'tk-results-title', items.length + ' file(s) scanned locally'));

    var xmlFiles = [];
    var jsonFiles = [];
    items.forEach(function (item) {
      if (item.name.toLowerCase().endsWith('.json')) jsonFiles.push(item);
      else xmlFiles.push(item);
    });

    // ---- XML name duplicates ----
    if (xmlFiles.length) {
      var parseResults = xmlFiles.map(function (item) {
        var parsed;
        try { parsed = dom.makeXmlParser()(item.text); }
        catch (err) { parsed = { ok: false, error: { message: err.message } }; }
        if (!parsed.ok) {
          dom.renderSummaryLine(results, item.name + ': not parseable (' + parsed.error.message + ') — skipped');
          return null;
        }
        return { fileName: item.name, entries: core.collectNamed(parsed.model) };
      }).filter(Boolean);

      var duplicates = core.findDuplicates(parseResults);
      var expected = duplicates.filter(function (d) {
        return d.tag === 'group' && d.files.every(function (f) {
          return f.split('/').pop().toLowerCase() === 'mapgrouppos.xml';
        });
      });
      var real = duplicates.filter(function (d) { return expected.indexOf(d) === -1; });

      results.appendChild(dom.el('h2', 'tk-results-title', 'XML registry names — ' + real.length + ' collision(s), ' + expected.length + ' expected repeat(s)'));
      if (real.length) {
        renderTable(results, real.map(function (d) {
          return [
            { text: d.name, mono: true },
            '<' + d.tag + '>',
            String(d.count),
            d.crossFile ? 'YES — merged sources' : 'same file',
            d.files.length > 1 ? d.files.slice(0, 3).join(', ') + (d.files.length > 3 ? ' …' : '') : d.files[0]
          ];
        }), ['Name', 'Element', 'Count', 'Cross-file', 'Where']);
      } else {
        dom.renderSummaryLine(results, 'No unexpected duplicate names found.');
      }
      if (expected.length) {
        dom.renderSummaryLine(results, 'Expected repeats (multiple placements in mapgrouppos.xml): ' +
          expected.map(function (d) { return d.name + ' ×' + d.count; }).join(', '));
      }
    }

    // ---- JSON placement-object duplicates ----
    if (jsonFiles.length) {
      results.appendChild(dom.el('h2', 'tk-results-title', 'JSON placement objects'));
      jsonFiles.forEach(function (item) {
        var extracted = extractJsonArrays(item);
        if (extracted.error) {
          dom.renderSummaryLine(results, item.name + ': not parseable (' + extracted.error + ') — skipped');
          return;
        }
        (extracted.arrays || []).forEach(function (arr) {
          var counts = {};
          arr.entries.forEach(function (entry) {
            var key = JSON.stringify(entry);
            counts[key] = (counts[key] || 0) + 1;
          });
          var dupKeys = Object.keys(counts).filter(function (k) { return counts[k] > 1; });
          if (dupKeys.length === 0) {
            dom.renderSummaryLine(results, item.name + ' (' + arr.label + ', ' + arr.entries.length + ' objects): no exact duplicates.');
            return;
          }
          dom.renderSummaryLine(results, item.name + ' (' + arr.label + ', ' + arr.entries.length + ' objects): ' + dupKeys.length + ' distinct object(s) appear more than once — ' +
            dupKeys.reduce(function (sum, k) { return sum + counts[k]; }, 0) + ' total placements.');
          renderTable(results, dupKeys.slice(0, 10).map(function (key) {
            var sample = JSON.parse(key);
            var ident = sample && typeof sample === 'object'
              ? (sample.class || sample.name || sample.type || '(unlabeled)') +
                (sample.position || sample.pos ? ' @ ' + JSON.stringify(sample.position || sample.pos) : '')
              : '(non-object entry)';
            return [{ text: ident, mono: true }, String(counts[key])];
          }), ['Object', 'Placements']);
          if (dupKeys.length > 10) dom.renderSummaryLine(results, '… and ' + (dupKeys.length - 10) + ' more duplicate object(s).');
        });
      });
    }
  }

  dom.mountSourceBox(app, {
    multiple: true,
    accept: '.xml,.json,.txt',
    allowPaste: false,
    onFiles: runOn
  });
  app.appendChild(results);
})();
