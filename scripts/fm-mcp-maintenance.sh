#!/usr/bin/env bash
# Daily maintenance for a supervised firstmate_mcp deployment: prove the server
# still speaks the protocol, then rotate its logs.
#
# Fail-closed and BOUNDED by design:
#   - every stage runs under a hard watchdog, so a hung smoke gate becomes a
#     reported failure instead of a stuck launchd job (observed 2026-09-22: the
#     gate hung >75s under launchd while passing in a shell, and the job sat in
#     "running" with no way to notice)
#   - stage output goes to temp FILES, never command substitution: a `$( )`
#     capture also waits for EOF on the pipe, which any surviving grandchild
#     (the smoke gate spawns a server) can hold open forever
#   - a failed smoke gate exits non-zero and SKIPS rotation, so a broken dist
#     surfaces loudly instead of quietly accumulating logs
#
# Usage:
#   scripts/fm-mcp-maintenance.sh --home /path/to/firstmate [--runtime bun|node]
#       [--max-size-mb 50] [--retention-days 14] [--smoke-budget 25]
#       [--rotate-budget 120] [--dry-run] [--json]
#
# Exit: 0 healthy (smoke passed, rotation ran), 1 a stage failed or timed out,
# 2 configuration or environment error.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

HOME_ARG=""
RUNTIME="${FM_MCP_RUNTIME:-bun}"
MAX_SIZE_MB="${MAX_SIZE_MB:-50}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
SMOKE_BUDGET="${SMOKE_BUDGET_S:-25}"
ROTATE_BUDGET="${ROTATE_BUDGET_S:-120}"
DRY_RUN=0
JSON=0

fail() {
  printf 'fm-mcp-maintenance: %s\n' "$1" >&2
  exit "${2:-2}"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --home) HOME_ARG="${2:-}"; shift 2 ;;
    --home=*) HOME_ARG="${1#--home=}"; shift ;;
    --runtime) RUNTIME="${2:-}"; shift 2 ;;
    --runtime=*) RUNTIME="${1#--runtime=}"; shift ;;
    --max-size-mb) MAX_SIZE_MB="${2:-}"; shift 2 ;;
    --max-size-mb=*) MAX_SIZE_MB="${1#--max-size-mb=}"; shift ;;
    --retention-days) RETENTION_DAYS="${2:-}"; shift 2 ;;
    --retention-days=*) RETENTION_DAYS="${1#--retention-days=}"; shift ;;
    --smoke-budget) SMOKE_BUDGET="${2:-}"; shift 2 ;;
    --smoke-budget=*) SMOKE_BUDGET="${1#--smoke-budget=}"; shift ;;
    --rotate-budget) ROTATE_BUDGET="${2:-}"; shift 2 ;;
    --rotate-budget=*) ROTATE_BUDGET="${1#--rotate-budget=}"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --json) JSON=1; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) fail "unknown argument: $1 (see --help)" 2 ;;
  esac
done

FM_HOME_PINNED="${HOME_ARG:-${FM_HOME:-}}"
[ -n "$FM_HOME_PINNED" ] || fail "FM_HOME is not pinned: pass --home or export FM_HOME" 2
case "$FM_HOME_PINNED" in
  /*) : ;;
  *) fail "FM_HOME must be absolute, got: $FM_HOME_PINNED" 2 ;;
esac
[ -d "$FM_HOME_PINNED" ] || fail "FM_HOME is not a directory: $FM_HOME_PINNED" 2

SMOKE="${FM_MCP_SMOKE_SH:-$ROOT/scripts/fm-mcp-smoke.sh}"
ROTATE="${FM_MCP_LOGROTATE_SH:-$ROOT/scripts/fm-mcp-logrotate.sh}"
[ -x "$SMOKE" ] || fail "smoke gate missing or not executable: $SMOKE" 2
[ -x "$ROTATE" ] || fail "logrotate missing or not executable: $ROTATE" 2

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fm-mcp-maintenance.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM

# Milliseconds since the epoch, bash-native on purpose: a launchd job must not
# depend on the pyenv shim. Measured 2026-09-22: `pyenv-exec python3` hung
# indefinitely under launchd while working in a shell, which parked this job in
# "running" with an empty log and no way to notice.
now_ms() {
  if [ -n "${EPOCHREALTIME:-}" ]; then
    local secs="${EPOCHREALTIME%%.*}" frac="${EPOCHREALTIME#*.}"
    frac="${frac}000"
    printf '%s' "$((secs * 1000 + 10#${frac:0:3}))"
  else
    printf '%s' "$(( $(date +%s) * 1000 ))"
  fi
}

# Kill a process and every descendant (the smoke gate spawns a server that can
# outlive it). Recursive pgrep rather than process-group signals: job control
# (`set -m`) behaves differently for a launchd job with no controlling terminal.
kill_tree() {
  local parent="$1" child
  for child in $(pgrep -P "$parent" 2>/dev/null); do
    kill_tree "$child"
  done
  kill -TERM "$parent" 2>/dev/null
  sleep 1
  kill -KILL "$parent" 2>/dev/null
}

# Run one stage under a hard watchdog. Output goes to $3; the return value is the
# stage's exit code (124 when the watchdog fired).
run_stage() {
  local label="$1" budget="$2" outfile="$3"
  shift 3
  local pid waited=0 rc=0
  "$@" >"$outfile" 2>&1 &
  pid=$!
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt "$budget" ]; do
    sleep 1
    waited=$((waited + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    printf 'fm-mcp-maintenance: %s exceeded its %ss budget; terminating it\n' "$label" "$budget" >&2
    kill_tree "$pid"
    wait "$pid" 2>/dev/null
    return 124
  fi
  wait "$pid"
  rc=$?
  return "$rc"
}

started_ms=$(now_ms)

# 1. Health: the server must still speak the protocol against this home.
smoke_tmp="$TMP_DIR/smoke.out"
run_stage smoke "$SMOKE_BUDGET" "$smoke_tmp" \
  "$SMOKE" --home "$FM_HOME_PINNED" --runtime "$RUNTIME"
smoke_code=$?
smoke_out="$(cat "$smoke_tmp" 2>/dev/null || true)"
if [ "$smoke_code" -ne 0 ]; then
  printf 'fm-mcp-maintenance: smoke gate FAILED (exit %s); rotation skipped\n%s\n' \
    "$smoke_code" "$smoke_out" >&2
  [ "$JSON" -eq 1 ] && printf '{"status":"fail","stage":"smoke","exit":%s}\n' "$smoke_code"
  exit 1
fi
tools_count=$(printf '%s' "$smoke_out" | sed -n 's/.*tools\/list OK (\([0-9]*\) tools.*/\1/p' | head -1)

# 2. Rotation: copytruncate, bounded size, bounded retention.
rotate_args=(--home "$FM_HOME_PINNED" --max-size-mb "$MAX_SIZE_MB" --retention-days "$RETENTION_DAYS")
[ "$DRY_RUN" -eq 1 ] && rotate_args+=(--dry-run)
rotate_tmp="$TMP_DIR/rotate.out"
run_stage rotate "$ROTATE_BUDGET" "$rotate_tmp" "$ROTATE" "${rotate_args[@]}"
rotate_code=$?
rotate_out="$(cat "$rotate_tmp" 2>/dev/null || true)"
if [ "$rotate_code" -ne 0 ]; then
  printf 'fm-mcp-maintenance: rotation FAILED (exit %s)\n%s\n' "$rotate_code" "$rotate_out" >&2
  [ "$JSON" -eq 1 ] && printf '{"status":"fail","stage":"rotate","exit":%s}\n' "$rotate_code"
  exit 1
fi

finished_ms=$(now_ms)
duration_ms=$((finished_ms - started_ms))

if [ "$JSON" -eq 1 ]; then
  printf '{"status":"pass","home":"%s","runtime":"%s","tools_count":%s,"max_size_mb":%s,"retention_days":%s,"dry_run":%s,"duration_ms":%s}\n' \
    "$FM_HOME_PINNED" "$RUNTIME" "${tools_count:-null}" "$MAX_SIZE_MB" "$RETENTION_DAYS" \
    "$([ "$DRY_RUN" -eq 1 ] && echo true || echo false)" "$duration_ms"
else
  printf 'fm-mcp-maintenance: healthy (%s tools) and rotated (max %sMB, %s days) in %sms\n' \
    "${tools_count:-?}" "$MAX_SIZE_MB" "$RETENTION_DAYS" "$duration_ms"
fi
exit 0
