#!/usr/bin/env bash
# Behavior tests for scripts/fm-mcp-smoke.sh: the MCP fail-closed smoke gate.
#
# Verifies:
#   1. Smoke gate passes against a stub fleet home across runtime engines (bun + node).
#   2. Verifies 4-stage sequence: initialize -> ping -> tools/list -> Tier-1 read.
#   3. Verifies stdout-pristine guarantee (empty stdout unless --json).
#   4. Verifies JSON output structure when --json is requested.
#   5. Verifies fail-closed exit 1 on version assertion failure.
#   6. Verifies fail-closed exit 2 on configuration error (missing home).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SMOKE="$ROOT/scripts/fm-mcp-smoke.sh"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fm-smoke-test.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM

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

make_stub_home() {
  local target="$1"
  mkdir -p "$target/bin" "$target/state" "$target/logs"
  cat > "$target/bin/fm-fleet-snapshot.sh" <<'SH'
#!/bin/sh
echo '{"schema":"fm-fleet-snapshot.v1","backlog":{},"tasks":[]}'
SH
  chmod +x "$target/bin/fm-fleet-snapshot.sh"
}

test_smoke_bun() {
  if ! command -v bun >/dev/null 2>&1; then
    pass "skipping bun smoke test (bun not installed)"
    return 0
  fi
  local home="$TMP_DIR/bunhome"
  make_stub_home "$home"

  local out status
  out=$("$SMOKE" --home "$home" --runtime bun 2>&1)
  status=$?
  expect_code 0 "$status" "smoke gate under bun should exit 0" "$out"
  assert_contains "$out" "initialize OK" "initialize stage ran"
  assert_contains "$out" "ping OK" "ping stage ran"
  assert_contains "$out" "tools/list OK" "tools/list stage ran"
  assert_contains "$out" "Tier-1 read OK" "tier-1 read stage ran"
  pass "smoke gate passes under bun with full 4-stage sequence"
}

test_smoke_node() {
  if ! command -v node >/dev/null 2>&1; then
    pass "skipping node smoke test (node not installed)"
    return 0
  fi
  local home="$TMP_DIR/nodehome"
  make_stub_home "$home"

  local out status
  out=$("$SMOKE" --home "$home" --runtime node 2>&1)
  status=$?
  expect_code 0 "$status" "smoke gate under node should exit 0" "$out"
  assert_contains "$out" "initialize OK" "initialize stage ran"
  assert_contains "$out" "ping OK" "ping stage ran"
  assert_contains "$out" "tools/list OK" "tools/list stage ran"
  assert_contains "$out" "Tier-1 read OK" "tier-1 read stage ran"
  pass "smoke gate passes under node with full 4-stage sequence"
}

test_stdout_pristine() {
  local home="$TMP_DIR/pristinehome"
  make_stub_home "$home"

  local stdout_capture status
  stdout_capture=$("$SMOKE" --home "$home" 2>/dev/null)
  status=$?
  expect_code 0 "$status" "smoke gate should exit 0"
  [ -z "$stdout_capture" ] || fail "stdout must be completely pristine (got: '$stdout_capture')"
  pass "smoke gate preserves pristine stdout"
}

test_json_summary_output() {
  local home="$TMP_DIR/jsonhome"
  make_stub_home "$home"

  local stdout_capture status
  stdout_capture=$("$SMOKE" --home "$home" --json 2>/dev/null)
  status=$?
  expect_code 0 "$status" "smoke gate --json should exit 0"
  
  python3 -c "
import json, sys
data = json.loads('''$stdout_capture''')
assert data.get('status') == 'pass', f'bad status: {data}'
assert data.get('tools_count', 0) >= 50, f'tools_count < 50: {data}'
assert 'server_version' in data, f'missing server_version: {data}'
assert 'duration_ms' in data, f'missing duration_ms: {data}'
" || fail "JSON summary output structure invalid"

  pass "smoke gate --json emits valid structured summary on stdout"
}

test_version_mismatch_fails() {
  local home="$TMP_DIR/verhome"
  make_stub_home "$home"

  local out status
  set +e
  out=$("$SMOKE" --home "$home" --version "99.99.99" 2>&1)
  status=$?
  set -e
  expect_code 1 "$status" "version mismatch should fail with exit 1" "$out"
  assert_contains "$out" "version mismatch" "error message should report version mismatch"
  pass "version mismatch fails closed with exit 1"
}

test_missing_home_fails() {
  local out status
  set +e
  out=$(FM_HOME="" "$SMOKE" 2>&1)
  status=$?
  set -e
  expect_code 2 "$status" "missing home should fail with exit 2" "$out"
  assert_contains "$out" "CONFIG ERROR" "error message should report config error"
  pass "missing home fails closed with exit 2"
}

test_smoke_bun
test_smoke_node
test_stdout_pristine
test_json_summary_output
test_version_mismatch_fails
test_missing_home_fails
pass "all smoke gate tests passed"
