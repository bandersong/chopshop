# Rytm & Keys Mod Installer (working name) — browser installer, M0

A static web page that builds this project's firmware mods from **the user's own copy of Elektron's OS file**, checks the result the way `rytm1_mods`' `verify.py` does, offers the file for download only when every check passes, and can stream it to the unit over **Web MIDI** through the startup-menu route.

- One self-contained file: **`dist/index.html`** (no server, no network, works offline).
- Targets: Analog Rytm MK1 OS 1.73, Analog Rytm MKII OS 1.73, Analog Keys OS 1.56.
- Licence: **GPL-3.0-or-later** (`LICENSE`). Credits and third-party terms: `NOTICE`.
- Status: **M0, no device.** Nothing here has talked to a real unit. Local only: not pushed, not deployed, not named.

## Open the page

```bash
open "web/dist/index.html"        # Chrome or Edge; Safari opens it but cannot send MIDI
```

From a static server instead (any host works; nothing is fetched):

```bash
python3 -m http.server --directory web/dist 8000   # then http://localhost:8000
```

Checked in headless Chrome 155 from `file://`: the engine starts in a Web Worker and three builds reproduce their published sha256 inside the page (`test/browser/e2e.js`). Web MIDI exists there and the page is a secure context, but headless Chrome refuses the permission. Whether a desktop Chrome shows the SysEx permission prompt for a `file://` page is **not checked**. If it doesn't, use the local server.

## What the page does

1. **Identify.** The user drops a `.syx` or an Elektron `_dist.zip`. The page identifies the file by sha256 against `src/engine/known.json`. A file it doesn't know gets a plain explanation, using what elektron-firmware-tool reads from the file (device byte, version text). Cases covered:
   - a newer OS ("your file is 1.74: not supported yet; do not install it on your unit");
   - 1.72;
   - one of this project's own outputs;
   - other Elektron devices, including the Analog Four MKII;
   - damaged or modified files.
2. **Choose.** Mods are checkboxes with rules from the package index:
   - MK1/MKII: SMP CUT requires CHOP, because it runs through CHOP's page code.
   - MK1: the classic step-lock build excludes both.
   - Keys: chord and JOY RANDOM are independent; JOY alone is `joy-min`.

   Each selection resolves to exactly one published build, or the page says why it can't. No boxes ticked gives the Control build.
3. **Build and verify** (in a Web Worker; about 9 to 15 s per build in node on the VM, 9 to 13 s in headless Chrome):
   - **Package:** its text hashes to the pinned `index.json` entry, and it names the published output pinned in `known.json`.
   - **Stock file:** its sha256 matches the stock file this target needs.
   - **Unpack:** `eft -i stock.syx -o /x`. The file must hold exactly the expected sections, and the MAIN OS size and sha256 must match. On MKII, every other section's sha256 must match too.
   - **Per-site checks**, done before writing anything:
     - every edit lies inside MAIN OS and inside a declared claim;
     - no edit overlaps another;
     - no edit touches a never-write range;
     - the stock bytes at each site pass a keyed check (see the package format below);
     - stock copies come only from declared detour spans or declared stock copies, and each copy passes its own keyed check.
   - **verify.py's image checks:**
     - size unchanged;
     - never-write ranges byte-identical:
       - MK1 bootstrap `[0x4028c708,0x402a1b24)`;
       - MKII device firmware `[0x402c8754,0x402cc91c)`;
       - Keys bootstrap `[0x40226ee8,0x40233fc0)` and UI-board firmware `[0x401b8a92,0x401b9fd6)`;
     - every changed byte lies inside a declared claim;
     - every detour is a `jmp` to its stub, at an even address, inside its own mod's claims;
     - every detour's displaced instructions are re-emitted, and it rejoins past them without running the rejoin instruction twice.
   - **Pack:** `eft -i stock.syx -c 3 mainos.bin -o out.syx`. These are `build.py`'s own arguments, so the packer is the same code at the same default level 3.
   - **Null repack:** `eft -i stock.syx -r -o null.syx` must give the stock file back byte for byte.
   - **Round trip:** `eft -i out.syx -o /v` must give back the patched MAIN OS. The other sections must equal stock's: MK1 and Keys carry MAIN OS only; on MKII the bootstrap section must be byte-identical. The never-write ranges are checked again.
   - **Published hash:** sha256(out) must equal the published hash. Only then does the page show the download.
   - Not repeated in the page: `verify.py`'s stack-frame disassembly check (it needs `objdump`). It is a property of the mod code, and that code passed `verify.py` when the image was built. The published-hash check pins the same bytes.
4. **Flash (Web MIDI, route C).** The page walks the user through the startup menu:
   - Hold FUNC (on the Keys: FUNCTION) at power-on, then press TRIG 4 = OS UPGRADE.
   - Send over DIN MIDI into the unit's MIDI IN. USB does not work in the startup menu.

   Route warnings in the page: close Transfer, disable sleep, keep the tab in front, don't power off. The user ticks four confirmations, then the page streams the file's own SysEx messages (`src/sender/sender.js`):
   - one by one, unchanged, with a selectable gap: 5/10/**20**/40/80 ms;
   - each timestamped no earlier than the previous one plus its DIN wire time (10 bits a byte at 31250 baud, 40.96 ms for 128 B) plus the gap, so the average never exceeds 31250 baud;
   - restarting the schedule from "now" after a stall instead of bursting;
   - never handing the browser more than 1 s of data ahead, because Chrome has no `MIDIOutput.clear()`;
   - with progress and ETA, an abort, a screen wake lock, and a warning when the tab goes to the background.

   **Recover: send Elektron's original file** uses the same sender on the stock file the user dropped.

Not in M0 (next): **route A**, USB while the OS runs (Transfer's drop route: the `0x50`/`0x51` OsUpgrade RPC described in corp `installer-re/REPORT.md`). Also not in M0:
- M0b: measuring Transfer's own pacing on the startup-menu route.
- Any real-device test (M1–M4 in the report).
- Firefox, which needs a site-permission add-on for Web MIDI.

## Layout

| Path | What |
|---|---|
| `dist/index.html` | the page, generated by `tools/bundle.js` (commit it after a rebuild) |
| `src/engine/engine.js` | identify, resolve, build and verify (own code) |
| `src/engine/eftrun.js` | runs elektron-firmware-tool's `main()` in a fresh WebAssembly instance per call |
| `src/engine/sha256.js`, `zip.js` | SHA-256/HMAC (FIPS 180-4, RFC 2104) and a .zip reader (APPNOTE), own code |
| `src/engine/known.json` | hand-entered pins: stock sha256s, published output sha256s with their source file, never-write ranges |
| `src/sender/sender.js` | the Web MIDI sender |
| `src/ui/` | page template, style, page script |
| `src/wasm/eft_api.c` | a read-only `eft_identify()` (device byte, container, version) over the tool's parser |
| `generated/eft.js` | elektron-firmware-tool + `eft_api.c` compiled by emscripten 6.0.10 (`SINGLE_FILE`), with `eft.build.txt` (flags, source hashes) |
| `generated/packages/` | one JSON package per published build, and `index.json` (sha256 of each package text, feature rules) |
| `third_party/` | elektron-firmware-tool sources (MIT) at a5bce9a plus the ELE2 align-4 patch; emscripten and musl licence texts |
| `tools/build-wasm.sh` | builds `generated/eft.js` (emscripten; build VM) |
| `tools/mkpackages.py` | builds `generated/packages/` from rytm1_mods' built images (build VM) |
| `tools/bundle.js` | builds `dist/index.html`; `--check` fails if it is stale |
| `test/*.test.js` | node tests (below); `test/browser/e2e.js` drives the page in headless Chrome (VM only) |

## Package format `rytm-installer-package/1`

One JSON file per build. Every field is generated by `tools/mkpackages.py` from:
- `build/manifest_<tag>.json` and `build/mainos_<tag>.bin` (the built, verify-passed image);
- `registry/allocations*.toml` and `re/symbols*.toml` (rytm1_mods, branch `chop`).

The generator refuses to write a package unless:
- the built `.syx` hashes to the published sha256;
- stock + package rebuild the built image byte for byte;
- every changed byte lies inside a claim.

- `target fields`: `device`, `os`, `base`, `stock` (syx/MAIN OS sha256 and size, MKII's other sections' sha256), `never_write`.
- `regions`: the registry claims active in this build (as `verify.py` resolves gates).
- `edits[]`: `{kind: cave|detour|patch, owner, addr, len, expect_len, expect, parts}`.
  - `parts` is a list of `["data", base64]` (the mod's own bytes) and `["stock", addr, len]` (copy that many bytes from the user's stock MAIN OS).
  - `expect` = HMAC-SHA256(K, addr‖len‖stock bytes at the site), with K = SHA-256("rytm-installer site key v1" ‖ stock MAIN OS). Only someone with the stock file can compute or test it, so the check says nothing about Elektron's bytes to anyone else.
- `stock_copies[]`: `{addr, len, expect}` for copies other than detour spans, each with its own keyed check.
- `detours[]`: `{owner, addr, entry, target, displaced_len, rejoin, reemit}` for the `verify.py`-style detour checks.
- `output`: `{name, sha256, size, mainos_sha256}`.
- `counts`, `provenance`: rytm1_mods commit and manifest sha256.

Trust: the page runs only packages whose text hashes to `index.json`, and only accepts a result whose sha256 equals the pin in `known.json`. Both files are hand-checked by `test/known.test.js` against `flash/*/SHA256SUMS`, `stock/SHA256SUMS` and `flash/KEYS/START_HERE_KEYS.md`.

## The no-Elektron-bytes scan (`test/scan.test.js`)

**Shipped (S):**
- every package's mod bytes, decoded;
- every package file as text;
- `dist/index.html`;
- the WebAssembly binary decoded from `generated/eft.js`;
- every other file under `web/`.

**References (R):** the three stock files (read, never copied), each raw and as every section the tool unpacks.

- **T1, exact.** No S contains the stock bytes displaced at any detour site (33 distinct spans over the three devices), as bytes or spelled in hex. Packages carry them only as `["stock", addr, len]`.
- **T2, runs of 16 B or more.**
  - Packages: none, apart from low-entropy padding (at most 3 distinct byte values, at least ¾ of them 0x00/0xFF).
  - Other files: only plain text, and every such run is listed.
  - **History:** v1 used one rule for everything and **failed on its first run**. In packages it found:
    - a few RAM tables;
    - two call sequences identical to stock's;
    - in the classic step-lock build, a pointer table repeating four stock table entries.

    In the other files it found C-library messages in the WebAssembly, the product name, `0123456789ABCDEF`, and comments. Since then the generator turns every non-padding run of 16 B or more that stock holds into a stock copy, and v2 replaced v1.
- **T3, 4-byte rate.** For each device's mod bytes, the share of bytes inside a 4-byte window that also occurs in that device's stock MAIN OS. Declared `jmp`/`jsr` abs.l to a MAIN OS address and padding are left out. This share must stay within 10 points of the same share measured against the other family's OS. That control is the rate at which any ColdFire code matches some 4 bytes of a ~2.5 MB image.

Results, VM and host (2026-10-08):

| Check | MK1 | MKII | Keys |
|---|---|---|---|
| T1 | 0 | 0 | 0 |
| T2 package runs | padding only | padding only | padding only |
| T3 same device | 50.22 % | 50.24 % | 53.77 % |
| T3 control | 47.76 % | 47.57 % | 52.68 % |
| Longest non-padding run, mod bytes vs same-device MAIN OS | 15 B | 15 B | 15 B |

- T1 covered 33 displaced spans.
- T2 non-package runs: all text (361 on the final run; the count moves as the docs change).
- Package texts: 0 hits.

## Rebuild

Toolchains live in the build VM only. The host only runs the tests.

```bash
# in the VM (brew: emscripten 6.0.10, node; python3.12 for the generator)
sh web/tools/build-wasm.sh                                       # generated/eft.js
python3.12 web/tools/mkpackages.py --rytm1-mods upstream/rytm1_mods \
    --steplock-tree <rytm1_mods ee8665e, git archive + `make chop` there>   # generated/packages/
node web/tools/bundle.js                                         # dist/index.html
```

The classic step-lock package (`mk1-chop-steplock`, a96657b4…) comes from rytm1_mods commit `ee8665e`. Build it this way:
1. `git archive ee8665e` into a scratch directory.
2. Copy in `vendor/elektron-firmware-tool` and the MK1 stock file.
3. Run `make PY=python3.12 chop`.

Without `--steplock-tree` the generator skips that one package.

## Tests

```bash
node --test web/test/*.test.js     # 45 tests, about 2 minutes; read-only (all outputs stay in memory)
ONLY=keys-chord node --test web/test/engine.test.js
```

Stock files are found by sha256 in `stock/` and `upstream/rytm1_mods/stock/`, or in `STOCK_DIR`.

| File | Covers |
|---|---|
| `engine.test.js` | every published target from its stock file → the published sha256 (11 targets) |
| `negative.test.js` | refusals listed below |
| `sender.test.js` | the sender against a mock `MIDIOutput` with a fake clock (listed below) |
| `scan.test.js` | the no-Elektron-bytes scan |
| `known.test.js` | pins against the project's SHA256SUMS files; packages against pins; SHA-256/HMAC against node crypto and RFC 4231 |
| `bundle.test.js` | `dist/index.html` is current, self-contained, and its embedded engine builds `keys-joy-min` in a worker-like sandbox |

`negative.test.js` checks that each of these is refused, each by the layer meant to catch it:
- a 1.74-like file, made with the tool's own `-V 1.74`, as `.syx` and inside a `_dist.zip`;
- 1.72 files;
- random, truncated and empty inputs;
- a wrong stock file for the target;
- a tampered package;
- a tampered package with a forged index;
- a package naming the wrong output;
- an expect mismatch, and a site moved by 2 bytes;
- a write into each never-write range, on all three devices;
- a missing never-write declaration;
- an unclaimed edit;
- an undeclared stock copy, and a failing copy check;
- one of this project's own outputs dropped as stock.

It also checks the feature rules.

`sender.test.js` checks:
- the whole stock file comes out as byte-identical messages, in order;
- spacing is at least wire time + gap;
- data is queued at most 1 s ahead;
- the average rate stays at or under 31250 baud;
- the ETA is exact;
- gap 0 runs at wire speed;
- stalls don't cause bursts;
- abort works;
- real timers keep the spacing.

No device, virtual port or system setting is used.

Browser end-to-end (VM): `CHROME=… PUPPETEER=… SHOTS=… node web/test/browser/e2e.js` checks:
- the page from `file://` builds `mk1-samplefocus-cut`, `mk2-samplefocus` and `keys-joy-min` to their published sha256 (checked with `crypto.subtle` in the page);
- a 1.72 file is refused;
- no horizontal scroll at 375 px;
- no console errors.

## Known gaps

- **Not tested:**
  - a real MIDI interface or unit;
  - desktop Chrome/Edge permission behaviour from `file://`;
  - Windows/Linux browsers.
- **Route C pacing is unknown** (corp `installer-re`: no Elektron source gives a gap). 20 ms is a conservative default, not a measured one; M0b should measure Transfer's own stream.
- **The page cannot see whether the unit received the file.** It is not known whether the bootstrap ever answers.
- **Licences:** the packages contain code first written in gdeo607/rytm1_mods, which has no licence yet (see `NOTICE`). Do not publish this folder until that is settled and the project has its name.
