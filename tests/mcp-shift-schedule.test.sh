#!/usr/bin/env bash
# Hermetic proof for the scheduled upstream-shift gate.
# No network, no submodule, no live checkout: layer A drives the real
# drift/shift.py report functions with a faked moved upstream (depended-on
# script + noise) and a no-move pair; layer B drives scripts/mcp-shift-schedule.sh
# with stub detectors asserting fire writes the PORT/IGNORE report while quiet
# and error cases stay silent.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCHED="$ROOT/scripts/mcp-shift-schedule.sh"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/shift-schedule.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT INT TERM

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'ok - %s\n' "$1"
}

assert_contains() {
  case "$1" in
    *"$2"*) : ;;
    *) fail "$3 (missing: '$2')"$'\n'"--- output ---"$'\n'"$1" ;;
  esac
}

assert_not_exists() {
  [ -e "$1" ] && fail "$2 (unexpected file: $1)"
}

# Layer A: real shift.py report math on a faked moved upstream.
test_moved_upstream_fires_port_ignore() {
  local out
  out=$(cd "$ROOT" && python3 - <<'PYEOF'
import drift.shift as shift

mapping = shift.depended_on_commands()
assert "fm-fleet-snapshot.sh" in mapping, "seed mapping lost fm-fleet-snapshot.sh"

pinned, upstream = "a" * 40, "b" * 40
rep = shift.build_report(
    pinned, upstream, "test:fake",
    mapping, ["fm-fleet-snapshot.sh", "fm-some-noise.sh"],
)
assert rep["shift"] is True
assert rep["summary"] == {"depended_on_moved": 1, "other_changed": 1}, rep["summary"]
md = shift.to_markdown(rep)
print(md)
PYEOF
) || fail "moved-upstream report raised"
  assert_contains "$out" "fm-fleet-snapshot.sh" "moved report names the depended-on script" "$out"
  assert_contains "$out" "fleet_snapshot" "moved report names the owning contract" "$out"
  assert_contains "$out" "Depended-on surfaces that moved" "moved report has the PORT section" "$out"
  assert_contains "$out" "fm-some-noise.sh" "moved report files noise under IGNORE" "$out"
}

test_no_move_reports_silence() {
  local out
  out=$(cd "$ROOT" && python3 - <<'PYEOF'
import drift.shift as shift

mapping = shift.depended_on_commands()
rep = shift.build_report("c" * 40, "c" * 40, "test:fake", mapping, [])
assert rep["shift"] is False
assert rep["summary"] == {"depended_on_moved": 0, "other_changed": 0}, rep["summary"]
print(shift.to_markdown(rep))
PYEOF
) || fail "no-move report raised"
  assert_contains "$out" "No shift" "no-move report says quiet" "$out"
}

# Layer B: scheduler fire-vs-silence gating with stub detectors.
stub_detector() {
  # $1 = path, $2 = mode (fire|quiet|error)
  python3 - "$1" "$2" <<'PYEOF'
import sys
path, mode = sys.argv[1], sys.argv[2]
if mode == "fire":
    json_body = '{"pinned": "' + "a" * 40 + '", "upstream": "' + "b" * 40 + '", "resolved_via": "test:stub", "shift": true, "depended_on_moved": [{"script": "fm-fleet-snapshot.sh", "contract": "fleet_snapshot"}], "other_changed": ["fm-some-noise.sh"], "summary": {"depended_on_moved": 1, "other_changed": 1}}'
    md_body = "# Upstream shift report\\n\\n## Depended-on surfaces that moved (port from here)\\n\\n- `fm-fleet-snapshot.sh` (contract `fleet_snapshot`)\\n\\n## Other changed scripts (noise unless a pin names them)\\n\\n- `fm-some-noise.sh`\\n"
    code = "1"
elif mode == "quiet":
    json_body = '{"pinned": "' + "c" * 40 + '", "upstream": "' + "c" * 40 + '", "resolved_via": "test:stub", "shift": false, "depended_on_moved": [], "other_changed": [], "summary": {"depended_on_moved": 0, "other_changed": 0}}'
    md_body = "# Upstream shift report\\n\\nNo shift: the pin tracks upstream main.\\n"
    code = "0"
else:
    json_body, md_body, code = "", "", "2"
json_line = "  printf '%s\\n' '" + json_body + "'\n" if json_body else "  :\n"
md_line = "printf '%b\\n' '" + md_body + "'\n" if md_body else "printf 'shift: stub boom\\n' >&2\n"
text = (
    "#!/usr/bin/env bash\n"
    'if [ "${1:-}" = "--format" ] && [ "${2:-}" = "json" ]; then\n'
    + json_line
    + "  exit " + code + "\n"
    + "fi\n"
    + md_line
    + "exit " + code + "\n"
)
open(path, "w", encoding="utf-8").write(text)
PYEOF
  chmod +x "$1"
}

test_scheduler_fires_on_movement() {
  local stub="$TMP_ROOT/stub-fire.sh" body="$TMP_ROOT/fire-report.md"
  local outputs="$TMP_ROOT/fire-outputs" out status
  stub_detector "$stub" fire
  out=$(GITHUB_OUTPUT="$outputs" bash "$SCHED" --shift-py "$stub" --body "$body" 2>&1)
  status=$?
  [ "$status" -eq 0 ] || fail "fire case exited $status, want 0"$'\n'"$out"
  [ -f "$body" ] || fail "fire case wrote no report body"
  assert_contains "$(cat "$body")" "fm-fleet-snapshot.sh" "fire body names the PORT script" "$(cat "$body")"
  assert_contains "$(cat "$body")" "fm-some-noise.sh" "fire body names the IGNORE script" "$(cat "$body")"
  assert_contains "$out" "PORT=1" "fire line carries the PORT count" "$out"
  assert_contains "$(cat "$outputs")" "shift=true" "fire case exports shift=true" "$(cat "$outputs")"
  assert_contains "$(cat "$outputs")" "upstream=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" "fire case exports the upstream SHA" "$(cat "$outputs")"
}

test_scheduler_silent_on_no_move() {
  local stub="$TMP_ROOT/stub-quiet.sh" body="$TMP_ROOT/quiet-report.md"
  local outputs="$TMP_ROOT/quiet-outputs" out status
  stub_detector "$stub" quiet
  echo "stale" >"$body" # a stale body must be removed, not left behind
  out=$(GITHUB_OUTPUT="$outputs" bash "$SCHED" --shift-py "$stub" --body "$body" 2>&1)
  status=$?
  [ "$status" -eq 0 ] || fail "quiet case exited $status, want 0"$'\n'"$out"
  assert_not_exists "$body" "quiet case left a report body behind"
  assert_contains "$out" "quiet" "quiet case prints the quiet line" "$out"
  assert_contains "$(cat "$outputs")" "shift=false" "quiet case exports shift=false" "$(cat "$outputs")"
}

test_scheduler_error_stays_silent() {
  local stub="$TMP_ROOT/stub-error.sh" body="$TMP_ROOT/error-report.md"
  local out status
  stub_detector "$stub" error
  out=$(bash "$SCHED" --shift-py "$stub" --body "$body" 2>&1)
  status=$?
  [ "$status" -eq 2 ] || fail "error case exited $status, want 2"$'\n'"$out"
  assert_not_exists "$body" "error case wrote a report body"
}

test_moved_upstream_fires_port_ignore
test_no_move_reports_silence
test_scheduler_fires_on_movement
test_scheduler_silent_on_no_move
test_scheduler_error_stays_silent
pass "shift scheduler: moved upstream fires PORT/IGNORE, no-move and errors stay silent"
