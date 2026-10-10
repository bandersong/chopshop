/* eftrun.js - run elektron-firmware-tool (compiled to WebAssembly) like a command.
 *
 * Part of Chopshop, the browser installer. Copyright (C) 2026 bandersong.
 * SPDX-License-Identifier: GPL-3.0-or-later.
 *
 * Each call starts a FRESH instance of the tool, writes the input files into its
 * private in-memory file system, runs its main() with the given arguments (the same
 * arguments rytm1_mods' build.py and verify.py pass to the native tool), and reads the
 * output files back. A fresh instance per call is the browser's equivalent of a new
 * process: nothing carries over from one call to the next.
 */
(function (root) {
  'use strict';

  function dirname(p) { return p.replace(/\/[^/]*$/, '') || '/'; }

  /* run(createEFT, args, inputs {path: Uint8Array}, opts {mkdirs, readDir, readFiles})
   * -> {rc, out: [lines], files: {path: Uint8Array}, dir: [names]} */
  async function run(createEFT, args, inputs, opts) {
    opts = opts || {};
    var out = [];
    var M = await createEFT({
      print: function (s) { out.push(s); },
      printErr: function (s) { out.push('stderr: ' + s); }
    });
    (opts.mkdirs || []).forEach(function (d) { M.FS.mkdirTree(d); });
    Object.keys(inputs || {}).forEach(function (p) {
      M.FS.mkdirTree(dirname(p));
      M.FS.writeFile(p, inputs[p]);
    });
    var rc;
    // Under node the generated runtime records the tool's exit code as the host
    // process's own exit code (process.exitCode); put it back, the tool is not the host.
    var proc = (typeof process !== 'undefined' && process && process.versions && process.versions.node) ? process : null;
    var prevExit = proc ? proc.exitCode : undefined;
    try {
      rc = M.callMain(args);
    } catch (e) {
      rc = (e && typeof e.status === 'number') ? e.status : -1;
      out.push('exception: ' + (e && e.message ? e.message : String(e)));
    } finally {
      if (proc) proc.exitCode = prevExit;
    }
    var files = {}, dir = null;
    if (opts.readDir) {
      try {
        dir = M.FS.readdir(opts.readDir).filter(function (n) { return n !== '.' && n !== '..'; }).sort();
        dir.forEach(function (n) { files[opts.readDir + '/' + n] = M.FS.readFile(opts.readDir + '/' + n); });
      } catch (e) { dir = null; }
    }
    (opts.readFiles || []).forEach(function (p) {
      try { files[p] = M.FS.readFile(p); } catch (e) { /* missing: caller decides */ }
    });
    return { rc: rc, out: out, files: files, dir: dir };
  }

  /* What a .syx says it is, from the tool's own parser (src/wasm/eft_api.c). */
  async function identify(createEFT, bytes) {
    var M = await createEFT({ print: function () {}, printErr: function () {} });
    M.FS.mkdirTree('/in');
    M.FS.writeFile('/in/file.syx', bytes);
    var cap = 4096, buf = M._malloc(cap);
    try {
      var rc = M.ccall('eft_identify', 'number', ['string', 'number', 'number'], ['/in/file.syx', buf, cap]);
      if (rc !== 0) return null;
      return JSON.parse(M.UTF8ToString(buf));
    } catch (e) {
      return null;
    } finally {
      M._free(buf);
    }
  }

  var api = { run: run, identify: identify };
  root.RytmEftRun = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
