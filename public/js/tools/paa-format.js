/*
 * DayZ Toolkit — PAA texture + PBO archive format logic.
 *
 * Pure, dependency-free, browser-safe (no DOM, no fetch). UMD: in Node it
 * exports via module.exports (used by scripts/paa-format-test.js); in the
 * browser it sets globalThis.DayZPaaFormat.
 *
 * Verified 2026-10-15 against the real DayZ 1.30 Nasadara map (9,844 .paa,
 * 24 uncompressed PBOs) and the grad_aff C++ reference layout:
 *
 *   PAA: u16 magic (0xFF01 DXT1 | 0xFF05 DXT5 | 0x4444 | 0x1555 | 0x8888 |
 *        0x8080 …); taggs repeated until a 0x00 byte (8s signature + u32
 *        length + data: GGATCGVA avg color, GGATCXAM FF*4, GGATGALF
 *        transparency, GGATZIWS engine tag, GGATSFFO 16xu32 per-mip offsets);
 *        u16 palette length (0 in practice); mips repeated until u16==0:
 *        u16 width (bit15 = LZO1x flag, mask 0x7FFF) + u16 height +
 *        ArmaUShort length (3 bytes LE) + data.
 *
 *   PBO: datablocks until empty name (name + u32 packing + u32 orig_size +
 *        u32 reserved + u32 timestamp + u32 data_size); then sequential
 *        file data; 21-byte trailer (0x00 + sha1). 1.30 quirk: orig_size is
 *        0 in entry datablocks — data_size carries the real length.
 *        LZMA packing (0x5041584C) is detected but NOT decompressed in the
 *        browser (message tells the user to use the pbo-viewer CLI).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    (root || (root = window)).DayZPaaFormat = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var PAA_MAGIC = {
    0xFF01: 'DXT1',
    0xFF02: 'DXT2',
    0xFF03: 'DXT3',
    0xFF04: 'DXT4',
    0xFF05: 'DXT5',
    0x4444: 'RGBA4444',
    0x1555: 'RGBA5551',
    0x8888: 'RGBA8888',
    0x8080: 'GRAYwAlpha'
  };
  var PBO_PACK_NONE = 0x00000000;
  var PBO_PACK_LZMA = 0x5041584C; // 'LXAP'

  function issue(severity, message, code) {
    return { severity: severity, message: message, code: code || null };
  }

  /* ------------------------------------------------------------------ *
   * PAA                                                                 *
   * ------------------------------------------------------------------ */

  /**
   * parsePaaHeader(bytes) ->
   *   { ok, magic, format, width, height, topMip, mips: [{width,height,
   *     dataLength,lzo,offset}], taggs: [{sig,length}], avgAlpha,
   *     issues: [{severity,message,code}], filesize }
   * bytes: Uint8Array (the whole file).
   */
  function parsePaaHeader(bytes) {
    var d = bytes;
    var out = {
      ok: false, magic: null, format: null, width: 0, height: 0,
      topMip: null, mips: [], taggs: [], avgAlpha: null, issues: [],
      filesize: d ? d.length : 0
    };
    if (!d || d.length < 8) {
      out.issues.push(issue('error', 'file too small to be a PAA (' + out.filesize + ' bytes)', 'paa-too-short'));
      return out;
    }
    var dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    var magic = dv.getUint16(0, true);
    out.magic = magic;
    var format = PAA_MAGIC[magic];
    if (!format) {
      out.issues.push(issue('error', 'unrecognized PAA magic 0x' + magic.toString(16) +
        ' (expected DXT1 0xFF01, DXT5 0xFF05, or one of the legacy uncompressed formats)', 'paa-bad-magic'));
      return out;
    }
    out.format = format;

    var off = 2;
    var taggs = out.taggs;
    while (off < d.length && d[off] !== 0) {
      if (off + 12 > d.length) {
        out.issues.push(issue('error', 'truncated tagg header at offset ' + off, 'paa-trunc'));
        return out;
      }
      var sig = String.fromCharCode(d[off], d[off + 1], d[off + 2], d[off + 3],
        d[off + 4], d[off + 5], d[off + 6], d[off + 7]);
      var ln = dv.getUint32(off + 8, true);
      if (ln > d.length - off - 12) {
        out.issues.push(issue('error', 'tagg ' + sig + ' declares ' + ln +
          ' bytes of data that run past the end of the file', 'paa-taggs-run'));
        return out;
      }
      taggs.push({ sig: sig, length: ln });
      if (sig === 'GGATCGVA' && ln >= 4) {
        out.avgAlpha = d[off + 12 + 3];
      }
      off += 12 + ln;
    }
    if (off >= d.length) {
      out.issues.push(issue('error', 'no mip table found (header truncated before it)', 'paa-trunc'));
      return out;
    }
    off += 2; // u16 palette length (0 in practice)

    var mips = out.mips;
    var i;
    for (i = 0; off + 7 <= d.length; i++) {
      var wr = dv.getUint16(off, true);
      if (wr === 0) break;
      var lzo = (wr & 0x8000) !== 0;
      var w = wr & 0x7FFF;
      var h = dv.getUint16(off + 2, true);
      var len = d[off + 4] | (d[off + 5] << 8) | (d[off + 6] << 16); // ArmaUShort
      if (off + 7 + len > d.length) {
        out.issues.push(issue('error', 'mip ' + w + 'x' + h + ' declares ' + len +
          ' data bytes past the end of the file', 'paa-mip-run'));
        return out;
      }
      mips.push({ width: w, height: h, dataLength: len, lzo: lzo, offset: off + 7 });
      off += 7 + len;
    }
    if (mips.length === 0) {
      out.issues.push(issue('error', 'no mips found in PAA body', 'paa-no-mips'));
      return out;
    }
    out.topMip = mips[0];
    out.width = mips[0].width;
    out.height = mips[0].height;

    // mip chain sanity: each mip halves the previous (min dimension >= 1);
    // chain should bottom out at 4x4 for BC formats.
    for (i = 1; i < mips.length; i++) {
      var prev = mips[i - 1];
      var cur = mips[i];
      var expW = Math.max(1, prev.width >> 1);
      var expH = Math.max(1, prev.height >> 1);
      if (cur.width > expW + 1 || cur.height > expH + 1) {
        out.issues.push(issue('warning', 'mip ' + i + ' is ' + cur.width + 'x' + cur.height +
          ' but expected roughly ' + expW + 'x' + expH + ' (chain does not halve)', 'paa-mip-chain'));
      }
    }
    var last = mips[mips.length - 1];
    if ((format === 'DXT1' || format === 'DXT5') && (last.width < 4 || last.height < 4)) {
      out.issues.push(issue('info', 'mip chain ends below 4x4 (' + last.width + 'x' + last.height +
        ') — unusual for BC textures', 'paa-mip-floor'));
    }

    // raw (non-LZO) BC mips must be exactly the block size: DXT1 w*h/2, DXT5 w*h
    for (i = 0; i < mips.length; i++) {
      var m = mips[i];
      if (m.lzo) continue;
      var expected = format === 'DXT1' ? (m.width * m.height) / 2
        : (format === 'DXT5' ? m.width * m.height : null);
      if (expected !== null && m.dataLength !== expected) {
        out.issues.push(issue('warning', 'mip ' + i + ' (' + m.width + 'x' + m.height + ') is ' +
          m.dataLength + ' bytes raw but ' + format + ' expects ' + expected +
          ' — likely missing LZO flag or corrupt header', 'paa-mip-size'));
      }
    }

    // GGATSFFO: 16 x u32 per-mip file offsets, first N cover the mip chain.
    for (i = 0; i < taggs.length; i++) {
      if (taggs[i].sig !== 'GGATSFFO') continue;
      if (taggs[i].length < 64) {
        out.issues.push(issue('warning', 'GGATSFFO present but only ' + taggs[i].length +
          ' bytes (expected 64)', 'paa-sffo-short'));
        continue;
      }
      // Replay the tagg walk to find the SFFO data offset.
      var tOff = 2;
      for (var j = 0; j < taggs.length; j++) {
        if (taggs[j].sig === 'GGATSFFO') break;
        tOff += 12 + taggs[j].length;
      }
      tOff += 12; // skip SFFO signature + length
      for (var k = 0; k < mips.length; k++) {
        var o = dv.getUint32(tOff + k * 4, true);
        // SFFO points at the mip record start (u16 width), i.e. 7 bytes
        // before the data bytes.
        if (o !== 0 && o !== mips[k].offset - 7 && o !== mips[k].offset) {
          out.issues.push(issue('info', 'GGATSFFO offset for mip ' + k + ' (' + o + ') does not ' +
            'match the parsed mip table (' + mips[k].offset + ')', 'paa-sffo-mismatch'));
          break;
        }
      }
    }

    out.ok = out.issues.every(function (x) { return x.severity !== 'error'; });
    return out;
  }

  /* ------------------------------------------------------------------ *
   * PBO (uncompressed entries only; LZMA detected, not decompressed)    *
   * ------------------------------------------------------------------ */

  /**
   * parsePboHeader(bytes) ->
   *   { ok, entries: [{name, packing, packingName, origSize, timestamp,
   *     dataSize, offset}], hasLzma, paaEntries, issues, filesize }
   * Works on the full PBO bytes (header + data + trailer).
   */
  function parsePboHeader(bytes) {
    var d = bytes;
    var out = { ok: false, entries: [], hasLzma: false, paaEntries: [], issues: [], filesize: d ? d.length : 0 };
    if (!d || d.length < 24) {
      out.issues.push(issue('error', 'file too small to be a PBO', 'pbo-too-short'));
      return out;
    }
    var dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
    var pos = 0;
    function readCstr() {
      var end = pos;
      while (end < d.length && d[end] !== 0) end++;
      if (end >= d.length) return null;
      var s = '';
      for (var i = pos; i < end; i++) s += String.fromCharCode(d[i]);
      pos = end + 1;
      return s;
    }
    // signature datablock
    var sigName = readCstr();
    if (sigName === null) {
      out.issues.push(issue('error', 'unterminated signature string — not a PBO', 'pbo-trunc'));
      return out;
    }
    if (pos + 20 > d.length) {
      out.issues.push(issue('error', 'truncated signature datablock', 'pbo-trunc'));
      return out;
    }
    var sig = dv.getUint32(pos, true);
    var isPrefix = sig === 0x56657273; // 'sreV'
    var isProduct = sig === 0x43707273 || sig === 0; // 'srpC' / nosig
    if (!isPrefix && !isProduct) {
      out.issues.push(issue('error', 'unknown PBO signature 0x' + sig.toString(16), 'pbo-bad-sig'));
      return out;
    }
    pos += 20;
    if (isPrefix) {
      for (;;) {
        var pn = readCstr();
        if (pn === null) break;
        if (pn === '') break;
        var pv = readCstr();
        if (pv === null) break;
      }
    }
    var entries = out.entries;
    for (;;) {
      var name = readCstr();
      if (name === null) {
        out.issues.push(issue('error', 'unterminated entry name — PBO truncated', 'pbo-trunc'));
        return out;
      }
      if (name === '') {
        // terminator datablock: name + 5x u32 (same shape as entries)
        if (pos + 20 > d.length) {
          out.issues.push(issue('warning', 'terminator datablock missing its 20 metadata bytes', 'pbo-trunc'));
        } else {
          pos += 20;
        }
        break;
      }
      if (pos + 20 > d.length) {
        out.issues.push(issue('error', 'truncated datablock for entry ' + name, 'pbo-trunc'));
        return out;
      }
      var packing = dv.getUint32(pos, true);
      var origSize = dv.getInt32(pos + 4, true);
      var timestamp = dv.getInt32(pos + 12, true);
      var dataSize = dv.getInt32(pos + 16, true);
      pos += 20;
      if (dataSize < 0 || origSize < 0) {
        out.issues.push(issue('error', 'entry ' + name + ' has a negative size', 'pbo-neg-size'));
        return out;
      }
      var entry = {
        name: name,
        packing: packing,
        packingName: packing === PBO_PACK_LZMA ? 'LZMA' : (packing === PBO_PACK_NONE ? 'uncompressed' : '0x' + packing.toString(16)),
        origSize: origSize,
        timestamp: timestamp,
        dataSize: dataSize,
        offset: 0
      };
      if (packing === PBO_PACK_LZMA) out.hasLzma = true;
      entries.push(entry);
    }
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      e.offset = pos;
      if (e.offset + e.dataSize > d.length) {
        out.issues.push(issue('error', 'entry ' + e.name + ' data runs past the end of the file', 'pbo-run'));
        return out;
      }
      pos += e.dataSize;
    }
    if (d.length >= 21 && d[d.length - 21] === 0) {
      // sha1 trailer present (not verified in-browser)
    }
    for (i = 0; i < entries.length; i++) {
      // PBO entry paths use backslash separators (data\\name.paa)
      if (entries[i].name.toLowerCase().slice(-4) === '.paa') out.paaEntries.push(entries[i]);
    }
    out.ok = out.issues.every(function (x) { return x.severity !== 'error'; });
    return out;
  }

  /**
   * pboEntryBytes(pbo, entry) -> Uint8Array (uncompressed entries only).
   * Throws for LZMA entries — the browser does not decompress them.
   */
  function pboEntryBytes(pbo, entry) {
    if (entry.packing === PBO_PACK_LZMA) {
      throw new Error('LZMA-compressed PBO entry: the in-browser tool does not decompress — use the pbo-viewer CLI');
    }
    var d = new Uint8Array(pbo.buffer, pbo.byteOffset, pbo.byteLength);
    return d.subarray(entry.offset, entry.offset + entry.dataSize);
  }

  return {
    PAA_MAGIC: PAA_MAGIC,
    PBO_PACK_NONE: PBO_PACK_NONE,
    PBO_PACK_LZMA: PBO_PACK_LZMA,
    parsePaaHeader: parsePaaHeader,
    parsePboHeader: parsePboHeader,
    pboEntryBytes: pboEntryBytes
  };
});
