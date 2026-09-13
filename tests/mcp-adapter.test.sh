#!/usr/bin/env bash
# Behavior tests for adapter/ - the compatibility-adapter boundary.
#
# The adapter is the ONLY layer allowed to know First Mate internals: every
# MCP tool calls the adapter, the adapter shells to the owning bin/fm-*.sh
# script (never reimplements), validates ids/paths/text limits, and returns
# a typed result/error envelope. These cases pin that contract hermetically
# (a fake subprocess runner, a temp served home - no real script ever runs):
#   (a) validators accept and reject ids, projects, notes, approvals, and
#       steer text, and confine state paths to the served home
#   (b) the envelope carries exactly one shape for ok and err
#   (c) unknown tools and every DENY_LIST surface are refused with no side
#       effects, and dispatch never raises
#   (d) validation rejections fire before any process starts
#   (e) argv builders emit only the safe flag subset for spawn, brief,
#       lifecycle, decision resolve, and relay tools
#   (f) snapshot tools validate the schema id and derive backlog counts;
#       status_tail reads the confined log with a history-only warning
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v python3 >/dev/null 2>&1; then
  echo "skip: python3 unavailable for adapter tests"
  exit 0
fi

python3 "$ROOT/tests/mcp-adapter.test.py"
rc=$?
if [ "$rc" -ne 0 ]; then
  printf 'not ok - mcp-adapter python suite failed (exit %s)\n' "$rc" >&2
  exit "$rc"
fi
echo "all mcp-adapter tests passed"
