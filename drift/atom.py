#!/usr/bin/env python3
"""Atom-feed fast path for the upstream-shift watch (stdlib only).

Borrowed from the captain's auto-rebase-prs method: poll
github.com/<owner>/<repo>/commits/<branch>.atom for the latest main SHA
and compare it against a cached SHA - no API auth, no rate limit - instead
of heavier git operations (ls-remote / fetch / diff).

Exit codes mirror drift/shift.py so the two compose:
  0: feed SHA matches the cached SHA (quiet, nothing moved).
  1: feed SHA differs, or there is no cached SHA yet (fire: run the full
     shift.py diff to find out what moved).
  2: usage or read errors (feed unreachable, malformed feed, ...).

Malformed feeds are LOUD, never silent: feed parsing is fragile by nature
(grep/sed on XML breaks silently on format change), so any parse failure
prints an ATOM PARSE FAILURE warning to stderr and exits 2. Callers must
treat 2 as "atom says nothing, fall through to the full git path", never
as "no shift".

Usage:
    python3 drift/atom.py [--repo URL-or-owner/name] [--branch main]
                          [--timeout 15] [--feed-file PATH]
                          [--cache PATH] [--check SHA]
                          [--update-cache] [--format text|json]

- Without --cache/--check, prints the observed feed SHA and exits 0.
- With --cache PATH, compares against the cached SHA file (missing or
  empty cache fires, exit 1, so the first run populates via the full path).
- With --check SHA, compares against the SHA on the command line.
- With --update-cache, writes the observed feed SHA into --cache PATH
  after a successful parse (only make the write once the caller has
  decided what the observation means).
- With --feed-file PATH, reads feed XML from a file instead of the
  network (offline use and hermetic tests).

The submodule pin is the usual "cached SHA": drift/shift.py passes the
live gitlink as --check, so no extra cache file is needed in CI.
"""
import argparse
import json
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET

DEFAULT_BRANCH = "main"
DEFAULT_TIMEOUT_S = 15
ATOM_NS = "{http://www.w3.org/2005/Atom}"
SHA_RE = re.compile(r"\b[0-9a-f]{40}\b")


class AtomError(ValueError):
    """Feed unreachable or unreadable (exit 2, fall through to git)."""


class AtomParseError(AtomError):
    """Feed fetched but no commit SHA found (exit 2, LOUD, never silent)."""


def atom_url_for_repo(repo, branch=DEFAULT_BRANCH):
    """Normalize a git URL or owner/name into its commits Atom feed URL."""
    repo = (repo or "").strip().rstrip("/")
    if repo.endswith(".git"):
        repo = repo[:-4]
    m = re.match(r"https?://github\.com/([^/\s]+/[^/\s]+)/?$", repo)
    if m:
        repo = m.group(1)
    if not re.match(r"[^/\s]+/[^/\s]+$", repo):
        raise AtomError(f"cannot derive an Atom feed from repo {repo!r} "
                        "(want owner/name or a github.com URL)")
    return f"https://github.com/{repo}/commits/{branch}.atom"


def fetch_feed(url, timeout=DEFAULT_TIMEOUT_S):
    """Fetch Atom XML as text. Raises AtomError (never returns silently)."""
    req = urllib.request.Request(
        url, headers={"User-Agent": "firstmate-mcp-shift-atom/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8", "replace")
    except AtomError:
        raise
    except Exception as exc:
        raise AtomError(f"cannot fetch Atom feed {url}: {exc}")


def parse_feed_sha(xml_text):
    """Return the newest commit SHA in Atom XML.

    Raises AtomParseError with a LOUD message (feed excerpt included) when
    no SHA is found: the feed format may have changed, and guessing
    "unchanged" would wedge the watch silent.
    """
    if not xml_text or not xml_text.strip():
        raise AtomParseError(
            "ATOM PARSE FAILURE: empty feed body; GitHub may have changed "
            "the Atom format or the branch may be gone. Falling through to "
            "the full git path - atom says nothing.")
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError as exc:
        raise AtomParseError(
            "ATOM PARSE FAILURE: feed is not parseable XML "
            f"({exc}); GitHub may have changed the Atom format. "
            "Falling through to the full git path - atom says nothing. "
            f"Feed head: {xml_text[:300]!r}")
    entries = root.findall(f".//{ATOM_NS}entry")
    if not entries:
        entries = [el for el in root.iter()
                   if el.tag.split("}")[-1] == "entry"]
    for entry in entries:
        for child in entry:
            local = child.tag.split("}")[-1]
            if local == "id" and child.text:
                m = SHA_RE.search(child.text)
                if m:
                    return m.group(0)
            if local == "link":
                href = (child.get("href") or "") + " " + (child.text or "")
                m = re.search(r"/commit/([0-9a-f]{40})\b", href)
                if m:
                    return m.group(1)
                m = SHA_RE.search(href)
                if m:
                    return m.group(0)
    m = re.search(r"Grit::Commit/([0-9a-f]{40})", xml_text)
    if m:
        return m.group(1)
    m = re.search(r"/commit/([0-9a-f]{40})\b", xml_text)
    if m:
        return m.group(1)
    raise AtomParseError(
        "ATOM PARSE FAILURE: no 40-hex commit SHA in any entry id/link "
        "and no Grit::Commit marker; GitHub may have changed the Atom "
        "format. Falling through to the full git path - atom says nothing. "
        f"Feed head: {xml_text[:300]!r}")


def read_cached(path):
    """Return the cached SHA, or '' when missing/empty/unparseable."""
    try:
        text = open(path, encoding="utf-8").read()
    except OSError:
        return ""
    m = SHA_RE.search(text)
    return m.group(0) if m else ""


def write_cached(path, sha):
    try:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(sha + "\n")
    except OSError as exc:
        raise AtomError(f"cannot write atom cache {path}: {exc}")


def check_sha(feed_sha, cached_sha):
    """Return (changed: bool, reason: str) for a feed-vs-cache compare."""
    if not cached_sha:
        return True, "no cached SHA yet"
    if feed_sha == cached_sha:
        return False, "feed SHA matches cached SHA"
    return True, "feed SHA differs from cached SHA"


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Poll a repo Atom feed for its latest commit SHA.")
    parser.add_argument("--repo", default="",
                        help="git URL or owner/name "
                             "(default: upstream repo from drift/baseline.json)")
    parser.add_argument("--branch", default=DEFAULT_BRANCH)
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_S)
    parser.add_argument("--feed-file", default="",
                        help="read feed XML from PATH instead of the network")
    parser.add_argument("--cache", default="",
                        help="compare against the SHA cached in PATH")
    parser.add_argument("--check", default="",
                        help="compare against this SHA instead of a cache file")
    parser.add_argument("--update-cache", action="store_true",
                        help="write the observed feed SHA into --cache PATH")
    parser.add_argument("--format", choices=("text", "json"), default="text")
    args = parser.parse_args(argv)

    if args.check and args.cache:
        print("atom: --check and --cache are mutually exclusive",
              file=sys.stderr)
        return 2
    if args.update_cache and not args.cache:
        print("atom: --update-cache needs --cache PATH", file=sys.stderr)
        return 2

    repo = args.repo
    if not repo and not args.feed_file:
        try:
            repo = json.load(
                open("drift/baseline.json", encoding="utf-8")
            ).get("upstream", {}).get("repo", "")
        except (OSError, ValueError):
            repo = ""
    try:
        if args.feed_file:
            try:
                xml_text = open(args.feed_file, encoding="utf-8").read()
            except OSError as exc:
                raise AtomError(
                    f"cannot read feed file {args.feed_file}: {exc}")
            url = f"file:{args.feed_file}"
        else:
            if not repo:
                raise AtomError("no --repo and no upstream repo in "
                                "drift/baseline.json")
            url = atom_url_for_repo(repo, args.branch)
            xml_text = fetch_feed(url, timeout=args.timeout)
        feed_sha = parse_feed_sha(xml_text)
    except AtomError as exc:
        print(f"atom: WARN: {exc}", file=sys.stderr)
        return 2

    cached = ""
    if args.cache:
        cached = read_cached(args.cache)
    elif args.check:
        m = SHA_RE.search(args.check)
        cached = m.group(0) if m else ""
        if not cached:
            print(f"atom: --check value has no 40-hex SHA: {args.check!r}",
                  file=sys.stderr)
            return 2

    if args.cache and args.update_cache:
        try:
            write_cached(args.cache, feed_sha)
        except AtomError as exc:
            print(f"atom: WARN: {exc}", file=sys.stderr)
            return 2

    if not args.cache and not args.check:
        if args.format == "json":
            sys.stdout.write(json.dumps(
                {"repo": repo, "branch": args.branch, "atom_url": url,
                 "sha": feed_sha}) + "\n")
        else:
            sys.stdout.write(feed_sha + "\n")
        return 0

    changed, reason = check_sha(feed_sha, cached)
    if args.format == "json":
        sys.stdout.write(json.dumps(
            {"repo": repo, "branch": args.branch, "atom_url": url,
             "sha": feed_sha, "cached": cached or None,
             "changed": changed, "reason": reason}) + "\n")
    elif changed:
        sys.stdout.write(
            f"atom: CHANGE {cached[:12] if cached else '(no cache)'} -> "
            f"{feed_sha[:12]} ({reason}; {url})\n")
    else:
        sys.stdout.write(
            f"atom: quiet (feed SHA matches cached {feed_sha[:12]}; {url})\n")
    return 1 if changed else 0


if __name__ == "__main__":
    sys.exit(main())
