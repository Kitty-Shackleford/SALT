/* global document, navigator */
/*
 * JSON Validator & Splitter page. Client-side only.
 */
(function () {
  'use strict';
  var core = globalThis.DayZToolkitCore;
  var dom = globalThis.DayZToolkitDom;
  if (!core || !dom) return;

  var app = document.getElementById('app');
  dom.mountChrome(app, 'JSON Validator & Splitter',
    'Strict JSON parsing with error location, indentation report, and a pretty-print download. ' +
    'The splitter breaks any top-level array into parts — by piece count or by target byte size — ' +
    'each downloadable, for files that exceed editor or API limits.');

  var results = document.createElement('div');
  results.className = 'tk-results';

  var lastText = null;
  var lastValue = null;

  function actionsFor(item, report) {
    var row = dom.el('div', 'tk-actions');
    row.appendChild(dom.makeDownloadButton(item.name, item.text));
    if (report.summary && report.summary.valid) {
      row.appendChild(dom.makeDownloadButton(item.name + '.pretty.json', function () {
        return core.prettyJson(item.text);
      }));
    }
    var copy = dom.el('button', 'tk-btn tk-btn-small', 'Copy report (JSON)');
    copy.type = 'button';
    copy.addEventListener('click', function () {
      var payload = { file: report.fileName, summary: report.summary, errors: report.errors, warnings: report.warnings, info: report.info };
      navigator.clipboard.writeText(JSON.stringify(payload, null, 2)).then(
        function () { copy.textContent = 'Copied'; },
        function () { copy.textContent = 'Copy failed'; }
      );
    });
    row.appendChild(copy);
    return row;
  }

  // ---- Splitter (operates on the last validated file) ----
  var splitRow = dom.el('div', 'tk-split-row');
  var modeSelect = document.createElement('select');
  modeSelect.className = 'tk-select';
  [['count', 'By piece count'], ['size', 'By target size']].forEach(function (pair) {
    var opt = document.createElement('option');
    opt.value = pair[0];
    opt.textContent = pair[1];
    modeSelect.appendChild(opt);
  });
  var countInput = document.createElement('input');
  countInput.className = 'tk-number';
  countInput.type = 'number';
  countInput.min = '2';
  countInput.max = '1000';
  countInput.value = '4';
  var sizeInput = document.createElement('input');
  sizeInput.className = 'tk-number';
  sizeInput.type = 'number';
  sizeInput.min = '1024';
  sizeInput.step = '1024';
  sizeInput.value = String(512 * 1024);
  sizeInput.title = 'Max serialized bytes per part (default 512 KiB)';
  var splitBtn = dom.el('button', 'tk-btn', 'Split');
  splitBtn.type = 'button';
  splitBtn.disabled = true;

  splitRow.appendChild(dom.el('label', '', 'Split last validated file'));
  splitRow.appendChild(modeSelect);
  splitRow.appendChild(dom.el('label', '', 'parts:'));
  splitRow.appendChild(countInput);
  splitRow.appendChild(dom.el('label', '', 'max bytes/part:'));
  splitRow.appendChild(sizeInput);
  splitRow.appendChild(splitBtn);
  app.appendChild(splitRow);

  function syncSplitInputs() {
    var byCount = modeSelect.value === 'count';
    countInput.style.display = byCount ? '' : 'none';
    sizeInput.style.display = byCount ? 'none' : '';
  }
  modeSelect.addEventListener('change', syncSplitInputs);
  syncSplitInputs();

  splitBtn.addEventListener('click', function () {
    if (!lastText) return;
    var mode = modeSelect.value;
    var arg = mode === 'count' ? countInput.value : sizeInput.value;
    var result = core.splitJsonArray(lastText, mode, arg);
    var holder = document.createElement('div');
    holder.className = 'tk-card';
    var head = dom.el('div', 'tk-card-head');
    if (result.ok) {
      head.appendChild(dom.el('span', 'tk-status tk-status-excellent', 'SPLIT'));
      head.appendChild(dom.el('h3', 'tk-card-title', lastValue + ' → ' + result.chunks.length + ' part(s)'));
      var list = dom.el('ul', 'tk-findings');
      result.chunks.forEach(function (chunk) {
        var li = document.createElement('li');
        li.className = 'tk-finding';
        li.appendChild(dom.el('strong', 'tk-sev', 'part'));
        li.appendChild(dom.el('span', 'tk-msg', ' ' + chunk.name + ' — ' + (chunk.content.length / 1024).toFixed(1) + ' KiB '));
        var btn = dom.makeDownloadButton(chunk.name + '.json', chunk.content);
        li.appendChild(btn);
        list.appendChild(li);
      });
      holder.appendChild(head);
      holder.appendChild(list);
    } else {
      head.appendChild(dom.el('span', 'tk-status tk-status-invalid', 'ERROR'));
      head.appendChild(dom.el('h3', 'tk-card-title', result.error));
      holder.appendChild(head);
    }
    results.appendChild(holder);
  });

  function runOn(items) {
    results.textContent = '';
    results.appendChild(dom.el('p', 'tk-results-title', items.length + ' file(s) — all checks ran locally'));
    items.forEach(function (item) {
      var report = core.validateJson(item.name, item.text);
      if (report.summary && report.summary.valid) {
        lastText = item.text;
        lastValue = item.name;
      }
      dom.renderReport(results, report);
      results.appendChild(actionsFor(item, report));
    });
    splitBtn.disabled = !lastText;
  }

  dom.mountSourceBox(app, {
    multiple: true,
    accept: '.json,.txt',
    allowPaste: true,
    onFiles: runOn
  });
  app.appendChild(results);
})();
