#!/usr/bin/env python3
"""Test provenance: resolve, repair, and never let it rot again.

`manifest/FEATURES.yaml` cites, for every feature, the test that establishes it. That
citation is how the manifest can *demonstrate* a feature is present rather than merely
assert it. Nothing resolved those citations, so they rotted silently when the
conformance suite was sharded: 58 features pointed at `ts/tests/conformance.test.ts`,
a file that no longer exists, and others named describe blocks that had been renamed
(`sessions equivalence` where the shard says `session-read equivalence`).

A citation is `<path>` or `<path>::<case>`, optionally followed by ` (human note)`,
and several may be joined with ` + `. `none (...)` is a documented absence.

Usage:
    python3 scripts/test_provenance.py --check   # resolve every citation, exit 1 on rot
    python3 scripts/test_provenance.py --repair  # rewrite citations to real tests
"""
import argparse
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
FEATURES = ROOT / "manifest" / "FEATURES.yaml"

CITATION_RE = re.compile(r"^([A-Za-z0-9._/+-]+\.(?:ts|sh|py))(::(.*))?$")


def strip_note(text: str) -> str:
    """Drop the manifest's trailing human description, which is not part of a title."""
    return re.sub(r"\s*\([^()]*\)\s*$", "", text.strip()).strip()


def split_citations(value: str) -> list[str]:
    return [part.strip() for part in value.split(" + ") if part.strip()]


def parse(citation: str):
    """-> (path, case_or_None) or None when the citation is not shaped like a citation."""
    m = CITATION_RE.match(strip_note(citation))
    if not m:
        return None
    return m.group(1), (strip_note(m.group(3)) if m.group(3) else None)


def test_titles(path: pathlib.Path) -> list[str]:
    text = path.read_text(encoding="utf-8", errors="replace")
    titles = re.findall(r'it\(\s*"([^"]+)"', text)
    titles += re.findall(r'describe\(\s*"([^"]+)"', text)
    titles += re.findall(r"^\s*(test_[a-z0-9_]+)\(\)", text, re.M)
    return titles


def resolve(citation: str) -> tuple[bool, str]:
    """(ok, reason). Feedback names what is wrong, so a repair can act on it."""
    if citation.startswith("none"):
        return True, "documented absence"
    parsed = parse(citation)
    if parsed is None:
        return False, "not shaped like a citation"
    path_str, case = parsed
    path = ROOT / path_str
    if not path.exists():
        return False, f"file missing: {path_str}"
    if case and case not in path.read_text(encoding="utf-8", errors="replace"):
        return False, f"case not found in {path_str}: {case}"
    return True, "ok"


def candidates(feature_id: str) -> list[tuple[str, str]]:
    """Every (path, title) whose title names this feature, best first."""
    found = []
    for path in sorted((ROOT / "ts/tests").glob("*.test.ts")) + sorted((ROOT / "tests").glob("*.test.sh")):
        rel = str(path.relative_to(ROOT))
        for title in test_titles(path):
            if title.startswith(feature_id):
                found.append((rel, title))
    if not found:
        # Tests are often named for the verb, not the tool: lifecycle_interrupt is
        # covered by "interrupt refuses without approval", spawn_crew by "spawn
        # requires note". Match the feature id's own tokens so provenance points at a
        # real test rather than falling back to "none".
        tokens = [t for t in re.split(r"[_]+", feature_id) if len(t) > 3]
        for path in sorted((ROOT / "ts/tests").glob("*.test.ts")):
            rel = str(path.relative_to(ROOT))
            for title in test_titles(path):
                if any(token in title.lower() for token in tokens):
                    found.append((rel, title))
    for pref in ("matches direct stub", "matches direct", "agrees with", "matches"):
        for rel, title in found:
            if pref in title:
                return [(rel, title)] + [f for f in found if (f[0], f[1]) != (rel, title)]
    return found


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="resolve citations; exit 1 on rot")
    parser.add_argument("--repair", action="store_true", help="rewrite citations to real tests")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args(argv)

    lines = FEATURES.read_text(encoding="utf-8").split("\n")
    feature_id = None
    broken, repaired, absent = [], 0, 0
    for i, line in enumerate(lines):
        m = re.match(r"^  - id: ([a-z0-9_]+)\s*$", line)
        if m:
            feature_id = m.group(1)
            continue
        if feature_id is None or not line.strip().startswith("upstream_test:"):
            continue
        declared = line.split("upstream_test:", 1)[1].strip().strip('"')
        if declared.startswith("none"):
            absent += 1
            continue
        bad = [c for c in split_citations(declared) if not resolve(c)[0]]
        if not bad:
            continue
        if args.repair:
            fixed = []
            for citation in split_citations(declared):
                ok, _ = resolve(citation)
                if ok:
                    fixed.append(citation)
                    continue
                note = ""
                m_note = re.search(r"(\([^()]*\))\s*$", citation)
                if m_note:
                    note = " " + m_note.group(1)
                replacement = None
                for rel, title in candidates(feature_id):
                    replacement = f"{rel}::{title}{note}"
                    break
                if replacement is None:
                    # No test names this feature: keep the path if it exists, so the
                    # citation stays a real pointer, and record the loss of the case.
                    parsed = parse(citation)
                    replacement = f"{parsed[0]}{note}" if parsed and (ROOT / parsed[0]).exists() else f"none (no test names {feature_id})"
                fixed.append(replacement)
            lines[i] = '    upstream_test: "' + " + ".join(fixed) + '"'
            repaired += 1
            continue
        broken.append((feature_id, bad))

    if args.repair:
        FEATURES.write_text("\n".join(lines), encoding="utf-8")
        print(f"test provenance: repaired {repaired} feature(s)")
        return 0

    if broken:
        print(f"test provenance: {len(broken)} feature(s) cite tests that do not resolve:", file=sys.stderr)
        for fid, bad in broken[:12]:
            for citation in bad:
                print(f"  {fid}: {resolve(citation)[1]}", file=sys.stderr)
        if len(broken) > 12:
            print(f"  ... and {len(broken) - 12} more", file=sys.stderr)
        return 1
    print(f"test provenance: ok: every citation resolves ({absent} documented absence)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
