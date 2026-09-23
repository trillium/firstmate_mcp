#!/usr/bin/env bash
# Two-home scoping fixture for the beads store contract (project-iptk).
#
# Proves fm-tasks-axi-lib.sh keeps two homes sharing one beads store distinct:
# same task slug resolves to DIFFERENT idempotency labels because the scope
# derives from the physical home path. The fleet label stays shared.
#
# Resolution order for the owning library: $FM_TASKS_AXI_LIB, then
# $FM_HOME/bin/fm-tasks-axi-lib.sh, then the live fork checkout. When none
# resolves (e.g. CI without a fork checkout), the suite warns and passes —
# an absent home cannot prove scoping, and a hard fail would punish the
# wrong tree. Locally (and on the captain's box) it always runs.
set -u

LIB="${FM_TASKS_AXI_LIB:-}"
if [ -z "$LIB" ] && [ -n "${FM_HOME:-}" ]; then
  LIB="$FM_HOME/bin/fm-tasks-axi-lib.sh"
fi
if [ -z "$LIB" ]; then
  LIB="$HOME/code/firstmate/bin/fm-tasks-axi-lib.sh"
fi

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'ok - %s\n' "$1"
}

if [ ! -r "$LIB" ]; then
  echo "warn: fork checkout absent ($LIB unreadable); scoping fixture skips" >&2
  pass "two-home scoping skipped without fork checkout"
  exit 0
fi

# shellcheck disable=SC1090
. "$LIB"

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fm-beads-scope.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT INT TERM

HOME_A="$TMP_ROOT/home-a"
HOME_B="$TMP_ROOT/home-b"
mkdir -p "$HOME_A" "$HOME_B"

# 1. Fleet label is shared across homes.
[ "$(FM_HOME="$HOME_A" fm_beads_fleet_label)" = "$(FM_HOME="$HOME_B" fm_beads_fleet_label)" ] \
  || fail "fleet label differs across homes"
[ "$(FM_HOME="$HOME_A" fm_beads_fleet_label)" = "fleet:firstmate" ] \
  || fail "default fleet label is not fleet:firstmate"

# 2. Home scopes differ, are 16 lowercase hex, and are stable.
SCOPE_A="$(FM_HOME="$HOME_A" fm_beads_home_scope)" || fail "scope A failed"
SCOPE_B="$(FM_HOME="$HOME_B" fm_beads_home_scope)" || fail "scope B failed"
[ "$SCOPE_A" != "$SCOPE_B" ] || fail "two homes share one scope ($SCOPE_A)"
case "$SCOPE_A$SCOPE_B" in
  *[!0-9a-f]*|"") fail "scopes are not 16-hex: $SCOPE_A $SCOPE_B" ;;
esac
[ "${#SCOPE_A}" = 16 ] && [ "${#SCOPE_B}" = 16 ] \
  || fail "scope length is not 16"
[ "$(FM_HOME="$HOME_A" fm_beads_home_scope)" = "$SCOPE_A" ] \
  || fail "scope is not stable across reads"

# 3. Same slug, different beads: the two-homes-one-slug case.
LABEL_A="$(FM_HOME="$HOME_A" fm_beads_task_label "du4ii")" || fail "label A failed"
LABEL_B="$(FM_HOME="$HOME_B" fm_beads_task_label "du4ii")" || fail "label B failed"
[ "$LABEL_A" != "$LABEL_B" ] || fail "same slug adopted the same bead ($LABEL_A)"
[ "$LABEL_A" = "task:$SCOPE_A:du4ii" ] || fail "label A mis-shaped: $LABEL_A"
[ "$LABEL_B" = "task:$SCOPE_B:du4ii" ] || fail "label B mis-shaped: $LABEL_B"

# 4. Normalization: symlinked and trailing-slash spellings scope identically.
ln -s "$HOME_A" "$TMP_ROOT/link-a"
LINK_SCOPE="$(FM_HOME="$TMP_ROOT/link-a" fm_beads_home_scope)" || fail "link scope failed"
[ "$LINK_SCOPE" = "$SCOPE_A" ] || fail "symlinked home scopes differently ($LINK_SCOPE vs $SCOPE_A)"
SLASH_SCOPE="$(FM_HOME="$HOME_A/" fm_beads_home_scope)" || fail "slash scope failed"
[ "$SLASH_SCOPE" = "$SCOPE_A" ] || fail "trailing-slash home scopes differently"

# 5. Backend selection: tasks-axi default, beads file honored.
CONF="$TMP_ROOT/config"
mkdir -p "$CONF"
[ "$(fm_backlog_backend_value "$CONF")" = "tasks-axi" ] \
  || fail "backend default is not tasks-axi"
printf 'beads' > "$CONF/backlog-backend"
[ "$(fm_backlog_backend_value "$CONF")" = "beads" ] \
  || fail "backlog-backend file not honored"

# 6. Closed predicate fails open: absent bead is NOT closed.
if fm_beads_is_closed "task-no-such-bead-zzz" 2>/dev/null; then
  fail "absent bead reads closed"
fi

pass "two homes sharing one slug resolve to different beads; fleet label shared; backend + closed-predicate behave"
