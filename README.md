# Chopshop

Chopshop builds unofficial mods for the Elektron **Analog Rytm** (MK1 and MKII, OS 1.73) and the **Analog Keys** (OS 1.56) from your own copy of Elektron's OS file, in your browser. Then you flash the checked file with Elektron Transfer.

**Use it: https://chopshop.pages.dev/** (one page; it also works offline if you save it).

Unofficial: not made, checked or endorsed by Elektron. Changing your unit's firmware is at your own risk.

## Read this first: OS 1.74

Elektron's support pages now serve only OS 1.74 for the Rytm MK1 and MKII. These mods are built for **1.73** (Keys: **1.56**).

- A Rytm already on 1.74 cannot take these files, and the page will not build from a 1.74 file.
- Going back to 1.73 on an MKII that is on 1.74 is likely not possible. That is unverified: nobody has tried it here. Ask Elektron support before you try anything.
- If you still have Elektron's original 1.73 file and a unit still on 1.73, use it, and do not update the unit to 1.74.
- A 1.74 port is a planned follow-up. There is no date.

## What it does

You drop Elektron's original `.syx` (or the `_dist.zip` it came in). The page identifies it by sha256, you pick mods, and it rebuilds the firmware in a Web Worker (Elektron's open-source firmware tool compiled to WebAssembly) and checks the result. The download appears only if the output's sha256 equals the published hash for that build. Nothing is uploaded. No Elektron code or files are shipped; you supply your own.

| Unit | Builds |
|---|---|
| Analog Rytm MK1, OS 1.73 | Control (no mods), Sample Focus, Sample Focus + SMP CUT, classic CHOP + step-lock |
| Analog Rytm MKII, OS 1.73 | Control, CHOP, CHOP + SMP CUT |
| Analog Keys, OS 1.56 | Control, chord memory, chord + JOY RANDOM, JOY RANDOM only |

Not supported: OS 1.74, the Analog Four (including the MKII).

## Hardware status (the author's own reports, not independent testing)

| Unit | Build | Status |
|---|---|---|
| MK1 | Sample Focus + SMP CUT | used in a 20-minute live jam with two other people; MIDI sync solid, nothing hung |
| MK1 | classic CHOP + step-lock | worked on a unit (2026-10-06) |
| MK1 | Control, Sample Focus | not reported on a unit |
| Keys | Control, chord memory | worked |
| Keys | chord + JOY RANDOM | used in the same jam; JOY RANDOM triggered many times, nothing hung |
| Keys | JOY RANDOM only | not run separately |
| **MKII** | **every build** | **never run on an MKII. Built and verified byte for byte only** |
| any | going back to stock over a mod build | not tried on a unit |

## How to use it

1. Open the page and drop your Elektron OS file. Its OS version must match your unit.
2. Choose mods. First time: tick nothing. That gives the Control build (Elektron's code repacked, nothing else). Flash it first; if the unit starts and plays normally, the route works.
3. Build and check. Takes about 10-15 seconds.
4. Download, then flash with Elektron Transfer: drag the file onto DROP, press YES on the unit, do not power off during the update or the first start. Back up your projects first. Add one mod at a time, each only after the one before behaved.
5. Keep Elektron's original file: the startup-menu recovery route sends it (hold FUNC, FUNCTION on the Keys, while powering on, then TRIG 4 = OS UPGRADE; DIN MIDI only). The page lists the exact steps per device.

The mods never change the unit's recovery code, and the page checks that byte for byte before offering a download.

## Developers

See [DEVELOPING.md](DEVELOPING.md): layout, package format, tests, adding a mod or an OS version. The mods themselves live in https://github.com/bandersong/analog-rytm-chop .

## Licence and credits

Copyright (C) 2026 Jesus Triana. GPL-3.0-or-later ([LICENSE](LICENSE)); details in [NOTICE](NOTICE). Built on `elektron-firmware-tool` (MIT) compiled to WebAssembly, and on gdeo607's `rytm1_mods`, which has no licence: credited and used as-is, and the GPL grant does not cover it. Elektron, Analog Rytm, Analog Four and Analog Keys are trademarks of Elektron Music Machines; this project is not affiliated with them.
