#!/usr/bin/env bash
# Behavior tests for schema/contracts.yaml: the MCP depended-on contract map.
# Exercises the public interface (schema/validate.py, a commodity JSON Schema
# draft 2020-12 validator plus pin freshness) three ways: the seed validates,
# a deliberately stale pin fails naming the contract and the current pin, and
# a tier outside the enum fails naming the offending location.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

VALIDATOR="$ROOT/schema/validate.py"
SEED="$ROOT/schema/contracts.yaml"
TMP_ROOT=$(fm_test_tmproot mcp-schema)

test_seed_validates() {
  local out status
  out=$(python3 "$VALIDATOR" "$SEED" 2>&1)
  status=$?
  expect_code 0 "$status" "seed contracts.yaml should validate"
  assert_contains "$out" "ok:" "validator did not confirm the seed"
}

test_stale_pin_fails_with_clear_message() {
  local stale="$TMP_ROOT/stale.yaml" out status
  python3 - "$SEED" "$stale" <<'PYEOF'
import sys
import yaml
src, dst = sys.argv[1], sys.argv[2]
data = yaml.safe_load(open(src, encoding="utf-8"))
for entry in data["contracts"]:
    if entry["name"] == "fleet_snapshot":
        entry["pinned"] = "fm-fleet-snapshot.v0"
open(dst, "w", encoding="utf-8").write(yaml.safe_dump(data))
PYEOF
  out=$(python3 "$VALIDATOR" "$stale" 2>&1)
  status=$?
  expect_code 3 "$status" "a stale pin should exit 3"
  assert_contains "$out" "stale" "stale failure did not say 'stale'"
  assert_contains "$out" "fleet_snapshot" "stale failure did not name the contract"
  assert_contains "$out" "fm-fleet-snapshot.v1" "stale failure did not name the current pin"
}

test_unknown_tier_fails_with_clear_message() {
  local bad="$TMP_ROOT/bad-tier.yaml" out status
  python3 - "$SEED" "$bad" <<'PYEOF'
import sys
import yaml
src, dst = sys.argv[1], sys.argv[2]
data = yaml.safe_load(open(src, encoding="utf-8"))
data["contracts"][0]["stability"] = "frozen"
open(dst, "w", encoding="utf-8").write(yaml.safe_dump(data))
PYEOF
  out=$(python3 "$VALIDATOR" "$bad" 2>&1)
  status=$?
  expect_code 2 "$status" "an unknown tier should exit 2"
  assert_contains "$out" "contract invalid" "tier failure did not say 'contract invalid'"
}

test_seed_validates
test_stale_pin_fails_with_clear_message
test_unknown_tier_fails_with_clear_message
pass "mcp-schema contract map validates; stale and invalid entries fail clearly"
