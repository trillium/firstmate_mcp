#!/usr/bin/env python3
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path as _Path

sys.path.insert(0, str(_Path(__file__).resolve().parent.parent))
from datetime import datetime
from pathlib import Path

from auth.audit import AUDIT_KEYS, append, build_line, format_line, read_lines
from auth.tiers import (
    FORBIDDEN_TOOLS,
    TIER_AUTHORITY,
    TIER_EXTERNAL,
    TIER_FORBIDDEN,
    TIER_OPEN,
    TIER_STEER,
    TOOL_TIERS,
    approval_ref,
    check,
    requires_approval,
    tier_of,
    valid_approval,
)

APPROVAL = "I authorize lifecycle_interrupt on fm-task1 (2026-09-13)"

TIER1_TOOLS = ["fleet_snapshot", "backlog", "crew_state", "status_tail", "fleet_poll",
               "peek", "fleet_view", "review_diff", "bearings_snapshot",
               "wake_drain", "guard_check", "remote_doctor", "remote_file",
               "remote_delta", "handoff_status",
               "harness_detect", "project_mode", "lock_status", "lease_check",
               "bearings_board_path", "inbox_status", "inbox_list",
               "home_summary", "contributions_snapshot", "contributions_pending",
               "receipt_submit", "receipt_status"]
TIER3_TOOLS = [t for t, tier in TOOL_TIERS.items() if tier == TIER_AUTHORITY]
TIER4_TOOLS = [t for t, tier in TOOL_TIERS.items() if tier == TIER_EXTERNAL]


class TierAssignmentTest(unittest.TestCase):
    def test_every_tool_has_a_tier(self):
        self.assertEqual(len(TOOL_TIERS), 46)

    def test_tier1_is_open_reads(self):
        for tool in TIER1_TOOLS:
            self.assertEqual(tier_of(tool), TIER_OPEN)

    def test_tier2_is_send_message_only(self):
        self.assertEqual(tier_of("send_message"), TIER_STEER)

    def test_tier3_is_authority_writes(self):
        self.assertEqual(len(TIER3_TOOLS), 15)
        for tool in TIER3_TOOLS:
            self.assertEqual(tier_of(tool), TIER_AUTHORITY)

    def test_tier4_is_external_sends(self):
        self.assertEqual(
            sorted(TIER4_TOOLS), ["relay_dismiss", "relay_followup", "relay_reply"]
        )
        for tool in TIER4_TOOLS:
            self.assertEqual(tier_of(tool), TIER_EXTERNAL)

    def test_forbidden_tools_have_no_tool(self):
        self.assertEqual(
            sorted(FORBIDDEN_TOOLS),
            ["arm_pr_check", "merge_local", "merge_pr", "promote_scout", "teardown_crew"],
        )
        for tool in FORBIDDEN_TOOLS:
            self.assertEqual(tier_of(tool), TIER_FORBIDDEN)

    def test_unknown_tool_has_no_tier(self):
        self.assertIsNone(tier_of("drop_database"))


class AllowRefuseTest(unittest.TestCase):
    def test_tier1_allows_without_approval(self):
        for tool in TIER1_TOOLS:
            allow, reason = check(tool)
            self.assertTrue(allow, tool)
            self.assertEqual(reason, "ok")

    def test_tier2_allows_without_approval(self):
        allow, reason = check("send_message")
        self.assertTrue(allow)
        self.assertEqual(reason, "ok")

    def test_tier3_refuses_without_approval(self):
        for tool in TIER3_TOOLS:
            allow, reason = check(tool)
            self.assertFalse(allow, tool)
            self.assertEqual(reason, "approval-required")

    def test_tier4_refuses_without_approval(self):
        for tool in TIER4_TOOLS:
            allow, reason = check(tool)
            self.assertFalse(allow, tool)
            self.assertEqual(reason, "approval-required")

    def test_tier3_refuses_bad_approval(self):
        for bad in ["", "yes please", "authorize this", "I authorize" + "x" * 500]:
            allow, reason = check("spawn_crew", bad)
            self.assertFalse(allow, repr(bad))
            self.assertEqual(reason, "approval-invalid")

    def test_tier4_refuses_bad_approval(self):
        allow, reason = check("relay_reply", "ok by me")
        self.assertFalse(allow)
        self.assertEqual(reason, "approval-invalid")

    def test_tier3_allows_with_approval(self):
        for tool in TIER3_TOOLS:
            allow, reason = check(tool, APPROVAL)
            self.assertTrue(allow, tool)
            self.assertEqual(reason, "ok")

    def test_tier4_allows_with_approval(self):
        for tool in TIER4_TOOLS:
            allow, reason = check(tool, APPROVAL)
            self.assertTrue(allow, tool)
            self.assertEqual(reason, "ok")

    def test_forbidden_refuses_even_with_approval(self):
        for tool in FORBIDDEN_TOOLS:
            allow, reason = check(tool, APPROVAL)
            self.assertFalse(allow, tool)
            self.assertEqual(reason, "forbidden")

    def test_unknown_refuses_even_with_approval(self):
        allow, reason = check("drop_database", APPROVAL)
        self.assertFalse(allow)
        self.assertEqual(reason, "unknown-tool")

    def test_no_ambient_authority(self):
        allow, reason = check("merge_pr", APPROVAL)
        self.assertFalse(allow)
        self.assertEqual(reason, "forbidden")
        allow, reason = check("lifecycle_exit", None)
        self.assertFalse(allow)
        self.assertEqual(reason, "approval-required")


class ApprovalMechanicsTest(unittest.TestCase):
    def test_valid_prefix(self):
        self.assertTrue(valid_approval("I authorize X"))

    def test_rejects_wrong_prefix(self):
        self.assertFalse(valid_approval("I authorise X"))
        self.assertFalse(valid_approval("yes"))
        self.assertFalse(valid_approval(""))
        self.assertFalse(valid_approval(None))

    def test_rejects_overlong(self):
        self.assertFalse(valid_approval("I authorize " + "x" * 500))
        self.assertTrue(valid_approval("I authorize " + "x" * 487))

    def test_requires_approval_only_on_tiers_3_and_4(self):
        for tool in TIER1_TOOLS + ["send_message"]:
            self.assertFalse(requires_approval(tool), tool)
        for tool in TIER3_TOOLS + TIER4_TOOLS:
            self.assertTrue(requires_approval(tool), tool)

    def test_approval_ref_is_stable_short_hash(self):
        ref = approval_ref(APPROVAL)
        self.assertEqual(ref, approval_ref(APPROVAL))
        self.assertTrue(re.fullmatch(r"[0-9a-f]{16}", ref))

    def test_approval_ref_none_without_token(self):
        self.assertIsNone(approval_ref(None))
        self.assertIsNone(approval_ref(""))


class AuditLineTest(unittest.TestCase):
    def test_allow_line_shape(self):
        line = build_line(
            "trillium",
            "lifecycle_interrupt",
            "allow",
            "ok",
            approval=APPROVAL,
            target="fm-task1",
            ts="2026-09-13T18:00:00Z",
        )
        self.assertEqual(tuple(sorted(line.keys())), tuple(sorted(AUDIT_KEYS)))
        self.assertEqual(line["v"], 1)
        self.assertEqual(line["actor"], "trillium")
        self.assertEqual(line["tool"], "lifecycle_interrupt")
        self.assertEqual(line["tier"], 3)
        self.assertEqual(line["decision"], "allow")
        self.assertEqual(line["reason"], "ok")
        self.assertEqual(line["approval_ref"], approval_ref(APPROVAL))
        self.assertEqual(line["target"], "fm-task1")

    def test_refuse_line_shape_without_token(self):
        line = build_line("trillium", "relay_reply", "refuse", "approval-required")
        self.assertEqual(line["tier"], 4)
        self.assertEqual(line["decision"], "refuse")
        self.assertIsNone(line["approval_ref"])
        self.assertIsNone(line["target"])

    def test_forbidden_and_unknown_tiers(self):
        line = build_line("trillium", "merge_pr", "refuse", "forbidden")
        self.assertEqual(line["tier"], "forbidden")
        line = build_line("trillium", "nope", "refuse", "unknown-tool")
        self.assertIsNone(line["tier"])

    def test_ts_is_utc_iso8601(self):
        line = build_line("trillium", "backlog", "allow", "ok")
        datetime.strptime(line["ts"], "%Y-%m-%dT%H:%M:%SZ")

    def test_format_is_single_json_line(self):
        line = build_line("trillium", "backlog", "allow", "ok", ts="2026-09-13T18:00:00Z")
        raw = format_line(line)
        self.assertNotIn("\n", raw)
        self.assertEqual(json.loads(raw), line)

    def test_never_logs_token_text(self):
        line = build_line("trillium", "spawn_crew", "allow", "ok", approval=APPROVAL)
        self.assertNotIn(APPROVAL, format_line(line))

    def test_append_and_read_round_trip(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "audit.jsonl"
            first = build_line("trillium", "backlog", "allow", "ok")
            second = build_line(
                "trillium", "relay_reply", "refuse", "approval-required"
            )
            append(path, first)
            append(path, second)
            lines = path.read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(lines), 2)
            self.assertEqual(read_lines(path), [first, second])


if __name__ == "__main__":
    unittest.main()
