/* dist/index.html is what the sources give, and its embedded engine builds a published file.
 * Part of Chopshop, the browser installer. SPDX-License-Identifier: GPL-3.0-or-later. Read-only. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const L = require('./lib.js');

const dist = path.join(L.WEB, 'dist', 'index.html');

test('dist/index.html is exactly what tools/bundle.js makes from the current sources', () => {
  const { build } = require(path.join(L.WEB, 'tools', 'bundle.js'));
  assert.ok(build() === fs.readFileSync(dist, 'utf8'), 'dist/index.html is stale: run node tools/bundle.js');
});

test('the page is self-contained: no external script, style, font or fetch target', () => {
  const html = fs.readFileSync(dist, 'utf8');
  assert.ok(!/<script[^>]+src=/i.test(html), 'external <script src>');
  assert.ok(!/<link[^>]+rel=["']?stylesheet/i.test(html), 'external stylesheet');
  assert.ok(!/@import/i.test(html), 'CSS @import');
  assert.ok(!/(fetch|importScripts|open)\(\s*["']https?:/i.test(html), 'a hard-coded network fetch');
});

test('the page carries NOTICE and every licence text in full, and says where the source is', () => {
  const { LICENCES, esc } = require(path.join(L.WEB, 'tools', 'bundle.js'));
  const html = fs.readFileSync(dist, 'utf8');
  const want = [['NOTICE'], ['third_party/elektron-firmware-tool/LICENSE'], ['third_party/emscripten-runtime/LICENSE.emscripten'],
                ['third_party/emscripten-runtime/COPYRIGHT.musl'], ['LICENSE']];
  assert.deepStrictEqual(LICENCES.map(l => [l[0]]), want, 'the bundler embeds exactly these texts');
  for (const [f] of want) {
    const text = fs.readFileSync(path.join(L.WEB, f), 'utf8');
    assert.ok(html.includes('<pre>' + esc(text) + '</pre>'), `${f} is in the page, whole`);
  }
  // the MIT conditions, spelled out: the copyright line and the permission notice of each
  assert.ok(html.includes('Copyright (c) 2026 Marcel Bierling'), 'EFT copyright line');
  assert.ok(html.split('The above copyright notice and this permission notice shall be').length - 1 >= 3, 'EFT, emscripten and musl permission notices');
  assert.ok(html.includes('Rich Felker'), 'musl copyright line');
  assert.ok(html.includes('GNU GENERAL PUBLIC LICENSE') && html.includes('Version 3, 29 June 2007'), 'GPL text');
  assert.ok(html.includes('Corresponding Source: https://github.com/bandersong/chopshop . The page is built by tools/bundle.js'), 'source pointer');
  const head = html.slice(0, html.indexOf('Built by tools/bundle.js'));
  assert.ok(/GPL-3\.0-or-later/.test(head) && /Marcel Bierling \(MIT License\)/.test(head) && /Rich Felker/.test(head),
            'the top-of-file comment names the licences');
});

test('the engine embedded in the page builds keys-joy-min to its published sha256', async (t) => {
  const stock = L.stockFor('keys', '1.56');
  if (!stock) return t.skip('Keys stock file not found');
  const html = fs.readFileSync(dist, 'utf8');
  // one line: the JSON string literal has no raw newline in it
  const tag = 'window.RYTM_ENGINE_SRC = ';
  const at = html.indexOf(tag);
  assert.ok(at > 0, 'engine source string in the page');
  const line = html.slice(at + tag.length, html.indexOf('\n', at));
  assert.ok(line.endsWith(';'));
  const src = JSON.parse(line.slice(0, -1));
  // a worker-like global: no window, no document, no require
  const ctx = { console, TextEncoder, TextDecoder, atob, btoa, URL, Blob, Response, DecompressionStream,
                WebAssembly, setTimeout, clearTimeout, performance, Promise,
                WorkerGlobalScope: function WorkerGlobalScope() {}, location: { href: 'blob:null/engine' } };
  ctx.self = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: 'RYTM_ENGINE_SRC' });
  const engine = ctx.RytmEngine.createEngine({
    sha: ctx.RytmSha256, zip: ctx.RytmZip, eft: ctx.RytmEftRun, createEFT: ctx.createEFT,
    known: ctx.RYTM_KNOWN, packageTexts: ctx.RYTM_PACKAGES, packageIndex: ctx.RYTM_INDEX
  });
  const r = await engine.build(stock, 'keys-joy-min');
  assert.ok(r.ok, r.message);
  const pin = L.known.recipes.find(x => x.id === 'keys-joy-min');
  assert.strictEqual(L.SHA.sha256hex(r.bytes), pin.output_sha256);
});
