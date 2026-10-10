/* Regression test for the page's state handling, in a real browser (SAFE-1/2/4/5/6/7/8, F2, F5).
 * Part of Chopshop, the browser installer. SPDX-License-Identifier: GPL-3.0-or-later.
 *
 * The invariant: whatever the user does and whenever the replies arrive, the page never
 * offers, and never sends, bytes other than the published file for the device shown in
 * step 1 and the recipe shown in step 2. Each case below tries to break it:
 *   R1 drop another device's stock file 0 ms and 100 ms after Build (the panel's SAFE-1
 *      case), then again after the build; R1b a synthetic drop event on the drop zone
 *      right after Build; worker engine, and with INLINE=1 the on-page engine. A drop the
 *      page handles while the build runs must be refused; with the on-page engine the
 *      page itself is busy packing, so the browser may only deliver the drop after the
 *      build: then it must be handled as a new file, with the old build gone;
 *   R2 change the mod boxes 0.5 s and 3 s into a build;
 *   R3 the exclusion rule both ways (Classic vs CHOP / SMP CUT);
 *   R4 the confirmations: reset on a new file and after a build; the device box names
 *      the device; Recover needs five boxes, the build all six; the buttons name the device;
 *   R5 during a send: file, mod boxes and Build locked; Stop: the page re-enables only
 *      after the queued tail is due to have left the wire; the download name carries
 *      the sha256 prefix.
 * After every settle, if Send the build is enabled (after ticking every box), it is
 * pressed: the first 30 messages on a mock port must be a prefix of the published file
 * for the recipe on screen, for the device on screen.
 *
 * The page's own Web MIDI sender is off by default (it has never touched a real unit).
 * It is switched on by the address flag #experimental-sender, which this test adds; e2e.js checks the default page.
 *
 * Needs Chrome and puppeteer-core (build VM only; never installed on the host):
 *   CHROME=<chrome-headless-shell> PUPPETEER=<dir with node_modules/puppeteer-core> \
 *   [DIST=<page to test, default web/dist/index.html>] [INLINE=1] [SHOTS=<dir>] node web/test/browser/race.js
 * Read-only on the project. No MIDI device is used: the page gets a mock MIDIAccess.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const L = require('../lib.js');
const puppeteer = require(path.join(process.env.PUPPETEER, 'node_modules', 'puppeteer-core'));

const DIST = process.env.DIST || path.join(L.WEB, 'dist', 'index.html');
const SHOTS = process.env.SHOTS || null;
const INLINE = !!process.env.INLINE;
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

function stockPath(dev, os) {
  const s = L.known.stock.find(x => x.device === dev && x.os === os);
  const hit = L.findStock()[s.sha256];
  if (!hit) throw new Error(`stock ${dev} ${os} not found`);
  return hit.file;
}
/* the published outputs, by sha256, from the project's flash/ folders */
const published = {};
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.syx$/i.test(e.name)) published[sha(fs.readFileSync(p))] = p;
  }
})(path.join(L.SYX_ROOT, 'flash'));
const pinBySha = {};
for (const r of L.known.recipes) pinBySha[r.output_sha256] = r;
const DEVICE_RX = { mk1: /Analog Rytm MK1/, mk2: /Analog Rytm MKII/, keys: /Analog Keys/ };

const MOCK = `
  window.__sent = [];
  const out = { id: 'mock1', name: 'Mock DIN interface', manufacturer: 'test', state: 'connected',
    send(data, ts) { window.__sent.push({ d: Array.from(data), ts: ts, at: performance.now() }); } };
  navigator.requestMIDIAccess = async function () {
    return { outputs: new Map([['mock1', out]]), inputs: new Map(), onstatechange: null, sysexEnabled: true };
  };` + (INLINE ? '\n  window.Worker = undefined;' : '');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ': ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
}

async function openPage(browser) {
  const page = await browser.newPage();
  page.on('dialog', d => d.dismiss().catch(() => {}));
  await page.evaluateOnNewDocument(MOCK);
  await page.setViewport({ width: 1100, height: 900 });
  // the sender is off by default: this test is the experimental sender's regression test, so it turns it on
  await page.goto('file://' + DIST.split('/').map(encodeURIComponent).join('/') + '#experimental-sender', { waitUntil: 'load' });
  await page.waitForFunction(() => window.RYTM_ENGINE_MODE, { timeout: 30000 });
  await page.click('#midiBtn');
  await page.waitForFunction(() => document.getElementById('portSel').options.length > 1, { timeout: 10000 });
  await page.select('#portSel', 'mock1');
  return page;
}

async function upload(page, file) { await (await page.$('#file')).uploadFile(file); }

async function waitIdentified(page, rx) {
  await page.waitForFunction(r => new RegExp(r).test(document.getElementById('idResult').textContent), { timeout: 60000 }, rx.source);
}
async function waitResolved(page) {
  await page.waitForFunction(() => /Result:/.test(document.getElementById('recipeCard').textContent) &&
    !document.getElementById('s3').classList.contains('locked') && !document.getElementById('buildBtn').disabled, { timeout: 30000 });
}
async function tickAll(page) {
  for (const cb of await page.$$('.cf')) {
    const st = await cb.evaluate(c => ({ checked: c.checked, disabled: c.disabled }));
    if (!st.checked && !st.disabled) await cb.click();
  }
}
async function settle(page) {
  // quiet: no build running, the file read, and step 2 either answered or locked
  await page.waitForFunction(() => {
    const id = document.getElementById('idResult').textContent;
    const s3locked = document.getElementById('s3').classList.contains('locked');
    return /✓|✗/.test(id) && !/Reading/.test(id) && (s3locked || !document.getElementById('buildBtn').disabled) &&
      !/Starting|Packing|Unpacking|Verifying|Applying|Checking/.test(document.getElementById('buildStatus').textContent);
  }, { timeout: 180000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 3000));
}

/* What the page shows, and what it would download. */
async function snapshot(page) {
  return page.evaluate(async () => {
    const t = id => (document.getElementById(id) || { textContent: '' }).textContent;
    const a = document.getElementById('dlLink');
    const vis = !document.getElementById('dlBox').classList.contains('hidden');
    let dlSha = null;
    if (vis && a.href) {
      const buf = await (await fetch(a.href)).arrayBuffer();
      dlSha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf))).map(b => b.toString(16).padStart(2, '0')).join('');
    }
    return { id: t('idResult').slice(0, 70), card: (t('recipeCard').match(/sha256 ([0-9a-f]{64})/) || [])[1] || null,
             cardName: (t('recipeCard').match(/Result: (\S+)/) || [])[1] || null,
             dlVisible: vis, dlName: a.getAttribute('download'), dlSha,
             ticked: Array.from(document.querySelectorAll('#features input:checked')).map(x => x.value),
             cf: Array.from(document.querySelectorAll('.cf')).map(c => c.checked),
             sendBuild: !document.getElementById('sendBuild').disabled, sendBuildText: t('sendBuild'),
             sendStock: !document.getElementById('sendStock').disabled, sendStockText: t('sendStock'),
             status: t('buildStatus'), dropNote: t('dropNote') };
  });
}

function shownDevice(s) {
  return Object.keys(DEVICE_RX).filter(d => s.id.startsWith('✓') && DEVICE_RX[d].test(s.id) &&
    !(d === 'mk1' && /MKII/.test(s.id)))[0] || null;
}

/* A file dropped while a build runs: if the page handled it during the build, it must
 * have been refused with the inputs locked and the old file kept; if the browser only
 * delivered it after the build (the on-page engine keeps the page busy), it must have
 * been taken as a new file. `after` = the device that file shows ('none' = unreadable). */
async function duringOrAfter(page, label, after) {
  const st = await page.evaluate(() => ({
    building: /Building/.test((document.getElementById('busyNote') || { textContent: '' }).textContent),
    fileDisabled: document.getElementById('file').disabled,
    boxesDisabled: Array.from(document.querySelectorAll('#features input')).every(c => c.disabled),
    note: (document.getElementById('dropNote') || { textContent: '' }).textContent,
    id: document.getElementById('idResult').textContent.slice(0, 60) }));
  if (st.building) {
    check(`${label}: during the build the file input and mod boxes are locked and the drop is refused`,
          st.fileDisabled && st.boxesDisabled && /build is running/.test(st.note) && /Analog Rytm MK1/.test(st.id), st);
  } else {
    await page.waitForFunction(() => /✓|✗/.test(document.getElementById('idResult').textContent) &&
      !/Reading/.test(document.getElementById('idResult').textContent), { timeout: 60000 }).catch(() => {});
    const id = await page.$eval('#idResult', e => e.textContent.slice(0, 60));
    const ok = after === 'mk2' ? /✓ Analog Rytm MKII/.test(id) : /✗/.test(id);
    check(`${label}: the drop reached the page only after the build ended, and was taken as a new file`, ok, { id, note: 'the page was busy; no "during" state to check' });
  }
}

/* The invariant (the recipe card, the download and the wire all belong to the device and
 * recipe on screen), plus a real press of "Send the build" when the page allows it. */
async function coherent(page, label) {
  const s = await snapshot(page);
  const dev = shownDevice(s);
  let ok = true, why = [];
  if (s.card && dev && pinBySha[s.card] && pinBySha[s.card].device !== dev) {
    ok = false; why.push(`recipe card is for ${pinBySha[s.card].device}, page shows ${dev}`);
  }
  if (s.dlVisible) {
    const pin = pinBySha[s.dlSha];
    if (!pin) { ok = false; why.push('download is not a published build'); }
    else {
      if (s.dlSha !== s.card) { ok = false; why.push(`download ${s.dlSha.slice(0, 8)} != recipe on screen ${String(s.card).slice(0, 8)}`); }
      if (pin.device !== dev) { ok = false; why.push(`download is for ${pin.device}, page shows ${dev}`); }
    }
  }
  await tickAll(page);
  const armed = await page.$eval('#sendBuild', b => !b.disabled);
  let wire = null;
  if (armed) {
    await page.evaluate(() => { window.__sent = []; });
    await page.click('#sendBuild');
    await page.waitForFunction(() => window.__sent.length >= 30, { timeout: 60000 });
    await page.click('#abortBtn');
    await page.waitForFunction(() => document.getElementById('sendBox').classList.contains('hidden'), { timeout: 20000 });
    const msgs = await page.evaluate(() => window.__sent.map(m => m.d));
    const bytes = Buffer.concat(msgs.map(m => Buffer.from(m)));
    const want = s.card && published[s.card];
    const pfx = !!want && fs.readFileSync(want).subarray(0, bytes.length).equals(bytes);
    const which = Object.keys(published).find(h => fs.readFileSync(published[h]).subarray(0, bytes.length).equals(bytes));
    wire = { n: msgs.length, prefixOfRecipeOnScreen: pfx, matches: which ? path.basename(published[which]) : null };
    if (!pfx || !pinBySha[s.card] || pinBySha[s.card].device !== dev) { ok = false; why.push('Send the build put another file on the wire'); }
  }
  check(`${label}: offered/sent bytes match the device and recipe on screen`, ok,
        { shown: dev, card: s.card && s.card.slice(0, 8), dl: s.dlSha && s.dlSha.slice(0, 8), dlName: s.dlName, armed, wire, why });
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `race-${label.replace(/\W+/g, '_')}${INLINE ? '-inline' : ''}.png`), fullPage: true });
  return s;
}

(async () => {
  const MK1 = stockPath('mk1', '1.73'), MK2 = stockPath('mk2', '1.73');
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME, headless: true, args: [] });
  try {
    /* R1: another device's file during a build (the panel's SAFE-1 case) */
    for (const D of [0, 100]) {
      const page = await openPage(browser);
      try {
        console.log('engine mode:', await page.evaluate(() => window.RYTM_ENGINE_MODE));
        await upload(page, MK1); await waitIdentified(page, /✓ Analog Rytm MK1/); await waitResolved(page);
        await page.click('#features input[value="smpcut"]');
        await page.waitForFunction(() => /f73f4239/.test(document.getElementById('recipeCard').textContent), { timeout: 30000 });
        await tickAll(page);
        await page.click('#buildBtn');
        if (D) await new Promise(r => setTimeout(r, D));
        await upload(page, MK2);
        await duringOrAfter(page, `R1 D=${D}`, 'mk2');
        await settle(page);
        const s = await coherent(page, `R1 D=${D} after the build`);
        if (shownDevice(s) !== 'mk2') {
          // the drop was refused: the MKII file now, after the build; the MK1 build must go
          await upload(page, MK2); await waitIdentified(page, /✓ Analog Rytm MKII/); await waitResolved(page);
          await settle(page);
        }
        const s2 = await coherent(page, `R1 D=${D} with the MKII file on screen`);
        check(`R1 D=${D}: with the MKII file on screen, no download and no build to send`, shownDevice(s2) === 'mk2' && !s2.dlVisible && !s2.sendBuild,
              { shown: shownDevice(s2), dl: s2.dlVisible, send: s2.sendBuild });
      } catch (e) { check(`R1 D=${D}: ran to the end`, false, String(e.message || e).split('\n')[0]); }
      await page.close();
    }

    /* R1b: a synthetic drop event right after Build */
    {
      const page = await openPage(browser);
      try {
        await upload(page, MK1); await waitIdentified(page, /✓ Analog Rytm MK1/); await waitResolved(page);
        await page.click('#buildBtn');
        await page.evaluate(() => {
          const dt = new DataTransfer();
          dt.items.add(new File([new Uint8Array([0xf0, 0xf7])], 'other.syx'));
          document.getElementById('drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
        });
        await duringOrAfter(page, 'R1b drop event', 'none');
        await settle(page);
        await coherent(page, 'R1b drop event during the build');
      } catch (e) { check('R1b: ran to the end', false, String(e.message || e).split('\n')[0]); }
      await page.close();
    }

    /* R2: change the mods during a build */
    for (const D of [500, 3000]) {
      const page = await openPage(browser);
      try {
      await upload(page, MK1); await waitIdentified(page, /✓ Analog Rytm MK1/); await waitResolved(page);
      await page.click('#features input[value="smpcut"]');
      await page.waitForFunction(() => /f73f4239/.test(document.getElementById('recipeCard').textContent), { timeout: 30000 });
      await page.click('#buildBtn');
      await new Promise(r => setTimeout(r, D));
      // a user click (disabled box) and a scripted change event (as an extension or a11y tool might send)
      await page.click('#features input[value="chop"]').catch(() => {});
      await page.evaluate(() => {
        for (const v of ['smpcut', 'chop']) {
          const c = document.querySelector(`#features input[value="${v}"]`);
          c.checked = false; c.dispatchEvent(new Event('change'));
        }
      });
      await settle(page);
      await coherent(page, `R2 D=${D} mods changed during the build`);
      } catch (e) { check(`R2 D=${D}: ran to the end`, false, String(e.message || e).split('\n')[0]); }
      await page.close();
    }

    /* R3, R4, R5 on one page */
    {
      const page = await openPage(browser);
      try {
      await upload(page, MK1); await waitIdentified(page, /✓ Analog Rytm MK1/); await waitResolved(page);
      // R3: exclusions, both ways
      await page.click('#features input[value="classic"]');
      await page.waitForFunction(() => /a96657b4/.test(document.getElementById('recipeCard').textContent), { timeout: 30000 });
      await page.click('#features input[value="smpcut"]');
      await page.waitForFunction(() => /f73f4239/.test(document.getElementById('recipeCard').textContent), { timeout: 30000 }).catch(() => {});
      let s = await snapshot(page);
      check('R3 Classic on, then tick SMP CUT: Classic goes, CHOP comes, recipe = SMP CUT build',
            s.ticked.sort().join(',') === 'chop,smpcut' && /f73f4239/.test(String(s.card)), { ticked: s.ticked, card: s.cardName });
      await page.click('#features input[value="classic"]');
      await page.waitForFunction(() => /a96657b4/.test(document.getElementById('recipeCard').textContent), { timeout: 30000 }).catch(() => {});
      s = await snapshot(page);
      check('R3 then tick Classic: CHOP and SMP CUT go', s.ticked.join(',') === 'classic', { ticked: s.ticked, card: s.cardName });
      await page.click('#features input[value="classic"]'); // back to Control
      await page.waitForFunction(() => /3407638c/.test(document.getElementById('recipeCard').textContent), { timeout: 30000 });

      // R4: device box, labels, five vs six boxes, resets
      const lab = await page.evaluate(() => ({ dev: (document.getElementById('cfDeviceText') || {}).textContent,
                                              os: (document.getElementById('cfOsText') || {}).textContent,
                                              b: document.getElementById('sendBuild').textContent,
                                              st: document.getElementById('sendStock').textContent }));
      check('R4 the device box and both buttons name the device and OS', /Analog Rytm MK1 \(not an MKII\)/.test(lab.dev || '') &&
            /OS 1\.73/.test(lab.os || '') && /Analog Rytm MK1/.test(lab.b) && /Analog Rytm MK1/.test(lab.st), lab);
      // tick everything but the OS box: Recover yes, build no (no build yet anyway)
      for (const cb of await page.$$('.cf:not(.cf-build)')) await cb.click();
      s = await snapshot(page);
      check('R4 five boxes: Recover enabled', s.sendStock, { cf: s.cf });
      await page.click('#buildBtn');
      await page.waitForFunction(() => !document.getElementById('dlBox').classList.contains('hidden'), { timeout: 180000 });
      s = await snapshot(page);
      check('R4 the boxes are unticked after a build', s.cf.every(x => !x), { cf: s.cf });
      check('R5 the download name carries the sha256 prefix', s.dlName === 'AR1_OS1.73_control_3407638c.syx', s.dlName);
      for (const cb of await page.$$('.cf:not(.cf-build)')) await cb.click();
      s = await snapshot(page);
      check('R4 five boxes with a build: Recover yes, Send the build no', s.sendStock && !s.sendBuild, { stock: s.sendStock, build: s.sendBuild });
      await page.click('#cfOs');
      s = await snapshot(page);
      check('R4 all six: Send the build enabled', s.sendBuild, { build: s.sendBuild });

      // R5: lock during a send, and Stop waits for the tail
      await page.evaluate(() => { window.__sent = []; });
      await page.click('#sendBuild');
      await page.waitForFunction(() => window.__sent.length >= 40, { timeout: 60000 });
      const locks = await page.evaluate(() => ({ build: document.getElementById('buildBtn').disabled,
        file: document.getElementById('file').disabled,
        boxes: Array.from(document.querySelectorAll('#features input')).every(c => c.disabled) }));
      check('R5 during a send: Build, the file input and the mod boxes are locked', locks.build && locks.file && locks.boxes, locks);
      await upload(page, MK2);
      const note = await page.$eval('#dropNote', e => e.textContent);
      check('R5 a file dropped during a send is refused', /send is running/.test(note) &&
            /Analog Rytm MK1/.test(await page.$eval('#idResult', e => e.textContent)), note);
      await page.evaluate(() => {
        window.__doneAt = null;
        new MutationObserver(() => {
          if (window.__doneAt == null && document.getElementById('sendBox').classList.contains('hidden')) window.__doneAt = performance.now();
        }).observe(document.getElementById('sendBox'), { attributes: true });
      });
      const stopAt = await page.evaluate(() => { document.getElementById('abortBtn').click(); return performance.now(); });
      await page.waitForFunction(() => window.__doneAt != null, { timeout: 20000 });
      const tail = await page.evaluate(() => {
        const last = window.__sent[window.__sent.length - 1];
        return { lastTs: last.ts, len: last.d.length, doneAt: window.__doneAt, n: window.__sent.length };
      });
      const tailEnd = tail.lastTs + tail.len * 10 * 1000 / 31250;
      check('R5 after Stop the page re-enables only once the queued tail has left the wire', tail.doneAt >= tailEnd - 1,
            { stopAt: +stopAt.toFixed(1), tailEnd: +tailEnd.toFixed(1), doneAt: +tail.doneAt.toFixed(1), queued: tail.n });
      s = await snapshot(page);
      check('R5/R4 after the send ends the boxes are unticked and both sends are off', s.cf.every(x => !x) && !s.sendBuild && !s.sendStock, { cf: s.cf });
      } catch (e) { check('R3-R5: ran to the end', false, String(e.message || e).split('\n')[0]); }
      await page.close();
    }
  } finally {
    await browser.close();
  }
  const bad = results.filter(r => !r.ok);
  console.log(`${results.length - bad.length} of ${results.length} checks passed${INLINE ? ' (on-page engine)' : ''}`);
  if (SHOTS) fs.writeFileSync(path.join(SHOTS, `race-results${INLINE ? '-inline' : ''}.json`), JSON.stringify(results, null, 1));
  process.exitCode = bad.length ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
