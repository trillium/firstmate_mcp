#!/usr/bin/env bash
# Standing loop engine: repin upstream, evaluate the delta, prove the gates.
#
# The owner's standing directive (2026-09-22, AGENTS.md "Posture"): "repin
# upstream, eval features, yolo forward" — an infinite loop. This script is the
# mechanical half of one cycle:
#
#   fetch upstream main -> report the shift -> bump the pin in both provenance
#   files -> regenerate the coverage view -> run every gate CI would run
#
# It deliberately does NOT commit. The evaluation (which moved surfaces are a
# port vs noise) is the part that needs judgement, and it belongs in the commit
# message next to the diff it explains.
#
# Usage:
#   scripts/fm-mcp-repin.sh [--check|--apply] [--submodule PATH] [--no-gates]
#
# Exit: 0 pin is current (or --apply finished green), 1 a shift is pending
# (--check), 2 environment error, 3 a gate failed after --apply.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
MODE="check"
SUBMODULE="$ROOT/sources/firstmate"
RUN_GATES=1

fail() {
  printf 'fm-mcp-repin: %s\n' "$1" >&2
  exit "${2:-2}"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --check) MODE="check"; shift ;;
    --apply) MODE="apply"; shift ;;
    --submodule) SUBMODULE="${2:-}"; shift 2 ;;
    --submodule=*) SUBMODULE="${1#--submodule=}"; shift ;;
    --no-gates) RUN_GATES=0; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) fail "unknown argument: $1 (see --help)" 2 ;;
  esac
done

[ -d "$SUBMODULE/.git" ] || [ -f "$SUBMODULE/.git" ] || fail "no git submodule at $SUBMODULE" 2
cd "$ROOT" || fail "cannot enter $ROOT" 2

git -C "$SUBMODULE" fetch --quiet origin main || fail "could not fetch upstream main" 2
UPSTREAM="$(git -C "$SUBMODULE" rev-parse FETCH_HEAD)"
# The pin of record is the PARENT repo's gitlink, not the submodule's checkout:
# that is what drift/shift.py reads and what CI's drift job checks. Comparing the
# checkout instead reports a phantom shift when the two disagree.
PINNED="$(git ls-files -s -- sources/firstmate 2>/dev/null | awk '{print $2}')"
[ -n "$PINNED" ] || fail "no gitlink for sources/firstmate in the index" 2
CHECKED_OUT="$(git -C "$SUBMODULE" rev-parse HEAD)"
if [ "$CHECKED_OUT" != "$PINNED" ]; then
  printf 'fm-mcp-repin: note — the submodule checkout (%s) is not the pinned gitlink (%s); the gitlink is authoritative\n' \
    "${CHECKED_OUT:0:12}" "${PINNED:0:12}" >&2
fi

if [ "$UPSTREAM" = "$PINNED" ]; then
  printf 'fm-mcp-repin: pin is current at %s\n' "${PINNED:0:12}"
  exit 0
fi

AHEAD="$(git -C "$SUBMODULE" rev-list --count "$PINNED..$UPSTREAM" 2>/dev/null || echo '?')"
printf 'fm-mcp-repin: shift pending — pinned %s -> upstream %s (%s commit(s))\n\n' \
  "${PINNED:0:12}" "${UPSTREAM:0:12}" "$AHEAD"

# Evaluate: which surfaces moved, and which of those anything actually depends on.
python3 drift/shift.py --no-fetch --format markdown || true
printf '\n'

if [ "$MODE" = "check" ]; then
  printf 'fm-mcp-repin: run with --apply to bump the pin, then evaluate the depended-on moves above.\n'
  exit 1
fi

# --- apply ------------------------------------------------------------------
git -C "$SUBMODULE" checkout --quiet "$UPSTREAM" || fail "could not checkout $UPSTREAM" 2
python3 - "$PINNED" "$UPSTREAM" <<'PY' || fail "could not update the provenance pins" 2
import pathlib
import sys

old, new = sys.argv[1], sys.argv[2]
edits = [
    ("manifest/FEATURES.yaml", f"gitlink_at_seed: {old}", f"gitlink_at_seed: {new}"),
    ("schema/contracts.yaml", f"gitlink: {old}", f"gitlink: {new}"),
]
for path, needle, replacement in edits:
    p = pathlib.Path(path)
    text = p.read_text()
    if needle not in text:
        raise SystemExit(f"{path}: pin '{needle}' not found — refusing to guess")
    p.write_text(text.replace(needle, replacement, 1))
print(f"provenance pins updated: {old[:12]} -> {new[:12]}")
PY

python3 scripts/gen_coverage.py >/dev/null || fail "coverage regeneration failed" 2

# Stage EVERYTHING this cycle wrote. Both provenance files and the regenerated
# coverage view are updated with plain writes, and leaving one unstaged once put a
# stale pin on main that its own provenance gate rejected (contracts said the old
# sha while the manifest said the new one).
git add sources/firstmate manifest/FEATURES.yaml schema/contracts.yaml manifest/COVERAGE.md \
  || fail "could not stage the repin changes" 2
STAGED="$(git ls-files -s -- sources/firstmate | awk '{print $2}')"
[ "$STAGED" = "$UPSTREAM" ] || fail "staged gitlink $STAGED does not match upstream $UPSTREAM" 2
# Guard, not hope: nothing this script wrote may be left unstaged before the gates run.
leftover="$(git diff --name-only -- sources/firstmate manifest/FEATURES.yaml schema/contracts.yaml manifest/COVERAGE.md)"
[ -z "$leftover" ] || fail "repin left unstaged changes: $leftover" 2

if [ "$RUN_GATES" -eq 1 ]; then
  failures=0
  run_gate() {
    local label="$1"
    shift
    if "$@" >/tmp/fm-mcp-repin-gate.log 2>&1; then
      printf '  ok   %s\n' "$label"
    else
      printf '  FAIL %s\n' "$label"
      tail -4 /tmp/fm-mcp-repin-gate.log | sed 's/^/       /'
      failures=$((failures + 1))
    fi
  }
  printf 'gates:\n'
  run_gate "manifest" python3 manifest/validate.py
  run_gate "schema" python3 schema/validate.py
  run_gate "readme lists" python3 scripts/gen_readme_lists.py --check
  run_gate "contract index" python3 scripts/gen_contract_index.py --check
  run_gate "parity report" python3 scripts/gen_parity.py --check
  run_gate "fm-manifest suite" bash tests/fm-manifest.test.sh
  run_gate "fm-coverage suite" bash tests/fm-coverage.test.sh
  run_gate "mcp-schema suite" bash tests/mcp-schema.test.sh
  # The ci-gate job compares contracts.yaml, schema/matrix.md and validate.py
  # CURRENT_PINS; run its exact snippet rather than a paraphrase of it.
  run_gate "ci drift-baseline snippet" python3 - <<'PY'
import pathlib
import subprocess
import sys
import textwrap

wf = pathlib.Path(".github/workflows/mcp-ci.yml").read_text()
job = wf.split("name: drift-baseline freshness", 1)[1].split("ci-gate:", 1)[0]
body = textwrap.dedent(job.split("python3 - <<'PYEOF'", 1)[1].split("PYEOF", 1)[0])
raise SystemExit(subprocess.run([sys.executable, "-c", body]).returncode)
PY
  if [ "$failures" -gt 0 ]; then
    printf 'fm-mcp-repin: %s gate(s) failed; fix before committing\n' "$failures" >&2
    exit 3
  fi
fi

printf '\nfm-mcp-repin: repinned %s -> %s; all gates green.\n' "${PINNED:0:12}" "${UPSTREAM:0:12}"
printf 'Next: write the evaluation into the commit message (port vs noise per moved surface), then merge.\n'
