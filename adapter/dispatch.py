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
HARNESS_MODES = ("own", "crew", "secondmate", "secondmate-model",
                 "secondmate-effort")
HOME_SUMMARY_SCHEMA = "fm-secondmate-home-summary.v1"
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


def _build_peek(args):
    target = args.get("target")
    if not v.valid_id(target):
        return None, env.err(
            "invalid-target",
            "invalid target",
            expect="exact task id, no slashes or traversal",
        )
    lines = v.valid_peek_lines(args.get("lines", 40))
    if lines is None:
        return None, env.err(
            "invalid-lines", "invalid lines", expect="integer 1..100"
        )
    return _argv("fm-peek.sh", target, str(lines)), None


def _build_remote_file(args):
    relpath = args.get("path")
    if not v.valid_relpath(relpath):
        return None, env.err(
            "invalid-path",
            "invalid path",
            expect="relative path under the home, no traversal",
        )
    raw_max = args.get("max_bytes", v.REMOTE_FILE_DEFAULT_MAX_BYTES)
    max_bytes = v.valid_remote_max_bytes(raw_max)
    if max_bytes is None:
        return None, env.err(
            "invalid-max-bytes",
            "invalid max_bytes",
            expect="integer 1..262144",
        )
    return _argv("fm-remote-file.sh", "get", relpath, str(max_bytes)), None


def _build_remote_delta(args):
    rel_log = args.get("log")
    if not v.valid_relpath(rel_log):
        return None, env.err(
            "invalid-path",
            "invalid path",
            expect="relative log path under the home, no traversal",
        )
    offset = v.valid_nonneg_int(args.get("offset", 0))
    if offset is None:
        return None, env.err(
            "invalid-offset",
            "invalid offset",
            expect="nonnegative integer byte cursor",
        )
    sha = args.get("sha256")
    if not v.valid_sha256(sha):
        return None, env.err(
            "invalid-sha256",
            "invalid sha256",
            expect="64 hex chars of the exact prefix",
        )
    wait = v.valid_delta_wait(args.get("wait", 0))
    if wait is None:
        return None, env.err(
            "invalid-wait",
            "invalid wait",
            expect="integer 0..10 seconds",
        )
    return _argv("fm-remote-delta-read.sh", rel_log, str(offset), sha,
                  str(wait)), None


def _build_handoff_status(args):
    task_id = args.get("id")
    if task_id is not None and not v.valid_id(task_id):
        return None, ID_ERROR
    lines = v.valid_handoff_lines(args.get("lines", v.HANDOFF_DEFAULT_LINES))
    if lines is None:
        return None, env.err(
            "invalid-lines", "invalid lines", expect="integer 1..20"
        )
    # The read is native (bounded outbox files under data/handoff/); no
    # owning-script argv exists, mirroring the status_tail shape.
    return [], None


def _build_secondmate_nudge(args):
    # Notify-only subset: the backstop asks mismatched secondmates to
    # reconcile through the cooldown-guarded notify path. request (snapshot
    # plumbing) and process-requests (watcher-internal queue claim) stay out.
    if not v.valid_approval(args.get("approval")):
        return None, APPROVAL_ERROR
    return _argv("fm-secondmate-reconcile.sh", "notify"), None


def _build_secondmate_restart(args):
    ids = v.valid_id_list(args.get("ids"), v.RESTART_IDS_MAX)
    if ids is None:
        return None, env.err(
            "invalid-id",
            "invalid id",
            expect="1..8 secondmate ids, no slashes or traversal",
        )
    if not v.valid_approval(args.get("approval")):
        return None, APPROVAL_ERROR
    return _argv("fm-secondmate-restart.sh", *ids), None


def _build_secondmate_report(args):
    verb = args.get("verb")
    if not v.valid_id(verb):
        return None, env.err(
            "invalid-verb",
            "invalid verb",
            expect="short slug, no slashes or traversal",
        )
    corr = args.get("corr")
    if not v.valid_corr(corr):
        return None, env.err(
            "invalid-corr",
            "invalid corr",
            expect="16 hex chars, optional corr= prefix",
        )
    note = args.get("note")
    if not v.valid_note(note):
        return None, env.err(
            "invalid-note",
            "invalid note",
            expect="single line, 1..500 chars",
        )
    if not v.valid_approval(args.get("approval")):
        return None, APPROVAL_ERROR
    return _argv("fm-secondmate-report.sh", verb, corr, note), None


def _build_remote_control(args):
    verb = args.get("verb")
    if verb not in v.REMOTE_CONTROL_VERBS:
        return None, env.err(
            "invalid-verb",
            "invalid verb",
            expect="one of state, route, observe, send",
        )
    task_id = args.get("id")
    if not v.valid_id(task_id):
        return None, ID_ERROR
    if not v.valid_approval(args.get("approval")):
        return None, APPROVAL_ERROR
    argv = _argv("fm-remote-secondmate-control.sh", verb, task_id)
    if verb == "send":
        text = args.get("text")
        if not isinstance(text, str) or not 1 <= len(text) <= v.SEND_TEXT_MAX_CHARS:
            return None, env.err(
                "invalid-text",
                "invalid text",
                expect=f"single line, 1..{v.SEND_TEXT_MAX_CHARS} chars",
            )
        if "\n" in text or "\r" in text:
            return None, env.err(
                "invalid-text", "invalid text",
                expect="single line, no newlines",
            )
        if text.lstrip().startswith("/"):
            return None, env.err(
                "slash-commands-refused",
                "slash commands refused",
                expect="plain prose steer only",
            )
        argv.append(text)
    return argv, None


def _build_handoff_move(args):
    task_id = args.get("id")
    if not v.valid_id(task_id):
        return None, ID_ERROR
    resume = args.get("resume", False)
    if not isinstance(resume, bool):
        return None, env.err(
            "invalid-resume", "invalid resume", expect="boolean"
        )
    if not v.valid_approval(args.get("approval")):
        return None, APPROVAL_ERROR
    if resume:
        keys = args.get("keys", [])
        if keys not in ([], None):
            return None, env.err(
                "invalid-keys",
                "invalid keys",
                expect="resume takes no keys",
            )
        return _argv("fm-backlog-handoff.sh", "--resume-pending"), None
    keys = v.valid_id_list(args.get("keys"), v.HANDOFF_KEYS_MAX)
    if keys is None:
        return None, env.err(
            "invalid-keys",
            "invalid keys",
            expect="1..20 backlog item keys, no slashes or traversal",
        )
    return _argv("fm-backlog-handoff.sh", task_id, *keys), None
def _build_harness_detect(args):
    mode = args.get("mode", "own")
    if mode not in HARNESS_MODES:
        return None, env.err(
            "invalid-mode",
            "invalid mode",
            expect="one of own, crew, secondmate, secondmate-model, "
                   "secondmate-effort",
        )
    # Ancestry/ancestry-descent (pid walks) and validate-native-effort
    # stay out: detection only, never process introspection or policy.
    if mode == "own":
        return _argv("fm-harness.sh"), None
    return _argv("fm-harness.sh", mode), None


def _build_project_mode(args):
    project = args.get("project")
    if not v.valid_project(project):
        return None, env.err(
            "invalid-project",
            "invalid project",
            expect="bare name or projects/<name>, no absolute paths or traversal",
        )
    # Mapped "<mode> <yolo>" only: --raw is a denied argv flag, so
    # conditional policies resolve to their most rigorous leg.
    return _argv("fm-project-mode.sh", project), None


def _build_lease_check(args):
    task_id = args.get("id")
    if not v.valid_id(task_id):
        return None, ID_ERROR
    # Check only: claim/release/release-actor/sweep are guarded by the
    # supervision-actor contract, which an adapter call cannot name.
    return _argv("fm-lease.sh", "check", task_id), None


def _build_home_summary(_args):
    # Native bounded ledger read under state_dir; no owning-script argv
    # exists, mirroring the status_tail shape.
    return [], None


def _build_contributions_snapshot(args):
    want_all = args.get("all", False)
    if not isinstance(want_all, bool):
        return None, env.err(
            "invalid-all", "invalid all", expect="boolean"
        )
    # Snapshot + pending only: poll spends forge reads over the network
    # and verdict/ack/arm mutate the saved records.
    return _argv("fm-contributions.sh", "snapshot"), None


def _build_review_diff(args):
    task_id = args.get("id")
    if not v.valid_id(task_id):
        return None, ID_ERROR
    stat = args.get("stat", False)
    if not isinstance(stat, bool):
        return None, env.err(
            "invalid-stat", "invalid stat", expect="boolean"
        )
    argv = _argv("fm-review-diff.sh", task_id)
    if stat:
        argv.append("--stat")
    return argv, None


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
BEARINGS_SCHEMA = "fm-bearings.v1"

TOOLS = {
    "fleet_snapshot": ("fm-fleet-snapshot.sh", None, False),
    "backlog": ("fm-fleet-snapshot.sh", None, False),
    "crew_state": ("fm-crew-state.sh", _build_crew_state, False),
    "status_tail": (None, _build_status_tail, False),
    "send_message": ("fm-send.sh", _build_send_message, False),
    "fleet_poll": ("fm-fleet-snapshot.sh", None, False),
    "peek": ("fm-peek.sh", _build_peek, False),
    "fleet_view": ("fm-fleet-view.sh", None, False),
    "review_diff": ("fm-review-diff.sh", _build_review_diff, False),
    "bearings_snapshot": ("fm-bearings-snapshot.sh", None, False),
    "wake_drain": ("fm-wake-drain.sh", None, False),
    "guard_check": ("fm-guard.sh", None, False),
    "remote_doctor": ("fm-remote-doctor.sh", None, False),
    "remote_file": ("fm-remote-file.sh", _build_remote_file, False),
    "remote_delta": ("fm-remote-delta-read.sh", _build_remote_delta, False),
    "handoff_status": (None, _build_handoff_status, False),
    "secondmate_nudge": ("fm-secondmate-reconcile.sh", _build_secondmate_nudge, True),
    "secondmate_restart": ("fm-secondmate-restart.sh", _build_secondmate_restart, True),
    "secondmate_report": ("fm-secondmate-report.sh", _build_secondmate_report, True),
    "remote_control": ("fm-remote-secondmate-control.sh", _build_remote_control, True),
    "handoff_move": ("fm-backlog-handoff.sh", _build_handoff_move, True),
    "harness_detect": ("fm-harness.sh", _build_harness_detect, False),
    "project_mode": ("fm-project-mode.sh", _build_project_mode, False),
    "lock_status": ("fm-lock.sh", None, False),
    "lease_check": ("fm-lease.sh", _build_lease_check, False),
    "bearings_board_path": ("fm-bearings-board.sh", None, False),
    "inbox_status": ("fm-inbox.sh", None, False),
    "inbox_list": ("fm-inbox.sh", None, False),
    "home_summary": (None, _build_home_summary, False),
    "contributions_snapshot": ("fm-contributions.sh", _build_contributions_snapshot, False),
    "contributions_pending": ("fm-contributions.sh", None, False),
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
        data_override = os.environ.get("FM_DATA_OVERRIDE")
        self.data_dir = Path(data_override) if data_override else self.home / "data"
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

    def tool_peek(self, args):
        argv, error = _build_peek(args)
        if error:
            return error
        result = self.owned_call(argv, "peek failed")
        if env.is_err(result):
            return result
        result = dict(result)
        result.update({
            "target": args.get("target"),
            "lines": v.valid_peek_lines(args.get("lines", 40)),
        })
        return result

    def tool_fleet_view(self, _args):
        return self.owned_call(["fm-fleet-view.sh"], "fleet view failed")

    def tool_review_diff(self, args):
        argv, error = _build_review_diff(args)
        if error:
            return error
        result = self.owned_call(argv, "review diff failed")
        if env.is_err(result):
            return result
        result = dict(result)
        result.update({"id": args.get("id"), "stat": bool(args.get("stat", False))})
        return result

    def tool_bearings_snapshot(self, _args):
        proc, error = self.run_script(["fm-bearings-snapshot.sh", "--json"])
        if error:
            return error
        if proc.returncode != 0:
            out, _ = truncate(proc.stderr or proc.stdout or "")
            return env.err("bearings-failed", "bearings failed",
                           exit=proc.returncode, output=out)
        if len(proc.stdout.encode("utf-8", "replace")) > MAX_OUTPUT_BYTES:
            return env.err("bearings-too-large",
                           "bearings too large for envelope")
        try:
            projection = json.loads(proc.stdout)
        except json.JSONDecodeError:
            out, _ = truncate(proc.stdout)
            return env.err("bearings-not-json", "bearings was not JSON",
                           output=out)
        if projection.get("schema") != BEARINGS_SCHEMA:
            return env.err("unexpected-bearings-schema",
                           "unexpected bearings schema",
                           schema=projection.get("schema"))
        return env.ok(**projection)

    def tool_wake_drain(self, _args):
        return self.owned_call(["fm-wake-drain.sh"], "wake drain failed")

    def tool_guard_check(self, _args):
        prev = os.environ.get("FM_GUARD_READ_ONLY")
        os.environ["FM_GUARD_READ_ONLY"] = "1"
        try:
            return self.owned_call(["fm-guard.sh"], "guard check failed")
        finally:
            if prev is None:
                os.environ.pop("FM_GUARD_READ_ONLY", None)
            else:
                os.environ["FM_GUARD_READ_ONLY"] = prev

    def tool_remote_doctor(self, _args):
        # Check mode only: the --fix repair path stays out of scope.
        return self.owned_call(["fm-remote-doctor.sh"], "doctor failed")

    def tool_remote_file(self, args):
        argv, error = _build_remote_file(args)
        if error:
            return error
        result = self.owned_call(argv, "remote file read failed")
        if env.is_err(result):
            return result
        result = dict(result)
        result.update({
            "path": args.get("path"),
            "max_bytes": v.valid_remote_max_bytes(
                args.get("max_bytes", v.REMOTE_FILE_DEFAULT_MAX_BYTES)),
        })
        return result

    def tool_remote_delta(self, args):
        argv, error = _build_remote_delta(args)
        if error:
            return error
        result = self.owned_call(argv, "remote delta read failed")
        if env.is_err(result):
            return result
        result = dict(result)
        result.update({
            "log": args.get("log"),
            "offset": v.valid_nonneg_int(args.get("offset", 0)),
        })
        return result

    def tool_handoff_status(self, args):
        _, error = _build_handoff_status(args)
        if error:
            return error
        lines = v.valid_handoff_lines(
            args.get("lines", v.HANDOFF_DEFAULT_LINES))
        handoff_dir = self.data_dir / "handoff"
        task_id = args.get("id")
        if task_id is None:
            try:
                names = sorted(p.name for p in handoff_dir.iterdir()
                               if p.is_file() and not p.is_symlink()
                               and p.name.endswith(".outbox.md"))
            except FileNotFoundError:
                return env.ok(outboxes=[])
            except OSError as exc:
                return env.err("cannot-read-handoff",
                               "cannot read handoff", detail=str(exc))
            outboxes = []
            for name in names:
                try:
                    text = (handoff_dir / name).read_text(
                        encoding="utf-8", errors="replace").splitlines()
                    size = (handoff_dir / name).stat().st_size
                except OSError as exc:
                    return env.err("cannot-read-handoff",
                                   "cannot read handoff", detail=str(exc))
                outboxes.append({
                    "id": name[: -len(".outbox.md")],
                    "bytes": size,
                    "total_lines": len(text),
                })
            return env.ok(outboxes=outboxes)
        path = v.confine_handoff_path(self.data_dir, task_id)
        if path is None:
            return ID_ERROR
        try:
            content = path.read_text(
                encoding="utf-8", errors="replace").splitlines()
            size = path.stat().st_size
        except FileNotFoundError:
            return env.err("no-handoff", "no handoff for id", id=task_id)
        except OSError as exc:
            return env.err("cannot-read-handoff",
                           "cannot read handoff", detail=str(exc))
        return env.ok(id=task_id, bytes=size, total_lines=len(content),
                      lines=content[-lines:])

    def tool_secondmate_nudge(self, args):
        argv, error = _build_secondmate_nudge(args)
        if error:
            return error
        return self.owned_call(argv, "reconcile notify refused or failed")

    def tool_secondmate_restart(self, args):
        argv, error = _build_secondmate_restart(args)
        if error:
            return error
        result = self.owned_call(argv, "secondmate restart refused or failed")
        if env.is_err(result):
            return result
        result = dict(result)
        result.update({"ids": args.get("ids")})
        return result

    def tool_secondmate_report(self, args):
        argv, error = _build_secondmate_report(args)
        if error:
            return error
        result = self.owned_call(argv, "secondmate report refused or failed")
        if env.is_err(result):
            return result
        result = dict(result)
        result.update({"verb": args.get("verb"), "corr": args.get("corr")})
        return result

    def tool_remote_control(self, args):
        argv, error = _build_remote_control(args)
        if error:
            return error
        verb = args.get("verb")
        result = self.owned_call(argv, "remote control refused or failed")
        if env.is_err(result):
            return result
        result = dict(result)
        result.update({"verb": verb, "id": args.get("id")})
        return result

    def tool_handoff_move(self, args):
        argv, error = _build_handoff_move(args)
        if error:
            return error
        result = self.owned_call(argv, "handoff refused or failed")
        if env.is_err(result):
            return result
        result = dict(result)
        if args.get("resume", False):
            result.update({"id": args.get("id"), "resumed": True})
        else:
            result.update({"id": args.get("id"), "keys": args.get("keys")})
        return result
    def tool_harness_detect(self, args):
        argv, error = _build_harness_detect(args)
        if error:
            return error
        mode = args.get("mode", "own")
        result = self.owned_call(argv, "harness detection failed")
        if env.is_err(result):
            return result
        result = dict(result)
        first = (result.get("stdout") or "").strip().splitlines()
        result.update({"mode": mode, "harness": first[0] if first else ""})
        return result

    def tool_project_mode(self, args):
        argv, error = _build_project_mode(args)
        if error:
            return error
        result = self.owned_call(argv, "project mode refused or failed")
        if env.is_err(result):
            return result
        result = dict(result)
        tokens = (result.get("stdout") or "").strip().split()
        if len(tokens) == 2:
            mode, yolo = tokens
        else:
            mode, yolo = None, None
        result.update({"project": args.get("project"),
                       "mode": mode, "yolo": yolo})
        return result

    def tool_lock_status(self, _args):
        # Status only: acquiring the per-home lock would steal firstmate's
        # own session lock, so only the read is mirrored.
        result = self.owned_call(["fm-lock.sh", "status"], "lock status failed")
        if env.is_err(result):
            return result
        result = dict(result)
        lines = (result.get("stdout") or "").strip().splitlines()
        line = lines[0] if lines else ""
        status = "unknown"
        if line == "lock: free":
            status = "free"
        elif line.startswith("lock: held"):
            status = "held"
        elif line.startswith("lock: stale"):
            status = "stale"
        elif line.startswith("lock: unreadable"):
            status = "unreadable"
        result.update({"status": status, "raw": line})
        return result

    def tool_lease_check(self, args):
        argv, error = _build_lease_check(args)
        if error:
            return error
        task_id = args.get("id")
        proc, run_error = self.run_script(argv)
        if run_error:
            return run_error
        out, out_trunc = truncate(proc.stdout or "")
        err_out, err_trunc = truncate(proc.stderr or "")
        if proc.returncode == 0:
            lines = out.strip().splitlines()
            holder = lines[0] if lines else ""
            record = env.ok(task_id=task_id, leased=True, holder=holder,
                            stdout_truncated=out_trunc,
                            stderr_truncated=err_trunc)
            parts = holder.split()
            if len(parts) == 4:
                actor, pid, epoch, live = parts
                try:
                    pid_num, epoch_num = int(pid), int(epoch)
                except ValueError:
                    pid_num, epoch_num = None, None
                record.update({"actor": actor, "pid": pid_num,
                               "epoch": epoch_num, "live": live == "live"})
            return record
        if proc.returncode == 1 and not out.strip():
            return env.ok(task_id=task_id, leased=False)
        return env.err("lease-check-failed", "lease check failed",
                       exit=proc.returncode, stdout=out, stderr=err_out)

    def tool_bearings_board_path(self, _args):
        # Path only: build proves a live lavish session and binds the
        # keyed-answer intake — interactive captain surface that stays out.
        result = self.owned_call(["fm-bearings-board.sh", "path"],
                                 "bearings board path failed")
        if env.is_err(result):
            return result
        result = dict(result)
        result.update({"path": (result.get("stdout") or "").strip()})
        return result

    def tool_inbox_status(self, _args):
        return self.owned_call(["fm-inbox.sh", "status"], "inbox status failed")

    def tool_inbox_list(self, _args):
        return self.owned_call(["fm-inbox.sh", "list"], "inbox list failed")

    def tool_home_summary(self, _args):
        try:
            root = self.state_dir.resolve()
        except OSError:
            return env.err("no-home-summary", "no home summary",
                           expect="published state/home-summary.json in the served home")
        path = (root / "home-summary.json").resolve()
        if path.parent != root:
            return env.err("no-home-summary", "no home summary",
                           expect="published state/home-summary.json in the served home")
        try:
            raw = path.read_bytes()
        except FileNotFoundError:
            return env.err("no-home-summary", "no home summary",
                           expect="published state/home-summary.json in the served home")
        except OSError as exc:
            return env.err("cannot-read-home-summary",
                           "cannot read home summary", detail=str(exc))
        if len(raw) > MAX_OUTPUT_BYTES:
            return env.err("home-summary-too-large",
                           "home summary too large for envelope")
        try:
            summary = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            out, _ = truncate(raw.decode("utf-8", "replace"))
            return env.err("home-summary-not-json",
                           "home summary was not JSON", output=out)
        if not isinstance(summary, dict) or \
                summary.get("schema") != HOME_SUMMARY_SCHEMA:
            schema = summary.get("schema") if isinstance(summary, dict) else None
            return env.err("unexpected-home-summary-schema",
                           "unexpected home summary schema", schema=schema)
        return env.ok(**summary)

    def tool_contributions_snapshot(self, args):
        _argv_check, error = _build_contributions_snapshot(args)
        if error:
            return error
        want_all = bool(args.get("all", False))
        staged, stage_error = self._contribution_input()
        if stage_error:
            return stage_error
        tmp = None
        try:
            with tempfile.NamedTemporaryFile("w", suffix=".json",
                                              delete=False) as handle:
                handle.write(staged)
                tmp = handle.name
            argv = _argv("fm-contributions.sh", "snapshot", tmp)
            if want_all:
                argv.append("--all")
            proc, run_error = self.run_script(argv)
            if run_error:
                return run_error
            if proc.returncode != 0:
                out, _ = truncate(proc.stderr or proc.stdout or "")
                return env.err("contributions-failed",
                               "contributions snapshot failed",
                               exit=proc.returncode, output=out)
            if len(proc.stdout.encode("utf-8", "replace")) > MAX_OUTPUT_BYTES:
                return env.err("contributions-too-large",
                               "contributions too large for envelope")
            try:
                projection = json.loads(proc.stdout)
            except json.JSONDecodeError:
                out, _ = truncate(proc.stdout)
                return env.err("contributions-not-json",
                               "contributions was not JSON", output=out)
            if not isinstance(projection, dict):
                out, _ = truncate(proc.stdout)
                return env.err("contributions-not-json",
                               "contributions was not JSON", output=out)
        finally:
            if tmp:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
        projection = dict(projection)
        projection["all"] = want_all
        return env.ok(**projection)

    def _contribution_input(self):
        """Stage the canonical backlog/tasks ownership pair for a snapshot."""
        proc, run_error = self.run_script(
            ["fm-fleet-snapshot.sh", "--contribution-input"])
        if run_error:
            return None, run_error
        if proc.returncode != 0:
            out, _ = truncate(proc.stderr or proc.stdout or "")
            return None, env.err("contribution-input-failed",
                                  "contribution input failed",
                                  exit=proc.returncode, output=out)
        if len(proc.stdout.encode("utf-8", "replace")) > MAX_OUTPUT_BYTES:
            return None, env.err("contribution-input-failed",
                                  "contribution input failed",
                                  detail="contribution input too large for envelope")
        return proc.stdout, None

    def tool_contributions_pending(self, _args):
        proc, run_error = self.run_script(["fm-contributions.sh", "pending"])
        if run_error:
            return run_error
        if proc.returncode != 0:
            out, _ = truncate(proc.stderr or proc.stdout or "")
            return env.err("contributions-pending-failed",
                           "contributions pending failed",
                           exit=proc.returncode, output=out)
        if len(proc.stdout.encode("utf-8", "replace")) > MAX_OUTPUT_BYTES:
            return env.err("contributions-too-large",
                           "contributions too large for envelope")
        try:
            pending = json.loads(proc.stdout)
        except json.JSONDecodeError:
            out, _ = truncate(proc.stdout)
            return env.err("contributions-pending-not-json",
                           "contributions pending was not JSON", output=out)
        if not isinstance(pending, list):
            out, _ = truncate(proc.stdout)
            return env.err("contributions-pending-not-json",
                           "contributions pending was not JSON", output=out)
        return env.ok(pending=pending)

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
