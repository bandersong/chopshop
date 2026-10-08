/* known.json against the project's published checksums, and the packages against known.json.
 * Part of the browser installer (working name "web"). SPDX-License-Identifier: GPL-3.0-or-later. Read-only. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const L = require('./lib.js');

function sums(rel) {
  const f = path.join(L.REPO, rel);
  if (!fs.existsSync(f)) return null;
  const out = {};
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^([0-9a-f]{64})\s+(\S+)/);
    if (m) out[m[2]] = m[1];
  }
  return out;
}

test('every pinned hash appears in the project file it cites', () => {
  const files = {
    'flash/SHA256SUMS': sums('flash/SHA256SUMS'),
    'flash/MKII/SHA256SUMS': sums('flash/MKII/SHA256SUMS'),
    'flash/KEYS/SHA256SUMS': sums('flash/KEYS/SHA256SUMS'),
    'stock/SHA256SUMS': sums('stock/SHA256SUMS')
  };
  const text = rel => { const f = path.join(L.REPO, rel); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''; };
  const all = [...L.known.stock.map(s => [s.sha256, s.source]), ...L.known.recipes.map(r => [r.output_sha256, r.source]),
               ...L.known.other_outputs.map(o => [o.sha256, o.what])];
  for (const [h, src] of all) {
    const file = Object.keys(files).find(f => src.startsWith(f) || src.includes(f));
    if (file && files[file]) {
      assert.ok(Object.values(files[file]).includes(h), `${h.slice(0, 16)} not in ${file}`);
    } else if (/START_HERE_KEYS\.md/.test(src)) {
      assert.ok(text('flash/KEYS/START_HERE_KEYS.md').includes(h), `${h.slice(0, 16)} not in START_HERE_KEYS.md`);
    } else {
      assert.fail(`no checkable source for ${h.slice(0, 16)} (${src})`);
    }
  }
});

test('every package is pinned, names its pinned output, and its never-write ranges match known.json', () => {
  const { index, texts } = L.loadPackages();
  for (const r of L.known.recipes) assert.ok(index.packages[r.id], `no package for ${r.id}`);
  for (const id of Object.keys(index.packages)) {
    assert.strictEqual(L.SHA.sha256hex(new TextEncoder().encode(texts[id])), index.packages[id]);
    const p = JSON.parse(texts[id]);
    const pin = L.known.recipes.find(r => r.id === id);
    assert.strictEqual(p.output.sha256, pin.output_sha256);
    const dev = L.known.devices[p.device];
    for (const r of dev.never_write) {
      assert.ok(p.never_write.some(q => q[1] === parseInt(r.start, 16) && q[2] === parseInt(r.end, 16)), `${id}: ${r.label}`);
    }
    const st = L.known.stock.find(s => s.device === p.device && s.supported);
    assert.strictEqual(p.stock.syx_sha256, st.sha256);
  }
});

test('sha256.js agrees with node crypto, and HMAC with RFC 4231 case 2', () => {
  const crypto = require('crypto');
  for (const n of [0, 1, 55, 56, 63, 64, 65, 1000, 100001]) {
    const b = crypto.randomBytes(n);
    assert.strictEqual(L.SHA.sha256hex(new Uint8Array(b)), crypto.createHash('sha256').update(b).digest('hex'));
    const a = new Uint8Array(b.subarray(0, n >> 1)), c = new Uint8Array(b.subarray(n >> 1));
    assert.strictEqual(L.SHA.sha256hex(a, c), crypto.createHash('sha256').update(b).digest('hex'));
  }
  const mac = L.SHA.hex(L.SHA.hmacSha256(new TextEncoder().encode('Jefe'), new TextEncoder().encode('what do ya want for nothing?')));
  assert.strictEqual(mac, '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
});
