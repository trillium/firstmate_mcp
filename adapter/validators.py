"""Input validators ported from the PoC (poc-mcp/fm_mcp_server.py).

Every validator is a pure predicate or a path check: no subprocess, no
filesystem writes, no reimplementation of script behavior. Rejections name
the expected shape so callers can return it verbatim in the error envelope.
"""

import re
from pathlib import Path

ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}")
PROJECT_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_./-]{0,199}")
REL_PATH_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_./-]{0,255}")
SHA256_RE = re.compile(r"[0-9a-fA-F]{64}")
CORR_RE = re.compile(r"(?:corr=)?[0-9a-fA-F]{16}")
APPROVAL_PREFIX = "I authorize"

SEND_TEXT_MAX_CHARS = 500
NOTE_MAX_CHARS = 500
TITLE_MAX_CHARS = 200
REASON_MAX_CHARS = 1000
DECISION_TEXT_MAX_CHARS = 2000
STATUS_LINES_MIN = 1
STATUS_LINES_MAX = 50
PEEK_LINES_MIN = 1
PEEK_LINES_MAX = 100
REMOTE_FILE_BYTES_MIN = 1
REMOTE_FILE_BYTES_MAX = 262144
REMOTE_FILE_DEFAULT_MAX_BYTES = 8192
DELTA_WAIT_MIN = 0
DELTA_WAIT_MAX = 10
HANDOFF_LINES_MIN = 1
HANDOFF_LINES_MAX = 20
HANDOFF_DEFAULT_LINES = 10
RESTART_IDS_MAX = 8
HANDOFF_KEYS_MAX = 20
REMOTE_CONTROL_VERBS = ("state", "route", "observe", "send")


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


def valid_peek_lines(value):
    """Coerce a peek lines count to the 1..100 window; None when not an integer."""
    try:
        lines = int(value)
    except (TypeError, ValueError):
        return None
    return max(PEEK_LINES_MIN, min(PEEK_LINES_MAX, lines))


def valid_relpath(value):
    """Home-relative file path: no absolute paths, no traversal, no controls.

    Mirrors the confinement bin/fm-remote-file.sh resolve_file enforces
    (relative, ordinary directories, no dot segments), so the adapter
    refuses before spawning what the script would refuse after."""
    if not isinstance(value, str) or REL_PATH_RE.fullmatch(value) is None:
        return False
    if "//" in value:
        return False
    if any(part in ("", ".", "..") for part in value.split("/")):
        return False
    if any(c in value for c in ("\n", "\r", "\t")):
        return False
    return True


def valid_sha256(value):
    """64 hex chars: a continuity-check prefix hash, nothing else."""
    return isinstance(value, str) and SHA256_RE.fullmatch(value) is not None


def valid_corr(value):
    """Correlated-request token: 16 hex chars, optional corr= prefix.

    The owning helper strips the prefix itself; the mirror accepts both
    spellings and passes the value through unchanged."""
    return isinstance(value, str) and CORR_RE.fullmatch(value) is not None


def valid_nonneg_int(value):
    """Nonnegative integer cursor (remote delta offset); None when not one."""
    if isinstance(value, bool):
        return None
    try:
        offset = int(value)
    except (TypeError, ValueError):
        return None
    if isinstance(value, float) and not value.is_integer():
        return None
    if offset < 0:
        return None
    return offset


def valid_delta_wait(value):
    """Coerce a delta-read wait into the 0..10s window; None when not an integer."""
    if isinstance(value, bool):
        return None
    try:
        wait = int(value)
    except (TypeError, ValueError):
        return None
    if isinstance(value, float) and not value.is_integer():
        return None
    return max(DELTA_WAIT_MIN, min(DELTA_WAIT_MAX, wait))


def valid_remote_max_bytes(value):
    """Coerce a remote-file byte bound into the 1..256KB window; None when bad."""
    if isinstance(value, bool):
        return None
    try:
        cap = int(value)
    except (TypeError, ValueError):
        return None
    if isinstance(value, float) and not value.is_integer():
        return None
    return max(REMOTE_FILE_BYTES_MIN, min(REMOTE_FILE_BYTES_MAX, cap))


def valid_handoff_lines(value):
    """Coerce an outbox line count to the 1..20 window; None when not an integer."""
    try:
        lines = int(value)
    except (TypeError, ValueError):
        return None
    return max(HANDOFF_LINES_MIN, min(HANDOFF_LINES_MAX, lines))


def valid_id_list(value, max_items):
    """Non-empty list of id slugs, capped at max_items; None when not one."""
    if not isinstance(value, list) or not 1 <= len(value) <= max_items:
        return None
    if not all(valid_id(item) for item in value):
        return None
    return list(value)


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


def confine_handoff_path(data_dir, task_id):
    """Resolve data/handoff/<task_id>.outbox.md confined under data_dir.

    Returns the resolved Path, or None when the id is invalid, the home
    cannot be resolved, or the resolved path escapes the handoff directory.
    """
    if not valid_id(task_id):
        return None
    try:
        root = Path(data_dir).resolve()
    except OSError:
        return None
    path = (root / "handoff" / f"{task_id}.outbox.md").resolve()
    if path.parent != root / "handoff":
        return None
    return path
