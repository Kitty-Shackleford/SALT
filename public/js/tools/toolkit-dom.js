/* global DOMParser, FileReader, document */
/*
 * DayZ Toolkit — browser DOM layer.
 *
 * Everything here runs in the user's browser. No fetch, no workers, no
 * eval. User data reaches the DOM only through textContent / DOM
 * construction — never innerHTML.
 *
 * Depends on: DayZToolkitCore (toolkit-core.js).
 */
(function (root) {
  'use strict';
  var core = root.DayZToolkitCore;
  if (!core) throw new Error('toolkit-core.js must load before toolkit-dom.js');

  /* ------------------------------------------------------------------ *
   * XML parsing via DOMParser (browser-only)                            *
   * ------------------------------------------------------------------ */
  function nodeToModel(el) {
    var attrs = {};
    for (var i = 0; i < el.attributes.length; i++) {
      attrs[el.attributes[i].name] = el.attributes[i].value;
    }
    var children = [];
    var text = '';
    for (var j = 0; j < el.childNodes.length; j++) {
      var child = el.childNodes[j];
      if (child.nodeType === 1) {
        children.push(nodeToModel(child));
      } else if (child.nodeType === 3 || child.nodeType === 4) {
        text += child.nodeValue;
      }
    }
    return { tag: el.tagName, attrs: attrs, children: children, text: text.trim() };
  }

  /** parser(content) -> { ok, model?, error? } for core.validateXml. */
  function makeXmlParser() {
    return function parseXml(content) {
      var doc = new DOMParser().parseFromString(content, 'application/xml');
      var err = doc.getElementsByTagName('parsererror')[0];
      if (err) {
        var message = (err.textContent || 'XML parse error').replace(/\s+/g, ' ').trim();
        // Best-effort line extraction from browser error text.
        var lineMatch = /line[^\d]*(\d+)/i.exec(message);
        var colMatch = /column[^\d]*(\d+)/i.exec(message);
        return {
          ok: false,
          error: {
            message: message,
            line: lineMatch ? parseInt(lineMatch[1], 10) : undefined,
            column: colMatch ? parseInt(colMatch[1], 10) : undefined
          }
        };
      }
      var model = nodeToModel(doc.documentElement);
      model.sourceText = content; // used by analyzeEvents for comment positions
      return { ok: true, model: model };
    };
  }

  /* ------------------------------------------------------------------ *
   * File reading (size-capped)                                          *
   * ------------------------------------------------------------------ */
  function readAsText(file) {
    return new Promise(function (resolve, reject) {
      if (file.size > core.MAX_FILE_BYTES) {
        reject(new Error(file.name + ' is ' + (file.size / 1048576).toFixed(1) + ' MiB — exceeds the ' + (core.MAX_FILE_BYTES / 1048576) + ' MiB per-file limit'));
        return;
      }
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result)); };
      reader.onerror = function () { reject(reader.error || new Error('Failed to read ' + file.name)); };
      reader.readAsText(file, 'utf-8');
    });
  }

  function readAsArrayBuffer(file) {
    return new Promise(function (resolve, reject) {
      if (file.size > 100 * 1024 * 1024) {
        reject(new Error(file.name + ' exceeds the 100 MiB archive limit'));
        return;
      }
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(reader.error || new Error('Failed to read ' + file.name)); };
      reader.readAsArrayBuffer(file);
    });
  }

  /* ------------------------------------------------------------------ *
   * DOM building helpers (XSS-safe by construction)                     *
   * ------------------------------------------------------------------ */
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  var SEVERITY_LABEL = { error: 'Error', warning: 'Warning', info: 'Info' };

  /** Render one report (from core.validateXml/validateJson/analyzeEvents/...)
   *  into a <section> card appended to `container`. */
  function renderReport(container, report) {
    var status = report.summary ? report.summary.status : 'invalid';
    var card = el('section', 'tk-card tk-' + status);
    var head = el('div', 'tk-card-head');
    head.appendChild(el('span', 'tk-status tk-status-' + status, status.toUpperCase()));
    head.appendChild(el('h3', 'tk-card-title', report.fileName || '(untitled)'));
    if (typeof report.inputBytes === 'number') {
      head.appendChild(el('span', 'tk-size', (report.inputBytes / 1024).toFixed(1) + ' KiB'));
    }
    card.appendChild(head);

    var list = el('ul', 'tk-findings');
    var order = ['errors', 'warnings', 'info'];
    order.forEach(function (kind) {
      (report[kind] || []).forEach(function (f) {
        var li = el('li', 'tk-finding tk-finding-' + (f.severity || 'info'));
        var where = '';
        if (f.line) where += 'line ' + f.line + (f.column ? ':' + f.column : '');
        if (f.element) where += (where ? ' ' : '') + '<' + f.element + '>';
        var code = f.code ? '[' + f.code + ']' : '';
        li.appendChild(el('strong', 'tk-sev', SEVERITY_LABEL[f.severity] || 'Info'));
        li.appendChild(el('span', 'tk-msg', ' ' + (where ? where + ' — ' : '') + f.message + ' ' + code));
        list.appendChild(li);
      });
    });
    if (!list.childElementCount) list.appendChild(el('li', 'tk-finding', 'No findings.'));
    card.appendChild(list);
    container.appendChild(card);
    return card;
  }

  /** Render a plain findings list (event reports, mission structure). */
  function renderSummaryLine(container, text) {
    container.appendChild(el('p', 'tk-summary-line', text));
  }

  /* ------------------------------------------------------------------ *
   * Source box: file picker + drag&drop + (optional) paste              *
   * ------------------------------------------------------------------ */
  /**
   * options: { multiple, accept, allowPaste, binary, maxBytes, onFiles(items) }
   *   items = [{ name, text, file }] (text-mode) or [{ name, file }] (binary
   *   mode — skips the utf-8 pre-read; per-file cap = maxBytes, default 1 GiB).
   */
  function mountSourceBox(mount, options) {
    // Append-only: callers may already have mounted page chrome (header,
    // controls) and results containers on `mount` — never clear it.
    var box = el('div', 'tk-sourcebox');
    var drop = el('div', 'tk-dropzone');
    drop.appendChild(el('p', '', 'Drop files here' + (options.allowPaste ? ', or paste content below' : '')));
    drop.appendChild(el('p', 'tk-drophint', 'Processed entirely in your browser — nothing is uploaded'));

    var input = document.createElement('input');
    input.type = 'file';
    input.multiple = options.multiple !== false;
    if (options.accept) input.accept = options.accept;
    input.style.display = 'none'; // hidden picker; opened via the "Choose files" button
    box.appendChild(input);
    var pickBtn = el('button', 'tk-btn', 'Choose files');
    pickBtn.type = 'button';
    pickBtn.addEventListener('click', function () { input.click(); });

    var actions = el('div', 'tk-actions');
    actions.appendChild(pickBtn);
    box.appendChild(actions);
    box.appendChild(drop);

    var pending = [];
    function refresh() {
      var line = el('p', 'tk-pending', pending.length ? pending.length + ' file(s) queued' : '');
      box.appendChild(line);
    }

    async function ingestFileList(fileList) {
      var items = [];
      var errors = [];
      var binary = options.binary === true;
      var cap = binary ? (options.maxBytes || 1024 * 1024 * 1024) : core.MAX_SCAN_BYTES;
      for (var i = 0; i < fileList.length; i++) {
        var f = fileList[i];
        if (f.size > cap) {
          errors.push(f.name + ' exceeds the ' + Math.round(cap / 1048576) + ' MiB limit');
          continue;
        }
        try {
          if (binary) {
            items.push({ name: f.name, file: f });
          } else {
            items.push({ name: f.name, text: await readAsText(f), file: f });
          }
          pending.push(f.name);
        } catch (err) {
          errors.push(err.message);
        }
      }
      errors.forEach(function (msg) {
        box.appendChild(el('p', 'tk-err', msg));
      });
      if (items.length) {
        options.onFiles(items);
        pending = [];
        refresh();
      }
    }

    input.addEventListener('change', function () {
      if (input.files && input.files.length) ingestFileList(input.files);
      input.value = '';
    });

    ['dragenter', 'dragover'].forEach(function (evt) {
      drop.addEventListener(evt, function (e) { e.preventDefault(); drop.classList.add('tk-dragging'); });
    });
    ['dragleave', 'drop'].forEach(function (evt) {
      drop.addEventListener(evt, function (e) { e.preventDefault(); drop.classList.remove('tk-dragging'); });
    });
    drop.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        ingestFileList(e.dataTransfer.files);
      }
    });

    var pasteArea = null;
    if (options.allowPaste) {
      pasteArea = document.createElement('textarea');
      pasteArea.className = 'tk-paste';
      pasteArea.placeholder = 'Paste XML/JSON content here (single document)…';
      pasteArea.spellcheck = false;
      var pasteBtn = el('button', 'tk-btn', 'Validate pasted content');
      pasteBtn.type = 'button';
      pasteBtn.addEventListener('click', function () {
        var text = pasteArea.value;
        if (!text.trim()) return;
        options.onFiles([{ name: 'pasted-document.xml', text: text }]);
      });
      var pasteRow = el('div', 'tk-paste-row');
      pasteRow.appendChild(pasteArea);
      pasteRow.appendChild(pasteBtn);
      box.appendChild(pasteRow);
    }

    mount.appendChild(box);
    return {
      box: box,
      getPaste: pasteArea ? function () { return pasteArea.value; } : null,
      clearPending: function () { pending = []; refresh(); }
    };
  }

  /* ------------------------------------------------------------------ *
   * Downloads (local only: Blob + object URL, revoked after click)      *
   * ------------------------------------------------------------------ */
  function downloadText(filename, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function makeDownloadButton(filename, getText) {
    var btn = el('button', 'tk-btn tk-btn-small', 'Download ' + filename);
    btn.type = 'button';
    btn.addEventListener('click', function () {
      var text = typeof getText === 'function' ? getText() : getText;
      if (typeof text === 'string') downloadText(filename, text);
    });
    return btn;
  }

  /* ------------------------------------------------------------------ *
   * Page scaffold: header with back link + "local only" badge           *
   * ------------------------------------------------------------------ */
  function mountChrome(rootEl, title, blurb) {
    var header = el('header', 'tk-header');
    var brand = el('a', 'tk-brand', 'DayZ Toolkit');
    brand.href = '/tools';
    header.appendChild(brand);
    header.appendChild(el('span', 'tk-local-badge', '100% in your browser — no uploads, no network'));
    rootEl.appendChild(header);
    rootEl.appendChild(el('h1', 'tk-title', title));
    if (blurb) rootEl.appendChild(el('p', 'tk-blurb', blurb));
  }

  /* ------------------------------------------------------------------ *
   * Exports                                                             *
   * ------------------------------------------------------------------ */
  root.DayZToolkitDom = {
    makeXmlParser: makeXmlParser,
    readAsText: readAsText,
    readAsArrayBuffer: readAsArrayBuffer,
    el: el,
    renderReport: renderReport,
    renderSummaryLine: renderSummaryLine,
    mountSourceBox: mountSourceBox,
    downloadText: downloadText,
    makeDownloadButton: makeDownloadButton,
    mountChrome: mountChrome
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
