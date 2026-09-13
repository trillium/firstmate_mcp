#!/bin/bash
# fm-mcp-authz covers the MCP authorization tiers: per-tier allow/refuse, approval-token mechanics, and audit line shape.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT" || exit 1
python3 auth/test_authz.py -v
