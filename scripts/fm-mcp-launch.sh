#!/usr/bin/env bash
# Cutover launcher: serve a live firstmate fleet through firstmate_mcp.
#
# Pins one home, stays local-only, then execs the TypeScript server with stdio
# as the only transport (newline-delimited JSON-RPC on stdin/stdout, logs
# on stderr). No TCP, no SSE, no multi-user wiring in this task.
#
# Usage:
#   scripts/fm-mcp-launch.sh --home /path/to/firstmate [--server ts]
#       [--runtime bun|node] [--audit-log PATH] [--actor NAME]
#
# Env equivalents: FM_HOME, FM_MCP_SERVER (ts), FM_MCP_RUNTIME,
# FM_AUDIT_LOG, FM_ACTOR. CLI flags win over env.
#
#   --home is required: FM_HOME is inherited from the server environment,
#     so the launcher pins it rather than passing it per call (AUTH.md).
#     Default audit log is $FM_HOME/state/mcp-audit.jsonl; every allow and
#     every refuse appends one JSON line (AUTH.md format).
#   --server ts (default) runs the TypeScript server.
#
# Approval flow: every authority-bearing or externally visible tool takes
# an explicit per-call `approval` string starting with `I authorize` and
# refuses without it (AUTH.md tiers). Relay sends additionally stay inert
# without relay consent (FMX_PAIRING_TOKEN) inside the owning scripts.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

HOME_ARG=""
SERVER="${FM_MCP_SERVER:-ts}"
RUNTIME="${FM_MCP_RUNTIME:-bun}"
AUDIT_LOG="${FM_AUDIT_LOG:-}"
ACTOR="${FM_ACTOR:-local}"

fail() {
  printf 'fm-mcp-launch: %s\n' "$1" >&2
  exit "${2:-2}"
}

usage() {
  sed -n '2,22p' "$0"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --home) HOME_ARG="${2:-}"; shift 2 ;;
    --home=*) HOME_ARG="${1#--home=}"; shift ;;
    --server) SERVER="${2:-}"; shift 2 ;;
    --server=*) SERVER="${1#--server=}"; shift ;;
    --runtime) RUNTIME="${2:-}"; shift 2 ;;
    --runtime=*) RUNTIME="${1#--runtime=}"; shift ;;
    --audit-log) AUDIT_LOG="${2:-}"; shift 2 ;;
    --audit-log=*) AUDIT_LOG="${1#--audit-log=}"; shift ;;
    --actor) ACTOR="${2:-}"; shift 2 ;;
    --actor=*) ACTOR="${1#--actor=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    --port*|--host*|--sse*|--http*|--network*|--listen*)
      fail "refused $1: local-only stdio transport, no network listeners in this task" 2 ;;
    --) shift; break ;;
    -*) fail "unknown flag: $1 (see --help)" 2 ;;
    *) fail "unexpected argument: $1 (see --help)" 2 ;;
  esac
done
[ $# -eq 0 ] || fail "unexpected argument: $1 (see --help)" 2

FM_HOME_PINNED="${HOME_ARG:-${FM_HOME:-}}"
[ -n "$FM_HOME_PINNED" ] || fail "FM_HOME is not pinned: pass --home or export FM_HOME" 2
case "$FM_HOME_PINNED" in
  /*) : ;;
  *) fail "FM_HOME must be absolute, got: $FM_HOME_PINNED" 2 ;;
esac
[ -d "$FM_HOME_PINNED" ] || fail "FM_HOME is not a directory: $FM_HOME_PINNED" 2
[ -d "$FM_HOME_PINNED/bin" ] || fail "FM_HOME has no bin/: $FM_HOME_PINNED/bin" 2
[ -x "$FM_HOME_PINNED/bin/fm-fleet-snapshot.sh" ] \
  || fail "FM_HOME/bin lacks fm-fleet-snapshot.sh: $FM_HOME_PINNED/bin" 2

case "$SERVER" in
  py) fail "Python server retired; firstmate_mcp uses TypeScript server (ts)" 2 ;;
  ts)
    [ -f "$ROOT/ts/dist/server.js" ] \
      || fail "ts/dist/server.js missing: run (cd ts && bun install && bun run build) first" 2
    case "$RUNTIME" in
      bun|node) : ;;
      *) fail "--runtime must be bun or node, got: $RUNTIME" 2 ;;
    esac
    command -v "$RUNTIME" >/dev/null 2>&1 \
      || fail "runtime unavailable: $RUNTIME" 2
    SERVER_CMD=("$RUNTIME" "$ROOT/ts/dist/server.js")
    ;;
  *) fail "--server must be ts, got: $SERVER" 2 ;;
esac

if [ -z "$AUDIT_LOG" ]; then
  AUDIT_LOG="$FM_HOME_PINNED/state/mcp-audit.jsonl"
fi
case "$AUDIT_LOG" in
  /*) : ;;
  *) fail "audit log path must be absolute, got: $AUDIT_LOG" 2 ;;
esac

export FM_HOME="$FM_HOME_PINNED"
export FM_AUDIT_LOG="$AUDIT_LOG"
export FM_ACTOR="$ACTOR"

printf 'fm-mcp-launch: home=%s server=%s audit=%s actor=%s transport=stdio-local-only\n' \
  "$FM_HOME" "$SERVER" "$FM_AUDIT_LOG" "$FM_ACTOR" >&2

exec "${SERVER_CMD[@]}"
