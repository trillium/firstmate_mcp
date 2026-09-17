#!/usr/bin/env bash
# Upstream preservation gate: upstream tests unchanged against py + ts.
#
# - Builds ts/dist when missing (bun-primary, npm-fallback).
# - Runs the harness under the TS runtimes that are available, then writes
#   the seeded UPSTREAM-RESULTS.md on the primary pass.
# - Skips cleanly (exit 0) when no upstream checkout exists for the
#   upstream-reference column; py/ts projection columns still run.
# - Skips the TS column only when neither bun nor node can run the TS server.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

command -v python3 >/dev/null 2>&1 || fail "python3 unavailable for upstream harness"

if [ ! -f "$ROOT/ts/dist/server.js" ]; then
  echo "--- building ts/ (dist missing) ---"
  if command -v bun >/dev/null 2>&1; then
    (cd "$ROOT/ts" && bun install --no-progress && bun run build) || fail "ts build failed (bun)"
  elif command -v npm >/dev/null 2>&1; then
    (cd "$ROOT/ts" && npm install --no-audit --no-fund && npm run build) || fail "ts build failed (npm)"
  else
    echo "warn: no bun/npm; TS column will skip (dist missing)"
  fi
fi

echo "--- upstream preservation (primary pass) ---"
python3 "$ROOT/tests/upstream/run_upstream.py" --format text --write-results || fail "upstream harness failed"

if command -v bun >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
  echo "--- upstream preservation (node runtime cross-check) ---"
  python3 "$ROOT/tests/upstream/run_upstream.py" --format text --ts-runtime node || fail "upstream harness failed under node runtime"
fi

echo "all upstream preservation checks passed"
