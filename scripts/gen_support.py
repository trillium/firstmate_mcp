#!/usr/bin/env python3
"""Support join: does firstmate_mcp support a pin-moved upstream feature, provably.

Bead: project-bx3x. One computed artifact, two views, one join.

Join (on script basename; all sides already on disk):
  upstream tree      sources/firstmate/bin            what upstream offers
  contract index     schema/contracts.index.json      what we feature
  served fork home   ~/code/firstmate/bin ($FM_HOME)  what can actually run here
  DENY_REASONS       scripts/gen_coverage.py          what we deliberately refuse
  fork spine         drift/fork-spine.json            which surfaces carry a fork delta

Coverage-time states (current pin):
  yes           featured + runnable + contract resolves
  no            upstream-only + not featured + not denied
  no-computed   upstream-only + not featured + denied-by-design (refusal recorded)
  altered       featured + a fork delta exists on that surface (class D)
  unrunnable    featured but dead on the served home (the degraded set)
Shift-time states add:
  upstream-removed  present at the old pin, absent at the new pin
"dropped" is NOT a shift state: a forward pin move cannot drop anything, and
denial is stationary (it would re-report every shift forever).

Gate: a surface that is runnable, not featured, and not denied fails loudly
until classified (catches fm-watch-arm.sh-style omissions without inventing
phantom ports; helpers and denied surfaces never count).

Policy (measured, not assumed): never execute upstream scripts. The dynamic
route (--help across the tree) reported 177/177 changed on an UNCHANGED
revision; drift/diff.py IGNORED_FIELDS bans it. The sanctioned channel is
header_contract (file content, never executed).

Usage:
  python3 scripts/gen_support.py [--json] [--check]
  python3 scripts/gen_support.py --shift OLD_PIN NEW_PIN [--json]
  python3 scripts/gen_support.py --upstream PATH --fork-home PATH (fixtures)
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FEATURES = ROOT / "manifest" / "FEATURES.yaml"
INDEX = ROOT / "schema" / "contracts.index.json"
SPINE = ROOT / "drift" / "fork-spine.json"

sys.path.insert(0, str(ROOT / "scripts"))
from gen_coverage import DENY_ALSO, DENY_REASONS  # noqa: E402


def read_yaml(path):
    import yaml
    return yaml.safe_load(Path(path).read_text(encoding="utf-8"))


def upstream_cmds(upstream_bin: Path) -> set[str]:
    bindir = upstream_bin if os.path.basename(upstream_bin) == "bin" else upstream_bin / "bin"
    return {
        f for f in os.listdir(bindir)
        if f.startswith("fm-") and f.endswith(".sh") and not f.endswith("-lib.sh")
    } if bindir.is_dir() else set()


def upstream_at_pin(upstream_repo: Path, rev: str) -> set[str]:
    out = subprocess.run(
        ["git", "-C", str(upstream_repo), "ls-tree", "-r", "--name-only",
         rev, "--", "bin/"],
        capture_output=True, check=True, text=True,
    ).stdout.split()
    return {
        p.removeprefix("bin/") for p in out
        if p.startswith("bin/fm-") and p.endswith(".sh")
        and not p.endswith("-lib.sh")
    }


def fork_runnable(fork_home: Path) -> set[str]:
    bindir = fork_home / "bin"
    return set(os.listdir(bindir)) if bindir.is_dir() else set()


def featured_scripts() -> set[str]:
    data = read_yaml(FEATURES)
    out = set()
    for e in data.get("features", []):
        if e.get("kind") == "upstream-mirror" and e.get("upstream_command"):
            base = Path(e["upstream_command"]).name
            # Command scope only: file:/derived: entries are not upstream surfaces.
            if base.startswith("fm-") and base.endswith(".sh") \
                    and not base.endswith("-lib.sh") and "/" not in base:
                out.add(base)
    return out


def contracted_scripts() -> set[str]:
    try:
        data = json.loads(INDEX.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return set()
    out = set()
    for _tool, cmd in (data.get("contracts") or {}).items():
        if isinstance(cmd, str) and cmd.startswith("bin/"):
            out.add(Path(cmd).name)
    return out


def denied_names() -> set[str]:
    # A surface is denied iff it is a DENY_REASONS owning command or a
    # DENY_ALSO key (the same wiring scripts/gen_coverage.py:classify uses).
    out = set()
    for _name, (cmd, _reason) in DENY_REASONS.items():
        out.add(cmd)
        out.add(Path(cmd).name)
    out.update(DENY_ALSO.keys())
    return out


def spine_classes() -> dict[str, str]:
    try:
        data = json.loads(SPINE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return {r["surface"]: r["class"] for r in data.get("rows", [])}


def classify(cmd: str, featured: set[str], contracted: set[str],
             runnable: set[str], denied: set[str],
             spine: dict[str, str]) -> str:
    if cmd in denied or cmd.replace(".sh", "") in denied:
        return "no-computed" if cmd not in featured else "altered-refused"
    if cmd not in featured:
        return "no"
    if cmd not in runnable:
        return "unrunnable"
    if spine.get(cmd) == "D":
        return "altered"
    if cmd in contracted:
        return "yes"
    return "yes-uncontracted"


def build(upstream_bin: Path, fork_home: Path) -> list[dict]:
    cmds = upstream_cmds(upstream_bin)
    runnable_all = fork_runnable(fork_home)
    featured = featured_scripts()
    contracted = contracted_scripts()
    denied = denied_names()
    spine = spine_classes()
    rows = []
    for cmd in sorted(cmds):
        rows.append({
            "surface": cmd,
            "featured": cmd in featured,
            "contracted": cmd in contracted,
            "runnable": cmd in runnable_all,
            "denied": cmd in denied or cmd.replace(".sh", "") in denied,
            "spine_class": spine.get(cmd),
            "state": classify(cmd, featured, contracted, runnable_all, denied, spine),
        })
    return rows


def gate(rows: list[dict]) -> list[str]:
    """Runnable, featured by nothing, refused by nothing: classify it."""
    bad = [r["surface"] for r in rows
           if r["runnable"] and not r["featured"] and not r["denied"]
           and r["state"] not in ("yes", "yes-uncontracted", "altered")]
    return sorted(set(bad))


def render(rows: list[dict]) -> str:
    counts: dict[str, int] = {}
    for r in rows:
        counts[r["state"]] = counts.get(r["state"], 0) + 1
    lines = ["# Support join (generated view)",
             "",
             "<!-- GENERATED by scripts/gen_support.py — do not hand-edit. -->",
             "",
             "States: `yes` featured+runnable+contracted · `no` upstream-only, "
             "unfeatured, undenied · `no-computed` denied-by-design · `altered` "
             "featured with a fork delta (class D) · `unrunnable` featured but "
             "dead on the served home.",
             "",
             "Counts: " + ", ".join(f"{k}={counts.get(k, 0)}" for k in
                                    ["yes", "no", "no-computed", "altered",
                                     "unrunnable", "yes-uncontracted",
                                     "altered-refused"]),
             "",
             "| Surface | Featured | Contracted | Runnable | Denied | Spine | State |",
             "| --- | --- | --- | --- | --- | --- | --- |"]
    for r in rows:
        cells = [f"`{r['surface']}`"]
        for k in ["featured", "contracted", "runnable", "denied"]:
            cells.append("yes" if r[k] else "—")
        cells.append(r["spine_class"] or "—")
        cells.append(r["state"])
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines) + "\n"


def shift_rows(old_pin: str, new_pin: str, upstream_repo: Path,
               fork_home: Path) -> list[dict]:
    old, new = upstream_at_pin(upstream_repo, old_pin), upstream_at_pin(upstream_repo, new_pin)
    featured, contracted = featured_scripts(), contracted_scripts()
    runnable_all = fork_runnable(fork_home)
    denied, spine = denied_names(), spine_classes()
    rows = []
    for cmd in sorted((new - old) | {c for c in old if c not in new}):
        if cmd in old and cmd not in new:
            state = "upstream-removed"
        else:
            state = classify(cmd, featured, contracted, runnable_all, denied, spine)
        rows.append({"surface": cmd, "state": state})
    return rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--shift", nargs=2, metavar=("OLD_PIN", "NEW_PIN"))
    ap.add_argument("--upstream", default=None)
    ap.add_argument("--fork-home", default=None)
    args = ap.parse_args()
    upstream_repo = Path(ROOT / "sources" / "firstmate")
    upstream_bin = Path(args.upstream) if args.upstream else upstream_repo / "bin"
    fork_home = Path(args.fork_home) if args.fork_home else Path(
        os.environ.get("FM_HOME", str(Path.home() / "code" / "firstmate")))
    if args.shift:
        rows = shift_rows(args.shift[0], args.shift[1], upstream_repo, fork_home)
    else:
        rows = build(upstream_bin, fork_home)
    if args.json:
        print(json.dumps({"rows": rows}, indent=2))
        return 0
    if args.check:
        bad = gate(rows)
        if bad:
            print("support join: runnable, unfeatured, undenied surfaces (classify them):",
                  file=sys.stderr)
            for b in bad:
                print(f"  {b}", file=sys.stderr)
            return 1
        print(f"support join: ok ({len(rows)} surfaces, no unclassified runnable)")
        return 0
    print(render(rows))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
