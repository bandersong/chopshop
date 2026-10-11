/* zip.js - read the .syx out of a .zip (Elektron ships OS updates as *_dist.zip).
 *
 * Part of Chopshop, the browser installer. Copyright (C) 2026 bandersong.
 * SPDX-FileCopyrightText: 2026 Jesus Triana. SPDX-License-Identifier: GPL-3.0-or-later.
 *
 * Written from PKWARE's APPNOTE (end-of-central-directory record, central directory,
 * local headers). Stored (method 0) and deflate (method 8) entries; deflate is
 * undone by the platform's DecompressionStream("deflate-raw") (browsers, node 18+).
 * Every entry is checked against its CRC-32.
 */
(function (root) {
  'use strict';

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  var CRC = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(b) {
    var c = 0xffffffff;
    for (var i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function isZip(b) {
    return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
  }

  async function inflateRaw(data) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('this browser cannot unpack .zip files; unzip it yourself and drop the .syx');
    }
    var ds = new DecompressionStream('deflate-raw');
    var stream = new Blob([data]).stream().pipeThrough(ds);
    var buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  /* List the entries: [{name, method, csize, size, crc, offset}]. Throws on a
   * malformed archive. */
  function listEntries(b) {
    var eocd = -1;
    for (var i = b.length - 22; i >= 0 && i >= b.length - 22 - 65535; i--) {
      if (u32(b, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a readable .zip (no end-of-directory record)');
    var count = u16(b, eocd + 10), cdOff = u32(b, eocd + 16);
    if (cdOff === 0xffffffff || count === 0xffff) throw new Error('ZIP64 archives are not supported');
    var out = [], p = cdOff;
    for (var e = 0; e < count; e++) {
      if (p + 46 > b.length || u32(b, p) !== 0x02014b50) throw new Error('damaged .zip directory');
      var flags = u16(b, p + 8), method = u16(b, p + 10);
      var crc = u32(b, p + 16), csize = u32(b, p + 20), size = u32(b, p + 24);
      var nlen = u16(b, p + 28), xlen = u16(b, p + 30), clen = u16(b, p + 32);
      var lho = u32(b, p + 42);
      var name = '';
      for (var k = 0; k < nlen; k++) name += String.fromCharCode(b[p + 46 + k]);
      out.push({ name: name, method: method, flags: flags, csize: csize, size: size, crc: crc, offset: lho });
      p += 46 + nlen + xlen + clen;
    }
    return out;
  }

  async function readEntry(b, ent) {
    var p = ent.offset;
    if (p + 30 > b.length || u32(b, p) !== 0x04034b50) throw new Error('damaged .zip entry ' + ent.name);
    if (ent.flags & 1) throw new Error(ent.name + ' is encrypted');
    var start = p + 30 + u16(b, p + 26) + u16(b, p + 28);
    var raw = b.subarray(start, start + ent.csize);
    var data;
    if (ent.method === 0) data = raw.slice();
    else if (ent.method === 8) data = await inflateRaw(raw);
    else throw new Error(ent.name + ' uses an unsupported compression method (' + ent.method + ')');
    if (data.length !== ent.size || crc32(data) !== ent.crc) throw new Error(ent.name + ' is damaged (CRC mismatch)');
    return data;
  }

  /* Every .syx in the archive (macOS resource forks skipped): [{name, data}]. */
  async function syxEntries(b) {
    var list = listEntries(b).filter(function (e) {
      return /\.syx$/i.test(e.name) && !/(^|\/)__MACOSX\//.test(e.name) && !/(^|\/)\._/.test(e.name);
    });
    var out = [];
    for (var i = 0; i < list.length; i++) out.push({ name: list[i].name, data: await readEntry(b, list[i]) });
    return out;
  }

  var api = { isZip: isZip, listEntries: listEntries, readEntry: readEntry, syxEntries: syxEntries, crc32: crc32 };
  root.RytmZip = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
