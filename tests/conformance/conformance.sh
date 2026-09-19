#!/usr/bin/env bash
# Conformance fixtures: TS server equivalence against firstmate read tools.
#
# Runs the TS server's read tools against firstmate's REAL bin/fm-*.sh scripts
# in a scratch FM_HOME, then replays the same inputs directly and asserts
# both paths agree. Side-effect-free by construction: only read tools
# dispatch, every subprocess runs under a temp scratch home, and the suite
# asserts the live fleet state dir is untouched.
#
# Usage:
#   bash tests/conformance/conformance.sh
#   FIRSTMATE_HOME=/path/to/firstmate bash tests/conformance/conformance.sh
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if command -v bun >/dev/null 2>&1; then
  (cd "$ROOT/ts" && bun run conformance:bun) || exit 1
elif command -v node >/dev/null 2>&1; then
  (cd "$ROOT/ts" && npm run conformance) || exit 1
else
  printf 'not ok - neither bun nor node available\n' >&2
  exit 1
fi
echo "all conformance checks passed"
