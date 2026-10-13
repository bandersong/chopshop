/* The default page has no sender: no sender controls, and no MIDI access request at load.
 * The experimental sender exists only behind the address flag #experimental-sender.
 * Part of Chopshop, the browser installer. SPDX-FileCopyrightText: 2026 Bandersong. SPDX-License-Identifier: GPL-3.0-or-later. Read-only.
 *
 * Two layers: (1) the shipped dist/index.html, with its <template> and scripts cut out, holds
 * none of the sender's controls or MIDI-sender wording; (2) the page's own script, taken from
 * dist/index.html and run in a sandbox with a stand-in DOM, never calls navigator.requestMIDIAccess
 * at load, with or without the flag, and never looks up a sender control unless the flag is set. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const L = require('./lib.js');

const html = fs.readFileSync(process.env.DIST_HTML || path.join(L.WEB, 'dist', 'index.html'), 'utf8'); // DIST_HTML: check another build of the page

const SENDER_IDS = ['midiBtn', 'midiStatus', 'midiSupport', 'portSel', 'portWarn', 'gapSel', 'estimate', 'confirms',
  'cfDevice', 'cfOs', 'cfDeviceText', 'cfOsText', 'sendBuild', 'sendStock', 'sendWhat', 'sendBox', 'sendBar',
  'sendStatus', 'abortBtn', 'bgWarn', 'sendDone', 'funcKey', 'routeSteps', 's4x', 'm0note'];

/* the page as a visitor sees it by default: no <template>, no <script>, no <style>, no comments, no licence texts */
function defaultMarkup() {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<template[\s\S]*?<\/template>/g, '')
    .replace(/<script>[\s\S]*?<\/script>/g, '')
    .replace(/<style>[\s\S]*?<\/style>/g, '')
    .replace(/<details id="licences">[\s\S]*?<\/details>/g, '');
}

test('default page: no sender controls and no MIDI-sender wording in the markup', () => {
  const m = defaultMarkup();
  for (const id of SENDER_IDS) assert.ok(!new RegExp(`id=["']${id}["']`).test(m), `sender control #${id} is in the default markup`);
  assert.ok(!/type=["']checkbox["'][^>]*class=["']cf/.test(m) && !/class=["']cf[ "']/.test(m), 'sender confirmation boxes');
  for (const w of [/Allow MIDI/i, /Web ?MIDI/i, /requestMIDIAccess/, /Send the .* build/i, /Recover: send/i, /MIDI access/i, /pause between messages/i]) {
    assert.ok(!w.test(m), `the default page says ${w}`);
  }
  // what it offers instead
  assert.match(m, /Flash it with Elektron Transfer/);
  assert.ok(/id="s4x"/.test(html), 'the experimental sender is still in the file (in a <template>)');
  assert.ok(/<template id="experimentalSenderTpl">/.test(html));
});

/* A stand-in DOM: every element is a recording no-op. */
function runPage(hash) {
  const asked = [];
  const calls = { requestMIDIAccess: 0 };
  function el(id) {
    const listeners = {};
    const e = {
      id, listeners, style: {}, children: [], textContent: '', value: '', checked: false, disabled: false, href: '',
      classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
      setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
      addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
      appendChild(c) { return c; }, removeChild() {}, remove() {}, click() {},
      querySelectorAll() { return []; }, querySelector() { return null; },
      get firstChild() { return null; },
      parentNode: { insertBefore() {} },
      content: { cloneNode() { return {}; } }
    };
    return e;
  }
  const els = {};
  const sandbox = {
    console, setTimeout, clearTimeout,
    document: {
      getElementById(id) { asked.push(id); return els[id] || (els[id] = el(id)); },
      createElement() { return el('(new)'); }, createTextNode() { return {}; },
      querySelectorAll() { return []; }, addEventListener() {}, hidden: false
    },
    location: { hash },
    navigator: { requestMIDIAccess() { calls.requestMIDIAccess++; return new Promise(() => {}); } },
    Blob: function () {}, URL: { createObjectURL() { return 'blob:x'; }, revokeObjectURL() {} },
    alert() {}, Uint8Array, ArrayBuffer, Promise, JSON, Object, Array, Math, Date, String, Number, Error, Function
  };
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  sandbox.window.addEventListener = () => {};
  // the page's last <script>: the engine source string, the pins, sha256.js, sender.js, app.js
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x => x[1]);
  const page = scripts[scripts.length - 1];
  vm.runInNewContext(page, sandbox, { filename: 'dist-page.js' });
  return { asked, calls, els, sandbox };
}

test('default page script: never asks for MIDI access, never touches a sender control', async () => {
  const r = runPage('');
  await new Promise(res => setImmediate(res));
  assert.strictEqual(r.calls.requestMIDIAccess, 0, 'requestMIDIAccess was called at load');
  const touched = r.asked.filter(id => SENDER_IDS.includes(id) || id === 'experimentalSenderTpl');
  assert.deepStrictEqual(touched, [], 'the page script looked up sender elements without the flag');
  assert.ok(r.asked.includes('buildBtn') && r.asked.includes('drop'), 'the page script did run');
});

test('other hashes do not switch the sender on', async () => {
  for (const h of ['#experimental', '#experimental-sender-x', '#sender', '#EXPERIMENTAL-SENDER']) {
    const r = runPage(h);
    await new Promise(res => setImmediate(res));
    assert.strictEqual(r.calls.requestMIDIAccess, 0, h);
    assert.ok(!r.asked.includes('experimentalSenderTpl'), `${h} mounted the sender`);
  }
});

test('with #experimental-sender the sender mounts, still asks for nothing at load, and only a click asks for MIDI', async () => {
  const r = runPage('#experimental-sender');
  await new Promise(res => setImmediate(res));
  assert.ok(r.asked.includes('experimentalSenderTpl'), 'the flag did not mount the sender');
  assert.ok(r.asked.includes('midiBtn'));
  assert.strictEqual(r.calls.requestMIDIAccess, 0, 'requestMIDIAccess was called before any click');
  (r.els.midiBtn.listeners.click || []).forEach(f => f());
  assert.strictEqual(r.calls.requestMIDIAccess, 1, 'the button asks exactly once, with the user\'s click');
});
