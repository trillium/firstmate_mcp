#!/usr/bin/env bash
# Hermetic proof for the upstream-shift Atom-feed fast path.
# No network, no submodule, no live checkout: layer A drives the real
# drift/atom.py CLI against fake feed files (moved SHA fires, unchanged SHA
# stays quiet, malformed feeds warn LOUDLY); layer B drives the real
# drift/shift.py wiring with stubbed git/network proving the cheap path
# skips ls-remote + diff on agreement and fails open to the full git path
# on disagreement, feed trouble, --no-atom, and --no-fetch.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ATOM="$ROOT/drift/atom.py"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/shift-atom.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT INT TERM

SHA_A="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
SHA_B="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'ok - %s\n' "$1"
}

expect_code() {
  local expected=$1 actual=$2 label=$3 details=${4-}
  [ "$actual" = "$expected" ] && return 0
  [ -z "$details" ] || printf '%s\n' "$details" >&2
  fail "$label: expected exit $expected, got $actual"
}

assert_contains() {
  case "$1" in
    *"$2"*) : ;;
    *) fail "$3 (missing: '$2')"$'\n'"--- output ---"$'\n'"$1" ;;
  esac
}

make_feed() {
  # $1 = path, $2.. = SHAs (newest first)
  local path=$1; shift
  {
    printf '%s\n' '<?xml version="1.0" encoding="utf-8"?>'
    printf '%s\n' '<feed xmlns="http://www.w3.org/2005/Atom">'
    printf '%s\n' '  <title>Recent Commits to firstmate:main</title>'
    for sha in "$@"; do
      printf '%s\n' '  <entry>' \
        "    <id>tag:github.com,2008:Grit::Commit/${sha}abcdef</id>" \
        "    <link href=\"https://github.com/kunchenguid/firstmate/commit/${sha}\"/>" \
        '    <updated>2026-09-17T00:00:00Z</updated>' \
        '  </entry>'
    done
    printf '%s\n' '</feed>'
  } >"$path"
}

# Layer A: atom.py CLI against fake feeds.

test_moved_sha_fires() {
  local feed="$TMP_ROOT/moved.atom" out status
  make_feed "$feed" "$SHA_B" "$SHA_A"
  out=$(python3 "$ATOM" --feed-file "$feed" --check "$SHA_A" 2>&1)
  status=$?
  expect_code 1 "$status" "moved SHA should fire" "$out"
  assert_contains "$out" "CHANGE" "moved SHA did not print CHANGE" "$out"
}

test_unchanged_sha_silent() {
  local feed="$TMP_ROOT/same.atom" out status
  make_feed "$feed" "$SHA_A"
  out=$(python3 "$ATOM" --feed-file "$feed" --check "$SHA_A" 2>&1)
  status=$?
  expect_code 0 "$status" "unchanged SHA should stay quiet" "$out"
  assert_contains "$out" "quiet" "unchanged SHA did not print quiet" "$out"
}

test_malformed_feed_warns_loudly() {
  local feed="$TMP_ROOT/bad.atom" out status
  printf '%s\n' '<feed><entry><id>no sha here</id></entry></feed>' >"$feed"
  out=$(python3 "$ATOM" --feed-file "$feed" --check "$SHA_A" 2>&1)
  status=$?
  expect_code 2 "$status" "malformed feed should exit 2" "$out"
  assert_contains "$out" "ATOM PARSE FAILURE" \
    "malformed feed did not warn LOUDLY" "$out"
}

test_garbage_feed_warns_loudly() {
  local feed="$TMP_ROOT/garbage.atom" out status
  printf '%s\n' 'this is not xml at all <>>>' >"$feed"
  out=$(python3 "$ATOM" --feed-file "$feed" --check "$SHA_A" 2>&1)
  status=$?
  expect_code 2 "$status" "garbage feed should exit 2" "$out"
  assert_contains "$out" "ATOM PARSE FAILURE" \
    "garbage feed did not warn LOUDLY" "$out"
}

test_empty_feed_warns_loudly() {
  local feed="$TMP_ROOT/empty.atom" out status
  : >"$feed"
  out=$(python3 "$ATOM" --feed-file "$feed" --check "$SHA_A" 2>&1)
  status=$?
  expect_code 2 "$status" "empty feed should exit 2" "$out"
  assert_contains "$out" "ATOM PARSE FAILURE" \
    "empty feed did not warn LOUDLY" "$out"
}

test_cache_roundtrip() {
  local feed="$TMP_ROOT/cache.atom" cache="$TMP_ROOT/atom.sha" out status
  make_feed "$feed" "$SHA_B"
  out=$(python3 "$ATOM" --feed-file "$feed" --cache "$cache" 2>&1)
  status=$?
  expect_code 1 "$status" "missing cache should fire (fail-open)" "$out"
  out=$(python3 "$ATOM" --feed-file "$feed" --cache "$cache" --update-cache 2>&1)
  status=$?
  expect_code 1 "$status" "first observation still fires" "$out"
  [ -f "$cache" ] || fail "update-cache wrote no cache file"
  out=$(python3 "$ATOM" --feed-file "$feed" --cache "$cache" 2>&1)
  status=$?
  expect_code 0 "$status" "cached SHA should stay quiet" "$out"
  assert_contains "$out" "quiet" "cached SHA did not print quiet" "$out"
}

test_plain_sha_print() {
  local feed="$TMP_ROOT/plain.atom" out status
  make_feed "$feed" "$SHA_B"
  out=$(python3 "$ATOM" --feed-file "$feed" 2>&1)
  status=$?
  expect_code 0 "$status" "plain poll should exit 0" "$out"
  assert_contains "$out" "$SHA_B" "plain poll did not print the feed SHA" "$out"
}

test_repo_normalization() {
  local out status
  out=$(cd "$ROOT" && python3 - 2>&1 <<'PYEOF'
from drift import atom
assert atom.atom_url_for_repo(
    "https://github.com/kunchenguid/firstmate.git", "main") == \
    "https://github.com/kunchenguid/firstmate/commits/main.atom"
assert atom.atom_url_for_repo("kunchenguid/firstmate") == \
    "https://github.com/kunchenguid/firstmate/commits/main.atom"
try:
    atom.atom_url_for_repo("not-a-repo")
except atom.AtomError as exc:
    print(f"refused as expected: {exc}")
else:
    raise AssertionError("garbage repo string was accepted")
print("normalization ok")
PYEOF
) || fail "repo normalization raised"$'\n'"$out"
  status=$?
  expect_code 0 "$status" "repo normalization block failed" "$out"
  assert_contains "$out" "normalization ok" "normalization did not finish" "$out"
}

# Layer B: shift.py wiring with stubbed git + network (fake feeds only).

shift_case() {
  # $1 = case (unchanged|moved|malformed|no-atom|no-fetch)
  cd "$ROOT" && python3 - "$1" "$TMP_ROOT" <<'PYEOF'
import io
import sys
from contextlib import redirect_stderr, redirect_stdout
from drift import atom as atom_mod
from drift import shift

case, tmp = sys.argv[1], sys.argv[2]
PIN = "a" * 40
FEED_NEW = "a" * 40   # unchanged case: feed agrees with the pin
FEED_MOVED = "c" * 40  # moved case: feed disagrees with pin and ls-remote

def feed_xml(sha):
    return (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<feed xmlns="http://www.w3.org/2005/Atom">'
        "<entry>"
        f"<id>tag:github.com,2008:Grit::Commit/{sha}xxx</id>"
        f'<link href="https://github.com/kunchenguid/firstmate/commit/{sha}"/>'
        "</entry></feed>")

calls = {"upstream": 0, "fetch": 0}
shift.pinned_commit = lambda: PIN
shift.submodule_url = lambda: "https://github.com/kunchenguid/firstmate.git"

def forbid_fetch(url, timeout=15):
    calls["fetch"] += 1
    raise AssertionError("network must not be touched on this path")

def forbid_upstream(url, do_fetch):
    calls["upstream"] += 1
    raise AssertionError("ls-remote path must not run on this path")

if case == "unchanged":
    atom_mod.fetch_feed = lambda url, timeout=15: feed_xml(FEED_NEW)
    shift.upstream_commit = forbid_upstream
    shift.changed_scripts = lambda p, u: (_ for _ in ()).throw(
        AssertionError("diff must not run on the unchanged path"))
elif case == "moved":
    atom_mod.fetch_feed = lambda url, timeout=15: feed_xml(FEED_MOVED)
    shift.upstream_commit = lambda url, do_fetch: ("b" * 40, "ls-remote")
    shift.changed_scripts = lambda p, u: ["fm-fleet-snapshot.sh"]
elif case == "malformed":
    atom_mod.fetch_feed = lambda url, timeout=15: "<feed><nope/></feed>"
    shift.upstream_commit = lambda url, do_fetch: ("b" * 40, "ls-remote")
    shift.changed_scripts = lambda p, u: ["fm-fleet-snapshot.sh"]
elif case in ("no-atom", "no-fetch"):
    atom_mod.fetch_feed = forbid_fetch
    shift.upstream_commit = lambda url, do_fetch: ("b" * 40, "ls-remote")
    shift.changed_scripts = lambda p, u: ["fm-fleet-snapshot.sh"]

argv = {"unchanged": ["--format", "json"],
        "moved": ["--format", "markdown"],
        "malformed": ["--format", "markdown"],
        "no-atom": ["--format", "markdown", "--no-atom"],
        "no-fetch": ["--format", "markdown", "--no-fetch"]}[case]

out, err = io.StringIO(), io.StringIO()
with redirect_stdout(out), redirect_stderr(err):
    code = shift.main(argv)
print(f"EXIT={code}")
print(f"FETCH_CALLS={calls['fetch']}")
print("--- stdout ---")
print(out.getvalue())
print("--- stderr ---")
print(err.getvalue())
PYEOF
}

test_shift_unchanged_skips_git() {
  local out
  out=$(shift_case unchanged) || fail "unchanged wiring raised"$'\n'"$out"
  assert_contains "$out" "EXIT=0" "unchanged feed should exit 0" "$out"
  assert_contains "$out" "atom:unchanged" \
    "unchanged report did not record the atom path" "$out"
  assert_contains "$out" '"shift": false' \
    "unchanged report is not quiet JSON" "$out"
}

test_shift_moved_falls_through() {
  local out
  out=$(shift_case moved) || fail "moved wiring raised"$'\n'"$out"
  assert_contains "$out" "EXIT=1" "moved feed should fire exit 1" "$out"
  assert_contains "$out" "Depended-on surfaces that moved" \
    "moved feed did not run the full PORT diff" "$out"
  assert_contains "$out" "fm-fleet-snapshot.sh" \
    "moved feed lost the PORT script" "$out"
}

test_shift_malformed_falls_through_loud() {
  local out
  out=$(shift_case malformed) || fail "malformed wiring raised"$'\n'"$out"
  assert_contains "$out" "EXIT=1" "malformed feed should fail open to fire" "$out"
  assert_contains "$out" "ATOM PARSE FAILURE" \
    "malformed feed did not warn LOUDLY on stderr" "$out"
  assert_contains "$out" "falling through to git" \
    "malformed feed did not announce the fallback" "$out"
}

test_shift_no_atom_skips_feed() {
  local out
  out=$(shift_case no-atom) || fail "no-atom wiring raised"$'\n'"$out"
  assert_contains "$out" "EXIT=1" "no-atom should run the full path" "$out"
  assert_contains "$out" "FETCH_CALLS=0" "--no-atom still touched the feed" "$out"
}

test_shift_no_fetch_implies_offline() {
  local out
  out=$(shift_case no-fetch) || fail "no-fetch wiring raised"$'\n'"$out"
  assert_contains "$out" "EXIT=1" "no-fetch should run the local path" "$out"
  assert_contains "$out" "FETCH_CALLS=0" "--no-fetch still touched the feed" "$out"
}

test_moved_sha_fires
test_unchanged_sha_silent
test_malformed_feed_warns_loudly
test_garbage_feed_warns_loudly
test_empty_feed_warns_loudly
test_cache_roundtrip
test_plain_sha_print
test_repo_normalization
test_shift_unchanged_skips_git
test_shift_moved_falls_through
test_shift_malformed_falls_through_loud
test_shift_no_atom_skips_feed
test_shift_no_fetch_implies_offline
pass "shift atom fast-path: moved fires, unchanged quiet, malformed warns loudly, git fallback intact"
