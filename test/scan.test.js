/* The no-Elektron-bytes scan over everything the installer ships.
 * Part of Chopshop, the browser installer. SPDX-License-Identifier: GPL-3.0-or-later.
 *
 * Shipped byte strings ("S"): every package's mod bytes (each data part, decoded), every
 * package file as text, the bundle dist/index.html, the WebAssembly binary inside
 * generated/eft.js (decoded), and every other text file under web/.
 * References ("R"): the user's three stock files (Elektron's), each as the raw .syx and
 * as every section the tool unpacks from it. Read here, never copied anywhere.
 *
 * The test, fixed before it was first run:
 *  T1 exact - no S contains, as bytes, the stock bytes displaced at any detour site
 *     (what a stub re-emits); the packages carry those only as "copy N bytes from stock
 *     at X" references. Also no text file spells them in hex.
 *  T2 long runs - (v2, see below) no package (mod bytes or package text) shares a run of
 *     16 or more bytes with any R, apart from low-entropy padding (at most 3 distinct byte
 *     values, at least 3/4 of them 0x00 or 0xFF: RAM defaults). In everything else shipped
 *     (the WebAssembly, the bundle, the sources) a run of 16 or more is allowed only if it
 *     is plain text (printable ASCII, tab, CR, LF, NUL), and every such run is listed.
 *     History: v1 used one rule for everything (only single-byte fill excused) and failed
 *     on its first run, 2026-10-08: in the packages, a few low-entropy RAM tables, two
 *     call sequences identical to stock's (jsr; move.l d0,-(sp); jsr) and, in the classic
 *     step-lock build, a pointer table repeating four entries of a stock table; elsewhere,
 *     C-library error messages in the WebAssembly ("No such file or directory"...), the
 *     product name, "0123456789ABCDEF" and comments. The generator now turns every such
 *     non-padding run in the packages into a "copy from your stock file" reference, and
 *     the text rule above replaced v1 for the non-package files.
 *  T3 rate - over the mod bytes of each device: the share of bytes inside some 4-byte
 *     window that also occurs in that device's stock MAIN OS, leaving out the declared
 *     jmp/jsr opcodes (4EF9/4EB9 + a 32-bit address inside that MAIN OS) and fill, must
 *     not exceed by more than 10 percentage points the same share measured against the
 *     other family's MAIN OS (Rytm mods vs the Keys OS, Keys mods vs the Rytm MK1 OS): the
 *     rate at which ColdFire code written by anyone matches some 4 bytes of a large image.
 *  Reported as well: the distribution of maximal matching runs (same device), so a reader
 *  can see what "non-trivial" would have looked like.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const L = require('./lib.js');

const RUN = 16;

function bufOf(u8) { return Buffer.from(u8.buffer, u8.byteOffset, u8.length); }
function lowEntropy(b) {
  const d = new Set(b);
  let pad = 0;
  for (const x of b) if (x === 0 || x === 0xff) pad++;
  return d.size <= 3 && pad * 4 >= b.length * 3;
}
function isText(b) {
  for (const x of b) if (!((x >= 0x20 && x <= 0x7e) || x === 9 || x === 10 || x === 13 || x === 0)) return false;
  return true;
}
function isFill(b, i, n) { for (let k = 1; k < n; k++) if (b[i + k] !== b[i]) return false; return true; }

/* sorted unique 4-grams of a reference, for exact membership by binary search */
function grams4(R) {
  const n = R.length - 3, a = new Uint32Array(n);
  for (let i = 0; i < n; i++) a[i] = ((R[i] << 24) | (R[i + 1] << 16) | (R[i + 2] << 8) | R[i + 3]) >>> 0;
  a.sort();
  let w = 0;
  for (let i = 0; i < n; i++) if (i === 0 || a[i] !== a[i - 1]) a[w++] = a[i];
  return a.subarray(0, w);
}
function has4(G, v) {
  let lo = 0, hi = G.length - 1;
  while (lo <= hi) { const m = (lo + hi) >>> 1; if (G[m] === v) return true; if (G[m] < v) lo = m + 1; else hi = m - 1; }
  return false;
}
function word(b, i) { return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0; }

/* hashed 16-grams of a reference (verified by indexOf on a hit) */
function hash16(b, i) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let k = 0; k < 4; k++) {
    const w = word(b, i + 4 * k);
    h1 = Math.imul(h1 ^ w, 0x9e3779b1) >>> 0;
    h2 = Math.imul(h2 + w, 0x85ebca77) >>> 0;
  }
  return (h1 & 0x3ffffff) * 0x4000000 + (h2 & 0x3ffffff);
}
function grams16(R) {
  const s = new Set();
  for (let i = 0; i + RUN <= R.length; i++) s.add(hash16(R, i));
  return s;
}

/* runs of >= RUN bytes of S found in R (fill excluded), extended to their full length */
function longRuns(S, R, G16) {
  const out = [], rb = bufOf(R), sb = bufOf(S);
  let i = 0;
  while (i + RUN <= S.length) {
    if (!isFill(S, i, RUN) && G16.has(hash16(S, i)) && rb.indexOf(sb.subarray(i, i + RUN)) >= 0) {
      let len = RUN;
      while (i + len < S.length && rb.indexOf(sb.subarray(i, i + len + 1)) >= 0) len++;
      out.push({ at: i, len });
      i += len;
    } else i++;
  }
  return out;
}

/* T3: bytes covered by matching 4-grams, minus declared jmp/jsr forms and fill */
function coverage(S, G4, declaredMask) {
  const cov = new Uint8Array(S.length);
  for (let i = 0; i + 4 <= S.length; i++) {
    if (isFill(S, i, 4)) continue;
    let declared = true;
    for (let k = 0; k < 4; k++) if (!declaredMask[i + k]) { declared = false; break; }
    if (declared) continue;
    if (has4(G4, word(S, i))) for (let k = 0; k < 4; k++) cov[i + k] = 1;
  }
  let n = 0;
  for (let i = 0; i < S.length; i++) if (cov[i] && !declaredMask[i]) n++;
  return n;
}
function declaredJumps(S, lo, hi) {
  const m = new Uint8Array(S.length);
  let n = 0;
  for (let i = 0; i + 6 <= S.length; i++) {
    if (S[i] === 0x4e && (S[i + 1] === 0xf9 || S[i + 1] === 0xb9)) {
      const a = word(S, i + 2);
      if (a >= lo && a < hi) { for (let k = 0; k < 6; k++) m[i + k] = 1; n++; }
    }
  }
  return { mask: m, count: n };
}

/* maximal runs (>= 4) of S in R, exact, for the report */
function maximalRuns(S, R, G4) {
  const rb = bufOf(R), sb = bufOf(S), runs = [];
  let prev = 0;
  for (let i = 0; i + 4 <= S.length; i++) {
    let len = 0;
    if (has4(G4, word(S, i))) {
      len = Math.max(4, prev - 1);
      while (i + len < S.length && rb.indexOf(sb.subarray(i, i + len + 1)) >= 0) len++;
      if (len > 4 && rb.indexOf(sb.subarray(i, i + len)) < 0) { // prev-1 start was too optimistic
        len = 4;
        while (i + len < S.length && rb.indexOf(sb.subarray(i, i + len + 1)) >= 0) len++;
      }
      if (len > prev - 1) runs.push({ at: i, len });
    }
    prev = len;
  }
  return runs;
}

const stocks = L.findStock();
const haveAll = ['mk1', 'mk2', 'keys'].every(d => L.stockFor(d, d === 'keys' ? '1.56' : '1.73'));

test('no Elektron bytes in the packages or the bundle (T1 exact, T2 runs >= 16 B, T3 4-byte rate vs control)',
     { skip: !haveAll && 'all three stock files are needed' }, async () => {
  const { index, texts } = L.loadPackages();
  const report = { definition: 'see the header of test/scan.test.js', T1: {}, T2: {}, T3: {}, runs: {} };

  // references, per device
  const refs = {};
  for (const dev of ['mk1', 'mk2', 'keys']) {
    const raw = L.stockFor(dev, dev === 'keys' ? '1.56' : '1.73');
    const ex = await L.EFT.run(L.createEFT, ['-i', '/in/s.syx', '-o', '/x'], { '/in/s.syx': raw }, { readDir: '/x' });
    assert.strictEqual(ex.rc, 0);
    refs[dev] = { raw, sections: ex.files, main: ex.files['/x/section_3_MAIN_OS.bin'] };
  }
  const allRefs = [];
  for (const dev of Object.keys(refs)) {
    allRefs.push([`${dev} raw .syx`, refs[dev].raw]);
    for (const [n, b] of Object.entries(refs[dev].sections)) allRefs.push([`${dev} ${n.slice(3)}`, b]);
  }

  // shipped strings
  const shipped = [];
  const payload = { mk1: [], mk2: [], keys: [] };
  const seen = new Set();
  const displaced = { mk1: new Map(), mk2: new Map(), keys: new Map() };
  for (const id of Object.keys(index.packages)) {
    const p = JSON.parse(texts[id]);
    const main = refs[p.device].main;
    shipped.push([`package ${id} (text)`, new Uint8Array(Buffer.from(texts[id]))]);
    for (const d of p.detours) {
      const b = main.subarray(d.addr - p.base, d.addr - p.base + d.displaced_len);
      displaced[p.device].set(Buffer.from(b).toString('hex'), b);
    }
    for (const e of p.edits) e.parts.forEach((part, k) => {
      if (part[0] !== 'data') return;
      const b = new Uint8Array(Buffer.from(part[1], 'base64'));
      const key = p.device + ':' + part[1];
      if (seen.has(key)) return;
      seen.add(key);
      shipped.push([`${id} mod bytes @0x${e.addr.toString(16)} part ${k} (${e.kind} ${e.owner})`, b]);
      payload[p.device].push(b);
    });
  }
  const bundle = path.join(L.WEB, 'dist', 'index.html');
  assert.ok(fs.existsSync(bundle), 'dist/index.html must exist (node tools/bundle.js)');
  shipped.push(['dist/index.html', new Uint8Array(fs.readFileSync(bundle))]);
  // emscripten (SINGLE_FILE) embeds the module as a one-byte-per-character string literal,
  // binaryDecode('...'); take that literal, evaluate it alone and decode it the same way
  const eftText = fs.readFileSync(path.join(L.WEB, 'generated', 'eft.js'), 'utf8');
  const open = 'function findWasmBinary(){return binaryDecode(', close = ')}function getBinarySync';
  const a = eftText.indexOf(open), z = eftText.indexOf(close, a);
  assert.ok(a > 0 && z > a, 'the WebAssembly binary is embedded in generated/eft.js');
  const binStr = require('vm').runInNewContext(eftText.slice(a + open.length, z));
  const wasm = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) { const c = binStr.charCodeAt(i); wasm[i] = ~c >> 8 & c; }
  const page = fs.readFileSync(bundle, 'utf8');
  const tag = 'window.RYTM_ENGINE_SRC = ', at = page.indexOf(tag);
  const engineSrc = JSON.parse(page.slice(at + tag.length, page.indexOf('\n', at)).replace(/;$/, ''));
  assert.ok(engineSrc.includes(eftText), 'the bundle carries generated/eft.js, so the same WebAssembly');
  assert.deepStrictEqual([...wasm.subarray(0, 4)], [0x00, 0x61, 0x73, 0x6d]);
  shipped.push(['WebAssembly (eft.wasm, decoded)', wasm]);
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? (['dist', 'node_modules', 'build'].includes(e.name) ? [] : walk(path.join(d, e.name)))
                    : [path.join(d, e.name)]);
  const textFiles = walk(L.WEB).filter(f => !/generated\/packages\//.test(f));
  for (const f of textFiles) shipped.push([path.relative(L.WEB, f), new Uint8Array(fs.readFileSync(f))]);
  report.shipped = { strings: shipped.length, bytes: shipped.reduce((n, s) => n + s[1].length, 0),
                     mod_bytes: Object.fromEntries(Object.entries(payload).map(([d, a]) => [d, a.reduce((n, b) => n + b.length, 0)])) };

  // T1
  let t1 = 0, t1hex = 0, nDisp = 0;
  for (const dev of Object.keys(displaced)) {
    for (const [hx, b] of displaced[dev]) {
      nDisp++;
      for (const [name, s] of shipped) {
        if (bufOf(s).indexOf(bufOf(b)) >= 0) { t1++; console.log(`  T1 HIT: ${dev} displaced span (${b.length} B) inside ${name}`); }
        const txt = bufOf(s).toString('latin1').toLowerCase();
        if (txt.includes(hx)) { t1hex++; console.log(`  T1 HEX HIT: ${dev} displaced span spelled in hex inside ${name}`); }
      }
    }
  }
  report.T1 = { displaced_spans: nDisp, hits: t1, hex_hits: t1hex };

  // T2
  const hits2 = [];
  for (const [rname, R] of allRefs) {
    const G16 = grams16(R);
    for (const [sname, s] of shipped) for (const h of longRuns(s, R, G16)) hits2.push({ s: sname, r: rname, at: h.at, len: h.len });
  }
  report.T2 = { min_run: RUN, references: allRefs.map(r => `${r[0]} (${r[1].length} B)`), hits: hits2 };
  const cls = h => {
    const s = shipped.find(x => x[0] === h.s)[1].subarray(h.at, h.at + h.len);
    return (/ mod bytes |^package /.test(h.s) ? 'package' : 'other') + '/' + (lowEntropy(s) ? 'padding' : isText(s) ? 'text' : 'binary');
  };
  report.T2.by_class = hits2.reduce((m, h) => { const k = cls(h); m[k] = (m[k] || 0) + 1; return m; }, {});
  report.T2.text_runs = [...new Set(hits2.filter(h => cls(h) === 'other/text')
    .map(h => Buffer.from(shipped.find(x => x[0] === h.s)[1].subarray(h.at, h.at + h.len)).toString('latin1').replace(/\0/g, ' ').trim()))];

  // T3 and the run report
  const control = { mk1: 'keys', mk2: 'keys', keys: 'mk1' };
  for (const dev of Object.keys(payload)) {
    const base = 0x40000400, main = refs[dev].main;
    const Gs = grams4(main), Gc = grams4(refs[control[dev]].main);
    let total = 0, same = 0, ctrl = 0, jumps = 0, runs = [];
    for (const b of payload[dev]) {
      const d = declaredJumps(b, base, base + main.length);
      jumps += d.count;
      total += b.length;
      same += coverage(b, Gs, d.mask);
      ctrl += coverage(b, Gc, d.mask);
      runs = runs.concat(maximalRuns(b, main, Gs).map(r => ({ len: r.len, pad: lowEntropy(b.subarray(r.at, r.at + r.len)) })));
    }
    const hist = { '4-5': 0, '6-7': 0, '8-11': 0, '12-15': 0, '16+': 0 };
    for (const { len: r } of runs) hist[r >= 16 ? '16+' : r >= 12 ? '12-15' : r >= 8 ? '8-11' : r >= 6 ? '6-7' : '4-5']++;
    const real = runs.filter(r => !r.pad).map(r => r.len);
    report.T3[dev] = { mod_bytes: total, declared_jmp_jsr: jumps,
                       same_device_pct: +(100 * same / total).toFixed(2),
                       control_pct: +(100 * ctrl / total).toFixed(2), control: control[dev] + ' MAIN OS' };
    report.runs[dev] = { maximal_runs: runs.length, histogram: hist,
                         longest_padding_included: runs.length ? Math.max(...runs.map(r => r.len)) : 0,
                         longest_not_padding: real.length ? Math.max(...real) : 0,
                         note: 'maximal runs of the shipped mod bytes equal to some bytes of the same device\'s stock MAIN OS' };
  }
  console.log(JSON.stringify(Object.assign({}, report, { T2: Object.assign({}, report.T2, { hits: report.T2.hits.length }) }), null, 1));
  if (process.env.SCAN_REPORT) {
    // the full report, with each long run's bytes, for a person to read: written ONLY when asked,
    // and never into the project (it can hold bytes equal to stock)
    const full = JSON.parse(JSON.stringify(report));
    full.T2.hits = report.T2.hits.map(h => {
      const s = shipped.find(x => x[0] === h.s)[1].subarray(h.at, h.at + h.len);
      return Object.assign({}, h, { hex: Buffer.from(s).toString('hex'), text: Buffer.from(s).toString('latin1') });
    });
    fs.writeFileSync(process.env.SCAN_REPORT, JSON.stringify(full, null, 1));
  }

  assert.strictEqual(t1, 0, 'T1: displaced stock bytes shipped');
  assert.strictEqual(t1hex, 0, 'T1: displaced stock bytes spelled in hex');
  // T2 v2 verdicts (the runs themselves are in report.T2)
  const isPkg = name => / mod bytes /.test(name) || /^package /.test(name);
  const bad2 = hits2.filter(h => {
    const s = shipped.find(x => x[0] === h.s)[1].subarray(h.at, h.at + h.len);
    return isPkg(h.s) ? !lowEntropy(s) : !isText(s);
  });
  for (const h of bad2) console.log(`  T2 FAIL: ${h.len} B of ${h.s} at ${h.at} equal ${h.r}`);
  assert.strictEqual(bad2.length, 0, 'T2: a long run equal to stock that is neither padding (packages) nor text (other files)');
  for (const dev of Object.keys(report.T3)) {
    const r = report.T3[dev];
    assert.ok(r.same_device_pct <= r.control_pct + 10, `T3 ${dev}: ${r.same_device_pct}% vs control ${r.control_pct}%`);
  }
});
