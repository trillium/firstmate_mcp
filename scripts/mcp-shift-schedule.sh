#!/usr/bin/env bash
# Scheduled upstream-shift gate: runs drift/shift.py and decides fire vs silence.
#
# Fast path first: shift.py polls the upstream Atom feed for the latest main
# SHA against the pin (the pin is the cached SHA, quiet when unchanged) and
# only runs the heavier ls-remote + bin/ diff when the feed moved or is
# unreadable. This script needs no atom-specific logic: --atom/--no-atom,
# --atom-branch, --atom-timeout, --atom-url, and --atom-feed-file all
# forward to shift.py like --fetch/--no-fetch already do.
#
# - Shift detected (shift.py exit 1): writes the PORT/IGNORE markdown report to
#   --body PATH, records shift=true (+ pinned/upstream SHAs) in $GITHUB_OUTPUT
#   when set, prints a SHIFT line, and exits 0 so a scheduled job can gate the
#   issue step on the output instead of a failure.
# - No shift (exit 0): removes any stale --body file, records shift=false,
#   prints a quiet line, exits 0. No noise, no empty issues.
# - Detector error (exit 2): writes nothing, records nothing, exits 2.
# - --file-issue: file (or dedup) the shift issue with gh, using --body PATH
#   --upstream SHA --pinned SHA [--label NAME]; no detection is done. The gh
#   logic lives here, not in the workflow, so the hermetic tests cover it: a
#   `gh issue list --jq` without `--json`, plus a label that did not exist yet,
#   made the scheduled job fail on every run for five days (2026-09-18..22).
#
# Hermetic tests override the detector with stubs via --shift-py PATH (or
# $SHIFT_PY); extra unknown flags are forwarded to shift.py (--fetch/--no-fetch).
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHIFT_PY="${SHIFT_PY:-$ROOT/drift/shift.py}"
BODY=""
FILE_ISSUE=0
LABEL="upstream-shift"
UPSTREAM_ARG=""
PINNED_ARG=""

FORWARD=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --body) BODY="${2:-}"; [ -n "$BODY" ] || { echo "shift-schedule: --body needs a path" >&2; exit 2; }; shift 2 ;;
    --body=*) BODY="${1#--body=}"; shift ;;
    --file-issue) FILE_ISSUE=1; shift ;;
    --label) LABEL="${2:-}"; shift 2 ;;
    --label=*) LABEL="${1#--label=}"; shift ;;
    --upstream) UPSTREAM_ARG="${2:-}"; shift 2 ;;
    --upstream=*) UPSTREAM_ARG="${1#--upstream=}"; shift ;;
    --pinned) PINNED_ARG="${2:-}"; shift 2 ;;
    --pinned=*) PINNED_ARG="${1#--pinned=}"; shift ;;
    --shift-py) SHIFT_PY="$2"; shift 2 ;;
    --shift-py=*) SHIFT_PY="${1#--shift-py=}"; shift ;;
    -h|--help) awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$0"; exit 0 ;;
    *) FORWARD+=("$1"); shift ;;
  esac
done
[ -n "$BODY" ] || BODY="$ROOT/shift-report.md"

# File the shift issue. Idempotent by design: the label is created if missing
# (creating an existing label is a no-op) and an open issue naming this upstream
# SHA suppresses a duplicate. `--jq` requires `--json`; omitting it exits 2 and
# is exactly what killed the scheduled job silently.
file_issue() {
  local label="$1" upstream="$2" pinned="$3" body="$4"
  [ -n "$upstream" ] && [ -n "$pinned" ] || {
    echo "shift-schedule: --file-issue needs --upstream and --pinned" >&2
    return 2
  }
  [ -f "$body" ] || { echo "shift-schedule: --file-issue needs an existing --body report" >&2; return 2; }
  command -v gh >/dev/null 2>&1 || { echo "shift-schedule: --file-issue needs gh on PATH" >&2; return 2; }
  gh label create "$label" \
    --description "Upstream firstmate shift detected by the daily radar" \
    --color FBCA04 >/dev/null 2>&1 || true
  # Titles carry the short SHA (${upstream:0:12}), so dedup must match the
  # same 12 chars: grepping the full SHA never matched and every daily run
  # would have opened a fresh issue.
  if gh issue list --label "$label" --state open --json title --jq '.[].title' 2>/dev/null \
       | grep -qF "${upstream:0:12}"; then
    echo "shift-schedule: shift to ${upstream:0:12} already reported; skipping new issue"
    return 0
  fi
  gh issue create --label "$label" \
    --title "Upstream shift ${pinned:0:12} -> ${upstream:0:12}" \
    --body-file "$body" || {
    echo "shift-schedule: could not open the shift issue" >&2
    return 2
  }
  echo "shift-schedule: opened ${label} issue for ${pinned:0:12} -> ${upstream:0:12}"
  return 0
}

if [ "$FILE_ISSUE" -eq 1 ]; then
  file_issue "$LABEL" "$UPSTREAM_ARG" "$PINNED_ARG" "$BODY"
  exit $?
fi

TMP_JSON="$(mktemp "${TMPDIR:-/tmp}/shift-schedule-json.XXXXXX")"
TMP_ERR="$(mktemp "${TMPDIR:-/tmp}/shift-schedule-err.XXXXXX")"
trap 'rm -f "$TMP_JSON" "$TMP_ERR"' EXIT INT TERM

set +e
"$SHIFT_PY" --format json "${FORWARD[@]}" >"$TMP_JSON" 2>"$TMP_ERR"
code=$?
set -e

if [ "$code" -eq 2 ]; then
  rm -f "$BODY"
  cat "$TMP_ERR" >&2
  echo "shift-schedule: detector error (exit 2); no report written" >&2
  exit 2
fi
if [ "$code" -ne 0 ] && [ "$code" -ne 1 ]; then
  rm -f "$BODY"
  cat "$TMP_ERR" >&2
  echo "shift-schedule: unexpected detector exit $code" >&2
  exit 2
fi

read_fields() {
  python3 - "$TMP_JSON" <<'PYEOF'
import json, sys
rep = json.load(open(sys.argv[1], encoding="utf-8"))
print("true" if rep.get("shift") else "false")
print(rep.get("pinned", ""))
print(rep.get("upstream", ""))
summary = rep.get("summary", {})
print(summary.get("depended_on_moved", 0))
print(summary.get("other_changed", 0))
PYEOF
}

FIELDS="$(read_fields)"
SHIFT="$(printf '%s' "$FIELDS" | sed -n '1p')"
PINNED="$(printf '%s' "$FIELDS" | sed -n '2p')"
UPSTREAM="$(printf '%s' "$FIELDS" | sed -n '3p')"
PORT_N="$(printf '%s' "$FIELDS" | sed -n '4p')"
NOISE_N="$(printf '%s' "$FIELDS" | sed -n '5p')"

emit_output() {
  [ -z "${GITHUB_OUTPUT:-}" ] && return 0
  {
    echo "shift=$1"
    echo "pinned=$PINNED"
    echo "upstream=$UPSTREAM"
  } >>"$GITHUB_OUTPUT"
}

if [ "$SHIFT" = "true" ]; then
  set +e
  "$SHIFT_PY" --format markdown "${FORWARD[@]}" >"$BODY" 2>>"$TMP_ERR"
  md_code=$?
  set -e
  if [ "$md_code" -ne 0 ] && [ "$md_code" -ne 1 ]; then
    echo "shift-schedule: could not render markdown report" >&2
    exit 2
  fi
  emit_output true
  echo "shift-schedule: SHIFT ${PINNED:0:12} -> ${UPSTREAM:0:12}: PORT=$PORT_N IGNORE=$NOISE_N report=$BODY"
  exit 0
fi

rm -f "$BODY"
emit_output false
echo "shift-schedule: quiet (pin tracks upstream ${UPSTREAM:0:12}); no report written"
exit 0
