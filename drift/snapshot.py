#!/usr/bin/env python3
"""Observed-inventory snapshot of firstmate command surfaces (read-only).

Inspects a firstmate checkout without modifying it: for every
``bin/fm-*.sh`` script it records the name, kind, file hash, parsed flag
surface from ``--help`` output, a bounded help excerpt plus its hash, and
any schema id hint found in the script header. Contract pins from
``schema/contracts.yaml`` are NOT re-declared here; this is the observed
side that the diff engine compares against a seeded baseline.

Usage:
    python3 -m drift.snapshot --fm-home /path/to/firstmate -o drift/observed.json
    python3 drift/snapshot.py --fm-home /path/to/firstmate -o drift/observed.json

Exit 0 on success. Exit 2 on usage or inspection errors.
"""
import argparse
import datetime
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

SNAPSHOT_VERSION = 1
HELP_TIMEOUT_S = 10
HELP_EXCERPT_LINES = 40
HEADER_LINES = 40

FLAG_RE = re.compile(r"--[A-Za-z0-9][A-Za-z0-9_-]*")
SCHEMA_HINT_RE = re.compile(r"[A-Za-z0-9_.-]*\.v\d+[A-Za-z0-9.]*")


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run_help(script, timeout=HELP_TIMEOUT_S):
    """Run `script --help` read-only; return (exit_code, combined_output)."""
    try:
        proc = subprocess.run(
            ["bash", str(script), "--help"],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return proc.returncode, (proc.stdout or "") + (proc.stderr or "")
    except (OSError, subprocess.SubprocessError) as exc:
        return -1, f"<help unavailable: {exc}>"


def parse_flags(help_text):
    """Extract the sorted unique long-flag surface from help text."""
    return sorted(set(FLAG_RE.findall(help_text)))


def header_contract(header_text):
    """First header line that looks like an output/schema contract, if any."""
    for line in header_text.splitlines():
        if "schema" in line.lower() or "output contract" in line.lower():
            stripped = line.strip().lstrip("#").strip()
            if stripped:
                return stripped[:200]
    return ""


def schema_hint(header_text, help_text):
    """Best-effort schema id hint (e.g. fm-fleet-snapshot.v1) from header/help."""
    for text in (header_text, help_text):
        for match in SCHEMA_HINT_RE.findall(text):
            if ".v" in match and len(match) <= 60:
                return match
    return ""


def inspect_script(script):
    help_code, help_text = run_help(script)
    try:
        header_text = "\n".join(
            script.read_text(encoding="utf-8", errors="replace").splitlines()[:HEADER_LINES]
        )
    except OSError:
        header_text = ""
    excerpt_lines = help_text.splitlines()[:HELP_EXCERPT_LINES]
    excerpt = "\n".join(excerpt_lines)[:4000]
    try:
        file_hash = sha256_file(script)
        stat = script.stat()
        size, mtime = stat.st_size, int(stat.st_mtime)
    except OSError:
        file_hash, size, mtime = "", 0, 0
    return {
        "name": script.name,
        "command": f"bin/{script.name}",
        "kind": "script",
        "flags": parse_flags(help_text),
        "help_exit": help_code,
        "help_excerpt": excerpt,
        "help_hash": hashlib.sha256(excerpt.encode("utf-8")).hexdigest(),
        "file_hash": file_hash,
        "size": size,
        "mtime": mtime,
        "schema_hint": schema_hint(header_text, help_text),
        "header_contract": header_contract(header_text),
    }


def firstmate_revision(fm_home):
    try:
        proc = subprocess.run(
            ["git", "-C", str(fm_home), "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if proc.returncode == 0:
            return proc.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        pass
    return ""


def collect(fm_home):
    fm_home = Path(fm_home)
    bin_dir = fm_home / "bin"
    if not bin_dir.is_dir():
        raise ValueError(f"no bin/ directory under {fm_home}")
    scripts = sorted(bin_dir.glob("fm-*.sh"))
    generated = (
        datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat()
    )
    return {
        "version": SNAPSHOT_VERSION,
        "generated": generated,
        "fm_home": str(fm_home),
        "firstmate_revision": firstmate_revision(fm_home),
        "surfaces": [inspect_script(script) for script in scripts],
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description="Snapshot firstmate command surfaces.")
    parser.add_argument("--fm-home", required=True, help="firstmate checkout to inspect (read-only)")
    parser.add_argument("-o", "--output", required=True, help="where to write the snapshot JSON")
    args = parser.parse_args(argv)
    try:
        snapshot = collect(args.fm_home)
    except ValueError as exc:
        print(f"snapshot: {exc}", file=sys.stderr)
        return 2
    out = Path(args.output)
    out.write_text(json.dumps(snapshot, indent=2) + "\n", encoding="utf-8")
    print(
        f"snapshot: ok: {len(snapshot['surfaces'])} surface(s) "
        f"rev {snapshot['firstmate_revision'] or 'unknown'} -> {out}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
