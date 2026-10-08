/* engine.js - identify a stock OS file, apply a mod package, rebuild and verify.
 *
 * Part of the browser installer (working name "web"). Copyright (C) 2026 bandersong.
 * SPDX-License-Identifier: GPL-3.0-or-later.
 *
 * The checks mirror rytm1_mods' tools/build.py and tools/verify.py (read for their
 * rules; no code taken): stock checksum; MAIN OS size and checksum; every site holds
 * the stock bytes it expects; nothing written into a never-write range; the image
 * differs from stock only inside the declared claims; every detour jumps where it
 * should, its displaced instructions are re-emitted and it rejoins past them; the
 * untouched stock .syx rebuilds byte for byte (null repack); the new .syx unpacks to
 * the patched image and carries the stock's other sections unchanged; and the result
 * is the published file, by sha256. The download is offered only when all pass.
 *
 * Inputs the engine trusts are pinned separately from the packages: known.json (stock
 * checksums, the published output checksums, the never-write ranges) and the package
 * index (sha256 of each package text). A package that does not hash to its index entry
 * is refused before it is read.
 */
(function (root) {
  'use strict';

  var SITE_KEY_LABEL = 'rytm-installer site key v1';
  var PKG_FORMAT = 'rytm-installer-package/1';
  var MAIN = 'section_3_MAIN_OS.bin';

  function hex8(n) { return '0x' + ('00000000' + (n >>> 0).toString(16)).slice(-8); }
  function num(x) { return typeof x === 'number' ? x : parseInt(x, 16); }

  function b64(s) {
    var bin = atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function same(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function indexOfBytes(hay, needle) {
    if (needle.length === 0) return 0;
    outer: for (var i = 0; i + needle.length <= hay.length; i++) {
      for (var j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
      return i;
    }
    return -1;
  }

  function be32(n) { return new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]); }

  var DEVICE_WORDS = {
    7: 'Analog Rytm MK1', 12: 'Analog Rytm MKII', 6: 'Analog Four MK1 / Analog Keys',
    11: 'Analog Four MKII', 4: 'Analog Four (TM-1 id)'
  };

  function createEngine(deps) {
    var SHA = deps.sha, ZIP = deps.zip, EFT = deps.eft, createEFT = deps.createEFT;
    var known = deps.known, texts = deps.packageTexts, index = deps.packageIndex;
    var enc = new TextEncoder();

    function knownStock(sha) { return known.stock.filter(function (s) { return s.sha256 === sha; })[0]; }
    function deviceName(dev) { return known.devices[dev] ? known.devices[dev].name : dev; }
    function supportedLine() {
      return 'This installer supports Elektron\'s own OS 1.73 file for the Analog Rytm MK1 or MKII, ' +
             'and OS 1.56 for the Analog Keys.';
    }

    /* ---------------------------- identify ---------------------------- */

    async function identifySyx(bytes, name) {
      var sha = SHA.sha256hex(bytes);
      var base = { name: name, sha256: sha, size: bytes.length };
      var st = knownStock(sha);
      if (st && st.supported) {
        return Object.assign(base, {
          ok: true, kind: 'stock', device: st.device, os: st.os,
          title: deviceName(st.device) + ', OS ' + st.os + ' (Elektron\'s original file)',
          message: 'This is Elektron\'s original OS ' + st.os + ' file for the ' + deviceName(st.device) +
                   ', byte for byte. Keep a copy of it: it is also your recovery file.'
        });
      }
      if (st && !st.supported) {
        var want = st.device === 'keys' ? '1.56' : '1.73';
        return Object.assign(base, {
          ok: false, kind: 'stock-old', device: st.device, os: st.os,
          title: deviceName(st.device) + ', OS ' + st.os,
          message: 'This is Elektron\'s OS ' + st.os + ' file for the ' + deviceName(st.device) +
                   '. The mods are built for OS ' + want + ', so they need Elektron\'s ' + want +
                   ' file instead (and your unit needs to run ' + want + ' too). If your unit is on ' + st.os +
                   ': first install Elektron\'s original ' + want + ' file the normal way (Elektron Transfer, its drop page), ' +
                   'then drop that ' + want + ' file here and flash the Control build first.' +
                   (st.device === 'keys' ? '' : ' Elektron\'s site now offers only 1.74 for the Rytm, so the 1.73 file has to be one you ' +
                   'already have; this page checks it by its checksum.')
        });
      }
      var rec = known.recipes.filter(function (r) { return r.output_sha256 === sha; })[0];
      if (rec) {
        return Object.assign(base, {
          ok: false, kind: 'our-output', device: rec.device,
          title: 'A file this installer builds (' + rec.id + ')',
          message: 'This is already a modded file made by this project, not Elektron\'s original. ' +
                   'Drop Elektron\'s own OS file: the page builds the mods from it.'
        });
      }
      var other = (known.other_outputs || []).filter(function (r) { return r.sha256 === sha; })[0];
      if (other) {
        return Object.assign(base, {
          ok: false, kind: 'our-output', title: 'An older file from this project',
          message: 'This is ' + other.what + ', not Elektron\'s original. Drop Elektron\'s own OS file instead.'
        });
      }
      if (!(bytes.length > 0 && bytes[0] === 0xf0)) {
        return Object.assign(base, {
          ok: false, kind: 'not-syx', title: 'Not an OS file',
          message: 'This file is not a MIDI SysEx (.syx) OS file. ' + supportedLine()
        });
      }
      var info = await EFT.identify(createEFT, bytes);
      if (!info || !info.sysex) {
        return Object.assign(base, {
          ok: false, kind: 'unreadable', title: 'Not a readable Elektron OS file',
          message: 'This .syx could not be read as an Elektron OS file. ' + supportedLine()
        });
      }
      var dev = info.device, ver = info.version || '?';
      var what = DEVICE_WORDS[dev] || info.device_name || ('device ' + dev);
      var ourDev = dev === 7 ? 'mk1' : dev === 12 ? 'mk2' : dev === 6 ? 'keys' : null;
      var target = ourDev === 'keys' ? '1.56' : '1.73';
      if (dev === 11) {
        return Object.assign(base, {
          ok: false, kind: 'other-device', title: 'Analog Four MKII, OS ' + ver,
          message: 'This is an OS file for the Analog Four MKII. The Analog Keys mods are for the ' +
                   'Analog Keys only: never send them to an Analog Four MKII. ' + supportedLine()
        });
      }
      if (!ourDev) {
        return Object.assign(base, {
          ok: false, kind: 'other-device', title: what + ', OS ' + ver,
          message: 'This is an OS file for the ' + what + '. ' + supportedLine()
        });
      }
      var newer = verCmp(ver, target) > 0;
      if (newer) {
        return Object.assign(base, {
          ok: false, kind: 'newer', device: ourDev, os: ver,
          title: what + ', OS ' + ver,
          message: 'Your file is OS ' + ver + ' for the ' + what + ': not supported yet. ' +
                   'Do not install it on your unit. These mods are built for OS ' + target +
                   ', and going back from a newer OS to an older one is a downgrade, which Elektron ' +
                   'does not support.' +
                   (ourDev === 'keys' ? '' : ' Elektron\'s site now offers only 1.74 for the Rytm. If your unit is on 1.73, ' +
                   'keep it there and drop the 1.73 file you already have. If it is already on 1.74, these mods ' +
                   'can\'t be installed on it yet.')
        });
      }
      return Object.assign(base, {
        ok: false, kind: info.all_ok ? 'unknown-version' : 'damaged', device: ourDev, os: ver,
        title: what + ', OS ' + ver + ' (not a file this installer knows)',
        message: (ver === target
          ? 'This file says it is OS ' + ver + ' for the ' + what + ', but it is not Elektron\'s ' +
            'original file byte for byte' + (info.all_ok ? '' : ' (its checksums do not even add up: it is damaged)') +
            '. Use the file exactly as Elektron published it.'
          : 'This is OS ' + ver + ' for the ' + what + '. The mods are built for OS ' + target +
            ' only, so they need Elektron\'s ' + target + ' file.')
      });
    }

    function verCmp(a, b) {
      var pa = String(a).match(/\d+/g) || [], pb = String(b).match(/\d+/g) || [];
      for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
        var x = +(pa[i] || 0), y = +(pb[i] || 0);
        if (x !== y) return x < y ? -1 : 1;
      }
      return 0;
    }

    /* identify(bytes, name) -> one result, or for a .zip {zip: true, entries, chosen} */
    async function identify(bytes, name) {
      if (ZIP.isZip(bytes)) {
        var entries;
        try {
          entries = await ZIP.syxEntries(bytes);
        } catch (e) {
          return { ok: false, kind: 'zip-error', name: name, title: 'Could not open the .zip',
                   message: String(e.message || e) + '. You can also unzip it yourself and drop the .syx.' };
        }
        if (!entries.length) {
          return { ok: false, kind: 'zip-empty', name: name, title: 'No .syx in this .zip',
                   message: 'This .zip holds no .syx OS file. ' + supportedLine() };
        }
        var results = [];
        for (var i = 0; i < entries.length; i++) {
          var r = await identifySyx(entries[i].data, entries[i].name);
          r.data = entries[i].data;
          results.push(r);
        }
        var chosen = results.filter(function (r) { return r.ok; })[0] || results[0];
        return Object.assign({}, chosen, { zip: name, zipEntries: results.map(function (r) {
          return { name: r.name, ok: r.ok, title: r.title, sha256: r.sha256 };
        }) });
      }
      var res = await identifySyx(bytes, name);
      res.data = bytes;
      return res;
    }

    /* ---------------------------- choose ------------------------------ */

    function featuresFor(device) { return (index.features || {})[device] || []; }

    /* resolve(device, [feature ids]) -> {ok, recipe, features, notes, message} */
    function resolve(device, picked) {
      var feats = featuresFor(device), byId = {};
      feats.forEach(function (f) { byId[f.id] = f; });
      var set = {}, notes = [];
      (picked || []).forEach(function (id) {
        if (!byId[id]) throw new Error('unknown feature ' + id + ' for ' + device);
        set[id] = true;
      });
      var changed = true;
      while (changed) {
        changed = false;
        Object.keys(set).forEach(function (id) {
          (byId[id].requires || []).forEach(function (need) {
            if (!set[need]) { set[need] = true; changed = true; notes.push(byId[id].why || (id + ' needs ' + need)); }
          });
        });
      }
      var ids = Object.keys(set);
      for (var i = 0; i < ids.length; i++) {
        var ex = byId[ids[i]].excludes || [];
        for (var j = 0; j < ex.length; j++) {
          if (set[ex[j]]) {
            return { ok: false, features: ids, notes: notes,
                     message: byId[ids[i]].label + ' cannot be combined with ' + byId[ex[j]].label + '. ' +
                              (byId[ids[i]].why || '') };
          }
        }
      }
      var key = ids.slice().sort().join('+');
      var recipes = index.recipes || {};
      var match = Object.keys(recipes).filter(function (rid) {
        var r = recipes[rid];
        return r.device === device && r.features.slice().sort().join('+') === key;
      })[0];
      if (!match) {
        return { ok: false, features: ids, notes: notes,
                 message: 'There is no checked build with exactly this combination.' };
      }
      return { ok: true, recipe: match, features: ids, notes: notes };
    }

    function recipesFor(device) {
      return Object.keys(index.recipes || {}).filter(function (rid) { return index.recipes[rid].device === device; });
    }

    /* Read a package after checking it against the pinned index. */
    function loadPackage(id) {
      var text = texts[id];
      if (typeof text !== 'string') throw refusal('package', 'There is no package called ' + id + '.');
      var want = (index.packages || {})[id];
      var got = SHA.sha256hex(enc.encode(text));
      if (!want || got !== want) {
        throw refusal('package', 'The mod package ' + id + ' is damaged or was changed (sha256 ' + got.slice(0, 16) +
                      '…, expected ' + String(want).slice(0, 16) + '…). Nothing was built.');
      }
      var pkg = JSON.parse(text);
      if (pkg.format !== PKG_FORMAT || pkg.id !== id) throw refusal('package', 'Package ' + id + ' has an unknown format.');
      return pkg;
    }

    function packageInfo(id) {
      var p = loadPackage(id);
      return { id: p.id, device: p.device, os: p.os, title: p.title, summary: p.summary, status: p.status,
               features: p.features, mods: p.mods, output: p.output, counts: p.counts };
    }

    function refusal(stage, message, checks) {
      var e = new Error(message);
      e.refusal = { stage: stage, message: message, checks: checks || [] };
      return e;
    }

    /* ----------------------------- build ------------------------------ */

    /* build(stockBytes, recipeId, onProgress) -> {ok:true, bytes, name, sha256, checks}
     * or {ok:false, stage, message, checks}. Never throws for a refusal. */
    async function build(stockBytes, recipeId, onProgress) {
      var checks = [];
      function ok(line) { checks.push('ok   ' + line); }
      function step(s) { if (onProgress) onProgress(s); }
      try {
        return await buildInner();
      } catch (e) {
        if (e && e.refusal) return Object.assign({ ok: false }, e.refusal, { checks: checks.concat(['FAIL ' + e.refusal.message]) });
        return { ok: false, stage: 'internal', message: 'Unexpected error: ' + (e && e.message ? e.message : e),
                 checks: checks.concat(['FAIL internal error']) };
      }

      async function buildInner() {
        step('Checking the mod package');
        var pkg = loadPackage(recipeId);
        ok('package ' + recipeId + ' matches its pinned sha256');
        var pin = known.recipes.filter(function (r) { return r.id === recipeId; })[0];
        if (!pin || pin.device !== pkg.device || pin.output_sha256 !== pkg.output.sha256) {
          throw refusal('package', 'Package ' + recipeId + ' does not name the published result this page expects.');
        }
        var dev = known.devices[pkg.device];
        var base = num(dev.base);
        if (pkg.base !== base) throw refusal('package', 'Package ' + recipeId + ' uses the wrong load address.');
        var pinnedNW = dev.never_write.map(function (r) { return [num(r.start), num(r.end), r.label]; });
        pinnedNW.forEach(function (r) {
          var hit = (pkg.never_write || []).some(function (q) { return q[1] === r[0] && q[2] === r[1]; });
          if (!hit) throw refusal('package', 'Package ' + recipeId + ' does not declare the ' + r[2] + ' it must leave alone.');
        });

        step('Checking your stock file');
        var stockSha = SHA.sha256hex(stockBytes);
        var st = knownStock(stockSha);
        if (!st || !st.supported || st.device !== pkg.device || stockSha !== pkg.stock.syx_sha256) {
          throw refusal('stock', 'This build needs Elektron\'s original OS ' + pkg.os + ' file for the ' +
                        deviceName(pkg.device) + ' (sha256 ' + pkg.stock.syx_sha256.slice(0, 16) +
                        '…). The file you gave is ' + (st ? deviceName(st.device) + ' OS ' + st.os : 'not that file') + '.');
        }
        ok('stock .syx is ' + deviceName(pkg.device) + ' OS ' + pkg.os + ' (sha256 ' + stockSha.slice(0, 16) + '…)');

        step('Unpacking MAIN OS');
        var ex = await EFT.run(createEFT, ['-i', '/in/stock.syx', '-o', '/x'], { '/in/stock.syx': stockBytes }, { readDir: '/x' });
        if (ex.rc !== 0 || !ex.dir) throw refusal('stock', 'The tool could not unpack your stock file.');
        var wantDir = [MAIN].concat(Object.keys(pkg.stock.other_sections || {})).sort();
        if (ex.dir.join('|') !== wantDir.join('|')) {
          throw refusal('stock', 'Your stock file holds sections ' + ex.dir.join(', ') + '; expected ' + wantDir.join(', ') + '.');
        }
        var stockOther = {};
        Object.keys(pkg.stock.other_sections || {}).forEach(function (n) {
          var b = ex.files['/x/' + n];
          if (SHA.sha256hex(b) !== pkg.stock.other_sections[n]) throw refusal('stock', 'Stock section ' + n + ' is not the expected one.');
          stockOther[n] = b;
        });
        var stock = ex.files['/x/' + MAIN];
        if (stock.length !== pkg.stock.mainos_size || SHA.sha256hex(stock) !== pkg.stock.mainos_sha256) {
          throw refusal('stock', 'The MAIN OS inside your stock file is not the expected one.');
        }
        ok('stock MAIN OS ' + stock.length + ' B, sha256 ' + pkg.stock.mainos_sha256.slice(0, 16) + '…' +
           (wantDir.length > 1 ? '; other sections ' + Object.keys(stockOther).join(', ') + ' as expected' : ''));

        step('Applying the mods');
        var patched = applyPackage(pkg, stock, base, pinnedNW, ok);

        var pre = verifyImage(pkg, stock, patched, base, pinnedNW);
        pre.forEach(ok);

        step('Packing MAIN OS (the slow part)');
        var pk = await EFT.run(createEFT, ['-i', '/in/stock.syx', '-c', '3', '/w/mainos.bin', '-o', '/w/out.syx'],
                               { '/in/stock.syx': stockBytes, '/w/mainos.bin': patched }, { readFiles: ['/w/out.syx'] });
        var out = pk.files['/w/out.syx'];
        if (pk.rc !== 0 || !out) throw refusal('pack', 'The tool could not pack the new MAIN OS.');
        ok('packed: ' + out.length + ' B .syx');

        step('Verifying: null repack');
        var nr = await EFT.run(createEFT, ['-i', '/in/stock.syx', '-r', '-o', '/w/null.syx'],
                               { '/in/stock.syx': stockBytes }, { mkdirs: ['/w'], readFiles: ['/w/null.syx'] });
        if (nr.rc !== 0 || !nr.files['/w/null.syx'] || !same(nr.files['/w/null.syx'], stockBytes)) {
          throw refusal('verify', 'Null repack failed: rebuilding your untouched stock file did not give it back byte for byte.');
        }
        ok('null repack: stock .syx rebuilds byte-identically');

        step('Verifying: unpacking the new file again');
        var rt = await EFT.run(createEFT, ['-i', '/w/out.syx', '-o', '/v'], { '/w/out.syx': out }, { readDir: '/v' });
        if (rt.rc !== 0 || !rt.dir) throw refusal('verify', 'The new file could not be unpacked again.');
        var back = rt.files['/v/' + MAIN];
        if (!back || !same(back, patched)) throw refusal('verify', 'The new file does not unpack to the patched MAIN OS.');
        ok(pkg.output.name + ' round-trips to a byte-identical MAIN OS');
        if (rt.dir.join('|') !== wantDir.join('|')) {
          throw refusal('verify', 'The new file carries sections ' + rt.dir.join(', ') + ', not ' + wantDir.join(', ') + '.');
        }
        if (wantDir.length === 1) ok('the new .syx carries MAIN OS only, like stock');
        Object.keys(stockOther).forEach(function (n) {
          if (!same(rt.files['/v/' + n], stockOther[n])) throw refusal('verify', 'Section ' + n + ' changed.');
          ok(n + ' byte-identical to stock (' + stockOther[n].length + ' B)' + (/bootstrap/.test(n) ? ' - recovery path intact' : ''));
        });
        pinnedNW.forEach(function (r) {
          var lo = r[0] - base, hi = r[1] - base;
          if (!same(back.subarray(lo, hi), stock.subarray(lo, hi))) {
            throw refusal('verify', 'The ' + r[2] + ' ' + hex8(r[0]) + '..' + hex8(r[1]) + ' changed in the new file.');
          }
          ok(r[2] + ' ' + hex8(r[0]) + '..' + hex8(r[1]) + ' unchanged after the round trip (' + (hi - lo) + ' B)');
        });

        var outSha = SHA.sha256hex(out);
        if (outSha !== pin.output_sha256 || out.length !== pkg.output.size) {
          throw refusal('verify', 'The result is not the published file: sha256 ' + outSha + ', expected ' + pin.output_sha256 + '.');
        }
        ok('sha256 ' + outSha + ' = the published ' + pkg.output.name);
        checks.push('PASS');
        step('Done');
        return { ok: true, bytes: out, name: pkg.output.name, sha256: outSha, size: out.length,
                 recipe: recipeId, device: pkg.device, checks: checks };
      }
    }

    /* Apply every edit after checking its site; returns the patched image. */
    function applyPackage(pkg, stock, base, pinnedNW, ok) {
      var key = SHA.sha256(enc.encode(SITE_KEY_LABEL), stock);
      var img = stock.slice();
      var edits = pkg.edits.slice().sort(function (a, b) { return a.addr - b.addr; });
      var detourSpan = {};
      (pkg.detours || []).forEach(function (d) { detourSpan[d.addr] = d.displaced_len; });
      // other declared copies from stock (runs of mod data stock also holds): each must
      // pass its own keyed check against the user's file before it is used
      var copyOk = {};
      (pkg.stock_copies || []).forEach(function (c) {
        var o = c.addr - base;
        if (o < 0 || o + c.len > stock.length) throw refusal('apply', 'A stock copy at ' + hex8(c.addr) + ' lies outside MAIN OS.');
        var m = SHA.hex(SHA.hmacSha256(key, concat([be32(c.addr), be32(c.len), stock.subarray(o, o + c.len)])));
        if (m !== c.expect) {
          throw refusal('apply', 'Your stock file does not hold the expected bytes at ' + hex8(c.addr) + ' (a copy source). Nothing was built.');
        }
        copyOk[c.addr + ':' + c.len] = true;
      });
      var regions = pkg.regions || [];
      var lastEnd = 0, mods = 0, refs = 0;
      edits.forEach(function (e) {
        var span = Math.max(e.len, e.expect_len);
        if (e.addr < base || e.addr + span > base + stock.length) {
          throw refusal('apply', 'An edit at ' + hex8(e.addr) + ' lies outside MAIN OS.');
        }
        if (e.addr < lastEnd) throw refusal('apply', 'Two edits overlap at ' + hex8(e.addr) + '.');
        lastEnd = e.addr + span;
        pinnedNW.forEach(function (r) {
          if (e.addr < r[1] && r[0] < e.addr + e.len) {
            throw refusal('apply', 'The package would write into the ' + r[2] + ' at ' + hex8(e.addr) + '. Refused.');
          }
        });
        var inside = regions.some(function (g) { return g[0] <= e.addr && e.addr + e.len <= g[0] + g[1]; });
        if (!inside) throw refusal('apply', 'The edit at ' + hex8(e.addr) + ' is outside every declared claim.');
        var off = e.addr - base;
        var mac = SHA.hex(SHA.hmacSha256(key, concat([be32(e.addr), be32(e.expect_len),
                                                      stock.subarray(off, off + e.expect_len)])));
        if (mac !== e.expect) {
          throw refusal('apply', 'Your stock file does not hold the expected bytes at ' + hex8(e.addr) +
                        ' (' + e.kind + ' of ' + e.owner + '). Nothing was built.');
        }
        var bytes = [];
        e.parts.forEach(function (p) {
          if (p[0] === 'data') { var d = b64(p[1]); bytes.push(d); mods += d.length; }
          else if (p[0] === 'stock') {
            if (detourSpan[p[1]] !== p[2] && !copyOk[p[1] + ':' + p[2]]) {
              throw refusal('apply', 'The edit at ' + hex8(e.addr) + ' copies stock bytes from ' + hex8(p[1]) +
                            ', which is not a declared detour site or stock copy.');
            }
            bytes.push(stock.subarray(p[1] - base, p[1] - base + p[2]));
            refs += p[2];
          } else throw refusal('apply', 'Unknown part type in the edit at ' + hex8(e.addr) + '.');
        });
        var all = concat(bytes);
        if (all.length !== e.len) throw refusal('apply', 'The edit at ' + hex8(e.addr) + ' has the wrong length.');
        img.set(all, off);
      });
      ok(edits.length + ' site(s) hold the stock bytes they expect (keyed check against your file); ' +
         mods + ' mod bytes written, ' + refs + ' bytes copied from your own file (declared detour spans' +
         ((pkg.stock_copies || []).length ? ' and ' + pkg.stock_copies.length + ' declared copy run(s)' : '') + ')');
      return img;
    }

    /* verify.py's image checks, on the patched image before packing. */
    function verifyImage(pkg, stock, patched, base, pinnedNW) {
      var lines = [];
      if (patched.length !== stock.length) throw refusal('verify', 'The image size changed.');
      lines.push('size unchanged (' + patched.length + ' B)');
      pinnedNW.forEach(function (r) {
        var lo = r[0] - base, hi = r[1] - base;
        if (!same(patched.subarray(lo, hi), stock.subarray(lo, hi))) {
          throw refusal('verify', 'The ' + r[2] + ' changed. Refused.');
        }
        lines.push(r[2] + ' ' + hex8(r[0]) + '..' + hex8(r[1]) + ' unchanged (' + (hi - lo) + ' B)');
      });
      var regions = pkg.regions || [];
      var changed = 0;
      for (var i = 0; i < stock.length; i++) {
        if (stock[i] === patched[i]) continue;
        changed++;
        var va = base + i;
        var hit = regions.some(function (g) { return g[0] <= va && va < g[0] + g[1]; });
        if (!hit) throw refusal('verify', 'Byte ' + hex8(va) + ' changed outside every declared claim. Refused.');
      }
      lines.push(changed + ' changed byte(s), all inside the ' + regions.length + ' declared claim(s)');
      var caves = {};
      regions.forEach(function (g) {
        if (/^cave\//.test(g[2])) (caves[g[2].slice(5)] = caves[g[2].slice(5)] || []).push(g);
      });
      function stub(owner) {
        return concat((caves[owner] || []).map(function (g) { return patched.subarray(g[0] - base, g[0] - base + g[1]); }));
      }
      var nd = 0;
      (pkg.detours || []).forEach(function (d) {
        var off = d.addr - base;
        var want = concat([new Uint8Array([0x4e, 0xf9]), be32(d.target)]);
        if (!same(patched.subarray(off, off + 6), want)) throw refusal('verify', 'Detour ' + hex8(d.addr) + ' does not jump to its stub.');
        if (d.target % 2) throw refusal('verify', 'Detour ' + hex8(d.addr) + ' jumps to an odd address.');
        var inCave = (caves[d.owner] || []).some(function (g) { return g[0] <= d.target && d.target < g[0] + g[1]; });
        if (!inCave) throw refusal('verify', 'Detour ' + hex8(d.addr) + ' jumps outside its mod\'s claims.');
        var blk = stub(d.owner);
        var disp = stock.subarray(off, off + d.displaced_len);
        if (d.reemit !== false && indexOfBytes(blk, disp) < 0) {
          throw refusal('verify', 'Detour ' + hex8(d.addr) + ': the displaced instructions are not re-emitted.');
        }
        if (d.rejoin !== 'none') {
          var rj = concat([new Uint8Array([0x4e, 0xf9]), be32(d.rejoin)]);
          var at = indexOfBytes(blk, rj);
          if (at < 0) throw refusal('verify', 'Detour ' + hex8(d.addr) + ' never jumps back to ' + hex8(d.rejoin) + '.');
          [2, 4, 6].forEach(function (n) {
            var r = d.rejoin - base;
            if (at >= n && same(blk.subarray(at - n, at), stock.subarray(r, r + n))) {
              throw refusal('verify', 'Detour ' + hex8(d.addr) + ' would run the instruction at ' + hex8(d.rejoin) + ' twice.');
            }
          });
        }
        nd++;
      });
      if (nd) lines.push(nd + ' detour(s): each jumps to its stub, re-emits what it displaced and rejoins past it');
      return lines;
    }

    function concat(list) {
      var n = 0;
      list.forEach(function (a) { n += a.length; });
      var out = new Uint8Array(n), o = 0;
      list.forEach(function (a) { out.set(a, o); o += a.length; });
      return out;
    }

    return {
      identify: identify, resolve: resolve, featuresFor: featuresFor, recipesFor: recipesFor,
      packageInfo: packageInfo, build: build, known: known
    };
  }

  var api = { createEngine: createEngine };
  root.RytmEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
