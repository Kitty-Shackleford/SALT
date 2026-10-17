#!/usr/bin/env node
/*
 * paa-format-test.js — verify the browser format logic against REAL DayZ 1.30
 * Nasadara map files (same inputs the browser tool will see).
 *
 * Run: node scripts/paa-format-test.js [PAA_DIR] [PBO_DIR]
 *   No args: synthetic self-contained fixtures (CI-safe).
 *   With args: also exercises the parsers against real DayZ content
 *   (a tree of .paa files, and a directory of map .pbo files).
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const paa = require('../public/js/tools/paa-format.js');

let pass = 0;
function ok(cond, label) {
  assert.ok(cond, label);
  pass++;
  console.log('  ok - ' + label);
}

/* ------------------------------------------------------------------ *
 * Synthetic PAA (DXT5 4x4, no taggs, single mip, no LZO)             *
 * ------------------------------------------------------------------ */
function synthPaa() {
  // magic FF05 (LE: 05 FF); no taggs (0x00); palette u16 0;
  // mip: width 4 (no LZO bit) height 4; ArmaUShort len = 16 (DXT5 4x4 = 4*4*1)
  // data 16 bytes; trailer 00 00.
  const b = new Uint8Array([
    0x05, 0xFF, 0x00, 0x00, // magic + tagg terminator + palette len
    0x04, 0x00, 0x04, 0x00, // width=4 height=4
    0x10, 0x00, 0x00, // ArmaUShort 16
    ...Array(16).fill(0xAB), // DXT5 data
    0x00, 0x00 // u16 end marker
  ]);
  return b;
}

function testSyntheticPaa() {
  console.log('synthetic PAA (DXT5 4x4):');
  const r = paa.parsePaaHeader(synthPaa());
  ok(r.ok, 'parses ok');
  ok(r.format === 'DXT5', 'format DXT5');
  ok(r.width === 4 && r.height === 4, 'dims 4x4');
  ok(r.mips.length === 1, 'one mip');
  ok(r.mips[0].lzo === false, 'no LZO flag');
  ok(r.issues.length === 0, 'no issues: ' + JSON.stringify(r.issues));

  const bad = synthPaa();
  bad[0] = 0x99; bad[1] = 0x99;
  const rb = paa.parsePaaHeader(bad);
  ok(!rb.ok, 'bad magic rejected');
  ok(rb.issues[0].code === 'paa-bad-magic', 'paa-bad-magic code');
}

/* ------------------------------------------------------------------ *
 * Synthetic PBO (uncompressed, 2 entries)                             *
 * ------------------------------------------------------------------ */
function synthPbo() {
  // datablock: name \0 + u32 packing + u32 orig + u32 reserved + u32 ts + u32 dsize
  function db(name, packing, dsize, body) {
    const nameB = Buffer.from(name + '\0', 'ascii');
    const meta = Buffer.alloc(20);
    meta.writeUInt32LE(packing, 0);
    meta.writeInt32LE(dsize, 4); // orig
    meta.writeInt32LE(0, 8);
    meta.writeInt32LE(1000, 12);
    meta.writeInt32LE(dsize, 16);
    return { nameB, meta, body };
  }
  const sig = db('', 0x43707273, 0, Buffer.alloc(0));
  const e1 = db('data/a.paa', 0, 2, Buffer.from([1, 2]));
  const e2 = db('data/b.txt', 0, 3, Buffer.from([3, 4, 5]));
  const term = db('', 0, 0, Buffer.alloc(0));
  const body = Buffer.concat([e1.body, e2.body]);
  const out = Buffer.concat([
    sig.nameB, sig.meta,
    e1.nameB, e1.meta,
    e2.nameB, e2.meta,
    term.nameB, term.meta,
    body
  ]);
  return new Uint8Array(out);
}

function testSyntheticPbo() {
  console.log('synthetic PBO (2 uncompressed entries):');
  const r = paa.parsePboHeader(synthPbo());
  ok(r.ok, 'parses ok: ' + JSON.stringify(r.issues));
  ok(r.entries.length === 2, 'two entries');
  ok(r.entries[0].name === 'data/a.paa', 'entry name');
  ok(r.entries[0].offset + 2 === r.entries[1].offset, 'sequential offsets');
  ok(r.paaEntries.length === 1, 'one paa entry');
  const bytes = paa.pboEntryBytes(synthPbo(), r.entries[0]);
  ok(bytes.length === 2 && bytes[0] === 1 && bytes[1] === 2, 'entry bytes read');
}

/* ------------------------------------------------------------------ *
 * Real Nasadara fixtures (when present)                               *
 * ------------------------------------------------------------------ */
function walkPaa(dir) {
  const out = [];
  (function rec(d) {
    for (const fn of fs.readdirSync(d)) {
      const p = path.join(d, fn);
      if (fs.statSync(p).isDirectory()) rec(p);
      else if (fn.toLowerCase().endsWith('.paa')) out.push(p);
    }
  })(dir);
  return out;
}

function testRealSamples(dir) {
  const files = walkPaa(dir);
  if (!files.length) {
    console.log('real samples: none present, skipping');
    return;
  }
  console.log('real Nasadara samples (' + files.length + ' files):');
  let dxt1 = 0, dxt5 = 0, lzoMips = 0;
  for (const f of files) {
    const buf = fs.readFileSync(f);
    const r = paa.parsePaaHeader(new Uint8Array(buf));
    ok(r.ok, path.relative(dir, f) + ' ok (' + r.format + ' ' + r.width + 'x' + r.height +
      ', mips=' + r.mips.length + (r.issues.length ? ', issues=' + JSON.stringify(r.issues) : ''));
    if (r.format === 'DXT1') dxt1++;
    if (r.format === 'DXT5') dxt5++;
    r.mips.forEach(m => { if (m.lzo) lzoMips++; });
    // mip chain must halve
    for (let i = 1; i < r.mips.length; i++) {
      const pw = r.mips[i - 1].width, ph = r.mips[i - 1].height;
      const cw = r.mips[i].width, ch = r.mips[i].height;
      assert.ok(cw <= Math.max(1, Math.floor((pw + 1) / 2)) + 1 && ch <= Math.max(1, Math.floor((ph + 1) / 2)) + 1,
        'mip chain ' + f);
    }
  }
  ok(dxt1 > 0 && dxt5 > 0, 'both DXT1 (' + dxt1 + ') and DXT5 (' + dxt5 + ') present');
  ok(lzoMips > 0, 'LZO mips present (' + lzoMips + ')');
}

function testRealPbo(dir) {
  if (!fs.existsSync(dir)) {
    console.log('real PBO snapshot not present, skipping');
    return;
  }
  const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.pbo'));
  if (!files.length) {
    console.log('real PBOs: none present, skipping');
    return;
  }
  // Use the smallest PBOs to keep the test quick.
  const sized = files.map(f => ({ f, s: fs.statSync(path.join(dir, f)).size }))
    .sort((a, b) => a.s - b.s);
  const picks = sized.slice(0, 3);
  console.log('real PBOs (' + picks.map(p => p.f).join(', ') + '):');
  for (const { f } of picks) {
    const buf = fs.readFileSync(path.join(dir, f));
    const r = paa.parsePboHeader(new Uint8Array(buf));
    ok(r.ok, f + ' header ok (' + r.entries.length + ' entries, ' + r.paaEntries.length + ' paa)');
    ok(!r.hasLzma, f + ' is uncompressed (1.30 quirk — no LZMA in the map)');
    // 1.30 quirk: orig_size=0 in datablocks, data_size carries the length
    ok(r.entries.every(e => e.dataSize > 0), f + ' data_size non-zero for all entries');
    // spot-extract the first paa entry and re-parse it as a PAA
    if (r.paaEntries.length) {
      const e = r.paaEntries[0];
      const paaBytes = paa.pboEntryBytes(new Uint8Array(buf), e);
      const pr = paa.parsePaaHeader(paaBytes);
      ok(pr.ok, 'spot extract ' + e.name + ' -> valid PAA (' + pr.format + ' ' + pr.width + 'x' + pr.height + ')');
    }
  }
}

testSyntheticPaa();
testSyntheticPbo();

// Real-fixture tests are optional: pass a directory of .paa / a directory of
// .pbo to exercise the parser against real DayZ content (e.g. the Nasadara
// map snapshot). No fixtures => synthetic-only (CI-safe, no game assets).
if (process.argv[2]) testRealSamples(process.argv[2]);
if (process.argv[3]) testRealPbo(process.argv[3]);

console.log('\npaa-format-test: all ' + pass + ' assertions passed');
