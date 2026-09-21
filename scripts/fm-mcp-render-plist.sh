#!/usr/bin/env bash
# Render a launchd user agent plist from deploy/com.firstmate.mcp.plist.template.
#
# Parameterizes all paths, runtime binaries, audit destinations, and environment
# variables with safe documented defaults — never hardcoding local machine values.
#
# Usage:
#   scripts/fm-mcp-render-plist.sh --home /path/to/firstmate [OPTIONS]
#
# Options:
#   --home PATH             Firstmate home directory (required or via FM_HOME)
#   --mcp-dir PATH          firstmate_mcp repo directory (default: repo root)
#   --label NAME            launchd service label (default: com.firstmate.mcp)
#   --runtime bun|node      Runtime binary name (default: bun, fallback: node)
#   --audit-log PATH        Audit JSONL path (default: $FM_HOME/state/mcp-audit.jsonl)
#   --actor NAME            Calling actor name (default: mcp-agent)
#   --log-dir PATH          Directory for logs (default: $FM_HOME/logs)
#   --stderr PATH           Standard error log path (default: $LOG_DIR/mcp-stderr.log)
#   --stdout PATH           Standard out log path (default: /dev/null)
#   --path STR              PATH environment variable for launchd unit
#   --pairing-token TOKEN   Optional FMX_PAIRING_TOKEN for relay operations
#   --release-grant 0|1     Optional FM_RELEASE_GRANT (default: 0)
#   --output PATH           Output file path (default: stdout)
#   --template PATH         Template file path (default: deploy/com.firstmate.mcp.plist.template)
#   -h, --help              Show this help message
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

HOME_ARG="${FM_HOME:-}"
MCP_DIR_ARG="${FIRSTMATE_MCP_DIR:-$ROOT}"
LABEL_ARG="com.firstmate.mcp"
RUNTIME_ARG="${FM_MCP_RUNTIME:-}"
AUDIT_LOG_ARG="${FM_AUDIT_LOG:-}"
ACTOR_ARG="${FM_ACTOR:-mcp-agent}"
LOG_DIR_ARG=""
STDERR_ARG=""
STDOUT_ARG=""
PATH_ARG="${PATH:-/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin}"
PAIRING_TOKEN_ARG="${FMX_PAIRING_TOKEN:-}"
RELEASE_GRANT_ARG="${FM_RELEASE_GRANT:-0}"
OUTPUT_ARG=""
TEMPLATE_ARG="$ROOT/deploy/com.firstmate.mcp.plist.template"

fail() {
  printf 'fm-mcp-render-plist: %s\n' "$1" >&2
  exit "${2:-2}"
}

usage() {
  sed -n '2,24p' "$0"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --home) HOME_ARG="${2:-}"; shift 2 ;;
    --home=*) HOME_ARG="${1#--home=}"; shift ;;
    --mcp-dir) MCP_DIR_ARG="${2:-}"; shift 2 ;;
    --mcp-dir=*) MCP_DIR_ARG="${1#--mcp-dir=}"; shift ;;
    --label) LABEL_ARG="${2:-}"; shift 2 ;;
    --label=*) LABEL_ARG="${1#--label=}"; shift ;;
    --runtime) RUNTIME_ARG="${2:-}"; shift 2 ;;
    --runtime=*) RUNTIME_ARG="${1#--runtime=}"; shift ;;
    --audit-log) AUDIT_LOG_ARG="${2:-}"; shift 2 ;;
    --audit-log=*) AUDIT_LOG_ARG="${1#--audit-log=}"; shift ;;
    --actor) ACTOR_ARG="${2:-}"; shift 2 ;;
    --actor=*) ACTOR_ARG="${1#--actor=}"; shift ;;
    --log-dir) LOG_DIR_ARG="${2:-}"; shift 2 ;;
    --log-dir=*) LOG_DIR_ARG="${1#--log-dir=}"; shift ;;
    --stderr) STDERR_ARG="${2:-}"; shift 2 ;;
    --stderr=*) STDERR_ARG="${1#--stderr=}"; shift ;;
    --stdout) STDOUT_ARG="${2:-}"; shift 2 ;;
    --stdout=*) STDOUT_ARG="${1#--stdout=}"; shift ;;
    --path) PATH_ARG="${2:-}"; shift 2 ;;
    --path=*) PATH_ARG="${1#--path=}"; shift ;;
    --pairing-token) PAIRING_TOKEN_ARG="${2:-}"; shift 2 ;;
    --pairing-token=*) PAIRING_TOKEN_ARG="${1#--pairing-token=}"; shift ;;
    --release-grant) RELEASE_GRANT_ARG="${2:-}"; shift 2 ;;
    --release-grant=*) RELEASE_GRANT_ARG="${1#--release-grant=}"; shift ;;
    --output) OUTPUT_ARG="${2:-}"; shift 2 ;;
    --output=*) OUTPUT_ARG="${1#--output=}"; shift ;;
    --template) TEMPLATE_ARG="${2:-}"; shift 2 ;;
    --template=*) TEMPLATE_ARG="${1#--template=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; break ;;
    -*) fail "unknown flag: $1 (see --help)" 2 ;;
    *) fail "unexpected argument: $1 (see --help)" 2 ;;
  esac
done

[ -n "$HOME_ARG" ] || fail "missing required --home (or FM_HOME env var)" 2
case "$HOME_ARG" in
  /*) : ;;
  *) fail "--home must be an absolute path, got: $HOME_ARG" 2 ;;
esac

case "$MCP_DIR_ARG" in
  /*) : ;;
  *) fail "--mcp-dir must be an absolute path, got: $MCP_DIR_ARG" 2 ;;
esac

[ -f "$TEMPLATE_ARG" ] || fail "template file not found: $TEMPLATE_ARG" 2

# Runtime resolution: default bun, fallback node
if [ -z "$RUNTIME_ARG" ]; then
  if command -v bun >/dev/null 2>&1; then
    RUNTIME_ARG="bun"
  elif command -v node >/dev/null 2>&1; then
    RUNTIME_ARG="node"
  else
    RUNTIME_ARG="bun"
  fi
fi

case "$RUNTIME_ARG" in
  bun|node) : ;;
  *) fail "--runtime must be 'bun' or 'node', got: $RUNTIME_ARG" 2 ;;
esac

# Default audit log
if [ -z "$AUDIT_LOG_ARG" ]; then
  AUDIT_LOG_ARG="$HOME_ARG/state/mcp-audit.jsonl"
fi

# Default log dir & stderr/stdout
if [ -z "$LOG_DIR_ARG" ]; then
  LOG_DIR_ARG="$HOME_ARG/logs"
fi
if [ -z "$STDERR_ARG" ]; then
  STDERR_ARG="$LOG_DIR_ARG/mcp-stderr.log"
fi
if [ -z "$STDOUT_ARG" ]; then
  STDOUT_ARG="/dev/null"
fi

LAUNCH_SCRIPT="$MCP_DIR_ARG/scripts/fm-mcp-launch.sh"

# Build extra XML env vars if requested
EXTRA_ENV=""
if [ -n "$PAIRING_TOKEN_ARG" ]; then
  EXTRA_ENV="${EXTRA_ENV}
        <key>FMX_PAIRING_TOKEN</key>
        <string>${PAIRING_TOKEN_ARG}</string>"
fi
if [ "$RELEASE_GRANT_ARG" = "1" ]; then
  EXTRA_ENV="${EXTRA_ENV}
        <key>FM_RELEASE_GRANT</key>
        <string>1</string>"
fi

# Template substitution helper
render() {
  python3 - <<PYEOF
import sys

template = open("$TEMPLATE_ARG", "r", encoding="utf-8").read()
replacements = {
    "{{LABEL}}": "$LABEL_ARG",
    "{{FM_HOME}}": "$HOME_ARG",
    "{{FIRSTMATE_MCP_DIR}}": "$MCP_DIR_ARG",
    "{{FM_MCP_LAUNCH_SCRIPT}}": "$LAUNCH_SCRIPT",
    "{{FM_MCP_RUNTIME}}": "$RUNTIME_ARG",
    "{{FM_AUDIT_LOG}}": "$AUDIT_LOG_ARG",
    "{{FM_ACTOR}}": "$ACTOR_ARG",
    "{{PATH}}": "$PATH_ARG",
    "{{STDERR_LOG}}": "$STDERR_ARG",
    "{{STDOUT_LOG}}": "$STDOUT_ARG",
    "{{EXTRA_ENV_VARS}}": """$EXTRA_ENV""".strip(),
}

rendered = template
for k, v in replacements.items():
    rendered = rendered.replace(k, v)

# Clean up empty lines from extra env replacements if any
rendered = "\n".join([line for line in rendered.splitlines() if line.strip() != ""])

if "$OUTPUT_ARG":
    with open("$OUTPUT_ARG", "w", encoding="utf-8") as f:
        f.write(rendered + "\n")
    print(f"fm-mcp-render-plist: wrote {sys.argv[0] if False else '$OUTPUT_ARG'}", file=sys.stderr)
else:
    print(rendered)
PYEOF
}

render

# If output was written and plutil is available, lint it
if [ -n "$OUTPUT_ARG" ] && command -v plutil >/dev/null 2>&1; then
  plutil -lint "$OUTPUT_ARG" >/dev/null 2>&1 || fail "rendered plist failed plutil validation: $OUTPUT_ARG" 1
fi
