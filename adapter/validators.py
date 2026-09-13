"""Input validators ported from the PoC (poc-mcp/fm_mcp_server.py).

Every validator is a pure predicate or a path check: no subprocess, no
filesystem writes, no reimplementation of script behavior. Rejections name
the expected shape so callers can return it verbatim in the error envelope.
"""

import re
from pathlib import Path

ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}")
PROJECT_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_./-]{0,199}")
APPROVAL_PREFIX = "I authorize"

SEND_TEXT_MAX_CHARS = 500
NOTE_MAX_CHARS = 500
TITLE_MAX_CHARS = 200
REASON_MAX_CHARS = 1000
DECISION_TEXT_MAX_CHARS = 2000
STATUS_LINES_MIN = 1
STATUS_LINES_MAX = 50


def valid_id(value):
    """Short task/decision slug: no slashes, no traversal."""
    return isinstance(value, str) and ID_RE.fullmatch(value) is not None


def valid_project(value):
    """Bare project name or projects/<name>: no absolute paths, no traversal."""
    if not isinstance(value, str) or PROJECT_RE.fullmatch(value) is None:
        return False
    if ".." in value or value.startswith("/"):
        return False
    return True


def valid_single_line(value, max_chars):
    """Single-line human text, 1..max_chars, no CR/LF."""
    return (
        isinstance(value, str)
        and 1 <= len(value) <= max_chars
        and "\n" not in value
        and "\r" not in value
    )


def valid_note(value, cap=NOTE_MAX_CHARS):
    """Single-line note capped at cap chars (default 500)."""
    return valid_single_line(value, cap)


def valid_approval(value):
    """Explicit per-action authorization string starting with 'I authorize'."""
    return (
        isinstance(value, str)
        and value.startswith(APPROVAL_PREFIX)
        and len(value) <= NOTE_MAX_CHARS
    )


def valid_steer_text(value, max_chars=SEND_TEXT_MAX_CHARS):
    """Plain prose steer: single line, capped, never a slash command."""
    if not valid_single_line(value, max_chars):
        return False
    return not value.lstrip().startswith("/")


def valid_status_lines(value):
    """Coerce a lines count to the 1..50 window; None when not an integer."""
    try:
        lines = int(value)
    except (TypeError, ValueError):
        return None
    return max(STATUS_LINES_MIN, min(STATUS_LINES_MAX, lines))


def confine_state_path(state_dir, task_id):
    """Resolve state/<task_id>.status confined under state_dir.

    Returns the resolved Path, or None when the id is invalid, the home
    cannot be resolved, or the resolved path escapes the state directory.
    """
    if not valid_id(task_id):
        return None
    try:
        root = Path(state_dir).resolve()
    except OSError:
        return None
    path = (root / f"{task_id}.status").resolve()
    if path.parent != root:
        return None
    return path
