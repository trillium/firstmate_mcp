#!/usr/bin/env bash
# Configures git commit hooks for firstmate_mcp checkouts and worktrees.
#
# Sets core.hooksPath to .githooks in repository git config, which applies
# across the primary checkout and all linked worktrees (e.g. treehouse worktrees).
#
# Usage:
#   bash scripts/setup-hooks.sh             # Configure hooks (core.hooksPath = .githooks)
#   bash scripts/setup-hooks.sh --check     # Check if hooks are active
#   bash scripts/setup-hooks.sh --uninstall # Unset core.hooksPath
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
HOOKS_DIR="$REPO_ROOT/.githooks"

show_help() {
  cat <<'EOF'
Usage: scripts/setup-hooks.sh [OPTIONS]

Configures git hooks for this repository and all linked worktrees.

Options:
  --check       Check whether git hooks are currently active
  --uninstall   Remove core.hooksPath configuration
  -h, --help    Show this help message
EOF
}

check_hooks() {
  local current_path
  current_path="$(git config core.hooksPath 2>/dev/null || true)"
  if [ "$current_path" = ".githooks" ]; then
    if [ -x "$HOOKS_DIR/commit-msg" ]; then
      echo "✓ Git hooks are configured and executable (core.hooksPath = .githooks)"
      return 0
    else
      echo "! core.hooksPath is .githooks, but $HOOKS_DIR/commit-msg is not executable"
      return 1
    fi
  else
    echo "✗ Git hooks are not configured (core.hooksPath = '${current_path:-unset}')"
    return 1
  fi
}

uninstall_hooks() {
  git config --unset core.hooksPath 2>/dev/null || true
  echo "✓ Unset core.hooksPath. Default .git/hooks path will be used by git."
}

install_hooks() {
  if [ ! -d "$HOOKS_DIR" ]; then
    echo "Error: hooks directory not found at $HOOKS_DIR" >&2
    exit 1
  fi

  # Ensure all hooks in .githooks are executable
  if [ -f "$HOOKS_DIR/commit-msg" ]; then
    chmod +x "$HOOKS_DIR/commit-msg"
  fi

  # Configure core.hooksPath in repo git config
  git config core.hooksPath .githooks

  echo "✓ Configured git hooks (core.hooksPath = .githooks)"
  echo "  Active hook: $HOOKS_DIR/commit-msg (enforces conventional/semantic commit format)"
  echo "  Applies to this checkout and all linked worktrees."
}

case "${1:-}" in
  --check)
    check_hooks
    ;;
  --uninstall)
    uninstall_hooks
    ;;
  -h|--help)
    show_help
    ;;
  "")
    install_hooks
    ;;
  *)
    echo "Unknown option: $1" >&2
    show_help >&2
    exit 1
    ;;
esac
