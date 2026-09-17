/**
 * Unit tests for src/auth.ts — tier assignments, allow/refuse, approval
 * mechanics, and the audit line shape.
 * Contract referee: auth/test_authz.py (preserved upstream, run unchanged
 * against the Python path; this suite asserts the same contract here).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AUDIT_KEYS,
  FORBIDDEN_TOOLS,
  TIER_AUTHORITY,
  TIER_EXTERNAL,
  TIER_FORBIDDEN,
  TIER_OPEN,
  TIER_STEER,
  TOOL_TIERS,
  appendAudit,
  approvalRef,
  buildLine,
  check,
  formatLine,
  readAuditLines,
  requiresApproval,
  tierOf,
  validApproval,
} from "../src/auth.js";

const APPROVAL = "I authorize lifecycle_interrupt on fm-task1 (2026-09-13)";

const TIER1_TOOLS = [
  "fleet_snapshot", "backlog", "crew_state", "status_tail", "fleet_poll",
  "receipt_submit", "receipt_status",
];
const TIER3_TOOLS = Object.entries(TOOL_TIERS)
  .filter(([, tier]) => tier === TIER_AUTHORITY)
  .map(([tool]) => tool);
const TIER4_TOOLS = Object.entries(TOOL_TIERS)
  .filter(([, tier]) => tier === TIER_EXTERNAL)
  .map(([tool]) => tool);

describe("tier assignments", () => {
  it("covers every tool", () => {
    assert.equal(Object.keys(TOOL_TIERS).length, 21);
  });
  it("tier 1 is open reads", () => {
    for (const tool of TIER1_TOOLS) assert.equal(tierOf(tool), TIER_OPEN, tool);
  });
  it("tier 2 is send_message only", () => {
    assert.equal(tierOf("send_message"), TIER_STEER);
  });
  it("tier 3 is authority writes", () => {
    assert.equal(TIER3_TOOLS.length, 10);
    for (const tool of TIER3_TOOLS) assert.equal(tierOf(tool), TIER_AUTHORITY, tool);
  });
  it("tier 4 is external sends", () => {
    assert.deepEqual([...TIER4_TOOLS].sort(), ["relay_dismiss", "relay_followup", "relay_reply"]);
    for (const tool of TIER4_TOOLS) assert.equal(tierOf(tool), TIER_EXTERNAL, tool);
  });
  it("forbidden tools have no tool tier", () => {
    assert.deepEqual(
      [...FORBIDDEN_TOOLS].sort(),
      ["arm_pr_check", "merge_local", "merge_pr", "promote_scout", "teardown_crew"],
    );
    for (const tool of FORBIDDEN_TOOLS) assert.equal(tierOf(tool), TIER_FORBIDDEN, tool);
  });
  it("unknown tools have no tier", () => {
    assert.equal(tierOf("drop_database"), null);
  });
});

describe("allow / refuse", () => {
  it("tier 1 allows without approval", () => {
    for (const tool of TIER1_TOOLS) {
      assert.deepEqual(check(tool), [true, "ok"], tool);
    }
  });
  it("tier 2 allows without approval", () => {
    assert.deepEqual(check("send_message"), [true, "ok"]);
  });
  it("tiers 3 and 4 refuse without approval", () => {
    for (const tool of [...TIER3_TOOLS, ...TIER4_TOOLS]) {
      assert.deepEqual(check(tool), [false, "approval-required"], tool);
    }
  });
  it("tiers 3 and 4 refuse bad approval", () => {
    for (const bad of ["", "yes please", "authorize this", "I authorize" + "x".repeat(500)]) {
      assert.deepEqual(check("spawn_crew", bad), [false, "approval-invalid"], JSON.stringify(bad));
    }
    assert.deepEqual(check("relay_reply", "ok by me"), [false, "approval-invalid"]);
  });
  it("tiers 3 and 4 allow with approval", () => {
    for (const tool of [...TIER3_TOOLS, ...TIER4_TOOLS]) {
      assert.deepEqual(check(tool, APPROVAL), [true, "ok"], tool);
    }
  });
  it("forbidden refuses even with approval", () => {
    for (const tool of FORBIDDEN_TOOLS) {
      assert.deepEqual(check(tool, APPROVAL), [false, "forbidden"], tool);
    }
  });
  it("unknown refuses even with approval", () => {
    assert.deepEqual(check("drop_database", APPROVAL), [false, "unknown-tool"]);
  });
  it("no ambient authority", () => {
    assert.deepEqual(check("merge_pr", APPROVAL), [false, "forbidden"]);
    assert.deepEqual(check("lifecycle_exit", null), [false, "approval-required"]);
  });
});

describe("approval mechanics", () => {
  it("validates the prefix", () => {
    assert.equal(validApproval("I authorize X"), true);
    assert.equal(validApproval("I authorise X"), false);
    assert.equal(validApproval("yes"), false);
    assert.equal(validApproval(""), false);
    assert.equal(validApproval(null), false);
  });
  it("rejects overlong tokens at the boundary", () => {
    assert.equal(validApproval("I authorize " + "x".repeat(500)), false);
    assert.equal(validApproval("I authorize " + "x".repeat(487)), true);
  });
  it("requires approval only on tiers 3 and 4", () => {
    for (const tool of [...TIER1_TOOLS, "send_message"]) {
      assert.equal(requiresApproval(tool), false, tool);
    }
    for (const tool of [...TIER3_TOOLS, ...TIER4_TOOLS]) {
      assert.equal(requiresApproval(tool), true, tool);
    }
  });
  it("approvalRef is a stable 16-hex hash", () => {
    const ref = approvalRef(APPROVAL);
    assert.equal(ref, approvalRef(APPROVAL));
    assert.match(ref as string, /^[0-9a-f]{16}$/);
  });
  it("approvalRef is null without a token", () => {
    assert.equal(approvalRef(null), null);
    assert.equal(approvalRef(""), null);
  });
});

describe("audit lines", () => {
  it("allow line carries the full shape", () => {
    const line = buildLine("trillium", "lifecycle_interrupt", "allow", "ok", {
      approval: APPROVAL,
      target: "fm-task1",
      ts: "2026-09-13T18:00:00Z",
    });
    assert.deepEqual([...Object.keys(line)].sort(), [...AUDIT_KEYS].sort());
    assert.equal(line.v, 1);
    assert.equal(line.actor, "trillium");
    assert.equal(line.tool, "lifecycle_interrupt");
    assert.equal(line.tier, 3);
    assert.equal(line.decision, "allow");
    assert.equal(line.reason, "ok");
    assert.equal(line.approval_ref, approvalRef(APPROVAL));
    assert.equal(line.target, "fm-task1");
  });
  it("refuse line works without a token", () => {
    const line = buildLine("trillium", "relay_reply", "refuse", "approval-required");
    assert.equal(line.tier, 4);
    assert.equal(line.decision, "refuse");
    assert.equal(line.approval_ref, null);
    assert.equal(line.target, null);
  });
  it("forbidden and unknown tiers", () => {
    assert.equal(buildLine("trillium", "merge_pr", "refuse", "forbidden").tier, "forbidden");
    assert.equal(buildLine("trillium", "nope", "refuse", "unknown-tool").tier, null);
  });
  it("timestamps are UTC ISO-8601", () => {
    const line = buildLine("trillium", "backlog", "allow", "ok");
    assert.match(line.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
  it("format is a single JSON line", () => {
    const line = buildLine("trillium", "backlog", "allow", "ok", {
      ts: "2026-09-13T18:00:00Z",
    });
    const raw = formatLine(line);
    assert.equal(raw.includes("\n"), false);
    assert.deepEqual(JSON.parse(raw), JSON.parse(JSON.stringify(line)));
  });
  it("never logs token text", () => {
    const line = buildLine("trillium", "spawn_crew", "allow", "ok", { approval: APPROVAL });
    assert.equal(formatLine(line).includes(APPROVAL), false);
  });
  it("append and read round-trip", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fm-ts-audit-"));
    const file = path.join(tmp, "audit.jsonl");
    const first = buildLine("trillium", "backlog", "allow", "ok");
    const second = buildLine("trillium", "relay_reply", "refuse", "approval-required");
    appendAudit(file, first);
    appendAudit(file, second);
    const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    assert.equal(rows.length, 2);
    assert.deepEqual(readAuditLines(file), [first, second]);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
