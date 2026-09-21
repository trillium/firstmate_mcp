#!/usr/bin/env bash
# fm-mcp-loop.test.sh: prove the autonomous MCP loop runner against a dedicated scratch home.
# Exercises:
# 1. Scoped standing grant authentication and verification
# 2. Handshake and 87-tool discovery
# 3. Scout read chain (fleet_snapshot, backlog, crew_state, status_tail, bearings_snapshot, guard_check)
# 4. Tier 2 plain text steer (send_message)
# 5. Tier 3 authority writes (scaffold_brief, secondmate_report) on standing grant without human strings
# 6. Async long-running work via detached receipt_submit and receipt_status polling
# 7. Attestation read (decision_verify) and durable outcome record bead write
# 8. Kill-switch proof: mid-run grant revocation fails closed immediately on next authority call
# 9. Audit trail verification: 100% schema match, grant_ref logging, zero human string leaks
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/fm-mcp-loop-test.XXXXXX")"
REPORT="$SCRATCH/LOOP-TEST-REPORT.md"
trap 'rm -rf "$SCRATCH"' EXIT INT TERM

# Ensure TS server is built
(cd "$ROOT/ts" && pnpm run build) >/dev/null

echo "--- Running autonomous MCP loop proof ---"
python3 "$ROOT/scripts/fm-mcp-loop.py" --home "$SCRATCH/home" --report "$REPORT" --prove

[ -f "$REPORT" ] || {
  echo "FAIL: report was not generated" >&2
  exit 1
}

[ -f "$SCRATCH/home/state/mcp-loop-outcome.json" ] || {
  echo "FAIL: outcome record bead missing" >&2
  exit 1
}

echo "all mcp-loop tests passed"
