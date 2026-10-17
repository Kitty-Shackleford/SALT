/*
 * DayZ Toolkit — PAA / PBO ↔ PNG map-tile converter.
 *
 * 100% client-side, fully offline: files never leave the browser. Pipeline:
 *   .paa  -> DayZPaaFormat.parsePaaHeader (lint) -> grad_aff WASM decode
 *           -> PNG (canvas) -> download / zip
 *   .pbo  -> DayZPaaFormat.parsePboHeader (lint, uncompressed entries only)
 *           -> per-entry PAA pipeline
 *   .png  -> createImageBitmap -> grad_aff WASM encode (DXT1/DXT5 auto)
 *           -> PAA download / zip
 *
 * WASM: embedded as base64 in paa-wasm-asset.js (group-adler/grad_aff,
 * Apache-2.0) so the tool obeys the toolkit security contract (no
 * network calls, no dynamic code, no innerHTML — see
 * scripts/toolkit-client-test.js).
 *
 * UI follows the mission-validator convention: per-file cards via
 * dom.renderReport (lint findings map 1:1), preview image, download
 * button, JSZip batch download.
 */
(function () {
  'use strict';

  var dom = globalThis.DayZToolkitDom;
  var fmt = globalThis.DayZPaaFormat;
  var asset = globalThis.DayZWasmAsset;
  var app = document.getElementById('app');

  if (!dom) {
    console.error('paa-converter: DayZToolkitDom not loaded');
    return;
  }
  if (!fmt) {
    dom.mountChrome(app, 'PAA ↔ PNG Map-Tile Converter', '');
    dom.mountError(app, 'PAA format module failed to load',
      'public/js/tools/paa-format.js missing — check the deployment');
    return;
  }

  dom.mountChrome(app, 'PAA ↔ PNG Map-Tile Converter',
    'Drop .paa tiles, a .pbo (uncompressed — e.g. DayZ 1.30 map PBOs), or .png images. ' +
    'PAA becomes validated PNG; PNG becomes PAA (DXT5 when alpha varies, else DXT1). ' +
    'Everything runs in your browser — no upload, no network.');

  /* ------------------------------------------------------------------ *
   * Limits                                                              *
   * ------------------------------------------------------------------ */
  var PAA_MAX = 32 * 1024 * 1024;       // largest single .paa accepted
  var PBO_MAX = 500 * 1024 * 1024;      // largest single .pbo accepted
  var PAA_PER_PBO = 300;                // tiles per PBO (worlds_data holds ~5.5k)
  var BATCH_BYTES = 512 * 1024 * 1024;  // total input bytes per batch

  function fmtBytes(n) {
    if (!isFinite(n) || n < 0) return '?';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KiB';
    return (n / (1024 * 1024)).toFixed(1) + ' MiB';
  }

  /* ------------------------------------------------------------------ *
   * WASM (grad_aff) — import surface identical to the node harness      *
   * ------------------------------------------------------------------ */
  var aff = null;

  function loadWasm() {
    if (aff) return Promise.resolve(aff);
    if (!asset) return Promise.reject(new Error('WASM asset not loaded (paa-wasm-asset.js)'));
    var memory = new WebAssembly.Memory({ initial: 512, maximum: 32768 });
    return WebAssembly.instantiate(asset.arrayBuffer(), {
      env: {
        memory: memory,
        __sys_stat64: function () { return -1; },
        emscripten_notify_memory_growth: function () {}
      },
      wasi_snapshot_preview1: {
        fd_read: function () { return -1; },
        fd_close: function () { return -1; },
        fd_seek: function () { return -1; },
        fd_write: function () { return -1; },
        environ_sizes_get: function () { return 0; },
        environ_get: function () { return 0; },
        proc_exit: function () {}
      }
    }).then(function (result) {
      aff = { ex: result.instance.exports, memory: memory };
      return aff;
    });
  }

  function lastException() {
    try {
      return String(aff.ex.get_last_aff_exception());
    } catch (e) {
      return String(e);
    }
  }

  function decodePaa(bytes) {
    var ex = aff.ex;
    var buf = new Uint8Array(aff.memory.buffer);
    var dataPtr = ex.malloc(bytes.length);
    buf.set(bytes, dataPtr);
    var wP = ex.malloc(2), hP = ex.malloc(2), sP = ex.malloc(4);
    var outPtr = ex.decode(dataPtr, bytes.length, wP, hP, sP);
    if (!outPtr) {
      ex.free(wP); ex.free(hP); ex.free(sP); ex.free(dataPtr);
      throw new Error('decode failed: ' + lastException());
    }
    var dv = new DataView(aff.memory.buffer);
    var width = dv.getUint16(wP, true);
    var height = dv.getUint16(hP, true);
    var size = dv.getUint32(sP, true);
    if (size !== width * height * 4) {
      ex.free(outPtr);
      ex.free(wP); ex.free(hP); ex.free(sP); ex.free(dataPtr);
      throw new Error('unexpected decode size ' + size + ' for ' + width + 'x' + height);
    }
    var rgba = new Uint8Array(size);
    rgba.set(new Uint8Array(aff.memory.buffer, outPtr, size));
    ex.free(outPtr); // release the WASM-side copy (browser batches leak otherwise)
    ex.free(wP); ex.free(hP); ex.free(sP); ex.free(dataPtr);
    return { width: width, height: height, rgba: rgba };
  }

  function encodePaa(rgba, width, height) {
    var ex = aff.ex;
    var buf = new Uint8Array(aff.memory.buffer);
    var dataPtr = ex.malloc(rgba.length);
    buf.set(rgba, dataPtr);
    var sizePtr = ex.malloc(4);
    var outPtr = ex.encode(width, height, dataPtr, sizePtr);
    if (!outPtr) {
      ex.free(sizePtr); ex.free(dataPtr);
      throw new Error('encode failed: ' + lastException());
    }
    var size = new DataView(aff.memory.buffer).getUint32(sizePtr, true);
    var paa = new Uint8Array(size);
    paa.set(new Uint8Array(aff.memory.buffer, outPtr, size));
    var ok = ex.free_encoded_data(outPtr);
    if (!ok) throw new Error('free_encoded_data failed');
    ex.free(sizePtr); ex.free(dataPtr);
    return paa;
  }

  /* ------------------------------------------------------------------ *
   * PNG <-> bitmap helpers                                              *
   * ------------------------------------------------------------------ */
  function pngToBitmap(file) {
    if (globalThis.createImageBitmap) return createImageBitmap(file);
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('could not decode image: ' + file.name)); };
      img.src = url;
    });
  }

  function bitmapToRgba(bitmap) {
    var width = bitmap.width;   // capture BEFORE close() — a closed ImageBitmap
    var height = bitmap.height; // reports 0 dimensions (spec: image is destroyed)
    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    var imgData = canvas.getContext('2d').getImageData(0, 0, width, height);
    if (bitmap.close) bitmap.close();
    return { width: width, height: height, rgba: imgData.data };
  }

  function rgbaToPngBlob(rgba, width, height) {
    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').putImageData(
      new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length), width, height),
      0, 0);
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (blob) resolve(blob);
        else reject(new Error('PNG encoding failed (canvas.toBlob)'));
      }, 'image/png');
    });
  }

  /* ------------------------------------------------------------------ *
   * UI (mission-validator convention: renderReport cards + summary)     *
   * ------------------------------------------------------------------ */
  dom.mountSourceBox(app, {
    title: 'Drop .paa / .pbo / .png files here',
    subtitle: 'or click to browse — batches are converted one at a time, with lint + preview per tile',
    multiple: true,
    accept: '.paa,.png,.pbo',
    binary: true,
    maxBytes: PBO_MAX,
    onFiles: function (items) {
      handleFiles(items.map(function (it) { return it.file; }));
    }
  });

  var resultsEl = dom.el('div', 'tk-results');
  app.appendChild(resultsEl);
  var statusEl = dom.el('p', 'tk-summary-line', '');
  app.appendChild(statusEl);

  var batchOutputs = [];   // { name, blob }
  var objectUrls = [];

  function setStatus(text) { statusEl.textContent = text; }

  function resetResults() {
    objectUrls.forEach(function (u) { URL.revokeObjectURL(u); });
    objectUrls = [];
    batchOutputs = [];
    resultsEl.textContent = '';
    setStatus('');
  }

  /** Render one per-file card from lint findings; returns the card. */
  function fileReport(name, status, findings, inputBytes, extraInfo) {
    var report = {
      fileName: name,
      inputBytes: inputBytes,
      summary: {
        status: status,
        errorCount: findings.filter(function (f) { return f.severity === 'error'; }).length,
        warningCount: findings.filter(function (f) { return f.severity === 'warning'; }).length
      },
      errors: findings.filter(function (f) { return f.severity === 'error'; }),
      warnings: findings.filter(function (f) { return f.severity === 'warning'; }),
      info: findings.filter(function (f) { return f.severity === 'info'; })
    };
    (extraInfo || []).forEach(function (m) { report.info.push({ severity: 'info', message: m }); });
    return dom.renderReport(resultsEl, report);
  }

  /** Append a late-arriving info line to a rendered card (post-render facts). */
  function addInfoLine(card, message) {
    var list = card.querySelector('ul');
    if (!list) return;
    list.appendChild(dom.el('li', 'tk-finding tk-finding-info', message));
  }

  function addPreview(card, url) {
    var img = document.createElement('img');
    img.src = url;
    img.style.maxWidth = '240px';
    img.style.maxHeight = '160px';
    img.style.margin = '6px 0 0 14px';
    card.appendChild(img);
  }

  function addDownloadRow(card, blob, filename) {
    var row = dom.el('div', 'tk-actions');
    row.style.padding = '0 14px 12px';
    var btn = dom.el('button', 'tk-btn', 'Download ' + filename);
    btn.type = 'button';
    btn.addEventListener('click', function () { downloadBlob(blob, filename); });
    row.appendChild(btn);
    card.appendChild(row);
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
  }

  function lintDetail(h) {
    var parts = [h.format + ' ' + h.width + '×' + h.height +
      ', ' + h.mips.length + ' mips' +
      (h.mips.some(function (m) { return m.lzo; }) ? ' (LZO)' : '')];
    if (h.avgAlpha !== null) parts.push('avg alpha ' + h.avgAlpha);
    return 'Lint: ' + parts.join(' · ');
  }

  function baseName(path) {
    var p = String(path).replace(/\\/g, '/');
    return p.split('/').pop();
  }

  function uniqueName(name, taken) {
    if (!taken.has(name)) { taken.add(name); return name; }
    var dot = name.lastIndexOf('.');
    var stem = dot > 0 ? name.slice(0, dot) : name;
    var ext = dot > 0 ? name.slice(dot) : '';
    var i = 2;
    while (taken.has(stem + '_' + i + ext)) i++;
    var out = stem + '_' + i + ext;
    taken.add(out);
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Pipeline                                                            *
   * ------------------------------------------------------------------ */

  function emitPng(card, outName, decoded, t0) {
    return rgbaToPngBlob(decoded.rgba, decoded.width, decoded.height)
      .then(function (blob) {
        var url = URL.createObjectURL(blob);
        objectUrls.push(url);
        addPreview(card, url);
        addDownloadRow(card, blob, outName);
        batchOutputs.push({ name: outName, blob: blob });
        addInfoLine(card, 'PNG ' + decoded.width + '×' + decoded.height +
          ' · ' + fmtBytes(blob.size) + ' · ' + (Date.now() - t0) + ' ms');
      });
  }

  function convertPaaFile(file, outName) {
    var t0 = Date.now();
    return file.arrayBuffer().then(function (buf) {
      var bytes = new Uint8Array(buf);
      if (bytes.length > PAA_MAX) {
        fileReport(file.name, 'invalid',
          [{ severity: 'error', message: 'file is ' + fmtBytes(bytes.length) +
            ' — above the ' + fmtBytes(PAA_MAX) + ' per-file cap' }],
          file.size);
        return 0;
      }
      var h = fmt.parsePaaHeader(bytes);
      var card = fileReport(file.name, h.ok ? 'excellent' : 'invalid', h.issues, file.size,
        h.ok ? [lintDetail(h) + ' — converting…'] : null);
      if (!h.ok) return 0;
      return emitPng(card, outName, decodePaa(bytes), t0).then(function () { return 1; });
    });
  }

  function convertPboFile(file, taken) {
    var t0 = Date.now();
    return file.arrayBuffer().then(function (buf) {
      var bytes = new Uint8Array(buf);
      if (bytes.length > PBO_MAX) {
        fileReport(file.name, 'invalid',
          [{ severity: 'error', message: 'PBO is ' + fmtBytes(bytes.length) +
            ' — above the ' + fmtBytes(PBO_MAX) + ' cap (use the pbo-viewer CLI for bigger splits)' }],
          file.size);
        return 0;
      }
      var pbo = fmt.parsePboHeader(bytes);
      var extra = ['uncompressed PBO · ' + pbo.entries.length + ' entries · ' +
        pbo.paaEntries.length + ' .paa'];
      if (pbo.hasLzma) {
        extra.push('contains LZMA entries — skipped (the in-browser tool does not decompress; use the pbo-viewer CLI)');
      }
      var card = fileReport(file.name, pbo.ok ? 'excellent' : 'invalid', pbo.issues, file.size,
        pbo.ok ? extra : null);
      if (!pbo.ok) return 0;
      var entries = pbo.paaEntries;
      if (!entries.length) {
        addInfoLine(card, 'no .paa entries inside — nothing to convert');
        return 0;
      }
      var picked = entries.slice(0, PAA_PER_PBO);
      if (picked.length < entries.length) {
        addInfoLine(card, 'converting first ' + PAA_PER_PBO + ' of ' + entries.length +
          ' .paa entries — re-run with a narrower PBO for the rest');
      }
      var stem = file.name.replace(/\.pbo$/i, '');
      var made = 0;
      var chain = Promise.resolve();
      picked.forEach(function (e) {
        chain = chain.then(function () {
          setStatus('Converting ' + file.name + ': ' + baseName(e.name) +
            ' (' + (made + 1) + '/' + picked.length + ')');
          var paaBytes = fmt.pboEntryBytes(bytes, e);
          var h = fmt.parsePaaHeader(paaBytes);
          var sub = fileReport(baseName(e.name), h.ok ? 'excellent' : 'invalid',
            h.issues, paaBytes.length, h.ok ? [lintDetail(h)] : null);
          if (!h.ok) return;
          var outName = uniqueName(stem + '/' + baseName(e.name).replace(/\.paa$/i, '') + '.png', taken);
          return emitPng(sub, outName, decodePaa(paaBytes), t0).then(function () { made++; });
        });
      });
      return chain.then(function () { return made; });
    });
  }

  function convertPngFile(file, taken) {
    var t0 = Date.now();
    return pngToBitmap(file).then(function (bitmap) {
      var rgba = bitmapToRgba(bitmap);
      var paaBytes = encodePaa(rgba.rgba, rgba.width, rgba.height);
      var h = fmt.parsePaaHeader(paaBytes); // verify encoder output via our own lint
      var card = fileReport(file.name, h.ok ? 'excellent' : 'invalid',
        h.issues, file.size, h.ok
          ? ['PNG ' + rgba.width + '×' + rgba.height + ' → PAA ' + h.format +
            ' (' + h.mips.length + ' mips) · ' + fmtBytes(paaBytes.length) +
            ' · ' + (Date.now() - t0) + ' ms']
          : null);
      if (!h.ok) return 0;
      var outName = uniqueName(file.name.replace(/\.png$/i, '') + '.paa', taken);
      var blob = new Blob([paaBytes], { type: 'application/octet-stream' });
      addDownloadRow(card, blob, outName);
      batchOutputs.push({ name: outName, blob: blob });
      return 1;
    });
  }

  function handleFiles(files) {
    if (!files.length) return;
    resetResults();
    var total = files.reduce(function (s, f) { return s + f.size; }, 0);
    if (total > BATCH_BYTES) {
      setStatus('Batch is ' + fmtBytes(total) + ' — over the ' +
        fmtBytes(BATCH_BYTES) + ' budget. Split the drop.');
      resultsEl.appendChild(dom.el('p', 'tk-err',
        'Batch exceeds the ' + (BATCH_BYTES / 1048576) + ' MiB budget — drop fewer files.'));
      return;
    }
    var taken = new Set();
    setStatus('Loading converter (WASM)…');
    loadWasm().catch(function (err) {
      setStatus('WASM failed to load: ' + err.message);
      resultsEl.appendChild(dom.el('p', 'tk-err', 'WASM failed to load: ' + err.message));
    }).then(function (a) {
      if (!a) return;
      var t0 = Date.now();
      var failCount = 0;
      var chain = Promise.resolve();
      files.forEach(function (f) {
        chain = chain.then(function () {
          var lower = f.name.toLowerCase();
          var job;
          if (lower.endsWith('.paa')) {
            job = convertPaaFile(f, uniqueName(f.name.replace(/\.paa$/i, '') + '.png', taken));
          } else if (lower.endsWith('.pbo')) {
            job = convertPboFile(f, taken);
          } else if (lower.endsWith('.png')) {
            job = convertPngFile(f, taken);
          } else {
            fileReport(f.name, 'invalid',
              [{ severity: 'error', message: 'unsupported extension — only .paa, .pbo and .png' }],
              f.size);
            return Promise.resolve(0);
          }
          return job.catch(function (err) {
            failCount += 1;
            resultsEl.appendChild(dom.el('p', 'tk-err', f.name + ': ' + err.message));
            return 0;
          });
        });
      });
      chain.then(function () {
        var dt = ((Date.now() - t0) / 1000).toFixed(1);
        var outputs = batchOutputs.length;
        var summary = 'Done in ' + dt + ' s — ' + outputs + ' output(s)' +
          (failCount ? ', ' + failCount + ' failed' : '') +
          ' · all processing stayed in this tab.';
        if (outputs > 1) {
          var row = dom.el('div', 'tk-actions');
          row.style.marginTop = '12px';
          var zbtn = dom.el('button', 'tk-btn', 'Download all as .zip (' + outputs + ')');
          zbtn.type = 'button';
          zbtn.addEventListener('click', function () { downloadZip(zbtn); });
          row.appendChild(zbtn);
          app.appendChild(row);
        }
        setStatus(summary);
      });
    });
  }

  function downloadZip(btn) {
    var JZ = globalThis.JSZip;
    if (!JZ) {
      setStatus('JSZip failed to load — download the files individually.');
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Building zip…';
    var zip = new JZ();
    var names = new Set();
    batchOutputs.forEach(function (o) { zip.file(uniqueName(o.name, names), o.blob); });
    zip.generateAsync({ type: 'blob' })
      .then(function (blob) {
        downloadBlob(blob, 'dayz-tiles-' + new Date().toISOString().replace(/[:T]/g, '-') + '.zip');
        btn.textContent = 'Zip downloaded';
      })
      .catch(function (err) {
        setStatus('Zip failed: ' + err.message);
        btn.disabled = false;
        btn.textContent = 'Download all as .zip (' + batchOutputs.length + ')';
      });
  }
})();
