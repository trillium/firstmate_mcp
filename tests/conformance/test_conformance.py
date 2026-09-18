#!/usr/bin/env python3
"""Conformance fixtures: prove the adapter behaves like firstmate.

Runs the adapter's read tools against firstmate's REAL bin/fm-*.sh scripts
in a scratch FM_HOME, then replays the same inputs directly against those
scripts and asserts both paths agree.

Equivalence here means: for the same read input, the adapter's typed
projection equals the owning script's observable output (modulo the envelope
wrap and the `generated` timestamp). The adapter may be STRICTER than the
script on invalid input (refusing traversal before spawning a process where
the script answers a lax `unknown`); stricter-is-conformant, and the suite
pins that direction. The reverse - the adapter accepting what the script
refuses - fails.

Side-effect-free by construction, asserted in TestSideEffectFree:
  * only read tools ever dispatch (fleet_snapshot, backlog, crew_state,
    status_tail, fleet_poll, peek, fleet_view, review_diff,
    bearings_snapshot, wake_drain, guard_check, remote_doctor,
    remote_file, remote_delta, handoff_status, harness_detect,
    project_mode, lock_status, lease_check, bearings_board_path,
    inbox_status, inbox_list, home_summary, contributions_snapshot,
    contributions_pending); any other tool name raises in the wrapper.
  * every subprocess runs with FM_HOME/FM_STATE_OVERRIDE pinned to a temp
    scratch dir; the suite asserts the snapshot's own fm_home/roots.state
    resolve inside that scratch dir.
  * the scratch home is never the live checkout: FM_HOME != FIRSTMATE_HOME.
  * every spawned process is captured carrying FM_HOME=<scratch>; the live
    fleet is busy (concurrent status appends), so a live dir-listing
    fingerprint would flake - per-process env capture is the proof.
  * send/lifecycle/spawn/brief/decision/relay tools are never dispatched,
    so no steer, launch, or external send can fire.

Locating firstmate: FIRSTMATE_HOME (else FM_REAL_HOME, FM_CHECKOUT, then the
well-known checkout path). Without a checkout carrying the read-script set
(fleet-snapshot, crew-state, peek, fleet-view, review-diff,
bearings-snapshot, wake-drain, guard, harness, project-mode, lock, lease,
bearings-board, inbox, contributions) the suite skips cleanly so
this repo stays standalone in CI.
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from adapter import dispatch as d
from adapter import envelope as env

SNAPSHOT_SCHEMA = "fm-fleet-snapshot.v1"
SUBPROCESS_TIMEOUT_S = 60

# Read-only boundary: the only tools this suite may dispatch.
READ_TOOLS = frozenset({
    "fleet_snapshot", "backlog", "crew_state", "status_tail", "fleet_poll",
    "peek", "fleet_view", "review_diff", "bearings_snapshot",
    "wake_drain", "guard_check", "remote_doctor", "remote_file",
    "remote_delta", "handoff_status", "harness_detect", "project_mode",
    "lock_status", "lease_check", "bearings_board_path", "inbox_status",
    "inbox_list", "home_summary", "contributions_snapshot",
    "contributions_pending",
})

# Scripts the suite may execute. Anything else fails closed at the runner.
READ_SCRIPTS = frozenset({
    "fm-fleet-snapshot.sh", "fm-crew-state.sh", "fm-peek.sh",
    "fm-fleet-view.sh", "fm-review-diff.sh", "fm-bearings-snapshot.sh",
    "fm-wake-drain.sh", "fm-guard.sh", "fm-remote-doctor.sh",
    "fm-remote-file.sh", "fm-remote-delta-read.sh", "fm-harness.sh",
    "fm-project-mode.sh", "fm-lock.sh", "fm-lease.sh",
    "fm-bearings-board.sh", "fm-inbox.sh", "fm-contributions.sh",
})


def find_firstmate_home():
    for var in ("FIRSTMATE_HOME", "FM_REAL_HOME", "FM_CHECKOUT"):
        candidate = os.environ.get(var)
        if candidate and (Path(candidate) / "bin" / "fm-fleet-snapshot.sh").is_file():
            return Path(candidate)
    for candidate in (ROOT.parent / "firstmate",):
        if (candidate / "bin" / "fm-fleet-snapshot.sh").is_file():
            return candidate
    return None


FIRSTMATE_HOME = find_firstmate_home()
REQUIRED_SCRIPTS = ("fm-fleet-snapshot.sh", "fm-crew-state.sh",
                    "fm-peek.sh", "fm-fleet-view.sh", "fm-review-diff.sh",
                    "fm-bearings-snapshot.sh", "fm-wake-drain.sh", "fm-guard.sh",
                    "fm-remote-doctor.sh", "fm-remote-file.sh",
                    "fm-remote-delta-read.sh", "fm-harness.sh",
                    "fm-project-mode.sh", "fm-lock.sh", "fm-lease.sh",
                    "fm-bearings-board.sh", "fm-inbox.sh",
                    "fm-contributions.sh")


def scratch_env(scratch):
    merged = dict(os.environ)
    merged["FM_HOME"] = str(scratch)
    merged["FM_STATE_OVERRIDE"] = str(scratch / "state")
    return merged


def run_direct(script, args, env):
    proc = subprocess.run(
        [str(FIRSTMATE_HOME / "bin" / script)] + list(args),
        capture_output=True,
        text=True,
        timeout=SUBPROCESS_TIMEOUT_S,
        env=env,
    )
    return proc


class GuardedRunner:
    """subprocess.run wrapper: pins scratch env, records every invocation."""

    def __init__(self, scratch):
        self.scratch = scratch
        self.calls = []

    def __call__(self, argv, **kwargs):
        script = Path(str(argv[0])).name
        if script not in READ_SCRIPTS:
            raise AssertionError(f"conformance must stay read-only: {script}")
        kwargs = dict(kwargs)
        kwargs["env"] = scratch_env(self.scratch)
        kwargs.setdefault("timeout", SUBPROCESS_TIMEOUT_S)
        self.calls.append({
            "argv": [str(a) for a in argv],
            "script": script,
            "fm_home": kwargs["env"].get("FM_HOME"),
        })
        return subprocess.run(argv, **kwargs)

    def scripts_run(self):
        return {call["script"] for call in self.calls}


class ConformanceBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if FIRSTMATE_HOME is None:
            raise unittest.SkipTest(
                "no firstmate checkout: set FIRSTMATE_HOME to run conformance"
            )
        for script in REQUIRED_SCRIPTS:
            if not (FIRSTMATE_HOME / "bin" / script).is_file():
                raise unittest.SkipTest(f"firstmate checkout lacks bin/{script}")

    def setUp(self):
        self.scratch = Path(tempfile.mkdtemp(prefix="fm-conformance-"))
        (self.scratch / "state").mkdir(exist_ok=True)
        (self.scratch / "data").mkdir(exist_ok=True)
        (self.scratch / "config").mkdir(exist_ok=True)
        # Never serve the live fleet out of this suite.
        self.assertNotEqual(
            self.scratch.resolve(), FIRSTMATE_HOME.resolve(),
            "scratch home must not be the live checkout",
        )
        self.runner = GuardedRunner(self.scratch)
        self.adapter = d.Adapter(
            home=str(self.scratch),
            checkout_root=str(FIRSTMATE_HOME),
            runner=self.runner,
        )
        raw_dispatch = self.adapter.dispatch

        def read_only_dispatch(name, args):
            if name not in READ_TOOLS:
                raise AssertionError(
                    f"conformance dispatches reads only, refused: {name}"
                )
            return raw_dispatch(name, args)

        self.adapter.dispatch = read_only_dispatch
        self.env = scratch_env(self.scratch)

    def tearDown(self):
        import shutil

        shutil.rmtree(self.scratch, ignore_errors=True)

    def direct_snapshot(self):
        proc = run_direct("fm-fleet-snapshot.sh", ["--json"], self.env)
        self.assertEqual(proc.returncode, 0, f"snapshot failed: {proc.stderr[:500]}")
        return json.loads(proc.stdout)


class SnapshotEquivalenceTest(ConformanceBase):
    def test_fleet_snapshot_matches_direct(self):
        direct = self.direct_snapshot()
        result = self.adapter.dispatch("fleet_snapshot", {})
        self.assertTrue(env.is_ok(result), result)
        snap = result["snapshot"]
        self.assertEqual(snap["schema"], SNAPSHOT_SCHEMA)
        self.assertEqual(snap["schema"], direct["schema"])
        self.assertEqual(snap["tasks"], direct["tasks"])
        self.assertEqual(snap["backlog"], direct["backlog"])
        self.assertEqual(snap.get("main_inventory"), direct.get("main_inventory"))

    def test_backlog_derives_counts_from_same_snapshot(self):
        direct = self.direct_snapshot()
        result = self.adapter.dispatch("backlog", {})
        self.assertTrue(env.is_ok(result), result)
        by_state = {}
        for task in direct.get("tasks", []):
            state = ((task.get("current_state") or {}).get("state")) or "unknown"
            by_state[state] = by_state.get(state, 0) + 1
        self.assertEqual(result["task_counts"]["total"], len(direct.get("tasks", [])))
        self.assertEqual(result["task_counts"]["by_state"], by_state)
        self.assertEqual(result["backlog"], direct["backlog"])

    def test_fleet_poll_agrees_with_snapshot(self):
        direct = self.direct_snapshot()
        result = self.adapter.dispatch("fleet_poll", {"count": 2, "interval_s": 0})
        self.assertTrue(env.is_ok(result), result)
        self.assertEqual(len(result["polls"]), 2)
        for poll in result["polls"]:
            self.assertEqual(poll["tasks"], len(direct.get("tasks", [])))


class CrewStateEquivalenceTest(ConformanceBase):
    def test_crew_state_unknown_matches_direct_line(self):
        proc = run_direct("fm-crew-state.sh", ["no-such-crew"], self.env)
        direct_line = (proc.stdout or "").strip().splitlines()[0]
        result = self.adapter.dispatch("crew_state", {"id": "no-such-crew"})
        self.assertTrue(env.is_ok(result), result)
        self.assertEqual(result["raw"], direct_line)
        self.assertEqual(result["current"]["state"], "unknown")
        self.assertIn("unknown", direct_line)

    def test_adapter_stricter_than_script_on_traversal(self):
        """Stricter-is-conformant: the adapter refuses traversal without
        spawning; the raw script answers a lax `unknown` line."""
        before = len(self.runner.calls)
        result = self.adapter.dispatch("crew_state", {"id": "../escape"})
        self.assertTrue(env.is_err(result), result)
        self.assertEqual(result["error"]["code"], "invalid-id")
        self.assertEqual(len(self.runner.calls), before,
                         "rejected input must not spawn a process")


class StatusTailEquivalenceTest(ConformanceBase):
    def test_status_tail_matches_file_tail(self):
        lines = [f"event-{i}: working" for i in range(1, 8)]
        (self.scratch / "state" / "t1.status").write_text(
            "\n".join(lines) + "\n", encoding="utf-8"
        )
        result = self.adapter.dispatch("status_tail", {"id": "t1", "lines": 3})
        self.assertTrue(env.is_ok(result), result)
        self.assertEqual(result["events"], lines[-3:])
        self.assertIn("warning", result)

    def test_status_tail_missing_id_agrees_with_empty_state(self):
        result = self.adapter.dispatch("status_tail", {"id": "ghost-crew"})
        self.assertTrue(env.is_err(result), result)
        self.assertEqual(result["error"]["code"], "no-status-log")

    def test_status_tail_rejects_traversal_without_read(self):
        (self.scratch / "state" / "t1.status").write_text("x\n", encoding="utf-8")
        result = self.adapter.dispatch("status_tail", {"id": "../escape"})
        self.assertTrue(env.is_err(result), result)
        self.assertEqual(result["error"]["code"], "invalid-id")
        self.assertEqual(self.runner.calls, [],
                         "status_tail must never spawn a process")


def _assert_text_matches(testcase, result, proc):
    """Adapter owned-call text agrees with the direct script run.

    Success matches stdout (modulo the 8KB envelope truncation); failure
    matches the exit code with the script output carried in the payload.
    """
    from adapter import dispatch as _d
    cap = _d.TAIL_CAP_BYTES
    if proc.returncode == 0:
        testcase.assertTrue(env.is_ok(result), result)
        direct_out = proc.stdout or ""
        if len(direct_out.encode("utf-8", "replace")) <= cap:
            testcase.assertEqual(result["stdout"], direct_out)
            testcase.assertFalse(result["stdout_truncated"])
        else:
            testcase.assertTrue(result["stdout_truncated"])
            testcase.assertTrue(direct_out.startswith(
                result["stdout"].split("\n…[truncated]")[0][:100]))
    else:
        testcase.assertTrue(env.is_err(result), result)
        testcase.assertEqual(result["error"].get("exit"), proc.returncode)


class TestPeekEquivalence(ConformanceBase):
    def test_peek_matches_direct(self):
        proc = run_direct("fm-peek.sh", ["no-such-crew", "5"], self.env)
        result = self.adapter.dispatch("peek", {"target": "no-such-crew", "lines": 5})
        _assert_text_matches(self, result, proc)
        if env.is_ok(result):
            self.assertEqual(result["target"], "no-such-crew")
            self.assertEqual(result["lines"], 5)

    def test_peek_rejects_traversal_without_spawn(self):
        before = len(self.runner.calls)
        result = self.adapter.dispatch("peek", {"target": "../escape"})
        self.assertTrue(env.is_err(result), result)
        self.assertEqual(result["error"]["code"], "invalid-target")
        self.assertEqual(len(self.runner.calls), before)

    def test_peek_rejects_bad_lines(self):
        result = self.adapter.dispatch("peek", {"target": "x", "lines": "many"})
        self.assertTrue(env.is_err(result), result)
        self.assertEqual(result["error"]["code"], "invalid-lines")


class TestFleetViewEquivalence(ConformanceBase):
    def test_fleet_view_matches_direct(self):
        proc = run_direct("fm-fleet-view.sh", [], self.env)
        result = self.adapter.dispatch("fleet_view", {})
        _assert_text_matches(self, result, proc)


class TestReviewDiffEquivalence(ConformanceBase):
    def test_review_diff_missing_meta_agrees(self):
        proc = run_direct("fm-review-diff.sh", ["no-such-crew"], self.env)
        result = self.adapter.dispatch("review_diff", {"id": "no-such-crew"})
        self.assertNotEqual(proc.returncode, 0)
        self.assertTrue(env.is_err(result), result)
        self.assertEqual(result["error"].get("exit"), proc.returncode)

    def test_review_diff_rejects_traversal_without_spawn(self):
        before = len(self.runner.calls)
        result = self.adapter.dispatch("review_diff", {"id": "../escape"})
        self.assertTrue(env.is_err(result), result)
        self.assertEqual(result["error"]["code"], "invalid-id")
        self.assertEqual(len(self.runner.calls), before)

    def test_review_diff_rejects_non_bool_stat(self):
        result = self.adapter.dispatch("review_diff", {"id": "x", "stat": "yes"})
        self.assertTrue(env.is_err(result), result)
        self.assertEqual(result["error"]["code"], "invalid-stat")


class TestBearingsEquivalence(ConformanceBase):
    def test_bearings_matches_direct(self):
        proc = run_direct("fm-bearings-snapshot.sh", ["--json"], self.env)
        self.assertEqual(proc.returncode, 0, f"bearings failed: {proc.stderr[:500]}")
        direct = json.loads(proc.stdout)
        result = self.adapter.dispatch("bearings_snapshot", {})
        self.assertTrue(env.is_ok(result), result)
        self.assertEqual(result["schema"], "fm-bearings.v1")
        self.assertEqual(result["schema"], direct["schema"])
        for key in ("in_flight", "decisions_open", "landed", "omitted"):
            self.assertEqual(result.get(key), direct.get(key), key)


class TestWakeDrainEquivalence(ConformanceBase):
    def test_wake_drain_matches_direct(self):
        proc = run_direct("fm-wake-drain.sh", [], self.env)
        result = self.adapter.dispatch("wake_drain", {})
        _assert_text_matches(self, result, proc)


class TestGuardCheckEquivalence(ConformanceBase):
    def test_guard_matches_direct_read_only(self):
        guard_env = dict(self.env)
        guard_env["FM_GUARD_READ_ONLY"] = "1"
        proc = run_direct("fm-guard.sh", [], guard_env)
        result = self.adapter.dispatch("guard_check", {})
        self.assertEqual(proc.returncode, 0)
        _assert_text_matches(self, result, proc)


class TestRemoteDoctorEquivalence(ConformanceBase):
    def test_doctor_matches_direct_check_mode(self):
        proc = run_direct("fm-remote-doctor.sh", [], self.env)
        result = self.adapter.dispatch("remote_doctor", {})
        _assert_text_matches(self, result, proc)


class TestRemoteFileEquivalence(ConformanceBase):
    def test_file_get_matches_direct(self):
        rel = "data/probe.txt"
        target = self.scratch / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("probe-bytes\n", encoding="utf-8")
        proc = run_direct("fm-remote-file.sh", ["get", rel, "8192"], self.env)
        result = self.adapter.dispatch("remote_file", {"path": rel})
        _assert_text_matches(self, result, proc)
        if env.is_ok(result):
            self.assertEqual(result["path"], rel)
            self.assertEqual(result["max_bytes"], 8192)

    def test_file_rejects_traversal_without_spawn(self):
        before = len(self.runner.calls)
        result = self.adapter.dispatch("remote_file", {"path": "../escape"})
        self.assertTrue(env.is_err(result), result)
        self.assertEqual(result["error"]["code"], "invalid-path")
        self.assertEqual(len(self.runner.calls), before)

    def test_file_rejects_bad_bytes(self):
        result = self.adapter.dispatch(
            "remote_file", {"path": "data/x.md", "max_bytes": "big"})
        self.assertTrue(env.is_err(result), result)
        self.assertEqual(result["error"]["code"], "invalid-max-bytes")


class TestRemoteDeltaEquivalence(ConformanceBase):
    EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

    def test_delta_matches_direct(self):
        rel = "state/job.log"
        target = self.scratch / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("delta-line-1\n", encoding="utf-8")
        proc = run_direct("fm-remote-delta-read.sh",
                          [rel, "0", self.EMPTY_SHA, "0"], self.env)
        result = self.adapter.dispatch(
            "remote_delta",
            {"log": rel, "offset": 0, "sha256": self.EMPTY_SHA})
        _assert_text_matches(self, result, proc)
        if env.is_ok(result):
            self.assertEqual(result["log"], rel)
            self.assertEqual(result["offset"], 0)

    def test_delta_rejects_bad_cursor_without_spawn(self):
        before = len(self.runner.calls)
        good = {"log": "state/job.log", "offset": 0,
                "sha256": self.EMPTY_SHA}
        for key, value, code in (("log", "../x", "invalid-path"),
                                 ("offset", -1, "invalid-offset"),
                                 ("sha256", "short", "invalid-sha256"),
                                 ("wait", "long", "invalid-wait")):
            with self.subTest(field=key):
                args = dict(good, **{key: value})
                result = self.adapter.dispatch("remote_delta", args)
                self.assertTrue(env.is_err(result), key)
                self.assertEqual(result["error"]["code"], code, key)
        self.assertEqual(len(self.runner.calls), before)


class TestHandoffStatusEquivalence(ConformanceBase):
    def test_handoff_lists_staged_outboxes(self):
        handoff = self.scratch / "data" / "handoff"
        handoff.mkdir(parents=True)
        (handoff / "m1.outbox.md").write_text(
            "- [ ] k1 first\n- [ ] k2 second\n", encoding="utf-8")
        (handoff / "notes.txt").write_text("ignored\n", encoding="utf-8")
        result = self.adapter.dispatch("handoff_status", {})
        self.assertTrue(env.is_ok(result), result)
        self.assertEqual(len(result["outboxes"]), 1)
        self.assertEqual(result["outboxes"][0]["id"], "m1")
        self.assertEqual(result["outboxes"][0]["total_lines"], 2)
        self.assertEqual(self.runner.calls, [],
                         "handoff_status must never spawn a process")

    def test_handoff_detail_matches_file_tail(self):
        handoff = self.scratch / "data" / "handoff"
        handoff.mkdir(parents=True)
        lines = ["- [ ] k1 first", "- [ ] k2 second", "- [ ] k3 third"]
        (handoff / "m1.outbox.md").write_text(
            "\n".join(lines) + "\n", encoding="utf-8")
        result = self.adapter.dispatch(
            "handoff_status", {"id": "m1", "lines": 2})
        self.assertTrue(env.is_ok(result), result)
        self.assertEqual(result["lines"], lines[-2:])
        self.assertEqual(result["total_lines"], 3)

    def test_handoff_missing_id_is_typed_error(self):
        (self.scratch / "data" / "handoff").mkdir(parents=True)
        result = self.adapter.dispatch("handoff_status", {"id": "ghost"})
        self.assertTrue(env.is_err(result), result)
        self.assertEqual(result["error"]["code"], "no-handoff")

    def test_handoff_rejects_traversal_without_read(self):
        result = self.adapter.dispatch("handoff_status", {"id": "../escape"})
        self.assertTrue(env.is_err(result), result)
        self.assertEqual(result["error"]["code"], "invalid-id")
        self.assertEqual(self.runner.calls, [],
                         "handoff_status must never spawn a process")
class TestHarnessEquivalence(ConformanceBase):
    MODES = ("own", "crew", "secondmate", "secondmate-model",
             "secondmate-effort")

    def test_harness_modes_match_direct(self):
        for mode in self.MODES:
            with self.subTest(mode=mode):
                argv = [] if mode == "own" else [mode]
                proc = run_direct("fm-harness.sh", argv, self.env)
                self.assertEqual(proc.returncode, 0)
                args = {} if mode == "own" else {"mode": mode}
                result = self.adapter.dispatch("harness_detect", args)
                self.assertTrue(env.is_ok(result), result)
                self.assertEqual(result["mode"], mode)
                self.assertEqual(result["stdout"], proc.stdout)
                first = proc.stdout.strip().splitlines()
                self.assertEqual(result["harness"], first[0] if first else "")

    def test_harness_rejects_unknown_mode_without_spawn(self):
        before = len(self.runner.calls)
        result = self.adapter.dispatch("harness_detect", {"mode": "ancestry"})
        self.assertTrue(env.is_err(result), result)
        self.assertEqual(result["error"]["code"], "invalid-mode")
        self.assertEqual(len(self.runner.calls), before)


class TestProjectModeEquivalence(ConformanceBase):
    def test_project_mode_matches_direct(self):
        proc = run_direct("fm-project-mode.sh", ["conformance-probe"], self.env)
        self.assertEqual(proc.returncode, 0)
        result = self.adapter.dispatch("project_mode", {"project": "conformance-probe"})
        self.assertTrue(env.is_ok(result), result)
        self.assertEqual(result["stdout"], proc.stdout)
        tokens = proc.stdout.strip().split()
        self.assertEqual(len(tokens), 2)
        self.assertEqual(result["project"], "conformance-probe")
        self.assertEqual(result["mode"], tokens[0])
        self.assertEqual(result["yolo"], tokens[1])

    def test_project_mode_rejects_traversal_without_spawn(self):
        before = len(self.runner.calls)
        result = self.adapter.dispatch("project_mode", {"project": "../escape"})
        self.assertTrue(env.is_err(result), result)
        self.assertEqual(result["error"]["code"], "invalid-project")
        self.assertEqual(len(self.runner.calls), before)


class TestLockStatusEquivalence(ConformanceBase):
    def test_lock_status_matches_direct(self):
        proc = run_direct("fm-lock.sh", ["status"], self.env)
        self.assertEqual(proc.returncode, 0)
        result = self.adapter.dispatch("lock_status", {})
        self.assertTrue(env.is_ok(result), result)
        self.assertEqual(result["stdout"], proc.stdout)
        line = proc.stdout.strip().splitlines()[0]
        self.assertEqual(result["raw"], line)
        self.assertEqual(result["status"], "free")


class TestLeaseCheckEquivalence(ConformanceBase):
    def test_lease_check_unleased_matches_direct(self):
        proc = run_direct("fm-lease.sh", ["check", "ghost-task"], self.env)
        self.assertEqual(proc.returncode, 1)
        self.assertEqual((proc.stdout or "").strip(), "")
        result = self.adapter.dispatch("lease_check", {"id": "ghost-task"})
        self.assertTrue(env.is_ok(result), result)
        self.assertFalse(result["leased"])
        self.assertEqual(result["task_id"], "ghost-task")

    def test_lease_check_held_matches_direct(self):
        # Claim/release run directly: the mutations are out of the read
        # boundary by design, so only check dispatches through the adapter.
        claim = run_direct("fm-lease.sh", ["check", "probe-task"], self.env)
        self.assertEqual(claim.returncode, 1)
        claimed = run_direct(
            "fm-lease.sh", ["claim", "probe-task", "--actor", "main"], self.env)
        self.assertEqual(claimed.returncode, 0, claimed.stderr[:500])
        try:
            proc = run_direct("fm-lease.sh", ["check", "probe-task"], self.env)
            self.assertEqual(proc.returncode, 0)
            result = self.adapter.dispatch("lease_check", {"id": "probe-task"})
            self.assertTrue(env.is_ok(result), result)
            self.assertTrue(result["leased"])
            line = proc.stdout.strip().splitlines()[0]
            self.assertEqual(result["holder"], line)
            actor, pid, epoch, live = line.split()
            self.assertEqual(result["actor"], actor)
            self.assertEqual(result["pid"], int(pid))
            self.assertEqual(result["epoch"], int(epoch))
            self.assertEqual(result["live"], live == "live")
        finally:
            run_direct("fm-lease.sh", ["release", "probe-task",
                                         "--actor", "main"], self.env)

    def test_lease_check_rejects_traversal_without_spawn(self):
        before = len(self.runner.calls)
        result = self.adapter.dispatch("lease_check", {"id": "../escape"})
        self.assertTrue(env.is_err(result), result)
        self.assertEqual(result["error"]["code"], "invalid-id")
        self.assertEqual(len(self.runner.calls), before)


class TestBearingsBoardEquivalence(ConformanceBase):
    def test_board_path_matches_direct(self):
        proc = run_direct("fm-bearings-board.sh", ["path"], self.env)
        self.assertEqual(proc.returncode, 0)
        result = self.adapter.dispatch("bearings_board_path", {})
        self.assertTrue(env.is_ok(result), result)
        self.assertEqual(result["stdout"], proc.stdout)
        self.assertEqual(result["path"], proc.stdout.strip())
        self.assertTrue(result["path"].startswith(str(self.scratch)))


def _assert_inbox_status_matches(testcase, result, proc):
    """Inbox status carries a wall-clock `time` line, so exact stdout
    equality would flake across a second boundary; normalize it away."""
    import re as _re
    testcase.assertEqual(proc.returncode, 0)
    testcase.assertTrue(env.is_ok(result), result)
    normalize = lambda text: _re.sub(r"(?m)^time\s+\S+", "time STAMP", text or "")
    testcase.assertEqual(normalize(result["stdout"]), normalize(proc.stdout))


class TestInboxEquivalence(ConformanceBase):
    def test_inbox_status_matches_direct(self):
        proc = run_direct("fm-inbox.sh", ["status"], self.env)
        result = self.adapter.dispatch("inbox_status", {})
        _assert_inbox_status_matches(self, result, proc)

    def test_inbox_list_matches_direct(self):
        proc = run_direct("fm-inbox.sh", ["list"], self.env)
        self.assertEqual(proc.returncode, 0)
        result = self.adapter.dispatch("inbox_list", {})
        _assert_text_matches(self, result, proc)


class TestHomeSummaryEquivalence(ConformanceBase):
    LEDGER = {
        "schema": "fm-secondmate-home-summary.v1",
        "generated": "2026-09-18T00:00:00Z",
        "generated_epoch": 1700000000,
        "state": "idle",
        "counts": {},
    }

    def test_home_summary_matches_ledger(self):
        (self.scratch / "state" / "home-summary.json").write_text(
            json.dumps(self.LEDGER), encoding="utf-8"
        )
        result = self.adapter.dispatch("home_summary", {})
        self.assertTrue(env.is_ok(result), result)
        for key, value in self.LEDGER.items():
            self.assertEqual(result.get(key), value, key)
        self.assertEqual(self.runner.calls, [],
                         "home_summary must never spawn a process")

    def test_home_summary_missing_is_typed_error(self):
        result = self.adapter.dispatch("home_summary", {})
        self.assertTrue(env.is_err(result), result)
        self.assertEqual(result["error"]["code"], "no-home-summary")
        self.assertEqual(self.runner.calls, [],
                         "home_summary must never spawn a process")

    def test_home_summary_rejects_wrong_schema(self):
        (self.scratch / "state" / "home-summary.json").write_text(
            json.dumps({"schema": "other.v9"}), encoding="utf-8"
        )
        result = self.adapter.dispatch("home_summary", {})
        self.assertTrue(env.is_err(result), result)
        self.assertEqual(result["error"]["code"],
                         "unexpected-home-summary-schema")


class TestContributionsEquivalence(ConformanceBase):
    def _stage_input(self):
        proc = run_direct("fm-fleet-snapshot.sh", ["--contribution-input"],
                          self.env)
        self.assertEqual(proc.returncode, 0, proc.stderr[:500])
        staged = self.scratch / "contribution-input.json"
        staged.write_text(proc.stdout, encoding="utf-8")
        return staged

    def test_contributions_snapshot_matches_direct(self):
        staged = self._stage_input()
        for want_all, extra in ((False, []), (True, ["--all"])):
            with self.subTest(all=want_all):
                proc = run_direct("fm-contributions.sh",
                                  ["snapshot", str(staged)] + extra, self.env)
                self.assertEqual(proc.returncode, 0, proc.stderr[:500])
                direct = json.loads(proc.stdout)
                result = self.adapter.dispatch(
                    "contributions_snapshot", {"all": want_all})
                self.assertTrue(env.is_ok(result), result)
                self.assertEqual(result["all"], want_all)
                claimed = dict(result)
                claimed.pop("all")
                # valid_until derives from the wall clock, which may tick
                # between the direct run and the adapter run; everything
                # else must agree exactly.
                for key in direct:
                    if key == "valid_until":
                        self.assertIsInstance(claimed.get(key), int)
                        continue
                    self.assertEqual(claimed.get(key), direct[key], key)

    def test_contributions_pending_matches_direct(self):
        proc = run_direct("fm-contributions.sh", ["pending"], self.env)
        self.assertEqual(proc.returncode, 0, proc.stderr[:500])
        result = self.adapter.dispatch("contributions_pending", {})
        self.assertTrue(env.is_ok(result), result)
        self.assertEqual(result["pending"], json.loads(proc.stdout))

    def test_contributions_rejects_bad_all_without_spawn(self):
        before = len(self.runner.calls)
        result = self.adapter.dispatch("contributions_snapshot", {"all": "yes"})
        self.assertTrue(env.is_err(result), result)
        self.assertEqual(result["error"]["code"], "invalid-all")
        self.assertEqual(len(self.runner.calls), before)


class TestSideEffectFree(ConformanceBase):
    def test_snapshot_served_from_scratch_home(self):
        result = self.adapter.dispatch("fleet_snapshot", {})
        self.assertTrue(env.is_ok(result), result)
        snap = result["snapshot"]
        self.assertEqual(snap.get("fm_home"), str(self.scratch))
        state_root = ((snap.get("roots") or {}).get("state")) or ""
        self.assertTrue(
            state_root.startswith(str(self.scratch)),
            f"snapshot state root escaped scratch: {state_root}",
        )

    def test_only_read_scripts_ever_execute(self):
        self.direct_snapshot()
        self.adapter.dispatch("fleet_snapshot", {})
        self.adapter.dispatch("backlog", {})
        self.adapter.dispatch("crew_state", {"id": "no-such-crew"})
        self.adapter.dispatch("fleet_poll", {"count": 1, "interval_s": 0})
        (self.scratch / "state" / "t1.status").write_text("a\n", encoding="utf-8")
        self.adapter.dispatch("status_tail", {"id": "t1"})
        self.adapter.dispatch("peek", {"target": "no-such-crew", "lines": 1})
        self.adapter.dispatch("fleet_view", {})
        self.adapter.dispatch("review_diff", {"id": "no-such-crew"})
        self.adapter.dispatch("bearings_snapshot", {})
        self.adapter.dispatch("wake_drain", {})
        self.adapter.dispatch("guard_check", {})
        self.adapter.dispatch("remote_doctor", {})
        (self.scratch / "data" / "probe.txt").write_text("p\n", encoding="utf-8")
        self.adapter.dispatch("remote_file", {"path": "data/probe.txt"})
        (self.scratch / "state" / "job.log").write_text("l\n", encoding="utf-8")
        self.adapter.dispatch("remote_delta", {
            "log": "state/job.log", "offset": 0,
            "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"})
        (self.scratch / "data" / "handoff").mkdir(parents=True, exist_ok=True)
        self.adapter.dispatch("handoff_status", {})
        self.adapter.dispatch("harness_detect", {})
        self.adapter.dispatch("project_mode", {"project": "probe"})
        self.adapter.dispatch("lock_status", {})
        self.adapter.dispatch("lease_check", {"id": "ghost-task"})
        self.adapter.dispatch("bearings_board_path", {})
        self.adapter.dispatch("inbox_status", {})
        self.adapter.dispatch("inbox_list", {})
        (self.scratch / "state" / "home-summary.json").write_text(
            json.dumps({"schema": "fm-secondmate-home-summary.v1",
                        "generated": "stub"}), encoding="utf-8")
        self.adapter.dispatch("home_summary", {})
        self.adapter.dispatch("contributions_snapshot", {})
        self.adapter.dispatch("contributions_pending", {})
        for script in self.runner.scripts_run():
            self.assertIn(script, READ_SCRIPTS, f"non-read script ran: {script}")

    def test_every_subprocess_ran_under_scratch_home(self):
        # The live fleet is busy (other agents append status concurrently),
        # so a live dir-listing fingerprint would flake. The deterministic
        # proof is stronger: every process this suite spawned carried
        # FM_HOME=<scratch>, never the live checkout.
        self.direct_snapshot()
        self.adapter.dispatch("fleet_snapshot", {})
        self.adapter.dispatch("crew_state", {"id": "no-such-crew"})
        self.assertGreaterEqual(len(self.runner.calls), 2)
        for call in self.runner.calls:
            self.assertEqual(call["fm_home"], str(self.scratch), call)
            self.assertNotEqual(call["fm_home"], str(FIRSTMATE_HOME), call)

    def test_write_tools_never_dispatch(self):
        for name in ("send_message", "lifecycle_interrupt", "spawn_crew",
                     "scaffold_brief", "decision_hold", "relay_reply",
                     "secondmate_nudge", "secondmate_restart",
                     "secondmate_report", "remote_control", "handoff_move"):
            with self.subTest(tool=name):
                with self.assertRaises(AssertionError):
                    self.adapter.dispatch(name, {})
        self.assertEqual(self.runner.calls, [],
                         "no subprocess may run for refused tools")


if __name__ == "__main__":
    unittest.main(verbosity=2)
