#!/usr/bin/env bash
# Smoke gate for firstmate_mcp: verify server protocol health over stdio.
#
# Sequence:
#   1. initialize                -> negotiate protocol & verify serverInfo
#   2. notifications/initialized -> acknowledge protocol initialization
#   3. ping                      -> verify unauthenticated health probe
#   4. tools/list                -> verify tool registry >= 50 tools & version assertion
#   5. Tier-1 read (tools/call)  -> verify open read tool execution & envelope
#
# Exit codes (fail-closed):
#   0 - Smoke gate passed (all assertions verified)
#   1 - Protocol / assertion / schema failure
#   2 - Configuration / environment error (missing FM_HOME, missing runtime, bad flag)
#   3 - Timeout / process hang / unexpected exit
#
# Stdout-pristine:
#   All diagnostic logs, stage markers, timings, and error traces are written
#   exclusively to stderr. Stdout is kept completely pristine (or outputs a
#   single structured JSON summary when --json is explicitly requested).
#
# Usage:
#   scripts/fm-mcp-smoke.sh --home /path/to/firstmate [OPTIONS]
#
# Options:
#   --home PATH             Firstmate home directory (required or via FM_HOME)
#   --mcp-dir PATH          firstmate_mcp root directory (default: repo root)
#   --launcher PATH         Launcher script path (default: scripts/fm-mcp-launch.sh)
#   --runtime bun|node      Runtime binary (default: bun, fallback: node)
#   --server ts             Server implementation (default: ts)
#   --audit-log PATH        Audit log path (default: $FM_HOME/state/mcp-audit.jsonl)
#   --actor NAME            Actor name for audit records (default: smoke-gate)
#   --tool NAME             Tier-1 tool to execute (default: status_tail)
#   --version VER           Assert server version equals this (default: from ts/package.json)
#   --timeout SECONDS       Timeout for whole smoke gate in seconds (default: 15)
#   --json                  Emit JSON summary on stdout upon pass
#   --quiet                 Suppress non-error progress output on stderr
#   -h, --help              Show this help message
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

HOME_ARG="${FM_HOME:-}"
MCP_DIR_ARG="${FIRSTMATE_MCP_DIR:-$ROOT}"
LAUNCHER_ARG=""
RUNTIME_ARG="${FM_MCP_RUNTIME:-}"
SERVER_ARG="${FM_MCP_SERVER:-ts}"
AUDIT_LOG_ARG="${FM_AUDIT_LOG:-}"
ACTOR_ARG="${FM_ACTOR:-smoke-gate}"
TOOL_ARG="status_tail"
VERSION_ARG=""
TIMEOUT_ARG="${SMOKE_TIMEOUT_S:-15}"
JSON_OUTPUT=0
QUIET_OUTPUT=0

fail_env() {
  printf 'fm-mcp-smoke [CONFIG ERROR]: %s\n' "$1" >&2
  exit 2
}

usage() {
  sed -n '2,32p' "$0"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --home) HOME_ARG="${2:-}"; shift 2 ;;
    --home=*) HOME_ARG="${1#--home=}"; shift ;;
    --mcp-dir) MCP_DIR_ARG="${2:-}"; shift 2 ;;
    --mcp-dir=*) MCP_DIR_ARG="${1#--mcp-dir=}"; shift ;;
    --launcher) LAUNCHER_ARG="${2:-}"; shift 2 ;;
    --launcher=*) LAUNCHER_ARG="${1#--launcher=}"; shift ;;
    --runtime) RUNTIME_ARG="${2:-}"; shift 2 ;;
    --runtime=*) RUNTIME_ARG="${1#--runtime=}"; shift ;;
    --server) SERVER_ARG="${2:-}"; shift 2 ;;
    --server=*) SERVER_ARG="${1#--server=}"; shift ;;
    --audit-log) AUDIT_LOG_ARG="${2:-}"; shift 2 ;;
    --audit-log=*) AUDIT_LOG_ARG="${1#--audit-log=}"; shift ;;
    --actor) ACTOR_ARG="${2:-}"; shift 2 ;;
    --actor=*) ACTOR_ARG="${1#--actor=}"; shift ;;
    --tool) TOOL_ARG="${2:-}"; shift 2 ;;
    --tool=*) TOOL_ARG="${1#--tool=}"; shift ;;
    --version) VERSION_ARG="${2:-}"; shift 2 ;;
    --version=*) VERSION_ARG="${1#--version=}"; shift ;;
    --timeout) TIMEOUT_ARG="${2:-}"; shift 2 ;;
    --timeout=*) TIMEOUT_ARG="${1#--timeout=}"; shift ;;
    --json) JSON_OUTPUT=1; shift ;;
    --quiet) QUIET_OUTPUT=1; shift ;;
    -h|--help) usage; exit 0 ;;
    --) shift; break ;;
    -*) fail_env "unknown flag: $1 (see --help)" ;;
    *) fail_env "unexpected argument: $1 (see --help)" ;;
  esac
done

[ -n "$HOME_ARG" ] || fail_env "missing required --home (or FM_HOME env var)"
case "$HOME_ARG" in
  /*) : ;;
  *) fail_env "--home must be an absolute path, got: $HOME_ARG" ;;
esac
[ -d "$HOME_ARG" ] || fail_env "--home directory does not exist: $HOME_ARG"

case "$MCP_DIR_ARG" in
  /*) : ;;
  *) fail_env "--mcp-dir must be an absolute path, got: $MCP_DIR_ARG" ;;
esac
[ -d "$MCP_DIR_ARG" ] || fail_env "--mcp-dir directory does not exist: $MCP_DIR_ARG"

if [ -z "$LAUNCHER_ARG" ]; then
  LAUNCHER_ARG="$MCP_DIR_ARG/scripts/fm-mcp-launch.sh"
fi
[ -f "$LAUNCHER_ARG" ] || fail_env "launcher script not found: $LAUNCHER_ARG"
[ -x "$LAUNCHER_ARG" ] || fail_env "launcher script is not executable: $LAUNCHER_ARG"

if [ -z "$RUNTIME_ARG" ]; then
  if command -v bun >/dev/null 2>&1; then
    RUNTIME_ARG="bun"
  elif command -v node >/dev/null 2>&1; then
    RUNTIME_ARG="node"
  else
    fail_env "neither bun nor node found in PATH"
  fi
fi
case "$RUNTIME_ARG" in
  bun|node) : ;;
  *) fail_env "--runtime must be 'bun' or 'node', got: $RUNTIME_ARG" ;;
esac

# Auto-detect expected version from ts/package.json if not specified
if [ -z "$VERSION_ARG" ]; then
  PKG_JSON="$MCP_DIR_ARG/ts/package.json"
  if [ -f "$PKG_JSON" ]; then
    VERSION_ARG=$(python3 -c "import json; print(json.load(open('$PKG_JSON'))['version'])" 2>/dev/null || echo "0.3.0")
  else
    VERSION_ARG="0.3.0"
  fi
fi

if [ -z "$AUDIT_LOG_ARG" ]; then
  AUDIT_LOG_ARG="$HOME_ARG/state/mcp-audit.jsonl"
fi

export FM_HOME="$HOME_ARG"
export FIRSTMATE_MCP_DIR="$MCP_DIR_ARG"
export FM_MCP_RUNTIME="$RUNTIME_ARG"
export FM_MCP_SERVER="$SERVER_ARG"
export FM_AUDIT_LOG="$AUDIT_LOG_ARG"
export FM_ACTOR="$ACTOR_ARG"

# Execute smoke gate harness in Python (fail-closed, strict JSON-RPC stream framing)
exec python3 - <<PYEOF
import json
import os
import subprocess
import sys
import time

home = "$HOME_ARG"
launcher = "$LAUNCHER_ARG"
runtime = "$RUNTIME_ARG"
server = "$SERVER_ARG"
audit_log = "$AUDIT_LOG_ARG"
actor = "$ACTOR_ARG"
tier1_tool = "$TOOL_ARG"
expected_version = "$VERSION_ARG"
timeout_s = float("$TIMEOUT_ARG")
emit_json = bool(int("$JSON_OUTPUT"))
quiet = bool(int("$QUIET_OUTPUT"))

def log_stderr(msg: str):
    if not quiet:
        print(f"fm-mcp-smoke: {msg}", file=sys.stderr, flush=True)

def fail_assertion(msg: str, code: int = 1):
    print(f"fm-mcp-smoke [ASSERTION FAILED]: {msg}", file=sys.stderr, flush=True)
    sys.exit(code)

def fail_timeout(msg: str):
    print(f"fm-mcp-smoke [TIMEOUT]: {msg}", file=sys.stderr, flush=True)
    sys.exit(3)

cmd = [
    launcher,
    "--home", home,
    "--server", server,
    "--runtime", runtime,
    "--audit-log", audit_log,
    "--actor", actor,
]

log_stderr(f"Starting server process: {' '.join(cmd)}")
start_time = time.monotonic()

try:
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
except Exception as e:
    fail_assertion(f"failed to spawn server process: {e}", code=2)

def read_line_with_timeout(timeout_secs: float) -> str:
    import select
    deadline = time.monotonic() + timeout_secs
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            stderr_out = proc.stderr.read() if proc.stderr else ""
            fail_assertion(f"server process exited prematurely with code {proc.returncode}. Stderr:\n{stderr_out}", code=3)
        r, _, _ = select.select([proc.stdout], [], [], min(0.2, max(0.01, deadline - time.monotonic())))
        if r:
            line = proc.stdout.readline()
            if line:
                return line.strip()
            else:
                stderr_out = proc.stderr.read() if proc.stderr else ""
                fail_assertion(f"server stdout closed unexpectedly. Stderr:\n{stderr_out}", code=3)
    fail_timeout(f"deadline exceeded ({timeout_secs:.1f}s) waiting for server response")

def send_msg(msg_obj: dict):
    line = json.dumps(msg_obj) + "\n"
    proc.stdin.write(line)
    proc.stdin.flush()

try:
    # -------------------------------------------------------------
    # Step 1: initialize
    # -------------------------------------------------------------
    log_stderr("Step 1/4: sending initialize request...")
    init_req = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "smoke-gate", "version": "1.0.0"}
        }
    }
    send_msg(init_req)
    init_resp_line = read_line_with_timeout(timeout_s)
    try:
        init_resp = json.loads(init_resp_line)
    except Exception as e:
        fail_assertion(f"initialize response is not valid JSON: {init_resp_line!r} ({e})")
    
    if init_resp.get("jsonrpc") != "2.0":
        fail_assertion(f"initialize response jsonrpc != '2.0': {init_resp}")
    if init_resp.get("id") != 1:
        fail_assertion(f"initialize response id != 1: {init_resp}")
    if "error" in init_resp:
        fail_assertion(f"initialize returned error: {init_resp['error']}")
    
    result = init_resp.get("result", {})
    server_info = result.get("serverInfo", {})
    server_name = server_info.get("name")
    server_version = server_info.get("version")
    
    if not server_name:
        fail_assertion(f"initialize serverInfo missing name: {init_resp}")
    if expected_version and server_version != expected_version:
        fail_assertion(f"serverInfo version mismatch: expected '{expected_version}', got '{server_version}'")
    
    log_stderr(f"✓ initialize OK (server={server_name} v{server_version}, proto={result.get('protocolVersion')})")

    # Send notifications/initialized
    send_msg({"jsonrpc": "2.0", "method": "notifications/initialized"})

    # -------------------------------------------------------------
    # Step 2: ping
    # -------------------------------------------------------------
    log_stderr("Step 2/4: sending ping request...")
    send_msg({"jsonrpc": "2.0", "id": 2, "method": "ping"})
    ping_resp_line = read_line_with_timeout(timeout_s)
    try:
        ping_resp = json.loads(ping_resp_line)
    except Exception as e:
        fail_assertion(f"ping response is not valid JSON: {ping_resp_line!r} ({e})")
    
    if ping_resp.get("id") != 2:
        fail_assertion(f"ping response id != 2: {ping_resp}")
    if "error" in ping_resp:
        fail_assertion(f"ping returned error: {ping_resp['error']}")
    if ping_resp.get("result") != {}:
        fail_assertion(f"ping result != {{}}: {ping_resp}")
    
    log_stderr("✓ ping OK (unauthenticated health probe verified)")

    # -------------------------------------------------------------
    # Step 3: tools/list + version assertion
    # -------------------------------------------------------------
    log_stderr("Step 3/4: sending tools/list request...")
    send_msg({"jsonrpc": "2.0", "id": 3, "method": "tools/list"})
    tools_resp_line = read_line_with_timeout(timeout_s)
    try:
        tools_resp = json.loads(tools_resp_line)
    except Exception as e:
        fail_assertion(f"tools/list response is not valid JSON: {tools_resp_line!r} ({e})")
    
    if tools_resp.get("id") != 3:
        fail_assertion(f"tools/list response id != 3: {tools_resp}")
    if "error" in tools_resp:
        fail_assertion(f"tools/list returned error: {tools_resp['error']}")
    
    tools_list = tools_resp.get("result", {}).get("tools", [])
    if not isinstance(tools_list, list) or len(tools_list) < 50:
        fail_assertion(f"tools/list returned insufficient tools ({len(tools_list)} < 50): {tools_resp}")
    
    tool_names = {t.get("name") for t in tools_list if isinstance(t, dict)}
    required_core_tools = {"fleet_snapshot", "backlog", "status_tail", "guard_check", "receipt_submit", "receipt_status"}
    missing_core = required_core_tools - tool_names
    if missing_core:
        fail_assertion(f"tools/list missing core tools: {sorted(missing_core)}")
    
    log_stderr(f"✓ tools/list OK ({len(tools_list)} tools registered, all core tools verified)")

    # -------------------------------------------------------------
    # Step 4: Tier-1 read (tools/call)
    # -------------------------------------------------------------
    log_stderr(f"Step 4/4: executing Tier-1 read tool '{tier1_tool}'...")
    if tier1_tool == "status_tail":
        call_args = {"id": "smoke-probe-crew", "lines": 1}
    elif tier1_tool == "lint_versions":
        call_args = {}
    elif tier1_tool == "bearings_board_path":
        call_args = {}
    elif tier1_tool == "home_summary":
        call_args = {}
    else:
        call_args = {}
    
    call_req = {
        "jsonrpc": "2.0",
        "id": 4,
        "method": "tools/call",
        "params": {
            "name": tier1_tool,
            "arguments": call_args
        }
    }
    send_msg(call_req)
    call_resp_line = read_line_with_timeout(timeout_s)
    try:
        call_resp = json.loads(call_resp_line)
    except Exception as e:
        fail_assertion(f"tools/call response is not valid JSON: {call_resp_line!r} ({e})")
    
    if call_resp.get("id") != 4:
        fail_assertion(f"tools/call response id != 4: {call_resp}")
    if "error" in call_resp:
        fail_assertion(f"tools/call JSON-RPC error: {call_resp['error']}")
    
    content = call_resp.get("result", {}).get("content", [])
    if not isinstance(content, list) or len(content) == 0:
        fail_assertion(f"tools/call result.content is empty: {call_resp}")
    
    raw_payload_text = content[0].get("text", "")
    try:
        payload_obj = json.loads(raw_payload_text)
    except Exception as e:
        fail_assertion(f"tools/call content text is not JSON envelope: {raw_payload_text!r} ({e})")
    
    log_stderr(f"✓ Tier-1 read OK (tool='{tier1_tool}', envelope={payload_obj.get('ok') or False})")

    elapsed_ms = round((time.monotonic() - start_time) * 1000, 2)
    log_stderr(f"=== Smoke Gate PASSED in {elapsed_ms}ms ===")

    if emit_json:
        summary = {
            "status": "pass",
            "server_name": server_name,
            "server_version": server_version,
            "tools_count": len(tools_list),
            "tier1_tool": tier1_tool,
            "duration_ms": elapsed_ms,
        }
        print(json.dumps(summary))

    sys.exit(0)

finally:
    # Graceful shutdown
    try:
        if proc.poll() is None:
            proc.stdin.close()
            proc.terminate()
            proc.wait(timeout=2)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass
PYEOF
