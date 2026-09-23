#!/usr/bin/env python3
"""Gate: contract flag surfaces resolve against owning script bytes (project-2od.14).

Compares each depended-on `--flag` declared in schema/contracts.yaml against
the literal bytes of the owning script. Pure function of bytes: no --help
execution (banned measurable: --help printed live pids and timed out on an
unchanged revision; drift/diff.py IGNORED_FIELDS).

Resolution order per command: upstream submodule at the pin, then the served
fork home ($FM_HOME/bin, else ~/code/firstmate/bin). Fork-only scripts resolve
only via the fork home; when no home resolves, they warn-and-skip (CI has no
fork checkout) instead of failing the wrong tree.

`--a/--b` notations split; `<...>` positionals are not flags and are skipped.

Usage:
  python3 scripts/check_flag_surfaces.py [--check]
  --check exits nonzero naming every drifted flag (this is also the gate).
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONTRACTS = ROOT / "schema" / "contracts.yaml"
UPSTREAM_BIN = ROOT / "sources" / "firstmate" / "bin"


def fork_bin() -> Path | None:
    home = os.environ.get("FM_HOME") or str(Path.home() / "code" / "firstmate")
    bindir = Path(home) / "bin"
    return bindir if bindir.is_dir() else None


def read_yaml(path):
    import yaml
    return yaml.safe_load(Path(path).read_text(encoding="utf-8"))


def resolve(command: str) -> tuple[str | None, str]:
    """Return (bytes-or-None, provenance). Absent everywhere -> (None, reason)."""
    rel = command[4:] if command.startswith("bin/") else command
    up = UPSTREAM_BIN / rel
    if up.is_file():
        return up.read_text(encoding="utf-8", errors="replace"), f"upstream@{rel}"
    fb = fork_bin()
    if fb is not None and (fb / rel).is_file():
        return (fb / rel).read_text(encoding="utf-8", errors="replace"), f"fork-home@{rel}"
    return None, ("absent upstream and no fork home"
                   if fb is None else f"absent upstream and absent under {fb}")


# Declared flags that differ from the owning upstream bytes ON PURPOSE:
# the fork replaced the upstream CLI with a sourced lib (or reshaped the
# surface) while the doorway flags stayed stable. Visible here, never silent;
# a new entry needs a reason, and the gate still fails anything unlisted.
KNOWN_DIVERGENCES = {
    # Upstream fm-tasks-axi.sh is the tasks-axi backend CLI; the fork serves
    # the beads backend through fm-tasks-axi-lib.sh (sourced, no CLI) while
    # the doorway keeps its own stable flag surface (project-4sh).
    ("tasks_list", "--state"),
    ("tasks_list", "--kind"),
    ("tasks_list", "--blocked"),
    ("tasks_list", "--limit"),
    ("tasks_list", "--fields"),
    ("tasks_show", "--full"),
    ("tasks_ready", "--include-held"),
}


def check(contracts_path=None) -> tuple:
    data = read_yaml(contracts_path or CONTRACTS)
    problems: list[str] = []
    skipped: list[str] = []
    diverged: list[str] = []
    for entry in data.get("contracts", []):
        name, command = entry.get("name", "?"), entry.get("command", "")
        if not command.startswith("bin/"):
            continue
        text, prov = resolve(command)
        if text is None:
            skipped.append(f"{name}: {prov}")
            continue
        for item in entry.get("flags", []):
            for flag in str(item).split("/"):
                if not flag.startswith("--"):
                    continue
                if flag not in text:
                    if (name, flag) in KNOWN_DIVERGENCES:
                        diverged.append(f"{name}:{flag}")
                        continue
                    problems.append(
                        f"contract '{name}' declares '{flag}' absent from {prov} "
                        f"({command}) — declaration drifted from the owning script"
                    )
    return problems, skipped, diverged


def main(argv=None) -> int:
    args = argv if argv is not None else sys.argv[1:]
    contracts = None
    if "--contracts" in args:
        contracts = args[args.index("--contracts") + 1]
    problems, skipped, diverged = check(contracts)
    for s in skipped:
        print(f"flag surfaces: skip ({s})")
    if diverged:
        print(f"flag surfaces: {len(diverged)} known fork-shape divergences (declared, not silent)")
    if problems:
        for p in problems:
            print(f"flag surfaces: {p}", file=sys.stderr)
        return 1
    print(f"flag surfaces: ok (all declared --flags resolve against owning script bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
