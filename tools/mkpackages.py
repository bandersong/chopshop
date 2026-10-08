#!/usr/bin/env python3
"""Generate the installer's mod packages from rytm1_mods' BUILT images.

Part of the browser installer (working name "web"). Copyright (C) 2026 bandersong.
SPDX-License-Identifier: GPL-3.0-or-later.

Nothing here is typed in by hand: every byte a package carries is read out of an
image that tools/build.py built and tools/verify.py passed (build/mainos_<tag>.bin),
at the addresses its manifest (build/manifest_<tag>.json) and the registry
(registry/allocations*.toml) name. The image's .syx must hash to the published
sha256 pinned in src/engine/known.json, or the package is refused.

What a package carries, and what it never carries:
  * the mods' own bytes: cave code/data, the 6-byte `jmp` at each detour site, each
    patch's replacement bytes;
  * NO Elektron bytes. Where a stub re-emits stock instructions it displaced (the
    detour's `displaced` span), the package says "copy N bytes from stock at address
    X" and the engine fills them from the user's own stock file. Per-site
    expect-checks are HMAC-SHA256 values keyed by the stock MAIN OS itself
    (key = SHA-256("rytm-installer site key v1" || MAIN OS)), so they reveal nothing to
    anyone without the stock file, and only the right stock bytes pass them.
  * Any other run of 16 or more bytes of mod data that the stock MAIN OS also holds (a
    call sequence the same as stock's, a table that repeats a stock table) is turned into
    a reference the same way (`stock_copies`, each with its own keyed check), unless it
    is low-entropy padding (zeros/0xFF with a few small values: the mod's RAM defaults).
Before writing, the generator rebuilds every image from stock + package and asserts
it equals the built image byte for byte.

Run it in the build VM (python3.12), from the parent repo:
  python3.12 web/tools/mkpackages.py --rytm1-mods upstream/rytm1_mods \
      [--steplock-tree <dir>]   # optional: rytm1_mods ee8665e, after `make chop` there
"""

import argparse
import base64
import hashlib
import hmac
import json
import subprocess
import sys
import tomllib
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent  # web/
SITE_KEY_LABEL = b"rytm-installer site key v1"
FORMAT = "rytm-installer-package/1"
MAINOS_SECTION = 3

DEVICES = {
    # device: (symbols, registry, build dir, stock name in rytm1_mods/stock)
    "mk1": ("re/symbols.toml", "registry/allocations.toml", "build",
            "Analog-Rytm_OS1.73.syx"),
    "mk2": ("re/symbols_mk2.toml", "registry/allocations_mk2.toml", "build/mk2",
            "Analog-Rytm_MKII_OS1.73.syx"),
    "keys": ("re/symbols_keys.toml", "registry/allocations_keys.toml", "build/keys",
             "KEYS_Analog-Four_Analog-Keys_OS1.56.syx"),
}

# Each recipe is one composition rytm1_mods builds and the project published. The
# features are what the page shows as checkboxes; the rules below map a selection
# of features to exactly one recipe.
RECIPES = [
    dict(id="mk1-control", device="mk1", tag="control", features=[],
         title="Control build (no mods)",
         summary="Elektron's own code, only unpacked and packed again by this tool. "
                 "Flash it first: if it boots and plays normally, the route works on your unit.",
         status="Same file as the project's 1_CONTROL (proves the tool)."),
    dict(id="mk1-samplefocus", device="mk1", tag="0000_0001", features=["chop"],
         title="CHOP / Sample Focus",
         summary="A CHOP page on SAMPLE (press SAMPLE, pause, SAMPLE again): the 12 pads "
                 "play one track's sample from 12 start markers; hi-res markers, END, DIV, "
                 "LAY, RND; step-lock in GRID REC.",
         status="Built and checked on a computer; this exact file has not run on a Rytm yet "
                "(the earlier CHOP builds did)."),
    dict(id="mk1-samplefocus-cut", device="mk1", tag="0000_0001_0008",
         features=["chop", "smpcut"],
         title="CHOP / Sample Focus + SMP CUT",
         summary="Everything in CHOP / Sample Focus, plus SMP CUT: a second FILTER page "
                 "(press FILTER, pause, FILTER again) with a low cut and a high cut per track.",
         status="Built and checked on a computer; SMP CUT has never run on an MK1 yet."),
    dict(id="mk1-chop-steplock", device="mk1", tag="0000_0001_0002_0003",
         features=["classic"], optional=True,
         title="Classic CHOP + step-lock (older build)",
         summary="The earlier, hardware-proven CHOP build: 3-knob CHOP page, step-lock, "
                 "plus euclid accents and velocity humanise. No Sample Focus, no SMP CUT.",
         status="Proven on the founder's MK1 (file 2b, step-lock confirmed 2026-10-06). "
                "Pressing a CHOP knob while holding steps can leave a hidden lock on this build."),
    dict(id="mk2-control", device="mk2", tag="control", features=[],
         title="Control build (no mods)",
         summary="Elektron's own MKII code, only unpacked and packed again by this tool. "
                 "Flash it first.",
         status="Same file as the project's MKII 1_CONTROL. Not yet run on an MKII."),
    dict(id="mk2-samplefocus", device="mk2", tag="0000_0001", features=["chop"],
         title="CHOP / Sample Focus",
         summary="The CHOP page as the third SAMPLE page (SAMPLE → SMPL WAVEFORM → CHOP): "
                 "12 pads, 12 start markers, hi-res, END, DIV, LAY, RND, step-lock.",
         status="Built and checked on a computer; not yet run on an MKII."),
    dict(id="mk2-samplefocus-cut", device="mk2", tag="0000_0001_0008",
         features=["chop", "smpcut"],
         title="CHOP / Sample Focus + SMP CUT",
         summary="Everything in CHOP / Sample Focus, plus SMP CUT on FILTER ×2 "
                 "(low cut / high cut per track).",
         status="Built and checked on a computer; not yet run on an MKII."),
    dict(id="keys-control", device="keys", tag="control", features=[],
         title="Control build (no mods)",
         summary="Elektron's own Analog Keys code, only unpacked and packed again by this "
                 "tool. Flash it first.",
         status="Same file as the project's KEYS 1_CONTROL. Not yet run on an Analog Keys."),
    dict(id="keys-chord", device="keys", tag="0010", features=["chord"],
         title="Chord memory",
         summary="Hold 2-4 keys + FUNCTION + OCTAVE UP captures a chord; every key then "
                 "plays it with itself as the root. FUNCTION + OCTAVE UP with nothing held "
                 "or latched turns it off.",
         status="Built and checked on a computer; not yet run on an Analog Keys."),
    dict(id="keys-joy", device="keys", tag="0010_0011", features=["chord", "joy"],
         title="Chord memory + JOY RANDOM",
         summary="Chord memory, plus FUNCTION + OCTAVE DOWN: new random joystick "
                 "assignments for the active track ([NO/RELOAD] + [SOUND] undoes it).",
         status="Built and checked on a computer; not yet run on an Analog Keys."),
    dict(id="keys-joy-min", device="keys", tag="0011", features=["joy"],
         title="JOY RANDOM only",
         summary="Only the joystick roll (FUNCTION + OCTAVE DOWN), without chord memory.",
         status="Built and checked on a computer; not yet run on an Analog Keys."),
]

FEATURES = {
    "mk1": [
        dict(id="chop", label="CHOP / Sample Focus page"),
        dict(id="smpcut", label="SMP CUT (FILTER ×2: low/high cut)", requires=["chop"],
             why="SMP CUT is built to run through CHOP's page code, so it comes with CHOP."),
        dict(id="classic", label="Classic CHOP + step-lock (older, hardware-proven build)",
             excludes=["chop", "smpcut"],
             why="The classic build is a different, older image; it cannot be combined with "
                 "Sample Focus or SMP CUT."),
    ],
    "mk2": [
        dict(id="chop", label="CHOP / Sample Focus page"),
        dict(id="smpcut", label="SMP CUT (FILTER ×2: low/high cut)", requires=["chop"],
             why="SMP CUT is built to run through CHOP's page code, so it comes with CHOP."),
    ],
    "keys": [
        dict(id="chord", label="Chord memory"),
        dict(id="joy", label="JOY RANDOM (joystick roll)"),
    ],
}


def sha256(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def load_toml(p: Path) -> dict:
    with open(p, "rb") as fh:
        return tomllib.load(fh)


def git_head(repo: Path) -> str:
    try:
        return subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"],
                              capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def gated_out(gate, params, owner):
    """rytm1_mods tools/layout.py gated_out(), the same rule (re-stated here so the
    generator does not import the build tree)."""
    if gate is None:
        return False
    if "==" in gate:
        name, _, want = gate.partition("==")
        name = name.strip()
        if name not in params:
            raise SystemExit(f"{owner}: gate {gate!r} names no param")
        return str(params[name]) not in {w.strip() for w in want.split("|")}
    negate = gate.startswith("!")
    name = gate[1:] if negate else gate
    if name not in params:
        raise SystemExit(f"{owner}: gate {gate!r} names no param")
    return bool(params[name]) == negate


def active_regions(reg: dict, manifest: dict):
    """verify.py's `claimed`: the registry claims of the mods this build contains, with
    their gates resolved by the params the build used."""
    built = ({m["mod"] for m in manifest.get("mods", [])}
             | {d["mod"] for d in manifest.get("detours", [])}
             | {q["mod"] for q in manifest.get("patches", [])})
    params = manifest.get("params", {})

    def active(e):
        if e["owner"] not in built:
            return False
        if e["owner"] not in params:
            return True
        return not gated_out(e.get("gate"), params[e["owner"]], e["owner"])

    out = []
    for kind in ("cave", "detour", "patch"):
        for e in reg.get(kind, []):
            if active(e):
                out.append([e["addr"], e["size"], f"{kind}/{e['owner']}"])
    return sorted(out)


STOCK_RUN = 16


def low_entropy(b: bytes) -> bool:
    """Zero/0xFF padding with a few small values in it (RAM defaults): not anyone's
    expression, and kept as the mod's own bytes."""
    return len(set(b)) <= 3 and sum(1 for x in b if x in (0, 0xFF)) * 4 >= len(b) * 3


def stock_runs(data: bytes, stock: bytes):
    """Maximal runs (>= STOCK_RUN, not low-entropy) of `data` that occur in `stock`,
    left to right, without overlap: [(offset in data, length, offset in stock)]."""
    out, i, n = [], 0, len(data)
    while i + STOCK_RUN <= n:
        seg = data[i:i + STOCK_RUN]
        if low_entropy(seg) or stock.find(seg) < 0:
            i += 1
            continue
        ln = STOCK_RUN
        while i + ln < n and stock.find(data[i:i + ln + 1]) >= 0:
            ln += 1
        out.append((i, ln, stock.find(data[i:i + ln])))
        i += ln
    return out


def build_package(rec, r1m: Path, known: dict):
    sym_p, reg_p, bdir, stock_name = DEVICES[rec["device"]]
    build = r1m / bdir
    meta = load_toml(r1m / sym_p)["meta"]
    reg = load_toml(r1m / reg_p)
    base = meta["base"]
    tag = rec["tag"]

    published = next(k["output_sha256"] for k in known["recipes"] if k["id"] == rec["id"])
    stock_known = next(s for s in known["stock"]
                       if s["device"] == rec["device"] and s["supported"])

    manifest_raw = (build / f"manifest_{tag}.json").read_bytes()
    manifest = json.loads(manifest_raw)
    syx = (build / manifest["syx"]).read_bytes()
    if sha256(syx) != manifest["syx_sha256"] or sha256(syx) != published:
        raise SystemExit(f"{rec['id']}: built {manifest['syx']} is {sha256(syx)}, manifest says "
                         f"{manifest['syx_sha256']}, published is {published} - refusing")
    stock_syx = (r1m / "stock" / stock_name).read_bytes()
    if sha256(stock_syx) != stock_known["sha256"]:
        raise SystemExit(f"{rec['id']}: stock {stock_name} is not {stock_known['sha256']}")
    stock = (build / "stock_mainos.bin").read_bytes()
    patched = (build / f"mainos_{tag}.bin").read_bytes()
    if sha256(stock) != meta["mainos_sha256"] or len(stock) != meta["mainos_size"]:
        raise SystemExit(f"{rec['id']}: {build}/stock_mainos.bin is not the stock MAIN OS")
    if sha256(patched) != manifest["patched_mainos_sha256"] or len(patched) != len(stock):
        raise SystemExit(f"{rec['id']}: mainos_{tag}.bin does not match its manifest")

    key = hashlib.sha256(SITE_KEY_LABEL + stock).digest()

    def site_mac(addr, n):
        off = addr - base
        return hmac.new(key, addr.to_bytes(4, "big") + n.to_bytes(4, "big") + stock[off:off + n],
                        hashlib.sha256).hexdigest()

    detours = manifest.get("detours", [])
    displaced = sorted(((d["addr"], bytes.fromhex(d["displaced"])) for d in detours),
                       key=lambda t: -len(t[1]))
    edits = []
    copies = {}
    # cave code and data, with every re-emitted displaced span made a stock reference
    for m in manifest.get("mods", []):
        addr, n = m["stub_addr"], m["stub_size"]
        data = patched[addr - base: addr - base + n]
        parts, i, lit = [], 0, bytearray()
        while i < n:
            hit = next(((a, d) for a, d in displaced if data[i:i + len(d)] == d), None)
            if hit:
                if lit:
                    parts.append(["data", base64.b64encode(bytes(lit)).decode()])
                    lit = bytearray()
                parts.append(["stock", hit[0], len(hit[1])])
                i += len(hit[1])
            else:
                lit.append(data[i])
                i += 1
        if lit:
            parts.append(["data", base64.b64encode(bytes(lit)).decode()])
        # second pass: any other run of >= STOCK_RUN bytes that stock also holds (a call
        # sequence identical to stock's, a table that repeats a stock table) becomes a
        # reference too, so no package carries a long run equal to Elektron's bytes
        split = []
        for p in parts:
            if p[0] != "data":
                split.append(p)
                continue
            lit = base64.b64decode(p[1])
            at = 0
            for off, ln, src in stock_runs(lit, stock):
                if off > at:
                    split.append(["data", base64.b64encode(lit[at:off]).decode()])
                split.append(["stock", base + src, ln])
                copies[(base + src, ln)] = site_mac(base + src, ln)
                at = off + ln
            if at < len(lit):
                split.append(["data", base64.b64encode(lit[at:]).decode()])
        edits.append(dict(kind="cave", owner=m["mod"], section=m["section"], addr=addr, len=n,
                          expect_len=n, expect=site_mac(addr, n), parts=split))
    for d in detours:
        disp = bytes.fromhex(d["displaced"])
        jmp = patched[d["addr"] - base: d["addr"] - base + 6]
        if jmp != b"\x4e\xf9" + d["target"].to_bytes(4, "big"):
            raise SystemExit(f"{rec['id']}: detour 0x{d['addr']:08x} is not jmp 0x{d['target']:08x}")
        if stock[d["addr"] - base: d["addr"] - base + len(disp)] != disp:
            raise SystemExit(f"{rec['id']}: detour 0x{d['addr']:08x} displaced bytes differ")
        edits.append(dict(kind="detour", owner=d["mod"], addr=d["addr"], len=6,
                          expect_len=len(disp), expect=site_mac(d["addr"], len(disp)),
                          parts=[["data", base64.b64encode(jmp).decode()]]))
    for q in manifest.get("patches", []):
        want = bytes.fromhex(q["expect"])
        repl = bytes.fromhex(q["replace"])
        got = patched[q["addr"] - base: q["addr"] - base + len(repl)]
        if got != repl or stock[q["addr"] - base: q["addr"] - base + len(want)] != want:
            raise SystemExit(f"{rec['id']}: patch 0x{q['addr']:08x} does not match its manifest")
        edits.append(dict(kind="patch", owner=q["mod"], addr=q["addr"], len=len(repl),
                          expect_len=len(want), expect=site_mac(q["addr"], len(want)),
                          parts=[["data", base64.b64encode(got).decode()]]))
    edits.sort(key=lambda e: e["addr"])

    # no two edits overlap
    for a, b in zip(edits, edits[1:]):
        if a["addr"] + max(a["len"], a["expect_len"]) > b["addr"]:
            raise SystemExit(f"{rec['id']}: edits overlap at 0x{a['addr']:08x}/0x{b['addr']:08x}")

    # rebuild from stock + package and demand the built image back, byte for byte
    img = bytearray(stock)
    for e in edits:
        if site_mac(e["addr"], e["expect_len"]) != e["expect"]:
            raise SystemExit("internal: expect mismatch")
        out = bytearray()
        for p in e["parts"]:
            if p[0] == "data":
                out += base64.b64decode(p[1])
            else:
                out += stock[p[1] - base: p[1] - base + p[2]]
        if len(out) != e["len"]:
            raise SystemExit(f"{rec['id']}: edit 0x{e['addr']:08x} assembles to {len(out)} B, not {e['len']}")
        img[e["addr"] - base: e["addr"] - base + e["len"]] = out
    if bytes(img) != patched:
        bad = next(i for i in range(len(img)) if img[i] != patched[i])
        raise SystemExit(f"{rec['id']}: package does not rebuild the image (first diff 0x{base + bad:08x})")

    regions = active_regions(reg, manifest)
    for i in range(len(stock)):
        if stock[i] != patched[i]:
            va = base + i
            if not any(a <= va < a + s for a, s, _ in regions):
                raise SystemExit(f"{rec['id']}: changed byte 0x{va:08x} outside every claim")

    never_write = []
    if "embedded_bootstrap_start" in meta:
        never_write.append(["embedded bootstrap", meta["embedded_bootstrap_start"],
                            meta["embedded_bootstrap_end"]])
    if "never_write_start" in meta:
        never_write.append([meta.get("never_write_name", "never-write range"),
                            meta["never_write_start"], meta["never_write_end"]])

    stock_data_bytes = sum(p[2] for e in edits for p in e["parts"] if p[0] == "stock")
    detour_span = {(d["addr"], len(bytes.fromhex(d["displaced"]))) for d in detours}
    for e in edits:
        for p in e["parts"]:
            if p[0] == "stock" and (p[1], p[2]) not in detour_span and (p[1], p[2]) not in copies:
                raise SystemExit(f"{rec['id']}: undeclared stock reference 0x{p[1]:08x}+{p[2]}")
    mod_bytes = sum(len(base64.b64decode(p[1])) for e in edits for p in e["parts"] if p[0] == "data")
    return dict(
        format=FORMAT,
        id=rec["id"], device=rec["device"], os=meta["target"].replace("OS", ""),
        title=rec["title"], summary=rec["summary"], status=rec["status"],
        features=rec["features"],
        mods=sorted({m["mod"] for m in manifest.get("mods", [])}
                    | {d["mod"] for d in detours}
                    | {q["mod"] for q in manifest.get("patches", [])}),
        params=manifest.get("params", {}),
        stock=dict(syx_sha256=stock_known["sha256"], mainos_sha256=meta["mainos_sha256"],
                   mainos_size=meta["mainos_size"], section=MAINOS_SECTION,
                   other_sections=meta.get("other_sections", {})),
        base=base,
        site_key="HMAC-SHA256, key = SHA-256(\"rytm-installer site key v1\" || stock MAIN OS); "
                 "message = addr (u32 BE) || len (u32 BE) || the stock bytes there",
        never_write=never_write,
        regions=regions,
        edits=edits,
        stock_copies=[dict(addr=a, len=ln, expect=mac) for (a, ln), mac in sorted(copies.items())],
        detours=[dict(owner=d["mod"], addr=d["addr"], entry=d["entry"], target=d["target"],
                      displaced_len=len(bytes.fromhex(d["displaced"])), rejoin=d["rejoin"],
                      reemit=d.get("reemit", True)) for d in detours],
        output=dict(name=manifest["syx"], sha256=manifest["syx_sha256"], size=len(syx),
                    mainos_sha256=manifest["patched_mainos_sha256"]),
        counts=dict(edits=len(edits), mod_bytes=mod_bytes, stock_reference_bytes=stock_data_bytes,
                    stock_copies=len(copies)),
        provenance=dict(rytm1_mods_commit=rec.get("_commit", "unknown"),
                        manifest_sha256=sha256(manifest_raw),
                        generator="web/tools/mkpackages.py"),
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rytm1-mods", required=True, type=Path)
    ap.add_argument("--steplock-tree", type=Path, default=None,
                    help="a rytm1_mods tree at ee8665e (git archive) after `make chop` "
                         "there: its registry, symbols, stock and build/ (optional)")
    ap.add_argument("--steplock-commit", default="ee8665e")
    ap.add_argument("--out", type=Path, default=HERE / "generated" / "packages")
    args = ap.parse_args()

    known = json.loads((HERE / "src" / "engine" / "known.json").read_text())
    r1m = args.rytm1_mods.resolve()
    commit = git_head(r1m)
    args.out.mkdir(parents=True, exist_ok=True)
    index = {}
    for rec in RECIPES:
        tree = r1m
        rec = dict(rec, _commit=commit)
        if rec["id"] == "mk1-chop-steplock":
            if args.steplock_tree is None:
                print(f"skip {rec['id']} (no --steplock-tree)")
                continue
            tree = args.steplock_tree.resolve()
            rec["_commit"] = args.steplock_commit
        pkg = build_package(rec, tree, known)
        text = json.dumps(pkg, indent=1, ensure_ascii=True) + "\n"
        path = args.out / f"{rec['id']}.json"
        path.write_text(text)
        index[rec["id"]] = sha256(text.encode())
        c = pkg["counts"]
        print(f"ok   {rec['id']:22s} {len(pkg['edits']):3d} edits, {c['mod_bytes']:5d} mod bytes, "
              f"{c['stock_reference_bytes']:3d} B by stock reference ({c['stock_copies']} copy run(s) "
              f"besides the detour spans) -> {pkg['output']['sha256'][:16]}")
    rules = {dev: feats for dev, feats in FEATURES.items()}
    recipes = {r["id"]: dict(device=r["device"], features=r["features"])
               for r in RECIPES if r["id"] in index}
    idx = dict(format=FORMAT, packages=index, features=rules, recipes=recipes)
    (args.out / "index.json").write_text(json.dumps(idx, indent=1, ensure_ascii=False) + "\n")
    print(f"wrote {len(index)} packages + index.json to {args.out}")


if __name__ == "__main__":
    main()
