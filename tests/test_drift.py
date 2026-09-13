#!/usr/bin/env python3
"""Unit tests for drift diff classes and report shapes (stdlib only).

Run: python3 tests/test_drift.py
"""
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from drift.diff import diff_snapshots
from drift.report import to_dict, to_json, to_markdown, to_text


def surface(name, **overrides):
    base = {
        "name": name,
        "command": f"bin/{name}",
        "kind": "script",
        "flags": ["--json"],
        "help_exit": 0,
        "help_excerpt": f"usage: {name} --json",
        "help_hash": "aaa",
        "file_hash": "fff",
        "size": 100,
        "mtime": 1000,
        "schema_hint": "fm-snapshot.v1",
        "header_contract": "Output contract: --json prints one object",
    }
    base.update(overrides)
    return base


def snapshot(names):
    return {
        "version": 1,
        "generated": "2026-09-13T00:00:00+00:00",
        "firstmate_revision": "abc123",
        "surfaces": [surface(name) for name in names],
    }


class DiffClassesTest(unittest.TestCase):
    def test_clean_pair_has_empty_classes(self):
        report = diff_snapshots(snapshot(["a.sh"]), snapshot(["a.sh"]))
        self.assertTrue(report["summary"]["clean"])
        self.assertEqual(report["added"], [])
        self.assertEqual(report["removed"], [])
        self.assertEqual(report["changed"], [])

    def test_added_is_feature_drift(self):
        report = diff_snapshots(snapshot(["a.sh"]), snapshot(["a.sh", "b.sh"]))
        self.assertEqual(report["added"], ["b.sh"])
        self.assertEqual(report["summary"]["feature_drift"], 1)
        self.assertFalse(report["summary"]["clean"])

    def test_removed_is_feature_drift(self):
        report = diff_snapshots(snapshot(["a.sh", "b.sh"]), snapshot(["a.sh"]))
        self.assertEqual(report["removed"], ["b.sh"])
        self.assertEqual(report["summary"]["feature_drift"], 1)

    def test_flag_change_is_feature_drift_only(self):
        old = snapshot(["a.sh"])
        new = snapshot(["a.sh"])
        new["surfaces"][0]["flags"] = ["--json", "--verbose"]
        (entry,) = diff_snapshots(old, new)["changed"]
        self.assertTrue(entry["feature_drift"])
        self.assertFalse(entry["behavior_drift"])
        self.assertTrue(all(c["class"] == "feature" for c in entry["changes"]))

    def test_help_only_change_is_behavior_drift_only(self):
        old = snapshot(["a.sh"])
        new = snapshot(["a.sh"])
        new["surfaces"][0]["help_excerpt"] = "usage: a.sh --json (new docs)"
        new["surfaces"][0]["help_hash"] = "bbb"
        (entry,) = diff_snapshots(old, new)["changed"]
        self.assertTrue(entry["behavior_drift"])
        self.assertFalse(entry["feature_drift"])

    def test_mixed_change_carries_both_classes(self):
        old = snapshot(["a.sh"])
        new = snapshot(["a.sh"])
        new["surfaces"][0]["flags"] = ["--json", "--verbose"]
        new["surfaces"][0]["file_hash"] = "ggg"
        (entry,) = diff_snapshots(old, new)["changed"]
        self.assertTrue(entry["feature_drift"])
        self.assertTrue(entry["behavior_drift"])


class ReportShapesTest(unittest.TestCase):
    def report(self):
        old = snapshot(["a.sh", "gone.sh"])
        new = snapshot(["a.sh", "new.sh"])
        new["surfaces"][0]["flags"] = ["--json", "--verbose"]
        return diff_snapshots(old, new)

    def test_json_shape_has_summary_and_sections(self):
        data = json.loads(to_json(self.report()))
        self.assertIn("summary", data)
        self.assertIn("added", data)
        self.assertIn("removed", data)
        self.assertIn("changed", data)
        for key in ("added", "removed", "changed", "feature_drift", "behavior_drift", "clean"):
            self.assertIn(key, data["summary"])
        report = self.report()
        self.assertIs(to_dict(report), report)

    def test_markdown_shape_has_sections(self):
        text = to_markdown(self.report())
        self.assertIn("# Drift report", text)
        self.assertIn("## Added", text)
        self.assertIn("## Removed", text)
        self.assertIn("## Changed", text)
        self.assertIn("feature-drift", text)

    def test_text_shape_lists_each_drift(self):
        text = to_text(self.report())
        self.assertIn("added [feature]: new.sh", text)
        self.assertIn("removed [feature]: gone.sh", text)
        self.assertIn("changed [feature-drift]: a.sh", text)

    def test_clean_reports_say_so(self):
        clean = diff_snapshots(snapshot(["a.sh"]), snapshot(["a.sh"]))
        self.assertIn("No drift", to_markdown(clean))
        self.assertIn("clean: no drift", to_text(clean))


if __name__ == "__main__":
    unittest.main(verbosity=2)
