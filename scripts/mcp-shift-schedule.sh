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
#
# Hermetic tests override the detector with stubs via --shift-py PATH (or
# $SHIFT_PY); extra unknown flags are forwarded to shift.py (--fetch/--no-fetch).
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHIFT_PY="${SHIFT_PY:-$ROOT/drift/shift.py}"
BODY=""

FORWARD=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --body) BODY="${2:-}"; [ -n "$BODY" ] || { echo "shift-schedule: --body needs a path" >&2; exit 2; }; shift 2 ;;
    --body=*) BODY="${1#--body=}"; shift ;;
    --shift-py) SHIFT_PY="$2"; shift 2 ;;
    --shift-py=*) SHIFT_PY="${1#--shift-py=}"; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) FORWARD+=("$1"); shift ;;
  esac
done
[ -n "$BODY" ] || BODY="$ROOT/shift-report.md"

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
