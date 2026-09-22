#!/usr/bin/env bash
# Hermetic proof for the daily maintenance stage: no network, no launchd, no
# live home. Stubs the smoke gate and the rotator through the documented
# FM_MCP_SMOKE_SH / FM_MCP_LOGROTATE_SH overrides, so the script's own logic is
# what runs.
#
# What this pins, in the order the failures actually happened while deploying:
#   - a passing gate rotates and reports a JSON line with the tool count
#   - a failing gate exits 1, names the stage, and SKIPS rotation
#   - a hung stage is terminated by the watchdog instead of parking forever
#     (observed live: a launchd job sat in "running" with an empty log)
#   - a bad home is a configuration error (exit 2), not a hang
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAINT="$ROOT/scripts/fm-mcp-maintenance.sh"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fm-mcp-maintenance-test.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT INT TERM

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'ok - %s\n' "$1"
}

# A home that passes the script's own guards.
HOME_DIR="$TMP_ROOT/home"
mkdir -p "$HOME_DIR/state"

stub_smoke_ok() {
  cat >"$TMP_ROOT/smoke-ok.sh" <<'EOF'
#!/usr/bin/env bash
echo "fm-mcp-smoke: ✓ tools/list OK (7 tools registered, all core tools verified)" >&2
exit 0
EOF
  chmod +x "$TMP_ROOT/smoke-ok.sh"
}

stub_smoke_fail() {
  cat >"$TMP_ROOT/smoke-fail.sh" <<'EOF'
#!/usr/bin/env bash
echo "fm-mcp-smoke [TIMEOUT]: deadline exceeded (15.0s) waiting for server response" >&2
exit 3
EOF
  chmod +x "$TMP_ROOT/smoke-fail.sh"
}

stub_smoke_hang() {
  cat >"$TMP_ROOT/smoke-hang.sh" <<'EOF'
#!/usr/bin/env bash
sleep 30
echo "should never get here"
EOF
  chmod +x "$TMP_ROOT/smoke-hang.sh"
}

stub_rotate() {
  cat >"$TMP_ROOT/rotate.sh" <<EOF
#!/usr/bin/env bash
echo "rotate ran" >>"$TMP_ROOT/rotate-called"
exit \${ROTATE_EXIT:-0}
EOF
  chmod +x "$TMP_ROOT/rotate.sh"
}

test_pass_path_rotates_and_reports() {
  local out status
  rm -f "$TMP_ROOT/rotate-called"
  out=$(FM_MCP_SMOKE_SH="$TMP_ROOT/smoke-ok.sh" FM_MCP_LOGROTATE_SH="$TMP_ROOT/rotate.sh" \
    bash "$MAINT" --home "$HOME_DIR" --json 2>&1)
  status=$?
  [ "$status" -eq 0 ] || fail "pass path exited $status, want 0"$'\n'"$out"
  case "$out" in *'"status":"pass"'*) : ;; *) fail "pass path did not report pass: $out" ;; esac
  case "$out" in *'"tools_count":7'*) : ;; *) fail "pass path did not carry the tool count: $out" ;; esac
  [ -f "$TMP_ROOT/rotate-called" ] || fail "pass path did not rotate"
}

test_failing_gate_skips_rotation() {
  local out status
  rm -f "$TMP_ROOT/rotate-called"
  out=$(FM_MCP_SMOKE_SH="$TMP_ROOT/smoke-fail.sh" FM_MCP_LOGROTATE_SH="$TMP_ROOT/rotate.sh" \
    bash "$MAINT" --home "$HOME_DIR" --json 2>&1)
  status=$?
  [ "$status" -eq 1 ] || fail "failing gate exited $status, want 1"$'\n'"$out"
  case "$out" in *'"stage":"smoke"'*) : ;; *) fail "failure did not name the smoke stage: $out" ;; esac
  case "$out" in *"rotation skipped"*) : ;; *) fail "failure did not say rotation was skipped: $out" ;; esac
  [ -f "$TMP_ROOT/rotate-called" ] && fail "a failed gate must not rotate"
}

test_watchdog_terminates_a_hung_stage() {
  local out status started elapsed
  rm -f "$TMP_ROOT/rotate-called"
  started=$(date +%s)
  out=$(FM_MCP_SMOKE_SH="$TMP_ROOT/smoke-hang.sh" FM_MCP_LOGROTATE_SH="$TMP_ROOT/rotate.sh" \
    bash "$MAINT" --home "$HOME_DIR" --smoke-budget 2 --json 2>&1)
  status=$?
  elapsed=$(( $(date +%s) - started ))
  [ "$status" -eq 1 ] || fail "hung stage exited $status, want 1"$'\n'"$out"
  case "$out" in *"exceeded its 2s budget"*) : ;; *) fail "watchdog did not report the budget overrun: $out" ;; esac
  [ "$elapsed" -lt 15 ] || fail "watchdog took ${elapsed}s; it must bound the stage"
  [ -f "$TMP_ROOT/rotate-called" ] && fail "a timed-out gate must not rotate"
  sleep 1
  pgrep -f "smoke-hang.sh" >/dev/null 2>&1 && fail "watchdog left the hung stage running"
}

test_bad_home_is_a_config_error() {
  local out status
  out=$(bash "$MAINT" --home "$TMP_ROOT/does-not-exist" 2>&1)
  status=$?
  [ "$status" -eq 2 ] || fail "bad home exited $status, want 2"$'\n'"$out"
  case "$out" in *"not a directory"*) : ;; *) fail "bad home did not name the reason: $out" ;; esac
}

stub_smoke_ok
stub_smoke_fail
stub_smoke_hang
stub_rotate

test_pass_path_rotates_and_reports
test_failing_gate_skips_rotation
test_watchdog_terminates_a_hung_stage
test_bad_home_is_a_config_error

pass "maintenance stage: pass rotates and reports, failure skips rotation, the watchdog bounds a hung gate, bad home is exit 2"
