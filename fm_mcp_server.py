#!/usr/bin/env python3
"""First Mate MCP smarts-only server (stdlib only, no dependencies)."""
import hashlib
import json
import os
import re
import secrets
import signal
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

SERVER_NAME = "firstmate-mcp-poc"
SERVER_VERSION = "0.3.0"
SUPPORTED_PROTOCOL_VERSIONS = ("2024-11-05", "2025-03-26", "2025-06-18")
SNAPSHOT_SCHEMA = "fm-fleet-snapshot.v1"
BEARINGS_SCHEMA = "fm-bearings.v1"
HOME_SUMMARY_SCHEMA = "fm-secondmate-home-summary.v1"
CHECKOUT_ROOT = Path(__file__).resolve().parent


def home_dir():
    return Path(os.environ.get("FM_HOME", str(CHECKOUT_ROOT)))


CHECKOUT_BIN = CHECKOUT_ROOT / "bin"
BIN = CHECKOUT_BIN if CHECKOUT_BIN.is_dir() else home_dir() / "bin"
MAX_OUTPUT_BYTES = 1048576
TAIL_CAP_BYTES = 8192
# Fail-closed call budget: no tool call ever blocks an external caller past
# this. A script that cannot finish in time is killed as a whole process
# group and answered with a typed timeout error; callers that need longer
# work submit it via receipt_submit and poll receipt_status instead.
SUBPROCESS_TIMEOUT_S = 30
# Background budget for receipt runs: the detached continuation of a
# receipt_submit may run this long while the caller stays unblocked.
RECEIPT_TIMEOUT_S = 180
# Receipt lifetime: completed receipt records stay retrievable this long,
# then expire. Receipts live under the serving home's state dir, so they
# never leak across homes.
RECEIPT_TTL_S = 3600
RECEIPT_DIRNAME = "mcp-receipts"
SEND_TEXT_MAX_CHARS = 500
APPROVAL_PREFIX = "I authorize"
ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}")
PROJECT_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_./-]{0,199}")
REL_PATH_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_./-]{0,255}")
SHA256_RE = re.compile(r"[0-9a-fA-F]{64}")
CORR_RE = re.compile(r"(?:corr=)?[0-9a-fA-F]{16}")
REMOTE_CONTROL_VERBS = ("state", "route", "observe", "send")
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
MODES = ("no-mistakes", "direct-PR", "local-only")
BRIEF_MODES = ("no-mistakes", "direct-PR", "local-only", "scout")
HARNESS_MODES = ("own", "crew", "secondmate", "secondmate-model", "secondmate-effort")
VERDICTS = ("approve", "decline", "comment")


def state_dir():
    override = os.environ.get("FM_STATE_OVERRIDE")
    return Path(override) if override else home_dir() / "state"


def data_dir():
    override = os.environ.get("FM_DATA_OVERRIDE")
    return Path(override) if override else home_dir() / "data"


def valid_id(value):
    return isinstance(value, str) and ID_RE.fullmatch(value) is not None


def valid_project(value):
    if not isinstance(value, str) or PROJECT_RE.fullmatch(value) is None:
        return False
    if ".." in value or value.startswith("/"):
        return False
    return True


def valid_note(value, cap=500):
    return (
        isinstance(value, str)
        and 1 <= len(value) <= cap
        and "\n" not in value
        and "\r" not in value
    )


def valid_approval(value):
    return isinstance(value, str) and value.startswith(APPROVAL_PREFIX) and len(value) <= 500


def valid_relpath(value):
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
    return isinstance(value, str) and SHA256_RE.fullmatch(value) is not None


def valid_corr(value):
    return isinstance(value, str) and CORR_RE.fullmatch(value) is not None


def valid_nonneg_int(value):
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
    try:
        lines = int(value)
    except (TypeError, ValueError):
        return None
    return max(HANDOFF_LINES_MIN, min(HANDOFF_LINES_MAX, lines))


def valid_id_list(value, max_items):
    if not isinstance(value, list) or not 1 <= len(value) <= max_items:
        return None
    if not all(valid_id(item) for item in value):
        return None
    return list(value)


def confine_handoff_path(home_data_dir, task_id):
    if not valid_id(task_id):
        return None
    try:
        root = Path(home_data_dir).resolve()
    except OSError:
        return None
    path = (root / "handoff" / f"{task_id}.outbox.md").resolve()
    if path.parent != root / "handoff":
        return None
    return path


def approval_error():
    return {
        "error": "approval required",
        "expect": "explicit approval string starting with 'I authorize'",
    }


AUDIT_VERSION = 1

# Tier mirror of auth/tiers.py TOOL_TIERS (kept inline so the server stays
# stdlib-only and single-file; auth/ remains the standing contract and the
# cutover proof diffs both). Forbidden tools have no MCP tool and answer
# unknown-tool; unknown names audit with a null tier.
AUDIT_TOOL_TIERS = {
    "fleet_snapshot": 1,
    "backlog": 1,
    "crew_state": 1,
    "status_tail": 1,
    "fleet_poll": 1,
    "peek": 1,
    "fleet_view": 1,
    "review_diff": 1,
    "bearings_snapshot": 1,
    "wake_drain": 1,
    "guard_check": 1,
    "remote_doctor": 1,
    "remote_file": 1,
    "remote_delta": 1,
    "handoff_status": 1,
    "harness_detect": 1,
    "project_mode": 1,
    "lock_status": 1,
    "lease_check": 1,
    "bearings_board_path": 1,
    "inbox_status": 1,
    "inbox_list": 1,
    "home_summary": 1,
    "contributions_snapshot": 1,
    "contributions_pending": 1,
    "send_message": 2,
    "lifecycle_interrupt": 3,
    "lifecycle_exit": 3,
    "lifecycle_relaunch": 3,
    "lifecycle_suspend": 3,
    "lifecycle_resume": 3,
    "receipt_submit": 1,
    "receipt_status": 1,
    "spawn_crew": 3,
    "scaffold_brief": 3,
    "decision_hold": 3,
    "decision_resolve": 3,
    "review_decision": 3,
    "relay_reply": 4,
    "relay_dismiss": 4,
    "relay_followup": 4,
    "secondmate_nudge": 3,
    "secondmate_restart": 3,
    "secondmate_report": 3,
    "remote_control": 3,
    "handoff_move": 3,
}
AUDIT_FORBIDDEN_TOOLS = (
    "promote_scout",
    "teardown_crew",
    "arm_pr_check",
    "merge_pr",
    "merge_local",
)

# Payload error strings that refuse the request (auth/validation) rather
# than report a downstream failure. Anything else flagged isError ran with
# authorization and audits as allow/ok with the failure kept in the payload.
AUDIT_VALIDATION_ERRORS = frozenset({
    "invalid id",
    "invalid target",
    "invalid text",
    "slash commands refused",
    "invalid lines",
    "invalid note",
    "invalid task_id",
    "invalid project",
    "invalid mode",
    "invalid yolo",
    "invalid origin_id",
    "invalid decision_key",
    "invalid title",
    "invalid reason",
    "invalid routed_to",
    "invalid decision_text",
    "invalid verdict",
    "invalid comment",
    "invalid request_id",
    "invalid final",
    "invalid count",
    "invalid interval_s",
    "invalid stat",
    "invalid path",
    "invalid max_bytes",
    "invalid offset",
    "invalid sha256",
    "invalid wait",
    "invalid verb",
    "invalid corr",
    "invalid keys",
    "invalid resume",
    "no handoff for id",
    "cannot read handoff",
    "invalid all",
    "contributions was not JSON",
    "contributions pending was not JSON",
    "contributions too large for envelope",
    "no home summary",
    "cannot read home summary",
    "home summary was not JSON",
    "unexpected home summary schema",
    "home summary too large for envelope",
    "bearings was not JSON",
    "unexpected bearings schema",
    "bearings too large for envelope",
    "invalid tool",
    "invalid arguments",
    "unknown tool",
    "invalid receipt_id",
    "unknown receipt",
    "receipt expired",
    "cannot read receipt",
    "cannot read status log",
    "no status log for id",
    "unexpected snapshot schema",
    "snapshot was not JSON",
    "snapshot too large for PoC envelope",
    "poll output too large for PoC envelope",
    "tool crashed",
})


def audit_tier(tool):
    if tool in AUDIT_TOOL_TIERS:
        return AUDIT_TOOL_TIERS[tool]
    if tool in AUDIT_FORBIDDEN_TOOLS:
        return "forbidden"
    return None


def audit_approval_ref(approval):
    if not isinstance(approval, str) or not approval:
        return None
    return hashlib.sha256(approval.encode("utf-8")).hexdigest()[:16]


def audit_target(name, args):
    if not isinstance(args, dict):
        return None
    for key in ("id", "target", "task_id", "origin_id", "request_id",
                "receipt_id", "tool", "path", "log", "project"):
        value = args.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def audit_decision(args, payload, is_error):
    """Map a tool outcome to the (decision, reason) authorization audit pair.

    allow/ok means the request was authorized to execute; a downstream
    script failure after dispatch keeps allow/ok with the failure in the
    tool payload. refuse/* means the request never dispatched.
    """
    if not is_error:
        return "allow", "ok"
    error = payload.get("error") if isinstance(payload, dict) else None
    if error == "approval required":
        approval = args.get("approval") if isinstance(args, dict) else None
        if approval is None:
            return "refuse", "approval-required"
        return "refuse", "approval-invalid"
    if isinstance(error, str) and error in AUDIT_VALIDATION_ERRORS:
        return "refuse", "validation-failed"
    return "allow", "ok"


def audit_log_path():
    override = os.environ.get("FM_AUDIT_LOG")
    if override:
        return Path(override)
    return home_dir() / "state" / "mcp-audit.jsonl"


def audit_append(tool, decision, reason, approval=None, target=None):
    """Append one JSON-lines audit record. Best-effort: never breaks a call."""
    try:
        dest = audit_log_path()
        dest.parent.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        line = {
            "v": AUDIT_VERSION,
            "ts": stamp,
            "actor": os.environ.get("FM_ACTOR", "local"),
            "tool": tool,
            "tier": audit_tier(tool),
            "decision": decision,
            "reason": reason,
            "approval_ref": audit_approval_ref(approval),
            "target": target,
        }
        with dest.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(line, sort_keys=True) + "\n")
    except Exception:
        pass


def truncate(text, cap=TAIL_CAP_BYTES):
    if len(text.encode("utf-8", "replace")) <= cap:
        return text, False
    buf = text.encode("utf-8", "replace")[:cap].decode("utf-8", "replace")
    return buf + "\n…[truncated]", True


def terminate_process_group(proc, grace_s=5):
    """Kill the child and its whole group after a timeout.

    A bare proc.kill() would reap only the shell; fm-*.sh scripts shell out to
    per-task children that would keep running as orphans for the rest of their
    natural lifetime. start_new_session puts the child at the head of its own
    group, so killing the group reclaims every descendant.
    """
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        return
    try:
        proc.wait(timeout=grace_s)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        proc.wait()


_run_timeout = threading.local()


def _current_timeout():
    """Effective script budget: the fail-closed 30s default, or the receipt
    background budget inside a receipt worker thread (thread-local, so sync
    calls are never affected)."""
    return getattr(_run_timeout, "s", SUBPROCESS_TIMEOUT_S)


def run_script(argv, timeout_s=None):
    budget = timeout_s if timeout_s is not None else _current_timeout()
    try:
        proc = subprocess.Popen(
            [str(a) for a in argv],
            cwd=str(CHECKOUT_ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
    except FileNotFoundError as exc:
        return None, {"error": "executable not found", "detail": str(exc)}
    try:
        stdout, stderr = proc.communicate(timeout=budget)
    except subprocess.TimeoutExpired:
        terminate_process_group(proc)
        stdout, stderr = proc.communicate()
        return None, {"error": "timed out", "timeout_s": budget}
    return subprocess.CompletedProcess(proc.args, proc.returncode, stdout, stderr), None


def receipt_dir():
    return state_dir() / RECEIPT_DIRNAME


def new_receipt_id():
    return "rcpt-" + secrets.token_hex(8)


def utc_now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def write_receipt(record):
    dest = receipt_dir()
    dest.mkdir(parents=True, exist_ok=True)
    path = (dest / (record["receipt_id"] + ".json")).resolve()
    if path.parent != dest.resolve():
        return False
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(record, sort_keys=True), encoding="utf-8")
    tmp.replace(path)
    return True


def read_receipt(receipt_id):
    """Load one receipt record confined to this home's receipt dir.
    Returns (record, None) or (None, typed-error-payload)."""
    if not valid_id(receipt_id):
        return None, {"error": "invalid receipt_id",
                       "expect": "receipt id from a receipt_submit pending response"}
    try:
        base = receipt_dir().resolve()
    except FileNotFoundError:
        return None, {"error": "unknown receipt", "receipt_id": receipt_id}
    path = (receipt_dir() / (receipt_id + ".json")).resolve()
    if path.parent != base:
        return None, {"error": "invalid receipt_id",
                       "expect": "receipt id from a receipt_submit pending response"}
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None, {"error": "unknown receipt", "receipt_id": receipt_id}
    except (OSError, ValueError) as exc:
        return None, {"error": "cannot read receipt", "detail": str(exc)}
    if not isinstance(record, dict) or record.get("receipt_id") != receipt_id:
        return None, {"error": "unknown receipt", "receipt_id": receipt_id}
    return record, None


def _receipt_worker(receipt_id, tool, args):
    """Detached continuation of a receipt_submit: runs the target tool with
    the receipt background budget and records the terminal result."""
    _run_timeout.s = RECEIPT_TIMEOUT_S
    try:
        _, _, func = TOOLS[tool]
        payload, is_error = func(args)
    except Exception as exc:  # never leave a receipt stuck running
        payload, is_error = {"error": "tool crashed", "detail": str(exc)}, True
    record, err = read_receipt(receipt_id)
    if err or record is None:
        return
    record.update({
        "status": "failed" if is_error else "done",
        "finished": utc_now(),
        ("error_record" if is_error else "result"): payload,
    })
    try:
        write_receipt(record)
    except OSError:
        pass


def owned_call(argv, label):
    proc, err = run_script(argv)
    if err:
        return err, True
    out, out_trunc = truncate(proc.stdout or "")
    err_out, err_trunc = truncate(proc.stderr or "")
    if proc.returncode != 0:
        return {
            "error": label,
            "exit": proc.returncode,
            "stdout": out,
            "stderr": err_out,
        }, True
    return {
        "ok": True,
        "stdout": out,
        "stdout_truncated": out_trunc,
        "stderr": err_out,
        "stderr_truncated": err_trunc,
    }, False


def tool_fleet_snapshot(_args):
    proc, err = run_script([BIN / "fm-fleet-snapshot.sh", "--json"])
    if err:
        return err, True
    if proc.returncode != 0:
        out, _ = truncate(proc.stderr or proc.stdout)
        return {"error": "snapshot failed", "exit": proc.returncode, "output": out}, True
    if len(proc.stdout.encode("utf-8", "replace")) > MAX_OUTPUT_BYTES:
        return {"error": "snapshot too large for PoC envelope"}, True
    try:
        snapshot = json.loads(proc.stdout)
    except json.JSONDecodeError:
        out, _ = truncate(proc.stdout)
        return {"error": "snapshot was not JSON", "output": out}, True
    if snapshot.get("schema") != SNAPSHOT_SCHEMA:
        return {"error": "unexpected snapshot schema", "schema": snapshot.get("schema")}, True
    return snapshot, False


def tool_backlog(_args):
    snapshot, is_error = tool_fleet_snapshot({})
    if is_error:
        return snapshot, True
    by_state = {}
    for task in snapshot.get("tasks", []):
        state = ((task.get("current_state") or {}).get("state")) or "unknown"
        by_state[state] = by_state.get(state, 0) + 1
    return {
        "generated": snapshot.get("generated"),
        "backlog": snapshot.get("backlog", {}),
        "task_counts": {"total": len(snapshot.get("tasks", [])), "by_state": by_state},
    }, False


def tool_crew_state(args):
    task_id = args.get("id")
    if not valid_id(task_id):
        return {"error": "invalid id", "expect": "short task id, no slashes or traversal"}, True
    proc, err = run_script([BIN / "fm-crew-state.sh", task_id])
    if err:
        return err, True
    raw = (proc.stdout or "").strip().splitlines()
    line = raw[0] if raw else ""
    parsed = {"state": "unknown", "source": "none", "detail": line}
    match = re.match(r"state:\s*(\S+)\s+·\s*source:\s*(\S+)\s+·\s*(.*)", line)
    if match:
        parsed = {"state": match.group(1), "source": match.group(2), "detail": match.group(3)}
    return {"id": task_id, "current": parsed, "raw": line}, False


def tool_status_tail(args):
    task_id = args.get("id")
    if not valid_id(task_id):
        return {"error": "invalid id", "expect": "short task id, no slashes or traversal"}, True
    try:
        lines = int(args.get("lines", 10))
    except (TypeError, ValueError):
        return {"error": "invalid lines", "expect": "integer 1..50"}, True
    lines = max(1, min(50, lines))
    path = (state_dir() / f"{task_id}.status").resolve()
    try:
        state_resolved = state_dir().resolve()
    except FileNotFoundError:
        return {"error": "no status log for id", "id": task_id}, True
    if path.parent != state_resolved:
        return {"error": "invalid id", "expect": "short task id, no slashes or traversal"}, True
    try:
        content = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except FileNotFoundError:
        return {"error": "no status log for id", "id": task_id}, True
    except OSError as exc:
        return {"error": "cannot read status log", "detail": str(exc)}, True
    return {
        "id": task_id,
        "events": content[-lines:],
        "warning": "wake-event history only, never current state; use crew_state for current state",
    }, False


def tool_send_message(args):
    target = args.get("target")
    text = args.get("text")
    if not valid_id(target):
        return {"error": "invalid target", "expect": "exact task id, no slashes or traversal"}, True
    if not isinstance(text, str) or not 1 <= len(text) <= SEND_TEXT_MAX_CHARS:
        return {
            "error": "invalid text",
            "expect": f"single line, 1..{SEND_TEXT_MAX_CHARS} chars",
        }, True
    if "\n" in text or "\r" in text:
        return {"error": "invalid text", "expect": "single line, no newlines"}, True
    if text.lstrip().startswith("/"):
        return {"error": "slash commands refused", "expect": "plain prose steer only"}, True
    proc, err = run_script([BIN / "fm-send.sh", target, text])
    if err:
        return err, True
    out, out_trunc = truncate(proc.stdout or "")
    err_out, err_trunc = truncate(proc.stderr or "")
    if proc.returncode != 0:
        return {
            "error": "steer refused or failed",
            "target": target,
            "exit": proc.returncode,
            "stdout": out,
            "stderr": err_out,
        }, True
    return {
        "delivered": True,
        "target": target,
        "note": "verified submit per fm-send contract; delivery is not reply",
        "stdout": out,
        "stdout_truncated": out_trunc,
        "stderr_truncated": err_trunc,
    }, False


def lifecycle_tool(args, verb, needs_note):
    task_id = args.get("id")
    if not valid_id(task_id):
        return {"error": "invalid id", "expect": "short task id, no slashes or traversal"}, True
    if not valid_approval(args.get("approval")):
        return approval_error(), True
    argv = [BIN / "fm-control.sh", task_id, verb]
    if needs_note:
        note = args.get("note")
        if not valid_note(note):
            return {"error": "invalid note", "expect": "single line, 1..500 chars"}, True
        argv += ["--note", note]
    payload, is_error = owned_call(argv, f"{verb} refused or failed")
    if not is_error:
        payload = dict(payload)
        payload.update({"verb": verb, "id": task_id})
    return payload, is_error


def tool_lifecycle_interrupt(args):
    return lifecycle_tool(args, "interrupt", False)


def tool_lifecycle_exit(args):
    return lifecycle_tool(args, "exit", False)


def tool_lifecycle_relaunch(args):
    return lifecycle_tool(args, "relaunch", True)


def tool_lifecycle_suspend(args):
    return lifecycle_tool(args, "suspend", True)


def tool_lifecycle_resume(args):
    return lifecycle_tool(args, "resume", True)


def tool_spawn_crew(args):
    task_id = args.get("task_id")
    project = args.get("project")
    mode = args.get("mode")
    yolo = args.get("yolo")
    if not valid_id(task_id):
        return {"error": "invalid task_id", "expect": "short task id, no slashes or traversal"}, True
    if not valid_project(project):
        return {"error": "invalid project", "expect": "bare name or projects/<name>, no absolute paths or traversal"}, True
    if mode not in MODES:
        return {"error": "invalid mode", "expect": "one of no-mistakes, direct-PR, local-only"}, True
    if yolo not in ("on", "off"):
        return {"error": "invalid yolo", "expect": "one of on, off"}, True
    if not valid_approval(args.get("approval")):
        return approval_error(), True
    payload, is_error = owned_call(
        [BIN / "fm-spawn.sh", task_id, project, "--mode", mode, "--yolo", yolo],
        "spawn refused or failed",
    )
    if not is_error:
        payload = dict(payload)
        payload.update({"task_id": task_id, "project": project, "mode": mode})
    return payload, is_error


def tool_scaffold_brief(args):
    task_id = args.get("task_id")
    project = args.get("project")
    mode = args.get("mode")
    if not valid_id(task_id):
        return {"error": "invalid task_id", "expect": "short task id, no slashes or traversal"}, True
    if not valid_project(project):
        return {"error": "invalid project", "expect": "bare name or projects/<name>, no absolute paths or traversal"}, True
    if mode not in BRIEF_MODES:
        return {"error": "invalid mode", "expect": "one of no-mistakes, direct-PR, local-only, scout"}, True
    if not valid_approval(args.get("approval")):
        return approval_error(), True
    argv = [BIN / "fm-brief.sh", task_id, project]
    argv += ["--scout"] if mode == "scout" else ["--mode", mode]
    payload, is_error = owned_call(argv, "brief refused or failed")
    if not is_error:
        payload = dict(payload)
        payload.update({"task_id": task_id, "project": project, "mode": mode})
    return payload, is_error


def tool_decision_hold(args):
    origin_id = args.get("origin_id")
    decision_key = args.get("decision_key")
    title = args.get("title")
    reason = args.get("reason")
    if not valid_id(origin_id):
        return {"error": "invalid origin_id", "expect": "short task id, no slashes or traversal"}, True
    if not valid_id(decision_key):
        return {"error": "invalid decision_key", "expect": "short slug, no slashes or traversal"}, True
    if not valid_note(title, 200):
        return {"error": "invalid title", "expect": "single line, 1..200 chars"}, True
    if not valid_note(reason, 1000):
        return {"error": "invalid reason", "expect": "single line, 1..1000 chars"}, True
    if not valid_approval(args.get("approval")):
        return approval_error(), True
    payload, is_error = owned_call(
        [BIN / "fm-decision-hold.sh", "hold", origin_id, decision_key,
         "--title", title, "--reason", reason],
        "decision hold refused or failed",
    )
    if not is_error:
        payload = dict(payload)
        payload.update({"origin_id": origin_id, "decision_key": decision_key})
    return payload, is_error


def tool_decision_resolve(args):
    origin_id = args.get("origin_id")
    decision_key = args.get("decision_key")
    routed_to = args.get("routed_to")
    decision_text = args.get("decision_text")
    if not valid_id(origin_id):
        return {"error": "invalid origin_id", "expect": "short task id, no slashes or traversal"}, True
    if not valid_id(decision_key):
        return {"error": "invalid decision_key", "expect": "short slug, no slashes or traversal"}, True
    if not valid_id(routed_to):
        return {"error": "invalid routed_to", "expect": "short task id, no slashes or traversal"}, True
    if not isinstance(decision_text, str) or not 1 <= len(decision_text) <= 2000:
        return {"error": "invalid decision_text", "expect": "1..2000 chars"}, True
    if not valid_approval(args.get("approval")):
        return approval_error(), True
    tmp = None
    try:
        with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as handle:
            handle.write(decision_text)
            tmp = handle.name
        payload, is_error = owned_call(
            [BIN / "fm-decision-hold.sh", "resolve", origin_id, decision_key,
             "--decision-file", tmp, "--routed-to", routed_to],
            "decision resolve refused or failed",
        )
    finally:
        if tmp:
            try:
                os.unlink(tmp)
            except OSError:
                pass
    if not is_error:
        payload = dict(payload)
        payload.update({"origin_id": origin_id, "decision_key": decision_key})
    return payload, is_error


def tool_review_decision(args):
    task_id = args.get("id")
    verdict = args.get("verdict")
    comment = args.get("comment", "")
    if not valid_id(task_id):
        return {"error": "invalid id", "expect": "short task id, no slashes or traversal"}, True
    if verdict not in VERDICTS:
        return {"error": "invalid verdict", "expect": "one of approve, decline, comment"}, True
    if verdict == "comment" and not (isinstance(comment, str) and comment.strip()):
        return {"error": "comment verdict requires comment text", "expect": "single line, 1..500 chars"}, True
    if comment and not valid_note(comment):
        return {"error": "invalid comment", "expect": "single line, 1..500 chars"}, True
    if not valid_approval(args.get("approval")):
        return approval_error(), True
    if isinstance(comment, str) and comment.strip():
        decision_text = "%s - %s" % (verdict, comment)
    else:
        decision_text = verdict
    tmp = None
    try:
        with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as handle:
            handle.write(decision_text)
            tmp = handle.name
        payload, is_error = owned_call(
            [BIN / "fm-captain-hold.sh", "answer", task_id,
             "--decision-file", tmp],
            "review decision refused or failed",
        )
    finally:
        if tmp:
            try:
                os.unlink(tmp)
            except OSError:
                pass
    if not is_error:
        payload = dict(payload)
        payload.update({"id": task_id, "verdict": verdict})
    return payload, is_error


def tool_relay_reply(args):
    request_id = args.get("request_id")
    text = args.get("text")
    if not valid_id(request_id):
        return {"error": "invalid request_id", "expect": "short slug, no slashes or traversal"}, True
    if not isinstance(text, str) or not 1 <= len(text) <= 2000:
        return {"error": "invalid text", "expect": "1..2000 chars"}, True
    if not valid_approval(args.get("approval")):
        return approval_error(), True
    payload, is_error = owned_call(
        [BIN / "fm-x-reply.sh", request_id, text],
        "relay reply refused or failed",
    )
    if not is_error:
        payload = dict(payload)
        payload.update({"request_id": request_id})
    return payload, is_error


def tool_relay_dismiss(args):
    request_id = args.get("request_id")
    if not valid_id(request_id):
        return {"error": "invalid request_id", "expect": "short slug, no slashes or traversal"}, True
    if not valid_approval(args.get("approval")):
        return approval_error(), True
    payload, is_error = owned_call(
        [BIN / "fm-x-dismiss.sh", request_id],
        "relay dismiss refused or failed",
    )
    if not is_error:
        payload = dict(payload)
        payload.update({"request_id": request_id})
    return payload, is_error


def tool_relay_followup(args):
    task_id = args.get("task_id")
    text = args.get("text")
    final = args.get("final", False)
    if not valid_id(task_id):
        return {"error": "invalid task_id", "expect": "short task id, no slashes or traversal"}, True
    if not isinstance(text, str) or not 1 <= len(text) <= 2000:
        return {"error": "invalid text", "expect": "1..2000 chars"}, True
    if not isinstance(final, bool):
        return {"error": "invalid final", "expect": "boolean"}, True
    if not valid_approval(args.get("approval")):
        return approval_error(), True
    tmp = None
    try:
        with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as handle:
            handle.write(text)
            tmp = handle.name
        argv = [BIN / "fm-x-followup.sh", task_id, "--text-file", tmp]
        if final:
            argv.append("--final")
        payload, is_error = owned_call(argv, "relay followup refused or failed")
    finally:
        if tmp:
            try:
                os.unlink(tmp)
            except OSError:
                pass
    if not is_error:
        payload = dict(payload)
        payload.update({"task_id": task_id})
    return payload, is_error


def tool_fleet_poll(args):
    try:
        count = int(args.get("count", 2))
    except (TypeError, ValueError):
        return {"error": "invalid count", "expect": "integer 1..3"}, True
    try:
        interval_s = float(args.get("interval_s", 0))
    except (TypeError, ValueError):
        return {"error": "invalid interval_s", "expect": "number 0..2"}, True
    count = max(1, min(3, count))
    interval_s = max(0.0, min(2.0, interval_s))
    polls = []
    for _ in range(count):
        snapshot, is_error = tool_fleet_snapshot({})
        if is_error:
            return snapshot, True
        polls.append({
            "generated": snapshot.get("generated"),
            "tasks": len(snapshot.get("tasks", [])),
        })
        if interval_s > 0:
            time.sleep(interval_s)
    payload = {
        "polls": polls,
        "warning": "polling convenience only; fleet_snapshot stays canonical",
    }
    if len(json.dumps(payload).encode("utf-8", "replace")) > MAX_OUTPUT_BYTES:
        return {
            "error": "poll output too large for PoC envelope",
            "polls": len(polls),
        }, True
    return payload, False


def tool_peek(args):
    target = args.get("target")
    if not valid_id(target):
        return {"error": "invalid target", "expect": "exact task id, no slashes or traversal"}, True
    try:
        lines = int(args.get("lines", 40))
    except (TypeError, ValueError):
        return {"error": "invalid lines", "expect": "integer 1..100"}, True
    lines = max(1, min(100, lines))
    payload, is_error = owned_call(
        [BIN / "fm-peek.sh", target, str(lines)],
        "peek failed",
    )
    if not is_error:
        payload = dict(payload)
        payload.update({"target": target, "lines": lines})
    return payload, is_error


def tool_fleet_view(_args):
    return owned_call([BIN / "fm-fleet-view.sh"], "fleet view failed")


def tool_review_diff(args):
    task_id = args.get("id")
    if not valid_id(task_id):
        return {"error": "invalid id", "expect": "short task id, no slashes or traversal"}, True
    stat = args.get("stat", False)
    if not isinstance(stat, bool):
        return {"error": "invalid stat", "expect": "boolean"}, True
    argv = [BIN / "fm-review-diff.sh", task_id]
    if stat:
        argv.append("--stat")
    payload, is_error = owned_call(argv, "review diff failed")
    if not is_error:
        payload = dict(payload)
        payload.update({"id": task_id, "stat": stat})
    return payload, is_error


def tool_bearings_snapshot(_args):
    proc, err = run_script([BIN / "fm-bearings-snapshot.sh", "--json"])
    if err:
        return err, True
    if proc.returncode != 0:
        out, _ = truncate(proc.stderr or proc.stdout or "")
        return {"error": "bearings failed", "exit": proc.returncode, "output": out}, True
    if len(proc.stdout.encode("utf-8", "replace")) > MAX_OUTPUT_BYTES:
        return {"error": "bearings too large for envelope"}, True
    try:
        projection = json.loads(proc.stdout)
    except json.JSONDecodeError:
        out, _ = truncate(proc.stdout)
        return {"error": "bearings was not JSON", "output": out}, True
    if projection.get("schema") != BEARINGS_SCHEMA:
        return {"error": "unexpected bearings schema", "schema": projection.get("schema")}, True
    return projection, False


def tool_wake_drain(_args):
    return owned_call([BIN / "fm-wake-drain.sh"], "wake drain failed")


def tool_guard_check(_args):
    prev = os.environ.get("FM_GUARD_READ_ONLY")
    os.environ["FM_GUARD_READ_ONLY"] = "1"
    try:
        return owned_call([BIN / "fm-guard.sh"], "guard check failed")
    finally:
        if prev is None:
            os.environ.pop("FM_GUARD_READ_ONLY", None)
        else:
            os.environ["FM_GUARD_READ_ONLY"] = prev


def tool_remote_doctor(_args):
    # Check mode only: the --fix repair path stays out of scope.
    return owned_call([BIN / "fm-remote-doctor.sh"], "doctor failed")


def tool_remote_file(args):
    relpath = args.get("path")
    if not valid_relpath(relpath):
        return {"error": "invalid path",
                "expect": "relative path under the home, no traversal"}, True
    max_bytes = valid_remote_max_bytes(args.get("max_bytes", REMOTE_FILE_DEFAULT_MAX_BYTES))
    if max_bytes is None:
        return {"error": "invalid max_bytes",
                "expect": "integer 1..262144"}, True
    payload, is_error = owned_call(
        [BIN / "fm-remote-file.sh", "get", relpath, str(max_bytes)],
        "remote file read failed",
    )
    if not is_error:
        payload = dict(payload)
        payload.update({"path": relpath, "max_bytes": max_bytes})
    return payload, is_error


def tool_remote_delta(args):
    rel_log = args.get("log")
    if not valid_relpath(rel_log):
        return {"error": "invalid path",
                "expect": "relative log path under the home, no traversal"}, True
    offset = valid_nonneg_int(args.get("offset", 0))
    if offset is None:
        return {"error": "invalid offset",
                "expect": "nonnegative integer byte cursor"}, True
    sha = args.get("sha256")
    if not valid_sha256(sha):
        return {"error": "invalid sha256",
                "expect": "64 hex chars of the exact prefix"}, True
    wait = valid_delta_wait(args.get("wait", 0))
    if wait is None:
        return {"error": "invalid wait",
                "expect": "integer 0..10 seconds"}, True
    payload, is_error = owned_call(
        [BIN / "fm-remote-delta-read.sh", rel_log, str(offset), sha, str(wait)],
        "remote delta read failed",
    )
    if not is_error:
        payload = dict(payload)
        payload.update({"log": rel_log, "offset": offset})
    return payload, is_error


def tool_handoff_status(args):
    task_id = args.get("id")
    if task_id is not None and not valid_id(task_id):
        return {"error": "invalid id",
                "expect": "short task id, no slashes or traversal"}, True
    lines = valid_handoff_lines(args.get("lines", HANDOFF_DEFAULT_LINES))
    if lines is None:
        return {"error": "invalid lines", "expect": "integer 1..20"}, True
    handoff = data_dir() / "handoff"
    if task_id is None:
        try:
            names = sorted(p.name for p in handoff.iterdir()
                           if p.is_file() and not p.is_symlink()
                           and p.name.endswith(".outbox.md"))
        except FileNotFoundError:
            return {"outboxes": []}, False
        except OSError as exc:
            return {"error": "cannot read handoff", "detail": str(exc)}, True
        outboxes = []
        for name in names:
            try:
                text = (handoff / name).read_text(
                    encoding="utf-8", errors="replace").splitlines()
                size = (handoff / name).stat().st_size
            except OSError as exc:
                return {"error": "cannot read handoff", "detail": str(exc)}, True
            outboxes.append({
                "id": name[: -len(".outbox.md")],
                "bytes": size,
                "total_lines": len(text),
            })
        return {"outboxes": outboxes}, False
    path = confine_handoff_path(data_dir(), task_id)
    if path is None:
        return {"error": "invalid id",
                "expect": "short task id, no slashes or traversal"}, True
    try:
        content = path.read_text(encoding="utf-8", errors="replace").splitlines()
        size = path.stat().st_size
    except FileNotFoundError:
        return {"error": "no handoff for id", "id": task_id}, True
    except OSError as exc:
        return {"error": "cannot read handoff", "detail": str(exc)}, True
    return {"id": task_id, "bytes": size, "total_lines": len(content),
            "lines": content[-lines:]}, False


def tool_secondmate_nudge(args):
    # Notify-only subset: the backstop asks mismatched secondmates to
    # reconcile through the cooldown-guarded notify path.
    if not valid_approval(args.get("approval")):
        return approval_error(), True
    return owned_call([BIN / "fm-secondmate-reconcile.sh", "notify"],
                      "reconcile notify refused or failed")


def tool_secondmate_restart(args):
    ids = valid_id_list(args.get("ids"), RESTART_IDS_MAX)
    if ids is None:
        return {"error": "invalid id",
                "expect": "1..8 secondmate ids, no slashes or traversal"}, True
    if not valid_approval(args.get("approval")):
        return approval_error(), True
    payload, is_error = owned_call(
        [BIN / "fm-secondmate-restart.sh", *ids],
        "secondmate restart refused or failed",
    )
    if not is_error:
        payload = dict(payload)
        payload.update({"ids": ids})
    return payload, is_error


def tool_secondmate_report(args):
    verb = args.get("verb")
    if not valid_id(verb):
        return {"error": "invalid verb",
                "expect": "short slug, no slashes or traversal"}, True
    corr = args.get("corr")
    if not valid_corr(corr):
        return {"error": "invalid corr",
                "expect": "16 hex chars, optional corr= prefix"}, True
    note = args.get("note")
    if not valid_note(note):
        return {"error": "invalid note",
                "expect": "single line, 1..500 chars"}, True
    if not valid_approval(args.get("approval")):
        return approval_error(), True
    # Note-only form: --doc stays out, and the helper resolves the parent
    # channel itself, so no status path ever crosses this boundary.
    payload, is_error = owned_call(
        [BIN / "fm-secondmate-report.sh", verb, corr, note],
        "secondmate report refused or failed",
    )
    if not is_error:
        payload = dict(payload)
        payload.update({"verb": verb, "corr": corr})
    return payload, is_error


def tool_remote_control(args):
    verb = args.get("verb")
    if verb not in REMOTE_CONTROL_VERBS:
        return {"error": "invalid verb",
                "expect": "one of state, route, observe, send"}, True
    task_id = args.get("id")
    if not valid_id(task_id):
        return {"error": "invalid id",
                "expect": "short task id, no slashes or traversal"}, True
    if not valid_approval(args.get("approval")):
        return approval_error(), True
    argv = [BIN / "fm-remote-secondmate-control.sh", verb, task_id]
    if verb == "send":
        text = args.get("text")
        if not isinstance(text, str) or not 1 <= len(text) <= SEND_TEXT_MAX_CHARS:
            return {"error": "invalid text",
                    "expect": f"single line, 1..{SEND_TEXT_MAX_CHARS} chars"}, True
        if "\n" in text or "\r" in text:
            return {"error": "invalid text",
                    "expect": "single line, no newlines"}, True
        if text.lstrip().startswith("/"):
            return {"error": "slash commands refused",
                    "expect": "plain prose steer only"}, True
        argv.append(text)
    # Closed verb subset: launch/relaunch (firstmate-owned provisioning),
    # key/capture (raw pane access), and sync/update/retire (remote code
    # and pane teardown) stay out.
    payload, is_error = owned_call(argv, "remote control refused or failed")
    if not is_error:
        payload = dict(payload)
        payload.update({"verb": verb, "id": task_id})
    return payload, is_error


def tool_handoff_move(args):
    task_id = args.get("id")
    if not valid_id(task_id):
        return {"error": "invalid id",
                "expect": "short task id, no slashes or traversal"}, True
    resume = args.get("resume", False)
    if not isinstance(resume, bool):
        return {"error": "invalid resume", "expect": "boolean"}, True
    if not valid_approval(args.get("approval")):
        return approval_error(), True
    if resume:
        keys = args.get("keys", [])
        if keys not in ([], None):
            return {"error": "invalid keys",
                    "expect": "resume takes no keys"}, True
        payload, is_error = owned_call(
            [BIN / "fm-backlog-handoff.sh", "--resume-pending"],
            "handoff refused or failed",
        )
        if not is_error:
            payload = dict(payload)
            payload.update({"id": task_id, "resumed": True})
        return payload, is_error
    keys = valid_id_list(args.get("keys"), HANDOFF_KEYS_MAX)
    if keys is None:
        return {"error": "invalid keys",
                "expect": "1..20 backlog item keys, no slashes or traversal"}, True
    payload, is_error = owned_call(
        [BIN / "fm-backlog-handoff.sh", task_id, *keys],
        "handoff refused or failed",
    )
    if not is_error:
        payload = dict(payload)
        payload.update({"id": task_id, "keys": keys})
    return payload, is_error
def tool_harness_detect(args):
    mode = args.get("mode", "own")
    if mode not in HARNESS_MODES:
        return {
            "error": "invalid mode",
            "expect": "one of own, crew, secondmate, secondmate-model, secondmate-effort",
        }, True
    argv = [BIN / "fm-harness.sh"]
    if mode != "own":
        argv.append(mode)
    payload, is_error = owned_call(argv, "harness detection failed")
    if not is_error:
        payload = dict(payload)
        first = (payload.get("stdout") or "").strip().splitlines()
        payload.update({"mode": mode, "harness": first[0] if first else ""})
    return payload, is_error


def tool_project_mode(args):
    project = args.get("project")
    if not valid_project(project):
        return {
            "error": "invalid project",
            "expect": "bare name or projects/<name>, no absolute paths or traversal",
        }, True
    # Mapped "<mode> <yolo>" only: --raw stays out (raw-pane access is a
    # denied argv flag), so conditional policies resolve to their most
    # rigorous leg exactly as the owning script maps them.
    payload, is_error = owned_call(
        [BIN / "fm-project-mode.sh", project],
        "project mode refused or failed",
    )
    if not is_error:
        payload = dict(payload)
        tokens = (payload.get("stdout") or "").strip().split()
        if len(tokens) == 2:
            mode, yolo = tokens
        else:
            mode, yolo = None, None
        payload.update({"project": project, "mode": mode, "yolo": yolo})
    return payload, is_error


def tool_lock_status(_args):
    # Status only: acquiring the per-home lock via MCP would steal
    # firstmate's own session lock, so only the read is mirrored.
    payload, is_error = owned_call([BIN / "fm-lock.sh", "status"], "lock status failed")
    if not is_error:
        payload = dict(payload)
        line = ((payload.get("stdout") or "").strip().splitlines() or [""])[0]
        status = "unknown"
        if line == "lock: free":
            status = "free"
        elif line.startswith("lock: held"):
            status = "held"
        elif line.startswith("lock: stale"):
            status = "stale"
        elif line.startswith("lock: unreadable"):
            status = "unreadable"
        payload.update({"status": status, "raw": line})
    return payload, is_error


def tool_lease_check(args):
    task_id = args.get("id")
    if not valid_id(task_id):
        return {"error": "invalid id", "expect": "short task id, no slashes or traversal"}, True
    # Check only: claim/release/release-actor/sweep are guarded by the
    # supervision-actor contract (main vs branch), which an MCP call cannot
    # name, so only the read is mirrored. Exit 1 with empty stdout is the
    # script's defined unleased outcome, not a failure.
    proc, err = run_script([BIN / "fm-lease.sh", "check", task_id])
    if err:
        return err, True
    out, out_trunc = truncate(proc.stdout or "")
    err_out, err_trunc = truncate(proc.stderr or "")
    if proc.returncode == 0:
        line = out.strip().splitlines()
        holder = line[0] if line else ""
        record = {"task_id": task_id, "leased": True, "holder": holder}
        parts = holder.split()
        if len(parts) == 4:
            actor, pid, epoch, live = parts
            # Digit-strict on both implementations (py + ts): anything
            # else projects to null rather than guessing at number formats.
            pid_num = int(pid) if pid.isascii() and pid.isdigit() else None
            epoch_num = int(epoch) if epoch.isascii() and epoch.isdigit() else None
            record.update({
                "actor": actor,
                "pid": pid_num,
                "epoch": epoch_num,
                "live": live == "live",
            })
        record.update({"stdout_truncated": out_trunc, "stderr_truncated": err_trunc})
        return record, False
    if proc.returncode == 1 and not out.strip():
        return {"task_id": task_id, "leased": False}, False
    return {
        "error": "lease check failed",
        "exit": proc.returncode,
        "stdout": out,
        "stderr": err_out,
    }, True


def tool_bearings_board_path(_args):
    # Path only: build validates a payload, proves a live lavish session,
    # and binds the keyed-answer intake — interactive captain surface that
    # stays firstmate/agent-owned.
    payload, is_error = owned_call(
        [BIN / "fm-bearings-board.sh", "path"],
        "bearings board path failed",
    )
    if not is_error:
        payload = dict(payload)
        payload.update({"path": (payload.get("stdout") or "").strip()})
    return payload, is_error


def tool_inbox_status(_args):
    # Status only: durable-records read, no network, appends no wake.
    return owned_call([BIN / "fm-inbox.sh", "status"], "inbox status failed")


def tool_inbox_list(_args):
    # List only: note/say queue wakes or call Bedrock; drain --ack moves
    # records. All of those stay out.
    return owned_call([BIN / "fm-inbox.sh", "list"], "inbox list failed")


def tool_home_summary(_args):
    # Native bounded read of the published ledger (same shape as
    # status_tail): the refresh itself is firstmate-owned plumbing
    # (session start, watcher, spawn, teardown call it --best-effort).
    try:
        state_resolved = state_dir().resolve()
    except FileNotFoundError:
        return {"error": "no home summary", "expect": "published state/home-summary.json in the served home"}, True
    path = (state_resolved / "home-summary.json").resolve()
    if path.parent != state_resolved:
        return {"error": "no home summary", "expect": "published state/home-summary.json in the served home"}, True
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return {"error": "no home summary", "expect": "published state/home-summary.json in the served home"}, True
    except OSError as exc:
        return {"error": "cannot read home summary", "detail": str(exc)}, True
    if len(raw) > MAX_OUTPUT_BYTES:
        return {"error": "home summary too large for envelope"}, True
    try:
        summary = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        out, _ = truncate(raw.decode("utf-8", "replace"))
        return {"error": "home summary was not JSON", "output": out}, True
    if not isinstance(summary, dict) or summary.get("schema") != HOME_SUMMARY_SCHEMA:
        schema = summary.get("schema") if isinstance(summary, dict) else None
        return {"error": "unexpected home summary schema", "schema": schema}, True
    return summary, False


def tool_contributions_snapshot(args):
    want_all = args.get("all", False)
    if not isinstance(want_all, bool):
        return {"error": "invalid all", "expect": "boolean"}, True
    # Snapshot + pending only: poll spends forge reads over the network
    # and verdict/ack/arm mutate the saved records, so all stay out.
    # Same two-step the fleet snapshot itself runs: contribution-input
    # staged to a temp file, then the read-only snapshot over it.
    proc, err = run_script([BIN / "fm-fleet-snapshot.sh", "--contribution-input"])
    if err:
        return err, True
    if proc.returncode != 0:
        out, _ = truncate(proc.stderr or proc.stdout or "")
        return {"error": "contribution input failed", "exit": proc.returncode, "output": out}, True
    if len(proc.stdout.encode("utf-8", "replace")) > MAX_OUTPUT_BYTES:
        return {"error": "contribution input failed", "detail": "contribution input too large for envelope"}, True
    tmp = None
    try:
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            handle.write(proc.stdout)
            tmp = handle.name
        argv = [BIN / "fm-contributions.sh", "snapshot", tmp]
        if want_all:
            argv.append("--all")
        proj, err = run_script(argv)
        if err:
            return err, True
        if proj.returncode != 0:
            out, _ = truncate(proj.stderr or proj.stdout or "")
            return {"error": "contributions snapshot failed", "exit": proj.returncode, "output": out}, True
        if len(proj.stdout.encode("utf-8", "replace")) > MAX_OUTPUT_BYTES:
            return {"error": "contributions too large for envelope"}, True
        try:
            projection = json.loads(proj.stdout)
        except json.JSONDecodeError:
            out, _ = truncate(proj.stdout)
            return {"error": "contributions was not JSON", "output": out}, True
        if not isinstance(projection, dict):
            out, _ = truncate(proj.stdout)
            return {"error": "contributions was not JSON", "output": out}, True
    finally:
        if tmp:
            try:
                os.unlink(tmp)
            except OSError:
                pass
    projection = dict(projection)
    projection["all"] = want_all
    return projection, False


def tool_contributions_pending(_args):
    proc, err = run_script([BIN / "fm-contributions.sh", "pending"])
    if err:
        return err, True
    if proc.returncode != 0:
        out, _ = truncate(proc.stderr or proc.stdout or "")
        return {"error": "contributions pending failed", "exit": proc.returncode, "output": out}, True
    if len(proc.stdout.encode("utf-8", "replace")) > MAX_OUTPUT_BYTES:
        return {"error": "contributions too large for envelope"}, True
    try:
        pending = json.loads(proc.stdout)
    except json.JSONDecodeError:
        out, _ = truncate(proc.stdout)
        return {"error": "contributions pending was not JSON", "output": out}, True
    if not isinstance(pending, list):
        out, _ = truncate(proc.stdout)
        return {"error": "contributions pending was not JSON", "output": out}, True
    return {"pending": pending}, False


# Tools whose schemas carry a required per-call approval string. A
# receipt_submit for one of these targets only schedules when the nested
# arguments carry a valid approval; open tools submit freely.
NEEDS_APPROVAL = frozenset({
    "lifecycle_interrupt", "lifecycle_exit", "lifecycle_relaunch",
    "lifecycle_suspend", "lifecycle_resume", "spawn_crew",
    "scaffold_brief", "decision_hold", "decision_resolve",
    "review_decision", "relay_reply", "relay_dismiss", "relay_followup",
    "secondmate_nudge", "secondmate_restart", "secondmate_report",
    "remote_control", "handoff_move",
})


def tool_receipt_submit(args):
    target = args.get("tool")
    nested = args.get("arguments")
    if not isinstance(target, str) or not target:
        return {"error": "invalid tool", "expect": "name of a known tool"}, True
    if not isinstance(nested, dict):
        return {"error": "invalid arguments", "expect": "object of arguments for the named tool"}, True
    if target not in TOOLS or target in ("receipt_submit",):
        return {"error": "unknown tool", "tool": target}, True
    if target in NEEDS_APPROVAL and not valid_approval(nested.get("approval")):
        return approval_error(), True
    receipt_id = new_receipt_id()
    created = time.time()
    record = {
        "receipt_id": receipt_id,
        "tool": target,
        "status": "running",
        "created": utc_now(),
        "created_epoch": created,
        "ttl_s": RECEIPT_TTL_S,
        "note": "long call detached; poll receipt_status for running/done/failed",
    }
    try:
        if not write_receipt(record):
            return {"error": "cannot record receipt"}, True
    except OSError as exc:
        return {"error": "cannot record receipt", "detail": str(exc)}, True
    worker = threading.Thread(target=_receipt_worker, args=(receipt_id, target, nested), daemon=True)
    worker.start()
    return {
        "status": "pending",
        "receipt_id": receipt_id,
        "tool": target,
        "check": {"tool": "receipt_status", "arguments": {"receipt_id": receipt_id}},
        "ttl_s": RECEIPT_TTL_S,
        "note": "call detached past the 30s budget; check receipt_status for the result",
    }, False


def tool_receipt_status(args):
    receipt_id = args.get("receipt_id")
    record, err = read_receipt(receipt_id)
    if err or record is None:
        return err, True
    try:
        age = time.time() - float(record.get("created_epoch", 0))
    except (TypeError, ValueError):
        age = RECEIPT_TTL_S + 1
    ttl = record.get("ttl_s", RECEIPT_TTL_S)
    if age > ttl:
        try:
            (receipt_dir() / (record["receipt_id"] + ".json")).unlink(missing_ok=True)
        except OSError:
            pass
        return {"error": "receipt expired", "receipt_id": record["receipt_id"], "ttl_s": ttl}, True
    return record, False


def approval_schema(extra):
    props = dict(extra)
    props["approval"] = {
        "type": "string",
        "description": "Explicit authorization starting with 'I authorize'",
    }
    return {"type": "object", "properties": props, "required": [*extra.keys(), "approval"], "additionalProperties": False}


def id_approval_schema(id_field="id"):
    return approval_schema({id_field: {"type": "string", "description": "Task id"}})


TOOLS = {
    "fleet_snapshot": (
        "Read-only canonical fleet snapshot (backlog plus per-task state).",
        {"type": "object", "properties": {}, "additionalProperties": False},
        tool_fleet_snapshot,
    ),
    "backlog": (
        "Read-only backlog records plus per-state task counts, derived from the fleet snapshot.",
        {"type": "object", "properties": {}, "additionalProperties": False},
        tool_backlog,
    ),
    "crew_state": (
        "Read-only deterministic current state of one crew; never infer state from the status log tail.",
        {
            "type": "object",
            "properties": {"id": {"type": "string", "description": "Task id"}},
            "required": ["id"],
            "additionalProperties": False,
        },
        tool_crew_state,
    ),
    "status_tail": (
        "Read-only tail of one task wake-event log; history only, not current state.",
        {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "Task id"},
                "lines": {"type": "integer", "minimum": 1, "maximum": 50, "default": 10},
            },
            "required": ["id"],
            "additionalProperties": False,
        },
        tool_status_tail,
    ),
    "peek": (
        "Read-only bounded tail of one crew endpoint for cheap diagnosis.",
        {
            "type": "object",
            "properties": {
                "target": {"type": "string", "description": "Exact task id"},
                "lines": {"type": "integer", "minimum": 1, "maximum": 100, "default": 40},
            },
            "required": ["target"],
            "additionalProperties": False,
        },
        tool_peek,
    ),
    "fleet_view": (
        "Read-only human render of the fleet snapshot for operators.",
        {"type": "object", "properties": {}, "additionalProperties": False},
        tool_fleet_view,
    ),
    "review_diff": (
        "Read-only branch-vs-base diff for one task worktree.",
        {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "Task id"},
                "stat": {"type": "boolean", "description": "Stat summary only", "default": False},
            },
            "required": ["id"],
            "additionalProperties": False,
        },
        tool_review_diff,
    ),
    "bearings_snapshot": (
        "Read-only compact pick-up digest projected from the fleet snapshot (local-only).",
        {"type": "object", "properties": {}, "additionalProperties": False},
        tool_bearings_snapshot,
    ),
    "wake_drain": (
        "Read-only drained-wake records from the durable watcher queue.",
        {"type": "object", "properties": {}, "additionalProperties": False},
        tool_wake_drain,
    ),
    "guard_check": (
        "Read-only watcher liveness and worktree-tangle verdict.",
        {"type": "object", "properties": {}, "additionalProperties": False},
        tool_guard_check,
    ),
    "remote_doctor": (
        "Read-only remote-home readiness diagnostic (check mode; repairs stay out).",
        {"type": "object", "properties": {}, "additionalProperties": False},
        tool_remote_doctor,
    ),
    "remote_file": (
        "Read-only bounded read of one home-relative file (get only; intake stays out).",
        {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Home-relative file path"},
                "max_bytes": {"type": "integer", "minimum": 1, "maximum": 262144, "default": 8192},
            },
            "required": ["path"],
            "additionalProperties": False,
        },
        tool_remote_file,
    ),
    "remote_delta": (
        "Read-only continuity-checked delta read of one append-only log.",
        {
            "type": "object",
            "properties": {
                "log": {"type": "string", "description": "Home-relative log path"},
                "offset": {"type": "integer", "minimum": 0, "description": "Byte cursor", "default": 0},
                "sha256": {"type": "string", "description": "64 hex chars of the exact prefix"},
                "wait": {"type": "integer", "minimum": 0, "maximum": 10, "default": 0},
            },
            "required": ["log", "sha256"],
            "additionalProperties": False,
        },
        tool_remote_delta,
    ),
    "handoff_status": (
        "Read-only staged handoff outboxes: list staged moves, or read one outbox tail.",
        {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "Secondmate id"},
                "lines": {"type": "integer", "minimum": 1, "maximum": 20, "default": 10},
            },
            "additionalProperties": False,
        },
        tool_handoff_status,
    ),
    "harness_detect": (
        "Read-only harness detection for this home; closed mode subset, never walks process ancestry.",
        {
            "type": "object",
            "properties": {
                "mode": {"type": "string", "enum": ["own", "crew", "secondmate", "secondmate-model", "secondmate-effort"], "default": "own"},
            },
            "additionalProperties": False,
        },
        tool_harness_detect,
    ),
    "project_mode": (
        "Read-only registered delivery posture (mode + yolo) for one project.",
        {
            "type": "object",
            "properties": {"project": {"type": "string", "description": "Bare name or projects/<name>"}},
            "required": ["project"],
            "additionalProperties": False,
        },
        tool_project_mode,
    ),
    "lock_status": (
        "Read-only per-home session lock status; acquiring stays out.",
        {"type": "object", "properties": {}, "additionalProperties": False},
        tool_lock_status,
    ),
    "lease_check": (
        "Read-only per-task supervision lease check; claim/release/sweep stay out.",
        {
            "type": "object",
            "properties": {"id": {"type": "string", "description": "Task id"}},
            "required": ["id"],
            "additionalProperties": False,
        },
        tool_lease_check,
    ),
    "bearings_board_path": (
        "Read-only stable path of the captain's bearings board; building/arming stays out.",
        {"type": "object", "properties": {}, "additionalProperties": False},
        tool_bearings_board_path,
    ),
    "inbox_status": (
        "Read-only captain inbox status from durable records; sends no wake.",
        {"type": "object", "properties": {}, "additionalProperties": False},
        tool_inbox_status,
    ),
    "inbox_list": (
        "Read-only list of queued captain inbox notes.",
        {"type": "object", "properties": {}, "additionalProperties": False},
        tool_inbox_list,
    ),
    "home_summary": (
        "Read-only published home-summary ledger; refresh stays firstmate-owned.",
        {"type": "object", "properties": {}, "additionalProperties": False},
        tool_home_summary,
    ),
    "contributions_snapshot": (
        "Read-only owned-contribution coverage projected from the fleet snapshot; never contacts a forge.",
        {
            "type": "object",
            "properties": {
                "all": {"type": "boolean", "description": "Include rows for supervisor inspection", "default": False},
            },
            "additionalProperties": False,
        },
        tool_contributions_snapshot,
    ),
    "contributions_pending": (
        "Read-only pending contribution event tokens from saved records.",
        {"type": "object", "properties": {}, "additionalProperties": False},
        tool_contributions_pending,
    ),
    "send_message": (
        "Steer one crew with a single verified prose line; slash commands, keys, raw panes, and lifecycle verbs are refused.",
        {
            "type": "object",
            "properties": {
                "target": {"type": "string", "description": "Exact task id"},
                "text": {"type": "string", "minLength": 1, "maxLength": 500},
            },
            "required": ["target", "text"],
            "additionalProperties": False,
        },
        tool_send_message,
    ),
    "lifecycle_interrupt": (
        "Authority write: deliver the harness interrupt sequence to one crew; agent keeps running.",
        id_approval_schema(),
        tool_lifecycle_interrupt,
    ),
    "lifecycle_exit": (
        "Authority write: stop one agent, preserving its endpoint, worktree, and uncommitted changes.",
        id_approval_schema(),
        tool_lifecycle_exit,
    ),
    "lifecycle_relaunch": (
        "Authority write: transactionally replace one running agent in the same endpoint and worktree.",
        approval_schema({
            "id": {"type": "string", "description": "Task id"},
            "note": {"type": "string", "description": "Progress note, single line 1..500 chars"},
        }),
        tool_lifecycle_relaunch,
    ),
    "lifecycle_suspend": (
        "Authority write: park one persistent secondmate with a durable note.",
        approval_schema({
            "id": {"type": "string", "description": "Task id"},
            "note": {"type": "string", "description": "Park note, single line 1..500 chars"},
        }),
        tool_lifecycle_suspend,
    ),
    "lifecycle_resume": (
        "Authority write: restore one parked secondmate with a durable note.",
        approval_schema({
            "id": {"type": "string", "description": "Task id"},
            "note": {"type": "string", "description": "Resume note, single line 1..500 chars"},
        }),
        tool_lifecycle_resume,
    ),
    "spawn_crew": (
        "Authority write: spawn one direct report via fm-spawn.sh with an explicit delivery contract.",
        approval_schema({
            "task_id": {"type": "string"},
            "project": {"type": "string", "description": "Bare name or projects/<name>"},
            "mode": {"type": "string", "enum": list(MODES)},
            "yolo": {"type": "string", "enum": ["on", "off"]},
        }),
        tool_spawn_crew,
    ),
    "scaffold_brief": (
        "Authority write: scaffold one crewmate brief via fm-brief.sh; does not launch anything.",
        approval_schema({
            "task_id": {"type": "string"},
            "project": {"type": "string", "description": "Bare name or projects/<name>"},
            "mode": {"type": "string", "enum": list(BRIEF_MODES)},
        }),
        tool_scaffold_brief,
    ),
    "decision_hold": (
        "Authority write: record one durable captain-held decision via fm-decision-hold.sh hold.",
        approval_schema({
            "origin_id": {"type": "string"},
            "decision_key": {"type": "string", "description": "Short slug"},
            "title": {"type": "string"},
            "reason": {"type": "string"},
        }),
        tool_decision_hold,
    ),
    "decision_resolve": (
        "Authority write: resolve one held decision via fm-decision-hold.sh resolve with a decision file.",
        approval_schema({
            "origin_id": {"type": "string"},
            "decision_key": {"type": "string"},
            "routed_to": {"type": "string", "description": "Task id receiving the decision"},
            "decision_text": {"type": "string", "description": "Decision record, 1..2000 chars"},
        }),
        tool_decision_resolve,
    ),
    "review_decision": (
        "Authority write: record one captain approve, decline, or comment via fm-captain-hold.sh answer with a decision file.",
        approval_schema({
            "id": {"type": "string"},
            "verdict": {"type": "string", "enum": list(VERDICTS)},
            "comment": {"type": "string", "description": "Optional single-line comment"},
        }),
        tool_review_decision,
    ),
    "relay_reply": (
        "External send: post one public-safe reply to the relay via fm-x-reply.sh.",
        approval_schema({
            "request_id": {"type": "string"},
            "text": {"type": "string", "description": "Reply text, 1..2000 chars"},
        }),
        tool_relay_reply,
    ),
    "relay_dismiss": (
        "External send: dismiss one pending relay mention without replying via fm-x-dismiss.sh.",
        id_approval_schema("request_id"),
        tool_relay_dismiss,
    ),
    "relay_followup": (
        "External send: post one completion follow-up for a relay-linked task via fm-x-followup.sh.",
        approval_schema({
            "task_id": {"type": "string"},
            "text": {"type": "string", "description": "Follow-up text, 1..2000 chars"},
            "final": {"type": "boolean", "description": "Clear the link after this post"},
        }),
        tool_relay_followup,
    ),
    "secondmate_nudge": (
        "Authority write: ask mismatched secondmates to reconcile via the cooldown-guarded notify path.",
        approval_schema({}),
        tool_secondmate_nudge,
    ),
    "secondmate_restart": (
        "Authority write: restart secondmates onto current wiring after persist; ids only.",
        approval_schema({
            "ids": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 8},
        }),
        tool_secondmate_restart,
    ),
    "secondmate_report": (
        "Authority write: append one correlated report to the parent channel; the helper resolves the destination.",
        approval_schema({
            "verb": {"type": "string", "description": "Report verb slug"},
            "corr": {"type": "string", "description": "16 hex chars, optional corr= prefix"},
            "note": {"type": "string", "description": "Report note, single line 1..500 chars"},
        }),
        tool_secondmate_report,
    ),
    "remote_control": (
        "Authority write: closed state/route/observe/send subset of remote secondmate control.",
        approval_schema({
            "verb": {"type": "string", "enum": ["state", "route", "observe", "send"]},
            "id": {"type": "string", "description": "Secondmate id"},
            "text": {"type": "string", "description": "Prose steer for send, 1..500 chars"},
        }),
        tool_remote_control,
    ),
    "handoff_move": (
        "Authority write: hand queued backlog items to a secondmate, or resume pending wakes.",
        approval_schema({
            "id": {"type": "string", "description": "Secondmate id"},
            "keys": {"type": "array", "items": {"type": "string"}, "description": "1..20 backlog item keys"},
            "resume": {"type": "boolean", "description": "Resume pending wakes; takes no keys", "default": False},
        }),
        tool_handoff_move,
    ),
    "receipt_submit": (
        "Detach one tool call past the 30s fail-closed budget; returns a pending receipt to poll with receipt_status.",
        {
            "type": "object",
            "properties": {
                "tool": {"type": "string", "description": "Name of the tool to run detached"},
                "arguments": {"type": "object", "description": "Arguments for the named tool, including its approval when it requires one"},
            },
            "required": ["tool", "arguments"],
            "additionalProperties": False,
        },
        tool_receipt_submit,
    ),
    "receipt_status": (
        "Read-only check on one detached receipt; reports running, done with the result attached, failed, or expired.",
        {
            "type": "object",
            "properties": {"receipt_id": {"type": "string", "description": "Receipt id from a receipt_submit pending response"}},
            "required": ["receipt_id"],
            "additionalProperties": False,
        },
        tool_receipt_status,
    ),
    "fleet_poll": (
        "Read-only convenience poller over fleet_snapshot for clients that need push-like updates.",
        {
            "type": "object",
            "properties": {
                "count": {"type": "integer", "minimum": 1, "maximum": 3, "default": 2},
                "interval_s": {"type": "number", "minimum": 0, "maximum": 2, "default": 0},
            },
            "additionalProperties": False,
        },
        tool_fleet_poll,
    ),
}


def reply(msg_id, result):
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": msg_id, "result": result}) + "\n")
    sys.stdout.flush()


def reply_error(msg_id, code, message, data=None):
    err = {"code": code, "message": message}
    if data is not None:
        err["data"] = data
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": msg_id, "error": err}) + "\n")
    sys.stdout.flush()


def handle_initialize(msg_id, params):
    params = params or {}
    requested = params.get("protocolVersion")
    version = requested if requested in SUPPORTED_PROTOCOL_VERSIONS else SUPPORTED_PROTOCOL_VERSIONS[-1]
    reply(msg_id, {
        "protocolVersion": version,
        "capabilities": {"tools": {}},
        "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
    })


def handle_tools_list(msg_id):
    reply(msg_id, {
        "tools": [
            {"name": name, "description": desc, "inputSchema": schema}
            for name, (desc, schema, _) in TOOLS.items()
        ]
    })


def handle_tools_call(msg_id, params):
    params = params or {}
    name = params.get("name")
    args = params.get("arguments") or {}
    tool_label = name if isinstance(name, str) else "unknown"
    if name not in TOOLS:
        audit_append(tool_label, "refuse", "unknown-tool",
                     approval=args.get("approval") if isinstance(args, dict) else None,
                     target=audit_target(tool_label, args))
        reply_error(msg_id, -32602, f"unknown tool: {name}")
        return
    if not isinstance(args, dict):
        audit_append(tool_label, "refuse", "validation-failed",
                     target=None)
        reply_error(msg_id, -32602, "arguments must be an object")
        return
    _, _, func = TOOLS[name]
    try:
        payload, is_error = func(args)
    except Exception as exc:  # never crash the session on a tool failure
        payload, is_error = {"error": "tool crashed", "detail": str(exc)}, True
    decision, reason = audit_decision(args, payload, is_error)
    approval = args.get("approval")
    if approval is None and name == "receipt_submit":
        nested = args.get("arguments")
        if isinstance(nested, dict):
            approval = nested.get("approval")
    audit_append(tool_label, decision, reason,
                 approval=approval, target=audit_target(tool_label, args))
    result = {"content": [{"type": "text", "text": json.dumps(payload)}]}
    if is_error:
        result["isError"] = True
    reply(msg_id, result)


def main():
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            reply_error(None, -32700, "parse error")
            continue
        method = msg.get("method")
        msg_id = msg.get("id")
        params = msg.get("params") or {}
        if method == "initialize":
            handle_initialize(msg_id, params)
        elif method == "notifications/initialized":
            continue
        elif method == "tools/list":
            handle_tools_list(msg_id)
        elif method == "tools/call":
            handle_tools_call(msg_id, params)
        elif method == "ping":
            reply(msg_id, {})
        elif isinstance(method, str) and method.startswith("notifications/"):
            continue
        elif msg_id is not None:
            reply_error(msg_id, -32601, f"method not found: {method}")


if __name__ == "__main__":
    main()
