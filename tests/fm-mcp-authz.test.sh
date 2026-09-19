#!/usr/bin/env bash
# fm-mcp-authz covers the MCP authorization tiers: per-tier allow/refuse, approval-token mechanics, audit line shape, and timing.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT/ts" || exit 1

if command -v bun >/dev/null 2>&1; then
  bun run build && bun run build:tests && bun test --timeout 30000 testbuild/tests/auth.test.js
elif command -v node >/dev/null 2>&1; then
  npm run build && npm run build:tests && node --test testbuild/tests/auth.test.js
else
  printf 'not ok - neither bun nor node available\n' >&2
  exit 1
fi
echo "all authz tests passed"
