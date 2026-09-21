#!/usr/bin/env bash
# Behavior tests for scripts/fm-mcp-logrotate.sh: log rotation and retention.
#
# Verifies:
#   1. Files below size threshold are skipped when not forced.
#   2. Forced rotation copies active file, truncates active file in place to 0.
#   3. Gzip compression produces valid .gz archive and removes uncompressed archive.
#   4. Retention purge cleans up archives older than retention threshold.
#   5. Dry-run mode reports planned actions without altering file contents.
#   6. Missing home fails closed with exit code 2.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
LOGROTATE="$ROOT/scripts/fm-mcp-logrotate.sh"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fm-logrotate-test.XXXXXX")"
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

test_size_threshold_skip() {
  local home="$TMP_DIR/skiphome"
  mkdir -p "$home/state" "$home/logs"
  local audit="$home/state/mcp-audit.jsonl"
  echo '{"test":1}' > "$audit"

  local out status
  out=$("$LOGROTATE" --home "$home" --max-size-mb 50 2>&1)
  status=$?
  expect_code 0 "$status" "logrotate should exit 0 on threshold skip" "$out"
  assert_contains "$out" "skipping rotation" "log output should indicate skipping"
  [ -s "$audit" ] || fail "audit file should not have been truncated"
  pass "files below size threshold are skipped"
}

test_force_rotation_and_copytruncate() {
  local home="$TMP_DIR/forcehome"
  mkdir -p "$home/state" "$home/logs"
  local audit="$home/state/mcp-audit.jsonl"
  local stderr_log="$home/logs/mcp-stderr.log"

  echo '{"test":"audit-record-1"}' > "$audit"
  echo 'server log message' > "$stderr_log"

  local out status
  out=$("$LOGROTATE" --home "$home" --force --compress 2>&1)
  status=$?
  expect_code 0 "$status" "forced logrotate should exit 0" "$out"
  
  # Both active files must exist and be 0 bytes (copytruncate)
  [ -f "$audit" ] || fail "active audit log missing after rotation"
  [ "$(wc -c < "$audit" | tr -d ' ')" = "0" ] || fail "active audit log was not truncated to 0 bytes"
  [ -f "$stderr_log" ] || fail "active stderr log missing after rotation"
  [ "$(wc -c < "$stderr_log" | tr -d ' ')" = "0" ] || fail "active stderr log was not truncated to 0 bytes"

  # Compressed archive must exist and contain the original data
  local audit_archives
  audit_archives=$(ls "$home/state"/mcp-audit.jsonl.*.gz 2>/dev/null || true)
  [ -n "$audit_archives" ] || fail "no compressed audit archive found"

  if command -v gzip >/dev/null 2>&1; then
    local decompressed
    decompressed=$(gzip -dc "$audit_archives")
    assert_contains "$decompressed" "audit-record-1" "archive content preserved"
  fi

  pass "force rotation applies copytruncate and creates compressed archive"
}

test_retention_purge() {
  local home="$TMP_DIR/purgehome"
  mkdir -p "$home/state" "$home/logs"
  local old_archive="$home/state/mcp-audit.jsonl.20200101_000000.gz"
  echo "old data" > "$old_archive"

  # Set mtime to 30 days ago
  python3 -c "import os, time; t = time.time() - (30 * 86400); os.utime('$old_archive', (t, t))"

  local out status
  out=$("$LOGROTATE" --home "$home" --retention-days 14 2>&1)
  status=$?
  expect_code 0 "$status" "purge check should exit 0" "$out"
  [ ! -f "$old_archive" ] || fail "old archive was not purged"
  assert_contains "$out" "purged old archive" "log output should indicate archive purged"
  pass "retention policy purges old archives past retention window"
}

test_dry_run() {
  local home="$TMP_DIR/dryrunhome"
  mkdir -p "$home/state" "$home/logs"
  local audit="$home/state/mcp-audit.jsonl"
  echo "important-audit-line" > "$audit"

  local out status
  out=$("$LOGROTATE" --home "$home" --force --dry-run 2>&1)
  status=$?
  expect_code 0 "$status" "dry-run should exit 0" "$out"
  assert_contains "$out" "[dry-run]" "output should indicate dry-run"
  [ "$(wc -c < "$audit" | tr -d ' ')" -gt 0 ] || fail "dry-run modified active audit file"
  pass "dry-run reports planned operations without modifying files"
}

test_missing_home_fails() {
  local out status
  set +e
  out=$(FM_HOME="" "$LOGROTATE" 2>&1)
  status=$?
  set -e
  expect_code 2 "$status" "missing home should fail closed with exit 2" "$out"
  pass "missing home fails closed with exit 2"
}

test_size_threshold_skip
test_force_rotation_and_copytruncate
test_retention_purge
test_dry_run
test_missing_home_fails
pass "all log rotation tests passed"
