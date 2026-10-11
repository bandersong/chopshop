/* Every published target, rebuilt in the engine from the user's stock file, must hash
 * to the published sha256. Part of Chopshop, the browser installer.
 * SPDX-FileCopyrightText: 2026 Jesus Triana. SPDX-License-Identifier: GPL-3.0-or-later. Read-only: inputs are read, outputs stay in memory.
 * ONLY=<recipe id,...> limits the run (the full set takes a few minutes). */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const L = require('./lib.js');

const E = L.engine();
const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
const { index } = L.loadPackages();

for (const pin of L.known.recipes) {
  if (only && !only.includes(pin.id)) continue;
  const stockPin = L.known.stock.find(s => s.device === pin.device && s.supported);
  const stock = L.stockFor(pin.device, stockPin.os);
  const hasPkg = !!index.packages[pin.id];
  test(`${pin.id}: stock ${stockPin.sha256.slice(0, 8)} -> published ${pin.output_sha256.slice(0, 8)}`,
       { skip: !stock ? 'stock file not found' : !hasPkg ? 'no package generated' : false }, async () => {
    const t0 = Date.now();
    const id = await E.identify(stock, 'stock.syx');
    assert.ok(id.ok && id.device === pin.device, 'identify the stock file');
    const r = await E.build(stock, pin.id);
    if (!r.ok) console.log(r.checks.join('\n'));
    assert.ok(r.ok, r.message);
    assert.strictEqual(r.sha256, pin.output_sha256);
    assert.strictEqual(L.SHA.sha256hex(r.bytes), pin.output_sha256);
    assert.strictEqual(r.checks[r.checks.length - 1], 'PASS');
    console.log(`  ${pin.id}: ${r.sha256} (${r.size} B) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  });
}
