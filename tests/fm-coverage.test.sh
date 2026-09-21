#!/usr/bin/env bash
# Behavior tests for the support-coverage view (manifest/COVERAGE.md).
# Exercises the public interface (scripts/gen_coverage.py) four ways: the seed
# view is current, every manifest entry appears and every upstream top-level
# command is classified, an unclassified upstream command fails naming it, and
# a stale COVERAGE.md fails. Self-contained: fixtures are tmp dirs/files plus
# --upstream-root/--output overrides; the live tree is only read, never written.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GEN="$ROOT/scripts/gen_coverage.py"
COVERAGE="$ROOT/manifest/COVERAGE.md"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fm-coverage.XXXXXX")"
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

test_seed_current_and_classified() {
  local out status
  out=$(python3 "$GEN" --check 2>&1)
  status=$?
  expect_code 0 "$status" "seed coverage should validate" "$out"
  assert_contains "$out" "fully classified" "seed check did not prove full classification"
}

test_manifest_and_deny_appear() {
  local missing=0
  for id in fleet_snapshot backlog crew_state status_tail send_message fleet_poll \
    peek fleet_view review_diff bearings_snapshot wake_drain guard_check \
    remote_doctor remote_file remote_delta handoff_status \
    harness_detect project_mode lock_status lease_check bearings_board_path \
    inbox_status inbox_list home_summary home_summary_refresh contributions_snapshot contributions_pending \
    mail_status mail_read voice_status lint_versions tool_update_check vendor_auth_probe \
    startup_memory pr_state relay_poll \
    lifecycle_interrupt lifecycle_exit lifecycle_relaunch lifecycle_suspend lifecycle_resume \
    spawn_crew scaffold_brief decision_hold decision_resolve review_decision \
    secondmate_nudge secondmate_restart secondmate_report remote_control handoff_move \
    voice_queue mail_send \
    relay_reply relay_dismiss relay_followup; do
    case "$(cat "$COVERAGE")" in
      *"$id"*) : ;;
      *) printf 'coverage missing manifest entry: %s\n' "$id" >&2; missing=1 ;;
    esac
  done
  for name in promote_scout teardown_crew arm_pr_check merge_pr merge_local \
    daemon_start daemon_stop daemon_restart watch_start watch_stop \
    repo_edit repo_commit repo_push repo_merge; do
    case "$(cat "$COVERAGE")" in
      *"$name"*) : ;;
      *) printf 'coverage missing DENY_LIST name: %s\n' "$name" >&2; missing=1 ;;
    esac
  done
  [ "$missing" = 0 ] || fail "manifest/DENY appearance"
  pass "every manifest entry and DENY_LIST name appears in COVERAGE.md"
}

test_unclassified_command_fails() {
  local fixture="$TMP_ROOT/fakehome" out status
  mkdir -p "$fixture/bin/backends"
  : > "$fixture/bin/fm-zzz-new-command.sh"
  out=$(python3 "$GEN" --upstream-root "$fixture" --output "$TMP_ROOT/cov.md" 2>&1)
  status=$?
  expect_code 1 "$status" "unclassified command should fail" "$out"
  assert_contains "$out" "fm-zzz-new-command.sh" "failure did not name the unclassified command"
  pass "unclassified upstream command fails naming it"
}

test_stale_coverage_fails() {
  local stale="$TMP_ROOT/stale.md" out status
  cp "$COVERAGE" "$stale"
  printf '\n<!-- stale -->\n' >> "$stale"
  out=$(python3 "$GEN" --check --output "$stale" 2>&1)
  status=$?
  expect_code 1 "$status" "stale coverage should fail" "$out"
  assert_contains "$out" "stale" "failure did not say stale"
  pass "stale COVERAGE.md fails --check"
}

test_seed_current_and_classified
test_manifest_and_deny_appear
test_unclassified_command_fails
test_stale_coverage_fails
pass "support-coverage view validates; manifest, upstream, and staleness wiring behave"
