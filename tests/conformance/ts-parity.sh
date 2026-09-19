#!/usr/bin/env bash
# TypeScript server multi-runtime conformance gate (Bun primary + Node compat).
#
# Proves the TS implementation in ts/ behaves like firstmate:
#   (a) TS proof suites under bun (primary runtime);
#   (b) TS proof suites under node (fallback compat);
#   (c) TS conformance fixtures (conformance / conformance:bun in ts/)
#       prove the TS read tools equal the owning scripts' output hermetically.
#
# Bun is the primary runtime: the bun proof runs first and bun must be
# installed. Node stays as fallback compat and must stay green.
#
# Usage: bash tests/conformance/ts-parity.sh
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "node unavailable for TS parity (fallback compat)"
command -v bun >/dev/null 2>&1 || fail "bun unavailable for TS parity (primary runtime)"
[ -d "$ROOT/ts" ] || fail "ts/ sibling missing"

if [ ! -f "$ROOT/ts/dist/server.js" ]; then
  echo "--- building ts/ (dist missing) ---"
  if command -v pnpm >/dev/null 2>&1; then
    (cd "$ROOT/ts" && pnpm install && pnpm run build) || fail "ts build failed (pnpm)"
  elif command -v bun >/dev/null 2>&1; then
    (cd "$ROOT/ts" && bun install --no-progress && bun run build) || fail "ts build failed (bun)"
  elif command -v npm >/dev/null 2>&1; then
    (cd "$ROOT/ts" && npm install --no-audit --no-fund && npm run build) || fail "ts build failed (npm)"
  fi
fi

echo "--- ts proof under bun (primary) ---"
(cd "$ROOT/ts" && bun run test:bun) || fail "ts proof under bun failed"

echo "--- ts proof under node (fallback compat) ---"
(cd "$ROOT/ts" && (command -v pnpm >/dev/null 2>&1 && pnpm test || npm test)) || fail "ts proof under node failed"

echo "--- ts conformance fixtures (bun) ---"
(cd "$ROOT/ts" && bun run conformance:bun) || fail "ts conformance fixtures (bun) failed"

echo "--- ts conformance fixtures (node) ---"
(cd "$ROOT/ts" && (command -v pnpm >/dev/null 2>&1 && pnpm run conformance || npm run conformance)) || fail "ts conformance fixtures (node) failed"

echo "all ts-parity checks passed"
