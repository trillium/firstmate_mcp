#!/usr/bin/env python3
"""Upstream-shift detector for the sources/firstmate submodule (stdlib only).

The submodule pin is the upstream-change signal: when upstream main moves
past the pin, this reports which *depended-on* surfaces moved, so ports into
the TS/Python impls start from that report instead of a blind re-read.

Usage:
    python3 drift/shift.py [--format json|markdown|text] [--fetch/--no-fetch]
                           [--atom/--no-atom] [--atom-branch BRANCH]
                           [--atom-timeout SECS] [--atom-url URL]
                           [--atom-feed-file PATH]

Atom fast path (default when fetching): before any git network call, poll
the repo's Atom feed for the latest branch SHA and compare it against the
pin - the pin is the cached SHA, quiet when unchanged. On agreement the
detector reports no shift without ls-remote or the bin/ diff. On
disagreement, or when the feed is unreachable or malformed (loud warning
on stderr), it falls through to the full git path, which stays
authoritative. --no-atom forces the full path; --no-fetch implies it
(fully offline, local origin refs only).

- Pinned commit: read live from the gitlink (`git ls-tree HEAD
  sources/firstmate`); the `upstream` stanza in drift/baseline.json records
  the repo URL and the pin at capture time for humans.
- Upstream main: resolved via `git ls-remote <url> HEAD` (network), unless
  the Atom fast path already agreed with the pin (feed SHA == pin: no
  shift, ls-remote skipped). With
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

try:
    from drift import atom as atom_mod
except ImportError:  # invoked as `python3 drift/shift.py`
    import atom as atom_mod

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


def atom_short_circuit(url, pinned, mapping, branch="main", timeout=15,
                       feed_url="", feed_file=""):
    """Atom-feed fast path: cheap change detector ahead of the git path.

    Returns a no-shift report when the feed SHA agrees with the pin (no
    ls-remote, no bin/ diff), else None meaning "run the full git path".
    Feed trouble warns loudly on stderr and returns None - atom never
    vetoes the authoritative diff, and a changed SHA never skips it.
    """
    try:
        if feed_file:
            try:
                xml_text = Path(feed_file).read_text(encoding="utf-8")
            except OSError as exc:
                raise ValueError(
                    f"cannot read atom feed file {feed_file}: {exc}")
            feed_sha = atom_mod.parse_feed_sha(xml_text)
            source = f"atom:feed-file:{feed_file}"
        else:
            feed = feed_url or atom_mod.atom_url_for_repo(url, branch)
            xml_text = atom_mod.fetch_feed(feed, timeout=timeout)
            feed_sha = atom_mod.parse_feed_sha(xml_text)
            source = f"atom:{feed}"
    except atom_mod.AtomError as exc:
        print(f"shift: WARN: atom fast-path unavailable ({exc}); "
              f"falling through to git", file=sys.stderr)
        return None
    if feed_sha == pinned:
        return build_report(pinned, pinned,
                            f"atom:unchanged ({source}, ls-remote skipped)",
                            mapping, [])
    return None


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
    # Fail LOUD on an uninitialized submodule (task-eyl89): running git with
    # cwd inside an empty submodule dir resolves upward to the parent repo,
    # where `-- bin/` matches nothing and the diff silently reports 0/0 while
    # depended-on surfaces moved. Never fetch-or-infer around it.
    sub = ROOT / SUBMODULE
    if not (sub / ".git").exists():
        raise ValueError(
            f"submodule worktree absent at {SUBMODULE} (no .git): initialize "
            "it before diffing — an empty dir would report a silent 0/0 no-shift"
        )
    try:
        run("git", "cat-file", "-t", pinned, cwd=sub)
    except ValueError:
        raise ValueError(
            f"pinned commit {pinned[:12]} unreadable inside {SUBMODULE}: "
            "cannot diff what cannot be read"
        )
    out = run(
        "git", "diff", "--name-only", pinned, upstream, "--", "bin/",
        cwd=sub,
    )
    return sorted(
        Path(p).name for p in out.splitlines() if p.endswith(".sh")
    )


def spine_classes():
    """Fork classes from the committed spine (project-rkk9/bx3x).

    The spine tracks the OLD pin during --check, so classes describe where
    each surface stood, not the new tree: a class-D flag means port with
    awareness of our delta, never auto-merge."""
    try:
        data = json.load(open(ROOT / "drift" / "fork-spine.json", encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return {r["surface"]: r["class"] for r in data.get("rows", [])}


def build_report(pinned, upstream, how, mapping, changed):
    moved = sorted({s for s in changed if s in mapping})
    noise = sorted({s for s in changed if s not in mapping})
    spine = spine_classes()
    depended = [
        {"script": s, "contract": mapping[s],
         "spine_class": spine.get(s)} for s in moved
    ]
    with_delta = sum(1 for e in depended if e["spine_class"] == "D")
    return {
        "pinned": pinned,
        "upstream": upstream,
        "resolved_via": how,
        "shift": pinned != upstream,
        "depended_on_moved": depended,
        "other_changed": noise,
        "summary": {
            "depended_on_moved": len(moved),
            "other_changed": len(noise),
            "moved_with_fork_delta": with_delta,
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
            cls = entry.get("spine_class")
            extra = f" [fork delta, class {cls}]" if cls == "D" else (
                f" [spine class {cls}]" if cls else "")
            lines.append(f"- `{entry['script']}` (contract `{entry['contract']}`){extra}")
        if rep["summary"].get("moved_with_fork_delta"):
            lines.append("")
            lines.append(f"Note: {rep['summary']['moved_with_fork_delta']} moved surface(s) "
                         "carry a fork delta (class D) — port with awareness of the delta, "
                         "never auto-merge.")
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
    parser.add_argument("--atom", dest="atom", action="store_true", default=True)
    parser.add_argument("--no-atom", dest="atom", action="store_false")
    parser.add_argument("--atom-branch", default="main")
    parser.add_argument("--atom-timeout", type=float, default=15)
    parser.add_argument("--atom-url", default="",
                        help="override the Atom feed URL "
                             "(default: derived from the submodule URL)")
    parser.add_argument("--atom-feed-file", default="",
                        help="read the Atom feed from PATH instead of the "
                             "network (offline use and hermetic tests)")
    args = parser.parse_args(argv)
    try:
        url = submodule_url()
        if not url:
            raise ValueError("no submodule URL in .gitmodules or drift/baseline.json")
        pinned = pinned_commit()
        mapping = depended_on_commands()
        rep = None
        if args.atom and args.fetch:
            rep = atom_short_circuit(url, pinned, mapping,
                                     branch=args.atom_branch,
                                     timeout=args.atom_timeout,
                                     feed_url=args.atom_url,
                                     feed_file=args.atom_feed_file)
        if rep is None:
            upstream, how = upstream_commit(url, args.fetch)
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
