/* app.js - the page: drop a file, choose mods, build and check; flash with Elektron Transfer.
 *
 * Part of Chopshop, the browser installer. Copyright (C) 2026 bandersong.
 * SPDX-FileCopyrightText: 2026 Jesus Triana. SPDX-License-Identifier: GPL-3.0-or-later.
 *
 * The engine (EFT in WebAssembly, the packages, the checks) runs in a Web Worker made
 * from its own source text, so the page stays responsive while it packs and it works
 * from file:// (no fetch, no server). If a worker cannot start, the same engine runs
 * on the page itself.
 *
 * Every result is bound to the state that asked for it. state.gen goes up whenever the
 * file or the mod choice changes, every engine reply is checked against the gen it was
 * asked under, and a stale reply is dropped. While a build or a send runs, the file,
 * the mod boxes and Build are locked. Before anything goes out over MIDI, the page checks
 * again, on this thread, that the bytes belong to the file and the choice on screen and
 * hash to the published sha256 (RYTM_PAGE_KNOWN, the same pins the engine uses).
 *
 * The page's own Web MIDI sender is EXPERIMENTAL and off: it has never touched a real unit.
 * Its markup lives in <template id="experimentalSenderTpl"> and all of its code is inside
 * mountSender(), which runs only when the address ends in #experimental-sender. Without that
 * flag the page has no sender controls and never asks for MIDI access.
 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var S = window.RytmSender;
  var SHA = window.RytmSha256;
  var KNOWN = window.RYTM_PAGE_KNOWN;

  var state = {
    gen: 0,            // bumped on every new file or new choice
    file: null,        // identify result (with .data)
    ident: null,       // the last identify result, accepted or not
    device: null,
    picked: {},
    rules: null,       // {byId, excludedBy} for the mod boxes
    recipe: null,
    built: null,       // {bytes, name, dlName, sha256, size, recipe, device, stockSha, gen}
    building: null,    // {gen, recipe}
    midi: null,
    sending: null      // {signal, kind}
  };
  function bump() { return ++state.gen; }
  function busy() { return !!(state.building || state.sending); }

  var DEVICE_TEXT = {
    mk1: { name: 'Analog Rytm MK1', os: '1.73', unit: 'an Analog Rytm MK1 (not an MKII)' },
    mk2: { name: 'Analog Rytm MKII', os: '1.73', unit: 'an Analog Rytm MKII (not an MK1)' },
    keys: { name: 'Analog Keys', os: '1.56', unit: 'an Analog Keys (not an Analog Four)' }
  };

  /* The experimental sender plugs in here (see mountSender). Off, all three do nothing. */
  var sender = { on: false, update: function () {}, labels: function () {}, identity: function () {} };
  function updateSend() { sender.update(); }
  function deviceLabels() { sender.labels(); }

  /* The step-4 notes for the unit in the file: only that unit's box is shown. With no
   * accepted file, all three are. */
  function showDevice(dev) {
    each('.devnote', function (n) { n.classList.toggle('hidden', !!dev && n.getAttribute('data-dev') !== dev); });
  }

  /* Where Elektron's own text for the startup-menu OS UPGRADE route is, per device
   * (corp/installer-re/evidence/elektron: the MK1 manual's section 14.4, the Analog Keys
   * manual's EARLY STARTUP MENU chapter, the MKII OS release notes). The MKII has no
   * section number here: its manual was not read. */
  var MANUAL_REF_ALL = 'Elektron\'s manuals: Analog Rytm MK1, section 14.4 "OS UPGRADE"; Analog Keys, "EARLY STARTUP MENU", "OS UPGRADE"; ' +
    'Analog Rytm MKII, "Upgrading from the STARTUP Menu" in its OS release notes';
  var MANUAL_REF = {
    mk1: 'Elektron\'s Analog Rytm MK1 manual, section 14.4 "OS UPGRADE"',
    keys: 'Elektron\'s Analog Keys manual, "EARLY STARTUP MENU", "OS UPGRADE"',
    mk2: 'Elektron\'s Analog Rytm MKII OS release notes, "Upgrading from the STARTUP Menu" (they call Transfer\'s CONNECTION-page button "LEGACY OS UPGRADE mode")'
  };

  /* This project's first-run checks and do-not list for each device's builds (public). */
  var START_HERE_BASE = 'https://github.com/bandersong/analog-rytm-chop/blob/main/flash/';
  var START_HERE = { mk1: 'START_HERE.md', mk2: 'MKII/START_HERE_MKII.md', keys: 'KEYS/START_HERE_KEYS.md' };

  /* ------------------------------ engine ------------------------------ */

  function workerMain() {
    var engine = RytmEngine.createEngine({
      sha: RytmSha256, zip: RytmZip, eft: RytmEftRun, createEFT: createEFT,
      known: RYTM_KNOWN, packageTexts: RYTM_PACKAGES, packageIndex: RYTM_INDEX
    });
    self.onmessage = function (ev) {
      var m = ev.data, id = m.id;
      Promise.resolve().then(function () {
        if (m.op === 'identify') return engine.identify(new Uint8Array(m.bytes), m.name);
        if (m.op === 'features') {
          return { features: engine.featuresFor(m.device),
                   recipes: engine.recipesFor(m.device).map(engine.packageInfo) };
        }
        if (m.op === 'resolve') {
          var r = engine.resolve(m.device, m.picked);
          if (r.ok) r.info = engine.packageInfo(r.recipe);
          return r;
        }
        if (m.op === 'build') {
          return engine.build(new Uint8Array(m.bytes), m.recipe, function (s) { self.postMessage({ id: id, progress: s }); });
        }
        throw new Error('unknown op ' + m.op);
      }).then(function (res) { self.postMessage({ id: id, result: res }); },
              function (e) { self.postMessage({ id: id, error: String(e && e.message || e) }); });
    };
    self.postMessage({ ready: true });
  }

  function makeEngine() {
    var src = window.RYTM_ENGINE_SRC;
    var seq = 0, pending = {}, worker = null, inline = null, ready;

    function viaInline() {
      if (!inline) {
        (0, eval)(src); // defines RytmEngine, createEFT, RYTM_* on window
        var fakeSelf = { postMessage: function (msg) { onMsg({ data: msg }); } };
        inline = { handler: null };
        // run workerMain against a local "self" (the page's own is left alone)
        (new Function('self', 'RytmEngine', 'RytmSha256', 'RytmZip', 'RytmEftRun', 'createEFT',
                      'RYTM_KNOWN', 'RYTM_PACKAGES', 'RYTM_INDEX', '(' + workerMain.toString() + ')();'))(
          fakeSelf, window.RytmEngine, window.RytmSha256, window.RytmZip, window.RytmEftRun, window.createEFT,
          window.RYTM_KNOWN, window.RYTM_PACKAGES, window.RYTM_INDEX);
        inline.handler = fakeSelf.onmessage;
      }
      return inline;
    }

    function onMsg(ev) {
      var m = ev.data;
      if (m.ready) return;
      var p = pending[m.id];
      if (!p) return;
      if (m.progress) { if (p.onProgress) p.onProgress(m.progress); return; }
      delete pending[m.id];
      if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
    }

    ready = new Promise(function (resolve) {
      try {
        var url = URL.createObjectURL(new Blob([src, '\n;(' + workerMain.toString() + ')();\n'], { type: 'text/javascript' }));
        worker = new Worker(url);
        var t = setTimeout(function () { worker = null; resolve('inline'); }, 8000);
        worker.onmessage = function (ev) {
          if (ev.data && ev.data.ready) { clearTimeout(t); worker.onmessage = onMsg; resolve('worker'); }
        };
        worker.onerror = function () { clearTimeout(t); worker = null; resolve('inline'); };
      } catch (e) {
        worker = null; resolve('inline');
      }
    });

    ready.then(function (mode) { window.RYTM_ENGINE_MODE = mode; }); // for diagnostics and the browser test

    function call(op, args, onProgress) {
      return ready.then(function (mode) {
        return new Promise(function (resolve, reject) {
          var id = ++seq;
          pending[id] = { resolve: resolve, reject: reject, onProgress: onProgress };
          var msg = Object.assign({ id: id, op: op }, args);
          if (mode === 'worker' && worker) worker.postMessage(msg);
          else setTimeout(function () { viaInline().handler({ data: msg }); }, 30);
        });
      });
    }
    return { call: call, mode: function () { return ready; } };
  }

  var engine = makeEngine();

  /* ------------------------------ helpers ----------------------------- */

  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k === 'cls') e.className = attrs[k];
      else e.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function unlock(id, on) {
    $(id).classList.toggle('locked', !on);
    $(id).setAttribute('aria-disabled', on ? 'false' : 'true');
  }
  function fmtMin(ms) {
    var s = Math.round(ms / 1000), m = Math.floor(s / 60);
    return m ? m + ' min ' + (s % 60) + ' s' : s + ' s';
  }
  function each(sel, fn) { Array.prototype.forEach.call(document.querySelectorAll(sel), fn); }
  function featureBoxes() { return $('features').querySelectorAll('input[type=checkbox]'); }

  /* Lock the inputs that would change the file, the choice or the build while a build
   * or a send runs. */
  function syncInputs() {
    var b = busy();
    $('file').disabled = b;
    $('drop').classList.toggle('busy', b);
    $('drop').setAttribute('aria-disabled', b ? 'true' : 'false');
    Array.prototype.forEach.call(featureBoxes(), function (cb) { cb.disabled = b; });
    $('buildBtn').disabled = b || !(state.file && state.recipe);
    $('busyNote').textContent = state.building
      ? 'Building: the file and the mod boxes are locked until the build ends.'
      : state.sending ? 'Sending: the file, the mod boxes and Build are locked until the send ends.' : '';
    if (!b) $('dropNote').textContent = ''; // "wait until it ends" no longer applies
  }

  /* The confirmation boxes describe one unit, one file and one moment: untick them
   * whenever any of those may have changed. */
  function resetConfirms() {
    each('.cf', function (c) { c.checked = false; });
  }

  /* ------------------------------ step 1 ------------------------------ */

  function readFile(f) {
    if (busy()) {
      $('dropNote').textContent = state.building
        ? 'A build is running. Wait until it ends, then drop the file again.'
        : 'A send is running. Wait until it ends, then drop the file again.';
      return;
    }
    $('dropNote').textContent = '';
    var g = resetChoice();
    var box = $('idResult');
    box.className = 'card';
    clear(box);
    box.appendChild(el('p', { text: 'Reading ' + f.name + '…' }));
    f.arrayBuffer().then(function (buf) {
      if (g !== state.gen) return null;
      return engine.call('identify', { bytes: buf, name: f.name });
    }).then(function (r) {
      if (!r || g !== state.gen) return; // another file came in meanwhile
      showIdentity(r, g);
    }, function (e) {
      if (g !== state.gen) return;
      clear(box); box.className = 'card bad';
      box.appendChild(el('p', { text: 'Something went wrong reading the file: ' + e.message }));
    });
  }

  function showIdentity(r, g) {
    var box = $('idResult');
    clear(box);
    box.className = 'card ' + (r.ok ? 'good' : 'bad');
    box.appendChild(el('p', {}, [el('b', { text: r.ok ? '✓ ' + r.title : '✗ ' + r.title })]));
    if (r.zip) box.appendChild(el('p', { cls: 'fine', text: 'Found in ' + r.zip + ': ' + r.name }));
    box.appendChild(el('p', { text: r.message }));
    if (r.sha256) box.appendChild(el('p', { cls: 'fine mono', text: 'sha256 ' + r.sha256 }));
    state.file = r.ok ? r : null;
    state.device = r.ok ? r.device : null;
    state.ident = r;
    showDevice(r.ok ? r.device : null);
    sender.identity(r);
    deviceLabels();
    resetConfirms();
    if (r.ok) {
      if (r.device === 'keys') {
        box.appendChild(el('p', { cls: 'fine', text: 'Elektron publishes this OS file for the Analog Four too, but the Analog Four is not supported: these mods were made and checked for the Analog Keys only.' }));
      }
      loadFeatures(g);
    }
    syncInputs();
    updateSend();
  }

  /* A new file: forget everything that belonged to the old one. Returns the new gen. */
  function resetChoice() {
    var g = bump();
    state.file = null; state.ident = null; state.device = null; state.picked = {}; state.rules = null; state.recipe = null; state.built = null;
    showDevice(null);
    unlock('s2', false); unlock('s3', false);
    Array.prototype.slice.call($('features').querySelectorAll('label')).forEach(function (n) { n.remove(); });
    clear($('recipeCard'));
    hideBuild();
    deviceLabels();
    resetConfirms();
    syncInputs();
    updateSend();
    return g;
  }

  /* ------------------------------ step 2 ------------------------------ */

  function loadFeatures(g) {
    engine.call('features', { device: state.device }).then(function (res) {
      if (g !== state.gen) return;
      var fs = $('features');
      Array.prototype.slice.call(fs.querySelectorAll('label')).forEach(function (n) { n.remove(); });
      var byId = {}, excludedBy = {};
      res.features.forEach(function (f) { byId[f.id] = f; });
      // both directions of every exclusion: ticking either side unticks the other
      res.features.forEach(function (f) {
        (f.excludes || []).forEach(function (x) { (excludedBy[x] = excludedBy[x] || []).push(f.id); });
      });
      state.rules = { byId: byId, excludedBy: excludedBy };
      res.features.forEach(function (f) {
        var cb = el('input', { type: 'checkbox', value: f.id });
        cb.addEventListener('change', function () { onPick(f, cb.checked); });
        var lab = el('label', { cls: 'feat' }, [cb, ' ' + f.label]);
        if (f.requires || f.excludes) lab.appendChild(el('small', { text: f.why || '' }));
        fs.appendChild(lab);
      });
      unlock('s2', true);
      syncInputs();
      resolveChoice();
    });
  }

  /* Ticking a box ticks what it requires (and what that requires), and unticks anything
   * that excludes, or is excluded by, any of them. */
  function onPick(f, on) {
    if (busy()) {
      // the boxes are disabled then; if a change still gets through, put them back as they were
      Array.prototype.forEach.call(featureBoxes(), function (cb) { cb.checked = !!state.picked[cb.value]; });
      return;
    }
    var byBox = {};
    Array.prototype.forEach.call(featureBoxes(), function (cb) { byBox[cb.value] = cb; });
    var R = state.rules || { byId: {}, excludedBy: {} };
    if (on) {
      var want = {}, todo = [f.id];
      while (todo.length) {
        var id = todo.pop();
        if (want[id]) continue;
        want[id] = true;
        ((R.byId[id] || {}).requires || []).forEach(function (x) { todo.push(x); });
      }
      Object.keys(want).forEach(function (id) {
        ((R.byId[id] || {}).excludes || []).concat(R.excludedBy[id] || []).forEach(function (x) {
          if (!want[x] && byBox[x]) byBox[x].checked = false;
        });
      });
      Object.keys(want).forEach(function (id) { if (byBox[id]) byBox[id].checked = true; });
    }
    state.picked = {};
    Array.prototype.forEach.call(featureBoxes(), function (cb) { if (cb.checked) state.picked[cb.value] = true; });
    resolveChoice();
  }

  function resolveChoice() {
    var g = bump();
    var picked = Object.keys(state.picked);
    // the old recipe and build no longer apply, whatever the answer is
    state.recipe = null; state.built = null;
    hideBuild(); resetConfirms(); unlock('s3', false);
    syncInputs(); updateSend();
    engine.call('resolve', { device: state.device, picked: picked }).then(function (r) {
      if (g !== state.gen) return; // the choice changed again meanwhile
      // keep the boxes in step with what the rules added
      Array.prototype.forEach.call(featureBoxes(), function (cb) {
        cb.checked = r.features.indexOf(cb.value) >= 0;
        if (cb.checked) state.picked[cb.value] = true; else delete state.picked[cb.value];
      });
      var card = $('recipeCard');
      clear(card);
      if (!r.ok) {
        card.className = 'card bad';
        card.appendChild(el('p', { text: r.message }));
        syncInputs(); updateSend();
        return;
      }
      state.recipe = r.recipe;
      card.className = 'card';
      card.appendChild(el('p', {}, [el('b', { text: r.info.title })]));
      card.appendChild(el('p', { text: r.info.summary }));
      card.appendChild(el('p', { cls: 'fine', text: 'Status: ' + r.info.status }));
      r.notes.forEach(function (n) { card.appendChild(el('p', { cls: 'fine', text: n })); });
      card.appendChild(el('p', { cls: 'fine mono', text: 'Result: ' + r.info.output.name + ' · sha256 ' + r.info.output.sha256 }));
      unlock('s3', true);
      syncInputs(); updateSend();
    }, function (e) {
      if (g !== state.gen) return;
      var card = $('recipeCard');
      clear(card); card.className = 'card bad';
      card.appendChild(el('p', { text: 'Something went wrong: ' + e.message }));
    });
  }

  /* ------------------------------ step 3 ------------------------------ */

  function hideBuild() {
    ['dlBox', 'checksBox', 'buildBar'].forEach(function (id) { $(id).classList.add('hidden'); });
    $('buildStatus').textContent = '';
    var a = $('dlLink');
    if (a.href && a.href.indexOf('blob:') === 0) URL.revokeObjectURL(a.href);
    a.removeAttribute('href');
  }

  /* The download name carries the first 8 hex digits of the file's sha256, so two
   * different builds of the same mod set never share a name in a Downloads folder. */
  function downloadName(name, sha) {
    return name.replace(/\.syx$/i, '') + '_' + sha.slice(0, 8) + '.syx';
  }

  $('buildBtn').addEventListener('click', function () {
    if (busy() || !state.file || !state.recipe) return;
    var g = state.gen, file = state.file, recipe = state.recipe, device = state.device;
    state.built = null;
    state.building = { gen: g, recipe: recipe };
    hideBuild(); resetConfirms();
    syncInputs(); updateSend();
    var bar = $('buildBar'), status = $('buildStatus');
    bar.classList.remove('hidden'); bar.value = 0;
    status.textContent = 'Starting…';
    var steps = 0;
    function current() {
      return g === state.gen && state.file === file && state.recipe === recipe && state.device === device;
    }
    engine.call('build', { bytes: file.data.slice().buffer, recipe: recipe }, function (s) {
      if (!current()) return;
      steps++; bar.value = Math.min(steps, bar.max);
      status.textContent = s + '…';
    }).then(function (r) {
      state.building = null;
      syncInputs();
      if (!current()) { updateSend(); return; } // a result for a file or choice no longer on screen
      bar.classList.add('hidden');
      $('checks').textContent = (r.checks || []).join('\n');
      $('checksBox').classList.remove('hidden');
      if (!r.ok) {
        status.textContent = '';
        status.appendChild(el('span', { cls: 'bad-text', text: 'Stopped: ' + r.message }));
        $('checksBox').open = true;
        updateSend();
        return;
      }
      if (r.recipe !== recipe || r.device !== device) {
        status.textContent = '';
        status.appendChild(el('span', { cls: 'bad-text', text: 'Stopped: the engine answered for another build. Nothing is offered.' }));
        updateSend();
        return;
      }
      status.textContent = 'Done. Every check passed.';
      var dl = downloadName(r.name, r.sha256);
      state.built = { bytes: r.bytes, name: r.name, dlName: dl, sha256: r.sha256, size: r.size,
                      recipe: r.recipe, device: r.device, stockSha: file.sha256, gen: g };
      resetConfirms();
      var blob = new Blob([r.bytes], { type: 'application/octet-stream' });
      var a = $('dlLink');
      a.href = URL.createObjectURL(blob);
      a.setAttribute('download', dl);
      a.textContent = 'Download ' + dl;
      $('dlName').textContent = dl;
      $('dlSha').textContent = 'sha256 ' + r.sha256 + ' (' + r.size + ' bytes) · the project\'s name for it: ' + r.name;
      var next = $('dlNext');
      clear(next);
      if (START_HERE[r.device]) {
        var url = START_HERE_BASE + START_HERE[r.device];
        next.appendChild(document.createTextNode('Before you flash this build, read its first-run checks and what not to do: '));
        next.appendChild(el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: url.replace(/^https:\/\//, '') }));
        next.appendChild(document.createTextNode(' (opens the project\'s page on GitHub; this page itself needs no network).'));
      }
      $('dlBox').classList.remove('hidden');
      updateSend();
    }, function (e) {
      state.building = null;
      syncInputs();
      if (!current()) { updateSend(); return; }
      bar.classList.add('hidden');
      status.textContent = 'Something went wrong: ' + e.message;
      updateSend();
    });
  });

  /* ---------------- EXPERIMENTAL: the Web MIDI sender (off unless #experimental-sender) ---------------- */

  function mountSender() {
    if (sender.on) return;
    sender.on = true;
    var tpl = document.getElementById('experimentalSenderTpl');
    var host = $('s5');
    if (!tpl || !host) { sender.on = false; return; }
    host.parentNode.insertBefore(tpl.content.cloneNode(true), host);

    function senderLabels() {
      var d = state.device && DEVICE_TEXT[state.device];
      $('cfDeviceText').textContent = d
        ? 'This unit is ' + d.unit + '.'
        : 'This unit is the one the file in step 1 is for (drop a file first).';
      $('cfOsText').textContent = d
        ? 'It runs OS ' + d.os + ' now (Elektron\'s ' + d.os + ', or a ' + d.os + ' build from this page), not an older or newer OS.'
        : 'It runs the OS version of the file in step 1.';
      $('cfDevice').disabled = !d;
      $('cfOs').disabled = !d;
      $('sendBuild').textContent = d ? 'Send the ' + d.name + ' build' : 'Send the build';
      $('sendStock').textContent = d ? 'Recover: send Elektron\'s original ' + d.name + ' file' : 'Recover: send Elektron\'s original file';
    }
    function senderIdentity(r) {
      // the key's name on this unit; until a file is accepted, both names
      var func = !r || !r.ok ? 'FUNC (FUNCTION on the Analog Keys)' : r.device === 'keys' ? 'FUNCTION' : 'FUNC';
      $('funcKey').textContent = func;
      each('.funcName', function (n) { n.textContent = func; });
      var manual = r && r.ok && MANUAL_REF[r.device] ? MANUAL_REF[r.device] : MANUAL_REF_ALL;
      each('.manualRef', function (n) { n.textContent = manual; });
    }
    /* ------------------------------ step 4 ------------------------------ */

    var hasMidi = typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function';
    $('midiSupport').textContent = hasMidi ? 'this browser: yes' : 'this browser: no';
    if (!hasMidi) {
      $('midiBtn').disabled = true;
      $('midiStatus').textContent = 'This browser has no Web MIDI. Use Chrome or Edge on a computer.';
    }

    $('midiBtn').addEventListener('click', function () {
      $('midiStatus').textContent = 'Asking…';
      navigator.requestMIDIAccess({ sysex: true }).then(function (access) {
        state.midi = access;
        $('midiStatus').textContent = 'MIDI allowed.';
        access.onstatechange = listPorts;
        listPorts();
      }, function (e) {
        $('midiStatus').textContent = 'MIDI access was not given (' + (e && e.name ? e.name : 'denied') + '). ' +
          'The page needs MIDI with SysEx to send an OS file. If the browser asked and the answer was no: ' +
          'allow MIDI for this page in the browser\'s site settings, then reload the page. ' +
          'If no question appeared, the browser may not offer MIDI to a page opened from a file: in a terminal, ' +
          'in the folder that holds this page, run  python3 -m http.server --bind 127.0.0.1 8000  then open ' +
          'http://localhost:8000/ in Chrome or Edge and click this page\'s file name.';
      });
    });

    function listPorts() {
      var sel = $('portSel'), keep = sel.value;
      clear(sel);
      var outs = [];
      state.midi.outputs.forEach(function (o) { outs.push(o); });
      if (!outs.length) {
        sel.appendChild(el('option', { value: '', text: '(no MIDI outputs found: plug in your interface)' }));
        sel.disabled = true;
      } else {
        sel.appendChild(el('option', { value: '', text: 'choose your MIDI interface…' }));
        outs.forEach(function (o) {
          sel.appendChild(el('option', { value: o.id, text: o.name + (o.manufacturer ? ' (' + o.manufacturer + ')' : '') }));
        });
        sel.disabled = false;
        if (keep) sel.value = keep;
      }
      portWarning();
      updateSend();
    }

    function selectedPort() {
      if (!state.midi) return null;
      var id = $('portSel').value, found = null;
      state.midi.outputs.forEach(function (o) { if (o.id === id) found = o; });
      return found;
    }

    function portWarning() {
      var p = selectedPort();
      $('portWarn').textContent = (p && /elektron|analog rytm|analog keys|analog four/i.test(p.name))
        ? 'This looks like the unit\'s own USB port. In the startup menu the unit only listens on its DIN MIDI IN: pick your MIDI interface instead.'
        : '';
    }
    $('portSel').addEventListener('change', function () { portWarning(); updateSend(); });
    $('gapSel').addEventListener('change', updateSend);
    each('.cf', function (c) { c.addEventListener('change', updateSend); });

    function ticked(sel) {
      return Array.prototype.every.call(document.querySelectorAll(sel), function (c) { return c.checked && !c.disabled; });
    }

    function updateSend() {
      var port = selectedPort();
      var d = state.device && DEVICE_TEXT[state.device];
      var stockOk = !!(port && !busy() && state.file && state.file.kind === 'stock' && d);
      var recoverReady = stockOk && ticked('.cf:not(.cf-build)');
      $('sendStock').disabled = !recoverReady;
      $('sendBuild').disabled = !(recoverReady && state.built && ticked('.cf'));
      var gap = +$('gapSel').value, parts = [];
      [['the build', state.built && state.built.bytes], ['the original file', state.file && state.file.data]].forEach(function (x) {
        if (!x[1]) return;
        try {
          var msgs = S.splitSysex(x[1]);
          parts.push(x[0] + ': ' + msgs.length + ' messages, about ' + fmtMin(S.estimateMs(msgs, gap)));
        } catch (e) { /* not a sendable file */ }
      });
      $('estimate').textContent = parts.join(' · ');
      var what = [];
      if (state.built && d) what.push('Send the ' + d.name + ' build = ' + state.built.dlName + ' (checked).');
      if (state.file && state.file.kind === 'stock' && d) what.push('Recover = Elektron\'s original ' + d.name + ' file, ' + state.file.name + '.');
      if (!state.built) what.push('Build in step 3 to enable "Send the build".');
      if (d) what.push('Recover needs the first five boxes ticked; sending the build needs all six.');
      $('sendWhat').textContent = what.join(' ');
    }

    /* The last word before anything goes out: recomputed here, on this thread, from the
     * bytes themselves. Returns {bytes, label} or {why}. */
    function preflight(kind) {
      var d = state.device && DEVICE_TEXT[state.device];
      if (busy()) return { why: 'Something else is running.' };
      if (!state.file || !d) return { why: 'No OS file in step 1.' };
      var fileSha = SHA.sha256hex(state.file.data);
      var stockPin = KNOWN.stock.filter(function (s) { return s.sha256 === fileSha && s.supported; })[0];
      if (!stockPin || stockPin.device !== state.device || fileSha !== state.file.sha256) {
        return { why: 'The file in step 1 is not Elektron\'s original file for the ' + d.name + '.' };
      }
      if (kind === 'stock') return { bytes: state.file.data, label: 'Elektron\'s original ' + d.name + ' file' };
      var b = state.built;
      if (!b) return { why: 'There is no checked build.' };
      if (b.gen !== state.gen || b.device !== state.device || b.recipe !== state.recipe || b.stockSha !== fileSha) {
        return { why: 'The build does not belong to the file and the mods shown on the page now. Press Build again.' };
      }
      var pin = KNOWN.recipes.filter(function (r) { return r.id === b.recipe; })[0];
      if (!pin || pin.device !== state.device) return { why: 'The build is not a published build for the ' + d.name + '.' };
      var outSha = SHA.sha256hex(b.bytes);
      if (outSha !== pin.output_sha256 || outSha !== b.sha256) {
        return { why: 'The build\'s bytes do not hash to the published sha256 (' + outSha.slice(0, 16) + '…). Nothing was sent.' };
      }
      return { bytes: b.bytes, label: 'the ' + d.name + ' build ' + b.dlName };
    }

    function startSend(kind) {
      var port = selectedPort();
      if (!port) return;
      var pf = preflight(kind);
      if (!pf.bytes) {
        if (kind === 'build') { state.built = null; hideBuild(); }
        resetConfirms(); updateSend();
        alert('Not sent: ' + pf.why);
        return;
      }
      var msgs, label = pf.label;
      try { msgs = S.splitSysex(pf.bytes); } catch (e) { alert('This file cannot be sent: ' + e.message); return; }
      var signal = { aborted: false };
      state.sending = { signal: signal, kind: kind };
      syncInputs(); updateSend();
      $('sendBox').classList.remove('hidden');
      $('sendDone').classList.add('hidden');
      $('abortBtn').disabled = false;
      $('sendBar').max = msgs.length; $('sendBar').value = 0;
      $('sendStatus').textContent = 'Starting ' + label + '…';
      var lock = null;
      if (navigator.wakeLock && navigator.wakeLock.request) {
        navigator.wakeLock.request('screen').then(function (l) { lock = l; }, function () { /* not available */ });
      }
      var gap = +$('gapSel').value;
      function finish() {
        if (lock) lock.release().catch(function () {});
        state.sending = null;
        $('sendBox').classList.add('hidden');
        $('bgWarn').classList.add('hidden');
        resetConfirms(); // the unit is no longer on the OS UPGRADE screen
        syncInputs(); updateSend();
      }
      S.send({
        output: port, messages: msgs, gapMs: gap, aheadMs: 1000, signal: signal,
        onProgress: function (p) {
          $('sendBar').value = p.sent;
          if (!signal.aborted) {
            $('sendStatus').textContent = 'Sending ' + label + ': message ' + p.sent + ' of ' + p.total +
              ' · ' + fmtMin(p.etaMs) + ' left';
          }
        },
        onStopping: function (s) {
          $('sendStatus').textContent = (s.why === 'error' ? 'Error: ' : 'Stopping: ') +
            'letting the data already handed to the browser leave the cable (' + fmtMin(s.untilMs) + ')…';
        }
      }).then(function (r) {
        finish();
        var done = $('sendDone');
        done.classList.remove('hidden');
        clear(done);
        if (r.aborted) {
          done.className = 'card bad';
          done.appendChild(el('p', { text: 'Stopped after ' + r.sent + ' of ' + r.total + ' messages (the data already queued has now left). ' +
            'The unit has only part of the file. If it is still waiting or receiving, switch it off and start again from step 1 of this section. ' +
            'If its screen says it is upgrading, don\'t switch it off: wait.' }));
        } else {
          done.className = 'card good';
          done.appendChild(el('p', { text: 'The whole file has been sent (' + r.total + ' messages). The unit now installs it and restarts by itself. ' +
            'Don\'t switch it off until it has restarted. If it shows an error instead, start again from step 1 of this section with a longer pause, ' +
            'or send the file with Elektron Transfer (see the box at the top of this section).' }));
        }
      }, function (e) {
        finish();
        $('sendStatus').textContent = '';
        alert('Sending failed: ' + e.message);
      });
    }

    $('sendBuild').addEventListener('click', function () { startSend('build'); });
    $('sendStock').addEventListener('click', function () { startSend('stock'); });
    $('abortBtn').addEventListener('click', function () {
      if (!state.sending) return;
      state.sending.signal.aborted = true;
      $('abortBtn').disabled = true;
      $('sendStatus').textContent = 'Stopping…';
    });
    document.addEventListener('visibilitychange', function () {
      $('bgWarn').classList.toggle('hidden', !(state.sending && document.hidden));
    });
    window.addEventListener('beforeunload', function (ev) {
      if (state.sending) { ev.preventDefault(); ev.returnValue = ''; }
    });

    sender.labels = senderLabels;
    sender.identity = senderIdentity;
    sender.update = updateSend;
    senderIdentity(state.ident);
    senderLabels();
    resetConfirms();
    updateSend();
  }

  /* The flag: the address ends in #experimental-sender. Read at load and when the hash changes. */
  function senderFlag() { return /^#experimental-sender$/.test(location.hash || ''); }
  if (senderFlag()) mountSender();
  window.addEventListener('hashchange', function () { if (senderFlag()) mountSender(); });

  /* ------------------------------ drop -------------------------------- */

  var drop = $('drop');
  ['dragenter', 'dragover'].forEach(function (t) {
    drop.addEventListener(t, function (ev) { ev.preventDefault(); if (!busy()) drop.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (t) {
    drop.addEventListener(t, function (ev) { ev.preventDefault(); drop.classList.remove('over'); });
  });
  drop.addEventListener('drop', function (ev) {
    var f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
    if (f) readFile(f);
  });
  drop.addEventListener('keydown', function (ev) {
    if (busy()) return;
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); $('file').click(); }
  });
  drop.addEventListener('click', function (ev) {
    if (busy()) return;
    if (ev.target === drop || ev.target.tagName === 'P') $('file').click();
  });
  $('file').addEventListener('change', function () {
    var f = this.files[0];
    this.value = ''; // the same file can be chosen again later
    if (f) readFile(f);
  });
  // a file dropped anywhere else should not navigate away from the page
  window.addEventListener('dragover', function (ev) { ev.preventDefault(); });
  window.addEventListener('drop', function (ev) { ev.preventDefault(); });

  deviceLabels();
  syncInputs();
  updateSend();
})();
