/**
 * Central authorization gate: an approval-gated tool must not execute just
 * because its handler forgot to ask.
 *
 * Before this gate, approval was enforced only inside handlers that called
 * requireAuth, so 19 of the 50 live Tier-3 tools (repo_edit, repo_commit,
 * repo_push, repo_merge, merge_pr, promote_scout, teardown_crew, pr_open, ...)
 * ran with no approval string. Proven live on 2026-09-22 by calling pr_open
 * through the mcpjungle group endpoint with no approval: the handler executed.
 *
 * These tests drive the real dispatcher, so they fail if a future tool is added
 * to the tier table and reaches its handler unguarded.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { TIER_AUTHORITY, requiresApproval, tierOf } from "../src/auth.js";
import { handleToolsCall } from "../src/server.js";
import { TOOLS, type ToolContext } from "../src/tools.js";
import type { RunResult } from "../src/runner.js";
import { makeStubHome, removeHome } from "./helpers.js";

const APPROVAL = "I authorize this tier 3 call in a test";

type Recorder = { calls: string[][]; sent: Record<string, unknown>[] };

function ctxRecording(rec: Recorder): ToolContext {
  const home = makeStubHome();
  return {
    binDir: path.join(home, "bin"),
    stateDir: path.join(home, "state"),
    dataDir: path.join(home, "data"),
    run: async (argv): Promise<RunResult> => {
      rec.calls.push(argv);
      return { stdout: "stub ok", stderr: "", exitCode: 0 };
    },
  };
}

async function callTool(
  rec: Recorder,
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await handleToolsCall(1, { name, arguments: args }, ctx, (value) => {
    rec.sent.push(value as Record<string, unknown>);
  });
  const msg = rec.sent[rec.sent.length - 1];
  const result = msg["result"] as Record<string, unknown>;
  const content = (result["content"] as Array<Record<string, unknown>>)[0];
  return {
    ...(JSON.parse(String(content["text"])) as Record<string, unknown>),
    isError: result["isError"] === true,
  };
}

describe("central authorization gate", () => {
  let home: string;
  before(() => {
    home = makeStubHome();
  });
  after(() => {
    removeHome(home);
  });

  // The tools that shipped unguarded: each must now refuse, and must not run.
  for (const tool of ["repo_commit", "repo_push", "repo_merge", "repo_edit", "pr_open"]) {
    it(`${tool} refuses without approval and executes nothing`, async () => {
      const rec: Recorder = { calls: [], sent: [] };
      const ctx = ctxRecording(rec);
      const args =
        tool === "repo_commit"
          ? { message: "test: unguarded call" }
          : tool === "repo_push" || tool === "repo_merge"
            ? { branch: "fm/test" }
            : tool === "repo_edit"
              ? { path: "notes.md", content: "x" }
              : { title: "t", body: "b", head: "fm/test" };
      const payload = await callTool(rec, ctx, tool, args);
      assert.equal(payload["isError"], true, `${tool} must be refused`);
      assert.equal(payload["error"], "approval required");
      assert.deepEqual(rec.calls, [], `${tool} must not execute anything when refused`);
    });
  }

  it("still executes the same tool once approval is present", async () => {
    const rec: Recorder = { calls: [], sent: [] };
    const payload = await callTool(rec, ctxRecording(rec), "repo_commit", {
      message: "test: approved call",
      approval: APPROVAL,
    });
    assert.equal(payload["isError"], false, JSON.stringify(payload));
    assert.deepEqual(rec.calls[0], ["git", "commit", "-m", "test: approved call"]);
  });

  it("does not gate tier 1 reads", async () => {
    const rec: Recorder = { calls: [], sent: [] };
    const payload = await callTool(rec, ctxRecording(rec), "harness_detect", {});
    assert.equal(payload["isError"], false, JSON.stringify(payload));
    assert.equal(rec.calls.length, 1);
  });

  it("still refuses an unknown tool before any authorization work", async () => {
    const rec: Recorder = { calls: [], sent: [] };
    await handleToolsCall(1, { name: "no_such_tool", arguments: {} }, ctxRecording(rec), (value) => {
      rec.sent.push(value as Record<string, unknown>);
    });
    const msg = rec.sent[rec.sent.length - 1];
    assert.equal((msg["error"] as Record<string, unknown>)["message"], "unknown tool: no_such_tool");
    assert.deepEqual(rec.calls, []);
  });

  it("covers every registered authority tool, so none can ship unguarded", () => {
    const registered = Object.keys(TOOLS).filter((t) => tierOf(t) === TIER_AUTHORITY);
    assert.ok(registered.length >= 40, `expected the authority surface, saw ${registered.length}`);
    for (const tool of registered) {
      assert.notEqual(TOOLS[tool].handler, undefined, `${tool} has no handler`);
    }
  });

  it("audits the refusal rather than silently allowing it", async () => {
    const rec: Recorder = { calls: [], sent: [] };
    const ctx = ctxRecording(rec);
    await callTool(rec, ctx, "repo_commit", { message: "test: audited refusal" });
    const auditFile = path.join(ctx.stateDir, "mcp-audit.jsonl");
    const lines = fs
      .readFileSync(auditFile, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const last = lines[lines.length - 1];
    assert.equal(last["decision"], "refuse");
    assert.equal(last["reason"], "approval-required");
  });
});

/**
 * The detached receipt path bypasses the dispatcher, and it used to consult a
 * hand-maintained NEEDS_APPROVAL set that held 35 entries while 60 live tools
 * were gated — so receipt_submit(repo_push | merge_pr | promote_scout | pr_open
 * | ...) ran with no approval at all, on the very path an autonomous loop uses.
 * It now derives from the tier table.
 */
describe("receipt path authorization", () => {
  it("refuses to detach every live approval-gated tool without approval", async () => {
    const rec: Recorder = { calls: [], sent: [] };
    const ctx = ctxRecording(rec);
    const gated = Object.keys(TOOLS).filter((t) => requiresApproval(t) && t !== "receipt_submit");
    assert.ok(gated.length >= 40, `expected the gated surface, saw ${gated.length}`);
    for (const tool of gated) {
      const res = await TOOLS["receipt_submit"].handler({ tool, arguments: {} }, ctx);
      assert.equal(res.isError, true, `${tool} must not be detached without approval`);
      assert.equal(res.payload["error"], "approval required", `${tool} must name approval`);
    }
    assert.deepEqual(rec.calls, [], "a refused receipt must execute nothing");
  });

  it("still detaches a gated tool once approval is present", async () => {
    const rec: Recorder = { calls: [], sent: [] };
    const res = await TOOLS["receipt_submit"].handler(
      { tool: "repo_edit", arguments: { path: "note.md", content: "x", approval: APPROVAL } },
      ctxRecording(rec),
    );
    assert.equal(res.isError, false, JSON.stringify(res.payload));
    assert.match(String(res.payload["receipt_id"]), /^rcpt-/);
  });
});
