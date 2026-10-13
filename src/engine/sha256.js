/* sha256.js - SHA-256 (FIPS 180-4) and HMAC-SHA256 (RFC 2104), plain JavaScript.
 *
 * Part of Chopshop, the browser installer. Copyright (C) 2026 bandersong.
 * SPDX-FileCopyrightText: 2026 Bandersong. SPDX-License-Identifier: GPL-3.0-or-later.
 *
 * Written from the specifications. Used instead of crypto.subtle so the engine
 * behaves the same from file://, in a worker, and in node.
 */
(function (root) {
  'use strict';
  var K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);

  function blocks(H, W, b, off) {
    for (var t = 0; t < 16; t++) {
      var j = off + t * 4;
      W[t] = (b[j] << 24) | (b[j + 1] << 16) | (b[j + 2] << 8) | b[j + 3];
    }
    for (t = 16; t < 64; t++) {
      var x = W[t - 15], y = W[t - 2];
      var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
    }
    var a = H[0], bb = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (t = 0; t < 64; t++) {
      var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      var ch = (e & f) ^ (~e & g);
      var T1 = (h + S1 + ch + K[t] + W[t]) | 0;
      var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      var maj = (a & bb) ^ (a & c) ^ (bb & c);
      var T2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + T1) | 0; d = c; c = bb; bb = a; a = (T1 + T2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + bb) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }

  /* sha256(parts...) - each part a Uint8Array; returns the 32-byte digest. */
  function sha256() {
    var H = new Int32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                            0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    var W = new Int32Array(64);
    var buf = new Uint8Array(64), fill = 0, total = 0;
    for (var p = 0; p < arguments.length; p++) {
      var m = arguments[p], i = 0, n = m.length;
      total += n;
      if (fill) {
        while (i < n && fill < 64) buf[fill++] = m[i++];
        if (fill === 64) { blocks(H, W, buf, 0); fill = 0; }
      }
      for (; i + 64 <= n; i += 64) blocks(H, W, m, i);
      while (i < n) buf[fill++] = m[i++];
    }
    buf[fill++] = 0x80;
    if (fill > 56) { while (fill < 64) buf[fill++] = 0; blocks(H, W, buf, 0); fill = 0; }
    while (fill < 56) buf[fill++] = 0;
    var bits = total * 8;
    var hi = Math.floor(bits / 0x100000000), lo = bits >>> 0;
    buf[56] = hi >>> 24; buf[57] = hi >>> 16; buf[58] = hi >>> 8; buf[59] = hi;
    buf[60] = lo >>> 24; buf[61] = lo >>> 16; buf[62] = lo >>> 8; buf[63] = lo;
    blocks(H, W, buf, 0);
    var out = new Uint8Array(32);
    for (var k = 0; k < 8; k++) {
      out[k * 4] = H[k] >>> 24; out[k * 4 + 1] = H[k] >>> 16;
      out[k * 4 + 2] = H[k] >>> 8; out[k * 4 + 3] = H[k];
    }
    return out;
  }

  function hex(b) {
    var s = '';
    for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return s;
  }

  function sha256hex() { return hex(sha256.apply(null, arguments)); }

  function hmacSha256(key, msg) {
    if (key.length > 64) key = sha256(key);
    var ipad = new Uint8Array(64), opad = new Uint8Array(64);
    for (var i = 0; i < 64; i++) {
      var k = i < key.length ? key[i] : 0;
      ipad[i] = k ^ 0x36; opad[i] = k ^ 0x5c;
    }
    return sha256(opad, sha256(ipad, msg));
  }

  var api = { sha256: sha256, sha256hex: sha256hex, hmacSha256: hmacSha256, hex: hex };
  root.RytmSha256 = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
