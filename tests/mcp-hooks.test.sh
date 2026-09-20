#!/usr/bin/env bash
# Behavior tests for commit-msg hook and scripts/setup-hooks.sh.
#
# Verifies:
#   (a) commit-msg accepts all valid semantic commit formats matching repo history
#   (b) commit-msg rejects non-conventional commit messages with clear diagnostics
#   (c) merge, reconcile, revert, and autosquash commits pass without rejection
#   (d) environment variable escape hatch bypasses enforcement
#   (e) setup-hooks.sh correctly configures core.hooksPath and manages lifecycle
#   (f) real git commits in a repo and worktree enforce semantic messages
#   (g) git commit --no-verify bypasses hook enforcement
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
HOOK="$ROOT/.githooks/commit-msg"
SETUP="$ROOT/scripts/setup-hooks.sh"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mcp-hooks-test.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'ok - %s\n' "$1"
}

expect_code() {
  local expected=$1 actual=$2 label=$3 details=${4-}
  [ "$actual" = "$expected" ] && return 0
  [ -z "$details" ] || printf '%s\n' "$details" >&2
  fail "$label: expected exit $expected, got $actual"
}

assert_contains() {
  case "$1" in
    *"$2"*) : ;;
    *) fail "$3 (missing: '$2')"$'\n'"--- output ---"$'\n'"$1" ;;
  esac
}

# 1. Valid semantic commit messages
test_valid_commit_messages() {
  local valid_messages=(
    "feat(ts): implement follow-on actions and dev test runner"
    "feat: add new capability"
    "fix(mcp): raise fleet-read envelope to live-fleet size"
    "fix: correct typo in documentation"
    "chore(hygiene): adopt pnpm as package manager for ts/"
    "chore: clean up scratch files"
    "docs: line binding and runtime checkout resolution"
    "docs(readme): clarify worktree hook resolution"
    "refactor(server): drop Python MCP server, make TypeScript sole server"
    "refactor: restructure layers"
    "test(busy-state): prove the stale-lock reap survives"
    "test: add unit test coverage"
    "ci: add mcp-ci workflow"
    "ci(bin): rebalance portable-serial test shards"
    "perf(fm-lint): cache per-root lint verdicts"
    "perf: optimize regex matching"
    "build(deps): update Effect to 3.22.2"
    "revert: drop unneeded configuration"
    "style: format code according to prettier"
    "feat(mcp)!: breaking change to tool envelope"
    "feat!: breaking change without scope"
    "fix(remote-job.v2): detect dialect"
    "feat(fm-stat-lib/darwin): support custom stat format"
  )

  local msg_file="$TMP_DIR/msg_valid.txt"
  for msg in "${valid_messages[@]}"; do
    printf "%s\n\n# Some git comment\n# Another comment\n" "$msg" > "$msg_file"
    local out status
    out=$("$HOOK" "$msg_file" 2>&1)
    status=$?
    expect_code 0 "$status" "Valid message accepted: '$msg'" "$out"
  done
}

# 2. Invalid commit messages rejected with clear diagnostic
test_invalid_commit_messages() {
  local invalid_messages=(
    "random commit message"
    "Added new feature"
    "Update README.md"
    "WIP: working on stuff"
    "feat:no space after colon"
    "feat(): empty scope"
    "FEAT(ts): uppercase type"
    "feat(TS): uppercase scope"
    "feat(ts):"
    "feat: "
    "unknown(mcp): unknown type"
    "invalid: subject"
  )

  local msg_file="$TMP_DIR/msg_invalid.txt"
  for msg in "${invalid_messages[@]}"; do
    printf "%s\n" "$msg" > "$msg_file"
    local out status
    out=$("$HOOK" "$msg_file" 2>&1)
    status=$?
    expect_code 1 "$status" "Invalid message rejected: '$msg'" "$out"
    assert_contains "$out" "COMMIT MESSAGE REJECTED" "Rejection banner missing"
    assert_contains "$out" "Expected format:" "Expected format missing"
    assert_contains "$out" "Allowed types:" "Allowed types list missing"
    assert_contains "$out" "feat" "Type list missing feat"
    assert_contains "$out" "fix" "Type list missing fix"
    assert_contains "$out" "Escape hatch" "Escape hatch guidance missing"
  done
}

# 3. Exemptions (merge, reconcile, revert, autosquash)
test_exemptions() {
  local exempt_messages=(
    "Merge pull request #36 from trillium/fm/mcp-hooks"
    "Merge branch 'main' of github.com:trillium/firstmate_mcp"
    "Merge remote-tracking branch 'origin/main'"
    "Reconcile: merge upstream kunchenguid/firstmate into trillium fork"
    "Revert \"feat(ts): implement customizable follow-on actions\""
    "fixup! feat(ts): implement follow-on actions"
    "squash! feat(ts): implement follow-on actions"
    "amend! feat(ts): implement follow-on actions"
  )

  local msg_file="$TMP_DIR/msg_exempt.txt"
  for msg in "${exempt_messages[@]}"; do
    printf "%s\n" "$msg" > "$msg_file"
    local out status
    out=$("$HOOK" "$msg_file" 2>&1)
    status=$?
    expect_code 0 "$status" "Exempt message passed: '$msg'" "$out"
  done
}

# 4. Escape hatch via environment variable
test_env_var_escape_hatch() {
  local msg_file="$TMP_DIR/msg_env.txt"
  printf "random non-conventional commit message\n" > "$msg_file"

  local out status
  out=$(FM_SKIP_HOOKS=1 "$HOOK" "$msg_file" 2>&1)
  status=$?
  expect_code 0 "$status" "FM_SKIP_HOOKS=1 allows commit" "$out"

  out=$(SKIP_COMMIT_MSG_HOOK=1 "$HOOK" "$msg_file" 2>&1)
  status=$?
  expect_code 0 "$status" "SKIP_COMMIT_MSG_HOOK=1 allows commit" "$out"
}

# 5. Setup script lifecycle (--check, install, --uninstall)
test_setup_script_lifecycle() {
  local test_repo="$TMP_DIR/repo_setup"
  mkdir -p "$test_repo/.githooks" "$test_repo/scripts"
  cp "$HOOK" "$test_repo/.githooks/commit-msg"
  cp "$SETUP" "$test_repo/scripts/setup-hooks.sh"
  chmod +x "$test_repo/scripts/setup-hooks.sh" "$test_repo/.githooks/commit-msg"

  (
    cd "$test_repo"
    git init --quiet -b main

    # Check initially unconfigured
    local out status
    out=$(bash scripts/setup-hooks.sh --check 2>&1) || true
    assert_contains "$out" "not configured" "Initial check should report unconfigured"

    # Install hooks
    out=$(bash scripts/setup-hooks.sh 2>&1)
    status=$?
    expect_code 0 "$status" "setup-hooks.sh install should exit 0" "$out"
    assert_contains "$out" "core.hooksPath = .githooks" "Install output should confirm hooksPath"

    # Check active
    out=$(bash scripts/setup-hooks.sh --check 2>&1)
    status=$?
    expect_code 0 "$status" "setup-hooks.sh --check should exit 0 when active" "$out"
    assert_contains "$out" "Git hooks are configured and executable" "Check should confirm active"

    # Uninstall
    out=$(bash scripts/setup-hooks.sh --uninstall 2>&1)
    status=$?
    expect_code 0 "$status" "setup-hooks.sh --uninstall should exit 0" "$out"
  )
}

# 6. Real git commit enforcement in repository and worktree
test_real_git_commits() {
  local test_repo="$TMP_DIR/real_git_repo"
  mkdir -p "$test_repo/.githooks" "$test_repo/scripts"
  cp "$HOOK" "$test_repo/.githooks/commit-msg"
  cp "$SETUP" "$test_repo/scripts/setup-hooks.sh"
  chmod +x "$test_repo/.githooks/commit-msg" "$test_repo/scripts/setup-hooks.sh"

  (
    cd "$test_repo"
    git init --quiet -b main
    git config user.name "Test Committer"
    git config user.email "test@example.com"
    bash scripts/setup-hooks.sh

    echo "initial" > file.txt
    git add file.txt .githooks scripts
    git commit -m "feat(init): initial commit with hooks" --quiet

    # 1) Non-conventional commit is rejected
    echo "bad change" >> file.txt
    git add file.txt
    local out status
    out=$(git commit -m "non-conventional commit message" 2>&1) && status=0 || status=$?
    [ "$status" -ne 0 ] || fail "git commit with non-conventional message should fail"
    assert_contains "$out" "COMMIT MESSAGE REJECTED" "git commit error should contain rejection banner"

    # 2) Valid conventional commit succeeds
    echo "good change" >> file.txt
    git add file.txt
    out=$(git commit -m "feat(core): initial feature implementation" 2>&1)
    status=$?
    expect_code 0 "$status" "Valid conventional commit should succeed" "$out"

    # 3) --no-verify bypasses hook on invalid message
    echo "update 2" >> file.txt
    git add file.txt
    out=$(git commit --no-verify -m "non-conventional message with no-verify" 2>&1)
    status=$?
    expect_code 0 "$status" "git commit --no-verify should bypass hook" "$out"

    # 4) Worktree enforcement: create a worktree and test enforcement
    local wt_path="$TMP_DIR/real_git_wt"
    git worktree add -b feature-wt "$wt_path" --quiet

    cd "$wt_path"
    echo "wt change" > wt_file.txt
    git add wt_file.txt

    # Invalid message in worktree is rejected
    out=$(git commit -m "bad worktree message" 2>&1) && status=0 || status=$?
    [ "$status" -ne 0 ] || fail "worktree git commit with invalid message should fail"
    assert_contains "$out" "COMMIT MESSAGE REJECTED" "Worktree rejection should show banner"

    # Valid message in worktree succeeds
    out=$(git commit -m "fix(wt): fix issue in worktree" 2>&1)
    status=$?
    expect_code 0 "$status" "Valid commit in worktree should succeed" "$out"
  )
}

test_valid_commit_messages
test_invalid_commit_messages
test_exemptions
test_env_var_escape_hatch
test_setup_script_lifecycle
test_real_git_commits

pass "all commit-msg hook and setup tests passed"
