"""Command dispatcher: tool name -> owning script + argv builder.

The adapter never reimplements First Mate behavior. Each tool entry names
the single bin/fm-*.sh script that owns the operation and a builder that
turns validated arguments into that script's safe flag subset. Anything
not in the registry, or named in DENY_LIST, is refused before any process
starts. run_script additionally refuses any script outside the registry's
allow-list, so a bad table entry fails closed instead of executing.
"""

import json
import os
import subprocess
import tempfile
from pathlib import Path

from adapter import envelope as env
from adapter import validators as v

SNAPSHOT_SCHEMA = "fm-fleet-snapshot.v1"
MAX_OUTPUT_BYTES = 131072
TAIL_CAP_BYTES = 8192
SUBPROCESS_TIMEOUT_S = 30

MODES = ("no-mistakes", "direct-PR", "local-only")
BRIEF_MODES = ("no-mistakes", "direct-PR", "local-only", "scout")
VERDICTS = ("approve", "decline", "comment")
YOLO = ("on", "off")

APPROVAL_ERROR = env.err(
    "approval-required",
    "approval required",
    expect="explicit approval string starting with 'I authorize'",
)
ID_ERROR = env.err(
    "invalid-id", "invalid id", expect="short task id, no slashes or traversal"
)

# Surfaces that must never be reachable through the adapter. Code-writing
# and landing tools stay out per the smarts-only line (launch ability yes,
# development ability no); daemon control stays out because the shared
# no-mistakes daemon serves every lane and only firstmate manages it;
# direct repo mutation stays out because project changes belong to workers
# behind the configured merge authority, never to an MCP call.
DENY_LIST = frozenset(
    {
        # Code-writing / landing (PoC code-forbidden set).
        "promote_scout",
        "teardown_crew",
        "arm_pr_check",
        "merge_pr",
        "merge_local",
        # Daemon and supervision control.
        "daemon_start",
        "daemon_stop",
        "daemon_restart",
        "watch_start",
        "watch_stop",
        # Direct repo mutation.
        "repo_edit",
        "repo_commit",
        "repo_push",
        "repo_merge",
    }
)

# Flags no argv builder may ever emit: raw pane access, key injection,
# destructive force, and unattended yes-to-everything.
DENIED_FLAGS = frozenset({"--key", "--raw", "--force", "--yes", "--force-with-lease"})


def _argv(*parts):
    argv = [str(p) for p in parts]
    for flag in argv:
        if flag in DENIED_FLAGS:
            raise ValueError(f"denied flag: {flag}")
    return argv


def _build_crew_state(args):
    task_id = args.get("id")
    if not v.valid_id(task_id):
        return None, ID_ERROR
    return _argv("fm-crew-state.sh", task_id), None


def _build_status_tail(args):
    task_id = args.get("id")
    if not v.valid_id(task_id):
        return None, ID_ERROR
    return _argv("fm-crew-state.sh", task_id), None


def _build_send_message(args):
    target = args.get("target")
    text = args.get("text")
    if not v.valid_id(target):
        return None, env.err(
            "invalid-target",
            "invalid target",
            expect="exact task id, no slashes or traversal",
        )
    if not isinstance(text, str) or not 1 <= len(text) <= v.SEND_TEXT_MAX_CHARS:
        return None, env.err(
            "invalid-text",
            "invalid text",
            expect=f"single line, 1..{v.SEND_TEXT_MAX_CHARS} chars",
        )
    if "\n" in text or "\r" in text:
        return None, env.err(
            "invalid-text", "invalid text", expect="single line, no newlines"
        )
    if text.lstrip().startswith("/"):
        return None, env.err(
            "slash-commands-refused",
            "slash commands refused",
            expect="plain prose steer only",
        )
    return _argv("fm-send.sh", target, text), None


def _lifecycle_builder(verb, needs_note):
    def build(args):
        task_id = args.get("id")
        if not v.valid_id(task_id):
            return None, ID_ERROR
        if not v.valid_approval(args.get("approval")):
            return None, APPROVAL_ERROR
        argv = _argv("fm-control.sh", task_id, verb)
        if needs_note:
            note = args.get("note")
            if not v.valid_note(note):
                return None, env.err(
                    "invalid-note",
                    "invalid note",
                    expect="single line, 1..500 chars",
                )
            argv += ["--note", note]
        return argv, None

    return build


def _build_spawn_crew(args):
    task_id = args.get("task_id")
    project = args.get("project")
    mode = args.get("mode")
    yolo = args.get("yolo")
    if not v.valid_id(task_id):
        return None, env.err(
            "invalid-task-id",
            "invalid task_id",
            expect="short task id, no slashes or traversal",
        )
    if not v.valid_project(project):
        return None, env.err(
            "invalid-project",
            "invalid project",
            expect="bare name or projects/<name>, no absolute paths or traversal",
        )
    if mode not in MODES:
        return None, env.err(
            "invalid-mode",
            "invalid mode",
            expect="one of no-mistakes, direct-PR, local-only",
        )
    if yolo not in YOLO:
        return None, env.err(
            "invalid-yolo", "invalid yolo", expect="one of on, off"
        )
    if not v.valid_approval(args.get("approval")):
        return None, APPROVAL_ERROR
    return _argv("fm-spawn.sh", task_id, project, "--mode", mode, "--yolo", yolo), None


def _build_scaffold_brief(args):
    task_id = args.get("task_id")
    project = args.get("project")
    mode = args.get("mode")
    if not v.valid_id(task_id):
        return None, env.err(
            "invalid-task-id",
            "invalid task_id",
            expect="short task id, no slashes or traversal",
        )
    if not v.valid_project(project):
        return None, env.err(
            "invalid-project",
            "invalid project",
            expect="bare name or projects/<name>, no absolute paths or traversal",
        )
    if mode not in BRIEF_MODES:
        return None, env.err(
            "invalid-mode",
            "invalid mode",
            expect="one of no-mistakes, direct-PR, local-only, scout",
        )
    if not v.valid_approval(args.get("approval")):
        return None, APPROVAL_ERROR
    if mode == "scout":
        return _argv("fm-brief.sh", task_id, project, "--scout"), None
    return _argv("fm-brief.sh", task_id, project, "--mode", mode), None


def _build_decision_hold(args):
    origin_id = args.get("origin_id")
    decision_key = args.get("decision_key")
    title = args.get("title")
    reason = args.get("reason")
    if not v.valid_id(origin_id):
        return None, env.err(
            "invalid-origin-id",
            "invalid origin_id",
            expect="short task id, no slashes or traversal",
        )
    if not v.valid_id(decision_key):
        return None, env.err(
            "invalid-decision-key",
            "invalid decision_key",
            expect="short slug, no slashes or traversal",
        )
    if not v.valid_note(title, v.TITLE_MAX_CHARS):
        return None, env.err(
            "invalid-title", "invalid title", expect="single line, 1..200 chars"
        )
    if not v.valid_note(reason, v.REASON_MAX_CHARS):
        return None, env.err(
            "invalid-reason",
            "invalid reason",
            expect="single line, 1..1000 chars",
        )
    if not v.valid_approval(args.get("approval")):
        return None, APPROVAL_ERROR
    return _argv(
        "fm-decision-hold.sh",
        "hold",
        origin_id,
        decision_key,
        "--title",
        title,
        "--reason",
        reason,
    ), None


def _build_review_decision(args):
    task_id = args.get("id")
    verdict = args.get("verdict")
    comment = args.get("comment", "")
    if not v.valid_id(task_id):
        return None, ID_ERROR
    if verdict not in VERDICTS:
        return None, env.err(
            "invalid-verdict",
            "invalid verdict",
            expect="one of approve, decline, comment",
        )
    if comment and not v.valid_note(comment):
        return None, env.err(
            "invalid-comment",
            "invalid comment",
            expect="single line, 1..500 chars",
        )
    if not v.valid_approval(args.get("approval")):
        return None, APPROVAL_ERROR
    argv = _argv("fm-review-decision.sh", task_id, verdict)
    if comment:
        argv.append(comment)
    return argv, None


def _relay_text_args(args, id_field, max_chars):
    request_id = args.get(id_field)
    text = args.get("text")
    if not v.valid_id(request_id):
        return None, None, env.err(
            f"invalid-{id_field}",
            f"invalid {id_field}",
            expect="short slug, no slashes or traversal",
        )
    if not isinstance(text, str) or not 1 <= len(text) <= max_chars:
        return None, None, env.err(
            "invalid-text", "invalid text", expect=f"1..{max_chars} chars"
        )
    if not v.valid_approval(args.get("approval")):
        return None, None, APPROVAL_ERROR
    return request_id, text, None


def _build_relay_reply(args):
    request_id, text, error = _relay_text_args(args, "request_id", 2000)
    if error:
        return None, error
    return _argv("fm-x-reply.sh", request_id, text), None


def _build_relay_dismiss(args):
    request_id = args.get("request_id")
    if not v.valid_id(request_id):
        return None, env.err(
            "invalid-request-id",
            "invalid request_id",
            expect="short slug, no slashes or traversal",
        )
    if not v.valid_approval(args.get("approval")):
        return None, APPROVAL_ERROR
    return _argv("fm-x-dismiss.sh", request_id), None


# Registry: tool name -> (owning script basename, argv builder, needs approval).
# Reads and the single safe steer need no approval; everything authority-
# bearing or externally visible does. status_tail and fleet_poll are
# handled natively by the adapter (bounded file read / snapshot poller)
# because no owning script exists for those projections.
TOOLS = {
    "fleet_snapshot": ("fm-fleet-snapshot.sh", None, False),
    "backlog": ("fm-fleet-snapshot.sh", None, False),
    "crew_state": ("fm-crew-state.sh", _build_crew_state, False),
    "status_tail": (None, _build_status_tail, False),
    "send_message": ("fm-send.sh", _build_send_message, False),
    "fleet_poll": ("fm-fleet-snapshot.sh", None, False),
    "lifecycle_interrupt": ("fm-control.sh", _lifecycle_builder("interrupt", False), True),
    "lifecycle_exit": ("fm-control.sh", _lifecycle_builder("exit", False), True),
    "lifecycle_relaunch": ("fm-control.sh", _lifecycle_builder("relaunch", True), True),
    "lifecycle_suspend": ("fm-control.sh", _lifecycle_builder("suspend", True), True),
    "lifecycle_resume": ("fm-control.sh", _lifecycle_builder("resume", True), True),
    "spawn_crew": ("fm-spawn.sh", _build_spawn_crew, True),
    "scaffold_brief": ("fm-brief.sh", _build_scaffold_brief, True),
    "decision_hold": ("fm-decision-hold.sh", _build_decision_hold, True),
    "decision_resolve": ("fm-decision-hold.sh", None, True),
    "review_decision": ("fm-review-decision.sh", _build_review_decision, True),
    "relay_reply": ("fm-x-reply.sh", _build_relay_reply, True),
    "relay_dismiss": ("fm-x-dismiss.sh", _build_relay_dismiss, True),
    "relay_followup": ("fm-x-followup.sh", None, True),
}

TOOL_NAMES = frozenset(TOOLS)
ALLOWED_SCRIPTS = frozenset(s for s, _, _ in TOOLS.values() if s)


def truncate(text, cap=TAIL_CAP_BYTES):
    """Bound script output tails; returns (text, was_truncated)."""
    if len(text.encode("utf-8", "replace")) <= cap:
        return text, False
    buf = text.encode("utf-8", "replace")[:cap].decode("utf-8", "replace")
    return buf + "\n…[truncated]", True


class Adapter:
    """Pinned-home dispatcher. One instance serves one First Mate home."""

    def __init__(self, home=None, checkout_root=None, runner=None):
        root = checkout_root or Path(__file__).resolve().parent.parent
        self.checkout_root = Path(root)
        self.bin = self.checkout_root / "bin"
        pinned = home if home is not None else os.environ.get("FM_HOME")
        self.home = Path(pinned) if pinned else self.checkout_root
        override = os.environ.get("FM_STATE_OVERRIDE")
        self.state_dir = Path(override) if override else self.home / "state"
        self._runner = runner or subprocess.run

    def run_script(self, argv):
        """Run an allow-listed bin script; refuse everything else."""
        if not argv:
            return None, env.err("invalid-argv", "empty argv")
        script = Path(str(argv[0])).name
        if script not in ALLOWED_SCRIPTS:
            return None, env.err(
                "script-not-allowed",
                f"script not allowed: {script}",
                expect="one of " + ", ".join(sorted(ALLOWED_SCRIPTS)),
            )
        full = [str(self.bin / script)] + [str(a) for a in argv[1:]]
        try:
            proc = self._runner(
                full,
                cwd=str(self.checkout_root),
                capture_output=True,
                text=True,
                timeout=SUBPROCESS_TIMEOUT_S,
            )
        except FileNotFoundError as exc:
            return None, env.err("executable-not-found", str(exc))
        except subprocess.TimeoutExpired:
            return None, env.err("timed-out", "script timed out",
                                 timeout_s=SUBPROCESS_TIMEOUT_S)
        return proc, None

    def owned_call(self, argv, label):
        """Shared fail-closed wrapper: nonzero exit stays a typed error."""
        proc, error = self.run_script(argv)
        if error:
            return error
        out, out_trunc = truncate(proc.stdout or "")
        err_out, err_trunc = truncate(proc.stderr or "")
        if proc.returncode != 0:
            return env.err(
                "script-failed", label, exit=proc.returncode,
                stdout=out, stderr=err_out,
            )
        return env.ok(
            stdout=out, stdout_truncated=out_trunc,
            stderr=err_out, stderr_truncated=err_trunc,
        )

    def dispatch(self, name, args):
        """Route one tool call to its owning script. Never raises."""
        try:
            return self._dispatch(name, args or {})
        except Exception as exc:
            return env.err("adapter-crashed", "tool crashed", detail=str(exc))

    def _dispatch(self, name, args):
        if not isinstance(args, dict):
            return env.err("invalid-arguments", "arguments must be an object")
        if name in DENY_LIST:
            return env.err(
                "forbidden",
                f"tool not reachable: {name}",
                expect="adapter boundary: code-writing, landing, daemon, "
                       "and repo-mutation surfaces have no tool",
            )
        entry = TOOLS.get(name)
        if entry is None:
            return env.err("unknown-tool", f"unknown tool: {name}")
        script, builder, _needs_approval = entry
        handler = getattr(self, f"tool_{name}", None)
        if handler is None:
            return env.err("not-implemented", f"tool not implemented: {name}")
        _ = script, builder
        return handler(args)

    def tool_fleet_snapshot(self, _args):
        proc, error = self.run_script(["fm-fleet-snapshot.sh", "--json"])
        if error:
            return error
        if proc.returncode != 0:
            out, _ = truncate(proc.stderr or proc.stdout or "")
            return env.err("snapshot-failed", "snapshot failed",
                           exit=proc.returncode, output=out)
        if len(proc.stdout.encode("utf-8", "replace")) > MAX_OUTPUT_BYTES:
            return env.err("snapshot-too-large",
                           "snapshot too large for envelope")
        try:
            snapshot = json.loads(proc.stdout)
        except json.JSONDecodeError:
            out, _ = truncate(proc.stdout)
            return env.err("snapshot-not-json", "snapshot was not JSON",
                           output=out)
        if snapshot.get("schema") != SNAPSHOT_SCHEMA:
            return env.err("unexpected-schema", "unexpected snapshot schema",
                           schema=snapshot.get("schema"))
        return env.ok(snapshot=snapshot)

    def tool_backlog(self, _args):
        result = self.tool_fleet_snapshot({})
        if env.is_err(result):
            return result
        snapshot = result["snapshot"]
        by_state = {}
        for task in snapshot.get("tasks", []):
            state = ((task.get("current_state") or {}).get("state")) or "unknown"
            by_state[state] = by_state.get(state, 0) + 1
        return env.ok(
            generated=snapshot.get("generated"),
            backlog=snapshot.get("backlog", {}),
            task_counts={"total": len(snapshot.get("tasks", [])), "by_state": by_state},
        )

    def tool_crew_state(self, args):
        argv, error = _build_crew_state(args)
        if error:
            return error
        proc, run_error = self.run_script(argv)
        if run_error:
            return run_error
        import re as _re

        raw = (proc.stdout or "").strip().splitlines()
        line = raw[0] if raw else ""
        parsed = {"state": "unknown", "source": "none", "detail": line}
        match = _re.match(r"state:\s*(\S+)\s+·\s*source:\s*(\S+)\s+·\s*(.*)", line)
        if match:
            parsed = {
                "state": match.group(1),
                "source": match.group(2),
                "detail": match.group(3),
            }
        return env.ok(id=args.get("id"), current=parsed, raw=line)

    def tool_status_tail(self, args):
        task_id = args.get("id")
        lines = v.valid_status_lines(args.get("lines", 10))
        if not v.valid_id(task_id):
            return ID_ERROR
        if lines is None:
            return env.err("invalid-lines", "invalid lines",
                           expect="integer 1..50")
        path = v.confine_state_path(self.state_dir, task_id)
        if path is None:
            return ID_ERROR
        try:
            content = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except FileNotFoundError:
            return env.err("no-status-log", "no status log for id", id=task_id)
        except OSError as exc:
            return env.err("cannot-read-status-log", "cannot read status log",
                           detail=str(exc))
        return env.ok(
            id=task_id,
            events=content[-lines:],
            warning="wake-event history only, never current state; "
                    "use crew_state for current state",
        )

    def tool_send_message(self, args):
        argv, error = _build_send_message(args)
        if error:
            return error
        result = self.owned_call(argv, "steer refused or failed")
        if env.is_err(result):
            return result
        result = dict(result)
        result.update(
            {"delivered": True, "target": args.get("target"),
             "note": "verified submit per fm-send contract; delivery is not reply"}
        )
        return result

    def tool_fleet_poll(self, args):
        try:
            count = int(args.get("count", 2))
        except (TypeError, ValueError):
            return env.err("invalid-count", "invalid count",
                           expect="integer 1..3")
        try:
            interval_s = float(args.get("interval_s", 0))
        except (TypeError, ValueError):
            return env.err("invalid-interval", "invalid interval_s",
                           expect="number 0..2")
        count = max(1, min(3, count))
        interval_s = max(0.0, min(2.0, interval_s))
        polls = []
        for _ in range(count):
            result = self.tool_fleet_snapshot({})
            if env.is_err(result):
                return result
            snapshot = result["snapshot"]
            polls.append(
                {"generated": snapshot.get("generated"),
                 "tasks": len(snapshot.get("tasks", []))}
            )
            if interval_s > 0:
                import time as _time

                _time.sleep(interval_s)
        return env.ok(
            polls=polls,
            warning="polling convenience only; fleet_snapshot stays canonical",
        )

    def _lifecycle(self, args, verb, needs_note):
        argv, error = _lifecycle_builder(verb, needs_note)(args)
        if error:
            return error
        result = self.owned_call(argv, f"{verb} refused or failed")
        if env.is_err(result):
            return result
        result = dict(result)
        result.update({"verb": verb, "id": args.get("id")})
        return result

    def tool_lifecycle_interrupt(self, args):
        return self._lifecycle(args, "interrupt", False)

    def tool_lifecycle_exit(self, args):
        return self._lifecycle(args, "exit", False)

    def tool_lifecycle_relaunch(self, args):
        return self._lifecycle(args, "relaunch", True)

    def tool_lifecycle_suspend(self, args):
        return self._lifecycle(args, "suspend", True)

    def tool_lifecycle_resume(self, args):
        return self._lifecycle(args, "resume", True)

    def tool_spawn_crew(self, args):
        argv, error = _build_spawn_crew(args)
        if error:
            return error
        result = self.owned_call(argv, "spawn refused or failed")
        if env.is_err(result):
            return result
        result = dict(result)
        result.update(
            {"task_id": args.get("task_id"), "project": args.get("project"),
             "mode": args.get("mode")}
        )
        return result

    def tool_scaffold_brief(self, args):
        argv, error = _build_scaffold_brief(args)
        if error:
            return error
        result = self.owned_call(argv, "brief refused or failed")
        if env.is_err(result):
            return result
        result = dict(result)
        result.update(
            {"task_id": args.get("task_id"), "project": args.get("project"),
             "mode": args.get("mode")}
        )
        return result

    def tool_decision_hold(self, args):
        argv, error = _build_decision_hold(args)
        if error:
            return error
        result = self.owned_call(argv, "decision hold refused or failed")
        if env.is_err(result):
            return result
        result = dict(result)
        result.update(
            {"origin_id": args.get("origin_id"),
             "decision_key": args.get("decision_key")}
        )
        return result

    def tool_decision_resolve(self, args):
        origin_id = args.get("origin_id")
        decision_key = args.get("decision_key")
        routed_to = args.get("routed_to")
        decision_text = args.get("decision_text")
        if not v.valid_id(origin_id):
            return env.err(
                "invalid-origin-id", "invalid origin_id",
                expect="short task id, no slashes or traversal",
            )
        if not v.valid_id(decision_key):
            return env.err(
                "invalid-decision-key", "invalid decision_key",
                expect="short slug, no slashes or traversal",
            )
        if not v.valid_id(routed_to):
            return env.err(
                "invalid-routed-to", "invalid routed_to",
                expect="short task id, no slashes or traversal",
            )
        if not isinstance(decision_text, str) or not (
            1 <= len(decision_text) <= v.DECISION_TEXT_MAX_CHARS
        ):
            return env.err(
                "invalid-decision-text", "invalid decision_text",
                expect="1..2000 chars",
            )
        if not v.valid_approval(args.get("approval")):
            return APPROVAL_ERROR
        tmp = None
        try:
            with tempfile.NamedTemporaryFile("w", suffix=".md",
                                             delete=False) as handle:
                handle.write(decision_text)
                tmp = handle.name
            result = self.owned_call(
                _argv("fm-decision-hold.sh", "resolve", origin_id,
                      decision_key, "--decision-file", tmp,
                      "--routed-to", routed_to),
                "decision resolve refused or failed",
            )
        finally:
            if tmp:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
        if env.is_err(result):
            return result
        result = dict(result)
        result.update({"origin_id": origin_id, "decision_key": decision_key})
        return result

    def tool_review_decision(self, args):
        argv, error = _build_review_decision(args)
        if error:
            return error
        result = self.owned_call(argv, "review decision refused or failed")
        if env.is_err(result):
            return result
        result = dict(result)
        result.update({"id": args.get("id"), "verdict": args.get("verdict")})
        return result

    def tool_relay_reply(self, args):
        argv, error = _build_relay_reply(args)
        if error:
            return error
        result = self.owned_call(argv, "relay reply refused or failed")
        if env.is_err(result):
            return result
        result = dict(result)
        result.update({"request_id": args.get("request_id")})
        return result

    def tool_relay_dismiss(self, args):
        argv, error = _build_relay_dismiss(args)
        if error:
            return error
        result = self.owned_call(argv, "relay dismiss refused or failed")
        if env.is_err(result):
            return result
        result = dict(result)
        result.update({"request_id": args.get("request_id")})
        return result

    def tool_relay_followup(self, args):
        task_id = args.get("task_id")
        text = args.get("text")
        final = args.get("final", False)
        if not v.valid_id(task_id):
            return env.err(
                "invalid-task-id", "invalid task_id",
                expect="short task id, no slashes or traversal",
            )
        if not isinstance(text, str) or not 1 <= len(text) <= 2000:
            return env.err("invalid-text", "invalid text",
                           expect="1..2000 chars")
        if not isinstance(final, bool):
            return env.err("invalid-final", "invalid final",
                           expect="boolean")
        if not v.valid_approval(args.get("approval")):
            return APPROVAL_ERROR
        tmp = None
        try:
            with tempfile.NamedTemporaryFile("w", suffix=".md",
                                             delete=False) as handle:
                handle.write(text)
                tmp = handle.name
            argv = _argv("fm-x-followup.sh", task_id, "--text-file", tmp)
            if final:
                argv.append("--final")
            result = self.owned_call(argv, "relay followup refused or failed")
        finally:
            if tmp:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
        if env.is_err(result):
            return result
        result = dict(result)
        result.update({"task_id": task_id})
        return result
