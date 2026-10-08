#!/usr/bin/env node
/* bundle.js - assemble dist/index.html: one self-contained page, no server needed.
 *
 * Part of the browser installer (working name "web"). Copyright (C) 2026 bandersong.
 * SPDX-License-Identifier: GPL-3.0-or-later.
 *
 * Inlines the stylesheet, the sender, the page script and, as one string, the engine
 * (sha256, zip, eftrun, engine, the WebAssembly tool generated/eft.js, known.json and
 * the generated packages). The page starts the engine in a Web Worker from that string,
 * so it runs from file:// and offline. No timestamps: the same inputs give the same file.
 * The page thread gets its own copy of sha256.js and of known.json (RYTM_PAGE_KNOWN) for
 * the last check before sending. The page carries every notice and licence text that
 * applies to the code inside it (LICENCES below): one file, so they travel with it.
 *   node web/tools/bundle.js            writes web/dist/index.html
 *   node web/tools/bundle.js --check    exits 1 if dist/index.html is not what the inputs give
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WEB = path.resolve(__dirname, '..');
const rd = p => fs.readFileSync(path.join(WEB, p), 'utf8');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* Every text the page must carry, in full: [file, heading]. */
const LICENCES = [
  ['NOTICE', 'NOTICE: credits and third-party code in this page'],
  ['third_party/elektron-firmware-tool/LICENSE', 'elektron-firmware-tool (compiled into this page): MIT License'],
  ['third_party/emscripten-runtime/LICENSE.emscripten', 'Emscripten runtime (compiled into this page): MIT / University of Illinois/NCSA'],
  ['third_party/emscripten-runtime/COPYRIGHT.musl', 'musl libc (parts compiled into this page): MIT License'],
  ['LICENSE', 'This page: GNU General Public License, version 3']
];
const SOURCE_NOTE =
  'This page is free software: you can redistribute it and/or modify it under the terms of the GNU General ' +
  'Public License as published by the Free Software Foundation, either version 3 of the License, or (at your ' +
  'option) any later version. It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; ' +
  'without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU ' +
  'General Public License below for more details.\n\n' +
  'Corresponding Source: the page is built by web/tools/bundle.js from the project\'s web/ folder (src/, tools/, ' +
  'generated/, third_party/). Its JavaScript is in this file as written. The WebAssembly part is ' +
  'elektron-firmware-tool\'s C sources (third_party/elektron-firmware-tool/) plus src/wasm/eft_api.c, compiled by ' +
  'tools/build-wasm.sh with emscripten 6.0.10 (flags and source hashes: generated/eft.build.txt). The project has ' +
  'no public address yet (working name, not published); the address of the source will be written here before ' +
  'this page is shared.';

function licenceHtml() {
  const parts = ['<h3>This page</h3>\n<pre>' + esc(SOURCE_NOTE) + '</pre>'];
  for (const [f, h] of LICENCES) parts.push('<h3>' + esc(h) + '</h3>\n<pre>' + esc(rd(f)) + '</pre>');
  return parts.join('\n');
}

function build() {
  const index = JSON.parse(rd('generated/packages/index.json'));
  const texts = {};
  for (const id of Object.keys(index.packages)) {
    texts[id] = rd(`generated/packages/${id}.json`);
    if (sha(texts[id]) !== index.packages[id]) throw new Error(`package ${id} does not match index.json`);
  }
  const known = JSON.parse(rd('src/engine/known.json'));
  const engineParts = [
    ['src/engine/sha256.js', rd('src/engine/sha256.js')],
    ['src/engine/zip.js', rd('src/engine/zip.js')],
    ['src/engine/eftrun.js', rd('src/engine/eftrun.js')],
    ['src/engine/engine.js', rd('src/engine/engine.js')],
    ['generated/eft.js', rd('generated/eft.js')],
    ['data', 'var RYTM_KNOWN = ' + JSON.stringify(known) + ';\n' +
             'var RYTM_INDEX = ' + JSON.stringify(index) + ';\n' +
             'var RYTM_PACKAGES = ' + JSON.stringify(texts) + ';\n']
  ];
  const engineSrc = engineParts.map(([n, s]) => `/* ---- ${n} ---- */\n${s}\n;`).join('\n');
  // a JS string literal that cannot end the <script> element or open an HTML comment
  const lit = JSON.stringify(engineSrc).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const pageJs = [rd('src/engine/sha256.js'), rd('src/sender/sender.js'), rd('src/ui/app.js')];
  for (const js of pageJs) {
    if (/<\/script|<!--/i.test(js)) throw new Error('page script contains </script or <!--');
  }
  const pageKnown = JSON.stringify(known).replace(/</g, '\\u003c');
  const scripts = 'window.RYTM_ENGINE_SRC = ' + lit + ';\n' +
    'window.RYTM_PAGE_KNOWN = ' + pageKnown + ';\n' + pageJs.join('\n;\n');
  const inputs = ['src/ui/index.html', 'src/ui/style.css', 'src/ui/app.js', 'src/sender/sender.js',
                  ...engineParts.slice(0, 5).map(p => p[0]), 'src/engine/known.json', 'generated/packages/index.json',
                  ...LICENCES.map(l => l[0])];
  const stamp = '<!-- Rytm & Keys Mod Installer (working name), M0. Copyright (C) 2026 bandersong.\n' +
    'Free software: GPL-3.0-or-later. This file also contains elektron-firmware-tool,\n' +
    'Copyright (c) 2026 Marcel Bierling (MIT License), the emscripten runtime (MIT or\n' +
    'University of Illinois/NCSA) and parts of musl libc, Copyright (c) 2005-2020 Rich Felker,\n' +
    'et al. (MIT License), compiled to WebAssembly. Their full notices and licence texts, and\n' +
    'where the source is, are in the "Licences and credits" section at the end of this file.\n\n' +
    'Built by web/tools/bundle.js from (sha256):\n' +
    inputs.map(p => `  ${sha(rd(p))}  ${p}`).join('\n') + '\n-->\n';
  let html = rd('src/ui/index.html');
  if (html.split('<!--@LICENCES@-->').length !== 2) throw new Error('index.html needs exactly one <!--@LICENCES@-->');
  html = html.replace('/*@CSS@*/', () => rd('src/ui/style.css'));
  html = html.replace('<!--@LICENCES@-->', () => licenceHtml());
  html = html.replace('/*@SCRIPTS@*/', () => scripts);
  html = html.replace('<!doctype html>\n', () => '<!doctype html>\n' + stamp);
  return html;
}

module.exports = { build, LICENCES, esc };
if (require.main !== module) return;

const html = build();
const out = path.join(WEB, 'dist', 'index.html');
if (process.argv.includes('--check')) {
  const cur = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
  if (cur !== html) { console.error('dist/index.html is out of date: run node web/tools/bundle.js'); process.exit(1); }
  console.log(`dist/index.html is up to date (${Buffer.byteLength(html)} B, sha256 ${sha(html)})`);
} else {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  console.log(`wrote dist/index.html (${Buffer.byteLength(html)} B, sha256 ${sha(html)})`);
}
