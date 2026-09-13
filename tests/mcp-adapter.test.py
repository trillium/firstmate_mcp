#!/usr/bin/env python3
"""Unit tests for the compatibility adapter (stdlib only, hermetic).

No real bin/ script ever runs: the Adapter takes a fake runner, and the
served home is a temp dir. Covers dispatch routing, validation rejections,
and the typed envelope shape.
"""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from adapter import dispatch as d
from adapter import envelope as env
from adapter import validators as v

APPROVAL = "I authorize adapter test use"


class FakeProc:
    def __init__(self, stdout="", stderr="", returncode=0):
        self.stdout = stdout
        self.stderr = stderr
        self.returncode = returncode


def make_adapter(**kwargs):
    home = tempfile.mkdtemp(prefix="fm-adapter-test-")
    seen = []

    def fake_runner(argv, **_kw):
        seen.append(argv)
        return kwargs.get("proc", FakeProc())

    adapter = d.Adapter(home=home, checkout_root=ROOT, runner=fake_runner)
    return adapter, seen, Path(home)


SNAPSHOT = {
    "schema": "fm-fleet-snapshot.v1",
    "generated": "2026-09-13T00:00:00Z",
    "backlog": {"open": []},
    "tasks": [
        {"id": "a", "current_state": {"state": "working"}},
        {"id": "b", "current_state": {"state": "done"}},
        {"id": "c"},
    ],
}


class ValidatorsTest(unittest.TestCase):
    def test_valid_ids(self):
        self.assertTrue(v.valid_id("abc"))
        self.assertTrue(v.valid_id("task-1a2b.3:x_y-z"))
        self.assertFalse(v.valid_id("../escape"))
        self.assertFalse(v.valid_id("a/b"))
        self.assertFalse(v.valid_id(""))
        self.assertFalse(v.valid_id(None))
        self.assertFalse(v.valid_id("x" * 70))

    def test_valid_projects(self):
        self.assertTrue(v.valid_project("myproj"))
        self.assertTrue(v.valid_project("projects/myproj"))
        self.assertFalse(v.valid_project("/abs/path"))
        self.assertFalse(v.valid_project("../up"))
        self.assertFalse(v.valid_project("a..b"))
        self.assertFalse(v.valid_project(""))

    def test_notes_and_approval(self):
        self.assertTrue(v.valid_note("one line"))
        self.assertFalse(v.valid_note("two\nlines"))
        self.assertFalse(v.valid_note(""))
        self.assertFalse(v.valid_note("z" * 501))
        self.assertTrue(v.valid_note("z" * 200, 200))
        self.assertFalse(v.valid_note("z" * 201, 200))
        self.assertTrue(v.valid_approval(APPROVAL))
        self.assertFalse(v.valid_approval("please do it"))
        self.assertFalse(v.valid_approval(None))

    def test_steer_text(self):
        self.assertTrue(v.valid_steer_text("hello crew"))
        self.assertFalse(v.valid_steer_text("/merge now"))
        self.assertFalse(v.valid_steer_text("  /slash with pad"))
        self.assertFalse(v.valid_steer_text("one\ntwo"))
        self.assertFalse(v.valid_steer_text("z" * 501))
        self.assertFalse(v.valid_steer_text(""))

    def test_status_lines_window(self):
        self.assertEqual(v.valid_status_lines(10), 10)
        self.assertEqual(v.valid_status_lines(999), 50)
        self.assertEqual(v.valid_status_lines(0), 1)
        self.assertIsNone(v.valid_status_lines("many"))
        self.assertIsNone(v.valid_status_lines(None))

    def test_confine_state_path(self):
        with tempfile.TemporaryDirectory() as home:
            state = Path(home) / "state"
            state.mkdir()
            ok_path = v.confine_state_path(state, "task-1")
            self.assertEqual(ok_path, (state / "task-1.status").resolve())
            self.assertIsNone(v.confine_state_path(state, "../escape"))
            self.assertIsNone(v.confine_state_path(state, "a/b"))


class EnvelopeTest(unittest.TestCase):
    def test_ok_shape(self):
        result = env.ok(snapshot={"a": 1})
        self.assertTrue(result["ok"])
        self.assertEqual(result["snapshot"], {"a": 1})
        self.assertTrue(env.is_ok(result))
        self.assertFalse(env.is_err(result))

    def test_err_shape(self):
        result = env.err("unknown-tool", "unknown tool: nope")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "unknown-tool")
        self.assertIn("nope", result["error"]["message"])
        self.assertTrue(env.is_err(result))
        self.assertFalse(env.is_ok(result))

    def test_err_carries_extra(self):
        result = env.err("invalid-id", "invalid id", expect="short task id")
        self.assertEqual(result["error"]["expect"], "short task id")


class DispatchRoutingTest(unittest.TestCase):
    def test_unknown_tool_is_typed_error(self):
        adapter, seen, _ = make_adapter()
        result = adapter.dispatch("nope", {})
        self.assertTrue(env.is_err(result))
        self.assertEqual(result["error"]["code"], "unknown-tool")
        self.assertEqual(seen, [])

    def test_non_dict_args_rejected(self):
        adapter, seen, _ = make_adapter()
        result = adapter.dispatch("fleet_snapshot", ["not", "a", "dict"])
        self.assertTrue(env.is_err(result))
        self.assertEqual(result["error"]["code"], "invalid-arguments")
        self.assertEqual(seen, [])

    def test_every_denied_surface_forbidden(self):
        adapter, seen, _ = make_adapter()
        for name in sorted(d.DENY_LIST):
            with self.subTest(tool=name):
                result = adapter.dispatch(name, {})
                self.assertTrue(env.is_err(result), name)
                self.assertEqual(result["error"]["code"], "forbidden", name)
        self.assertEqual(seen, [])

    def test_deny_list_covers_code_landing_and_daemon(self):
        for name in ("promote_scout", "teardown_crew", "arm_pr_check",
                     "merge_pr", "merge_local", "daemon_restart",
                     "repo_merge"):
            self.assertIn(name, d.DENY_LIST)

    def test_run_script_refuses_unlisted_script(self):
        adapter, seen, _ = make_adapter()
        _proc, error = adapter.run_script(["fm-merge-local.sh", "x"])
        self.assertTrue(env.is_err(error))
        self.assertEqual(error["error"]["code"], "script-not-allowed")
        self.assertEqual(seen, [])

    def test_dispatch_never_raises(self):
        adapter, _, _ = make_adapter()
        result = adapter.dispatch("crew_state", None)
        self.assertTrue(env.is_err(result))

    def test_registry_tools_all_reachable(self):
        adapter, _, _ = make_adapter()
        for name in sorted(d.TOOL_NAMES):
            with self.subTest(tool=name):
                self.assertNotIn(name, d.DENY_LIST)
                self.assertTrue(hasattr(adapter, f"tool_{name}"), name)


class ValidationRejectionTest(unittest.TestCase):
    def test_crew_state_rejects_traversal(self):
        adapter, seen, _ = make_adapter()
        result = adapter.dispatch("crew_state", {"id": "../escape"})
        self.assertTrue(env.is_err(result))
        self.assertEqual(result["error"]["code"], "invalid-id")
        self.assertEqual(seen, [])

    def test_send_message_refusals(self):
        adapter, seen, _ = make_adapter()
        for text in ("/merge now", "one\ntwo", "z" * 501, ""):
            with self.subTest(text=text[:10]):
                result = adapter.dispatch(
                    "send_message", {"target": "t1", "text": text})
                self.assertTrue(env.is_err(result), text[:10])
        self.assertEqual(seen, [])

    def test_authority_tools_require_approval(self):
        adapter, seen, _ = make_adapter()
        cases = [
            ("lifecycle_interrupt", {"id": "t1"}),
            ("lifecycle_exit", {"id": "t1"}),
            ("lifecycle_relaunch", {"id": "t1", "note": "n"}),
            ("spawn_crew", {"task_id": "t1", "project": "p",
                            "mode": "local-only", "yolo": "off"}),
            ("scaffold_brief", {"task_id": "t1", "project": "p",
                                "mode": "scout"}),
            ("relay_dismiss", {"request_id": "r1"}),
        ]
        for name, args in cases:
            with self.subTest(tool=name):
                result = adapter.dispatch(name, args)
                self.assertTrue(env.is_err(result), name)
                self.assertEqual(result["error"]["code"],
                                 "approval-required", name)
        self.assertEqual(seen, [])

    def test_spawn_rejects_bad_mode_project_yolo(self):
        adapter, seen, _ = make_adapter()
        base = {"task_id": "t1", "project": "p", "mode": "local-only",
                "yolo": "off", "approval": APPROVAL}
        for key, value in (("mode", "bogus"), ("project", "/abs"),
                           ("yolo", "maybe"), ("task_id", "../x")):
            with self.subTest(field=key):
                args = dict(base, **{key: value})
                result = adapter.dispatch("spawn_crew", args)
                self.assertTrue(env.is_err(result), key)
        self.assertEqual(seen, [])

    def test_brief_rejects_bad_mode(self):
        adapter, seen, _ = make_adapter()
        result = adapter.dispatch("scaffold_brief", {
            "task_id": "t1", "project": "p", "mode": "bogus",
            "approval": APPROVAL})
        self.assertTrue(env.is_err(result))
        self.assertEqual(seen, [])

    def test_review_rejects_bad_verdict(self):
        adapter, seen, _ = make_adapter()
        result = adapter.dispatch("review_decision", {
            "id": "t1", "verdict": "bogus", "approval": APPROVAL})
        self.assertTrue(env.is_err(result))
        self.assertEqual(seen, [])

    def test_relay_followup_validates_final_flag(self):
        adapter, seen, _ = make_adapter()
        result = adapter.dispatch("relay_followup", {
            "task_id": "t1", "text": "done", "final": "yes",
            "approval": APPROVAL})
        self.assertTrue(env.is_err(result))
        self.assertEqual(result["error"]["code"], "invalid-final")
        self.assertEqual(seen, [])


class ArgvBuilderTest(unittest.TestCase):
    def test_spawn_argv_safe_subset(self):
        adapter, seen, _ = make_adapter(proc=FakeProc())
        result = adapter.dispatch("spawn_crew", {
            "task_id": "t1", "project": "myproj", "mode": "direct-PR",
            "yolo": "off", "approval": APPROVAL})
        self.assertTrue(env.is_ok(result))
        self.assertIn("fm-spawn.sh", seen[0][0])
        self.assertEqual(seen[0][1:], ["t1", "myproj", "--mode", "direct-PR",
                                       "--yolo", "off"])
        self.assertNotIn("--force", seen[0])

    def test_scout_brief_uses_scout_flag(self):
        adapter, seen, _ = make_adapter(proc=FakeProc())
        result = adapter.dispatch("scaffold_brief", {
            "task_id": "t1", "project": "p", "mode": "scout",
            "approval": APPROVAL})
        self.assertTrue(env.is_ok(result))
        self.assertEqual(seen[0][1:], ["t1", "p", "--scout"])

    def test_lifecycle_relaunch_carries_note(self):
        adapter, seen, _ = make_adapter(proc=FakeProc())
        result = adapter.dispatch("lifecycle_relaunch", {
            "id": "t1", "note": "retry now", "approval": APPROVAL})
        self.assertTrue(env.is_ok(result))
        self.assertEqual(seen[0][1:], ["t1", "relaunch", "--note", "retry now"])

    def test_denied_flags_never_emitted(self):
        with self.assertRaises(ValueError):
            d._argv("fm-send.sh", "t1", "--raw")

    def test_decision_resolve_uses_temp_file(self):
        adapter, seen, _ = make_adapter(proc=FakeProc())
        result = adapter.dispatch("decision_resolve", {
            "origin_id": "o1", "decision_key": "k1", "routed_to": "t9",
            "decision_text": "ship it", "approval": APPROVAL})
        self.assertTrue(env.is_ok(result))
        argv = seen[0]
        self.assertIn("fm-decision-hold.sh", argv[0])
        self.assertIn("resolve", argv)
        self.assertIn("--routed-to", argv)


class SnapshotToolsTest(unittest.TestCase):
    def test_fleet_snapshot_validates_schema(self):
        adapter, _, _ = make_adapter(proc=FakeProc(stdout=json.dumps(SNAPSHOT)))
        result = adapter.dispatch("fleet_snapshot", {})
        self.assertTrue(env.is_ok(result))
        self.assertEqual(result["snapshot"]["schema"], "fm-fleet-snapshot.v1")

    def test_fleet_snapshot_rejects_wrong_schema(self):
        bad = dict(SNAPSHOT, schema="other.v9")
        adapter, _, _ = make_adapter(proc=FakeProc(stdout=json.dumps(bad)))
        result = adapter.dispatch("fleet_snapshot", {})
        self.assertTrue(env.is_err(result))
        self.assertEqual(result["error"]["code"], "unexpected-schema")

    def test_fleet_snapshot_rejects_non_json(self):
        adapter, _, _ = make_adapter(proc=FakeProc(stdout="not json"))
        result = adapter.dispatch("fleet_snapshot", {})
        self.assertTrue(env.is_err(result))
        self.assertEqual(result["error"]["code"], "snapshot-not-json")

    def test_backlog_derives_counts(self):
        adapter, _, _ = make_adapter(proc=FakeProc(stdout=json.dumps(SNAPSHOT)))
        result = adapter.dispatch("backlog", {})
        self.assertTrue(env.is_ok(result))
        self.assertEqual(result["task_counts"]["total"], 3)
        self.assertEqual(result["task_counts"]["by_state"]["working"], 1)
        self.assertEqual(result["task_counts"]["by_state"]["done"], 1)

    def test_status_tail_reads_confined_file(self):
        adapter, seen, home = make_adapter()
        state = home / "state"
        state.mkdir(exist_ok=True)
        (state / "t1.status").write_text("a: one\nb: two\nc: three\n")
        result = adapter.dispatch("status_tail", {"id": "t1", "lines": 2})
        self.assertTrue(env.is_ok(result))
        self.assertEqual(result["events"], ["b: two", "c: three"])
        self.assertIn("warning", result)
        self.assertEqual(seen, [])

    def test_status_tail_missing_id_is_typed_error(self):
        adapter, seen, home = make_adapter()
        (home / "state").mkdir(exist_ok=True)
        result = adapter.dispatch("status_tail", {"id": "ghost"})
        self.assertTrue(env.is_err(result))
        self.assertEqual(result["error"]["code"], "no-status-log")
        self.assertEqual(seen, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
