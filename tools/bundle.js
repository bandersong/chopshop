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
  const pageJs = [rd('src/sender/sender.js'), rd('src/ui/app.js')];
  for (const js of pageJs) {
    if (/<\/script|<!--/i.test(js)) throw new Error('page script contains </script or <!--');
  }
  const scripts = 'window.RYTM_ENGINE_SRC = ' + lit + ';\n' + pageJs.join('\n;\n');
  const inputs = ['src/ui/index.html', 'src/ui/style.css', 'src/ui/app.js', 'src/sender/sender.js',
                  ...engineParts.slice(0, 5).map(p => p[0]), 'src/engine/known.json', 'generated/packages/index.json'];
  const stamp = '<!-- Built by web/tools/bundle.js from (sha256):\n' +
    inputs.map(p => `  ${sha(rd(p))}  ${p}`).join('\n') + '\n-->\n';
  let html = rd('src/ui/index.html');
  html = html.replace('/*@CSS@*/', () => rd('src/ui/style.css'));
  html = html.replace('/*@SCRIPTS@*/', () => scripts);
  html = html.replace('<!doctype html>\n', () => '<!doctype html>\n' + stamp);
  return html;
}

module.exports = { build };
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
