/* global document, navigator */
/*
 * XML Validator page. Client-side only.
 */
(function () {
  'use strict';
  var core = globalThis.DayZToolkitCore;
  var dom = globalThis.DayZToolkitDom;
  if (!core || !dom) return;

  var app = document.getElementById('app');
  dom.mountChrome(app, 'XML Validator',
    'Drop .xml files (or paste content). Well-formedness is checked with the browser’s XML parser; ' +
    'recognized DayZ files (types.xml, cfgeventspawns.xml, globals.xml, …) get structure rules — ' +
    'required roots, required attributes, unique names, valid class names, numeric invariants, and common style issues.');

  var parser = dom.makeXmlParser();

  // Document-type override (for pasted content or oddly-named files).
  var typeSelect = document.createElement('select');
  typeSelect.className = 'tk-select';
  var autoOpt = document.createElement('option');
  autoOpt.value = '';
  autoOpt.textContent = 'Auto (from file name)';
  typeSelect.appendChild(autoOpt);
  core.RULE_NAMES.forEach(function (name) {
    var opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    typeSelect.appendChild(opt);
  });
  var controls = document.createElement('div');
  controls.className = 'tk-split-row';
  controls.appendChild(dom.el('label', '', 'Document type:'));
  controls.appendChild(typeSelect);
  app.appendChild(controls);

  var results = document.createElement('div');
  results.className = 'tk-results';

  function actionsFor(item, report) {
    var row = dom.el('div', 'tk-actions');
    row.appendChild(dom.makeDownloadButton(item.name.replace(/\.xml$/i, '') + '.xml', item.text));
    if (report.summary && report.summary.valid) {
      var cleaned = core.safeCleanupXml(item.text);
      if (cleaned.hasChanges) {
        row.appendChild(dom.makeDownloadButton(item.name.replace(/\.xml$/i, '') + '.cleaned.xml', cleaned.fixed));
      }
    }
    var copy = dom.el('button', 'tk-btn tk-btn-small', 'Copy report (JSON)');
    copy.type = 'button';
    copy.addEventListener('click', function () {
      var payload = {
        file: report.fileName,
        summary: report.summary,
        errors: report.errors,
        warnings: report.warnings,
        info: report.info
      };
      navigator.clipboard.writeText(JSON.stringify(payload, null, 2)).then(
        function () { copy.textContent = 'Copied'; },
        function () { copy.textContent = 'Copy failed'; }
      );
    });
    row.appendChild(copy);
    return row;
  }

  function runOn(items) {
    results.textContent = '';
    var title = dom.el('p', 'tk-results-title', items.length + ' document(s) — all checks ran locally');
    results.appendChild(title);
    items.forEach(function (item) {
      var type = typeSelect.value || undefined;
      var report = core.validateXml(item.name, item.text, parser, type);
      dom.renderReport(results, report);
      results.appendChild(actionsFor(item, report));
    });
  }

  dom.mountSourceBox(app, {
    multiple: true,
    accept: '.xml,.txt',
    allowPaste: true,
    onFiles: runOn
  });
  app.appendChild(results);
})();
