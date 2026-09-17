#!/usr/bin/env python3
"""Upstream-shift detector for the sources/firstmate submodule (stdlib only).

The submodule pin is the upstream-change signal: when upstream main moves
past the pin, this reports which *depended-on* surfaces moved, so ports into
the TS/Python impls start from that report instead of a blind re-read.

Usage:
    python3 drift/shift.py [--format json|markdown|text] [--fetch/--no-fetch]

- Pinned commit: read live from the gitlink (`git ls-tree HEAD
  sources/firstmate`); the `upstream` stanza in drift/baseline.json records
  the repo URL and the pin at capture time for humans.
- Upstream main: resolved via `git ls-remote <url> HEAD` (network). With
  --no-fetch, or when the network is unreachable, falls back to the
  submodule's local origin refs and says so.
- Shift diff: `git diff --name-only <pinned> <upstream> -- bin/` inside the
  submodule, mapped onto schema/contracts.yaml depended-on commands.
  Changed depended-on scripts are the port signal; everything else is noise.

Exit 0: pinned == upstream main (no shift). Exit 1: shift found.
Exit 2: usage or read errors (network unreachable, no gitlink, ...).
"""
import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SUBMODULE = "sources/firstmate"


def run(*argv, cwd=ROOT):
    try:
        proc = subprocess.run(
            list(argv),
            cwd=str(cwd),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=120,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ValueError(f"cannot run {' '.join(argv)}: {exc}")
    if proc.returncode != 0:
        raise ValueError(f"{' '.join(argv)} failed: {proc.stderr.strip()}")
    return proc.stdout.strip()


def submodule_url():
    gitmodules = ROOT / ".gitmodules"
    if gitmodules.exists():
        m = re.search(r"url\s*=\s*(\S+)", gitmodules.read_text(encoding="utf-8"))
        if m:
            return m.group(1)
    baseline = json.loads((ROOT / "drift" / "baseline.json").read_text(encoding="utf-8"))
    return baseline.get("upstream", {}).get("repo", "")


def pinned_commit():
    for args in (
        ("git", "ls-files", "--stage", SUBMODULE),
        ("git", "ls-tree", "HEAD", SUBMODULE),
    ):
        try:
            out = run(*args)
        except ValueError:
            continue
        m = re.search(r"\b([0-9a-f]{40})\b", out)
        if m:
            return m.group(1)
    raise ValueError(f"no gitlink at {SUBMODULE}; is the submodule initialized?")


def upstream_commit(url, do_fetch):
    """Resolve upstream main SHA. Returns (sha, how)."""
    if do_fetch:
        try:
            out = run("git", "ls-remote", url, "HEAD")
            return out.split()[0], "ls-remote"
        except (ValueError, IndexError):
            pass
    sub = ROOT / SUBMODULE
    for ref in ("origin/main", "origin/HEAD", "FETCH_HEAD"):
        try:
            return run("git", "rev-parse", ref, cwd=sub), f"local:{ref}"
        except ValueError:
            continue
    raise ValueError(
        f"cannot resolve upstream main for {url} "
        "(network unreachable and no local origin refs; retry with --fetch)"
    )


def depended_on_commands():
    """Parse schema/contracts.yaml -> {script basename: contract name}."""
    mapping = {}
    text = (ROOT / "schema" / "contracts.yaml").read_text(encoding="utf-8")
    name, command = None, None
    for line in text.splitlines():
        m = re.match(r"\s+- name:\s*(\S+)", line)
        if m:
            if name and command:
                _record(mapping, name, command)
            name, command = m.group(1), None
            continue
        m = re.match(r"\s+command:\s*\"?([^\"\n]+)\"?", line)
        if m and name:
            command = m.group(1).strip()
    if name and command:
        _record(mapping, name, command)
    return mapping


def _record(mapping, name, command):
    m = re.match(r"bin/(\S+\.sh)", command)
    if m:
        mapping[m.group(1)] = name


def changed_scripts(pinned, upstream):
    out = run(
        "git", "diff", "--name-only", pinned, upstream, "--", "bin/",
        cwd=ROOT / SUBMODULE,
    )
    return sorted(
        Path(p).name for p in out.splitlines() if p.endswith(".sh")
    )


def build_report(pinned, upstream, how, mapping, changed):
    moved = sorted({s for s in changed if s in mapping})
    noise = sorted({s for s in changed if s not in mapping})
    return {
        "pinned": pinned,
        "upstream": upstream,
        "resolved_via": how,
        "shift": pinned != upstream,
        "depended_on_moved": [
            {"script": s, "contract": mapping[s]} for s in moved
        ],
        "other_changed": noise,
        "summary": {
            "depended_on_moved": len(moved),
            "other_changed": len(noise),
        },
    }


def to_markdown(rep):
    lines = ["# Upstream shift report", ""]
    lines.append(f"- pinned: `{rep['pinned']}`")
    lines.append(f"- upstream main: `{rep['upstream']}` ({rep['resolved_via']})")
    lines.append("")
    if not rep["shift"]:
        lines.append("No shift: the pin tracks upstream main.")
        return "\n".join(lines) + "\n"
    lines.append(
        f"Shift found: {rep['summary']['depended_on_moved']} depended-on "
        f"surface(s) moved, {rep['summary']['other_changed']} other script(s) "
        "changed (noise)."
    )
    lines.append("")
    if rep["depended_on_moved"]:
        lines.append("## Depended-on surfaces that moved (port from here)")
        lines.append("")
        for entry in rep["depended_on_moved"]:
            lines.append(f"- `{entry['script']}` (contract `{entry['contract']}`)")
        lines.append("")
    if rep["other_changed"]:
        lines.append("## Other changed scripts (noise unless a pin names them)")
        lines.append("")
        for script in rep["other_changed"]:
            lines.append(f"- `{script}`")
    return "\n".join(lines) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(description="Diff the submodule pin against upstream main.")
    parser.add_argument("--format", choices=("json", "markdown", "text"), default="text")
    parser.add_argument("--fetch", dest="fetch", action="store_true", default=True)
    parser.add_argument("--no-fetch", dest="fetch", action="store_false")
    args = parser.parse_args(argv)
    try:
        url = submodule_url()
        if not url:
            raise ValueError("no submodule URL in .gitmodules or drift/baseline.json")
        pinned = pinned_commit()
        upstream, how = upstream_commit(url, args.fetch)
        mapping = depended_on_commands()
        changed = changed_scripts(pinned, upstream) if pinned != upstream else []
        rep = build_report(pinned, upstream, how, mapping, changed)
    except ValueError as exc:
        print(f"shift: {exc}", file=sys.stderr)
        return 2
    if args.format == "json":
        sys.stdout.write(json.dumps(rep, indent=2) + "\n")
    else:
        sys.stdout.write(to_markdown(rep))
    return 1 if rep["shift"] else 0


if __name__ == "__main__":
    sys.exit(main())
