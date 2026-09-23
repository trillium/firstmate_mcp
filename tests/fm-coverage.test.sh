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
    remote_doctor remote_file remote_delta extension_list extension_inspect handoff_status \
    harness_detect project_mode lock_status lease_check bearings_board_path \
    inbox_status inbox_list home_summary home_summary_refresh contributions_snapshot contributions_pending \
    mail_status mail_read mail_check voice_status lint_versions tool_update_check vendor_auth_probe \
    startup_memory pr_state pr_poll relay_poll public_followup_pending public_followup_collect \
    lifecycle_interrupt lifecycle_exit lifecycle_relaunch lifecycle_suspend lifecycle_resume \
    spawn_crew scaffold_brief decision_hold decision_resolve review_decision \
    secondmate_nudge secondmate_restart secondmate_report remote_control handoff_move \
    voice_queue mail_send \
    relay_reply relay_dismiss relay_followup \
    tasks_list tasks_show tasks_ready dispatch_resolve sessionstart_nudge \
    startup_network_report doc_audience_check home_seed_validate stow_cascade \
    test_isolation_list test_run_list pr_reviewers arm_policy_check cd_policy_check \
    subagent_policy_check supervision_instructions quota_choose; do
    case "$(cat "$COVERAGE")" in
      *"$id"*) : ;;
      *) printf 'coverage missing manifest entry: %s\n' "$id" >&2; missing=1 ;;
    esac
  done
  for name in promote_scout teardown_crew arm_pr_check merge_pr merge_local \
    daemon_start daemon_stop daemon_restart watch_start watch_stop \
    repo_edit repo_commit repo_push repo_merge public_followup_emit relay_link \
    fleet_sync inactive_reconcile backlog_receive session_start sessionstart_run sessionstart_cursor \
    herdr_lab herdr_ci_cleanup session_cleanup claude_trust agy_trust claude_stop_autoarm \
    herdr_eventwait herdr_workspace_move backend_select \
    on_execute config_push remote_entrypoint remote_herdr_guard remote_provision \
    remote_seed inherit_push remote_inherit reap_orphans remote_worker \
    bootstrap check_register check_unregister agents_md_ensure install_actionlint \
    install_herdr install_shellcheck install_treehouse update workflow_lint \
    afk_contract afk_launch afk_return afk_start branch_outcome branch_prompt \
    busy_event kimi_turnend_hook operational_input procevent_run procevent_lavish \
    procevent_quota procevent_remote_reply procevent_when turnend_guard \
    turnend_guard_cursor turnend_guard_grok wake_grant watch_checkpoint; do
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

test_fork_extension_renders() {
  local fixture="$TMP_ROOT/forkhome" spine="$TMP_ROOT/spine.json" out status
  mkdir -p "$fixture/bin/backends"
  # Fixture upstream ships every curated command EXCEPT fm-ledger.sh, which
  # is curated in COMMAND_AREAS but absent here; the fixture spine declares
  # it class A (fork-only).
  ( cd "$ROOT" && python3 -c "from scripts.gen_coverage import COMMAND_AREAS; print('\n'.join(COMMAND_AREAS))" ) | while IFS= read -r cmd; do
    case "$cmd" in fm-*.sh) [ "$cmd" = "fm-ledger.sh" ] || : > "$fixture/bin/$cmd" ;; esac
  done
  cat > "$spine" <<'EOF'
{"rows": [{"surface": "fm-ledger.sh", "class": "A", "fork_rev": "abc", "fork_hash": "def", "upstream_hash": null, "state": "not-porting"}]}
EOF
  out=$(python3 "$GEN" --upstream-root "$fixture" --spine "$spine" --output "$TMP_ROOT/fork.md" 2>&1)
  status=$?
  expect_code 0 "$status" "fork-classified render should succeed" "$out"
  assert_contains "$(cat "$TMP_ROOT/fork.md")" "fork extension" "fork row did not render as fork extension"
  case "$(grep 'fm-ledger.sh' "$TMP_ROOT/fork.md")" in
    *"(removed upstream)"*) fail "fork extension mislabelled as removed upstream" ;;
  esac
  pass "fork extension renders as fork extension, never as removed gap"
}

test_unclassified_fork_command_fails() {
  local fixture="$TMP_ROOT/barehome" spine="$TMP_ROOT/newfork-spine.json" out status
  mkdir -p "$fixture/bin/backends"
  # A fork extension the spine knows but COMMAND_AREAS never curated is
  # invisible everywhere: the gate must fail naming it until classified.
  cat > "$spine" <<'EOF'
{"rows": [{"surface": "fm-zzz-fork.sh", "class": "A", "fork_rev": "abc", "fork_hash": "def", "upstream_hash": null, "state": "not-porting"}]}
EOF
  out=$(python3 "$GEN" --upstream-root "$fixture" --spine "$spine" --output "$TMP_ROOT/bare.md" 2>&1)
  status=$?
  expect_code 1 "$status" "unclassified fork command should fail" "$out"
  assert_contains "$out" "fm-zzz-fork.sh" "failure did not name the unclassified fork command"
  pass "new fork-only .sh fails the gate until classified"
}

test_seed_current_and_classified
test_manifest_and_deny_appear
test_unclassified_command_fails
test_stale_coverage_fails
test_fork_extension_renders
test_unclassified_fork_command_fails
pass "support-coverage view validates; manifest, upstream, and staleness wiring behave"
