/* End-to-end in a real browser: open dist/index.html from file://, drop a stock file,
 * pick mods, build, and check the downloadable file's sha256 inside the page.
 * Part of the browser installer (working name "web"). SPDX-License-Identifier: GPL-3.0-or-later.
 *
 * Not part of `node --test`: it needs Chrome and puppeteer-core, which live in the build
 * VM only (never installed on the host):
 *   CHROME=<chrome-headless-shell> PUPPETEER=<dir with node_modules/puppeteer-core> \
 *   STOCK_DIR=<stock dir> SHOTS=<dir> node web/test/browser/e2e.js
 * Read-only on the project: screenshots go to SHOTS. No MIDI device is used; the default page
 * must not ask for MIDI access at all (a spy on navigator.requestMIDIAccess counts the calls).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const L = require('../lib.js');
const puppeteer = require(path.join(process.env.PUPPETEER, 'node_modules', 'puppeteer-core'));

const CASES = [
  // [stock device, os, feature ids to tick, expected recipe]
  ['mk1', '1.73', ['smpcut'], 'mk1-samplefocus-cut'],
  ['mk2', '1.73', ['chop'], 'mk2-samplefocus'],
  ['keys', '1.56', ['joy'], 'keys-joy-min']
];

function stockPath(dev, os) {
  const s = L.known.stock.find(x => x.device === dev && x.os === os);
  const hit = L.findStock()[s.sha256];
  return hit && hit.file;
}

(async () => {
  const shots = process.env.SHOTS || '/tmp';
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME, headless: true, args: [] });
  const results = [];
  try {
    const page = await browser.newPage();
    const logs = [];
    page.on('console', m => logs.push(`${m.type()}: ${m.text()}`));
    page.on('pageerror', e => logs.push(`pageerror: ${e.message}`));
    await page.evaluateOnNewDocument(() => {
      window.__midiCalls = 0;
      const spy = () => { window.__midiCalls++; return Promise.reject(new Error('spy')); };
      try { Object.defineProperty(navigator, 'requestMIDIAccess', { value: spy, configurable: true }); } catch (e) { /* none */ }
    });
    await page.setViewport({ width: 1100, height: 900 });
    const url = 'file://' + path.join(L.WEB, 'dist', 'index.html').split('/').map(encodeURIComponent).join('/');
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.RYTM_ENGINE_MODE, { timeout: 30000 });
    const mode = await page.evaluate(() => window.RYTM_ENGINE_MODE);
    console.log('engine mode:', mode, '| isSecureContext:', await page.evaluate(() => window.isSecureContext),
                '| Web MIDI:', await page.evaluate(() => typeof navigator.requestMIDIAccess));

    for (const [dev, os, feats, want] of CASES) {
      const f = stockPath(dev, os);
      if (!f) { results.push({ dev, skip: 'no stock' }); continue; }
      const input = await page.$('#file');
      await input.uploadFile(f);
      await page.waitForFunction(() => /✓|✗/.test(document.getElementById('idResult').textContent), { timeout: 60000 });
      const idText = await page.$eval('#idResult', e => e.textContent);
      await page.waitForFunction(() => document.querySelectorAll('#features input[type=checkbox]').length > 0, { timeout: 30000 });
      for (const id of feats) await page.click(`#features input[value="${id}"]`);
      await page.waitForFunction(w => document.getElementById('recipeCard').textContent.length > 0 &&
                                      !document.getElementById('s3').classList.contains('locked'), { timeout: 30000 }, want);
      const ticked = await page.$$eval('#features input:checked', a => a.map(x => x.value));
      const card = await page.$eval('#recipeCard', e => e.textContent);
      const t0 = Date.now();
      await page.click('#buildBtn');
      await page.waitForFunction(() => !document.getElementById('dlBox').classList.contains('hidden') ||
                                       /Stopped/.test(document.getElementById('buildStatus').textContent), { timeout: 600000 });
      const secs = (Date.now() - t0) / 1000;
      const out = await page.evaluate(async () => {
        const a = document.getElementById('dlLink');
        if (!a.href) return { ok: false, status: document.getElementById('buildStatus').textContent };
        const buf = await (await fetch(a.href)).arrayBuffer();
        const h = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)))
          .map(b => b.toString(16).padStart(2, '0')).join('');
        return { ok: true, sha: h, size: buf.byteLength, name: a.getAttribute('download'),
                 checks: document.getElementById('checks').textContent.split('\n').slice(-2) };
      });
      const pin = L.known.recipes.find(r => r.id === want);
      const pass = out.ok && out.sha === pin.output_sha256;
      results.push({ dev, want, ticked, identified: idText.slice(0, 80), secs, ...out, pass });
      console.log(`${pass ? 'PASS' : 'FAIL'} ${want}: ticked [${ticked}] -> ${out.name} ${out.sha} (${secs.toFixed(1)} s in the page)`);
      if (!/Result: /.test(card)) console.log('  recipe card:', card);
      await page.screenshot({ path: path.join(shots, `e2e-${want}.png`), fullPage: true });
    }

    // the default page: no sender, no MIDI request, the OS 1.74 note and Transfer steps, only the unit's own note
    {
      const d = await page.evaluate(() => ({
        midiCalls: window.__midiCalls,
        sender: ['midiBtn', 'portSel', 'gapSel', 'sendBuild', 'sendStock', 'confirms', 'abortBtn'].filter(id => document.getElementById(id)),
        os174: !!document.getElementById('os174') && /OS 1\.74/.test(document.getElementById('os174').textContent),
        transfer: /Flash it with Elektron Transfer/.test(document.getElementById('s4').textContent),
        notes: Array.from(document.querySelectorAll('.devnote:not(.hidden)')).map(n => n.getAttribute('data-dev'))
      }));
      const ok = d.midiCalls === 0 && d.sender.length === 0 && d.os174 && d.transfer && d.notes.join() === 'keys';
      console.log(`${ok ? 'PASS' : 'FAIL'} default page: no sender controls, ${d.midiCalls} MIDI access requests, OS 1.74 note ${d.os174}, Transfer steps ${d.transfer}, device notes shown [${d.notes}]`);
      results.push({ defaultPage: ok, ...d });
      await page.screenshot({ path: path.join(shots, 'e2e-default-s4.png'), fullPage: true });
    }

    // a refused file, in the page
    const old = stockPath('mk1', '1.72');
    if (old) {
      await (await page.$('#file')).uploadFile(old);
      await page.waitForFunction(() => /✗/.test(document.getElementById('idResult').textContent), { timeout: 60000 });
      const t = await page.$eval('#idResult', e => e.textContent);
      const locked = await page.$eval('#s2', e => e.classList.contains('locked'));
      console.log(`${locked ? 'PASS' : 'FAIL'} 1.72 file refused in the page: ${t.slice(0, 140)}`);
      results.push({ refused172: locked });
    }

    {
      const calls = await page.evaluate(() => window.__midiCalls);
      console.log(`${calls === 0 ? 'PASS' : 'FAIL'} the page never asked for MIDI access during the whole run: ${calls} call(s)`);
      results.push({ midiCalls: calls });
    }

    // phone width: no horizontal scrolling
    await page.setViewport({ width: 375, height: 800 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    console.log(`${overflow <= 0 ? 'PASS' : 'FAIL'} phone width 375 px: horizontal overflow ${overflow} px`);
    await page.screenshot({ path: path.join(shots, 'e2e-phone.png'), fullPage: true });
    results.push({ phoneOverflow: overflow });

    const errs = logs.filter(l => /^(error|pageerror)/.test(l));
    console.log('console errors:', errs.length ? errs : 'none');
    fs.writeFileSync(path.join(shots, 'e2e-results.json'), JSON.stringify({ mode, results, logs }, null, 1));
    const bad = results.some(r => r.pass === false || r.refused172 === false || r.phoneOverflow > 0 || r.defaultPage === false || r.midiCalls > 0) || errs.length;
    process.exitCode = bad ? 1 : 0;
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
