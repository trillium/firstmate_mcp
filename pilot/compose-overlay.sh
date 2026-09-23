#!/usr/bin/env bash
# Compose a mirror-hybrid tree: pristine upstream + overlay wins per file.
#
# Pilot (task-loxs5): deterministic, byte-reproducible composition for the
# beads cluster. Same inputs always produce byte-identical outputs; the
# overlay directory IS the file list (walked, never hand-maintained).
#
# Usage:
#   scripts/compose-overlay.sh --upstream DIR --overlay DIR --out DIR
#
# Rules:
#   --out must not exist (never compose over a live tree).
#   Every file under <overlay>/ lands at the same relative path in <out>,
#     replacing the pristine copy. Nothing else is touched.
#   Prints the composed file list with sha256 so provenance can record it.
set -eu

UPSTREAM=""
OVERLAY=""
OUT=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --upstream) UPSTREAM="$2"; shift 2 ;;
    --overlay) OVERLAY="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    -h|--help) sed -n '2,/^set -eu/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "compose-overlay: unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "$UPSTREAM" ] || { echo "compose-overlay: --upstream required" >&2; exit 2; }
[ -n "$OVERLAY" ] || { echo "compose-overlay: --overlay required" >&2; exit 2; }
[ -n "$OUT" ] || { echo "compose-overlay: --out required" >&2; exit 2; }
[ -d "$UPSTREAM" ] || { echo "compose-overlay: no such upstream dir: $UPSTREAM" >&2; exit 2; }
[ -d "$OVERLAY" ] || { echo "compose-overlay: no such overlay dir: $OVERLAY" >&2; exit 2; }
if [ -e "$OUT" ]; then
  echo "compose-overlay: refusing: output exists: $OUT" >&2
  exit 2
fi

mkdir -p "$OUT"
cp -a "$UPSTREAM/." "$OUT/"
( cd "$OVERLAY" && find . -type f | sort ) | while IFS= read -r rel; do
  mkdir -p "$OUT/$(dirname "$rel")"
  cp -a "$OVERLAY/$rel" "$OUT/$rel"
done

( cd "$OUT" && find . -type f | sort | while IFS= read -r f; do
  printf '%s  %s\n' "$(shasum -a 256 "$f" | awk '{print $1}')" "$f"
done )
