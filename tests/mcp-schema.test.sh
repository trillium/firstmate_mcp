#!/usr/bin/env bash
# Behavior tests for schema/contracts.yaml: the MCP depended-on contract map.
# Exercises the public interface (schema/validate.py, a commodity JSON Schema
# draft 2020-12 validator plus pin freshness) five ways: the seed validates,
# a deliberately stale pin fails naming the contract and the current pin,
# a tier outside the enum fails naming the offending location, a missing
# provenance block fails naming it, and a fork pin disagreeing with the
# manifest fails naming the pin.
#
# Self-contained: this repo ships the MCP layer only, so the suite builds a
# stub FM_HOME/bin carrying the pinned owning-script names (the same stub-home
# pattern test_client.py uses) instead of sourcing firstmate's tests/lib.sh.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VALIDATOR="$ROOT/schema/validate.py"
SEED="$ROOT/schema/contracts.yaml"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/mcp-schema.XXXXXX")"
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

stub_fm_home() {
  local home=$1
  mkdir -p "$home/bin"
  for script in fm-fleet-snapshot.sh fm-crew-state.sh fm-send.sh fm-spawn.sh fm-brief.sh fm-peek.sh fm-fleet-view.sh fm-review-diff.sh fm-bearings-snapshot.sh fm-wake-drain.sh fm-guard.sh fm-control.sh fm-decision-hold.sh fm-captain-hold.sh fm-review-decision.sh fm-x-reply.sh fm-x-dismiss.sh fm-x-followup.sh fm-remote-doctor.sh fm-remote-file.sh fm-remote-delta-read.sh fm-extension.sh fm-secondmate-reconcile.sh fm-secondmate-restart.sh fm-secondmate-report.sh fm-remote-secondmate-control.sh fm-backlog-handoff.sh fm-harness.sh fm-project-mode.sh fm-lock.sh fm-lease.sh fm-bearings-board.sh fm-inbox.sh fm-home-summary-refresh.sh fm-contributions.sh fm-mail.sh fm-mail-check.sh fm_voice_records.py fm-lint.sh fm-lint-workflows.sh fm-tool-update-check.sh fm-vendor-auth-probe.sh fm-startup-memory-budget.sh fm-pr-state.sh fm-pr-poll.sh fm-x-poll.sh fm-public-followup.sh fm-public-followup-collect.sh fm-fleet-sync.sh fm-inactive-reconcile.sh fm-tasks-axi.sh fm-backlog-receive.sh fm-dispatch-resolve.sh fm-sessionstart-nudge.sh fm-session-start.sh fm-sessionstart-run.sh fm-sessionstart-cursor.sh fm-herdr-lab.sh fm-herdr-ci-cleanup.sh fm-herdr-session-cleanup.sh fm-claude-trust.sh fm-agy-trust.sh fm-claude-stop-autoarm.sh; do
    printf '#!/usr/bin/env bash\nexit 0\n' > "$home/bin/$script"
    chmod +x "$home/bin/$script"
  done
}

export FM_HOME="$TMP_ROOT/stubhome"
stub_fm_home "$FM_HOME"

test_seed_validates() {
  local out status
  out=$(python3 "$VALIDATOR" "$SEED" 2>&1)
  status=$?
  expect_code 0 "$status" "seed contracts.yaml should validate" "$out"
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
  expect_code 3 "$status" "a stale pin should exit 3" "$out"
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
  expect_code 2 "$status" "an unknown tier should exit 2" "$out"
  assert_contains "$out" "contract invalid" "tier failure did not say 'contract invalid'"
}

test_missing_provenance_fails_with_clear_message() {
  local bad="$TMP_ROOT/no-prov.yaml" out status
  python3 - "$SEED" "$bad" <<'PYEOF'
import sys
import yaml
src, dst = sys.argv[1], sys.argv[2]
data = yaml.safe_load(open(src, encoding="utf-8"))
del data["provenance"]
open(dst, "w", encoding="utf-8").write(yaml.safe_dump(data))
PYEOF
  out=$(python3 "$VALIDATOR" "$bad" 2>&1)
  status=$?
  [ "$status" -ne 0 ] || fail "contracts without a provenance block should fail"
  assert_contains "$out" "provenance" "provenance failure did not say 'provenance'"
}

test_fork_pin_mismatch_fails_with_clear_message() {
  local bad="$TMP_ROOT/fork-mismatch.yaml" out status
  python3 - "$SEED" "$bad" <<'PYEOF'
import sys
import yaml
src, dst = sys.argv[1], sys.argv[2]
data = yaml.safe_load(open(src, encoding="utf-8"))
data["provenance"]["fork"]["proven_commit"] = "0" * 40
open(dst, "w", encoding="utf-8").write(yaml.safe_dump(data))
PYEOF
  out=$(python3 "$VALIDATOR" "$bad" 2>&1)
  status=$?
  expect_code 3 "$status" "a fork pin disagreeing with the manifest should exit 3" "$out"
  assert_contains "$out" "fork proven_commit" "mismatch failure did not name the fork pin"
}

test_seed_validates
test_stale_pin_fails_with_clear_message
test_unknown_tier_fails_with_clear_message
test_missing_provenance_fails_with_clear_message
test_fork_pin_mismatch_fails_with_clear_message
pass "mcp-schema contract map validates; stale and invalid entries fail clearly"
