#!/usr/bin/env bash
# Behavior tests for manifest/FEATURES.yaml: the durable feature manifest.
# Exercises the public interface (manifest/validate.py plus the generator's
# --check-manifest wiring) seven ways: the seed validates, every schema
# contract has an entry, a divergence without a reason fails naming the
# entry, a status claiming a nonexistent implementation fails, the generated
# README lists agree with the manifest, a missing fork pin fails naming it,
# and a stale upstream gitlink fails naming the drift.
# Self-contained: fixtures are tmp copies of the seed, no checkout needed.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VALIDATOR="$ROOT/manifest/validate.py"
SEED="$ROOT/manifest/FEATURES.yaml"
GEN="$ROOT/scripts/gen_readme_lists.py"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fm-manifest.XXXXXX")"
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

test_seed_validates() {
  local out status
  out=$(python3 "$VALIDATOR" "$SEED" 2>&1)
  status=$?
  expect_code 0 "$status" "seed manifest should validate" "$out"
  assert_contains "$out" "manifest ok" "seed validation did not say 'manifest ok'"
  assert_contains "$out" "schema contracts covered" "seed validation did not prove contract coverage"
  assert_contains "$out" "evidence spot-checked" "seed validation did not prove honesty spot-checks"
}

test_divergence_without_reason_fails() {
  local bad="$TMP_ROOT/noreason.yaml" out status
  cp "$SEED" "$bad"
  python3 - "$bad" <<'PYEOF'
import sys
text = open(sys.argv[1]).read()
needle = "reason: >-\n        Per-call \"I authorize\" approval gate plus the closed interrupt verb;"
assert needle in text, "seed shape changed; update this fixture"
text = text.replace(
    "plus the closed interrupt verb;\n        upstream fm-control.sh knows no MCP approval string. Same owning\n        script, narrower surface.",
    "plus the closed interrupt verb;",
    1,
)
# blank the lifecycle_interrupt reason entirely
text = text.replace(
    "      reason: >-\n        Per-call \"I authorize\" approval gate plus the closed interrupt verb;",
    "      reason: \"\"",
    1,
)
open(sys.argv[1], "w").write(text)
PYEOF
  out=$(python3 "$VALIDATOR" "$bad" 2>&1)
  status=$?
  [ "$status" -ne 0 ] || fail "a divergence without a reason should fail"
  assert_contains "$out" "lifecycle_interrupt" "reason failure did not name the entry"
}

test_phantom_implementation_fails() {
  local bad="$TMP_ROOT/phantom.yaml" out status
  cp "$SEED" "$bad"
  python3 - "$bad" <<'PYEOF'
import sys
text = open(sys.argv[1]).read()
needle = "ts/src/tools.ts:fleet_snapshot"
assert needle in text, "seed shape changed; update this fixture"
open(sys.argv[1], "w").write(text.replace(needle, "ts/src/tools.ts:no_such_tool_xyz", 1))
PYEOF
  out=$(python3 "$VALIDATOR" "$bad" 2>&1)
  status=$?
  expect_code 3 "$status" "a status claiming a nonexistent implementation should exit 3" "$out"
  assert_contains "$out" "fleet_snapshot" "honesty failure did not name the entry"
}

test_missing_contract_entry_fails() {
  local bad="$TMP_ROOT/nocontract.yaml" out status
  cp "$SEED" "$bad"
  python3 - "$bad" <<'PYEOF'
import sys
text = open(sys.argv[1]).read()
needle = "contract: schema/contracts.yaml#backlog"
assert needle in text, "seed shape changed; update this fixture"
open(sys.argv[1], "w").write(
    text.replace(needle, "contract: adapter/dispatch.py#TOOLS[backlog]", 1)
)
PYEOF
  out=$(python3 "$VALIDATOR" "$bad" 2>&1)
  status=$?
  expect_code 3 "$status" "a schema contract without an entry should exit 3" "$out"
  assert_contains "$out" "backlog" "coverage failure did not name the contract"
}

test_missing_fork_pin_fails() {
  local bad="$TMP_ROOT/nofork.yaml" out status
  cp "$SEED" "$bad"
  python3 - "$bad" <<'PYEOF'
import sys
text = open(sys.argv[1]).read()
start = text.index("fork:")
end = text.index("features:")
open(sys.argv[1], "w").write(text[:start] + text[end:])
PYEOF
  out=$(python3 "$VALIDATOR" "$bad" 2>&1)
  status=$?
  expect_code 2 "$status" "a manifest missing the fork pin should exit 2" "$out"
  assert_contains "$out" "fork" "missing-pin failure did not name the fork pin"
}

test_stale_gitlink_fails() {
  local bad="$TMP_ROOT/stalelink.yaml" out status
  cp "$SEED" "$bad"
  python3 - "$bad" <<'PYEOF'
import sys
text = open(sys.argv[1]).read()
needle = "gitlink_at_seed: 1b1b6e051dafc9dcabe3ef0a7d4a64bd40a45567"
assert needle in text, "seed shape changed; update this fixture"
open(sys.argv[1], "w").write(
    text.replace(needle, "gitlink_at_seed: aaaaaaaaaabbbbbbbbbbccccccccccdddddddddd", 1)
)
PYEOF
  out=$(python3 "$VALIDATOR" "$bad" 2>&1)
  status=$?
  expect_code 3 "$status" "a stale upstream gitlink should exit 3" "$out"
  assert_contains "$out" "stale" "stale-pin failure did not say 'stale'"
}

test_fork_missing_rev_fails() {
  local bad="$TMP_ROOT/noforkrev.yaml" out status
  cp "$SEED" "$bad"
  python3 - "$bad" <<'PYEOF'
import sys
text = open(sys.argv[1]).read()
needle = "fork_rev: 86c035336bf9e136dd44d76e7d46e16d260fac8f"
assert needle in text, "seed shape changed; update this fixture"
# remove the first fork_rev line
open(sys.argv[1], "w").write(text.replace(needle, "", 1))
PYEOF
  out=$(python3 "$VALIDATOR" "$bad" 2>&1)
  status=$?
  expect_code 2 "$status" "a fork entry without fork_rev should exit 2" "$out"
  assert_contains "$out" "brief_herdr_lab_safety" "fork_rev failure did not name the entry"
}

test_fork_divergence_without_reason_fails() {
  local bad="$TMP_ROOT/noforkreason.yaml" out status
  cp "$SEED" "$bad"
  python3 - "$bad" <<'PYEOF'
import sys
text = open(sys.argv[1]).read()
target = (
    "      reason: >-\n"
    "        Trillium fork requires explicit --herdr-lab and strict lifecycle safety\n"
    "        gate injection for agent briefs; upstream brief generation has no\n"
    "        Herdr lab contract."
)
assert target in text, "seed shape changed; update this fixture"
text = text.replace(target, '      reason: ""', 1)
open(sys.argv[1], "w").write(text)
PYEOF
  out=$(python3 "$VALIDATOR" "$bad" 2>&1)
  status=$?
  expect_code 3 "$status" "a fork entry with empty divergence reason should exit 3" "$out"
  assert_contains "$out" "brief_herdr_lab_safety" "fork divergence failure did not name the entry"
}

test_generator_manifest_check() {
  local out status
  out=$(python3 "$GEN" --check-manifest 2>&1)
  status=$?
  expect_code 0 "$status" "generator --check-manifest should pass" "$out"
  out=$(python3 "$GEN" --check 2>&1)
  status=$?
  expect_code 0 "$status" "generator --check should pass (README embed current)" "$out"
}

test_seed_validates
test_divergence_without_reason_fails
test_phantom_implementation_fails
test_missing_contract_entry_fails
test_missing_fork_pin_fails
test_stale_gitlink_fails
test_fork_missing_rev_fails
test_fork_divergence_without_reason_fails
test_generator_manifest_check
pass "feature manifest validates; coverage, honesty, divergence, and generator wiring behave"
