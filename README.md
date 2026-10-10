# Chopshop — browser installer, M0

A static web page that builds this project's firmware mods from **the user's own copy of Elektron's OS file**, checks the result the way `rytm1_mods`' `verify.py` does, and offers the file for download only when every check passes. To install it the page points to **Elektron Transfer** (the proven route). The page's own Web MIDI sender is **hidden by default**: it has never touched a real unit, and it exists only behind the address flag `#experimental-sender` (see "The experimental sender").

- One self-contained file: **`dist/index.html`** (no server, no network, works offline).
- Targets: Analog Rytm MK1 OS 1.73, Analog Rytm MKII OS 1.73, Analog Keys OS 1.56.
- Licence: **GPL-3.0-or-later** (`LICENSE`). Credits and third-party terms: `NOTICE`.
- Status: **M0, no device.** Nothing here has talked to a real unit. Local only: not pushed, not deployed.

## Open the page

```bash
open "web/dist/index.html"        # any current browser (the page no longer sends MIDI by default)
```

From a static server instead (any host works; nothing is fetched):

```bash
python3 -m http.server --directory web/dist 8000   # then http://localhost:8000
```

Checked in headless Chrome 155 from `file://`: the engine starts in a Web Worker and three builds reproduce their published sha256 inside the page (`test/browser/e2e.js`). The default page never asks the browser for MIDI access: `test/page.test.js` and `e2e.js` count the calls to `navigator.requestMIDIAccess` (none).

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

   Each selection resolves to exactly one published build, or the page says why it can't. No boxes ticked gives the Control build. Ticking a box ticks what it requires and unticks whatever excludes it or is excluded by it, in both directions (ticking CHOP or SMP CUT clears Classic, and the reverse).
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
4. **Flash with Elektron Transfer.** The page never sends to the unit. Section 4 gives the steps for the unit in the dropped file, using only wording the project's START_HERE files and Elektron's own text already contain:
   - normal route: Elektron's article "How to update your device" (USB, Transfer's DROP area, YES on the unit; the article is saved in corp `installer-re/evidence/elektron`, fetched 2026-10-08, not re-fetched);
   - startup-menu route for a unit that doesn't start (DIN MIDI only): FUNC (Keys: FUNCTION) at power-on, TRIG 4 = OS UPGRADE, then Transfer's "go to the SYSEX TRANSFER page" / "OS upgrade via device startup menu" (MK1 and Keys wording; MKII release notes call it "LEGACY OS UPGRADE mode");
   - Elektron's own text, named per device: MK1 manual section 14.4 "OS UPGRADE"; Analog Keys manual "EARLY STARTUP MENU", "OS UPGRADE"; MKII OS release notes "Upgrading from the STARTUP Menu".

   **OS 1.74.** A prominent note at the top: Elektron's support pages now serve only 1.74 for the Rytm MK1 and MKII; these mods are for 1.73 (Keys: 1.56, still served); a 1.74 unit can't be loaded with these files (the page refuses a 1.74 file, and a 1.73-based file on a 1.74 unit is a downgrade, which Elektron's release notes say is not supported); going back on an MKII that is on 1.74 is **likely not possible and unverified** (the MKII bootstrap carries a "DOWNGRADE NOT POSSIBLE" string, found by a string scan, not tried on a unit; corp `installer-re/REPORT.md` section 2), so: ask Elektron support first; whether an MK1 can go back is equally unverified. Keep the 1.73 file if you have it; a 1.74 port is planned as a follow-up.

   **Status wording** (per recipe, from `tools/mkpackages.py`, checked against `flash/START_HERE.md` and the README at ebd197b): MK1 5c is hardware-proven (2026-10-10, "everything works"; per-row SMP CUT detail still pending); 2b is hardware-proven (2026-10-06); 4d has not been run; the MK1 Control build has no separate hardware report in the project's notes; every MKII and Keys build is "built and verified byte for byte, never run on a unit". END mode is gone from the MK1 builds (it remains on the MKII).

5. **State.** Every result is bound to the state that asked for it. A counter goes up on every new file and every new choice; each engine reply carries the counter it was asked under, and a stale reply is dropped. While a build or a send runs, the file input, the drop zone, the mod boxes and Build are locked, and a dropped file is refused with a message. Before anything could go out (only the experimental sender sends), the page checks again, on its own thread with its own copy of `sha256.js` and `known.json`, that:
   - the stock file is Elektron's original for the device on screen;
   - the build belongs to that file and to the recipe on screen;
   - its bytes hash to the published sha256 for that recipe and device.

   The download name carries the first 8 hex digits of the sha256 (`AR1_OS1.73_0000_0001_36a017ba.syx`), because the project's own build names repeat across different builds (`…_0000_0001.syx` is files 3, 4, 4b, 4c and 4d).

   After a successful build the page points to that device's `START_HERE` (first-run checks and what not to do): `flash/START_HERE.md` (MK1), `flash/MKII/START_HERE_MKII.md`, `flash/KEYS/START_HERE_KEYS.md`, as links to github.com/bandersong/analog-rytm-chop (`blob/main/…`). The page itself still needs no network.

## The experimental sender (off by default)

Decision (2026-10-10): the page's own Web MIDI sender and its Recover button have never touched a real unit, so the default page shows none of it: no controls, no MIDI permission request, no MIDI claims. The code is kept for later testing:
- address ending **`#experimental-sender`** mounts the section from `<template id="experimentalSenderTpl">` (read at load and on `hashchange`); any other hash does nothing;
- `src/sender/sender.js` and its tests are unchanged; `test/browser/race.js` loads the page with the flag;
- `test/page.test.js` proves the default page has no sender controls and never calls `navigator.requestMIDIAccess`, and that the flag mounts it and still waits for a click.

Whether a desktop Chrome shows the SysEx permission prompt for a `file://` page was never checked; with the flag, use the local server (`python3 -m http.server --bind 127.0.0.1 --directory web/dist 8000`) if it doesn't.

What the sender does (unchanged since M0):

**Route C (startup menu, DIN MIDI).** The page walks the user through the startup menu:
- Hold FUNC (on the Keys: FUNCTION) at power-on, then press TRIG 4 = OS UPGRADE.
- Send over DIN MIDI into the unit's MIDI IN. USB does not work in the startup menu.

A notice at the top of the section says this sender has not been tried on a unit yet and gives Elektron's own route for the same thing (Elektron's own text for it, which the page names per device: MK1 manual section 14.4 "OS UPGRADE"; Analog Keys manual "EARLY STARTUP MENU", "OS UPGRADE"; MKII OS release notes "Upgrading from the STARTUP Menu", which call Transfer's button "LEGACY OS UPGRADE mode". Transfer, CONNECTION, "go to the SYSEX TRANSFER page", "OS Upgrade via device startup menu" is the MK1/Keys wording); "If something goes wrong" puts that route first. Route warnings in the page: close Transfer, disable sleep, keep the tab in front, don't power off. The user ticks the confirmations:
- four about the route: backup, the OS UPGRADE screen, the DIN cable, Transfer closed and no sleep;
- a fifth, written from the file in step 1, naming the unit: e.g. "This unit is an Analog Rytm MK1 (not an MKII)", or "an Analog Keys (not an Analog Four)";
- a sixth, for sending the build only: "It runs OS 1.73 now", or 1.56 on the Keys.

Both buttons name the device ("Send the Analog Rytm MK1 build", "Recover: send Elektron's original Analog Rytm MK1 file"). Recover needs the first five boxes, the build all six. Every box is unticked again on a new file, a new choice, a new build and at the end of every send. Then the page streams the file's own SysEx messages (`src/sender/sender.js`):
- one by one, unchanged, with a selectable gap: 5/10/**20**/40/80 ms;
- each timestamped no earlier than the previous one plus its DIN wire time (10 bits a byte at 31250 baud, 40.96 ms for 128 B) plus the gap, so the average never exceeds 31250 baud;
- restarting the schedule from "now" after a stall instead of bursting;
- never handing the browser more than 1 s of data ahead, because Chrome has no `MIDIOutput.clear()`;
- with progress and ETA, an abort, a screen wake lock, and a warning when the tab goes to the background;
- ending (done, stopped or failed) only once everything already handed to the browser is due to have left the cable, so a new send can never interleave with the tail of a stopped one.

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
| `src/sender/sender.js` | the Web MIDI sender (experimental, off by default) |
| `src/ui/` | page template (its `<template id="experimentalSenderTpl">` holds the experimental sender's markup), style, page script (all sender code is in `mountSender()`) |
| `src/wasm/eft_api.c` | a read-only `eft_identify()` (device byte, container, version) over the tool's parser |
| `generated/eft.js` | elektron-firmware-tool + `eft_api.c` compiled by emscripten 6.0.10 (`SINGLE_FILE`), with `eft.build.txt` (flags, source hashes) |
| `generated/packages/` | one JSON package per published build, and `index.json` (sha256 of each package text, feature rules) |
| `third_party/` | elektron-firmware-tool sources (MIT) at a5bce9a plus the ELE2 align-4 patch; emscripten and musl licence texts |
| `tools/build-wasm.sh` | builds `generated/eft.js` (emscripten; build VM) |
| `tools/mkpackages.py` | builds `generated/packages/` from rytm1_mods' built images (build VM) |
| `tools/bundle.js` | builds `dist/index.html`; `--check` fails if it is stale |
| `test/*.test.js` | node tests (below); `test/browser/e2e.js` and `test/browser/race.js` drive the page in headless Chrome (VM only) |

## Package format `rytm-installer-package/1`

One JSON file per build, written by `tools/mkpackages.py`. The bytes, sites, claims and detours come from:
- `build/manifest_<tag>.json` and `build/mainos_<tag>.bin` (the built, verify-passed image);
- `registry/allocations*.toml` and `re/symbols*.toml` (rytm1_mods, branch `chop`).

The words are hand-written in `mkpackages.py`: each recipe's title, summary and status (`RECIPES`), and the checkboxes with their `requires`/`excludes` rules (`FEATURES`).

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

## Adding a mod package

1. Build it in `rytm1_mods` (branch `chop`, in the VM) until `verify.py` passes, and publish the output: its sha256 goes into the `SHA256SUMS` of its `flash/` folder (or a `START_HERE` file that `known.test.js` reads).
2. Pin it by hand in `src/engine/known.json` under `recipes`: `id`, `device`, `output_sha256`, and a `source` naming that file. `known.test.js` fails if the hash is not in the cited file, or if a pin has no package.
3. Add a `RECIPES` entry in `tools/mkpackages.py` (id, device, build tag, features, title, summary, status). If it brings a new checkbox, add it to `FEATURES` for that device with its `requires`/`excludes` and a `why`. Every selection must still resolve to exactly one recipe.
4. In the VM: `python3.12 web/tools/mkpackages.py --rytm1-mods upstream/rytm1_mods` (it refuses unless the image rebuilds from stock + package byte for byte and hashes to the pin), then `node web/tools/bundle.js`.
5. Run every test: `node --test web/test/*.test.js` (the new pin is built by `engine.test.js` and scanned by `scan.test.js`), then `test/browser/e2e.js` and `test/browser/race.js` in the VM.
6. If it adds a feature combination, add it to the feature-rule cases in `negative.test.js`.

### A new OS version

Supporting another OS version (say Rytm 1.74) touches more than a package:
- `known.json`: the new stock sha256 under `stock` (`supported: true`), and the old one set to `supported: false` if it is dropped; new never-write ranges if they move.
- `src/engine/engine.js`: the target versions in `identifySyx` (`'1.56' : '1.73'` in the old-file and newer-file branches), `supportedLine()`, and `DEVICE_WORDS` if a device byte is new.
- `src/ui/app.js`: `DEVICE_TEXT` (the OS in the confirmation box).
- `src/ui/index.html`: the versions in the page text (lede, "Which file do I need?", the 1.74 note in step 1).
- `tools/mkpackages.py`: `DEVICES` (stock name, build dir) and the recipes.
- `test/negative.test.js`: the version cases (it makes a "newer" file with the tool's own `-V`).

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
- T2 non-package runs: all text (380 on the integrator's run of 2026-10-08, after the licence texts went into the page; the count moves as the docs change).
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
node --test web/test/*.test.js     # 51 tests, about 2 minutes; read-only (all outputs stay in memory)
ONLY=keys-chord node --test web/test/engine.test.js
```

Stock files are found by sha256 in `stock/` and `upstream/rytm1_mods/stock/`, or in `STOCK_DIR` (a path-delimited list). The project's `flash/*.syx` images are not in git, so the superseded-build checks read them from `SYX_ROOT` (a checkout that holds them; default: this repo). The checksum files (`flash/**/SHA256SUMS`, `START_HERE_KEYS.md`) are always read from this repo. Example from a worktree:

```bash
STOCK_DIR="<main checkout>/upstream/rytm1_mods/stock:<main checkout>/stock" SYX_ROOT="<main checkout>" node --test web/test/*.test.js
```

| File | Covers |
|---|---|
| `engine.test.js` | every published target from its stock file → the published sha256 (11 targets) |
| `negative.test.js` | refusals listed below |
| `sender.test.js` | the experimental sender against a mock `MIDIOutput` with a fake clock (listed below) |
| `page.test.js` | the default page has no sender controls or MIDI-sender wording, its script never calls `requestMIDIAccess` (with or without the flag, until a click), other hashes don't switch the sender on, and `#experimental-sender` does |
| `scan.test.js` | the no-Elektron-bytes scan |
| `known.test.js` | pins against the project's SHA256SUMS files; packages against pins; SHA-256/HMAC against node crypto and RFC 4231 |
| `bundle.test.js` | `dist/index.html` is current, self-contained, carries NOTICE and every licence text in full (EFT's MIT, emscripten, musl, the GPL) plus the source pointer, and its embedded engine builds `keys-joy-min` in a worker-like sandbox |

`negative.test.js` checks that each of these is refused, each by the layer meant to catch it:
- a 1.74-like file, made with the tool's own `-V 1.74`, as `.syx` and inside a `_dist.zip` (the refusal must also say that Elektron offers only 1.74 for the Rytm and that a 1.74 unit can't take these mods yet);
- 1.72 files (the refusal must give the way forward: Elektron's 1.73 first, then the Control build);
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
- one of this project's own outputs dropped as stock;
- this project's older and superseded flash builds (`flash/`, `flash/_superseded/`) dropped as stock, including 4b, 5, 4c and 5b (MK1) and the two older MKII builds: each is named as "a modded build from this project, not Elektron's stock file", and a one-byte-changed copy is not.

It also checks the feature rules.

`sender.test.js` checks:
- the whole stock file comes out as byte-identical messages, in order;
- spacing is at least wire time + gap;
- data is queued at most 1 s ahead;
- the average rate stays at or under 31250 baud;
- the ETA is exact;
- gap 0 runs at wire speed;
- stalls don't cause bursts;
- abort works, and resolves only after the queued tail is due to have left the wire;
- an output error mid-send rejects only after the queued tail has left;
- a Stop after the last message is queued still waits for the wire;
- with real timers on one port, Stop followed at once by a new send never interleaves (the panel's SAFE-5 case);
- real timers keep the spacing.

No device, virtual port or system setting is used.

Browser state test (VM): `CHROME=… PUPPETEER=… [INLINE=1] [DIST=…] SHOTS=… node web/test/browser/race.js` loads the page with `#experimental-sender` and checks, with a mock MIDI port and both engine modes, that the page never offers or sends bytes other than the published file for the device and recipe on screen:
- another device's stock file dropped 0 and 100 ms into a build (the panel's SAFE-1 case), then after the build, and a synthetic drop event right after Build. A drop the page handles during the build must be refused. With the on-page engine the page itself is busy packing, so the browser may deliver the drop only after the build; then it must be taken as a new file, with the old build gone;
- the mod boxes changed 0.5 s and 3 s into a build (a click and a scripted change event);
- the exclusion rule both ways;
- the confirmation boxes: device and OS text, five boxes for Recover and six for the build, unticked after a build and after a send;
- during a send: Build, the file input and the mod boxes locked, a dropped file refused; after Stop, nothing re-enabled before the queued tail has left;
- the download name with its sha256 prefix.

When "Send the build" is enabled after a settle, the test presses it: the first 30 messages on the mock port must be a prefix of the published file for the recipe on screen. Against the M0 page as first committed (33cd3f8) the same test fails: that was the panel's SAFE-1/SAFE-2 finding.

Browser end-to-end (VM): `CHROME=… PUPPETEER=… SHOTS=… node web/test/browser/e2e.js` checks:
- the page from `file://` builds `mk1-samplefocus-cut`, `mk2-samplefocus` and `keys-joy-min` to their published sha256 (checked with `crypto.subtle` in the page);
- a 1.72 file is refused;
- no horizontal scroll at 375 px;
- the default page: no sender controls, no call to `navigator.requestMIDIAccess` during the whole run, the OS 1.74 note, the Transfer steps, and only the identified unit's note shown;
- no console errors.

## Known gaps

- **Not tested:**
  - a real MIDI interface or unit;
  - desktop Chrome/Edge permission behaviour from `file://`;
  - Windows/Linux browsers.
- **Experimental sender only:** route C pacing is unknown (corp `installer-re`: no Elektron source gives a gap). 20 ms is a conservative default, not a measured one; M0b should measure Transfer's own stream.
- **Experimental sender only:** the page cannot see whether the unit received the file. It is not known whether the bootstrap ever answers.
- **Licences:** the packages, and some of the mod code in them, include code from gdeo607/rytm1_mods, which has no licence (GitHub reports none, 2026-10-08). It is credited (`NOTICE`, the page's footer and licence section) and used as-is; this project's GPL-3.0-or-later grant covers its own code only. Local only until it is published. The page's Corresponding Source pointer names the `web/` folder; the public address goes in `tools/bundle.js` (`SOURCE_NOTE`) once there is one.
- **Experimental sender only:** the page cannot ask the unit what it is or which OS it runs (M0 has no USB route). The fifth and sixth boxes are the user's word for it.
- **Elektron's pages** (the two support articles linked from step 4, the release-note and manual references, "only 1.74 is served") were read from copies saved on 2026-10-08; they were not re-fetched for this build.
