/**
 * End-to-end proof for the TypeScript smarts-only server.
 *
 * Preserved-provenance suite: every check mirrors test_client.py (the
 * upstream 87-check proof for the Python path) against the TS server, so
 * the shared behavioral contract is the referee between the two
 * implementations. Self-contained: stub firstmate homes pinned via FM_HOME.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  APPROVAL,
  Client,
  isError,
  makeStubHome,
  makeTasksStubHome,
  payload,
  removeHome,
} from "./helpers.js";
import { TIER_FORBIDDEN, TIER_OPEN, TIER_STEER, tierOf } from "../src/auth.js";
import { TOOLS } from "../src/tools.js";

describe("handshake and reads", () => {
  let client: Client;
  let home: string;
  before(() => {
    home = makeStubHome();
    client = new Client({ FM_HOME: home });
  });
  after(async () => {
    await client.close();
    removeHome(home);
  });

  it("handshake negotiates version", async () => {
    const resp = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "poc-test-client", version: "0.1.0" },
    });
    assert.equal((resp.result as Record<string, unknown>)["protocolVersion"], "2024-11-05");
  });

  it("server identifies itself", async () => {
    const resp = await client.request("initialize", { protocolVersion: "2024-11-05" });
    const info = (resp.result as Record<string, unknown>)["serverInfo"] as Record<string, string>;
    assert.equal(info["name"], "firstmate-mcp-poc");
    client.notify("notifications/initialized");
  });

  it("tools list keeps the 5 PoC tools", async () => {
    const resp = await client.request("tools/list");
    const names = new Set(
      ((resp.result as Record<string, unknown>)["tools"] as Array<{ name: string }>).map((t) => t.name),
    );
    for (const required of ["fleet_snapshot", "backlog", "crew_state", "status_tail", "send_message"]) {
      assert.ok(names.has(required), `missing ${required}`);
    }
  });

  it("tools carry input schemas", async () => {
    const resp = await client.request("tools/list");
    const tools = (resp.result as Record<string, unknown>)["tools"] as Array<Record<string, unknown>>;
    for (const tool of tools) assert.ok("inputSchema" in tool, JSON.stringify(tool).slice(0, 120));
  });

  it("fleet_snapshot returns canonical schema", async () => {
    const snap = payload(await client.call("fleet_snapshot", {}));
    assert.equal(snap["schema"], "fm-fleet-snapshot.v1");
  });

  it("fleet_snapshot has backlog plus tasks", async () => {
    const snap = payload(await client.call("fleet_snapshot", {}));
    assert.ok("backlog" in snap && "tasks" in snap);
  });

  it("backlog returns records plus counts", async () => {
    const back = payload(await client.call("backlog", {}));
    assert.ok("backlog" in back && "task_counts" in back);
  });

  it("crew_state answers unknown for missing id", async () => {
    const state = payload(await client.call("crew_state", { id: "no-such-id" }));
    assert.equal((state["current"] as Record<string, string>)["state"], "unknown");
  });

  it("crew_state rejects traversal", async () => {
    assert.equal(isError(await client.call("crew_state", { id: "../escape" })), true);
  });

  it("status_tail missing id is structured error", async () => {
    assert.equal(isError(await client.call("status_tail", { id: "no-such-id", lines: 5 })), true);
  });

  it("status_tail rejects traversal", async () => {
    assert.equal(isError(await client.call("status_tail", { id: "x/../../y" })), true);
  });

  it("send_message fail-closed stays structured", async () => {
    assert.equal(isError(await client.call("send_message", { target: "no-such-id", text: "hello" })), true);
  });

  it("send_message refuses slash", async () => {
    const err = payload(await client.call("send_message", { target: "x", text: "/merge now" }));
    assert.match(String(err["error"] ?? ""), /slash/);
  });

  it("send_message refuses multiline", async () => {
    assert.equal(isError(await client.call("send_message", { target: "x", text: "one\ntwo" })), true);
  });

  it("send_message enforces length cap", async () => {
    assert.equal(isError(await client.call("send_message", { target: "x", text: "z".repeat(501) })), true);
  });

  it("unknown tool is JSON-RPC error", async () => {
    const resp = await client.call("nope", {});
    assert.ok("error" in resp && resp.error!.code === -32602);
  });

  it("ping answers", async () => {
    const resp = await client.request("ping");
    assert.deepEqual(resp.result, {});
  });
});

describe("expanded surface: 66 tools", () => {
  let boxed: Client;
  let sandbox: string;
  before(() => {
    sandbox = makeStubHome();
    boxed = new Client({ FM_HOME: sandbox });
    boxed.notify("notifications/initialized");
  });
  after(async () => {
    await boxed.close();
    removeHome(sandbox);
  });

  const REQUIRED = [
    "lifecycle_interrupt", "lifecycle_exit", "lifecycle_relaunch", "lifecycle_suspend",
    "lifecycle_resume", "spawn_crew", "scaffold_brief", "decision_hold",
    "decision_resolve", "decision_release", "decision_complete", "decision_verify",
    "decision_open", "decision_diverged", "review_decision", "relay_reply",
    "relay_dismiss", "relay_followup", "fleet_poll", "peek",
    "fleet_view", "review_diff", "bearings_snapshot", "wake_drain",
    "guard_check", "remote_doctor", "remote_file", "remote_delta",
    "extension_list", "extension_inspect", "handoff_status", "secondmate_nudge",
    "secondmate_restart", "secondmate_report", "remote_control", "handoff_move",
    "harness_detect", "project_mode", "lock_status", "lease_check",
    "bearings_board_path", "inbox_status", "inbox_list", "home_summary",
    "home_summary_refresh", "contributions_snapshot", "contributions_pending", "mail_status",
    "mail_read", "mail_check", "voice_status", "lint_versions",
    "tool_update_check", "vendor_auth_probe", "startup_memory", "pr_state",
    "pr_poll", "relay_poll", "public_followup_pending", "public_followup_collect",
    "tasks_list", "tasks_show", "tasks_ready", "dispatch_resolve",
    "sessionstart_nudge", "startup_network_report", "doc_audience_check", "home_seed_validate",
    "stow_cascade", "test_isolation_list", "test_run_list", "pr_reviewers",
    "arm_policy_check", "cd_policy_check", "subagent_policy_check", "supervision_instructions",
    "quota_choose", "voice_queue", "mail_send", "receipt_submit",
    "receipt_status", "repo_edit", "repo_commit", "repo_push",
    "daemon_status", "task_intake", "worktree_allocate", "lifecycle_drive",
    "review_gate", "reconcile_upstream", "grant_mint", "grant_revoke",
    "grant_status",
  ];
  // Registered so the dispatcher can refuse them by name, never advertised.
  const HIDDEN = [
    "session_start", "sessionstart_run", "sessionstart_cursor", "herdr_lab",
    "herdr_ci_cleanup", "session_cleanup", "claude_trust", "agy_trust",
    "claude_stop_autoarm", "herdr_eventwait", "herdr_workspace_move", "promote_scout",
    "teardown_crew", "arm_pr_check", "merge_pr", "merge_local",
    "public_followup_emit", "relay_link", "fleet_sync", "inactive_reconcile",
    "backlog_receive", "repo_merge", "daemon_start", "daemon_stop",
    "daemon_restart", "watch_start", "watch_stop", "herdr_spur",
  ];

  it("server lists every callable tool and no forbidden one", async () => {
    const resp = await boxed.request("tools/list");
    const tools = (resp.result as Record<string, unknown>)["tools"] as Array<{ name: string }>;
    // Derived, not a literal: the surface grows with each mirrored gap, and a
    // hardcoded count turns every tool addition into an unrelated failure.
    const callable = Object.keys(TOOLS).filter((name) => tierOf(name) !== TIER_FORBIDDEN);
    assert.equal(tools.length, callable.length);
    assert.equal(new Set(tools.map((t) => t.name)).size, tools.length, "tool names must be unique");
    for (const tool of tools) {
      assert.notEqual(
        tierOf(tool.name),
        TIER_FORBIDDEN,
        `${tool.name} is code-forbidden and must not be advertised`,
      );
    }
  });

  for (const hidden of HIDDEN) {
    it(`forbidden tool hidden from the list: ${hidden}`, async () => {
      const resp = await boxed.request("tools/list");
      const names = new Set(
        ((resp.result as Record<string, unknown>)["tools"] as Array<{ name: string }>).map((t) => t.name),
      );
      assert.equal(names.has(hidden), false, `${hidden} must not be advertised`);
      const call = await boxed.call(hidden, { approval: APPROVAL });
      assert.equal(isError(call), true, `${hidden} must still be refused when called directly`);
      assert.equal(String(payload(call)["error"] ?? ""), "forbidden", `${hidden} refusal must say forbidden`);
    });
  }

  for (const required of REQUIRED) {
    it(`tool present: ${required}`, async () => {
      const resp = await boxed.request("tools/list");
      const names = new Set(
        ((resp.result as Record<string, unknown>)["tools"] as Array<{ name: string }>).map((t) => t.name),
      );
      assert.ok(names.has(required));
    });
  }

  it("every approval-gated tool schema requires approval", async () => {
    const resp = await boxed.request("tools/list");
    const tools = (resp.result as Record<string, unknown>)["tools"] as Array<{
      name: string;
      inputSchema: { required?: string[] };
    }>;
    // Derived from the tier table, not a hand-maintained allowlist: that list was
    // how adding a new open read (doctor) turned into an unrelated failure here,
    // which is the same drift the code-forbidden set suffered from.
    for (const tool of tools) {
      const tier = tierOf(tool.name);
      if (tier === TIER_OPEN || tier === TIER_STEER || tier === TIER_FORBIDDEN) continue;
      assert.ok(
        (tool.inputSchema.required ?? []).includes("approval"),
        `${tool.name} schema must require approval`,
      );
    }
  });

  it("interrupt refuses without approval", async () => {
    const resp = await boxed.call("lifecycle_interrupt", { id: "no-such-id" });
    assert.ok(isError(resp) && String(payload(resp)["error"] ?? "").includes("approval"));
  });
  it("interrupt rejects traversal", async () => {
    assert.equal(isError(await boxed.call("lifecycle_interrupt", { id: "../escape", approval: APPROVAL })), true);
  });
  it("interrupt unknown id stays structured", async () => {
    assert.equal(
      isError(await boxed.call("lifecycle_interrupt", { id: "no-such-id", approval: APPROVAL })),
      true,
    );
  });
  it("exit refuses without approval", async () => {
    const resp = await boxed.call("lifecycle_exit", { id: "no-such-id" });
    assert.ok(isError(resp) && String(payload(resp)["error"] ?? "").includes("approval"));
  });
  it("exit unknown id stays structured", async () => {
    assert.equal(
      isError(await boxed.call("lifecycle_exit", { id: "no-such-id", approval: APPROVAL })),
      true,
    );
  });
  it("relaunch unknown id stays structured", async () => {
    assert.equal(
      isError(await boxed.call("lifecycle_relaunch", { id: "no-such-id", note: "retry", approval: APPROVAL })),
      true,
    );
  });
  it("relaunch requires note", async () => {
    assert.equal(
      isError(await boxed.call("lifecycle_relaunch", { id: "no-such-id", approval: APPROVAL })),
      true,
    );
  });
  it("suspend unknown id stays structured", async () => {
    assert.equal(
      isError(await boxed.call("lifecycle_suspend", { id: "no-such-id", note: "park", approval: APPROVAL })),
      true,
    );
  });
  it("resume unknown id stays structured", async () => {
    assert.equal(
      isError(await boxed.call("lifecycle_resume", { id: "no-such-id", note: "back", approval: APPROVAL })),
      true,
    );
  });
  it("spawn refuses without approval", async () => {
    const resp = await boxed.call("spawn_crew", {
      task_id: "no-such-id", project: "no-such-project", mode: "local-only", yolo: "off",
    });
    assert.ok(isError(resp) && String(payload(resp)["error"] ?? "").includes("approval"));
  });
  it("spawn rejects traversal id", async () => {
    assert.equal(
      isError(
        await boxed.call("spawn_crew", {
          task_id: "../x", project: "p", mode: "local-only", yolo: "off", approval: APPROVAL,
        }),
      ),
      true,
    );
  });
  it("spawn rejects absolute project", async () => {
    assert.equal(
      isError(
        await boxed.call("spawn_crew", {
          task_id: "no-such-id", project: "/abs/path", mode: "local-only", yolo: "off", approval: APPROVAL,
        }),
      ),
      true,
    );
  });
  it("spawn unknown target stays structured", async () => {
    assert.equal(
      isError(
        await boxed.call("spawn_crew", {
          task_id: "no-such-id", project: "no-such-project", mode: "local-only", yolo: "off", approval: APPROVAL,
        }),
      ),
      true,
    );
  });
  it("brief refuses without approval", async () => {
    const resp = await boxed.call("scaffold_brief", {
      task_id: "no-such-id", project: "no-such-project", mode: "scout",
    });
    assert.ok(isError(resp) && String(payload(resp)["error"] ?? "").includes("approval"));
  });
  it("brief rejects bad mode", async () => {
    assert.equal(
      isError(
        await boxed.call("scaffold_brief", {
          task_id: "no-such-id", project: "no-such-project", mode: "bogus", approval: APPROVAL,
        }),
      ),
      true,
    );
  });
  it("decision hold refuses without approval", async () => {
    const resp = await boxed.call("decision_hold", {
      origin_id: "no-such-id", decision_key: "k1", title: "t", reason: "r",
    });
    assert.ok(isError(resp) && String(payload(resp)["error"] ?? "").includes("approval"));
  });
  it("decision resolve refuses without approval", async () => {
    const resp = await boxed.call("decision_resolve", {
      origin_id: "x", decision_key: "k", routed_to: "y", decision_text: "d",
    });
    assert.ok(isError(resp) && String(payload(resp)["error"] ?? "").includes("approval"));
  });
  it("decision resolve rejects empty decision_text", async () => {
    const resp = await boxed.call("decision_resolve", {
      origin_id: "x", decision_key: "k", routed_to: "y", decision_text: "   ", approval: APPROVAL,
    });
    assert.ok(isError(resp));
    assert.equal(payload(resp)["error"], "invalid decision_text");
  });
  it("decision release refuses without approval", async () => {
    const resp = await boxed.call("decision_release", {
      id: "agent-1-decision-key1", decision_text: "approved",
    });
    assert.ok(isError(resp) && String(payload(resp)["error"] ?? "").includes("approval"));
  });
  it("decision release rejects empty decision_text", async () => {
    const resp = await boxed.call("decision_release", {
      id: "agent-1-decision-key1", decision_text: "", approval: APPROVAL,
    });
    assert.ok(isError(resp));
    assert.equal(payload(resp)["error"], "invalid decision_text");
  });
  it("decision release refuses captain-opened hold without grant (SAFETY CORE)", async () => {
    const resp = await boxed.call("decision_release", {
      id: "captain-hold", decision_text: "approved release", approval: APPROVAL,
    });
    assert.ok(isError(resp));
    assert.equal(payload(resp)["error"], "release unauthorized");
    assert.ok(String(payload(resp)["detail"] ?? "").includes("captain-opened hold"));
  });
  it("decision release allows captain-opened hold when FM_RELEASE_GRANT is enabled", async () => {
    const grantClient = new Client({ FM_HOME: sandbox, FM_RELEASE_GRANT: "1" });
    try {
      const resp = await grantClient.call("decision_release", {
        id: "captain-hold", decision_text: "approved release", approval: APPROVAL,
      });
      assert.equal(isError(resp), false);
      assert.equal(payload(resp)["id"], "captain-hold");
      assert.ok(typeof payload(resp)["decision_digest"] === "string");
      assert.equal((payload(resp)["decision_digest"] as string).length, 64);
    } finally {
      await grantClient.close();
    }
  });
  it("decision release allows self-opened hold (matching FM_ACTOR)", async () => {
    const workerClient = new Client({ FM_HOME: sandbox, FM_ACTOR: "worker-1" });
    try {
      const resp = await workerClient.call("decision_release", {
        origin_id: "worker-1", decision_key: "auth-gate", routed_to: "task-2", decision_text: "approved release", approval: APPROVAL,
      });
      assert.equal(isError(resp), false);
      assert.equal(payload(resp)["origin_id"], "worker-1");
      assert.equal(payload(resp)["decision_key"], "auth-gate");
      assert.ok(typeof payload(resp)["decision_digest"] === "string");
    } finally {
      await workerClient.close();
    }
  });
  it("decision release refuses hold opened by different actor without grant", async () => {
    const workerClient = new Client({ FM_HOME: sandbox, FM_ACTOR: "worker-2" });
    try {
      const resp = await workerClient.call("decision_release", {
        origin_id: "worker-1", decision_key: "auth-gate", routed_to: "task-2", decision_text: "approved release", approval: APPROVAL,
      });
      assert.ok(isError(resp));
      assert.equal(payload(resp)["error"], "release unauthorized");
    } finally {
      await workerClient.close();
    }
  });
  it("decision complete refuses without approval", async () => {
    const resp = await boxed.call("decision_complete", { origin_id: "t1", none: true });
    assert.ok(isError(resp) && String(payload(resp)["error"] ?? "").includes("approval"));
  });
  it("decision complete rejects combining none with task_ids", async () => {
    const resp = await boxed.call("decision_complete", {
      origin_id: "t1", none: true, task_ids: ["t2"], approval: APPROVAL,
    });
    assert.ok(isError(resp));
    assert.equal(payload(resp)["error"], "invalid task_ids");
  });
  it("decision complete with none succeeds", async () => {
    const resp = await boxed.call("decision_complete", {
      origin_id: "t1", none: true, approval: APPROVAL,
    });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["origin_id"], "t1");
    assert.equal(payload(resp)["none"], true);
  });
  it("decision complete with task_ids succeeds", async () => {
    const resp = await boxed.call("decision_complete", {
      origin_id: "t1", task_ids: ["t2", "t3"], approval: APPROVAL,
    });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["origin_id"], "t1");
    assert.deepEqual(payload(resp)["task_ids"], ["t2", "t3"]);
  });
  it("decision verify succeeds without approval (open read)", async () => {
    const resp = await boxed.call("decision_verify", { origin_id: "t1" });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["origin_id"], "t1");
    assert.equal(payload(resp)["verified"], true);
  });
  it("decision open succeeds without approval (open read)", async () => {
    const resp = await boxed.call("decision_open", { id: "open-task", identity: true });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["id"], "open-task");
    assert.equal(payload(resp)["open"], true);
    assert.equal(payload(resp)["identity"], "2026-09-20T00:00:00Z 1");
  });
  it("decision diverged succeeds without approval (open read)", async () => {
    const resp = await boxed.call("decision_diverged", {});
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["diverged"], true);
    assert.equal(payload(resp)["count"], 1);
  });
  it("review refuses without approval", async () => {
    const resp = await boxed.call("review_decision", { id: "no-such-id", verdict: "approve" });
    assert.ok(isError(resp) && String(payload(resp)["error"] ?? "").includes("approval"));
  });
  it("review rejects bad verdict", async () => {
    assert.equal(
      isError(await boxed.call("review_decision", { id: "no-such-id", verdict: "bogus", approval: APPROVAL })),
      true,
    );
  });
  it("review comment verdict requires text", async () => {
    assert.equal(
      isError(await boxed.call("review_decision", { id: "no-such-id", verdict: "comment", approval: APPROVAL })),
      true,
    );
  });
  it("review with release refuses captain-opened hold without grant", async () => {
    const resp = await boxed.call("review_decision", {
      id: "captain-hold", verdict: "approve", release: true, approval: APPROVAL,
    });
    assert.ok(isError(resp));
    assert.equal(payload(resp)["error"], "release unauthorized");
  });
  it("review with release allows captain-opened hold when FM_RELEASE_GRANT is enabled", async () => {
    const grantClient = new Client({ FM_HOME: sandbox, FM_RELEASE_GRANT: "1" });
    try {
      const resp = await grantClient.call("review_decision", {
        id: "captain-hold", verdict: "approve", release: true, approval: APPROVAL,
      });
      assert.equal(isError(resp), false);
      assert.equal(payload(resp)["id"], "captain-hold");
      assert.equal(payload(resp)["verdict"], "approve");
      assert.equal(payload(resp)["release"], true);
      assert.ok(typeof payload(resp)["decision_digest"] === "string");
    } finally {
      await grantClient.close();
    }
  });
  it("review valid call reaches captain-hold answer and stays structured", async () => {
    const resp = await boxed.call("review_decision", { id: "t1", verdict: "approve", approval: APPROVAL });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["id"], "t1");
    assert.equal(payload(resp)["verdict"], "approve");
    assert.ok(typeof payload(resp)["decision_digest"] === "string");
  });
  it("relay reply refuses without approval", async () => {
    const resp = await boxed.call("relay_reply", { request_id: "no-such-id", text: "hello" });
    assert.ok(isError(resp) && String(payload(resp)["error"] ?? "").includes("approval"));
  });
  it("relay reply rejects traversal", async () => {
    assert.equal(
      isError(await boxed.call("relay_reply", { request_id: "../x", text: "hello", approval: APPROVAL })),
      true,
    );
  });
  it("relay dismiss refuses without approval", async () => {
    const resp = await boxed.call("relay_dismiss", { request_id: "no-such-id" });
    assert.ok(isError(resp) && String(payload(resp)["error"] ?? "").includes("approval"));
  });
  it("relay followup refuses without approval", async () => {
    const resp = await boxed.call("relay_followup", { task_id: "no-such-id", text: "done" });
    assert.ok(isError(resp) && String(payload(resp)["error"] ?? "").includes("approval"));
  });
  it("fleet_poll returns poll summaries", async () => {
    const resp = await boxed.call("fleet_poll", { count: 2, interval_s: 0 });
    const polled = payload(resp);
    assert.equal(isError(resp), false);
    assert.equal(((polled["polls"] as unknown[]) ?? []).length, 2);
  });
  it("peek returns bounded tail with target echoed", async () => {
    const resp = await boxed.call("peek", { target: "no-such-id" });
    const peeked = payload(resp);
    assert.equal(isError(resp), false);
    assert.equal(peeked["target"], "no-such-id");
    assert.ok("stdout" in peeked);
  });
  it("peek rejects traversal", async () => {
    assert.equal(isError(await boxed.call("peek", { target: "../escape" })), true);
  });
  it("peek rejects bad lines", async () => {
    assert.equal(isError(await boxed.call("peek", { target: "x", lines: "many" })), true);
  });
  it("fleet_view returns human render", async () => {
    const resp = await boxed.call("fleet_view", {});
    assert.equal(isError(resp), false);
    assert.ok("stdout" in payload(resp));
  });
  it("review_diff unknown id stays structured", async () => {
    assert.equal(isError(await boxed.call("review_diff", { id: "no-such-id" })), false);
  });
  it("review_diff rejects traversal", async () => {
    assert.equal(isError(await boxed.call("review_diff", { id: "../escape" })), true);
  });
  it("review_diff rejects non-bool stat", async () => {
    assert.equal(isError(await boxed.call("review_diff", { id: "x", stat: "yes" })), true);
  });
  it("bearings_snapshot returns fm-bearings.v1", async () => {
    const resp = await boxed.call("bearings_snapshot", {});
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["schema"], "fm-bearings.v1");
  });
  it("wake_drain drains to structured text", async () => {
    const resp = await boxed.call("wake_drain", {});
    assert.equal(isError(resp), false);
    assert.ok("stdout" in payload(resp));
  });
  it("guard_check returns verdict text", async () => {
    const resp = await boxed.call("guard_check", {});
    assert.equal(isError(resp), false);
    assert.ok("stdout" in payload(resp));
  });
  it("remote_doctor returns check-mode diagnostic", async () => {
    const resp = await boxed.call("remote_doctor", {});
    assert.equal(isError(resp), false);
    assert.ok(String(payload(resp)["stdout"] ?? "").includes("doctor-stub"));
  });
  it("remote_file returns bounded bytes with path echoed", async () => {
    const resp = await boxed.call("remote_file", { path: "data/probe.txt" });
    const filed = payload(resp);
    assert.equal(isError(resp), false);
    assert.equal(filed["path"], "data/probe.txt");
    assert.equal(filed["max_bytes"], 8192);
    assert.ok("stdout" in filed);
  });
  it("remote_file rejects traversal", async () => {
    assert.equal(isError(await boxed.call("remote_file", { path: "../escape" })), true);
  });
  it("remote_file rejects bad max_bytes", async () => {
    assert.equal(isError(await boxed.call("remote_file", { path: "x", max_bytes: "big" })), true);
  });
  it("remote_delta returns appended bytes with log echoed", async () => {
    const resp = await boxed.call("remote_delta", {
      log: "state/job.log", offset: 0, sha256: "e".repeat(64),
    });
    const delta = payload(resp);
    assert.equal(isError(resp), false);
    assert.equal(delta["log"], "state/job.log");
    assert.equal(delta["offset"], 0);
    assert.ok("stdout" in delta);
  });
  it("remote_delta rejects traversal", async () => {
    assert.equal(
      isError(await boxed.call("remote_delta", { log: "../x", offset: 0, sha256: "e".repeat(64) })),
      true,
    );
  });
  it("remote_delta rejects bad offset", async () => {
    assert.equal(
      isError(await boxed.call("remote_delta", { log: "x", offset: -1, sha256: "e".repeat(64) })),
      true,
    );
  });
  it("remote_delta rejects bad sha256", async () => {
    assert.equal(
      isError(await boxed.call("remote_delta", { log: "x", offset: 0, sha256: "short" })),
      true,
    );
  });
  it("extension_list returns binding table without error", async () => {
    const resp = await boxed.call("extension_list", {});
    assert.equal(isError(resp), false);
    assert.ok(String(payload(resp)["stdout"] ?? "").includes("extension-stub:list"));
  });
  it("extension_inspect returns binding with id echoed", async () => {
    const resp = await boxed.call("extension_inspect", { id: "org.example.probe" });
    const inspected = payload(resp);
    assert.equal(isError(resp), false);
    assert.equal(inspected["id"], "org.example.probe");
    assert.ok(String(inspected["stdout"] ?? "").includes("extension-stub:inspect"));
  });
  it("extension_inspect rejects bad ids", async () => {
    for (const id of ["../escape", "UPPER", "trailing.", "", "a".repeat(129)]) {
      assert.equal(isError(await boxed.call("extension_inspect", { id })), true, String(id));
    }
  });
  it("remote-mutating verbs are refused as unknown, even with approval", async () => {
    for (const name of [
      "on_execute", "config_push", "remote_entrypoint", "remote_herdr_guard",
      "remote_provision", "remote_seed", "inherit_push", "remote_inherit",
      "reap_orphans", "remote_worker",
    ]) {
      for (const args of [{}, { approval: APPROVAL }]) {
        const resp = await boxed.call(name, args);
        assert.ok("error" in resp && resp.error!.code === -32602, `${name} ${JSON.stringify(args)}`);
        assert.match(String(resp.error!.message ?? ""), /unknown tool/i, name);
      }
    }
  });
  it("remote_delta rejects bad wait", async () => {
    assert.equal(
      isError(
        await boxed.call("remote_delta", { log: "x", offset: 0, sha256: "e".repeat(64), wait: "long" }),
      ),
      true,
    );
  });
  it("handoff_status lists staged outboxes", async () => {
    const resp = await boxed.call("handoff_status", {});
    assert.equal(isError(resp), false);
    assert.deepEqual(payload(resp)["outboxes"], []);
  });
  it("handoff_status rejects traversal", async () => {
    assert.equal(isError(await boxed.call("handoff_status", { id: "../escape" })), true);
  });
  it("handoff_status missing id is structured error", async () => {
    assert.equal(isError(await boxed.call("handoff_status", { id: "ghost" })), true);
  });
  it("nudge refuses without approval", async () => {
    const resp = await boxed.call("secondmate_nudge", {});
    assert.ok(isError(resp) && String(payload(resp)["error"] ?? "").includes("approval"));
  });
  it("nudge unknown home stays structured", async () => {
    assert.equal(isError(await boxed.call("secondmate_nudge", { approval: APPROVAL })), true);
  });
  it("restart refuses without approval", async () => {
    const resp = await boxed.call("secondmate_restart", { ids: ["m1"] });
    assert.ok(isError(resp) && String(payload(resp)["error"] ?? "").includes("approval"));
  });
  it("restart rejects traversal ids", async () => {
    assert.equal(
      isError(await boxed.call("secondmate_restart", { ids: ["../x"], approval: APPROVAL })),
      true,
    );
  });
  it("restart rejects empty ids", async () => {
    assert.equal(
      isError(await boxed.call("secondmate_restart", { ids: [], approval: APPROVAL })),
      true,
    );
  });
  it("restart unknown mate stays structured", async () => {
    assert.equal(
      isError(await boxed.call("secondmate_restart", { ids: ["m1"], approval: APPROVAL })),
      true,
    );
  });
  it("report refuses without approval", async () => {
    const resp = await boxed.call("secondmate_report", {
      verb: "done", corr: "a".repeat(16), note: "ok",
    });
    assert.ok(isError(resp) && String(payload(resp)["error"] ?? "").includes("approval"));
  });
  it("report rejects bad corr", async () => {
    assert.equal(
      isError(
        await boxed.call("secondmate_report", {
          verb: "done", corr: "short", note: "ok", approval: APPROVAL,
        }),
      ),
      true,
    );
  });
  it("report rejects bad verb", async () => {
    assert.equal(
      isError(
        await boxed.call("secondmate_report", {
          verb: "has space", corr: "a".repeat(16), note: "ok", approval: APPROVAL,
        }),
      ),
      true,
    );
  });
  it("report unknown home stays structured", async () => {
    assert.equal(
      isError(
        await boxed.call("secondmate_report", {
          verb: "done", corr: "a".repeat(16), note: "ok", approval: APPROVAL,
        }),
      ),
      true,
    );
  });
  it("remote control refuses without approval", async () => {
    const resp = await boxed.call("remote_control", { verb: "state", id: "m1" });
    assert.ok(isError(resp) && String(payload(resp)["error"] ?? "").includes("approval"));
  });
  it("remote control refuses launch verb", async () => {
    assert.equal(
      isError(await boxed.call("remote_control", { verb: "launch", id: "m1", approval: APPROVAL })),
      true,
    );
  });
  it("remote control refuses retire verb", async () => {
    assert.equal(
      isError(await boxed.call("remote_control", { verb: "retire", id: "m1", approval: APPROVAL })),
      true,
    );
  });
  it("remote control send refuses slash", async () => {
    assert.equal(
      isError(
        await boxed.call("remote_control", {
          verb: "send", id: "m1", text: "/raw key", approval: APPROVAL,
        }),
      ),
      true,
    );
  });
  it("remote control unknown mate stays structured", async () => {
    assert.equal(
      isError(await boxed.call("remote_control", { verb: "state", id: "m1", approval: APPROVAL })),
      true,
    );
  });
  it("handoff refuses without approval", async () => {
    const resp = await boxed.call("handoff_move", { id: "m1", keys: ["k1"] });
    assert.ok(isError(resp) && String(payload(resp)["error"] ?? "").includes("approval"));
  });
  it("handoff rejects empty keys", async () => {
    assert.equal(
      isError(await boxed.call("handoff_move", { id: "m1", keys: [], approval: APPROVAL })),
      true,
    );
  });
  it("handoff rejects non-bool resume", async () => {
    assert.equal(
      isError(await boxed.call("handoff_move", { id: "m1", resume: "yes", approval: APPROVAL })),
      true,
    );
  });
  it("handoff unknown mate stays structured", async () => {
    assert.equal(
      isError(await boxed.call("handoff_move", { id: "m1", keys: ["k1"], approval: APPROVAL })),
      true,
    );
  });
  it("handoff resume stays structured", async () => {
    assert.equal(
      isError(await boxed.call("handoff_move", { id: "m1", resume: true, approval: APPROVAL })),
      true,
    );
  });
  it("harness_detect defaults to own and echoes the harness", async () => {
    const resp = await boxed.call("harness_detect", {});
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["mode"], "own");
    assert.equal(payload(resp)["harness"], "harness-stub:");
  });
  it("harness_detect passes the crew mode through", async () => {
    const resp = await boxed.call("harness_detect", { mode: "crew" });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["harness"], "harness-stub:crew");
  });
  it("harness_detect rejects unknown modes", async () => {
    assert.equal(isError(await boxed.call("harness_detect", { mode: "bogus" })), true);
  });
  it("project_mode returns the mapped mode+yolo pair", async () => {
    const resp = await boxed.call("project_mode", { project: "myproj" });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["project"], "myproj");
    assert.equal(payload(resp)["mode"], "local-only");
    assert.equal(payload(resp)["yolo"], "off");
  });
  it("project_mode rejects traversal", async () => {
    assert.equal(isError(await boxed.call("project_mode", { project: "../escape" })), true);
  });
  it("lock_status reports the free projection", async () => {
    const resp = await boxed.call("lock_status", {});
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["status"], "free");
  });
  it("lease_check projects a held lease", async () => {
    const resp = await boxed.call("lease_check", { id: "leased-task" });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["leased"], true);
    assert.equal(payload(resp)["actor"], "main");
    assert.equal(payload(resp)["live"], true);
    assert.equal(payload(resp)["pid"], 4242);
  });
  it("lease_check reports unleased without error", async () => {
    const resp = await boxed.call("lease_check", { id: "ghost-task" });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["leased"], false);
  });
  it("lease_check rejects traversal", async () => {
    assert.equal(isError(await boxed.call("lease_check", { id: "../escape" })), true);
  });
  it("bearings_board_path returns the stable path", async () => {
    const resp = await boxed.call("bearings_board_path", {});
    assert.equal(isError(resp), false);
    assert.ok(
      ((payload(resp)["path"] as string) ?? "").endsWith("bearings-board.html"),
    );
  });
  it("inbox_status reads without sending a wake", async () => {
    const resp = await boxed.call("inbox_status", {});
    assert.equal(isError(resp), false);
    assert.ok(((payload(resp)["stdout"] as string) ?? "").includes("inbox-stub:status"));
  });
  it("inbox_list reads the queued notes", async () => {
    const resp = await boxed.call("inbox_list", {});
    assert.equal(isError(resp), false);
    assert.ok(((payload(resp)["stdout"] as string) ?? "").includes("inbox-stub:list"));
  });
  it("home_summary without a ledger is a structured error", async () => {
    const resp = await boxed.call("home_summary", {});
    assert.equal(isError(resp), true);
    assert.equal(payload(resp)["error"], "no home summary");
  });
  it("home_summary returns the published ledger", async () => {
    fs.writeFileSync(
      path.join(sandbox, "state", "home-summary.json"),
      JSON.stringify({ schema: "fm-secondmate-home-summary.v1", generated: "stub" }),
      "utf8",
    );
    const resp = await boxed.call("home_summary", {});
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["schema"], "fm-secondmate-home-summary.v1");
  });
  it("home_summary_refresh runs the refresh stub", async () => {
    const resp = await boxed.call("home_summary_refresh", {});
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["best_effort"], false);
    assert.ok(((payload(resp)["stdout"] as string) ?? "").includes("home-summary-refresh-stub"));
  });
  it("home_summary_refresh echoes the best_effort flag", async () => {
    const resp = await boxed.call("home_summary_refresh", { best_effort: true });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["best_effort"], true);
    assert.ok(((payload(resp)["stdout"] as string) ?? "").includes("--best-effort"));
  });
  it("home_summary_refresh rejects non-bool best_effort", async () => {
    assert.equal(isError(await boxed.call("home_summary_refresh", { best_effort: "yes" })), true);
  });
  it("contributions_snapshot projects coverage without a forge", async () => {
    const resp = await boxed.call("contributions_snapshot", {});
    assert.equal(isError(resp), false);
    assert.ok("backlog" in payload(resp));
    assert.equal(payload(resp)["all"], false);
  });
  it("contributions_snapshot echoes the all flag", async () => {
    const resp = await boxed.call("contributions_snapshot", { all: true });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["all"], true);
  });
  it("contributions_snapshot rejects non-bool all", async () => {
    assert.equal(isError(await boxed.call("contributions_snapshot", { all: "yes" })), true);
  });
  it("contributions_pending returns the token list", async () => {
    const resp = await boxed.call("contributions_pending", {});
    assert.equal(isError(resp), false);
    assert.deepEqual(payload(resp)["pending"], []);
  });
  it("mail_status reads config without network", async () => {
    const resp = await boxed.call("mail_status", {});
    assert.equal(isError(resp), false);
    assert.ok(String(payload(resp)["stdout"] ?? "").includes("mail-stub:status"));
  });
  it("mail_read returns a never-marks-seen digest", async () => {
    const resp = await boxed.call("mail_read", {});
    assert.equal(isError(resp), false);
    assert.ok(String(payload(resp)["stdout"] ?? "").includes("mail-stub:read"));
    assert.ok(String(payload(resp)["warning"] ?? "").includes("BODY.PEEK"));
  });
  it("mail_check runs the bounded inbound check", async () => {
    const resp = await boxed.call("mail_check", {});
    assert.equal(isError(resp), false);
    assert.ok(String(payload(resp)["stdout"] ?? "").includes("mail-check-stub:check"));
  });
  it("mail_send refuses without approval", async () => {
    const resp = await boxed.call("mail_send", { to: "a@example.com", subject: "hi", body: "hello" });
    assert.ok(isError(resp) && String(payload(resp)["error"] ?? "").includes("approval"));
  });
  it("mail_send rejects bad recipient", async () => {
    assert.equal(
      isError(await boxed.call("mail_send", { to: "not-an-address", subject: "hi", body: "hello", approval: APPROVAL })),
      true,
    );
  });
  it("mail_send rejects multiline subject", async () => {
    assert.equal(
      isError(await boxed.call("mail_send", { to: "a@example.com", subject: "hi\nthere", body: "hello", approval: APPROVAL })),
      true,
    );
  });
  it("mail_send rejects empty body", async () => {
    assert.equal(
      isError(await boxed.call("mail_send", { to: "a@example.com", subject: "hi", body: "", approval: APPROVAL })),
      true,
    );
  });
  it("mail_send pipes the body via stdin with to echoed", async () => {
    const resp = await boxed.call("mail_send", {
      to: "a@example.com", subject: "hi", body: "hello via stdin", approval: APPROVAL,
    });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["to"], "a@example.com");
    assert.ok(String(payload(resp)["stdout"] ?? "").includes("mail-stub:sent"));
  });
  it("voice_status defaults to counts without mic or model", async () => {
    const resp = await boxed.call("voice_status", {});
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["scope"], "counts");
  });
  it("voice_status passes the full scope through", async () => {
    const resp = await boxed.call("voice_status", { scope: "full" });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["scope"], "full");
  });
  it("voice_status rejects unknown scopes", async () => {
    assert.equal(isError(await boxed.call("voice_status", { scope: "bogus" })), true);
  });
  it("voice_queue refuses without approval", async () => {
    const resp = await boxed.call("voice_queue", { text: "check the fleet" });
    assert.ok(isError(resp) && String(payload(resp)["error"] ?? "").includes("approval"));
  });
  it("voice_queue rejects multiline text", async () => {
    assert.equal(
      isError(await boxed.call("voice_queue", { text: "one\ntwo", approval: APPROVAL })),
      true,
    );
  });
  it("voice_queue hands the request over without audio", async () => {
    const resp = await boxed.call("voice_queue", { text: "check the fleet", approval: APPROVAL });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["queued"], true);
  });
  it("lint_versions returns both required pins", async () => {
    const resp = await boxed.call("lint_versions", {});
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["shellcheck"], "0.11.0");
    assert.equal(payload(resp)["actionlint"], "1.7.12");
  });
  it("lint_versions degrades when the workflows probe script is retired", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "fm-mcp-ts-nolintwf-"));
    fs.mkdirSync(path.join(home, "bin"));
    fs.writeFileSync(
      path.join(home, "bin", "fm-lint.sh"),
      '#!/bin/sh\nif [ "$1" = "--required-version" ]; then echo "0.11.0"; else exit 1; fi\n',
      { mode: 0o755 },
    );
    fs.mkdirSync(path.join(home, "state"));
    const thin = new Client({ FM_HOME: home });
    try {
      const resp = await thin.call("lint_versions", {});
      assert.equal(isError(resp), false);
      assert.equal(payload(resp)["shellcheck"], "0.11.0");
      assert.equal(
        (payload(resp)["actionlint"] as Record<string, unknown>)["error"],
        "unsupported probe",
      );
    } finally {
      await thin.close();
      removeHome(home);
    }
  });
  it("tool_update_check reports without repairing", async () => {
    const resp = await boxed.call("tool_update_check", {});
    assert.equal(isError(resp), false);
    assert.ok(String(payload(resp)["stdout"] ?? "").includes("tool-update-stub"));
  });
  it("vendor_auth_probe returns one sanitized line with probe echoed", async () => {
    const resp = await boxed.call("vendor_auth_probe", { probe: "grok" });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["probe"], "grok");
    assert.ok(String(payload(resp)["stdout"] ?? "").includes("status="));
  });
  it("vendor_auth_probe rejects probes outside the allowlist", async () => {
    assert.equal(isError(await boxed.call("vendor_auth_probe", { probe: "bogus" })), true);
  });
  it("startup_memory defaults to read with mode echoed", async () => {
    const resp = await boxed.call("startup_memory", {});
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["mode"], "read");
    assert.ok(String(payload(resp)["stdout"] ?? "").includes("memory-stub:read"));
  });
  it("startup_memory passes the report mode through", async () => {
    const resp = await boxed.call("startup_memory", { mode: "report" });
    assert.equal(isError(resp), false);
    assert.ok(String(payload(resp)["stdout"] ?? "").includes("memory-stub:report"));
  });
  it("startup_memory rejects unknown modes", async () => {
    assert.equal(isError(await boxed.call("startup_memory", { mode: "bogus" })), true);
  });
  it("pr_state reads blockers with url echoed", async () => {
    const resp = await boxed.call("pr_state", { url: "https://github.com/octo/repo/pull/42" });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["url"], "https://github.com/octo/repo/pull/42");
    assert.ok(String(payload(resp)["stdout"] ?? "").includes("pr-stub"));
  });
  it("pr_state rejects non-GitHub urls", async () => {
    assert.equal(
      isError(await boxed.call("pr_state", { url: "https://example.com/o/r/pull/1" })),
      true,
    );
  });
  it("pr_state rejects malformed urls", async () => {
    assert.equal(isError(await boxed.call("pr_state", { url: "not a url" })), true);
  });
  it("pr_poll checks merge status with url echoed", async () => {
    const resp = await boxed.call("pr_poll", { url: "https://github.com/octo/repo/pull/42" });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["url"], "https://github.com/octo/repo/pull/42");
    assert.ok(String(payload(resp)["stdout"] ?? "").includes("pr-poll-stub"));
  });
  it("pr_poll rejects non-GitHub urls", async () => {
    assert.equal(
      isError(await boxed.call("pr_poll", { url: "https://example.com/o/r/pull/1" })),
      true,
    );
  });
  it("pr_poll rejects malformed urls", async () => {
    assert.equal(isError(await boxed.call("pr_poll", { url: "not a url" })), true);
  });
  it("pr_reviewers reads candidates with url echoed", async () => {
    const resp = await boxed.call("pr_reviewers", { url: "https://github.com/octo/repo/pull/42" });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["url"], "https://github.com/octo/repo/pull/42");
    assert.ok(String(payload(resp)["stdout"] ?? "").includes("pr-reviewers-stub"));
  });
  it("pr_reviewers rejects non-GitHub urls", async () => {
    assert.equal(
      isError(await boxed.call("pr_reviewers", { url: "https://example.com/o/r/pull/1" })),
      true,
    );
  });
  it("pr_reviewers rejects malformed urls", async () => {
    assert.equal(isError(await boxed.call("pr_reviewers", { url: "not a url" })), true);
  });
  it("relay_poll short-polls without error", async () => {
    const resp = await boxed.call("relay_poll", {});
    assert.equal(isError(resp), false);
    assert.ok(String(payload(resp)["stdout"] ?? "").includes("x-poll stub"));
  });
  it("public_followup_pending reads open loops without error", async () => {
    const resp = await boxed.call("public_followup_pending", {});
    assert.equal(isError(resp), false);
    assert.ok(String(payload(resp)["stdout"] ?? "").includes("public-followup-stub:pending"));
  });
  it("public_followup_collect drains staged events with obligation echoed", async () => {
    const resp = await boxed.call("public_followup_collect", { obligation_id: "ob-1" });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["obligation_id"], "ob-1");
    assert.ok(String(payload(resp)["stdout"] ?? "").includes("public-followup-collect-stub:drain id=ob-1"));
  });
  it("public_followup_collect rejects traversal obligation id", async () => {
    assert.equal(isError(await boxed.call("public_followup_collect", { obligation_id: "../escape" })), true);
  });
  it("public_followup_emit refuses without approval", async () => {
    const resp = await boxed.call("public_followup_emit", {
      obligation_id: "ob-1",
      relation_id: "rel-1",
      source_home: "main",
      work_id: "task-1",
      generation: 1,
      outcome: "pr-merged",
      outcome_text: "done and landed",
    });
    assert.equal(isError(resp), true);
  });
  it("relay_link refuses without approval", async () => {
    const resp = await boxed.call("relay_link", {
      task_id: "task-1",
      request_id: "req-1",
    });
    assert.equal(isError(resp), true);
  });
  it("relay_link rejects traversal task_id", async () => {
    assert.equal(
      isError(await boxed.call("relay_link", { task_id: "../x", request_id: "req-1", approval: APPROVAL })),
      true,
    );
  });
  it("fleet_sync refuses without approval", async () => {
    const resp = await boxed.call("fleet_sync", {});
    assert.equal(isError(resp), true);
  });
  it("fleet_sync rejects traversal project", async () => {
    assert.equal(
      isError(await boxed.call("fleet_sync", { project: "../x", approval: APPROVAL })),
      true,
    );
  });
  it("inactive_reconcile refuses without approval", async () => {
    const resp = await boxed.call("inactive_reconcile", {});
    assert.equal(isError(resp), true);
  });
  it("inactive_reconcile rejects invalid mode", async () => {
    assert.equal(
      isError(await boxed.call("inactive_reconcile", { mode: "invalid", approval: APPROVAL })),
      true,
    );
  });
  it("inactive_reconcile report mode rejects traversal task_id", async () => {
    assert.equal(
      isError(await boxed.call("inactive_reconcile", { mode: "report", task_id: "../x", approval: APPROVAL })),
      true,
    );
  });
  it("inactive_reconcile acknowledge mode rejects non-hex fingerprint", async () => {
    assert.equal(
      isError(await boxed.call("inactive_reconcile", { mode: "acknowledge", fingerprint: "not-hex!", approval: APPROVAL })),
      true,
    );
  });
  it("tasks_list returns listing", async () => {
    const resp = await boxed.call("tasks_list", {});
    assert.equal(isError(resp), false);
  });
  it("tasks_list rejects invalid state", async () => {
    assert.equal(
      isError(await boxed.call("tasks_list", { state: "invalid_state" })),
      true,
    );
  });
  it("tasks_list rejects traversal repo", async () => {
    assert.equal(
      isError(await boxed.call("tasks_list", { repo: "../escape" })),
      true,
    );
  });
  it("tasks_show returns task details", async () => {
    const resp = await boxed.call("tasks_show", { id: "agent-hold" });
    assert.equal(isError(resp), false);
  });
  it("tasks_show rejects missing or invalid id", async () => {
    assert.equal(isError(await boxed.call("tasks_show", {})), true);
    assert.equal(isError(await boxed.call("tasks_show", { id: "../escape" })), true);
  });
  it("tasks_ready returns ready tasks", async () => {
    const resp = await boxed.call("tasks_ready", {});
    assert.equal(isError(resp), false);
  });
  it("backlog_receive refuses without approval", async () => {
    const resp = await boxed.call("backlog_receive", {});
    assert.equal(isError(resp), true);
  });
  it("backlog_receive rejects invalid path", async () => {
    assert.equal(
      isError(
        await boxed.call("backlog_receive", {
          path: "data/invalid.md",
          bytes: 100,
          sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          generation: 1,
          approval: APPROVAL,
        }),
      ),
      true,
    );
  });
  it("backlog_receive rejects invalid sha256", async () => {
    assert.equal(
      isError(
        await boxed.call("backlog_receive", {
          path: "state/handoff/sm1.outbox.md",
          bytes: 100,
          sha256: "not-64-hex",
          generation: 1,
          approval: APPROVAL,
        }),
      ),
      true,
    );
  });
  it("dispatch_resolve returns a plan without launching", async () => {
    const resp = await boxed.call("dispatch_resolve", { task_id: "task-1" });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["task_id"], "task-1");
  });
  it("dispatch_resolve rejects invalid task id", async () => {
    assert.equal(isError(await boxed.call("dispatch_resolve", { task_id: "../escape" })), true);
  });
  it("dispatch_resolve rejects invalid project", async () => {
    assert.equal(
      isError(await boxed.call("dispatch_resolve", { task_id: "task-1", project: "/abs" })),
      true,
    );
  });
  it("sessionstart_nudge returns fired projection", async () => {
    const resp = await boxed.call("sessionstart_nudge", {});
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["fired"], true);
  });
  it("startup_network_report returns the report stub", async () => {
    const resp = await boxed.call("startup_network_report", {});
    assert.equal(isError(resp), false);
    assert.match(String(payload(resp)["stdout"] ?? ""), /network-stub:report/);
  });
  it("doc_audience_check defaults root to this home", async () => {
    const resp = await boxed.call("doc_audience_check", {});
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["root"], sandbox);
  });
  it("doc_audience_check rejects roots outside the home", async () => {
    assert.equal(isError(await boxed.call("doc_audience_check", { root: "../escape" })), true);
    assert.equal(isError(await boxed.call("doc_audience_check", { root: "/abs" })), true);
  });
  it("home_seed_validate returns the validate stub", async () => {
    const resp = await boxed.call("home_seed_validate", {});
    assert.equal(isError(resp), false);
    assert.match(String(payload(resp)["stdout"] ?? ""), /home-seed-stub:validate/);
  });
  it("stow_cascade returns the cascade stub", async () => {
    const resp = await boxed.call("stow_cascade", {});
    assert.equal(isError(resp), false);
    assert.match(String(payload(resp)["stdout"] ?? ""), /stow-cascade-stub/);
  });
  it("test_isolation_list defaults to portable candidates", async () => {
    const resp = await boxed.call("test_isolation_list", {});
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["mode"], "candidates");
    assert.equal(payload(resp)["pool"], "portable");
    assert.match(String(payload(resp)["stdout"] ?? ""), /isolation-stub:--list pool=portable/);
  });
  it("test_isolation_list rejects bad mode and pool without spawn", async () => {
    assert.equal(isError(await boxed.call("test_isolation_list", { mode: "bogus" })), true);
    assert.equal(
      isError(await boxed.call("test_isolation_list", { pool: "../escape" })),
      true,
    );
  });
  it("test_run_list defaults to families", async () => {
    const resp = await boxed.call("test_run_list", {});
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["mode"], "families");
    assert.match(String(payload(resp)["stdout"] ?? ""), /test-run-stub:--list-families/);
  });
  it("test_run_list rejects bad mode without spawn", async () => {
    assert.equal(isError(await boxed.call("test_run_list", { mode: "bogus" })), true);
  });
  it("arm_policy_check allows a benign command", async () => {
    const resp = await boxed.call("arm_policy_check", { command: "git status" });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["verdict"], "allow");
    assert.equal(payload(resp)["command"], "git status");
  });
  it("arm_policy_check denies the stubbed command as a verdict, not an error", async () => {
    const resp = await boxed.call("arm_policy_check", { command: "deny-me" });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["verdict"], "deny");
    assert.ok(String(payload(resp)["stdout"] ?? "").includes("deny"));
  });
  it("arm_policy_check rejects empty and oversized commands without spawn", async () => {
    assert.equal(isError(await boxed.call("arm_policy_check", { command: "" })), true);
    assert.equal(isError(await boxed.call("arm_policy_check", { command: "x".repeat(4001) })), true);
    assert.equal(isError(await boxed.call("arm_policy_check", {})), true);
  });
  it("cd_policy_check allows a benign command", async () => {
    const resp = await boxed.call("cd_policy_check", { command: "git status" });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["verdict"], "allow");
  });
  it("cd_policy_check denies the stubbed command as a verdict, not an error", async () => {
    const resp = await boxed.call("cd_policy_check", { command: "deny-me" });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["verdict"], "deny");
  });
  it("cd_policy_check rejects empty commands without spawn", async () => {
    assert.equal(isError(await boxed.call("cd_policy_check", { command: "" })), true);
  });
  it("subagent_policy_check allows a plain tool", async () => {
    const resp = await boxed.call("subagent_policy_check", { tool: "Bash" });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["verdict"], "allow");
    assert.equal(payload(resp)["tool"], "Bash");
  });
  it("subagent_policy_check denies delegation-shaped tools as a verdict", async () => {
    const resp = await boxed.call("subagent_policy_check", { tool: "Task" });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["verdict"], "deny");
  });
  it("subagent_policy_check rejects empty and multiline tools without spawn", async () => {
    assert.equal(isError(await boxed.call("subagent_policy_check", { tool: "" })), true);
    assert.equal(isError(await boxed.call("subagent_policy_check", { tool: "a\nb" })), true);
  });
  it("supervision_instructions renders the stubbed block with flags echoed", async () => {
    const resp = await boxed.call("supervision_instructions", { harness: "pi", read_only: true });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["harness"], "pi");
    assert.equal(payload(resp)["read_only"], true);
    assert.ok(String(payload(resp)["stdout"] ?? "").includes("instructions-stub"));
  });
  it("supervision_instructions rejects unknown harnesses and non-boolean flags", async () => {
    assert.equal(isError(await boxed.call("supervision_instructions", { harness: "bogus" })), true);
    assert.equal(isError(await boxed.call("supervision_instructions", { afk_mode: "loud" })), true);
    assert.equal(isError(await boxed.call("supervision_instructions", { read_only: "yes" })), true);
  });
  it("quota_choose selects the stubbed eligible candidate", async () => {
    const resp = await boxed.call("quota_choose", { snapshot: "captured", candidates: ["pi:default"] });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["eligible"], true);
    assert.equal(payload(resp)["harness"], "pi");
    assert.equal(payload(resp)["model"], "default");
  });
  it("quota_choose reports none as ineligible without error", async () => {
    const resp = await boxed.call("quota_choose", { snapshot: "captured", candidates: ["none:default"] });
    assert.equal(isError(resp), false);
    assert.equal(payload(resp)["eligible"], false);
  });
  it("quota_choose rejects empty snapshots and bad candidates without spawn", async () => {
    assert.equal(isError(await boxed.call("quota_choose", { snapshot: "", candidates: ["pi:default"] })), true);
    assert.equal(isError(await boxed.call("quota_choose", { snapshot: "captured", candidates: [] })), true);
    assert.equal(isError(await boxed.call("quota_choose", { snapshot: "captured", candidates: [":bad"] })), true);
    assert.equal(isError(await boxed.call("quota_choose", { snapshot: "captured", candidates: ["bad candidate!"] })), true);
  });
  it("installs-mutating verbs are refused as unknown, even with approval", async () => {
    for (const name of [
      "bootstrap", "check_register", "check_unregister", "agents_md_ensure",
      "install_actionlint", "install_herdr", "install_shellcheck", "install_treehouse",
      "update", "workflow_lint",
    ]) {
      for (const args of [{}, { approval: APPROVAL }]) {
        const resp = await boxed.call(name, args);
        assert.ok("error" in resp && resp.error!.code === -32602, `${name} ${JSON.stringify(args)}`);
        assert.match(String(resp.error!.message ?? ""), /unknown tool/i, name);
      }
    }
  });
  it("supervision-driving verbs are refused as unknown, even with approval", async () => {
    for (const name of [
      "afk_contract", "afk_launch", "afk_return", "afk_start",
      "branch_outcome", "branch_prompt", "busy_event", "kimi_turnend_hook",
      "operational_input", "procevent_run", "procevent_lavish", "procevent_quota",
      "procevent_remote_reply", "procevent_when", "turnend_guard",
      "turnend_guard_cursor", "turnend_guard_grok", "wake_grant", "watch_checkpoint",
    ]) {
      for (const args of [{}, { approval: APPROVAL }]) {
        const resp = await boxed.call(name, args);
        assert.ok("error" in resp && resp.error!.code === -32602, `${name} ${JSON.stringify(args)}`);
        assert.match(String(resp.error!.message ?? ""), /unknown tool/i, name);
      }
    }
  });
  it("session_start refuses without approval", async () => {
    const resp = await boxed.call("session_start", {});
    assert.equal(isError(resp), true);
  });
  it("session_start rejects invalid source", async () => {
    assert.equal(
      isError(await boxed.call("session_start", { source: "bad source!", approval: APPROVAL })),
      true,
    );
  });
  it("sessionstart_run refuses without approval", async () => {
    const resp = await boxed.call("sessionstart_run", {});
    assert.equal(isError(resp), true);
  });
  it("sessionstart_run rejects invalid source", async () => {
    assert.equal(
      isError(await boxed.call("sessionstart_run", { source: "bad source!", approval: APPROVAL })),
      true,
    );
  });
  it("sessionstart_cursor refuses without approval", async () => {
    const resp = await boxed.call("sessionstart_cursor", { source: "startup" });
    assert.equal(isError(resp), true);
  });
  it("sessionstart_cursor rejects missing or invalid source", async () => {
    assert.equal(isError(await boxed.call("sessionstart_cursor", { approval: APPROVAL })), true);
    assert.equal(
      isError(await boxed.call("sessionstart_cursor", { source: "bad source!", approval: APPROVAL })),
      true,
    );
  });
  it("herdr_lab refuses without approval", async () => {
    const resp = await boxed.call("herdr_lab", { subcommand: "stop", session: "fm-lab-x" });
    assert.equal(isError(resp), true);
  });
  it("herdr_lab rejects invalid subcommand and session", async () => {
    assert.equal(
      isError(await boxed.call("herdr_lab", { subcommand: "delete", session: "fm-lab-x", approval: APPROVAL })),
      true,
    );
    assert.equal(
      isError(await boxed.call("herdr_lab", { subcommand: "stop", session: "default", approval: APPROVAL })),
      true,
    );
  });
  it("herdr_ci_cleanup refuses without approval", async () => {
    const resp = await boxed.call("herdr_ci_cleanup", { command: "snapshot", path: "state/snap.json" });
    assert.equal(isError(resp), true);
  });
  it("herdr_ci_cleanup rejects traversal path", async () => {
    assert.equal(
      isError(
        await boxed.call("herdr_ci_cleanup", { command: "snapshot", path: "../escape.json", approval: APPROVAL }),
      ),
      true,
    );
  });
  it("session_cleanup refuses without approval", async () => {
    const resp = await boxed.call("session_cleanup", {});
    assert.equal(isError(resp), true);
  });
  it("claude_trust refuses without approval", async () => {
    const resp = await boxed.call("claude_trust", { worktree: "/tmp/wt", project: "/tmp/proj" });
    assert.equal(isError(resp), true);
  });
  it("claude_trust rejects ambiguous mode", async () => {
    assert.equal(
      isError(await boxed.call("claude_trust", { approval: APPROVAL })),
      true,
    );
    assert.equal(
      isError(
        await boxed.call("claude_trust", {
          worktree: "/tmp/wt",
          project: "/tmp/proj",
          home: "/tmp/home",
          id: "sm1",
          approval: APPROVAL,
        }),
      ),
      true,
    );
  });
  it("agy_trust refuses without approval", async () => {
    const resp = await boxed.call("agy_trust", { worktree: "/tmp/wt", project: "/tmp/proj" });
    assert.equal(isError(resp), true);
  });
  it("agy_trust rejects missing worktree", async () => {
    assert.equal(
      isError(await boxed.call("agy_trust", { project: "/tmp/proj", approval: APPROVAL })),
      true,
    );
  });
  it("claude_stop_autoarm refuses without approval", async () => {
    const resp = await boxed.call("claude_stop_autoarm", {});
    assert.equal(isError(resp), true);
  });
  it("herdr_eventwait refuses without approval", async () => {
    const resp = await boxed.call("herdr_eventwait", { socket: "/tmp/s", timeout_s: 5, pane_ids: [1] });
    assert.equal(isError(resp), true);
  });
  it("herdr_eventwait rejects invalid timeout and panes", async () => {
    assert.equal(
      isError(
        await boxed.call("herdr_eventwait", { socket: "/tmp/s", timeout_s: 999, pane_ids: [1], approval: APPROVAL }),
      ),
      true,
    );
    assert.equal(
      isError(
        await boxed.call("herdr_eventwait", { socket: "/tmp/s", timeout_s: 5, pane_ids: [], approval: APPROVAL }),
      ),
      true,
    );
  });
  it("herdr_workspace_move refuses without approval", async () => {
    const resp = await boxed.call("herdr_workspace_move", { socket: "/tmp/s", workspace_id: 3, insert_index: 0 });
    assert.equal(isError(resp), true);
  });
  it("herdr_workspace_move rejects invalid ids", async () => {
    assert.equal(
      isError(
        await boxed.call("herdr_workspace_move", {
          socket: "/tmp/s",
          workspace_id: -1,
          insert_index: 0,
          approval: APPROVAL,
        }),
      ),
      true,
    );
  });
  it("decision_release records decision_digest in audit log", async () => {
    const auditFile = path.join(sandbox, "state", "mcp-audit.jsonl");
    const client = new Client({ FM_HOME: sandbox, FM_ACTOR: "audit-tester", FM_AUDIT_LOG: auditFile });
    try {
      const resp = await client.call("decision_release", {
        origin_id: "audit-tester",
        decision_key: "audit-key",
        routed_to: "task-99",
        decision_text: "decision text for audit test",
        approval: APPROVAL,
      });
      assert.equal(isError(resp), false);
      const digest = payload(resp)["decision_digest"] as string;
      assert.ok(typeof digest === "string" && digest.length === 64);
      assert.ok(fs.existsSync(auditFile));
      const lines = fs.readFileSync(auditFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const matching = lines.find((l) => l.tool === "decision_release" && l.actor === "audit-tester");
      assert.ok(matching, "audit line for decision_release must exist");
      assert.equal(matching.decision_digest, digest);
    } finally {
      await client.close();
    }
  });
});

describe("paginated fleet reads: fleet_snapshot and backlog", () => {
  let taskHome: string;
  let taskClient: Client;

  before(() => {
    taskHome = makeTasksStubHome(5); // 5 tasks: task-000 .. task-004
    taskClient = new Client({ FM_HOME: taskHome });
  });

  after(async () => {
    await taskClient.close();
    removeHome(taskHome);
  });

  it("unpaginated fleet_snapshot returns canonical schema with snapshot_id attached", async () => {
    const snap = payload(await taskClient.call("fleet_snapshot", {}));
    assert.equal(snap["schema"], "fm-fleet-snapshot.v1");
    assert.ok(typeof snap["snapshot_id"] === "string");
    assert.ok((snap["snapshot_id"] as string).startsWith("snap-"));
    assert.equal(((snap["tasks"] as unknown[]) ?? []).length, 5);
  });

  it("paginated fleet_snapshot page 1 returns summary, page slice, next_cursor, truncated", async () => {
    const resp = await taskClient.call("fleet_snapshot", { limit: 2 });
    assert.equal(isError(resp), false);
    const snap = payload(resp);
    assert.equal(snap["schema"], "fm-fleet-snapshot.v1");
    assert.ok(typeof snap["snapshot_id"] === "string");
    const snapId = snap["snapshot_id"] as string;

    const summary = snap["summary"] as Record<string, unknown>;
    assert.ok(summary, "summary must be present");
    assert.equal(summary["total"], 5);
    assert.equal(summary["generated"], "2026-09-21T12:00:00Z");
    assert.equal(summary["rev"], "rev-test-1");
    const byState = summary["by_state"] as Record<string, number>;
    assert.equal(byState["in_flight"], 3);
    assert.equal(byState["queued"], 2);

    const page = snap["page"] as Array<Record<string, unknown>>;
    assert.equal(page.length, 2);
    assert.equal(page[0]!["task_id"], "task-000");
    assert.equal(page[1]!["task_id"], "task-001");

    assert.equal(snap["next_cursor"], `${snapId}:2`);
    assert.equal(snap["truncated"], true);
  });

  it("paginated fleet_snapshot page 2 uses cursor to read from cache without script execution", async () => {
    // First get page 1 to have the snapshot ID
    const snap1 = payload(await taskClient.call("fleet_snapshot", { limit: 2 }));
    const nextCursor = snap1["next_cursor"] as string;

    // Remove the script in the stub home to prove this read is 100% from state cache
    const scriptPath = path.join(taskHome, "bin", "fm-fleet-snapshot.sh");
    const savedScript = fs.readFileSync(scriptPath, "utf8");
    fs.writeFileSync(scriptPath, "#!/bin/sh\nexit 99\n", "utf8");

    try {
      const resp = await taskClient.call("fleet_snapshot", { cursor: nextCursor, limit: 2 });
      assert.equal(isError(resp), false);
      const snap2 = payload(resp);
      assert.equal(snap2["snapshot_id"], snap1["snapshot_id"]);
      const page = snap2["page"] as Array<Record<string, unknown>>;
      assert.equal(page.length, 2);
      assert.equal(page[0]!["task_id"], "task-002");
      assert.equal(page[1]!["task_id"], "task-003");
      assert.equal(snap2["next_cursor"], `${snap1["snapshot_id"]}:4`);
      assert.equal(snap2["truncated"], true);

      // Page 3: final item
      const resp3 = await taskClient.call("fleet_snapshot", { cursor: snap2["next_cursor"] as string, limit: 2 });
      assert.equal(isError(resp3), false);
      const snap3 = payload(resp3);
      const page3 = snap3["page"] as Array<Record<string, unknown>>;
      assert.equal(page3.length, 1);
      assert.equal(page3[0]!["task_id"], "task-004");
      assert.equal(snap3["next_cursor"], null);
      assert.equal(snap3["truncated"], false);
    } finally {
      fs.writeFileSync(scriptPath, savedScript, "utf8");
    }
  });

  it("fleet_snapshot beyond total offset returns empty page with null next_cursor", async () => {
    const snap1 = payload(await taskClient.call("fleet_snapshot", { limit: 2 }));
    const snapId = snap1["snapshot_id"] as string;

    const resp = await taskClient.call("fleet_snapshot", { cursor: `${snapId}:100`, limit: 10 });
    assert.equal(isError(resp), false);
    const snap = payload(resp);
    assert.equal(((snap["page"] as unknown[]) ?? []).length, 0);
    assert.equal(snap["next_cursor"], null);
    assert.equal(snap["truncated"], false);
  });

  it("fleet_snapshot accepts integer cursor with explicit snapshot_id", async () => {
    const snap1 = payload(await taskClient.call("fleet_snapshot", { limit: 2 }));
    const snapId = snap1["snapshot_id"] as string;

    const resp = await taskClient.call("fleet_snapshot", { cursor: 2, snapshot_id: snapId, limit: 2 });
    assert.equal(isError(resp), false);
    const snap = payload(resp);
    const page = snap["page"] as Array<Record<string, unknown>>;
    assert.equal(page.length, 2);
    assert.equal(page[0]!["task_id"], "task-002");
  });

  it("fleet_snapshot rejects invalid cursor and limit arguments", async () => {
    assert.equal(isError(await taskClient.call("fleet_snapshot", { limit: -1 })), true);
    assert.equal(isError(await taskClient.call("fleet_snapshot", { limit: "bad" })), true);
    assert.equal(isError(await taskClient.call("fleet_snapshot", { cursor: "bad_cursor" })), true);
    assert.equal(isError(await taskClient.call("fleet_snapshot", { cursor: 10 })), true); // offset > 0 without snapshot_id
    assert.equal(isError(await taskClient.call("fleet_snapshot", { cursor: "snap-123:10", snapshot_id: "snap-456" })), true); // mismatch
    assert.equal(isError(await taskClient.call("fleet_snapshot", { snapshot_id: "../traversal" })), true);
  });

  it("fleet_snapshot returns structured error for unknown snapshot_id", async () => {
    const resp = await taskClient.call("fleet_snapshot", { cursor: "snap-0000000000000000:0" });
    assert.equal(isError(resp), true);
    assert.equal(payload(resp)["error"], "unknown snapshot");
  });

  it("unpaginated backlog returns records plus counts and snapshot_id", async () => {
    const back = payload(await taskClient.call("backlog", {}));
    assert.ok(typeof back["snapshot_id"] === "string");
    assert.equal(back["generated"], "2026-09-21T12:00:00Z");
    assert.ok("backlog" in back && "task_counts" in back);
    const counts = back["task_counts"] as Record<string, unknown>;
    assert.equal(counts["total"], 5);
  });

  it("paginated backlog page 1 returns summary, backlog, task_counts, page slice, next_cursor, truncated", async () => {
    const resp = await taskClient.call("backlog", { limit: 2 });
    assert.equal(isError(resp), false);
    const back = payload(resp);
    assert.ok(typeof back["snapshot_id"] === "string");
    const snapId = back["snapshot_id"] as string;

    const summary = back["summary"] as Record<string, unknown>;
    assert.ok(summary, "summary must be present");
    assert.equal(summary["total"], 5);
    assert.equal(summary["generated"], "2026-09-21T12:00:00Z");
    assert.equal(summary["rev"], "rev-test-1");

    assert.ok("backlog" in back);
    assert.ok("task_counts" in back);

    const page = back["page"] as Array<Record<string, unknown>>;
    assert.equal(page.length, 2);
    assert.equal(page[0]!["task_id"], "task-000");
    assert.equal(page[1]!["task_id"], "task-001");

    assert.equal(back["next_cursor"], `${snapId}:2`);
    assert.equal(back["truncated"], true);

    // Follow-up page 2
    const resp2 = await taskClient.call("backlog", { cursor: back["next_cursor"] as string, limit: 2 });
    assert.equal(isError(resp2), false);
    const back2 = payload(resp2);
    const page2 = back2["page"] as Array<Record<string, unknown>>;
    assert.equal(page2.length, 2);
    assert.equal(page2[0]!["task_id"], "task-002");
    assert.equal(page2[1]!["task_id"], "task-003");
  });

  it("cross-home isolation: cached snapshots never leak across homes", async () => {
    const homeA = makeTasksStubHome(3);
    const homeB = makeStubHome();
    const clientA = new Client({ FM_HOME: homeA });
    const clientB = new Client({ FM_HOME: homeB });

    try {
      const snapA = payload(await clientA.call("fleet_snapshot", { limit: 1 }));
      const snapIdA = snapA["snapshot_id"] as string;

      // Client B attempts to read snapshot created in home A
      const respB = await clientB.call("fleet_snapshot", { cursor: `${snapIdA}:0`, limit: 1 });
      assert.equal(isError(respB), true);
      assert.equal(payload(respB)["error"], "unknown snapshot");
    } finally {
      await clientA.close();
      await clientB.close();
      removeHome(homeA);
      removeHome(homeB);
    }
  });
});
