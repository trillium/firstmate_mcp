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
    bearings_snapshot, wake_drain, guard_check); any other tool name
    raises in the wrapper.
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
bearings-snapshot, wake-drain, guard) the suite skips cleanly so
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
    "wake_drain", "guard_check",
})

# Scripts the suite may execute. Anything else fails closed at the runner.
READ_SCRIPTS = frozenset({
    "fm-fleet-snapshot.sh", "fm-crew-state.sh", "fm-peek.sh",
    "fm-fleet-view.sh", "fm-review-diff.sh", "fm-bearings-snapshot.sh",
    "fm-wake-drain.sh", "fm-guard.sh",
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
                    "fm-bearings-snapshot.sh", "fm-wake-drain.sh", "fm-guard.sh")


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
                     "scaffold_brief", "decision_hold", "relay_reply"):
            with self.subTest(tool=name):
                with self.assertRaises(AssertionError):
                    self.adapter.dispatch(name, {})
        self.assertEqual(self.runner.calls, [],
                         "no subprocess may run for refused tools")


if __name__ == "__main__":
    unittest.main(verbosity=2)
