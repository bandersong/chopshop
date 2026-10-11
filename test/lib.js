/* Test helpers: load the engine exactly as the page does, find the stock files.
 * Part of Chopshop, the browser installer. SPDX-License-Identifier: GPL-3.0-or-later.
 * Tests only READ files (they run read-only on the host): everything they make stays in memory. */
'use strict';
const fs = require('fs');
const path = require('path');

const WEB = path.resolve(__dirname, '..');
/* In the standalone repo the project's public checksum files and START_HERE pages are mirrored under mods-repo/;
 * inside the mods repo (web/ folder) they are read from the repo root. */
const REPO = fs.existsSync(path.join(WEB, 'mods-repo')) ? path.join(WEB, 'mods-repo') : path.resolve(WEB, '..');
/* The project's flash/*.syx images are not in git ("images stay local"): SYX_ROOT names a checkout that holds them
 * (read only); the checksum files and START_HERE pages are always read from this repo (REPO). */
const SYX_ROOT = process.env.SYX_ROOT || REPO;
const SHA = require(path.join(WEB, 'src/engine/sha256.js'));
const ZIP = require(path.join(WEB, 'src/engine/zip.js'));
const EFT = require(path.join(WEB, 'src/engine/eftrun.js'));
const { createEngine } = require(path.join(WEB, 'src/engine/engine.js'));
const createEFT = require(path.join(WEB, 'generated/eft.js'));
const known = JSON.parse(fs.readFileSync(path.join(WEB, 'src/engine/known.json'), 'utf8'));

function loadPackages(dir = path.join(WEB, 'generated/packages')) {
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  const texts = {};
  for (const id of Object.keys(index.packages)) texts[id] = fs.readFileSync(path.join(dir, id + '.json'), 'utf8');
  return { index, texts };
}

function engine(over = {}) {
  const { index, texts } = loadPackages();
  return createEngine(Object.assign({
    sha: SHA, zip: ZIP, eft: EFT, createEFT, known, packageTexts: texts, packageIndex: index
  }, over));
}

/* The user's stock files, found by checksum in STOCK_DIR (a path-delimited list; default: the repo's stock/
 * and upstream/rytm1_mods/stock/). Elektron's files: read, never copied anywhere. */
function findStock() {
  const dirs = process.env.STOCK_DIR ? process.env.STOCK_DIR.split(path.delimiter)
    : [path.join(REPO, 'stock'), path.join(REPO, 'upstream/rytm1_mods/stock')];
  const bySha = {};
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (!/\.syx$/i.test(f)) continue;
      const b = new Uint8Array(fs.readFileSync(path.join(d, f)));
      const h = SHA.sha256hex(b);
      if (!bySha[h]) bySha[h] = { file: path.join(d, f), bytes: b };
    }
  }
  return bySha;
}

function stockFor(device, os) {
  const s = known.stock.find(x => x.device === device && x.os === os);
  const all = findStock();
  return s && all[s.sha256] ? all[s.sha256].bytes : null;
}

module.exports = { WEB, REPO, SYX_ROOT, SHA, ZIP, EFT, createEFT, known, loadPackages, engine, findStock, stockFor };
