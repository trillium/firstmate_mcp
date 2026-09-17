#!/usr/bin/env bash
# TypeScript-sibling parity gate: the shared conformance referee for both paths.
#
# Proves the TS implementation in ts/ behaves like firstmate two ways:
#   (a) parity-py-ts.mjs replays the same stub-home call sequence against
#       `python3 fm_mcp_server.py` and the TS server and diffs every payload
#       field-for-field — once with the server under node, once under bun
#       (the harness spawns the TS server via process.execPath, so the
#       runner running the script selects the server runtime);
#   (b) the TS conformance fixtures (conformance / conformance:bun in ts/)
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
command -v python3 >/dev/null 2>&1 || fail "python3 unavailable for TS parity"
[ -d "$ROOT/ts" ] || fail "ts/ sibling missing"

if [ ! -f "$ROOT/ts/dist/server.js" ]; then
  echo "--- building ts/ (dist missing) ---"
  (cd "$ROOT/ts" && bun install --no-progress && bun run build) || fail "ts build failed"
fi

echo "--- ts proof under bun (primary) ---"
(cd "$ROOT/ts" && bun run test:bun) || fail "ts proof under bun failed"

echo "--- ts proof under node (fallback compat) ---"
(cd "$ROOT/ts" && npm test) || fail "ts proof under node failed"

echo "--- py/ts wire parity (bun server) ---"
bun "$ROOT/tests/conformance/parity-py-ts.mjs" || fail "py/ts wire parity (bun server) failed"

echo "--- py/ts wire parity (node server) ---"
node "$ROOT/tests/conformance/parity-py-ts.mjs" || fail "py/ts wire parity (node server) failed"

echo "--- ts conformance fixtures (bun) ---"
(cd "$ROOT/ts" && bun run conformance:bun) || fail "ts conformance fixtures (bun) failed"

echo "--- ts conformance fixtures (node) ---"
(cd "$ROOT/ts" && npm run conformance) || fail "ts conformance fixtures (node) failed"

echo "all ts-parity checks passed"
