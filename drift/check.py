#!/usr/bin/env python3
"""CLI entry comparing two snapshots: `drift check` (stdlib only).

Usage:
    python3 -m drift.check BASELINE OBSERVED [--format json|markdown|text]
    python3 drift/check.py BASELINE OBSERVED [--format json|markdown|text]

Exit 0: no drift. Exit 1: drift detected. Exit 2: usage or read errors.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from drift.diff import diff_snapshots
from drift.report import to_json, to_markdown, to_text


def load_snapshot(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except OSError as exc:
        raise ValueError(f"cannot read {path}: {exc}")
    except json.JSONDecodeError as exc:
        raise ValueError(f"{path} is not valid JSON: {exc}")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Compare two drift snapshots.")
    parser.add_argument("baseline", help="baseline snapshot JSON")
    parser.add_argument("observed", help="observed snapshot JSON to compare")
    parser.add_argument(
        "--format",
        choices=("json", "markdown", "text"),
        default="text",
        help="report shape: json (machine-readable) or markdown/text (human-readable)",
    )
    args = parser.parse_args(argv)
    try:
        baseline = load_snapshot(args.baseline)
        observed = load_snapshot(args.observed)
    except ValueError as exc:
        print(f"drift check: {exc}", file=sys.stderr)
        return 2
    report = diff_snapshots(baseline, observed)
    if args.format == "json":
        sys.stdout.write(to_json(report))
    elif args.format == "markdown":
        sys.stdout.write(to_markdown(report))
    else:
        sys.stdout.write(to_text(report))
    return 1 if not report["summary"]["clean"] else 0


if __name__ == "__main__":
    sys.exit(main())
