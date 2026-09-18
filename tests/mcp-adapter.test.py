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

    def test_peek_lines_window(self):
        self.assertEqual(v.valid_peek_lines(40), 40)
        self.assertEqual(v.valid_peek_lines(999), 100)
        self.assertEqual(v.valid_peek_lines(0), 1)
        self.assertIsNone(v.valid_peek_lines("many"))
        self.assertIsNone(v.valid_peek_lines(None))

    def test_confine_state_path(self):
        with tempfile.TemporaryDirectory() as home:
            state = Path(home) / "state"
            state.mkdir()
            ok_path = v.confine_state_path(state, "task-1")
            self.assertEqual(ok_path, (state / "task-1.status").resolve())
            self.assertIsNone(v.confine_state_path(state, "../escape"))
            self.assertIsNone(v.confine_state_path(state, "a/b"))

    def test_relpath_confinement(self):
        self.assertTrue(v.valid_relpath("data/backlog.md"))
        self.assertTrue(v.valid_relpath("state/handoff/x.outbox.md"))
        self.assertFalse(v.valid_relpath("/abs/path"))
        self.assertFalse(v.valid_relpath("../up"))
        self.assertFalse(v.valid_relpath("a//b"))
        self.assertFalse(v.valid_relpath("a/./b"))
        self.assertFalse(v.valid_relpath("a/../b"))
        self.assertFalse(v.valid_relpath(""))
        self.assertFalse(v.valid_relpath("a\tb"))
        self.assertFalse(v.valid_relpath(None))

    def test_sha256_and_corr(self):
        self.assertTrue(v.valid_sha256("e" * 64))
        self.assertFalse(v.valid_sha256("e" * 63))
        self.assertFalse(v.valid_sha256("z" * 64))
        self.assertFalse(v.valid_sha256(None))
        self.assertTrue(v.valid_corr("abcdef0123456789"))
        self.assertTrue(v.valid_corr("corr=abcdef0123456789"))
        self.assertFalse(v.valid_corr("abcdef01"))
        self.assertFalse(v.valid_corr("zzzzz0123456789ab"))
        self.assertFalse(v.valid_corr(None))

    def test_delta_windows(self):
        self.assertEqual(v.valid_nonneg_int(0), 0)
        self.assertEqual(v.valid_nonneg_int("42"), 42)
        self.assertIsNone(v.valid_nonneg_int(-1))
        self.assertIsNone(v.valid_nonneg_int("many"))
        self.assertIsNone(v.valid_nonneg_int(None))
        self.assertIsNone(v.valid_nonneg_int(True))
        self.assertEqual(v.valid_delta_wait(0), 0)
        self.assertEqual(v.valid_delta_wait(300), 10)
        self.assertEqual(v.valid_delta_wait(-5), 0)
        self.assertIsNone(v.valid_delta_wait("long"))
        self.assertIsNone(v.valid_delta_wait(None))
        self.assertEqual(v.valid_remote_max_bytes(8192), 8192)
        self.assertEqual(v.valid_remote_max_bytes(10 ** 9), 262144)
        self.assertEqual(v.valid_remote_max_bytes(0), 1)
        self.assertIsNone(v.valid_remote_max_bytes("big"))
        self.assertIsNone(v.valid_remote_max_bytes(None))
        self.assertEqual(v.valid_handoff_lines(10), 10)
        self.assertEqual(v.valid_handoff_lines(999), 20)
        self.assertEqual(v.valid_handoff_lines(0), 1)
        self.assertIsNone(v.valid_handoff_lines("many"))
        self.assertIsNone(v.valid_handoff_lines(None))

    def test_id_lists(self):
        self.assertEqual(v.valid_id_list(["a", "b"], 8), ["a", "b"])
        self.assertIsNone(v.valid_id_list([], 8))
        self.assertIsNone(v.valid_id_list(["a"] * 9, 8))
        self.assertIsNone(v.valid_id_list(["../x"], 8))
        self.assertIsNone(v.valid_id_list("a", 8))
        self.assertIsNone(v.valid_id_list(None, 8))

    def test_confine_handoff_path(self):
        with tempfile.TemporaryDirectory() as home:
            data = Path(home) / "data"
            (data / "handoff").mkdir(parents=True)
            ok_path = v.confine_handoff_path(data, "mate-1")
            self.assertEqual(
                ok_path, (data / "handoff" / "mate-1.outbox.md").resolve())
            self.assertIsNone(v.confine_handoff_path(data, "../escape"))
            self.assertIsNone(v.confine_handoff_path(data, "a/b"))


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

    def test_peek_validates_target_and_lines(self):
        adapter, seen, _ = make_adapter()
        result = adapter.dispatch("peek", {"target": "../escape"})
        self.assertTrue(env.is_err(result))
        self.assertEqual(result["error"]["code"], "invalid-target")
        result = adapter.dispatch("peek", {"target": "t1", "lines": "many"})
        self.assertTrue(env.is_err(result))
        self.assertEqual(result["error"]["code"], "invalid-lines")
        self.assertEqual(seen, [])

    def test_review_diff_validates_id_and_stat(self):
        adapter, seen, _ = make_adapter()
        result = adapter.dispatch("review_diff", {"id": "../escape"})
        self.assertTrue(env.is_err(result))
        self.assertEqual(result["error"]["code"], "invalid-id")
        result = adapter.dispatch("review_diff", {"id": "t1", "stat": "yes"})
        self.assertTrue(env.is_err(result))
        self.assertEqual(result["error"]["code"], "invalid-stat")
        self.assertEqual(seen, [])

    def test_remote_file_validates_path_and_bytes(self):
        adapter, seen, _ = make_adapter()
        result = adapter.dispatch("remote_file", {"path": "../escape"})
        self.assertTrue(env.is_err(result))
        self.assertEqual(result["error"]["code"], "invalid-path")
        result = adapter.dispatch("remote_file",
                                  {"path": "data/x.md", "max_bytes": "big"})
        self.assertTrue(env.is_err(result))
        self.assertEqual(result["error"]["code"], "invalid-max-bytes")
        self.assertEqual(seen, [])

    def test_remote_delta_validates_cursor(self):
        adapter, seen, _ = make_adapter()
        good = {"log": "state/job.log", "offset": 0, "sha256": "e" * 64}
        for key, value, code in (("log", "../x", "invalid-path"),
                                 ("offset", -1, "invalid-offset"),
                                 ("sha256", "short", "invalid-sha256"),
                                 ("wait", "long", "invalid-wait")):
            with self.subTest(field=key):
                args = dict(good, **{key: value})
                result = adapter.dispatch("remote_delta", args)
                self.assertTrue(env.is_err(result), key)
                self.assertEqual(result["error"]["code"], code, key)
        self.assertEqual(seen, [])

    def test_handoff_status_validates_id_and_lines(self):
        adapter, seen, home = make_adapter()
        (home / "data" / "handoff").mkdir(parents=True, exist_ok=True)
        result = adapter.dispatch("handoff_status", {"id": "../escape"})
        self.assertTrue(env.is_err(result))
        self.assertEqual(result["error"]["code"], "invalid-id")
        result = adapter.dispatch("handoff_status", {"lines": "many"})
        self.assertTrue(env.is_err(result))
        self.assertEqual(result["error"]["code"], "invalid-lines")
        self.assertEqual(seen, [])

    def test_secondmate_authority_tools_require_approval(self):
        adapter, seen, _ = make_adapter()
        cases = [
            ("secondmate_nudge", {}),
            ("secondmate_restart", {"ids": ["m1"]}),
            ("secondmate_report", {"verb": "done",
                                     "corr": "a" * 16, "note": "ok"}),
            ("remote_control", {"verb": "state", "id": "m1"}),
            ("handoff_move", {"id": "m1", "keys": ["k1"]}),
        ]
        for name, args in cases:
            with self.subTest(tool=name):
                result = adapter.dispatch(name, args)
                self.assertTrue(env.is_err(result), name)
                self.assertEqual(result["error"]["code"],
                                 "approval-required", name)
        self.assertEqual(seen, [])

    def test_secondmate_restart_report_control_move_refusals(self):
        adapter, seen, _ = make_adapter()
        result = adapter.dispatch("secondmate_restart",
                                  {"ids": ["../x"], "approval": APPROVAL})
        self.assertTrue(env.is_err(result))
        self.assertEqual(result["error"]["code"], "invalid-id")
        result = adapter.dispatch("secondmate_report",
                                  {"verb": "done", "corr": "short",
                                   "note": "ok", "approval": APPROVAL})
        self.assertTrue(env.is_err(result))
        self.assertEqual(result["error"]["code"], "invalid-corr")
        result = adapter.dispatch("secondmate_report",
                                  {"verb": "has space", "corr": "a" * 16,
                                   "note": "ok", "approval": APPROVAL})
        self.assertTrue(env.is_err(result))
        self.assertEqual(result["error"]["code"], "invalid-verb")
        result = adapter.dispatch("remote_control",
                                  {"verb": "launch", "id": "m1",
                                   "approval": APPROVAL})
        self.assertTrue(env.is_err(result))
        self.assertEqual(result["error"]["code"], "invalid-verb")
        result = adapter.dispatch("remote_control",
                                  {"verb": "send", "id": "m1",
                                   "text": "/raw key",
                                   "approval": APPROVAL})
        self.assertTrue(env.is_err(result))
        self.assertEqual(result["error"]["code"], "slash-commands-refused")
        result = adapter.dispatch("handoff_move",
                                  {"id": "m1", "keys": [],
                                   "approval": APPROVAL})
        self.assertTrue(env.is_err(result))
        self.assertEqual(result["error"]["code"], "invalid-keys")
        result = adapter.dispatch("handoff_move",
                                  {"id": "m1", "resume": "yes",
                                   "approval": APPROVAL})
        self.assertTrue(env.is_err(result))
        self.assertEqual(result["error"]["code"], "invalid-resume")
        result = adapter.dispatch("handoff_move",
                                  {"id": "m1", "resume": True,
                                   "keys": ["k1"], "approval": APPROVAL})
        self.assertTrue(env.is_err(result))
        self.assertEqual(result["error"]["code"], "invalid-keys")
    def test_harness_detect_validates_mode(self):
        adapter, seen, _ = make_adapter()
        result = adapter.dispatch("harness_detect", {"mode": "ancestry"})
        self.assertTrue(env.is_err(result))
        self.assertEqual(result["error"]["code"], "invalid-mode")
        result = adapter.dispatch("harness_detect", {"mode": "bogus"})
        self.assertTrue(env.is_err(result))
        self.assertEqual(seen, [])

    def test_project_mode_validates_project(self):
        adapter, seen, _ = make_adapter()
        result = adapter.dispatch("project_mode", {"project": "../escape"})
        self.assertTrue(env.is_err(result))
        self.assertEqual(result["error"]["code"], "invalid-project")
        result = adapter.dispatch("project_mode", {"project": "/abs"})
        self.assertTrue(env.is_err(result))
        self.assertEqual(seen, [])

    def test_lease_check_validates_id(self):
        adapter, seen, _ = make_adapter()
        result = adapter.dispatch("lease_check", {"id": "../escape"})
        self.assertTrue(env.is_err(result))
        self.assertEqual(result["error"]["code"], "invalid-id")
        self.assertEqual(seen, [])

    def test_contributions_snapshot_validates_all(self):
        adapter, seen, _ = make_adapter()
        result = adapter.dispatch("contributions_snapshot", {"all": "yes"})
        self.assertTrue(env.is_err(result))
        self.assertEqual(result["error"]["code"], "invalid-all")
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

    def test_peek_argv_carries_target_and_lines(self):
        adapter, seen, _ = make_adapter(proc=FakeProc())
        result = adapter.dispatch("peek", {"target": "t1", "lines": 5})
        self.assertTrue(env.is_ok(result))
        self.assertEqual(seen[0][1:], ["t1", "5"])
        self.assertIn("fm-peek.sh", seen[0][0])

    def test_review_diff_stat_flag(self):
        adapter, seen, _ = make_adapter(proc=FakeProc())
        result = adapter.dispatch("review_diff", {"id": "t1", "stat": True})
        self.assertTrue(env.is_ok(result))
        self.assertEqual(seen[0][1:], ["t1", "--stat"])

    def test_bearings_validates_schema(self):
        good = json.dumps({"schema": "fm-bearings.v1", "generated": "stub",
                           "in_flight": [], "omitted": []})
        adapter, _, _ = make_adapter(proc=FakeProc(stdout=good))
        result = adapter.dispatch("bearings_snapshot", {})
        self.assertTrue(env.is_ok(result))
        self.assertEqual(result["schema"], "fm-bearings.v1")
        bad = json.dumps(dict(json.loads(good), schema="other.v9"))
        adapter, _, _ = make_adapter(proc=FakeProc(stdout=bad))
        result = adapter.dispatch("bearings_snapshot", {})
        self.assertTrue(env.is_err(result))
        self.assertEqual(result["error"]["code"], "unexpected-bearings-schema")

    def test_secondmate_remote_handoff_argv(self):
        adapter, seen, _ = make_adapter(proc=FakeProc())
        result = adapter.dispatch("secondmate_nudge", {"approval": APPROVAL})
        self.assertTrue(env.is_ok(result))
        self.assertIn("fm-secondmate-reconcile.sh", seen[-1][0])
        self.assertEqual(seen[-1][1:], ["notify"])
        result = adapter.dispatch("secondmate_restart",
                                  {"ids": ["m1", "m2"],
                                   "approval": APPROVAL})
        self.assertTrue(env.is_ok(result))
        self.assertIn("fm-secondmate-restart.sh", seen[-1][0])
        self.assertEqual(seen[-1][1:], ["m1", "m2"])
        self.assertEqual(result["ids"], ["m1", "m2"])
        result = adapter.dispatch("secondmate_report",
                                  {"verb": "done", "corr": "a" * 16,
                                   "note": "audit clean",
                                   "approval": APPROVAL})
        self.assertTrue(env.is_ok(result))
        self.assertIn("fm-secondmate-report.sh", seen[-1][0])
        self.assertEqual(seen[-1][1:],
                         ["done", "a" * 16, "audit clean"])
        self.assertNotIn("--doc", seen[-1])
        result = adapter.dispatch("remote_control",
                                  {"verb": "state", "id": "m1",
                                   "approval": APPROVAL})
        self.assertTrue(env.is_ok(result))
        self.assertIn("fm-remote-secondmate-control.sh", seen[-1][0])
        self.assertEqual(seen[-1][1:], ["state", "m1"])
        result = adapter.dispatch("remote_control",
                                  {"verb": "send", "id": "m1",
                                   "text": "steady on",
                                   "approval": APPROVAL})
        self.assertTrue(env.is_ok(result))
        self.assertEqual(seen[-1][1:], ["send", "m1", "steady on"])
        result = adapter.dispatch("handoff_move",
                                  {"id": "m1", "keys": ["k1", "k2"],
                                   "approval": APPROVAL})
        self.assertTrue(env.is_ok(result))
        self.assertIn("fm-backlog-handoff.sh", seen[-1][0])
        self.assertEqual(seen[-1][1:], ["m1", "k1", "k2"])
        self.assertEqual(result["keys"], ["k1", "k2"])
        result = adapter.dispatch("handoff_move",
                                  {"id": "m1", "resume": True,
                                   "approval": APPROVAL})
        self.assertTrue(env.is_ok(result))
        self.assertEqual(seen[-1][1:], ["--resume-pending"])
        self.assertTrue(result["resumed"])

    def test_remote_file_delta_argv(self):
        adapter, seen, _ = make_adapter(proc=FakeProc())
        result = adapter.dispatch("remote_file", {"path": "data/x.md"})
        self.assertTrue(env.is_ok(result))
        self.assertIn("fm-remote-file.sh", seen[-1][0])
        self.assertEqual(seen[-1][1:], ["get", "data/x.md", "8192"])
        self.assertEqual(result["path"], "data/x.md")
        self.assertEqual(result["max_bytes"], 8192)
        result = adapter.dispatch("remote_delta",
                                  {"log": "state/job.log", "offset": 0,
                                   "sha256": "e" * 64})
        self.assertTrue(env.is_ok(result))
        self.assertIn("fm-remote-delta-read.sh", seen[-1][0])
        self.assertEqual(seen[-1][1:],
                         ["state/job.log", "0", "e" * 64, "0"])
        self.assertEqual(result["offset"], 0)
        result = adapter.dispatch("remote_delta",
                                  {"log": "state/job.log", "offset": 0,
                                   "sha256": "e" * 64, "wait": 300})
        self.assertTrue(env.is_ok(result))
        self.assertEqual(seen[-1][-1], "10")
    def test_harness_argv_modes(self):
        adapter, seen, _ = make_adapter(proc=FakeProc(stdout="pi\n"))
        result = adapter.dispatch("harness_detect", {})
        self.assertTrue(env.is_ok(result))
        self.assertEqual(seen[0][1:], [])
        self.assertEqual(result["mode"], "own")
        self.assertEqual(result["harness"], "pi")
        adapter, seen, _ = make_adapter(proc=FakeProc(stdout="pi\n"))
        result = adapter.dispatch("harness_detect", {"mode": "crew"})
        self.assertTrue(env.is_ok(result))
        self.assertEqual(seen[0][1:], ["crew"])

    def test_project_mode_argv_and_projection(self):
        adapter, seen, _ = make_adapter(proc=FakeProc(stdout="direct-PR on\n"))
        result = adapter.dispatch("project_mode", {"project": "myproj"})
        self.assertTrue(env.is_ok(result))
        self.assertEqual(seen[0][1:], ["myproj"])
        self.assertEqual(result["project"], "myproj")
        self.assertEqual(result["mode"], "direct-PR")
        self.assertEqual(result["yolo"], "on")

    def test_lock_status_argv_and_projection(self):
        adapter, seen, _ = make_adapter(proc=FakeProc(stdout="lock: free\n"))
        result = adapter.dispatch("lock_status", {})
        self.assertTrue(env.is_ok(result))
        self.assertEqual(seen[0][1:], ["status"])
        self.assertEqual(result["status"], "free")

    def test_lease_check_held_and_unleased(self):
        adapter, seen, _ = make_adapter(
            proc=FakeProc(stdout="main 4242 1700000000 live\n"))
        result = adapter.dispatch("lease_check", {"id": "t1"})
        self.assertTrue(env.is_ok(result))
        self.assertEqual(seen[0][1:], ["check", "t1"])
        self.assertTrue(result["leased"])
        self.assertEqual(result["actor"], "main")
        self.assertEqual(result["pid"], 4242)
        self.assertTrue(result["live"])
        adapter, seen, _ = make_adapter(proc=FakeProc(stdout="", returncode=1))
        result = adapter.dispatch("lease_check", {"id": "t1"})
        self.assertTrue(env.is_ok(result))
        self.assertFalse(result["leased"])
        self.assertEqual(seen[0][1:], ["check", "t1"])

    def test_bearings_board_path_argv(self):
        adapter, seen, _ = make_adapter(
            proc=FakeProc(stdout="/h/.lavish/bearings-board.html\n"))
        result = adapter.dispatch("bearings_board_path", {})
        self.assertTrue(env.is_ok(result))
        self.assertEqual(seen[0][1:], ["path"])
        self.assertEqual(result["path"], "/h/.lavish/bearings-board.html")

    def test_inbox_argv(self):
        adapter, seen, _ = make_adapter(proc=FakeProc(stdout="s\n"))
        result = adapter.dispatch("inbox_status", {})
        self.assertTrue(env.is_ok(result))
        self.assertEqual(seen[0][1:], ["status"])
        adapter, seen, _ = make_adapter(proc=FakeProc(stdout="l\n"))
        result = adapter.dispatch("inbox_list", {})
        self.assertTrue(env.is_ok(result))
        self.assertEqual(seen[0][1:], ["list"])

    def test_home_summary_reads_confined_ledger(self):
        adapter, seen, home = make_adapter()
        state = home / "state"
        state.mkdir(exist_ok=True)
        (state / "home-summary.json").write_text(json.dumps({
            "schema": "fm-secondmate-home-summary.v1",
            "generated": "stub",
        }))
        result = adapter.dispatch("home_summary", {})
        self.assertTrue(env.is_ok(result))
        self.assertEqual(result["schema"], "fm-secondmate-home-summary.v1")
        self.assertEqual(seen, [])

    def test_home_summary_missing_is_typed_error(self):
        adapter, seen, home = make_adapter()
        (home / "state").mkdir(exist_ok=True)
        result = adapter.dispatch("home_summary", {})
        self.assertTrue(env.is_err(result))
        self.assertEqual(result["error"]["code"], "no-home-summary")
        self.assertEqual(seen, [])

    def test_home_summary_rejects_wrong_schema(self):
        adapter, seen, home = make_adapter()
        state = home / "state"
        state.mkdir(exist_ok=True)
        (state / "home-summary.json").write_text(json.dumps({"schema": "other.v9"}))
        result = adapter.dispatch("home_summary", {})
        self.assertTrue(env.is_err(result))
        self.assertEqual(result["error"]["code"], "unexpected-home-summary-schema")
        self.assertEqual(seen, [])

    def test_contributions_snapshot_stages_input(self):
        staged = json.dumps({"backlog": {}, "tasks": []})
        projection = json.dumps({"known": 0, "checked": 0, "counts": {}})
        calls = []

        def runner(argv, **_kw):
            calls.append([str(a) for a in argv])
            if "--contribution-input" in [str(a) for a in argv]:
                return FakeProc(stdout=staged)
            return FakeProc(stdout=projection)

        import tempfile as _tf
        home = _tf.mkdtemp(prefix="fm-adapter-test-")
        adapter = d.Adapter(home=home, checkout_root=ROOT, runner=runner)
        result = adapter.dispatch("contributions_snapshot", {})
        self.assertTrue(env.is_ok(result), result)
        self.assertEqual(result["known"], 0)
        self.assertFalse(result["all"])
        scripts = [c[0] for c in calls]
        self.assertTrue(any("fm-fleet-snapshot.sh" in s for s in scripts))
        self.assertTrue(any("fm-contributions.sh" in s for s in scripts))
        snapshot_call = next(c for c in calls if "fm-contributions.sh" in c[0])
        self.assertEqual(snapshot_call[1], "snapshot")

    def test_contributions_pending_wraps_list(self):
        adapter, seen, _ = make_adapter(proc=FakeProc(stdout='[{"token": "t"}]\n'))
        result = adapter.dispatch("contributions_pending", {})
        self.assertTrue(env.is_ok(result))
        self.assertEqual(result["pending"], [{"token": "t"}])
        self.assertEqual(seen[0][1:], ["pending"])

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

    def test_handoff_status_lists_and_reads_outboxes(self):
        adapter, seen, home = make_adapter()
        handoff = home / "data" / "handoff"
        result = adapter.dispatch("handoff_status", {})
        self.assertTrue(env.is_ok(result))
        self.assertEqual(result["outboxes"], [])
        handoff.mkdir(parents=True)
        (handoff / "m1.outbox.md").write_text("- [ ] k1 first\n- [ ] k2 second\n")
        (handoff / "notes.txt").write_text("ignored\n")
        result = adapter.dispatch("handoff_status", {})
        self.assertTrue(env.is_ok(result))
        self.assertEqual(len(result["outboxes"]), 1)
        self.assertEqual(result["outboxes"][0]["id"], "m1")
        self.assertEqual(result["outboxes"][0]["total_lines"], 2)
        result = adapter.dispatch("handoff_status",
                                  {"id": "m1", "lines": 1})
        self.assertTrue(env.is_ok(result))
        self.assertEqual(result["lines"], ["- [ ] k2 second"])
        result = adapter.dispatch("handoff_status", {"id": "ghost"})
        self.assertTrue(env.is_err(result))
        self.assertEqual(result["error"]["code"], "no-handoff")
        self.assertEqual(seen, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
