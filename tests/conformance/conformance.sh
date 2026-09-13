#!/usr/bin/env bash
# Conformance fixtures: adapter-vs-firstmate equivalence on read tools.
#
# Runs the adapter's read tools against firstmate's REAL bin/fm-*.sh scripts
# in a scratch FM_HOME, then replays the same inputs directly and asserts
# both paths agree. Side-effect-free by construction: only read tools
# dispatch, every subprocess runs under a temp scratch home, and the suite
# asserts the live fleet state dir is untouched.
#
# Usage:
#   bash tests/conformance/conformance.sh
#   FIRSTMATE_HOME=/path/to/firstmate bash tests/conformance/conformance.sh
#
# Without a firstmate checkout the suite skips cleanly (exit 0) so this repo
# stays standalone in CI.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if ! command -v python3 >/dev/null 2>&1; then
  echo "skip: python3 unavailable for conformance fixtures"
  exit 0
fi

python3 "$ROOT/tests/conformance/test_conformance.py" -v
rc=$?
if [ "$rc" -ne 0 ]; then
  printf 'not ok - conformance suite failed (exit %s)\n' "$rc" >&2
  exit "$rc"
fi
echo "all conformance checks passed"
