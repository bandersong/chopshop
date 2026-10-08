/* app.js - the page: drop a file, choose mods, build and check, send over MIDI.
 *
 * Part of the browser installer (working name "web"). Copyright (C) 2026 bandersong.
 * SPDX-License-Identifier: GPL-3.0-or-later.
 *
 * The engine (EFT in WebAssembly, the packages, the checks) runs in a Web Worker made
 * from its own source text, so the page stays responsive while it packs and it works
 * from file:// (no fetch, no server). If a worker cannot start, the same engine runs
 * on the page itself.
 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var S = window.RytmSender;

  var state = {
    file: null,        // identify result (with .data)
    device: null,
    picked: {},
    recipe: null,
    built: null,       // {bytes, name, sha256, recipe}
    midi: null,
    sending: null      // {signal}
  };

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

  /* ------------------------------ step 1 ------------------------------ */

  function readFile(f) {
    var box = $('idResult');
    box.className = 'card';
    clear(box);
    box.appendChild(el('p', { text: 'Reading ' + f.name + '…' }));
    resetChoice();
    f.arrayBuffer().then(function (buf) {
      return engine.call('identify', { bytes: buf, name: f.name });
    }).then(showIdentity, function (e) {
      clear(box); box.className = 'card bad';
      box.appendChild(el('p', { text: 'Something went wrong reading the file: ' + e.message }));
    });
  }

  function showIdentity(r) {
    var box = $('idResult');
    clear(box);
    box.className = 'card ' + (r.ok ? 'good' : 'bad');
    box.appendChild(el('p', {}, [el('b', { text: r.ok ? '✓ ' + r.title : '✗ ' + r.title })]));
    if (r.zip) box.appendChild(el('p', { cls: 'fine', text: 'Found in ' + r.zip + ': ' + r.name }));
    box.appendChild(el('p', { text: r.message }));
    if (r.sha256) box.appendChild(el('p', { cls: 'fine mono', text: 'sha256 ' + r.sha256 }));
    state.file = r.ok ? r : null;
    state.device = r.ok ? r.device : null;
    // the key's name on this unit; until a file is accepted, both names
    var func = !r.ok ? 'FUNC (FUNCTION on the Analog Keys)' : r.device === 'keys' ? 'FUNCTION' : 'FUNC';
    $('funcKey').textContent = func;
    Array.prototype.forEach.call(document.querySelectorAll('.funcName'), function (n) { n.textContent = func; });
    if (r.ok) {
      if (r.device === 'keys') {
        box.appendChild(el('p', { cls: 'fine', text: 'The same OS file also runs the Analog Four MK1. These mods were made and checked for the Analog Keys only.' }));
      }
      loadFeatures();
    }
    updateSend();
  }

  function resetChoice() {
    state.file = null; state.device = null; state.picked = {}; state.recipe = null; state.built = null;
    unlock('s2', false); unlock('s3', false);
    hideBuild();
    updateSend();
  }

  /* ------------------------------ step 2 ------------------------------ */

  function loadFeatures() {
    engine.call('features', { device: state.device }).then(function (res) {
      var fs = $('features');
      Array.prototype.slice.call(fs.querySelectorAll('label')).forEach(function (n) { n.remove(); });
      res.features.forEach(function (f) {
        var cb = el('input', { type: 'checkbox', value: f.id });
        cb.addEventListener('change', function () { onPick(f, cb.checked); });
        var lab = el('label', { cls: 'feat' }, [cb, ' ' + f.label]);
        if (f.requires || f.excludes) lab.appendChild(el('small', { text: f.why || '' }));
        fs.appendChild(lab);
      });
      unlock('s2', true);
      resolveChoice();
    });
  }

  function onPick(f, on) {
    var feats = $('features').querySelectorAll('input[type=checkbox]');
    var byId = {};
    Array.prototype.forEach.call(feats, function (cb) { byId[cb.value] = cb; });
    if (on) {
      (f.excludes || []).forEach(function (x) { if (byId[x]) byId[x].checked = false; });
      // anything that excludes this one goes too
      Array.prototype.forEach.call(feats, function (cb) {
        if (cb.value !== f.id && cb.checked && cb.dataset.excl && cb.dataset.excl.split(',').indexOf(f.id) >= 0) cb.checked = false;
      });
      (f.requires || []).forEach(function (x) { if (byId[x]) byId[x].checked = true; });
    }
    state.picked = {};
    Array.prototype.forEach.call(feats, function (cb) { if (cb.checked) state.picked[cb.value] = true; });
    resolveChoice();
  }

  function resolveChoice() {
    var picked = Object.keys(state.picked);
    engine.call('resolve', { device: state.device, picked: picked }).then(function (r) {
      // keep the boxes in step with what the rules added
      Array.prototype.forEach.call($('features').querySelectorAll('input[type=checkbox]'), function (cb) {
        cb.checked = r.features.indexOf(cb.value) >= 0;
        if (cb.checked) state.picked[cb.value] = true; else delete state.picked[cb.value];
      });
      var card = $('recipeCard');
      clear(card);
      state.built = null; hideBuild();
      if (!r.ok) {
        card.className = 'card bad';
        card.appendChild(el('p', { text: r.message }));
        state.recipe = null; unlock('s3', false);
        updateSend();
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
      updateSend();
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

  $('buildBtn').addEventListener('click', function () {
    if (!state.file || !state.recipe) return;
    hideBuild();
    state.built = null;
    updateSend();
    var btn = $('buildBtn'), bar = $('buildBar'), status = $('buildStatus');
    btn.disabled = true;
    bar.classList.remove('hidden'); bar.value = 0;
    status.textContent = 'Starting…';
    var steps = 0;
    engine.call('build', { bytes: state.file.data.slice().buffer, recipe: state.recipe }, function (s) {
      steps++; bar.value = Math.min(steps, bar.max);
      status.textContent = s + '…';
    }).then(function (r) {
      btn.disabled = false;
      bar.classList.add('hidden');
      $('checks').textContent = (r.checks || []).join('\n');
      $('checksBox').classList.remove('hidden');
      if (!r.ok) {
        status.textContent = '';
        status.appendChild(el('span', { cls: 'bad-text', text: 'Stopped: ' + r.message }));
        $('checksBox').open = true;
        return;
      }
      status.textContent = 'Done. Every check passed.';
      state.built = r;
      var blob = new Blob([r.bytes], { type: 'application/octet-stream' });
      var a = $('dlLink');
      a.href = URL.createObjectURL(blob);
      a.setAttribute('download', r.name);
      a.textContent = 'Download ' + r.name;
      $('dlName').textContent = r.name;
      $('dlSha').textContent = 'sha256 ' + r.sha256 + ' (' + r.size + ' bytes)';
      $('dlBox').classList.remove('hidden');
      updateSend();
    }, function (e) {
      btn.disabled = false;
      bar.classList.add('hidden');
      status.textContent = 'Something went wrong: ' + e.message;
    });
  });

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
      $('midiStatus').textContent = 'MIDI access was not given (' + (e && e.name ? e.name : 'denied') +
        '). The page needs SysEx permission to send an OS file. If no prompt appeared, see the README (opening the page from a local web server).';
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
  Array.prototype.forEach.call(document.querySelectorAll('.cf'), function (c) { c.addEventListener('change', updateSend); });

  function confirmsTicked() {
    return Array.prototype.every.call(document.querySelectorAll('.cf'), function (c) { return c.checked; });
  }

  function updateSend() {
    var port = selectedPort(), ready = !!port && confirmsTicked() && !state.sending;
    $('sendBuild').disabled = !(ready && state.built);
    $('sendStock').disabled = !(ready && state.file && state.file.kind === 'stock');
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
    if (state.built) what.push('Send the build = ' + state.built.name + ' (checked).');
    if (state.file && state.file.kind === 'stock') what.push('Recover = Elektron\'s original ' + state.file.name + '.');
    if (!state.built) what.push('Build in step 3 to enable "Send the build".');
    $('sendWhat').textContent = what.join(' ');
  }

  function startSend(bytes, label) {
    var port = selectedPort();
    if (!port) return;
    var msgs;
    try { msgs = S.splitSysex(bytes); } catch (e) { alert('This file cannot be sent: ' + e.message); return; }
    var signal = { aborted: false };
    state.sending = { signal: signal };
    updateSend();
    $('sendBox').classList.remove('hidden');
    $('sendDone').classList.add('hidden');
    $('sendBar').max = msgs.length; $('sendBar').value = 0;
    $('sendStatus').textContent = 'Starting ' + label + '…';
    var lock = null;
    if (navigator.wakeLock && navigator.wakeLock.request) {
      navigator.wakeLock.request('screen').then(function (l) { lock = l; }, function () { /* not available */ });
    }
    var gap = +$('gapSel').value;
    S.send({
      output: port, messages: msgs, gapMs: gap, aheadMs: 1000, signal: signal,
      onProgress: function (p) {
        $('sendBar').value = p.sent;
        $('sendStatus').textContent = 'Sending ' + label + ': message ' + p.sent + ' of ' + p.total +
          ' · ' + fmtMin(p.etaMs) + ' left';
      }
    }).then(function (r) {
      if (lock) lock.release().catch(function () {});
      state.sending = null;
      $('sendBox').classList.add('hidden');
      var done = $('sendDone');
      done.classList.remove('hidden');
      clear(done);
      if (r.aborted) {
        done.className = 'card bad';
        done.appendChild(el('p', { text: 'Stopped after ' + r.sent + ' of ' + r.total + ' messages. Up to a second of data may still go out. ' +
          'The unit has only part of the file. If it is still waiting or receiving, switch it off and start again from step 1. ' +
          'If its screen says it is upgrading, don\'t switch it off: wait.' }));
      } else {
        done.className = 'card good';
        done.appendChild(el('p', { text: 'The whole file has been sent (' + r.total + ' messages). The unit now installs it and restarts by itself. ' +
          'Don\'t switch it off until it has restarted. If it shows an error instead, start again from step 1 with a longer pause.' }));
      }
      updateSend();
    }, function (e) {
      if (lock) lock.release().catch(function () {});
      state.sending = null;
      $('sendBox').classList.add('hidden');
      $('sendStatus').textContent = '';
      alert('Sending failed: ' + e.message);
      updateSend();
    });
  }

  $('sendBuild').addEventListener('click', function () {
    if (state.built) startSend(state.built.bytes, state.built.name);
  });
  $('sendStock').addEventListener('click', function () {
    if (state.file && state.file.kind === 'stock') startSend(state.file.data, 'Elektron\'s original file');
  });
  $('abortBtn').addEventListener('click', function () {
    if (state.sending) state.sending.signal.aborted = true;
  });
  document.addEventListener('visibilitychange', function () {
    $('bgWarn').classList.toggle('hidden', !(state.sending && document.hidden));
  });
  window.addEventListener('beforeunload', function (ev) {
    if (state.sending) { ev.preventDefault(); ev.returnValue = ''; }
  });

  /* ------------------------------ drop -------------------------------- */

  var drop = $('drop');
  ['dragenter', 'dragover'].forEach(function (t) {
    drop.addEventListener(t, function (ev) { ev.preventDefault(); drop.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (t) {
    drop.addEventListener(t, function (ev) { ev.preventDefault(); drop.classList.remove('over'); });
  });
  drop.addEventListener('drop', function (ev) {
    var f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
    if (f) readFile(f);
  });
  drop.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); $('file').click(); }
  });
  drop.addEventListener('click', function (ev) { if (ev.target === drop || ev.target.tagName === 'P') $('file').click(); });
  $('file').addEventListener('change', function () { if (this.files[0]) readFile(this.files[0]); });
  // a file dropped anywhere else should not navigate away from the page
  window.addEventListener('dragover', function (ev) { ev.preventDefault(); });
  window.addEventListener('drop', function (ev) { ev.preventDefault(); });

  updateSend();
})();
