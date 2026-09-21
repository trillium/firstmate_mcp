#!/usr/bin/env bash
# Behavior tests for launchd plist template rendering and deployment tooling.
#
# Verifies:
#   1. Plist template renders valid XML plist with default parameters.
#   2. Custom parameters (home, runtime, logs, tokens, grants) are interpolated cleanly.
#   3. Missing required parameters fail closed with exit code 2.
#   4. Rendered output passes plutil linting (if plutil is present).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
RENDERER="$ROOT/scripts/fm-mcp-render-plist.sh"
TEMPLATE="$ROOT/deploy/com.firstmate.mcp.plist.template"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fm-deploy-test.XXXXXX")"
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

test_template_exists() {
  [ -f "$TEMPLATE" ] || fail "deploy/com.firstmate.mcp.plist.template is missing"
  pass "launchd plist template exists"
}

test_missing_home_fails() {
  local out status
  set +e
  out=$(FM_HOME="" "$RENDERER" 2>&1)
  status=$?
  set -e
  expect_code 2 "$status" "missing --home should fail closed with exit 2" "$out"
  assert_contains "$out" "missing required --home" "error message should specify missing home"
  pass "missing home fails closed with exit 2"
}

test_render_default() {
  local fake_home="$TMP_DIR/fakehome"
  mkdir -p "$fake_home"
  local output_plist="$TMP_DIR/output.plist"

  "$RENDERER" --home "$fake_home" --output "$output_plist"
  [ -f "$output_plist" ] || fail "output plist was not written"

  local content
  content=$(cat "$output_plist")
  assert_contains "$content" "<string>com.firstmate.mcp</string>" "default label present"
  assert_contains "$content" "<string>$fake_home</string>" "FM_HOME interpolated"
  assert_contains "$content" "<string>ts</string>" "server ts present"
  assert_contains "$content" "<string>$fake_home/state/mcp-audit.jsonl</string>" "default audit log present"
  assert_contains "$content" "<string>$fake_home/logs/mcp-stderr.log</string>" "default stderr log present"

  if command -v plutil >/dev/null 2>&1; then
    plutil -lint "$output_plist" >/dev/null 2>&1 || fail "rendered plist failed plutil lint"
  fi
  pass "default plist rendering is valid and parameterizes all defaults"
}

test_render_custom_parameters() {
  local fake_home="$TMP_DIR/customhome"
  mkdir -p "$fake_home"
  local output_plist="$TMP_DIR/custom.plist"

  "$RENDERER" \
    --home "$fake_home" \
    --label "org.custom.mcp" \
    --runtime "node" \
    --audit-log "$fake_home/audit/custom.jsonl" \
    --actor "custom-actor" \
    --stderr "$fake_home/logs/custom-err.log" \
    --pairing-token "secret-relay-token" \
    --release-grant "1" \
    --output "$output_plist"

  local content
  content=$(cat "$output_plist")
  assert_contains "$content" "<string>org.custom.mcp</string>" "custom label present"
  assert_contains "$content" "<string>node</string>" "custom runtime present"
  assert_contains "$content" "<string>$fake_home/audit/custom.jsonl</string>" "custom audit log present"
  assert_contains "$content" "<string>custom-actor</string>" "custom actor present"
  assert_contains "$content" "<string>$fake_home/logs/custom-err.log</string>" "custom stderr log present"
  assert_contains "$content" "<key>FMX_PAIRING_TOKEN</key>" "pairing token key present"
  assert_contains "$content" "<string>secret-relay-token</string>" "pairing token value present"
  assert_contains "$content" "<key>FM_RELEASE_GRANT</key>" "release grant key present"

  if command -v plutil >/dev/null 2>&1; then
    plutil -lint "$output_plist" >/dev/null 2>&1 || fail "custom plist failed plutil lint"
  fi
  pass "custom parameter rendering succeeds with token and grant keys"
}

test_template_exists
test_missing_home_fails
test_render_default
test_render_custom_parameters
pass "all deployment plist render tests passed"
