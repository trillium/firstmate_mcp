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
MODES = ("no-mistakes", "direct-PR", "local-only")
BRIEF_MODES = ("no-mistakes", "direct-PR", "local-only", "scout")
VERDICTS = ("approve", "decline", "comment")


def state_dir():
    override = os.environ.get("FM_STATE_OVERRIDE")
    return Path(override) if override else home_dir() / "state"


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
                "receipt_id", "tool"):
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
    if comment and not valid_note(comment):
        return {"error": "invalid comment", "expect": "single line, 1..500 chars"}, True
    if not valid_approval(args.get("approval")):
        return approval_error(), True
    argv = [BIN / "fm-review-decision.sh", task_id, verdict]
    if comment:
        argv.append(comment)
    payload, is_error = owned_call(argv, "review decision refused or failed")
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


# Tools whose schemas carry a required per-call approval string. A
# receipt_submit for one of these targets only schedules when the nested
# arguments carry a valid approval; open tools submit freely.
NEEDS_APPROVAL = frozenset({
    "lifecycle_interrupt", "lifecycle_exit", "lifecycle_relaunch",
    "lifecycle_suspend", "lifecycle_resume", "spawn_crew",
    "scaffold_brief", "decision_hold", "decision_resolve",
    "review_decision", "relay_reply", "relay_dismiss", "relay_followup",
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
        "Authority write: record one captain approve, decline, or comment via fm-review-decision.sh.",
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
