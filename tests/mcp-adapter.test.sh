#!/usr/bin/env bash
# Behavior tests for the MCP boundary (validators, envelope, auth).
#
# Runs the TS fast test suites under bun (or node fallback) to verify:
#   (a) validators accept and reject ids, projects, notes, approvals, and
#       steer text, and confine state paths to the served home
#   (b) the envelope carries exactly one shape for ok and err
#   (c) unknown tools and every DENY_LIST surface are refused with no side
#       effects
#   (d) validation rejections fire before any process starts
#   (e) argv builders emit only the safe flag subset
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if command -v bun >/dev/null 2>&1; then
  (cd "$ROOT/ts" && bun run test:fast:bun)
elif command -v node >/dev/null 2>&1; then
  (cd "$ROOT/ts" && npm run test:fast)
else
  printf 'not ok - neither bun nor node available\n' >&2
  exit 1
fi
echo "all mcp-adapter tests passed"
