#!/usr/bin/env node
'use strict';
/*
 * Regenerates public/js/tools/paa-wasm-asset.js from the grad_aff WASM.
 *
 * The asset is base64-embedded because the toolkit security contract
 * (scripts/toolkit-client-test.js) forbids network calls (fetch/XHR) in
 * toolkit scripts — the converter must work fully offline, same origin.
 *
 * Usage: node scripts/paa-wasm-asset-build.js [path-to-grad_aff_paa.wasm]
 *   Default source: the copy vendored in this repo
 *   (public/vendor/grad-aff/grad_aff_paa.wasm); pass an explicit path to
 *   rebuild from the upstream paa.gruppe-adler.de repo instead.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const src = process.argv[2] || path.join(ROOT, 'public', 'vendor', 'grad-aff', 'grad_aff_paa.wasm');
const out = path.join(ROOT, 'public', 'js', 'tools', 'paa-wasm-asset.js');

const bytes = fs.readFileSync(src);
// WASM header: magic \0asm at 0, version 1 at 4 (both little-endian u32).
if (bytes.length < 8 || bytes.readUInt32LE(0) !== 0x6d736100 || bytes.readUInt32LE(4) !== 0x00000001) {
  throw new Error('source is not a WebAssembly module: ' + src);
}
const b64 = bytes.toString('base64');
const sha = crypto.createHash('sha256').update(bytes).digest('hex');

// wrap base64 into an array of strings to keep generated lines short
const chunks = [];
for (let i = 0; i < b64.length; i += 120) chunks.push('    ' + JSON.stringify(b64.slice(i, i + 120)));

const body = `/*
 * grad_aff PAA<->RGBA WASM bytes, base64-embedded (generated file).
 *
 * Source: group-adler/grad_aff (Apache-2.0), wasm asset from the
 * paa.gruppe-adler.de PWA repository. sha256 pinned below —
 * scripts/toolkit-client-test.js verifies it.
 * Regenerate: node scripts/paa-wasm-asset-build.js
 *
 * This file must NOT be hand-edited.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  (root || (root = window)).DayZWasmAsset = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var B64 = [
${chunks.join(',\n')}
  ].join('');
  return {
    sha256: 'sha256-${sha}',
    sizeBytes: ${bytes.length},
    arrayBuffer: function () {
      var raw = atob(B64);
      var bytes = new Uint8Array(raw.length);
      for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      var buf = new ArrayBuffer(bytes.length);
      new Uint8Array(buf).set(bytes);
      return buf;
    }
  };
});
`;
fs.writeFileSync(out, body);
console.log('wrote', out, '(' + body.length + ' bytes)');
console.log('wasm sha256:', sha);
console.log('wasm size:', bytes.length);
