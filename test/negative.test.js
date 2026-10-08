/* Everything the engine must refuse, refuses - each at the layer meant to catch it.
 * Part of the browser installer (working name "web"). SPDX-License-Identifier: GPL-3.0-or-later.
 * Read-only: every damaged file and package is made in memory. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const L = require('./lib.js');

const E = L.engine();
const mk1 = L.stockFor('mk1', '1.73');
const mk2 = L.stockFor('mk2', '1.73');
const keys = L.stockFor('keys', '1.56');
const mk1old = L.stockFor('mk1', '1.72');
const mk2old = L.stockFor('mk2', '1.72');

/* An engine whose package set differs from the shipped one. repin = also update the
 * pinned index, to reach the checks behind the package checksum. */
function engineWith(id, mutate, repin) {
  const { index, texts } = L.loadPackages();
  const pkg = JSON.parse(texts[id]);
  mutate(pkg);
  const t2 = Object.assign({}, texts, { [id]: JSON.stringify(pkg, null, 1) + '\n' });
  const i2 = JSON.parse(JSON.stringify(index));
  if (repin) i2.packages[id] = L.SHA.sha256hex(new TextEncoder().encode(t2[id]));
  return L.engine({ packageTexts: t2, packageIndex: i2 });
}

/* A minimal stored-entry .zip (APPNOTE 4.3), optionally deflated, made in memory. */
function makeZip(entries) {
  const locals = [], centrals = [];
  let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const raw = Buffer.from(e.data);
    const data = e.deflate ? zlib.deflateRawSync(raw) : raw;
    const crc = L.ZIP.crc32(new Uint8Array(raw));
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(e.deflate ? 8 : 0, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(e.deflate ? 8 : 0, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, name, data);
    centrals.push(ch, name);
    off += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

/* A 1.74-like file: the stock container with its version text set to 1.74 by the tool
 * itself (-V), so it is a well-formed OS file this installer has never seen. */
async function fakeVersion(stock, ver) {
  const r = await L.EFT.run(L.createEFT, ['-i', '/in/s.syx', '-V', ver, '-o', '/w/v.syx'],
                            { '/in/s.syx': stock }, { mkdirs: ['/w'], readFiles: ['/w/v.syx'] });
  assert.strictEqual(r.rc, 0, r.out.join('\n'));
  return r.files['/w/v.syx'];
}

test('identify: a 1.74-like Rytm MK1 file is refused as "1.74: not supported yet; do not install"', { skip: !mk1 }, async () => {
  const f = await fakeVersion(mk1, '1.74');
  const r = await E.identify(f, 'Analog-Rytm_OS1.74.syx');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.kind, 'newer');
  assert.match(r.message, /1\.74/);
  assert.match(r.message, /not supported yet/);
  assert.match(r.message, /Do not install it on your unit/);
  const b = await E.build(f, 'mk1-control');
  assert.strictEqual(b.ok, false);
  assert.strictEqual(b.stage, 'stock');
});

test('identify: a 1.74-like MKII file inside a _dist.zip is refused the same way', { skip: !mk2 }, async () => {
  const f = await fakeVersion(mk2, '1.74');
  const z = makeZip([{ name: '__MACOSX/._x.syx', data: new Uint8Array(10) },
                     { name: 'Analog-Rytm_MKII_OS1.74.syx', data: f, deflate: true }]);
  const r = await E.identify(z, 'Analog-Rytm_MKII_OS1.74_dist.zip');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.kind, 'newer');
  assert.match(r.title, /MKII/);
});

test('identify: stock 1.73 inside a _dist.zip (deflated) is found and accepted', { skip: !mk1 }, async () => {
  const z = makeZip([{ name: 'readme.txt', data: Buffer.from('hello') },
                     { name: 'Analog-Rytm_OS1.73.syx', data: mk1, deflate: true }]);
  const r = await E.identify(z, 'Analog-Rytm_OS1.73_dist.zip');
  assert.ok(r.ok);
  assert.strictEqual(r.device, 'mk1');
  assert.strictEqual(L.SHA.sha256hex(r.data), L.SHA.sha256hex(mk1));
});

test('identify: 1.72 stock files are known and refused (the mods need 1.73)', { skip: !(mk1old && mk2old) }, async () => {
  for (const f of [mk1old, mk2old]) {
    const r = await E.identify(f, 'x.syx');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.kind, 'stock-old');
    assert.match(r.message, /1\.73/);
  }
});

test('identify: random bytes, a truncated stock file and an empty .zip are refused', { skip: !mk1 }, async () => {
  let r = await E.identify(new Uint8Array([1, 2, 3, 4, 5]), 'x.bin');
  assert.strictEqual(r.ok, false); assert.strictEqual(r.kind, 'not-syx');
  r = await E.identify(mk1.slice(0, 100000), 'cut.syx');
  assert.strictEqual(r.ok, false);
  assert.ok(['unreadable', 'damaged', 'unknown-version'].includes(r.kind), r.kind);
  r = await E.identify(makeZip([{ name: 'a.txt', data: Buffer.from('x') }]), 'e.zip');
  assert.strictEqual(r.ok, false); assert.strictEqual(r.kind, 'zip-empty');
});

test('wrong stock: an MKII file cannot build an MK1 target, nor 1.72 a 1.73 one, nor Keys a Rytm one', { skip: !(mk1 && mk2 && keys) }, async () => {
  let r = await E.build(mk2, 'mk1-samplefocus');
  assert.strictEqual(r.ok, false); assert.strictEqual(r.stage, 'stock');
  r = await E.build(keys, 'mk2-control');
  assert.strictEqual(r.ok, false); assert.strictEqual(r.stage, 'stock');
  r = await E.build(mk1, 'keys-chord');
  assert.strictEqual(r.ok, false); assert.strictEqual(r.stage, 'stock');
  if (mk1old) {
    r = await E.build(mk1old, 'mk1-control');
    assert.strictEqual(r.ok, false); assert.strictEqual(r.stage, 'stock');
  }
});

test('tampered package: one changed mod byte is refused by the package checksum', { skip: !keys }, async () => {
  const E2 = engineWith('keys-chord', p => {
    const e = p.edits.find(x => x.kind === 'cave');
    const part = e.parts.find(x => x[0] === 'data');
    const b = Buffer.from(part[1], 'base64'); b[10] ^= 1; part[1] = b.toString('base64');
  }, false);
  const r = await E2.build(keys, 'keys-chord');
  assert.strictEqual(r.ok, false); assert.strictEqual(r.stage, 'package');
  assert.match(r.message, /damaged or was changed/);
});

test('tampered package with a forged index: refused because the result is not the published file', { skip: !keys }, async () => {
  // the last byte of the cave: CHORD's RAM state defaults (design.md), not code, so every
  // structural check passes and only the published-sha256 pin can catch it
  const E2 = engineWith('keys-chord', p => {
    const e = p.edits.find(x => x.kind === 'cave');
    const part = e.parts.filter(x => x[0] === 'data').pop();
    const b = Buffer.from(part[1], 'base64'); b[b.length - 1] ^= 1; part[1] = b.toString('base64');
  }, true);
  const r = await E2.build(keys, 'keys-chord');
  assert.strictEqual(r.ok, false); assert.strictEqual(r.stage, 'verify');
  assert.match(r.message, /not the published file/);
});

test('package naming another published hash than the pinned one is refused', { skip: !keys }, async () => {
  const E2 = engineWith('keys-chord', p => { p.output.sha256 = '00'.repeat(32); }, true);
  const r = await E2.build(keys, 'keys-chord');
  assert.strictEqual(r.ok, false); assert.strictEqual(r.stage, 'package');
});

test('expect-bytes mismatch: a wrong site fingerprint, and a site moved by 2 bytes, are refused', { skip: !mk1 }, async () => {
  let E2 = engineWith('mk1-samplefocus', p => {
    const e = p.edits.find(x => x.kind === 'detour');
    e.expect = e.expect.replace(/^./, c => (c === '0' ? '1' : '0'));
  }, true);
  let r = await E2.build(mk1, 'mk1-samplefocus');
  assert.strictEqual(r.ok, false); assert.strictEqual(r.stage, 'apply');
  assert.match(r.message, /does not hold the expected bytes/);
  E2 = engineWith('mk1-samplefocus', p => {
    const es = p.edits;  // a patch with room around it, so moving it overlaps nothing
    const e = es.find((x, i) => x.kind === 'patch' &&
                      (!es[i + 1] || es[i + 1].addr >= x.addr + 2 + Math.max(x.len, x.expect_len)));
    e.addr += 2;
    p.regions.push([e.addr, e.len, 'patch/test']);
  }, true);
  r = await E2.build(mk1, 'mk1-samplefocus');
  assert.strictEqual(r.ok, false); assert.strictEqual(r.stage, 'apply');
  assert.match(r.message, /does not hold the expected bytes/);
});

for (const [dev, id, stockKey] of [['mk1', 'mk1-samplefocus', 'mk1'], ['mk2', 'mk2-samplefocus', 'mk2'], ['keys', 'keys-chord', 'keys']]) {
  test(`never-write violation (${dev}): a package edit inside each never-write range is refused`, async (t) => {
    const stock = { mk1, mk2, keys }[stockKey];
    if (!stock) return t.skip('stock file not found');
    for (const r0 of L.known.devices[dev].never_write) {
      const at = parseInt(r0.start, 16) + 0x40;
      const E2 = engineWith(id, p => {
        p.edits.push({ kind: 'patch', owner: 'test', addr: at, len: 2, expect_len: 2, expect: '00', parts: [['data', 'TnE=']] });
        p.regions.push([at, 2, 'patch/test']);
      }, true);
      const r = await E2.build(stock, id);
      assert.strictEqual(r.ok, false, r0.label);
      assert.strictEqual(r.stage, 'apply');
      assert.match(r.message, /would write into the/);
    }
  });
}

test('never-write declaration missing from a package is refused', { skip: !mk1 }, async () => {
  const E2 = engineWith('mk1-control', p => { p.never_write = []; }, true);
  const r = await E2.build(mk1, 'mk1-control');
  assert.strictEqual(r.ok, false); assert.strictEqual(r.stage, 'package');
  assert.match(r.message, /must leave alone/);
});

test('an edit outside every declared claim is refused', { skip: !keys }, async () => {
  const E2 = engineWith('keys-chord', p => {
    const e = p.edits.find(x => x.kind === 'detour');
    p.regions = p.regions.filter(g => g[0] !== e.addr);
  }, true);
  const r = await E2.build(keys, 'keys-chord');
  assert.strictEqual(r.ok, false); assert.strictEqual(r.stage, 'apply');
  assert.match(r.message, /outside every declared claim/);
});

test('a stock copy from anywhere but a declared detour site is refused', { skip: !keys }, async () => {
  const E2 = engineWith('keys-chord', p => {
    const e = p.edits.find(x => x.parts.some(q => q[0] === 'stock'));
    const q = e.parts.find(x => x[0] === 'stock'); q[1] += 0x100;
  }, true);
  const r = await E2.build(keys, 'keys-chord');
  assert.strictEqual(r.ok, false); assert.strictEqual(r.stage, 'apply');
  assert.match(r.message, /not a declared detour site/);
});

test('a declared stock copy whose keyed check fails is refused', { skip: !mk1 }, async (t) => {
  const { texts } = L.loadPackages();
  if (!(JSON.parse(texts['mk1-samplefocus']).stock_copies || []).length) return t.skip('no stock copies in this package');
  const E2 = engineWith('mk1-samplefocus', p => {
    p.stock_copies[0].expect = p.stock_copies[0].expect.replace(/^./, c => (c === '0' ? '1' : '0'));
  }, true);
  const r = await E2.build(mk1, 'mk1-samplefocus');
  assert.strictEqual(r.ok, false); assert.strictEqual(r.stage, 'apply');
  assert.match(r.message, /a copy source/);
});

test('one of our own built files dropped as "stock" is recognised and refused', { skip: !keys }, async () => {
  const b = await E.build(keys, 'keys-joy-min');
  assert.ok(b.ok);
  const r = await E.identify(b.bytes, b.name);
  assert.strictEqual(r.ok, false); assert.strictEqual(r.kind, 'our-output');
});

test('feature rules: SMP CUT pulls in CHOP; classic excludes Sample Focus; Keys combinations map 1:1', () => {
  let r = E.resolve('mk1', ['smpcut']);
  assert.ok(r.ok); assert.strictEqual(r.recipe, 'mk1-samplefocus-cut'); assert.strictEqual(r.notes.length, 1);
  r = E.resolve('mk1', ['classic', 'chop']);
  assert.strictEqual(r.ok, false); assert.match(r.message, /cannot be combined/);
  assert.strictEqual(E.resolve('mk1', []).recipe, 'mk1-control');
  assert.strictEqual(E.resolve('mk2', ['chop']).recipe, 'mk2-samplefocus');
  assert.strictEqual(E.resolve('keys', ['joy']).recipe, 'keys-joy-min');
  assert.strictEqual(E.resolve('keys', ['chord', 'joy']).recipe, 'keys-joy');
  assert.strictEqual(E.resolve('keys', ['chord']).recipe, 'keys-chord');
  assert.strictEqual(E.resolve('keys', []).recipe, 'keys-control');
});
