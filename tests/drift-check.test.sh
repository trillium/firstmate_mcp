#!/usr/bin/env bash
# Behavior tests for drift check: the firstmate drift-detection CLI.
# Exercises the public interface (drift/check.py comparing two snapshots)
# four ways: identical snapshots exit clean, an added surface exits drift,
# --format json stays machine-readable with the summary shape, and a missing
# file fails clearly. Self-contained: fixtures are built inline, no checkout.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK="$ROOT/drift/check.py"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/drift-check.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT INT TERM

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

fixture() {
  local file=$1 surfaces=$2
  python3 - "$file" "$surfaces" <<'PYEOF'
import json, sys
path, names = sys.argv[1], sys.argv[2].split() if sys.argv[2] else []
def surface(name):
    return {"name": name, "command": f"bin/{name}", "kind": "script",
            "flags": ["--json"], "help_exit": 0,
            "help_excerpt": f"usage: {name} --json", "help_hash": "aaa",
            "file_hash": "fff", "size": 100, "mtime": 1000,
            "schema_hint": "fm-snapshot.v1",
            "header_contract": "Output contract: --json prints one object"}
snap = {"version": 1, "generated": "2026-09-13T00:00:00+00:00",
        "firstmate_revision": "abc123",
        "surfaces": [surface(n) for n in names]}
json.dump(snap, open(path, "w", encoding="utf-8"), indent=2)
PYEOF
}

BASE="$TMP_ROOT/base.json"
SAME="$TMP_ROOT/same.json"
NEXT="$TMP_ROOT/next.json"
fixture "$BASE" "a.sh"
fixture "$SAME" "a.sh"
fixture "$NEXT" "a.sh b.sh"

test_clean_pair_exits_zero() {
  local out status
  out=$(python3 "$CHECK" "$BASE" "$SAME" 2>&1)
  status=$?
  expect_code 0 "$status" "identical snapshots should exit 0" "$out"
  assert_contains "$out" "clean: no drift" "clean pair did not say 'clean'"
}

test_added_surface_exits_drift() {
  local out status
  out=$(python3 "$CHECK" "$BASE" "$NEXT" 2>&1)
  status=$?
  expect_code 1 "$status" "an added surface should exit 1" "$out"
  assert_contains "$out" "added [feature]: b.sh" "drift output did not name the added surface"
}

test_json_format_is_machine_readable() {
  local out status
  out=$(python3 "$CHECK" "$BASE" "$NEXT" --format json 2>&1)
  status=$?
  expect_code 1 "$status" "json drift should still exit 1" "$out"
  assert_contains "$out" '"feature_drift"' "json output missed the summary shape"
  python3 -c "import json,sys; json.loads(sys.stdin.read())" <<<"$out" \
    || fail "json output did not parse"
}

test_missing_file_fails_clearly() {
  local out status
  out=$(python3 "$CHECK" "$BASE" "$TMP_ROOT/nope.json" 2>&1)
  status=$?
  expect_code 2 "$status" "a missing file should exit 2" "$out"
  assert_contains "$out" "cannot read" "missing-file failure did not say 'cannot read'"
}

test_clean_pair_exits_zero
test_added_surface_exits_drift
test_json_format_is_machine_readable
test_missing_file_fails_clearly
pass "drift check compares snapshots; drift, json shape, and errors behave"
