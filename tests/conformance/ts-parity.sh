#!/usr/bin/env bash
# TypeScript-sibling parity gate: the shared conformance referee for both paths.
#
# Proves the TS implementation in ts/ behaves like firstmate two ways:
#   (a) parity-py-ts.mjs replays the same stub-home call sequence against
#       `python3 fm_mcp_server.py` and `node ts/dist/server.js` and diffs
#       every payload field-for-field;
#   (b) the TS conformance fixtures (npm run conformance in ts/) prove the
#       TS read tools equal the owning scripts' output hermetically.
#
# Usage: bash tests/conformance/ts-parity.sh
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "node unavailable for TS parity"
command -v python3 >/dev/null 2>&1 || fail "python3 unavailable for TS parity"
[ -d "$ROOT/ts" ] || fail "ts/ sibling missing"

if [ ! -f "$ROOT/ts/dist/server.js" ]; then
  echo "--- building ts/ (dist missing) ---"
  (cd "$ROOT/ts" && npm install --no-audit --no-fund && npm run build) || fail "ts build failed"
fi

echo "--- py/ts wire parity ---"
node "$ROOT/tests/conformance/parity-py-ts.mjs" || fail "py/ts wire parity failed"

echo "--- ts conformance fixtures ---"
(cd "$ROOT/ts" && npm run conformance) || fail "ts conformance fixtures failed"

echo "all ts-parity checks passed"
