#!/usr/bin/env bash
# Behavior tests for the contract flag-surface gate (project-2od.14).
# The gate compares depended-on --flags declared in schema/contracts.yaml
# against the literal bytes of the owning scripts: pure function of bytes,
# never --help execution (banned measurable: live pids, timeouts).
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK="$ROOT/scripts/check_flag_surfaces.py"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fm-flags.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT INT TERM

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'ok - %s\n' "$1"
}

test_seed_passes() {
  local out status
  out=$(python3 "$CHECK" --check 2>&1)
  status=$?
  [ "$status" = 0 ] || fail "seed flag surfaces should validate: $out"
  case "$out" in
    *"7 known fork-shape divergences"*) : ;;
    *) fail "divergence count changed; update fixture or record the new shape: $out" ;;
  esac
  pass "seed flag surfaces validate with declared divergences"
}

test_drifted_flag_fails_naming_it() {
  local bad="$TMP_ROOT/drifted.yaml" out status
  cp "$ROOT/schema/contracts.yaml" "$bad"
  python3 - "$bad" <<'PYEOF'
import sys
text = open(sys.argv[1]).read()
needle = 'flags: ["--json"]'
assert needle in text, "seed shape changed; update this fixture"
open(sys.argv[1], "w").write(text.replace(needle, 'flags: ["--json", "--zzz-drifted"]', 1))
PYEOF
  out=$(python3 "$CHECK" --contracts "$bad" --check 2>&1)
  status=$?
  [ "$status" -ne 0 ] || fail "drifted flag should fail"
  case "$out" in
    *"--zzz-drifted"*) : ;;
    *) fail "failure did not name the drifted flag: $out" ;;
  esac
  pass "drifted declaration fails naming the flag"
}

test_seed_passes
test_drifted_flag_fails_naming_it
pass "flag surfaces gate proves declarations match script bytes"
